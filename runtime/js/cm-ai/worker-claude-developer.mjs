// Read-only Claude process: edits are text proposals consumed by the protected host.
import {spawn} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {claudeBaseArgs,claudeEnvironment} from './worker-claude.mjs';
import {reportClaudeRateLimitNotice} from './claude-review-stream.mjs';
import {need,text,validCallTimeout,json,shape} from './effect-contract.mjs';

export function claudeDeveloperArgs(model){
  const args=claudeBaseArgs(model),index=args.indexOf('--tools');
  args[index+1]='Read,Grep,Glob';
  const schema=JSON.parse(readFileSync(new URL('./claude-developer-proposal.schema.json',import.meta.url),'utf8'));
  delete schema.$schema;delete schema.$id;
  return [...args,'--allowedTools','Read,Grep,Glob','--json-schema',JSON.stringify(schema)];
}

export function validateClaudeProposal(raw){
  const result=json(raw,64*1024); // Existing 64 KiB transport contract.
  need(result&&['succeeded','failed'].includes(result.status),'invalid_result');
  if(result.status==='failed'){
    shape(result,['status','code']);need(typeof result.code==='string'&&result.code.length>0,'invalid_result');return result;
  }
  shape(result,['status','value','edits']);
  const value=result.value,nullable=v=>v===null||typeof v==='string';
  need(value&&typeof value==='object','invalid_result');
  shape(value,['outcome',...['application','retrospective'].filter(key=>Object.hasOwn(value,key))]);
  need(['implemented','blocked'].includes(value.outcome),'invalid_result');
  if(Object.hasOwn(value,'application')){
    shape(value.application,['status','note']);
    need(['applied','no_relevant_lesson'].includes(value.application.status)&&nullable(value.application.note),'invalid_result');
  }
  if(Object.hasOwn(value,'retrospective')){
    const retrospective=value.retrospective;
    shape(retrospective,['status','candidates','reason']);
    need(['no_new_lesson','lesson_candidate','writeback_pending'].includes(retrospective.status)
      &&nullable(retrospective.reason)&&Array.isArray(retrospective.candidates)&&retrospective.candidates.length<=3,'invalid_result');
    for(const candidate of retrospective.candidates){
      shape(candidate,['classification','trigger','action','evidence']);
      need(['structured','memory_only'].includes(candidate.classification)&&typeof candidate.trigger==='string'
        &&typeof candidate.action==='string'&&Array.isArray(candidate.evidence)
        &&candidate.evidence.every(item=>typeof item==='string'),'invalid_result');
    }
  }
  need(Array.isArray(result.edits)&&result.edits.length<=64,'protected_edit_invalid');
  for(const edit of result.edits){
    shape(edit,['path','beforeSha256','content']);
    need(typeof edit.path==='string'&&edit.path.length>0
      &&(edit.beforeSha256===null||(typeof edit.beforeSha256==='string'&&/^[a-f0-9]{64}$/.test(edit.beforeSha256))),'protected_edit_invalid');
    need(edit.content===null||(typeof edit.content==='string'
      &&!/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(edit.content)
      &&Buffer.from(edit.content,'utf8').toString('utf8')===edit.content),'protected_edit_invalid');
  }
  return result;
}

function createClaudeDeveloperStream(onNotice=null){
  let session=null,done=false,value,assistant=false,noticeCount=0,thinkingCount=0;
  const tools=new Set();
  return {
    accept(event){
      need(event&&typeof event==='object'&&!Array.isArray(event)&&!done,'invalid_event');
      need(typeof event.session_id==='string'&&event.session_id.length>0&&event.session_id.length<=128,'invalid_session');
      if(session===null){
        need(event.type==='system'&&event.subtype==='init','missing_init');session=event.session_id;return;
      }
      need(event.session_id===session,'session_mismatch');
      if(event.type==='rate_limit_event'){
        need(noticeCount<8,'unexpected_event');noticeCount++;
        reportClaudeRateLimitNotice(event.rate_limit_info,onNotice);return;
      }
      if(event.type==='system'){
        need(event.subtype==='thinking_tokens'&&thinkingCount<64,'unexpected_event');thinkingCount++;return;
      }
      if(event.type==='assistant'){
        need(event.parent_tool_use_id===null&&event.error==null&&event.message?.role==='assistant','unexpected_assistant');
        need(Array.isArray(event.message.content)&&event.message.content.length>0,'invalid_event');
        let substantive=false;
        for(const block of event.message.content){
          if(['thinking','redacted_thinking'].includes(block?.type))continue;
          substantive=true;
          if(block.type==='text'){need(typeof block.text==='string','invalid_event');continue;}
          need(block.type==='tool_use'&&['Read','Grep','Glob','StructuredOutput'].includes(block.name)
            &&typeof block.id==='string'&&!tools.has(block.id),'unexpected_tool_or_content');tools.add(block.id);
        }
        if(substantive)assistant=true;return;
      }
      if(event.type==='user'){
        need(event.message?.role==='user'&&Array.isArray(event.message.content),'invalid_event');
        for(const block of event.message.content){need(block.type==='tool_result'&&tools.has(block.tool_use_id),'unexpected_tool_or_content');tools.delete(block.tool_use_id);}
        return;
      }
      need(event.type==='result','unexpected_event');
      need(event.subtype==='success'&&event.is_error===false,'provider_failed');
      need(assistant&&tools.size===0&&Number.isInteger(event.num_turns)&&event.num_turns>=1,'unexpected_result');
      let proposal=event.structured_output;
      if(!Object.hasOwn(event,'structured_output')){
        try{proposal=JSON.parse(event.result);}catch{need(false,'invalid_output_json');}
      }
      value=validateClaudeProposal(proposal);done=true;
    },
    finish(){need(done,'incomplete_result');return {...value,providerThread:session};},
  };
}

export function claudeDeveloperWorker({cwd,model,cli='claude',timeoutMs=1800000,spawnProcess=spawn,onNotice=null}) {
  validCallTimeout(timeoutMs);
  const args=claudeDeveloperArgs(model);
  let used=false;
  return async (request,{signal})=>{
    text(request.prompt);need(Buffer.byteLength(request.prompt)<=11*1024*1024,'limit_exceeded');
    if(signal.aborted)return {status:'cancelled',code:'cancelled_before_dispatch'};
    // Windows requires a job-object/process-tree owner before enabling coding.
    if(process.platform==='win32')return {status:'unavailable',code:'process_tree_unsupported'};
    if(used)return {status:'unavailable',code:'worker_dispatch_limit'};
    used=true;
    return new Promise(resolve=>{
      let child;
      try{child=spawnProcess(cli,args,{cwd,env:claudeEnvironment(),stdio:['pipe','pipe','pipe'],shell:false,detached:true});}
      catch{resolve({status:'unavailable',code:'spawn_failed'});return;}
      let buffer='',bytes=0;
      const stream=createClaudeDeveloperStream(onNotice);
      let failure=null,closed=false,timer,cleanup;
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
        if(!line.trim()||failure)return;
        try{stream.accept(JSON.parse(line));}catch(error){stop(error.code??'invalid_event');}
      };
      child.stderr.resume();
      child.stdout.setEncoding('utf8');
      child.stdout.on('data',chunk=>{
        if(failure||closed)return;
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
        if(failure||code!==0||exitSignal){
          resolve({status:['spawn_failed','provider_failed'].includes(failure)?'unavailable':'unknown',code:failure??'incomplete_result'});return;
        }
        try{resolve(stream.finish());}
        catch{resolve({status:'unknown',code:'invalid_output_json'});}
      });
      try{child.stdin.end(request.prompt);}catch{stop('prompt_write_failed');}
    });
  };
}
