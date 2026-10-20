// One real blocked native seed; shared owner/publication paths require sequential
// verdict branches. Each branch uses the real driver and a fresh synthetic CLI.
import test from 'node:test';import assert from 'node:assert/strict';import {spawn} from 'node:child_process';import {fileURLToPath} from 'node:url';
if(process.env.CM_VALID_EVIDENCE_CHILD==='1'){
 Object.assign(process.env,{CM_VALID_EVIDENCE_FIXTURE:'1',CM_NATIVE_MATERIAL_CHAIN_FIXTURE:'1',CM_NATIVE_MATERIAL_REVIEW_FIXTURE:'1',CM_NATIVE_MATERIAL_CHAIN_VERDICT:'blocked'});
 await import('./cm-ai-bounded-native-correction.test.mjs');
}else await test('one blocked native seed, three queued evidence review verdict branches',async()=>{
 const env={...process.env,CM_VALID_EVIDENCE_CHILD:'1'};delete env.NODE_TEST_CONTEXT;
 const result=await new Promise((resolve,reject)=>{const c=spawn(process.execPath,['--test',fileURLToPath(import.meta.url)],{env,stdio:['ignore','pipe','pipe']});
  let output='';for(const stream of [c.stdout,c.stderr])stream.on('data',b=>output=(output+b.toString()).slice(-24000));c.once('error',reject);c.once('close',(code,signal)=>resolve({code,signal,output}));});
 assert.equal(result.code,0,result.output);assert.equal(result.signal,null);
 for(const verdict of ['blocked','changes_requested','approved'])assert(result.output.includes(`[evidence scenario] ${verdict}:`),result.output);
 assert.match(result.output,/(?:#|ℹ) pass 1/,'child actually runs its old seed and all branch assertions');
 process.stderr.write(result.output);
});
