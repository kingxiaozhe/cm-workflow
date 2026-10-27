// Whether a process group we spawned (detached, so its id is our direct child's pid)
// has really stopped: the writer-stopped proof behind every owned cleanup.
//
// Measured on macOS 26 (2026-10-27): a group whose only member is our own child that
// already exited but is not reaped yet (a zombie) answers kill(-pgid, 0|SIGTERM) with
// EPERM; once Node has reaped it (its 'exit' event) the same signal answers ESRCH, or
// is delivered when a live member is left. A grandchild zombie is reaped by launchd
// or init promptly. So EPERM is only resolved through our own child: wait (without
// blocking the event loop) until its exit is observed, then signal again within the
// same small budget. ESRCH is a stop, a delivered signal means a live member, and an
// EPERM that persists (a member we may not signal) stays unknown. No process table
// is read and no external program runs.
const unknown=()=>Object.assign(new Error('process_cleanup_unknown'),{code:'process_cleanup_unknown'});
const exited=child=>Number.isInteger(child?.exitCode)||typeof child?.signalCode==='string';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
// Our direct child's exit, observed (Node emits 'exit' after reaping it) before the
// deadline. A child object without exit tracking can never prove it.
function childExit(child,deadline){
  if(exited(child))return Promise.resolve(true);
  if(typeof child?.once!=='function')return Promise.resolve(false);
  return new Promise(resolve=>{
    const done=()=>{clearTimeout(timer);resolve(true);};
    const timer=setTimeout(()=>{child.off?.('exit',done);resolve(exited(child));},Math.max(0,deadline-Date.now()));
    child.once('exit',done);
  });
}

// Signal the group of our detached child: 'sent' (a live member received it) or
// 'gone' (the group no longer exists); throws process_cleanup_unknown otherwise.
// budgetMs bounds the EPERM resolution (child exit wait plus re-probes) in all.
export async function signalOwnedGroup(child,signal,{killProcess=process.kill.bind(process),budgetMs=1000,probeEveryMs=50}={}){
  const send=()=>{
    try{killProcess(-child.pid,signal);return 'sent';}
    catch(error){return error?.code==='ESRCH'?'gone':error?.code==='EPERM'?'denied':'error';}
  };
  const first=send();
  if(first==='sent'||first==='gone')return first;
  const deadline=Date.now()+budgetMs;
  if(first==='error'||!await childExit(child,deadline))throw unknown();
  for(;;){
    const again=send();
    if(again==='sent'||again==='gone')return again;
    if(again==='error'||Date.now()>=deadline)throw unknown();
    await pause(Math.min(probeEveryMs,Math.max(0,deadline-Date.now())));
  }
}
