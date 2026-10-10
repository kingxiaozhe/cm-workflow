#!/usr/bin/env node
// /cm:notify ($cm-notify): pick the one active phone-notice channel (Bark or
// pushplus), show its state, send one test push, or turn notices off.
// Secret files are filled by the user; this tool only checks that they parse
// and never prints, logs or asks for their values.
//   status (default)          read-only; writes nothing, not even notify.log
//   bark | pushplus           switch after the target's secret parses; else nothing changes
//   off                       moves notify.json aside to notify.off.json
//   test                      one real push through the configured command
//   preview                   read-only; prints each event's title and body from sample fields, sends nothing
//   --replace-custom          allow replacing a notify.json command this tool does not manage (backed up first)
//   --json                    machine-readable status
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {parseNotifyConfig,appendNotifyLog,buildNotifyMessage,localClock,NOTIFY_LIMITS} from '../runtime/js/notify.mjs';
import {CHANNELS,CHANNEL_FILE,SEND_EXIT,SendError,WINDOWS_UNSUPPORTED,NODE_UNSUPPORTED,MAX_FILE_BYTES,notifyHome,readChannel,readSecret,readRegularFile,parseAssignments,buildRequest} from '../runtime/js/notify-send.mjs';

export const SENDER_SOURCE=fileURLToPath(new URL('../runtime/js/notify-send.mjs',import.meta.url));
export const NOTIFY_FILE='notify.json',OFF_FILE='notify.off.json',LEGACY_SCRIPT='cm-notify.py';
export const managedSenderPath=home=>path.join(home,'notify','cm-notify-send.mjs');

export class NotifyCommandError extends Error{constructor(message,exit=2){super(message);this.exit=exit;}}
const refuse=message=>{throw new NotifyCommandError(message);};

// Empty templates with what to fill. `line` is the line the user fills in.
export const TEMPLATES=Object.freeze({
  bark:{line:5,text:[
    '# CM 提醒 · Bark（iOS）密钥文件。只留在这台电脑上，权限保持 600；不要提交到仓库，也不要贴到对话里。',
    '# Bark App 首页的示例地址形如 https://api.day.app/AbCd1234EfGh/推送内容 。',
    '# BARK_KEY 填 api.day.app/ 后面那一段（8–64 位字母或数字），不是 App 里 64 位十六进制的 Device Token。',
    '# 用自建 Bark 服务时，去掉最后一行开头的 # 并改成你的 https 地址（不带路径，结尾不加 /）。',
    'BARK_KEY=',
    '# BARK_SERVER=https://api.day.app',''].join('\n')},
  pushplus:{line:3,text:[
    '# CM 提醒 · pushplus（微信）密钥文件。只留在这台电脑上，权限保持 600；不要提交到仓库，也不要贴到对话里。',
    '# 登录 pushplus 官网，在「一对一推送」页复制你的 token（8–128 位字母或数字），填在下一行等号后面。',
    'PUSHPLUS_TOKEN=',''].join('\n')},
});

function lstat(file){try{return fs.lstatSync(file);}catch(error){if(error.code==='ENOENT')return null;throw error;}}
function safeTarget(file){
  const st=lstat(file);
  if(st&&(st.isSymbolicLink()||!st.isFile()))refuse(`拒绝写入：${file} 不是普通文件（可能是符号链接），cm-notify 不会改它`);
  const dir=lstat(path.dirname(file));
  if(dir&&(dir.isSymbolicLink()||!dir.isDirectory()))refuse(`拒绝写入：${path.dirname(file)} 不是普通目录`);
}
const readBytes=file=>{try{return fs.readFileSync(file);}catch(error){if(error.code==='ENOENT')return null;throw error;}};

// One secret file's state. Never returns or prints a value.
// missing / empty / invalid / ok, plus where to fill it.
// On Windows only the file's existence is reported; its content is never read.
export async function inspectSecret(home,channel,{platform=process.platform}={}){
  const spec=CHANNELS[channel],file=path.join(home,spec.file);
  if(platform==='win32')return {channel,file,state:lstat(file)?'unchecked':'missing',line:null,name:spec.required,message:WINDOWS_UNSUPPORTED};
  try{await readSecret(home,channel);return {channel,file,state:'ok',line:null,name:spec.required,message:'已填写，可解析'};}
  catch(error){
    if(!(error instanceof SendError))return {channel,file,state:'invalid',line:null,name:spec.required,message:'无法读取'};
    const state=error.detail.state??'invalid',line=error.detail.line??null,name=error.detail.name??spec.required;
    const message=state==='missing'?`${spec.file} 不存在`:error.message;
    return {channel,file,state,line,name,message,reason:error.detail.reason??null};
  }
}
// The concrete thing to do, in one sentence, naming the file and the line.
export function fillHint(info){
  const line=info.state==='missing'?TEMPLATES[info.channel].line:info.line;
  if(info.state==='missing')return `请在 ${info.file} 第 ${line} 行 ${info.name}= 后面填写，再重试`;
  if(info.state==='empty')return line?`请在 ${info.file} 第 ${line} 行 ${info.name}= 后面填写，再重试`
    :`请在 ${info.file} 里加一行 ${info.name}=（等号后填写），再重试`;
  if(info.reason==='permission')return `${info.message}；请执行 chmod 600 "${info.file}"（并确认文件归你所有），再重试`;
  return `${info.message}；请打开 ${info.file}${line?` 第 ${line} 行`:''}修正，再重试`;
}

async function inspectChannelFile(home,{platform=process.platform}={}){
  const file=path.join(home,CHANNEL_FILE);
  if(!lstat(file))return {file,state:'missing',value:null,message:`${CHANNEL_FILE} 不存在`};
  // The channel file holds no secret; on Windows it is shown through the same
  // safe read boundary minus the owner/mode rule (never through a symlink).
  if(platform==='win32'){
    try{
      const {values}=parseAssignments(await readRegularFile(file,CHANNEL_FILE),['CHANNEL'],CHANNEL_FILE);
      return Object.hasOwn(CHANNELS,values.CHANNEL??'')?{file,state:'ok',value:values.CHANNEL,message:'可解析'}
        :{file,state:'invalid',value:null,message:`${CHANNEL_FILE} 的 CHANNEL 只能是 bark 或 pushplus`};
    }catch(error){return {file,state:'invalid',value:null,message:error instanceof SendError?error.message:'无法读取'};}
  }
  try{return {file,state:'ok',value:await readChannel(home),message:'可解析'};}
  catch(error){return {file,state:'invalid',value:null,message:error instanceof SendError?error.message:'无法读取'};}
}

// Shape only. Managed: exactly [<absolute node>, <home>/notify/cm-notify-send.mjs].
// Legacy: exactly [<home>/cm-notify.py]. Anything else is the user's own command.
const NODE_NAME=/^node(?:\.exe)?$/i;
export function classifyCommand(home,command){
  if(!Array.isArray(command)||!command.every(item=>typeof item==='string'))return 'custom';
  if(command.length===2&&path.isAbsolute(command[0])&&NODE_NAME.test(path.basename(command[0]))
    &&path.isAbsolute(command[1])&&path.resolve(command[1])===managedSenderPath(home))return 'managed';
  if(command.length===1&&path.isAbsolute(command[0])&&path.resolve(command[0])===path.join(home,LEGACY_SCRIPT))return 'legacy';
  return 'custom';
}
// notify.json and notify.off.json are read only through the safe boundary
// (never via a symlink, regular file, size cap, same file object), as exact
// bytes so the content matches what the runtime sees. null = no such file.
const UNSAFE_REASON={permission:'not_regular_file',too_large:'too_large'};
async function readConfigBytes(file){
  try{return {bytes:await readRegularFile(file,path.basename(file),{bytes:true})};}
  catch(error){
    if(error instanceof SendError&&error.detail.state==='missing')return {bytes:null};
    return {bytes:null,reason:error instanceof SendError?UNSAFE_REASON[error.detail.reason]??'unreadable':'unreadable'};
  }
}
// notify.json is read once per operation; `test` runs exactly this snapshot.
async function loadConfig(home){
  const file=path.join(home,NOTIFY_FILE),off=path.join(home,OFF_FILE);
  const {bytes,reason}=await readConfigBytes(file);
  if(reason)return {file,state:'invalid',reason,command:null};
  if(bytes===null)return {file,state:lstat(off)?'off':'missing',command:null};
  const parsed=parseNotifyConfig(bytes.toString('utf8'));
  if(parsed.reason)return {file,state:'invalid',reason:parsed.reason,command:null};
  const {command,text}=parsed.config;
  // Optional custom text: default, custom, or invalid (then the default text is used).
  const textState=parsed.textReason?'invalid':text?'custom':'default';
  return {file,state:classifyCommand(home,command),command,textState,...(parsed.textReason?{textReason:parsed.textReason}:{}),textSpec:text??null};
}
// Status view of a snapshot; neither the command (custom arguments may hold
// anything) nor the custom strings are included.
function describeConfig(home,{command,textSpec,...snapshot},{senderSource=SENDER_SOURCE}={}){
  const result={...snapshot};
  if(!command)return result;
  Object.assign(result,{program:command[0],programExists:Boolean(lstat(command[0]))});
  if(result.state==='managed'){
    const installed=readBytes(managedSenderPath(home)),source=readBytes(senderSource);
    Object.assign(result,{sender:managedSenderPath(home),senderExists:installed!==null,
      senderCurrent:installed!==null&&source!==null&&installed.equals(source)});
  }
  return result;
}
const inspectConfig=async(home,options)=>describeConfig(home,await loadConfig(home),options);

export async function notifyStatus(home,{platform=process.platform,...options}={}){
  const config=await inspectConfig(home,options),channelFile=await inspectChannelFile(home,{platform});
  const channels={};for(const name of Object.keys(CHANNELS))channels[name]=await inspectSecret(home,name,{platform});
  const active=platform!=='win32'&&['managed','legacy'].includes(config.state)&&channelFile.state==='ok'?channelFile.value:null;
  return {home,platform,config,channelFile,channels,active};
}

const UNSAFE_WORD={not_regular_file:'notify.json 不是普通文件（可能是符号链接），cm-notify 不读取它，无法确认提醒是否生效',
  too_large:'notify.json 超过 64 KiB，cm-notify 不读取它，无法确认提醒是否生效'};
const STATE_WORD={missing:'未填写（文件不存在）',empty:'未填写',invalid:'格式不对',ok:'已填写，可解析',unchecked:'文件存在（Windows 上不读取内容，无法判断是否填好）'};
export function formatStatus(status){
  const {config,channelFile,channels,active}=status,lines=[`CM 提醒设置（目录 ${status.home}）`];
  const windows=status.platform==='win32';
  if(windows)lines.push(WINDOWS_UNSUPPORTED);
  const describe={
    managed:'CM 托管发送器',
    legacy:`旧版本机脚本 ${LEGACY_SCRIPT}（读同一组文件；下次切换渠道时自动换成托管发送器，原脚本不动）`,
    custom:'自定义命令（cm-notify 不管理，切换渠道不会改它，除非加 --replace-custom）',
    missing:'未开启（没有 notify.json）',
    off:`已关闭（配置已移到 ${OFF_FILE}，切换渠道即重新开启）`,
    invalid:UNSAFE_WORD[config.reason]??`notify.json 无效（${config.reason}），提醒实际关闭`};
  lines.push(`发送命令：${describe[config.state]}`);
  if(['managed','legacy','custom'].includes(config.state)&&!config.programExists)
    lines.push(`  警告：命令程序 ${config.program} 不存在（node 可能已移动或升级），重新执行 /cm:notify <渠道> 修复`);
  if(config.state==='managed'&&!config.senderExists)lines.push('  警告：托管发送器文件缺失，重新执行 /cm:notify <渠道> 修复');
  else if(config.state==='managed'&&!config.senderCurrent)lines.push('  提示：托管发送器与当前插件版本不同，重新执行 /cm:notify <渠道> 更新');
  if(config.textState)lines.push(textLine(config));
  const chosen=channelFile.state==='ok'?channelFile.value:null;
  lines.push(`当前渠道：${active?`${active}（生效中）`:chosen&&windows?`${chosen}（Windows 上不会发送）`:chosen?`${chosen}（未生效：${describe[config.state]}）`
    :channelFile.state==='missing'?'未选择':`无法确定：${channelFile.message}`}`);
  for(const [name,info] of Object.entries(channels)){
    const mark=name===active?'［当前］':'';
    lines.push(`渠道 ${name}${mark}：${STATE_WORD[info.state]} — ${info.file}`);
    if(info.state!=='ok'&&!windows)lines.push(`  ${fillHint(info)}`);
  }
  lines.push('密钥只由你自己编辑上面的文件填写；本工具不读出、不显示其中的值。');
  return lines.join('\n');
}

const textLine=config=>config.textState==='custom'?'文案：自定义（/cm:notify preview 查看效果）'
  :config.textState==='invalid'?`文案：默认（notify.json 里的 text 无效：${config.textReason}，已改用默认文案，提醒照常发送）`:'文案：默认';

// Read-only preview of every event's title and body under the current
// notify.json text, built from fixed sample fields. Sends and logs nothing.
const PREVIEW_SAMPLE=Object.freeze({project:'demo-app',workflow:'cm-ai',runId:'run-sample-1',task:'T-001'});
export const PREVIEW_EVENTS=Object.freeze([
  {event:'stuck',name:'卡住，需要人处理',stage:'blocked',code:'checks_not_passed',nextAction:'核对原因后恢复原运行'},
  {event:'waiting',name:'等待会话应答',stage:'check',code:'waiting_session_answer',nextAction:'宿主已等待会话应答约 10 分钟，请回到会话处理'},
  {event:'idle',name:'疑似空转',stage:'requirements_analysis',code:'no_next_step',nextAction:'上一步已结束约 45 分钟，会话没有发下一步，请回到会话查看'},
  {event:'idle_waiting',name:'在等你',stage:'blocked',code:'waiting_for_you',nextAction:'上一步停在需要你处理的状态，约 45 分钟没有下一步，请回到会话处理'},
  {event:'dead',name:'宿主已退出未收尾',stage:'1 个宿主进程已不在',code:'host_process_gone',nextAction:'请回到会话用 status 核对运行状态，需要时按恢复说明接手'},
  {event:'done',name:'流程已结束',stage:'run_done',code:'run_done',nextAction:'建议在新会话里开始下一个任务，减少重复读入的上下文'}]);
export async function previewText(home,{now=Date.now(),timeZone}={}){
  const {state,textState=null,textReason=null,textSpec=null}=await loadConfig(home);
  const messages=PREVIEW_EVENTS.map(({name,...fields})=>({event:fields.event,name,
    ...buildNotifyMessage({...PREVIEW_SAMPLE,...fields},{now,timeZone,text:textSpec})}));
  return {state,textState,textReason,messages};
}
export function formatPreview(preview){
  const head=preview.textState?textLine(preview).replace('（/cm:notify preview 查看效果）','')
    :`文案：默认（${preview.state==='invalid'?'notify.json 无效':'没有生效的 notify.json'}，按默认文案预览）`;
  const lines=[`提醒文案预览，用示例字段生成，不发送。${head}`];
  for(const message of preview.messages)lines.push('',`【${message.name}】${message.event}`,`标题：${message.title}`,message.body);
  return lines.join('\n');
}

function backupName(file,now){
  const stamp=new Date(now).toISOString().replace(/[-:]/g,'').replace(/\.\d+Z$/,'Z');
  let candidate=`${file}.bak-${stamp}`;
  if(lstat(candidate))candidate=`${candidate}-${randomUUID().slice(0,8)}`;
  return candidate;
}
// File-system calls used for writes; tests inject faults here, nothing else does.
const FS_OPS=Object.freeze({writeFileSync:fs.writeFileSync,renameSync:fs.renameSync,unlinkSync:fs.unlinkSync,chmodSync:fs.chmodSync});
function writeAtomic(file,data,mode=0o600,ops=FS_OPS){
  safeTarget(file);
  fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  const temp=path.join(path.dirname(file),`.${path.basename(file)}.${randomUUID()}.tmp`);
  try{ops.writeFileSync(temp,data,{flag:'wx',mode});try{ops.chmodSync(temp,mode);}catch{}ops.renameSync(temp,file);}
  finally{try{fs.unlinkSync(temp);}catch{}}
}
// All-or-nothing over a few files. On a failure every file already written is
// put back from the previous bytes held in memory. No extra copies are made:
// a file that cannot be put back is reported by path, never silently kept.
class ApplyError extends Error{constructor(cause,restored,unrestored){super(cause);Object.assign(this,{restored,unrestored});}}
// An item may carry `before` already read through the safe boundary.
function applyAll(writes,{ops=FS_OPS}={}){
  const done=[];let failedFile=null;
  try{
    for(const item of writes){failedFile=item.file;const before=Object.hasOwn(item,'before')?item.before:readBytes(item.file);writeAtomic(item.file,item.data,item.mode,ops);done.push({file:item.file,before});}
  }catch(error){
    const restored=[],unrestored=[];
    for(const {file,before} of done.reverse()){
      try{if(before===null)ops.unlinkSync(file);else writeAtomic(file,before,0o600,ops);restored.push(file);}
      catch(restoreError){unrestored.push({file,code:restoreError.code??'error',created:before===null,keptAt:null});}
    }
    throw new ApplyError(error instanceof NotifyCommandError?error.message:`写 ${failedFile} 时失败（${error.code??'error'}）`,restored,unrestored);
  }
}
function rollbackMessage({message,restored,unrestored}){
  if(!unrestored.length)return Object.assign(new NotifyCommandError(`切换失败：${message}；已写入的文件都已恢复原样`),{restored,unrestored});
  const lines=unrestored.map(entry=>entry.created?`${entry.file} 是这次新建的，没能删除（${entry.code}）`
    :entry.renamedFrom?`${entry.file} 没能改回原名（${entry.code}），原内容仍在 ${entry.keptAt}`
    :`${entry.file} 没能恢复（${entry.code}），原内容${entry.keptAt?`仍在 ${entry.keptAt}`:'没有留在磁盘上'}`);
  return Object.assign(new NotifyCommandError(`切换失败：${message}；并且有文件没能恢复，需要你手动处理：${lines.join('；')}`
    +`${restored.length?`。已恢复：${restored.join('、')}`:''}`),{restored,unrestored});
}

// Creates an empty 0600 template only when the file does not exist at all.
export function ensureTemplate(home,channel){
  const file=path.join(home,CHANNELS[channel].file);
  if(lstat(file))return false;
  fs.mkdirSync(home,{recursive:true,mode:0o700});
  try{fs.writeFileSync(file,TEMPLATES[channel].text,{flag:'wx',mode:0o600});}catch(error){if(error.code==='EEXIST')return false;throw error;}
  try{fs.chmodSync(file,0o600);}catch{}
  return true;
}

export async function switchChannel(home,channel,{platform=process.platform,replaceCustom=false,execPath=process.execPath,senderSource=SENDER_SOURCE,now=Date.now(),ops=FS_OPS}={}){
  if(platform==='win32')refuse(WINDOWS_UNSUPPORTED);
  if(!Object.hasOwn(CHANNELS,channel))refuse(`未知渠道 ${channel}，只能是 bark 或 pushplus`);
  const target=await inspectSecret(home,channel);
  if(target.state!=='ok'){
    const created=target.state==='missing'&&ensureTemplate(home,channel);
    refuse(`没有切换到 ${channel}，原有设置都没动：${STATE_WORD[target.state]}。${created?`已新建空模板 ${target.file}（权限 600）。`:''}${fillHint(target)}`);
  }
  if(!path.isAbsolute(execPath))refuse('当前 node 路径不是绝对路径，无法写入发送命令');
  const file=path.join(home,NOTIFY_FILE),offFile=path.join(home,OFF_FILE);
  for(const item of [file,offFile,path.join(home,CHANNEL_FILE),managedSenderPath(home)])safeTarget(item);
  const fromOff=!lstat(file)&&Boolean(lstat(offFile));
  const baseFile=fromOff?offFile:file,baseRead=await readConfigBytes(baseFile),baseRaw=baseRead.bytes;
  if(baseRead.reason)refuse(`${baseFile} ${baseRead.reason==='too_large'?'超过 64 KiB':'不是普通文件（可能是符号链接）或无法安全读取'}，cm-notify 不会改它`);
  let base={version:1};
  if(baseRaw!==null){
    try{base=JSON.parse(baseRaw.toString('utf8'));}catch{refuse(`${baseFile} 不是有效 JSON，cm-notify 不会改它；请先修好或移走`);}
    if(!base||typeof base!=='object'||Array.isArray(base))refuse(`${baseFile} 不是 JSON 对象，cm-notify 不会改它`);
    if(base.version!==undefined&&base.version!==1)refuse(`${baseFile} 的 version 不是 1，cm-notify 不会改它`);
  }
  const kind=Object.hasOwn(base,'command')?classifyCommand(home,base.command):'none';
  if(kind==='custom'&&!replaceCustom)
    refuse(`没有切换：${baseFile} 里是你自己配置的提醒命令，cm-notify 不会静默覆盖。确认要换成 CM 托管发送器时，加 --replace-custom 重试（原文件会改名备份）`);
  const source=readBytes(senderSource);
  if(source===null)refuse('插件里找不到发送器 runtime/js/notify-send.mjs，请重新安装 CM Workflow');
  const sender=managedSenderPath(home);
  const next={...base,version:1,command:[execPath,sender]};
  const checked=parseNotifyConfig(JSON.stringify(next));
  if(checked.reason)refuse(`没有切换：${baseFile} 里其他字段无效（${checked.reason}），请先修好`);
  // The rewritten file (re-indented, new command) must stay readable by this
  // tool: checked on the exact bytes, before any backup or write.
  const data=`${JSON.stringify(next,null,2)}\n`,size=Buffer.byteLength(data);
  if(size>MAX_FILE_BYTES)refuse(`没有切换：改写后的 notify.json 会有 ${size} 字节，超过 ${MAX_FILE_BYTES} 字节（64 KiB）的读取上限；请先精简 ${baseFile}（如缩短 text、删掉不用的字段），原有文件都没动`);
  // A replaced custom or legacy config is backed up by renaming the original
  // file (its permissions/ACL travel with it), never by copying its content.
  let backup=null;
  if(baseRaw!==null&&(kind==='custom'||kind==='legacy')){
    backup=backupName(baseFile,now);
    try{ops.renameSync(baseFile,backup);}
    catch(error){refuse(`没有切换：备份 ${baseFile} 失败（${error.code??'error'}），什么都没改`);}
  }
  try{
    // notify.json's previous bytes (for rollback) come through the safe boundary too.
    const current=await readConfigBytes(file);
    if(current.reason)throw new ApplyError(`${file} 不是普通文件或无法安全读取，没有写入`,[],[]);
    applyAll([
      {file:sender,data:source,mode:0o600},
      {file:path.join(home,CHANNEL_FILE),data:`# CM 提醒渠道，由 /cm:notify 维护；同一时刻只开一个：bark 或 pushplus\nCHANNEL=${channel}\n`,mode:0o600},
      {file,data,mode:0o600,before:current.bytes},
    ],{ops});
  }catch(error){
    if(!(error instanceof ApplyError))throw error;
    // Put the renamed original back. If the new notify.json could not be removed
    // the rename would overwrite it; either way the result is reported exactly.
    if(backup){
      try{ops.renameSync(backup,baseFile);error.restored.push(baseFile);}
      catch(renameError){error.unrestored.push({file:baseFile,code:renameError.code??'error',created:false,renamedFrom:true,keptAt:backup});}
    }
    throw rollbackMessage(error);
  }
  if(fromOff&&!backup)try{fs.unlinkSync(offFile);}catch{}
  return {channel,file,sender,node:execPath,replaced:kind,backup,fromOff,textReason:checked.textReason??null};
}

// `ops` lets tests inject file-system faults; nothing else passes it.
export function turnOff(home,{now=Date.now(),ops={renameSync:fs.renameSync}}={}){
  const file=path.join(home,NOTIFY_FILE),offFile=path.join(home,OFF_FILE);
  safeTarget(file);safeTarget(offFile);
  if(!lstat(file))return {changed:false};
  let backup=null;
  if(lstat(offFile)){
    backup=backupName(offFile,now);
    try{ops.renameSync(offFile,backup);}
    catch(error){throw new NotifyCommandError(`关闭失败（${error.code??'error'}）：什么都没改，提醒仍开启`);}
  }
  try{ops.renameSync(file,offFile);}
  catch(error){
    const code=error.code??'error';
    if(!backup)throw new NotifyCommandError(`关闭失败（${code}）：notify.json 仍在原处，提醒仍开启；其他文件没改`);
    try{ops.renameSync(backup,offFile);}
    catch(restoreError){
      throw new NotifyCommandError(`关闭失败（${code}）：notify.json 仍在原处，提醒仍开启；原来的 ${offFile} 已移到 ${backup}，`
        +`放回时也失败（${restoreError.code??'error'}），请手动把它改回 ${OFF_FILE}`);
    }
    throw new NotifyCommandError(`关闭失败（${code}）：notify.json 仍在原处，提醒仍开启；原来的 ${OFF_FILE} 已放回原处`);
  }
  return {changed:true,offFile,backup};
}

// Runs the configured command exactly as the runtime does (no shell, message
// in CM_NOTIFY_TITLE/CM_NOTIFY_BODY, one JSON line on stdin, killed after 15 s),
// but in the foreground so the result can be reported. A test push bypasses
// dedupe and rate limits (it is one explicit request) and is not counted.
// Runs the configured command exactly as the runtime does (no shell, message
// in CM_NOTIFY_TITLE/CM_NOTIFY_BODY, one JSON line on stdin, killed after 15 s),
// in the foreground. It runs the same notify.json snapshot that was checked.
// Its output is never read or relayed, for any command type; only the exit
// code is reported. NODE_OPTIONS is removed so no preload can run first.
// A test push bypasses dedupe and rate limits and is not counted.
// With CM_NOTIFY_DRY_RUN=1 nothing is run and the secret file is not opened or
// checked at all: the redacted request is built here from the channel file only.
export async function sendTest(home,{platform=process.platform,env=process.env,now=Date.now(),timeoutMs=NOTIFY_LIMITS.commandTimeoutMs,beforeSpawn}={}){
  if(platform==='win32')refuse(WINDOWS_UNSUPPORTED);// also covers dry-run
  const snapshot=await loadConfig(home),config=describeConfig(home,snapshot);
  if(config.state==='missing'||config.state==='off')refuse('提醒未开启：先执行 /cm:notify bark 或 /cm:notify pushplus');
  if(config.state==='invalid')refuse(`notify.json 无效（${config.reason}），先修好或重新选择渠道`);
  const dry=env.CM_NOTIFY_DRY_RUN==='1';
  if(dry&&config.state==='custom')refuse('演练模式只适用于 bark / pushplus 渠道；自定义命令不会被运行');
  let channel=null;
  if(config.state!=='custom'){
    const channelFile=await inspectChannelFile(home);
    if(channelFile.state!=='ok')refuse(`没有发送：${channelFile.message}，重新执行 /cm:notify bark 或 pushplus`);
    channel=channelFile.value;
  }
  if(channel&&!dry){
    const secret=await inspectSecret(home,channel);
    if(secret.state!=='ok')refuse(`没有发送：当前渠道 ${channel} ${STATE_WORD[secret.state]}。${fillHint(secret)}`);
  }
  const title='CM 测试推送',body=`这是 /cm:notify test 发出的测试消息。\n时间：${localClock(now)}`;
  if(dry){
    const {url,payload}=await buildRequest(channel,{home,env:{CM_NOTIFY_TITLE:title,CM_NOTIFY_BODY:body},dry:true});
    return {kind:config.state,channel,dry:true,preview:`POST ${url}\n${JSON.stringify(payload)}`};
  }
  if(!config.programExists)refuse(`没有发送：命令程序 ${config.program} 不存在，重新执行 /cm:notify ${channel??'<渠道>'} 修复`);
  if(config.state==='managed'&&!config.senderExists)refuse(`没有发送：托管发送器缺失，重新执行 /cm:notify ${channel} 修复`);
  const command=[...snapshot.command];
  beforeSpawn?.();
  const childEnv={...env,CM_NOTIFY_TITLE:title,CM_NOTIFY_BODY:body};
  delete childEnv.CM_NOTIFY_PAYLOAD;delete childEnv.NODE_OPTIONS;
  const result=await new Promise(resolve=>{
    let child,settled=false;
    const finish=value=>{if(!settled){settled=true;clearTimeout(timer);resolve(value);}};
    const timer=setTimeout(()=>{try{child?.kill('SIGKILL');}catch{}finish({exit:null,reason:'timeout'});},timeoutMs);
    try{child=spawn(command[0],command.slice(1),{stdio:['pipe','ignore','ignore'],shell:false,windowsHide:true,env:childEnv});}
    catch(error){finish({exit:null,reason:`spawn_${String(error.code??'failed').toLowerCase()}`});return;}
    child.on('error',error=>finish({exit:null,reason:`spawn_${String(error.code??'failed').toLowerCase()}`}));
    child.on('close',(code,signal)=>finish({exit:code,reason:signal?`signal_${signal}`:null}));
    child.stdin.on('error',()=>{});
    child.stdin.end(`${JSON.stringify({title,body,event:'test',workflow:'cm-notify'})}\n`);
  });
  appendNotifyLog(home,now,{event:'test',workflow:'cm-notify',result:result.exit===0?'test ok':`test failed ${result.exit===null?result.reason:`exit_${result.exit}`}`});
  return {kind:config.state,channel,dry:false,exit:result.exit,reason:result.reason};
}

export const EXIT_WORDS=Object.freeze({
  [SEND_EXIT.ok]:'已被推送服务接受（不代表已送达）',
  [SEND_EXIT.config]:'配置或密钥问题',
  [SEND_EXIT.network]:'网络失败或超时',
  [SEND_EXIT.rejected]:'服务端拒绝',
});
export function formatTest(result){
  const who=result.kind==='custom'?'自定义命令':`渠道 ${result.channel}`;
  if(result.dry)return `${who}：演练模式（CM_NOTIFY_DRY_RUN=1），没有运行发送命令、没有联网，也没有读取或检查密钥文件（是否填好请用 /cm:notify 查看）；下面是按渠道设置生成的脱敏请求。\n${result.preview}`;
  if(result.exit===null)return `${who}：命令没有正常结束（${result.reason}），未知。`;
  return `${who}：退出码 ${result.exit}，${EXIT_WORDS[result.exit]??'未知'}。`;
}

const USAGE='用法：cm-notify.mjs [status|bark|pushplus|off|test|preview] [--replace-custom] [--json]';
export async function main(argv=process.argv.slice(2),{env=process.env,stdout=process.stdout,stderr=process.stderr,platform=process.platform}={}){
  const say=(stream,text)=>stream.write(`${text}\n`);
  // First action: on Windows everything except status, off and preview is refused
  // before any file is touched (argument parsing only).
  const first=argv.find(arg=>!arg.startsWith('--'))??'status';
  if(platform==='win32'&&!['status','off','preview'].includes(first)){say(stderr,`cm-notify: ${WINDOWS_UNSUPPORTED}`);return 2;}
  // Under node --test only an explicit CM_WORKFLOW_HOME is allowed: the real
  // home would push to the user's phone.
  if(env.NODE_TEST_CONTEXT&&!env.CM_WORKFLOW_HOME){say(stderr,'cm-notify: 测试环境必须设置 CM_WORKFLOW_HOME');return 2;}
  const flags=new Set(argv.filter(arg=>arg.startsWith('--'))),words=argv.filter(arg=>!arg.startsWith('--'));
  const unknown=[...flags].filter(flag=>!['--replace-custom','--json'].includes(flag));
  const sub=words[0]??'status';
  if(unknown.length||words.length>1||!['status','bark','pushplus','off','test','preview'].includes(sub)){say(stderr,USAGE);return 2;}
  const home=notifyHome(env);
  try{
    if(sub==='status'){
      const status=await notifyStatus(home,{platform});
      say(stdout,flags.has('--json')?JSON.stringify(status,null,2):formatStatus(status));return 0;
    }
    if(sub==='preview'){
      const preview=await previewText(home);
      say(stdout,flags.has('--json')?JSON.stringify(preview,null,2):formatPreview(preview));return 0;
    }
    if(sub==='off'){
      const result=turnOff(home);
      say(stdout,result.changed?`提醒已关闭：notify.json 已移到 ${result.offFile}；渠道设置和密钥文件都保留，/cm:notify bark 或 pushplus 重新开启。${result.backup?`之前的 ${OFF_FILE} 已备份到 ${result.backup}。`:''}`
        :'提醒本来就没有开启，什么都没改。');
      return 0;
    }
    if(sub==='test'){
      const result=await sendTest(home,{env,platform});
      say(stdout,formatTest(result));
      return result.dry?0:result.exit===null?SEND_EXIT.network:result.exit;
    }
    const result=await switchChannel(home,sub,{platform,replaceCustom:flags.has('--replace-custom')});
    const lines=[`已切换到 ${result.channel}（同一时刻只开这一个渠道）。`,
      `发送命令：${result.node} ${result.sender}`];
    if(result.backup)lines.push(`原配置文件已改名备份为 ${result.backup}${result.replaced==='legacy'?`（原 ${LEGACY_SCRIPT} 未改动）`:''}`);
    if(result.fromOff)lines.push(`已从 ${OFF_FILE} 恢复其他设置。`);
    if(result.textReason)lines.push(`提示：notify.json 里的 text 无效（${result.textReason}），提醒使用默认文案；/cm:notify preview 可查看。`);
    lines.push('node 移动或升级后，再执行一次本命令即可修复路径。发一条测试推送：/cm:notify test');
    say(stdout,lines.join('\n'));return 0;
  }catch(error){
    if(error instanceof NotifyCommandError){say(stderr,`cm-notify: ${error.message}`);return error.exit;}
    say(stderr,`cm-notify: 意外错误（${error?.code??'error'}），没有显示详情以免带出密钥`);return 3;
  }
}

// Entry detection uses import.meta.main only (no file-system access, symlinked
// entries work). No version number is checked; the plugin requires Node 24.14+,
// and only a missing import.meta.main is detected here: exit 3.
if(import.meta.main===undefined){process.stderr.write(`${NODE_UNSUPPORTED}\n`);process.exitCode=3;}
else if(import.meta.main)main().then(code=>{process.exitCode=code;});
