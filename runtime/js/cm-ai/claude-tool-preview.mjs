// Synthetic request capture only. No forwarding, review package, grant or task mutation.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {gunzipSync,zstdDecompressSync} from 'node:zlib';
import {claudeWorker,claudeReviewFingerprint} from './worker-claude.mjs';

export function claudeProbeSandbox(temp,port) {
  if(!path.isAbsolute(temp)||!Number.isInteger(port)||port<1||port>65535)throw Error('invalid_probe');
  return `(version 1)(allow default)(deny network*)
    (allow network-outbound (remote ip "localhost:${port}"))
    (deny file-write*)(allow file-write* (subpath ${JSON.stringify(temp)}) (literal "/dev/null"))`;
}

export async function previewClaudeTools({cwd,model,cli='claude',spawnProcess=spawn}) {
  if(process.platform!=='darwin'||!fs.existsSync('/usr/bin/sandbox-exec')) {
    throw Object.assign(Error('unsupported_probe_isolation'),{code:'unsupported_probe_isolation'});
  }
  cwd=fs.realpathSync(cwd);
  if(!fs.statSync(cwd).isDirectory())throw Error('invalid_code_project');
  const fingerprint=claudeReviewFingerprint({cwd,model,cli});
  const temp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-claude-probe-')));
  const observations=[];
  const controller=new AbortController();let stoppedByProbe=false;
  const server=http.createServer((request,response)=>{
    const index=observations.length;
    if(index<8)observations.push({valid:false});else observations[0]={valid:false};
    let chunks=[],size=0;
    request.on('error',()=>{});
    request.on('data',chunk=>{
      size+=chunk.length;
      if(size>1_000_000){chunks=[];request.destroy();return;}
      chunks.push(chunk);
    });
    request.on('end',()=>{
      const encoding=request.headers['content-encoding']??'identity';
      let endpoint;
      try{endpoint=new URL(request.url,'http://127.0.0.1').pathname;}
      catch{
        response.writeHead(400,{'Content-Type':'application/json'});response.end('{}');return;
      }
      // Installed CLI probes this endpoint before sending its messages request.
      // A single empty GET/HEAD may receive a fixed health response, never a model answer.
      if(['GET','HEAD'].includes(request.method)&&endpoint==='/api/hello'&&size===0
        &&!observations.some(item=>item.startup===true)){
        if(index<8)observations[index]={valid:false,startup:true};
        response.writeHead(200,{'Content-Type':'application/json'});response.end('{}');return;
      }
      let safe={valid:false,checks:{json:false,encoding_supported:['identity','gzip','zstd'].includes(encoding),
        post:request.method==='POST',messages_endpoint:endpoint==='/v1/messages',
        models_endpoint:endpoint==='/v1/models',hello_endpoint:endpoint==='/api/hello',root_endpoint:endpoint==='/',
        body_present:size>0}};
      try {
        let body=Buffer.concat(chunks);
        if(encoding==='gzip')body=gunzipSync(body,{maxOutputLength:1_000_000});
        else if(encoding==='zstd')body=zstdDecompressSync(body,{maxOutputLength:1_000_000});
        else if(encoding!=='identity')throw Error('unsupported_encoding');
        const data=JSON.parse(body.toString('utf8'));
        const tools=data.tools??[];
        const checks={json:true,post:request.method==='POST',
          messages_endpoint:new URL(request.url,'http://127.0.0.1').pathname==='/v1/messages',
          model_matches:data.model===model,messages_array:Array.isArray(data.messages),
          tools_empty:Array.isArray(tools)&&tools.length===0,
          synthetic_auth:request.headers['x-api-key']==='cm-synthetic-local-probe'};
        safe={valid:Object.values(checks).every(Boolean),checks};
      }catch{}
      // Never retain raw request bodies, auth headers, local context or diagnostics.
      if(index<8)observations[index]=safe;
      response.writeHead(400,{'Content-Type':'application/json'});
      response.end(JSON.stringify({type:'error',error:{type:'invalid_request_error',message:'CM_LOCAL_PROBE_STOP'}}));
      // Inspection is finished; do not let CLI-internal repair/retry issue another model request.
      if(safe.valid){stoppedByProbe=true;controller.abort();}
    });
  });
  server.requestTimeout=5000;server.headersTimeout=5000;
  let result,closeEvidence=null,closed=false;
  try {
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    const port=server.address().port;
    const preflight={passed:true,provider:'claude',prompt_transport:'stdin',config_fingerprint:fingerprint};
    // Internal diagnostic bootstrap: same worker lifecycle, forced sink and synthetic prompt only.
    // This object is never returned as a passing receipt without examining the captured request.
    const worker=claudeWorker({cwd,model,cli,preflight,timeoutMs:15000,
      spawnProcess:(command,args,options)=>spawnProcess('/usr/bin/sandbox-exec',
        ['-p',claudeProbeSandbox(temp,port),command,...args],{...options,env:{...options.env,
          ANTHROPIC_API_KEY:'cm-synthetic-local-probe',ANTHROPIC_BASE_URL:`http://127.0.0.1:${port}`,
          CLAUDE_CONFIG_DIR:temp,CLAUDE_CODE_TMPDIR:temp,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',TMPDIR:temp}})});
    result=await worker({prompt:'Return JSON for synthetic diagnostic task CM-PROBE-001.'},
      {signal:controller.signal,onEvent:event=>{
        if(event.event==='process_closed')closeEvidence=event;
      }});
  } finally {
    server.closeAllConnections();
    await new Promise(resolve=>server.close(()=>resolve()));closed=true;
    fs.rmSync(temp,{recursive:true,force:true});
  }
  const messages=observations.filter(item=>item.startup!==true);
  return {model,disabledSkills:[],preflight:{provider:'claude',prompt_transport:'stdin',
    config_fingerprint:fingerprint,passed:messages.length===1&&messages[0].valid
      &&stoppedByProbe&&result?.status==='cancelled'&&closeEvidence!==null&&!closeEvidence.timed_out,
    local_requests:observations.length,message_requests:messages.length,listener_closed:closed,isolation:'macos-loopback-sandbox',
    process_code:result?.code??'unknown',stopped_by_probe:stoppedByProbe,exit_code:closeEvidence?.exit_code??null,
    request_checks:observations.map(item=>item.startup?{startup:true}:item.checks??{complete:false})}};
}
