// Opt-in real Codex CLI transport fixture. The only model endpoint is a local
// scripted Responses sink, with synthetic auth and no retries or proxy env.
// Run: CM_REVIEW_MATERIAL_CLI_FIXTURE=1 node --test scripts/cm-review-material-cli.test.mjs
// This proves transport only. It deliberately reads one page then returns 400;
// it cannot produce independent review evidence or authorize completion.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {deflateSync,gunzipSync,zstdDecompressSync} from 'node:zlib';
import {fileURLToPath} from 'node:url';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
import {commonArgs,cleanEnvironment} from '../runtime/js/cm-ai/codex-config.mjs';
import {requestTools,skillContext} from '../runtime/js/cm-ai/tool-preview.mjs';
import {createReviewMaterialSession} from '../runtime/js/cm-ai/review-material.mjs';
import {ownedProcessCleanup} from '../runtime/js/cm-ai/owned-process-cleanup.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const HTTP_LIMIT=8*1024*1024;
function png(){
 const crc=data=>{let n=0xffffffff;for(const b of data){n^=b;for(let i=0;i<8;i++)n=(n>>>1)^((n&1)?0xedb88320:0);}return (n^0xffffffff)>>>0;};
 const chunk=(name,data)=>{const type=Buffer.from(name),out=Buffer.alloc(data.length+12);out.writeUInt32BE(data.length);type.copy(out,4);data.copy(out,8);out.writeUInt32BE(crc(Buffer.concat([type,data])),data.length+8);return out;};
 const header=Buffer.alloc(13);header.writeUInt32BE(1);header.writeUInt32BE(1,4);header[8]=8;header[9]=2;
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.from([0,255,255,255]))),chunk('IEND',Buffer.alloc(0))]);
}
function findPage(raw,depth=0,batch=false){
 if(depth>8)return null;
 if(typeof raw==='string'){try{return findPage(JSON.parse(raw),depth+1,batch);}catch{return null;}}
 if(Array.isArray(raw)){for(const item of raw){const value=findPage(item,depth+1,batch);if(value)return value;}return null;}
 if(raw&&typeof raw==='object'){
  if(batch?raw.kind==='cm-review-material-batch'&&Array.isArray(raw.pages):raw.page===0&&typeof raw.content==='string'&&typeof raw.pageSha256==='string')return raw;
  for(const value of Object.values(raw)){const found=findPage(value,depth+1,batch);if(found)return found;}
 }return null;
}
function functionCallResponse(response,model,batch=false){
 const item={id:'fc_cm_material_fixture',type:'function_call',status:'completed',call_id:'call_cm_material_page_zero',
  namespace:'mcp__cm_review',name:'read_material',arguments:JSON.stringify({page:0,...(batch?{count:8}:{})})};
 const events=[
  {type:'response.created',response:{id:'resp_cm_material_fixture',status:'in_progress',output:[]}},
  {type:'response.output_item.added',output_index:0,item:{...item,status:'in_progress',arguments:''}},
  {type:'response.function_call_arguments.delta',item_id:item.id,output_index:0,delta:item.arguments},
  {type:'response.function_call_arguments.done',item_id:item.id,output_index:0,arguments:item.arguments},
  {type:'response.output_item.done',output_index:0,item},
  {type:'response.completed',response:{id:'resp_cm_material_fixture',status:'completed',model,output:[item],
   usage:{input_tokens:1,output_tokens:1,total_tokens:2,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:0}}}},
 ];
 response.writeHead(200,{'Content-Type':'text/event-stream'});
 response.end(events.map((e,i)=>`event: ${e.type}\ndata: ${JSON.stringify({sequence_number:i,...e})}\n\n`).join(''));
}

for(const variant of ['single-escaped','batch-plain','batch-escaped'])test(`real CLI reads complete ${variant} through fixed MCP with image and response schema`,
 {skip:process.env.CM_REVIEW_MATERIAL_CLI_FIXTURE!=='1',timeout:55000},async()=>{
 const batch=variant!=='single-escaped',escaped=variant!=='batch-plain',expectedBatchPages=escaped?1:7;
 const cli=process.env.CM_REVIEW_MATERIAL_CLI??'codex',version=spawnSync(cli,['--version'],{encoding:'utf8'});
 assert.equal(version.status,0,'fixture requires an available Codex CLI');
 const cliVersion=/^codex-cli [0-9A-Za-z.+_-]+$/.test(version.stdout.trim())?version.stdout.trim():'unrecognized';
 const prefix='CM_MATERIAL_PAGE_ZERO_BEGIN:',tail=':CM_MATERIAL_PAGE_ZERO_END:😀';
 const page=prefix+(escaped?'\0':'x').repeat(16384-Buffer.byteLength(prefix+tail))+tail;
 const prompt=page+'x'.repeat(1049000),body={version:1,invocationId:'material-fixture.1',
  identity:{repositoryId:'fixture',runId:'material-cli',taskId:'T-001',attempt:1},role:'reviewer',provider:'codex',
  requestedModel:'gpt-6.1-sol',contextId:'material-fixture-review',payload:{reviewPackage:{packageDigest:'a'.repeat(64)},priorReview:null}};
 const request={...body,requestDigest:digest(body)},session=createReviewMaterialSession({prompt,request});
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-material-cli-fixture-'))),image=path.join(root,'fixture.png');fs.writeFileSync(image,png());
 const model=body.requestedModel,localRequests=[],issues=[],events=[];let stderrBytes=0,server,child,cleanup,result=null;
 const row={case:batch?'synthetic-material-batch-real-cli':'synthetic-large-review-material-real-cli',cliVersion,realModelRequests:0,syntheticOnly:true,
  syntheticMaterialScalars:[...prompt].length,materialBytes:Buffer.byteLength(prompt),materialSha256:sha(Buffer.from(prompt)),
  pageBytes:Buffer.byteLength(page),pageSha256:sha(Buffer.from(page)),pageEndEmoji:true,
  model,localRequests,issues,events,validIndependentReview:false,fullCoverageExpected:false};
 try{
  server=http.createServer((req,res)=>{
   let chunks=[],size=0,over=false;
   req.on('data',b=>{size+=b.length;if(size>HTTP_LIMIT){over=true;chunks=[];req.destroy();}else if(!over)chunks.push(b);});
   req.on('end',()=>{
    if(over)return;
    try{
     let bytes=Buffer.concat(chunks);
     if(req.headers['content-encoding']==='gzip')bytes=gunzipSync(bytes,{maxOutputLength:HTTP_LIMIT});
     if(req.headers['content-encoding']==='zstd')bytes=zstdDecompressSync(bytes,{maxOutputLength:HTTP_LIMIT});
     const parsed=JSON.parse(bytes),tools=requestTools(parsed,true),context=skillContext(parsed),index=localRequests.length;
     const controls=new Map([['exec','custom'],['wait','function'],['request_user_input_async','function']]);
     const active=tools?.filter(t=>!controls.has(t.name)),surface=Array.isArray(tools)
      &&new Set(tools.map(t=>t.name)).size===tools.length&&tools.every(t=>!controls.has(t.name)||controls.get(t.name)===t.type)
      &&JSON.stringify(active)===JSON.stringify([{type:'function',name:'mcp__cm_review__read_material'}]);
     const userItems=(parsed.input??[]).filter(v=>v.role==='user').flatMap(v=>v.content??[]);
     const userText=userItems.filter(v=>v.type==='input_text').map(v=>v.text??'').join('\n');
     const outputs=(parsed.input??[]).filter(v=>v.type==='function_call_output');let returned=null;
     let batchValue=null;
     for(const output of outputs){if(batch)batchValue=findPage(output.output,0,true);returned=batchValue?{...batchValue,...batchValue.pages[0]}:findPage(output.output);if(returned)break;}
     const fullPage=returned!==null&&returned.content===page&&returned.pageSha256===sha(Buffer.from(page))
      &&returned.manifestDigest===digest(session.manifest)&&returned.requestDigest===request.requestDigest
      &&returned.packageDigest===request.payload.reviewPackage.packageDigest&&returned.promptSha256===session.manifest.promptSha256
      &&returned.offset===0&&returned.end===16384&&returned.totalBytes===Buffer.byteLength(prompt);
     const meta={method:req.method,path:req.url,model:parsed.model,syntheticAuth:req.headers.authorization==='Bearer cm-js-synthetic-local-probe',
      fixedToolSurface:surface,toolNames:tools?.map(t=>t.name)??[],skillCatalogPresent:context.present,
      schemaPresent:Boolean(parsed.text?.format?.schema),imageCount:userItems.filter(v=>v.type==='input_image').length,
      initialTextBytes:Buffer.byteLength(userText),initialTextScalars:[...userText].length,
      transportTextPresent:userText.includes(session.prompt),materialBodyPresent:userText.includes(prefix),
      outputCount:outputs.length,fullPageReceived:fullPage,
      ...(batch?{fullBatchReceived:Boolean(batchValue&&batchValue.pages.length===expectedBatchPages&&batchValue.nextPage===expectedBatchPages
       &&batchValue.pages.every((p,i)=>p.page===i&&p.offset===session.manifest.pages[i].offset&&p.end===session.manifest.pages[i].end&&p.content===Buffer.from(prompt).subarray(p.offset,p.end).toString('utf8')&&p.pageSha256===session.manifest.pages[i].sha256&&p.pageSha256===sha(Buffer.from(p.content)))
       &&batchValue.pages.map(p=>p.content).join('')===Buffer.from(prompt).subarray(0,session.manifest.pages[expectedBatchPages-1].end).toString('utf8')),batchPages:batchValue?.pages.length??0}:{}),
      outputFixedAtoms:['error','unknown','unrecognized','function','namespace','tool','read_material','parse','invalid','not found','content','text'].filter(atom=>outputs.some(v=>JSON.stringify(v.output).toLowerCase().includes(atom))),
      ...(returned?{returnedBytes:Buffer.byteLength(returned.content),returnedSha256:sha(Buffer.from(returned.content)),endMarkerPresent:returned.content.endsWith(tail)}:{})};
     localRequests.push(meta);
     if(index===0){functionCallResponse(res,model,batch);return;}
     // This fixed error is the end of the fixture, not a business review result.
     res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:'Synthetic material transport capture complete.',type:'invalid_request_error',code:'synthetic_capture'}}));
    }catch{issues.push('local_capture_invalid');res.writeHead(400,{'Content-Type':'application/json'});res.end('{"error":{"message":"Synthetic capture failure","type":"invalid_request_error"}}');}
   });
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const port=server.address().port;const base=`http://127.0.0.1:${port}`;
  const args=[...commonArgs({cwd:session.transport.cwd,model,effort:'high',material:session.manifest,materialTransport:session.transport}),
   '-c','model_provider="cm_local_material_fixture"','-c',`model_providers.cm_local_material_fixture={name="CM local material fixture",base_url="${base}/v1",wire_api="responses",env_key="CM_JS_PROBE_AUTH",requires_openai_auth=false,request_max_retries=0,stream_max_retries=0}`,
   '--output-schema',fileURLToPath(new URL('../runtime/js/cm-ai/review-result.schema.json',import.meta.url)),'--image',image,'-'];
  assert(args.includes('tool_output_token_limit=131072'),'material mode must bound native tool output above fully escaped page size');
  const env=cleanEnvironment();env.CM_JS_PROBE_AUTH='cm-js-synthetic-local-probe';
  result=await new Promise((resolve,reject)=>{
   child=spawn(cli,args,{cwd:session.transport.cwd,env,stdio:['pipe','pipe','pipe'],detached:process.platform!=='win32'});cleanup=ownedProcessCleanup(child);
   let buffer='',stdoutBytes=0,timedOut=false;const timer=setTimeout(()=>{timedOut=true;void cleanup().catch(()=>{});},40000);
   child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{
    stdoutBytes+=Buffer.byteLength(chunk);if(stdoutBytes>2*1024*1024){issues.push('fixture_stdout_limit');void cleanup().catch(()=>{});return;}
    buffer+=chunk;let split;
    while((split=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,split);buffer=buffer.slice(split+1);try{const e=JSON.parse(line);events.push({type:e.type,itemType:e.item?.type??null,...(e.item?.type==='mcp_tool_call'?{server:e.item.server,tool:e.item.tool}:{} )});}catch{issues.push('fixture_event_invalid');}}
   });
   child.stderr.on('data',chunk=>{stderrBytes+=chunk.length;});
   child.once('error',()=>{clearTimeout(timer);reject(new Error('fixture_cli_spawn_failed'));});
   child.once('close',(code,signal)=>{clearTimeout(timer);resolve({code,signal,timedOut,stdoutBytes});});
   child.stdin.on('error',()=>{issues.push('fixture_stdin_failed');});child.stdin.end(session.prompt);
  });
  await cleanup();cleanup=null;
  row.process=result;row.stderrBytes=stderrBytes;
  let incomplete=false;try{session.finish('fixture-incomplete');}catch(e){incomplete=e.code==='review_material_incomplete';}row.fullCoverageRefused=incomplete;
  // All assertion messages are fixed; never print captured input or stderr.
  assert(row.syntheticMaterialScalars>1048576,'fixture material must exceed initial-input limit');
  assert(localRequests.length===2,'fixture must make exactly two local requests');
  assert(localRequests.every(v=>v.method==='POST'&&v.path==='/v1/responses'&&v.model===model&&v.syntheticAuth&&v.fixedToolSurface&&!v.skillCatalogPresent),'model requests must remain isolated and narrowly scoped');
  assert(localRequests[0].schemaPresent&&localRequests[0].imageCount===1&&localRequests[0].initialTextScalars<1048576
   &&localRequests[0].transportTextPresent&&!localRequests[0].materialBodyPresent,'initial request must carry schema, synthetic image and compact transport instructions');
  assert(localRequests[1].fullPageReceived&&localRequests[1].endMarkerPresent&&localRequests[1].returnedBytes===16384,'second request must contain exact complete page including emoji tail');
  assert(events.some(e=>e.type==='item.completed'&&e.itemType==='mcp_tool_call'&&e.server==='cm_review'&&e.tool==='read_material'),'CLI must execute the fixed MCP reader');
  if(batch)assert(localRequests[1].fullBatchReceived&&localRequests[1].batchPages===expectedBatchPages,'second local CLI request must contain every byte of the complete bounded batch');
  assert(result.code===1&&!result.timedOut,'intentional local 400 must fail without timeout');assert(incomplete,'one read page cannot become complete evidence');assert(issues.length===0,'fixture must have no capture or process errors');
  row.passed=true;
 }finally{
  if(cleanup)try{await cleanup();}catch{row.cleanupFailed=true;}
  if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  await session.close();fs.rmSync(root,{recursive:true,force:true});
  if(process.env.CM_REVIEW_MATERIAL_CLI_RESULT)fs.writeFileSync(process.env.CM_REVIEW_MATERIAL_CLI_RESULT+'.'+variant+'.json',JSON.stringify(row,null,2)+'\n',{mode:0o600});
  process.stdout.write(JSON.stringify({fixture:'review-material-real-cli',passed:row.passed===true,localRequests:localRequests.length,
   realModelRequests:0,fullPageReceived:localRequests[1]?.fullPageReceived===true,fullBatchReceived:localRequests[1]?.fullBatchReceived===true,batchPages:localRequests[1]?.batchPages??1,validIndependentReview:false,cliVersion})+'\n');
 }
});
