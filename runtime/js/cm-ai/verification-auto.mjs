// The verification gate answered by the host (control policy verification:"auto").
// It accepts the developer's per-requirement report only when every item is
// satisfied and none contradicts what the host itself ran (host-replay.mjs). It
// can only stop: a satisfied verdict still leaves the full independent review.
//
// The same limit as the session-answered gate: requirements are free text, so
// coverage of every written requirement is not proven. What is enforced is that
// a claim of a failing-first test or a baseline matches a host run.
const RED=/\bRED\b|先.{0,8}(失败|报错|变红)|看到失败|观察.{0,8}失败|fails? first|failing[- ]first/i;
const BASELINE=/基线|baseline|改代码前|改动前/i;

const redFact=facts=>facts.status!=='replayed'?`未实跑（${facts.reason}）`
  :facts.red.skipped?'tasks.md 未写测试文件，没有只放入测试文件的实跑'
    :`只放入测试文件时检查 ${facts.red.outcome}`;

// report: the developer's items, null (absent) or 'invalid'. facts: replayDelivery's result.
export function autoVerificationVerdict({report,facts}){
  if(report===null)return {satisfied:false,unsatisfied:['开发结果没有逐条要求与证据（requirements）']};
  if(report==='invalid')return {satisfied:false,unsatisfied:['开发结果的逐条要求与证据（requirements）格式不合法']};
  const unsatisfied=[];
  for(const item of report){
    if(item.satisfied!==true){unsatisfied.push(item.requirement);continue;}
    const claim=`${item.requirement}\n${item.evidence}`;
    if(RED.test(claim)&&!(facts.status==='replayed'&&!facts.red.skipped&&facts.red.outcome==='failed'))
      unsatisfied.push(`${item.requirement}（宿主实跑与此不符：${redFact(facts)}）`);
    else if(BASELINE.test(claim)&&facts.status!=='replayed')
      unsatisfied.push(`${item.requirement}（宿主没有实跑基线：${facts.reason}）`);
  }
  if(facts.green.outcome!=='passed')unsatisfied.push(`宿主实跑：全部放入后检查 ${facts.green.outcome}`);
  return unsatisfied.length?{satisfied:false,unsatisfied}:{satisfied:true,items:report};
}
