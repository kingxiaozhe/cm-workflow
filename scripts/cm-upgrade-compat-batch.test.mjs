// Upgrade compatibility (review R2-02, part 2): a batch started before the batch
// execution table (batch.memberDevelopment, design 3.7) resumes on the new code with its
// original plan digest, member fingerprints and path, and runs to completion.
//
// Archive format pinned from f73402d (the last commit before the upgrade):
// - scripts/cm-ai-batch-run.mjs: planDigest=digest(config) (line 160), and the first
//   advance writes record('batch_start',{from_key,[BATCH_SEGMENT_FIELD]:batchSegment(batchId)})
//   (line 530) through cm-log-event.py before any member run exists;
// - scripts/cm-ai-batch-host.mjs: config={...batch,controlPolicy} for a v2 batch;
// - runtime/js/cm-ai/batch-location.mjs: batchSegment = first 8 chars of batchId ('.'->'-')
//   + '-' + sha256(batchId)[0..12], field worktree_segment.
// A real f73402d run of this fixture wrote exactly these batch_start keys (checked by the
// last test whenever f73402d is in the local history; CI shallow clones skip it).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
import {buildManifest} from './cm-spec-manifest.mjs';
import {configFingerprint} from '../runtime/js/cm-ai/codex-config.mjs';

const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const LEGACY_COMMIT='f73402d';
const batchId='legacy-batch-run',repositoryId='legacy-batch-fixture';
const policy={version:2,development:'conversation',bootstrap:'disabled',qa:'run',qaFix:'disabled'};
const develop={status:'succeeded',value:{outcome:'implemented',application:{status:'no_relevant_lesson',note:null},
  retrospective:{status:'no_new_lesson',candidates:[],reason:null}}};
// The batch_start keys f73402d wrote (cm-log-event.py envelope + record() data).
const LEGACY_START_KEYS=['schema_version','run_id','at','workflow','event','runtime','project','detail','phase',
  'project_path','specs_path','repository_id','plan_digest','from_key','worktree_segment','event_id'].sort();

// Two serial members (T-002 waits for T-001), task grammar 2 approval, v2 conversation
// development with QA, no execution table: the shape every pre-upgrade batch had.
function fixture(t){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-upgrade-batch-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const specsDir=path.join(root,'specs'),codeProject=path.join(root,'app'),bin=path.join(root,'bin'),reject=path.join(root,'reject-T-002');
  fs.mkdirSync(path.join(specsDir,'1.work'),{recursive:true});fs.mkdirSync(codeProject);fs.mkdirSync(bin);
  for(const name of ['requirements.md','design.md'])fs.writeFileSync(path.join(specsDir,'1.work',name),'# Fixture\n');
  fs.writeFileSync(path.join(specsDir,'1.work/tasks.md'),
    '- [ ] T-001: first\n  - 范围: `target.mjs`\n- [ ] T-002: second\n  - 范围: `other.mjs`\n\n## 依赖关系\n\n- T-002 依赖 T-001\n');
  fs.writeFileSync(path.join(specsDir,'.cm-specs-status'),JSON.stringify({status:'approved',features:['1.work'],
    specFiles:buildManifest(specsDir),taskGrammar:2}));
  fs.writeFileSync(path.join(codeProject,'requirements.md'),'# Fixture\n');
  for(const args of [['init','-b','main'],['config','user.name','Fixture'],['config','user.email','fixture@example.invalid'],['add','-A'],['commit','-m','baseline']]){
    const r=spawnSync('git',['-C',codeProject,...args],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);
  }
  const workflow={qa:{commands:[{id:'value',caseIds:[],command:[process.execPath,'-e',"import('./target.mjs').then(m=>{if(m.value!==42)process.exit(1)})"]}],
    environment:{kind:'web',carrier:'browser',target:'fixture-target',scope:'local'}},documentationPaths:[],applicableAgentFiles:[]};
  const bundle={batch:{version:1,repositoryId,batchId,specsDir,codeProject,tasks:[
    {feature:'1.work',taskId:'T-001',scope:['target.mjs'],requirements:['requirements.md']},
    {feature:'1.work',taskId:'T-002',scope:['other.mjs'],requirements:['requirements.md']}]},
  workflows:{'1.work/T-001':workflow,'1.work/T-002':workflow}};
  fs.writeFileSync(path.join(root,'run.json'),JSON.stringify(bundle));
  fs.writeFileSync(path.join(root,'control.json'),JSON.stringify(policy));
  fs.writeFileSync(path.join(root,'review.json'),JSON.stringify({model:'fixture',preflight:{passed:true,cli_model:'fixture',
    prompt_transport:'stdin',config_fingerprint:configFingerprint({cwd:codeProject,model:'fixture'})}}));
  // Fixture Codex reviewer: approves, except T-002 while the reject marker exists.
  fs.writeFileSync(path.join(bin,'codex'),`#!${process.execPath}
const fs=require('node:fs');let prompt='';process.stdin.on('data',part=>prompt+=part);process.stdin.on('end',()=>{
  const marker='<cm-review-data-json>\\n',data=JSON.parse(prompt.slice(prompt.indexOf(marker)+marker.length));
  const reject=data.reviewPackage.identity.taskId==='T-002'&&fs.existsSync(${JSON.stringify(reject)});
  const value={verdict:reject?'changes_requested':'approved',packageDigest:data.reviewPackage.packageDigest,examinedPaths:data.examinedPaths,
    findings:reject?[{id:'F1',severity:'P2',path:'other.mjs',message:'Use 2',evidence:'Fixture finding'}]:[],summary:'Synthetic review'};
  for(const event of [{type:'thread.started',thread_id:'fixture-'+Date.now()},{type:'turn.started'},
    {type:'item.completed',item:{type:'agent_message',text:JSON.stringify(value)}},{type:'turn.completed'}])process.stdout.write(JSON.stringify(event)+'\\n');
});
`,{mode:0o700});
  for(const [task,file,source] of [['T-001','target.mjs','export const value = 42;\n'],['T-002','other.mjs','export const other = 1;\n']]){
    const dir=path.join(root,'answers/1.work',task);fs.mkdirSync(dir,{recursive:true});
    fs.writeFileSync(path.join(dir,'develop.json'),JSON.stringify({...develop,edits:{[file]:`${task}.txt`}}));
    fs.writeFileSync(path.join(dir,`${task}.txt`),source);
    fs.writeFileSync(path.join(dir,'documentation-inspect.json'),JSON.stringify({status:'completed',reason:'Fixture inspected'}));
    fs.writeFileSync(path.join(dir,'qa-assess.json'),JSON.stringify({confirmed:true}));
  }
  const plan=path.join(root,'plan.json');
  const writePlan=mode=>fs.writeFileSync(plan,JSON.stringify({config:'run.json',mode,hostContext:'legacy-host',
    ...(mode==='resume'?{originalHostContext:'legacy-host'}:{}),controlConfig:'control.json',
    permissions:['--review-config','review.json'],answers:'answers',
    checks:{'1.work/T-001':[{id:'syntax',command:[process.execPath,'--check','target.mjs']}],
      '1.work/T-002':[{id:'syntax',command:[process.execPath,'--check','other.mjs']}]}}));
  writePlan('create');
  const drive=(workflowRoot=repo)=>spawnSync(process.execPath,[path.join(workflowRoot,'scripts/cm-ai-batch-drive.mjs'),'--plan',plan,'advance'],
    {encoding:'utf8',timeout:120000,env:{...process.env,PATH:bin+path.delimiter+process.env.PATH,
      CM_WORKFLOW_HOME:path.join(root,'home'),CM_WORKFLOW_LOG_HOME:path.join(root,'logs')}});
  return {root,specsDir,codeProject,bundle,reject,writePlan,drive,log:path.join(specsDir,'运行日志.jsonl')};
}
// The plan digest and worktree segment exactly as f73402d computed them.
const legacyPlanDigest=bundle=>digest({...bundle.batch,controlPolicy:policy});
const legacySegment=id=>`${id.slice(0,8).replace(/\./g,'-')}-${createHash('sha256').update(id).digest('hex').slice(0,12)}`;
const batchRows=f=>fs.readFileSync(f.log,'utf8').trim().split('\n').map(line=>JSON.parse(line))
  .filter(row=>row.run_id===batchId&&row.event==='decision'&&row.phase.startsWith('batch_'));
const memberStates=f=>{
  const dir=path.join(f.specsDir,'.reviews/.execution');
  return Object.fromEntries(fs.readdirSync(dir).filter(name=>fs.existsSync(path.join(dir,name,'state.json')))
    .map(name=>[name,JSON.parse(fs.readFileSync(path.join(dir,name,'state.json'),'utf8'))]));
};
const lastResult=r=>JSON.parse(r.stdout.slice(r.stdout.indexOf('{'),r.stdout.lastIndexOf('}')+1)).result;
// Resume with the current code until the batch stops on its own.
function resumeToDone(f){
  f.writePlan('resume');let result=null;
  for(let round=0;round<6;round++){
    const r=f.drive();assert.equal(r.status,0,r.stderr);result=lastResult(r);
    if(['run_done','blocked'].includes(result.state)||result.outcome==='rejected')break;
  }
  return result;
}
function assertLegacyCompletion(f,expectedPlanDigest){
  const rows=batchRows(f);
  assert.deepEqual(rows.map(row=>row.phase),['batch_start','batch_task_committed','batch_handoff','batch_task_committed']);
  assert.deepEqual([...new Set(rows.map(row=>row.plan_digest))],[expectedPlanDigest],'every row keeps the pre-upgrade plan digest');
  const text=fs.readFileSync(f.log,'utf8');
  assert.doesNotMatch(text,/memberDevelopment|member_development/,'no execution table enters the log');
  assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(path.join(f.root,'run.json'),'utf8')).batch,'memberDevelopment'),false);
  for(const [runId,state] of Object.entries(memberStates(f)))
    assert.doesNotMatch(JSON.stringify(state),/memberDevelopment/,`${runId} carries no execution table`);
  const log=spawnSync('git',['-C',f.codeProject,'log','--format=%s'],{encoding:'utf8'}).stdout;
  assert.deepEqual(log.trim().split('\n'),['T-002: second','T-001: first','baseline'],'both members committed on the original serial path');
  assert.match(fs.readFileSync(path.join(f.specsDir,'1.work/tasks.md'),'utf8'),/\[x\] T-001[\s\S]*\[x\] T-002/);
}

test('a batch whose pre-upgrade host wrote batch_start and stopped before its first member resumes on the old plan digest to run_done',t=>{
  const f=fixture(t),planDigest=legacyPlanDigest(f.bundle);
  // Hand-written archive: the one row f73402d wrote at the first advance, before any member run.
  const row={schema_version:1,run_id:batchId,at:'2026-10-20T08:00:00+00:00',workflow:'cm-ai',event:'decision',runtime:'codex',
    project:'app',detail:'Approved task batch started',phase:'batch_start',project_path:f.codeProject,specs_path:f.specsDir,
    repository_id:repositoryId,plan_digest:planDigest,from_key:'1.work/T-001',worktree_segment:legacySegment(batchId),event_id:randomUUID()};
  assert.deepEqual(Object.keys(row).sort(),LEGACY_START_KEYS);
  fs.writeFileSync(f.log,JSON.stringify(row)+'\n');
  const result=resumeToDone(f);
  assert.equal(result.state,'run_done',JSON.stringify(result).slice(0,800));
  assertLegacyCompletion(f,planDigest);
  assert.equal(batchRows(f)[0].event_id,row.event_id,'the original batch_start row is kept, not rewritten');
});

const legacyAvailable=spawnSync('git',['-C',repo,'cat-file','-e',`${LEGACY_COMMIT}^{commit}`]).status===0;
test('a batch the f73402d code really ran to mid-member resumes on the new code with unchanged fingerprints to run_done',
  {skip:legacyAvailable?false:`${LEGACY_COMMIT} 不在本地历史（浅克隆），跳过真实旧代码运行`,timeout:300000},t=>{
  const old=fs.mkdtempSync(path.join(os.tmpdir(),'cm-upgrade-old-'));t.after(()=>fs.rmSync(old,{recursive:true,force:true}));
  const archive=spawnSync('sh',['-c',`git -C "$1" archive ${LEGACY_COMMIT} | tar -x -C "$2"`,'archive',repo,old],{encoding:'utf8'});
  assert.equal(archive.status,0,archive.stderr);
  const f=fixture(t);fs.writeFileSync(f.reject,'');
  // Pre-upgrade run: T-001 done and handed off, T-002 stopped after a changes_requested review.
  const first=f.drive(old);assert.equal(first.status,0,first.stderr);
  const stopped=lastResult(first);
  assert.deepEqual([stopped.state,stopped.code,stopped.identity.taskId],['changes_requested','revision_answer_required','T-002']);
  const before=batchRows(f),states=memberStates(f);
  assert.deepEqual(before.map(row=>row.phase),['batch_start','batch_task_committed','batch_handoff']);
  // The hand-written archive above matches the real one: same row keys, same digest formula.
  assert.deepEqual(Object.keys(before[0]).sort(),LEGACY_START_KEYS);
  assert.equal(before[0].plan_digest,legacyPlanDigest(f.bundle));
  assert.equal(before[0].worktree_segment,legacySegment(batchId));
  assert.equal(Object.keys(states).length,2);
  for(const state of Object.values(states))assert.deepEqual(Object.keys(state.fingerprints).sort(),['config','inputs','workflow']);
  // Upgrade: the T-002 author answers the review; the reviewer now approves.
  fs.rmSync(f.reject);
  const answers=path.join(f.root,'answers/1.work/T-002');
  fs.writeFileSync(path.join(answers,'develop-a2.json'),JSON.stringify({...develop,edits:{'other.mjs':'second.txt'}}));
  fs.writeFileSync(path.join(answers,'second.txt'),'export const other = 2;\n');
  const result=resumeToDone(f);
  assert.equal(result.state,'run_done',JSON.stringify(result).slice(0,800));
  assertLegacyCompletion(f,before[0].plan_digest);
  assert.deepEqual(batchRows(f).slice(0,3),before,'the pre-upgrade rows are kept byte for byte');
  const after=memberStates(f);
  for(const [runId,state] of Object.entries(states))
    assert.deepEqual(after[runId].fingerprints,state.fingerprints,`${runId} keeps its pre-upgrade fingerprints`);
  assert.equal(fs.readFileSync(path.join(f.codeProject,'other.mjs'),'utf8'),'export const other = 2;\n');
});
