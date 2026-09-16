import test from 'node:test';
import assert from 'node:assert/strict';
import {ROLE_ROUTING,selectRuntime,candidateOrder,describeSelection,isRuntime,
  RuntimeFailoverError} from '../runtime/js/cm-ai/runtime-failover.mjs';

const all=()=>true, none=()=>false, only=(runtime)=>(candidate)=>candidate===runtime;

test('角色主从表：开发主 codex，审查主 claude，且主备互异',()=>{
  assert.equal(ROLE_ROUTING.developer.primary,'codex');
  assert.equal(ROLE_ROUTING.developer.standby,'claude');
  assert.equal(ROLE_ROUTING.reviewer.primary,'claude');
  assert.equal(ROLE_ROUTING.reviewer.standby,'codex');
  for(const {primary,standby} of Object.values(ROLE_ROUTING)){
    assert.ok(isRuntime(primary)&&isRuntime(standby));
    assert.notEqual(primary,standby);
  }
});

test('路由表被冻结，调用方不能就地改写主从',()=>{
  assert.throws(()=>{ROLE_ROUTING.developer={primary:'claude',standby:'codex'};},TypeError);
  assert.throws(()=>{ROLE_ROUTING.reviewer.primary='codex';},TypeError);
});

test('候选顺序：显式请求优先，另一端永远兜底',()=>{
  assert.deepEqual(candidateOrder('developer'),['codex','claude']);
  assert.deepEqual(candidateOrder('reviewer'),['claude','codex']);
  assert.deepEqual(candidateOrder('reviewer','codex'),['codex','claude']);
  assert.deepEqual(candidateOrder('developer','claude'),['claude','codex']);
});

test('两端都可用时不切换，且如实标记 switched=false',()=>{
  const dev=selectRuntime({role:'developer',probe:all});
  assert.equal(dev.runtime,'codex');assert.equal(dev.switched,false);assert.equal(dev.reason,null);
  const review=selectRuntime({role:'reviewer',probe:all});
  assert.equal(review.runtime,'claude');assert.equal(review.switched,false);
});

test('主端不可达时切到备端并带上切换原因',()=>{
  const review=selectRuntime({role:'reviewer',probe:only('codex')});
  assert.equal(review.runtime,'codex');
  assert.equal(review.switched,true);
  assert.equal(review.from,'claude');
  assert.match(review.reason,/claude unreachable/);
  assert.deepEqual(review.rejected,[{runtime:'claude',reason:'unreachable'}]);
});

test('显式请求的运行时不可用时，切换以请求端为起点',()=>{
  const dev=selectRuntime({role:'developer',requested:'claude',probe:only('codex')});
  assert.equal(dev.runtime,'codex');assert.equal(dev.from,'claude');assert.equal(dev.switched,true);
});

test('allowed 收窄时不越界选路（protected 模式只允许 codex）',()=>{
  const review=selectRuntime({role:'reviewer',allowed:['codex'],probe:all});
  assert.equal(review.runtime,'codex');
  assert.equal(review.switched,true);
  assert.deepEqual(review.rejected,[{runtime:'claude',reason:'not_allowed'}]);
});

test('两端都不可用时抛错，绝不返回不可用的运行时',()=>{
  assert.throws(()=>selectRuntime({role:'developer',probe:none}),
    (error)=>error instanceof RuntimeFailoverError&&error.code==='no_runtime_available'
      &&/codex=unreachable/.test(error.message)&&/claude=unreachable/.test(error.message));
});

test('allowed 排除主端且备端不可达时同样阻塞',()=>{
  assert.throws(()=>selectRuntime({role:'reviewer',allowed:['codex'],probe:none}),
    /no runtime available for reviewer/);
});

test('非法输入被拒绝而不是回退到默认值',()=>{
  assert.throws(()=>selectRuntime({role:'qa',probe:all}),/unknown failover role/);
  assert.throws(()=>selectRuntime({role:'developer',requested:'gemini',probe:all}),/unsupported runtime/);
  assert.throws(()=>selectRuntime({role:'developer',probe:null}),/probe must be a function/);
  assert.throws(()=>selectRuntime({role:'developer',probe:()=>'yes'}),/probe must return a boolean/);
  assert.throws(()=>selectRuntime({role:'developer',allowed:[],probe:all}),/non-empty list/);
  assert.throws(()=>selectRuntime({role:'developer',allowed:['gemini'],probe:all}),/non-empty list/);
});

test('切换必须可读地播报，不能静默',()=>{
  assert.equal(describeSelection(selectRuntime({role:'developer',probe:all})),
    'developer: codex（未切换）');
  assert.equal(describeSelection(selectRuntime({role:'reviewer',probe:only('codex')})),
    'reviewer: claude → codex（原因: claude unreachable）');
});

test('探测只调用到选中候选为止，不做多余探测',()=>{
  const seen=[];
  selectRuntime({role:'developer',probe:(runtime)=>{seen.push(runtime);return true;}});
  assert.deepEqual(seen,['codex']);
});

// --- host 接线 ---
import {main as hostMain} from './cm-ai-host.mjs';

function runHost(argv){
  const chunks=[];
  const sink={write:(text)=>{chunks.push(text);return true;}};
  return hostMain(argv,{input:process.stdin,output:sink,error:sink})
    .then(code=>({code,text:chunks.join('')}));
}

const base=['serve','--config','/nonexistent.json','--mode','create',
  '--host-context','h1','--allow-development'];

test('--failover 与 --protected-config 互斥（protected 只支持 codex，无备端可选）',async()=>{
  const {code,text}=await runHost([...base,'--failover','--protected-config','/nonexistent2.json']);
  assert.equal(code,1);
  assert.match(text,/failover_unsupported_in_protected_mode/);
});

test('--failover 是布尔开关，不吞掉后面的参数',async()=>{
  // --allow-qa 未配 workflow.qa 时必须报 invalid_arguments；若 --failover 把它
  // 当成取值吞掉，这条检查就不会触发，测试随之失败。
  const {code,text}=await runHost([...base,'--failover','--allow-qa']);
  assert.equal(code,1);
  assert.match(text,/invalid_arguments/);
  assert.doesNotMatch(text,/failover_unsupported/);
});

test('不传 --failover 时不进入选路，既有行为不变',async()=>{
  const {code,text}=await runHost([...base,'--protected-config','/nonexistent2.json']);
  assert.equal(code,1);
  assert.doesNotMatch(text,/failover/);
});

test('未知参数仍被拒绝，--failover 没有放宽参数白名单',async()=>{
  const {code,text}=await runHost([...base,'--failover-now']);
  assert.equal(code,1);
  assert.match(text,/invalid_arguments/);
});
