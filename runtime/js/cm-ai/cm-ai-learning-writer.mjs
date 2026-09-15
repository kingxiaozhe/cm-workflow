// Minimal project AGENTS.md writeback for the task-level Learning loop.
import {createHash,randomUUID} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {digest,freeze,hex,json,need,shape,text,validIdentity,validTaskLearningInput} from './effect-contract.mjs';
import {encodeCmAiTaskLearningEvidence,readLearningRetrospectiveContent} from './cm-ai-context-refresh.mjs';

const LIMIT=256*1024,PREFIX='cm-learning-retrospective-v1:';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const statKey=stat=>[stat.dev,stat.ino,stat.mode,stat.nlink,stat.size,stat.mtimeNs,stat.ctimeNs].join(':');
const inline=value=>value.replace(/([\\`*_\[\]<>])/gu,'\\$1');

function canonicalRetrospective(raw) {
  const encoded=encodeCmAiTaskLearningEvidence(raw);
  return json(JSON.parse(encoded.slice(PREFIX.length)),16*1024);
}

function readAgents(target) {
  let descriptor;
  try {
    const before=fs.lstatSync(target,{bigint:true});
    need(before.isFile()&&!before.isSymbolicLink()&&before.nlink===1n&&before.size<=BigInt(LIMIT),'agents_unsafe');
    descriptor=fs.openSync(target,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));
    need(statKey(before)===statKey(fs.fstatSync(descriptor,{bigint:true})),'agents_changed');
    const bytes=fs.readFileSync(descriptor);need(bytes.length===Number(before.size),'agents_changed');
    new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
    const after=fs.fstatSync(descriptor,{bigint:true}),last=fs.lstatSync(target,{bigint:true});
    need(statKey(before)===statKey(after)&&statKey(before)===statKey(last),'agents_changed');
    return {exists:true,bytes,sha256:sha(bytes),mode:Number(before.mode&0o7777n),stat:before};
  } catch(error) {
    if(error?.code==='ENOENT')return {exists:false,bytes:Buffer.alloc(0),sha256:null,mode:0o644,stat:null};
    throw error;
  } finally {if(descriptor!==undefined)fs.closeSync(descriptor);}
}

const sameSnapshot=(left,right)=>left.exists===right.exists&&(!left.exists||
  statKey(left.stat)===statKey(right.stat)&&left.sha256===right.sha256);

function renderedCandidates(retrospective) {
  return retrospective.candidates.map(candidate=>{
    const marker=digest({version:1,trigger:candidate.trigger,action:candidate.action});
    const classification=candidate.classification==='structured'?'[已结构化]':'[仅记忆]';
    const source=`${retrospective.feature}/${retrospective.identity.taskId}/a${retrospective.identity.attempt}`;
    return {marker:`<!-- cm-learning-v1:${marker} -->`,line:`- **${inline(candidate.trigger)}**：${inline(candidate.action)}`+
      `。来源：${inline(source)}；证据：${candidate.evidence.map(inline).join('、')}。${classification} `+
      `<!-- cm-learning-v1:${marker} -->`};
  });
}

export function mergeLessons(source,retrospective) {
  const candidates=renderedCandidates(retrospective).filter(candidate=>!source.includes(candidate.marker));
  if(candidates.length===0)return source;
  const newline=source.includes('\r\n')?'\r\n':'\n',block=candidates.map(candidate=>candidate.line).join(newline);
  const header=/^## 项目教训[ \t]*\r?$/gmu.exec(source);
  if(!header){let prefix=source;if(prefix.length&&!prefix.endsWith(newline))prefix+=newline;
    if(prefix.length&&!prefix.endsWith(newline+newline))prefix+=newline;
    return `${prefix}## 项目教训${newline}${newline}${block}${newline}`;}
  const headings=/^## [^\r\n]+\r?$/gmu;headings.lastIndex=header.index+header[0].length;
  const next=headings.exec(source),insertAt=next?.index??source.length;
  let before=source.slice(0,insertAt);const after=source.slice(insertAt);
  if(!before.endsWith(newline))before+=newline;
  if(!before.endsWith(newline+newline))before+=newline;
  return `${before}${block}${newline}${after?newline:''}${after}`;
}

function result(retrospective,outcome,changed,agentsFile,reason) {
  const body={version:1,workflow:'cm-ai',phase:'task_learning_writeback',feature:retrospective.feature,
    identity:retrospective.identity,learningDigest:retrospective.learningDigest,
    retrospectiveDigest:retrospective.retrospectiveDigest,outcome,changed,agentsFile,reason};
  return freeze({...body,writebackDigest:digest(body)});
}

export function readCmAiProjectLearningWriteback(raw,{learningInput,retrospective}) {
  validTaskLearningInput(learningInput,learningInput.identity,learningInput.feature);
  const canonical=canonicalRetrospective(retrospective),value=json(raw,64*1024);
  shape(value,['version','workflow','phase','feature','identity','learningDigest','retrospectiveDigest',
    'outcome','changed','agentsFile','reason','writebackDigest']);
  need(value.version===1&&value.workflow==='cm-ai'&&value.phase==='task_learning_writeback');
  need(value.feature===learningInput.feature&&digest(value.identity)===digest(learningInput.identity)
    &&value.learningDigest===learningInput.learningDigest&&value.retrospectiveDigest===canonical.retrospectiveDigest,
  'identity_mismatch');
  [value.learningDigest,value.retrospectiveDigest,value.writebackDigest].forEach(hex);
  if(value.agentsFile!==null){shape(value.agentsFile,['scope','path','sha256']);
    need(value.agentsFile.scope==='project'&&value.agentsFile.path==='AGENTS.md');hex(value.agentsFile.sha256);}
  if(value.reason!==null){text(value.reason);need(value.reason.length<=512&&!/[\0\r\n\u2028\u2029]/u.test(value.reason));}
  need(['no_new_lesson','written','deduplicated','writeback_pending'].includes(value.outcome));
  const expectedAgents=learningInput.learningFiles.find(file=>file.scope==='project'&&file.path==='AGENTS.md')??null;
  if(value.outcome==='no_new_lesson')need(canonical.status==='no_new_lesson'&&value.changed===false&&value.reason===null
    &&digest(value.agentsFile)===digest(expectedAgents));
  else if(value.outcome==='written')need(canonical.status==='lesson_candidate'&&value.changed===true
    &&value.agentsFile!==null&&value.reason===null);
  else if(value.outcome==='deduplicated')need(canonical.status==='lesson_candidate'&&value.changed===false
    &&value.agentsFile!==null&&value.reason===null);
  else if(canonical.status==='writeback_pending')need(value.changed===null&&value.reason===canonical.reason
    &&digest(value.agentsFile)===digest(expectedAgents));
  else need(canonical.status==='lesson_candidate'&&value.changed===null
    &&['agents_changed','agents_unsafe','agents_too_large','agents_write_failed'].includes(value.reason));
  const {writebackDigest,...body}=value;need(digest(body)===writebackDigest,'writeback_mismatch');
  return freeze(value);
}

export function writeCmAiProjectLearning(raw,bootstrapAgentsSha256=null) {
  const input=json(raw,256*1024);shape(input,['codeProject','learningInput','retrospective']);
  text(input.codeProject);need(path.isAbsolute(input.codeProject)&&path.resolve(input.codeProject)===input.codeProject);
  validTaskLearningInput(input.learningInput,input.learningInput.identity,input.learningInput.feature);
  const retrospective=canonicalRetrospective(input.retrospective);
  need(retrospective.feature===input.learningInput.feature
    &&digest(retrospective.identity)===digest(input.learningInput.identity)
    &&retrospective.learningDigest===input.learningInput.learningDigest,'identity_mismatch');
  // Only the runner supplies a hash from its validated host bootstrap result.
  // The Learning identity/digest still describes the original task-start read.
  if(bootstrapAgentsSha256!==null){need(input.learningInput.feature==='0.bootstrap','bootstrap_task_required');hex(bootstrapAgentsSha256);}
  const expected=bootstrapAgentsSha256===null
    ?input.learningInput.learningFiles.find(file=>file.scope==='project'&&file.path==='AGENTS.md')??null
    :{scope:'project',path:'AGENTS.md',sha256:bootstrapAgentsSha256};
  if(retrospective.status==='no_new_lesson')return result(retrospective,'no_new_lesson',false,
    input.learningInput.learningFiles.find(file=>file.scope==='project'&&file.path==='AGENTS.md')??null,null);
  return writeLearningContent(input.codeProject,expected,retrospective,
    (outcome,changed,agentsFile,reason)=>result(retrospective,outcome,changed,agentsFile,reason));
}

// Shared file operation only. Callers retain workflow identity, authorization,
// registration, evidence binding and completion ownership.
export function writeProjectLearningContent(raw){
  const input=json(raw,64*1024);shape(input,['codeProject','expected','identity','feature','content']);
  text(input.codeProject);need(path.isAbsolute(input.codeProject)&&path.resolve(input.codeProject)===input.codeProject);
  validIdentity(input.identity);text(input.feature);
  need(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(input.feature),'invalid_feature');
  if(input.expected!==null){shape(input.expected,['scope','path','sha256']);
    need(input.expected.scope==='project'&&input.expected.path==='AGENTS.md');hex(input.expected.sha256);}
  const content=readLearningRetrospectiveContent(input.content);
  return writeLearningContent(input.codeProject,input.expected,{...content,identity:input.identity,feature:input.feature},
    (outcome,changed,agentsFile,reason)=>freeze({outcome,changed,agentsFile,reason}));
}

function writeLearningContent(codeProject,expected,retrospective,makeResult){
  const input={codeProject};
  const result=(_retrospective,...fields)=>makeResult(...fields);
  if(retrospective.status==='no_new_lesson')return result(retrospective,'no_new_lesson',false,expected,null);
  if(retrospective.status==='writeback_pending')return result(retrospective,'writeback_pending',null,expected,retrospective.reason);
  let root,target,before;
  try {
    const rootStat=fs.lstatSync(input.codeProject);root=fs.realpathSync(input.codeProject);
    need(rootStat.isDirectory()&&!rootStat.isSymbolicLink()&&root===input.codeProject,'agents_unsafe');
    target=path.join(root,'AGENTS.md');before=readAgents(target);
    need(before.exists===Boolean(expected)&&(!expected||before.sha256===expected.sha256),'agents_changed');
  } catch(error) {
    return result(retrospective,'writeback_pending',null,expected,error?.code==='agents_changed'?'agents_changed':'agents_unsafe');
  }
  const source=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(before.bytes),next=mergeLessons(source,retrospective);
  if(next===source)return result(retrospective,'deduplicated',false,
    before.exists?{scope:'project',path:'AGENTS.md',sha256:before.sha256}:null,null);
  const bytes=Buffer.from(next);if(bytes.length>LIMIT)return result(retrospective,'writeback_pending',null,expected,'agents_too_large');
  const temporary=path.join(root,`.AGENTS.md.cm-learning.${process.pid}.${randomUUID()}`);let descriptor,renamed=false;
  try {
    descriptor=fs.openSync(temporary,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL
      |(fs.constants.O_NOFOLLOW??0),before.mode);
    fs.fchmodSync(descriptor,before.mode);fs.writeFileSync(descriptor,bytes);fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);descriptor=undefined;
    need(sameSnapshot(before,readAgents(target)),'agents_changed');
    fs.renameSync(temporary,target);renamed=true;
    const directory=fs.openSync(root,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));
    try{fs.fsyncSync(directory);}finally{fs.closeSync(directory);}
    const after=readAgents(target);need(after.bytes.equals(bytes),'agents_write_failed');
    return result(retrospective,'written',true,{scope:'project',path:'AGENTS.md',sha256:after.sha256},null);
  } catch(error) {
    if(descriptor!==undefined)try{fs.closeSync(descriptor);}catch{}
    if(!renamed)try{fs.unlinkSync(temporary);}catch{}
    const reason=error?.code==='agents_changed'?'agents_changed':'agents_write_failed';
    return result(retrospective,'writeback_pending',null,null,reason);
  }
}
