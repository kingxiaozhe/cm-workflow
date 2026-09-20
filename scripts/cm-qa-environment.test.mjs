import test from 'node:test';
import assert from 'node:assert/strict';
import {QA_ENVIRONMENT_CARRIERS,QA_ENVIRONMENT_SCOPES,isQaEnvironmentCarrier} from '../runtime/js/cm-ai/qa-environment.mjs';

test('carrier table covers every cm-prd delivery form plus backend, CLI and library projects',()=>{
  // cm-prd confirms Web / iOS / Android / 小程序 / 桌面 / 多端 with the user, and
  // separately recognises projects with no deployment form (local tools, libraries).
  assert.deepEqual(Object.keys(QA_ENVIRONMENT_CARRIERS).sort(),
    ['app','desktop','library','miniprogram','service','web']);
  for(const [kind,carrier] of [['web','browser'],['app','ios-simulator'],['app','android-emulator'],
    ['app','device'],['miniprogram','wechat-devtools'],['miniprogram','device'],
    ['desktop','app-window'],['service','cli'],['service','http-api'],['library','none']]){
    assert.equal(isQaEnvironmentCarrier(kind,carrier),true,`${kind}/${carrier}`);
  }
});

test('carriers stay bound to their own kind and unknown values are rejected',()=>{
  for(const [kind,carrier] of [['service','browser'],['library','cli'],['desktop','device'],
    ['web','app-window'],['backend','cli'],['service','shell'],['','']]){
    assert.equal(isQaEnvironmentCarrier(kind,carrier),false,`${kind}/${carrier}`);
  }
  assert.equal(isQaEnvironmentCarrier('__proto__','cli'),false);
  assert.deepEqual([...QA_ENVIRONMENT_SCOPES],['local','test']);
});

test('the shared table is frozen so one consumer cannot mutate it for the others',()=>{
  assert.throws(()=>{QA_ENVIRONMENT_CARRIERS.service=['anything'];},TypeError);
  assert.throws(()=>{QA_ENVIRONMENT_CARRIERS.web.push('app-window');},TypeError);
  assert.equal(isQaEnvironmentCarrier('web','app-window'),false);
});
