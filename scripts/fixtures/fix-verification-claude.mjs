// Synthetic CLI protocol fixture. Exercises the real MCP server, never a model.
import fs from 'node:fs';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import assert from 'node:assert/strict';
const args=process.argv.slice(2),pick=key=>args[args.indexOf(key)+1];
assert(args.includes('--restricted'));assert(!args.includes('--safe-mode'));assert.equal(pick('--tools'),'');
const config=JSON.parse(pick('--mcp-config')).mcpServers.cm_review;
let prompt='';for await(const chunk of process.stdin)prompt+=chunk;
assert(!prompt.includes('Use no tools and do not execute code.'));
const probe=process.env.ANTHROPIC_API_KEY==='cm-synthetic-local-probe';
const data=probe?null:JSON.parse(prompt.split('<cm-review-data-json>\n')[1].split('\n')[0]);
const server=spawn(config.command,config.args,{stdio:['pipe','pipe','pipe']});server.stderr.resume();
const pending=new Map();let seq=0;
createInterface({input:server.stdout}).on('line',line=>{const value=JSON.parse(line);pending.get(value.id)?.(value.result);pending.delete(value.id);});
const rpc=(method,params={})=>new Promise(resolve=>{const id=++seq;pending.set(id,resolve);server.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
const session_id='synthetic-isolated-review',emit=value=>process.stdout.write(JSON.stringify({...value,session_id})+'\n');
try{
 await rpc('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'fixture',version:'1'}});
 const catalog=await rpc('tools/list');assert.deepEqual(catalog.tools.map(t=>t.name),['read_file','run_check','mutate_check']);
 assert.deepEqual(catalog.tools[1].inputSchema.properties.id.enum,['unit']);
 assert.deepEqual(catalog.tools[2].inputSchema.properties.checkId.enum,['unit']);
 emit({type:'system',subtype:'init'});
 if(probe){
  const http=await import('node:http');
  await new Promise((resolve,reject)=>{
   const req=http.request(new URL('/v1/messages',process.env.ANTHROPIC_BASE_URL),{method:'POST',headers:{'x-api-key':'cm-synthetic-local-probe','content-type':'application/json'}},res=>{res.resume();res.on('end',resolve);});req.on('error',reject);
   req.end(JSON.stringify({model:pick('--model'),messages:[{role:'user',content:'Synthetic local probe'}],tools:[{name:'StructuredOutput'},...catalog.tools.map(t=>({name:'mcp__cm_review__'+t.name}))]}));
  });
 }else{

 const call=async(name,input)=>{
  const id='tool-'+seq;emit({type:'assistant',parent_tool_use_id:null,message:{role:'assistant',content:[{type:'tool_use',id,name:'mcp__cm_review__'+name,input}]}});
  const result=await rpc('tools/call',{name,arguments:input});
  emit({type:'user',message:{role:'user',content:[{type:'tool_result',tool_use_id:id,is_error:result.isError===true,content:JSON.stringify(result.content)}]}});
  assert(!result.isError,JSON.stringify(result));return JSON.parse(result.content[0].text);
 };
 const file=await call('read_file',{path:'value.mjs'});assert(file.content.includes('value=1'));
 const mode=process.env.CM_VERIFICATION_FIXTURE_MODE??'valid';
 assert.equal((await call('run_check',{id:'unit'})).exitCode,mode==='failed-check'?1:0);
 if(mode==='valid')assert.equal((await call('mutate_check',{path:'value.mjs',find:'value=1',replace:'value=2',checkId:'unit'})).killed,true);
 emit({type:'result',subtype:'success',is_error:false,num_turns:4,structured_output:{verdict:'approved',packageDigest:data.reviewPackage.packageDigest,examinedPaths:data.examinedPaths,findings:[],summary:'Synthetic CLI transport and actual isolated commands; not a model review.'}});
}
}finally{server.stdin.end();await new Promise(resolve=>server.once('close',resolve));}
