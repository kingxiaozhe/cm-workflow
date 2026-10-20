import test from 'node:test';import assert from 'node:assert/strict';import {EventEmitter} from 'node:events';import {PassThrough} from 'node:stream';
import {codexWorker} from '../runtime/js/cm-ai/worker-codex.mjs';import {commonArgs,configFingerprint} from '../runtime/js/cm-ai/codex-config.mjs';import {createReviewMaterialSession} from '../runtime/js/cm-ai/review-material.mjs';import {requestFor} from '../runtime/js/cm-ai/effect-contract.mjs';
const request=()=>requestFor({invocationId:'fixture-1',identity:{repositoryId:'r',runId:'run',taskId:'T-001',attempt:1},role:'reviewer',provider:'codex',requestedModel:'fixture',contextId:'review',payload:{reviewPackage:{packageDigest:'a'.repeat(64)},priorReview:null}});
test('Codex dispatch rejects excessive Unicode scalars without spawning, while the boundary counts emoji once',async()=>{
 let spawned=0;const options={cwd:'/fixture',model:'fixture'};const worker=codexWorker({...options,schemaPath:'/fixture/schema',preflight:{passed:true,cli_model:'fixture',config_fingerprint:configFingerprint(options)},spawnProcess(){spawned++;throw Error('unexpected spawn');}});
 assert.deepEqual(await worker({prompt:'a'.repeat(1048576)+'😀'},{signal:new AbortController().signal,onEvent(){}}),{status:'blocked',code:'review_input_too_large'});assert.equal(spawned,0);
});
for(const material of [false,true])test(`only material stdout permits bounded page traffic above ordinary limit (${material})`,async t=>{
 const session=createReviewMaterialSession({prompt:'evidence\n'.repeat(180000),request:request()});t.after(()=>session.close());
 const options={cwd:'/fixture',model:'fixture',...(material?{material:session.manifest,materialTransport:session.transport}:{})};
 assert.equal(commonArgs(options).includes('tool_output_token_limit=131072'),material);
 const worker=codexWorker({...options,schemaPath:'/fixture/schema',preflight:{passed:true,cli_model:'fixture',config_fingerprint:configFingerprint(options)},spawnProcess(){const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>true;
 queueMicrotask(()=>{const send=e=>child.stdout.write(JSON.stringify(e)+'\n');send({type:'thread.started',thread_id:'fresh'});send({type:'turn.started'});
 for(let i=0;i<75;i++)send({type:'item.completed',item:{id:'page-'+i,type:material?'mcp_tool_call':'reasoning',server:'cm_review',tool:'read_material',result:{content:[{type:'text',text:'x'.repeat(16384)}]}}});
 send({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({fixture:'only'})}});send({type:'turn.completed'});child.stdout.end();child.stderr.end();child.emit('close',0,null);});return child;}});
 const result=await worker({prompt:'small manifest'},{signal:new AbortController().signal,onEvent(){}});
 assert.equal(result.status,material?'succeeded':'failed');if(!material)assert.equal(result.code,'output_limit');
});
