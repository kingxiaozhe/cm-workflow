// Mechanical subset of the existing Step 10.5 checklist. No semantic approval.
import {parseFeatureTaskText,validDependencies,declaredAcceptanceIds,DEPENDENCY} from '../cm-ai/cm-ai-admission.mjs';
import {specLines,taskLines} from '../spec-task-line.mjs';
import {validateTestCases} from '../../../scripts/validate-test-cases.mjs';
import {json,shape,need,digest} from '../cm-ai/effect-contract.mjs';

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

// Examples are not declarations. Task lines go through the shared grammar,
// which already skips fences; this blanks fenced acceptance examples.
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
// Rule 2 adds checks the parser alone cannot make; rule 1 is the original subset.
// Only a fresh draft round and a change proposal opt into rule 2. Every re-check
// of material that may predate it (corrections, dispositions, summary) stays on
// rule 1, and a recorded report is accepted under either rule
// (matchesPrdDraftMechanics), so sessions started before the upgrade resume as before.
export const PRD_SELF_CHECK_RULES=2;
// Task- or dependency-looking lines the parser skips: a task written this way
// would silently drop out of execution.
const TASK_LIKE=/^\s*-\s*\[[^\]]*\]\s+(?:~~)?T-/,DEPENDENCY_LIKE=/^\s*-\s*T-\S*\s+依赖(?:\s|$)/;
function malformedLines(source){
  const counts=new Map();
  for(const line of taskLines(source)){
    if(line.fenced||line.declaration||DEPENDENCY.test(line.body))continue;
    const code=TASK_LIKE.test(line.body)?'tasks_invalid':DEPENDENCY_LIKE.test(line.body)?'dependencies_invalid':null;
    if(code)counts.set(line.body,{code,count:(counts.get(line.body)?.count??0)+1});
  }
  return counts;
}
// Unfenced dependency lines as task -> exact prerequisite list.
function dependencyLines(source){
  const result=new Map();
  for(const line of specLines(source)){
    const match=line.fenced?null:line.body.match(DEPENDENCY);
    if(match&&!result.has(match[1]))result.set(match[1],match[2].split(/[,，]/).map(value=>value.trim()).filter(Boolean).join(','));
  }
  return result;
}
// Under rule 2 a change proposal is strict only for what it adds: a malformed line
// is exempt up to the number of times the approved tasks.md already had it, and a
// dependency on a dropped task is exempt when the approved file had that same line.
function strictFindings(source,previous,parsed){
  const codes=new Set(),before=previous===null?new Map():malformedLines(previous);
  for(const [body,{code,count}] of malformedLines(source))if(count>(before.get(body)?.count??0))codes.add(code);
  if(!parsed.error){
    const dropped=new Set(parsed.tasks.filter(task=>task.dropped).map(task=>task.id));
    const approved=previous===null?new Map():dependencyLines(previous);
    for(const [taskId,required] of parsed.dependencies)
      if(required.some(id=>dropped.has(id))&&approved.get(taskId)!==required.join(','))codes.add('dependencies_invalid');
  }
  return [...codes];
}
export function matchesPrdDraftMechanics(draft,recorded,options={}){
  return [PRD_SELF_CHECK_RULES,1].some(rules=>digest(checkPrdDraftMechanics(draft,{...options,rules}))===digest(recorded));
}
export function checkPrdDraftMechanics(draft,{change=false,previous=null,rules=1}={}){
  need(rules===1||rules===PRD_SELF_CHECK_RULES,'prd_self_check_rules_invalid');
  const findings=[],features=[];
  for(const feature of draft.features){
    const files=new Map(feature.documents.map(document=>[document.path,document.content]));
    const add=code=>findings.push({feature:feature.directory,code,
      ...(code==='dependencies_invalid'?{reason:{field:`${feature.directory}/tasks.md`,
        expected:'One line per task; comma-separated prerequisites, e.g. - T-003 依赖 T-001, T-002'}}:{})});
    const parsed=parseFeatureTaskText(files.get('tasks.md'));
    const acIds=declaredAcceptanceIds(outsideFences(files.get('requirements.md')));
    if(acIds.size===0)add('acceptance_missing');
    let taskIds=new Set();
    if(parsed.error)add(parsed.error);
    else{
      taskIds=new Set(parsed.tasks.map(task=>task.id));
      // Dropped tasks stay in tasks.md as history; only the rest is executable work.
      if((rules===1?parsed.tasks:parsed.tasks.filter(task=>!task.dropped)).length>15)add('task_limit_exceeded');
      if(!change&&parsed.tasks.some(task=>task.completed||task.dropped))add('new_task_not_pending');
      if(!validDependencies(parsed.tasks,parsed.dependencies))add('dependencies_invalid');
    }
    if(rules!==1){
      const reported=new Set(findings.filter(item=>item.feature===feature.directory).map(item=>item.code));
      for(const code of strictFindings(files.get('tasks.md'),previous?.[feature.directory]??null,parsed))
        if(!reported.has(code))add(code);
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
