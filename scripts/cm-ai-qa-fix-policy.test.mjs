import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {recordCmAiQaDecision,recordCmAiQaRun} from '../runtime/js/cm-ai/cm-ai-qa-log.mjs';
import {readHostQaFixHandoff} from '../runtime/js/cm-ai/host-qa-fix.mjs';

// policies.auto_fix 决定 QA 失败之后往哪走，模板把三个取值都写给用户看
// （explicit | never | auto），但 never 从来没有测试走过——docs/untested-branches.md
// 的 A 类第一条。这里把整张真值表钉死，包括「轮次耗尽压过策略」这条优先级：
// 那正是只测了一两个取值时最容易写反的地方。
function fixture(t,{autoFix=null,rounds=1}={}){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'qa-fix-policy-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const specsDir=path.join(root,'specs'),codeProject=path.join(root,'code'),logHome=path.join(root,'logs');
  fs.mkdirSync(path.join(specsDir,'.reviews'),{recursive:true});fs.mkdirSync(codeProject);
  // 不写配置文件时走 loadConfig 的缺省，这本身也是一条要覆盖的路径。
  if(autoFix!==null)fs.writeFileSync(path.join(codeProject,'.cm-workflow.json'),
    JSON.stringify({version:1,policies:{auto_fix:autoFix}}));
  const identity={repositoryId:'qa-policy',runId:'qa-policy-run',taskId:'T-001',attempt:2};
  const binding={specsDir,codeProject,feature:'1.work',identity,packageDigest:'a'.repeat(64)};
  const report=path.join(specsDir,'.reviews','qa-failure.md');
  fs.writeFileSync(report,'Synthetic QA FAIL');
  recordCmAiQaDecision({...binding,logHome,decision:{decisionId:'qa-decision',identity,
    packageDigest:binding.packageDigest,status:'triggered',reason:'fixture',score:null,at:'2026-09-08T01:00:00Z'}});
  const qa={...binding,mode:'commands',caseCount:1,logHome};
  let testRunId;
  for(let round=1;round<=rounds;round++){
    testRunId=`qa-round-${round}`;
    const step={...qa,testRunId,...(round>1?{qaRound:round}:{})};
    recordCmAiQaRun({...step,phase:'start'});
    recordCmAiQaRun({...step,phase:'complete',result:{result:'FAIL',passed:0,failed:1,blocked:0,report}});
  }
  return {binding,testRunId};
}
const handoffFor=(t,options)=>{
  const {binding,testRunId}=fixture(t,options);
  return readHostQaFixHandoff({...binding,testRunId});
};

test('every auto_fix value routes a QA failure to its own outcome',t=>{
  // 三个取值各自对应一种去向：never 直接堵死，explicit 要人点头，auto 才派发。
  for(const [autoFix,status,reason] of [
    ['never','blocked','auto_fix_disabled'],
    ['explicit','authorization_required','fix_authorization_required'],
    ['auto','dispatch_required','fix_dispatch_required']]){
    const handoff=handoffFor(t,{autoFix});
    assert.equal(handoff.policy,autoFix);
    assert.equal(handoff.status,status,autoFix);
    assert.equal(handoff.reason,reason,autoFix);
    // 无论哪种去向，交接本身都不是派发凭据。
    assert.equal(handoff.execution,'not_started',autoFix);
  }
});

test('the round limit overrides the policy, including the two that would otherwise proceed',t=>{
  // 第三轮之后无论策略是什么都堵死，而且理由要说是轮次耗尽，不是策略。
  // never 本来就 blocked，容易掩盖这条优先级，所以三个取值都验。
  for(const autoFix of ['never','explicit','auto']){
    const handoff=handoffFor(t,{autoFix,rounds:3});
    assert.equal(handoff.status,'blocked',autoFix);
    assert.equal(handoff.reason,'qa_round_limit',autoFix);
    assert.equal(handoff.policy,autoFix,'被限流不代表把策略改写掉');
  }
});

test('an unreadable auto_fix value is refused instead of being treated as one of the three',t=>{
  assert.throws(()=>handoffFor(t,{autoFix:'sometimes'}),error=>
    // 配置校验先拦下来也算通过：要的是「不会被当成三者之一放行」。
    error.code==='qa_fix_policy_unavailable'||/auto_fix/.test(String(error.message)));
});

test('the default configuration still resolves to one of the three outcomes',t=>{
  // 项目没写 .cm-workflow.json 时也必须落在契约内，不能是 undefined 或崩掉。
  const handoff=handoffFor(t,{autoFix:null});
  assert.ok(['never','explicit','auto'].includes(handoff.policy));
  assert.ok(['blocked','authorization_required','dispatch_required'].includes(handoff.status));
});
