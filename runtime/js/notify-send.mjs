#!/usr/bin/env node
// CM managed push sender for Bark (iOS) and pushplus (WeChat). /cm:notify copies
// this file to <CM_WORKFLOW_HOME>/notify/cm-notify-send.mjs and points
// notify.json at it, so it must stay self-contained (node: built-ins only).
// One channel at a time, chosen by notify-channel.conf CHANNEL=bark|pushplus.
// One process sends HTTPS itself (no curl, no child processes). Windows is not
// supported yet: every path exits 2 there (owner/ACL checks of the secret
// files are not verified on a real Windows machine). Total deadline: 12 s from
// the moment this script starts executing. A hard timer armed first at entry
// exits with 3; file reads are asynchronous so that timer can always fire, and the
// remaining budget is checked before every read, before the request and
// before every exit 0. This stays inside the plugin's 15 s kill. Secret files are parsed as data
// (never executed or exported) and their values are never printed or logged.
// No retry: a timed-out request may already have been delivered.
// Exit codes: 0 sent; 2 config or secret problem; 3 network failure or
// timeout (also any unexpected error); 4 server rejected or odd response.
// CM_NOTIFY_DRY_RUN=1: opens no secret file, no network, prints a redacted request.
// --check: only verifies that the active channel's files parse; sends nothing.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import {performance} from 'node:perf_hooks';
import {fileURLToPath} from 'node:url';

// Process entry, first: record the start and decide from import.meta.main
// alone (no file-system access; symlinked entries work too). The plugin needs
// Node 24.14+; no version number is checked here. Only a missing
// import.meta.main is detected, and then the process ends with 3 rather than
// doing nothing. When run directly the
// 12 s hard timer is armed next, and on Windows the very next action is the
// refusal (exit 2), before anything reads a file. The timer is not unref'd:
// the process ends with 3 at the deadline even if some work never settles.
export const WINDOWS_UNSUPPORTED='/cm:notify 暂不支持 Windows：密钥文件权限核对尚未在 Windows 实机验证';
export const NODE_UNSUPPORTED='cm-notify: 当前 Node 没有 import.meta.main，不受支持（插件要求 Node 24.14 或更高版本），没有发送';
export function entryDecision(main,platform){
  if(main===undefined)return 'unsupported_node';
  if(main!==true)return 'imported';
  return platform==='win32'?'windows':'run';
}
const ENTRY_STARTED_AT=performance.now();
const ENTRY=entryDecision(import.meta.main,process.platform);
const armHardTimer=(deadlineMs,startedAt)=>setTimeout(()=>{
  try{process.stderr.write(`cm-notify: 整次调用超过 ${Math.ceil(deadlineMs/1000)} 秒，已放弃\n`);}catch{}process.exit(3);
},Math.max(0,deadlineMs-(performance.now()-startedAt)));
if(ENTRY==='unsupported_node'){try{process.stderr.write(`${NODE_UNSUPPORTED}\n`);}catch{}process.exit(3);}
const ENTRY_HARD_TIMER=ENTRY==='run'||ENTRY==='windows'?armHardTimer(12000,ENTRY_STARTED_AT):null;
if(ENTRY==='windows'){try{process.stderr.write(`cm-notify: ${WINDOWS_UNSUPPORTED}\n`);}catch{}process.exit(2);}

export const SEND_EXIT=Object.freeze({ok:0,config:2,network:3,rejected:4});
export const DEADLINE_MS=12000;
const MAX_FILE=64*1024,MAX_RESPONSE=64*1024,MAX_STDIN=64*1024;
// Largest file the safe read boundary accepts; /cm:notify never writes a bigger notify.json.
export const MAX_FILE_BYTES=MAX_FILE;
export const CHANNEL_FILE='notify-channel.conf';
export const CHANNELS=Object.freeze({
  bark:Object.freeze({file:'bark.env',names:['BARK_KEY','BARK_SERVER'],required:'BARK_KEY'}),
  pushplus:Object.freeze({file:'pushplus.env',names:['PUSHPLUS_TOKEN'],required:'PUSHPLUS_TOKEN'}),
});
export const BARK_DEFAULT_SERVER='https://api.day.app';
export const PUSHPLUS_URL='https://www.pushplus.plus/send';
const BARK_KEY=/^[A-Za-z0-9]{8,64}$/,DEVICE_TOKEN=/^[0-9a-fA-F]{64}$/,PUSHPLUS_TOKEN=/^[A-Za-z0-9]{8,128}$/;
const HTTPS_ORIGIN=/^https:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/;

export class SendError extends Error{
  constructor(exit,message,detail={}){super(message);this.exit=exit;this.detail=detail;}
}
const configError=(message,detail)=>new SendError(SEND_EXIT.config,message,detail);

export function notifyHome(env=process.env){
  return path.resolve(env.CM_WORKFLOW_HOME||path.join(os.homedir(),'.cm-workflow'));
}

// Windows is refused until owner/ACL verification bound to the opened handle
// has been built and tested on a real machine (see docs/next-steps.md).
const windowsRefusal=()=>configError(WINDOWS_UNSUPPORTED,{state:'unsupported'});

// Safe read boundary used for every file this tool reads: lstat must show a
// regular file (never a symlink), the size is capped, the opened handle must be
// the same file object (dev+ino), and content is read from that handle only.
// `privateFile` adds: owned by this user, no group/other mode bits.
// `budget` (from runSender) returns the milliseconds left and throws once the
// total deadline has passed. `fileOps` (lstat/open) is replaceable only through
// this module API, so tests can simulate slow reads. `bytes` returns the exact
// bytes read instead of strict UTF-8 text (BOM kept).
async function readChecked(file,label,{privateFile,budget,fileOps=fsp,bytes:raw=false}){
  if(budget)budget();
  const notRegular=privateFile?`${label} 必须是自己的普通文件且权限 600`:`${label} 必须是普通文件（不能是符号链接）`;
  let link;
  try{link=await fileOps.lstat(file,{bigint:true});}
  catch(error){if(error.code==='ENOENT')throw configError(`读不到 ${label}`,{state:'missing'});throw configError(`读不到 ${label}`,{state:'invalid'});}
  const bad=st=>!st.isFile()||(privateFile&&((typeof process.getuid==='function'&&st.uid!==BigInt(process.getuid()))||(st.mode&0o077n)!==0n));
  if(link.isSymbolicLink()||bad(link))throw configError(notRegular,{state:'invalid',reason:'permission'});
  if(link.size>BigInt(MAX_FILE))throw configError(`${label} 太大`,{state:'invalid',reason:'too_large'});
  let handle;
  try{
    // O_NONBLOCK: a file swapped for a FIFO after lstat opens at once (instead of
    // waiting for a writer) and is then refused by the type check below.
    // Reads of regular files are unaffected.
    handle=await fileOps.open(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0)|(fs.constants.O_NONBLOCK??0));
    const st=await handle.stat({bigint:true});
    if(bad(st))throw configError(notRegular,{state:'invalid',reason:'permission'});
    if(st.dev!==link.dev||st.ino!==link.ino)throw configError(`${label} 在核对期间被替换，为安全起见不使用它`,{state:'invalid',reason:'permission'});
    if(st.size>BigInt(MAX_FILE))throw configError(`${label} 太大`,{state:'invalid',reason:'too_large'});
    const size=Number(st.size),bytes=Buffer.alloc(size);let read=0;
    while(read<size){const {bytesRead}=await handle.read(bytes,read,size-read,read);if(bytesRead===0)break;read+=bytesRead;}
    if(raw)return bytes.subarray(0,read);
    return new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,read)).replace(/^\uFEFF/,'');
  }catch(error){
    if(error instanceof SendError)throw error;
    throw configError(`读取 ${label} 失败`,{state:'invalid'});
  }finally{if(handle)await handle.close().catch(()=>{});}
}
// Secret and channel files: refused on Windows, private-file rules elsewhere.
export async function readPrivateFile(file,label,{platform=process.platform,budget,fileOps}={}){
  if(platform==='win32')throw windowsRefusal();
  return readChecked(file,label,{privateFile:true,budget,fileOps});
}
// A file that holds no secret (the channel file, for display on Windows):
// the same boundary without the owner/mode rule, so a link to a secret file
// is never followed. `bytes` (used for notify.json) returns the raw bytes.
export async function readRegularFile(file,label,{fileOps,bytes=false}={}){
  return readChecked(file,label,{privateFile:false,fileOps,bytes});
}

// KEY=value lines only: optional `export `, optional matching quotes, blank
// lines and # comments. Unknown or repeated names reject the whole file.
// Errors name the line number, never its content.
export function parseAssignments(text,allowed,label){
  const values={},lines={};
  text.split(/\r\n|\n|\r/).forEach((raw,index)=>{
    let line=raw.trim();
    if(!line||line.startsWith('#'))return;
    if(line.startsWith('export '))line=line.slice(7).trim();
    const at=line.indexOf('=');
    const name=at<0?'':line.slice(0,at).trim();
    let value=at<0?'':line.slice(at+1).trim();
    if(at<0||!allowed.includes(name)||Object.hasOwn(values,name))
      throw configError(`${label} 第 ${index+1} 行无法识别或重复`,{state:'invalid',line:index+1});
    if(value.length>=2&&value[0]===value.at(-1)&&(value[0]==='"'||value[0]==="'"))value=value.slice(1,-1);
    values[name]=value;lines[name]=index+1;
  });
  return {values,lines};
}

export async function readChannel(home,fileOptions={}){
  const file=path.join(home,CHANNEL_FILE);
  const {values,lines}=parseAssignments(await readPrivateFile(file,CHANNEL_FILE,fileOptions),['CHANNEL'],CHANNEL_FILE);
  const channel=values.CHANNEL??'';
  if(!Object.hasOwn(CHANNELS,channel))
    throw configError(`${CHANNEL_FILE} 的 CHANNEL 只能是 bark 或 pushplus`,{state:'invalid',line:lines.CHANNEL});
  return channel;
}

// Validated secret values for one channel. Messages say which file and line to
// fix; they never contain a value.
export async function readSecret(home,channel,fileOptions={}){
  const spec=CHANNELS[channel];
  if(!spec)throw configError('未知渠道');
  const {values,lines}=parseAssignments(await readPrivateFile(path.join(home,spec.file),spec.file,fileOptions),spec.names,spec.file);
  const where=name=>lines[name]?`第 ${lines[name]} 行 `:'';
  const empty=name=>configError(`${spec.file} ${where(name)}${name} 未填写`,{state:'empty',line:lines[name]??null,name});
  if(channel==='bark'){
    const key=values.BARK_KEY??'',server=values.BARK_SERVER??BARK_DEFAULT_SERVER;
    if(!key)throw empty('BARK_KEY');
    if(DEVICE_TOKEN.test(key))throw configError(`bark.env ${where('BARK_KEY')}BARK_KEY 像是 64 位 Device Token，应填示例地址里 api.day.app/ 后面那一段`,{state:'invalid',line:lines.BARK_KEY,name:'BARK_KEY'});
    if(!BARK_KEY.test(key))throw configError(`bark.env ${where('BARK_KEY')}BARK_KEY 格式不对（应为 8–64 位字母或数字）`,{state:'invalid',line:lines.BARK_KEY,name:'BARK_KEY'});
    if(!HTTPS_ORIGIN.test(server))throw configError(`bark.env ${where('BARK_SERVER')}BARK_SERVER 必须是不带路径的 https 地址`,{state:'invalid',line:lines.BARK_SERVER,name:'BARK_SERVER'});
    return {key,server};
  }
  const token=values.PUSHPLUS_TOKEN??'';
  if(!token)throw empty('PUSHPLUS_TOKEN');
  if(!PUSHPLUS_TOKEN.test(token))throw configError(`pushplus.env ${where('PUSHPLUS_TOKEN')}PUSHPLUS_TOKEN 格式不对（应为 8–128 位字母或数字）`,{state:'invalid',line:lines.PUSHPLUS_TOKEN,name:'PUSHPLUS_TOKEN'});
  return {token};
}

const chars=(text,max)=>Array.from(text).slice(0,max).join('');
export async function buildRequest(channel,{home,env=process.env,dry=false,fileOptions={}}){
  const title=chars(env.CM_NOTIFY_TITLE||'CM 提醒',100),body=chars(env.CM_NOTIFY_BODY||'（无正文）',1000);
  if(channel==='bark'){
    const {key,server}=dry?{key:'<已隐藏>',server:BARK_DEFAULT_SERVER}:await readSecret(home,'bark',fileOptions);
    return {url:`${server}/push`,payload:{device_key:key,title,body,group:'CM',level:'active'}};
  }
  const {token}=dry?{token:'<已隐藏>'}:await readSecret(home,'pushplus',fileOptions);
  return {url:PUSHPLUS_URL,payload:{token,title,content:body,template:'txt',channel:'wechat'}};
}

// Node 24.5+ routes https.Agent through HTTPS_PROXY/NO_PROXY when given
// proxyEnv; older Node ignores the option and connects directly.
function proxyAgent(env){
  const proxy=env.HTTPS_PROXY||env.https_proxy;
  if(!proxy)return undefined;
  const proxyEnv={HTTPS_PROXY:proxy};
  const noProxy=env.NO_PROXY??env.no_proxy;if(noProxy!==undefined)proxyEnv.NO_PROXY=noProxy;
  return new https.Agent({proxyEnv,keepAlive:false});
}

// One POST, no redirects (https.request never follows them), TLS verification
// forced on regardless of NODE_TLS_REJECT_UNAUTHORIZED. `request` is injectable
// only through this module API (tests use a loopback http server).
export function postJson(url,data,{request=https.request,agent,signal}={}){
  return new Promise((resolve,reject)=>{
    const target=new URL(url);
    const options={method:'POST',hostname:target.hostname,port:target.port||443,path:`${target.pathname}${target.search}`,
      headers:{'Content-Type':'application/json; charset=utf-8','Content-Length':Buffer.byteLength(data)},
      rejectUnauthorized:true,signal};
    if(agent)options.agent=agent;
    const req=request(options,response=>{
      const parts=[];let size=0;
      response.on('data',chunk=>{
        size+=chunk.length;
        if(size>MAX_RESPONSE){response.destroy();reject(new SendError(SEND_EXIT.rejected,'响应过大'));return;}
        parts.push(chunk);
      });
      response.on('end',()=>resolve({status:response.statusCode,raw:Buffer.concat(parts)}));
      response.on('error',()=>reject(new SendError(SEND_EXIT.network,'请求失败或超时')));
    });
    req.on('error',()=>reject(new SendError(SEND_EXIT.network,'请求失败或超时')));
    req.end(data);
  });
}

// Only the JSON type of `code` is ever reported, never its value: a server
// that echoes the request could put the secret there.
export function responseCodeType(raw){
  let value;
  try{value=JSON.parse(Buffer.from(raw).toString('utf8'));}catch{return {ok:false,type:'not_json'};}
  if(!value||typeof value!=='object'||Array.isArray(value)||!Object.hasOwn(value,'code'))return {ok:false,type:'missing'};
  const code=value.code,type=code===null?'null':Array.isArray(code)?'array':typeof code;
  return {ok:typeof code==='number'&&code===200,type};
}

// Reads one line or EOF from the plugin's stdin, then discards it.
export function drainStdinLine(stdin){
  return new Promise(resolve=>{
    if(!stdin||stdin.isTTY){resolve();return;}
    let size=0,done=false;
    const finish=()=>{
      if(done)return;done=true;
      stdin.off('data',data);stdin.off('end',finish);stdin.off('error',finish);stdin.off('close',finish);
      try{stdin.pause();stdin.destroy?.();}catch{}
      resolve();
    };
    const data=chunk=>{size+=chunk.length;if(size>=MAX_STDIN||chunk.includes(10))finish();};
    stdin.on('data',data);stdin.on('end',finish);stdin.on('error',finish);stdin.on('close',finish);
    stdin.resume?.();
  });
}

// The whole call, bounded by one deadline that covers stdin, config and the
// request. Returns an exit code; writes one line to stderr on failure.
export async function runSender({argv=[],env=process.env,stdin=process.stdin,stdout=process.stdout,stderr=process.stderr,
  request,home=notifyHome(env),deadlineMs=DEADLINE_MS,startedAt,platform=process.platform,fileOps,clock=()=>performance.now()}={}){
  const say=(stream,line)=>{try{stream.write(`${line}\n`);}catch{}};
  const controller=new AbortController();
  // The monotonic budget is checked before every read, before the request and
  // before every exit 0, besides the timer below (and the CLI's hard timer).
  const started=startedAt??clock(),seconds=Math.ceil(deadlineMs/1000);
  const budget=()=>{
    const left=deadlineMs-(clock()-started);
    if(left<=0)throw new SendError(SEND_EXIT.network,`整次调用超过 ${seconds} 秒，已放弃（未发送）`,{deadline:true});
    return left;
  };
  let timer;
  const deadline=new Promise(resolve=>{timer=setTimeout(()=>{controller.abort();resolve('deadline');},Math.max(0,deadlineMs-(clock()-started)));timer.unref?.();});
  let channel='-';
  const work=(async()=>{
    if(platform==='win32')throw windowsRefusal();// every path, including --check and dry-run
    await drainStdinLine(stdin);
    const dry=env.CM_NOTIFY_DRY_RUN==='1';
    const fileOptions={budget,platform,...(fileOps?{fileOps}:{})};
    channel=await readChannel(home,fileOptions);
    const {url,payload}=await buildRequest(channel,{home,env,dry,fileOptions});
    if(argv.includes('--check')){budget();say(stdout,`cm-notify: 渠道 ${channel} 配置可解析（未发送）`);return SEND_EXIT.ok;}
    if(dry){budget();say(stdout,`POST ${url}`);say(stdout,JSON.stringify(payload));return SEND_EXIT.ok;}
    const data=JSON.stringify(payload);
    const agent=request?undefined:proxyAgent(env);
    budget();
    const {status,raw}=await postJson(url,data,{request,agent,signal:controller.signal});
    const code=responseCodeType(raw);
    if(status!==200||!code.ok)throw new SendError(SEND_EXIT.rejected,`推送返回 http=${Number.isSafeInteger(status)?status:'?'} code类型=${code.type}`);
    // Accepted, but too late: report the deadline (it may have been delivered).
    if(deadlineMs-(clock()-started)<=0)throw new SendError(SEND_EXIT.network,`整次调用超过 ${seconds} 秒，已放弃（可能已送达）`,{deadline:true});
    return SEND_EXIT.ok;
  })();
  try{
    const result=await Promise.race([work.then(code=>({code}),error=>({error})),deadline]);
    if(result==='deadline'){work.catch(()=>{});say(stderr,`cm-notify: 整次调用超过 ${seconds} 秒，已放弃`);return SEND_EXIT.network;}
    if(result.error){
      const error=result.error;
      if(error instanceof SendError){
        const prefix=error.exit===SEND_EXIT.config||error.detail.deadline?'':`${channel} `;
        say(stderr,`cm-notify: ${prefix}${error.message}`);return error.exit;
      }
      say(stderr,'cm-notify: 意外错误（详情已隐藏，避免带出密钥）');return SEND_EXIT.network;
    }
    if(result.code===SEND_EXIT.ok&&deadlineMs-(clock()-started)<=0){say(stderr,`cm-notify: 整次调用超过 ${seconds} 秒，已放弃`);return SEND_EXIT.network;}
    return result.code;
  }finally{clearTimeout(timer);}
}

// Runs the sender as a process. `startedAt` and `hardTimer` come from the
// entry block above; tests call it with their own start and deadline.
export function runCli({argv=process.argv.slice(2),deadlineMs=DEADLINE_MS,softDeadlineMs=deadlineMs,startedAt=performance.now(),
  hardTimer=armHardTimer(deadlineMs,startedAt),senderOptions={}}={}){
  const hard=()=>{try{process.stderr.write('cm-notify: 意外错误（详情已隐藏，避免带出密钥）\n');}catch{}process.exit(SEND_EXIT.network);};
  process.on('uncaughtException',hard);process.on('unhandledRejection',hard);
  return runSender({argv,deadlineMs:softDeadlineMs,startedAt,...senderOptions})
    .then(code=>{clearTimeout(hardTimer);process.exit(code);},hard);
}
if(ENTRY==='run')runCli({startedAt:ENTRY_STARTED_AT,hardTimer:ENTRY_HARD_TIMER});
