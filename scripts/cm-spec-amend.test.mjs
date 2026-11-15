// Fixtures for tiered spec re-approval: each tier-1 condition has a counterexample
// that must fall back to tier 2 (user "开始"), and tier 1 only applies with a
// review verdict bound to the exact delta.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {approveCmAiSpecs} from '../runtime/js/cm-ai/cm-ai-admission.mjs';
import {applySpecAmendment,withApprovalLock} from '../runtime/js/cm-ai/spec-amendment.mjs';

// The round ledger lives under CM_WORKFLOW_HOME; never touch the real home.
const isolatedHome=fs.mkdtempSync(path.join(os.tmpdir(),'cm-spec-amend-home-'));
process.env.CM_WORKFLOW_HOME=isolatedHome;
process.on('exit',()=>fs.rmSync(isolatedHome,{recursive:true,force:true}));
const admission=fileURLToPath(new URL('./cm-ai-admission.mjs',import.meta.url));
const amend=fileURLToPath(new URL('./cm-spec-amend.mjs',import.meta.url));

const TASKS=`# 登录 — 任务清单

## 任务版本
| 日期 | 版本 | 说明 |
| --- | --- | --- |
| 2026-11-01 | v1 | 初始 |

## 任务列表
- [ ] T-001: 登录页
  - 范围: \`src/login.js\`
  - 验收: AC-001
- [ ] T-002: 登录接口
  - 范围: \`src/api.js\`
  - 验证: 断言错误密码返回 401
  - 验收: AC-002
- T-002 依赖 T-001
`;
const CASES={schemaVersion:'1.0',feature:'login',cases:[{id:'TC-001',origin:'user',kind:'logic',blocking:true,
  acIds:['AC-002'],taskIds:['T-002'],title:'错误密码被拒',preconditions:[],steps:['提交错误密码'],expected:['返回 401'],cleanup:[]}]};

function fixture(run,{cases=false}={}){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-spec-amend-')));
  const specs=path.join(root,'specs'),code=path.join(root,'code'),feature=path.join(specs,'1.login');
  fs.mkdirSync(feature,{recursive:true});fs.mkdirSync(code);fs.writeFileSync(path.join(code,'README.md'),'existing\n');
  fs.writeFileSync(path.join(feature,'requirements.md'),'# 需求\n\n- [AC-001] 显示登录页\n- [AC-002] 错误密码被拒\n');
  fs.writeFileSync(path.join(feature,'design.md'),'# 设计\n\n模块 1：登录页。\n');
  fs.writeFileSync(path.join(feature,'tasks.md'),TASKS);
  if(cases)fs.writeFileSync(path.join(feature,'test-cases.json'),JSON.stringify(CASES,null,2)+'\n');
  fs.writeFileSync(path.join(specs,'.cm-specs-status'),JSON.stringify({status:'awaiting_review',features:['1.login'],testCases:[]}));
  const file=name=>path.join(feature,name);
  const edit=(name,change)=>fs.writeFileSync(file(name),change(fs.readFileSync(file(name),'utf8')));
  const cli=(entry,args)=>{
    const result=spawnSync(process.execPath,[entry,...args],{encoding:'utf8'});
    return {status:result.status,stderr:result.stderr,json:result.stdout.trim()?JSON.parse(result.stdout.trim().split('\n').at(-1)):null};
  };
  const approve=(extra=[])=>cli(admission,['--specs-dir',specs,'--code-project',code,'--approve','--approval-response','开始',...extra]);
  const inspect=()=>cli(amend,['inspect','--specs-dir',specs]).json;
  const admit=()=>cli(admission,['--specs-dir',specs,'--code-project',code]).json;
  const review=(digest,verdict='approved')=>{
    const target=path.join(root,`review-${Math.random().toString(16).slice(2)}.txt`);
    fs.writeFileSync(target,`审查过程……\n{"cmSpecAmendReview":1,"deltaDigest":"${digest}","verdict":"${verdict}","findings":[]}\n`);
    return target;
  };
  const apply=(args)=>cli(amend,['apply','--specs-dir',specs,'--reason','补正',...args]);
  try{return run({root,specs,code,edit,approve,inspect,admit,review,apply,cli});}
  finally{fs.rmSync(root,{recursive:true,force:true});}
}

const addTask=text=>text.replace('- T-002 依赖 T-001','- [ ] T-003: 修复错误密码提示\n  - 范围: `src/api.js`\n  - 验收: AC-002\n- T-002 依赖 T-001');

test('approval writes a reviewed snapshot; --no-spec-amend records policy off',()=>{
  fixture(({specs,approve})=>{
    const result=approve();assert.equal(result.status,0,result.stderr);
    assert.deepEqual(result.json.specAmend,{policy:'reviewed',files:3,snapshot:'written'});
    const snapshot=JSON.parse(fs.readFileSync(path.join(specs,'.cm-specs-approved.json'),'utf8'));
    assert.equal(snapshot.approval.response,'开始');assert.deepEqual(snapshot.amendments,[]);
  });
  fixture(({approve})=>{assert.equal(approve(['--no-spec-amend']).json.specAmend.policy,'off');});
});

test('unchanged specs report nothing to re-bind',()=>fixture(({approve,inspect})=>{
  approve();const result=inspect();assert.equal(result.tier,null);assert.deepEqual(result.changedFiles,[]);
}));

test('tier 0: appended version row re-binds without review or a new 开始',()=>fixture(({approve,inspect,apply,admit,edit})=>{
  approve();
  edit('tasks.md',text=>text.replace('| 2026-11-01 | v1 | 初始 |','| 2026-11-01 | v1 | 初始 |\n| 2026-11-04 | v2 | 记录口头同意 |'));
  assert.equal(admit().reason,'spec_drift');
  assert.equal(inspect().tier,0);
  const applied=apply([]);assert.equal(applied.status,0,JSON.stringify(applied.json));
  assert.equal(admit().state,'ready');
}));

// Port review #2: re-binding keeps the grammar the approval bound (2 here), never the newest constant.
test('tier 0 re-bind keeps the approved task grammar',()=>fixture(({specs,approve,inspect,apply,edit})=>{
  approve();
  const grammar=()=>JSON.parse(fs.readFileSync(path.join(specs,'.cm-specs-status'),'utf8')).taskGrammar;
  assert.equal(grammar(),2);
  edit('tasks.md',text=>text.replace('| 2026-11-01 | v1 | 初始 |','| 2026-11-01 | v1 | 初始 |\n| 2026-11-04 | v2 | 记录口头同意 |'));
  assert.equal(inspect().tier,0);
  assert.equal(apply([]).status,0);
  assert.equal(grammar(),2);
}));

// Port review #1: a version note that weakens an existing task's acceptance is a requirement change.
test('version row changing an existing task acceptance is tier 2, other acceptance wording goes to review',()=>{
  fixture(({approve,inspect,apply,edit})=>{
    approve();
    edit('tasks.md',text=>text.replace('| 2026-11-01 | v1 | 初始 |','| 2026-11-01 | v1 | 初始 |\n| 2026-11-04 | v2 | T-002 验收要求变更：TC-001 可忽略 |'));
    const result=inspect();
    assert.equal(result.tier,2);assert(result.reasons.includes('version_row_changes_acceptance:1.login/T-002'),JSON.stringify(result.reasons));
    assert.equal(apply([]).status,1);
  });
  fixture(({approve,inspect,edit})=>{
    approve();
    edit('tasks.md',text=>text.replace('| 2026-11-01 | v1 | 初始 |','| 2026-11-01 | v1 | 初始 |\n| 2026-11-04 | v2 | AC-002 改为真机验收 |'));
    assert.equal(inspect().tier,1);
  });
  // Codex review: full-width ids, named AC/TC ids without keywords and unnamed weakening
  // notes never stay tier 0.
  for(const [note,tier] of [['Ｔ-００２ 验收改为只测成功路径',2],['T－002 验收改为只测成功路径',2],
    ['ＡＣ－００２ 验收改为可忽略',1],['AC-002：错误密码由阻断改成提示',1],['TC-001 的断言由 401 调整到 200',1],
    ['验收改为只测成功路径',1],['T-001 文案微调',1],
    // Codex review r2: wording outside any weakening list, English, increases and split ids.
    ['降低验收门槛：错误密码返回 200 也通过',1],['放宽断言：允许任意状态码',1],['只需成功登录',1],['仅测成功路径',1],
    ['跳过错误密码测试',1],['Skip negative tests; accept any HTTP status',1],['加强验收：新增错误密码检查',1],
    ['范围不变，跳过错误密码测试',1],['行为与验收不变',0],['检查与断言不放宽',0],['补记沟通，无其他改动',0]])
    fixture(({approve,inspect,edit})=>{
      approve();
      edit('tasks.md',text=>text.replace('| 2026-11-01 | v1 | 初始 |',`| 2026-11-01 | v1 | 初始 |\n| 2026-11-04 | v2 | ${note} |`));
      assert.equal(inspect().tier,tier,note);
    });
  // Dogfood (aihot specs7 copy): "范围与验收不变" is how real version rows record an
  // unchanged scope; without a task, AC or test-case id it stays tier 0.
  fixture(({approve,inspect,edit})=>{
    approve();
    edit('tasks.md',text=>text.replace('| 2026-11-01 | v1 | 初始 |','| 2026-11-01 | v1 | 初始 |\n| 2026-11-04 | v2 | 补记沟通，范围与验收不变 |'));
    assert.equal(inspect().tier,0);
  });
});

test('tier 0 does not cover edits to an existing version row',()=>fixture(({approve,inspect,edit})=>{
  approve();edit('tasks.md',text=>text.replace('| 初始 |','| 初始（改写） |'));
  assert.equal(inspect().tier,1);
}));

test('tier 1: new task on an existing AC plus wider unfinished scope applies after a bound review',()=>fixture(({root,specs,approve,inspect,apply,admit,edit,review,cli})=>{
  approve();
  edit('tasks.md',text=>addTask(text).replace('  - 范围: `src/login.js`','  - 范围: `src/login.js`, `test/login.test.js`'));
  const inspected=inspect();
  assert.equal(inspected.tier,1,JSON.stringify(inspected));
  assert.deepEqual(inspected.changedTasks,['1.login/T-001']);assert.deepEqual(inspected.newTasks,['1.login/T-003']);
  assert.equal(apply([]).json.refused,'review_output_required');
  const out=path.join(root,'packet');
  const prepared=cli(amend,['prepare','--specs-dir',specs,'--out',out]);
  assert.equal(prepared.status,0,prepared.stderr);
  assert.ok(fs.existsSync(path.join(out,'before/1.login/tasks.md')));assert.ok(fs.existsSync(path.join(out,'after/1.login/tasks.md')));
  assert.match(fs.readFileSync(path.join(out,'review-prompt.md'),'utf8'),new RegExp(inspected.deltaDigest));
  assert.equal(apply(['--review-output',review(inspected.deltaDigest)]).json.refused,'reviewer_required');
  assert.equal(apply(['--review-output',review(inspected.deltaDigest,'changes_requested'),'--reviewer','codex']).json.refused,'review_not_approved');
  assert.equal(apply(['--review-output',review('0'.repeat(64)),'--reviewer','codex']).json.refused,'review_delta_mismatch');
  const applied=apply(['--review-output',review(inspected.deltaDigest),'--reviewer','codex gpt-6.1-sol high']);
  assert.equal(applied.status,0,JSON.stringify(applied.json));
  assert.equal(admit().state,'ready');
  const status=JSON.parse(fs.readFileSync(path.join(specs,'.cm-specs-status'),'utf8'));
  assert.equal(status.approval.response,'开始');
  const snapshot=JSON.parse(fs.readFileSync(path.join(specs,'.cm-specs-approved.json'),'utf8'));
  assert.equal(snapshot.amendments.length,1);assert.equal(snapshot.amendments[0].reviewer,'codex gpt-6.1-sol high');
  assert.equal(inspect().tier,null);
}));

test('a review bound to an earlier delta is refused after another edit',()=>fixture(({approve,inspect,apply,edit,review})=>{
  approve();edit('tasks.md',addTask);
  const digest=inspect().deltaDigest;
  edit('tasks.md',text=>text.replace('修复错误密码提示','修复错误密码提示与重试'));
  assert.equal(apply(['--review-output',review(digest),'--reviewer','codex']).json.refused,'review_delta_mismatch');
}));

test('tier 1 also re-binds after a cm-prd style reset to awaiting_review',()=>fixture(({specs,approve,inspect,apply,admit,edit,review})=>{
  approve();edit('tasks.md',addTask);
  const status=JSON.parse(fs.readFileSync(path.join(specs,'.cm-specs-status'),'utf8'));
  fs.writeFileSync(path.join(specs,'.cm-specs-status'),JSON.stringify({...status,status:'awaiting_review',approval:null}));
  assert.equal(admit().state,'awaiting_spec_approval');
  const inspected=inspect();assert.equal(inspected.tier,1);
  assert.equal(apply(['--review-output',review(inspected.deltaDigest),'--reviewer','codex']).status,0);
  assert.equal(admit().state,'ready');
}));

const HUMAN=[
  ['requirements changed','requirements.md',text=>text+'- [AC-003] 记住我\n',/^requirements_changed:/],
  ['design changed','design.md',text=>text+'模块 2：新增。\n',/^design_changed:/],
  ['task removed','tasks.md',text=>text.replace(/- \[ \] T-001[\s\S]*?验收: AC-001\n/,'').replace('- T-002 依赖 T-001\n',''),/^task_removed:/],
  ['task dropped','tasks.md',text=>text.replace('- [ ] T-001: 登录页','- [ ] ~~T-001: 登录页~~ `[DROPPED v2]`'),/^task_dropped:/],
  ['new task without acceptance','tasks.md',text=>text.replace('- T-002 依赖','- [ ] T-003: 顺手优化\n- T-002 依赖'),/^new_task_without_acceptance:/],
  ['new task with unknown acceptance','tasks.md',text=>text.replace('- T-002 依赖','- [ ] T-003: 新能力\n  - 验收: AC-009\n- T-002 依赖'),/^new_task_unknown_acceptance:/],
  ['new task already completed','tasks.md',text=>text.replace('- T-002 依赖','- [x] T-003: 已做\n  - 验收: AC-001\n- T-002 依赖'),/^new_task_completed:/],
  ['unfinished task loses its acceptance link','tasks.md',text=>text.replace('  - 验收: AC-002\n','  - 验收: 无\n'),/^task_acceptance_removed:/],
];
for(const [name,file,change,reason] of HUMAN){
  test(`tier 2: ${name}`,()=>fixture(({approve,inspect,apply,edit})=>{
    approve();edit(file,change);
    const result=inspect();assert.equal(result.tier,2,JSON.stringify(result));
    assert.ok(result.reasons.some(item=>reason.test(item)),JSON.stringify(result.reasons));
    assert.equal(apply([]).json.refused,'spec_amend_needs_human');
  }));
}

test('tier 2: a task completed after approval cannot be rewritten',()=>fixture(({approve,inspect,edit})=>{
  approve();edit('tasks.md',text=>text.replace('- [ ] T-001: 登录页','- [x] T-001: 登录页'));
  assert.equal(inspect().tier,null,'a runtime completion mark alone is not a spec change');
  edit('tasks.md',text=>text.replace('  - 范围: `src/login.js`','  - 范围: `src/login.js`, `src/extra.js`'));
  assert.ok(inspect().reasons.some(item=>item.startsWith('completed_task_changed:')));
}));

test('tier 2: existing test case changed or removed; added case stays tier 1',()=>{
  const edited=change=>fixture(({approve,inspect,edit})=>{approve();edit('test-cases.json',change);return inspect();},{cases:true});
  const modify=edited(text=>text.replace('返回 401','返回 4xx'));
  assert.equal(modify.tier,2);assert.ok(modify.reasons.some(item=>item.startsWith('test_case_changed:')));
  const remove=edited(text=>{const value=JSON.parse(text);value.cases=[];return JSON.stringify(value);});
  assert.equal(remove.tier,2);
  const header=edited(text=>{const value=JSON.parse(text);value.schemaVersion='1.1';return JSON.stringify(value);});
  assert.equal(header.tier,2);assert.ok(header.reasons.some(item=>item.startsWith('test_cases_changed:')));
  const add=edited(text=>{const value=JSON.parse(text);value.cases.push({...value.cases[0],id:'TC-002',origin:'generated',title:'锁定提示'});return JSON.stringify(value);});
  assert.equal(add.tier,1,JSON.stringify(add));
});

test('tier 2: new feature directory, policy off, missing or mismatched snapshot',()=>{
  fixture(({specs,approve,inspect})=>{
    approve();const feature=path.join(specs,'2.logout');fs.mkdirSync(feature);
    for(const file of ['requirements.md','design.md','tasks.md'])fs.copyFileSync(path.join(specs,'1.login',file),path.join(feature,file));
    assert.deepEqual(inspect().reasons,['feature_set_changed']);
  });
  fixture(({approve,inspect,edit})=>{approve(['--no-spec-amend']);edit('tasks.md',addTask);assert.deepEqual(inspect().reasons,['amend_policy_off']);});
  fixture(({specs,approve,inspect,edit})=>{
    approve();edit('tasks.md',addTask);fs.unlinkSync(path.join(specs,'.cm-specs-approved.json'));
    assert.deepEqual(inspect().reasons,['snapshot_missing']);
  });
  fixture(({specs,approve,inspect,edit})=>{
    approve();edit('tasks.md',addTask);
    const target=path.join(specs,'.cm-specs-approved.json'),snapshot=JSON.parse(fs.readFileSync(target,'utf8'));
    // A snapshot synced to the edited bytes by hand fails its own digest.
    snapshot.files=snapshot.files.map(item=>item.path.endsWith('tasks.md')?{...item,content:fs.readFileSync(path.join(specs,item.path),'utf8')}:item);
    fs.writeFileSync(target,JSON.stringify(snapshot));
    assert.deepEqual(inspect().reasons,['snapshot_invalid']);
  });
});

// Review r1 #5: after a cm-prd reset the status no longer anchors the snapshot;
// a hand-synced snapshot must still not turn a requirements change into tier 0.
test('awaiting_review: requirements change with a hand-synced snapshot stays tier 2',()=>fixture(({specs,approve,inspect,apply,edit})=>{
  approve();edit('requirements.md',text=>text.replace('错误密码被拒','错误密码可通过'));
  const status=path.join(specs,'.cm-specs-status');
  fs.writeFileSync(status,JSON.stringify({...JSON.parse(fs.readFileSync(status,'utf8')),status:'awaiting_review',approval:null}));
  const target=path.join(specs,'.cm-specs-approved.json'),snapshot=JSON.parse(fs.readFileSync(target,'utf8'));
  snapshot.files=snapshot.files.map(item=>({...item,content:fs.readFileSync(path.join(specs,item.path),'utf8')}));
  fs.writeFileSync(target,JSON.stringify(snapshot));
  assert.deepEqual(inspect().reasons,['snapshot_invalid']);
  assert.equal(apply([]).json.refused,'spec_amend_needs_human');
}));

// Review r1 #4: a snapshot from an earlier approval round never applies to a later one.
test('a previous round snapshot is rejected and a new approval removes it first',()=>fixture(({specs,approve,inspect,edit})=>{
  approve();
  const target=path.join(specs,'.cm-specs-approved.json'),roundOne=fs.readFileSync(target);
  const status=path.join(specs,'.cm-specs-status');
  fs.writeFileSync(status,JSON.stringify({...JSON.parse(fs.readFileSync(status,'utf8')),status:'awaiting_review',approval:null}));
  const second=approve(['--no-spec-amend']);assert.equal(second.json.specAmend.policy,'off');
  fs.writeFileSync(target,roundOne);
  edit('tasks.md',addTask);
  assert.deepEqual(inspect().reasons,['snapshot_round_mismatch']);
  fs.rmSync(target);fs.mkdirSync(target);fs.writeFileSync(path.join(target,'x'),'');
  fs.writeFileSync(status,JSON.stringify({...JSON.parse(fs.readFileSync(status,'utf8')),status:'awaiting_review',approval:null}));
  const blocked=approve();
  assert.equal(blocked.json.approveRefused,'spec_amend_snapshot_unremovable');
}));

// Review r1 #3: a blank line inside a finished task must not split off its verification.
test('tier 2: finished task verification after a blank line cannot be weakened',()=>fixture(({approve,inspect,edit})=>{
  edit('tasks.md',text=>text.replace('  - 范围: `src/login.js`\n','  - 范围: `src/login.js`\n\n  - 验证: 必须显示错误提示\n'));
  approve();
  edit('tasks.md',text=>text.replace('- [ ] T-001: 登录页','- [x] T-001: 登录页'));
  assert.equal(inspect().tier,null);
  edit('tasks.md',text=>text.replace('必须显示错误提示','可以不显示错误提示'));
  const result=inspect();
  assert.equal(result.tier,2,JSON.stringify(result));
  assert.ok(result.reasons.some(item=>item.startsWith('completed_task_changed:1.login/T-001')));
}));

// Review r1 #2: approval and re-binding are serialized by one lock.
test('apply refuses while another live process holds the approval lock; a stale lock is replaced',()=>fixture(({specs,approve,inspect,apply,edit,review})=>{
  approve();edit('tasks.md',addTask);
  const lock=path.join(specs,'.cm-specs-approval.lock'),digest=inspect().deltaDigest;
  fs.writeFileSync(lock,JSON.stringify({pid:process.pid,at:new Date().toISOString()}));
  const busy=apply(['--review-output',review(digest),'--reviewer','codex']);
  assert.equal(busy.status,1);assert.match(busy.stderr,/spec_approval_busy/);
  fs.writeFileSync(lock,JSON.stringify({pid:2147483646,at:new Date().toISOString()}));
  assert.equal(apply(['--review-output',review(digest),'--reviewer','codex']).status,0);
  assert.equal(fs.existsSync(lock),false);
}));

// Port review #3: only the reclaim-guard holder deletes another process's lock, so a
// concurrent reclaimer cannot empty the lock path under a live holder; a holder
// never releases a lock it does not own; a guard left by a crash blocks reclaim.
test('stale lock reclaim and release never remove another live owner\'s lock',()=>fixture(({specs})=>{
  const lock=path.join(specs,'.cm-specs-approval.lock'),guard=`${lock}.reclaim`;
  const live=JSON.stringify({pid:process.pid,nonce:'live-owner',at:new Date().toISOString()});
  const dead=JSON.stringify({pid:2147483646,nonce:'dead-owner',at:new Date().toISOString()});
  // Another reclaimer holds the guard: this one neither deletes nor enters.
  fs.writeFileSync(lock,dead);fs.writeFileSync(guard,'other reclaimer');let ran=false;
  assert.throws(()=>withApprovalLock(specs,()=>{ran=true;}),{code:'spec_approval_busy'});
  assert.equal(ran,false);assert.equal(fs.readFileSync(lock,'utf8'),dead);
  // That reclaimer finished and a live owner now holds the lock: still busy, lock untouched.
  fs.unlinkSync(guard);fs.writeFileSync(lock,live);
  assert.throws(()=>withApprovalLock(specs,()=>{ran=true;}),{code:'spec_approval_busy'});
  assert.equal(ran,false);assert.equal(fs.readFileSync(lock,'utf8'),live);assert.equal(fs.existsSync(guard),false);
  // A truly stale lock is reclaimed under the guard; the guard is released.
  fs.writeFileSync(lock,dead);
  withApprovalLock(specs,()=>{ran=true;assert.notEqual(fs.readFileSync(lock,'utf8'),dead);});
  assert.equal(ran,true);assert.equal(fs.existsSync(lock),false);assert.equal(fs.existsSync(guard),false);
  // Release: a lock replaced while held is left in place.
  withApprovalLock(specs,()=>{fs.writeFileSync(lock,live);});
  assert.equal(fs.readFileSync(lock,'utf8'),live);
  // Codex r3: a lock without a readable pid (e.g. a creator paused before writing it)
  // is never reclaimed by age, however old.
  for(const bytes of ['','not json',JSON.stringify({at:'2020-01-01T00:00:00.000Z'})]){
    fs.writeFileSync(lock,bytes);const old=new Date(Date.now()-3600_000);fs.utimesSync(lock,old,old);
    assert.throws(()=>withApprovalLock(specs,()=>{ran=true;}),{code:'spec_approval_busy'});
    assert.equal(fs.readFileSync(lock,'utf8'),bytes);
  }
  // Codex r4: between reading the lock and finding its pid dead, the holder released
  // and a new live holder took the lock. The reclaimer must not delete it or enter.
  {
    const deadPid=2147483645,next=JSON.stringify({pid:process.pid,nonce:'next-owner',at:new Date().toISOString()});
    fs.writeFileSync(lock,JSON.stringify({pid:deadPid,nonce:'released-owner',at:new Date().toISOString()}));
    const kill=process.kill;ran=false;
    process.kill=function(pid,signal){
      if(pid===deadPid){process.kill=kill;fs.unlinkSync(lock);fs.writeFileSync(lock,next);
        throw Object.assign(new Error('ESRCH'),{code:'ESRCH'});}
      return kill.call(this,pid,signal);
    };
    try{assert.throws(()=>withApprovalLock(specs,()=>{ran=true;}),{code:'spec_approval_busy'});}
    finally{process.kill=kill;}
    assert.equal(ran,false);assert.equal(fs.readFileSync(lock,'utf8'),next);assert.equal(fs.existsSync(guard),false);
  }
  // Codex r5: a temp-file cleanup failure after publishing must not leave the lock
  // (or the reclaim guard) behind; once the fault clears the lock is available again.
  for(const reclaim of [false,true]){
    if(reclaim)fs.writeFileSync(lock,JSON.stringify({pid:2147483644,nonce:'dead-for-guard',at:new Date().toISOString()}));
    else if(fs.existsSync(lock))fs.unlinkSync(lock);
    const unlink=fs.unlinkSync,watched=reclaim?`${guard}.`:`${lock}.`;let failed=false;ran=false;
    fs.unlinkSync=function(file,...rest){
      if(!failed&&String(file).startsWith(watched)&&String(file).endsWith('.tmp')&&(reclaim||!String(file).startsWith(`${guard}.`))){
        failed=true;throw Object.assign(new Error('EACCES'),{code:'EACCES'});}
      return unlink.call(this,file,...rest);
    };
    try{assert.throws(()=>withApprovalLock(specs,()=>{ran=true;}),{code:'EACCES'});}
    finally{fs.unlinkSync=unlink;}
    assert.equal(failed,true);assert.equal(ran,false);assert.equal(fs.existsSync(guard),false);
    if(!reclaim)assert.equal(fs.existsSync(lock),false);
    for(const name of fs.readdirSync(specs).filter(item=>item.endsWith('.tmp')))fs.unlinkSync(path.join(specs,name));
    withApprovalLock(specs,()=>{ran=true;});assert.equal(ran,true);assert.equal(fs.existsSync(lock),false);
  }
  // Codex r6: the lock is held by a live owner, so linking fails with EEXIST, and then the
  // temp-file cleanup fails too. The other owner's lock must stay exactly as it was.
  {
    fs.writeFileSync(lock,live);
    const unlink=fs.unlinkSync;let failed=false;ran=false;
    fs.unlinkSync=function(file,...rest){
      if(!failed&&String(file).startsWith(`${lock}.`)&&String(file).endsWith('.tmp')&&!String(file).startsWith(`${guard}.`)){
        failed=true;throw Object.assign(new Error('EACCES'),{code:'EACCES'});}
      return unlink.call(this,file,...rest);
    };
    try{assert.throws(()=>withApprovalLock(specs,()=>{ran=true;}),{code:'EACCES'});}
    finally{fs.unlinkSync=unlink;}
    assert.equal(failed,true);assert.equal(ran,false);
    assert.equal(fs.readFileSync(lock,'utf8'),live);assert.equal(fs.existsSync(guard),false);
    for(const name of fs.readdirSync(specs).filter(item=>item.endsWith('.tmp')))fs.unlinkSync(path.join(specs,name));
    fs.unlinkSync(lock);
  }
  // A lock is visible only with its holder's pid, at its publication: no temp files are left behind.
  assert.equal(fs.existsSync(lock),false);ran=false;
  const link=fs.linkSync;let published=null;
  fs.linkSync=function(from,to,...rest){const result=link.call(this,from,to,...rest);if(to===lock)published=fs.readFileSync(lock,'utf8');return result;};
  try{withApprovalLock(specs,()=>{ran=true;});}finally{fs.linkSync=link;}
  assert.equal(ran,true);assert.equal(JSON.parse(published).pid,process.pid);
  assert.deepEqual(fs.readdirSync(specs).filter(name=>name.startsWith('.cm-specs-approval.lock')),[]);
}));

// Review r1 #1: the packet holds the exact bytes the review digest covers.
test('prepare packet matches the classified bytes',()=>fixture(({root,specs,approve,inspect,edit,cli})=>{
  // A second, untouched feature must stay out of context/ (review: feature filter had no fixture).
  fs.cpSync(path.join(specs,'1.login'),path.join(specs,'2.signup'),{recursive:true});
  fs.writeFileSync(path.join(specs,'.cm-specs-status'),JSON.stringify({status:'awaiting_review',features:['1.login','2.signup'],testCases:[]}));
  approve();edit('tasks.md',addTask);
  const out=path.join(root,'packet'),prepared=cli(amend,['prepare','--specs-dir',specs,'--out',out]);
  assert.equal(prepared.json.deltaDigest,inspect().deltaDigest);
  assert.equal(fs.readFileSync(path.join(out,'after/1.login/tasks.md'),'utf8'),fs.readFileSync(path.join(specs,'1.login/tasks.md'),'utf8'));
  // Dogfood (wue v4): judging "does not change the approved design" needs the unchanged design.
  for(const name of ['requirements.md','design.md'])
    assert.equal(fs.readFileSync(path.join(out,'context/1.login',name),'utf8'),fs.readFileSync(path.join(specs,'1.login',name),'utf8'));
  assert.equal(fs.existsSync(path.join(out,'context/1.login/tasks.md')),false);
  assert.equal(fs.existsSync(path.join(out,'context/2.signup')),false);
  assert.match(fs.readFileSync(path.join(out,'review-prompt.md'),'utf8'),/context\/ 是涉及的 feature 里没有改动的规格文件/);
  assert.equal(cli(amend,['prepare','--specs-dir',specs,'--out',path.join(specs,'inside')]).status,1);
}));

test('tier 2 after 3 reviewed corrections; a new 开始 resets the count',()=>fixture(({specs,approve,inspect,apply,edit,review})=>{
  approve();
  for(let index=1;index<=3;index++){
    edit('tasks.md',text=>text.replace('- T-002 依赖',`- [ ] T-10${index}: 补修 ${index}\n  - 验收: AC-002\n- T-002 依赖`));
    const digest=inspect().deltaDigest;
    assert.equal(apply(['--review-output',review(digest),'--reviewer','codex']).status,0,`round ${index}`);
  }
  edit('tasks.md',text=>text.replace('- T-002 依赖','- [ ] T-104: 补修 4\n  - 验收: AC-002\n- T-002 依赖'));
  assert.deepEqual(inspect().reasons,['amend_limit_reached']);
  const status=path.join(specs,'.cm-specs-status');
  fs.writeFileSync(status,JSON.stringify({...JSON.parse(fs.readFileSync(status,'utf8')),status:'awaiting_review',approval:null}));
  assert.equal(approve().status,0);assert.equal(inspect().tier,null);
}));

// Review r2 #2: restoring an older, self-consistent snapshot after a cm-prd reset
// must not revive its policy; the round file names the current snapshot bytes.
test('awaiting_review: a restored earlier snapshot does not revive its policy',()=>fixture(({specs,approve,inspect,apply,edit,review})=>{
  approve();
  const target=path.join(specs,'.cm-specs-approved.json'),roundA=fs.readFileSync(target);
  const status=path.join(specs,'.cm-specs-status');
  const reset=()=>fs.writeFileSync(status,JSON.stringify({...JSON.parse(fs.readFileSync(status,'utf8')),status:'awaiting_review',approval:null}));
  reset();assert.equal(approve(['--no-spec-amend']).json.specAmend.policy,'off');
  reset();fs.writeFileSync(target,roundA);edit('tasks.md',addTask);
  const result=inspect();assert.equal(result.tier,2);assert.deepEqual(result.reasons,['snapshot_round_mismatch']);
  assert.equal(apply(['--review-output',review('0'.repeat(64)),'--reviewer','codex']).json.refused,'spec_amend_needs_human');
}));

// Review r2 #1: an approval decided before another approval landed is refused under the lock.
test('approval decided before a concurrent approval is refused and keeps the newer policy',()=>fixture(({specs,code,cli})=>{
  const outcome=approveCmAiSpecs({specsDir:specs,codeProject:code,codeProjects:[code],approvalResponse:'开始',
    _beforeApprovalLock:()=>{
      const other=cli(admission,['--specs-dir',specs,'--code-project',code,'--approve','--approval-response','开始','--no-spec-amend']);
      assert.equal(other.status,0,other.stderr);
    }});
  assert.equal(outcome.approveRefused,'spec_status_changed_during_approval');
  assert.equal(JSON.parse(fs.readFileSync(path.join(specs,'.cm-specs-approved.json'),'utf8')).policy,'off');
}));

// Review r3 #1: restoring both an older snapshot and an older ledger-free specs
// backup cannot revive a round the user has since replaced with --no-spec-amend.
test('awaiting_review: restoring an older specs backup does not revive its round',()=>fixture(({specs,approve,inspect,apply,edit})=>{
  approve();
  const target=path.join(specs,'.cm-specs-approved.json'),roundA=fs.readFileSync(target);
  const status=path.join(specs,'.cm-specs-status');
  const reset=()=>fs.writeFileSync(status,JSON.stringify({...JSON.parse(fs.readFileSync(status,'utf8')),status:'awaiting_review',approval:null}));
  reset();assert.equal(approve(['--no-spec-amend']).json.specAmend.policy,'off');
  reset();fs.writeFileSync(target,roundA);
  assert.deepEqual(inspect().reasons,['snapshot_round_mismatch']);
  assert.equal(apply([]).json.refused,'spec_amend_needs_human');
  edit('tasks.md',addTask);assert.equal(inspect().tier,2);
}));

// Review r3 #2: a failed snapshot write during apply leaves no valid round, even after a reset.
test('a failed apply snapshot write stays tier 2 after a cm-prd reset',()=>fixture(({specs,approve,inspect,edit,review})=>{
  approve();edit('tasks.md',addTask);
  const digest=inspect().deltaDigest,original=fs.renameSync;
  // Inject one failure into the snapshot's final rename, after status was written.
  fs.renameSync=(from,to)=>{
    if(String(to).endsWith('.cm-specs-approved.json')){fs.renameSync=original;throw Object.assign(new Error('EACCES'),{code:'EACCES'});}
    return original(from,to);
  };
  try{
    assert.throws(()=>applySpecAmendment(specs,{reason:'补正',reviewOutput:fs.readFileSync(review(digest),'utf8'),reviewer:'codex'}),/EACCES/);
  }finally{fs.renameSync=original;}
  const status=path.join(specs,'.cm-specs-status');
  assert.equal(JSON.parse(fs.readFileSync(status,'utf8')).status,'approved');
  assert.deepEqual(inspect().reasons,['snapshot_round_missing']);
  fs.writeFileSync(status,JSON.stringify({...JSON.parse(fs.readFileSync(status,'utf8')),status:'awaiting_review',approval:null}));
  edit('tasks.md',text=>text.replace('- T-002 依赖','- [ ] T-009: 再补\n  - 验收: AC-001\n- T-002 依赖'));
  assert.deepEqual(inspect().reasons,['snapshot_round_missing']);
}));

// A new approval voids the previous round before writing; if its own snapshot write
// then fails, restoring the previous round's snapshot must not revive that round.
test('a failed approval snapshot write leaves no round to restore',()=>fixture(({specs,code,approve,inspect,edit})=>{
  approve();
  const target=path.join(specs,'.cm-specs-approved.json'),roundA=fs.readFileSync(target);
  const status=path.join(specs,'.cm-specs-status');
  const reset=()=>fs.writeFileSync(status,JSON.stringify({...JSON.parse(fs.readFileSync(status,'utf8')),status:'awaiting_review',approval:null}));
  reset();
  const original=fs.renameSync;
  fs.renameSync=(from,to)=>{
    if(String(to).endsWith('.cm-specs-approved.json')){fs.renameSync=original;throw Object.assign(new Error('EACCES'),{code:'EACCES'});}
    return original(from,to);
  };
  let outcome;
  try{outcome=approveCmAiSpecs({specsDir:specs,codeProject:code,codeProjects:[code],approvalResponse:'开始',specAmend:false});}
  finally{fs.renameSync=original;}
  assert.equal(outcome.specAmend.snapshot,'failed');
  reset();fs.writeFileSync(target,roundA);edit('tasks.md',addTask);
  assert.deepEqual(inspect().reasons,['snapshot_round_missing']);
}));
