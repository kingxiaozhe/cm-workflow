import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {prepareFixRepair,verifyFixRepair} from '../runtime/js/cm-fix/repair.mjs';
import {createFixRedTest} from '../runtime/js/cm-fix/red-test.mjs';
import {createFixBaseline} from '../runtime/js/cm-fix/baseline.mjs';
import {captureReviewBaseline,createReviewPackage} from '../runtime/js/cm-ai/review-package.mjs';
import {createHostHandoff} from '../runtime/js/cm-ai/host-handoff.mjs';
import {createFixFinalReview,fixFinalReviewConfiguration,inspectFixRepairReview} from '../runtime/js/cm-fix/final-review.mjs';
import {createHostReviewAuthority} from '../runtime/js/cm-ai/host-review-authority.mjs';
import {createHostToolBridge} from '../runtime/js/cm-ai/host-tool-bridge.mjs';
import {reviewPaths} from '../runtime/js/cm-ai/review-runner.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';

const MiB=1024*1024,MARK='CM_REPAIR_INPUT_BUDGET',size=x=>Buffer.byteLength(JSON.stringify(x)),sha=b=>createHash('sha256').update(b).digest('hex');
const tree=root=>{const rows=[];function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){const p=path.join(dir,e.name);if(e.isDirectory())walk(p);else rows.push({path:path.relative(root,p),mode:fs.statSync(p).mode&511,sha256:sha(fs.readFileSync(p))});}}walk(root);return rows;};
async function fixture(t,{paddingBytes=430*1024}={}){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'fix-repair-input-budget-'))),codeProject=path.join(root,'code'),specsRoot=path.join(root,'specs');fs.mkdirSync(codeProject);fs.mkdirSync(specsRoot);fs.mkdirSync(path.join(specsRoot,'.reviews'));
 const saved={},home=path.join(root,'home');fs.mkdirSync(home);
 for(const key of ['HOME','CLAUDE_HOME','CODEX_HOME','CM_WORKFLOW_HOME','CM_WORKFLOW_LOG_HOME']){saved[key]=process.env[key];process.env[key]=path.join(home,key);fs.mkdirSync(process.env[key]);}
 t.after(()=>{for(const [k,v]of Object.entries(saved))if(v===undefined)delete process.env[k];else process.env[k]=v;fs.rmSync(root,{recursive:true,force:true});});
 fs.writeFileSync(path.join(codeProject,'value.mjs'),'export const value=1;');
 fs.writeFileSync(path.join(codeProject,'red.mjs'),"import {value} from './value.mjs';if(value!==2){console.error('OWNED BUDGET BUG');process.exit(1)}");
 fs.writeFileSync(path.join(codeProject,'existing.mjs'),"import {value} from './value.mjs';if(typeof value!=='number')process.exit(1)");
 for(const p of ['context-a.txt','context-b.txt'])fs.writeFileSync(path.join(codeProject,p),'x'.repeat(paddingBytes));
 const firstIdentity={repositoryId:'owned-fixture',runId:'repair-budget',taskId:'T-FIX-budget',attempt:1},identity={...firstIdentity,attempt:2},signal=new AbortController().signal;
 const redTest={cwd:codeProject,testFiles:['red.mjs'],command:[process.execPath,'red.mjs'],expectedFailure:{exitCode:1,outputIncludes:'OWNED BUDGET BUG'},timeoutMs:3000};
 const baseline={cwd:codeProject,testFiles:['existing.mjs'],commands:[{id:'existing',command:[process.execPath,'existing.mjs']}],timeoutMs:3000};
 const redEvidence=await createFixRedTest(redTest,{identity:firstIdentity,specsRoot})({identity:firstIdentity},{authorized:true,signal});
 const beforeBaseline=await createFixBaseline(baseline)({identity:firstIdentity},{authorized:true,signal});
 assert.equal(redEvidence.status,'red_confirmed');assert.equal(beforeBaseline.status,'recorded');
 const priorBaseline=captureReviewBaseline({root:codeProject,specsRoot,identity:firstIdentity,scope:['value.mjs'],requirements:['context-a.txt','context-b.txt']});
 fs.writeFileSync(path.join(codeProject,'value.mjs'),'export const value=2;');
 const checks=[{id:'unit',command:[process.execPath,'red.mjs'],outcome:'passed',exitCode:0,evidence:'Owned synthetic first repair checked in fixture'}];
 const handoffPath=path.join(specsRoot,'.reviews','budget-a1-handoff.json');createHostHandoff({root:codeProject,baseline:priorBaseline,checks,handoffPath,evidence:['Owned first-round package fixture']});
 const pkg=createReviewPackage({root:codeProject,baseline:priorBaseline,checks,handoffPath});
 const configuration=fixFinalReviewConfiguration({hostContextId:'owned-host',causeReview:{reviewerId:'fixture-cause',adapterId:'codex-cause-review-adapter',provider:'codex',requestedModel:'fixture',contextId:'fixture-cause-context',excludedThreadIds:[]}});
 const authority=createHostReviewAuthority({hostContextId:configuration.hostContextId,reviewerId:configuration.reviewer.reviewerId,adapterId:configuration.reviewer.adapterId,decide:async()=>({status:'approved'})});
 await authority.hostDecisionProvider.decide({identity:firstIdentity,packageDigest:pkg.packageDigest},signal);
 let registration,started;
 const review=createFixFinalReview({reviewPackage:pkg,configuration,timeoutMs:3000},{authorize:authority.authorize,run:async(request,{onEvent})=>{
  for(const event of [{event:'thread.started',provider_thread:'owned-budget-reviewer'},{event:'turn.started',item_type:null},{event:'item.completed',item_type:'agent_message'},{event:'turn.completed',item_type:null},{event:'process_closed',exit_code:0,signal:null,timed_out:false}])assert.equal(onEvent(event),true);
  return {status:'succeeded',value:{verdict:'changes_requested',packageDigest:pkg.packageDigest,examinedPaths:reviewPaths(pkg),findings:[{id:'F1',severity:'P2',path:'value.mjs',message:'Owned second repair needed',evidence:'Owned fixture finding'}],summary:'Synthetic independent finding; no provider'}};
 }});
 const observed=await review({signal,register(value){registration=value;},onStarted(value){started=value;}});assert.equal(observed.outcome,'observed');
 const reviewFeedback={configuration,registration,started,result:observed.value},priorReview=inspectFixRepairReview(reviewFeedback,identity);
 assert.equal(priorReview.review.verdict,'changes_requested');assert.deepEqual(priorReview.identity,firstIdentity);
 const options={identity,specsRoot,codeProject,scope:['value.mjs'],requirements:['value.mjs'],defect:'Owned second-round repair',diagnosis:{status:'diagnosed',affectedPaths:['value.mjs'],rootCause:'Owned constant repair'},redTest,baseline,redEvidence,beforeBaseline,reviewFeedback};
 return {root,codeProject,specsRoot,options,reviewFeedback,priorReview,firstIdentity,identity,signal};
}
const quiet=()=>({bridge:{async call(){throw Error('prepare must not execute bridge');}},assertReviewReady(){}});
function expectedPreparation(options,capabilities){try{return prepareFixRepair(options,capabilities);}catch(error){if(error.code==='limit_exceeded')throw new Error(MARK+': a fully validated reviewFeedback above 1MiB must prepare under its existing 12MiB budget',{cause:error});throw error;}}

test('repair input budget: valid large prior review prepares without executing or changing source scope',async t=>{
 const f=await fixture(t),before=tree(f.codeProject),feedbackBefore=digest(f.reviewFeedback),{reviewFeedback,...rest}=f.options;
 assert(size(reviewFeedback)>MiB&&size(reviewFeedback)<12*MiB);assert(size(rest)<MiB);
 const repair=expectedPreparation(f.options,quiet());assert.deepEqual(tree(f.codeProject),before);assert.equal(digest(f.reviewFeedback),feedbackBefore);
 assert.deepEqual(repair.baseline.identity,f.identity);assert.deepEqual(repair.baseline.scope,['value.mjs']);assert.equal(typeof repair.execute,'function');
});

test('repair input budget: actual second repair execution preserves first red and enforces original scope and authority',async t=>{
 const f=await fixture(t),redPath=path.join(f.specsRoot,f.options.redEvidence.output.path),oldRed=fs.readFileSync(redPath),oldTests=['red.mjs','existing.mjs'].map(p=>[p,fs.readFileSync(path.join(f.codeProject,p))]);
 assert.throws(()=>prepareFixRepair({...f.options,scope:['value.mjs','context-a.txt']},quiet()),{code:'repair_scope_mismatch'});
 const bridge=createHostToolBridge();t.after(()=>bridge.close());let ready=0,registered=0,writes=0;
 bridge.attach(row=>{if(row.type!=='host_request')return;assert.equal(row.kind,'fix_repair');assert.equal(ready,1);assert.equal(registered,1);assert.deepEqual(row.payload.identity,f.identity);assert.deepEqual(row.payload.priorReview,f.priorReview);assert.deepEqual(row.payload.priorReview.identity,f.firstIdentity);assert.deepEqual(row.payload.scope,['value.mjs']);writes++;
  fs.writeFileSync(path.join(f.codeProject,'value.mjs'),'export const value=2;\n// second repair addresses the owned finding');bridge.accept({type:'host_result',sessionId:row.sessionId,callId:row.callId,requestDigest:row.requestDigest,result:{outcome:'repaired'}});
 });
 const repair=expectedPreparation(f.options,{bridge,assertReviewReady(){ready++;}}),control={authorized:true,signal:f.signal,register(b){registered++;assert.equal(b.baselineDigest,repair.baseline.baselineDigest);}};
 await assert.rejects(repair.execute({...control,authorized:false}),{code:'repair_authorization_required'});assert.equal(writes,0);
 const result=await repair.execute(control);assert.deepEqual(result.changedFiles,['value.mjs']);assert.equal(result.completionEligible,false);assert.equal(writes,1);verifyFixRepair({codeProject:f.codeProject,specsRoot:f.specsRoot,baseline:repair.baseline,result});
 assert.deepEqual(fs.readFileSync(redPath),oldRed);for(const [p,b]of oldTests)assert.deepEqual(fs.readFileSync(path.join(f.codeProject,p)),b);await assert.rejects(repair.execute(control),{code:'repair_already_attempted'});
});

test('repair input budget: large malformed package, grant, identity and verdict retain strict review validation',async t=>{
 const f=await fixture(t),before=tree(f.codeProject);
 for(const kind of ['package','grant','identity','verdict']){
  const feedback=structuredClone(f.reviewFeedback),identity=kind==='identity'?{...f.identity,runId:'foreign'}:f.identity;
  if(kind==='package')feedback.registration.request.payload.reviewPackage.packageDigest='0'.repeat(64);
  if(kind==='grant')feedback.registration.grant.packageDigest='0'.repeat(64);
  if(kind==='verdict')feedback.result.observation.result.value.verdict='approved';
  let expected;try{inspectFixRepairReview(feedback,identity);}catch(error){expected=error.code;}assert(expected,kind+' fixture must be genuinely invalid under the unchanged validator');
  assert.throws(()=>prepareFixRepair({...f.options,identity,reviewFeedback:feedback},quiet()),error=>error.code===expected,kind);assert.deepEqual(tree(f.codeProject),before);
 }
});

test('repair input budget: feedback 12MiB and all other arguments 1MiB remain separate hard bounds',async t=>{
 const f=await fixture(t),before=tree(f.codeProject),overFeedback={...f.reviewFeedback,oversize:'x'.repeat(12*MiB-size(f.reviewFeedback)+8)};
 assert(size(overFeedback)>12*MiB&&size({...f.options,reviewFeedback:overFeedback})<13*MiB);
 assert.throws(()=>prepareFixRepair({...f.options,reviewFeedback:overFeedback},quiet()),{code:'limit_exceeded'});
 assert.throws(()=>prepareFixRepair({...f.options,defect:'x'.repeat(MiB+1)},quiet()),{code:'limit_exceeded'});
 const edgeFeedback={...f.reviewFeedback,oversize:''};edgeFeedback.oversize='x'.repeat(12*MiB-size(edgeFeedback));
 const {reviewFeedback,...parameters}=f.options,edgeParameters={...parameters,defect:''};edgeParameters.defect='x'.repeat(MiB-size(edgeParameters));
 assert.equal(size(edgeFeedback),12*MiB);assert.equal(size(edgeParameters),MiB);
 const edgeOptions={...edgeParameters,reviewFeedback:edgeFeedback};assert.equal(size(edgeOptions),13*MiB+Buffer.byteLength(',"reviewFeedback":'));
 // This extra-key feedback remains invalid. The wrapper must reach the existing validator,
 // rather than reject valid-sized subcontracts because of its own JSON framing bytes.
 assert.throws(()=>inspectFixRepairReview(edgeFeedback,f.identity),{code:'invalid_input'});
 assert.throws(()=>prepareFixRepair(edgeOptions,quiet()),{code:'invalid_input'});
 assert.deepEqual(tree(f.codeProject),before);
});

test('repair input budget: plain shape and accessor rejection never execute user getters',async t=>{
 const f=await fixture(t),before=tree(f.codeProject);let getterCalls=0;
 const getter={...f.options};Object.defineProperty(getter,'reviewFeedback',{enumerable:true,get(){getterCalls++;throw Error('must not execute getter');}});
 assert.throws(()=>prepareFixRepair(getter,quiet()),{code:'invalid_input'});
 const nested={...f.reviewFeedback};Object.defineProperty(nested,'registration',{enumerable:true,get(){getterCalls++;throw Error('nested getter must not execute');}});
 assert.throws(()=>prepareFixRepair({...f.options,reviewFeedback:nested},quiet()),{code:'invalid_input'});
 assert.throws(()=>prepareFixRepair(Object.assign(Object.create({foreign:true}),f.options),quiet()),{code:'invalid_input'});
 assert.throws(()=>prepareFixRepair({...f.options,arbitrary:true},quiet()),{code:'invalid_input'});assert.equal(getterCalls,0);assert.deepEqual(tree(f.codeProject),before);
});

test('repair input budget: no-feedback legacy keeps its 1MiB limit and unchanged prepare behavior',async t=>{
 const f=await fixture(t,{paddingBytes:8}),{reviewFeedback,...rest}=f.options,options={...rest,identity:f.firstIdentity},before=tree(f.codeProject);
 const repair=prepareFixRepair(options,quiet());assert.deepEqual(repair.baseline.identity,f.firstIdentity);assert.deepEqual(tree(f.codeProject),before);
 assert.throws(()=>prepareFixRepair({...options,defect:'x'.repeat(MiB+1)},quiet()),{code:'limit_exceeded'});
});
