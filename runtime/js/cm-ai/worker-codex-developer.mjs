import {createProviderUsageCapture} from './provider-usage.mjs';
// Coding subprocess only. The host must authorize the task and select an isolated
// code workspace; workspace-write is not a per-file scope enforcement mechanism.
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {commonArgs,cleanEnvironment,specsPermissionArgs} from './codex-config.mjs';
import {need,text,validCallTimeout,json} from './effect-contract.mjs';
import {CODEX_RECONNECT_NOTICE_LIMIT,isCodexReconnectNotice} from './codex-reconnect-notice.mjs';
import {codexRateLimited} from './worker-codex.mjs';
// A provider terminal (failed turn) still lets the usage of a later turn.failed through.
const PROVIDER_ENDED=new Set(['provider_failed']);

export function developerArgs({cwd,model,effort,schemaPath,disabledSkills=[],specsRoot=null}) {
  text(cwd);text(schemaPath);
  const args=commonArgs({cwd,model,effort,disabledSkills}),coding=new Set(['shell_tool','unified_exec']);
  const result=[];
  for(let i=0;i<args.length;i++){
    if(specsRoot!==null&&args[i]==='--sandbox'){i++;continue;}
    // Codex 0.153.4 uses code_mode_host for tool execution; keep its default
    // on the coding path without enabling the separate code_mode feature.
    if(args[i]==='--disable'&&(coding.has(args[i+1])||args[i+1]==='code_mode_host')){i++;continue;}
    result.push(args[i]==='read-only'&&args[i-1]==='--sandbox'?'workspace-write':args[i]);
  }
  return [...result,...[...coding].flatMap(name=>['--enable',name]),
    ...(specsRoot===null?['-c','sandbox_workspace_write.network_access=false']:specsPermissionArgs({cwd,specsRoot})),
    '--output-schema',schemaPath,'-'];
}

export function codexDeveloperWorker({cwd,model,effort,learning=true,specsRoot=null,
  schemaPath=fileURLToPath(new URL(learning?'./codex-developer-output.schema.json':'./codex-developer-basic-output.schema.json',import.meta.url)),
  disabledSkills=[],cli='codex',
  timeoutMs=1800000,spawnProcess=spawn,onNotice=null,onUsage=null,onUsageClaim=null}) {
  validCallTimeout(timeoutMs);
  const args=developerArgs({cwd,model,effort,schemaPath,disabledSkills,specsRoot});
  let used=false;
  return async (request,{signal})=>{
    text(request.prompt);need(Buffer.byteLength(request.prompt)<=11*1024*1024,'limit_exceeded');
    if(signal.aborted)return {status:'cancelled',code:'cancelled_before_dispatch'};
    // Windows requires a job-object/process-tree owner before enabling coding.
    if(process.platform==='win32')return {status:'unavailable',code:'process_tree_unsupported'};
    if(used)return {status:'unavailable',code:'worker_dispatch_limit'};
    // A host may retain a worker while awaiting approval. Recheck physical roots
    // immediately before dispatch, not only when the configuration was built.
    if(specsRoot!==null){
      try{specsPermissionArgs({cwd,specsRoot});}
      catch{return {status:'unavailable',code:'specs_protection_invalid'};}
    }
    used=true;
    const usage=createProviderUsageCapture('codex',onUsage);
    try{onUsageClaim?.();}catch{}
    return new Promise(resolve=>{
      let child;
      try{child=spawnProcess(cli,args,{cwd,env:cleanEnvironment(),stdio:['pipe','pipe','pipe'],shell:false,detached:true});}
      catch{usage.complete();resolve({status:'unavailable',code:'spawn_failed'});return;}
      let buffer='',bytes=0,thread=null,turnStarted=false,completed=false,lastMessage=null;
      let failure=null,closed=false,timer,cleanup,noticeCount=0,reconnectNoticeCount=0,rateLimited=false;
      const signalGroup=signalName=>{
        if(!Number.isInteger(child.pid)||child.pid<=0)return false;
        try{process.kill(-child.pid,signalName);return true;}
        catch(error){if(error.code!=='ESRCH')failure??='process_cleanup_failed';return false;}
      };
      const cleanGroup=()=>{
        if(cleanup)return cleanup;
        if(!signalGroup('SIGTERM'))return cleanup=Promise.resolve();
        // Keep escalation alive even when the leader closes its own pipes first.
        cleanup=new Promise(done=>setTimeout(()=>{signalGroup('SIGKILL');done();},1000));
        return cleanup;
      };
      const stop=code=>{
        failure??=code;
        if(closed)return;
        cleanGroup();
      };
      const abort=()=>stop('cancelled');
      signal.addEventListener('abort',abort,{once:true});
      timer=setTimeout(()=>stop('timeout'),timeoutMs);
      if(signal.aborted)abort();
      const accept=line=>{
        if(!line.trim()||failure&&!PROVIDER_ENDED.has(failure))return;
        let event;try{event=JSON.parse(line);}catch{stop('invalid_event');return;}
        if(!event||Array.isArray(event)||typeof event.type!=='string'){stop('invalid_event');return;}
        if(event.type==='turn.failed'&&thread&&turnStarted&&!completed)usage.terminal(event.usage);
        // Like the Codex reviewer (worker-codex.mjs): every failure event of the turn,
        // the first or a later one, may name the rate limit; only the class is kept.
        if((event.type==='error'&&!isCodexReconnectNotice(event)||event.type==='turn.failed')&&codexRateLimited(event))rateLimited=true;
        if(PROVIDER_ENDED.has(failure))return;
        // Reconnects may precede thread initialization, but never bypass a
        // completed turn. Keep their budget separate from item notices.
        if(!completed&&isCodexReconnectNotice(event)&&reconnectNoticeCount<CODEX_RECONNECT_NOTICE_LIMIT){
          reconnectNoticeCount++;
          try{if(typeof onNotice==='function')onNotice(event.message.slice(0,200));}catch{}
          return;
        }
        if(event.type==='error'||event.type==='turn.failed'){stop('provider_failed');return;}
        if(completed){
          stop(event.type==='item.completed'&&event.item?.type==='error'?'invalid_event':'event_after_terminal');return;
        }
        if(event.type==='thread.started'){
          if(thread!==null||typeof event.thread_id!=='string'||!event.thread_id.trim()){stop('thread_mismatch');return;}
          thread=event.thread_id;return;
        }
        if(!thread){stop('thread_missing');return;}
        // CLI notices may precede turn.started; report only bounded message text.
        if(event.type==='item.completed'&&event.item?.type==='error'){
          if(typeof event.item.message!=='string'||noticeCount>=8){stop('invalid_event');return;}
          noticeCount++;
          try{if(typeof onNotice==='function')onNotice(event.item.message.slice(0,200));}catch{}
          return;
        }
        if(event.type==='turn.started'){
          if(turnStarted){stop('duplicate_turn');return;}turnStarted=true;return;
        }
        if(!turnStarted){stop('turn_missing');return;}
        if(event.type==='turn.completed'){completed=true;usage.terminal(event.usage);return;}
        if(!['item.started','item.updated','item.completed'].includes(event.type)
          ||!event.item||typeof event.item.type!=='string'){stop('invalid_event');return;}
        // Tool output stays private. Failed test commands can be a legitimate red
        // phase; their exit codes are not a substitute for the host's checks.
        if(!['agent_message','reasoning','command_execution','file_change','todo_list'].includes(event.item.type)){
          stop('unexpected_tool_or_item');return;
        }
        if(event.type==='item.completed'&&event.item.type==='agent_message'){
          if(typeof event.item.text!=='string'){stop('invalid_event');return;}
          lastMessage=event.item.text;
        }
      };
      child.stderr.resume();
      child.stdout.setEncoding('utf8');
      child.stdout.on('data',chunk=>{
        if(failure&&!PROVIDER_ENDED.has(failure)||closed)return;
        bytes+=Buffer.byteLength(chunk);if(bytes>4*1024*1024){stop('output_limit');return;}
        buffer+=chunk;let index;
        while((index=buffer.indexOf('\n'))!==-1){accept(buffer.slice(0,index));buffer=buffer.slice(index+1);}
      });
      child.stdout.on('error',()=>stop('output_read_failed'));
      child.stderr.on('error',()=>stop('output_read_failed'));
      child.stdin.on('error',()=>stop('prompt_write_failed'));
      child.once('error',()=>{failure??='spawn_failed';});
      // Background commands must not outlive a normally exiting coding leader.
      child.once('exit',()=>{cleanGroup();});
      child.once('close',async(code,exitSignal)=>{
        closed=true;clearTimeout(timer);signal.removeEventListener('abort',abort);
        await cleanGroup();
        if(buffer.trim())accept(buffer);
        usage.complete();
        if(failure||code!==0||exitSignal||!completed||lastMessage===null){
          // provider_failed stays the internal terminal; the published code names a rate limit.
          resolve({status:failure==='spawn_failed'?'unavailable':'unknown',
            code:failure==='provider_failed'&&rateLimited?'developer_rate_limited':failure??'incomplete_result'});return;
        }
        try{resolve({status:'succeeded',value:json(JSON.parse(lastMessage)),providerThread:thread});}
        catch{resolve({status:'unknown',code:'invalid_output_json'});}
      });
      try{child.stdin.end(request.prompt);}catch{stop('prompt_write_failed');}
    });
  };
}
