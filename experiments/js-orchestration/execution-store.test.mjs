import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn,spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { openExecutionStore } from './execution-store.mjs';
import { digest } from './effect-contract.mjs';

const identity={repositoryId:'synthetic',runId:'store-run'};
const fingerprints={workflow:digest('workflow'),config:digest('config'),inputs:digest('inputs')};
function fixture(fn) {
  const specsRoot=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-s3a-')));
  const options={specsRoot,identity,fingerprints,create:true};
  const directory=path.join(specsRoot,'.reviews','.execution',identity.runId);
  const stateFile=path.join(directory,'state.json');
  const lockFile=path.join(specsRoot,'.reviews','.execution','writer.sqlite');
  const cleanup=()=>fs.rmSync(specsRoot,{recursive:true,force:true});
  try {const result=fn({options,specsRoot,directory,stateFile,lockFile});
    if(result && typeof result.then==='function')return result.finally(cleanup);
    cleanup();return result;
  }catch(error){cleanup();throw error;}
}
const entry=(store,id='effect-1',payload={value:'fixture'})=>({id,kind:'intent',payload,expectedRevision:store.snapshot().revision});

test('S3b2 raw store refuses a fully initialized but uncertified database',()=>fixture(({options,lockFile})=>{
  fs.mkdirSync(path.dirname(lockFile),{recursive:true,mode:0o700});fs.writeFileSync(lockFile,'',{mode:0o600});
  const db=new DatabaseSync(lockFile);
  db.exec('PRAGMA application_id=1129142321; PRAGMA user_version=1; CREATE TABLE protocol(version INTEGER NOT NULL CHECK(version=1)); INSERT INTO protocol VALUES(1)');db.close();
  const before=fs.readFileSync(lockFile);
  assert.throws(()=>{const store=openExecutionStore(options);store.close();});
  assert.deepEqual(fs.readFileSync(lockFile),before);
  assert.deepEqual(fs.readdirSync(path.dirname(lockFile)),['writer.sqlite']);
}));

test('S3b2 initialized store publishes immutable readiness before run records',()=>fixture(({options,lockFile})=>{
  const store=openExecutionStore(options);store.close();
  const ready=path.join(path.dirname(lockFile),'writer-ready.json');assert(fs.existsSync(ready));
  const bytes=fs.readFileSync(ready);assert.equal(fs.statSync(ready).mode&0o777,0o600);
  const reopened=openExecutionStore({...options,create:false});reopened.close();assert.deepEqual(fs.readFileSync(ready),bytes);
}));

test('S3a create, close, reopen preserves a frozen versioned empty snapshot',()=>fixture(({options})=>{
  const store=openExecutionStore(options);
  try {
    const s=store.snapshot();assert.equal(s.version,1);assert.deepEqual(s.identity,identity);
    assert.deepEqual(s.fingerprints,fingerprints);assert.deepEqual(s.records,[]);
    assert(Object.isFrozen(s));assert.throws(()=>{s.identity.runId='changed';},TypeError);
    store.close();store.close();assert.throws(()=>store.snapshot(),{code:'store_closed'});
    const reopened=openExecutionStore({...options,create:false});
    try{assert.deepEqual(reopened.snapshot(),s);}finally{reopened.close();}
  }finally{store.close();}
}));

test('S3a append persists chained records, exact retries and revision conflicts',()=>fixture(({options,stateFile})=>{
  const store=openExecutionStore(options);
  try {
    const first=entry(store),s=store.append(first);assert.equal(s.records.length,1);
    assert.equal(s.records[0].seq,1);assert.equal(s.records[0].previousDigest,null);
    assert.equal(s.records[0].payload.value,'fixture');
    assert.deepEqual(store.append(first),s);
    assert.throws(()=>store.append({...first,payload:{value:'different'}}),{code:'record_conflict'});
    assert.throws(()=>store.append({...first,id:'second'}),{code:'revision_mismatch'});
    const second=store.append({...entry(store,'second'),kind:'result'});
    assert.equal(second.records[1].previousDigest,s.records[0].digest);
    assert.deepEqual(store.append(first),second);
    assert.deepEqual(JSON.parse(fs.readFileSync(stateFile,'utf8')),second);
    store.close();const reopened=openExecutionStore({...options,create:false});
    try{assert.deepEqual(reopened.snapshot(),second);assert.deepEqual(reopened.append(first),second);}
    finally{reopened.close();}
  }finally{store.close();}
}));

const moduleURL=new URL('./execution-store.mjs',import.meta.url).href;
const childSource=options=>`import fs from 'node:fs';
  import {openExecutionStore} from ${JSON.stringify(moduleURL)};
  const options=${JSON.stringify(options)};`;
const runChild=(options,body)=>spawnSync(process.execPath,['--input-type=module','-e',childSource(options)+body],
  {encoding:'utf8',timeout:10000});

test('S3a live writer excludes same-process, Node and Python contenders',()=>fixture(({options,lockFile})=>{
  const owner=openExecutionStore(options),snapshot=owner.snapshot();
  const python=`import sqlite3,sys
db=sqlite3.connect(sys.argv[1],timeout=0)
try:
 db.execute('BEGIN IMMEDIATE'); print('held')
except sqlite3.OperationalError:
 print('busy')
finally:
 db.close()
`;
  try {
    assert.throws(()=>openExecutionStore({...options,create:false}),{code:'store_busy'});
    const other=runChild({...options,create:false},`try{openExecutionStore(options);process.exitCode=2;}catch(e){console.log(e.code);}`);
    assert.equal(other.status,0);assert.equal(other.stdout.trim(),'store_busy');
    const py=spawnSync('python3',['-c',python,lockFile],{encoding:'utf8',timeout:5000});
    assert.equal(py.status,0,py.stderr);assert.equal(py.stdout.trim(),'busy');
    assert.deepEqual(owner.snapshot(),snapshot);
  }finally{owner.close();}
  const py=spawnSync('python3',['-c',python,lockFile],{encoding:'utf8',timeout:5000});
  assert.equal(py.status,0,py.stderr);assert.equal(py.stdout.trim(),'held');
}));

test('S3a SIGKILL releases process ownership but retains committed facts',()=>fixture(async({options})=>{
  const child=spawn(process.execPath,['--input-type=module','-e',childSource(options)+`
    const s=openExecutionStore(options);s.append({id:'intent',kind:'intent',payload:{state:'started'},expectedRevision:s.snapshot().revision});
    fs.writeSync(1,'ready');process.stdin.resume();`],{stdio:['pipe','pipe','pipe']});
  const exited=once(child,'exit');let timer;
  try {
    const [data]=await Promise.race([once(child.stdout,'data'),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('child readiness timeout')),5000);})]);
    clearTimeout(timer);assert.equal(data.toString(),'ready');
    assert.throws(()=>openExecutionStore({...options,create:false}),{code:'store_busy'});
    child.kill('SIGKILL');const [code,signal]=await exited;assert.equal(code,null);assert.equal(signal,'SIGKILL');
    const recovered=openExecutionStore({...options,create:false});
    try{assert.equal(recovered.snapshot().records.length,1);assert.equal(recovered.snapshot().records[0].kind,'intent');}
    finally{recovered.close();}
  }finally{clearTimeout(timer);if(child.exitCode===null && child.signalCode===null){child.kill('SIGKILL');await exited;}}
}));

for(const point of ['before-temp-fsync','before-rename','after-rename','before-dir-fsync'])
test(`S3a process crash ${point} recovers only whole old/new state`,()=>fixture(({options})=>{
  const store=openExecutionStore(options),initial=store.snapshot();store.close();
  const result=runChild({...options,create:false},`
    const s=openExecutionStore(options),point=${JSON.stringify(point)};
    const sync=fs.fsyncSync,rename=fs.renameSync;
    fs.fsyncSync=function(fd){if(point==='before-temp-fsync' && fs.fstatSync(fd).isFile()
      || point==='before-dir-fsync' && fs.fstatSync(fd).isDirectory())process.kill(process.pid,'SIGKILL');return sync(fd);};
    fs.renameSync=function(...args){if(point==='before-rename')process.kill(process.pid,'SIGKILL');
      const value=rename(...args);if(point==='after-rename')process.kill(process.pid,'SIGKILL');return value;};
    s.append({id:'durable-intent',kind:'intent',payload:{count:1},expectedRevision:s.snapshot().revision});`);
  assert.equal(result.error,undefined);assert.equal(result.signal,'SIGKILL');
  const recovered=openExecutionStore({...options,create:false});
  try{
    const actual=recovered.snapshot();assert.equal(actual.records.length,['after-rename','before-dir-fsync'].includes(point)?1:0);
    if(actual.records.length===0)assert.deepEqual(actual,initial);
    else assert.deepEqual(recovered.append({id:'durable-intent',kind:'intent',payload:{count:1},expectedRevision:initial.revision}),actual);
  }finally{recovered.close();}
}));

test('S3a post-rename sync failure is unknown and poisons read/write until reopen',()=>fixture(({options,directory})=>{
  const store=openExecutionStore(options),value=entry(store),sync=fs.fsyncSync;let seenFile=false;
  try{
    fs.fsyncSync=function(fd){if(fs.fstatSync(fd).isFile())seenFile=true;
      if(seenFile && fs.fstatSync(fd).isDirectory())throw Object.assign(Error('fixture failure'),{code:'ENOTSUP'});return sync(fd);};
    assert.throws(()=>store.append(value),{code:'store_write_unknown'});
  }finally{fs.fsyncSync=sync;}
  assert.throws(()=>store.snapshot(),{code:'store_poisoned'});
  assert.throws(()=>store.append(value),{code:'store_poisoned'});store.close();
  const reopened=openExecutionStore({...options,create:false});
  try{assert.equal(reopened.snapshot().records.length,1);assert.deepEqual(reopened.append(value),reopened.snapshot());
    assert.equal(fs.readdirSync(directory).length,1);}finally{reopened.close();}
}));

test('S3a mandatory synchronization order is file, rename, parent',()=>fixture(({options})=>{
  const store=openExecutionStore(options),sync=fs.fsyncSync,rename=fs.renameSync,events=[];
  try{
    fs.fsyncSync=function(fd){events.push(fs.fstatSync(fd).isDirectory()?'dir':'file');return sync(fd);};
    fs.renameSync=function(...args){events.push('rename');return rename(...args);};
    store.append(entry(store));assert.deepEqual(events,['file','rename','dir']);
  }finally{fs.fsyncSync=sync;fs.renameSync=rename;store.close();}
}));

for(let point=1;point<=12;point++)test(`S3a initialization fsync failure ${point} returns no handle`,()=>fixture(({options,stateFile,lockFile})=>{
  const sync=fs.fsyncSync;let count=0;
  try{fs.fsyncSync=function(fd){if(++count===point)throw Object.assign(Error('unsupported fixture sync'),{code:'ENOTSUP'});return sync(fd);};
    assert.throws(()=>openExecutionStore(options));assert.equal(count,point);
  }finally{fs.fsyncSync=sync;}
  if(fs.existsSync(stateFile)) {
    const s=openExecutionStore({...options,create:false});try{assert.deepEqual(s.snapshot().records,[]);}finally{s.close();}
  }else assert.throws(()=>openExecutionStore({...options,create:false}));
  if(fs.existsSync(lockFile) && fs.statSync(lockFile).size>0) {
    const db=new DatabaseSync(lockFile);try{db.exec('BEGIN IMMEDIATE');}finally{db.close();}
  }
}));

test('S3a reopen never creates a missing ownership database',()=>fixture(({options,lockFile})=>{
  const store=openExecutionStore(options);store.close();fs.unlinkSync(lockFile);
  assert.throws(()=>openExecutionStore({...options,create:false}));assert(!fs.existsSync(lockFile));
}));

for(const mutation of ['malformed','unknown-version','digest','sequence','fingerprint','extra','duplicate-key','missing'])
test(`S3a ${mutation} persisted state blocks without reset`,()=>fixture(({options,stateFile})=>{
  const store=openExecutionStore(options);store.append(entry(store));store.close();
  let value=JSON.parse(fs.readFileSync(stateFile));
  if(mutation==='unknown-version')value.version=2;
  if(mutation==='digest')value.revision='0'.repeat(64);
  if(mutation==='sequence')value.records[0].seq=2;
  if(mutation==='fingerprint')value.fingerprints.inputs='0'.repeat(64);
  if(mutation==='extra')value.extra=true;
  if(mutation==='missing')fs.unlinkSync(stateFile);
  else fs.writeFileSync(stateFile,mutation==='malformed'?'{':mutation==='duplicate-key'?'{"version":1,'+JSON.stringify(value).slice(1)+'\n':JSON.stringify(value)+'\n');
  const before=fs.existsSync(stateFile)?fs.readFileSync(stateFile):null;
  assert.throws(()=>openExecutionStore({...options,create:false}));
  assert.deepEqual(fs.existsSync(stateFile)?fs.readFileSync(stateFile):null,before);
  assert.throws(()=>openExecutionStore(options),{code:'store_exists'});
}));

for(const mutation of ['empty','unknown-version','wrong-table','garbage'])
test(`S3a ${mutation} lock database is not reinitialized`,()=>fixture(({options,lockFile})=>{
  const store=openExecutionStore(options);store.close();
  if(mutation==='empty')fs.truncateSync(lockFile,0);
  else if(mutation==='garbage')fs.writeFileSync(lockFile,'not a database');
  else {const db=new DatabaseSync(lockFile);try{db.exec(mutation==='unknown-version'?'PRAGMA user_version=99':'CREATE TABLE unexpected (value TEXT)');}finally{db.close();}}
  const bytes=fs.readFileSync(lockFile);assert.throws(()=>openExecutionStore({...options,create:false}));
  assert.deepEqual(fs.readFileSync(lockFile),bytes);
}));

for(const field of ['workflow','config','inputs'])test(`S3a ${field} mismatch cannot resume`,()=>fixture(({options,stateFile})=>{
  const store=openExecutionStore(options);store.close();const bytes=fs.readFileSync(stateFile);
  assert.throws(()=>openExecutionStore({...options,create:false,fingerprints:{...fingerprints,[field]:'0'.repeat(64)}}),{code:'fingerprint_mismatch'});
  assert.deepEqual(fs.readFileSync(stateFile),bytes);
}));

test('S3a closed, non-JSON and oversized appends cannot mutate disk',()=>fixture(({options,stateFile})=>{
  const store=openExecutionStore(options),bytes=fs.readFileSync(stateFile);let touched=0;
  const invalid=entry(store);Object.defineProperty(invalid,'payload',{enumerable:true,get(){touched++;return {};}});
  assert.throws(()=>store.append(invalid));assert.equal(touched,0);
  for(const payload of [()=>{},NaN,{value:'😀'.repeat(300000)}])assert.throws(()=>store.append({...entry(store),payload}));
  assert.deepEqual(fs.readFileSync(stateFile),bytes);store.close();
  assert.throws(()=>store.append({}),{code:'store_closed'});
}));

for(const target of ['reviews','execution','run','state','lock'])test(`S3a ${target} symlink is rejected`,()=>fixture(({options,specsRoot,directory,stateFile,lockFile})=>{
  const store=openExecutionStore(options);store.close();
  const names={reviews:path.join(specsRoot,'.reviews'),execution:path.join(specsRoot,'.reviews','.execution'),run:directory,state:stateFile,lock:lockFile};
  const source=names[target],moved=source+'.retained';fs.renameSync(source,moved);fs.symlinkSync(moved,source);
  assert.throws(()=>openExecutionStore({...options,create:false}));assert(fs.lstatSync(source).isSymbolicLink());
}));

for(const target of ['state','lock'])test(`S3a ${target} hardlink is rejected`,()=>fixture(({options,stateFile,lockFile,specsRoot})=>{
  const store=openExecutionStore(options);store.close();const source=target==='state'?stateFile:lockFile;
  fs.linkSync(source,path.join(specsRoot,'linked'));assert.throws(()=>openExecutionStore({...options,create:false}));
}));

test('S3a ownership inode replacement poisons the handle',()=>fixture(({options,lockFile})=>{
  const store=openExecutionStore(options);const bytes=fs.readFileSync(lockFile);
  fs.renameSync(lockFile,lockFile+'.retained');fs.writeFileSync(lockFile,bytes,{mode:0o600});
  try{assert.throws(()=>store.snapshot(),{code:'store_ownership'});assert.throws(()=>store.append({}),{code:'store_poisoned'});}
  finally{store.close();}
}));

test('S3a count limit is enforced on reopen and append, without truncation',()=>fixture(({options,stateFile})=>{
  const store=openExecutionStore(options),initial=store.snapshot();store.close();
  let previousDigest=null;
  const records=Array.from({length:1024},(_,i)=>{
    const data={version:1,seq:i+1,id:`entry-${i}`,kind:'intent',payload:null,previousDigest};
    const r={...data,digest:digest(data)};previousDigest=r.digest;return r;
  });
  const save=items=>{const {revision:old,...rest}=initial,data={...rest,records:items};
    fs.writeFileSync(stateFile,JSON.stringify({...data,revision:digest(data)})+'\n');};
  save(records);const full=openExecutionStore({...options,create:false});
  try{assert.equal(full.snapshot().records.length,1024);assert.throws(()=>full.append(entry(full)),{code:'limit_exceeded'});
    assert.equal(full.snapshot().records.length,1024);}finally{full.close();}
  save([...records,records[0]]);const bytes=fs.readFileSync(stateFile);
  assert.throws(()=>openExecutionStore({...options,create:false}),{code:'limit_exceeded'});assert.deepEqual(fs.readFileSync(stateFile),bytes);
}));

test('S3a payload UTF8 and whole-document byte budgets reject without truncating',()=>fixture(({options,stateFile})=>{
  const store=openExecutionStore(options);
  try {
    const payload='x'.repeat(1024*1024-2);
    for(let i=0;i<15;i++)store.append(entry(store,`large-${i}`,payload));
    const before=fs.readFileSync(stateFile);assert(before.length<16*1024*1024);
    assert.throws(()=>store.append(entry(store,'overflow',payload)),{code:'limit_exceeded'});
    assert.deepEqual(fs.readFileSync(stateFile),before);assert.equal(store.snapshot().records.length,15);
  }finally{store.close();}
  fs.truncateSync(stateFile,16*1024*1024+1);
  assert.throws(()=>openExecutionStore({...options,create:false}),{code:'limit_exceeded'});
}));

test('S3a crash temp headroom bounded, retained evidence not deleted',()=>fixture(({options,directory})=>{
  const store=openExecutionStore(options);store.close();
  const names=['.state.00000000-0000-0000-0000-000000000001.tmp','.state.00000000-0000-0000-0000-000000000002.tmp'];
  for(const name of names){const p=path.join(directory,name);fs.writeFileSync(p,'',{mode:0o600});fs.truncateSync(p,16*1024*1024);}
  assert.throws(()=>openExecutionStore({...options,create:false}),{code:'limit_exceeded'});
  for(const name of names)assert.equal(fs.statSync(path.join(directory,name)).size,16*1024*1024);
}));

test('S3a unknown run files and root alias reject without cleanup',()=>fixture(({options,directory,specsRoot})=>{
  const store=openExecutionStore(options);store.close();
  fs.writeFileSync(path.join(directory,'unexpected'),'retained',{mode:0o600});
  assert.throws(()=>openExecutionStore({...options,create:false}),{code:'store_unknown_file'});
  assert.equal(fs.readFileSync(path.join(directory,'unexpected'),'utf8'),'retained');
  const alias=path.join(specsRoot,'root-alias');fs.symlinkSync(specsRoot,alias);
  assert.throws(()=>openExecutionStore({...options,specsRoot:alias}),{code:'unsupported_path'});
  assert.throws(()=>openExecutionStore({...options,identity:{...identity,runId:'../escape'}}));
}));

test('S3a pre-rename I/O failure retains old state and poisons the instance',()=>fixture(({options,stateFile,directory})=>{
  const store=openExecutionStore(options),value=entry(store),before=fs.readFileSync(stateFile),write=fs.writeFileSync;
  try{fs.writeFileSync=()=>{throw Object.assign(Error('synthetic no space'),{code:'ENOSPC'});};
    assert.throws(()=>store.append(value),{code:'ENOSPC'});
  }finally{fs.writeFileSync=write;}
  assert.throws(()=>store.snapshot(),{code:'store_poisoned'});store.close();assert.deepEqual(fs.readFileSync(stateFile),before);
  assert.equal(fs.readdirSync(directory).filter(p=>p.endsWith('.tmp')).length,1);
  const fresh=openExecutionStore({...options,create:false});try{assert.equal(fresh.snapshot().records.length,0);}finally{fresh.close();}
}));

test('S3a different task identity and protocol permission changes cannot resume',()=>fixture(({options,lockFile})=>{
  const store=openExecutionStore(options);store.close();
  assert.throws(()=>openExecutionStore({...options,create:false,identity:{...identity,repositoryId:'foreign'}}),{code:'identity_mismatch'});
  fs.chmodSync(lockFile,0o644);assert.throws(()=>openExecutionStore({...options,create:false}),{code:'store_permissions'});
}));

test('S3a create cannot silently replace a lost lock for existing runs',()=>fixture(({options,lockFile})=>{
  const store=openExecutionStore(options);store.close();fs.unlinkSync(lockFile);
  assert.throws(()=>openExecutionStore({...options,identity:{...identity,runId:'new-run'}}),{code:'store_missing'});
  assert(!fs.existsSync(lockFile));
}));

for(const mode of ['reopen','live'])test(`S3a invalid UTF8 is rejected without replacement decoding (${mode})`,()=>fixture(({options,stateFile})=>{
  const store=openExecutionStore(options);store.append(entry(store,'replacement','\uFFFD'));
  if(mode==='reopen')store.close();
  const original=fs.readFileSync(stateFile),offset=original.indexOf(Buffer.from('\uFFFD'));
  assert(offset>=0);
  const corrupt=Buffer.concat([original.subarray(0,offset),Buffer.from([255]),original.subarray(offset+3)]);
  fs.writeFileSync(stateFile,corrupt);
  try {
    if(mode==='reopen')assert.throws(()=>{
      const reopened=openExecutionStore({...options,create:false});try{reopened.snapshot();}finally{reopened.close();}
    },{code:'store_corrupt'});
    else {
      assert.throws(()=>store.snapshot(),{code:'store_corrupt'});
      assert.throws(()=>store.snapshot(),{code:'store_poisoned'});
      assert.throws(()=>store.append({}),{code:'store_poisoned'});
    }
    assert.deepEqual(fs.readFileSync(stateFile),corrupt);
  }finally{store.close();}
}));

for(const [label,sql] of [
  ['extra column','ALTER TABLE protocol ADD COLUMN foreign_data TEXT'],
  ['missing constraints','DROP TABLE protocol; CREATE TABLE protocol(version); INSERT INTO protocol VALUES(1)'],
  ['internal table','DROP TABLE protocol; CREATE TABLE protocol(version INTEGER PRIMARY KEY AUTOINCREMENT); INSERT INTO protocol VALUES(1)'],
  ['wildcard hidden table','CREATE TABLE sqliteXunexpected(value TEXT)'],
])test(`S3a unknown lock schema rejected and preserved: ${label}`,()=>fixture(({options,lockFile})=>{
  const store=openExecutionStore(options);store.close();
  const db=new DatabaseSync(lockFile);try{db.exec(sql);}finally{db.close();}
  const before=fs.readFileSync(lockFile);
  assert.throws(()=>{
    const reopened=openExecutionStore({...options,create:false});try{reopened.snapshot();}finally{reopened.close();}
  },{code:'store_version'});
  assert.deepEqual(fs.readFileSync(lockFile),before);
  // Failed validation must release ownership, not leave a hidden live connection.
  const probe=new DatabaseSync(lockFile);try{probe.exec('BEGIN IMMEDIATE; ROLLBACK');}finally{probe.close();}
}));

for(const version of ['23.11.0','24.0.0','24.13.99'])test(`S3a unsupported Node ${version} rejects before creating files`,()=>fixture(({options,specsRoot})=>{
  const before=Object.getOwnPropertyDescriptor(process.versions,'node');
  try {
    Object.defineProperty(process.versions,'node',{...before,value:version});
    assert.throws(()=>{const store=openExecutionStore(options);store.close();},{code:'unsupported_platform'});
    assert.deepEqual(fs.readdirSync(specsRoot),[]);
  }finally{Object.defineProperty(process.versions,'node',before);}
}));
