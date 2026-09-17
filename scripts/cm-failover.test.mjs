import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {main,inspectSpecs,parseTasks,classifyBreakpoint,probeRuntimes,
  ROLE_ROUTING,FailoverError} from './cm-failover.mjs';

function sandbox(){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-failover-')));
  test.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  return root;
}

function feature(root,name,tasks){
  const dir=path.join(root,name);
  fs.mkdirSync(path.join(dir,'.reviews'),{recursive:true});
  fs.writeFileSync(path.join(dir,'tasks.md'),
    `# ${name}\n\n${tasks.map(t=>`- [${t.done?'x':' '}] ${t.id}: ${t.title}`).join('\n')}\n`);
  return dir;
}

function handoff(dir,name,task,attempt,payload){
  fs.writeFileSync(path.join(dir,'.reviews',`${name}-${task}-a${attempt}-handoff.json`),
    JSON.stringify({schema_version:1,task_id:task,attempt,status:'ready_for_review',
      changed_files:['src/a.ts'],implementation_sha256:'a'.repeat(64),
      verification:[{command:'npm test',status:'passed',evidence:'ok'}],
      evidence:['log'],blockers:[],scope_deviation:[],...payload}));
}

function review(dir,name,task,attempt,verdict){
  fs.writeFileSync(path.join(dir,'.reviews',`${name}-${task}-r${attempt}.md`),
    `---\nverdict: ${verdict}\nindependent: true\nscope:\n  - src/a.ts\n---\n\n审查正文。\n`);
}

test('parseTasks 读取勾选状态并拒绝重复任务号',()=>{
  const tasks=parseTasks('- [x] T-001: 建基线\n闲话\n- [ ] T-002: 接入检查\n');
  assert.deepEqual(tasks.map(t=>[t.id,t.done,t.title]),
    [['T-001',true,'建基线'],['T-002',false,'接入检查']]);
  assert.throws(()=>parseTasks('- [ ] T-1: a\n- [ ] T-1: b\n'),FailoverError);
  assert.throws(()=>parseTasks('# 没有任务行\n'),FailoverError);
});

test('全角冒号与大写 X 同样被识别',()=>{
  const tasks=parseTasks('- [X] T-001：全角标题\n');
  assert.deepEqual(tasks,[{id:'T-001',done:true,title:'全角标题'}]);
});

test('断点分类穷举每条分支',()=>{
  const task={id:'T-001',done:false,title:'t'};
  assert.equal(classifyBreakpoint({...task,done:true},[]).node,'N5');
  assert.equal(classifyBreakpoint(task,[]).state,'not_started');
  assert.equal(classifyBreakpoint(task,[{attempt:1,handoff:null,verdict:'approved'}]).state,
    'review_without_handoff');
  assert.equal(classifyBreakpoint(task,
    [{attempt:1,handoff:{status:'blocked',blockers:['x'],scopeDeviation:[]},verdict:null}]).state,'blocked');
  const awaiting=classifyBreakpoint(task,
    [{attempt:1,handoff:{status:'ready_for_review',changedFiles:['a'],contentBound:true},verdict:null}]);
  assert.equal(awaiting.node,'N4');assert.equal(awaiting.state,'awaiting_review');
  assert.equal(classifyBreakpoint(task,
    [{attempt:1,handoff:{status:'ready_for_review'},verdict:'approved'}]).node,'N5');
  const retry=classifyBreakpoint(task,
    [{attempt:1,handoff:{status:'ready_for_review'},verdict:'changes_requested'}]);
  assert.equal(retry.node,'N3');assert.equal(retry.attempt,2);
  assert.equal(classifyBreakpoint(task,
    [{attempt:2,handoff:{status:'ready_for_review'},verdict:'changes_requested'}]).state,'changes_exhausted');
  assert.equal(classifyBreakpoint(task,
    [{attempt:1,handoff:{status:'ready_for_review'},verdict:'blocked'}]).state,'review_blocked');
  assert.equal(classifyBreakpoint(task,
    [{attempt:1,handoff:{status:'ready_for_review'},verdict:'weird'}]).state,'unknown_verdict');
});

test('inspectSpecs 定位第一个未完成任务的断点',()=>{
  const root=sandbox();
  const dir=feature(root,'1.demo',[{id:'T-001',title:'a',done:true},{id:'T-002',title:'b',done:false}]);
  handoff(dir,'1.demo','T-002',1,{});
  const report=inspectSpecs(root);
  assert.equal(report.features.length,1);
  const only=report.features[0];
  assert.equal(only.done,1);assert.equal(only.total,2);
  assert.equal(only.currentTask.id,'T-002');
  assert.equal(only.breakpoint.node,'N4');
  assert.equal(only.breakpoint.contentBound,true);
});

test('直接指向 feature 目录与指向 specs 根等价',()=>{
  const root=sandbox();
  const dir=feature(root,'1.demo',[{id:'T-001',title:'a',done:false}]);
  assert.equal(inspectSpecs(dir).features[0].feature,'1.demo');
  assert.equal(inspectSpecs(root).features[0].feature,'1.demo');
});

test('全部完成后断点推进到 QA',()=>{
  const root=sandbox();
  feature(root,'1.demo',[{id:'T-001',title:'a',done:true}]);
  assert.equal(inspectSpecs(root).features[0].breakpoint.node,'N6');
});

test('blocked 交接把阻塞项带进简报',()=>{
  const root=sandbox();
  const dir=feature(root,'1.demo',[{id:'T-001',title:'a',done:false}]);
  handoff(dir,'1.demo','T-001',1,{status:'blocked',blockers:['缺少测试夹具'],
    verification:[{command:'npm test',status:'failed',evidence:'red'}]});
  const {text}=main(['handoff','--specs',root,'--to','codex']);
  assert.match(text,/缺少测试夹具/);
  assert.match(text,/N3（blocked）/);
});

test('第二次审查通过后断点是 N5 而非重复审查',()=>{
  const root=sandbox();
  const dir=feature(root,'1.demo',[{id:'T-001',title:'a',done:false}]);
  handoff(dir,'1.demo','T-001',1,{});review(dir,'1.demo','T-001',1,'changes_requested');
  handoff(dir,'1.demo','T-001',2,{attempt:2});review(dir,'1.demo','T-001',2,'approved');
  assert.equal(inspectSpecs(root).features[0].breakpoint.node,'N5');
});

test('简报声明接管约束且不冒充完成授权',()=>{
  const root=sandbox();
  feature(root,'1.demo',[{id:'T-001',title:'a',done:false}]);
  const {text}=main(['handoff','--specs',root,'--to','claude']);
  assert.match(text,/不是完成授权/);
  assert.match(text,/独立审查不得由实现者本人完成/);
  assert.match(text,/developer: 主 codex \/ 备 claude/);
  assert.match(text,/reviewer: 主 claude \/ 备 codex/);
});

test('角色主从与 runtime 契约一致',()=>{
  assert.equal(ROLE_ROUTING.developer.primary,'codex');
  assert.equal(ROLE_ROUTING.reviewer.primary,'claude');
  for(const {primary,standby} of Object.values(ROLE_ROUTING))assert.notEqual(primary,standby);
});

test('工具全程只读，不改写 tasks.md',()=>{
  const root=sandbox();
  const dir=feature(root,'1.demo',[{id:'T-001',title:'a',done:false}]);
  const tasksPath=path.join(dir,'tasks.md');
  const before=fs.readFileSync(tasksPath,'utf8');
  const entries=fs.readdirSync(path.join(dir,'.reviews'));
  main(['status','--specs',root]);main(['handoff','--specs',root,'--to','codex']);
  main(['status','--specs',root,'--json']);
  assert.equal(fs.readFileSync(tasksPath,'utf8'),before);
  assert.deepEqual(fs.readdirSync(path.join(dir,'.reviews')),entries);
});

test('拒绝 symlink 形式的 tasks.md',()=>{
  const root=sandbox();
  const real=path.join(root,'real.md');fs.writeFileSync(real,'- [ ] T-001: a\n');
  const dir=path.join(root,'1.demo');fs.mkdirSync(dir);
  fs.symlinkSync(real,path.join(dir,'tasks.md'));
  assert.throws(()=>inspectSpecs(dir),/must not be a symlink/);
});

test('损坏的交接证据报错而不是静默跳过',()=>{
  const root=sandbox();
  const dir=feature(root,'1.demo',[{id:'T-001',title:'a',done:false}]);
  fs.writeFileSync(path.join(dir,'.reviews','1.demo-T-001-a1-handoff.json'),'{不是 JSON');
  assert.throws(()=>inspectSpecs(root),/not valid JSON/);
});

test('未知状态的交接证据被拒绝',()=>{
  const root=sandbox();
  const dir=feature(root,'1.demo',[{id:'T-001',title:'a',done:false}]);
  handoff(dir,'1.demo','T-001',1,{status:'done'});
  assert.throws(()=>inspectSpecs(root),/unknown status/);
});

test('probe 只报告可解析性并明说不等于配额可用',()=>{
  const results=probeRuntimes(['codex','claude'],
    {run:(command)=>command==='codex'?{ok:true,detail:'codex 1.0'}:{ok:false,detail:'ENOENT'}});
  assert.deepEqual(results,[{runtime:'codex',available:true,detail:'codex 1.0'},
    {runtime:'claude',available:false,detail:'ENOENT'}]);
  const {text}=main(['probe']);
  assert.match(text,/可解析 != 配额可用/);
});

test('CLI 参数校验',()=>{
  const root=sandbox();
  feature(root,'1.demo',[{id:'T-001',title:'a',done:false}]);
  assert.throws(()=>main(['status']),/--specs is required/);
  assert.throws(()=>main(['handoff','--specs',root,'--to','gemini']),/must be codex or claude/);
  assert.throws(()=>main(['bogus','--specs',root]),/unknown command/);
  assert.throws(()=>main(['status','--specs']),/missing value/);
  assert.match(main(['--help']).text,/只读/);
});
