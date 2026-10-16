import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import nodeModule,{syncBuiltinESMExports} from 'node:module';
import {captureReviewBaseline,readReviewSourceFiles} from '../runtime/js/cm-ai/review-package.mjs';
import {verifyFixRepair} from '../runtime/js/cm-fix/repair.mjs';
import {createTestTypeCorrection} from '../runtime/js/cm-fix/test-type-correction.mjs';
import {createFixHost} from '../runtime/js/cm-fix/host.mjs';

function fixture(t,count){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'type-proof-cost-'))),codeProject=path.join(root,'code'),specsRoot=path.join(root,'specs');
 fs.mkdirSync(codeProject);fs.mkdirSync(specsRoot);t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 fs.writeFileSync(path.join(codeProject,'value.mjs'),'export const value=1;');
 const file='layers.spec.ts',source='const rows: { props: { style?: object } }[] = [];\nconst layers = rows.map(n => n.props.style);\n';
 fs.writeFileSync(path.join(codeProject,file),source);
 for(let i=0;i<count;i++)fs.writeFileSync(path.join(codeProject,`outside-${i}.txt`),`unchanged ${i}`);
 const identity={repositoryId:'fixture',runId:'proof-cost',taskId:'T-FIX-cost',attempt:1};
 const capture=()=>captureReviewBaseline({root:codeProject,specsRoot,identity,scope:['value.mjs'],requirements:['value.mjs']});
 const baseline=capture(),[before]=readReviewSourceFiles(codeProject,[file]);
 const correction=createTestTypeCorrection({file:before,declaration:{kind:'callback-type-annotation',path:file,beforeSha256:before.sha256,line:2,parameter:'n',annotation:'{ props: { style?: object } }'}});
 fs.writeFileSync(path.join(codeProject,file),Buffer.from(correction.after.contentBase64,'base64'));
 fs.writeFileSync(path.join(codeProject,'value.mjs'),'export const value=2;');
 const files=capture().files.filter(f=>f.path==='value.mjs').map(({contentBase64,...metadata})=>metadata);
 return {codeProject,specsRoot,baseline,result:{outcome:'repaired',baselineDigest:baseline.baselineDigest,changedFiles:['value.mjs'],files,completionEligible:false},testTypeCorrection:correction};
}
function countStrips(run){
 const original=nodeModule.stripTypeScriptTypes;let calls=0;
 nodeModule.stripTypeScriptTypes=(...args)=>{calls++;return original(...args);};syncBuiltinESMExports();
 try{run();return calls;}finally{nodeModule.stripTypeScriptTypes=original;syncBuiltinESMExports();}
}

test('repair proof validates once per verification irrespective of unrelated inventory size',t=>{
 const small=fixture(t,0),large=fixture(t,160);
 assert.ok(large.baseline.files.length-small.baseline.files.length>=160);
 const counts=[small,large].map(options=>countStrips(()=>verifyFixRepair(options)));
 assert.deepEqual(counts,[3,3],'one proof has three exact Node stripping checks; unrelated files must not multiply proof validation');
 assert.equal(countStrips(()=>verifyFixRepair(large)),3,'a new verification revalidates the proof; no cross-call cache');
});

test('bounded proof cost keeps current disk drift and altered-proof rejection',t=>{
 const options=fixture(t,64);
 assert.equal(countStrips(()=>verifyFixRepair(options)),3);
 const target=path.join(options.codeProject,'outside-0.txt');fs.writeFileSync(target,'unexpected unrelated change');
 assert.throws(()=>verifyFixRepair(options),{code:'out_of_scope'});
 fs.writeFileSync(target,'unchanged 0');
 const c=structuredClone(options.testTypeCorrection);c.emitSha256='f'.repeat(64);
 assert.throws(()=>verifyFixRepair({...options,testTypeCorrection:c}));
 fs.appendFileSync(path.join(options.codeProject,options.testTypeCorrection.path),'// unapproved test drift');
 assert.throws(()=>verifyFixRepair(options),{code:'out_of_scope'});
});

test('final review handler reads one stage snapshot and yields before granting, retaining later owner verification',async()=>{
 let statuses=0,packages=0,decisions=0,reviews=0,immediateRan=false;
 const pkg={identity:{repositoryId:'fixture',runId:'host-cost',taskId:'T-FIX-cost',attempt:1},packageDigest:'a'.repeat(64)};
 const owner={status(){statuses++;return {stage:'final_review_required'};},finalReviewPackage(){packages++;return pkg;},reviewFinal(options){reviews++;assert.deepEqual(options,{verificationRecoveryAuthorization:null});return {stage:'final_review_evidence_required'};}};
 const authority={hostDecisionProvider:{async decide(binding){decisions++;assert.deepEqual(binding,{identity:pkg.identity,packageDigest:pkg.packageDigest});assert.equal(immediateRan,true,'event-loop work queued before the handler must run before a grant');}}};
 const host=createFixHost({owner,config:{},finalAuthority:authority});
 setImmediate(()=>{immediateRan=true;});
 const pending=host.handle({requestId:'final',operation:'final_review'});
 const decisionsBeforeYield=decisions;
 assert.equal((await pending).stage,'final_review_evidence_required');
 assert.equal(decisionsBeforeYield,0,'no grant is issued in the initial synchronous projection interval');
 assert.equal(statuses,1);assert.equal(packages,1);assert.equal(decisions,1);assert.equal(reviews,1);
});
