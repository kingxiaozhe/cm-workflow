// Read-only completion projection. It neither authorizes a transition nor writes
// task state. The host supplies its already validated runner status; all wider
// claims come from the approved inventory and strictly bound latest QA evidence.
import fs from 'node:fs';
import path from 'node:path';
import {verifyApprovedManifest} from '../../../scripts/cm-spec-manifest.mjs';
import {recordedTaskGrammar} from '../spec-task-line.mjs';
import {parseFeatureTaskText} from './cm-ai-admission.mjs';
import {findCmAiQaDecision,latestCmAiQaRun} from './cm-ai-qa-log.mjs';
import {readReviewSourceFiles} from './review-package.mjs';
import {readStableLogRows} from './log-rows.mjs';
import {readExecutionSnapshot} from './execution-snapshot.mjs';
import {readRunnerHistory} from './durable-runner-state.mjs';
import {digest,freeze,need} from './effect-contract.mjs';
import {deliveryProjection} from './delivery-evidence.mjs';

const unknown=reason=>({status:'unknown',reason,evidence:[]});
const sameIdentity=(a,b)=>a&&b&&['repositoryId','runId','taskId','attempt'].every(key=>a[key]===b[key]);
const blockedCodes=new Set(['correction_review_required','spec_drift']);
const safeCode=error=>typeof error?.code==='string'&&/^[a-z][a-z0-9_]{0,63}$/.test(error.code)?error.code:'completion_evidence_unavailable';

// The receipt has already passed the owning runner's registration/replay gates.
// These checks prevent this display from accidentally pairing a previous receipt
// with a different task/attempt/candidate; they are not a new completion gate.
export function taskCompletion(status){
  const receipt=status?.receipt,{receiptDigest,...body}=receipt??{};
  const matched=receipt?.kind==='cm-review-receipt'&&sameIdentity(receipt.identity,status.identity)
    &&receipt.packageDigest===status.packageDigest&&receiptDigest===digest(body);
  const historicalCompleted=['fixture_completed','run_done'].includes(status?.state);
  const blocked=blockedCodes.has(status?.code)||status?.state==='blocked';
  const review=matched?{status:receipt.result?.verdict==='approved'?'passed':receipt.result?.verdict==='changes_requested'?'failed':'blocked',
    evidence:[`receipt:${receiptDigest}`]}:unknown('registered_review_receipt_unavailable');
  return {status:blocked?'blocked':status?.state==='unknown'?'unknown':historicalCompleted&&review.status==='passed'?'completed':historicalCompleted?'unknown':'pending',
    historicalCompleted,review,reason:blocked?status.code:historicalCompleted&&review.status!=='passed'?'registered_review_receipt_unavailable':null,
    evidence:matched?[`receipt:${receiptDigest}`,`package:${status.packageDigest}`]:[]};
}

const statKey=file=>{
  try{const s=fs.lstatSync(file,{bigint:true});
    need(!s.isSymbolicLink()&&s.isFile()&&s.nlink===1n,'completion_source_invalid');
    return [s.dev,s.ino,s.mode,s.size,s.mtimeNs,s.ctimeNs].join(':');
  }catch(error){if(error.code==='ENOENT')return null;throw error;}
};

export function completionSummary({specsDir,feature,result,task=result?.completion?.task??taskCompletion(result)}){
  const identity=result?.identity??null,packageDigest=result?.packageDigest??null;
  const binding={feature:feature??null,identity,packageDigest,runnerRevision:null};
  const base={version:1,binding,task,feature:unknown('approved_inventory_unavailable'),
    project:unknown('approved_inventory_unavailable'),run:unknown('run_done_evidence_unavailable'),
    productAcceptance:unknown('external_owner_acceptance_not_recorded'),deployment:unknown('deployment_evidence_not_recorded')};
  try{
    need(typeof specsDir==='string'&&path.isAbsolute(specsDir)&&fs.realpathSync(specsDir)===specsDir,'completion_source_invalid');
    const watched=new Map(),watch=file=>{if(!watched.has(file))watched.set(file,statKey(file));};
    const snapshots=new Map(),histories=new Map();
    const snapshotFor=who=>{
      const key=digest({repositoryId:who.repositoryId,runId:who.runId});
      watch(path.join(specsDir,'.reviews','.execution',who.runId,'state.json'));
      if(!snapshots.has(key))snapshots.set(key,readExecutionSnapshot({specsRoot:specsDir,
        identity:{repositoryId:who.repositoryId,runId:who.runId}}));
      return snapshots.get(key);
    };
    const completedOwner=(who,candidate)=>{
      const snapshot=snapshotFor(who);
      if(!histories.has(snapshot.revision)){
        const init=snapshot.records[0]?.payload;
        histories.set(snapshot.revision,readRunnerHistory(snapshot.records,init.config,init.version));
      }
      const history=histories.get(snapshot.revision),state=history.state;
      need(history.pending===null&&state.state==='fixture_completed'&&state.attempt===who.attempt
        &&state.reviewPackage?.packageDigest===candidate&&sameIdentity(state.receipt?.identity,who),'completion_owner_changed');
      return {snapshot,history};
    };
    const statusFile=path.join(specsDir,'.cm-specs-status');watch(statusFile);
    let acceptanceProtection='unknown',boundSources=null;
    if(identity?.runId){
      watch(path.join(specsDir,'.reviews','.execution',identity.runId,'state.json'));
      try{
        const snapshot=snapshotFor(identity);binding.runnerRevision=snapshot.revision;
        const baseline=snapshot.records[0]?.payload?.baseline;
        if(baseline)acceptanceProtection=baseline.specification?.acceptanceContract?.version===1?'contract_v1':'legacy_unprotected';
        if(baseline?.specification)boundSources=snapshot.records.findLast(item=>item.payload?.type==='specification-rebound')?.payload.record?.sources
          ??baseline.specification.sources;
      }catch{/* Missing legacy evidence stays unknown; no upgrade or journal write. */}
    }
    if(task.status==='completed')try{
      const {history}=completedOwner(identity,packageDigest);
      need(task.review.evidence.includes(`receipt:${history.state.receipt.receiptDigest}`),'completion_owner_changed');
    }catch(error){task={...task,status:'unknown',reason:safeCode(error)};}
    const approvalRecord=readReviewSourceFiles(specsDir,['.cm-specs-status'])[0];
    const approval=JSON.parse(Buffer.from(approvalRecord.contentBase64,'base64').toString('utf8'));
    need(approval.status==='approved'&&Array.isArray(approval.features)&&approval.features.length>0
      &&new Set(approval.features).size===approval.features.length,'completion_inventory_invalid');
    const manifest=verifyApprovedManifest(specsDir,statusFile);
    if(boundSources!==null&&digest(boundSources)!==digest(manifest.filter(item=>item.path.startsWith(feature+'/'))))
      task={...task,status:'blocked',reason:'spec_drift'};
    const names=[...approval.features].sort();
    need(digest(names)===digest([...new Set(manifest.map(row=>row.path.split('/')[0]))].sort()),'completion_inventory_invalid');
    for(const row of manifest)watch(path.join(specsDir,row.path));
    const log=path.join(specsDir,'运行日志.jsonl');watch(log);
    const rows=watched.get(log)===null?[]:readStableLogRows(log,row=>row?.schema_version===1&&row.workflow==='cm-ai','completion_log_invalid',{maxBytes:32*1024*1024});
    const latest=new Map();for(const row of rows)if(row.event==='qa'&&row.node==='N6')latest.set(row.feature,row);
    const qaFor=(name,pending)=>{
      const row=latest.get(name);if(!row)return unknown('qa_missing');
      const qaIdentity={repositoryId:row.repository_id,runId:row.run_id,taskId:row.task,attempt:row.attempt};
      const input={specsDir,feature:name,identity:qaIdentity,packageDigest:row.package_digest};
      const evidence=[`运行日志.jsonl#${row.event_id??row.decision_id}`];
      try{
        if(name===feature&&(!identity||!packageDigest))return {...unknown('current_candidate_unavailable'),evidence,binding:input.identity,packageDigest:input.packageDigest};
        if(name===feature)
          need(sameIdentity(qaIdentity,identity)&&row.package_digest===packageDigest,'qa_candidate_changed');
        watch(path.join(specsDir,'.reviews','.execution',qaIdentity.runId,'state.json'));
        for(const item of rows)if(item.event==='test_run'&&item.run_id===qaIdentity.runId&&typeof item.report==='string')
          watch(path.resolve(specsDir,item.report));
        const decision=findCmAiQaDecision(input);need(decision?.decisionId===row.decision_id,'qa_decision_mismatch');
        if(decision.status==='skipped')return {status:'skipped',reason:pending===0?'terminal_feature_qa_required':decision.reason,
          evidence,binding:input.identity,packageDigest:input.packageDigest};
        if(decision.status==='blocked')return {status:'blocked',reason:decision.reason,evidence,binding:input.identity,packageDigest:input.packageDigest};
        const inspected=latestCmAiQaRun(input);
        if(inspected===null)return {...unknown('qa_not_run'),evidence,binding:input.identity,packageDigest:input.packageDigest};
        if(inspected.status==='passed'){
          // A valid old QA round proves its bound candidate, not a later approved
          // specification. Reuse the owner's original sources / explicit rebind.
          let owner;
          try{owner=completedOwner(qaIdentity,row.package_digest).snapshot;}
          catch{return {...unknown('qa_specification_unavailable'),evidence,binding:input.identity,packageDigest:input.packageDigest};}
          const baseline=owner.records[0]?.payload?.baseline,material=baseline?.specification;
          if(!material)return {...unknown('qa_specification_unavailable'),evidence,binding:input.identity,packageDigest:input.packageDigest};
          need(material.feature===name&&baseline.identity.taskId===qaIdentity.taskId,'qa_specification_mismatch');
          const rebind=owner.records.findLast(item=>item.payload?.type==='specification-rebound')?.payload.record;
          const sources=rebind?.sources??material.sources;
          need(digest(sources)===digest(manifest.filter(item=>item.path.startsWith(name+'/'))),'qa_specification_changed');
        }
        return {status:inspected.status,reason:inspected.status==='passed'?null:`qa_${inspected.status}`,
          evidence:[...evidence,`test_run:${inspected.testRunId}`],binding:input.identity,packageDigest:input.packageDigest};
      }catch(error){const code=safeCode(error);return {status:code==='qa_result_incomplete'?'unknown':'blocked',reason:code,evidence,
        binding:input.identity,packageDigest:input.packageDigest};}
    };
    const features=names.map(name=>{
      const record=readReviewSourceFiles(specsDir,[`${name}/tasks.md`])[0];
      const parsed=parseFeatureTaskText(Buffer.from(record.contentBase64,'base64').toString('utf8'),
        {allowDependencyPunctuation:true,grammar:recordedTaskGrammar(approval.taskGrammar)});
      need(!parsed.error,'completion_tasks_invalid');
      const active=parsed.tasks.filter(item=>!item.dropped),completed=active.filter(item=>item.completed).length;
      const pending=active.length-completed,qa=qaFor(name,pending);
      const tasks={completed,total:active.length,pending,open:active.filter(item=>!item.completed).map(item=>item.id),
        dropped:parsed.tasks.filter(item=>item.dropped).length,evidence:[`${name}/tasks.md#sha256=${record.sha256}`]};
      return {name,status:pending>0?'pending':qa.status==='passed'?'passed':qa.status==='failed'?'failed':qa.status==='unknown'?'unknown':'blocked',tasks,qa};
    });
    const finalRow=rows.filter(row=>row.event==='run_done'&&row.node==='N8'&&row.feature===feature
      &&(row.repository_id===identity?.repositoryId||row.repository_id===undefined)&&row.run_id===identity?.runId&&row.task===identity?.taskId
      &&row.package_digest===packageDigest).at(-1);
    const runEvidence=finalRow?[`运行日志.jsonl#${finalRow.event_id}`,`context:${finalRow.context_digest}`]:[];
    const finalized=Boolean(finalRow&&typeof finalRow.documentation_sync_id==='string'
      &&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(finalRow.documentation_sync_id)&&/^[a-f0-9]{64}$/.test(finalRow.context_digest));
    const legacyBinding=finalized&&finalRow.repository_id===undefined;
    const currentBlocked=task.status==='blocked';
    const currentUnknown=task.status==='unknown'&&task.historicalCompleted;
    const scope=finalRow?.scope_features,scoped=Array.isArray(scope)?features.filter(item=>scope.includes(item.name)):[];
    const scopeCurrent=scoped.length>0&&scoped.length===scope?.length&&scoped.every(item=>item.status==='passed');
    const closeoutBlocked=['documentation_sync_blocked','project_qa_not_passed','qa_resources_open'].includes(result?.code);
    const run={status:currentBlocked||closeoutBlocked?'blocked':currentUnknown||legacyBinding?'unknown':finalized?(scopeCurrent?'finalized':scope?'blocked':'unknown'):
      result?.code==='documentation_synced'?'ready_to_finalize':'pending',
      historicalFinalized:finalized,reason:currentBlocked?task.reason:closeoutBlocked?result.code:legacyBinding?'legacy_closeout_binding_unknown':currentUnknown?task.reason:
        finalized?(scopeCurrent?null:scope?'scoped_acceptance_not_current':'legacy_closeout_scope_unknown'):'run_done_not_recorded',
      scope:finalRow?.scope_features??null,evidence:runEvidence};
    const allPassed=features.every(item=>item.status==='passed');
    const fullCloseout=finalized&&!legacyBinding&&Array.isArray(finalRow.scope_features)&&digest([...finalRow.scope_features].sort())===digest(names);
    const project={status:currentBlocked?'blocked':currentUnknown?'unknown':allPassed&&fullCloseout?'completed':allPassed?'ready_to_finalize':features.some(item=>item.status==='failed')?'failed':
      features.some(item=>item.tasks.pending>0)?'pending':features.some(item=>item.status==='blocked')?'blocked':'unknown',
      scope:names,features,completedFeatures:features.filter(item=>item.status==='passed').length,totalFeatures:features.length,
      pendingTasks:features.reduce((sum,item)=>sum+item.tasks.pending,0),historicalFinalized:fullCloseout,
      reason:currentBlocked||currentUnknown?task.reason:allPassed&&!fullCloseout?'full_project_closeout_not_recorded':null,
      evidence:[`.cm-specs-status#sha256=${approvalRecord.sha256}`,...(fullCloseout?runEvidence:[])]};
    const delivery=deliveryProjection({specsDir,feature,identity,packageDigest,specificationDigest:digest(manifest),
      current:task.status==='completed',maxEvidenceBytes:8*1024*1024});
    // Cross-file snapshot: do not compose earlier tasks with a later QA result.
    verifyApprovedManifest(specsDir,statusFile);
    need([...watched].every(([file,key])=>statKey(file)===key),'completion_snapshot_changed');
    const snapshotDigest=digest({approval:approvalRecord.sha256,files:[...watched].map(([file,key])=>[path.relative(specsDir,file),key]),binding,delivery});
    const selected=features.find(item=>item.name===feature)??unknown('feature_not_approved');
    return freeze({...base,...delivery,task:{...task,acceptanceProtection},snapshotDigest,
      feature:currentBlocked||currentUnknown?{...selected,status:currentBlocked?'blocked':'unknown',reason:task.reason}:selected,project,run});
  }catch(error){const reason=safeCode(error);return freeze({...base,task:{...task,status:'unknown',reason},
    feature:unknown(reason),project:unknown(reason),run:unknown(reason)});}
}

export {completionLines} from './operator-guidance.mjs';
