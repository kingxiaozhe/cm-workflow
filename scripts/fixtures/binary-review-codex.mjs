// Synthetic Codex stream; actual registered MCP reads and sandboxed font check.
// Its local HTTP request is a tool-surface probe, never a model invocation.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
const args=process.argv.slice(2),settings=args.filter((_,index)=>args[index-1]==='-c');
const configText=settings.filter(value=>value.startsWith('mcp_servers')).join('\n');
const commandMatch=/command\s*=\s*("(?:\\.|[^"\\])*")/.exec(configText);
const argsMatch=/args\s*=\s*(\[[^\]]*\])/.exec(configText);
assert(commandMatch&&argsMatch,'the fixed cm_review stdio transport is required');
const config={command:JSON.parse(commandMatch[1]),args:JSON.parse(argsMatch[1])};
assert.equal(config.command,process.execPath);assert.equal(config.args.length,2);
assert(config.args[0].endsWith('/runtime/js/cm-fix/review-verification-server.mjs'));
const modeIndex=args.indexOf('--fixture-mode'),mode=modeIndex<0?'valid':args[modeIndex+1];
let prompt='';for await(const chunk of process.stdin)prompt+=chunk;
const probe=settings.includes('model_provider="cm_local_tool_preview"');
const server=spawn(config.command,config.args,{stdio:['pipe','pipe','pipe']});server.stderr.resume();
let sequence=0;const pending=new Map();
createInterface({input:server.stdout}).on('line',line=>{
 const reply=JSON.parse(line);pending.get(reply.id)?.(reply.result);pending.delete(reply.id);
});
const rpc=(method,params={})=>new Promise(resolve=>{
 const id=++sequence;pending.set(id,resolve);server.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
});
const emit=event=>process.stdout.write(JSON.stringify(event)+'\n');
try{
 await rpc('initialize');const catalog=await rpc('tools/list');assert(catalog.tools.some(tool=>tool.name==='read_binary'));
 if(probe){
  const provider=settings.find(value=>value.startsWith('model_providers.cm_local_tool_preview='));
  const base=/base_url="(http:\/\/127\.0\.0\.1:\d+\/v1)"/.exec(provider)?.[1];assert(base,'probe target must be local');
  const model=JSON.parse(settings.find(value=>value.startsWith('model=')).slice(6));
  const response=await fetch(base+'/responses',{method:'POST',headers:{authorization:'Bearer cm-js-synthetic-local-probe'},
   body:JSON.stringify({model,input:[],tools:catalog.tools.map(tool=>({type:'function',name:'mcp__cm_review__'+tool.name}))})});
  await response.text();process.exitCode=1;
 }else{
  assert(!prompt.includes('Use no tools and do not execute code.'));
  const data=JSON.parse(prompt.split('<cm-review-data-json>\n')[1].split('\n')[0]);
  emit({type:'thread.started',thread_id:'synthetic-binary-codex-review'});emit({type:'turn.started'});
  emit({type:'item.completed',item:{id:'intro',type:'agent_message',text:'Inspecting isolated font bytes before the final JSON.'}});
  const call=async(name,input)=>{
   const item={id:'tool-'+sequence,type:'mcp_tool_call',server:'cm_review',tool:name,arguments:input};
   emit({type:'item.started',item});const result=await rpc('tools/call',{name,arguments:input});
   emit({type:'item.completed',item:{...item,status:'completed',result}});
   assert(!result.isError,JSON.stringify(result));return JSON.parse(result.content[0].text);
  };
  if(mode!=='metadata-only'){
   // Mixed text/font review reads the exact text snapshot as well as each
   // package-bound original/current binary version.
   for(const change of data.reviewPackage.changes){
    if(change.after&&!change.after.contentBlob)await call('read_file',{path:change.path});
    for(const version of ['before','after'])if(change[version]?.contentBlob)await call('read_binary',{path:change.path,version,length:16});
   }
   for(const record of data.reviewPackage.unchangedScope??[])if(record.contentBlob)await call('read_binary',{path:record.path,length:16});
   await call('run_check',{id:'asset-integrity'});
  }
  const result={verdict:'approved',packageDigest:data.reviewPackage.packageDigest,examinedPaths:data.examinedPaths,
   findings:[],summary:'Synthetic Codex protocol fixture; exact isolated font reads/checks, no model review.'};
  emit({type:'item.completed',item:{id:'answer',type:'agent_message',text:JSON.stringify(result)}});emit({type:'turn.completed'});
 }
}finally{server.stdin.end();await new Promise(resolve=>server.once('close',resolve));}
