// Fixture-only metadata, following live-evidence-driver's bounded diagnostics.
// Never retain request IDs, paths, payloads, command lines or stderr contents.
const operations=new Set(['advance','start','status','fix_status','cancel','resume','host_close','host_result','eof']);
const kinds=new Set(['develop','check','review','complete','qa_assess','qa_browser','documentation_sync','documentation_inspect']);
const states=new Set(['idle','developing','pending_review','reviewing','fixture_completed','blocked','unknown','cancelled',
  'requirements_analysis','awaiting_user','status_only']);
const codes=new Set(['develop_answer_missing','host_busy','execution_error','host_launch_failed','invalid_arguments']);
const signals=new Set(['SIGTERM','SIGKILL','SIGINT','SIGABRT','SIGSEGV','SIGHUP','SIGPIPE']);
const allowed=(set,value)=>set.has(value)?value:value==null?null:'other';

export function hostDiagnostic(child,{timeoutMs=null,now=()=>performance.now()}={}){
  const started=now(),events=[];
  let stdoutBytes=0,stderrBytes=0,exitCode=null,signal=null,closed=false;
  let lastOperation=null,lastKind=null,lastState=null,lastCode=null,eventCount=0;
  const elapsed=()=>Math.max(0,Math.round(now()-started));
  const mark=(direction,row={})=>{
    const operation=allowed(operations,row.operation??row.type);
    const kind=allowed(kinds,row.kind),state=allowed(states,row.result?.state??row.result?.stage);
    const code=allowed(codes,row.result?.code??row.error?.code);
    if(direction==='send'&&operation)lastOperation=operation;
    if(kind)lastKind=kind;if(state)lastState=state;if(code)lastCode=code;
    events.push({n:++eventCount,elapsedMs:elapsed(),direction,operation,kind,state,code});
    if(events.length>32)events.shift();
  };
  child.stdout?.on('data',chunk=>{stdoutBytes+=Buffer.byteLength(chunk);});
  child.stderr?.on('data',chunk=>{stderrBytes+=Buffer.byteLength(chunk);});
  child.once('close',(code,value)=>{closed=true;exitCode=Number.isInteger(code)?code:null;signal=allowed(signals,value);});
  const snapshot=()=>({pid:Number.isInteger(child.pid)?child.pid:null,timeoutMs,elapsedMs:elapsed(),
    closed,exitCode,signal,stdoutBytes,stderrBytes,eventCount,lastOperation,lastKind,lastState,lastCode,
    events:events.map(event=>({...event}))});
  return {send:row=>mark('send',row),receive:row=>mark('receive',row),snapshot,
    attach:error=>Object.assign(error,{diagnostic:snapshot()})};
}
