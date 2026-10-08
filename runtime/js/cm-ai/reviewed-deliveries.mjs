// Read-only discovery of other task runs' completed, reviewed deliveries in the
// same specs root. A delivery counts only after its own journal replays through
// the runner grammar to a committed fixture_completed state: its review package
// (and any accepted QA-fix packages) then describe reviewed before->after file
// transitions. A standalone cm-fix run counts the same way once its own owner
// replays it to its normal completed closeout: its independently approved final
// review package is the transition. This grants nothing, never repairs, and
// never opens a writer.
import fs from 'node:fs';
import path from 'node:path';
import {readExecutionSnapshot} from './execution-snapshot.mjs';
import {readRunnerHistory} from './durable-runner-state.mjs';
import {inspectFixCompletionHistory} from '../cm-fix/execution.mjs';
import {deliveredAfter,deliveryStep} from './fix-code-association.mjs';
import {digest,need} from './effect-contract.mjs';

const RUN_ID=/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const cache=new Map();

function readDelivery(specsRoot,identity,read={}){
  try{
    const snapshot=readExecutionSnapshot({specsRoot,identity});
    const init=snapshot.records[0]?.payload;
    if(init?.workflow==='cm-fix-stages-v1'){read.fix=true;return readFixDelivery(specsRoot,identity,init.configuration);}
    if(init?.protocol!=='cm-task-runner'||init.type!=='init'||![2,3].includes(init.version))return null;
    const history=readRunnerHistory(snapshot.records,init.config,init.version);
    const state=history.state;
    if(history.pending!==null||state.state!=='fixture_completed'||state.taskCommit?.outcome!=='fixture_committed'
      ||!state.reviewPackage)return null;
    // Each package carries its own review time: the run's approving review, or
    // for an accepted QA fix the fix's final review registration it cites.
    return Object.freeze({runId:identity.runId,root:init.config.root,taskId:init.config.identity.taskId,
      packages:Object.freeze([{pkg:state.reviewPackage,reviewedAt:approvedReviewAt(state)},
        ...history.acceptedFixes.map(item=>({pkg:item.evidence.reviewPackage,reviewedAt:fixReviewedAt(specsRoot,item.evidence)}))])});
  }catch{return null;}
}
// A standalone cm-fix run in this specs root, read through its own owner's
// read-only replay and completion projection: only a run whose approved final
// review of the exact package was closed by task_done and run_done qualifies
// (never a running, abandoned, cancelled or escalated one). A QA-fix child is
// its parent's delivery, through the parent's acceptance, never its own; a bare
// archive lives outside any specs root.
function readFixDelivery(specsRoot,identity,configuration){
  if(Object.hasOwn(configuration??{},'qaSource')||configuration?.archiveMode!==undefined)return null;
  const {identity:fixIdentity,evidence}=inspectFixCompletionHistory({specsRoot,identity});
  return Object.freeze({runId:identity.runId,root:fs.realpathSync(configuration.reproduction.cwd),taskId:fixIdentity.taskId,
    packages:Object.freeze([{pkg:evidence.reviewPackage,reviewedAt:fixReviewedAt(specsRoot,evidence)}])});
}
// A QA fix package's durable review time: the final review registration its
// completion evidence cites, read from the fix child's own store, for exactly
// that package. Anything else has no time and never orders.
export function fixReviewedAt(specsRoot,evidence){
  try{
    const {repositoryId,runId}=evidence.identity;
    const row=readExecutionSnapshot({specsRoot,identity:{repositoryId,runId}}).records.find(record=>
      /^fix-(?:revision-)?final(?:-recovery(?:-[1-9]\d*)?|-retry)?-registered$/.test(record.id)
      &&digest(record.payload)===evidence.reviewRegistrationDigest
      &&record.payload.request?.payload?.reviewPackage?.packageDigest===evidence.reviewPackage.packageDigest);
    return Number.isSafeInteger(row?.payload.registeredAt)?row.payload.registeredAt:null;
  }catch{return null;}
}

// Durable order: when the approving review of this exact package was registered.
// Journals without a registered V3 review have no order and never qualify.
export function approvedReviewAt(state){
  const registration=state?.reviewInvocation?.registration;
  return registration&&registration.grant?.packageDigest===state.reviewPackage?.packageDigest
    &&Number.isSafeInteger(registration.registeredAt)?registration.registeredAt:null;
}

const statVersion=stat=>stat?[stat.dev,stat.ino,stat.size,stat.mtimeMs,stat.ctimeMs].join(':'):null;
// A cm-fix run completes through its closeout rows in the run log, not its
// journal, so its entry also follows the log's version.
function logVersion(specsRoot){try{return statVersion(fs.lstatSync(path.join(specsRoot,'运行日志.jsonl')));}catch{return null;}}
function cachedDelivery(specsRoot,repositoryId,runId,stat){
  const slot=[specsRoot,repositoryId,runId].join('\0'),version=statVersion(stat),hit=cache.get(slot);
  if(hit?.version===version&&(!hit.fix||hit.log===logVersion(specsRoot)))return hit.delivery;
  // Read the log version first: an append during the read is seen next time.
  const log=logVersion(specsRoot),read={fix:false},delivery=readDelivery(specsRoot,{repositoryId,runId},read);
  cache.set(slot,{version,fix:read.fix,log,delivery});
  return delivery;
}

// Resolve recorded steps to the real, completed, later reviewed packages of the
// named runs. allowAbsent is only for journal replay: a missing store cannot be
// re-proved there (returns null), and every live use refuses it.
export function resolveDeliverySteps({specsRoot,root,identity,after,steps,allowAbsent=false}){
  const resolved=[];
  for(const step of steps){
    need(RUN_ID.test(step.runId)&&step.runId!==identity.runId,'fix_association_unverified');
    let stat;
    try{stat=fs.lstatSync(path.join(specsRoot,'.reviews','.execution',step.runId,'state.json'));}
    catch(error){if(error.code==='ENOENT'){need(allowAbsent,'fix_association_unverified');return null;}throw error;}
    const delivery=cachedDelivery(specsRoot,identity.repositoryId,step.runId,stat);
    need(delivery&&delivery.root===root&&delivery.taskId!==identity.taskId,'fix_association_unverified');
    const found=delivery.packages.find(item=>item.pkg.packageDigest===step.packageDigest);
    need(found&&deliveredAfter(found,after)&&digest(deliveryStep(step.runId,found.pkg,step.beforeFix))===digest(step),'fix_association_unverified');
    resolved.push({...step,pkg:found.pkg});
  }
  return resolved;
}

// Deliveries for the same code root and repository, excluding the caller's own
// run and any other run of the same task: a superseding rerun of a task is not
// a later change that its superseded run may adopt.
export function completedReviewedDeliveries({specsRoot,root,identity}){
  const execution=path.join(specsRoot,'.reviews','.execution');
  let entries;
  try{entries=fs.readdirSync(execution,{withFileTypes:true});}catch{return [];}
  const deliveries=[];
  for(const entry of entries.sort((left,right)=>left.name<right.name?-1:left.name>right.name?1:0)){
    if(!entry.isDirectory()||!RUN_ID.test(entry.name)||entry.name===identity.runId)continue;
    let stat;
    try{stat=fs.lstatSync(path.join(execution,entry.name,'state.json'));}catch{continue;}
    // Replay once per journal version; a changed state.json is read again.
    const delivery=cachedDelivery(specsRoot,identity.repositoryId,entry.name,stat);
    if(delivery&&delivery.root===root&&delivery.taskId!==identity.taskId)deliveries.push(delivery);
  }
  return deliveries;
}
