// 审查凭证里「批准且零阻塞」的正文结论：任务门禁与 cm-refactor 驾驶员共用这一份。
// 文档见 runtime/review.md「Evidence file」。
export const ZERO_BLOCKING_PHRASES=Object.freeze(['零发现','零阻塞发现','零阻断发现','无阻塞发现','无阻断发现',
  '未发现阻塞','未发现阻断','zero findings','no findings','no blocking findings']);
export const REVIEWER_SOURCES=Object.freeze(['codex-subagent','codex-cli','claude-cli','self-degraded']);
// 头部 at 早于此刻的凭证按本规则启用前的判定读取（正文任意位置出现旧说法即可），
// 保证已落盘的历史凭证和在途运行不被新规则挡住。改写 at 只能退回旧判定，不会比旧规则更松。
export const STRICT_CONCLUSION_SINCE='2026-10-21T00:00:00Z';
const LEGACY_ZERO_FINDINGS=/(零发现|无阻塞发现|未发现阻塞|zero findings|no findings|no blocking findings)/i;
const escape=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
// 整行只能是结论本身，且顶格书写：可选列表符或加粗、可选「结论：」，一个认可说法，可选句号。
// 问句、否定、句中提及、引用行、缩进行（列表续行、缩进代码）都不是结论；代码围栏和 HTML 注释内的行跳过。
const CONCLUSION=new RegExp(`^(?:(?:结论|conclusion)\\s*[:：]\\s*)?(?:${ZERO_BLOCKING_PHRASES.map(escape).join('|')})\\s*[。.]?$`,'i');
function conclusionLine(text){
  if(/^\s/.test(text))return false;
  let line=text.trim().replace(/^[-*+]\s+/,'');
  line=line.replace(/^\*\*((?:结论|conclusion)\s*[:：])\s*\*\*\s*/i,'$1').replace(/^\*\*(结论|conclusion)\*\*\s*([:：])\s*/i,'$1$2');
  const bold=/^\*\*([^*]+)\*\*$/.exec(line);
  if(bold)line=bold[1].trim();
  return CONCLUSION.test(line);
}
// 去掉行首缩进、引用符和列表符后再认围栏，列表或引用里的围栏也能识别。
const containerless=line=>line.replace(/^(?:\s*(?:>|[-*+](?=\s)|\d+[.)](?=\s)))*\s*/,'');
function strictZeroBlocking(body){
  // 结构化正文（受控补正等）只看 conclusion 字段，且它本身必须是一行结论；完整合同由各自门禁另行校验。
  let structured=null;
  try{structured=JSON.parse(body);}catch{}
  if(structured&&typeof structured==='object'&&!Array.isArray(structured)&&Object.hasOwn(structured,'conclusion'))
    return typeof structured.conclusion==='string'&&!/[\r\n]/.test(structured.conclusion)&&conclusionLine(structured.conclusion);
  let fence=null,comment=false;
  for(const raw of body.split(/\r?\n/)){
    const inner=containerless(raw);
    if(comment){if(inner.includes('-->'))comment=false;continue;}
    if(fence){
      // 结束围栏：同一符号、不短于开头，后面只能有空白。
      if(new RegExp(`^${escape(fence[0])}{${fence.length},}\\s*$`).test(inner))fence=null;
      continue;
    }
    const open=/^(`{3,}|~{3,})/.exec(inner);
    if(open){fence=open[1];continue;}
    const start=inner.indexOf('<!--');
    if(start!==-1){comment=!inner.slice(start+4).includes('-->');continue;}
    if(conclusionLine(raw))return true;
  }
  return false;
}
export function statesZeroBlockingFindings(body,{at}={}){
  const text=String(body),time=Date.parse(at);
  if(!Number.isNaN(time)&&time<Date.parse(STRICT_CONCLUSION_SINCE))return LEGACY_ZERO_FINDINGS.test(text);
  return strictZeroBlocking(text);
}
