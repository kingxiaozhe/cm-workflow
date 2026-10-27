// POSIX children must be spawned detached. Own only that child's process group.
// A leader closing its pipes does not cancel escalation for its descendants.
// Every group signal goes through signalOwnedGroup (process-group-exit.mjs), which
// tells an exited, not yet reaped child (EPERM on macOS) from a live member.
import {signalOwnedGroup} from './process-group-exit.mjs';
export function ownedProcessCleanup(child,{graceMs=250,killWaitMs=750,killProcess=process.kill.bind(process),
  exitBudgetMs=1000}={}) {
  let cleanup;
  const error=()=>Object.assign(new Error('process_cleanup_unknown'),{code:'process_cleanup_unknown'});
  // true: a member received it; false: the group is gone. An EPERM resolution never
  // gets more than what is left of one overall deadline (review 2026-10-27): every
  // signal used to get the full exitBudgetMs again, so the last probe could run past
  // the cleanup's own limit.
  let overall=null;
  const left=()=>Math.max(0,overall-Date.now());
  const signal=async(value,cap=exitBudgetMs)=>(await signalOwnedGroup(child,value,
    {killProcess,budgetMs:Math.min(exitBudgetMs,cap,left())}))==='sent';
  const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  return ()=>cleanup??=(async()=>{
    // Preserve the legacy Windows leader termination, without claiming tree cleanup.
    if(process.platform==='win32'){child.kill('SIGTERM');throw error();}
    // A failed spawn has no PID; in-memory test transports also have none.
    if(!Number.isInteger(child.pid)||child.pid<=0){child.kill('SIGTERM');return;}
    overall=Date.now()+exitBudgetMs+graceMs+killWaitMs;
    if(!await signal('SIGTERM'))return;
    await pause(graceMs);
    if(!await signal('SIGKILL'))return;
    // Review 2026-10-27 round 3: an EPERM resolution before SIGKILL must not buy the
    // poll a fresh killWaitMs, so the poll also ends at the overall deadline.
    const until=Math.min(Date.now()+killWaitMs,overall);
    // SIGKILL delivery is asynchronous. Give the group one polling turn to
    // exit before probing; this wait consumes the existing deadline. An actual
    // permission error still fails immediately, without another probe.
    do {
      await pause(Math.min(25,Math.max(0,until-Date.now())));
      if(!await signal(0,Math.max(0,until-Date.now())))return;
    } while(Date.now()<until);
    throw error();
  })();
}
