// Startup runtime selection for CM role failover. This module chooses which
// runtime a role starts on; it never changes an in-flight task, never edits
// task state, and never marks a probe-resolvable CLI as quota-available.
export class RuntimeFailoverError extends Error {
  constructor(message,code){super(message);this.name='RuntimeFailoverError';this.code=code;}
}

const RUNTIMES=['codex','claude'];

// Role-based primary/standby. Development runs on the large-quota runtime;
// review keeps the other one primary so N4 stays cross-model against the
// implementation. Both roles fall back to the opposite runtime.
export const ROLE_ROUTING=Object.freeze({
  developer:Object.freeze({primary:'codex',standby:'claude'}),
  reviewer:Object.freeze({primary:'claude',standby:'codex'}),
});

export function isRuntime(value){return RUNTIMES.includes(value);}

function requireRole(role){
  if(!Object.hasOwn(ROLE_ROUTING,role))
    throw new RuntimeFailoverError(`unknown failover role: ${role}`,'unknown_role');
  return ROLE_ROUTING[role];
}

// `probe(runtime)` must report reachability only. A true result means the CLI
// resolves, never that its quota or authentication will accept the next call.
function checkProbe(probe){
  if(typeof probe!=='function')
    throw new RuntimeFailoverError('probe must be a function','invalid_probe');
  return (runtime)=>{
    const result=probe(runtime);
    if(typeof result!=='boolean')
      throw new RuntimeFailoverError(`probe must return a boolean for ${runtime}`,'invalid_probe');
    return result;
  };
}

// Ordered candidates: an explicit request wins the first slot, otherwise the
// role's primary leads. The opposite runtime always trails as the standby.
export function candidateOrder(role,requested=null){
  const {primary,standby}=requireRole(role);
  if(requested===null)return [primary,standby];
  if(!isRuntime(requested))
    throw new RuntimeFailoverError(`unsupported runtime: ${requested}`,'invalid_runtime');
  return [requested,requested===primary?standby:primary];
}

// Resolve one role to a runtime. Returns the decision plus every rejected
// candidate and why, so the caller can print the switch instead of hiding it.
export function selectRuntime({role,requested=null,allowed=RUNTIMES,probe}){
  requireRole(role);
  const test=checkProbe(probe);
  if(!Array.isArray(allowed)||allowed.length===0||!allowed.every(isRuntime))
    throw new RuntimeFailoverError('allowed must be a non-empty list of known runtimes','invalid_allowed');
  const order=candidateOrder(role,requested),rejected=[];
  for(const candidate of order){
    if(!allowed.includes(candidate)){rejected.push({runtime:candidate,reason:'not_allowed'});continue;}
    if(!test(candidate)){rejected.push({runtime:candidate,reason:'unreachable'});continue;}
    const from=requested??order[0];
    return Object.freeze({role,runtime:candidate,switched:candidate!==from,
      from,rejected:Object.freeze(rejected),
      reason:candidate===from?null:`${from} ${rejected.find(r=>r.runtime===from)?.reason??'unavailable'}`});
  }
  throw new RuntimeFailoverError(
    `no runtime available for ${role}: ${rejected.map(r=>`${r.runtime}=${r.reason}`).join(', ')}`,
    'no_runtime_available');
}

// One human-readable line per switch. Callers must surface this; a silent
// switch would hide that the work moved to a different model.
export function describeSelection(selection){
  if(!selection.switched)return `${selection.role}: ${selection.runtime}（未切换）`;
  return `${selection.role}: ${selection.from} → ${selection.runtime}（原因: ${selection.reason}）`;
}
