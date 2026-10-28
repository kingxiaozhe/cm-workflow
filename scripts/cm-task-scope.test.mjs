// Per-task file scope in tasks.md (runtime/js/task-scope.mjs): how it is parsed,
// what the split self-check requires (rule 3), and how a new batch uses it to
// decide which tasks may run in parallel.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {parseTaskScopes,declaredTaskScope,sameScope,validScopePath} from '../runtime/js/task-scope.mjs';
import {checkPrdDraftMechanics,PRD_SELF_CHECK_RULES} from '../runtime/js/cm-prd/self-check.mjs';
import {recordPrdTaskScopes,prdTaskScopeOptions,approvedScopeExemptions} from '../runtime/js/cm-prd/task-scope-record.mjs';
import {createHash} from 'node:crypto';
import {normalizeRuntimeMarkBytes} from './cm-spec-manifest.mjs';
import {spawnSync} from 'node:child_process';
import {createCmAiBatch} from './cm-ai-batch-run.mjs';
import {BATCH_SEGMENT_FIELD,batchSegment} from '../runtime/js/cm-ai/batch-location.mjs';

const tasksText=lines=>lines.join('\n')+'\n';

test('scope, tests and device sub-items attach to the task line above them',()=>{
  const {tasks,errors}=parseTaskScopes(tasksText(['## 任务列表','',
    '- [ ] T-001: logic','  - 范围: `src/a.js`, `test/a.test.js`','  - 测试文件: `test/a.test.js`',
    '- [ ] T-002: ui','    - scope: `index.html` `src/app.js`','    - device: required',
    '- [ ] T-003: no scope','','## 依赖关系','','- T-002 依赖 T-001']));
  assert.deepEqual(errors,[]);
  assert.deepEqual(tasks.get('T-001'),{scope:['src/a.js','test/a.test.js'],tests:['test/a.test.js'],device:false,line:4});
  assert.deepEqual(tasks.get('T-002'),{scope:['index.html','src/app.js'],tests:[],device:true,line:7});
  assert.equal(tasks.has('T-003'),false);
});

// Task grammar 3 (spec-task-line.mjs): `- 开发: 会话` has meaning only under an
// approval that bound grammar 3; 1 and 2 read the very same text exactly as before.
test('开发 sub-item: grammar 3 reads it, grammar 1 and 2 keep it prose',t=>{
  const text=tasksText(['- [ ] T-001: impl','  - 范围: `src/a.js`','  - 开发: 开发进程',
    '- [ ] T-002：walk','  - 范围: `docs/qa.md`','  - developer: session']);
  const three=parseTaskScopes(text,{grammar:3});
  assert.deepEqual(three.errors,[]);assert.deepEqual([...three.sessions],['T-002']);
  assert.deepEqual(three.tasks.get('T-002').scope,['docs/qa.md']);
  assert.deepEqual(parseTaskScopes(text).sessions,three.sessions,'grammar 3 is the default for drafts');
  // Grammar 2 keeps its own declaration grammar (the full-width colon is a task) and ignores 开发.
  const two=parseTaskScopes(text,{grammar:2});
  assert.deepEqual(two.errors,[]);assert.equal(two.sessions.size,0);assert.deepEqual([...two.tasks.keys()],['T-001','T-002']);
  // Grammar 1 is the pre-grammar parse: `T-002：` is prose, so its scope is a stray item.
  const one=parseTaskScopes(text,{grammar:1});
  assert.equal(one.sessions.size,0);assert.deepEqual([...one.tasks.keys()],['T-001']);
  assert.deepEqual(one.errors.map(item=>item.taskId),[null]);
  // A value other than 会话/session (or the written-out default) is refused only under grammar 3.
  for(const bad of ['  - 开发: 张三','  - 开发: 会话\n  - 开发: session']){
    const bytes=tasksText(['- [ ] T-001: a','  - 范围: `a.js`',bad]);
    assert.equal(parseTaskScopes(bytes,{grammar:3}).errors.length,1,bad);
    assert.deepEqual(parseTaskScopes(bytes,{grammar:2}).errors,[],bad);
  }
  assert.match(parseTaskScopes(tasksText(['- [ ] T-001: a','  - 范围: `a.js`','  - 开发: 张三']),{grammar:3}).errors[0].message,/会话/);
  // Not under any task: reported like a stray scope under 3, prose under 2; prose values stay prose.
  const stray=tasksText(['- [ ] T-001: a','  - 范围: `a.js`','','## 说明','- 开发: 会话','- 开发: 由前端组负责']);
  assert.deepEqual(parseTaskScopes(stray,{grammar:3}).errors.map(item=>item.taskId),[null]);
  assert.deepEqual(parseTaskScopes(stray,{grammar:2}).errors,[]);
  // 开发 does not count as a scope field: alone it leaves the task without scope, and 串行 may carry it.
  const alone=parseTaskScopes(tasksText(['- [ ] T-001: a','  - 开发: 会话','- [ ] T-002: b','  - 范围: 串行','  - 开发: 会话']),{grammar:3});
  assert.deepEqual(alone.errors,[]);assert.equal(alone.tasks.size,0);assert.deepEqual([...alone.serial],['T-002']);
  assert.deepEqual([...alone.sessions],['T-001','T-002']);
  // The runtime reads with the grammar the approval bound.
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-task-scope-grammar-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'1.work'));
  fs.writeFileSync(path.join(root,'1.work','tasks.md'),tasksText(['- [ ] T-001: a','  - 范围: `a.js`','  - 开发: 张三']));
  for(const [status,refused] of [[{status:'approved',taskGrammar:3},true],[{status:'approved',taskGrammar:2},false],
    [{status:'approved'},false],[{status:'awaiting_review',taskGrammar:3},false],[{status:'approved',taskGrammar:4},false]]){
    fs.writeFileSync(path.join(root,'.cm-specs-status'),JSON.stringify(status));
    if(refused)assert.throws(()=>declaredTaskScope(root,'1.work','T-001'),{code:'task_scope_invalid'});
    else assert.deepEqual(declaredTaskScope(root,'1.work','T-001').scope,['a.js'],JSON.stringify(status));
  }
});

test('only exact relative file paths in backticks are accepted',()=>{
  for(const bad of ['src/*.js','src/','/etc/passwd','../x.js','a/./b.js','a\\b.js','AGENTS.md','.git/config','x?.js'])
    assert.equal(validScopePath(bad),false,bad);
  for(const good of ['README.md','src/deep/file.test.mjs','docs/中文.md'])assert.equal(validScopePath(good),true,good);
  const {errors}=parseTaskScopes(tasksText(['- [ ] T-001: a','  - 范围: src/a.js','- [ ] T-002: b','  - 范围: `src/*.js`',
    '- [ ] T-003: c','  - 范围: `a.js`, `a.js`','- [ ] T-004: d','  - 范围: `a.js`','  - 范围: `b.js`']));
  assert.deepEqual(errors.map(item=>item.taskId),['T-001','T-002','T-003','T-004']);
});

test('tests outside scope, a device mark without scope and a stray sub-item are reported',()=>{
  const {tasks,errors}=parseTaskScopes(tasksText(['- 范围: `orphan.js`','- [ ] T-001: a','  - 范围: `src/a.js`','  - 测试文件: `test/a.test.js`',
    '- [ ] T-002: b','  - 设备: 需要','- [ ] T-003: c','  - 设备: 是']));
  assert.equal(tasks.size,0);
  const messages=errors.map(item=>`${item.taskId}:${item.message}`);
  assert.ok(messages.some(item=>item.startsWith('null:')&&item.includes('不在任何任务行下面')));
  // Written at the task's own level (indent forgotten) is reported the same way.
  const flat=parseTaskScopes(tasksText(['- [ ] T-009: a','- 范围: `a.js`']));
  assert.equal(flat.tasks.size,0);assert.match(flat.errors[0].message,/要缩进/);
  // Ordinary prose bullets that merely start with the same word are not scope.
  assert.deepEqual(parseTaskScopes(tasksText(['- [ ] T-001: a','  - 范围: `a.js`','','## 风险点','- device: iPhone 15 无法覆盖','- 范围: 待定'])).errors,[]);
  assert.ok(messages.some(item=>item.startsWith('T-001:')&&item.includes('测试文件不在范围里')));
  assert.ok(messages.some(item=>item.startsWith('T-002:')&&item.includes('没有范围')));
  assert.ok(messages.some(item=>item.startsWith('T-003:')&&item.includes('设备只能写')));
});

test('sub-items inside a fence are examples, and a heading ends a task',()=>{
  const {tasks,errors}=parseTaskScopes(tasksText(['- [ ] T-001: a','```md','  - 范围: `fenced.js`','```','## 说明','  - 范围: `after-heading.js`']));
  assert.equal(tasks.has('T-001'),false);
  assert.ok(errors.every(item=>item.taskId===null));
});

test('a task that cannot list its files declares 串行 and is never treated as having a scope',t=>{
  const parsed=parseTaskScopes(tasksText(['- [ ] T-001: scaffold','  - 范围: 串行','- [ ] T-002: b','  - scope: serial','  - 设备: 需要']));
  assert.deepEqual([...parsed.serial],['T-001']);assert.equal(parsed.tasks.size,0);
  assert.match(parsed.errors[0].message,/串行/);
  // Only a scaffold feature (N.bootstrap) may use it; a business feature must list files.
  const scaffold=draft('- [ ] T-001: scaffold\n  - 范围: 串行\n');scaffold.features[0].directory='1.bootstrap';
  assert.equal(checkPrdDraftMechanics(scaffold,{rules:3}).status,'mechanical_subset_passed');
  const business=checkPrdDraftMechanics(draft('- [ ] T-001: feature\n  - 范围: 串行\n'),{rules:3});
  assert.deepEqual(codes(business),['task_scope_invalid']);assert.match(business.findings[0].reason.problems[0],/只用于脚手架功能/);
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-task-scope-serial-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  // At run time too: a scaffold's 串行 is "no scope", anywhere else it is refused, not read as "none".
  for(const feature of ['1.bootstrap','2.work']){
    fs.mkdirSync(path.join(root,feature));fs.writeFileSync(path.join(root,feature,'tasks.md'),'- [ ] T-001: scaffold\n  - 范围: 串行\n');
  }
  assert.equal(declaredTaskScope(root,'1.bootstrap','T-001'),null);
  assert.throws(()=>declaredTaskScope(root,'2.work','T-001'),error=>error.code==='task_scope_invalid'&&/只用于脚手架功能/.test(error.reason));
});

test('the same files in another order are the same scope',()=>{
  assert.equal(sameScope(['a','b'],['b','a']),true);
  assert.equal(sameScope(['a'],['a','b']),false);
  assert.equal(sameScope(['a','a'],['a','b']),false);
});

const draft=(tasks)=>({draftDigest:'d',features:[{directory:'1.sample',name:'sample',documents:[
  {path:'requirements.md',content:'- [ ] [AC-001] works\n'},{path:'design.md',content:'# d\n'},{path:'tasks.md',content:tasks}]}]});
const codes=report=>report.findings.map(item=>item.code);

test('rule 3: every task of a new draft must declare its files; earlier rules do not ask',()=>{
  assert.equal(PRD_SELF_CHECK_RULES,3);
  const without=draft('- [ ] T-001: a\n- [ ] T-002: b\n  - 范围: `b.js`\n');
  const report=checkPrdDraftMechanics(without,{rules:3});
  assert.deepEqual(codes(report),['task_scope_missing']);
  assert.deepEqual(report.findings[0].reason.tasks,['T-001']);
  assert.equal(checkPrdDraftMechanics(without,{rules:2}).status,'mechanical_subset_passed');
  // A dropped task (allowed in a change) needs no scope.
  assert.equal(checkPrdDraftMechanics(draft('- [ ] T-001: a\n  - 范围: `a.js`\n- [ ] ~~T-002: b~~ [DROPPED 合并]\n'),{rules:3,change:true}).status,'mechanical_subset_passed');
  const malformed=checkPrdDraftMechanics(draft('- [ ] T-001: a\n  - 范围: `src/*`\n'),{rules:3});
  assert.deepEqual(codes(malformed),['task_scope_invalid']);
});

test('rule 3 in a change proposal requires scope only for tasks the approval covered',()=>{
  const previous={'1.sample':'- [x] T-001: old\n'},scopes={'1.sample':{exempt:['T-001']}};
  const kept=draft('- [x] T-001: old\n- [ ] T-002: new\n  - 范围: `b.js`\n');
  assert.equal(checkPrdDraftMechanics(kept,{rules:3,change:true,previous,scopes}).status,'mechanical_subset_passed');
  const added=draft('- [x] T-001: old\n- [ ] T-002: new\n');
  assert.deepEqual(checkPrdDraftMechanics(added,{rules:3,change:true,previous,scopes}).findings[0].reason.tasks,['T-002']);
  // The previous text alone exempts nothing: it may be an unapproved draft.
  assert.deepEqual(checkPrdDraftMechanics(added,{rules:3,change:true,previous}).findings[0].reason.tasks,['T-001','T-002']);
});

test('change exemptions come from the approved bytes and grammar, or the save record, never a draft',()=>{
  const sha=text=>createHash('sha256').update(text).digest('hex');
  // Under the legacy grammar the full-width colon line is a note, not an approved task.
  const approvedText='- [ ] T-001: 原任务\n- [ ] T-002：旧说明\n';
  const status=(text,extra={})=>JSON.stringify({status:'approved',features:['1.sample'],specFiles:[{path:'1.sample/tasks.md',sha256:sha(text)}],...extra});
  const before=(text,statusText,scopeRecords)=>({files:{'1.sample/tasks.md':text},status:statusText,...(scopeRecords?{scopeRecords}:{})});
  assert.deepEqual(approvedScopeExemptions(before(approvedText,status(approvedText)),['1.sample'],1),{'1.sample':{exempt:['T-001']}});
  assert.deepEqual(approvedScopeExemptions(before(approvedText,status(approvedText)),['1.sample'],2),{'1.sample':{exempt:['T-001','T-002']}});
  // A saved but unapproved draft (no status, or bytes that differ from the approval) exempts nothing ...
  assert.deepEqual(approvedScopeExemptions(before('- [ ] T-001: new\n',null),['1.sample'],2),{'1.sample':{exempt:[]}});
  assert.deepEqual(approvedScopeExemptions(before('- [ ] T-001: edited\n',status(approvedText)),['1.sample'],2),{'1.sample':{exempt:[]}});
  // ... except what its own save recorded, which traces back to an approval.
  const record=JSON.stringify({version:1,enforced:true,exempt:['T-001']})+'\n';
  assert.deepEqual(approvedScopeExemptions(before('- [ ] T-001: edited\n',null,{'1.sample':record}),['1.sample'],2),{'1.sample':{exempt:['T-001']}});
  assert.deepEqual(approvedScopeExemptions(before('x',null),['2.added'],2),{'2.added':{exempt:[]}});
  // Approval rows are semantic digests: a task completed after approval still matches.
  const done='- [x] T-001: 原任务\n',semantic=sha(normalizeRuntimeMarkBytes(Buffer.from(done),'tasks.md'));
  const approval=JSON.stringify({status:'approved',specFiles:[{path:'1.sample/tasks.md',sha256:semantic}]});
  assert.deepEqual(approvedScopeExemptions(before(done,approval),['1.sample'],2),{'1.sample':{exempt:['T-001']}});
});

test('scope paths that differ only in case are refused, as the execution side would',()=>{
  const parsed=parseTaskScopes('- [ ] T-001: a\n  - 范围: `src/a.js`, `src/A.js`\n');
  assert.equal(parsed.tasks.size,0);assert.match(parsed.errors[0].message,/大小写/);
});

test('reading tasks.md never blocks on a non-regular file and stays inside the specs directory',t=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-task-scope-fifo-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'1.work'));
  assert.equal(spawnSync('mkfifo',[path.join(root,'1.work','tasks.md')]).status,0);
  assert.throws(()=>declaredTaskScope(root,'1.work','T-001'),error=>error.code==='task_scope_invalid'&&/不是普通文件/.test(error.reason));
  const outside=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-task-scope-outside-')));
  t.after(()=>fs.rmSync(outside,{recursive:true,force:true}));
  fs.writeFileSync(path.join(outside,'tasks.md'),'- [ ] T-001: a\n  - 范围: `a.js`\n');
  fs.mkdirSync(path.join(root,'2.link'));fs.symlinkSync(path.join(outside,'tasks.md'),path.join(root,'2.link','tasks.md'));
  assert.throws(()=>declaredTaskScope(root,'2.link','T-001'),error=>error.code==='task_scope_invalid'&&/不在规格目录内/.test(error.reason));
});

test('a saved scope record holds later re-checks to the scope rule, approved tasks exempt',t=>{
  const specs=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-task-scope-record-')));
  t.after(()=>fs.rmSync(specs,{recursive:true,force:true}));
  const feature=tasks=>draft(tasks).features[0];
  // Without a record the re-check is unchanged (rule 1 asks nothing about scope).
  assert.deepEqual(prdTaskScopeOptions(specs,'1.sample'),{});
  recordPrdTaskScopes(specs,[feature('- [ ] T-001: old\n- [ ] T-002: new\n  - 范围: `b.js`\n')],{'1.sample':{exempt:['T-001']}});
  const options=prdTaskScopeOptions(specs,['1.sample']);
  assert.deepEqual(options,{scopes:{'1.sample':{exempt:['T-001']}}});
  assert.equal(checkPrdDraftMechanics(draft('- [ ] T-001: old\n- [ ] T-002: new\n'),options).findings[0].code,'task_scope_missing');
  assert.equal(checkPrdDraftMechanics(draft('- [ ] T-001: old\n- [ ] T-002: new\n'),{}).status,'mechanical_subset_passed');
  assert.equal(checkPrdDraftMechanics(draft('- [ ] T-001: old\n- [ ] T-002: new\n  - 范围: `b.js`\n'),options).status,'mechanical_subset_passed');
  // A draft without scopes records that, and stays on the old rule.
  recordPrdTaskScopes(specs,[feature('- [ ] T-001: a\n')]);
  assert.deepEqual(prdTaskScopeOptions(specs,'1.sample'),{});
  fs.writeFileSync(path.join(specs,'.reviews/prd-sample-task-scope.json'),'{"version":1,"enforced":"yes","exempt":[]}\n',{mode:0o600});
  assert.throws(()=>prdTaskScopeOptions(specs,'1.sample'),/prd_task_scope_record_invalid/);
});

function batchSpecs(t,{tasks,log=[]}){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-task-scope-batch-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const specsDir=path.join(root,'specs'),codeProject=path.join(root,'code');
  fs.mkdirSync(path.join(specsDir,'1.work'),{recursive:true});fs.mkdirSync(codeProject);
  fs.writeFileSync(path.join(codeProject,'req.md'),'# r\n');
  fs.writeFileSync(path.join(specsDir,'1.work','tasks.md'),tasks);
  if(log.length)fs.writeFileSync(path.join(specsDir,'运行日志.jsonl'),log.map(row=>JSON.stringify(row)).join('\n')+'\n');
  const build=(batchId,taskScopes)=>createCmAiBatch({configuration:{version:1,repositoryId:'r',batchId,specsDir,codeProject,
    parallel:[['1.work/T-001','1.work/T-002']],tasks:['T-001','T-002','T-003'].map((taskId,index)=>({feature:'1.work',taskId,
      scope:[taskScopes[index]],requirements:['req.md']}))},executionFor:async()=>({}),logHome:path.join(root,'log')});
  return {specsDir,build};
}
const scoped=(a,b,c,extra='')=>`- [ ] T-001: a\n  - 范围: \`${a}\`\n${extra}- [ ] T-002: b\n  - 范围: \`${b}\`\n- [ ] T-003: c\n  - 范围: \`${c}\`\n\n- T-003 依赖 T-001, T-002\n`;

test('a new batch takes parallel members only from tasks that declare their files',t=>{
  const declared=batchSpecs(t,{tasks:scoped('a.js','b.js','c.js')});
  assert.ok(declared.build('scope-ok-1',['a.js','b.js','c.js']));
  const undeclared=batchSpecs(t,{tasks:'- [ ] T-001: a\n- [ ] T-002: b\n- [ ] T-003: c\n\n- T-003 依赖 T-001, T-002\n'});
  assert.throws(()=>undeclared.build('scope-none-1',['a.js','b.js','c.js']),{code:'parallel_scope_undeclared'});
});

test('a device task never joins a parallel group',t=>{
  const f=batchSpecs(t,{tasks:scoped('a.js','b.js','c.js','  - 设备: 需要\n')});
  assert.throws(()=>f.build('device-1',['a.js','b.js','c.js']),{code:'parallel_device_task'});
});

test('a batch member whose configured files depart from tasks.md is refused',t=>{
  const f=batchSpecs(t,{tasks:scoped('a.js','b.js','c.js')});
  assert.throws(()=>f.build('mismatch-1',['a.js','other.js','c.js']),error=>error.code==='task_scope_mismatch'&&/1\.work\/T-002/.test(error.reason));
});

test('a batch that started before tasks.md scope keeps resuming under its original rules',t=>{
  const start={schema_version:1,workflow:'cm-ai',event:'decision',phase:'batch_start',run_id:'legacy-batch',from_key:'1.work/T-001'};
  const f=batchSpecs(t,{tasks:'- [ ] T-001: a\n- [ ] T-002: b\n- [ ] T-003: c\n\n- T-003 依赖 T-001, T-002\n',log:[start]});
  assert.ok(f.build('legacy-batch',['a.js','b.js','c.js']));
  // The same tasks under a batch that has not started are refused.
  assert.throws(()=>f.build('fresh-batch',['a.js','b.js','c.js']),{code:'parallel_scope_undeclared'});
  // A recorded segment marks a new-style start; it does not exempt the batch from anything else.
  const g=batchSpecs(t,{tasks:scoped('a.js','b.js','c.js'),log:[{...start,run_id:'new-batch',[BATCH_SEGMENT_FIELD]:batchSegment('new-batch')}]});
  assert.ok(g.build('new-batch',['a.js','b.js','c.js']));
});

test('declaredTaskScope reads one task and refuses a malformed sub-item of that task only',t=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-task-scope-read-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'1.work'));
  fs.writeFileSync(path.join(root,'1.work','tasks.md'),'- [ ] T-001: a\n  - 范围: `a.js`\n- [ ] T-002: b\n  - 范围: `bad/*`\n- [ ] T-003: c\n');
  assert.deepEqual(declaredTaskScope(root,'1.work','T-001').scope,['a.js']);
  assert.equal(declaredTaskScope(root,'1.work','T-003'),null);
  assert.throws(()=>declaredTaskScope(root,'1.work','T-002'),{code:'task_scope_invalid'});
  assert.equal(declaredTaskScope(root,'2.none','T-001'),null);
});
