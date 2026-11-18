// Tiered re-approval for in-flight spec corrections (docs/proposals/spec-amendment-tiers.md).
// A human "开始" binds a snapshot of the approved spec bytes. A later edit that keeps
// requirements, design, existing test cases and finished tasks intact (tier 1) can be
// re-bound after an independent review instead of another "开始"; a change that only
// appends version-table rows to tasks.md (tier 0) needs no review. Everything else
// (tier 2) still waits for the user. The snapshot and the receipt are guidance-level
// evidence, like .cm-specs-status itself: they bind content, not who wrote them.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {readSpecsStatus,writeSpecsStatus} from '../specs-status.mjs';
import {buildManifest,normalizeRuntimeMarkBytes} from '../../../scripts/cm-spec-manifest.mjs';
import {taskLines,recordedTaskGrammar,LEGACY_TASK_GRAMMAR} from '../spec-task-line.mjs';
import {taskNames,acceptanceLanguage,weakensLanguage,versionNote,plainVersionNote,testingLanguage} from '../acceptance-language.mjs';

export const SNAPSHOT_FILE='.cm-specs-approved.json';
export const LOCK_FILE='.cm-specs-approval.lock';
// The round ledger lives outside the specs tree (CM_WORKFLOW_HOME, default
// ~/.cm-workflow) and names the latest human approval round and its snapshot bytes,
// so restoring an older snapshot (or a backup / git checkout of the specs directory)
// cannot revive an earlier authorization or policy.
export function roundLedgerPath(specsDir){
  const home=path.resolve(process.env.CM_WORKFLOW_HOME||path.join(os.homedir(),'.cm-workflow'));
  return path.join(home,'spec-approvals',`${sha(fs.realpathSync(specsDir))}.json`);
}
export const AMEND_LIMIT=3;
export const REVIEW_MARKER='cmSpecAmendReview';
const FILES=['requirements.md','design.md','tasks.md','test-cases.json'];
const FEATURE=/^\d+\.[^/\\]+$/;
const ACCEPTANCE=/^\s*[-*]\s+(?:\[[ xX]\]\s+)?(?:\[(AC-\d{3,})\]|(AC-\d{3,}))(?=[:\s])/;
const AC_REF=/AC-\d{3,}/g;
const DEPENDENCY=/^\s*-\s*(T-[A-Za-z0-9][A-Za-z0-9._-]*)\s+依赖\s+(.+)$/;
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const iso=value=>typeof value==='string'&&/^\d{4}-\d\d-\d\dT/.test(value)&&Number.isFinite(Date.parse(value));
const sha=value=>createHash('sha256').update(value).digest('hex');
const compare=(a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b));
const fail=code=>{throw Object.assign(new Error(code),{code});};
const rowsDigest=rows=>sha(JSON.stringify(rows.map(row=>[row.path,row.sha256])));

// Stable JSON so test-case comparison ignores key order but nothing else.
function stable(value){
  if(Array.isArray(value))return `[${value.map(stable).join(',')}]`;
  if(record(value))return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function atomicWrite(dir,name,bytes){
  const target=path.join(dir,name),temporary=path.join(dir,`${name}-${randomUUID()}`);let fd;
  try{
    fd=fs.openSync(temporary,'wx',0o600);fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
    fs.renameSync(temporary,target);
  }finally{
    if(fd!==undefined)fs.closeSync(fd);
    try{fs.unlinkSync(temporary);}catch(error){if(error.code!=='ENOENT')throw error;}
  }
}

function captureFiles(specsDir,features){
  const files=[];
  for(const name of features)for(const file of FILES){
    const target=path.join(specsDir,name,file);
    let stat;
    try{stat=fs.lstatSync(target);}catch(error){if(error.code==='ENOENT'&&file==='test-cases.json')continue;throw error;}
    if(stat.isSymbolicLink()||!stat.isFile())fail('spec_amend_file_invalid');
    const bytes=fs.readFileSync(target),content=bytes.toString('utf8');
    // The snapshot stores text; bytes that do not round-trip cannot be compared later.
    if(!Buffer.from(content,'utf8').equals(bytes))fail('spec_amend_file_not_utf8');
    files.push({path:`${name}/${file}`,content});
  }
  return files;
}

function snapshotRows(files){
  return files.map(item=>({path:item.path,
    sha256:sha(normalizeRuntimeMarkBytes(Buffer.from(item.content,'utf8'),path.posix.basename(item.path)))}))
    .sort((a,b)=>compare(a.path,b.path));
}

// Called by the explicit human approval. `policy: 'off'` keeps the old behaviour:
// every later spec change waits for "开始".
export function writeApprovalSnapshot(specsDir,{features,specFiles,approval,policy='reviewed'}){
  if(!['reviewed','off'].includes(policy))fail('spec_amend_policy_invalid');
  const files=captureFiles(specsDir,features);
  // Bytes read after the manifest was built must be the bytes that manifest approved.
  if(rowsDigest(snapshotRows(files))!==rowsDigest(specFiles))fail('spec_amend_snapshot_race');
  const value={version:1,policy,features:[...features],approval:{response:approval.response,at:approval.at},
    amendments:[],rowsDigest:rowsDigest(specFiles),files};
  const bytes=Buffer.from(JSON.stringify(value)+'\n');
  atomicWrite(specsDir,SNAPSHOT_FILE,bytes);
  writeRound(specsDir,value.approval.at,bytes);
  return {policy,files:files.length};
}

function writeRound(specsDir,approvalAt,snapshotBytes){
  const target=roundLedgerPath(specsDir);
  fs.mkdirSync(path.dirname(target),{recursive:true,mode:0o700});
  atomicWrite(path.dirname(target),path.basename(target),
    Buffer.from(JSON.stringify({version:1,specsDir:fs.realpathSync(specsDir),approvalAt,snapshotSha256:sha(snapshotBytes)})+'\n'));
}

function invalidateRound(specsDir){
  try{fs.unlinkSync(roundLedgerPath(specsDir));}
  catch(error){if(error.code!=='ENOENT')fail('spec_amend_round_unremovable');}
}

function readRound(specsDir){
  try{return fs.readFileSync(roundLedgerPath(specsDir));}catch{return null;}
}

function roundProblem(roundBytes,snapshotBytes,approvalAt){
  if(roundBytes===null)return 'snapshot_round_missing';
  let value;try{value=JSON.parse(roundBytes.toString('utf8'));}catch{return 'snapshot_round_mismatch';}
  return record(value)&&value.version===1&&value.approvalAt===approvalAt&&snapshotBytes!==null
    &&value.snapshotSha256===sha(snapshotBytes)?null:'snapshot_round_mismatch';
}

// A new human approval first removes the previous round's snapshot, so a failed
// snapshot write can never leave an older round (or its policy) in force.
export function removeApprovalSnapshot(specsDir){
  invalidateRound(specsDir);
  try{fs.unlinkSync(path.join(specsDir,SNAPSHOT_FILE));}
  catch(error){if(error.code!=='ENOENT')fail('spec_amend_snapshot_unremovable');}
}

function processAlive(pid){
  try{process.kill(pid,0);return true;}catch(error){return error.code==='EPERM';}
}

// Creates `target` holding `bytes` only if it does not exist. The bytes are
// complete before the name appears (temp file + link), so a lock is never seen
// empty or without its owner's pid, even while its creator is paused.
function createComplete(target,bytes){
  const temp=`${target}.${randomUUID()}.tmp`;
  let linked=false;
  try{
    fs.writeFileSync(temp,bytes,{mode:0o600,flag:'wx'});
    try{fs.linkSync(temp,target);linked=true;}
    catch(error){if(error.code!=='EEXIST')throw error;}
  }finally{
    try{fs.unlinkSync(temp);}
    catch(error){
      if(error.code!=='ENOENT'){
        // The caller never learns it holds `target`, so withdraw it before failing:
        // it is this call's own fresh link, which no one else may remove.
        if(linked)try{fs.unlinkSync(target);}catch{}
        throw error;
      }
    }
  }
  return linked;
}

// Serializes human approval and amendment re-binding in one specs directory.
// cm-prd does not take this lock; apply also re-checks status bytes before rename.
export function withApprovalLock(specsDir,run){
  const target=path.join(specsDir,LOCK_FILE),guard=`${target}.reclaim`;
  // A nonce makes every acquisition's bytes unique, so a releaser can tell its
  // own lock from any other one at the same path.
  const owner=()=>Buffer.from(JSON.stringify({pid:process.pid,nonce:randomUUID(),at:new Date().toISOString()}));
  const mine=owner();
  for(let attempt=0;attempt<2;attempt++){
    if(!createComplete(target,mine)){
      if(attempt>0)fail('spec_approval_busy');
      // Only the holder of the reclaim guard may delete another process's lock,
      // and only when its recorded pid is gone. A live owner is never judged
      // stale, a dead owner cannot release, and every lock carries its pid from
      // the moment it exists, so the lock path is never emptied under a live
      // holder. A lock without a readable pid, or a guard left by a crash, is
      // never reclaimed automatically (see N1-init「执行中补正分级」).
      if(!createComplete(guard,owner()))fail('spec_approval_busy');
      try{
        let seen;
        try{seen=fs.readFileSync(target);}
        catch(readError){if(readError.code==='ENOENT')continue;throw readError;}
        let holder=null;
        try{holder=JSON.parse(seen.toString('utf8'));}catch{}
        if(!(Number.isInteger(holder?.pid)&&holder.pid>0&&!processAlive(holder.pid)))fail('spec_approval_busy');
        // The holder may have released, and a new holder taken the lock, between
        // the read and the pid check. Only the very bytes judged dead are removed:
        // a dead holder cannot release any more, and other reclaimers wait on the guard.
        let current=null;
        try{current=fs.readFileSync(target);}catch(readError){if(readError.code!=='ENOENT')throw readError;}
        if(current===null)continue;
        if(!current.equals(seen))fail('spec_approval_busy');
        fs.unlinkSync(target);
      }finally{
        try{fs.unlinkSync(guard);}catch{}
      }
      continue;
    }
    try{
      return run();
    }finally{
      // Release only this acquisition's lock, never one that replaced it.
      try{if(fs.readFileSync(target).equals(mine))fs.unlinkSync(target);}catch{}
    }
  }
  fail('spec_approval_busy');
}

export function readApprovalSnapshot(specsDir){
  const target=path.join(specsDir,SNAPSHOT_FILE);
  let stat;
  try{stat=fs.lstatSync(target);}catch(error){return {kind:error.code==='ENOENT'?'missing':'invalid'};}
  try{
    if(stat.isSymbolicLink()||!stat.isFile())fail('invalid');
    const value=JSON.parse(fs.readFileSync(target,'utf8'));
    const valid=record(value)&&value.version===1&&['reviewed','off'].includes(value.policy)
      &&Array.isArray(value.features)&&value.features.length>0&&value.features.every(name=>typeof name==='string'&&FEATURE.test(name))
      &&new Set(value.features).size===value.features.length
      &&record(value.approval)&&typeof value.approval.response==='string'&&value.approval.response.trim()!==''&&iso(value.approval.at)
      &&Array.isArray(value.amendments)&&value.amendments.every(item=>record(item)&&[0,1].includes(item.tier))
      &&Array.isArray(value.files)&&value.files.every(item=>record(item)&&typeof item.path==='string'
        &&typeof item.content==='string'&&value.features.includes(item.path.split('/')[0])
        &&item.path.split('/').length===2&&FILES.includes(item.path.split('/')[1]))
      &&new Set(value.files.map(item=>item.path)).size===value.files.length
      // Self digest: a snapshot edited by hand (e.g. synced to current specs) is invalid.
      &&value.rowsDigest===rowsDigest(snapshotRows(value.files));
    return valid?{kind:'valid',value}:{kind:'invalid'};
  }catch{return {kind:'invalid'};}
}

function acceptanceIds(text){
  return new Set(text.split(/\r?\n/).map(line=>line.match(ACCEPTANCE)).filter(Boolean).map(match=>match[1]||match[2]));
}

// A task block runs from its declaration to the next declaration, heading,
// dependency line or non-indented text; blank lines and fenced lines inside stay
// in the block (a blank line must not split off a finished task's verification).
function taskStructure(text,grammar){
  const tasks=new Map(),dependencies=new Map(),prose=[];let current=null;
  for(const line of taskLines(text,{grammar})){
    const body=line.body.replace(/\s+$/,'');
    if(!line.fenced&&line.declaration){
      current={id:line.declaration.id,completed:line.declaration.completed,
        dropped:/\[DROPPED(?:\s[^\]]*)?\]/.test(line.declaration.rest),
        lines:[body.replace(/^(\s*-\s*(?:~~)?)\[[xX]\]/,'$1[ ]')]};
      if(tasks.has(current.id))fail('spec_amend_tasks_invalid');
      tasks.set(current.id,current);continue;
    }
    const dependency=line.fenced?null:body.match(DEPENDENCY);
    const ends=dependency||(!line.fenced&&(/^\s{0,3}#/.test(body)||/^\S/.test(body)));
    if(current&&!ends){current.lines.push(body);continue;}
    current=null;
    if(dependency){dependencies.set(dependency[1],dependency[2].trim());continue;}
    prose.push(body);
  }
  for(const task of tasks.values()){
    while(task.lines.length>1&&task.lines.at(-1)==='')task.lines.pop();
    task.text=task.lines.join('\n');task.acceptance=new Set(task.text.match(AC_REF)??[]);
  }
  return {tasks,dependencies,prose};
}

// Tier 0 allows only appended rows in a "版本"/"Version" table: every other line
// stays identical and every earlier version row is kept.
function splitVersionRows(lines){
  const body=[],rows=[];let versionSection=false;
  for(const line of lines){
    const heading=/^\s{0,3}#{1,6}\s+(.*)$/.exec(line);
    if(heading)versionSection=/版本|version/i.test(heading[1]);
    if(versionSection&&/^\s*\|/.test(line)){rows.push(line);continue;}
    if(line.trim()!=='')body.push(line);
  }
  return {body,rows};
}
// Returns the appended version rows, or null when anything else changed.
function appendedVersionRows(oldLines,newLines){
  const old=splitVersionRows(oldLines),next=splitVersionRows(newLines);
  if(JSON.stringify(old.body)!==JSON.stringify(next.body))return null;
  if(JSON.stringify(next.rows.slice(0,old.rows.length))!==JSON.stringify(old.rows))return null;
  return next.rows.slice(old.rows.length);
}

function compareTestCases(before,after,reasons,name){
  if(before===undefined)return;
  if(after===undefined){reasons.push(`test_cases_removed:${name}`);return;}
  let old,next;
  try{old=JSON.parse(before);next=JSON.parse(after);}catch{reasons.push(`test_cases_invalid:${name}`);return;}
  if(!record(old)||!record(next)||!Array.isArray(old.cases)||!Array.isArray(next.cases)){reasons.push(`test_cases_invalid:${name}`);return;}
  const {cases:oldCases,...oldRest}=old,{cases:newCases,...newRest}=next;
  if(stable(oldRest)!==stable(newRest))reasons.push(`test_cases_changed:${name}`);
  const byId=new Map(newCases.filter(record).map(item=>[item.id,item]));
  for(const item of oldCases){
    const match=record(item)?byId.get(item.id):undefined;
    if(!match||stable(match)!==stable(item)){reasons.push(`test_case_changed:${name}/${record(item)?item.id:'?'}`);}
  }
}

// Classifies the difference between the bound snapshot and the current spec files.
// tier null: nothing to re-bind; 0: version rows only; 1: reviewed correction; 2: human.
const rawBytes=target=>{try{return fs.readFileSync(target);}catch{return null;}};
const sameBytes=(a,b)=>a===null?b===null:b!==null&&a.equals(b);

// The bytes the latest human approval bound, as re-bound only by applied amendments:
// path -> runtime-mark-normalized sha256. Null unless status is approved and the
// snapshot, the out-of-tree round ledger and the status all name the same round, so a
// restored older snapshot or a hand-synced one never becomes a baseline.
export function approvedSpecBaseline(specsDir){
  const statusPath=path.join(specsDir,'.cm-specs-status'),snapshotPath=path.join(specsDir,SNAPSHOT_FILE);
  const statusBytes=rawBytes(statusPath),snapshotBytes=rawBytes(snapshotPath),roundBytes=readRound(specsDir);
  const status=readSpecsStatus(specsDir),snapshot=readApprovalSnapshot(specsDir);
  if(!sameBytes(statusBytes,rawBytes(statusPath))||!sameBytes(snapshotBytes,rawBytes(snapshotPath))
    ||!sameBytes(roundBytes,readRound(specsDir)))return null;
  if(status.kind!=='valid'||snapshot.kind!=='valid'||status.value.status!=='approved')return null;
  const listed=status.value.specFiles;
  if(!Array.isArray(listed)||!listed.every(row=>record(row)&&typeof row.path==='string'&&typeof row.sha256==='string'))return null;
  const bound=snapshot.value,rows=snapshotRows(bound.files);
  if(roundProblem(roundBytes,snapshotBytes,bound.approval.at)
    ||rowsDigest(listed)!==rowsDigest(rows)||status.value.approval?.at!==bound.approval.at)return null;
  return new Map(rows.map(row=>[row.path,row.sha256]));
}

export function inspectSpecAmendment(specsDir){
  const reasons=[],statusPath=path.join(specsDir,'.cm-specs-status'),snapshotPath=path.join(specsDir,SNAPSHOT_FILE);
  const statusBytes=rawBytes(statusPath),snapshotBytes=rawBytes(snapshotPath),roundBytes=readRound(specsDir);
  const status=readSpecsStatus(specsDir),snapshot=readApprovalSnapshot(specsDir);
  const human=(...why)=>({tier:2,reasons:why,changedFiles:[],changedTasks:[],newTasks:[],deltaDigest:null});
  if(!sameBytes(statusBytes,rawBytes(statusPath))||!sameBytes(snapshotBytes,rawBytes(snapshotPath))
    ||!sameBytes(roundBytes,readRound(specsDir)))return human('spec_status_changed_during_inspect');
  if(status.kind!=='valid')return human(`spec_status_${status.kind}`);
  if(snapshot.kind!=='valid')return human(snapshot.kind==='missing'?'snapshot_missing':'snapshot_invalid');
  const bound=snapshot.value,baseRows=snapshotRows(bound.files);
  const round=roundProblem(roundBytes,snapshotBytes,bound.approval.at);
  if(round)return human(round);
  // While approved, the snapshot must be this approval round's content. After a
  // cm-prd reset to awaiting_review the round is no longer recorded in status;
  // the snapshot's self digest is then the only anchor (guidance-level, see docs).
  if(status.value.status==='approved'&&(rowsDigest(status.value.specFiles??[])!==rowsDigest(baseRows)
    ||status.value.approval?.at!==bound.approval.at))return human('snapshot_status_mismatch');
  let currentRows;
  try{currentRows=buildManifest(specsDir);}catch{return human('spec_files_invalid');}
  const baseByPath=new Map(baseRows.map(row=>[row.path,row.sha256]));
  const currentByPath=new Map(currentRows.map(row=>[row.path,row.sha256]));
  const changedFiles=[...new Set([...baseByPath.keys(),...currentByPath.keys()])]
    .filter(file=>baseByPath.get(file)!==currentByPath.get(file)).sort(compare);
  const deltaDigest=sha(JSON.stringify({base:rowsDigest(baseRows),current:rowsDigest(currentRows),amendments:bound.amendments.length}));
  const features=[...new Set(currentRows.map(row=>row.path.split('/')[0]))].sort(compare);
  const boundFeatures=[...bound.features].sort(compare);
  if(JSON.stringify(features)!==JSON.stringify(boundFeatures))return {...human('feature_set_changed'),changedFiles};
  // Every later step (packet, review digest, re-bind) uses these exact bytes.
  let currentFiles;
  try{currentFiles=captureFiles(specsDir,features);}catch(error){return human(error.code??'spec_files_invalid');}
  if(rowsDigest(snapshotRows(currentFiles))!==rowsDigest(currentRows))return human('spec_changed_during_inspect');
  // Parse and re-bind with the grammar this approval round bound (2 or 3), never
  // the newest constant: a grammar-2 「开发: 会话」 line must stay prose.
  const grammar=recordedTaskGrammar(status.value.taskGrammar);
  if(grammar===LEGACY_TASK_GRAMMAR)return {...human('task_grammar_legacy'),changedFiles};
  const outcome=(tier,extra={})=>({tier,reasons,changedFiles,changedTasks:[],newTasks:[],deltaDigest,
    currentRows,currentFiles,baseRows,snapshot:bound,status:status.value,statusBytes,snapshotBytes,roundBytes,...extra});
  if(!changedFiles.length)return outcome(status.value.status==='approved'?null:0);
  const current=new Map(currentFiles.map(item=>[item.path,item.content]));
  const before=new Map(bound.files.map(item=>[item.path,item.content]));
  const changedTasks=[],newTasks=[];let tasksOnlyVersionRows=true;
  for(const name of features){
    for(const file of ['requirements.md','design.md'])
      if(changedFiles.includes(`${name}/${file}`))reasons.push(`${file.replace('.md','')}_changed:${name}`);
    if(changedFiles.includes(`${name}/test-cases.json`)){
      tasksOnlyVersionRows=false;
      compareTestCases(before.get(`${name}/test-cases.json`),current.get(`${name}/test-cases.json`),reasons,name);
    }
    if(!changedFiles.includes(`${name}/tasks.md`))continue;
    const oldText=before.get(`${name}/tasks.md`),newText=current.get(`${name}/tasks.md`);
    let old,next;
    try{old=taskStructure(oldText,grammar);next=taskStructure(newText,grammar);}catch{reasons.push(`tasks_invalid:${name}`);continue;}
    const resetLines=text=>text.split(/\r?\n/).map(line=>line.replace(/^(\s*-\s*(?:~~)?)\[[xX]\]/,'$1[ ]').replace(/\s+$/,''));
    const appended=appendedVersionRows(resetLines(oldText),resetLines(newText));
    if(appended===null)tasksOnlyVersionRows=false;
    else for(const row of appended){
      const note=versionNote(row);
      const affected=taskNames(note).find(id=>old.tasks.has(id));
      // Same rule as the standing authorization: a version note that states or
      // weakens acceptance for an existing task is a requirement change (tier 2).
      if(affected&&(acceptanceLanguage(note)||weakensLanguage(note)||testingLanguage(note))){
        reasons.push(`version_row_changes_acceptance:${name}/${affected}`);continue;}
      // Only a note made entirely of "unchanged" statements stays tier 0
      // (plainVersionNote); every other note goes to review (tier 1).
      if(affected||!plainVersionNote(note))tasksOnlyVersionRows=false;
    }
    const declared=acceptanceIds(current.get(`${name}/requirements.md`)??'');
    for(const [id,task] of old.tasks){
      const now=next.tasks.get(id);
      if(!now){reasons.push(`task_removed:${name}/${id}`);continue;}
      if(now.dropped!==task.dropped){reasons.push(`task_${now.dropped?'dropped':'restored'}:${name}/${id}`);continue;}
      if(task.completed&&!now.completed){reasons.push(`task_reopened:${name}/${id}`);continue;}
      const finished=task.completed||now.completed;
      if(task.text!==now.text||old.dependencies.get(id)!==next.dependencies.get(id)){
        if(finished){reasons.push(`completed_task_changed:${name}/${id}`);continue;}
        const lost=[...task.acceptance].filter(ac=>!now.acceptance.has(ac));
        if(lost.length)reasons.push(`task_acceptance_removed:${name}/${id}:${lost.join(',')}`);
        changedTasks.push(`${name}/${id}`);
      }
    }
    for(const [id,task] of next.tasks){
      if(old.tasks.has(id))continue;
      if(task.completed){reasons.push(`new_task_completed:${name}/${id}`);continue;}
      if(!task.dropped){
        if(!task.acceptance.size)reasons.push(`new_task_without_acceptance:${name}/${id}`);
        const unknown=[...task.acceptance].filter(ac=>!declared.has(ac));
        if(unknown.length)reasons.push(`new_task_unknown_acceptance:${name}/${id}:${unknown.join(',')}`);
      }
      newTasks.push(`${name}/${id}`);
    }
  }
  if(reasons.length)return outcome(2,{changedTasks,newTasks});
  if(bound.policy==='off')return {...outcome(2,{changedTasks,newTasks}),reasons:['amend_policy_off']};
  const onlyTasks=changedFiles.every(file=>file.endsWith('/tasks.md'));
  if(onlyTasks&&tasksOnlyVersionRows)return outcome(0,{changedTasks,newTasks});
  if(bound.amendments.filter(item=>item.tier===1).length>=AMEND_LIMIT)
    return {...outcome(2,{changedTasks,newTasks}),reasons:['amend_limit_reached']};
  return outcome(1,{changedTasks,newTasks});
}

export function publicAmendment(result){
  const {currentRows,currentFiles,baseRows,snapshot,status,statusBytes,snapshotBytes,roundBytes,...rest}=result;
  return rest;
}

const PROMPT=`你是 CM 规格补正的独立审查者。你没有写这次补正，也不能改任何文件。

before/ 是用户上次回复「开始」时批准的规格，after/ 是现在的规格。先运行：
  diff -ru before after

context/ 是涉及的 feature 里没有改动的规格文件（需求、设计等），内容与批准时相同（不计勾选状态），只供对照。
判断下面第 1 条时，先读 context/ 里的需求和设计，再看补正是在落实它们，还是在改变它们。

工具已用机器核对过以下条件，全部成立：
- requirements.md、design.md 未变；
- test-cases.json 只新增用例，原有用例逐字不变；
- 已完成任务逐字不变，没有删除或作废任务；
- 新增任务引用了 requirements.md 里已有的验收标准编号；
- 改过的未完成任务没有丢掉原来引用的验收标准编号。

你只判断机器判断不了的两件事：
1. 这次补正是不是「执行中的补漏」：补测试文件进范围、为已有验收标准补修复任务、拆分或重排未完成任务、修正写法。
   如果它引入了新的产品行为、改变了用户能看到的需求、或者改变了已批准的设计取舍，判 changes_requested。
2. 有没有削弱验证：删减「验证」「测试文件」里的检查、放宽断言、缩小原有检查范围、把必须人工确认的事改成自动通过。
   有任何一处，判 changes_requested。

拿不准时判 changes_requested，补正就会退回给用户本人批准，不会丢失。

最后一行只输出一行 JSON，不要加代码块：
{"${REVIEW_MARKER}":1,"deltaDigest":"{DELTA}","verdict":"approved 或 changes_requested","findings":["每条一句中文"]}
`;

// Writes before/ and after/ copies, the unchanged files of the touched features
// (context/), and the review prompt into a fresh directory outside the specs tree,
// so the reviewer reads exactly the classified bytes. Dogfood (wue v4, 2026-11-04):
// the amendment aligned tasks.md with design.md, which a reviewer cannot judge
// without the unchanged design.
export function prepareSpecAmendment(specsDir,{outDir}={}){
  const result=inspectSpecAmendment(specsDir);
  const summary=publicAmendment(result);
  if(result.tier!==1)return {...summary,packet:null};
  if(typeof outDir!=='string'||!outDir)fail('spec_amend_out_required');
  const root=path.resolve(outDir);
  if(fs.existsSync(root)&&fs.readdirSync(root).length)fail('spec_amend_out_not_empty');
  const specsRoot=fs.realpathSync(specsDir);
  fs.mkdirSync(root,{recursive:true});
  const realRoot=fs.realpathSync(root),relative=path.relative(specsRoot,realRoot);
  if(relative===''||(relative!=='..'&&!relative.startsWith(`..${path.sep}`)&&!path.isAbsolute(relative))){fs.rmSync(root,{recursive:true,force:true});fail('spec_amend_out_inside_specs');}
  const before=new Map(result.snapshot.files.map(item=>[item.path,item.content]));
  const after=new Map(result.currentFiles.map(item=>[item.path,item.content]));
  const write=(side,file,content)=>{
    const target=path.join(realRoot,side,file);
    fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,content);
    // The reviewer must read exactly the bytes the digest was computed from.
    if(fs.readFileSync(target,'utf8')!==content)fail('spec_amend_packet_mismatch');
  };
  fs.mkdirSync(path.join(realRoot,'before'),{recursive:true});fs.mkdirSync(path.join(realRoot,'after'),{recursive:true});
  for(const file of result.changedFiles){
    if(before.has(file))write('before',file,before.get(file));
    if(after.has(file))write('after',file,after.get(file));
  }
  const changed=new Set(result.changedFiles),features=new Set(result.changedFiles.map(file=>file.split('/')[0]));
  for(const [file,content] of after){
    if(!changed.has(file)&&features.has(file.split('/')[0]))write('context',file,content);
  }
  const prompt=PROMPT.replace('{DELTA}',result.deltaDigest);
  fs.writeFileSync(path.join(realRoot,'review-prompt.md'),prompt);
  return {...summary,packet:{dir:realRoot,prompt:path.join(realRoot,'review-prompt.md')}};
}

export function readReviewVerdict(text,deltaDigest){
  const lines=String(text).split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
  for(let index=lines.length-1;index>=0;index--){
    if(!lines[index].includes(REVIEW_MARKER))continue;
    let value;try{value=JSON.parse(lines[index]);}catch{return {ok:false,reason:'review_output_invalid'};}
    if(!record(value)||value[REVIEW_MARKER]!==1)return {ok:false,reason:'review_output_invalid'};
    if(value.deltaDigest!==deltaDigest)return {ok:false,reason:'review_delta_mismatch'};
    if(value.verdict!=='approved')return {ok:false,reason:'review_not_approved',findings:Array.isArray(value.findings)?value.findings:[]};
    return {ok:true,findings:Array.isArray(value.findings)?value.findings:[]};
  }
  return {ok:false,reason:'review_output_missing'};
}

// Re-binds the approval to the current spec files when the tier allows it. Status is
// written before the snapshot: if the snapshot write fails, the two disagree and the
// next inspection falls back to tier 2 (human approval) instead of trusting stale bytes.
export function applySpecAmendment(specsDir,options={}){
  const {reason}=options;
  if(typeof reason!=='string'||!reason.trim()||/[\r\n\0]/.test(reason))fail('spec_amend_reason_required');
  return withApprovalLock(specsDir,()=>applyLocked(specsDir,options));
}

function applyLocked(specsDir,{reason,reviewOutput,reviewer}){
  const result=inspectSpecAmendment(specsDir);
  const summary=publicAmendment(result);
  if(result.tier===null)return {...summary,applied:false,refused:'spec_amend_nothing_to_apply'};
  if(result.tier===2)return {...summary,applied:false,refused:'spec_amend_needs_human'};
  let findings=[];
  if(result.tier===1){
    if(typeof reviewOutput!=='string')return {...summary,applied:false,refused:'review_output_required'};
    if(typeof reviewer!=='string'||!reviewer.trim()||/[\r\n\0]/.test(reviewer))return {...summary,applied:false,refused:'reviewer_required'};
    const verdict=readReviewVerdict(reviewOutput,result.deltaDigest);
    if(!verdict.ok)return {...summary,applied:false,refused:verdict.reason,...(verdict.findings?{findings:verdict.findings}:{})};
    findings=verdict.findings;
  }
  const features=[...result.snapshot.features],files=result.currentFiles;
  const at=new Date().toISOString(),status=result.status;
  // Final ownership check right before the status rename: same status round, same
  // snapshot, same spec bytes as classified (cm-prd does not share the lock).
  const unchanged=()=>sameBytes(result.statusBytes,rawBytes(path.join(specsDir,'.cm-specs-status')))
    &&sameBytes(result.snapshotBytes,rawBytes(path.join(specsDir,SNAPSHOT_FILE)))
    &&sameBytes(result.roundBytes,readRound(specsDir))
    &&rowsDigest(buildManifest(specsDir))===rowsDigest(result.currentRows)
    &&rowsDigest(snapshotRows(captureFiles(specsDir,features)))===rowsDigest(result.currentRows);
  try{
    writeSpecsStatus(specsDir,{status:'approved',summaryDigest:status.summaryDigest??null,at,features,
      specFiles:result.currentRows,testCases:result.currentRows.filter(item=>item.path.endsWith('/test-cases.json')),
      approval:result.snapshot.approval,taskGrammar:recordedTaskGrammar(status.taskGrammar),
      ...(Object.hasOwn(status,'revisionDigest')?{revisionDigest:status.revisionDigest}:{})},
    {beforeRename:()=>{
      if(!unchanged())fail('spec_changed_during_apply');
      // Void the current round first: if anything below fails, no snapshot of this
      // or an earlier round matches the ledger, so every later change is tier 2.
      invalidateRound(specsDir);
    }});
  }catch(error){
    if(error.code==='spec_changed_during_apply')return {...summary,applied:false,refused:'spec_changed_during_apply'};
    throw error;
  }
  const amendment={at,tier:result.tier,reason:reason.trim(),deltaDigest:result.deltaDigest,files:result.changedFiles,
    ...(result.tier===1?{reviewer:reviewer.trim(),findings}:{})};
  const value={...result.snapshot,amendments:[...result.snapshot.amendments,amendment],
    rowsDigest:rowsDigest(result.currentRows),files};
  // Round voided, then status, snapshot, round: a failure in between leaves no
  // ledger entry, which inspection treats as tier 2 even after a cm-prd reset.
  const bytes=Buffer.from(JSON.stringify(value)+'\n');
  atomicWrite(specsDir,SNAPSHOT_FILE,bytes);
  writeRound(specsDir,value.approval.at,bytes);
  return {...summary,applied:true,amendment};
}
