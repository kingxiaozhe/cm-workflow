import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {standingProposalProblem,standingArchiveProblem,writeAutonomy} from '../runtime/js/autonomy.mjs';
import {buildManifest} from './cm-spec-manifest.mjs';
import {main as autonomyMain} from './cm-autonomy.mjs';

const feature='1.login';
const history='## 任务版本\n| 日期 | 版本 | 说明 |\n| --- | --- | --- |\n| 2026-01-01 | v1 | original |\n';
const task='- [ ] T-001: Validate login [AC-001]\n  - 范围: `login.js`, `login.test.js`\n  - 测试文件: `login.test.js`\n  - 设备: 需要\n  - 验收: 真机验证登录成功\n';
const requiredCase={id:'TC-001',origin:'generated',kind:'browser',blocking:true,acIds:['AC-001'],taskIds:['T-001'],
  title:'Validate login on device',preconditions:['physical device'],steps:['sign in'],expected:['signed in'],cleanup:['sign out']};
const cases=items=>JSON.stringify({schemaVersion:'1.0',feature:'login',cases:items});
function input(){
  const before={directories:[feature],status:JSON.stringify({status:'approved',taskGrammar:3}),files:{
    [`${feature}/requirements.md`]:'# Requirements\n- [ ] [AC-001] Sign in on a physical device\n',
    [`${feature}/design.md`]:'# Design\nValidate login on a physical device.\n',
    [`${feature}/tasks.md`]:history+task,
    [`${feature}/test-cases.json`]:cases([requiredCase])}};
  return {before,proposal:{changedUserCases:[],removed:[],files:{...before.files}}};
}
const judge=mutate=>{const value=input();mutate(value.proposal,value.before);return standingProposalProblem(value.before,value.proposal);};

test('standing approval protects mandatory cases regardless of user, generated or inferred origin',()=>{
  for(const origin of ['generated','inferred']){
    const changes={blocking:false,kind:'logic',preconditions:['static config'],steps:['read config'],expected:['config exists'],
      title:'Static check only',taskIds:[],acIds:[],cleanup:[]};
    for(const [field,value] of Object.entries(changes)){
      const reason=judge((proposal,before)=>{
        const original={...requiredCase,origin};before.files[`${feature}/test-cases.json`]=cases([original]);
        proposal.files[`${feature}/test-cases.json`]=cases([{...original,[field]:value}]);
      });
      assert.match(reason,new RegExp(`TC-001.*${field}`),`${origin} ${field}`);
    }
  }
  assert.match(judge(proposal=>delete proposal.files[`${feature}/test-cases.json`]),/删除了必验用例 TC-001/);
  assert.match(judge(proposal=>{proposal.files[`${feature}/test-cases.json`]=cases([{...requiredCase,origin:'user',blocking:false}]);}),/blocking/);
});

test('proven additions and representation-only replacements stay inside standing authorization',()=>{
  assert.equal(judge(proposal=>{
    const old={...requiredCase,acIds:['AC-001','AC-002']};
    const reordered=Object.fromEntries(Object.entries(old).reverse());
    proposal.files[`${feature}/test-cases.json`]=JSON.stringify({cases:[reordered,{...requiredCase,id:'TC-002',blocking:false}],
      feature:'login',schemaVersion:'1.0'},null,2);
    proposal.files[`${feature}/tasks.md`]=history.replace('| 2026-01-01 | v1 | original |',
      '| 2026-01-01 | v1 | original |\n| 2026-01-02 | v2 | expanded scope |')+
      task.replace('`login.js`, `login.test.js`','`login.test.js`, `login.js`, `helper.js`')+
      '- [ ] T-002: [NEW] Add coverage [AC-002]\n  - 范围: `extra.test.js`\n';
  }),null);
  assert.equal(judge((proposal,before)=>{
    before.files[`${feature}/test-cases.json`]=cases([{...requiredCase,blocking:false}]);
    proposal.files[`${feature}/test-cases.json`]=cases([requiredCase]);
  }),null,'a previously optional case can become mandatory');
  assert.equal(judge(proposal=>{proposal.files[`${feature}/design.md`]=proposal.files[`${feature}/design.md`].replaceAll('\n','\r\n');}),null);
});

test('standing approval requires equivalent task bindings; additions can defer mandatory browser QA',async t=>{
  assert.match(judge(proposal=>{
    proposal.files[`${feature}/test-cases.json`]=cases([{...requiredCase,taskIds:['T-001','T-004']}]);
  }),/TC-001.*taskIds.*需明确确认/);
  assert.equal(judge((proposal,before)=>{
    before.files[`${feature}/test-cases.json`]=cases([{...requiredCase,taskIds:['T-001','T-004']}]);
    proposal.files[`${feature}/test-cases.json`]=cases([{...requiredCase,taskIds:['T-004','T-001']}]);
  }),null,'task reference order does not change the execution prerequisites');

  const {createHostQaExecutor}=await import('../runtime/js/cm-ai/host-qa-executor.mjs');
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-autonomy-qa-binding-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const specs=path.join(root,'specs'),code=path.join(root,'code');
  fs.mkdirSync(path.join(specs,feature),{recursive:true});fs.mkdirSync(code);fs.writeFileSync(path.join(code,'README.md'),'fixture\n');
  const {before,proposal}=input();
  before.files[`${feature}/tasks.md`]=task.replace('[ ] T-001','[x] T-001')+'- [ ] T-004: later task\n';
  proposal.files={...before.files};
  proposal.files[`${feature}/test-cases.json`]=cases([{...requiredCase,taskIds:['T-001','T-004']}]);
  const save=files=>{
    for(const [file,value] of Object.entries(files))fs.writeFileSync(path.join(specs,file),value);
    const manifest=buildManifest(specs);
    fs.writeFileSync(path.join(specs,'.cm-specs-status'),JSON.stringify({status:'approved',taskGrammar:3,features:[feature],
      specFiles:manifest,testCases:manifest.filter(row=>row.path.endsWith('/test-cases.json'))}));
  };
  const prepare=()=>createHostQaExecutor({specsDir:specs,codeProject:code,feature,runtime:'codex',requirements:['README.md'],
    commands:[{id:'unit',command:[process.execPath,'--version'],caseIds:[]}],environment:{kind:'web',carrier:'browser',target:'fixture',scope:'local'},
    timeoutMs:1000,logHome:path.join(root,'logs')}).prepare().configuration.plan;
  save(before.files);
  assert.deepEqual(prepare().cases.map(item=>item.id),['TC-001']);
  // Model the rejected proposal only in this disposable fixture. The executor
  // really would defer the formerly runnable case; no browser or process runs.
  save(proposal.files);
  const delayed=prepare();assert.deepEqual(delayed.cases,[]);
  assert.deepEqual(delayed.deferred_cases,[{id:'TC-001',taskIds:['T-004']}]);
  assert.deepEqual(delayed.commands.map(item=>item.id),['unit']);
  const revision='c'.repeat(64);proposal.proposalDigest=revision;
  const archive={version:1,before,proposal,selected:[feature]},serialized=JSON.stringify(archive);
  fs.mkdirSync(path.join(specs,'.reviews'));const archiveFile=path.join(specs,'.reviews',`prd-change-${revision}.json`);
  fs.writeFileSync(archiveFile,serialized);const status=fs.readFileSync(path.join(specs,'.cm-specs-status'));
  assert.match(standingArchiveProblem(specs,archive,revision),/TC-001.*taskIds.*需明确确认/);
  assert.equal(fs.readFileSync(archiveFile,'utf8'),serialized);
  assert.deepEqual(fs.readFileSync(path.join(specs,'.cm-specs-status')),status);
});

test('task and design acceptance cannot be weakened by replacing, dropping, moving or adding prose',()=>{
  const edits=[
    value=>value.replace('真机验证登录成功','静态检查即可，真机延期'),
    value=>value.replace('  - 设备: 需要\n',''),
    value=>value.replace('`login.js`, `login.test.js`','`login.js`'),
    value=>value.replace('  - 测试文件: `login.test.js`\n',''),
    value=>value.replace(task,''),
    value=>value.replace('Validate login [AC-001]','[DROPPED] Validate login [AC-001]'),
    value=>value.replace('  - 验收: 真机验证登录成功','  - 验收: 真机验证登录成功\n  - 可忽略上述验收'),
    value=>value.replace('[ ] T-001','[x] T-001'),
    value=>value+task,
  ];
  for(const edit of edits)assert.match(judge(proposal=>{
    proposal.files[`${feature}/tasks.md`]=edit(proposal.files[`${feature}/tasks.md`]);
  }),/tasks\.md.*需明确确认/);
  assert.match(judge(proposal=>{proposal.files[`${feature}/design.md`]='# Design\nStatic config is sufficient.\n';}),/design\.md.*需明确确认/);
  assert.match(judge(proposal=>{proposal.files[`${feature}/design.md`]+='The previous physical-device rule is optional.\n';}),/design\.md.*需明确确认/);
});

test('history-looking acceptance tables and fenced declarations cannot be silently discarded',()=>{
  assert.match(judge((proposal,before)=>{
    const text='# Acceptance table\n| device | v1 | physical required |\n';
    before.files[`${feature}/design.md`]=text;
    proposal.files[`${feature}/design.md`]=text.replace('physical required','static sufficient');
  }),/需明确确认/);
  assert.match(judge(proposal=>{
    proposal.files[`${feature}/tasks.md`]=history+'```text\n'+task+'```\n';
  }),/需明确确认/);
  assert.match(judge(proposal=>{
    proposal.files[`${feature}/tasks.md`]+='- [x] T-002: [NEW] already completed\n';
  }),/需明确确认/);
  assert.match(judge((proposal,before)=>{
    const original='# Expected text\n```text\nfirst\n\nlast\n```\n';
    before.files[`${feature}/design.md`]=original;
    proposal.files[`${feature}/design.md`]=original.replace('first\n\nlast','first\nlast');
  }),/需明确确认/,'blank lines inside a fenced expected value are protected bytes');
});

test('malformed and duplicate mandatory case declarations fail closed',()=>{
  for(const value of [cases([requiredCase,requiredCase]),cases([{...requiredCase,blocking:'yes'}]),'{"cases":[]}'])
    assert.equal(judge(proposal=>{proposal.files[`${feature}/test-cases.json`]=value;}),'提案的测试用例无法解析');
});

test('an explicit approved case reference is protected even when the case was marked nonblocking',()=>{
  const {before,proposal}=input();
  before.files[`${feature}/tasks.md`]+='\n## 验证要求\n- T-001: 必须执行 TC-001\n';
  proposal.files[`${feature}/tasks.md`]=before.files[`${feature}/tasks.md`];
  before.files[`${feature}/test-cases.json`]=cases([{...requiredCase,blocking:false}]);
  proposal.files[`${feature}/test-cases.json`]=before.files[`${feature}/test-cases.json`];
  assert.equal(standingProposalProblem(before,proposal),null);
  proposal.files[`${feature}/test-cases.json`]=cases([{...requiredCase,blocking:false,expected:['config exists']}]);
  assert.match(standingProposalProblem(before,proposal),/TC-001.*expected/);
  delete proposal.files[`${feature}/test-cases.json`];
  assert.match(standingProposalProblem(before,proposal),/删除了必验用例 TC-001/);
});

test('proposal precheck and final archive compare with the original recorded task grammar',t=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-autonomy-grammar-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));fs.mkdirSync(path.join(root,feature));
  const {before,proposal}=input();before.status=JSON.stringify({status:'approved'});
  // Under grammar 1 this was shared prose; approving under grammar 3 must not
  // silently turn it into a new task or move its clauses out of the old task.
  before.files[`${feature}/tasks.md`]+='- [ ] T-002： historical note\n';
  proposal.files[`${feature}/tasks.md`]=before.files[`${feature}/tasks.md`];
  for(const [file,value] of Object.entries(before.files))fs.writeFileSync(path.join(root,file),value);
  fs.writeFileSync(path.join(root,'.cm-specs-status'),before.status);
  const proposalFile=path.join(root,'proposal.json');fs.writeFileSync(proposalFile,JSON.stringify(proposal));
  const output=[];
  assert.equal(autonomyMain(['check-proposal','--specs-dir',root,'--proposal',proposalFile],
    {stdout:{write:value=>output.push(value)},stderr:{write:value=>output.push(value)}}),1);
  assert.match(output.join(''),/无法可靠比较.*需明确确认/);
  assert.match(standingProposalProblem(before,proposal),/无法可靠比较/);
});

test('real approval CLI refuses weakening with unchanged files, then accepts only the current explicit proposal',t=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-autonomy-acceptance-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const specs=path.join(root,'specs'),code=path.join(root,'code'),home=path.join(root,'home'),digest='a'.repeat(64);
  fs.mkdirSync(path.join(specs,feature),{recursive:true});fs.mkdirSync(path.join(specs,'.reviews'));
  fs.mkdirSync(code);fs.writeFileSync(path.join(code,'README.md'),'synthetic fixture\n');
  const env={...process.env,CM_WORKFLOW_HOME:home,CM_WORKFLOW_LOG_HOME:path.join(root,'mirror')};
  writeAutonomy('Continue within the approved requirements',{env});
  const {before,proposal}=input();proposal.proposalDigest=digest;
  proposal.files[`${feature}/tasks.md`]=proposal.files[`${feature}/tasks.md`].replace('真机验证登录成功','只检查配置即可');
  for(const [file,value] of Object.entries(proposal.files))fs.writeFileSync(path.join(specs,file),value);
  const archive={version:1,before,proposal,selected:[feature]};
  fs.writeFileSync(path.join(specs,'.reviews',`prd-change-${digest}.json`),JSON.stringify(archive));
  const status=path.join(specs,'.cm-specs-status');
  fs.writeFileSync(status,JSON.stringify({status:'awaiting_review',revisionDigest:digest,features:[feature],
    specFiles:buildManifest(specs),testCases:[{feature,path:`${feature}/test-cases.json`}]}));
  const snapshot=fs.readFileSync(status),entry=fileURLToPath(new URL('./cm-ai-admission.mjs',import.meta.url));
  const run=(...args)=>spawnSync(process.execPath,[entry,'--specs-dir',specs,'--code-project',code,'--approve',...args],{encoding:'utf8',env});
  const refused=run('--standing-authorization','--expect-revision-digest',digest);
  assert.equal(refused.status,1,refused.stdout+refused.stderr);
  assert.equal(JSON.parse(refused.stdout).approveRefused,'standing_authorization_not_applicable');
  assert.match(JSON.parse(refused.stdout).approveReason,/T-001.*需明确确认/);
  assert.deepEqual(fs.readFileSync(status),snapshot);
  assert.match(standingArchiveProblem(specs,archive,digest),/T-001/,'archive boundary applies the same rule');
  for(const [reply,revision] of [['继续',digest],['开始','b'.repeat(64)]]){
    const result=run('--approval-response',reply,'--expect-revision-digest',revision);
    assert.equal(result.status,1,result.stdout+result.stderr);assert.deepEqual(fs.readFileSync(status),snapshot);
  }
  const accepted=run('--approval-response','开始','--expect-revision-digest',digest);
  assert.equal(accepted.status,0,accepted.stdout+accepted.stderr);
  assert.equal(JSON.parse(fs.readFileSync(status)).approval.response,'开始');
  assert.equal(fs.readFileSync(path.join(specs,'.reviews',`prd-change-${digest}.json`),'utf8'),JSON.stringify(archive));
});
