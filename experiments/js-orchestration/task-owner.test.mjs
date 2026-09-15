import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn,spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { openTaskExecutionStore } from './task-owner.mjs';
import * as taskOwner from './task-owner.mjs';
import { digest } from './effect-contract.mjs';

const fingerprints={workflow:digest('workflow'),config:digest('config'),inputs:digest('inputs')};
const repository=path.resolve(import.meta.dirname,'../..');
function legacyArgs(root,tasksPath,feature='login') {
  const reviews=path.join(root,'.reviews');
  const source=`import runpy,sys\nfrom pathlib import Path\nm=runpy.run_path(sys.argv[1])\nr=Path(sys.argv[2]);r.mkdir(exist_ok=True)\nh=r/(sys.argv[3]+"-T-001-a1-handoff.json")\nm["write_handoff"](h)\nm["write_review"](r/(sys.argv[3]+"-T-001-r1.md"),handoff=h)`;
  const r=spawnSync('python3',['-c',source,path.join(repository,'scripts/test-task-gate.py'),reviews,feature],{encoding:'utf8'});
  assert.equal(r.status,0,r.stderr);
  return ['--handoff',path.join(reviews,feature+'-T-001-a1-handoff.json'),'--reviews-dir',reviews,
    '--feature',feature,'--task','T-001','--tasks',tasksPath];
}
const pythonGate=(command,args)=>spawnSync('python3',[path.join(repository,'scripts/cm-task-gate.py'),command,...args],{encoding:'utf8',timeout:10000});

for(const layout of ['1.login','login','.'])test(`C2a owner target is immutable canonical identity: ${layout}`,()=>fixture(({options,tasksPath,root})=>{
  const saved={tasksPath,feature:'login',specsRoot:root},store=openTaskExecutionStore(options);
  try {
    options.tasksPath='/unrelated';options.feature='different';options.specsRoot='/different';
    const before=fs.readFileSync(tasksPath),records=store.snapshot();
    const target=taskOwner.taskOwnerTarget(store);
    assert.deepEqual(target,saved);assert(Object.isFrozen(target));
    assert.throws(()=>{target.feature='other';},TypeError);
    assert.deepEqual(store.snapshot(),records);assert.deepEqual(fs.readFileSync(tasksPath),before);
  }finally{store.close();}
  assert.throws(()=>taskOwner.taskOwnerTarget(store),{code:'store_closed'});
},layout));

test('C2a rejects forged and revoked proxy handles without caller operations',()=>fixture(({options})=>{
  const store=openTaskExecutionStore(options);let touched=0;
  const trap=()=>{touched++;throw Error('caller executed');};
  const revoked=Proxy.revocable({},{});revoked.revoke();
  try {
    for(const bad of [null,undefined,1,'owner',{},Object.assign({},store),{snapshot:trap},
      Object.defineProperty({},'snapshot',{get:trap}),new Proxy(store,{get:trap,getPrototypeOf:trap,ownKeys:trap}),revoked.proxy])
      assert.throws(()=>taskOwner.taskOwnerTarget(bad),{code:'task_owner_required'});
    assert.equal(touched,0);
  }finally{store.close();}
}));

test('C2a matching run IDs do not conflate different task owners',()=>fixture(({options})=>fixture(({options:other})=>{
  const a=openTaskExecutionStore(options),b=openTaskExecutionStore(other);
  try {
    assert.deepEqual(a.snapshot().identity,b.snapshot().identity);
    assert.notDeepEqual(taskOwner.taskOwnerTarget(a),taskOwner.taskOwnerTarget(b));
  }finally{a.close();b.close();}
})));

test('C2a raw execution stores cannot claim task ownership',async()=>fixture(async({options})=>{
  const {openExecutionStore}=await import('./execution-store.mjs');
  const {tasksPath,feature,...raw}=options,store=openExecutionStore(raw);
  try{assert.throws(()=>taskOwner.taskOwnerTarget(store),{code:'task_owner_required'});}finally{store.close();}
}));

for(const mutation of ['binding','certificate','state','binding-poison','state-poison'])
test(`C2a refuses invalid or poisoned ownership: ${mutation}`,()=>fixture(({options,binding,root})=>{
  const store=openTaskExecutionStore(options),execution=path.join(root,'.reviews/.execution');
  assert.equal(taskOwner.taskOwnerTarget(store).tasksPath,options.tasksPath);
  const p=mutation.startsWith('binding')?binding:mutation==='certificate'?path.join(execution,'writer-ready.json'):path.join(execution,'run/state.json');
  const bytes=fs.readFileSync(p);
  try {
    if(mutation.endsWith('poison')) {
      fs.writeFileSync(p,'invalid');assert.throws(()=>store.snapshot());fs.writeFileSync(p,bytes);
      assert.throws(()=>taskOwner.taskOwnerTarget(store),{code:'store_poisoned'});
    }else {
      fs.renameSync(p,p+'.retained');fs.writeFileSync(p,bytes,{mode:0o600});
      if(mutation==='state')fs.writeFileSync(p,'invalid');
      assert.throws(()=>taskOwner.taskOwnerTarget(store));
    }
  }finally{store.close();}
}));

test('C2a canonical-module brand cannot be borrowed by duplicate module instance',async()=>fixture(async({options})=>{
  const canonical=new URL('../../runtime/js/cm-ai/task-owner.mjs',import.meta.url);
  const duplicate=await import(`${canonical.href}?owner-brand-fixture`),store=openTaskExecutionStore(options);
  try{assert.throws(()=>duplicate.taskOwnerTarget(store),{code:'task_owner_required'});}finally{store.close();}
}));
function fixture(fn,featureDir='1.login') {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-owner-'))),dir=path.join(root,featureDir);
  if(dir!==root)fs.mkdirSync(dir);const tasksPath=path.join(dir,'tasks.md');fs.writeFileSync(tasksPath,'- [ ] T-001: fixture\n');
  const options={tasksPath,feature:'login',specsRoot:root,identity:{repositoryId:'fixture',runId:'run'},fingerprints,create:true};
  const binding=path.join(dir,'.reviews','.cm-task-owner.json');
  const cleanup=()=>fs.rmSync(root,{recursive:true,force:true});
  try{const result=fn({root,dir,tasksPath,options,binding});
    if(result?.then)return result.finally(cleanup);cleanup();return result;
  }catch(error){cleanup();throw error;}
}

for(const invalid of ['missing','duplicate','utf8'])test(`S3b1 invalid target ${invalid} cannot bind an owner`,()=>fixture(({root,tasksPath,binding})=>{
  const args=legacyArgs(root,tasksPath);
  const bytes=invalid==='missing'?Buffer.from('- [ ] T-002: other\n'):
    invalid==='duplicate'?Buffer.from('- [ ] T-001: first\n- [ ] T-001: second\n'):Buffer.from([255]);
  fs.writeFileSync(tasksPath,bytes);
  assert.equal(pythonGate('mark-done',args).status,1);
  assert.deepEqual(fs.readFileSync(tasksPath),bytes);
  assert(!fs.existsSync(binding),'invalid target claimed permanent owner');
  assert(!fs.existsSync(path.join(root,'.reviews/.execution')));
}));

for(const engine of ['python','js'])for(const kind of ['private','public','hardlink','symlink','empty','retained-run','case-alias'])
test(`S3b1 ${engine} preserves preexisting journal ${kind}`,()=>fixture(({root,tasksPath,options})=>{
  const args=legacyArgs(root,tasksPath);assert.equal(pythonGate('mark-done',args).status,0);
  fs.writeFileSync(tasksPath,'- [ ] T-001: fixture\n');
  const execution=path.join(root,'.reviews/.execution'),journal=path.join(execution,kind==='case-alias'?'WRITER.SQLITE-JOURNAL':'writer.sqlite-journal');
  const bytes=Buffer.from(kind==='empty'?'':'RETAIN CORRUPT EVIDENCE\n'.repeat(32));
  fs.writeFileSync(journal,bytes,{mode:kind==='public'?0o644:0o600});
  if(kind==='case-alias')assert(fs.existsSync(path.join(execution,'writer.sqlite-journal')),'requires case-insensitive test filesystem');
  if(kind==='hardlink')fs.linkSync(journal,path.join(root,'retained-journal'));
  if(kind==='symlink'){fs.renameSync(journal,path.join(root,'retained-journal'));fs.symlinkSync(path.join(root,'retained-journal'),journal);}
  if(kind==='retained-run')fs.mkdirSync(path.join(execution,'retained'),{mode:0o700});
  const stat=fs.lstatSync(journal),task=fs.readFileSync(tasksPath),lock=fs.readFileSync(path.join(execution,'writer.sqlite'));
  if(engine==='python')assert.equal(pythonGate('mark-done',args).status,1,'legacy consumed journal');
  else assert.throws(()=>openTaskExecutionStore(options),undefined,'JS consumed journal');
  assert.deepEqual(fs.readFileSync(journal),bytes);assert.equal(fs.lstatSync(journal).ino,stat.ino);
  assert.equal(fs.lstatSync(journal).mode,stat.mode);assert.equal(fs.lstatSync(journal).nlink,stat.nlink);
  assert.deepEqual(fs.readFileSync(tasksPath),task);assert.deepEqual(fs.readFileSync(path.join(execution,'writer.sqlite')),lock);
  assert(!fs.existsSync(path.join(execution,'run')));
}));

test('S3b1 new task store creates one canonical owner and no checkbox writes',()=>fixture(({options,binding,tasksPath})=>{
  const before=fs.readFileSync(tasksPath),store=openTaskExecutionStore(options);
  try{assert.deepEqual(store.snapshot().records,[]);}finally{store.close();}
  assert.deepEqual(fs.readFileSync(tasksPath),before);
  assert.equal(fs.statSync(binding).mode&0o777,0o600);
  assert.equal(fs.readFileSync(binding,'utf8'),JSON.stringify({version:1,tasksPath,specsRoot:options.specsRoot})+'\n');
  const reopened=openTaskExecutionStore({...options,create:false});reopened.close();
}));

test('S3b1 inner and outer review roots cannot own the same tasks path',()=>fixture(({options,binding,dir,tasksPath})=>{
  const outer=openTaskExecutionStore(options);outer.close();const before=fs.readFileSync(binding);
  assert.throws(()=>openTaskExecutionStore({...options,specsRoot:dir}),{code:'task_owner_mismatch'});
  assert.deepEqual(fs.readFileSync(binding),before);assert.equal(fs.readFileSync(tasksPath,'utf8'),'- [ ] T-001: fixture\n');
  assert(!fs.existsSync(path.join(dir,'.reviews','.execution')));
}));

test('S3b1 all host options validate before binding any task',()=>fixture(({options,binding,dir})=>{
  for(const bad of [{...options,extra:true},{...options,feature:'../login'},
    {...options,fingerprints:{...fingerprints,inputs:'bad'}},{...options,create:'true'},
    {...options,specsRoot:dir,feature:'unrelated',identity:{...options.identity,runId:'../bad'}}]) {
    assert.throws(()=>openTaskExecutionStore(bad));assert(!fs.existsSync(binding));
  }
}));

test('S3b1 Python mark-done refuses the live JS owner while readonly N5 still works',()=>fixture(({options,root,tasksPath})=>{
  const args=legacyArgs(root,tasksPath),before=fs.readFileSync(tasksPath),store=openTaskExecutionStore(options);
  try {
    const n5=pythonGate('check-n5',args.slice(0,-2));assert.equal(n5.status,0,n5.stderr);
    const marked=pythonGate('mark-done',args);assert.equal(marked.status,1,marked.stdout+marked.stderr);
    assert.deepEqual(fs.readFileSync(tasksPath),before);
  }finally{store.close();}
}));

test('S3b1 a closed JS run still blocks legacy and already-done shortcuts',()=>fixture(({options,root,tasksPath})=>{
  const args=legacyArgs(root,tasksPath),store=openTaskExecutionStore(options);store.close();
  for(const text of ['- [ ] T-001: fixture\n','- [x] T-001: fixture\n']) {
    fs.writeFileSync(tasksPath,text);const result=pythonGate('mark-done',args);
    assert.equal(result.status,1,result.stdout+result.stderr);assert.equal(fs.readFileSync(tasksPath,'utf8'),text);
  }
}));

test('S3b1 Python-created canonical binding is reused by JS',()=>fixture(({options,root,tasksPath,binding})=>{
  const args=legacyArgs(root,tasksPath),result=pythonGate('mark-done',args);assert.equal(result.status,0,result.stderr);
  assert.equal(fs.readFileSync(binding,'utf8'),JSON.stringify({version:1,tasksPath,specsRoot:root})+'\n');
  const before=fs.readFileSync(binding),store=openTaskExecutionStore(options);store.close();
  assert.deepEqual(fs.readFileSync(binding),before);
}));

for(const engine of ['python','js'])test(`S3b2 ${engine} refuses uncertified complete database`,()=>fixture(({options,root,tasksPath})=>{
  const args=legacyArgs(root,tasksPath),execution=path.join(root,'.reviews/.execution');
  fs.mkdirSync(execution,{mode:0o700});const lock=path.join(execution,'writer.sqlite');fs.writeFileSync(lock,'',{mode:0o600});
  const db=new DatabaseSync(lock);db.exec('PRAGMA application_id=1129142321; PRAGMA user_version=1; CREATE TABLE protocol(version INTEGER NOT NULL CHECK(version=1)); INSERT INTO protocol VALUES(1)');db.close();
  const before=fs.readFileSync(lock),task=fs.readFileSync(tasksPath);
  if(engine==='python')assert.equal(pythonGate('mark-done',args).status,1);
  else assert.throws(()=>{const store=openTaskExecutionStore(options);store.close();});
  assert.deepEqual(fs.readFileSync(lock),before);assert.deepEqual(fs.readFileSync(tasksPath),task);
  assert.deepEqual(fs.readdirSync(execution),['writer.sqlite']);
}));

for(const source of ['python','js'])for(const mutation of ['empty','version','duplicate','utf8','public','hardlink','symlink','digest','reordered'])
test(`S3b2 certificate ${source}/${mutation} refuses both consumers without repair`,()=>fixture(({options,root,tasksPath})=>{
  const args=legacyArgs(root,tasksPath),execution=path.join(root,'.reviews/.execution');
  if(source==='python')assert.equal(pythonGate('mark-done',args).status,0);
  else {const store=openTaskExecutionStore(options);store.close();}
  const marker=path.join(execution,'writer-ready.json'),initial=fs.readFileSync(marker),value=JSON.parse(initial);
  if(mutation==='empty')fs.writeFileSync(marker,'');
  if(mutation==='version')fs.writeFileSync(marker,JSON.stringify({...value,version:true})+'\n');
  if(mutation==='duplicate')fs.writeFileSync(marker,'{"version":1,'+initial.toString().slice(1));
  if(mutation==='utf8')fs.writeFileSync(marker,Buffer.from([255]));
  if(mutation==='public')fs.chmodSync(marker,0o644);
  if(mutation==='hardlink')fs.linkSync(marker,path.join(root,'retained-marker'));
  if(mutation==='symlink'){fs.renameSync(marker,path.join(root,'retained-marker'));fs.symlinkSync(path.join(root,'retained-marker'),marker);}
  if(mutation==='digest')fs.writeFileSync(marker,JSON.stringify({...value,databaseDigest:'0'.repeat(64)})+'\n');
  if(mutation==='reordered')fs.writeFileSync(marker,JSON.stringify({protocol:value.protocol,version:1,databaseDigest:value.databaseDigest})+'\n');
  const bytes=fs.readFileSync(marker),stat=fs.lstatSync(marker),task=fs.readFileSync(tasksPath),db=fs.readFileSync(path.join(execution,'writer.sqlite'));
  assert.equal(pythonGate('mark-done',args).status,1);
  assert.throws(()=>{const store=openTaskExecutionStore({...options,identity:{...options.identity,runId:'new-run'}});store.close();});
  assert.deepEqual(fs.readFileSync(marker),bytes);assert.equal(fs.lstatSync(marker).ino,stat.ino);
  assert.deepEqual(fs.readFileSync(tasksPath),task);assert.deepEqual(fs.readFileSync(path.join(execution,'writer.sqlite')),db);
  assert(!fs.existsSync(path.join(execution,'new-run')));
}));

function noNativeOpen(options,args,expectedCalls=0) {
  const node=`import {registerHooks} from 'node:module';globalThis.nativeCalls=0;
    const stub='data:text/javascript,'+encodeURIComponent('export class DatabaseSync {constructor(){globalThis.nativeCalls++;throw Error("NATIVE_OPEN");}}');
    registerHooks({resolve(specifier,context,next){return specifier==='node:sqlite'?{url:stub,shortCircuit:true}:next(specifier,context);}});
    const {openExecutionStore}=await import(${JSON.stringify(new URL('./execution-store.mjs',import.meta.url).href)});
    try{openExecutionStore(JSON.parse(process.argv[1]));console.log('opened');}catch{}console.log(globalThis.nativeCalls);`;
  const {tasksPath,feature,...storeOptions}=options;
  const js=spawnSync(process.execPath,['--input-type=module','-e',node,JSON.stringify(storeOptions)],{encoding:'utf8',timeout:10000});
  assert.equal(js.status,0,js.stderr);assert.equal(js.stdout.trim(),String(expectedCalls),'raw JS native call count');
  const python=`import sqlite3,runpy,sys,json\nm=runpy.run_path(sys.argv[1]);calls=[]\ndef reject(*a,**kw):\n calls.append(1)\n raise RuntimeError('NATIVE_OPEN')\nsqlite3.connect=reject\ntry:\n m['mark_done'](m['build_parser']().parse_args(['mark-done']+json.loads(sys.argv[2])))\nexcept Exception: pass\nprint(len(calls))`;
  const py=spawnSync('python3',['-c',python,path.join(repository,'scripts/cm-task-gate.py'),JSON.stringify(args)],{encoding:'utf8',timeout:10000});
  assert.equal(py.status,0,py.stderr);assert.equal(py.stdout.trim(),String(expectedCalls),'Python native call count');
}

test('S3b2 native-open instrumentation has positive controls for certified databases',()=>fixture(({root,tasksPath,options})=>{
  const args=legacyArgs(root,tasksPath);assert.equal(pythonGate('mark-done',args).status,0);
  noNativeOpen(options,args,1);
}));

for(const point of ['create','write','file-sync','dir-sync'])for(const source of ['js','python'])
test(`S3b2 ${source} certificate ${point} failure returns no ownership or task mutation`,()=>fixture(({root,tasksPath,options})=>{
  const args=legacyArgs(root,tasksPath),task=fs.readFileSync(tasksPath),marker=path.join(root,'.reviews/.execution/writer-ready.json');
  if(source==='js') {
    const open=fs.openSync,write=fs.writeFileSync,sync=fs.fsyncSync;let markerFd,created=false,failed=false;
    const fail=()=>{failed=true;throw Object.assign(Error('certificate fixture failure'),{code:'EIO'});};
    try {
      fs.openSync=function(p,flags,...rest){if(String(p)===marker && (flags&fs.constants.O_CREAT)){
        if(point==='create')fail();markerFd=open(p,flags,...rest);created=true;return markerFd;}return open(p,flags,...rest);};
      fs.writeFileSync=function(fd,...rest){if(fd===markerFd && point==='write')fail();return write(fd,...rest);};
      fs.fsyncSync=function(fd){if(created && (point==='file-sync' && fd===markerFd || point==='dir-sync' && fs.fstatSync(fd).isDirectory()))fail();return sync(fd);};
      assert.throws(()=>{const store=openTaskExecutionStore(options);store.close();},{code:'EIO'});assert(failed);
    }finally{fs.openSync=open;fs.writeFileSync=write;fs.fsyncSync=sync;}
  } else {
    const code=`import os,stat,runpy,sys,json,pathlib\npoint=sys.argv[3];marker=sys.argv[4];marker_fd=None;created=False;failed=False\ndef fail():\n global failed\n failed=True\n raise OSError('certificate fixture failure')\noriginal_open=os.open\ndef open_file(p,flags,*a,**kw):\n global marker_fd,created\n if str(p)==marker and flags & os.O_CREAT:\n  if point=='create': fail()\n  marker_fd=original_open(p,flags,*a,**kw);created=True;return marker_fd\n return original_open(p,flags,*a,**kw)\nos.open=open_file\noriginal_sync=os.fsync\ndef sync(fd):\n if created and ((point=='file-sync' and fd==marker_fd) or (point=='dir-sync' and stat.S_ISDIR(os.fstat(fd).st_mode))): fail()\n return original_sync(fd)\nos.fsync=sync\noriginal_fdopen=os.fdopen\nclass BadWrite:\n def __init__(self,h): self.h=h\n def __enter__(self): return self\n def __exit__(self,*a): self.h.close()\n def write(self,data): fail()\ndef fdopen(fd,*a,**kw):\n h=original_fdopen(fd,*a,**kw)\n return BadWrite(h) if point=='write' and fd==marker_fd else h\nos.fdopen=fdopen\nm=runpy.run_path(sys.argv[1])\ntry:\n m['mark_done'](m['build_parser']().parse_args(['mark-done']+json.loads(sys.argv[2])))\n print('unexpected success')\nexcept m['GateError']: print('refused' if failed else 'wrong failure')`;
    const r=spawnSync('python3',['-c',code,path.join(repository,'scripts/cm-task-gate.py'),JSON.stringify(args),point,marker],{encoding:'utf8',timeout:10000});
    assert.equal(r.status,0,r.stderr);assert.equal(r.stdout.trim(),'refused');
  }
  assert.deepEqual(fs.readFileSync(tasksPath),task);assert(!fs.existsSync(path.join(root,'.reviews/.execution/run')));
}));

for(const source of ['python','js'])for(const point of ['before-commit','before-certificate'])
test(`S3b2 ${source} initializer ${point}: contenders never open native DB before/after kill`,()=>fixture(async({root,tasksPath,options})=>{
  const args=legacyArgs(root,tasksPath),execution=path.join(root,'.reviews/.execution');
  let child;
  if(source==='python') {
    const code=`import sqlite3,os,runpy,sys,json,pathlib\npoint=sys.argv[3]\ndef pause():\n print('held',flush=True)\n sys.stdin.readline()\nclass Connection(sqlite3.Connection):\n def executescript(self,sql):\n  if point=='before-commit' and 'COMMIT' in sql:\n   super().executescript(sql.split('COMMIT')[0]);pause();return super().execute('COMMIT')\n  return super().executescript(sql)\noriginal_connect=sqlite3.connect\ndef connect(*a,**kw):\n return original_connect(*a,factory=Connection,**kw)\nsqlite3.connect=connect\noriginal_open=os.open\ndef open_file(p,flags,*a,**kw):\n if point=='before-certificate' and str(p).endswith('writer-ready.json') and flags & os.O_CREAT: pause()\n return original_open(p,flags,*a,**kw)\nos.open=open_file\nm=runpy.run_path(sys.argv[1]);m['mark_done'](m['build_parser']().parse_args(['mark-done']+json.loads(sys.argv[2])))`;
    child=interactive('python3',['-c',code,path.join(repository,'scripts/cm-task-gate.py'),JSON.stringify(args),point]);
  } else {
    const code=`import fs from 'node:fs';import {DatabaseSync} from 'node:sqlite';
      import {openTaskExecutionStore} from ${JSON.stringify(new URL('./task-owner.mjs',import.meta.url).href)};
      const point=process.argv[2],pause=()=>{console.log('held');fs.readSync(0,Buffer.alloc(1),0,1,null);};
      const exec=DatabaseSync.prototype.exec;DatabaseSync.prototype.exec=function(sql){
        if(point==='before-commit' && sql.includes('COMMIT')){exec.call(this,sql.split('COMMIT')[0]);pause();return exec.call(this,'COMMIT');}
        return exec.call(this,sql);};
      const open=fs.openSync;fs.openSync=function(p,flags,...rest){if(point==='before-certificate' && String(p).endsWith('writer-ready.json') && (flags&fs.constants.O_CREAT))pause();return open(p,flags,...rest);};
      const store=openTaskExecutionStore(JSON.parse(process.argv[1]));store.close();`;
    child=interactive(process.execPath,['--input-type=module','-e',code,JSON.stringify(options),point]);
  }
  try {
    assert.equal(await child.next(),'held');assert(!fs.existsSync(path.join(execution,'writer-ready.json')));
    noNativeOpen(options,args);
    child.child.kill('SIGKILL');assert.equal((await child.done).signal,'SIGKILL');
    const retained=Object.fromEntries(fs.readdirSync(execution).map(name=>[name,fs.readFileSync(path.join(execution,name))]));
    noNativeOpen(options,args);
    assert.deepEqual(Object.fromEntries(fs.readdirSync(execution).map(name=>[name,fs.readFileSync(path.join(execution,name))])),retained);
    assert.equal(fs.readFileSync(tasksPath,'utf8'),'- [ ] T-001: fixture\n');
    assert(!fs.existsSync(path.join(execution,'run')));
  }finally{await child.stop();}
}));

test('S3b1 Python outer/inner invocations cannot bind a shared tasks file twice',()=>fixture(({root,dir,tasksPath,binding})=>{
  const outer=legacyArgs(root,tasksPath),inner=legacyArgs(dir,tasksPath);
  const result=pythonGate('mark-done',outer);assert.equal(result.status,0,result.stderr);
  const before=fs.readFileSync(binding),task=fs.readFileSync(tasksPath);
  assert.equal(pythonGate('mark-done',inner).status,1);
  assert.deepEqual(fs.readFileSync(binding),before);assert.deepEqual(fs.readFileSync(tasksPath),task);
}));

for(const [name,feature,accepted] of [
  ['login','login',true],['0001.login','login',true],['用户登录','用户登录',true],
  ['1.用户登录','用户登录',true],['①.login','①.login',true],
  ['①.login','login',false],['١.login','login',false],['1١.login','login',false],['other.login','login',false],
])test(`S3b1 two-language exact layout and UTF8 binding: ${name}/${feature}`,()=>fixture(({root,tasksPath,binding,options})=>{
  const args=legacyArgs(root,tasksPath,feature),result=pythonGate('mark-done',args);
  assert.equal(result.status,accepted?0:1,result.stdout+result.stderr);
  if(!accepted) {
    assert(!fs.existsSync(binding));assert.throws(()=>openTaskExecutionStore({...options,feature}));assert(!fs.existsSync(binding));
  } else {
    const bytes=fs.readFileSync(binding);
    const store=openTaskExecutionStore({...options,feature});store.close();assert.deepEqual(fs.readFileSync(binding),bytes);
  }
},name));

for(const change of ['empty','version','boolean-version','duplicate','invalid-utf8','extra','permission','hardlink','symlink'])
test(`S3b1 both languages reject retained binding ${change}`,()=>fixture(({root,tasksPath,binding,options})=>{
  const args=legacyArgs(root,tasksPath);assert.equal(pythonGate('mark-done',args).status,0);
  const initial=fs.readFileSync(binding),value=JSON.parse(initial);
  if(change==='empty')fs.writeFileSync(binding,'');
  if(change==='version')fs.writeFileSync(binding,JSON.stringify({...value,version:2})+'\n');
  if(change==='boolean-version')fs.writeFileSync(binding,JSON.stringify({...value,version:true})+'\n');
  if(change==='duplicate')fs.writeFileSync(binding,initial.toString().replace('{','{"version":1,'));
  if(change==='invalid-utf8')fs.writeFileSync(binding,Buffer.concat([initial,Buffer.from([255])]));
  if(change==='extra')fs.writeFileSync(binding,JSON.stringify({...value,extra:1})+'\n');
  if(change==='permission')fs.chmodSync(binding,0o644);
  if(change==='hardlink')fs.linkSync(binding,binding+'.linked');
  if(change==='symlink'){fs.renameSync(binding,binding+'.retained');fs.symlinkSync(binding+'.retained',binding);}
  const before=fs.readFileSync(binding),tasks=fs.readFileSync(tasksPath);
  assert.equal(pythonGate('mark-done',args).status,1);
  assert.throws(()=>openTaskExecutionStore(options));
  assert.deepEqual(fs.readFileSync(binding),before);assert.deepEqual(fs.readFileSync(tasksPath),tasks);
}));

for(const sql of ['ALTER TABLE protocol ADD COLUMN other TEXT','CREATE TABLE sqliteXextra(value)',
  'DROP TABLE protocol; CREATE TABLE protocol(version); INSERT INTO protocol VALUES(1)',
  'PRAGMA application_id=0','PRAGMA user_version=2'])
test(`S3b1 Python rejects unknown SQLite protocol: ${sql}`,()=>fixture(({root,tasksPath,options})=>{
  const args=legacyArgs(root,tasksPath);assert.equal(pythonGate('mark-done',args).status,0);
  const lock=path.join(root,'.reviews/.execution/writer.sqlite'),db=new DatabaseSync(lock);db.exec(sql);db.close();
  const before=fs.readFileSync(lock),task=fs.readFileSync(tasksPath);
  assert.equal(pythonGate('mark-done',args).status,1);assert.throws(()=>openTaskExecutionStore(options));
  assert.deepEqual(fs.readFileSync(lock),before);assert.deepEqual(fs.readFileSync(tasksPath),task);
}));

for(const index of [1,2,3,4])test(`S3b1 JS binding sync failure ${index} starts no run and changes no task`,()=>fixture(({options,root,tasksPath})=>{
  const original=fs.fsyncSync,before=fs.readFileSync(tasksPath);let calls=0;
  try{fs.fsyncSync=fd=>{if(++calls===index)throw Object.assign(Error('fixture fsync'),{code:'EIO'});return original(fd);};
    assert.throws(()=>openTaskExecutionStore(options),{code:'EIO'});
  }finally{fs.fsyncSync=original;}
  assert.equal(calls,index);assert.deepEqual(fs.readFileSync(tasksPath),before);
  assert(!fs.existsSync(path.join(root,'.reviews/.execution')));
}));

test('S3b1 readonly Python validation creates no control files',()=>fixture(({root,tasksPath,binding})=>{
  const args=legacyArgs(root,tasksPath),before=fs.readdirSync(path.join(root,'.reviews')).sort();
  assert.equal(pythonGate('check-n5',args.slice(0,-2)).status,0);
  assert.deepEqual(fs.readdirSync(path.join(root,'.reviews')).sort(),before);assert(!fs.existsSync(binding));
}));

test('S3b1 binding replacement poisons the JS wrapper without releasing ownership',()=>fixture(({options,binding})=>{
  const store=openTaskExecutionStore(options);try {
    const bytes=fs.readFileSync(binding);fs.renameSync(binding,binding+'.retained');fs.writeFileSync(binding,bytes,{mode:0o600});
    assert.throws(()=>store.snapshot(),{code:'task_owner_changed'});
    assert.throws(()=>store.append({}),{code:'store_poisoned'});
  }finally{store.close();}
}));

function interactive(executable,args) {
  const child=spawn(executable,args,{stdio:['pipe','pipe','pipe']});let errors='';
  child.stderr.on('data',data=>{errors=(errors+data.toString()).slice(-4096);});
  let buffer='',closed=false;const lines=[],waiting=[];
  child.stdout.setEncoding('utf8');child.stdout.on('data',value=>{
    buffer+=value;let end;while((end=buffer.indexOf('\n'))!==-1) {
      const line=buffer.slice(0,end);buffer=buffer.slice(end+1);const waiter=waiting.shift();if(waiter)waiter.resolve(line);else lines.push(line);
    }
  });
  const done=new Promise(resolve=>child.once('close',(code,signal)=>{
    closed=true;for(const waiter of waiting.splice(0))waiter.reject(Error('child closed before line: '+errors));resolve({code,signal});
  }));
  const deadline=setTimeout(()=>child.kill('SIGKILL'),10000);done.then(()=>clearTimeout(deadline));
  return {child,done,next:()=>lines.length?Promise.resolve(lines.shift()):new Promise((resolve,reject)=>{
    if(closed)reject(Error('already closed'));else waiting.push({resolve,reject});
  }),stop:async()=>{if(!closed)child.kill('SIGKILL');await done;}};
}

for(const sameRoot of [false,true])test(`S3b1 real simultaneous JS initialization single owner (same root=${sameRoot})`,()=>fixture(async({options,dir,binding})=>{
  const source=`import {openTaskExecutionStore} from ${JSON.stringify(new URL('./task-owner.mjs',import.meta.url).href)};
    const options=JSON.parse(process.argv[1]);let store;process.stdout.write('ready\\n');
    process.stdin.setEncoding('utf8');process.stdin.on('data',data=>{
      if(data.includes('start')){try{store=openTaskExecutionStore(options);console.log('opened');}catch(e){console.log('refused');}}
      if(data.includes('release')){store?.close();process.exit(0);}
    });`;
  const first=interactive(process.execPath,['--input-type=module','-e',source,JSON.stringify(options)]);
  const secondOptions={...options,specsRoot:sameRoot?options.specsRoot:dir,identity:{...options.identity,runId:'other'}};
  const second=interactive(process.execPath,['--input-type=module','-e',source,JSON.stringify(secondOptions)]);
  try {
    assert.deepEqual(await Promise.all([first.next(),second.next()]),['ready','ready']);
    first.child.stdin.write('start\n');second.child.stdin.write('start\n');
    const results=await Promise.all([first.next(),second.next()]);assert.equal(results.filter(r=>r==='opened').length,1);
    const winner=JSON.parse(fs.readFileSync(binding));assert.equal(winner.specsRoot,results[0]==='opened'?options.specsRoot:secondOptions.specsRoot);
    first.child.stdin.write('release\n');second.child.stdin.write('release\n');
    assert.deepEqual(await Promise.all([first.done,second.done]),[{code:0,signal:null},{code:0,signal:null}]);
  }finally{await first.stop();await second.stop();}
}));

for(const kill of [false,true])test(`S3b1 actual Python replacement critical section excludes JS (kill=${kill})`,()=>fixture(async({root,tasksPath,options})=>{
  const args=legacyArgs(root,tasksPath);
  const source=`import runpy,sys,os,json\nm=runpy.run_path(sys.argv[1])\na=m["build_parser"]().parse_args(["mark-done"]+json.loads(sys.argv[2]))\noriginal=os.chmod\ndef pause(*args,**kw):\n original(*args,**kw)\n print("held",flush=True)\n sys.stdin.readline()\nos.chmod=pause\nm["mark_done"](a)\nprint("completed",flush=True)`;
  const child=interactive('python3',['-c',source,path.join(repository,'scripts/cm-task-gate.py'),JSON.stringify(args)]);
  try {
    assert.equal(await child.next(),'held');
    assert.throws(()=>openTaskExecutionStore(options),{code:'store_busy'});
    assert.equal(fs.readFileSync(tasksPath,'utf8'),'- [ ] T-001: fixture\n');
    if(kill)child.child.kill('SIGKILL');else{child.child.stdin.write('release\n');assert.equal(await child.next(),'completed');}
    const result=await child.done;assert.equal(kill?result.signal:result.code,kill?'SIGKILL':0);
    const store=openTaskExecutionStore(options);store.close();
    assert.equal(fs.readFileSync(tasksPath,'utf8'),kill?'- [ ] T-001: fixture\n':'- [x] T-001: fixture\n');
  }finally{await child.stop();}
}));

test('S3b1 root-layout tasks use the same binding in both languages',()=>fixture(({root,options})=>{
  const tasksPath=path.join(root,'tasks.md');fs.writeFileSync(tasksPath,'- [ ] T-001: root\n');
  const args=legacyArgs(root,tasksPath),result=pythonGate('mark-done',args);assert.equal(result.status,0,result.stderr);
  const store=openTaskExecutionStore({...options,tasksPath});store.close();
  assert.equal(JSON.parse(fs.readFileSync(path.join(root,'.reviews/.cm-task-owner.json'))).tasksPath,tasksPath);
}));

for(const which of ['task','task-reviews','root-reviews','execution','lock'])
test(`S3b1 two-language control symlink refusal: ${which}`,()=>fixture(({root,dir,tasksPath,options,binding})=>{
  const args=legacyArgs(root,tasksPath);assert.equal(pythonGate('mark-done',args).status,0);
  const names={task:tasksPath,'task-reviews':path.dirname(binding),'root-reviews':path.join(root,'.reviews'),
    execution:path.join(root,'.reviews/.execution'),lock:path.join(root,'.reviews/.execution/writer.sqlite')};
  const original=names[which];fs.renameSync(original,original+'.retained');fs.symlinkSync(original+'.retained',original);
  assert.equal(pythonGate('mark-done',args).status,1);assert.throws(()=>openTaskExecutionStore(options));
  assert(fs.lstatSync(original).isSymbolicLink());
}));

test('S3b1 task hardlinks cannot create competing physical-path bindings',()=>fixture(({root,tasksPath,binding,options})=>{
  const args=legacyArgs(root,tasksPath);fs.linkSync(tasksPath,path.join(root,'other-link'));
  assert.equal(pythonGate('mark-done',args).status,1);assert.throws(()=>openTaskExecutionStore(options));assert(!fs.existsSync(binding));
}));

test('S3b1 invalid approval cannot bind a task',()=>fixture(({root,tasksPath,binding})=>{
  const args=legacyArgs(root,tasksPath),review=path.join(root,'.reviews/login-T-001-r1.md');
  fs.writeFileSync(review,fs.readFileSync(review,'utf8').replace('independent: true','independent: false'));
  assert.equal(pythonGate('mark-done',args).status,1);assert(!fs.existsSync(binding));
  assert(!fs.existsSync(path.join(root,'.reviews/.execution')));
}));

test('S3b1 existing binding takeover sync failure cannot start another JS run',()=>fixture(({options,root,tasksPath,binding})=>{
  const args=legacyArgs(root,tasksPath);assert.equal(pythonGate('mark-done',args).status,0);
  const bytes=fs.readFileSync(binding),before=fs.readFileSync(tasksPath),sync=fs.fsyncSync;
  try{fs.fsyncSync=()=>{throw Object.assign(Error('fixture takeover fsync'),{code:'EIO'});};
    assert.throws(()=>openTaskExecutionStore(options),{code:'EIO'});
  }finally{fs.fsyncSync=sync;}
  assert.deepEqual(fs.readFileSync(binding),bytes);assert.deepEqual(fs.readFileSync(tasksPath),before);
  assert(!fs.existsSync(path.join(root,'.reviews/.execution/run')));
}));
