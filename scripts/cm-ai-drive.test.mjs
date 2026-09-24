import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {buildManifest} from './cm-spec-manifest.mjs';
import {qaFixAnswerFor} from './cm-ai-drive.mjs';

const DRIVER=fileURLToPath(new URL('./cm-ai-drive.mjs',import.meta.url));
const identity={repositoryId:'drive-fixture',runId:'drive-run',taskId:'T-001',attempt:1};
test('help prints the plan command without launching a host',()=>{
  const help=spawnSync(process.execPath,[DRIVER,'--help'],{encoding:'utf8'});
  assert.equal(help.status,0);assert.match(help.stdout,/--plan PLAN\.json <operation>/);
});
function fixture(t){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-ai-drive-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const specsDir=path.join(root,'specs'),codeProject=path.join(root,'code'),feature='1.work';
  fs.mkdirSync(path.join(specsDir,feature),{recursive:true});fs.mkdirSync(codeProject);
  for(const name of ['requirements.md','design.md'])fs.writeFileSync(path.join(specsDir,feature,name),'# Fixture\n');
  fs.writeFileSync(path.join(specsDir,feature,'tasks.md'),'- [ ] T-001: fixture\n');
  fs.writeFileSync(path.join(specsDir,'.cm-specs-status'),JSON.stringify({status:'approved',features:[feature],specFiles:buildManifest(specsDir)}));
  fs.writeFileSync(path.join(codeProject,'requirements.md'),'# Fixture\n');
  fs.writeFileSync(path.join(root,'run.json'),JSON.stringify({version:1,specsDir,codeProject,feature,identity,
    scope:['target.mjs'],requirements:['requirements.md']}));
  const answers=path.join(root,'answers');fs.mkdirSync(answers);
  const write=(name,value)=>fs.writeFileSync(path.join(answers,name),JSON.stringify(value));
  const plan=(extra={})=>{const file=path.join(root,`plan-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(file,JSON.stringify({config:'run.json',mode:'create',hostContext:'drive-host-a',
      permissions:[],answers:'answers',checks:[{id:'syntax',command:[process.execPath,'--check','target.mjs']}],...extra}));
    return file;};
  const drive=(file,operation)=>spawnSync(process.execPath,[DRIVER,'--plan',file,operation],
    {encoding:'utf8',timeout:30000,env:{...process.env,CM_WORKFLOW_HOME:path.join(root,'home'),
      CM_WORKFLOW_LOG_HOME:path.join(root,'logs')}});
  const store=path.join(specsDir,'.reviews','.execution',identity.runId,'state.json');
  return {root,codeProject,specsDir,answers,write,plan,drive,store};
}
const develop={status:'succeeded',value:{outcome:'implemented',
  application:{status:'no_relevant_lesson',note:null},
  retrospective:{status:'no_new_lesson',candidates:[],reason:null}},
  edits:{'target.mjs':'target-content.mjs'}};
function prepared(f){f.write('develop.json',develop);fs.writeFileSync(path.join(f.answers,'target-content.mjs'),'export const value = 42;\n');}

test('create and advance run authored edits and actual check, then resume with original context',t=>{
  const f=fixture(t);prepared(f);
  const first=f.drive(f.plan(),'advance');assert.equal(first.status,0,first.stderr);
  const result=JSON.parse(first.stdout).result;
  assert.equal(result.state,'awaiting_review');assert.equal(result.code,'decision_required');
  assert.match(first.stderr,/应答 develop/);assert.match(first.stderr,/应答 check/);
  assert.equal(fs.readFileSync(path.join(f.codeProject,'target.mjs'),'utf8'),'export const value = 42;\n');
  assert(fs.existsSync(f.store));
  const resumed=f.drive(f.plan({mode:'resume',hostContext:'drive-host-b',originalHostContext:'drive-host-a'}),'advance');
  assert.equal(resumed.status,0,resumed.stderr);assert.equal(JSON.parse(resumed.stdout).result.code,'decision_required');
});

test('missing develop answer is refused before store creation',t=>{
  const f=fixture(t);const run=f.drive(f.plan(),'advance');
  assert.equal(run.status,2);assert.match(run.stderr,/develop\.json/);assert.equal(fs.existsSync(f.store),false);
});
test('out-of-scope develop edit is refused before host launch',t=>{
  const f=fixture(t);prepared(f);
  f.write('develop.json',{...develop,edits:{'outside.mjs':'target-content.mjs'}});
  const run=f.drive(f.plan(),'advance');
  assert.equal(run.status,2,run.stderr);
  assert.match(run.stderr,/develop\.json\.edits 越过批准 scope: outside\.mjs/);
  assert.equal(fs.existsSync(path.dirname(f.store)),false,'preflight must not create the run store');
});
test('unprotected advance without checks is refused before host launch',t=>{
  const f=fixture(t);prepared(f);
  const run=f.drive(f.plan({checks:undefined}),'advance');
  assert.equal(run.status,2,run.stderr);
  assert.match(run.stderr,/步骤会反问 check，但 PLAN\.checks 缺少真实命令列表/);
  assert.equal(fs.existsSync(path.dirname(f.store)),false,'preflight must not create the run store');
});
test('missing checks cannot be replaced with static check.json',t=>{
  const f=fixture(t);prepared(f);f.write('check.json',[{id:'syntax',outcome:'passed',exitCode:0}]);
  const run=f.drive(f.plan({checks:undefined}),'advance');
  assert.equal(run.status,2);assert.match(run.stderr,/PLAN\.checks/);assert.equal(fs.existsSync(f.store),false);
});
test('a static passed check cannot override a failed real command',t=>{
  const f=fixture(t);prepared(f);f.write('check.json',[{id:'syntax',outcome:'passed',exitCode:0}]);
  const run=f.drive(f.plan({checks:[{id:'actual',command:[process.execPath,'-e','process.exit(7)']}]}),'advance');
  assert.equal(run.status,0,run.stderr);
  const evidence=fs.readFileSync(f.store,'utf8');
  assert.match(evidence,/host check exited 7/);
  assert.doesNotMatch(evidence,/"outcome":"passed","exitCode":0/);
});
test('malformed develop answer is rejected before host launch',t=>{
  const f=fixture(t);prepared(f);f.write('develop.json',{status:'succeeded',value:{outcome:'implemented'},
    edits:{'target.mjs':'target-content.mjs'}});
  const run=f.drive(f.plan(),'advance');assert.equal(run.status,2);assert.match(run.stderr,/答案格式错误/);
  assert.equal(fs.existsSync(f.store),false);
});
test('verification_precheck static answer is refused without an execution runner',t=>{
  const f=fixture(t);prepared(f);f.write('verification-precheck.json',{items:[{requirement:'synthetic',satisfied:true,evidence:'claim'}]});
  const run=f.drive(f.plan({verificationPrecheck:true}),'advance');
  assert.equal(run.status,2);assert.match(run.stderr,/verification_precheck/);assert.equal(fs.existsSync(f.store),false);
});
test('QA logic case is refused before sending without a real runner',t=>{
  const f=fixture(t);prepared(f);
  fs.writeFileSync(path.join(f.specsDir,'1.work','test-cases.json'),JSON.stringify({cases:[{kind:'logic'}]}));
  fs.writeFileSync(path.join(f.root,'workflow.json'),JSON.stringify({documentationPaths:[],applicableAgentFiles:[],qa:{}}));
  const run=f.drive(f.plan({permissions:['--workflow-config','workflow.json','--allow-qa']}),'advance');
  assert.equal(run.status,2);assert.match(run.stderr,/qa_logic/);assert.equal(fs.existsSync(f.store),false);
});
test('protected conversation still requires the authored develop answer',t=>{
  const f=fixture(t);fs.writeFileSync(path.join(f.root,'protection.json'),JSON.stringify({checkCommands:[
    {id:'syntax',command:[process.execPath,'--check','target.mjs']}],timeoutMs:60000}));
  const run=f.drive(f.plan({checks:undefined,
    permissions:['--protected-conversation-config','protection.json']}),'advance');
  assert.equal(run.status,2);assert.match(run.stderr,/develop\.json/);assert.equal(fs.existsSync(f.store),false);
});
test('resume requires originalHostContext before host launch',t=>{
  const f=fixture(t);prepared(f);
  const run=f.drive(f.plan({mode:'resume'}),'advance');assert.equal(run.status,2);
  assert.match(run.stderr,/originalHostContext/);assert.equal(fs.existsSync(f.store),false);
});
test('supersession flags reach create and incomplete or resume pairs stop before host launch',t=>{
  const f=fixture(t);prepared(f);
  const both=['--supersede-reviewed-evidence','--supersede-reason','operator restart'];
  const create=f.drive(f.plan({permissions:both}),'advance');
  assert.equal(create.status,1,create.stderr);
  assert.match(create.stderr,/supersede_unavailable/);
  for(const permissions of [['--supersede-reviewed-evidence'],['--supersede-reason','operator restart']]){
    const refused=f.drive(f.plan({permissions}),'advance');
    assert.equal(refused.status,2,refused.stderr);
    assert.match(refused.stderr,/supersede-reviewed-evidence.*supersede-reason/);
  }
  const resumed=f.drive(f.plan({mode:'resume',originalHostContext:'drive-host-a',permissions:both}),'status');
  assert.equal(resumed.status,2,resumed.stderr);
  assert.match(resumed.stderr,/supersede.*create/);
});
test('status reads the existing run without answer files or checks',t=>{
  const f=fixture(t);prepared(f);assert.equal(f.drive(f.plan(),'advance').status,0);
  const before=fs.readFileSync(f.store);
  const status=f.drive(f.plan({mode:'resume',originalHostContext:'drive-host-a',answers:undefined,checks:undefined}),'status');
  assert.equal(status.status,0,status.stderr);assert.equal(JSON.parse(status.stdout).result.state,'awaiting_review');
  assert.deepEqual(fs.readFileSync(f.store),before);
});
test('decision sends the package binding and needs no answer files',t=>{
  const f=fixture(t);prepared(f);
  const first=f.drive(f.plan(),'advance');assert.equal(first.status,0,first.stderr);
  const packageDigest=JSON.parse(first.stdout).result.packageDigest;
  const decision=f.drive(f.plan({mode:'resume',originalHostContext:'drive-host-a',
    packageDigest,answers:undefined,checks:undefined}),'decision');
  assert.equal(decision.status,0,decision.stderr);
  assert.equal(JSON.parse(decision.stdout).result.code,'decision_required');
});
test('explicit allow-development permission reaches the host once',t=>{
  const f=fixture(t);prepared(f);
  const run=f.drive(f.plan({permissions:['--allow-development']}),'advance');
  assert.equal(run.status,0,run.stderr);assert.equal(JSON.parse(run.stdout).result.code,'decision_required');
});
test('QA-fix child operation forwards its binding and returns parent gate result',t=>{
  const f=fixture(t);prepared(f);assert.equal(f.drive(f.plan(),'advance').status,0);
  const binding={feature:'1.work',identity,packageDigest:'a'.repeat(64),testRunId:'qa-child'};
  fs.writeFileSync(path.join(f.root,'fix-owner.json'),JSON.stringify({specsRoot:f.specsDir,identity:{...identity,runId:'fix-run'},
    configuration:{hostContextId:'drive-host-a',reproduction:{cwd:f.codeProject},qaSource:binding}}));
  const attempt=f.drive(f.plan({mode:'resume',originalHostContext:'drive-host-a',
    permissions:['--qa-fix-owner-config','fix-owner.json'],packageDigest:'a'.repeat(64),testRunId:'qa-child'}),'fix_status');
  assert.equal(attempt.status,1,attempt.stderr);
  assert.match(attempt.stderr,/qa_fix_parent_not_completed/);
});
test('QA-fix child action requires its own answer before any host request',t=>{
  const f=fixture(t);prepared(f);assert.equal(f.drive(f.plan(),'advance').status,0);
  const binding={feature:'1.work',identity,packageDigest:'a'.repeat(64),testRunId:'qa-child'};
  fs.writeFileSync(path.join(f.root,'fix-owner.json'),JSON.stringify({specsRoot:f.specsDir,identity:{...identity,runId:'fix-run'},
    configuration:{hostContextId:'drive-host-a',reproduction:{cwd:f.codeProject},qaSource:binding}}));
  const options={mode:'resume',originalHostContext:'drive-host-a',packageDigest:'a'.repeat(64),
    testRunId:'qa-child',fixOperation:'red_test',permissions:['--qa-fix-owner-config','fix-owner.json','--allow-qa-fix-start']};
  const missing=f.drive(f.plan(options),'fix_action');assert.equal(missing.status,2);
  assert.match(missing.stderr,/learning\.json/);
  f.write('learning.json',{status:'no_relevant_lesson',summary:'No applicable project lesson'});
  const sent=f.drive(f.plan(options),'fix_action');assert.equal(sent.status,1,sent.stderr);
  assert.match(sent.stderr,/qa_fix_parent_not_completed/);
  const learning={status:'no_relevant_lesson',summary:'No applicable project lesson'};
  assert.deepEqual(qaFixAnswerFor({kind:'fix_learning',payload:{contextDigest:'binding'}},{fix_learning:learning},f.answers),
    {contextDigest:'binding',...learning});
  fs.writeFileSync(path.join(f.answers,'repair.txt'),'export const value = 43;\n');
  assert.deepEqual(qaFixAnswerFor({kind:'fix_repair',payload:{expected:{'target.mjs':'old-hash'}}},
    {fix_repair:{'target.mjs':'repair.txt'}},f.answers),
  {outcome:'repaired',edits:[{path:'target.mjs',beforeSha256:'old-hash',content:'export const value = 43;\n'}]});
});
test('QA-fix answer travels through the shared JSONL core',t=>{
  const f=fixture(t),host=path.join(f.root,'child-host.mjs'),wrapper=path.join(f.root,'child-drive.mjs');
  fs.writeFileSync(host,`process.stdout.write(JSON.stringify({type:'host_ready',sessionId:'child'})+'\\n');
let text='';process.stdin.on('data',chunk=>{text+=chunk;let at;while((at=text.indexOf('\\n'))>=0){
 const line=text.slice(0,at);text=text.slice(at+1);if(!line)continue;const row=JSON.parse(line);
 if(row.operation==='fix_action')process.stdout.write(JSON.stringify({type:'host_request',sessionId:'child',
  callId:'learning-call',requestDigest:'digest',kind:'fix_learning',payload:{contextDigest:'context'}})+'\\n');
 if(row.type==='host_result')process.stdout.write(JSON.stringify({requestId:'drive',result:{stage:'child_answered',answer:row.result}})+'\\n');
}});`);
  fs.writeFileSync(wrapper,`import {driveHost} from ${JSON.stringify(new URL('../runtime/js/cm-ai/drive-core.mjs',import.meta.url).href)};
import {qaFixAnswerFor} from ${JSON.stringify(new URL('./cm-ai-drive.mjs',import.meta.url).href)};
const answers={fix_learning:{status:'no_relevant_lesson',summary:'No applicable lesson'}};
driveHost({host:${JSON.stringify(host)},args:[],cwd:${JSON.stringify(f.root)},operation:'fix_action',answers,
  answerFor:(row,value)=>qaFixAnswerFor(row,value,${JSON.stringify(f.answers)})});`);
  const run=spawnSync(process.execPath,[wrapper],{encoding:'utf8',timeout:5000});
  assert.equal(run.status,0,run.stderr);assert.match(run.stderr,/应答 fix_learning/);
  assert.deepEqual(JSON.parse(run.stdout).result.answer,
    {contextDigest:'context',status:'no_relevant_lesson',summary:'No applicable lesson'});
});
