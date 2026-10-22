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
// 正文第一个非空行必须顶格、整行只写结论：可选列表符或加粗、可选「结论：」，一个认可说法，可选句号。
// 只认第一行：它前面没有任何内容，不会落在代码围栏、引用或 HTML 注释里，无需解析 Markdown 结构。
// 后文与结论矛盾时由审查方负责；头部 verdict 与 blocking_findings 才是结构化结论。
const CONCLUSION=new RegExp(`^(?:(?:结论|conclusion)\\s*[:：]\\s*)?(?:${ZERO_BLOCKING_PHRASES.map(escape).join('|')})\\s*[。.]?$`,'i');
function conclusionLine(text){
  if(/^\s/.test(text))return false;
  let line=text.trim().replace(/^[-*+]\s+/,'');
  line=line.replace(/^\*\*((?:结论|conclusion)\s*[:：])\s*\*\*\s*/i,'$1').replace(/^\*\*(结论|conclusion)\*\*\s*([:：])\s*/i,'$1$2');
  const bold=/^\*\*([^*]+)\*\*$/.exec(line);
  if(bold)line=bold[1].trim();
  return CONCLUSION.test(line);
}
function strictZeroBlocking(body){
  // 结构化正文（受控补正等）只看 conclusion 字段，且它本身必须是一行结论；完整合同由各自门禁另行校验。
  let structured=null;
  try{structured=JSON.parse(body);}catch{}
  if(structured&&typeof structured==='object'&&!Array.isArray(structured)&&Object.hasOwn(structured,'conclusion'))
    return typeof structured.conclusion==='string'&&!/[\r\n]/.test(structured.conclusion)&&conclusionLine(structured.conclusion);
  const first=body.split(/\r?\n/).find(line=>line.trim()!=='');
  return first!==undefined&&conclusionLine(first);
}
export function statesZeroBlockingFindings(body,{at}={}){
  const text=String(body),time=Date.parse(at);
  if(!Number.isNaN(time)&&time<Date.parse(STRICT_CONCLUSION_SINCE))return LEGACY_ZERO_FINDINGS.test(text);
  return strictZeroBlocking(text);
}
