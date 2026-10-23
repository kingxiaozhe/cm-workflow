// 会话边界结论：单任务运行或缺陷修复到达终态时，由驾驶员直接打印三行结论，
// 模型只需在默认分支原样转告（实跑中模板结论曾被改写成一句建议）。
// 判断顺序与措辞见 runtime/model-efficiency.md「Session boundary」。
import fs from 'node:fs';
import path from 'node:path';
import {approvedTaskGrammar} from './spec-task-line.mjs';
import {parseFeatureTaskText} from './cm-ai/cm-ai-admission.mjs';
import {writeHandoff} from './session-handoff.mjs';

const HEADER='=== 会话边界（默认结论：把下面几行原样放在给用户回复的最后。例外：用户还要在本会话讨论本次结果时，第一行改为「会话边界：继续本会话。」；'
  +'用户拒绝换会话或宿主开不了新会话时，第一行改为「会话边界：留在本会话（原因）。」；这两种都删掉「新会话里运行」那一行，并按实际情况改写原因。'
  +'规则见 runtime/model-efficiency.md「Session boundary」）===';

export function sessionBoundaryBlock({next,reason,handoff}){
  return [HEADER,'会话边界：换新会话。',`新会话里运行：${next}`,`原因：${reason}`,...(handoff?[handoff]:[])].join('\n');
}

// 写交接摘要并给出结论里的那一行；写不成也如实写出来，不让新会话以为有摘要可读。
function handoffLine(recordsRoot,fields,write){
  if(typeof recordsRoot!=='string'||!recordsRoot)return null;
  try{return `交接摘要：${write(recordsRoot,fields)}（新会话开新运行时驾驶员会先打印它）`;}
  catch(error){return `交接摘要：未写成（${error.code??error.message}），新会话按上面的命令与 tasks.md 开工`;}
}

// 用仓库唯一的任务声明语法（与准入一致）读取同一 feature 的未完成任务：
// 返回未完成且未放弃的任务编号数组；任务清单读不到或无效时返回 null。
export function openTasks(specsDir,feature){
  if(typeof specsDir!=='string'||typeof feature!=='string'||!feature)return null;
  let source;
  try{source=fs.readFileSync(path.join(specsDir,feature,'tasks.md'),'utf8');}catch{return null;}
  const parsed=parseFeatureTaskText(source,{allowDependencyPunctuation:true,grammar:approvedTaskGrammar(specsDir)});
  if(parsed.error)return null;
  return parsed.tasks.filter(task=>!task.completed&&!task.dropped).map(task=>task.id);
}

export function cmAiSessionBoundary(result,{specsDir,feature,identity,write=writeHandoff}={}){
  if(result?.workflow!=='cm-ai'||result?.state!=='run_done')return null;
  const open=openTasks(specsDir,feature);
  // 不指定「下一个可执行任务」：依赖与选择由准入决定，这里只如实列出未完成项。
  const next=open===null?'无法确定（任务清单读不到或无法解析），在新会话里运行 $cm-ai 由准入给出下一项'
    :open.length?`$cm-ai（${feature} 仍有未完成任务：${open.join('、')}）`
      :`无，${feature} 的任务已全部完成`;
  const handoff=identity===undefined?null:handoffLine(specsDir,{workflow:'cm-ai',runId:identity?.runId,
    done:[`${feature} ${identity?.taskId??'任务编号未知'}：已到 run_done（审查、完成门禁都已通过）`],
    todo:open===null?['无法确定：tasks.md 读不到或无法解析']:open.map(id=>`${feature} ${id}`),next},write);
  return sessionBoundaryBlock({next,reason:'本运行已到 run_done，记录都已落盘，下一项是新单元。',handoff});
}

export function cmFixSessionBoundary(result,operation,{archive,runId,write=writeHandoff}={}){
  if(operation==='status')return null;
  if(result?.stage!=='completed'||result?.completionEligible!==true)return null;
  const next='无（有下一个缺陷时，在新会话里运行 $cm-fix）';
  const handoff=archive===undefined?null:handoffLine(archive,{workflow:'cm-fix',runId,
    done:['本缺陷已收口：修复、回归与最终审查都已通过'],todo:[],next},write);
  return sessionBoundaryBlock({next,reason:'本缺陷已收口，记录都已落盘。',handoff});
}
