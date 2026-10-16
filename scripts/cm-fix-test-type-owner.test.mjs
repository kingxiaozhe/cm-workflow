import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import * as execution from '../runtime/js/cm-fix/execution.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
import {startFixRun} from '../runtime/js/cm-fix/start.mjs';
import {createHostReviewAuthority} from '../runtime/js/cm-ai/host-review-authority.mjs';
import {fixFinalReviewConfiguration} from '../runtime/js/cm-fix/final-review.mjs';
import {reviewPaths} from '../runtime/js/cm-ai/review-runner.mjs';
import {createFixReviewHost} from '../runtime/js/cm-fix/host-review.mjs';
import {claudeReviewFingerprint} from '../runtime/js/cm-ai/worker-claude.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
const annotation='{ props: { pointerEvents?: string; accessible?: boolean } }';
const DRIVER=fileURLToPath(new URL('./cm-fix-drive.mjs',import.meta.url));
const INSPECT=fileURLToPath(new URL('./cm-fix-test-type-correction.mjs',import.meta.url));
async function fixture(t,{commandCorrection=false}={}){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'fix-test-type-owner-'))),cwd=path.join(root,'code'),specsRoot=path.join(root,'specs');
 fs.mkdirSync(path.join(cwd,'app/node_modules/typescript/bin'),{recursive:true});fs.mkdirSync(specsRoot);
 fs.writeFileSync(path.join(cwd,'.cm-workflow.json'),JSON.stringify({version:1,runtimes:{available:'both'},roles:{coder:{adapter:'codex-cli'},reviewer:{adapter:'claude-cli'}},policies:{delivery:'diff'}}));
 fs.writeFileSync(path.join(cwd,'value.mjs'),'export const value=1;\n');
 fs.writeFileSync(path.join(cwd,'existing.mjs'),"import {value} from './value.mjs';if(typeof value!=='number')process.exit(1);\n");
 fs.writeFileSync(path.join(cwd,'reproduce.mjs'),"import {value} from './value.mjs';if(value!==2){console.error('TARGET BUG');process.exit(1);}\n");
 const testPath='app/button.spec.ts',source=[
  "import assert from 'node:assert/strict';",
  `import {value} from ${JSON.stringify(pathToFileURL(path.join(cwd,'value.mjs')).href)};`,
  "const layers = (button: { findAll: Function }) => button.findAll(n => n.props.pointerEvents === 'none' && n.props.accessible === false);",
  "assert.equal(value,2,'TARGET BUG');",''].join('\n');
 fs.writeFileSync(path.join(cwd,'app/foreign.spec.ts'),source);
 // Synthetic local checker: this fixture scans the exact annotation; it is NOT a TypeScript compiler.
 fs.writeFileSync(path.join(cwd,'app/node_modules/typescript/bin/tsc'),`const fs=require('node:fs');if(!fs.readFileSync('app/button.spec.ts','utf8').includes(${JSON.stringify(`(n: ${annotation}) =>`)})){console.error("app/button.spec.ts(3,62): error TS7006: Parameter 'n' implicitly has an 'any' type.");process.exit(2);}`);
 const identity={repositoryId:'fixture',runId:'test-type-owner',taskId:'T-FIX-typing',attempt:1};
 // Synthetic preflight and review worker are fixture wiring only, never real provider readiness.
 const reviewConfig={model:'synthetic',disabledSkills:[],preflight:{passed:true,provider:'claude',prompt_transport:'stdin',config_fingerprint:claudeReviewFingerprint({cwd,model:'synthetic'})}};
 const reviewer=createFixReviewHost({codeProject:cwd,hostContextId:'fixture-author',runtime:'codex',reviewRuntime:'claude',review:reviewConfig}).reviewer;
 const configuration={hostContextId:'fixture-author',reviewRuntime:'claude',defect:'Wrong constant and an authored test has missing callback type',
  causeReview:reviewer,
  reproduction:{cwd,command:[process.execPath,'reproduce.mjs'],expectedFailure:{exitCode:1,outputIncludes:'TARGET BUG'},timeoutMs:3000},
  testAuthor:{requirements:['value.mjs']},
  redTest:{cwd,testFiles:[testPath],command:[process.execPath,testPath],expectedFailure:{exitCode:1,outputIncludes:'TARGET BUG'},timeoutMs:3000},
  baseline:{cwd,testFiles:['existing.mjs'],commands:[{id:'existing',command:[process.execPath,'existing.mjs']},{id:'types',command:[process.execPath,'app/node_modules/typescript/bin/tsc','--noEmit','--project','app/tsconfig.json']}],timeoutMs:3000},
  repair:{scope:['value.mjs'],requirements:['value.mjs']},
  walkthrough:{timeoutMs:3000,flows:[{id:'constant',modules:['constant'],kind:'commands',steps:['Execute the authored assertion'],expected:['value equals 2'],command:[process.execPath,testPath]}]}};
 fs.writeFileSync(path.join(cwd,'app/tsconfig.json'),'{}');
 if(commandCorrection){
  fs.mkdirSync(path.join(cwd,'app/node_modules/jest/bin'),{recursive:true});
  fs.writeFileSync(path.join(cwd,'app/package.json'),JSON.stringify({jest:{}}));
  const launcher='app/node_modules/jest/bin/jest.js';
  // Configuration-discovery fixture only, not an actual Jest installation.
  fs.writeFileSync(path.join(cwd,launcher),String.raw`if(!process.argv.includes('--config')){console.error('Error: Could not find a config file based on provided values:\ncwd: "'+process.cwd()+'"');process.exit(1)}import(require('node:url').pathToFileURL(process.cwd()+'/app/button.spec.ts').href);`);
  const command=[process.execPath,launcher,'--rootDir','app','--runTestsByPath',testPath];
  configuration.redTest.command=command;configuration.walkthrough.flows[0].command=command;
 }

 const learning={contextDigest:digest([]),files:[],application:{contextDigest:digest([]),status:'no_relevant_lesson',summary:'Fixture'}};
 const capabilities={prepare:async()=>learning,assertReviewReady(){},bridge:{async call(kind){
  if(kind==='fix_diagnose')return {status:'diagnosed',rootCause:'Wrong constant',affectedPaths:['value.mjs'],affectedModules:['constant'],plan:'Set value to 2',crossLayer:false,investigation:{discardedAlternatives:[],boundaryAnalysis:null}};
  if(kind==='fix_test_author'){fs.writeFileSync(path.join(cwd,testPath),source);return {outcome:'authored'};}
  if(kind==='fix_repair'){fs.writeFileSync(path.join(cwd,'value.mjs'),'export const value=2;\n');return {outcome:'repaired'};}
  assert.equal(kind,'fix_retrospective');return {status:'no_new_lesson',candidates:[],reason:null};
 }}};
 const options={specsRoot,identity,configuration};let owner=execution.openFixExecution({...options,create:true},capabilities);
 t.after(()=>{owner.close();fs.rmSync(root,{recursive:true,force:true});});
 startFixRun(options);assert.equal((await owner.advance({authorized:true})).stage,'test_author_required');
 assert.equal((await owner.authorTests({authorized:true})).stage,'red_test_required');
 let commandAudit=null;
 if(commandCorrection){
  assert.equal((await owner.runRedTest({authorized:true})).stage,'red_test_not_confirmed');
  const before=JSON.parse(fs.readFileSync(path.join(specsRoot,'.reviews/.execution',identity.runId,'state.json'))),red=owner.status().redTest;
  commandAudit={before,output:red.output,bytes:fs.readFileSync(path.join(specsRoot,red.output.path))};
  const declaration={kind:'jest-config-path',path:'app/package.json'},expected=owner.inspectCommandCorrection({declaration});
  assert.equal(owner.prepareCommandCorrection({authorized:true,expected,declaration,previousInvocationStopped:true,reason:'Add only existing Jest configuration path'}).stage,'red_test_required');
 }
 assert.equal((await owner.runRedTest({authorized:true})).stage,'baseline_required');
 assert.equal((await owner.captureBaseline({authorized:true})).stage,'repair_required');
 assert.equal((await owner.repair({authorized:true})).stage,'regression_required');
 assert.equal((await owner.runRegression({authorized:true})).stage,'regression_blocked');
 assert.equal(owner.status().regression.status,'inconclusive');assert.equal(owner.status().baseline.observations[1].exitCode,2);
 const statePath=path.join(specsRoot,'.reviews/.execution',identity.runId,'state.json');
 return {root,cwd,specsRoot,identity,configuration,reviewConfig,options,source,testPath,commandAudit,statePath,state:()=>JSON.parse(fs.readFileSync(statePath)),
  declaration:{kind:'callback-type-annotation',path:testPath,beforeSha256:sha(source),line:3,parameter:'n',annotation},
  get owner(){return owner;},reopen(extra={}){owner.close();owner=execution.openFixExecution({...options,create:false},{...capabilities,...extra});return owner;}};
}
const input=(f,expected)=>({authorized:true,expected,declaration:f.declaration,previousInvocationStopped:true,reason:'Add only the authored callback parameter type'});

for(const commandCorrection of [false,true])test(`${commandCorrection?'combined command and type corrections: ':''}owner typing correction retains original red/repair and reaches reviewed complete after real local command reruns`,async t=>{
 const f=await fixture(t,{commandCorrection}),before=f.state(),red=f.owner.status().redTest,rawRed=fs.readFileSync(path.join(f.specsRoot,red.output.path));
 const expected=f.owner.inspectTestTypeCorrection({declaration:f.declaration});assert.deepEqual(f.state(),before);
 assert.equal((await f.owner.prepareTestTypeCorrection(input(f,expected))).stage,'regression_blocked');
 const corrected=fs.readFileSync(path.join(f.cwd,f.testPath),'utf8');
 assert.equal(corrected,f.source.replace('findAll(n =>',`findAll((n: ${annotation}) =>`));
 assert.deepEqual(f.state().records.slice(0,before.records.length),before.records);assert.deepEqual(f.state().fingerprints,before.fingerprints);
 assert.deepEqual(fs.readFileSync(path.join(f.specsRoot,red.output.path)),rawRed);
 assert.equal(f.reopen().status().stage,'regression_blocked');
 assert.equal(f.owner.rerunBlockedStep({authorized:true,reason:'Recheck the original commands after bound type-only correction'}).stage,'regression_required');
 assert.equal((await f.owner.runRegression({authorized:true})).stage,'handoff_required');
 assert.equal(f.owner.status().regression.baseline.observations[1].outcome,'passed');
 assert.equal(f.owner.status().regression.comparison.comparisons[1].status,'now_passed');
 assert.equal((await f.owner.retrospect()).stage,'handoff_ready');assert.equal(f.owner.createHandoff().stage,'final_review_required');
 const pkg=f.owner.finalReviewPackage(),changed=pkg.changes.find(c=>c.path===f.testPath);
 assert.ok(changed);assert.equal(Buffer.from(changed.after.contentBase64,'base64').toString(),corrected);
 const handoff=JSON.parse(Buffer.from(pkg.handoff.contentBase64,'base64').toString());assert.ok(handoff.evidence.some(e=>/type.*correction|typing.*correction/i.test(e)));
 const cfg=fixFinalReviewConfiguration(f.configuration),authority=createHostReviewAuthority({hostContextId:cfg.hostContextId,reviewerId:cfg.reviewer.reviewerId,adapterId:cfg.reviewer.adapterId,decide:async()=>({status:'approved'})});
 await authority.hostDecisionProvider.decide({identity:pkg.identity,packageDigest:pkg.packageDigest},new AbortController().signal);
 let calls=0;f.reopen({finalReview:{authorize:authority.authorize,async run(request,{onEvent}){
  calls++;assert.equal(request.provider,'claude');for(const e of [{event:'thread.started',provider_thread:'synthetic-type-review'},{event:'turn.started',item_type:null},{event:'item.completed',item_type:'agent_message'},{event:'turn.completed',item_type:null},{event:'process_closed',exit_code:0,signal:null,timed_out:false}])assert.equal(onEvent(e),true);
  return {status:'succeeded',value:{verdict:'approved',packageDigest:request.payload.reviewPackage.packageDigest,examinedPaths:reviewPaths(request.payload.reviewPackage),findings:[],summary:'Synthetic fixture only; no actual Claude call'}};
 }}});
 assert.equal((await f.owner.reviewFinal()).stage,'final_review_evidence_required');assert.equal(f.owner.publishReview().stage,'completion_gate_required');
 assert.equal(f.owner.checkCompletionGate().stage,'post_review_regression_required');
 assert.equal((await f.owner.runRegression({authorized:true,postReview:true})).stage,'closeout_required');
 assert.equal((await f.reopen().runWalkthrough({authorized:true})).stage,'closeout_required');assert.equal(f.owner.status().walkthrough.status,'passed');
 const pending=f.owner.finish({authorized:true,cooperative:true});assert.ok(pending instanceof Promise);
 assert.throws(()=>f.owner.finish({authorized:true}),{code:'fix_busy'});
 assert.throws(()=>f.owner.checkCompletionGate(),{code:'fix_busy'});
 const done=await pending;assert.equal(done.stage,'completed');assert.equal(done.completionEligible,true);assert.equal(calls,1);
 assert.equal((await f.owner.finish({authorized:true,cooperative:true})).stage,'completed');
 assert.equal(f.reopen().completionEvidence().identity.runId,f.identity.runId);assert.deepEqual(fs.readFileSync(path.join(f.specsRoot,red.output.path)),rawRed);
 if(f.commandAudit){
  assert.deepEqual(f.state().records.slice(0,f.commandAudit.before.records.length),f.commandAudit.before.records);
  assert.deepEqual(f.state().fingerprints,f.commandAudit.before.fingerprints);
  assert.deepEqual(fs.readFileSync(path.join(f.specsRoot,f.commandAudit.output.path)),f.commandAudit.bytes);
  assert.equal(f.state().records.filter(r=>r.id==='fix-command-correction').length,1);
  assert.equal(f.state().records.filter(r=>r.id==='fix-test-type-correction-result').length,1);
  assert.match(f.owner.status().redTest.output.path,/-retry-1\.md$/);
 }

});

test('read-only typing preview exists and unauthorized/stale/foreign declarations cannot write or advance',async t=>{
 const f=await fixture(t),before=f.state();assert.equal(typeof execution.inspectFixTestTypeCorrection,'function');
 const expected=f.owner.inspectTestTypeCorrection({declaration:f.declaration});
 assert.deepEqual(execution.inspectFixTestTypeCorrection({specsRoot:f.specsRoot,identity:{repositoryId:f.identity.repositoryId,runId:f.identity.runId},declaration:f.declaration}),expected);
 assert.deepEqual(f.state(),before);
 for(const override of [{authorized:false},{previousInvocationStopped:false},{reason:''},{expected:{...expected,historyDigest:digest('stale')}}]){
  await assert.rejects(Promise.resolve().then(()=>f.owner.prepareTestTypeCorrection({...input(f,expected),...override})));
  assert.deepEqual(f.state(),before);assert.equal(fs.readFileSync(path.join(f.cwd,f.testPath),'utf8'),f.source);
 }
 for(const declaration of [{...f.declaration,path:'existing.mjs'},{...f.declaration,path:'app/foreign.spec.ts'},{...f.declaration,annotation:'any'},{...f.declaration,annotation:'unknown'},{...f.declaration,line:4},{...f.declaration,parameter:'other'}]){
  await assert.rejects(Promise.resolve().then(()=>f.owner.inspectTestTypeCorrection({declaration})));assert.deepEqual(f.state(),before);
 }
 await f.owner.prepareTestTypeCorrection(input(f,expected));const after=f.state();
 await assert.rejects(Promise.resolve().then(()=>f.owner.inspectTestTypeCorrection({declaration:f.declaration})));
 assert.deepEqual(f.state(),after);
});

test('real typing inspector and driver preserve frozen config and require separate preparation authority',async t=>{
 const f=await fixture(t),before=f.state();f.owner.close();
 const config=path.join(f.root,'config.json'),declarationFile=path.join(f.root,'declaration.json'),review=path.join(f.root,'review.json'),plan=path.join(f.root,'plan.json');
 const {hostContextId,causeReview,reviewRuntime,...configuration}=f.configuration;
 fs.writeFileSync(config,JSON.stringify({...configuration,specsRoot:f.specsRoot,identity:f.identity}));
 fs.writeFileSync(declarationFile,JSON.stringify(f.declaration));fs.writeFileSync(review,JSON.stringify(f.reviewConfig));
 const configBytes=fs.readFileSync(config),cli=args=>spawnSync(process.execPath,args,{encoding:'utf8',timeout:30000,env:{...process.env,CM_WORKFLOW_HOME:path.join(f.root,'home'),CM_WORKFLOW_LOG_HOME:path.join(f.root,'logs')}});
 const preview=cli([INSPECT,'--config',config,'--declaration',declarationFile]);assert.equal(preview.status,0,preview.stdout+preview.stderr);
 const expected=JSON.parse(preview.stdout).expected;assert.deepEqual(f.state(),before);assert.equal(fs.readFileSync(path.join(f.cwd,f.testPath),'utf8'),f.source);
 const base={config,cwd:f.cwd,mode:'resume',hostContext:hostContextId,runtime:'codex',reviewRuntime,reviewConfig:review,testTypeCorrection:f.declaration,previousInvocationStopped:true,expected,reason:'Explicit parameter-only type correction'};
 const drive=(permissions,extra={})=>{fs.writeFileSync(plan,JSON.stringify({...base,permissions,...extra}));return cli([DRIVER,'--plan',plan,'prepare_test_type_correction']);};
 for(const [permissions,extra]of [[[],{}],[['--allow-test-type-correction'],{previousInvocationStopped:false}],[['--allow-test-type-correction'],{mode:'create'}]]){
  const rejected=drive(permissions,extra);assert.notEqual(rejected.status,0);assert.deepEqual(f.state(),before);assert.equal(fs.readFileSync(path.join(f.cwd,f.testPath),'utf8'),f.source);
 }
 const prepared=drive(['--allow-test-type-correction']);assert.equal(prepared.status,0,prepared.stdout+prepared.stderr);assert.match(prepared.stdout,/regression_blocked/);
 const after=f.state();assert.deepEqual(after.records.slice(0,before.records.length),before.records);assert.deepEqual(after.fingerprints,before.fingerprints);assert.deepEqual(fs.readFileSync(config),configBytes);
 const used=cli([INSPECT,'--config',config,'--declaration',declarationFile]);assert.notEqual(used.status,0);assert.deepEqual(f.state(),after);
 f.reopen();assert.equal(f.owner.rerunBlockedStep({authorized:true,reason:'Original command rerun after official typing preparation'}).stage,'regression_required');
 assert.equal((await f.owner.runRegression({authorized:true})).stage,'handoff_required');
});

test('typing qualification refuses changed assertions or unrelated repaired-source drift',async t=>{
 const f=await fixture(t),before=f.state(),expected=f.owner.inspectTestTypeCorrection({declaration:f.declaration});
 const target=path.join(f.cwd,f.testPath);fs.writeFileSync(target,f.source.replace('assert.equal(value,2','assert.equal(value,1'));
 await assert.rejects(Promise.resolve().then(()=>f.owner.prepareTestTypeCorrection(input(f,expected))));assert.deepEqual(f.state(),before);
 fs.writeFileSync(target,f.source);const product=path.join(f.cwd,'value.mjs'),good=fs.readFileSync(product);fs.appendFileSync(product,'// unexpected drift\n');
 await assert.rejects(Promise.resolve().then(()=>f.owner.prepareTestTypeCorrection(input(f,expected))));assert.deepEqual(f.state(),before);
 fs.writeFileSync(product,good);assert.equal(f.owner.status().stage,'regression_blocked');
});

for(const when of ['before','after'])test(`typing intent resumes exact ${when} image after interrupted atomic write`,async t=>{
 const f=await fixture(t),before=f.state(),expected=f.owner.inspectTestTypeCorrection({declaration:f.declaration}),target=path.join(f.cwd,f.testPath);
 const rename=fs.renameSync;let interrupted=false;
 fs.renameSync=(from,to)=>{
  if(to===target&&!interrupted){interrupted=true;if(when==='before')throw Object.assign(new Error('fixture interruption before source rename'),{code:'fixture_interruption'});rename(from,to);throw Object.assign(new Error('fixture interruption after source rename'),{code:'fixture_interruption'});}
  return rename(from,to);
 };
 try{try{await f.owner.prepareTestTypeCorrection(input(f,expected));}catch{/* Expected interruption; inspect the durable intent below. */}}
 finally{fs.renameSync=rename;}
 assert.equal(interrupted,true);const pending=f.state();assert.deepEqual(pending.records.slice(0,before.records.length),before.records);
 assert.equal(pending.records.filter(r=>r.id==='fix-test-type-correction-intent').length,1);
 assert.equal(pending.records.some(r=>r.id==='fix-test-type-correction-result'),false);
 const image=fs.readFileSync(target,'utf8');assert.equal(image,when==='before'?f.source:f.source.replace('findAll(n =>',`findAll((n: ${annotation}) =>`));
 assert.equal(f.reopen().status().stage,'unknown');
 for(const override of [{previousInvocationStopped:false},{reason:'different reason'},{declaration:{...f.declaration,annotation:'number'}},{expected:{...expected,historyDigest:digest('stale')}}]){
  await assert.rejects(Promise.resolve().then(()=>f.owner.prepareTestTypeCorrection({...input(f,expected),...override})));assert.deepEqual(f.state(),pending);assert.equal(fs.readFileSync(target,'utf8'),image);
 }
 fs.appendFileSync(target,'// third image is never a recovery authority\n');
 await assert.rejects(Promise.resolve().then(()=>f.owner.prepareTestTypeCorrection(input(f,expected))));assert.deepEqual(f.state(),pending);
 fs.writeFileSync(target,image);
 assert.equal((await f.owner.prepareTestTypeCorrection(input(f,expected))).stage,'regression_blocked');
 assert.equal(f.state().records.filter(r=>r.id==='fix-test-type-correction-intent').length,1);
 assert.equal(f.state().records.filter(r=>r.id==='fix-test-type-correction-result').length,1);
 assert.deepEqual(f.state().fingerprints,before.fingerprints);
 assert.equal(f.owner.rerunBlockedStep({authorized:true,reason:'Recheck unchanged runtime assertions'}).stage,'regression_required');
 assert.equal((await f.owner.runRegression({authorized:true})).stage,'handoff_required');
});
