import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {buildManifest} from './cm-spec-manifest.mjs';
import {configFingerprint} from '../runtime/js/cm-ai/codex-config.mjs';

const DRIVER=fileURLToPath(new URL('./cm-ai-batch-drive.mjs',import.meta.url));
const reviewer=fileURLToPath(new URL('./fixtures/codex-review-process.mjs',import.meta.url));
const key='1.work/T-001';
const develop={status:'succeeded',value:{outcome:'implemented',
  application:{status:'no_relevant_lesson',note:null},
  retrospective:{status:'no_new_lesson',candidates:[],reason:null}},edits:{'target.mjs':'target.txt'}};

function fixture(t,count=1){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-batch-drive-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const specsDir=path.join(root,'specs'),codeProject=path.join(root,'code'),bin=path.join(root,'bin');
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
    fs.writeFileSync(file,JSON.stringify({config:'batch.json',mode:'create',hostContext:'batch-host-a',
      permissions:['--allow-qa'],answers:'answers',checks:Object.fromEntries(batch.tasks.map(task=>
        [`1.work/${task.taskId}`,[{id:'syntax',command:[process.execPath,'--check',task.taskId==='T-001'?'target.mjs':'target2.mjs']}]])),...extra}));
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

test('help names plan invocation',()=>{
  const run=spawnSync(process.execPath,[DRIVER,'--help'],{encoding:'utf8'});
  assert.equal(run.status,0);assert.match(run.stdout,/--plan PLAN\.json <operation>/);
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
  const permissions=['--allow-qa','--review-config','review.json','--allow-review',`${key}:1`];
  const first=f.drive(f.plan({permissions}),'advance');
  assert.equal(first.status,0,first.stderr);assert.match(first.stderr,/应答 check/);
  let result=JSON.parse(first.stdout).result;
  for(let n=0;n<4&&result.state!=='run_done';n++){
    const next=f.drive(f.plan({mode:'resume',originalHostContext:'batch-host-a',permissions}),'advance');
    assert.equal(next.status,0,next.stderr);result=JSON.parse(next.stdout).result;
  }
  assert.equal(result.state,'run_done',JSON.stringify(result));
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
