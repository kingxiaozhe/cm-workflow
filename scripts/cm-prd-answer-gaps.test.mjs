// P1-4 (O02, O05/O06): a recorded answer the host then refused can be discarded
// and asked again under the same pending operation (real prd-4b8e48aa shape:
// change-mode prd_generate); one interrupted or unpublishable prd_review attempt
// can be abandoned with an explicit flag and reason, releasing the gate claim
// for a fresh independent review (real prd-29b5f91e shape: a split review that
// came back self-degraded for an independent request). A recorded review that
// would publish is never abandoned.
import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {inspectPrdReview} from './cm-prd-review-gate.mjs';
import {openPrdSession} from '../runtime/js/cm-prd/session.mjs';

const isolatedWorkflowHome=fs.mkdtempSync(path.join(os.tmpdir(),'cm-prd-gaps-home-'));
process.env.CM_WORKFLOW_HOME=path.join(isolatedWorkflowHome,'user');
process.env.CM_WORKFLOW_LOG_HOME=path.join(isolatedWorkflowHome,'logs');
after(()=>fs.rmSync(isolatedWorkflowHome,{recursive:true,force:true}));
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const version='\n| 日期 | 版本 | 说明 |\n| --- | --- | --- |\n| 2026-09-08 | v1 | original |\n';
const docs=()=>[
  {path:'requirements.md',content:'## 需求版本'+version+'\n## 功能需求\n1. [F-001] Guide\n- [ ] [AC-001] Read guide\n'},
  {path:'design.md',content:'## 设计版本'+version+'\n## 方案摘要\nExisting guide\n'},
  {path:'tasks.md',content:'## 任务版本'+version+'\n- [x] T-001: Existing guide\n- [ ] T-002: Draft appendix\n'}];
const revised=()=>docs().map(doc=>({path:doc.path,content:doc.content.replace('| 2026-09-08 | v1 | original |','| 2026-09-08 | v1 | original |\n| 2026-09-08 | v2 | change |')
  +(doc.path==='tasks.md'?'\n- [ ] T-003: [NEW] Add example\n':'\nUpdated example\n')}));
function fixture(t){const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-prd-gaps-')));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));fs.mkdirSync(path.join(dir,'docs'));fs.mkdirSync(path.join(dir,'mirror'));
  fs.writeFileSync(path.join(dir,'docs/input.md'),'Synthetic guide');fs.mkdirSync(path.join(dir,'1.guide'));
  for(const doc of docs())fs.writeFileSync(path.join(dir,'1.guide',doc.path),doc.content,{mode:0o600});return dir;}
async function client(t,dir,respond,{session,change=true,review=false,abandon=false}={}){
  const child=spawn(process.execPath,[path.join(root,'scripts/cm-prd-host.mjs'),'serve','--skill-dir',path.join(root,'skills/cm-prd'),
    '--project',dir,'--specs',dir,'--runtime','codex','--allow-log-write','--allow-spec-write',
    ...(change?['--change','1.guide']:[]),...(session?['--session',session]:[]),
    ...(review?['--allow-review-write','--allow-disposition-write','--host-context','synthetic-author']:[]),
    ...(abandon?['--allow-review-abandon']:[])],
    {env:{...process.env,CM_WORKFLOW_LOG_HOME:path.join(dir,'mirror')},stdio:['pipe','pipe','pipe']});
  t.after(()=>{if(child.exitCode===null)child.kill();});let error='',sessionId,seq=0;
  child.stderr.on('data',bytes=>error+=bytes);const pending=new Map();let readyResolve,readyReject;
  const ready=new Promise((yes,no)=>{readyResolve=yes;readyReject=no;});
  const send=value=>child.stdin.write(JSON.stringify(value)+'\n');
  createInterface({input:child.stdout}).on('line',line=>{const message=JSON.parse(line);
    if(message.type==='host_ready'){sessionId=message.sessionId;readyResolve();}
    else if(message.type==='host_request')Promise.resolve().then(()=>respond(message,child)).then(result=>{
      if(result!==undefined)send({type:'host_result',sessionId,callId:message.callId,requestDigest:message.requestDigest,result});
    }).catch(readyReject);
    else if(message.requestId&&pending.has(message.requestId)){pending.get(message.requestId)(message);pending.delete(message.requestId);}
  });
  child.on('close',code=>{if(!sessionId)readyReject(Error(error));for(const resolve of pending.values())resolve({closed:code,error});pending.clear();});
  await ready;
  return {stderr:()=>error,request:async(operation,fields={})=>{const requestId=`test-${++seq}`;return new Promise(resolve=>{
    pending.set(requestId,resolve);send({requestId,operation,...fields});});},
    close:async()=>{send({type:'host_close',sessionId});const [code]=await once(child,'close');assert.equal(code,0,error);}};
}
const stateOf=(dir,runId)=>JSON.parse(fs.readFileSync(path.join(dir,'.reviews/prd-sessions',runId,'state.json'),'utf8'));
const generate=payload=>{const all=revised(),full=payload.phase==='change_tasks';
  return {status:full?'draft':'documents',summary:'Add example',features:[{directory:'1.guide',
    documents:all.filter(doc=>full||doc.path==='requirements.md'||payload.phase==='change_design'&&doc.path==='design.md'),
    ...(full?{testCasesReason:'no_observable_behavior'}:{})}],removed:[]};};

test('O02: a recorded prd_generate answer the host refused is discarded and asked again',{timeout:30000},async t=>{
  const dir=fixture(t);let bad=true,generated=0;
  const respond=({kind,payload})=>{
    if(kind==='prd_analyze')return {status:'analyzed',summary:'Add example',openQuestions:[]};
    assert.equal(kind,'prd_generate');generated++;
    // The refused shape: recorded first, validated after (features missing).
    return bad?{status:'documents',summary:'Add example',removed:[]}:generate(payload);
  };
  let c=await client(t,dir,respond);
  assert.equal((await c.request('start',{text:'Add example'})).result.stage,'change_requirements');
  assert.ok((await c.request('advance',{text:'Requirements'})).error,'the refused answer fails the operation');
  const {runId}=(await c.request('status')).result;await c.close();
  let state=stateOf(dir,runId);const recorded=state.active.calls.at(-1);
  assert.equal(recorded.kind,'prd_generate');assert.ok(Object.hasOwn(recorded,'result'));
  c=await client(t,dir,respond,{session:runId});
  // Before: a plain resume replays the same refused answer forever.
  assert.ok((await c.request('resume',{resolution:null})).error);
  assert.equal((await c.request('advance',{text:'again'})).result.reason,'prd_operation_recovery_required');
  const resolution={callId:recorded.callId,requestDigest:recorded.requestDigest,discard:true,evidence:'会话答复缺 features，被宿主拒收'};
  // prd_review / binding / evidence guards.
  assert.equal((await c.request('resume',{resolution:{...resolution,requestDigest:'wrong'}})).result.reason,'prd_recovery_binding');
  assert.equal((await c.request('resume',{resolution:{...resolution,evidence:' '}})).result.reason,'prd_recovery_evidence_required');
  bad=false;
  const reply=await c.request('resume',{resolution});
  assert.equal(reply.result?.stage,'change_design',JSON.stringify(reply)+c.stderr());
  assert.equal(generated,2,'asked again under the same pending operation');
  state=stateOf(dir,runId);
  assert.equal(state.active,null);assert.equal(state.discardedAnswers.length,1);
  assert.deepEqual([state.discardedAnswers[0].kind,state.discardedAnswers[0].callId,state.discardedAnswers[0].operation],
    ['prd_generate',recorded.callId,'advance']);
  await c.close();
});

test('O05/O06: an unpublishable recorded split review is abandoned with --allow-review-abandon, then reviewed afresh',{timeout:40000},async t=>{
  const dir=fixture(t);let reviews=0,degraded=true,conflict=false;
  const respond=({kind,payload})=>{
    if(kind==='prd_analyze')return {status:'analyzed',summary:'New documentation',sourcePaths:['docs/input.md'],openQuestions:[]};
    if(kind==='prd_generate')return {status:'draft',summary:'New guide',features:[{name:'new-guide',documents:docs().map(doc=>({
      ...doc,content:doc.content.replace('[x]','[ ]')})),testCasesReason:'no_observable_behavior'}]};
    if(kind==='prd_self_check')return {draftDigest:payload.draft.draftDigest,features:payload.draft.features.map(f=>({directory:f.directory,
      checks:payload.draft.mechanicalSelfCheck.pending.map(id=>({id,status:'passed',evidence:['Synthetic original context check']}))}))};
    assert.equal(kind,'prd_review');reviews++;
    if(conflict)fs.mkdirSync(path.join(dir,'.reviews/prd-new-guide-split-r1.md'));
    const result={verdict:'approved',packageDigest:payload.package.packageDigest,examinedPaths:payload.examinedPaths,findings:[],summary:'Synthetic no findings'};
    // The prd-29b5f91e shape: an independent request answered self-degraded with a degradedReason.
    return degraded?{reviewer:'self-degraded',contextId:'synthetic-author',independent:false,at:'2026-09-08T00:00:00.000Z',
      result,degradedReason:'Synthetic reviewer unavailable'}
      :{reviewer:'codex-subagent',contextId:'synthetic-independent',independent:true,at:'2026-09-08T00:00:00.000Z',result};
  };
  let c=await client(t,dir,respond,{change:false,review:true});
  await c.request('start',{text:'New guide'});await c.request('advance',{text:'Draft'});await c.request('advance',{text:'Check'});
  await c.request('save_draft');
  const runId=(await c.request('status')).result.runId;
  const initial=await c.request('final_review',{stage:'split',feature:'2.new-guide',mode:'independent'});
  assert.equal(initial.result.reviewState.status,'review_unknown',JSON.stringify(initial));
  await c.close();
  const gateArgs={stage:'split',feature:'new-guide',evidence:path.join(dir,'.reviews/prd-new-guide-split-r1.md'),
    receipt:path.join(dir,'.reviews/prd-new-guide-split-disposition.json')};
  assert.equal(inspectPrdReview(gateArgs).outcome,'dispatch_unknown');
  const call=stateOf(dir,runId).active.calls.find(item=>item.kind==='prd_review');
  const resolution={callId:call.callId,requestDigest:call.requestDigest,abandonReview:true,evidence:'独立审查回成了 self-degraded，原结果不可发布'};
  // Without the explicit flag the claim stays.
  c=await client(t,dir,respond,{session:runId,change:false,review:true});
  assert.equal((await c.request('resume',{resolution})).result.reason,'prd_review_abandon_not_enabled');await c.close();
  c=await client(t,dir,respond,{session:runId,change:false,review:true,abandon:true});
  const abandoned=await c.request('resume',{resolution});
  assert.equal(abandoned.result?.recovery,null,JSON.stringify(abandoned)+c.stderr());
  assert.equal(inspectPrdReview(gateArgs).outcome,'dispatch_once');
  const record=JSON.parse(fs.readFileSync(path.join(dir,'.reviews/prd-new-guide-split-dispatch-abandoned-1.json'),'utf8'));
  assert.deepEqual([record.status,record.call_id,record.reason],['abandoned',call.callId,resolution.evidence]);
  assert.equal(stateOf(dir,runId).abandonedReviews.length,1);
  // A fresh independent review is claimed, dispatched and published as the review evidence.
  degraded=false;
  const fresh=await c.request('final_review',{stage:'split',feature:'2.new-guide',mode:'independent'});
  assert.equal(fresh.result.reviewState.status,'review_recorded',JSON.stringify(fresh));
  assert.equal(reviews,2);assert.equal(fs.existsSync(path.join(dir,'.reviews/prd-new-guide-split-r2.md')),false);
  assert.equal(inspectPrdReview(gateArgs).outcome,'resume_disposition');
  await c.close();
});

test('O05/O06: a recorded review that would publish is never abandoned',{timeout:40000},async t=>{
  const dir=fixture(t);let conflicted=false;
  const respond=({kind,payload})=>{
    if(kind==='prd_analyze')return {status:'analyzed',summary:'New documentation',sourcePaths:['docs/input.md'],openQuestions:[]};
    if(kind==='prd_generate')return {status:'draft',summary:'New guide',features:[{name:'new-guide',documents:docs().map(doc=>({
      ...doc,content:doc.content.replace('[x]','[ ]')})),testCasesReason:'no_observable_behavior'}]};
    if(kind==='prd_self_check')return {draftDigest:payload.draft.draftDigest,features:payload.draft.features.map(f=>({directory:f.directory,
      checks:payload.draft.mechanicalSelfCheck.pending.map(id=>({id,status:'passed',evidence:['Synthetic original context check']}))}))};
    // A valid independent review whose publication fails (the evidence path is taken).
    if(!conflicted){conflicted=true;fs.mkdirSync(path.join(dir,'.reviews/prd-new-guide-split-r1.md'));}
    return {reviewer:'codex-subagent',contextId:'synthetic-independent',independent:true,at:'2026-09-08T00:00:00.000Z',
      result:{verdict:'approved',packageDigest:payload.package.packageDigest,examinedPaths:payload.examinedPaths,findings:[],summary:'Synthetic no findings'}};
  };
  let c=await client(t,dir,respond,{change:false,review:true,abandon:true});
  await c.request('start',{text:'New guide'});await c.request('advance',{text:'Draft'});await c.request('advance',{text:'Check'});
  await c.request('save_draft');
  const runId=(await c.request('status')).result.runId;
  assert.equal((await c.request('final_review',{stage:'split',feature:'2.new-guide',mode:'independent'})).result.reviewState.status,'review_unknown');
  const call=stateOf(dir,runId).active.calls.find(item=>item.kind==='prd_review');
  const before=stateOf(dir,runId);
  const refused=await c.request('resume',{resolution:{callId:call.callId,requestDigest:call.requestDigest,abandonReview:true,evidence:'想换一个审查'}});
  assert.equal(refused.result.reason,'prd_review_result_publishable');
  assert.deepEqual(stateOf(dir,runId),before);
  assert.equal(fs.readdirSync(path.join(dir,'.reviews')).some(name=>name.includes('dispatch-abandoned')),false);
  await c.close();
});

test('O02: at most two discards per call kind in a session; prd_review and prd_correct are never discarded',async t=>{
  const dir=fixture(t),session=openPrdSession({specs:dir,sessionId:'prd-discard-cap',identity:{entry:{fixture:true},runtime:'codex'}});
  try{
    session.begin({requestId:'one',operation:'advance',text:'x'},null);
    const discard=call=>session.discardAnswer({callId:call.callId,requestDigest:call.requestDigest,discard:true,evidence:'被宿主拒收'});
    for(let index=0;index<2;index++){
      await session.call('prd_generate',{n:index},new AbortController().signal,async()=>({bad:true}));
      discard(session.state.active.calls.at(-1));
    }
    await session.call('prd_generate',{n:3},new AbortController().signal,async()=>({bad:true}));
    assert.throws(()=>discard(session.state.active.calls.at(-1)),{code:'prd_answer_discard_limit'});
    assert.equal(session.state.discardedAnswers.length,2);
  }finally{session.close();}
  const other=openPrdSession({specs:dir,sessionId:'prd-discard-review',identity:{entry:{fixture:true},runtime:'codex'}});
  try{
    other.begin({requestId:'two',operation:'final_review',stage:'split',feature:'1.guide',mode:'independent'},null);
    await other.call('prd_review',{package:{packageDigest:'0'.repeat(64)}},new AbortController().signal,async()=>({reviewer:'x'}));
    const call=other.state.active.calls[0];
    assert.throws(()=>other.discardAnswer({callId:call.callId,requestDigest:call.requestDigest,discard:true,evidence:'x'}),{code:'prd_review_recovery_required'});
  }finally{other.close();}
});
