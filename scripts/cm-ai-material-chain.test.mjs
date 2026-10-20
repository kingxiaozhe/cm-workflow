// Real owner/driver/store/QA, synthetic providers only; each child owns its fixture.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
if(process.env.CM_MATERIAL_CHAIN_CHILD==='1'){
 process.env.CM_NATIVE_MATERIAL_CHAIN_FIXTURE='1';
 process.env.CM_NATIVE_MATERIAL_REVIEW_FIXTURE='1';
 await import('./cm-ai-bounded-native-correction.test.mjs');
}else{
 await test('original material failure through controlled continuation and owner reception',{concurrency:3},async t=>{
  await Promise.all(['approved','blocked','changes_requested'].map(verdict=>t.test(verdict,async()=>{
   const childEnvironment={...process.env,CM_MATERIAL_CHAIN_CHILD:'1',CM_NATIVE_MATERIAL_CHAIN_VERDICT:verdict};
   delete childEnvironment.NODE_TEST_CONTEXT;
   const result=await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['--test',fileURLToPath(import.meta.url)],{
     env:childEnvironment,stdio:['ignore','pipe','pipe']});
    let output='';const collect=b=>{output=(output+b.toString()).slice(-12000);};
    child.stdout.on('data',collect);child.stderr.on('data',collect);child.once('error',reject);
    child.once('close',(code,signal)=>resolve({code,signal,output}));
   });
   assert.equal(result.code,0,result.output);assert.equal(result.signal,null);
   assert.match(result.output,/original failed correction grants only one technical review/,'child must execute the real owner chain');
   assert.match(result.output,/(?:#|ℹ) pass 1/,'child must report its actual executed test');
  })));
 });
}
