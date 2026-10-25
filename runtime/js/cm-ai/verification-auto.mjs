// The verification gate answered by the host (control policy verification:"auto").
// It accepts the developer's per-requirement report only when every item is
// satisfied and no tagged item contradicts what the host itself ran
// (host-replay.mjs). It can only stop: a satisfied verdict still leaves the full
// independent review, which also reads the host's own replay record.
//
// Run claims are matched by their structured tag, never by reading free text:
// run "red" needs the test-files-only run to have run and failed; run "baseline"
// needs the baseline to have run (a run that could not start proves nothing) and,
// with a result, to have that result. An untagged item is not a run claim here.
// The same limit as the session-answered gate: coverage of every written
// requirement, and the tagging of every run claim, are not proven.
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
    if(item.run==='red'&&!(replayed&&!facts.red.skipped&&facts.red.outcome==='failed'))
      unsatisfied.push(`${item.requirement}（标记为先失败，宿主实跑与此不符：${redFact(facts)}）`);
    if(item.run==='baseline'){
      if(!replayed)unsatisfied.push(`${item.requirement}（标记为基线，宿主没有实跑基线：${facts.reason}）`);
      else if(!ran(facts.baseline))unsatisfied.push(`${item.requirement}（标记为基线，宿主基线没有跑起来：${facts.baseline.outcome}）`);
      else if(item.result&&item.result!==facts.baseline.outcome)
        unsatisfied.push(`${item.requirement}（标记基线 ${item.result}，宿主实跑基线 ${facts.baseline.outcome}）`);
    }
  }
  // The runner stops at develop_checks_not_passed before this gate when the
  // task's own checks fail; kept so the gate never passes a failed delivery.
  if(facts.green.outcome!=='passed')unsatisfied.push(`宿主实跑：全部放入后检查 ${facts.green.outcome}`);
  return unsatisfied.length?{satisfied:false,unsatisfied}:{satisfied:true,items:report};
}
