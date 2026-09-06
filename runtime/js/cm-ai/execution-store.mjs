// S3a local synthetic durable record store. No dispatch or task authority.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID,createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { need,shape,id,hex,json,digest,freeze } from './effect-contract.mjs';

const MiB=1024*1024,STATE_LIMIT=16*MiB,PHYSICAL_LIMIT=32*MiB,APP_ID=0x434d5831;
const PROTOCOL_SQL='CREATE TABLE protocol(version INTEGER NOT NULL CHECK(version=1))';
const kinds=new Set(['intent','result','cancel','commit-intent','commit-result','finalized']);
const seal=value=>freeze({...value,revision:digest(value)});
const sameInode=(a,b)=>a.dev===b.dev && a.ino===b.ino;
function syncPath(p) {
  const fd=fs.openSync(p,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
}
function directory(p,create=false,privateMode=true) {
  if(!fs.existsSync(p)) {
    need(create,'store_missing');
    try{fs.mkdirSync(p,{mode:0o700});syncPath(p);syncPath(path.dirname(p));}
    catch(error){if(error.code!=='EEXIST')throw error;}
  }
  const stat=fs.lstatSync(p);
  need(stat.isDirectory() && !stat.isSymbolicLink(),'unsupported_path');
  need(!privateMode || (stat.mode&0o077)===0,'store_permissions');return stat;
}
function regular(p,limit) {
  const s=fs.lstatSync(p);
  need(s.isFile() && !s.isSymbolicLink() && s.nlink===1,'unsupported_file');
  need((s.mode&0o077)===0,'store_permissions');need(s.size<=limit,'limit_exceeded');return s;
}
function readState(p) {
  const before=regular(p,STATE_LIMIT),fd=fs.openSync(p,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try {
    need(sameInode(before,fs.fstatSync(fd)),'snapshot_changed');
    const bytes=fs.readFileSync(fd);need(bytes.length<=STATE_LIMIT,'limit_exceeded');
    const after=fs.fstatSync(fd);
    need(sameInode(before,fs.lstatSync(p)) && before.size===after.size && before.mtimeMs===after.mtimeMs
      && before.ctimeMs===after.ctimeMs && bytes.length===after.size,'snapshot_changed');
    const raw=bytes.toString('utf8'),value=JSON.parse(raw);
    // Compare original bytes: replacement decoding must never repair corruption.
    need(Buffer.from(JSON.stringify(value)+'\n').equals(bytes),'store_corrupt');return value;
  }finally{fs.closeSync(fd);}
}
function validateState(raw,options) {
  const v=json(raw,STATE_LIMIT);shape(v,['version','identity','fingerprints','records','revision']);
  need(v.version===1,'store_version');
  need(digest(v.identity)===digest(options.identity),'identity_mismatch');
  need(digest(v.fingerprints)===digest(options.fingerprints),'fingerprint_mismatch');
  need(Array.isArray(v.records) && v.records.length<=1024,'limit_exceeded');
  let previous=null;const ids=new Set();
  for(const [index,r] of v.records.entries()) {
    shape(r,['version','seq','id','kind','payload','previousDigest','digest']);
    need(r.version===1,'store_version');need(r.seq===index+1 && r.previousDigest===previous,'store_corrupt');
    id(r.id);need(!ids.has(r.id) && kinds.has(r.kind),'store_corrupt');ids.add(r.id);json(r.payload,MiB);
    const {digest:checksum,...data}=r;hex(checksum);need(digest(data)===checksum,'store_corrupt');previous=checksum;
  }
  const {revision,...data}=v;hex(revision);need(digest(data)===revision,'store_corrupt');return v;
}
function runBytes(dir) {
  let total=0;
  for(const name of fs.readdirSync(dir)) {
    need(name==='state.json' || /^\.state\.[a-f0-9-]{36}\.tmp$/.test(name),'store_unknown_file');
    total+=regular(path.join(dir,name),STATE_LIMIT).size;
  }
  need(total<=PHYSICAL_LIMIT,'limit_exceeded');return total;
}
function atomicState(dir,value) {
  const bytes=Buffer.from(JSON.stringify(value)+'\n');need(bytes.length<=STATE_LIMIT,'limit_exceeded');
  need(runBytes(dir)+bytes.length<=PHYSICAL_LIMIT,'limit_exceeded');
  const tmp=path.join(dir,`.state.${randomUUID()}.tmp`);let fd,renamed=false;
  try {
    fd=fs.openSync(tmp,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
    fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
    fs.renameSync(tmp,path.join(dir,'state.json'));renamed=true;syncPath(dir);
  }catch(error) {
    if(renamed)need(false,'store_write_unknown');throw error;
  }finally{if(fd!==undefined)fs.closeSync(fd);}
}
const readyPath=p=>path.join(path.dirname(p),'writer-ready.json');
const activeWriters=new Set();
function noJournal(p) {
  try{fs.lstatSync(p+'-journal');}catch(error){if(error.code==='ENOENT')return;throw error;}
  need(false,'retained_journal');
}
function databaseDigest(p,fd) {
  const before=regular(p,64*1024);
    need(sameInode(before,fs.fstatSync(fd)),'store_ownership');
    const buffer=Buffer.alloc(before.size+1);let size=0;
    while(size<buffer.length){const n=fs.readSync(fd,buffer,size,buffer.length-size,size);if(!n)break;size+=n;}
    const bytes=buffer.subarray(0,size),after=fs.fstatSync(fd);
    need(sameInode(before,fs.lstatSync(p)) && bytes.length===before.size && before.size===after.size
      && before.mtimeMs===after.mtimeMs && before.ctimeMs===after.ctimeMs,'store_ownership');
    return createHash('sha256').update(bytes).digest('hex');
}
function readiness(p,fd) {
  const marker=readyPath(p),inode=regular(marker,1024),v=readState(marker);
  shape(v,['version','protocol','databaseDigest']);
  need(Object.keys(v).join('|')==='version|protocol|databaseDigest'
    && v.version===1 && v.protocol==='cm-writer-ready','store_version');hex(v.databaseDigest);
  need(v.databaseDigest===databaseDigest(p,fd),'store_version');
  need(sameInode(inode,fs.lstatSync(marker)),'store_ownership');return inode;
}
function publishReadiness(p,inspectionFd) {
  noJournal(p);
  const bytes=Buffer.from(JSON.stringify({version:1,protocol:'cm-writer-ready',databaseDigest:databaseDigest(p,inspectionFd)})+'\n');
  const fd=fs.openSync(readyPath(p),fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
  try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  syncPath(path.dirname(p));
}
function acquireWriter(p,create) {
  let created=false,db,certificate,inspectionFd,key;
  const release=()=>{
    try{if(db?.isOpen)db.close();}finally{
      if(inspectionFd!==undefined){fs.closeSync(inspectionFd);inspectionFd=undefined;}
      if(key!==undefined){activeWriters.delete(key);key=undefined;}
    }
  };
  try {
    if(!fs.existsSync(p)) {
      need(create && fs.readdirSync(path.dirname(p)).length===0,'store_missing');
      try{const fd=fs.openSync(p,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
        created=true;try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}syncPath(path.dirname(p));
      }catch(error){if(error.code!=='EEXIST')throw error;}
    }
    const inode=regular(p,64*1024);need(created || inode.size>0,'store_incomplete');
    const candidateKey=`${inode.dev}:${inode.ino}`;need(!activeWriters.has(candidateKey),'store_busy');
    key=candidateKey;activeWriters.add(key);
    // POSIX close(any fd on this DB) drops ALL process locks. Keep this one
    // inspection descriptor until AFTER SQLite closes, including failure paths.
    inspectionFd=fs.openSync(p,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
    noJournal(p);
    if(!created) {
      // An O_EXCL loser must NEVER open an incompletely initialized native DB.
      certificate=readiness(p,inspectionFd);fs.fsyncSync(inspectionFd);syncPath(readyPath(p));syncPath(path.dirname(p));
    }
    db=new DatabaseSync(p,{timeout:0,allowExtension:false});
    db.exec('PRAGMA busy_timeout=0; PRAGMA trusted_schema=OFF; PRAGMA synchronous=EXTRA; PRAGMA fullfsync=ON');
    if(created) {
      db.exec(`BEGIN IMMEDIATE; PRAGMA application_id=${APP_ID}; PRAGMA user_version=1;
        ${PROTOCOL_SQL}; INSERT INTO protocol VALUES(1); COMMIT;`);
      fs.fsyncSync(inspectionFd);syncPath(path.dirname(p));
    }
    db.exec('BEGIN IMMEDIATE');
    need(db.prepare('PRAGMA application_id').get().application_id===APP_ID
      && db.prepare('PRAGMA user_version').get().user_version===1,'store_version');
    need(db.prepare('PRAGMA journal_mode').get().journal_mode==='delete','store_version');
    // No filtered internal objects or schema-compatible guesses in this v1 protocol.
    const tables=db.prepare('SELECT name,type,tbl_name,sql FROM sqlite_master').all();
    need(tables.length===1 && tables[0].name==='protocol' && tables[0].type==='table'
      && tables[0].tbl_name==='protocol' && tables[0].sql===PROTOCOL_SQL,'store_version');
    const rows=db.prepare('SELECT version FROM protocol').all();need(rows.length===1 && rows[0].version===1,'store_version');
    if(created)publishReadiness(p,inspectionFd);
    const current=readiness(p,inspectionFd);
    need(!certificate || sameInode(certificate,current),'store_ownership');
    return {db,inode:regular(p,64*1024),certificate:current,inspectionFd,release};
  }catch(error){release();if(error.errcode===5)need(false,'store_busy');throw error;}
}
export function openExecutionStore(input) {
  const options=json(input);shape(options,['specsRoot','identity','fingerprints','create']);
  shape(options.identity,['repositoryId','runId']);Object.values(options.identity).forEach(id);
  shape(options.fingerprints,['workflow','config','inputs']);Object.values(options.fingerprints).forEach(hex);
  need(typeof options.create==='boolean' && typeof options.specsRoot==='string'
    && path.isAbsolute(options.specsRoot) && path.resolve(options.specsRoot)===options.specsRoot,'unsupported_path');
  const [major,minor]=process.versions.node.split('.').map(Number);
  need(process.platform==='darwin' && (major>24 || (major===24 && minor>=14)),'unsupported_platform');
  need(!fs.lstatSync(options.specsRoot).isSymbolicLink(),'unsupported_path');
  const root=fs.realpathSync(options.specsRoot);directory(root,false,false);
  const reviews=path.join(root,'.reviews'),execution=path.join(reviews,'.execution');
  directory(reviews,options.create,false);directory(execution,options.create);
  const lockPath=path.join(execution,'writer.sqlite'),{db,inode,certificate,inspectionFd,release}=acquireWriter(lockPath,options.create);
  let closed=false,poisoned=false,dir;
  const close=()=>{if(!closed){closed=true;release();}};
  try {
    dir=path.join(execution,options.identity.runId);
    if(options.create) {need(!fs.existsSync(dir),'store_exists');fs.mkdirSync(dir,{mode:0o700});syncPath(dir);syncPath(execution);}
    const directories=[reviews,execution,dir].map(p=>({p,inode:directory(p,false,p!==reviews)}));
    const guard=()=>{
      need(!closed,'store_closed');need(!poisoned,'store_poisoned');
      for(const d of directories)need(sameInode(d.inode,directory(d.p,false,d.p!==reviews)),'snapshot_changed');
      need(db.isOpen && db.isTransaction && sameInode(inode,regular(lockPath,64*1024)),'store_ownership');
      need(sameInode(certificate,readiness(lockPath,inspectionFd)),'store_ownership');noJournal(lockPath);
    };
    const statePath=path.join(dir,'state.json');
    if(options.create)atomicState(dir,seal({version:1,identity:options.identity,fingerprints:options.fingerprints,records:[]}));
    const snapshot=()=>{
      need(!closed,'store_closed');need(!poisoned,'store_poisoned');
      try{guard();runBytes(dir);return validateState(readState(statePath),options);}catch(error){poisoned=true;throw error;}
    };
    snapshot();
    const append=input=>{
      need(!closed,'store_closed');need(!poisoned,'store_poisoned');
      const v=json(input,MiB+1024);shape(v,['id','kind','payload','expectedRevision']);
      id(v.id);hex(v.expectedRevision);need(kinds.has(v.kind));json(v.payload,MiB);
      const current=snapshot(),existing=current.records.find(r=>r.id===v.id);
      if(existing){need(existing.kind===v.kind && digest(existing.payload)===digest(v.payload),'record_conflict');return current;}
      need(v.expectedRevision===current.revision,'revision_mismatch');
      need(current.records.length<1024,'limit_exceeded');
      const record={version:1,seq:current.records.length+1,id:v.id,kind:v.kind,payload:v.payload,
        previousDigest:current.records.at(-1)?.digest??null};
      const {revision:oldRevision,...data}=current;
      const next=validateState(seal({...data,records:[...current.records,{...record,digest:digest(record)}]}),options);
      try{guard();atomicState(dir,next);}catch(error){poisoned=true;throw error;}
      return next;
    };
    return Object.freeze({snapshot,append,close});
  }catch(error){close();throw error;}
}
