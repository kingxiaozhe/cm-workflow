// JSONL host driver transport shared by cm-fix and cm-ai. Policy stays in each driver.
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import readline from 'node:readline';

export const stderr=line=>process.stderr.write(`[drive] ${line}\n`);
export const stop=(code,line)=>{stderr(line);process.exit(code);};

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

export function driveHost({host,args,cwd,operation,request={},answers,paths,answerFor}){
  const child=spawn(process.execPath,[host,...args],{cwd,stdio:['pipe','pipe','pipe']});
  child.stderr.on('data',chunk=>process.stderr.write(chunk));
  const send=value=>child.stdin.write(JSON.stringify(value)+'\n');
  let done=false;
  readline.createInterface({input:child.stdout}).on('line',async line=>{
    let row;try{row=JSON.parse(line);}catch{process.stdout.write(line+'\n');return;}
    if(row.type==='host_ready'){send({requestId:'drive',operation,...request});return;}
    if(row.type==='host_request'){
      let result;
      try{result=await answerFor(row,answers,paths);}catch(error){stderr(`应答 ${row.kind} 失败：${error.message}`);result=null;}
      if(result===null){
        stderr(`宿主问了预检没覆盖的问题 ${row.kind}，无法应答；这一步会留在 unknown`);
        send({type:'host_close',sessionId:row.sessionId});return;
      }
      stderr(`应答 ${row.kind}`);
      send({type:'host_result',sessionId:row.sessionId,callId:row.callId,requestDigest:row.requestDigest,result});
      return;
    }
    if(row.type==='host_response')return;
    if(row.requestId==='drive'){
      done=true;
      process.stdout.write(JSON.stringify(row,null,2)+'\n');
      if(row.result?.stage)stderr(`stage = ${row.result.stage}`);
      if(row.error)stderr(`宿主拒绝：${row.error.code}（真实原因和位置在上面 [host] 那行 diagnostic 里）`);
      process.exitCode=row.error?1:0;
      child.stdin.end();
    }
  });
  child.on('error',error=>{stderr(`宿主启动失败：${error.message}`);process.exitCode=1;});
  child.on('exit',code=>{if(!done){stderr(`宿主在给出结果前退出了，exit ${code}`);process.exitCode=1;}});
}
