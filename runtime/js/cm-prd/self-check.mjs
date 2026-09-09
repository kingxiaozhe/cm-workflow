// Mechanical subset of the existing Step 10.5 checklist. No semantic approval.
import {parseFeatureTaskText,validDependencies,declaredAcceptanceIds} from '../cm-ai/cm-ai-admission.mjs';
import {validateTestCases} from '../../../scripts/validate-test-cases.mjs';
import {json,shape,need} from '../cm-ai/effect-contract.mjs';

export function inspectPrdContextCheck(raw,draft){
  const report=json(raw,64*1024);shape(report,['draftDigest','features']);
  need(report.draftDigest===draft.draftDigest&&Array.isArray(report.features)
    &&report.features.length===draft.features.length,'prd_context_check_binding');
  const seen=new Set();let failed=false;
  for(const feature of report.features){
    shape(feature,['directory','checks']);
    need(draft.features.some(item=>item.directory===feature.directory)&&!seen.has(feature.directory)
      &&Array.isArray(feature.checks),'prd_context_check_binding');seen.add(feature.directory);
    const expected=draft.mechanicalSelfCheck.pending,ids=new Set();
    need(feature.checks.length===expected.length,'prd_context_check_coverage');
    for(const check of feature.checks){
      shape(check,['id','status','evidence']);
      need(expected.includes(check.id)&&!ids.has(check.id)&&['passed','failed','not_applicable'].includes(check.status)
        &&Array.isArray(check.evidence)&&check.evidence.length>0
        &&check.evidence.every(item=>typeof item==='string'&&item.trim()),'prd_context_check_invalid');
      need(check.status!=='not_applicable'||check.id==='brownfield_references_and_B2_B3_B5_if_applicable','prd_context_check_invalid');
      ids.add(check.id);failed ||= check.status==='failed';
    }
  }
  return json({...report,status:failed?'failed':'host_reported_passed',independentReview:false,completionAuthorized:false});
}

// Examples are not declarations. Leave the original N1 parser behavior unchanged.
function outsideFences(source){
  let fence=null;return source.split(/\r?\n/).map(line=>{
    const match=line.match(/^\s*(`{3,}|~{3,})/);
    if(match){
      if(fence===null)fence=match[1];
      else if(match[1][0]===fence[0]&&match[1].length>=fence.length)fence=null;
      return '';
    }
    return fence===null?line:'';
  }).join('\n');
}
export function checkPrdDraftMechanics(draft,{change=false}={}){
  const findings=[],features=[];
  for(const feature of draft.features){
    const files=new Map(feature.documents.map(document=>[document.path,document.content]));
    const add=code=>findings.push({feature:feature.directory,code});
    const parsed=parseFeatureTaskText(outsideFences(files.get('tasks.md')));
    const acIds=declaredAcceptanceIds(outsideFences(files.get('requirements.md')));
    if(acIds.size===0)add('acceptance_missing');
    let taskIds=new Set();
    if(parsed.error)add(parsed.error);
    else{
      taskIds=new Set(parsed.tasks.map(task=>task.id));
      if(parsed.tasks.length>15)add('task_limit_exceeded');
      if(!change&&parsed.tasks.some(task=>task.completed||task.dropped))add('new_task_not_pending');
      if(!validDependencies(parsed.tasks,parsed.dependencies))add('dependencies_invalid');
    }
    if(files.has('test-cases.json')){
      let cases;try{cases=JSON.parse(files.get('test-cases.json'));}catch{add('test_cases_invalid');}
      if(cases){
        if(validateTestCases(cases).length||cases.feature!==feature.name)add('test_cases_invalid');
        else{
          if(cases.cases.some(item=>item.taskIds.length===0||item.taskIds.some(id=>!taskIds.has(id))
            ||item.acIds.some(id=>!acIds.has(id))))add('test_reference_invalid');
          const covered=new Set(cases.cases.flatMap(item=>item.acIds));
          if([...acIds].some(id=>!covered.has(id)))add('acceptance_test_coverage_missing');
        }
      }
    }
    features.push({directory:feature.directory,tasks:taskIds.size,acceptanceCriteria:acIds.size});
  }
  return json({draftDigest:draft.draftDigest,status:findings.length?'failed':'mechanical_subset_passed',features,findings,
    pending:['task_boundary_and_existing_asset_overlap','acceptance_verifiability','user_case_semantics',
      'test_contract_applicability','brownfield_references_and_B2_B3_B5_if_applicable'],
    completeSelfCheck:false,independentReview:false,completionAuthorized:false});
}
