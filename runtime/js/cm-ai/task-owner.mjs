// Synthetic task-enabled entry; raw S3a is only a storage primitive.
import fs from 'node:fs';
import path from 'node:path';
import { need,shape,id,hex,json } from './effect-contract.mjs';
import { openExecutionStore } from './execution-store.mjs';

const same=(a,b)=>a.dev===b.dev && a.ino===b.ino;
const taskOwners=new WeakMap();
export function taskOwnerTarget(store) {
  const owner=taskOwners.get(store);
  need(owner!==undefined,'task_owner_required');
  owner.validate();return owner.target;
}
function sync(p) {
  const fd=fs.openSync(p,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
}
function directory(p,create=false) {
  if(create)try{fs.mkdirSync(p,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}
  const stat=fs.lstatSync(p);need(stat.isDirectory() && !stat.isSymbolicLink(),'unsupported_path');return stat;
}
function validate(input) {
  const v={...json(input)};shape(v,['tasksPath','feature','specsRoot','identity','fingerprints','create']);
  shape(v.identity,['repositoryId','runId']);Object.values(v.identity).forEach(id);
  shape(v.fingerprints,['workflow','config','inputs']);Object.values(v.fingerprints).forEach(hex);
  need(typeof v.create==='boolean');
  const [major,minor]=process.versions.node.split('.').map(Number);
  need(process.platform==='darwin' && (major>24 || (major===24 && minor>=14)),'unsupported_platform');
  for(const p of [v.tasksPath,v.specsRoot])need(typeof p==='string' && path.isAbsolute(p)
    && path.resolve(p)===p,'unsupported_path');
  need(typeof v.feature==='string' && v.feature.length>0 && !['.','..'].includes(v.feature)
    && !/[ .]$|[\x00-\x1f<>:"/\\|?*]/u.test(v.feature),'unsupported_feature');
  directory(v.specsRoot);
  const task=fs.lstatSync(v.tasksPath);
  need(task.isFile() && !task.isSymbolicLink() && task.nlink===1,'unsupported_file');
  v.tasksPath=fs.realpathSync(v.tasksPath);v.specsRoot=fs.realpathSync(v.specsRoot);
  need(path.basename(v.tasksPath)==='tasks.md','unsupported_path');
  const parent=path.dirname(v.tasksPath),name=path.basename(parent),suffix='.'+v.feature;
  const numbered=name.endsWith(suffix) && /^[0-9]+$/.test(name.slice(0,-suffix.length));
  need(parent===v.specsRoot || (path.dirname(parent)===v.specsRoot && (name===v.feature || numbered)),
    'unsupported_layout');
  const reviews=path.join(v.specsRoot,'.reviews');
  try{directory(reviews);}catch(error){if(error.code!=='ENOENT')throw error;}
  return v;
}
function bind(v) {
  const parent=path.dirname(v.tasksPath),reviews=path.join(parent,'.reviews');directory(reviews,true);
  const p=path.join(reviews,'.cm-task-owner.json');
  const bytes=Buffer.from(JSON.stringify({version:1,tasksPath:v.tasksPath,specsRoot:v.specsRoot})+'\n');
  need(bytes.length<=16384,'limit_exceeded');
  try {
    const fd=fs.openSync(p,fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_WRONLY|fs.constants.O_NOFOLLOW,0o600);
    try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  }catch(error){if(error.code!=='EEXIST')throw error;}
  const stat=fs.lstatSync(p);
  need(stat.isFile() && !stat.isSymbolicLink() && stat.nlink===1 && (stat.mode&0o077)===0,'unsupported_binding');
  need(stat.size<=16384,'limit_exceeded');
  const fd=fs.openSync(p,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try {
    need(same(stat,fs.fstatSync(fd)),'task_owner_changed');
    need(fs.readFileSync(fd).equals(bytes),'task_owner_mismatch');
    fs.fsyncSync(fd);
    need(same(stat,fs.lstatSync(p)),'task_owner_changed');
  }finally{fs.closeSync(fd);}
  // Includes a prior initializer's possibly unsynced directory entry.
  sync(reviews);sync(parent);
  return {p,stat,bytes};
}
export function openTaskExecutionStore(input) {
  const v=validate(input),binding=bind(v),{tasksPath,feature,...options}=v;
  const execution=path.join(v.specsRoot,'.reviews','.execution');
  try {
    directory(execution);
    // Never let native SQLite recovery consume retained initialization evidence.
    // Resolve the same pathname SQLite uses, including case-insensitive aliases
    // and dangling symlinks. A directory-name string comparison is insufficient.
    fs.lstatSync(path.join(execution,'writer.sqlite-journal'));
    need(false,'retained_journal');
  }catch(error){if(error.code!=='ENOENT')throw error;}
  const store=openExecutionStore(options);
  let poisoned=false;
  const guard=()=>{
    need(!poisoned,'store_poisoned');
    try {
      directory(path.dirname(binding.p));
      const stat=fs.lstatSync(binding.p);
      need(same(stat,binding.stat) && stat.isFile() && stat.nlink===1 && (stat.mode&0o077)===0
        && stat.size<=16384 && fs.readFileSync(binding.p).equals(binding.bytes),'task_owner_changed');
    }catch(error){poisoned=true;throw error;}
  };
  try{guard();}catch(error){store.close();throw error;}
  const handle=Object.freeze({snapshot:()=>{guard();return store.snapshot();},
    append:entry=>{guard();return store.append(entry);},close:()=>store.close()});
  taskOwners.set(handle,{target:Object.freeze({tasksPath,feature,specsRoot:v.specsRoot}),
    validate:()=>{guard();store.snapshot();}});
  return handle;
}
