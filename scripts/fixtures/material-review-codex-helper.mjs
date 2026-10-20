// Synthetic CLI fixtures only: use the real fixed material server/coverage ledger.
// This is not a model or independent implementation review.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
export async function expandMaterialFixturePrompt(args,prompt,{pageLimit=Infinity,batchCount=8,boundaryDelayMs=0,onToolResult=()=>{}}={}){
 const settings=args.filter((_,i)=>args[i-1]==='-c');
 const encoded=settings.find(v=>v.startsWith('mcp_servers=')&&v.includes('review-material-server.mjs'));
 if(!encoded)return prompt;
 const command=JSON.parse(/command\s*=\s*("(?:\\.|[^"\\])*")/.exec(encoded)[1]);
 const argv=JSON.parse(/args\s*=\s*(\[[^\]]*\])/.exec(encoded)[1]);
 const child=spawn(command,argv,{stdio:['pipe','pipe','pipe']});child.stderr.resume();let seq=0;const pending=new Map();
 createInterface({input:child.stdout}).on('line',line=>{const r=JSON.parse(line);pending.get(r.id)?.(r.result);pending.delete(r.id);});
 const rpc=(method,params={})=>new Promise(resolve=>{const id=++seq;pending.set(id,resolve);child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
 try{
  await rpc('initialize');const catalog=await rpc('tools/list');assert.deepEqual(catalog.tools.map(t=>t.name),['read_material']);
  if(settings.includes('model_provider="cm_local_tool_preview"')){
   const provider=settings.find(v=>v.startsWith('model_providers.cm_local_tool_preview='));
   const base=/base_url="(http:\/\/127\.0\.0\.1:\d+\/v1)"/.exec(provider)[1];
   const model=JSON.parse(settings.find(v=>v.startsWith('model=')).slice(6));
   const r=await fetch(base+'/responses',{method:'POST',headers:{authorization:'Bearer cm-js-synthetic-local-probe'},body:JSON.stringify({model,input:[],tools:catalog.tools.map(t=>({type:'function',name:'mcp__cm_review__'+t.name}))})});await r.text();return null;
  }
  const manifest=JSON.parse(prompt.split('<cm-review-material-manifest>\n')[1]);let result='';
  for(let page=0;page<Math.min(manifest.pageCount,pageLimit);){
   const count=Math.min(batchCount,Math.min(manifest.pageCount,pageLimit)-page);
   const r=await rpc('tools/call',{name:'read_material',arguments:batchCount===1?{page}:{page,count}});assert(!r.isError);
   const value=JSON.parse(r.content[0].text),pages=value.version===1?[value]:value.pages;
   assert(pages.length>=1&&pages.length<=count);
   for(const p of pages){assert.equal(p.page,page++);assert.equal(p.pageSha256,manifest.pages[p.page].sha256);result+=p.content;}
   if(value.version===2)assert.equal(value.nextPage,page<manifest.pageCount?page:null);
   onToolResult(r);
   if(boundaryDelayMs)await new Promise(resolve=>setTimeout(resolve,boundaryDelayMs));
  }
  return pageLimit<manifest.pageCount?prompt:result;
 }finally{child.stdin.end();await new Promise(resolve=>child.once('close',resolve));}
}
