import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import * as verification from '../runtime/js/cm-fix/review-verification.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';

const supported=process.platform==='darwin';
const nativeTypes=supported&&Number(process.versions.node.split('.')[0])>=24;
const sha=value=>createHash('sha256').update(value).digest('hex');
const diagnosticKeys=['version','requestDigest','packageDigest','profileDigest','providerThreadId','phase','code',
  'checkId','exitCode','outcome','outputSha256','runtimeFailure'].sort();
const privateMarker='SYNTHETIC_PRIVATE_OUTPUT_DO_NOT_PERSIST';
function fixture(t,{typeImport=false}={}){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-verification-diagnostic-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const implementation=typeImport?'definitions.ts':'value.mjs',checkFile=typeImport?'consumer.ts':'value.test.mjs';
  fs.writeFileSync(path.join(root,implementation),typeImport?'export type Marker=number;export const value=1;\n':'export const value=1;\n');
  fs.writeFileSync(path.join(root,checkFile),typeImport?
    "import {Marker,value} from './definitions.ts';const typed:Marker=value;export {typed};\n":
    "import {value} from './value.mjs';if(value!==1)process.exit(1);\n");
  const config={files:[implementation,checkFile],checks:[{id:'unit',command:[process.execPath,
    ...(typeImport?['--experimental-strip-types']:[]),checkFile]}],mutationPaths:[implementation],timeoutMs:5000};
  const files=config.files.map(p=>({path:p,sha256:sha(fs.readFileSync(path.join(root,p))),mode:fs.statSync(path.join(root,p)).mode&511}));
  const reviewPackage={packageDigest:'b'.repeat(64),files};
  const request={requestDigest:'a'.repeat(64),provider:'claude',payload:{reviewPackage}};
  return {root,config,request,implementation,reviewPackage};
}
function open(f){return verification.createReviewVerificationSession({codeProject:f.root,configuration:f.config,request:f.request});}
function finishFailure(s){
  let error;try{s.finish('fresh-review-thread');}catch(caught){error=caught;}
  assert(error,'missing verification evidence must not become approval');
  assert.equal(error.code,'review_verification_evidence','historical generic code stays compatible');
  const diagnostic=s.diagnostic('fresh-review-thread',error,'finish');
  assert.deepEqual(error.verificationDiagnostic,diagnostic);
  return {error,diagnostic};
}
function assertBound(d,f){
  assert.deepEqual(Object.keys(d).sort(),diagnosticKeys);
  assert.equal(d.version,1);assert.equal(d.requestDigest,f.request.requestDigest);
  assert.equal(d.packageDigest,f.reviewPackage.packageDigest);assert.equal(d.profileDigest,digest(f.config));
  assert.equal(d.providerThreadId,'fresh-review-thread');
  assert(!JSON.stringify(d).includes(f.root));assert(!JSON.stringify(d).includes(privateMarker));
}

test('Node type-only export failure keeps a bound check diagnostic after session cleanup',{skip:!nativeTypes},async t=>{
  const f=fixture(t,{typeImport:true}),s=open(f);let saved;
  try{
    const check=await s.call('run_check',{id:'unit'});
    assert.equal(check.outcome,'failed');assert.equal(check.exitCode,1);
    assert.match(check.output,/does not provide an export named 'Marker'/);
    const {diagnostic:d}=finishFailure(s);assertBound(d,f);
    assert.equal(d.phase,'check');assert.equal(d.code,'review_verification_check_failed');
    assert.equal(d.runtimeFailure,'module_export_missing');assert.equal(d.checkId,'unit');
    assert.equal(d.exitCode,1);assert.equal(d.outcome,'failed');assert.equal(d.outputSha256,sha(check.output));
    saved=JSON.stringify(d);
  }finally{await s.close();}
  assert.equal(fs.existsSync(s.cwd),false);
  assert.equal(JSON.parse(saved).runtimeFailure,'module_export_missing');
});
test('successful checks without a mutation report the precise missing step',{skip:!supported},async t=>{
  const f=fixture(t),s=open(f);try{
    assert.equal((await s.call('run_check',{id:'unit'})).outcome,'passed');
    const {diagnostic:d}=finishFailure(s);assertBound(d,f);
    assert.equal(d.phase,'finish');assert.equal(d.code,'review_verification_mutation_missing');
    assert.equal(d.runtimeFailure,null);
  }finally{await s.close();}
});
for(const restoreFailed of [false,true]){
  test(restoreFailed?'restoration check failure cannot be hidden as missing mutation':'surviving mutation reports its own failure with no private output',
    {skip:!supported},async t=>{
      const f=fixture(t),s=open(f);let calls=0;
      try{
        const tools=verification.createVerificationTools({...JSON.parse(fs.readFileSync(s.configPath,'utf8')),
          runCommand:async()=>{
            const i=calls++,failed=restoreFailed&&i>0;
            return {exitCode:failed?1:0,outcome:failed?'failed':'passed',code:null,output:privateMarker};
          }});
        const result=await tools.call('mutate_check',{path:f.implementation,find:'value=1',replace:'value=2',checkId:'unit'});
        assert.equal(result.killed,false);assert.equal(calls,3);
        const {diagnostic:d}=finishFailure(s);assertBound(d,f);
        assert.equal(d.code,restoreFailed?'review_verification_restore_failed':'review_verification_mutation_survived');
        assert.equal(d.phase,restoreFailed?'restore':'mutation');assert.equal(d.checkId,'unit');
        assert.equal(d.exitCode,restoreFailed?1:0);assert.equal(d.outputSha256,sha(privateMarker));
        assert(!fs.readFileSync(path.join(path.dirname(s.cwd),'evidence.json'),'utf8').includes(privateMarker));
        for(const name of fs.readdirSync(path.dirname(s.cwd)).filter(p=>p.includes('diagnostic')))
          assert(!fs.readFileSync(path.join(path.dirname(s.cwd),name),'utf8').includes(privateMarker));
        assert.equal(fs.readFileSync(path.join(f.root,f.implementation),'utf8'),'export const value=1;\n');
      }finally{await s.close();}
    });
}
test('baseline-only verification succeeds without requiring or inventing a mutation',{skip:!supported},async t=>{
  const f=fixture(t),before=sha(fs.readFileSync(path.join(f.root,f.implementation)));
  const result=await verification.verifyReviewVerificationBaseline({codeProject:f.root,configuration:f.config,reviewPackage:f.reviewPackage});
  assert.equal(result.files.length,f.config.files.length);assert.equal(result.snapshotDigest,digest(result.files));
  assert.equal(result.checks.length,1);assert.equal(result.checks[0].id,'unit');assert.equal(result.checks[0].exitCode,0);
  assert.equal(sha(fs.readFileSync(path.join(f.root,f.implementation))),before);
});
test('baseline-only verification refuses an incompatible frozen check with safe diagnostics',{skip:!nativeTypes},async t=>{
  const f=fixture(t,{typeImport:true});
  await assert.rejects(verification.verifyReviewVerificationBaseline({codeProject:f.root,configuration:f.config,reviewPackage:f.reviewPackage}),error=>{
    const d=error.verificationDiagnostic;
    assert(d);assert.equal(d.phase,'check');assert.equal(d.code,'review_verification_check_failed');
    assert.equal(d.runtimeFailure,'module_export_missing');assert.equal(d.providerThreadId,null);
    assert.equal(d.packageDigest,f.reviewPackage.packageDigest);assert.equal(d.profileDigest,digest(f.config));
    assert.equal(d.exitCode,1);assert.equal(d.outcome,'failed');assert.match(d.outputSha256,/^[a-f0-9]{64}$/);
    assert(!JSON.stringify(d).includes(f.root));assert(!Object.hasOwn(d,'output'));return true;
  });
});
for(const drift of [false,true]){
  test(drift?'source drift outranks a recovered check failure':'a recovered check failure does not hide a missing mutation',
    {skip:!supported},async t=>{
      const f=fixture(t),s=open(f);let calls=0;
      try{
        const tools=verification.createVerificationTools({...JSON.parse(fs.readFileSync(s.configPath,'utf8')),
          runCommand:async()=>{
            const failed=calls++===0;
            return {exitCode:failed?1:0,outcome:failed?'failed':'passed',code:null,output:failed?privateMarker:'passed'};
          }});
        assert.equal((await tools.call('run_check',{id:'unit'})).outcome,'failed');
        assert.equal((await tools.call('run_check',{id:'unit'})).outcome,'passed');
        if(drift)fs.writeFileSync(path.join(f.root,f.implementation),'export const value=2;\n');
        let error;try{s.finish('fresh-review-thread');}catch(caught){error=caught;}
        assert(error);assert.equal(error.code,drift?'review_verification_source_drift':'review_verification_evidence');
        const d=s.diagnostic('fresh-review-thread',error,'finish');assertBound(d,f);
        assert.deepEqual(error.verificationDiagnostic,d);
        assert.equal(d.code,drift?'review_verification_source_drift':'review_verification_mutation_missing');
        assert.equal(d.phase,'finish');assert.equal(d.exitCode,null);assert.equal(d.outputSha256,null);
      }finally{await s.close();}
    });
}
test('baseline package binding failure carries a safe snapshot diagnostic',{skip:!supported},async t=>{
  const f=fixture(t),reviewPackage=structuredClone(f.reviewPackage);
  reviewPackage.files[0].sha256='f'.repeat(64);
  await assert.rejects(verification.verifyReviewVerificationBaseline({codeProject:f.root,configuration:f.config,reviewPackage}),error=>{
    assert.equal(error.code,'review_verification_package_binding');
    const d=error.verificationDiagnostic;assert(d);assert.deepEqual(Object.keys(d).sort(),diagnosticKeys);
    assert.equal(d.code,'review_verification_package_binding');assert.equal(d.phase,'snapshot');
    assert.equal(d.packageDigest,reviewPackage.packageDigest);assert.equal(d.profileDigest,digest(f.config));
    assert.match(d.requestDigest,/^[a-f0-9]{64}$/);assert.equal(d.providerThreadId,null);
    assert.equal(d.outputSha256,null);assert.equal(d.runtimeFailure,null);
    assert(!JSON.stringify(d).includes(f.root));assert(!Object.hasOwn(d,'output'));return true;
  });
});
test('unavailable check preserves its bounded timeout reason',{skip:!supported},async t=>{
  const f=fixture(t),s=open(f);
  try{
    const tools=verification.createVerificationTools({...JSON.parse(fs.readFileSync(s.configPath,'utf8')),
      runCommand:async()=>({exitCode:null,outcome:'unavailable',code:'verification_timeout',output:privateMarker})});
    assert.equal((await tools.call('run_check',{id:'unit'})).outcome,'unavailable');
    const {diagnostic:d}=finishFailure(s);assertBound(d,f);
    assert.equal(d.phase,'check');assert.equal(d.code,'verification_timeout');assert.equal(d.checkId,'unit');
    assert.equal(d.outcome,'unavailable');assert.equal(d.exitCode,null);assert.equal(d.outputSha256,sha(privateMarker));
  }finally{await s.close();}
});
for(const prior of ['worker','mutation']){
  test(`resolved ${prior} diagnostic does not hide a different missing check`,{skip:!supported},async t=>{
    const f=fixture(t);
    f.config.checks.push({id:'other',command:[process.execPath,'-e','process.exit(0)']});
    if(prior==='mutation')f.config.checks.push({id:'missing',command:[process.execPath,'-e','process.exit(0)']});
    const s=open(f);let calls=0;
    try{
      const tools=verification.createVerificationTools({...JSON.parse(fs.readFileSync(s.configPath,'utf8')),
        runCommand:async()=>{
          const exitCode=calls++===(prior==='worker'?2:4)?1:0;
          return {exitCode,outcome:exitCode?'failed':'passed',code:null,output:'bounded output'};
        }});
      const mutation=checkId=>tools.call('mutate_check',{path:f.implementation,find:'value=1',replace:'value=2',checkId});
      if(prior==='worker'){
        await assert.rejects(tools.call('mutate_check',{path:f.implementation,find:'absent-token',replace:'replacement',checkId:'unit'}),{code:'review_verification_mutation'});
        assert.equal((await tools.call('run_check',{id:'unit'})).outcome,'passed');
        assert.equal((await mutation('unit')).killed,true);
      }else{
        assert.equal((await mutation('unit')).killed,false);
        assert.equal((await mutation('other')).killed,true);
      }
      const {diagnostic:d}=finishFailure(s);assertBound(d,f);
      assert.equal(d.code,'review_verification_check_missing');assert.equal(d.phase,'finish');
    }finally{await s.close();}
  });
}
for(const target of ['source','copy']){
  test(`${target} drift outranks a still-unresolved failed check`,{skip:!supported},async t=>{
    const f=fixture(t),s=open(f);
    try{
      const tools=verification.createVerificationTools({...JSON.parse(fs.readFileSync(s.configPath,'utf8')),
        runCommand:async()=>({exitCode:1,outcome:'failed',code:null,output:privateMarker})});
      assert.equal((await tools.call('run_check',{id:'unit'})).outcome,'failed');
      fs.writeFileSync(path.join(target==='source'?f.root:s.cwd,f.implementation),'export const value=2;\n');
      assert.throws(()=>s.finish('fresh-review-thread'),error=>{
        assert.equal(error.code,`review_verification_${target}_drift`);
        assertBound(error.verificationDiagnostic,f);
        assert.equal(error.verificationDiagnostic.code,error.code);
        assert.equal(error.verificationDiagnostic.phase,'finish');return true;
      });
    }finally{await s.close();}
  });
}
