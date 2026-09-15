import test from 'node:test';
import assert from 'node:assert/strict';
import {createFixHost} from '../runtime/js/cm-fix/host.mjs';

test('continuous fix keeps individual action authorization',async()=>{
  let repairs=0;
  const owner={status:()=>({stage:'repair_required'}),repair:({authorized})=>{
    repairs++;assert.equal(authorized,false);throw Object.assign(Error('No repair grant'),{code:'fix_repair_authorization_required'});
  }};
  const host=createFixHost({owner,config:{},permissions:['--allow-reproduction']});
  await assert.rejects(host.run('sequence'),{code:'fix_repair_authorization_required'});
  assert.equal(repairs,1);
});

test('continuous fix stops at unchanged or blocked stage',async()=>{
  let redTests=0;
  const status={stage:'red_test_required'};
  const host=createFixHost({owner:{status:()=>status,runRedTest:({authorized})=>{
    assert.equal(authorized,true);redTests++;return status;
  }},config:{},permissions:['--allow-reproduction','--allow-red-test']});
  assert.deepEqual(await host.run('sequence'),status);assert.equal(redTests,1);
  for(const stage of ['unknown','cancelled','observation','final_review_changes_requested','revision_prepared']){
    const blocked=createFixHost({owner:{status:()=>({stage})},config:{},permissions:['--allow-reproduction']});
    assert.deepEqual(await blocked.run('sequence'),{stage});
  }
});
