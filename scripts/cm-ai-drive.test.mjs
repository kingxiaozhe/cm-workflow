import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {buildManifest} from './cm-spec-manifest.mjs';
import {configFingerprint} from '../runtime/js/cm-ai/codex-config.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
import {cmInitRuleTargets} from '../runtime/js/cm-init/draft-generation.mjs';
import {qaFixAnswerFor,projectDevelopAttempts} from './cm-ai-drive.mjs';

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
  const bin=path.join(root,'bin');fs.mkdirSync(bin);
  const write=(name,value)=>fs.writeFileSync(path.join(answers,name),JSON.stringify(value));
  const plan=(extra={})=>{const file=path.join(root,`plan-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(file,JSON.stringify({config:'run.json',mode:'create',hostContext:'drive-host-a',
      permissions:[],answers:'answers',checks:[{id:'syntax',command:[process.execPath,'--check','target.mjs']}],...extra}));
    return file;};
  const drive=(file,operation)=>spawnSync(process.execPath,[DRIVER,'--plan',file,operation],
    {encoding:'utf8',timeout:30000,env:{...process.env,PATH:bin+path.delimiter+process.env.PATH,CM_WORKFLOW_HOME:path.join(root,'home'),
      CM_WORKFLOW_LOG_HOME:path.join(root,'logs')}});
  const store=path.join(specsDir,'.reviews','.execution',identity.runId,'state.json');
  return {root,codeProject,specsDir,answers,bin,write,plan,drive,store};
}
const develop={status:'succeeded',value:{outcome:'implemented',
  application:{status:'no_relevant_lesson',note:null},
  retrospective:{status:'no_new_lesson',candidates:[],reason:null}},
  edits:{'target.mjs':'target-content.mjs'}};
function prepared(f){f.write('develop.json',develop);fs.writeFileSync(path.join(f.answers,'target-content.mjs'),'export const value = 42;\n');}
function changesRequestedReview(f){
  const source=fs.readFileSync(fileURLToPath(new URL('./fixtures/codex-review-process.mjs',import.meta.url)),'utf8');
  const fake=source.replace("verdict:'approved'","verdict:'changes_requested'")
    .replace('findings:[]',"findings:[{id:'F1',severity:'P2',path:'target.mjs',message:'Revise the value',evidence:'Fixture finding'}]");
  const cli=path.join(f.bin,'codex');fs.writeFileSync(cli,fake,{mode:0o700});
  fs.writeFileSync(path.join(f.root,'review.json'),JSON.stringify({model:'fixture',preflight:{passed:true,
    cli_model:'fixture',prompt_transport:'stdin',config_fingerprint:configFingerprint({cwd:f.codeProject,model:'fixture'})}}));
  return ['--review-config','review.json','--allow-review-attempt','1'];
}
function reviewPending(f){
  prepared(f);const permissions=changesRequestedReview(f);
  const first=f.drive(f.plan({permissions:permissions.slice(0,2)}),'advance');assert.equal(first.status,0,first.stderr);
  return {permissions,packageDigest:JSON.parse(first.stdout).result.packageDigest};
}
function assertActionableFirstReviewHint(stderr){
  assert.match(stderr,/develop-a2\.json/);
  assert.match(stderr,/审查后可能直接进入第 2 轮 develop/);
  assert.match(stderr,/移除 --allow-review-attempt 1/);
  assert.match(stderr,/awaiting_review/);
  assert.match(stderr,/packageDigest.*decision/);
  assert.match(stderr,/\.reviews\/work-T-001-r1\.md/);
  assert.match(stderr,/预先写.*develop-a2\.json/);
}
test('review-enabled advance refuses missing second-round answer before host launch',t=>{
  const f=fixture(t),{permissions,packageDigest}=reviewPending(f),before=fs.readFileSync(f.store);
  const run=f.drive(f.plan({mode:'resume',originalHostContext:'drive-host-a',permissions}),'advance');
  assert.equal(run.status,2,run.stderr);assert.match(run.stderr,/develop-a2\.json/);
  assert.match(run.stderr,/decision/);assert.match(run.stderr,new RegExp(packageDigest));
  assert.match(run.stderr,/\.reviews\/work-T-001-r1\.md/);
  assert.deepEqual(fs.readFileSync(f.store),before);
});
test('retryable blocked state projects the same develop attempt',()=>{
  for(const code of ['developer_result_invalid','verification_precheck_failed'])
    assert.deepEqual(projectDevelopAttempts({state:'blocked',code,attempt:2},'advance',[]).attempts,[2]);
});
test('review-authorized create preflights a possible second develop round',t=>{
  const f=fixture(t);prepared(f);const permissions=changesRequestedReview(f);
  const run=f.drive(f.plan({permissions}),'advance');
  assert.equal(run.status,2,run.stderr);assertActionableFirstReviewHint(run.stderr);
  assert.equal(fs.existsSync(f.store),false);
});
test('review-authorized resume from ready gives the same two paths before launch',t=>{
  const f=fixture(t);prepared(f);const permissions=changesRequestedReview(f);
  const status=f.drive(f.plan({permissions:permissions.slice(0,2),answers:undefined,checks:undefined}),'status');
  assert.equal(status.status,0,status.stderr);assert.equal(JSON.parse(status.stdout).result.state,'ready');
  const before=fs.readFileSync(f.store);
  const run=f.drive(f.plan({mode:'resume',originalHostContext:'drive-host-a',permissions}),'advance');
  assert.equal(run.status,2,run.stderr);assertActionableFirstReviewHint(run.stderr);
  assert.deepEqual(fs.readFileSync(f.store),before);
});
test('create advance without review authorization accepts only develop.json',t=>{
  const f=fixture(t);prepared(f);const permissions=changesRequestedReview(f).slice(0,2);
  assert.equal(fs.existsSync(path.join(f.answers,'develop-a2.json')),false);
  const run=f.drive(f.plan({permissions}),'advance');assert.equal(run.status,0,run.stderr);
  assert.equal(JSON.parse(run.stdout).result.state,'awaiting_review');
});
test('decision dispatches only review and leaves changes_requested for authored revision',t=>{
  const f=fixture(t),{permissions,packageDigest}=reviewPending(f);
  const run=f.drive(f.plan({mode:'resume',originalHostContext:'drive-host-a',permissions,
    packageDigest,answers:undefined,checks:undefined}),'decision');
  assert.equal(run.status,0,run.stderr);
  assert.equal(JSON.parse(run.stdout).result.state,'changes_requested');
  assert.equal(JSON.parse(run.stdout).result.identity.attempt,2);
  assert.equal(fs.readFileSync(path.join(f.codeProject,'target.mjs'),'utf8'),'export const value = 42;\n');
});
test('advance applies develop-a2 content after changes_requested review',t=>{
  const f=fixture(t),{permissions}=reviewPending(f);
  fs.writeFileSync(path.join(f.answers,'target-a2.mjs'),'export const value = 43;\n');
  f.write('develop-a2.json',{...develop,edits:{'target.mjs':'target-a2.mjs'}});
  const run=f.drive(f.plan({mode:'resume',originalHostContext:'drive-host-a',permissions}),'advance');
  assert.equal(run.status,0,run.stderr);
  assert.equal(fs.readFileSync(path.join(f.codeProject,'target.mjs'),'utf8'),'export const value = 43;\n');
  assert.equal(JSON.parse(run.stdout).result.identity.attempt,2);
});
test('both first-round develop filenames are refused before launch',t=>{
  const f=fixture(t);prepared(f);f.write('develop-a1.json',develop);
  const run=f.drive(f.plan(),'advance');assert.equal(run.status,2,run.stderr);
  assert.match(run.stderr,/develop\.json.*develop-a1\.json/);assert.equal(fs.existsSync(f.store),false);
});
test('develop-a1 alone is accepted for a new run',t=>{
  const f=fixture(t);prepared(f);fs.renameSync(path.join(f.answers,'develop.json'),path.join(f.answers,'develop-a1.json'));
  const run=f.drive(f.plan(),'advance');assert.equal(run.status,0,run.stderr);
  assert.equal(fs.readFileSync(path.join(f.codeProject,'target.mjs'),'utf8'),'export const value = 42;\n');
});
test('malformed develop-a2 is rejected before review launch',t=>{
  const f=fixture(t),{permissions}=reviewPending(f),before=fs.readFileSync(f.store);
  f.write('develop-a2.json',{status:'succeeded',value:{outcome:'implemented'},edits:{}});
  const run=f.drive(f.plan({mode:'resume',originalHostContext:'drive-host-a',permissions}),'advance');
  assert.equal(run.status,2,run.stderr);assert.match(run.stderr,/答案格式错误/);
  assert.deepEqual(fs.readFileSync(f.store),before);
});
function qaFixture(f,kinds,caseIds=[]){
  const featureRoot=path.join(f.specsDir,'1.work');
  fs.writeFileSync(path.join(featureRoot,'requirements.md'),'- [AC-001]: fixture\n');
  const cases=kinds.map(({kind,expected,taskIds=['T-001']},index)=>({id:`TC-${String(index+1).padStart(3,'0')}`,origin:'user',kind,
    blocking:true,acIds:['AC-001'],taskIds,title:`${kind} fixture`,preconditions:[],
    steps:['Observe fixture'],expected:[expected],cleanup:[]}));
  fs.writeFileSync(path.join(featureRoot,'test-cases.json'),JSON.stringify({schemaVersion:'1.0',feature:'work',cases}));
  fs.writeFileSync(path.join(f.specsDir,'.cm-specs-status'),JSON.stringify({status:'approved',features:['1.work'],
    specFiles:buildManifest(f.specsDir)}));
  fs.writeFileSync(path.join(f.root,'workflow.json'),JSON.stringify({documentationPaths:[],applicableAgentFiles:[],
    qa:{commands:[{id:'unit',command:[process.execPath,'--check','target.mjs'],caseIds}],
      environment:{kind:'web',carrier:'browser',target:'fixture-local',scope:'local'}}}));
  f.write('qa-assess.json',{scores:{scope:1,risk:1,accumulation:1,boundary:1},
    changes:{api:false,migration:false,authentication:false,authorization:false,payment:false}});
  f.write('documentation-inspect.json',{status:'blocked',reason:'Fixture stops before documentation review'});
  return f.plan({permissions:['--workflow-config','workflow.json','--allow-qa',
    ...(kinds.some(item=>item.kind==='browser')?['--browser-qa','available']:[])]});
}

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

test('driver resumes an interrupted develop and sends the bound abandon_effect request',t=>{
  const f=fixture(t);prepared(f);
  const first=f.drive(f.plan(),'advance');assert.equal(first.status,0,first.stderr);
  const current=JSON.parse(fs.readFileSync(f.store,'utf8'));
  const index=current.records.findIndex(row=>row.payload.type==='effect-intent'
    &&row.payload.effect.kind==='develop');assert(index>=0);
  const {revision,...body}=current;body.records=current.records.slice(0,index+1);
  fs.writeFileSync(f.store,JSON.stringify({...body,revision:digest(body)})+'\n');
  fs.rmSync(path.join(f.codeProject,'target.mjs'));
  const plan=f.plan({mode:'resume',permissions:['--allow-abandon-effect'],
    reason:'Old host and its checks have exited'});
  const result=f.drive(plan,'abandon_effect');assert.equal(result.status,0,result.stderr);
  const response=JSON.parse(result.stdout).result;
  assert.equal(response.state,'cancelled');assert.equal(response.code,'effect_abandoned');
  const saved=JSON.parse(fs.readFileSync(f.store,'utf8'));
  assert.deepEqual(saved.records.slice(-2).map(row=>row.payload.type),['effect-intent','effect-abandoned']);
});
test('real host drives split-root bootstrap scaffold, then refuses rules before creating T-002 run',t=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-ai-drive-bootstrap-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const specsDir=path.join(root,'specs5'),codeProject=path.join(root,'app'),feature='1.bootstrap';
  fs.mkdirSync(path.join(specsDir,feature),{recursive:true});fs.mkdirSync(codeProject);
  fs.writeFileSync(path.join(specsDir,feature,'requirements.md'),'# SwiftUI scaffold and rules\n');
  fs.writeFileSync(path.join(specsDir,feature,'design.md'),'# Split specs5 and app roots\n');
  fs.writeFileSync(path.join(specsDir,feature,'tasks.md'),'- [ ] T-001: 生成项目骨架 scaffold\n- [ ] T-002: 生成 AGENTS.md 和 .claude/ 规范（cm-init）\n');
  fs.writeFileSync(path.join(specsDir,'.cm-specs-status'),JSON.stringify({status:'approved',features:[feature],specFiles:buildManifest(specsDir)}));
  const answers=path.join(root,'answers'),bin=path.join(root,'bin');fs.mkdirSync(answers);fs.mkdirSync(bin);
  fs.writeFileSync(path.join(answers,'app-content.mjs'),'export const app = true;\n');
  fs.writeFileSync(path.join(answers,'develop.json'),JSON.stringify({...develop,edits:{'app.mjs':'app-content.mjs'}}));
  const config=path.join(root,'run.json'),bootstrap=path.join(root,'bootstrap.json');
  const plan=path.join(root,'plan.json'),selection={versionControl:'local',modules:[],analysis:'SwiftUI iOS app'};
  const writeRun=(taskId,scope)=>fs.writeFileSync(config,JSON.stringify({version:1,specsDir,codeProject,feature,
    identity:{repositoryId:'app',runId:`bootstrap-${taskId}`,taskId,attempt:1},scope,requirements:[]}));
  const writePlan=(mode,permissions,extra={})=>fs.writeFileSync(plan,JSON.stringify({config:'run.json',mode,
    hostContext:'drive-bootstrap-host',runtime:'claude',permissions,answers:'answers',
    checks:[{id:'syntax',command:[process.execPath,'--check','app.mjs']}],...extra}));
  const env={...process.env,PATH:bin+path.delimiter+process.env.PATH,
    CM_WORKFLOW_HOME:path.join(root,'home'),CM_WORKFLOW_LOG_HOME:path.join(root,'logs')};
  const drive=operation=>spawnSync(process.execPath,[DRIVER,'--plan',plan,operation],{encoding:'utf8',timeout:30000,env});
  writeRun('T-001',['app.mjs']);fs.writeFileSync(bootstrap,JSON.stringify({selection:null}));
  const reviewCli=path.join(bin,'claude');
  fs.copyFileSync(fileURLToPath(new URL('./fixtures/claude-review-process.mjs',import.meta.url)),reviewCli);
  fs.chmodSync(reviewCli,0o700);
  const preview=spawnSync(process.execPath,[fileURLToPath(new URL('./cm-ai-host.mjs',import.meta.url)),
    'preflight','--config',config,'--review-model','fixture','--runtime','claude'],
  {encoding:'utf8',timeout:10000,env});
  assert.equal(preview.status,0,preview.stderr);
  fs.writeFileSync(path.join(root,'review.json'),preview.stdout);
  writePlan('create',['--bootstrap-config','bootstrap.json','--allow-bootstrap-write','--review-config','review.json']);
  const scaffold=drive('advance');assert.equal(scaffold.status,0,scaffold.stderr);
  const first=JSON.parse(scaffold.stdout).result;assert.equal(first.state,'awaiting_review');
  assert.equal(fs.readFileSync(path.join(codeProject,'app.mjs'),'utf8'),'export const app = true;\n');
  writePlan('resume',['--bootstrap-config','bootstrap.json','--allow-bootstrap-write','--review-config','review.json',
    '--allow-review-attempt','1'],{packageDigest:first.packageDigest});
  const review=drive('decision');
  assert.equal(review.status,0,review.stderr);assert.equal(JSON.parse(review.stdout).result.state,'approved');
  writePlan('resume',['--bootstrap-config','bootstrap.json','--allow-bootstrap-write','--review-config','review.json']);
  const completed=drive('advance');assert.equal(completed.status,0,completed.stderr);
  assert.equal(JSON.parse(completed.stdout).result.state,'fixture_completed');
  assert.match(fs.readFileSync(path.join(specsDir,feature,'tasks.md'),'utf8'),/\[x\] T-001/);
  writeRun('T-002',cmInitRuleTargets(selection,codeProject));
  fs.writeFileSync(bootstrap,JSON.stringify({selection}));
  writePlan('create',['--bootstrap-config','bootstrap.json','--allow-bootstrap-write']);
  const rules=drive('advance');assert.equal(rules.status,2,rules.stderr);
  assert.match(rules.stderr,/init_verify.*cm-ai-host\.mjs serve/);
  assert.equal(fs.existsSync(path.join(specsDir,'.reviews','.execution','bootstrap-T-002')),false);
  assert.equal(fs.existsSync(path.join(codeProject,'.claude')),false);
});
test('driver requires resume, flag and one-line reason for abandon_effect before launch',t=>{
  const f=fixture(t);
  for(const plan of [
    {mode:'create',permissions:['--allow-abandon-effect'],reason:'host exited'},
    {mode:'resume',permissions:[],reason:'host exited'},
    {mode:'resume',permissions:['--allow-abandon-effect'],reason:'line one\nline two'},
    {mode:'resume',permissions:['--allow-abandon-effect'],reason:'x'.repeat(501)}]){
    const run=f.drive(f.plan(plan),'abandon_effect');assert.equal(run.status,2,run.stderr);
    assert.match(run.stderr,/abandon_effect 需要 resume/);
    assert.equal(fs.existsSync(f.store),false);
  }
});

test('missing develop answer is refused before store creation',t=>{
  const f=fixture(t);const run=f.drive(f.plan(),'advance');
  assert.equal(run.status,2);assert.match(run.stderr,/develop\.json/);assert.equal(fs.existsSync(f.store),false);
});
test('single driver accepts input limit as a value before host launch',t=>{
  const f=fixture(t);
  const run=f.drive(f.plan({permissions:['--input-limit','1048576']}),'advance');
  assert.equal(run.status,2);assert.match(run.stderr,/develop\.json/);
  assert.doesNotMatch(run.stderr,/permissions 无效|--input-limit 文件不存在/);
  assert.equal(fs.existsSync(f.store),false);
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
test('mapped logic case is still refused because executor asks qa_logic',t=>{
  const f=fixture(t);prepared(f);
  const plan=qaFixture(f,[{kind:'logic',expected:'Unit check passes'},
    {kind:'browser',expected:'[需确认] Browser evidence'}],['TC-001']);
  const run=f.drive(plan,'advance');
  assert.equal(run.status,2,run.stderr);
  assert.match(run.stderr,/缺少真实执行 runner: qa_logic/);
  assert.doesNotMatch(run.stderr,/qa_browser/);
  assert.equal(fs.existsSync(f.store),false);
});
test('marked browser case launches without qa_browser runner',t=>{
  const f=fixture(t);prepared(f);
  const run=f.drive(qaFixture(f,[{kind:'browser',expected:'[需确认] Browser evidence'}]),'advance');
  assert.doesNotMatch(run.stderr,/缺少真实执行 runner/);
  assert(fs.existsSync(f.store),run.stderr);
});
test('uncovered logic case is refused before launch without qa_logic runner',t=>{
  const f=fixture(t);prepared(f);
  const run=f.drive(qaFixture(f,[{kind:'logic',expected:'Unit check passes'}]),'advance');
  assert.equal(run.status,2,run.stderr);assert.match(run.stderr,/缺少真实执行 runner: qa_logic/);
  assert.equal(fs.existsSync(f.store),false);
});
test('unmarked browser case is refused before launch without qa_browser runner',t=>{
  const f=fixture(t);prepared(f);
  const run=f.drive(qaFixture(f,[{kind:'browser',expected:'Browser evidence'}]),'advance');
  assert.equal(run.status,2,run.stderr);assert.match(run.stderr,/缺少真实执行 runner: qa_browser/);
  assert.equal(fs.existsSync(f.store),false);
});
test('cases bound to another unfinished task do not require QA runners yet',t=>{
  const f=fixture(t);prepared(f);
  fs.writeFileSync(path.join(f.specsDir,'1.work','tasks.md'),'- [ ] T-001: current\n- [ ] T-002: future\n');
  const run=f.drive(qaFixture(f,[{kind:'logic',expected:'Future logic',taskIds:['T-002']},
    {kind:'browser',expected:'Future browser',taskIds:['T-002']}]),'advance');
  assert.doesNotMatch(run.stderr,/缺少真实执行 runner/);
  assert(fs.existsSync(f.store),run.stderr);
});
test('protected conversation still requires the authored develop answer',t=>{
  const f=fixture(t);fs.writeFileSync(path.join(f.root,'protection.json'),JSON.stringify({checkCommands:[
    {id:'syntax',command:[process.execPath,'--check','target.mjs']}],timeoutMs:60000}));
  const run=f.drive(f.plan({checks:undefined,
    permissions:['--protected-conversation-config','protection.json']}),'advance');
  assert.equal(run.status,2);assert.match(run.stderr,/develop\.json/);assert.equal(fs.existsSync(f.store),false);
});
test('same-session resume may omit originalHostContext and cross-session omission fails exact fingerprint',t=>{
  const f=fixture(t);prepared(f);
  assert.equal(f.drive(f.plan(),'advance').status,0);
  const before=fs.readFileSync(f.store);
  const same=f.drive(f.plan({mode:'resume',answers:undefined,checks:undefined}),'status');
  assert.equal(same.status,0,same.stderr);
  assert.equal(JSON.parse(same.stdout).result.state,'awaiting_review');
  const cross=f.drive(f.plan({mode:'resume',hostContext:'drive-host-b',answers:undefined,checks:undefined}),'status');
  assert.equal(cross.status,1,cross.stderr);assert.match(cross.stderr,/fingerprint_mismatch/);
  assert.deepEqual(fs.readFileSync(f.store),before);
});
test('supersession flags reach create and incomplete or resume pairs stop before host launch',t=>{
  const f=fixture(t);prepared(f);
  const both=['--supersede-reviewed-evidence','--supersede-reason','operator restart'];
  const create=f.drive(f.plan({permissions:both}),'advance');
  assert.equal(create.status,1,create.stderr);
  assert.match(create.stderr,/supersede_unavailable/);
  const accepted=f.drive(f.plan({permissions:[...both,'--accept-superseded-code-drift']}),'advance');
  assert.equal(accepted.status,1,accepted.stderr);
  assert.match(accepted.stderr,/supersede_unavailable/);
  for(const permissions of [['--supersede-reviewed-evidence'],['--supersede-reason','operator restart']]){
    const refused=f.drive(f.plan({permissions}),'advance');
    assert.equal(refused.status,2,refused.stderr);
    assert.match(refused.stderr,/supersede-reviewed-evidence.*supersede-reason/);
  }
  const orphan=f.drive(f.plan({permissions:['--accept-superseded-code-drift']}),'advance');
  assert.equal(orphan.status,2,orphan.stderr);
  assert.match(orphan.stderr,/accept-superseded-code-drift.*supersede-reviewed-evidence/);
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
