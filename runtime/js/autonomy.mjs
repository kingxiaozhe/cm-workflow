// Standing "run to the end" authorization (scripts/cm-autonomy.mjs). Like
// --approval-response, the session relays the person's own words; the record
// changes three things: a driver stop waits waitMinutes instead of paging at once
// (the session usually carries on), cm-ai admission may approve a change proposal
// that leaves the requirement contract alone, and the session may reopen a task
// up to AUTO_REOPEN_LIMIT times. Fatal stops page at once (cm-autonomy.mjs notify).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';

export const AUTONOMY_FILE='autonomy.json',AUTONOMY_OFF_FILE='autonomy.off.json',REOPEN_DIR='autonomy-reopens',AUTO_REOPEN_LIMIT=2;
// Same directory as notify.json (notify.mjs notifyHome); kept here so notify.mjs can import this module.
export const autonomyHome=(env=process.env)=>path.resolve(env.CM_WORKFLOW_HOME||path.join(os.homedir(),'.cm-workflow'));
const iso=value=>typeof value==='string'&&/^\d{4}-\d\d-\d\dT/.test(value)&&Number.isFinite(Date.parse(value));
const words=value=>typeof value==='string'&&value.trim()!==''&&Array.from(value).length<=500;
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);

function readJson(file){
  try{if(!fs.lstatSync(file).isFile())return {invalid:true};return {value:JSON.parse(fs.readFileSync(file,'utf8'))};}
  catch(error){return error.code==='ENOENT'?{missing:true}:{invalid:true};}
}
function writeJson(home,name,value){
  fs.mkdirSync(home,{recursive:true,mode:0o700});
  const target=path.join(home,name),temporary=path.join(home,`.${name}-${randomUUID()}`);
  try{fs.writeFileSync(temporary,JSON.stringify(value,null,1)+'\n',{mode:0o600,flag:'wx'});fs.renameSync(temporary,target);}
  finally{try{fs.unlinkSync(temporary);}catch(error){if(error.code!=='ENOENT')throw error;}}
}

// {on:true,value} only for a regular file the writer below would produce; anything else is off.
export function readAutonomy(env=process.env){
  const read=readJson(path.join(autonomyHome(env),AUTONOMY_FILE));
  if(read.missing)return {on:false,reason:'missing'};
  const value=read.value;
  if(read.invalid||!record(value)||Object.keys(value).sort().join()!=='at,mode,response,version'
    ||value.version!==1||value.mode!=='until_fatal'||!words(value.response)||!iso(value.at))return {on:false,reason:'invalid'};
  return {on:true,value:{version:1,mode:'until_fatal',response:value.response,at:value.at}};
}

export function writeAutonomy(response,{env=process.env,now=Date.now()}={}){
  if(!words(response))throw new Error('autonomy_response_invalid');
  const value={version:1,mode:'until_fatal',response,at:new Date(now).toISOString()};
  writeJson(autonomyHome(env),AUTONOMY_FILE,value);
  return value;
}

// Turning it off keeps the record (renamed) so the last grant stays auditable.
export function clearAutonomy({env=process.env}={}){
  const home=autonomyHome(env);
  try{fs.renameSync(path.join(home,AUTONOMY_FILE),path.join(home,AUTONOMY_OFF_FILE));return true;}
  catch(error){if(error.code==='ENOENT')return false;throw error;}
}

// Automatic reopens per task. Each reopen claims one numbered slot file with an
// exclusive create, which is atomic: concurrent takers (any project) can never
// claim the same slot, and there is no lock to reclaim. A slot left half-written
// by a crash still counts. {count} when a slot was claimed, {refused:true,count}
// when all AUTO_REOPEN_LIMIT are taken (a fatal stop).
const reopenKey=(project,task)=>`${path.resolve(project)}|${task}`;
const slotPrefix=key=>createHash('sha256').update(key).digest('hex').slice(0,32);
// Counted by slot file name, like takeReopen; a group whose files are all unreadable is still shown.
export function readReopens(env=process.env){
  const dir=path.join(autonomyHome(env),REOPEN_DIR),groups={};
  let names;try{names=fs.readdirSync(dir);}catch(error){if(error.code==='ENOENT')return {};throw error;}
  for(const name of names){
    const prefix=/^([0-9a-f]{32})-\d+$/.exec(name)?.[1];if(!prefix)continue;
    let key=null;try{key=JSON.parse(fs.readFileSync(path.join(dir,name),'utf8')).key;}catch{}
    const group=groups[prefix]??={key:null,count:0};group.count++;
    if(typeof key==='string'&&slotPrefix(key)===prefix)group.key=key;
  }
  return Object.fromEntries(Object.entries(groups).map(([prefix,{key,count}])=>[key??`未识别|名额 ${prefix}`,count]));
}
export function takeReopen(project,task,{env=process.env,now=Date.now()}={}){
  if(typeof task!=='string'||!/^\d+\.[^/\\\s]+\/T-\d+$/.test(task))throw new Error('autonomy_task_invalid');
  const dir=path.join(autonomyHome(env),REOPEN_DIR),key=reopenKey(project,task);
  // A count kept some other way is never taken as "none yet".
  if(fs.existsSync(path.join(autonomyHome(env),'autonomy-reopens.json')))throw new Error('autonomy_reopens_legacy');
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  for(let slot=1;slot<=AUTO_REOPEN_LIMIT;slot++){
    try{fs.writeFileSync(path.join(dir,`${slotPrefix(key)}-${slot}`),JSON.stringify({key,slot,at:new Date(now).toISOString()})+'\n',{flag:'wx',mode:0o600});}
    catch(error){if(error.code==='EEXIST')continue;throw error;}
    return {count:slot};
  }
  return {refused:true,count:AUTO_REOPEN_LIMIT};
}

const DOCUMENTS=['requirements.md','design.md','tasks.md'],CHANGEABLE=new Set(['design.md','tasks.md','test-cases.json']);
const userCases=source=>{
  if(source===undefined)return new Map();
  const cases=JSON.parse(source)?.cases;
  if(!Array.isArray(cases))throw new Error('cases');
  return new Map(cases.filter(item=>item?.origin==='user').map(item=>[item.id,JSON.stringify(item)]));
};

// Whether a change proposal may be approved under the standing authorization,
// judged from the complete before/after contents: it may change design, tasks and
// generated cases of existing features, never a requirement, the feature list or a
// user case. Returns null when it may, else the reason in plain words.
export function standingProposalProblem(before,proposal){
  if(!record(before)||!Array.isArray(before.directories)||!before.directories.every(dir=>typeof dir==='string')
    ||!record(before.files)||!Object.values(before.files).every(value=>typeof value==='string')
    ||!record(proposal)||!record(proposal.files)||!Object.keys(proposal.files).length
    ||!Object.values(proposal.files).every(value=>typeof value==='string')
    ||!Array.isArray(proposal.changedUserCases)||!Array.isArray(proposal.removed))return '提案内容不完整，无法判断';
  if(proposal.changedUserCases.length)return '提案删除或减弱了用户用例';
  if(proposal.removed.length)return '提案删除了功能';
  const features=new Set(Object.keys(proposal.files).map(file=>file.split('/')[0]));
  for(const feature of features){
    if(!before.directories.includes(feature))return '提案新增了功能';
    if(DOCUMENTS.some(name=>typeof proposal.files[`${feature}/${name}`]!=='string'))return '提案内容不完整，无法判断';
  }
  for(const [file,content] of Object.entries(proposal.files)){
    const [feature,name,...rest]=file.split('/');
    if(rest.length||!DOCUMENTS.includes(name)&&name!=='test-cases.json')return `提案改了规格以外的文件（${file}）`;
    if(content!==before.files[file]&&!CHANGEABLE.has(name))return '提案改了需求';
  }
  for(const feature of features){
    const file=`${feature}/test-cases.json`;
    let was,now;
    // A test-cases.json the proposal leaves out is deleted on save: its user cases count as removed.
    try{was=userCases(before.files[file]);now=userCases(proposal.files[file]);}
    catch{return '提案的测试用例无法解析';}
    for(const [id,item] of was)if(now.get(id)!==item)return '提案删除或减弱了用户用例';
  }
  return null;
}

// The saved archive (.reviews/prd-change-<digest>.json) must be this proposal and
// must be exactly what the specs now hold: features listed, proposal files written,
// every other feature untouched.
export function standingArchiveProblem(specsDir,archive,digest){
  if(!record(archive)||archive.proposal?.proposalDigest!==digest)return '找不到这份提案的归档';
  const problem=standingProposalProblem(archive.before,archive.proposal);
  if(problem)return problem;
  const {before,proposal}=archive;
  const listed=fs.readdirSync(specsDir).filter(dir=>/^\d+\./.test(dir)).sort();
  if(listed.join('\n')!==[...before.directories].sort().join('\n'))return '规格目录的功能与提案不一致';
  // What the save leaves (cm-prd change.mjs applyPrdChange): the selected features hold
  // exactly the proposal's files, every other feature its original ones. Compare the
  // complete spec file set, so a file the archive does not list cannot stay on disk.
  const selected=Array.isArray(archive.selected)?archive.selected:[...new Set(Object.keys(proposal.files).map(file=>file.split('/')[0]))];
  const expected={...before.files};
  for(const file of Object.keys(expected))if(selected.includes(file.split('/')[0]))delete expected[file];
  Object.assign(expected,proposal.files);
  const onDisk={};
  for(const dir of listed)for(const name of [...DOCUMENTS,'test-cases.json']){
    const file=`${dir}/${name}`;try{onDisk[file]=fs.readFileSync(path.join(specsDir,file),'utf8');}catch(error){if(error.code!=='ENOENT')return '规格文件与提案不一致';}
  }
  const files=Object.keys(expected).sort();
  if(files.join('\n')!==Object.keys(onDisk).sort().join('\n')||files.some(file=>onDisk[file]!==expected[file]))return '规格文件与提案不一致';
  return null;
}
