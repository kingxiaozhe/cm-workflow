// Same serial steps for direct callers and the event-loop driven host.
import {setImmediate as yieldHost} from 'node:timers/promises';
export function runStepsSync(steps){
  let result;
  try{do{result=steps.next();}while(!result.done);return result.value;}
  finally{if(!result?.done)steps.return();}
}
export async function runStepsCooperatively(steps){
  let result;
  try{do{await yieldHost();result=steps.next();}while(!result.done);return result.value;}
  finally{if(!result?.done)steps.return();}
}
