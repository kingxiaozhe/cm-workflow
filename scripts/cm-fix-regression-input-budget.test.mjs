import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createFixRegression} from '../runtime/js/cm-fix/regression.mjs';
import {createFixRedTest} from '../runtime/js/cm-fix/red-test.mjs';
import {createFixBaseline} from '../runtime/js/cm-fix/baseline.mjs';
import {captureReviewBaseline,createReviewPackage} from '../runtime/js/cm-ai/review-package.mjs';
import {createHostHandoff} from '../runtime/js/cm-ai/host-handoff.mjs';
import {createFixFinalReview,fixFinalReviewConfiguration,inspectFixRepairReview} from '../runtime/js/cm-fix/final-review.mjs';
import {createHostReviewAuthority} from '../runtime/js/cm-ai/host-review-authority.mjs';
import {reviewPaths} from '../runtime/js/cm-ai/review-runner.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';

const MiB=1024*1024,MARK='CM_REGRESSION_INPUT_BUDGET',size=x=>Buffer.byteLength(JSON.stringify(x)),sha=b=>createHash('sha256').update(b).digest('hex');
const tree=root=>{const rows=[];function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){const p=path.join(dir,e.name);if(e.isDirectory())walk(p);else rows.push({path:path.relative(root,p),mode:fs.statSync(p).mode&511,sha256:sha(fs.readFileSync(p))});}}walk(root);return rows;};
async function fixture(t,{paddingBytes=430*1024}={}){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'fix-regression-input-budget-'))),codeProject=path.join(root,'code'),specsRoot=path.join(root,'specs');fs.mkdirSync(codeProject);fs.mkdirSync(specsRoot);fs.mkdirSync(path.join(specsRoot,'.reviews'));
 const saved={},home=path.join(root,'home');fs.mkdirSync(home);
 for(const key of ['HOME','CLAUDE_HOME','CODEX_HOME','CM_WORKFLOW_HOME','CM_WORKFLOW_LOG_HOME']){saved[key]=process.env[key];process.env[key]=path.join(home,key);fs.mkdirSync(process.env[key]);}
 t.after(()=>{for(const [k,v]of Object.entries(saved))if(v===undefined)delete process.env[k];else process.env[k]=v;fs.rmSync(root,{recursive:true,force:true});});
 fs.writeFileSync(path.join(codeProject,'value.mjs'),'export const value=1;');
 fs.writeFileSync(path.join(codeProject,'red.mjs'),"import {value} from './value.mjs';if(value!==2){console.error('OWNED BUDGET BUG');process.exit(1)}");
 fs.writeFileSync(path.join(codeProject,'existing.mjs'),"import {value} from './value.mjs';if(typeof value!=='number')process.exit(1)");
 for(const p of ['context-a.txt','context-b.txt'])fs.writeFileSync(path.join(codeProject,p),'x'.repeat(paddingBytes));
 const firstIdentity={repositoryId:'owned-fixture',runId:'regression-budget',taskId:'T-FIX-budget',attempt:1},identity={...firstIdentity,attempt:2},signal=new AbortController().signal;
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
 const options={identity,specsRoot,redTest,baseline,redEvidence,beforeBaseline,reviewFeedback};
 return {root,codeProject,specsRoot,options,reviewFeedback,priorReview,firstIdentity,identity,signal};
}
function expectedRegression(options){try{return createFixRegression(options);}catch(error){if(error.code==='limit_exceeded')throw new Error(MARK+': fully validated reviewFeedback above 1MiB must construct regression under its existing 12MiB budget',{cause:error});throw error;}}

test('regression input budget: valid large prior review constructs without executing or changing source',async t=>{
 const f=await fixture(t),before=tree(f.codeProject),feedbackBefore=digest(f.reviewFeedback),{reviewFeedback,...rest}=f.options;
 assert(size(reviewFeedback)>MiB&&size(reviewFeedback)<12*MiB);assert(size(rest)<MiB);
 const run=expectedRegression(f.options);assert.equal(typeof run,'function');assert.deepEqual(tree(f.codeProject),before);assert.equal(digest(f.reviewFeedback),feedbackBefore);
});

test('regression input budget: actual a2 run preserves a1 red and enforces identity, authorization and single use',async t=>{
 const f=await fixture(t),before=tree(f.codeProject),redPath=path.join(f.specsRoot,f.options.redEvidence.output.path),originalRed=fs.readFileSync(redPath),request={identity:f.identity},control={authorized:true,signal:f.signal},run=expectedRegression(f.options);
 assert.deepEqual(f.priorReview.identity,f.firstIdentity);assert.equal(f.options.identity.attempt,2);
 await assert.rejects(run(request,{...control,authorized:false}),{code:'regression_authorization_required'});
 await assert.rejects(run({identity:f.firstIdentity},control),{code:'identity_mismatch'});
 const result=await run(request,control);assert.equal(result.status,'passed');assert.equal(result.red.outcome,'passed');assert.equal(result.comparison.status,'passed');assert.equal(result.comparison.comparisons[0].status,'still_passed');assert.equal(result.completionEligible,false);
 assert.deepEqual(fs.readFileSync(redPath),originalRed);assert.deepEqual(tree(f.codeProject),before);
 await assert.rejects(run(request,control),{code:'regression_already_attempted'});
});

test('regression input budget: malformed large package, grant, identity and verdict retain original feedback validation',async t=>{
 const f=await fixture(t),before=tree(f.codeProject);
 for(const kind of ['package','grant','identity','verdict']){
  const feedback=structuredClone(f.reviewFeedback),identity=kind==='identity'?{...f.identity,runId:'foreign'}:f.identity;
  if(kind==='package')feedback.registration.request.payload.reviewPackage.packageDigest='0'.repeat(64);
  if(kind==='grant')feedback.registration.grant.packageDigest='0'.repeat(64);
  if(kind==='verdict')feedback.result.observation.result.value.verdict='approved';
  let expected;try{inspectFixRepairReview(feedback,identity);}catch(error){expected=error.code;}assert(expected,kind+' must be invalid under the unchanged feedback validator');
  assert.throws(()=>createFixRegression({...f.options,identity,reviewFeedback:feedback}),error=>error.code===expected,kind);assert.deepEqual(tree(f.codeProject),before);
 }
});

test('regression input budget: feedback 12MiB and other arguments 1MiB keep separate hard bounds including exact framing',async t=>{
 const f=await fixture(t),before=tree(f.codeProject),overFeedback={...f.reviewFeedback,oversize:'x'.repeat(12*MiB-size(f.reviewFeedback)+8)};
 assert(size(overFeedback)>12*MiB&&size({...f.options,reviewFeedback:overFeedback})<13*MiB);
 assert.throws(()=>createFixRegression({...f.options,reviewFeedback:overFeedback}),{code:'limit_exceeded'});
 assert.throws(()=>createFixRegression({...f.options,specsRoot:'x'.repeat(MiB+1)}),{code:'limit_exceeded'});
 const edgeFeedback={...f.reviewFeedback,oversize:''};edgeFeedback.oversize='x'.repeat(12*MiB-size(edgeFeedback));
 const {reviewFeedback,...parameters}=f.options,edgeParameters={...parameters,specsRoot:''};edgeParameters.specsRoot='x'.repeat(MiB-size(edgeParameters));
 assert.equal(size(edgeFeedback),12*MiB);assert.equal(size(edgeParameters),MiB);
 const edgeOptions={...edgeParameters,reviewFeedback:edgeFeedback};assert.equal(size(edgeOptions),13*MiB+Buffer.byteLength(',"reviewFeedback":'));
 // Deliberately invalid feedback still must reach its original validator within the exact framing bound.
 assert.throws(()=>inspectFixRepairReview(edgeFeedback,f.identity),{code:'invalid_input'});
 assert.throws(()=>createFixRegression(edgeOptions),{code:'invalid_input'});assert.deepEqual(tree(f.codeProject),before);
});

test('regression input budget: plain shape and accessor rejection never invoke user getters',async t=>{
 const f=await fixture(t),before=tree(f.codeProject);let getters=0;
 const options={...f.options};Object.defineProperty(options,'reviewFeedback',{enumerable:true,get(){getters++;throw Error('top getter must not run');}});
 assert.throws(()=>createFixRegression(options),{code:'invalid_input'});
 const feedback={...f.reviewFeedback};Object.defineProperty(feedback,'registration',{enumerable:true,get(){getters++;throw Error('nested getter must not run');}});
 assert.throws(()=>createFixRegression({...f.options,reviewFeedback:feedback}),{code:'invalid_input'});
 assert.throws(()=>createFixRegression(Object.assign(Object.create({foreign:true}),f.options)),{code:'invalid_input'});
 assert.throws(()=>createFixRegression({...f.options,arbitrary:true}),{code:'invalid_input'});assert.equal(getters,0);assert.deepEqual(tree(f.codeProject),before);
});

test('regression input budget: no-feedback legacy retains original construction, real run and ordinary 1MiB limit',async t=>{
 const f=await fixture(t,{paddingBytes:8}),{reviewFeedback,...rest}=f.options,options={...rest,identity:f.firstIdentity},before=tree(f.codeProject),run=createFixRegression(options);
 assert.deepEqual(tree(f.codeProject),before);const result=await run({identity:f.firstIdentity},{authorized:true,signal:f.signal});assert.equal(result.status,'passed');assert.equal(result.completionEligible,false);assert.deepEqual(tree(f.codeProject),before);
 assert.throws(()=>createFixRegression({...options,specsRoot:'x'.repeat(MiB+1)}),{code:'limit_exceeded'});
});
