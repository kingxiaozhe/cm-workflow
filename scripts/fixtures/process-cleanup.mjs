// Test-only process hygiene for synthetic CLI fixtures. Runtime code never
// imports this module.
//
// Timeout fixtures deliberately stay busy (setInterval) and are often spawned
// detached by the host under test, so killing the host or losing the test
// process used to orphan them for good. Two independent guards apply:
//  1. ownerGuardSource(): the fixture itself exits once the *test process*
//     that created it is gone, or after a hard ceiling. It watches the test
//     process rather than its direct parent, so an orphan caused by a
//     production cleanup regression stays observable while the test runs.
//  2. killFixtureProcesses(): the test kills the processes that provably belong
//     to its temp dir (see fixtureProcesses), plus the groups they lead.
import {spawnSync} from 'node:child_process';

export const FIXTURE_MAX_LIFETIME_MS=300000;
export const ownerTag=(ownerPid=process.pid)=>`cm-fixture-owner:${ownerPid}`;

// Valid as the first statement of CommonJS, `node -e` and ESM sources.
export function ownerGuardSource({ownerPid=process.pid,maxLifetimeMs=FIXTURE_MAX_LIFETIME_MS}={}){
  if(!Number.isSafeInteger(ownerPid)||ownerPid<1||!Number.isSafeInteger(maxLifetimeMs)||maxLifetimeMs<1)
    throw Error('invalid_owner_guard');
  return `;(()=>{/*${ownerTag(ownerPid)}*/const owner=${ownerPid},deadline=Date.now()+${maxLifetimeMs};`
    +`const stop=()=>{try{process.kill(process.pid,'SIGKILL');}catch{process.exit(137);}};`
    +`const timer=setInterval(()=>{let alive=true;try{process.kill(owner,0);}catch(error){alive=error?.code==='EPERM';}`
    +`if(!alive||Date.now()>=deadline)stop();},200);timer.unref?.();})();\n`;
}

// Insert the guard after an optional shebang line.
export function guardFixtureSource(source,options){
  const guard=ownerGuardSource(options);
  if(!source.startsWith('#!'))return guard+source;
  const newline=source.indexOf('\n');
  return newline===-1?`${source}\n${guard}`:source.slice(0,newline+1)+guard+source.slice(newline+1);
}

function listProcesses(){
  const listed=spawnSync('ps',['-axww','-o','pid=,ppid=,pgid=,command='],{encoding:'utf8',maxBuffer:64*1024*1024});
  if(listed.status!==0)throw Error(`ps failed: ${listed.stderr}`);
  const rows=[];
  for(const line of listed.stdout.split('\n')){
    const match=line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    if(!match)continue;
    const [pid,ppid,pgid]=match.slice(1,4).map(Number);rows.push({pid,ppid,pgid,command:match[4]});
  }
  return rows;
}
const interpreters=new Set([process.execPath,'node','/bin/sh','sh']);

// Only processes that provably belong to this test, never one that merely
// mentions the root (a user's grep/tail/lsof of a fixture path survives):
//  - a descendant of this test process whose command line carries the root
//    (hosts and drivers the test spawned), or
//  - a program run from inside the root: argv[0] under it, or node/sh running
//    a script under it (fake CLIs, which may be orphaned by a killed host).
// Fixture roots come from mkdtemp and contain no whitespace.
export function fixtureProcesses(root){
  if(typeof root!=='string'||!root.startsWith('/')||root.length<8||/\s/.test(root))throw Error('invalid_fixture_marker');
  if(process.platform==='win32')return [];
  const rows=listProcesses(),parents=new Map(rows.map(row=>[row.pid,row.ppid]));
  const descends=pid=>{
    for(let current=parents.get(pid),hops=0;current>1&&hops<4096;current=parents.get(current),hops++)
      if(current===process.pid)return true;
    return false;
  };
  const inside=value=>typeof value==='string'&&value.startsWith(root+'/');
  return rows.filter(row=>{
    if(row.pid===process.pid||!row.command.includes(root))return false;
    const [program,script]=row.command.split(/\s+/);
    return inside(program)||(interpreters.has(program)&&inside(script))||descends(row.pid);
  });
}

function ownProcessGroup(){
  const row=listProcesses().find(entry=>entry.pid===process.pid);
  return row?.pgid??process.pid;
}
const pause=ms=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms);

// Synchronous so it also fits finally blocks, t.after and watchdog callbacks.
export function killFixtureProcesses(root,{waitMs=5000}={}){
  const found=fixtureProcesses(root);
  const own=found.length?ownProcessGroup():null;
  for(const row of found){
    // Only a group whose leader is itself a fixture process (spawned detached by
    // the host under test) is taken whole; never this test's own group.
    if(row.pgid===row.pid&&row.pgid!==own)try{process.kill(-row.pgid,'SIGKILL');}catch{}
    try{process.kill(row.pid,'SIGKILL');}catch{}
  }
  const deadline=Date.now()+waitMs;
  let remaining=found.length?fixtureProcesses(root):[];
  while(remaining.length&&Date.now()<deadline){pause(50);remaining=fixtureProcesses(root);}
  if(remaining.length)throw Error(`fixture processes survived SIGKILL: ${remaining.map(row=>row.pid).join(',')}`);
  return found;
}

export function killProcessGroup(pid){
  if(!Number.isSafeInteger(pid)||pid<2)return;
  try{process.kill(-pid,'SIGKILL');}catch{}
}
