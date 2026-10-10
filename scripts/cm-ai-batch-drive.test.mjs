import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {buildManifest} from './cm-spec-manifest.mjs';
import {configFingerprint} from '../runtime/js/cm-ai/codex-config.mjs';
import {batchDevelopAttempts} from './cm-ai-batch-drive.mjs';
import {runLiveDriver} from './fixtures/live-evidence-driver.mjs';

const DRIVER=fileURLToPath(new URL('./cm-ai-batch-drive.mjs',import.meta.url));
const reviewer=fileURLToPath(new URL('./fixtures/codex-review-process.mjs',import.meta.url));
const key='1.work/T-001';
const develop={status:'succeeded',value:{outcome:'implemented',
  application:{status:'no_relevant_lesson',note:null},
  retrospective:{status:'no_new_lesson',candidates:[],reason:null}},edits:{'target.mjs':'target.txt'}};

function fixture(t,count=1){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-batch-drive-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const specsDir=path.join(root,'specs5'),codeProject=path.join(root,'app'),bin=path.join(root,'bin');
  fs.mkdirSync(path.join(specsDir,'1.work'),{recursive:true});fs.mkdirSync(codeProject);fs.mkdirSync(bin);
  for(const name of ['requirements.md','design.md'])fs.writeFileSync(path.join(specsDir,'1.work',name),'# Fixture\n');
  fs.writeFileSync(path.join(specsDir,'1.work','tasks.md'),Array.from({length:count},(_,n)=>
    `- [ ] T-00${n+1}: implement target ${n+1}\n`).join(''));
  fs.writeFileSync(path.join(specsDir,'.cm-specs-status'),JSON.stringify({status:'approved',features:['1.work'],specFiles:buildManifest(specsDir)}));
  fs.writeFileSync(path.join(codeProject,'requirements.md'),'# Fixture\n');
  for(const args of [['init','-b','main'],['config','user.name','Fixture'],['config','user.email','fixture@example.invalid'],['add','-A'],['commit','-m','baseline']]){
    const run=spawnSync('git',['-C',codeProject,...args],{encoding:'utf8'});assert.equal(run.status,0,run.stderr);
  }
  const batch={version:1,repositoryId:'batch-drive',batchId:'batch-drive-run',specsDir,codeProject,
    tasks:Array.from({length:count},(_,n)=>({feature:'1.work',taskId:`T-00${n+1}`,
      scope:[n===0?'target.mjs':`target${n+1}.mjs`],requirements:['requirements.md']}))};
  fs.writeFileSync(path.join(root,'batch.json'),JSON.stringify({batch,workflows:Object.fromEntries(batch.tasks.map(task=>
    [`1.work/${task.taskId}`,{
    documentationPaths:[],applicableAgentFiles:[],qa:{commands:[{id:'value',caseIds:[],
      command:[process.execPath,'-e',"import('./target.mjs').then(m=>{if(m.value!==42)process.exit(1)})"]}],
      environment:{kind:'web',carrier:'browser',target:'fixture-target',scope:'local'}}}]))}));
  fs.writeFileSync(path.join(root,'review.json'),JSON.stringify({model:'fixture',preflight:{passed:true,
    cli_model:'fixture',prompt_transport:'stdin',config_fingerprint:configFingerprint({cwd:codeProject,model:'fixture'})}}));
  fs.copyFileSync(reviewer,path.join(bin,'codex'));fs.chmodSync(path.join(bin,'codex'),0o700);
  const answers=path.join(root,'answers','1.work','T-001');fs.mkdirSync(answers,{recursive:true});
  fs.writeFileSync(path.join(answers,'target.txt'),'export const value = 42;\n');
  const write=(name,value)=>fs.writeFileSync(path.join(answers,name),JSON.stringify(value));
  const plan=(extra={})=>{
    const file=path.join(root,`plan-${Math.random().toString(36).slice(2)}.json`);
    const value={config:'batch.json',mode:'create',hostContext:'batch-host-a',
      permissions:['--allow-qa'],answers:'answers',checks:Object.fromEntries(batch.tasks.map(task=>
        [`1.work/${task.taskId}`,[{id:'syntax',command:[process.execPath,'--check',task.taskId==='T-001'?'target.mjs':'target2.mjs']}]])),...extra};
    // A new batch requires a bound review configuration (it grants no review).
    if(!value.permissions.includes('--review-config'))value.permissions=[...value.permissions,'--review-config','review.json'];
    fs.writeFileSync(file,JSON.stringify(value));
    return file;
  };
  const drive=(file,operation)=>spawnSync(process.execPath,[DRIVER,'--plan',file,operation],{encoding:'utf8',timeout:60000,
    env:{...process.env,PATH:bin+path.delimiter+process.env.PATH,CM_WORKFLOW_HOME:path.join(root,'home'),
      CM_WORKFLOW_LOG_HOME:path.join(root,'logs')}});
  const store=path.join(specsDir,'.reviews','.execution');
  return {root,answers,codeProject,specsDir,plan,drive,write,store};
}
function prepared(f){
  f.write('develop.json',develop);
  f.write('qa-assess.json',{scores:{scope:2,risk:2,accumulation:2,boundary:2},
    changes:{api:false,migration:false,authentication:false,authorization:false,payment:false}});
  f.write('documentation-inspect.json',{status:'completed',reason:'README and task artifacts inspected'});
}
function noStore(f){assert.equal(fs.existsSync(f.store),false);assert.equal(fs.existsSync(path.join(f.specsDir,'运行日志.jsonl')),false);}
test('batch reaches live logic and browser QA through the real member host',async t=>{
  const f=fixture(t);prepared(f);
  const cases=['logic','browser'].map((kind,index)=>({id:`TC-00${index+1}`,origin:'user',kind,blocking:true,
    acIds:[],taskIds:['T-001'],title:'Fixture observation',preconditions:[],steps:['Observe fixture'],expected:['value is 42'],cleanup:[]}));
  fs.writeFileSync(path.join(f.specsDir,'1.work/test-cases.json'),JSON.stringify({schemaVersion:'1.0',feature:'work',cases}));
  fs.writeFileSync(path.join(f.specsDir,'.cm-specs-status'),JSON.stringify({status:'approved',features:['1.work'],specFiles:buildManifest(f.specsDir)}));
  const plan=f.plan({permissions:['--allow-qa','--allow-review',`${key}:1`,'--browser-qa','available'],
    liveEvidence:{directory:'exchange',kinds:['qa_logic','qa_browser'],timeoutMs:1000}});
  const out=await runLiveDriver(DRIVER,plan,'advance',row=>row.kind==='qa_logic'
    ?{verdict:'SUPPORTED',evidence:['Fixture target.mjs exports 42']}
    :{verdict:'BLOCKED',evidence:[],environment:row.payload.environment,cleanup:'not_needed'},
    {timeoutMs:60000,env:{...process.env,PATH:path.join(f.root,'bin')+path.delimiter+process.env.PATH,
      CM_WORKFLOW_HOME:path.join(f.root,'home'),CM_WORKFLOW_LOG_HOME:path.join(f.root,'logs')}});
  assert.equal(out.status,0,out.stderr);assert.deepEqual(out.requests.map(r=>r.kind),['qa_logic','qa_browser']);
  assert.equal(JSON.parse(out.stdout).result.code,'qa_result_blocked');
});
test('batch live verification request can reject a written requirement without review',async t=>{
  const f=fixture(t);prepared(f);
  fs.writeFileSync(path.join(f.specsDir,'1.work/tasks.md'),'- [ ] T-001: implement target\n  - 验证: value is 43\n');
  fs.writeFileSync(path.join(f.specsDir,'.cm-specs-status'),JSON.stringify({status:'approved',features:['1.work'],specFiles:buildManifest(f.specsDir)}));
  const plan=f.plan({permissions:['--allow-qa','--verification-precheck'],
    liveEvidence:{directory:'exchange',kinds:['verification_precheck'],timeoutMs:1000}});
  const out=await runLiveDriver(DRIVER,plan,'advance',row=>{
    assert.equal(row.kind,'verification_precheck');
    assert.match(fs.readFileSync(path.join(f.codeProject,'target.mjs'),'utf8'),/42/);
    return {items:[{requirement:'value is 43',satisfied:false,evidence:'Fixture source exports 42'}]};
  },{timeoutMs:60000,env:{...process.env,CM_WORKFLOW_HOME:path.join(f.root,'home'),CM_WORKFLOW_LOG_HOME:path.join(f.root,'logs')}});
  assert.equal(out.status,0,out.stderr);assert.equal(out.requests.length,1);
  assert.match(out.stdout,/verification_precheck_failed/);
});

test('help names plan invocation',()=>{
  const run=spawnSync(process.execPath,[DRIVER,'--help'],{encoding:'utf8'});
  assert.equal(run.status,0);assert.match(run.stdout,/--plan PLAN\.json <operation>/);
});
test('batch driver accepts input limit as a value before host launch',t=>{
  const f=fixture(t);
  const run=f.drive(f.plan({permissions:['--allow-qa','--input-limit','1048576']}),'advance');
  assert.equal(run.status,2);assert.match(run.stderr,/develop\.json/);
  assert.doesNotMatch(run.stderr,/permissions 无效|--input-limit 文件不存在/);
  noStore(f);
});
test('real batch host advances with authored edit and actual check, then resumes and reports status',t=>{
  const f=fixture(t);prepared(f);
  const first=f.drive(f.plan(),'advance');assert.equal(first.status,0,first.stderr);
  assert.match(first.stderr,/应答 develop/);assert.match(first.stderr,/应答 check/);
  assert.equal(fs.readFileSync(path.join(f.codeProject,'target.mjs'),'utf8'),'export const value = 42;\n');
  const before=fs.readFileSync(path.join(f.specsDir,'运行日志.jsonl'));
  const state=path.join(f.store,fs.readdirSync(f.store).find(name=>name.startsWith('task-')),'state.json');
  const stateBefore=fs.readFileSync(state);
  const resumed=f.drive(f.plan({mode:'resume',originalHostContext:'batch-host-a'}),'status');
  assert.equal(resumed.status,0,resumed.stderr);
  assert.equal(JSON.parse(resumed.stdout).result.batchId,'batch-drive-run');
  assert.deepEqual(fs.readFileSync(path.join(f.specsDir,'运行日志.jsonl')),before);
  assert.deepEqual(fs.readFileSync(state),stateBefore);
  const again=f.drive(f.plan({mode:'resume',originalHostContext:'batch-host-a'}),'advance');
  assert.equal(again.status,0,again.stderr);
});
test('real batch reaches completion with an independently dispatched fixture review',t=>{
  const f=fixture(t);prepared(f);
  f.write('develop-a2.json',develop);
  const permissions=['--allow-qa','--review-config','review.json','--allow-review',`${key}:1`];
  const first=f.drive(f.plan({permissions}),'advance');
  assert.equal(first.status,0,first.stderr);assert.match(first.stderr,/应答 check/);
  let result=JSON.parse(first.stdout).result,stderr=first.stderr;
  for(let n=0;n<4&&result.state!=='run_done';n++){
    const next=f.drive(f.plan({mode:'resume',originalHostContext:'batch-host-a',permissions}),'advance');
    assert.equal(next.status,0,next.stderr);result=JSON.parse(next.stdout).result;stderr+=next.stderr;
  }
  assert.equal(result.state,'run_done',JSON.stringify(result));
  assert.match(stderr,/开始检查.*value/,'quiet QA command start reaches the batch caller');
  assert.match(stderr,/检查结束.*value.*passed/,'quiet QA command result reaches the batch caller');
});
// Deliberately replaced (#30). The batch driver has no separate decision step, so
// demanding develop-a2.json before any findings existed made a first review with
// a possible revision impossible. Without the answer it now stops after the review.
function changesRequested(f){
  const cli=path.join(f.root,'bin','codex');
  fs.writeFileSync(cli,fs.readFileSync(reviewer,'utf8').replace("verdict:'approved'","verdict:'changes_requested'")
    .replace('findings:[]',"findings:[{id:'F1',severity:'P2',path:'target.mjs',message:'Revise value',evidence:'Fixture finding'}]"));
  fs.chmodSync(cli,0o700);
}
const developIntents=f=>{
  const state=path.join(f.store,fs.readdirSync(f.store).find(name=>name.startsWith('task-')),'state.json');
  return JSON.parse(fs.readFileSync(state,'utf8')).records.filter(row=>row.payload.type==='effect-intent'
    &&row.payload.effect.kind==='develop').map(row=>row.payload.effect.id);
};
test('batch review without a second-round answer stops at changes_requested after the first review',t=>{
  const f=fixture(t);prepared(f);changesRequested(f);
  const permissions=['--allow-qa','--review-config','review.json','--allow-review',`${key}:1`];
  const run=f.drive(f.plan({permissions}),'advance');
  assert.equal(run.status,0,run.stderr);
  assert.match(run.stderr,/没有 develop-a2\.json/);assert.match(run.stderr,/\.reviews\/work-T-001-r1\.md/);
  const result=JSON.parse(run.stdout).result;
  assert.equal(result.state,'changes_requested',run.stdout);assert.equal(result.code,'revision_answer_required');
  assert.equal(result.identity.attempt,2);assert.equal(result.pendingAction,'resume');
  assert(fs.existsSync(path.join(f.specsDir,'.reviews','work-T-001-r1.md')));
  assert.deepEqual(developIntents(f),['develop-1'],'no second-round develop intent before its answer exists');
  // The findings exist now: the revision is written and the same batch continues.
  fs.writeFileSync(path.join(f.answers,'target-a2.txt'),'export const value = 43;\n');
  f.write('develop-a2.json',{...develop,edits:{'target.mjs':'target-a2.txt'}});
  const revised=f.drive(f.plan({mode:'resume',originalHostContext:'batch-host-a',
    permissions:['--allow-qa','--review-config','review.json']}),'advance');
  assert.equal(revised.status,0,revised.stderr);assert.match(revised.stderr,/应答 develop/);
  assert.equal(fs.readFileSync(path.join(f.codeProject,'target.mjs'),'utf8'),'export const value = 43;\n');
  assert.equal(JSON.parse(revised.stdout).result.identity.attempt,2);
  assert.deepEqual(developIntents(f),['develop-1','develop-2']);
});
test('batch resume holds a later task that has no run yet when its second-round answer is missing',t=>{
  const f=fixture(t,2);prepared(f);
  const later=path.join(f.root,'answers','1.work','T-002');fs.mkdirSync(later,{recursive:true});
  fs.writeFileSync(path.join(later,'target2.txt'),'export const value = 42;\n');
  for(const name of ['qa-assess.json','documentation-inspect.json'])
    fs.copyFileSync(path.join(f.answers,name),path.join(later,name));
  fs.writeFileSync(path.join(later,'develop.json'),JSON.stringify({...develop,edits:{'target2.mjs':'target2.txt'}}));
  // T-001 stops at awaiting_review first, so T-002 has no run when the batch resumes.
  const first=f.drive(f.plan({permissions:['--allow-qa','--review-config','review.json']}),'advance');
  assert.equal(first.status,0,first.stderr);assert.equal(JSON.parse(first.stdout).result.state,'awaiting_review');
  // The reviewer approves T-001 and asks for changes on T-002.
  const cli=path.join(f.root,'bin','codex');
  fs.writeFileSync(cli,fs.readFileSync(reviewer,'utf8').replace("verdict:'approved'",
    "verdict:prompt.includes('target2.mjs')?'changes_requested':'approved'")
    .replace('findings:[]',"findings:prompt.includes('target2.mjs')?[{id:'F1',severity:'P2',path:'target2.mjs',message:'Revise',evidence:'Fixture finding'}]:[]"));
  fs.chmodSync(cli,0o700);
  const permissions=['--allow-qa','--review-config','review.json','--allow-review',`${key}:1`,'--allow-review','1.work/T-002:1'];
  let result;
  for(let n=0;n<4;n++){
    const next=f.drive(f.plan({mode:'resume',originalHostContext:'batch-host-a',permissions}),'advance');
    assert.equal(next.status,0,next.stderr);result=JSON.parse(next.stdout).result;
    if(result.code==='revision_answer_required')break;
  }
  assert.equal(result.state,'changes_requested',JSON.stringify(result));assert.equal(result.code,'revision_answer_required');
  assert.equal(result.identity.taskId,'T-002');
});
test('batch hold without a second-round answer does not interfere with an approving review',t=>{
  const f=fixture(t);prepared(f);
  const permissions=['--allow-qa','--review-config','review.json','--allow-review',`${key}:1`];
  const first=f.drive(f.plan({permissions}),'advance');assert.equal(first.status,0,first.stderr);
  let result=JSON.parse(first.stdout).result;
  for(let n=0;n<4&&result.state!=='run_done';n++){
    const next=f.drive(f.plan({mode:'resume',originalHostContext:'batch-host-a',permissions}),'advance');
    assert.equal(next.status,0,next.stderr);result=JSON.parse(next.stdout).result;
  }
  assert.equal(result.state,'run_done',JSON.stringify(result));
});
test('batch driver refuses an oversized answer of a later task before launching the first',t=>{
  const f=fixture(t,2);prepared(f);
  const later=path.join(f.root,'answers','1.work','T-002');fs.mkdirSync(later,{recursive:true});
  fs.writeFileSync(path.join(later,'big.txt'),Buffer.alloc(1200*1024,0x61));
  fs.writeFileSync(path.join(later,'develop.json'),JSON.stringify({...develop,edits:{'target2.mjs':'big.txt'}}));
  const run=f.drive(f.plan(),'advance');assert.equal(run.status,2,run.stderr);
  assert.match(run.stderr,/target2\.mjs/);assert.match(run.stderr,/1048576/);noStore(f);
});
// Codex review of 910b84c: a later task's starting tree is unknown, but its answer
// files alone can already prove a limit is exceeded; those checks still apply.
function laterTask(f,scope,files){
  const config=path.join(f.root,'batch.json'),bundle=JSON.parse(fs.readFileSync(config,'utf8'));
  bundle.batch.tasks[1].scope=scope;fs.writeFileSync(config,JSON.stringify(bundle));
  const later=path.join(f.root,'answers','1.work','T-002');fs.mkdirSync(later,{recursive:true});
  for(const name of ['qa-assess.json','documentation-inspect.json'])
    fs.copyFileSync(path.join(f.answers,name),path.join(later,name));
  for(const [name,size] of Object.entries(files))fs.writeFileSync(path.join(later,name.replaceAll('/','_')+'.txt'),Buffer.alloc(size,0x61));
  fs.writeFileSync(path.join(later,'develop.json'),JSON.stringify({...develop,edits:Object.fromEntries(Object.keys(files).map(name=>[name,name.replaceAll('/','_')+'.txt']))}));
}
test('batch driver refuses a later task whose new files alone exceed the 2 MiB material limit',t=>{
  const f=fixture(t,2);prepared(f);
  const scope=['gen/a.bin','gen/b.bin','gen/c.bin'];laterTask(f,scope,Object.fromEntries(scope.map(file=>[file,700*1024])));
  const run=f.drive(f.plan(),'advance');assert.equal(run.status,2,run.stderr);
  assert.match(run.stderr,/2097152/);assert.match(run.stderr,/gen\/[abc]\.bin/);noStore(f);
});
test('batch driver lets a later task\'s second-round delete bring its delivered files back under 2 MiB',t=>{
  const f=fixture(t,2);prepared(f);
  laterTask(f,['gen/a.bin','gen/b.bin','gen/c.bin'],{'gen/a.bin':1000*1024,'gen/b.bin':1000*1024});
  const later=path.join(f.root,'answers','1.work','T-002');
  fs.writeFileSync(path.join(later,'gen_c.bin.txt'),Buffer.alloc(100*1024,0x61));
  fs.writeFileSync(path.join(later,'develop-a2.json'),JSON.stringify({...develop,edits:{'gen/b.bin':{delete:true},'gen/c.bin':'gen_c.bin.txt'}}));
  const run=f.drive(f.plan({permissions:['--allow-qa','--review-config','review.json','--allow-review','1.work/T-002:1']}),'advance');
  assert.equal(run.status,0,run.stderr);assert.doesNotMatch(run.stderr,/仅答案写入/);assert.equal(fs.existsSync(f.store),true);
});
test('batch driver refuses a no-op or non-UTF-8 protected develop answer before launch',t=>{
  const f=fixture(t);prepared(f);
  f.write('develop.json',{...develop,edits:{}});
  const empty=f.drive(f.plan(),'advance');assert.equal(empty.status,2,empty.stderr);
  assert.match(empty.stderr,/没有任何改动/);noStore(f);
  fs.writeFileSync(path.join(f.root,'protection.json'),JSON.stringify({checkCommands:[{id:'noop',command:['/usr/bin/true']}],timeoutMs:60000}));
  fs.writeFileSync(path.join(f.answers,'target.txt'),Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0xff]));
  f.write('develop.json',develop);
  const binary=f.drive(f.plan({permissions:['--allow-qa','--protected-conversation-config','protection.json'],checks:undefined}),'advance');
  assert.equal(binary.status,2,binary.stderr);assert.match(binary.stderr,/UTF-8/);assert.match(binary.stderr,/target\.mjs/);noStore(f);
});
test('batch review revision applies the second-round develop content',t=>{
  const f=fixture(t);prepared(f);
  const cli=path.join(f.root,'bin','codex');
  fs.writeFileSync(cli,fs.readFileSync(cli,'utf8').replace("verdict:'approved'","verdict:'changes_requested'")
    .replace('findings:[]',"findings:[{id:'F1',severity:'P2',path:'target.mjs',message:'Revise value',evidence:'Fixture finding'}]"));
  fs.writeFileSync(path.join(f.answers,'target-a2.txt'),'export const value = 43;\n');
  f.write('develop-a2.json',{...develop,edits:{'target.mjs':'target-a2.txt'}});
  const permissions=['--allow-qa','--review-config','review.json','--allow-review',`${key}:1`];
  const run=f.drive(f.plan({permissions}),'advance');assert.equal(run.status,0,run.stderr);
  assert.equal(fs.readFileSync(path.join(f.codeProject,'target.mjs'),'utf8'),'export const value = 43;\n');
});
test('batch first-round answer aliases cannot coexist',t=>{
  const f=fixture(t);prepared(f);f.write('develop-a1.json',develop);
  const run=f.drive(f.plan(),'advance');assert.equal(run.status,2,run.stderr);
  assert.match(run.stderr,/develop\.json.*develop-a1\.json/);noStore(f);
});
test('batch retryable blocked state projects the same develop attempt',()=>{
  for(const code of ['developer_result_invalid','verification_precheck_failed','check_output_out_of_scope','develop_checks_not_passed'])
    assert.deepEqual(batchDevelopAttempts({state:'blocked',code,attempt:2},key,[]),[2]);
  assert.deepEqual(batchDevelopAttempts({state:'blocked',code:'checks_not_passed',attempt:2},key,[]),[]);
});

test('D1 batch rejects invalid check timeout before opening a host',t=>{
  const f=fixture(t);prepared(f);
  const checks={[key]:[{id:'syntax',command:[process.execPath,'--check','target.mjs'],timeoutMs:0}]};
  const run=f.drive(f.plan({checks}),'advance');
  assert.equal(run.status,2);assert.match(run.stderr,/timeoutMs/);noStore(f);
});

test('D1 batch retries failed checks before review in the same attempt',t=>{
  const f=fixture(t);prepared(f);
  const failed={[key]:[{id:'test',command:[process.execPath,'-e','process.exit(1)']}]};
  const first=f.drive(f.plan({permissions:['--allow-qa','--runtime','claude'],checks:failed}),'advance');assert.equal(first.status,0,first.stderr);
  const result=JSON.parse(first.stdout).result;
  assert.equal(result.code,'develop_checks_not_passed');assert.equal(result.pendingAction,'resume');
  assert.equal(result.guidance.recoveryOperation,'advance');assert.equal(result.guidance.authorizationGranted,false);
  assert.match(first.stderr,/原批次入口/);assert.doesNotMatch(result.guidance.prerequisites.join(' '),/--mode/);
  const clean={[key]:[{id:'test',command:[process.execPath,'-e','0']}]};
  const second=f.drive(f.plan({mode:'resume',originalHostContext:'batch-host-a',permissions:['--allow-qa','--runtime','claude'],checks:clean}),'advance');
  assert.equal(second.status,0,second.stderr);assert.match(second.stderr,/应答 develop/);
});
test('missing answer leaves no batch store or session',t=>{
  const f=fixture(t);const run=f.drive(f.plan(),'advance');
  assert.equal(run.status,2);assert.match(run.stderr,/develop\.json/);noStore(f);
});
test('batch selection preflights the later task before launching the first',t=>{
  const f=fixture(t,2);prepared(f);
  const run=f.drive(f.plan(),'advance');assert.equal(run.status,2);
  assert.match(run.stderr,/任务 1\.work\/T-002 会反问 develop.*T-002\/develop\.json/s);
  noStore(f);
});
test('invalid parallel selection is refused before the batch store',t=>{
  const f=fixture(t,2);prepared(f);
  const config=path.join(f.root,'batch.json'),bundle=JSON.parse(fs.readFileSync(config,'utf8'));
  bundle.batch.parallel=[[key,'1.work/T-002']];fs.writeFileSync(config,JSON.stringify(bundle));
  const run=f.drive(f.plan(),'advance');assert.equal(run.status,2);
  assert.match(run.stderr,/parallel_final_task_excluded|批次定义、scope 或 workflow 无效/);
  noStore(f);
});
test('malformed authored answer is refused before launch',t=>{
  const f=fixture(t);prepared(f);f.write('develop.json',{...develop,value:{outcome:'implemented'}});
  const run=f.drive(f.plan(),'advance');assert.equal(run.status,2);assert.match(run.stderr,/答案格式错误/);noStore(f);
});
test('static check cannot replace a real runner',t=>{
  const f=fixture(t);prepared(f);f.write('check.json',[{id:'syntax',outcome:'passed',exitCode:0}]);
  const run=f.drive(f.plan({checks:undefined}),'advance');
  assert.equal(run.status,2);assert.match(run.stderr,/PLAN\.checks/);noStore(f);
});
test('a static passed check cannot override a failed real command',t=>{
  const f=fixture(t);prepared(f);f.write('check.json',[{id:'syntax',outcome:'passed',exitCode:0}]);
  const run=f.drive(f.plan({checks:{[key]:[{id:'actual',command:[process.execPath,'-e','process.exit(7)']}]}}),'advance');
  assert.equal(run.status,0,run.stderr);
  const files=fs.readdirSync(f.store),state=path.join(f.store,files.find(name=>name.startsWith('task-')),'state.json');
  assert.match(fs.readFileSync(state,'utf8'),/host check exited 7/);
});
test('an out-of-scope edit is refused before launch',t=>{
  const f=fixture(t);prepared(f);f.write('develop.json',{...develop,edits:{'outside.mjs':'target.txt'}});
  const run=f.drive(f.plan(),'advance');assert.equal(run.status,2);assert.match(run.stderr,/越过批准 scope: outside\.mjs/);noStore(f);
});
test('verification evidence kind requires a real runner',t=>{
  const f=fixture(t);prepared(f);f.write('verification-precheck.json',{satisfied:true,evidence:'static'});
  const run=f.drive(f.plan({permissions:['--allow-qa','--verification-precheck']}),'advance');
  assert.equal(run.status,2);assert.match(run.stderr,/verification_precheck/);noStore(f);
});
test('QA logic evidence cannot be supplied as a static answer',t=>{
  const f=fixture(t);prepared(f);
  fs.writeFileSync(path.join(f.specsDir,'1.work','test-cases.json'),JSON.stringify({cases:[{kind:'logic',id:'CASE-1'}]}));
  f.write('qa-logic.json',{verdict:'PASS',evidence:['static claim']});
  const run=f.drive(f.plan(),'advance');assert.equal(run.status,2);
  assert.match(run.stderr,/qa_logic/);noStore(f);
});
test('resume binding is required before launch',t=>{
  const f=fixture(t);prepared(f);
  const run=f.drive(f.plan({mode:'resume'}),'advance');assert.equal(run.status,2);
  assert.match(run.stderr,/originalHostContext/);noStore(f);
});

test('optimized real batch driver shares only a declared same-plan check and rejects legacy aliases before launch',t=>{
  const f=fixture(t);prepared(f);const counter=path.join(f.root,'physical-check-count');
  const command=[process.execPath,'-e',`require('node:fs').appendFileSync(${JSON.stringify(counter)},'x')`];
  const checks={[key]:[{id:'first',command},{id:'same',command,sameExecutionAs:'first'}]};
  const denied=f.drive(f.plan({checks}), 'advance');assert.equal(denied.status,2);noStore(f);assert(!fs.existsSync(counter));
  const out=f.drive(f.plan({permissions:['--allow-qa','--execution-optimizations'],checks}), 'advance');
  assert.equal(out.status,0,out.stderr);assert.equal(JSON.parse(out.stdout).result.state,'awaiting_review',out.stdout+out.stderr);
  assert.equal(fs.readFileSync(counter,'utf8'),'x');
});

// Q24 driver: develop_redo goes through the batch host to the stopped member; the
// next advance still preflights the develop answer from the projected state (Q28).
test('Q24 batch driver forwards develop_redo to the stopped member, then advance redoes the round',t=>{
  const f=fixture(t);prepared(f);
  f.write('develop.json',{status:'failed',code:'session_error'});
  const stuck=f.drive(f.plan(),'advance');assert.equal(stuck.status,0,stuck.stderr);
  const first=JSON.parse(stuck.stdout).result;
  assert.deepEqual([first.state,first.code,first.pendingAction],['blocked','develop_answer_missing','develop_redo'],stuck.stdout);
  const resume={mode:'resume',originalHostContext:'batch-host-a'};
  const missing=f.drive(f.plan({...resume,taskKey:key,reason:'会话已停止修改代码'}),'develop_redo');
  assert.equal(missing.status,2);assert.match(missing.stderr,/--allow-develop-redo 1\.work\/T-001/);
  const noReason=f.drive(f.plan({...resume,taskKey:key,permissions:['--allow-qa','--allow-develop-redo',key]}),'develop_redo');
  assert.equal(noReason.status,2);assert.match(noReason.stderr,/reason/);
  const unknownTask=f.drive(f.plan({...resume,taskKey:key,reason:'已停',permissions:['--allow-qa','--allow-develop-redo','1.work/T-009']}),'develop_redo');
  assert.equal(unknownTask.status,2);assert.match(unknownTask.stderr,/--allow-develop-redo/);
  const redo=f.drive(f.plan({...resume,taskKey:key,reason:'会话已停止修改代码',permissions:['--allow-qa','--allow-develop-redo',key]}),'develop_redo');
  assert.equal(redo.status,0,redo.stderr);
  const recorded=JSON.parse(redo.stdout).result;
  assert.deepEqual([recorded.outcome,recorded.pendingAction,recorded.taskKey],['recorded','resume',key],redo.stdout);
  prepared(f);
  const again=f.drive(f.plan(resume),'advance');assert.equal(again.status,0,again.stderr);
  assert.match(again.stderr,/应答 develop/);
  assert.equal(fs.readFileSync(path.join(f.codeProject,'target.mjs'),'utf8'),'export const value = 42;\n');
});

// Review round 1 (major): in a strict batch (and, batch 4, an ordinary one) a terminal parallel member is rescheduled
// into a serial second generation. The host stops at batch_member_rescheduled; the next
// resume advance preflights the gen-2 attempt-1 answer (the finished gen-1 run would
// have yielded none) and the batch continues without a host_close mid-run.
for(const [label,strict] of [['strict',true],['ordinary',false]])
test(`${label} batch driver preflights a rescheduled second generation before it is developed`,t=>{
  const f=fixture(t,3);
  const bundlePath=path.join(f.root,'batch.json'),bundle=JSON.parse(fs.readFileSync(bundlePath,'utf8'));
  bundle.batch.parallel=[['1.work/T-001','1.work/T-002']];
  fs.writeFileSync(bundlePath,JSON.stringify(bundle));
  const dir=id=>{const d=path.join(f.root,'answers','1.work',id);fs.mkdirSync(d,{recursive:true});return d;};
  const answer=(id,file,content,outcome='implemented')=>{
    fs.writeFileSync(path.join(dir(id),`${file}.txt`),content);
    fs.writeFileSync(path.join(dir(id),'develop.json'),JSON.stringify({...develop,
      value:outcome==='implemented'?develop.value:{outcome:'blocked',reason:'Synthetic dependency is missing'},edits:{[`${file}.mjs`]:`${file}.txt`}}));
    for(const [name,value] of [['qa-assess.json',{scores:{scope:2,risk:2,accumulation:2,boundary:2},
      changes:{api:false,migration:false,authentication:false,authorization:false,payment:false}}],
      ['documentation-inspect.json',{status:'completed',reason:'README and task artifacts inspected'}]])
      fs.writeFileSync(path.join(dir(id),name),JSON.stringify(value));
  };
  answer('T-001','target','export const value = 42;\n');
  answer('T-002','target2','export const value = 2;\n','blocked');
  answer('T-003','target3','export const value = 3;\n');
  const checks=Object.fromEntries(['T-001','T-002','T-003'].map((id,n)=>[`1.work/${id}`,
    [{id:'syntax',command:[process.execPath,'--check',n===0?'target.mjs':`target${n+1}.mjs`]}]]));
  const permissions=['--allow-qa',...(strict?['--execution-optimizations']:[]),...['T-001','T-002','T-003'].flatMap(id=>['--allow-review',`1.work/${id}:1`])];
  const first=f.drive(f.plan({permissions,checks}),'advance');assert.equal(first.status,0,first.stderr);
  const stopped=JSON.parse(first.stdout).result;
  assert.equal(stopped.code,'batch_member_rescheduled',first.stdout+first.stderr);assert.deepEqual(stopped.rescheduled,['1.work/T-002']);
  // The gen-2 answer replaces the blocked one; the resume preflight must load it.
  answer('T-002','target2','export const value = 2;\n');
  const resumed=f.drive(f.plan({mode:'resume',originalHostContext:'batch-host-a',
    permissions:permissions.filter(flag=>flag!=='--execution-optimizations'),checks}),'advance');
  assert.equal(resumed.status,0,resumed.stderr);
  assert.doesNotMatch(resumed.stderr,/未预检/);
  const done=JSON.parse(resumed.stdout).result;
  assert.equal(done.state,'run_done',resumed.stdout+resumed.stderr);
  assert.equal(fs.readFileSync(path.join(f.codeProject,'target2.mjs'),'utf8'),'export const value = 2;\n');
});
