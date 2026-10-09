// O20: every kind a workflow host asks through the real bridge must be on its
// whitelist; refactor_revise_tests (round-2 judge revision) was missing, so the
// second refactor round threw host_operation_invalid on every attempt.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHostToolBridge,HOST_CALL_KINDS} from '../runtime/js/cm-ai/host-tool-bridge.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
test('the real bridge accepts refactor_revise_tests and answers it',async()=>{
  const bridge=createHostToolBridge(),sent=[];bridge.attach(value=>{sent.push(value);});
  try{
    const pending=bridge.call('refactor_revise_tests',{attempt:2},new AbortController().signal);
    await new Promise(resolve=>setImmediate(resolve));
    const request=sent.find(row=>row.type==='host_request');
    assert.equal(request?.kind,'refactor_revise_tests');
    bridge.accept({type:'host_result',sessionId:request.sessionId,callId:request.callId,requestDigest:request.requestDigest,result:{files:[]}});
    assert.deepEqual(await pending,{files:[]});
  }finally{bridge.close();}
});
test('every refactor invoke kind in the workflow is a bridge kind',()=>{
  const source=fs.readFileSync(path.join(root,'runtime/js/cm-refactor/workflow.mjs'),'utf8');
  const kinds=[...new Set([...source.matchAll(/invoke\([^,]+,'([a-z_]+)'/g)].map(match=>match[1]))];
  assert.ok(kinds.includes('refactor_revise_tests'),kinds.join(','));
  assert.deepEqual(kinds.filter(kind=>!HOST_CALL_KINDS.includes(kind)),[]);
});
