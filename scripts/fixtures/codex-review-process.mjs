#!/usr/bin/env node
// Synthetic CLI process for isolated tests only. No model service or code edits.
import {randomUUID} from 'node:crypto';
let prompt='';for await(const part of process.stdin)prompt+=part;
const args=process.argv.slice(2),settings=args.filter((_,index)=>args[index-1]==='-c');
if(settings.includes('model_provider="cm_local_tool_preview"')){
  const setting=settings.find(value=>value.startsWith('model_providers.cm_local_tool_preview='));
  const base=/base_url="(http:\/\/127\.0\.0\.1:\d+\/v1)"/.exec(setting)?.[1];
  if(!base)throw Error('nonlocal fixture target');
  const model=JSON.parse(settings.find(value=>value.startsWith('model=')).slice(6));
  await fetch(base+'/responses',{method:'POST',headers:{authorization:'Bearer cm-js-synthetic-local-probe'},
    body:JSON.stringify({model,input:[],tools:[]})});
  process.exitCode=1; // The local diagnostic sink deliberately rejects the request.
}else{
  const marker='<cm-review-data-json>\n';
  const data=JSON.parse(prompt.slice(prompt.indexOf(marker)+marker.length));
  const result={verdict:'approved',packageDigest:data.reviewPackage.packageDigest,
    examinedPaths:data.examinedPaths,findings:[],summary:'Synthetic process review, not model evidence'};
  for(const value of [{type:'thread.started',thread_id:randomUUID()},{type:'turn.started'},
    {type:'item.completed',item:{type:'agent_message',text:JSON.stringify(result)}},{type:'turn.completed'}])
    process.stdout.write(JSON.stringify(value)+'\n');
}
