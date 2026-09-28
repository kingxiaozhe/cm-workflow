import test from 'node:test';
import assert from 'node:assert/strict';
import {planCheckTimeout} from '../runtime/js/cm-ai/drive-core.mjs';

test('D1 driver check timeout defaults to 15 minutes and item override wins',()=>{
  assert.equal(planCheckTimeout({}),900000);
  assert.equal(planCheckTimeout({checkTimeoutMs:70000}),70000);
  assert.equal(planCheckTimeout({checkTimeoutMs:1000},{timeoutMs:65000}),65000);
  assert.equal(planCheckTimeout({},{timeoutMs:3600000}),3600000);
});

test('D1 driver rejects invalid plan and item timeouts before dispatch',()=>{
  for(const value of [0,3600001,1.5,null,'65000']){
    assert.throws(()=>planCheckTimeout({checkTimeoutMs:value}),/checkTimeoutMs/);
    assert.throws(()=>planCheckTimeout({},{timeoutMs:value}),/timeoutMs/);
  }
});
