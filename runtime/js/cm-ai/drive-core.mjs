// JSONL host driver transport shared by cm-fix and cm-ai. Policy stays in each driver.
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import readline from 'node:readline';
import {guidanceText} from './operator-guidance.mjs';
import {applyRateLimitResume,nextRateLimitRetry,rateLimitedReview,rateLimitRetriesDone,RATE_LIMIT_RETRY_ENV} from './drive-rate-limit.mjs';

export const stderr=line=>process.stderr.write(`[drive] ${line}\n`);
const waitWords=ms=>ms<60000?`${Math.max(1,Math.ceil(ms/1000))} 秒`:`${Math.round(ms/60000)} 分钟`;
export const stop=(code,line)=>{stderr(line);process.exit(code);};
export function planCheckTimeout(plan,item=null){
  const valid=value=>Number.isInteger(value)&&value>=1&&value<=3600000;
  if(Object.hasOwn(plan,'checkTimeoutMs')&&!valid(plan.checkTimeoutMs))throw Error('PLAN.checkTimeoutMs 需要 1..3600000 的整数');
  if(item!==null&&Object.hasOwn(item,'timeoutMs')&&!valid(item.timeoutMs))throw Error('PLAN.checks timeoutMs 需要 1..3600000 的整数');
  return item?.timeoutMs??plan.checkTimeoutMs??900000;
}

export function readJson(file,label){
  try{return JSON.parse(fs.readFileSync(file,'utf8'));}
  catch(error){if(error.code==='ENOENT')return undefined;stop(2,`${label} 不是合法 JSON: ${file}`);}
}

export function loadPlanFile({argv=process.argv.slice(2),name,known}){
  const at=argv.indexOf('--plan');
  const operation=argv.find((arg,index)=>index!==at&&index!==at+1&&!arg.startsWith('--'));
  if(at===-1||!argv[at+1]||!operation)stop(2,`用法: ${name} --plan PLAN.json <operation>`);
  if(!known.has(operation))stop(2,`不认识的步骤 ${operation}；宿主支持的见 ${name.replace('-drive','-host')} --help`);
  const planPath=path.resolve(argv[at+1]),base=path.dirname(planPath);
  let plan;
  try{plan=JSON.parse(fs.readFileSync(planPath,'utf8'));}
  catch(error){stop(2,`读不了 ${planPath}: ${error.code??error.message}`);}
  // A rate-limit re-run (driveHost below) resumes the run its first command created.
  if(plan&&typeof plan==='object')applyRateLimitResume(plan);
  return {operation,plan,base};
}

export function requireFields(value,keys){
  for(const key of keys)if(!Object.hasOwn(value,key))stop(2,`PLAN 缺少字段 ${key}`);
}

export function preflightAnswers(kinds,load){
  const answers={};
  for(const kind of kinds)answers[kind]=load(kind);
  return answers;
}

export const hostResponseFailed=row=>Boolean(row.error||row.result?.state==='unknown'
  ||row.result?.pendingAction==='reconcile');
// A static answer cannot be corrected and resent, so a rejected reply would
// leave the host waiting forever on the same call. Say why and end the session.
const rejectedReplyHint=code=>code==='host_response_too_large'
  ?'应答超过宿主输入上限：在 PLAN.permissions 加 "--input-limit","<字节数>"（65536–4194304，默认 65536）'
  :code==='host_response_late'?'应答到得太晚：宿主已按应答期限或取消停止等待这次反问（期限见 CM_HOST_ANSWER_TIMEOUT_MINUTES）'
  :'应答与宿主这次反问不匹配（会话、调用或请求摘要不对）';

// beforeRequest runs after host_ready, i.e. after the host itself accepted every
// launch input, admission and the run store, and before the operation is sent.
// A returned refusal closes the session without any operation and exits 2.
// A driver that deliberately leaves a host question unanswered (a re-asked
// confirmation the current user must decide) ends with exit code 2, whatever the
// host's final row says, so callers see a stop that needs a person.
let deliberateStop=false;
export function deliberatelyUnanswered(message){
  if(!deliberateStop){deliberateStop=true;process.on('exit',()=>{process.exitCode=2;});}
  return Object.assign(new Error(message),{code:'confirm_reask_decision_required'});
}
// Transport-only budgets: no field is added to a run or its configuration hash.
// The long fallback covers hosts that cannot advertise individual phase budgets.
export const DRIVE_LIVENESS_DEFAULTS=Object.freeze({startupMs:60000,operationMs:21600000,
  heartbeatMs:30000,graceMs:30000,closeMs:5000,killMs:1000,pollMs:250});
// rateLimitRetry (cm-ai drivers only, drive-rate-limit.mjs): a review the provider
// rate limited is redispatched by re-running this same driver command after a
// wait, without printing the interim result or notifying; the re-run's result is
// the one printed. Only the runner's automatic pending_review state qualifies.
export function driveHost({host,args,cwd,operation,request={},answers,paths,answerFor,beforeRequest=null,liveness={},sessionBoundary=null,rateLimitRetry=false}){
  const budget={...DRIVE_LIVENESS_DEFAULTS,...liveness};
  for(const value of Object.values(budget))if(!Number.isSafeInteger(value)||value<1)throw Error('driver_liveness_invalid');
  const ownGroup=process.platform!=='win32';
  // Notices on: name the project and session they will show, so a notice can be matched to this session.
  import('../notify.mjs').then(({notifyIdentityLine})=>{const line=notifyIdentityLine({cwd,args});if(line)stderr(line);}).catch(()=>{});
  const child=spawn(process.execPath,[host,...args],{cwd,stdio:['pipe','pipe','pipe'],detached:ownGroup,
    env:{...process.env,CM_HOST_HEARTBEAT:'1'}});
  const control=new AbortController();
  child.stderr.on('data',chunk=>process.stderr.write(chunk));
  let done=false,refused=false,rejected=null,unanswered=false,finalRow=null,finalAt=null,noticed=false,failureCode=null,retry=null;
  const retriesDone=rateLimitRetriesDone();
  let sessionId=null,ready=false,heartbeat=false,lastBeat=0,waitingFor='drive',stopping=false,closed=false;
  let deadline=Date.now()+budget.startupMs,phase='startup',closeDeadline=null,killTimer=null,forceTimer=null;
  // Optional notices never change the result or make watchdog failures successful.
  // A stop that is not a person's decision waits waitMinutes and is dropped if
  // the session moves on (notifyLater); a rate limit after this driver's own
  // retries is sent at once and says how many were tried.
  const sendNotice=(fields,mod)=>{
    if(!failureCode&&rateLimitedReview(finalRow)&&retriesDone>0)fields={...fields,rateLimitRetries:retriesDone,delivery:'now'};
    return fields.delivery==='later'?mod.notifyLater(fields):mod.notify(fields);
  };
  const notice=failure=>{
    if(noticed)return;noticed=true;
    if(retry!==null&&!failure){waitAndRetry();return;}
    if(retry!==null)releaseRetry();
    if(rejected!==null)failure='host_response_rejected';else if(!failure&&unanswered&&!finalRow)failure='host_request_unanswered';
    import('../notify.mjs').then(mod=>{
      const {driveNotice,driveProgressKey,clearAttention}=mod;
      const fields=driveNotice({host,cwd,args,operation,row:finalRow,failure});
      if(fields)return sendNotice(fields,mod);
      const progress=driveProgressKey({host,cwd,args,operation,row:finalRow,failure});
      // The step moved on when its final result arrived, not when the host closed later.
      return progress&&finalAt!==null?clearAttention(progress,{before:finalAt}):null;
    }).catch(()=>{});
  };
  // The interim rate-limited result is printed only if the re-run cannot start.
  const printFinal=row=>{
    process.stdout.write(JSON.stringify(row,null,2)+'\n');
    // The driver prints the session-boundary verdict itself so the model only relays it;
    if(typeof sessionBoundary==='function'&&!row.error){let block=null;try{block=sessionBoundary(row.result,operation);}catch{stderr('会话边界结论生成失败；请按技能输出模板手写三行结论（业务结果不受影响）');}
      // stderr, not stdout: callers parse stdout as one JSON result.
      if(typeof block==='string'&&block)process.stderr.write(block+'\n');}
    const guidance=guidanceText(row.result);if(guidance)stderr(guidance);
    if(row.result?.stage)stderr(`stage = ${row.result.stage}`);
    if(row.error)stderr(`宿主拒绝：${row.error.code}（真实原因和位置在上面 [host] 那行 diagnostic 里）`);
  };
  // A host failure after the result was chosen for a retry: show it as usual.
  const releaseRetry=()=>{printFinal(finalRow);retry=null;};
  const waitAndRetry=()=>{
    const pending=retry;
    // Backstop: if this waiting driver is killed, the stop is still sent once
    // the wait and waitMinutes have passed; the re-run's start cancels it.
    import('../notify.mjs').then(mod=>{
      const fields=mod.driveNotice({host,cwd,args,operation,row:finalRow,failure:null});
      return fields?mod.notifyLater({...fields,rateLimitWaiting:true},{extraDelayMs:pending.delayMs}):null;
    }).catch(()=>{});
    const timer=setTimeout(()=>{
      stderr(`审查限流等待结束，在原运行重派审查（第 ${pending.attempt}/${pending.max} 次）`);
      let rerun;
      try{rerun=spawn(process.execPath,[...process.execArgv,process.argv[1],...process.argv.slice(2)],{cwd:process.cwd(),stdio:'inherit',
        env:{...process.env,[RATE_LIMIT_RETRY_ENV]:String(pending.attempt)}});}
      catch{rerun=null;}
      const failed=()=>{
        stderr('自动重派没能启动：下面是限流时的原结果，请回到会话说「继续」');
        printFinal(finalRow);process.exitCode=hostResponseFailed(finalRow)?1:0;
        import('../notify.mjs').then(mod=>{const fields=mod.driveNotice({host,cwd,args,operation,row:finalRow,failure:null});
          return fields?mod.notify({...fields,rateLimitWaiting:true}):null;}).catch(()=>{});
      };
      if(!rerun){failed();return;}
      rerun.once('error',failed);
      rerun.once('exit',(code,signal)=>{process.exitCode=code??(signal?1:0);});
    },pending.delayMs);
    void timer;
  };
  const signalOwnHost=(signal,cleanup=false)=>{
    if((closed&&!cleanup)||!child.pid)return;
    try{if(ownGroup)process.kill(-child.pid,signal);else child.kill(signal);}catch{}
  };
  const fail=(code,reason,message)=>{
    if(stopping||closed)return;
    stopping=true;failureCode=reason;control.abort();process.exitCode=code;
    stderr(`${reason}：${message}；未写入成功或取消结果；清理仅覆盖本驾驶员创建的进程组，脱离该组的后代须另行核对，恢复前请核对原运行`);
    // Only the process/group created here is eligible for cleanup. Never inspect
    // or signal PIDs received from a host message or another run's heartbeat.
    signalOwnHost('SIGTERM');
    killTimer=setTimeout(()=>{
      signalOwnHost('SIGKILL',true);
      if(closed)return;
      forceTimer=setTimeout(()=>{child.stdin.destroy();child.stdout.destroy();child.stderr.destroy();child.unref();clearInterval(watchdog);notice(failureCode);},budget.killMs);
      forceTimer.unref();
    },budget.killMs);
    // Keep cleanup alive after the host exits: same-group workers can ignore
    // SIGTERM and use stdio:ignore, so child.close does not prove group exit.
  };
  const send=value=>{
    if(stopping||closed)return;
    if(child.stdin.destroyed||child.stdin.writableEnded){fail(74,'host_pipe_closed','宿主输入管道没有可写端');return;}
    try{child.stdin.write(JSON.stringify(value)+'\n',error=>{if(error)fail(74,'host_pipe_closed','宿主输入管道已关闭，无法发送请求');});}
    catch{fail(74,'host_pipe_closed','宿主输入管道已关闭，无法发送请求');}
  };
  const closeHost=force=>{
    if(stopping||closed)return;
    closeDeadline=Date.now()+budget.closeMs;
    if(force)stderr('显式 force 关闭无法继续应答的宿主；在途步骤可能进入 unknown，请核对原运行');
    send({type:'host_close',sessionId,...(force?{force:true}:{})});
    if(force&&!heartbeat){
      stderr('旧宿主未声明关闭握手能力：已显式请求 force，随后结束输入以兼容旧宿主；在途步骤可能进入 unknown');
      child.stdin.end();
    }
  };
  const phaseDeadlines=new Map();
  const phaseBudget=inFlight=>{
    const candidates=[];
    for(const [prefix,value,id] of [['call',inFlight?.call,inFlight?.call?.callId],
      ['native',inFlight?.nativeStage,inFlight?.nativeStage?.id]]){
      if(typeof id!=='string'||!Number.isSafeInteger(value?.deadlineMs))continue;
      const key=`${prefix}:${id}`;
      // Keep the first announced deadline, including while a nested phase is
      // active. A heartbeat or return to its enclosing phase cannot extend it.
      if(!phaseDeadlines.has(key))phaseDeadlines.set(key,value.deadlineMs+budget.graceMs);
      candidates.push({key,deadline:phaseDeadlines.get(key)});
    }
    if(candidates.length){phase=candidates.map(item=>item.key).join('|');deadline=Math.min(...candidates.map(item=>item.deadline));}
    else if(phase!=='operation'){phase='operation';deadline=Date.now()+budget.operationMs;}
  };
  const watchdog=setInterval(()=>{
    if(stopping||closed)return;
    const now=Date.now();
    if(closeDeadline!==null){if(now>closeDeadline)fail(failureCode==='host_exited'?71:75,failureCode==='host_exited'?'host_exited':'host_close_timeout','宿主或其继承管道未在关闭期限内退出');return;}
    if(ready&&heartbeat&&now-lastBeat>budget.heartbeatMs){fail(72,'host_heartbeat_timeout','宿主心跳超时，进程可能已卡死');return;}
    if(now>deadline)fail(ready?73:70,ready?'host_stage_timeout':'host_start_timeout',ready?'当前阶段超过已声明期限或有界后备期限':'宿主未在启动期限内发出 host_ready');
  },budget.pollMs);
  child.stdin.on('error',()=>fail(74,'host_pipe_closed','宿主输入管道已关闭，无法继续写入'));
  child.stdin.on('close',()=>{if(!done&&!refused&&!unanswered&&rejected===null&&!stopping&&!closed&&failureCode!=='host_exited')fail(74,'host_pipe_closed','宿主输入管道提前关闭');});
  const lines=readline.createInterface({input:child.stdout});
  lines.on('line',async line=>{
    let row;try{row=JSON.parse(line);}catch{process.stdout.write(line+'\n');return;}
    if(stopping||closed||done)return;
    if(row.type==='host_heartbeat'){
      if(ready&&heartbeat&&row.sessionId===sessionId){lastBeat=Date.now();phaseBudget(row.inFlight);}
      return;
    }
    if(row.type==='host_ready'){
      if(ready)return;
      ready=true;sessionId=row.sessionId;heartbeat=Boolean(row.heartbeat);lastBeat=Date.now();
      // The host accepted a new step of this session: a deferred stop from before is no longer news.
      const startedAt=Date.now();
      import('../notify.mjs').then(({driveAttentionKey,cancelPendingNotice})=>{
        const key=driveAttentionKey({host,cwd,args,operation});return key?cancelPendingNotice(key,{before:startedAt}):null;}).catch(()=>{});
      phase='operation';deadline=Date.now()+budget.operationMs;
      if(beforeRequest){
        let refusal;
        try{refusal=await beforeRequest();}catch(error){refusal=`发送操作前的准备失败：${error.message}`;}
        if(stopping||closed)return;
        if(refusal){refused=true;failureCode='driver_refused';stderr(refusal);process.exitCode=2;closeHost(false);return;}
      }
      send({requestId:'drive',operation,...request});return;
    }
    if(row.type==='host_request'){
      if(done||unanswered||rejected!==null)return;
      let result;
      try{result=await answerFor(row,answers,paths,{signal:control.signal});}catch(error){stderr(`应答 ${row.kind} 失败：${error.message}`);result=null;}
      if(control.signal.aborted||stopping||closed)return;
      if(result===null){
        unanswered=true;process.exitCode=deliberateStop?2:1;
        stderr(`宿主问了预检没覆盖的问题 ${row.kind}，无法应答`);
        closeHost(true);return;
      }
      stderr(`应答 ${row.kind}`);
      send({type:'host_result',sessionId:row.sessionId,callId:row.callId,requestDigest:row.requestDigest,result});
      return;
    }
    if(row.type==='host_response'){
      if(row.code==='host_close_busy'){
        stderr('host_close_busy：宿主仍有在途工作；继续等待原请求结果');closeDeadline=null;return;
      }
      if(row.accepted===true&&row.closing===true){child.stdin.end();return;}
      if(row.accepted===false&&rejected===null){
        rejected=typeof row.code==='string'?row.code:'host_response_rejected';control.abort();process.exitCode=1;
        stderr(`宿主拒收了应答：${rejected}；${rejectedReplyHint(rejected)}`);
        closeHost(true);
      }
      return;
    }
    if(row.requestId===waitingFor||row.requestId==='drive'){
      if(row.error?.code==='host_busy'){
        const inFlight=row.error.inFlight;
        if(typeof inFlight?.requestId==='string')waitingFor=inFlight.requestId;
        phaseBudget(inFlight);stderr(`host_busy：上一步仍在执行，继续等待 ${waitingFor} 的结果`);return;
      }
      done=true;finalRow=row;finalAt=Date.now();control.abort();
      retry=rateLimitRetry&&!deliberateStop&&!refused&&!unanswered&&rejected===null?nextRateLimitRetry(row):null;
      if(retry)stderr(`审查被限流（reviewer_rate_limited），${waitWords(retry.delayMs)}后在原运行自动重派审查（第 ${retry.attempt}/${retry.max} 次）；等待期间不推送，也不用你处理`);
      else printFinal(row);
      process.exitCode=deliberateStop||refused?2:hostResponseFailed(row)||rejected!==null||unanswered?1:0;
      // Normal EOF follows a final result. The explicit force compatibility
      // path for a legacy host is separately logged by closeHost above.
      closeDeadline=Date.now()+budget.closeMs;child.stdin.end();
    }
  });
  child.on('error',()=>fail(71,'host_start_failed','宿主进程无法启动'));
  child.on('exit',(code,signal)=>{
    control.abort();
    if(!done&&!refused&&!stopping&&!unanswered&&rejected===null){
      failureCode='host_exited';stderr(`host_exited：宿主在给出结果前退出了，exit ${code}，signal ${signal??'none'}`);process.exitCode=71;closeDeadline=Date.now()+budget.closeMs;
    }
  });
  // close drains stdout so a buffered final result can still determine outcome.
  child.on('close',()=>{
    // stdout has drained now; absence of a final result is definitive. Clean
    // this spawn's process group even if ignored stdio let its leader close.
    if(!done&&!refused&&!unanswered&&rejected===null&&!stopping)fail(71,'host_exited','宿主未返回结果，清理其在途进程组');
    closed=true;control.abort();clearInterval(watchdog);
    if(!stopping)clearTimeout(killTimer);
    clearTimeout(forceTimer);lines.close();notice(failureCode??(done?null:'host_exited'));
  });
}
