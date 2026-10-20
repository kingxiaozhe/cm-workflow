// Synthetic CLI; actual MCP and sandboxed integrity check, never a model.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
const args=process.argv.slice(2),pick=k=>args[args.indexOf(k)+1];
assert(args.includes('--restricted'));assert.equal(pick('--tools'),'');
let prompt='';for await(const chunk of process.stdin)prompt+=chunk;
const probe=process.env.ANTHROPIC_API_KEY==='cm-synthetic-local-probe';
const data=probe?null:JSON.parse(prompt.split('<cm-review-data-json>\n')[1].split('\n')[0]);
const config=JSON.parse(pick('--mcp-config')).mcpServers.cm_review;
const server=spawn(config.command,config.args,{stdio:['pipe','pipe','pipe']});server.stderr.resume();
let seq=0;const pending=new Map();
createInterface({input:server.stdout}).on('line',line=>{const r=JSON.parse(line);pending.get(r.id)?.(r.result);pending.delete(r.id);});
const rpc=(method,params={})=>new Promise(resolve=>{const id=++seq;pending.set(id,resolve);server.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
const emit=r=>process.stdout.write(JSON.stringify({...r,session_id:'synthetic-binary-review'})+'\n');
try{
 await rpc('initialize');const catalog=await rpc('tools/list');assert(catalog.tools.some(t=>t.name==='read_binary'));
 emit({type:'system',subtype:'init'});
 if(probe){
  const http=await import('node:http');await new Promise((resolve,reject)=>{
   const req=http.request(new URL('/v1/messages',process.env.ANTHROPIC_BASE_URL),{method:'POST',headers:{'x-api-key':'cm-synthetic-local-probe','content-type':'application/json'}},res=>{res.resume();res.on('end',resolve);});req.on('error',reject);
   req.end(JSON.stringify({model:pick('--model'),messages:[{role:'user',content:'Synthetic binary probe'}],tools:[{name:'StructuredOutput'},...catalog.tools.map(t=>({name:'mcp__cm_review__'+t.name}))]}));
  });
 }else{
  assert(!prompt.includes('Use no tools and do not execute code.'));
  const call=async(name,input)=>{
   const id='tool-'+seq;emit({type:'assistant',parent_tool_use_id:null,message:{role:'assistant',content:[{type:'tool_use',id,name:'mcp__cm_review__'+name,input}]}});
   const r=await rpc('tools/call',{name,arguments:input});
   emit({type:'user',message:{role:'user',content:[{type:'tool_result',tool_use_id:id,is_error:r.isError===true,content:JSON.stringify(r.content)}]}});
   assert(!r.isError,JSON.stringify(r));return JSON.parse(r.content[0].text);
  };
  const mode=process.env.CM_BINARY_REVIEW_FIXTURE_MODE??'valid';
  if(mode!=='metadata-only'){
   for(const c of data.reviewPackage.changes)for(const version of ['before','after'])if(c[version]?.contentBlob){
    if(mode==='missing-before'&&version==='before')continue;
    await call('read_binary',{path:c.path,version,length:16});
   }
   for(const r of data.reviewPackage.unchangedScope??[])if(r.contentBlob)await call('read_binary',{path:r.path,length:16});
   await call('run_check',{id:'asset-integrity'});
  }
  emit({type:'assistant',parent_tool_use_id:null,message:{role:'assistant',content:[{type:'text',text:'Synthetic checked result'}]}});
  emit({type:'result',subtype:'success',is_error:false,num_turns:4,structured_output:{verdict:'approved',packageDigest:data.reviewPackage.packageDigest,examinedPaths:data.examinedPaths,findings:[],summary:'Synthetic protocol fixture; actual isolated asset checks, no model review.'}});
 }
}finally{server.stdin.end();await new Promise(resolve=>server.once('close',resolve));}
