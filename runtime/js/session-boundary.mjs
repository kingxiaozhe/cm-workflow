// 会话边界结论：单任务运行或缺陷修复到达终态时，由驾驶员直接打印三行结论，
// 模型只需在默认分支原样转告（实跑中模板结论曾被改写成一句建议）。
// 判断顺序与措辞见 runtime/model-efficiency.md「Session boundary」。
import fs from 'node:fs';
import path from 'node:path';
import {approvedTaskGrammar} from './spec-task-line.mjs';
import {parseFeatureTaskText} from './cm-ai/cm-ai-admission.mjs';

const HEADER='=== 会话边界（默认结论：把下面三行原样放在给用户回复的最后。例外：用户还要在本会话讨论本次结果时，第一行改为「会话边界：继续本会话。」；'
  +'用户拒绝换会话或宿主开不了新会话时，第一行改为「会话边界：留在本会话（原因）。」；这两种都删掉「新会话里运行」那一行，并按实际情况改写原因。'
  +'规则见 runtime/model-efficiency.md「Session boundary」）===';

export function sessionBoundaryBlock({next,reason}){
  return [HEADER,'会话边界：换新会话。',`新会话里运行：${next}`,`原因：${reason}`].join('\n');
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

export function cmAiSessionBoundary(result,{specsDir,feature}={}){
  if(result?.workflow!=='cm-ai'||result?.state!=='run_done')return null;
  const open=openTasks(specsDir,feature);
  // 不指定「下一个可执行任务」：依赖与选择由准入决定，这里只如实列出未完成项。
  const next=open===null?'无法确定（任务清单读不到或无法解析），在新会话里运行 $cm-ai 由准入给出下一项'
    :open.length?`$cm-ai（${feature} 仍有未完成任务：${open.join('、')}）`
      :`无，${feature} 的任务已全部完成`;
  return sessionBoundaryBlock({next,reason:'本运行已到 run_done，记录都已落盘，下一项是新单元。'});
}

export function cmFixSessionBoundary(result,operation){
  if(operation==='status')return null;
  if(result?.stage!=='completed'||result?.completionEligible!==true)return null;
  return sessionBoundaryBlock({next:'无（有下一个缺陷时，在新会话里运行 $cm-fix）',reason:'本缺陷已收口，记录都已落盘。'});
}
