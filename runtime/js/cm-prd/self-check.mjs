// Mechanical subset of the existing Step 10.5 checklist. No semantic approval.
import {parseFeatureTaskText,validDependencies,declaredAcceptanceIds,DEPENDENCY} from '../cm-ai/cm-ai-admission.mjs';
import {specLines,taskLines,TASK_GRAMMAR} from '../spec-task-line.mjs';
import {parseTaskScopes,BOOTSTRAP_FEATURE,sessionTaskProblem,sessionTaskReason} from '../task-scope.mjs';
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
// Rule 3 adds per-task file scope (task-scope.mjs): every new task must name the
// files it may change, so parallel work is decided from the approved tasks.md
// instead of a session's guess. Tasks an approved tasks.md already had may stay
// without scope (they simply run serially).
// Rule 4 reads tasks.md as task grammar 3 (`开发: 会话`) and adds the session-task checks.
export const PRD_SELF_CHECK_RULES=4;
// Every rule a session, an operation or a recorded report may carry. Earlier rules
// stay listed explicitly so raising the current one never drops them.
export const PRD_SELF_CHECK_RULE_VERSIONS=Object.freeze([...new Set([PRD_SELF_CHECK_RULES,3,2,1])]);
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
// The missing-scope hint text a recorded rule-3 report may carry (persisted
// reports are matched by digest, so a reworded hint keeps its old form here).
const SCOPE_HINT='每个任务下写一行缩进子项，例如 - 范围: `src/a.js`, `test/a.test.js`（只有 N.bootstrap 脚手架里列不出文件的任务才写 - 范围: 串行）';
const SCOPE_HINTS=[SCOPE_HINT,'每个任务下写一行缩进子项，例如 - 范围: `src/a.js`, `test/a.test.js`；列不出文件的任务写 - 范围: 串行'];
export function matchesPrdDraftMechanics(draft,recorded,options={}){
  const want=digest(recorded);
  return PRD_SELF_CHECK_RULE_VERSIONS.some(rules=>{
    const report=checkPrdDraftMechanics(draft,{...options,rules});
    return SCOPE_HINTS.some(hint=>digest({...report,findings:report.findings.map(item=>
      item.code==='task_scope_missing'?{...item,reason:{...item.reason,expected:hint}}:item)})===want);
  });
}
// `scopes` ({directory: {exempt:[taskId...]}}) applies only rule 3's per-task scope
// check, to those features, on top of `rules`. Re-checks of a saved draft
// (correction, disposition, summary) pass it when the save recorded that the draft
// carried scopes (task-scope-record.mjs), so a correction cannot drop them while
// every other check stays on its old rule.
export function checkPrdDraftMechanics(draft,{change=false,previous=null,rules=1,scopes=null}={}){
  need(PRD_SELF_CHECK_RULE_VERSIONS.includes(rules),'prd_self_check_rules_invalid');
  const findings=[],features=[];
  for(const feature of draft.features){
    const files=new Map(feature.documents.map(document=>[document.path,document.content]));
    const add=(code,reason=null)=>findings.push({feature:feature.directory,code,
      ...(code==='dependencies_invalid'?{reason:{field:`${feature.directory}/tasks.md`,
        expected:'One line per task; comma-separated prerequisites, e.g. - T-003 依赖 T-001, T-002'}}:{}),
      ...(reason?{reason}:{})});
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
    const scope=scopes!==null&&Object.hasOwn(scopes,feature.directory)?scopes[feature.directory]:null;
    if((rules>=3||scope!==null)&&!parsed.error){
      // Rules 1-3 predate grammar 3: a `开发:` line there stays prose, as it was then.
      const scopes=parseTaskScopes(files.get('tasks.md'),{grammar:rules>=4?TASK_GRAMMAR:2});
      const problems=scopes.errors.map(item=>`${item.taskId??'(无任务)'} 第 ${item.line} 行：${item.message}`);
      // 串行 is the scaffold generator's exit (a N.bootstrap feature), not an opt-out for business tasks.
      if(!BOOTSTRAP_FEATURE.test(feature.directory))for(const id of scopes.serial)problems.push(`${id}：范围: 串行 只用于脚手架功能（N.bootstrap），其余任务要列出文件`);
      if(problems.length)add('task_scope_invalid',{field:`${feature.directory}/tasks.md`,problems:problems.slice(0,10)});
      // Only tasks an approval already covered may stay without scope; the caller
      // derives them from the approval (task-scope-record.mjs), never from a draft.
      const known=new Set(scope?.exempt??[]);
      const missing=parsed.tasks.filter(task=>!task.dropped&&!scopes.tasks.has(task.id)&&!scopes.serial.has(task.id)&&!scopes.errors.some(item=>item.taskId===task.id)
        &&!known.has(task.id)).map(task=>task.id);
      if(missing.length)add('task_scope_missing',{field:`${feature.directory}/tasks.md`,tasks:missing,
        expected:SCOPE_HINT});
    }
    if(rules>=4&&!parsed.error)for(const item of sessionTaskFindings(feature.directory,files.get('tasks.md')))add(item.code,item.reason);
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

// Grammar 3 mechanical check (task-scope.mjs sessionTaskProblem): only the explicit
// `开发: 会话` marks, never a guess at which task needs a session. Findings shaped like
// checkPrdDraftMechanics' own; empty under grammar 1/2, where the mark is prose, and for
// a tasks.md the parser already refuses (that finding is reported on its own).
export function sessionTaskFindings(directory,source,{grammar=TASK_GRAMMAR}={}){
  if(grammar!==TASK_GRAMMAR)return [];
  const parsed=parseFeatureTaskText(source,{grammar});
  if(parsed.error)return [];
  const problem=sessionTaskProblem(parsed.tasks,parseTaskScopes(source,{grammar}).sessions);
  return problem?[{feature:directory,code:problem.code,reason:{field:`${directory}/tasks.md`,tasks:problem.tasks,
    expected:sessionTaskReason(problem)}}]:[];
}
