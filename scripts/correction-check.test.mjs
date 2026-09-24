import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {correctionCheckStore} from '../runtime/js/cm-prd/correction-check.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';

function fixture(run) {
  const specs=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-prd-correction-check-')));
  fs.mkdirSync(path.join(specs,'.reviews'));
  try {
    const options={specs,feature:'1.guide',packageDigest:digest('package'),inputDigest:digest('input')};
    return run(options);
  } finally { fs.rmSync(specs,{recursive:true,force:true}); }
}

for (const outcome of ['mechanical_failed','context_result']) {
  test(`correctionCheckStore records and reopens ${outcome} with exact result`,()=>fixture(options=>{
    const store=correctionCheckStore(options);
    assert.deepEqual(store.inspect(),{status:'not_started',result:null});
    assert.deepEqual(store.claim(),{status:'claimed',result:null});
    const evidence={checks:[{id:'unit',status:outcome==='mechanical_failed'?'failed':'passed'}],note:'synthetic'};
    const recorded=store.record(outcome,evidence);
    assert.equal(recorded.status,'recorded');
    assert.equal(recorded.result.outcome,outcome);
    assert.deepEqual(recorded.result.result,evidence);
    assert.deepEqual(correctionCheckStore(options).inspect(),recorded);
    assert.throws(()=>store.record(outcome,evidence),{code:'prd_check_not_pending'});
  }));
}

test('correctionCheckStore rejects an undeclared outcome without writing a result',()=>fixture(options=>{
  const store=correctionCheckStore(options);
  store.claim();
  assert.throws(()=>store.record('unlisted_result',{note:'synthetic'}),{code:'prd_check_record_invalid'});
  assert.equal(store.inspect().status,'unknown');
}));
