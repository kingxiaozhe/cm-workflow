import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {reviewResult} from '../runtime/js/cm-ai/review-runner.mjs';

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
