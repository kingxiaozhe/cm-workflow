// Read-only discovery of other task runs' completed, reviewed deliveries in the
// same specs root. A delivery counts only after its own journal replays through
// the runner grammar to a committed fixture_completed state: its review package
// (and any accepted QA-fix packages) then describe reviewed before->after file
// transitions. This grants nothing, never repairs, and never opens a writer.
import fs from 'node:fs';
import path from 'node:path';
import {readExecutionSnapshot} from './execution-snapshot.mjs';
import {readRunnerHistory} from './durable-runner-state.mjs';
import {deliveredAfter,deliveryStep} from './fix-code-association.mjs';
import {digest,need} from './effect-contract.mjs';

const RUN_ID=/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const cache=new Map();

function readDelivery(specsRoot,identity){
  try{
    const snapshot=readExecutionSnapshot({specsRoot,identity});
    const init=snapshot.records[0]?.payload;
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
function fixReviewedAt(specsRoot,evidence){
  try{
    const {repositoryId,runId}=evidence.identity;
    const row=readExecutionSnapshot({specsRoot,identity:{repositoryId,runId}}).records.find(record=>
      /^fix-(?:revision-)?final(?:-recovery(?:-[1-9]\d*)?|-retry)?-registered$/.test(record.id)
      &&digest(record.payload)===evidence.reviewRegistrationDigest);
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

function cachedDelivery(specsRoot,repositoryId,runId,stat){
  const slot=[specsRoot,repositoryId,runId].join('\0');
  const version=[stat.dev,stat.ino,stat.size,stat.mtimeMs,stat.ctimeMs].join(':');
  if(cache.get(slot)?.version!==version)cache.set(slot,{version,delivery:readDelivery(specsRoot,{repositoryId,runId})});
  return cache.get(slot).delivery;
}

// Recorded interleaving steps must each be exactly derivable from a real,
// completed, later reviewed package of the named run. allowAbsent is only for
// journal replay: a missing store cannot be re-proved there, and every live use
// (status, acceptance) calls this without it and fails closed.
export function verifyDeliverySteps({specsRoot,root,identity,after,steps,allowAbsent=false}){
  for(const step of steps){
    need(RUN_ID.test(step.runId)&&step.runId!==identity.runId,'fix_association_unverified');
    let stat;
    try{stat=fs.lstatSync(path.join(specsRoot,'.reviews','.execution',step.runId,'state.json'));}
    catch(error){if(error.code==='ENOENT'){need(allowAbsent,'fix_association_unverified');continue;}throw error;}
    const delivery=cachedDelivery(specsRoot,identity.repositoryId,step.runId,stat);
    need(delivery&&delivery.root===root&&delivery.taskId!==identity.taskId,'fix_association_unverified');
    const found=delivery.packages.find(item=>item.pkg.packageDigest===step.packageDigest);
    need(found&&deliveredAfter(found,after)
      &&digest(deliveryStep(step.runId,found.pkg,step.beforeFix))===digest(step),'fix_association_unverified');
  }
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
