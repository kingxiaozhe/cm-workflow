// cm-test Step 4/7: static evidence is never an executed-test PASS.
import {validateTestCases} from '../../../scripts/validate-test-cases.mjs';
import {need,shape,json,digest} from '../cm-ai/effect-contract.mjs';

export function inspectCmTestLogicResults(contract,raw){
  contract=json(contract,256*1024);need(validateTestCases(contract).length===0,'cm_test_contract_invalid');
  const cases=contract.cases.filter(item=>item.kind==='logic');
  need(cases.length>0,'cm_test_logic_cases_missing');
  const result=json(raw,256*1024);shape(result,['contractDigest','results']);
  need(result.contractDigest===digest(contract)&&Array.isArray(result.results)
    &&result.results.length===cases.length,'cm_test_logic_binding');
  const ids=new Set();let blockingFailure=false,blockingUnknown=false,contradiction=false;
  const counts={supported:0,contradicted:0,insufficient:0,executedPassed:0};
  for(const row of result.results){
    shape(row,['id','verdict','evidence','explanation']);
    const item=cases.find(candidate=>candidate.id===row.id);
    need(item&&!ids.has(row.id)&&['SUPPORTED','CONTRADICTED','INSUFFICIENT_EVIDENCE'].includes(row.verdict)
      &&typeof row.explanation==='string'&&row.explanation.trim()&&Array.isArray(row.evidence),
      'cm_test_logic_result_invalid');ids.add(row.id);
    for(const source of row.evidence){
      shape(source,['path','line']);
      need(typeof source.path==='string'&&source.path.trim()&&Number.isSafeInteger(source.line)&&source.line>=1,
        'cm_test_logic_evidence_invalid');
    }
    need(row.verdict==='INSUFFICIENT_EVIDENCE'||row.evidence.length>0,'cm_test_logic_evidence_missing');
    // Unconfirmed inferred expectations cannot become supported by circularly
    // citing the same implementation from which they were inferred.
    if(item.expected.some(text=>text.startsWith('[需确认]')))
      need(row.verdict==='INSUFFICIENT_EVIDENCE','cm_test_expected_confirmation_required');
    counts[row.verdict==='SUPPORTED'?'supported':row.verdict==='CONTRADICTED'?'contradicted':'insufficient']++;
    contradiction ||= row.verdict==='CONTRADICTED';
    blockingFailure ||= item.blocking&&row.verdict==='CONTRADICTED';
    blockingUnknown ||= item.blocking&&row.verdict==='INSUFFICIENT_EVIDENCE';
  }
  const overall=blockingFailure?'FAIL':blockingUnknown||contradiction?'BLOCKED':'REVIEWED';
  return json({status:'logic_reviewed',overall,counts,contractDigest:result.contractDigest,results:result.results,
    source:'host_reported_static_analysis',executed:false,completionAuthorized:false,
    next:overall==='REVIEWED'?'report_static_review_not_execution_pass':'report_evidence_without_auto_fix'});
}
