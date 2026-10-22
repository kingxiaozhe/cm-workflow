// Commander phase 2 dispatch preflight: cm-start-check's findings plus the
// commander's own, for the one driver operation about to be dispatched. Each
// rule applies only where the driver would act the same way, so a legitimate
// second round, a recovery or a read-only step is not refused. Read-only.
import fs from 'node:fs';
import path from 'node:path';
import {loadStartInputs,startCheck} from './cm-start-check.mjs';
import {answerValueFindings,answerChangeFindings,deviceFindings,checksDriftFindings} from '../runtime/js/commander/preflight.mjs';
import {readRegistry,openDispatches,registryProblem} from '../runtime/js/commander/dispatch-registry.mjs';
import {readExecutionSnapshot} from '../runtime/js/cm-ai/execution-snapshot.mjs';
import {readRunnerHistory} from '../runtime/js/cm-ai/durable-runner-state.mjs';

// Operations whose host step may ask for a develop answer (cm-ai-drive ADVANCE).
export const DEVELOP_OPERATIONS=new Set(['advance','start','resume']);
// Operations that re-run the reviewed checks for completion.
const COMPLETION_OPERATIONS=new Set(['complete','advance','resume']);

// The run as its journal records it, or null for a create or an unreadable run.
function recordedRun(definition){
  let specsRoot;try{specsRoot=fs.realpathSync(definition.specsDir);}catch{return null;}
  try{
    const snapshot=readExecutionSnapshot({specsRoot,identity:{repositoryId:definition.identity.repositoryId,runId:definition.identity.runId}});
    const first=snapshot.records[0].payload;return readRunnerHistory(snapshot.records,first.config,first.version).state;
  }catch{return null;}
}

// The answer file the driver reads for this attempt (attemptAnswerName's rule,
// reported instead of exiting when both attempt-1 names exist).
function answerFile(answersDir,attempt){
  if(attempt!==1)return {name:`develop-a${attempt}.json`};
  const legacy=fs.existsSync(path.join(answersDir,'develop.json')),named=fs.existsSync(path.join(answersDir,'develop-a1.json'));
  if(legacy&&named)return {error:'develop.json 与 develop-a1.json 不能同时存在；驾驶员会拒绝启动'};
  return {name:named?'develop-a1.json':'develop.json'};
}

// Which attempt's answer this step reads: attempt 1 on create; on resume the
// journal's own attempt, which the runner already advances to 2 when the first
// review requests changes (the driver reads develop-a2.json then).
export const answerAttempt=(mode,state)=>mode==='create'?1:state?state.attempt:null;

export function commanderPreflight(planFile,{operation,now=new Date().toISOString()}={}){
  const findings=[];
  let plan,definition;
  try{({plan,definition}=loadStartInputs(planFile));}
  catch(error){return {findings:[{level:'error',code:'plan_unreadable',message:error.message}]};}
  // cm-start-check refuses some inputs with no verdict (invalid scope, modes it
  // does not model). That refusal keeps its weight: it is an error here too.
  try{findings.push(...startCheck(planFile));}
  catch(error){findings.push({level:'error',code:'start_check_refused',message:`开工体检拒绝给出结论：${error.message}`});}
  const state=plan.mode==='resume'?recordedRun(definition):null;
  const base=path.dirname(path.resolve(planFile));
  const answersDir=typeof plan.answers==='string'?path.resolve(base,plan.answers):null;
  if(answersDir&&DEVELOP_OPERATIONS.has(operation)){
    const attempt=answerAttempt(plan.mode,state);
    if(attempt===null)findings.push({level:'info',code:'answer_check_skipped',message:'读不了原运行记录，没能确定本步用哪一轮的开发应答，已跳过应答核对'});
    else{
      const chosen=answerFile(answersDir,attempt);
      if(chosen.error)findings.push({level:'error',code:'develop_answer_ambiguous',message:chosen.error});
      else if(fs.existsSync(path.join(answersDir,chosen.name))){
        let answer;try{answer=JSON.parse(fs.readFileSync(path.join(answersDir,chosen.name),'utf8'));}
        catch{answer=null;findings.push({level:'error',code:'develop_answer_unreadable',message:`${chosen.name} 不是合法 JSON`});}
        const tag=items=>items.map(item=>({...item,answer:chosen.name,message:`${chosen.name}：${item.message}`}));
        if(answer){
          findings.push(...tag(answerValueFindings(answer,{feature:definition.feature,identity:{...definition.identity,attempt}})));
          // Only on create is the code root the delivery's own baseline; after a
          // delivery the driver compares against the recorded baseline instead.
          if(plan.mode==='create')findings.push(...tag(answerChangeFindings(answer,{answersDir,codeProject:definition.codeProject})));
        }
      }
    }
  }
  let specsReadable=true;try{fs.realpathSync(definition.specsDir);}catch{specsReadable=false;}
  if(specsReadable){
    const registry=readRegistry(definition.specsDir),problem=registryProblem(registry);
    if(problem)findings.push({level:'error',code:'registry_unreadable',message:`派活登记有问题（${problem}），不能确认设备是否空闲；先核对登记文件`});
    findings.push(...deviceFindings(plan.checks,openDispatches(registry,now),{runId:definition.identity?.runId??null}));
  }
  // Completion re-runs the checks of the approved package of this attempt; only
  // then must PLAN.checks equal them. A new delivery may use other checks.
  if(state&&COMPLETION_OPERATIONS.has(operation)&&state.state==='approved'
    &&state.reviewPackage?.identity?.attempt===state.attempt)
    findings.push(...checksDriftFindings(plan.checks,state.reviewPackage.checks?.map(check=>({id:check.id,command:check.command}))));
  return {findings};
}
