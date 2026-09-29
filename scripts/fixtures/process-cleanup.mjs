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
//  2. killFixtureProcesses(): the test kills every process whose command line
//     carries its temp dir (fake CLIs under <root>/bin, hosts started with
//     <root>/run.json, ...), plus the process groups those processes lead.
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

export function fixtureProcesses(marker){
  if(typeof marker!=='string'||marker.length<8)throw Error('invalid_fixture_marker');
  if(process.platform==='win32')return [];
  const listed=spawnSync('ps',['-axww','-o','pid=,ppid=,pgid=,command='],{encoding:'utf8',maxBuffer:64*1024*1024});
  if(listed.status!==0)throw Error(`ps failed: ${listed.stderr}`);
  const rows=[];
  for(const line of listed.stdout.split('\n')){
    const match=line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    if(!match)continue;
    const [pid,ppid,pgid]=match.slice(1,4).map(Number),command=match[4];
    if(pid!==process.pid&&command.includes(marker))rows.push({pid,ppid,pgid,command});
  }
  return rows;
}

const pause=ms=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms);

// Synchronous so it also fits finally blocks, t.after and watchdog callbacks.
export function killFixtureProcesses(marker,{waitMs=5000}={}){
  const found=fixtureProcesses(marker);
  for(const row of found){
    // A matching group leader was spawned detached: its group is the fixture's own.
    if(row.pgid===row.pid)try{process.kill(-row.pgid,'SIGKILL');}catch{}
    try{process.kill(row.pid,'SIGKILL');}catch{}
  }
  const deadline=Date.now()+waitMs;
  let remaining=found.length?fixtureProcesses(marker):[];
  while(remaining.length&&Date.now()<deadline){pause(50);remaining=fixtureProcesses(marker);}
  if(remaining.length)throw Error(`fixture processes survived SIGKILL: ${remaining.map(row=>row.pid).join(',')}`);
  return found;
}

export function killProcessGroup(pid){
  if(!Number.isSafeInteger(pid)||pid<2)return;
  try{process.kill(-pid,'SIGKILL');}catch{}
}
