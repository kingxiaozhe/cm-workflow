// Narrow stdio MCP transport; only this server's three fixed operations exist.
import fs from 'node:fs';
import {createInterface} from 'node:readline';
import {createVerificationTools} from './review-verification.mjs';
// A dispatch owns one server for its lifetime. A restart must fail closed instead
// of clearing accumulated evidence or running a second mutation concurrently.
try{const fd=fs.openSync(process.argv[2]+'.server-started','wx',384);fs.closeSync(fd);}
catch{process.stderr.write('review_verification_server_already_started\n');process.exit(1);}
const config=JSON.parse(fs.readFileSync(process.argv[2],'utf8')),tools=createVerificationTools(config);
const schema=(properties,required=Object.keys(properties))=>({type:'object',properties,required,additionalProperties:false});
const str={type:'string'},checkId={type:'string',enum:config.configuration.checks.map(c=>c.id)};
const registeredIds=JSON.stringify(checkId.enum);
const catalog=[
 {name:'read_file',description:'Read at most 16 KiB of one registered UTF-8 file from the isolated snapshot. Optional offset is a UTF-8 byte cursor (default 0); follow nextOffset until null. sha256 covers the whole file. Cursors must be character boundaries.',inputSchema:schema({path:str,offset:{type:'integer',minimum:0,maximum:2*1024*1024}},['path'])},
 {name:'run_check',description:`Run only a registered check in the OS sandbox. Valid IDs: ${registeredIds}. Package check labels are not tool IDs.`,inputSchema:schema({id:checkId})},
 {name:'mutate_check',description:'Run baseline, exact unique source mutation, check, exact restoration, restored check. Never edits original source.',inputSchema:schema({path:{type:'string',enum:config.configuration.mutationPaths},find:str,replace:str,checkId})},
];
if(config.configuration.binaryAssets)catalog.push({name:'read_binary',description:'Read at most 16 KiB from one exact package-bound binary version. version defaults to after; before reads the private archived original, including deleted files. SHA covers the full version; examinedPath is the approved project path.',
 inputSchema:schema({path:{type:'string',enum:config.configuration.binaryAssets.paths},version:{type:'string',enum:['before','after']},
 offset:{type:'integer',minimum:0,maximum:128*1024*1024},length:{type:'integer',minimum:1,maximum:16384}},['path'])});
let queue=Promise.resolve(),count=0;const controller=new AbortController();
for(const sig of ['SIGTERM','SIGINT'])process.on(sig,()=>{controller.abort();});
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
const input=createInterface({input:process.stdin,crlfDelay:Infinity});
input.on('line',line=>{
 if(Buffer.byteLength(line)>65536||++count>(config.configuration.binaryReview?256:64)){controller.abort();input.close();return;}
 queue=queue.then(async()=>{
 let r;try{r=JSON.parse(line);if(r.id===undefined)return;
  let result;
  if(r.method==='initialize')result={protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'cm-review-verification',version:'1.0.0'}};
  else if(r.method==='ping')result={};
  else if(r.method==='tools/list')result={tools:config.configuration.binaryReview?catalog.filter(t=>t.name!=='mutate_check').map(t=>({...t,annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false}})):catalog};
  else if(r.method==='tools/call'){
   try{const value=await tools.call(r.params.name,r.params.arguments,controller.signal);result={content:[{type:'text',text:JSON.stringify(value)}]};}
   catch(e){result={isError:true,content:[{type:'text',text:/^[a-z_]+$/.test(e.code??'')?e.code:'review_verification_failed'}]};}
  }else {send({jsonrpc:'2.0',id:r.id,error:{code:-32601,message:'Method not found'}});return;}
  send({jsonrpc:'2.0',id:r.id,result});
 }catch{if(r?.id!==undefined)send({jsonrpc:'2.0',id:r.id,error:{code:-32600,message:'Invalid request'}});}
 });
});
input.on('close',()=>controller.abort());
