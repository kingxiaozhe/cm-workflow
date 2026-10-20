import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {openPrdSession} from '../runtime/js/cm-prd/session.mjs';
import {createCmPrdAnalysis} from '../runtime/js/cm-prd/analysis.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
import {EXECUTION_POLICY_V1} from '../runtime/js/cm-ai/execution-policy.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const sessionId='prd-blocked-planning';
async function fixture(t,{version=1}={}){
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-prd-planning-recovery-')));
  const sessions=[];t.after(()=>{for(const session of sessions)session.close();fs.rmSync(dir,{recursive:true,force:true});});fs.mkdirSync(path.join(dir,'docs'));
  fs.writeFileSync(path.join(dir,'docs/input.md'),'Use the confirmed prototype pixel baseline');
  const entry={skillDir:path.join(root,'skills/cm-prd'),project:dir,specs:dir},identity={entry,runtime:'codex'};
  const analysis=createCmPrdAnalysis({input:entry,runtime:'codex',record:()=>{},
    analyze:async()=>({status:'analyzed',summary:'Confirmed visual requirement',sourcePaths:['docs/input.md'],openQuestions:[]}),
    generate:async()=>({status:'blocked',reason:'No owner baseline import entry'})});
  await analysis.advance('Warm glass, two warm skins, confirmed prototype pixels');
  await analysis.plan('Save pixel baseline first',{designOnly:true});
  const open=()=>{const owner=openPrdSession({specs:dir,sessionId,identity,executionPolicy:version===2?EXECUTION_POLICY_V1:null});
    const close=owner.close;let closed=false;owner.close=()=>{if(!closed){close();closed=true;}};sessions.push(owner);return owner;};
  const session=open();session.checkpoint({analysis:analysis.checkpoint(),change:null,started:true,routeTurn:2,
    reviewState:null,summaryState:null,publishedSummary:false});session.segment('design_generation');session.close();
  const stateFile=path.join(dir,'.reviews/prd-sessions',sessionId,'state.json');
  return {dir,entry,analysis,open,stateFile,read:()=>JSON.parse(fs.readFileSync(stateFile,'utf8'))};
}
const request=session=>({...session.inspectPlanningRecovery(),reason:'The baseline owner entry is now implemented'});
for(const version of [1,2])test(`planning recovery preserves original v${version} state and is idempotent after restart`,async t=>{
  const f=await fixture(t,{version});let session=f.open();t.after(()=>{if(session){session.close();session=null;}});
  const original=session.state,originalBytes=fs.readFileSync(f.stateFile,'utf8'),binding=request(session);let validations=0;
  const validateCurrent=()=>{validations++;f.analysis.validateCurrent();};
  assert.equal(fs.readFileSync(f.stateFile,'utf8'),originalBytes,'inspection is read-only');
  assert.equal(binding.sessionId,sessionId);assert.equal(binding.checkpointDigest,digest(original.checkpoint));
  const result=session.recoverPlanning(binding,{validateCurrent});
  assert.equal(result.outcome,'planning_recovered');assert.equal(result.completionAuthorized,false);assert.equal(validations,1);
  const expected=structuredClone(original);expected.checkpoint.analysis.stage='analysis_ready';expected.planningRecoveries=session.state.planningRecoveries;
  assert.deepEqual(session.state,expected);assert.equal(session.state.version,version);
  assert.deepEqual(result.recovery.originalCheckpoint,original.checkpoint);
  assert.deepEqual(result.recovery.binding,binding);assert.equal(session.state.planningRecoveries.length,1);
  assert.equal(result.recovery.recordDigest,digest(Object.fromEntries(Object.entries(result.recovery).filter(([key])=>key!=='recordDigest'))));
  const afterBytes=fs.readFileSync(f.stateFile,'utf8');session.close();session=f.open();
  assert.deepEqual(session.recoverPlanning(binding,{validateCurrent}),result);assert.equal(validations,2);
  assert.equal(fs.readFileSync(f.stateFile,'utf8'),afterBytes,'idempotent retry does not rewrite the session');
  assert.throws(()=>session.recoverPlanning({...binding,reason:'Changed reason'},{validateCurrent}),/prd_planning_recovery_conflict/);
  assert.equal(fs.readFileSync(f.stateFile,'utf8'),afterBytes);
});
for(const field of ['sessionId','checkpointDigest','sourceDigest','configDigest','blockedReplyDigest'])
  test(`planning recovery rejects wrong ${field} without changing state`,async t=>{
    const f=await fixture(t),session=f.open();t.after(()=>session.close());const binding=request(session),before=session.state;
    const wrong=field==='sessionId'?'prd-other-session':'f'.repeat(64);
    assert.throws(()=>session.recoverPlanning({...binding,[field]:wrong},{validateCurrent:()=>f.analysis.validateCurrent()}),/prd_planning_recovery_binding/);
    assert.deepEqual(session.state,before);
  });
for(const mode of ['active','cancelled','unanalysed','not-design','no-blocked-reply','draft','designDraft','acceptedDesign','designRiskSelection','designPromotion','contextCheck','round','history','review','summary','published','change'])
  test(`planning recovery refuses ${mode} boundary`,async t=>{
    const f=await fixture(t),session=f.open();t.after(()=>session.close());const checkpoint=structuredClone(session.state.checkpoint),a=checkpoint.analysis;
    if(mode==='active')session.begin({requestId:'pending',operation:'plan_design',text:'Pending'},checkpoint);
    else{
      if(mode==='cancelled')a.stage='cancelled';
      if(mode==='unanalysed')a.result={status:'question',question:'Not done'};
      if(mode==='not-design')a.designPlanning=false;
      if(mode==='no-blocked-reply')a.planning.at(-1).result={status:'question',question:'Choose'};
      if(['draft','designDraft','acceptedDesign','designRiskSelection','designPromotion','contextCheck'].includes(mode))a[mode]={present:true};
      if(mode==='round')a.selfCheckRound=1;if(mode==='history')a.selfCheckHistory=[{round:1}];
      if(mode==='review')checkpoint.reviewState={status:'review_recorded'};
      if(mode==='summary')checkpoint.summaryState={present:true};if(mode==='published')checkpoint.publishedSummary=true;
      if(mode==='change')checkpoint.change={stage:'change_design'};
      session.checkpoint(checkpoint);
    }
    const before=session.state;assert.throws(()=>session.inspectPlanningRecovery(),/prd_planning_recovery_not_ready/);assert.deepEqual(session.state,before);
  });
test('planning recovery rejects drift, absent validation and asynchronous validation before any write',async t=>{
  const f=await fixture(t),session=f.open();t.after(()=>session.close());const binding=request(session),before=session.state;
  assert.throws(()=>session.recoverPlanning(binding),/prd_planning_recovery_validation_required/);
  assert.throws(()=>session.recoverPlanning(binding,{validateCurrent:async()=>{}}),/prd_planning_recovery_validation_async/);
  fs.writeFileSync(path.join(f.dir,'docs/input.md'),'Changed source');
  assert.throws(()=>session.recoverPlanning(binding,{validateCurrent:()=>f.analysis.validateCurrent()}),/prd_inputs_changed/);
  assert.deepEqual(session.state,before);
});
test('planning recovery rejects malformed or extended binding and preserves counts',async t=>{
  const f=await fixture(t),session=f.open();t.after(()=>session.close());const binding=request(session),before=session.state;
  for(const bad of [{...binding,extra:true},{...binding,reason:''},{...binding,reason:'bad\nreason'}, {...binding,reason:'x'.repeat(1001)},null])
    assert.throws(()=>session.recoverPlanning(bad,{validateCurrent:()=>f.analysis.validateCurrent()}));
  assert.deepEqual(session.state,before);
});
test('one recovery cannot be reused as an unbounded retry and recorded history corruption is rejected',async t=>{
  const f=await fixture(t),session=f.open();t.after(()=>session.close());const binding=request(session);
  session.recoverPlanning(binding,{validateCurrent:()=>f.analysis.validateCurrent()});
  assert.throws(()=>session.inspectPlanningRecovery(),/prd_planning_recovery_limit/);
  const checkpoint=structuredClone(session.state.checkpoint);checkpoint.analysis.stage='blocked';session.checkpoint(checkpoint);
  assert.throws(()=>session.inspectPlanningRecovery(),/prd_planning_recovery_limit/);
  const changed=structuredClone(session.state);changed.planningRecoveries[0].originalCheckpoint.analysis.messages[0].text='Forged';
  session.close();fs.writeFileSync(f.stateFile,JSON.stringify(changed),{mode:0o600});
  const reopened=f.open();assert.throws(()=>reopened.recoverPlanning(binding,{validateCurrent:()=>f.analysis.validateCurrent()}),/prd_planning_recovery_binding/);reopened.close();
});

test('recovered session can register another normal operation without freezing its mutable owner state',async t=>{
  const f=await fixture(t),session=f.open(),binding=request(session);
  session.recoverPlanning(binding,{validateCurrent:()=>f.analysis.validateCurrent()});
  const before=session.state.checkpoint;session.begin({requestId:'plan-again',operation:'plan_design',text:'Continue'},before);
  const reply=await session.call('prd_generate',{phase:'design'},new AbortController().signal,async()=>({status:'question',question:'Fixture'}));
  assert.equal(reply.status,'question');session.commit(before);assert.equal(session.state.active,null);
  assert.equal(session.state.planningRecoveries.length,1);
});
test('planning recovery detects durable and in-memory changes during validation without replacing them',async t=>{
  for(const mode of ['file','memory']){
    const f=await fixture(t),session=f.open(),binding=request(session),before=session.state;
    if(mode==='file'){
      const bytes=fs.readFileSync(f.stateFile,'utf8');
      assert.throws(()=>session.recoverPlanning(binding,{validateCurrent:()=>{fs.writeFileSync(f.stateFile,bytes+' ');}}),/prd_write_conflict/);
      assert.deepEqual(session.state,before);assert.equal(fs.readFileSync(f.stateFile,'utf8'),bytes+' ');
    }else{
      assert.throws(()=>session.recoverPlanning(binding,{validateCurrent:()=>session.segment('unrelated')}),/prd_planning_recovery_conflict/);
      assert.equal(session.state.checkpoint.analysis.stage,'blocked');assert.equal(session.state.segments.unrelated,1);
      assert.equal(session.state.planningRecoveries,undefined);
    }
  }
});
test('planning recovery rejects current configuration drift and does not replace its frozen digest',async t=>{
  const f=await fixture(t),session=f.open(),binding=request(session),before=session.state;
  fs.writeFileSync(path.join(f.dir,'.cm-workflow.json'),JSON.stringify({version:1,policies:{generate_cases:false}}));
  assert.throws(()=>session.recoverPlanning(binding,{validateCurrent:()=>f.analysis.validateCurrent()}),/prd_inputs_changed/);
  assert.deepEqual(session.state,before);assert.equal(session.state.planningRecoveries,undefined);
});

test('idempotent binding cannot reopen a subsequently cancelled session',async t=>{
  const f=await fixture(t),session=f.open(),binding=request(session);
  session.recoverPlanning(binding,{validateCurrent:()=>f.analysis.validateCurrent()});
  const cancelled=structuredClone(session.state.checkpoint);cancelled.analysis.stage='cancelled';session.checkpoint(cancelled);
  const before=session.state;
  assert.throws(()=>session.recoverPlanning(binding,{validateCurrent:()=>f.analysis.validateCurrent()}),/prd_planning_recovery_not_ready/);
  assert.deepEqual(session.state,before);
});
