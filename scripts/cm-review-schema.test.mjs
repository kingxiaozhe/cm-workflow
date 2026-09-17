import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {reviewResult,reviewPaths,allowedFindingPaths,reviewReceipt} from '../runtime/js/cm-ai/review-runner.mjs';
import {digest} from '../runtime/js/cm-ai/contracts.mjs';
import {checkCompletion} from '../runtime/js/cm-ai/gate-bridge.mjs';

test('provider schema avoids unsupported uniqueness keyword; local gate rejects duplicate or missing paths',()=>{
  const schema=JSON.parse(fs.readFileSync(new URL('../runtime/js/cm-ai/review-result.schema.json',import.meta.url),'utf8'));
  assert.equal(Object.hasOwn(schema.properties.examinedPaths,'uniqueItems'),false);
  const pkg={packageDigest:'a'.repeat(64),changes:[{path:'code.mjs'}],requirements:[{path:'requirements.md'}]};
  const result={verdict:'approved',packageDigest:pkg.packageDigest,examinedPaths:['code.mjs','requirements.md'],findings:[],summary:'Reviewed both files'};
  assert.equal(reviewResult(result,pkg).verdict,'approved');
  for(const examinedPaths of [['code.mjs','code.mjs','requirements.md'],['code.mjs'],['code.mjs','requirements.md','other.mjs']]){
    assert.throws(()=>reviewResult({...result,examinedPaths},pkg),/missing_material/);
  }
});

test('unchanged scope joins exact examined paths and permitted findings without duplicating requirements',()=>{
  const pkg={packageDigest:'a'.repeat(64),changes:[{path:'code.mjs'}],requirements:[{path:'requirements.md'}],
    unchangedScope:[{path:'AGENTS.md',sha256:'b'.repeat(64)},{path:'requirements.md',sha256:'c'.repeat(64)}]};
  const paths=['AGENTS.md','code.mjs','requirements.md'];
  assert.deepEqual(reviewPaths(pkg),paths);assert.deepEqual(allowedFindingPaths(pkg),paths);
  const result={verdict:'approved',packageDigest:pkg.packageDigest,examinedPaths:paths,
    findings:[{id:'F1',severity:'P3',path:'AGENTS.md',message:'Unchanged instruction fingerprint recorded',
      evidence:'Only a hash is supplied; no content claim or requested edit'}],summary:'Synthetic review'};
  assert.deepEqual(reviewResult(result,pkg),result);
  assert.throws(()=>reviewResult({...result,examinedPaths:paths.slice(1)},pkg),{code:'missing_material'});
  assert.throws(()=>reviewResult({...result,findings:[{...result.findings[0],path:'outside.md'}]},pkg),{code:'invalid_finding_path'});
  const {unchangedScope,...legacy}=pkg;
  assert.deepEqual(reviewPaths(legacy),paths.slice(1));
  assert.throws(()=>reviewResult({...result,examinedPaths:paths.slice(1)},legacy),{code:'invalid_finding_path'});
});

test('legacy review receipt uses the original digest and path set without unchanged scope',()=>{
  const pkg={packageDigest:'a'.repeat(64),baseIdentity:'b'.repeat(64),artifactDigest:'c'.repeat(64),
    requirementsDigest:'d'.repeat(64),checksDigest:'e'.repeat(64),scope:['AGENTS.md','code.mjs'],
    identity:{repositoryId:'fixture',runId:'legacy',taskId:'T-001',attempt:1},checks:[{outcome:'passed',exitCode:0}],
    changes:[{path:'code.mjs'}],requirements:[{path:'requirements.md'}]};
  const result={verdict:'approved',packageDigest:pkg.packageDigest,examinedPaths:['code.mjs','requirements.md'],
    findings:[],summary:'Legacy review'};
  const request={identity:{repositoryId:'fixture',runId:'legacy',taskId:'T-001',attempt:1},requestDigest:'f'.repeat(64)};
  const call={invocationId:'legacy-review',started:true,terminal:'succeeded',requestDigest:request.requestDigest,
    resultDigest:digest(result),provider:'claude',contextId:'reviewer',requestedModel:'fixture',effectiveModel:'fixture',channel:'fixture'};
  const receipt=reviewReceipt({request,call,result,reviewPackage:pkg,developerProvider:'codex',fallbackReasons:[]});
  assert.equal(receipt.packageDigest,pkg.packageDigest);assert.deepEqual(receipt.result,result);
  const {receiptDigest,...body}=receipt;assert.equal(receiptDigest,digest(body));
  assert.equal(checkCompletion({receipt,registered:receipt,execution:call,reviewPackage:pkg,identity:pkg.identity}).outcome,'eligible');
});
