// POSIX children must be spawned detached. Own only that child's process group.
// A leader closing its pipes does not cancel escalation for its descendants.
export function ownedProcessCleanup(child,{graceMs=250,killWaitMs=750,killProcess=process.kill.bind(process)}={}) {
  let cleanup;
  const error=()=>Object.assign(new Error('process_cleanup_unknown'),{code:'process_cleanup_unknown'});
  const signal=value=>{
    try{killProcess(-child.pid,value);return true;}
    catch(e){if(e.code==='ESRCH')return false;throw error();}
  };
  const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  return ()=>cleanup??=(async()=>{
    // Preserve the legacy Windows leader termination, without claiming tree cleanup.
    if(process.platform==='win32'){child.kill('SIGTERM');throw error();}
    // A failed spawn has no PID; in-memory test transports also have none.
    if(!Number.isInteger(child.pid)||child.pid<=0){child.kill('SIGTERM');return;}
    if(!signal('SIGTERM'))return;
    await pause(graceMs);
    if(!signal('SIGKILL'))return;
    const until=Date.now()+killWaitMs;
    // SIGKILL delivery is asynchronous. Give the group one polling turn to
    // exit before probing; this wait consumes the existing deadline. An actual
    // permission error still fails immediately, without another probe.
    do {
      await pause(Math.min(25,Math.max(0,until-Date.now())));
      if(!signal(0))return;
    } while(Date.now()<until);
    throw error();
  })();
}
