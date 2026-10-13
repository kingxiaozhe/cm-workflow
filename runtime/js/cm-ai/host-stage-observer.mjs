// Process-local transport telemetry only. No durable state, authority or timers.
import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID} from 'node:crypto';

const operations=new AsyncLocalStorage();
const emit=context=>{
  if(context.closed)return;
  const stages=[...context.stages.values()],latest=stages.at(-1);
  const snapshot=latest?Object.freeze({...latest,deadlineMs:Math.min(...stages.map(stage=>stage.deadlineMs))}):null;
  try{context.observer(snapshot);}catch{/* diagnostic observers cannot change execution */}
};
export async function withHostStageObserver(observer,run){
  const context={observer,stages:new Map(),closed:false};
  return operations.run(context,async()=>{
    try{return await run();}
    finally{context.stages.clear();emit(context);context.closed=true;}
  });
}
export function beginHostStage(kind,timeoutMs){
  const context=operations.getStore();
  if(!context||context.closed||!Number.isSafeInteger(timeoutMs)||timeoutMs<1)return ()=>{};
  const now=Date.now(),id=randomUUID();
  context.stages.set(id,{id,kind,startedAt:new Date(now).toISOString(),deadlineMs:now+timeoutMs});emit(context);
  let ended=false;
  return ()=>{if(ended||context.closed)return;ended=true;context.stages.delete(id);emit(context);};
}
