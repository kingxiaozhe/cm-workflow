// Minimal N3 handoff update for one runner-owned task Learning result.
import {createHash,randomUUID} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import childProcess from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {attachCmAiTaskLearningApplicationEvidence,attachCmAiTaskLearningEvidence,
  readCmAiTaskLearningApplication} from './cm-ai-context-refresh.mjs';
import {readCmAiProjectLearningWriteback} from './cm-ai-learning-writer.mjs';
import {arrayItems,digest,freeze,json,need,shape,text,validIdentity,validTaskLearningInput} from './effect-contract.mjs';

const LIMIT=256*1024,MiB=1024*1024;
const gate=fileURLToPath(new URL('../../../scripts/cm-task-gate.mjs',import.meta.url));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const statKey=stat=>[stat.dev,stat.ino,stat.mode,stat.nlink,stat.size,stat.mtimeNs,stat.ctimeNs].join(':');

function readHandoff(target) {
  let descriptor;
  try {
    const before=fs.lstatSync(target,{bigint:true});
    need(before.isFile()&&!before.isSymbolicLink()&&before.nlink===1n&&before.size<=BigInt(LIMIT),'handoff_unsafe');
    descriptor=fs.openSync(target,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));
    need(statKey(before)===statKey(fs.fstatSync(descriptor,{bigint:true})),'handoff_changed');
    const bytes=fs.readFileSync(descriptor);need(bytes.length===Number(before.size),'handoff_changed');
    const source=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
    const after=fs.fstatSync(descriptor,{bigint:true}),last=fs.lstatSync(target,{bigint:true});
    need(statKey(before)===statKey(after)&&statKey(before)===statKey(last),'handoff_changed');
    return {bytes,source,sha256:sha(bytes),mode:Number(before.mode&0o7777n),stat:before};
  } finally {if(descriptor!==undefined)fs.closeSync(descriptor);}
}

const sameSnapshot=(left,right)=>statKey(left.stat)===statKey(right.stat)&&left.sha256===right.sha256;

function validateHandoff(target,identity) {
  const result=childProcess.spawnSync(process.execPath,[gate,'validate-handoff','--handoff',target,
    '--task',identity.taskId,'--attempt',String(identity.attempt)],{encoding:'buffer',timeout:10000,maxBuffer:MiB});
  need(!result.error&&result.status===0&&result.signal===null&&Buffer.isBuffer(result.stdout)
    &&result.stdout.length<=MiB,'handoff_invalid');
}

export function writeCmAiTaskLearningHandoff(raw) {
  const input=json(raw,512*1024);
  shape(input,['handoffPath','feature','identity','learningInput','application','retrospective','writeback']);
  text(input.handoffPath);text(input.feature);validIdentity(input.identity);
  need(path.isAbsolute(input.handoffPath)&&path.resolve(input.handoffPath)===input.handoffPath,'unsupported_path');
  validTaskLearningInput(input.learningInput,input.identity,input.feature);
  readCmAiTaskLearningApplication(input.application);
  const writeback=readCmAiProjectLearningWriteback(input.writeback,
    {learningInput:input.learningInput,retrospective:input.retrospective});
  need(writeback.outcome!=='writeback_pending','handoff_invalid');

  const parent=path.dirname(input.handoffPath);
  need(fs.realpathSync(parent)===parent&&fs.lstatSync(parent).isDirectory(),'unsupported_path');
  const before=readHandoff(input.handoffPath);validateHandoff(input.handoffPath,input.identity);
  need(sameSnapshot(before,readHandoff(input.handoffPath)),'handoff_changed');
  let handoff;
  try {handoff=JSON.parse(before.source);}catch{need(false,'handoff_invalid');}
  const applied=attachCmAiTaskLearningApplicationEvidence({handoff,feature:input.feature,identity:input.identity,
    learningInput:input.learningInput,application:input.application});
  const attached=attachCmAiTaskLearningEvidence({handoff:applied,feature:input.feature,identity:input.identity,
    learningInput:input.learningInput,retrospective:input.retrospective});
  const changedFiles=arrayItems(attached.changed_files);for(const item of changedFiles)text(item);
  const includeAgents=writeback.outcome==='written';
  const next={...attached,changed_files:includeAgents&&!changedFiles.includes('AGENTS.md')
    ?[...changedFiles,'AGENTS.md']:changedFiles};
  const bytes=Buffer.from(`${JSON.stringify(next,null,2)}\n`);
  need(bytes.length<=LIMIT,'limit_exceeded');
  if(bytes.equals(before.bytes))return freeze({outcome:'unchanged',handoffSha256:before.sha256});

  const temporary=path.join(parent,`.${path.basename(input.handoffPath)}.cm-learning.${process.pid}.${randomUUID()}`);
  let descriptor,renamed=false;
  try {
    descriptor=fs.openSync(temporary,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL
      |(fs.constants.O_NOFOLLOW??0),before.mode);
    fs.fchmodSync(descriptor,before.mode);fs.writeFileSync(descriptor,bytes);fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);descriptor=undefined;
    need(sameSnapshot(before,readHandoff(input.handoffPath)),'handoff_changed');
    fs.renameSync(temporary,input.handoffPath);renamed=true;
    const directory=fs.openSync(parent,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));
    try{fs.fsyncSync(directory);}finally{fs.closeSync(directory);}
    const after=readHandoff(input.handoffPath);need(after.bytes.equals(bytes),'handoff_write_failed');
    validateHandoff(input.handoffPath,input.identity);
    need(sameSnapshot(after,readHandoff(input.handoffPath)),'handoff_changed');
    return freeze({outcome:'written',handoffSha256:after.sha256});
  } finally {
    if(descriptor!==undefined)try{fs.closeSync(descriptor);}catch{}
    if(!renamed)try{fs.unlinkSync(temporary);}catch{}
  }
}

export function verifyCmAiTaskLearningHandoff(raw) {
  const input=json(raw,512*1024);
  const hasApplication=Object.hasOwn(input,'application');
  shape(input,['handoffPath','feature','identity','learningInput',...(hasApplication?['application']:[]),
    'retrospective','writeback']);
  text(input.handoffPath);text(input.feature);validIdentity(input.identity);
  need(path.isAbsolute(input.handoffPath)&&path.resolve(input.handoffPath)===input.handoffPath,'unsupported_path');
  validTaskLearningInput(input.learningInput,input.identity,input.feature);
  if(hasApplication)readCmAiTaskLearningApplication(input.application);
  const writeback=readCmAiProjectLearningWriteback(input.writeback,
    {learningInput:input.learningInput,retrospective:input.retrospective});
  need(writeback.outcome!=='writeback_pending','handoff_invalid');
  const parent=path.dirname(input.handoffPath);
  need(fs.realpathSync(parent)===parent&&fs.lstatSync(parent).isDirectory(),'unsupported_path');
  const before=readHandoff(input.handoffPath);validateHandoff(input.handoffPath,input.identity);
  need(sameSnapshot(before,readHandoff(input.handoffPath)),'handoff_changed');
  let handoff;
  try {handoff=JSON.parse(before.source);}catch{need(false,'handoff_invalid');}
  if(!hasApplication){const evidence=arrayItems(handoff.evidence);for(const item of evidence)text(item);
    need(!evidence.some(item=>item.startsWith('cm-learning-application-v1:')),'handoff_invalid');}
  const applied=hasApplication?attachCmAiTaskLearningApplicationEvidence({handoff,feature:input.feature,
    identity:input.identity,learningInput:input.learningInput,application:input.application}):handoff;
  const attached=attachCmAiTaskLearningEvidence({handoff:applied,feature:input.feature,identity:input.identity,
    learningInput:input.learningInput,retrospective:input.retrospective});
  need(digest(attached)===digest(handoff),'handoff_invalid');
  const changedFiles=arrayItems(handoff.changed_files);for(const item of changedFiles)text(item);
  if(writeback.outcome==='written')need(changedFiles.includes('AGENTS.md'),'handoff_invalid');
  return freeze({outcome:'matched',handoffSha256:before.sha256});
}
