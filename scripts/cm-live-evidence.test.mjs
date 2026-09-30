import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createLiveEvidence} from '../runtime/js/cm-ai/live-evidence.mjs';

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
