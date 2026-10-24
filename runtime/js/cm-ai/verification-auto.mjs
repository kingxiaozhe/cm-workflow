// The verification gate answered by the host (control policy verification:"auto").
// It accepts the developer's per-requirement report only when every item is
// satisfied and none contradicts what the host itself ran (host-replay.mjs). It
// can only stop: a satisfied verdict still leaves the full independent review.
//
// The same limit as the session-answered gate: requirements are free text, so
// coverage of every written requirement is not proven. What is enforced is that
// a claim about a failing-first run or a baseline run matches a host run that
// actually ran (a run that could not start proves nothing).
const RED=new RegExp(['\\bRED\\b','先.{0,8}(失败|报错|抛错|变红)','看到.{0,4}失败','观察.{0,8}失败',
  '(旧|原|修改前|改前|改动前|实现前|未实现|没实现|占位).{0,12}(失败|不通过|报错|抛错)',
  'fails? first','failing[- ]first','fail(s|ed)? (before|without|on the old|against the old)'].join('|'),'i');
const BASELINE=/基线|baseline|改代码前|改动前/i;
const BASELINE_PASSED=/(基线|baseline)[^。；;\n]{0,30}(通过|passed|\bpass\b|green|全绿)/i;
const ran=run=>run&&['passed','failed'].includes(run.outcome);

const redFact=facts=>facts.status!=='replayed'?`未实跑（${facts.reason}）`
  :facts.red.skipped?'tasks.md 未写测试文件，没有只放入测试文件的实跑'
    :`只放入测试文件时检查 ${facts.red.outcome}`;

// report: the developer's items, null (absent) or 'invalid'. facts: replayDelivery's result.
export function autoVerificationVerdict({report,facts}){
  if(report===null)return {satisfied:false,unsatisfied:['开发结果没有逐条要求与证据（requirements）']};
  if(report==='invalid')return {satisfied:false,unsatisfied:['开发结果的逐条要求与证据（requirements）格式不合法']};
  const unsatisfied=[],replayed=facts.status==='replayed';
  for(const item of report){
    if(item.satisfied!==true){unsatisfied.push(item.requirement);continue;}
    const claim=`${item.requirement}\n${item.evidence}`;
    if(RED.test(claim)&&!(replayed&&!facts.red.skipped&&facts.red.outcome==='failed'))
      unsatisfied.push(`${item.requirement}（宿主实跑与此不符：${redFact(facts)}）`);
    if(BASELINE.test(claim)){
      if(!replayed)unsatisfied.push(`${item.requirement}（宿主没有实跑基线：${facts.reason}）`);
      else if(!ran(facts.baseline))unsatisfied.push(`${item.requirement}（宿主基线没有跑起来：${facts.baseline.outcome}）`);
      else if(BASELINE_PASSED.test(claim)&&facts.baseline.outcome!=='passed')
        unsatisfied.push(`${item.requirement}（宿主实跑与此不符：基线 ${facts.baseline.outcome}）`);
    }
  }
  // The runner stops at develop_checks_not_passed before this gate when the
  // task's own checks fail; kept so the gate never passes a failed delivery.
  if(facts.green.outcome!=='passed')unsatisfied.push(`宿主实跑：全部放入后检查 ${facts.green.outcome}`);
  return unsatisfied.length?{satisfied:false,unsatisfied}:{satisfied:true,items:report};
}
