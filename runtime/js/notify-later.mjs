// Detached waiter for notify.mjs notifyLater(). Sleeps the given delay, then
// sends the deferred notice only if its token is still the session's pending
// stop (notify() checks that under the state lock): progress, a new step, a
// newer stop or an immediate notice in the meantime cancels it. The workflow
// that started this process never waits for it; a killed waiter sends nothing.
import {sendPendingNotice,NOTIFY_LATER_MAX_MS} from './notify.mjs';

let job=null;
try{job=JSON.parse(process.env.CM_NOTIFY_LATER??'null');}catch{}
const env={...process.env};delete env.CM_NOTIFY_LATER;
if(!job||typeof job.token!=='string'||!job.fields||typeof job.fields!=='object'
  ||!Number.isSafeInteger(job.delayMs)||job.delayMs<1||job.delayMs>NOTIFY_LATER_MAX_MS)process.exit(0);
setTimeout(()=>{sendPendingNotice(job.fields,job.token,{env}).catch(()=>{}).finally(()=>process.exit(0));},job.delayMs);
