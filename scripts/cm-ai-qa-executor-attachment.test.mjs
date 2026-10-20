import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
import {readQaExecutorAttachment,validateQaExecutorAttachment,qaExecutorAttachmentIn,
  validateQaExecutorAttachmentReason} from '../runtime/js/cm-ai/qa-executor-attachment.mjs';
import {createConversationExecution} from '../runtime/js/cm-ai/host-conversation-execution.mjs';
import {implicitHostQaDecision,isQaExecutorAttachment,preQaExecutorMaterial,
  createAttachedHostQaCapabilities} from '../runtime/js/cm-ai/host-workflow-capabilities.mjs';
import {runConfigMaterial} from './cm-ai-run.mjs';
import {buildManifest} from './cm-spec-manifest.mjs';

const hash=name=>digest({name});
const policy={version:2,development:'conversation',bootstrap:'disabled',qa:'disabled',qaFix:'disabled'};
const record=()=>({version:1,fromFingerprint:hash('original'),toFingerprint:hash('attached'),executorDigest:hash('executor'),
  sourceRevision:hash('source'),packageDigest:hash('package'),taskCommitDigest:hash('commit'),decisionId:'qa-decision-1',
  decisionDigest:hash('decision'),taskAttempt:1,reason:'Resume mandatory QA with the built-in executor.',
  hostContextId:'host-context-1',attachedAt:'2026-10-16T20:00:00Z'});
const context=()=>({fingerprints:{workflow:hash('workflow'),config:hash('original'),inputs:hash('inputs')},
  identity:{repositoryId:'fixture',runId:'run-1',taskId:'T-001',attempt:1},packageDigest:hash('package'),
  taskCommitDigest:hash('commit'),state:'fixture_completed',code:null,pending:null,previous:null,
  sourceRevision:hash('source'),controlPolicy:{...policy}});
const row=(type,value=record())=>({payload:{type,record:value}});

test('attachment validates without changing original fingerprints or input record',()=>{
  const input=record(),ctx=context(),before=structuredClone(ctx),saved=structuredClone(input);
  const result=validateQaExecutorAttachment(input,ctx);
  assert.deepEqual(result,saved);assert.ok(Object.isFrozen(result));
  assert.deepEqual(input,saved);assert.deepEqual(ctx,before);
  assert.deepEqual(readQaExecutorAttachment(input),saved);
  const second={...input,taskAttempt:2};
  assert.deepEqual(validateQaExecutorAttachment(second,{...ctx,identity:{...ctx.identity,attempt:2}}),second);
});

test('record rejects extra, missing and accessor properties without executing getters',()=>{
  assert.throws(()=>readQaExecutorAttachment({...record(),extra:true}));
  for(const key of Object.keys(record())){
    const value=record();delete value[key];assert.throws(()=>readQaExecutorAttachment(value),key);
  }
  let called=false;const value=record();Object.defineProperty(value,'reason',{enumerable:true,get(){called=true;return 'x';}});
  assert.throws(()=>readQaExecutorAttachment(value));assert.equal(called,false);
  const symbol=record();symbol[Symbol('hidden')]=true;assert.throws(()=>readQaExecutorAttachment(symbol));
});

test('record enforces digest, identity, attempt and canonical second-resolution time syntax',()=>{
  for(const key of ['fromFingerprint','toFingerprint','executorDigest','sourceRevision','packageDigest','taskCommitDigest','decisionDigest']){
    for(const value of [null,'a'.repeat(63),'A'.repeat(64),'g'.repeat(64)]){
      assert.throws(()=>readQaExecutorAttachment({...record(),[key]:value}),`${key}: ${value}`);
    }
  }
  assert.throws(()=>readQaExecutorAttachment({...record(),toFingerprint:record().fromFingerprint}));
  for(const key of ['decisionId','hostContextId'])for(const value of ['', '../outside','x\ny','x'.repeat(129)]){
    assert.throws(()=>readQaExecutorAttachment({...record(),[key]:value}));
  }
  for(const value of [0,3,'1',null])assert.throws(()=>readQaExecutorAttachment({...record(),taskAttempt:value}));
  for(const value of [0,2,'1'])assert.throws(()=>readQaExecutorAttachment({...record(),version:value}));
  for(const attachedAt of [null,'2026-10-16T20:00:00.000Z','2026-10-16T20:00:00+00:00',
    '2026-02-30T20:00:00Z','2026-13-16T20:00:00Z','2026-10-16T24:00:00Z']){
    assert.throws(()=>readQaExecutorAttachment({...record(),attachedAt}));
  }
});

test('reason has one nonempty line and a UTF-8 byte budget',()=>{
  for(const reason of ['', '   ',null,'x\ny','x\ry','x\0y','x\ty','x\u007fy','x\u2028y','x\u2029y','é'.repeat(251)]){
    assert.throws(()=>readQaExecutorAttachment({...record(),reason}));
    assert.throws(()=>validateQaExecutorAttachmentReason(reason));
  }
  for(const reason of ['x'.repeat(500),'é'.repeat(250),'理由'.repeat(83)+'ab']){
    assert.equal(validateQaExecutorAttachmentReason(reason),reason);
    assert.equal(readQaExecutorAttachment({...record(),reason}).reason,reason);
  }
});

test('attachment binds package, task commit, original fingerprint, attempt and source revision',()=>{
  for(const key of ['packageDigest','taskCommitDigest','sourceRevision']){
    assert.throws(()=>validateQaExecutorAttachment(record(),{...context(),[key]:hash('changed')}),key);
    assert.throws(()=>validateQaExecutorAttachment(record(),{...context(),[key]:null}),key);
  }
  const ctx=context();ctx.fingerprints.config=hash('other');
  assert.throws(()=>validateQaExecutorAttachment(record(),ctx));
  assert.throws(()=>validateQaExecutorAttachment(record(),{...context(),identity:{...context().identity,attempt:2}}));
  assert.throws(()=>validateQaExecutorAttachment(record(),{...context(),identity:null}));
});

test('attachment refuses incomplete, drifted, pending or already-attached targets',()=>{
  for(const state of ['idle','awaiting_review','blocked','unknown',null]){
    assert.throws(()=>validateQaExecutorAttachment(record(),{...context(),state}));
  }
  for(const code of ['correction_review_required','cancelled',undefined]){
    assert.throws(()=>validateQaExecutorAttachment(record(),{...context(),code}));
  }
  for(const pending of [{type:'effect-intent'},false,undefined]){
    assert.throws(()=>validateQaExecutorAttachment(record(),{...context(),pending}));
  }
  for(const previous of [record(),{},undefined]){
    assert.throws(()=>validateQaExecutorAttachment(record(),{...context(),previous}));
  }
});

test('attachment is restricted to the frozen v2 single-conversation disabled policy',()=>{
  for(const [key,value] of [['version',1],['development','provider'],['bootstrap','write'],['qa','run'],['qaFix','manual']]){
    assert.throws(()=>validateQaExecutorAttachment(record(),{...context(),controlPolicy:{...policy,[key]:value}}),key);
  }
  for(const controlPolicy of [null,{...policy,extra:true},{version:2,qa:'disabled'}]){
    assert.throws(()=>validateQaExecutorAttachment(record(),{...context(),controlPolicy}));
  }
});

test('snapshot scanner accepts absence or one schema-valid attachment and rejects competing chains',()=>{
  assert.equal(qaExecutorAttachmentIn({records:[]}),null);
  assert.equal(qaExecutorAttachmentIn({records:[row('init'),row('qa-attached')]}),null);
  assert.deepEqual(qaExecutorAttachmentIn({records:[row('init'),row('qa-executor-attached')]}),record());
  assert.throws(()=>qaExecutorAttachmentIn({records:[row('qa-executor-attached'),row('qa-executor-attached')]}));
  for(const legacy of ['qa-attached','qa-config-revised'])for(const records of [
    [row(legacy),row('qa-executor-attached')],[row('qa-executor-attached'),row(legacy)]]){
    assert.throws(()=>qaExecutorAttachmentIn({records}));
  }
  assert.throws(()=>qaExecutorAttachmentIn({records:[row('qa-executor-attached',{...record(),extra:true})]}));
});

function factoryFixture(t){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-qa-executor-material-')));
  const codeProject=path.join(root,'app'),specsDir=path.join(root,'specs'),feature='1.work';
  fs.mkdirSync(codeProject);fs.mkdirSync(path.join(specsDir,feature),{recursive:true});
  fs.writeFileSync(path.join(codeProject,'target.mjs'),'export const value=42;\n');
  for(const name of ['requirements.md','design.md'])fs.writeFileSync(path.join(specsDir,feature,name),'# Fixture\n');
  fs.writeFileSync(path.join(specsDir,feature,'tasks.md'),'- [x] T-001: completed fixture\n- [ ] T-002: pending fixture\n');
  fs.writeFileSync(path.join(specsDir,'.cm-specs-status'),JSON.stringify({status:'approved',features:[feature],specFiles:buildManifest(specsDir)}));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const marker=path.join(codeProject,'must-not-run'),calls=[];
  const definition={version:1,codeProject,specsDir,feature,
    identity:{repositoryId:'material-fixture',runId:'material-run',taskId:'T-001',attempt:1},scope:['target.mjs'],requirements:[]};
  const bridge={call:async(...args)=>{calls.push(args);throw Error('factory must not dispatch');}};
  const qa={commands:[{id:'sentinel',command:[process.execPath,'-e',
    `require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran')`],caseIds:[]}],
    environment:{kind:'web',carrier:'browser',target:'fixture',scope:'local'}};
  return {root,definition,qa,bridge,calls,marker,
    execution:(configuration=null,options={},workflow=null,allowQa=false)=>createConversationExecution(definition,'material-author',bridge,
      null,null,workflow,allowQa,'codex',{controlPolicy:policy,...options,
        ...(configuration===null?{}:{qaExecutorConfiguration:configuration})})};
}

test('factory attachment adds only executor material and a bound attachment discriminator',t=>{
  const f=factoryFixture(t),original=f.execution(),attached=f.execution(f.qa);
  const before=runConfigMaterial(f.definition,original),after=runConfigMaterial(f.definition,attached);
  assert.equal(isQaExecutorAttachment(attached),true);assert.equal(implicitHostQaDecision(attached),true);
  assert.deepEqual(attached.configuration,original.configuration);
  assert.equal(Object.hasOwn(after,'qaDecisionProvider'),false);assert.equal(Object.hasOwn(after,'qaTimeoutMs'),false);
  assert.deepEqual(after.qaExecutorAttachment,{version:1,requestTimeoutMs:60000});assert.ok(after.qaExecutor);
  const {qaExecutor,qaExecutorAttachment,...prior}=after;
  assert.deepEqual(prior,before);assert.equal(digest(prior),digest(before));
  assert.deepEqual(preQaExecutorMaterial(attached,after),before);
  assert.equal(attached.documentationProvider,undefined);assert.equal(attached.documentationSync,undefined);
  assert.deepEqual(attached.applicableAgentFiles,[]);assert.equal(attached.qaLogHome,undefined);
  assert.equal(f.calls.length,0);assert.equal(fs.existsSync(f.marker),false);
  assert.equal(fs.existsSync(path.join(f.definition.specsDir,'运行日志.jsonl')),false);
});

test('factory attachment preserves the original default log selection and honors its environment override',t=>{
  const f=factoryFixture(t),saved=process.env.CM_WORKFLOW_LOG_HOME;
  try{
    delete process.env.CM_WORKFLOW_LOG_HOME;
    const defaultExecution=f.execution(f.qa);
    assert.equal(defaultExecution.qaLogHome,undefined);
    assert.equal(defaultExecution.qaExecutor.configuration.logHome,path.join(os.homedir(),'.cm-workflow','logs'));
    const mirror=path.join(f.root,'isolated-logs');process.env.CM_WORKFLOW_LOG_HOME=mirror;
    const overridden=f.execution(f.qa);
    assert.equal(overridden.qaLogHome,undefined);assert.equal(overridden.qaExecutor.configuration.logHome,mirror);
    process.env.CM_WORKFLOW_LOG_HOME='~/.cm-workflow/fixture-logs';
    assert.equal(f.execution(f.qa).qaExecutor.configuration.logHome,path.join(os.homedir(),'.cm-workflow','fixture-logs'));
    assert.equal(f.calls.length,0);assert.equal(fs.existsSync(mirror),false);
  }finally{
    if(saved===undefined)delete process.env.CM_WORKFLOW_LOG_HOME;else process.env.CM_WORKFLOW_LOG_HOME=saved;
  }
});

test('attachment request timeout is fingerprinted without changing the original decision timeout',t=>{
  const f=factoryFixture(t),original=f.execution(),first=f.execution({...f.qa,timeoutMs:1234}),second=f.execution({...f.qa,timeoutMs:2345});
  const before=runConfigMaterial(f.definition,original),a=runConfigMaterial(f.definition,first),b=runConfigMaterial(f.definition,second);
  assert.equal(first.qaDecisionProvider.timeoutMs,original.qaDecisionProvider.timeoutMs);
  assert.equal(first.qaDecisionProvider.timeoutMs,60000);
  assert.deepEqual(a.qaExecutorAttachment,{version:1,requestTimeoutMs:1234});
  assert.deepEqual(b.qaExecutorAttachment,{version:1,requestTimeoutMs:2345});
  assert.notEqual(digest(a),digest(b));assert.deepEqual(a.qaExecutor,b.qaExecutor);
  assert.deepEqual(preQaExecutorMaterial(first,a),before);assert.deepEqual(preQaExecutorMaterial(second,b),before);
});

test('attachment config cannot smuggle critical-path, documentation or unrelated capabilities',t=>{
  const f=factoryFixture(t);
  for(const extra of [{criticalPaths:{}},{documentationPaths:[]},{applicableAgentFiles:[]},{qaFix:'auto'},{bootstrap:{}}]){
    assert.throws(()=>f.execution({...f.qa,...extra}));
  }
  for(const timeoutMs of [0,-1,3600001,1.5,'1000',null])assert.throws(()=>f.execution({...f.qa,timeoutMs}));
  for(const options of [{parallelMember:true},{qaLogHome:path.join(f.root,'other-logs')},
    {originalHostContextId:'different-author'}])assert.throws(()=>f.execution(f.qa,options));
  assert.throws(()=>f.execution(f.qa,{}, {qa:null,documentationPaths:[],applicableAgentFiles:[]}));
  assert.throws(()=>f.execution(f.qa,{controlPolicy:{...policy,qa:'run'}},
    {qa:f.qa,documentationPaths:[],applicableAgentFiles:[]},true));
  assert.equal(f.calls.length,0);assert.equal(fs.existsSync(f.marker),false);
});

test('ordinary and copied executors cannot obtain the private attachment provenance',t=>{
  const f=factoryFixture(t),attached=f.execution(f.qa),material=runConfigMaterial(f.definition,attached);
  const replacements=[{timeoutMs:60000,mode:'commands',caseCount:1},
    {...attached.qaExecutor},Object.freeze({...attached.qaExecutor,requestTimeoutMs:1234})];
  for(const qaExecutor of replacements){
    const custom={...attached,qaExecutor};
    assert.equal(isQaExecutorAttachment(custom),false);assert.equal(implicitHostQaDecision(custom),false);
    assert.throws(()=>preQaExecutorMaterial(custom,material),{code:'qa_executor_attachment_required'});
    const customMaterial=runConfigMaterial(f.definition,custom);
    assert.equal(Object.hasOwn(customMaterial,'qaExecutorAttachment'),false);assert.equal(customMaterial.qaDecisionProvider,'host-v1');
  }
  assert.throws(()=>preQaExecutorMaterial(f.execution(),material),{code:'qa_executor_attachment_required'});
});

test('a marked executor cannot hide material when moved into workflow, parallel or enabled-QA contexts',t=>{
  const f=factoryFixture(t),attached=f.execution(f.qa),material=runConfigMaterial(f.definition,attached);
  const altered=[{...attached.configuration,workflow:{qa:f.qa,documentationPaths:[],applicableAgentFiles:[]}},
    {...attached.configuration,parallelMember:true},
    {...attached.configuration,controlPolicy:{...policy,qa:'run'}},
    {...attached.configuration,controlPolicy:{...policy,bootstrap:'write'}},
    {...attached.configuration,controlPolicy:{...policy,qaFix:'manual'}}];
  for(const configuration of altered){
    const moved={...attached,configuration};
    assert.equal(isQaExecutorAttachment(moved),false);
    assert.throws(()=>preQaExecutorMaterial(moved,material),{code:'qa_executor_attachment_required'});
    const movedMaterial=runConfigMaterial(f.definition,moved);
    assert.equal(Object.hasOwn(movedMaterial,'qaExecutorAttachment'),false);assert.equal(movedMaterial.qaDecisionProvider,'host-v1');
    assert.throws(()=>createAttachedHostQaCapabilities({definition:f.definition,configuration,
      qa:f.qa,bridge:f.bridge,runtime:'codex'}),{code:'qa_executor_attachment_required'});
  }
});
