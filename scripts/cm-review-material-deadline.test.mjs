// Real stdio server + native worker deadline; synthetic CLI and boundary delay only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {createReviewMaterialSession} from '../runtime/js/cm-ai/review-material.mjs';
import {planCodexReviewInput} from '../runtime/js/cm-ai/codex-review-input.mjs';
import {codexWorker} from '../runtime/js/cm-ai/worker-codex.mjs';
import {configFingerprint} from '../runtime/js/cm-ai/codex-config.mjs';
import {requestFor} from '../runtime/js/cm-ai/effect-contract.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');

test('same fixed worker deadline rejects scalar latency and accepts complete bounded batches',async t=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-material-deadline-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const text=('ASCII complete material "quote" \\ slash\n'.repeat(110000)).slice(0,3772637);
 assert.equal(Buffer.byteLength(text),3772637);
 const request=requestFor({invocationId:'deadline-fixture',identity:{repositoryId:'fixture',runId:'deadline',taskId:'T-001',attempt:1},role:'reviewer',provider:'codex',requestedModel:'synthetic',contextId:'review',payload:{reviewPackage:{packageDigest:'a'.repeat(64)},priorReview:null}});
 const plan=planCodexReviewInput(text,request);assert.equal(plan.material.manifest.pageCount,231);
 // The two timing measurements share the disk scheduler: run sequentially for comparable load.
 const outcomes=[];for(const batchCount of [1,8]){
  const session=createReviewMaterialSession({prompt:text,request}),cli=path.join(root,'codex-'+batchCount);
  const helper=new URL('./fixtures/material-review-codex-helper.mjs',import.meta.url).href;
  fs.writeFileSync(cli,`#!${process.execPath}\nimport assert from 'node:assert/strict';import {createHash} from 'node:crypto';import {expandMaterialFixturePrompt} from ${JSON.stringify(helper)};let p='';for await(const b of process.stdin)p+=b;const send=v=>console.log(JSON.stringify(v));send({type:'thread.started',thread_id:'deadline-thread'});send({type:'turn.started'});let count=0;const full=await expandMaterialFixturePrompt(process.argv.slice(2),p,{batchCount:${batchCount},boundaryDelayMs:25,onToolResult:result=>send({type:'item.completed',item:{id:'tool-'+(++count),type:'mcp_tool_call',server:'cm_review',tool:'read_material',result}})});assert.equal(Buffer.byteLength(full),3772637);assert.equal(createHash('sha256').update(full).digest('hex'),${JSON.stringify(sha(text))});send({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({verdict:'approved',packageDigest:'a'.repeat(64),examinedPaths:[],findings:[],summary:'Synthetic transport deadline only'})}});send({type:'turn.completed'});\n`,{mode:0o700});
  const options={cwd:root,model:'synthetic',material:session.manifest,materialTransport:session.transport,promptTransport:'stdin',timeoutMs:3500,cli,schemaPath:fileURLToPath(new URL('../runtime/js/cm-ai/review-result.schema.json',import.meta.url))};
  const start=performance.now();
  try{
   const result=await codexWorker({...options,preflight:{passed:true,cli_model:'synthetic',prompt_transport:'stdin',config_fingerprint:configFingerprint(options)}})({prompt:plan.prompt},{signal:new AbortController().signal,onEvent(){}});
   const diagnostic=session.failureSnapshot();let proof=null;if(result.status==='succeeded')proof=session.finish('deadline-thread');
   outcomes.push({batchCount,result,diagnostic,proof,elapsedMs:performance.now()-start});
  }finally{await session.close();}
 }
 const [scalar,batch]=outcomes;
 assert.equal(scalar.result.status,'failed');assert.equal(scalar.result.code,'timeout');assert(scalar.diagnostic.readPages<231);
 assert.equal(batch.result.status,'succeeded',JSON.stringify(batch));assert.equal(batch.diagnostic.readPages,231);assert.equal(batch.proof.pages.length,231);
 assert.equal(batch.proof.pageReadCount,231);assert(batch.proof.callCount<60);assert(batch.elapsedMs<3500);
 console.log(JSON.stringify({fixtureOnly:true,timeoutMs:3500,boundaryDelayMs:25,scalar:{outcome:scalar.result.status,code:scalar.result.code,readPages:scalar.diagnostic.readPages,elapsedMs:scalar.elapsedMs},batch:{outcome:batch.result.status,readPages:231,toolCalls:batch.proof.callCount,elapsedMs:batch.elapsedMs},realModelCalled:false}));
});
