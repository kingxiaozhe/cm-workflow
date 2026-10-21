// 会话边界结论：单任务运行或缺陷修复到达终态时，由驾驶员直接打印三行结论，
// 模型只需原样转告用户，不再依赖它照文字自己组织（实跑中曾被改写成一句建议）。
// 判断顺序与措辞见 runtime/model-efficiency.md「Session boundary」。
import fs from 'node:fs';
import path from 'node:path';

const HEADER='=== 会话边界（把下面三行原样放在给用户回复的最后，不要改写；只有用户要在本会话继续讨论本次结果时，按 runtime/model-efficiency.md 改第一行）===';

export function sessionBoundaryBlock({next,reason}){
  return [HEADER,'会话边界：换新会话。',`新会话里运行：${next}`,`原因：${reason}`].join('\n');
}

// 返回下一个未勾选任务编号；没有返回 null；读不到任务清单返回 undefined。
export function nextOpenTask(specsDir,feature){
  if(typeof specsDir!=='string'||typeof feature!=='string')return undefined;
  let text;
  try{text=fs.readFileSync(path.join(specsDir,feature,'tasks.md'),'utf8');}catch{return undefined;}
  const match=text.match(/^\s*[-*]\s*\[ \]\s*\**(T-[0-9]+)/m);
  return match?match[1]:null;
}

export function cmAiSessionBoundary(result,{specsDir,feature}={}){
  if(result?.workflow!=='cm-ai'||result?.state!=='run_done')return null;
  const task=nextOpenTask(specsDir,feature);
  const next=task===undefined?'$cm-ai（未能读取任务清单，先在新会话里查看下一项）'
    :task===null?`无，${feature} 的任务已全部完成`:`$cm-ai（继续 ${feature} 的 ${task}）`;
  return sessionBoundaryBlock({next,reason:'本运行已到 run_done，记录都已落盘，下一项是新单元。'});
}

export function cmFixSessionBoundary(result,operation){
  if(operation==='status')return null;
  if(result?.stage!=='completed'||result?.completionEligible!==true)return null;
  return sessionBoundaryBlock({next:'无（有下一个缺陷时，在新会话里运行 $cm-fix）',reason:'本缺陷已收口，记录都已落盘。'});
}
