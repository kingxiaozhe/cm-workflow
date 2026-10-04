// JSONL host driver transport shared by cm-fix and cm-ai. Policy stays in each driver.
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import readline from 'node:readline';
import {guidanceText} from './operator-guidance.mjs';

export const stderr=line=>process.stderr.write(`[drive] ${line}\n`);
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
  :'应答与宿主这次反问不匹配（会话、调用或请求摘要不对）';

// beforeRequest runs after host_ready, i.e. after the host itself accepted every
// launch input, admission and the run store, and before the operation is sent.
// A returned refusal closes the session without any operation and exits 2.
export function driveHost({host,args,cwd,operation,request={},answers,paths,answerFor,beforeRequest=null}){
  const child=spawn(process.execPath,[host,...args],{cwd,stdio:['pipe','pipe','pipe']});
  const control=new AbortController();
  child.stderr.on('data',chunk=>process.stderr.write(chunk));
  // After a rejected reply the session is ended; later rows get no answer.
  const send=value=>{if(!child.stdin.writableEnded)child.stdin.write(JSON.stringify(value)+'\n');};
  let done=false,refused=false,rejected=null;
  readline.createInterface({input:child.stdout}).on('line',async line=>{
    let row;try{row=JSON.parse(line);}catch{process.stdout.write(line+'\n');return;}
    if(row.type==='host_ready'){
      if(beforeRequest){
        let refusal;
        try{refusal=await beforeRequest();}catch(error){refusal=`发送操作前的准备失败：${error.message}`;}
        if(refusal){refused=true;stderr(refusal);process.exitCode=2;send({type:'host_close',sessionId:row.sessionId});child.stdin.end();return;}
      }
      send({requestId:'drive',operation,...request});return;
    }
    if(row.type==='host_request'){
      let result;
      try{result=await answerFor(row,answers,paths,{signal:control.signal});}catch(error){stderr(`应答 ${row.kind} 失败：${error.message}`);result=null;}
      if(control.signal.aborted)return;
      if(result===null){
        stderr(`宿主问了预检没覆盖的问题 ${row.kind}，无法应答；这一步会留在 unknown`);
        send({type:'host_close',sessionId:row.sessionId});return;
      }
      stderr(`应答 ${row.kind}`);
      send({type:'host_result',sessionId:row.sessionId,callId:row.callId,requestDigest:row.requestDigest,result});
      return;
    }
    if(row.type==='host_response'){
      if(row.accepted===false&&rejected===null){
        rejected=typeof row.code==='string'?row.code:'host_response_rejected';
        control.abort();
        stderr(`宿主拒收了应答：${rejected}；${rejectedReplyHint(rejected)}。驾驶员不再等待，已结束会话；宿主会把这一步记为 unknown`);
        child.stdin.end();
      }
      return;
    }
    if(row.requestId==='drive'){
      done=true;
      control.abort();
      process.stdout.write(JSON.stringify(row,null,2)+'\n');
      const guidance=guidanceText(row.result);if(guidance)stderr(guidance);
      if(row.result?.stage)stderr(`stage = ${row.result.stage}`);
      if(row.error)stderr(`宿主拒绝：${row.error.code}（真实原因和位置在上面 [host] 那行 diagnostic 里）`);
      process.exitCode=hostResponseFailed(row)||rejected!==null?1:0;
      child.stdin.end();
    }
  });
  child.on('error',error=>{control.abort();stderr(`宿主启动失败：${error.message}`);process.exitCode=1;});
  child.on('exit',code=>{control.abort();if(!done&&!refused){stderr(`宿主在给出结果前退出了，exit ${code}`);process.exitCode=1;}});
}
