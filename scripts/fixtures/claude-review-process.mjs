#!/usr/bin/env node
// Synthetic stdout protocol fixture only, never a model-generated review.
import {randomUUID} from 'node:crypto';
let prompt='';for await(const part of process.stdin)prompt+=part;
if(process.env.ANTHROPIC_API_KEY==='cm-synthetic-local-probe'){
  const base=process.env.ANTHROPIC_BASE_URL;
  if(!/^http:\/\/127\.0\.0\.1:\d+$/.test(base))throw Error('nonlocal fixture target');
  const args=process.argv.slice(2),model=args[args.indexOf('--model')+1];
  if(model==='fixture-invalid-target'){
    const {request}=await import('node:http'),url=new URL(base);
    await new Promise((resolve,reject)=>{
      const req=request({host:url.hostname,port:url.port,path:'http://['},res=>{res.resume();res.on('end',resolve);});
      req.on('error',reject);req.end();
    });process.exit(1);
  }
  const hello=await fetch(base+'/api/hello',{method:'HEAD'});if(hello.status!==200)process.exit(1);
  await fetch(base+'/v1/messages?beta=true',{method:'POST',headers:{'x-api-key':'cm-synthetic-local-probe'},
    body:JSON.stringify({model,messages:[{role:'user',content:prompt}],tools:[]})});
  if(model==='fixture-plain-error')process.exit(1);
  const session_id=randomUUID();
  process.stdout.write(JSON.stringify({type:'system',subtype:'init',session_id})+'\n');
  process.stdout.write(JSON.stringify({type:'result',subtype:'error_during_execution',session_id,is_error:true})+'\n');
  process.exit(1);
}
const marker='<cm-review-data-json>\n';
const data=JSON.parse(prompt.slice(prompt.indexOf(marker)+marker.length));
const value={verdict:'approved',packageDigest:data.reviewPackage.packageDigest,
  examinedPaths:data.examinedPaths,findings:[],summary:'Synthetic Claude protocol fixture'};
const session_id=randomUUID();
for(const event of [
  {type:'system',subtype:'init',session_id},
  {type:'assistant',session_id,parent_tool_use_id:null,
    message:{role:'assistant',content:[{type:'text',text:JSON.stringify(value)}]}},
  {type:'result',subtype:'success',session_id,is_error:false,num_turns:1,result:JSON.stringify(value)},
]) process.stdout.write(JSON.stringify(event)+'\n');
