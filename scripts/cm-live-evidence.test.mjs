import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createLiveEvidence,qaAnswerWindowShortfall} from '../runtime/js/cm-ai/live-evidence.mjs';

function fixture(t){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-live-evidence-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const project=path.join(root,'project');fs.mkdirSync(project);
  return {root,project,directory:path.join(root,'exchange')};
}
const row={type:'host_request',sessionId:'session-a',callId:'call-a',requestDigest:'a'.repeat(64),kind:'qa_logic',payload:{case:{id:'TC-001'}}};
test('fresh live request accepts only its session/call/digest and leaves request evidence',async t=>{
  const f=fixture(t);let requestPath;
  const live=createLiveEvidence({directory:f.directory,kinds:['qa_logic'],timeoutMs:1000},{base:f.root,protectedRoots:[f.project],
    notify:p=>{requestPath=p;const request=JSON.parse(fs.readFileSync(p));
      fs.writeFileSync(p.replace('.request.json','.result.json'),JSON.stringify({type:'host_result',sessionId:request.sessionId,
        callId:request.callId,requestDigest:request.requestDigest,result:{verdict:'SUPPORTED',evidence:['observed']}}));}});
  const result=await live.answer(row);
  assert.equal(result.verdict,'SUPPORTED');assert.ok(fs.existsSync(requestPath));
  assert.equal(fs.statSync(path.dirname(requestPath)).mode&0o777,0o700);
  assert.equal(await live.answer({...row,kind:'check'}),null);
});
test('stale reply is refused rather than rebound to the current request',async t=>{
  const f=fixture(t);const live=createLiveEvidence({directory:f.directory,kinds:['qa_logic'],timeoutMs:1000},
    {base:f.root,protectedRoots:[f.project],notify:p=>fs.writeFileSync(p.replace('.request.json','.result.json'),
      JSON.stringify({type:'host_result',sessionId:'old-session',callId:row.callId,requestDigest:row.requestDigest,result:{verdict:'PASS'}}))});
  await assert.rejects(live.answer(row),/live_evidence_binding_mismatch/);
});
test('no response times out and cancellation interrupts the wait',async t=>{
  const f=fixture(t);const live=createLiveEvidence({directory:f.directory,kinds:['qa_logic'],timeoutMs:30},
    {base:f.root,protectedRoots:[f.project],notify:()=>{}});
  await assert.rejects(live.answer(row),/live_evidence_timeout/);
  const controller=new AbortController();controller.abort();
  await assert.rejects(live.answer({...row,callId:'call-b'},{signal:controller.signal}),/live_evidence_cancelled/);
});
test('preflight refuses protected trees, symlinks, unknown kinds and malformed settings',t=>{
  const f=fixture(t),options={base:f.root,protectedRoots:[f.project]};
  fs.symlinkSync(f.project,path.join(f.root,'linked'));
  for(const config of [{directory:f.project,kinds:['qa_logic']},{directory:path.join(f.project,'exchange'),kinds:['qa_logic']},
    {directory:path.join(f.root,'linked','exchange'),kinds:['qa_logic']},{directory:f.directory,kinds:['develop']},
    {directory:f.directory,kinds:['qa_logic'],timeoutMs:0},{directory:f.directory,kinds:['qa_logic'],extra:true}])
    assert.throws(()=>createLiveEvidence(config,options),/live_evidence_/);
});
for(const bad of ['symlink','oversize','malformed'])test(`live result refuses ${bad} rather than claiming execution`,async t=>{
  const f=fixture(t);const live=createLiveEvidence({directory:f.directory,kinds:['qa_logic'],timeoutMs:1000},
    {base:f.root,protectedRoots:[f.project],maxBytes:100,notify:file=>{
      const target=file.replace('.request.json','.result.json');
      if(bad==='symlink')fs.symlinkSync(file,target);
      else fs.writeFileSync(target,bad==='oversize'?'x'.repeat(101):'{');
    }});
  await assert.rejects(live.answer(row),bad==='malformed'?/live_evidence_invalid_json/:/live_evidence_unsafe_result|ELOOP/);
});

test('future parallel worktree roots are protected before they exist, including an aliased parent',t=>{
  const f=fixture(t),future=path.join(f.root,'.cm-worktrees');
  assert.throws(()=>createLiveEvidence({directory:path.join(future,'run','exchange'),kinds:['qa_logic']},
    {protectedRoots:[future]}),/live_evidence_protected_directory/);
  const alias=path.join(f.root,'alias');fs.symlinkSync(f.root,alias);
  assert.throws(()=>createLiveEvidence({directory:path.join(future,'run','exchange'),kinds:['qa_logic']},
    {protectedRoots:[path.join(alias,'.cm-worktrees')]}),/live_evidence_protected_directory/);
});

// Batch session member develop (design 3.4): the bridge package travels unchanged
// and each of the three reply shapes comes back exactly as the session wrote it.
const bridgePackage={request:{identity:{repositoryId:'r',runId:'task-a',taskId:'T-002',attempt:1},payload:{scope:['docs/qa.md']}},
  prompt:'Implement T-002',codeProject:'/fixture/app',route:{role:'developer'},editMode:'protected-text-v1',expected:{'docs/qa.md':null}};
const developRow={...row,kind:'develop',callId:'call-develop',payload:bridgePackage};
const replies={
  proposal:{status:'succeeded',value:{outcome:'implemented',application:{status:'no_relevant_lesson',note:null},
    retrospective:{status:'no_new_lesson',candidates:[],reason:null},requirements:[]},
    edits:[{path:'docs/qa.md',beforeSha256:null,content:'# QA walk-through\n'}]},
  blocked:{status:'succeeded',value:{outcome:'blocked',reason:'browser environment unavailable',
    application:{status:'no_relevant_lesson',note:null},retrospective:{status:'no_new_lesson',candidates:[],reason:null}},edits:[]},
  failed:{status:'failed',code:'session_unavailable'}};
for(const [name,reply] of Object.entries(replies))test(`develop live request passes the full bridge package and returns the ${name} reply unchanged`,async t=>{
  const f=fixture(t);let request;
  const live=createLiveEvidence({directory:f.directory,kinds:['develop'],timeoutMs:1000},{base:f.root,protectedRoots:[f.project],
    allowedKinds:['develop'],notify:p=>{request=JSON.parse(fs.readFileSync(p,'utf8'));
      fs.writeFileSync(p.replace('.request.json','.result.json'),JSON.stringify({type:'host_result',sessionId:request.sessionId,
        callId:request.callId,requestDigest:request.requestDigest,result:reply}));}});
  assert.deepEqual(await live.answer(developRow),reply);
  assert.deepEqual(request,developRow);
});
test('develop is opt-in and its wait floor applies to develop only',t=>{
  const f=fixture(t),options={base:f.root,protectedRoots:[f.project]};
  assert.throws(()=>createLiveEvidence({directory:f.directory,kinds:['develop']},options),/live_evidence_invalid_config/);
  const live=createLiveEvidence({directory:f.directory,kinds:['develop','qa_logic'],timeoutMs:1000},
    {...options,allowedKinds:['develop','qa_logic'],minimumTimeouts:{develop:1860000}});
  assert.equal(live.timeoutFor('develop'),1860000);assert.equal(live.timeoutFor('qa_logic'),1000);
  assert.equal(live.timeoutFor('qa_browser'),null);
  // A longer configured wait is kept; the floor never shortens it.
  assert.equal(createLiveEvidence({directory:f.directory,kinds:['develop'],timeoutMs:3600000},
    {...options,allowedKinds:['develop'],minimumTimeouts:{develop:1860000}}).timeoutFor('develop'),3600000);
  for(const minimumTimeouts of [{develop:0},{develop:'1'},{unknown:1000}])
    assert.throws(()=>createLiveEvidence({directory:f.directory,kinds:['develop']},{...options,allowedKinds:['develop'],minimumTimeouts}),/live_evidence_invalid_limit/);
});
test('develop wait uses its floor, not the shorter configured timeout',async t=>{
  const f=fixture(t);
  const live=createLiveEvidence({directory:f.directory,kinds:['develop','qa_logic'],timeoutMs:20},{base:f.root,protectedRoots:[f.project],
    allowedKinds:['develop','qa_logic'],minimumTimeouts:{develop:400}});
  const started=Date.now();
  await assert.rejects(live.answer(developRow),/live_evidence_timeout/);
  assert.ok(Date.now()-started>=400,'develop waits for its floor');
  const quick=Date.now();await assert.rejects(live.answer({...row,callId:'call-q'}),/live_evidence_timeout/);
  assert.ok(Date.now()-quick<400,'other kinds keep the configured timeout');
});

test('the QA answer window is compared with the live wait for qa_logic/qa_browser only',()=>{
  const live=kinds=>({has:kind=>kinds.includes(kind),timeoutFor:kind=>kinds.includes(kind)?900000:null});
  assert.equal(qaAnswerWindowShortfall(null,live(['qa_browser']),['qa_browser']),null);
  assert.match(qaAnswerWindowShortfall({commands:[]},live(['qa_browser']),['qa_assess','qa_browser']),
    /未填（默认 60000） 毫秒，短于 PLAN\.liveEvidence 对 qa_browser 的等待 900000 毫秒/);
  assert.match(qaAnswerWindowShortfall({timeoutMs:300000},live(['qa_logic','qa_browser']),['qa_logic','qa_browser','qa_logic']),
    /为 300000 毫秒，短于 PLAN\.liveEvidence 对 qa_logic、qa_browser 的等待/);
  assert.equal(qaAnswerWindowShortfall({timeoutMs:900000},live(['qa_browser']),['qa_browser']),null);
  // Not answered live, or not asked: the window is not this driver's wait.
  assert.equal(qaAnswerWindowShortfall({},live([]),['qa_browser']),null);
  assert.equal(qaAnswerWindowShortfall({},live(['verification_precheck']),['verification_precheck','check']),null);
});
