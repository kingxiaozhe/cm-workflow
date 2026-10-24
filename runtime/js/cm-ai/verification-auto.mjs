// The verification gate answered by the host (control policy verification:"auto").
// It accepts the developer's per-requirement report only when every item is
// satisfied and none contradicts what the host itself ran (host-replay.mjs). It
// can only stop: a satisfied verdict still leaves the full independent review.
//
// The same limit as the session-answered gate: requirements are free text, so
// coverage of every written requirement is not proven. What is enforced is that
// a claim about a failing-first run or a baseline result matches a host run that
// actually ran (a run that could not start proves nothing).
//
// Claims are read one clause at a time, so a behaviour ("校验失败时显示错误")
// is not a run claim and a later clause ("修改后通过") is not about the baseline.
const CLAUSES=/[。；;，,：:\n]+/;
// A failure word followed by 时/后/则/的 describes behaviour, not a run result.
const FAILURE='(失败|不通过|报错|抛错|变红)(?![时后则的])';
const RED=new RegExp(['\\bRED\\b',`先.{0,8}${FAILURE}`,`看到.{0,4}${FAILURE}`,`观察.{0,8}${FAILURE}`,
  `(旧|原|修改前|改前|改动前|实现前|未实现|没实现|占位).{0,12}${FAILURE}`,
  'fails? first','failing[- ]first','fail(s|ed)? (before|without|on the old|against the old)'].join('|'),'i');
const BASELINE=/基线|baseline|改代码前|改动前/i;
// A zero failure count ("fail 0", "0 failed") is a passing report, not a failure.
const ZERO_FAILURES=/\bfail(ed|s|ures?)?\s*[:=]?\s*0\b|\b0\s*fail(ed|s|ures?)?\b|失败\s*[:：=]?\s*0(?!\d)/gi;
const BASELINE_FAILED=/不通过|未通过|没通过|没有通过|失败|报错|\bfail(ed|s)?\b|\bred\b|变红/i;
const BASELINE_PASSED=/通过|\bpass(ed)?\b|\bgreen\b|全绿/i;
const clauses=text=>text.split(CLAUSES).map(part=>part.trim()).filter(Boolean);
// The result a baseline clause states: 'failed', 'passed' or null (only that it ran).
function baselineClaim(clause){
  const text=clause.replace(ZERO_FAILURES,'');
  if(BASELINE_FAILED.test(text))return 'failed';
  return BASELINE_PASSED.test(text)?'passed':null;
}
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
    const parts=clauses(`${item.requirement}\n${item.evidence}`);
    if(parts.some(part=>RED.test(part))&&!(replayed&&!facts.red.skipped&&facts.red.outcome==='failed'))
      unsatisfied.push(`${item.requirement}（宿主实跑与此不符：${redFact(facts)}）`);
    // The requirement names what to record; only the evidence states the result.
    const baselineParts=clauses(item.evidence).filter(part=>BASELINE.test(part));
    if(parts.some(part=>BASELINE.test(part))){
      if(!replayed)unsatisfied.push(`${item.requirement}（宿主没有实跑基线：${facts.reason}）`);
      else if(!ran(facts.baseline))unsatisfied.push(`${item.requirement}（宿主基线没有跑起来：${facts.baseline.outcome}）`);
      else{
        const claimed=baselineParts.map(baselineClaim).filter(Boolean);
        if(claimed.some(result=>result!==facts.baseline.outcome))
          unsatisfied.push(`${item.requirement}（宿主实跑与此不符：基线 ${facts.baseline.outcome}，自报 ${[...new Set(claimed)].join('/')}）`);
      }
    }
  }
  // The runner stops at develop_checks_not_passed before this gate when the
  // task's own checks fail; kept so the gate never passes a failed delivery.
  if(facts.green.outcome!=='passed')unsatisfied.push(`宿主实跑：全部放入后检查 ${facts.green.outcome}`);
  return unsatisfied.length?{satisfied:false,unsatisfied}:{satisfied:true,items:report};
}
