// Synthetic request capture only. No forwarding, review package, grant or task mutation.
import fs from 'node:fs';
import {verificationTools} from '../cm-fix/review-verification-contract.mjs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {gunzipSync,zstdDecompressSync} from 'node:zlib';
import {claudeWorker,claudeReviewFingerprint,claudeAliasModelMatches} from './worker-claude.mjs';

const UNRECOGNIZED_MODEL_MARKER='[claude-code:unrecognized_model]';
export function createClaudeModelMarkerDetector(onMarker) {
  let matched=0,found=false,reported=false,jsonTail='';
  const report=()=>{
    if(reported||!found)return;
    reported=true;
    let model=null;
    try {
      const value=JSON.parse(jsonTail.trim());
      if(typeof value?.model==='string'&&/^[a-zA-Z0-9._-]+$/.test(value.model))model=value.model;
    }catch{}
    onMarker({reported_model:model});
    jsonTail='';
  };
  return {
    accept(chunk){
      for(const char of String(chunk)){
        if(reported)break;
        if(found){
          if(char==='\n'||char==='\r'){report();continue;}
          if(jsonTail.length<512)jsonTail+=char;
          else report();
        }else if(char===UNRECOGNIZED_MODEL_MARKER[matched]){
          matched++;
          if(matched===UNRECOGNIZED_MODEL_MARKER.length)found=true;
        }else matched=char===UNRECOGNIZED_MODEL_MARKER[0]?1:0;
      }
    },
    finish:report,
  };
}

export function claudeProbeSandbox(temp,port,writeRoot=null) {
  if(!path.isAbsolute(temp)||!Number.isInteger(port)||port<1||port>65535)throw Error('invalid_probe');
  return `(version 1)(allow default)(deny network*)
    (allow network-outbound (remote ip "localhost:${port}"))
    (deny file-write*)(allow file-write* (subpath ${JSON.stringify(temp)}) (literal "/dev/null") ${writeRoot?`(subpath ${JSON.stringify(writeRoot)})`:""})`;
}

export async function previewClaudeTools(options) {
  const alias=['default','opus','sonnet','haiku'].includes(options.model);
  // The verification transport owns a single-use server. Discovery is tool-free;
  // only the exact concrete-id probe may consume that transport/profile.
  const captured=await probeClaudeTools(alias?{...options,verification:null,verificationTransport:null}:options,alias);
  if(!alias||!captured.preflight.passed)return captured;
  const resolved=captured.preflight.observed_models;
  if(resolved?.length!==1)return {...captured,preflight:{...captured.preflight,passed:false}};
  // Discovery is never a passing public receipt. Issue one only after a fresh,
  // exact-id probe. Returning the concrete model lets existing owner/configuration
  // digests pin it without a new journal shape or a mutable alias on resume.
  const verified=await probeClaudeTools({...options,model:resolved[0]},false);
  if(!verified.preflight.passed)return {...captured,preflight:{...captured.preflight,passed:false,
    resolution_check:verified.preflight}};
  return {...verified,preflight:{...verified.preflight,model_resolution:{requested_model:options.model,
    resolved_model:resolved[0],resolution_context:'synthetic-api-key-probe'}}};
}
async function probeClaudeTools({cwd,model,effort,cli='claude',spawnProcess=spawn,verification=null,verificationTransport=null},discoverAlias) {
  if(process.platform!=='darwin'||!fs.existsSync('/usr/bin/sandbox-exec')) {
    throw Object.assign(Error('unsupported_probe_isolation'),{code:'unsupported_probe_isolation'});
  }
  cwd=fs.realpathSync(cwd);
  if(!fs.statSync(cwd).isDirectory())throw Error('invalid_code_project');
  const fingerprint=claudeReviewFingerprint({cwd,model,effort,cli,verification});
  const temp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-claude-probe-')));
  const observations=[];
  const controller=new AbortController();let stoppedByProbe=false,modelMarker=null;
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
          model_matches:discoverAlias?claudeAliasModelMatches(model,data.model):data.model===model,messages_array:Array.isArray(data.messages),
          tools_allowed:Array.isArray(tools)&&(verification
            ?verificationTools(verification).every(name=>tools.some(t=>t.name===name))&&tools.every(t=>t.name==='StructuredOutput'||verificationTools(verification).includes(t.name))
            :tools.length===0||(tools.length===1&&tools[0]?.name==='StructuredOutput')),
          synthetic_auth:request.headers['x-api-key']==='cm-synthetic-local-probe'};
        safe={...(claudeAliasModelMatches('default',data.model)?{observedModel:data.model}:{}),valid:Object.values(checks).every(Boolean),checks:{...checks,...(verification?{tool_names:tools.map(t=>typeof t?.name==='string'?t.name.slice(0,80):'invalid').slice(0,16)}:{})}};
      }catch{}
      // Never retain raw request bodies, auth headers, local context or diagnostics.
      if(index<8)observations[index]=safe;
      response.writeHead(400,{'Content-Type':'application/json'});
      response.end(JSON.stringify({type:'error',error:{type:'invalid_request_error',message:'CM_LOCAL_PROBE_STOP'}}));
      // Stop after the first valid request; a CLI retry may already be in flight.
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
    const worker=claudeWorker({cwd,model,effort,cli,preflight,timeoutMs:15000,verification,verificationTransport,
      spawnProcess:(command,args,options)=>{
        const child=spawnProcess('/usr/bin/sandbox-exec',
          ['-p',claudeProbeSandbox(temp,port,verificationTransport?.cwd?path.dirname(verificationTransport.cwd):null),command,...args],{...options,env:{...options.env,
          ANTHROPIC_API_KEY:'cm-synthetic-local-probe',ANTHROPIC_BASE_URL:`http://127.0.0.1:${port}`,
          CLAUDE_CONFIG_DIR:temp,CLAUDE_CODE_TMPDIR:temp,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',TMPDIR:temp}});
        const detector=createClaudeModelMarkerDetector(value=>{modelMarker=value;});
        child.stderr.on('data',detector.accept);
        child.stderr.once('end',detector.finish);
        return child;
      }});
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
  const observedModels=[...new Set(messages.map(item=>item.observedModel).filter(Boolean))];
  return {model,...(effort===undefined?{}:{effort}),disabledSkills:[],preflight:{provider:'claude',prompt_transport:'stdin',
    config_fingerprint:fingerprint,passed:(!discoverAlias||observedModels.length===1)&&modelMarker===null&&messages.length>=1&&messages.length<=2&&messages.every(message=>message.valid)
      &&stoppedByProbe&&result?.status==='cancelled'&&closeEvidence!==null&&!closeEvidence.timed_out,
    ...(observedModels.length?{observed_models:observedModels}:{}),
    local_requests:observations.length,message_requests:messages.length,message_requests_expected:'1-2',
    listener_closed:closed,isolation:'macos-loopback-sandbox',
    process_code:result?.code??'unknown',stopped_by_probe:stoppedByProbe,exit_code:closeEvidence?.exit_code??null,
    request_checks:[...observations.map(item=>item.startup?{startup:true}:item.checks??{complete:false}),
      ...(modelMarker?[{model_recognized:false,...modelMarker}]:[])]}};
}
