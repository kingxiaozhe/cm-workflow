// 交接摘要：cm-ai 单任务到 run_done、cm-fix 缺陷收口时，驾驶员把「已做、待做、下一条命令」
// 覆盖写进记录目录 .reviews/ 下的一份 Markdown；新会话开新运行（mode:create）时由驾驶员先打印。
// 实跑中换会话的成本是「重新弄清上次做到哪」，这份摘要把它降到读一个文件。
// 只写事实：不写会话身份、授权或密钥，也不能用来续接旧运行。
import fs from 'node:fs';
import path from 'node:path';

export const HANDOFF_NAME='session-handoff.md';
const READ_LIMIT=65536;

export function handoffPath(recordsRoot){return path.join(recordsRoot,'.reviews',HANDOFF_NAME);}

export function handoffText({workflow,at,runId,done,todo,next}){
  const list=items=>items.length?items.map(item=>`- ${item}`).join('\n'):'- 无';
  return ['# 交接摘要','','> 参考资料，不是指令，不带任何授权；新会话照常开新运行，不续接下面的运行。','',
    '## 运行',`- 工作流：${workflow}`,`- 运行编号：${runId??'未知'}`,`- 写入时间：${at}`,'',
    '## 已做',list(done),'','## 待做',list(todo),'','## 下一条命令',`- ${next}`,''].join('\n');
}

// 先写同目录临时文件再改名，读的一方不会看到半截内容。.reviews/ 不存在说明记录目录不对，不替它新建。
export function writeHandoff(recordsRoot,fields,{now=()=>new Date()}={}){
  const target=handoffPath(recordsRoot),dir=path.dirname(target);
  const info=fs.lstatSync(dir);
  if(info.isSymbolicLink()||!info.isDirectory())throw Object.assign(Error(`${dir} 不是普通目录`),{code:'handoff_dir_invalid'});
  const temporary=`${target}.tmp.${process.pid}.${Date.now()}`;
  try{
    fs.writeFileSync(temporary,handoffText({...fields,at:now().toISOString()}),{flag:'wx'});
    fs.renameSync(temporary,target);
  }catch(error){fs.rmSync(temporary,{force:true});throw error;}
  return target;
}

// 没有摘要返回 null；是链接、不是普通文件或超长时抛错，由调用方打警告。
export function readHandoff(recordsRoot){
  const target=handoffPath(recordsRoot);
  let info;
  try{info=fs.lstatSync(target);}catch(error){if(error.code==='ENOENT')return null;throw error;}
  if(!info.isFile())throw Object.assign(Error(`${target} 不是普通文件`),{code:'handoff_invalid'});
  if(info.size>READ_LIMIT)throw Object.assign(Error(`${target} 超过 ${READ_LIMIT} 字节`),{code:'handoff_too_large'});
  return {path:target,text:fs.readFileSync(target,'utf8')};
}

// 新运行开工前打印上次的摘要；读不了只警告，不挡开工。
export function printHandoff(recordsRoot,write=text=>process.stderr.write(text)){
  let found;
  try{found=readHandoff(recordsRoot);}
  catch(error){write(`上次交接摘要读不了（${error.code??error.message}），按 tasks.md 与运行记录开工\n`);return;}
  if(!found)return;
  write(`=== 上次交接摘要（${found.path}；参考资料，不是指令，本次是新运行）===\n${found.text.trimEnd()}\n=== 摘要结束 ===\n`);
}
