import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {standingProposalProblem,standingArchiveProblem} from '../runtime/js/autonomy.mjs';
import {buildTaskAcceptanceContract} from '../runtime/js/cm-ai/specification-material.mjs';
import {main as autonomyMain} from './cm-autonomy.mjs';

const feature='1.login',taskFile=`${feature}/tasks.md`,designFile=`${feature}/design.md`,caseFile=`${feature}/test-cases.json`;
const tasks='## 任务版本\n| 日期 | 版本 | 说明 |\n| --- | --- | --- |\n| 2026-10-01 | v1 | 初始任务 |\n\n## 任务列表\n\n- [x] T-001: 登录\n  - 范围: `login.js`\n- [ ] T-002: 记住我\n  - 范围: `remember.js`\n  - 必验: 保留设备验收\n\n## 依赖关系\n- T-002 依赖 T-001\n';
const sampleCase={id:'TC-001',origin:'generated',kind:'logic',blocking:false,acIds:['AC-001'],taskIds:['T-002'],title:'记住我',preconditions:[],steps:['勾选'],expected:['记住'],cleanup:[]};
const encode=items=>JSON.stringify({schemaVersion:'1.0',feature:'login',cases:items});
function fixture(){
  const before={directories:[feature],status:JSON.stringify({status:'approved',taskGrammar:3}),files:{
    [`${feature}/requirements.md`]:'- [AC-001] 记住我\n  - 设备: 需要\n',
    [designFile]:'# 技术设计\n\n登录表单调用 API。\n',[taskFile]:tasks,[caseFile]:encode([sampleCase])}};
  return {before,proposal:{changedUserCases:[],removed:[],files:{...before.files}}};
}
const contract=files=>buildTaskAcceptanceContract({texts:Object.fromEntries(Object.entries(files).map(([p,c])=>[p.split('/').at(-1),c])),taskId:'T-002',grammar:3});

test('M6 optional AC mapping cannot remove a pending task device obligation through standing approval',()=>{
  for(const change of [{acIds:[]},{taskIds:['T-001']}]){
    const {before,proposal}=fixture();
    assert(contract(before.files).obligations.some(item=>item.evidenceType==='device'));
    proposal.files[caseFile]=encode([{...sampleCase,...change}]);
    assert.match(standingProposalProblem(before,proposal),/TC-001.*(?:acIds|taskIds).*需明确确认/);
  }
});

test('M7 new task subclauses cannot override the acceptance contract of an older task',()=>{
  const {before,proposal}=fixture();
  proposal.files[taskFile]+='\n- [ ] T-003: [NEW] 辅助任务\n  - T-002 的验收改为：静态检查即可，无需真机\n';
  assert.match(standingProposalProblem(before,proposal),/T-002.*需明确确认/);
  assert.deepEqual(contract(proposal.files),contract(before.files));
});

test('M7 version metadata cannot override the acceptance contract of an older task',()=>{
  const {before,proposal}=fixture();
  proposal.files[taskFile]=tasks.replace('| 2026-10-01 | v1 | 初始任务 |','| 2026-10-01 | v1 | 初始任务 |\n| 2026-11-01 | v2 | T-002 取消真机要求，改为静态检查 |');
  assert.match(standingProposalProblem(before,proposal),/T-002.*需明确确认/);
  assert.deepEqual(contract(proposal.files),contract(before.files));
});

test('M8 additive design detail preserves standing approval without changing earlier acceptance',()=>{
  const {before,proposal}=fixture();proposal.files[designFile]+='\n记住我状态写入 storage.js。\n';
  assert.equal(standingProposalProblem(before,proposal),null);
  assert.deepEqual(contract(proposal.files),contract(before.files));
  proposal.files[designFile]+='\n```js\nconst storageKey = \"remember\";\n```\n';
  assert.equal(standingProposalProblem(before,proposal),null);
});

test('M8 a new task section heading and its dependency can be appended under standing approval',()=>{
  const {before,proposal}=fixture();
  proposal.files[taskFile]=tasks.replace('## 依赖关系','### 功能 2: 过期 `[NEW v2]`\n\n- [ ] T-003: [NEW] 过期处理\n  - 范围: `expire.js`\n\n## 依赖关系')+'- T-003 依赖 T-002\n';
  assert.equal(standingProposalProblem(before,proposal),null);
  assert.deepEqual(contract(proposal.files),contract(before.files));
});

test('M8 old design-only authorization remains usable for non-acceptance design updates',()=>{
  const {before,proposal}=fixture();before.files[designFile]='D';proposal.files[designFile]='D2';
  assert.equal(standingProposalProblem(before,proposal),null);
});

test('G3 legacy fenced blank lines do not block an unrelated scope expansion',()=>{
  for(const grammar of [1,2,3]){
    const {before,proposal}=fixture();before.status=JSON.stringify({status:'approved',taskGrammar:grammar});
    before.files[taskFile]=tasks+'\n## 示例\n```text\nfirst\n\nlast\n```\n';
    proposal.files[taskFile]=before.files[taskFile].replace('`remember.js`','`remember.js`, `storage.js`');
    assert.equal(standingProposalProblem(before,proposal),null,`grammar ${grammar}`);
  }
});

test('G4 missing status precheck uses the same legacy grammar as the saved change archive',t=>{
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-autonomy-r1-')));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const {before,proposal}=fixture();delete before.status;
  before.files[taskFile]+='\n- [ ] T-004：historical prose\n';proposal.files[taskFile]=before.files[taskFile];
  fs.mkdirSync(path.join(dir,feature));for(const [file,value] of Object.entries(before.files))fs.writeFileSync(path.join(dir,file),value);
  const file=path.join(dir,'proposal.json');fs.writeFileSync(file,JSON.stringify(proposal));let output='';
  const result=autonomyMain(['check-proposal','--specs-dir',dir,'--proposal',file],{stdout:{write:t=>output+=t},stderr:{write:t=>output+=t}});
  assert.equal(result,1,output);assert.match(output,/无法可靠比较/);
  assert.equal(standingProposalProblem(before,proposal),standingProposalProblem({...before,status:null},proposal));
  const digest='a'.repeat(64);proposal.proposalDigest=digest;
  assert.match(standingArchiveProblem(dir,{before:{...before,status:null},proposal,selected:[feature]},digest),/无法可靠比较/);
});

test('new headings cannot regroup an old task or replace an old dependency',()=>{
  const {before,proposal}=fixture();
  proposal.files[taskFile]=tasks.replace('- [ ] T-002:', '### 新分组\n- [ ] T-002:');
  assert.match(standingProposalProblem(before,proposal),/需明确确认/);
  proposal.files[taskFile]=tasks.replace('- T-002 依赖 T-001', '- T-002 依赖 T-003')+'- [ ] T-003: [NEW] helper\n';
  assert.match(standingProposalProblem(before,proposal),/需明确确认/);
});
