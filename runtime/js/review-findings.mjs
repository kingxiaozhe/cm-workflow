// 审查凭证里「批准且零阻塞」的正文说法：任务门禁与 cm-refactor 驾驶员共用这一份。
// 「阻断」是 CM 严重度分级的用词，审查方常写「零阻塞发现」「无阻断发现」，一并接受；
// 原有说法全部保留。改动这里即改动两处门禁，文档列表见 runtime/review.md「Evidence file」。
export const ZERO_BLOCKING_PHRASES=Object.freeze(['零发现','零阻塞发现','零阻断发现','无阻塞发现','无阻断发现',
  '未发现阻塞','未发现阻断','zero findings','no findings','no blocking findings']);
const escape=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
// 说法必须是一句结论本身：位于行首或紧跟句号/分号/叹号之后（可带列表符、加粗和「结论：」），
// 后面紧跟行尾、空白或非问号的标点。引用行、代码块、问句和「不能说零阻塞发现」这类句中片段都不算。
// 头部 verdict 与 blocking_findings 才是结构化结论；这里只防误把非结论文字当成零阻塞。
const CONCLUSION_LINE=new RegExp(`(?:^|[。.!！；;]\\s*)(?:[-*+]\\s+)?(?:\\*\\*)?(?:(?:结论|conclusion)\\s*[:：]\\s*)?(?:\\*\\*)?`
  +`(?:${ZERO_BLOCKING_PHRASES.map(escape).join('|')})(?:\\*\\*)?(?=$|\\s|[。.，,；;：:！!（()）\\]】])`,'i');
export function statesZeroBlockingFindings(body){
  // 结构化正文（受控补正等）只看 conclusion 字段；字段本身的完整合同由各自门禁另行校验。
  let structured=null;
  try{structured=JSON.parse(String(body));}catch{}
  if(structured&&typeof structured==='object'&&!Array.isArray(structured)&&Object.hasOwn(structured,'conclusion'))
    return typeof structured.conclusion==='string'&&CONCLUSION_LINE.test(structured.conclusion.trim());
  let fence=null;
  for(const raw of String(body).split(/\r?\n/)){
    const line=raw.trim(),marker=/^(`{3,}|~{3,})/.exec(line)?.[1];
    if(marker){if(!fence)fence=marker;else if(marker[0]===fence[0]&&marker.length>=fence.length)fence=null;continue;}
    if(fence||line.startsWith('>'))continue;
    if(CONCLUSION_LINE.test(line))return true;
  }
  return false;
}
export const REVIEWER_SOURCES=Object.freeze(['codex-subagent','codex-cli','claude-cli','self-degraded']);
