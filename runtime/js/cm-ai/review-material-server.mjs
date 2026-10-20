// One fixed read-only MCP operation over an immutable host-created prompt.
import {createInterface} from 'node:readline';
import {openReviewMaterialReader,REVIEW_MATERIAL_BATCH_PAGES} from './review-material.mjs';
let reader;
try{reader=openReviewMaterialReader(process.argv[2]);}
catch{process.stderr.write('review_material_server_unavailable\n');process.exit(1);}
const tool={name:'read_material',description:'Read complete consecutive UTF-8 pages of the bound immutable review prompt. Prefer count:8 and follow nextPage until null; a batch may be shorter to respect output limits. Read every page from 0 through pageCount-1 before returning a verdict. Omit count only for the legacy single-page response. No project files or commands are available.',
 inputSchema:{type:'object',properties:{page:{type:'integer',minimum:0,maximum:reader.manifest.pageCount-1},count:{type:'integer',minimum:1,maximum:REVIEW_MATERIAL_BATCH_PAGES}},required:['page'],additionalProperties:false},
 annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false}};
const input=createInterface({input:process.stdin,crlfDelay:Infinity});let count=0;
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
input.on('line',line=>{
 if(Buffer.byteLength(line)>4096||++count>272){input.close();return;}
 let request;
 try{
  request=JSON.parse(line);if(request.id===undefined)return;
  let result;
  if(request.method==='initialize')result={protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'cm-review-material',version:'1.0.0'}};
  else if(request.method==='ping')result={};
  else if(request.method==='tools/list')result={tools:[tool]};
  else if(request.method==='tools/call'){
   try{const value=reader.call(request.params?.name,request.params?.arguments);result={content:[{type:'text',text:JSON.stringify(value)}]};}
   catch(error){result={isError:true,content:[{type:'text',text:/^review_material_[a-z_]+$/.test(error.code??'')?error.code:'review_material_failed'}]};}
  }else{send({jsonrpc:'2.0',id:request.id,error:{code:-32601,message:'Method not found'}});return;}
  send({jsonrpc:'2.0',id:request.id,result});
 }catch{if(request?.id!==undefined)send({jsonrpc:'2.0',id:request.id,error:{code:-32600,message:'Invalid request'}});}
});
