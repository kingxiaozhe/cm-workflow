// Standing "run to the end" authorization (scripts/cm-autonomy.mjs). Like
// --approval-response, the session relays the person's own words; the record
// changes three things: a driver stop waits waitMinutes instead of paging at once
// (the session usually carries on), cm-ai admission may approve a change proposal
// that leaves the requirement contract alone, and the session may reopen a task
// up to AUTO_REOPEN_LIMIT times. Fatal stops page at once (cm-autonomy.mjs notify).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {taskLines,TASK_GRAMMAR,recordedTaskGrammar,specLines} from './spec-task-line.mjs';
import {validateTestCases} from '../../scripts/validate-test-cases.mjs';
import {declaredAcceptanceIds,DEPENDENCY} from './cm-ai/cm-ai-admission.mjs';

export const AUTONOMY_FILE='autonomy.json',AUTONOMY_OFF_FILE='autonomy.off.json',REOPEN_DIR='autonomy-reopens',AUTO_REOPEN_LIMIT=2;
// Same directory as notify.json (notify.mjs notifyHome); kept here so notify.mjs can import this module.
export const autonomyHome=(env=process.env)=>path.resolve(env.CM_WORKFLOW_HOME||path.join(os.homedir(),'.cm-workflow'));
const iso=value=>typeof value==='string'&&/^\d{4}-\d\d-\d\dT/.test(value)&&Number.isFinite(Date.parse(value));
const words=value=>typeof value==='string'&&value.trim()!==''&&Array.from(value).length<=500;
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);

function readJson(file){
  try{if(!fs.lstatSync(file).isFile())return {invalid:true};return {value:JSON.parse(fs.readFileSync(file,'utf8'))};}
  catch(error){return error.code==='ENOENT'?{missing:true}:{invalid:true};}
}
function writeJson(home,name,value){
  fs.mkdirSync(home,{recursive:true,mode:0o700});
  const target=path.join(home,name),temporary=path.join(home,`.${name}-${randomUUID()}`);
  try{fs.writeFileSync(temporary,JSON.stringify(value,null,1)+'\n',{mode:0o600,flag:'wx'});fs.renameSync(temporary,target);}
  finally{try{fs.unlinkSync(temporary);}catch(error){if(error.code!=='ENOENT')throw error;}}
}

// {on:true,value} only for a regular file the writer below would produce; anything else is off.
export function readAutonomy(env=process.env){
  const read=readJson(path.join(autonomyHome(env),AUTONOMY_FILE));
  if(read.missing)return {on:false,reason:'missing'};
  const value=read.value;
  if(read.invalid||!record(value)||Object.keys(value).sort().join()!=='at,mode,response,version'
    ||value.version!==1||value.mode!=='until_fatal'||!words(value.response)||!iso(value.at))return {on:false,reason:'invalid'};
  return {on:true,value:{version:1,mode:'until_fatal',response:value.response,at:value.at}};
}

export function writeAutonomy(response,{env=process.env,now=Date.now()}={}){
  if(!words(response))throw new Error('autonomy_response_invalid');
  const value={version:1,mode:'until_fatal',response,at:new Date(now).toISOString()};
  writeJson(autonomyHome(env),AUTONOMY_FILE,value);
  return value;
}

// Turning it off keeps the record (renamed) so the last grant stays auditable.
export function clearAutonomy({env=process.env}={}){
  const home=autonomyHome(env);
  try{fs.renameSync(path.join(home,AUTONOMY_FILE),path.join(home,AUTONOMY_OFF_FILE));return true;}
  catch(error){if(error.code==='ENOENT')return false;throw error;}
}

// Automatic reopens per task. Each reopen claims one numbered slot file with an
// exclusive create, which is atomic: concurrent takers (any project) can never
// claim the same slot, and there is no lock to reclaim. A slot left half-written
// by a crash still counts. {count} when a slot was claimed, {refused:true,count}
// when all AUTO_REOPEN_LIMIT are taken (a fatal stop).
const reopenKey=(project,task)=>`${path.resolve(project)}|${task}`;
const slotPrefix=key=>createHash('sha256').update(key).digest('hex').slice(0,32);
// Counted by slot file name, like takeReopen; a group whose files are all unreadable is still shown.
export function readReopens(env=process.env){
  const dir=path.join(autonomyHome(env),REOPEN_DIR),groups={};
  let names;try{names=fs.readdirSync(dir);}catch(error){if(error.code==='ENOENT')return {};throw error;}
  for(const name of names){
    const prefix=/^([0-9a-f]{32})-\d+$/.exec(name)?.[1];if(!prefix)continue;
    let key=null;try{key=JSON.parse(fs.readFileSync(path.join(dir,name),'utf8')).key;}catch{}
    const group=groups[prefix]??={key:null,count:0};group.count++;
    if(typeof key==='string'&&slotPrefix(key)===prefix)group.key=key;
  }
  return Object.fromEntries(Object.entries(groups).map(([prefix,{key,count}])=>[key??`未识别|名额 ${prefix}`,count]));
}
export function takeReopen(project,task,{env=process.env,now=Date.now()}={}){
  if(typeof task!=='string'||!/^\d+\.[^/\\\s]+\/T-\d+$/.test(task))throw new Error('autonomy_task_invalid');
  const dir=path.join(autonomyHome(env),REOPEN_DIR),key=reopenKey(project,task);
  // A count kept some other way is never taken as "none yet".
  if(fs.existsSync(path.join(autonomyHome(env),'autonomy-reopens.json')))throw new Error('autonomy_reopens_legacy');
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  for(let slot=1;slot<=AUTO_REOPEN_LIMIT;slot++){
    try{fs.writeFileSync(path.join(dir,`${slotPrefix(key)}-${slot}`),JSON.stringify({key,slot,at:new Date(now).toISOString()})+'\n',{flag:'wx',mode:0o600});}
    catch(error){if(error.code==='EEXIST')continue;throw error;}
    return {count:slot};
  }
  return {refused:true,count:AUTO_REOPEN_LIMIT};
}

const DOCUMENTS=['requirements.md','design.md','tasks.md'],CHANGEABLE=new Set(['design.md','tasks.md','test-cases.json']);
const userCases=source=>{
  if(source===undefined)return new Map();
  const cases=JSON.parse(source)?.cases;
  if(!Array.isArray(cases))throw new Error('cases');
  return new Map(cases.filter(item=>item?.origin==='user').map(item=>[item.id,JSON.stringify(item)]));
};

const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const sortedObject=value=>Array.isArray(value)?value.map(sortedObject):record(value)
  ?Object.fromEntries(Object.keys(value).sort().map(key=>[key,sortedObject(value[key])])):value;
const equalJson=(a,b)=>same(sortedObject(a),sortedObject(b));
const includesAll=(after,before)=>before.every(value=>after.includes(value));

// Preserve old task clauses exactly. Design-only details may evolve, but
// explicit acceptance wording and fenced examples are retained as written.
// Added task sections/metadata cannot silently rewrite an older task's duties.
const versionHeading=/^(?:任务版本|设计版本|版本历史|版本记录|变更记录|Version history)$/i;
const versionRow=/^\|[^\r\n]*\bv\d+\b[^\r\n]*\|\s*$/;
const indent=body=>/^[ \t]*/.exec(body)[0].length;
const taskNames=body=>body.match(/(?<![A-Za-z0-9])T-[A-Za-z0-9][A-Za-z0-9._-]*/g)??[];
const acceptanceLanguage=body=>/验收|必验|必跑|必须|要求|真机|物理设备|physical[- ]device|\b(?:must|required|shall|acceptance)\b/i.test(body);
const weakensLanguage=body=>/取消|无需|不再|改为|可忽略|即可|延期|\b(?:optional|instead|waiv(?:e|ed)|no longer|not required|previous)\b/i.test(body);

function protectedRows(source,{grammar=TASK_GRAMMAR,priorIds=null,tasks=false}={}){
  const rows=[],ids=new Set(),declarations=[];let owner=null,ownerIndent=0,historyLevel=null;
  const physical=specLines(source);
  for(const line of tasks?taskLines(source,{grammar}):physical){
    const {body,declaration}=line;
    // Grammar 1 still decides declarations, but blank lines in a fence remain
    // literal bytes in both sides of a grammar-transition comparison.
    const fenced=line.fenced||physical[line.index]?.fenced===true;
    if(!body.trim()&&!fenced)continue;
    const heading=fenced?null:/^\s*(#{1,6})\s+(.+?)\s*$/.exec(body);
    if(heading){
      if(historyLevel!==null&&heading[1].length<=historyLevel)historyLevel=null;
      if(versionHeading.test(heading[2]))historyLevel=heading[1].length;
    }
    if(declaration){
      if(ids.has(declaration.id))throw new Error('duplicate task');ids.add(declaration.id);declarations.push({id:declaration.id,start:line.start});
      owner=declaration.id;ownerIndent=indent(body);
      if(priorIds&&!priorIds.has(owner)&&
        (declaration.completed||!/^\[NEW\](?:\s|$)/.test(declaration.description)))throw new Error('new task');
    }else if(owner!==null&&!(indent(body)>ownerIndent&&!/^\s*#/.test(body)))owner=null;
    if(priorIds&&owner!==null&&!priorIds.has(owner)){
      const affected=taskNames(body).find(id=>priorIds.has(id));
      if(affected&&(acceptanceLanguage(body)||weakensLanguage(body)))throw new Error(`override:${affected}`);
      continue;
    }
    rows.push({text:fenced?body:body.trimEnd(),start:line.start,owner,fenced,heading,history:historyLevel!==null&&!fenced&&versionRow.test(body),
      scope:tasks&&owner!==null&&!fenced&&!declaration?/^(\s*-\s*(?:范围|scope)\s*[:：]\s*)(.*)$/i.exec(body):null});
  }
  return {rows,ids,declarations};
}
function scopePaths(raw){
  const paths=[...raw.matchAll(/`([^`]+)`/g)].map(match=>match[1]);
  return paths.length&&raw.replace(/`[^`]+`/g,'').replace(/[\s,，、]/g,'')===''&&new Set(paths).size===paths.length?paths:null;
}
function documentProblem(before,after,file,grammar){
  if(before===after&&(!file.endsWith('/tasks.md')||grammar===TASK_GRAMMAR))return null;
  try{
    const tasks=file.endsWith('/tasks.md'),old=protectedRows(before,{tasks,grammar});
    const next=protectedRows(after,{tasks,priorIds:tasks?old.ids:null});
    if(!tasks){
      const protectedDesign=old.rows.some(row=>row.fenced||acceptanceLanguage(row.text));
      // No task/AC contract is built from design-only implementation details.
      // Keep explicit legacy acceptance statements and examples protected.
      if(!protectedDesign&&!next.rows.some(row=>acceptanceLanguage(row.text)||weakensLanguage(row.text)))return null;
    }
    let position=0;
    for(const row of next.rows){
      const prior=old.rows[position];
      if(prior?.text===row.text&&prior.owner===row.owner){position++;continue;}
      // A history row is metadata only in an explicitly named history section;
      // a table elsewhere may contain an obligation and is never ignored.
      if(row.history){
        const affected=taskNames(row.text).find(id=>old.ids.has(id));
        if(affected&&(acceptanceLanguage(row.text)||weakensLanguage(row.text)))
          return `${file}（${affected}）的版本说明改变了既有验收，需明确确认规格变更`;
        continue;
      }
      if(!tasks&&!row.fenced&&!acceptanceLanguage(row.text)&&!weakensLanguage(row.text))continue;
      if(tasks&&!row.fenced&&row.heading){
        // A new subsection is scaffolding only when it introduces a NEW task,
        // never when it changes the grouping/meaning of an existing task.
        const index=next.rows.indexOf(row),following=next.rows.slice(index+1);
        const level=row.heading[1].length,until=following.findIndex(item=>item.heading&&item.heading[1].length<=level);
        const block=until<0?following:following.slice(0,until);
        const boundary=until<0?after.length:following[until].start;
        const newTasks=next.declarations.filter(item=>item.start>row.start&&item.start<boundary);
        if(newTasks.length&&newTasks.every(item=>!old.ids.has(item.id))
          &&!block.some(item=>item.owner!==null&&old.ids.has(item.owner))
          &&!acceptanceLanguage(row.text)&&!weakensLanguage(row.text))continue;
      }
      if(tasks&&!row.fenced){
        const dependency=DEPENDENCY.exec(row.text);
        if(dependency&&!old.ids.has(dependency[1])&&next.ids.has(dependency[1])
          &&dependency[2].split(/[,，、\s]+/).filter(Boolean).every(id=>next.ids.has(id)))continue;
      }
      if(prior?.owner===row.owner&&prior?.scope&&row.scope){
        const was=scopePaths(prior.scope[2]),now=scopePaths(row.scope[2]);
        if(was&&now&&includesAll(now,was)){position++;continue;}
      }
      return `${file}${prior?.owner?`（${prior.owner}）`:''} 的既有条款改变，无法证明验收未减弱，需明确确认规格变更`;
    }
    if(position!==old.rows.length||tasks&&!includesAll([...next.ids],[...old.ids]))
      return `${file} 删除了既有条款或任务，需明确确认规格变更`;
    return null;
  }catch(error){
    const affected=/^override:(T-[A-Za-z0-9._-]+)$/.exec(error.message)?.[1];
    return affected?`${file}（${affected}）的新任务条款改变了既有验收，需明确确认规格变更`:
      `${file} 无法可靠比较，需明确确认规格变更`;
  }
}

function caseProtectionProblem(before,after,file,references,acceptanceIds,taskIds){
  let old,next;
  try{
    old=before===undefined?null:JSON.parse(before);next=after===undefined?null:JSON.parse(after);
    if(old&&validateTestCases(old).length||next&&validateTestCases(next).length)throw new Error('cases');
  }catch{return '提案的测试用例无法解析';}
  if(old===null)return null;
  const {cases:was,...beforeContract}=old,{cases:now=[],...afterContract}=next??{};
  if(next!==null&&!equalJson(beforeContract,afterContract))return `${file} 用例合同改变，需明确确认规格变更`;
  // A written reference is retained even when an old case mislabeled itself
  // optional. The boolean alone cannot override an approved task's obligation.
  for(const prior of was.filter(item=>item.blocking||references.has(item.id)
    ||item.acIds.some(id=>acceptanceIds.has(id))&&item.taskIds.some(id=>taskIds.has(id)))){
    const candidate=now.find(item=>item.id===prior.id);
    if(!candidate)return `${file} 删除了必验用例 ${prior.id}，需明确确认规格变更`;
    if(prior.blocking&&candidate.blocking!==true)return `${file} 降低了 ${prior.id} 的 blocking，需明确确认规格变更`;
    // QA defers a case until every linked task completes. Adding a task can
    // therefore delay a mandatory check: task bindings must be the same set.
    // AC additions retain the old obligations; JSON key order and provenance
    // do not change the required preconditions/steps/outcome.
    for(const key of Object.keys(prior)){
      if(['id','blocking','origin'].includes(key))continue;
      const preserved=key==='taskIds'?includesAll(candidate[key],prior[key])&&includesAll(prior[key],candidate[key])
        :key==='acIds'?includesAll(candidate[key],prior[key])
        :equalJson(prior[key],candidate[key]);
      if(!preserved)return `${file} 改变了必验用例 ${prior.id} 的 ${key}，需明确确认规格变更`;
    }
    if(Object.keys(candidate).some(key=>!Object.hasOwn(prior,key)))return `${file} 改变了必验用例 ${prior.id} 的字段，需明确确认规格变更`;
  }
  return null;
}

// Whether a change proposal may be approved under the standing authorization,
// judged from the complete before/after contents. A generated/inferred blocking
// case is an obligation too. Unknown prose edits are not presumed harmless.
// Returns null when it may, else the reason in plain words.
export function standingProposalProblem(before,proposal){
  if(!record(before)||!Array.isArray(before.directories)||!before.directories.every(dir=>typeof dir==='string')
    ||!record(before.files)||!Object.values(before.files).every(value=>typeof value==='string')
    ||!record(proposal)||!record(proposal.files)||!Object.keys(proposal.files).length
    ||!Object.values(proposal.files).every(value=>typeof value==='string')
    ||!Array.isArray(proposal.changedUserCases)||!Array.isArray(proposal.removed))return '提案内容不完整，无法判断';
  if(proposal.changedUserCases.length)return '提案删除或减弱了用户用例';
  if(proposal.removed.length)return '提案删除了功能';
  const features=new Set(Object.keys(proposal.files).map(file=>file.split('/')[0]));
  for(const feature of features){
    if(!before.directories.includes(feature))return '提案新增了功能';
    if(DOCUMENTS.some(name=>typeof proposal.files[`${feature}/${name}`]!=='string'))return '提案内容不完整，无法判断';
  }
  for(const [file,content] of Object.entries(proposal.files)){
    const [feature,name,...rest]=file.split('/');
    if(rest.length||!DOCUMENTS.includes(name)&&name!=='test-cases.json')return `提案改了规格以外的文件（${file}）`;
    if(content!==before.files[file]&&!CHANGEABLE.has(name))return '提案改了需求';
  }
  let grammar=recordedTaskGrammar(undefined);
  try{if(before.status!==undefined)grammar=recordedTaskGrammar(JSON.parse(before.status)?.taskGrammar);}
  catch{return '原规格语法记录无法解析，需明确确认规格变更';}
  for(const feature of features){
    const file=`${feature}/test-cases.json`;
    let was,now;
    // A test-cases.json the proposal leaves out is deleted on save: its user cases count as removed.
    try{was=userCases(before.files[file]);now=userCases(proposal.files[file]);}
    catch{return '提案的测试用例无法解析';}
    for(const [id,item] of was)if(now.get(id)!==item)return '提案删除或减弱了用户用例';
    const references=new Set(DOCUMENTS.flatMap(name=>before.files[`${feature}/${name}`]?.match(/\bTC-\d{3,}\b/g)??[]));
    const caseProblem=caseProtectionProblem(before.files[file],proposal.files[file],file,references,
      declaredAcceptanceIds(before.files[`${feature}/requirements.md`]??''),
      new Set(taskLines(before.files[`${feature}/tasks.md`]??'',{grammar}).filter(row=>row.declaration).map(row=>row.declaration.id)));
    if(caseProblem)return caseProblem;
  }
  for(const feature of features)for(const name of ['design.md','tasks.md']){
    const file=`${feature}/${name}`;
    if(typeof before.files[file]!=='string')return '提案内容不完整，无法判断';
    const problem=documentProblem(before.files[file],proposal.files[file],file,grammar);
    if(problem)return problem;
  }
  return null;
}

// The saved archive (.reviews/prd-change-<digest>.json) must be this proposal and
// must be exactly what the specs now hold: features listed, proposal files written,
// every other feature untouched.
export function standingArchiveProblem(specsDir,archive,digest){
  if(!record(archive)||archive.proposal?.proposalDigest!==digest)return '找不到这份提案的归档';
  const problem=standingProposalProblem(archive.before,archive.proposal);
  if(problem)return problem;
  const {before,proposal}=archive;
  const listed=fs.readdirSync(specsDir).filter(dir=>/^\d+\./.test(dir)).sort();
  if(listed.join('\n')!==[...before.directories].sort().join('\n'))return '规格目录的功能与提案不一致';
  // What the save leaves (cm-prd change.mjs applyPrdChange): the selected features hold
  // exactly the proposal's files, every other feature its original ones. Compare the
  // complete spec file set, so a file the archive does not list cannot stay on disk.
  const selected=Array.isArray(archive.selected)?archive.selected:[...new Set(Object.keys(proposal.files).map(file=>file.split('/')[0]))];
  const expected={...before.files};
  for(const file of Object.keys(expected))if(selected.includes(file.split('/')[0]))delete expected[file];
  Object.assign(expected,proposal.files);
  const onDisk={};
  for(const dir of listed)for(const name of [...DOCUMENTS,'test-cases.json']){
    const file=`${dir}/${name}`;try{onDisk[file]=fs.readFileSync(path.join(specsDir,file),'utf8');}catch(error){if(error.code!=='ENOENT')return '规格文件与提案不一致';}
  }
  const files=Object.keys(expected).sort();
  if(files.join('\n')!==Object.keys(onDisk).sort().join('\n')||files.some(file=>onDisk[file]!==expected[file]))return '规格文件与提案不一致';
  return null;
}
