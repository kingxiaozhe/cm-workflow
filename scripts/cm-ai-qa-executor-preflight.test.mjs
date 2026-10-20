import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {buildManifest} from './cm-spec-manifest.mjs';
import {configFingerprint} from '../runtime/js/cm-ai/codex-config.mjs';
import {buildCmAiDriveHostArgs} from './cm-ai-drive.mjs';

const DRIVER=fileURLToPath(new URL('./cm-ai-drive.mjs',import.meta.url));
const policy={version:2,development:'conversation',bootstrap:'disabled',qa:'disabled',qaFix:'disabled'};
function fixture(t,kind=null){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-qa-executor-preflight-')));
  const codeProject=path.join(root,'app'),specsDir=path.join(root,'specs'),feature='1.work',answers=path.join(root,'answers');
  fs.mkdirSync(codeProject);fs.mkdirSync(path.join(specsDir,feature),{recursive:true});fs.mkdirSync(answers);
  fs.writeFileSync(path.join(codeProject,'target.mjs'),'export const value=42;\n');
  fs.writeFileSync(path.join(specsDir,feature,'requirements.md'),'- [AC-001]: fixture\n');
  fs.writeFileSync(path.join(specsDir,feature,'design.md'),'# Fixture\n');
  fs.writeFileSync(path.join(specsDir,feature,'tasks.md'),'- [ ] T-001: fixture [AC-001]\n');
  if(kind)fs.writeFileSync(path.join(specsDir,feature,'test-cases.json'),JSON.stringify({schemaVersion:'1.0',feature:'work',
    cases:[{id:'TC-001',origin:'user',kind,blocking:true,acIds:['AC-001'],taskIds:['T-001'],title:`${kind} fixture`,
      preconditions:[],steps:['Observe fixture'],expected:['The accepted value is visible'],cleanup:[]}]}));
  fs.writeFileSync(path.join(specsDir,'.cm-specs-status'),JSON.stringify({status:'approved',features:[feature],specFiles:buildManifest(specsDir)}));
  const definition={version:1,codeProject,specsDir,feature,
    identity:{repositoryId:'qa-preflight',runId:'qa-preflight-run',taskId:'T-001',attempt:1},scope:['target.mjs'],requirements:[]};
  fs.writeFileSync(path.join(root,'run.json'),JSON.stringify(definition));
  fs.writeFileSync(path.join(root,'control.json'),JSON.stringify(policy));
  fs.writeFileSync(path.join(root,'review.json'),JSON.stringify({model:'fixture',preflight:{passed:true,cli_model:'fixture',
    prompt_transport:'stdin',config_fingerprint:configFingerprint({cwd:codeProject,model:'fixture'})}}));
  fs.writeFileSync(path.join(answers,'qa-assess.json'),JSON.stringify({confirmed:true}));
  const marker=path.join(root,'qa-command-ran'),config=path.join(root,'qa-executor.json');
  const qa={commands:[{id:'sentinel',caseIds:[],command:[process.execPath,'-e',
    `require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran')`]}],
    environment:{kind:'web',carrier:'browser',target:'isolated-fixture',scope:'local'}};
  fs.writeFileSync(config,JSON.stringify(qa));
  const permissions=['--review-config','review.json','--qa-executor-config','qa-executor.json',
    ...(kind==='browser'?['--browser-qa','available']:[])];
  const env={...process.env,CM_WORKFLOW_HOME:path.join(root,'home'),CM_WORKFLOW_LOG_HOME:path.join(root,'logs')};
  let sequence=0;
  const plan=extra=>{const file=path.join(root,`plan-${++sequence}.json`);fs.writeFileSync(file,JSON.stringify({config:'run.json',
    mode:'create',hostContext:'qa-preflight-author',controlConfig:'control.json',answers:'answers',permissions,
    packageDigest:'a'.repeat(64),testRunId:null,checks:[{id:'syntax',command:[process.execPath,'--check','target.mjs']}],...extra}));return file;};
  const drive=(operation='status',extra={})=>spawnSync(process.execPath,[DRIVER,'--plan',plan(extra),operation],
    {cwd:root,env,encoding:'utf8',timeout:20000});
  const untouched=()=>{
    assert.equal(fs.existsSync(path.join(specsDir,'.reviews','.execution')),false,'preflight cannot create any owner store');
    assert.equal(fs.existsSync(marker),false,'preflight cannot run QA commands');
    assert.equal(fs.existsSync(path.join(specsDir,'运行日志.jsonl')),false,'preflight cannot record a QA decision or result');
  };
  t.after(()=>{untouched();fs.rmSync(root,{recursive:true,force:true});});
  return {root,codeProject,specsDir,config,qa,permissions,definition,env,drive,untouched};
}

test('driver forwards the independent executor config and host rejects create before opening an owner',t=>{
  const f=fixture(t),r=f.drive();
  assert.notEqual(r.status,0,r.stdout+r.stderr);
  assert.match(r.stderr,/qa_executor_attachment_unavailable/);
  assert.doesNotMatch(r.stderr,/unknown.*(?:flag|argument)|tool_preflight_missing|invalid_review_config|review-config 不存在/i);
  f.untouched();
  const expectedFile=path.join(f.root,'expected.json');
  const args=buildCmAiDriveHostArgs({mode:'resume',hostContext:'qa-preflight-author',controlConfig:'control.json'},
    ['--qa-executor-config',f.config,'--attach-qa-executor-reason','Run the required QA','--expected-control',expectedFile],
    path.join(f.root,'run.json'),path.join(f.root,'control.json'));
  assert.equal(args[args.indexOf('--qa-executor-config')+1],f.config);
  assert.equal(args[args.indexOf('--attach-qa-executor-reason')+1],'Run the required QA');
  assert.equal(args[args.indexOf('--expected-control')+1],expectedFile);
  assert.equal(args[args.indexOf('--mode')+1],'resume');
  // Driver resume requires a real store before reaching host authorization.
  // The missing-preview transition belongs to the completed-owner fixture;
  // this preflight intentionally does not manufacture a snapshot for it.
  f.untouched();
});

test('driver refuses registration outside resume status without treating the reason as a file path',t=>{
  const f=fixture(t),r=f.drive('status',{permissions:[...f.permissions,'--attach-qa-executor-reason','Run the required QA']});
  assert.equal(r.status,2,r.stderr);assert.match(r.stderr,/QA executor attachment registration requires resume status/);
  assert.doesNotMatch(r.stderr,/文件不存在|unknown.*(?:flag|argument)/i);f.untouched();
});

for(const extra of [{criticalPaths:{}},{documentationPaths:[]},{applicableAgentFiles:[]},{qaFix:'auto'}])
  test(`driver rejects an independent executor config containing ${Object.keys(extra)[0]} before launch`,t=>{
    const f=fixture(t);fs.writeFileSync(f.config,JSON.stringify({...f.qa,...extra}));const r=f.drive();
    assert.equal(r.status,1,r.stderr);assert.match(r.stderr,/\[drive\] 驾驶员失败：invalid_input/);
    assert.doesNotMatch(r.stderr,/qa_executor_attachment_unavailable|unknown.*(?:flag|argument)/i);f.untouched();
  });

for(const kind of ['browser','logic'])for(const operation of ['qa','advance'])
  test(`qa-disabled independent executor requires a live ${kind} runner before ${operation} or any owner starts`,t=>{
    const f=fixture(t,kind),r=f.drive(operation);
    assert.equal(r.status,2,r.stderr);assert.match(r.stderr,new RegExp(`缺少真实执行 runner: qa_${kind}`));
    assert.doesNotMatch(r.stderr,/qa_executor_attachment_unavailable|tool_preflight_missing|invalid_review_config|恢复存档不存在/);
    assert.equal(r.stdout,'');f.untouched();
  });
