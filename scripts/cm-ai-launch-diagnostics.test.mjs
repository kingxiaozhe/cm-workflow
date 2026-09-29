// #25 launch-input mistakes name the input instead of a bare code.
import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {buildManifest} from './cm-spec-manifest.mjs';
import {readRunDefinition,openControlRun} from './cm-ai-run.mjs';
import {createConversationExecution} from './cm-ai-host.mjs';
import {createHostToolBridge} from '../runtime/js/cm-ai/host-tool-bridge.mjs';

const home=fs.mkdtempSync(path.join(os.tmpdir(),'cm-launch-diagnostics-home-'));
process.env.CM_WORKFLOW_HOME=path.join(home,'user');process.env.CM_WORKFLOW_LOG_HOME=path.join(home,'logs');
after(()=>fs.rmSync(home,{recursive:true,force:true}));
const cli=fileURLToPath(new URL('./cm-ai-host.mjs',import.meta.url));
const driver=fileURLToPath(new URL('./cm-ai-drive.mjs',import.meta.url));
const identity={repositoryId:'launch-fixture',runId:'launch-fixture-run',taskId:'T-001',attempt:1};

function fixture(t){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-launch-diagnostics-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const specsDir=path.join(root,'specs'),codeProject=path.join(root,'code'),feature='1.work';
  fs.mkdirSync(codeProject);fs.mkdirSync(path.join(specsDir,feature),{recursive:true});
  for(const name of ['requirements.md','design.md'])fs.writeFileSync(path.join(specsDir,feature,name),'# Fixture\n');
  fs.writeFileSync(path.join(specsDir,feature,'tasks.md'),'- [ ] T-001: fixture\n');
  fs.writeFileSync(path.join(specsDir,'.cm-specs-status'),JSON.stringify({status:'approved',features:[feature],specFiles:buildManifest(specsDir)}));
  fs.writeFileSync(path.join(codeProject,'requirements.md'),'# Fixture\n');
  const config=path.join(root,'run.json'),review=path.join(root,'review.json'),workflow=path.join(root,'workflow.json');
  fs.writeFileSync(config,JSON.stringify({version:1,specsDir,codeProject,feature,identity,scope:['target.mjs'],requirements:['requirements.md']}));
  fs.writeFileSync(review,JSON.stringify({model:'fixture',preflight:{}}));
  fs.writeFileSync(workflow,JSON.stringify({documentationPaths:[],applicableAgentFiles:[],qa:null}));
  const env={...process.env,CM_WORKFLOW_HOME:path.join(root,'home'),CM_WORKFLOW_LOG_HOME:path.join(root,'logs'),NODE_NO_WARNINGS:'1'};
  const host=(mode,{hostContext='session-a',extra=[]}={})=>{
    const result=spawnSync(process.execPath,[cli,'serve','--config',config,'--mode',mode,'--host-context',hostContext,
      '--allow-development',...extra],{encoding:'utf8',env,timeout:20000,
      input:JSON.stringify({version:1,operation:'status',requestId:'status',identity})+'\n'});
    const line=result.stderr.split('\n').find(item=>item.startsWith('{"error"'));
    return {...result,error:line?JSON.parse(line).error:null};
  };
  return {root,specsDir,codeProject,config,review,workflow,env,host};
}

test('create without --review-config is refused with the reason and leaves no run',t=>{
  const f=fixture(t);
  const refused=f.host('create');
  assert.equal(refused.status,1);assert.equal(refused.error.code,'review_configuration_required');
  assert.match(refused.error.reason,/--review-config/);assert.match(refused.error.reason,/preflight/);
  assert.equal(fs.existsSync(path.join(f.specsDir,'.reviews','.execution',identity.runId)),false);
  const created=f.host('create',{extra:['--review-config',f.review]});
  assert.equal(created.status,0,created.stderr);
});

test('fingerprint_mismatch names the launch input that differs',t=>{
  const f=fixture(t);
  assert.equal(f.host('create',{extra:['--runtime','claude','--review-config',f.review]}).status,0);
  const same=f.host('resume',{extra:['--runtime','claude','--review-config',f.review]});
  assert.equal(same.status,0,same.stderr);
  for(const [label,options,pattern] of [
    ['runtime omitted',{extra:['--review-config',f.review]},/--runtime：创建时为 claude，本次为 codex/],
    ['review config omitted',{extra:['--runtime','claude']},/--review-config：创建时用了审查模型 fixture，本次没有提供/],
    ['other session without --original-host-context',{hostContext:'session-b',extra:['--runtime','claude','--review-config',f.review]},
      /--host-context：创建会话为 session-a.*--original-host-context session-a/],
    ['workflow config added',{extra:['--runtime','claude','--review-config',f.review,'--workflow-config',f.workflow]},
      /--workflow-config/],
  ]){
    const result=f.host('resume',options);
    assert.equal(result.status,1,label);assert.equal(result.error.code,'fingerprint_mismatch',label);
    assert.match(result.error.reason,pattern,label);
  }
  // The explicit cross-session form still reopens: the diagnosis never widens the check.
  assert.equal(f.host('resume',{hostContext:'session-b',extra:['--original-host-context','session-a',
    '--runtime','claude','--review-config',f.review]}).status,0);
});

test('a legacy run created without review config explains why the config cannot be added on resume',async t=>{
  const f=fixture(t),bridge=createHostToolBridge();
  try{
    // Shape written by earlier versions: no review binding at create.
    const definition=readRunDefinition(f.config);
    const created=await openControlRun(definition,'create',createConversationExecution(definition,'session-a',bridge,null,null,null,false,'claude'));
    created.close();
  }finally{bridge.close();}
  const result=f.host('resume',{extra:['--runtime','claude','--review-config',f.review]});
  assert.equal(result.status,1);assert.equal(result.error.code,'fingerprint_mismatch');
  assert.match(result.error.reason,/创建时没有审查配置.*不能补加.*cancel/);
  assert.equal(f.host('resume',{extra:['--runtime','claude']}).status,0,'the original launch still reopens it');
});

test('driver PLAN without runtime reaches the host diagnosis for a Claude run',t=>{
  const f=fixture(t);
  assert.equal(f.host('create',{extra:['--runtime','claude','--review-config',f.review]}).status,0);
  const plan=path.join(f.root,'plan.json');
  fs.writeFileSync(plan,JSON.stringify({config:'run.json',mode:'resume',hostContext:'session-a',
    permissions:['--review-config','review.json']}));
  const result=spawnSync(process.execPath,[driver,'--plan',plan,'status'],{encoding:'utf8',env:f.env,timeout:30000});
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/fingerprint_mismatch/);assert.match(result.stderr,/--runtime：创建时为 claude/);
});

test('invalid_arguments names the argument',t=>{
  const f=fixture(t);
  for(const [extra,pattern] of [
    [['--allow-qa','--review-config',f.review],/--allow-qa 需要同时提供 --workflow-config/],
    [['--workflow-config',f.workflow,'--allow-qa','--review-config',f.review],/qa 不为 null/],
    [['--browser-qa','available','--review-config',f.review],/没有适用的交互式 QA/],
    [['--no-such-flag'],/未知参数：--no-such-flag/],
    [['--review-config',f.review,'--review-config',f.review],/参数重复：--review-config/],
    [['--allow-review-attempt','3','--review-config',f.review],/只接受 1 或 2/],
    [['--input-limit','12'],/--input-limit/],
  ]){
    const result=f.host('create',{extra});
    assert.equal(result.status,1,extra.join(' '));assert.equal(result.error.code,'invalid_arguments',extra.join(' '));
    assert.match(result.error.reason,pattern,extra.join(' '));
  }
});

test('usage marks --review-config as required at create',()=>{
  const help=spawnSync(process.execPath,[cli,'--help'],{encoding:'utf8'});
  assert.equal(help.status,0);assert.match(help.stdout,/--allow-development --review-config PATH \(required at create/);
  assert.doesNotMatch(help.stdout,/\[--review-config PATH\]/);
});
