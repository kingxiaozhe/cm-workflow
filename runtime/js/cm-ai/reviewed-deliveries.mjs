// Read-only discovery of other task runs' completed, reviewed deliveries in the
// same specs root. A delivery counts only after its own journal replays through
// the runner grammar to a committed fixture_completed state: its review package
// (and any accepted QA-fix packages) then describe reviewed before->after file
// transitions. This grants nothing, never repairs, and never opens a writer.
import fs from 'node:fs';
import path from 'node:path';
import {readExecutionSnapshot} from './execution-snapshot.mjs';
import {readRunnerHistory} from './durable-runner-state.mjs';

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
    return Object.freeze({runId:identity.runId,root:init.config.root,taskId:init.config.identity.taskId,
      packages:Object.freeze([state.reviewPackage,...history.acceptedFixes.map(item=>item.evidence.reviewPackage)])});
  }catch{return null;}
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
    const slot=[specsRoot,identity.repositoryId,entry.name].join('\0');
    const version=[stat.dev,stat.ino,stat.size,stat.mtimeMs,stat.ctimeMs].join(':');
    if(cache.get(slot)?.version!==version)
      cache.set(slot,{version,delivery:readDelivery(specsRoot,{repositoryId:identity.repositoryId,runId:entry.name})});
    const {delivery}=cache.get(slot);
    if(delivery&&delivery.root===root&&delivery.taskId!==identity.taskId)deliveries.push(delivery);
  }
  return deliveries;
}
