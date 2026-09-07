import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {digest} from './effect-contract.mjs';
import {createCmAiTaskLearningRetrospective} from './cm-ai-context-refresh.mjs';

const identity={repositoryId:'fixture',runId:'learning-writer',taskId:'T-001',attempt:1};
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const fixture=async fn=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-learning-writer-')));
  try{return await fn(root);}finally{fs.rmSync(root,{recursive:true,force:true});}
};
const input=(root,{source=null,status='lesson_candidate',classification='structured'}={})=>{
  const target=path.join(root,'AGENTS.md');
  if(source!==null)fs.writeFileSync(target,source,{mode:0o640});
  const learningFiles=source===null?[]:[{scope:'project',path:'AGENTS.md',sha256:sha(Buffer.from(source))}];
  const learningDigest=digest({version:1,feature:'1.login',identity,files:learningFiles});
  const learningInput={version:1,workflow:'cm-ai',phase:'task_learning_input',feature:'1.login',identity,
    learningDigest,learningFiles};
  const candidates=status==='no_new_lesson'?[]:[{classification,trigger:'Snapshot changes during task closeout',
    action:'Stop before replacing user instructions',evidence:['experiments/js-orchestration/task-runner.test.mjs']}];
  const retrospective=createCmAiTaskLearningRetrospective({feature:'1.login',identity,learningDigest,status,
    candidates,reason:status==='writeback_pending'?'AGENTS.md changed concurrently':null});
  return {target,learningInput,retrospective};
};

test('F05 Learning writer leaves disk untouched when there is no new lesson',()=>fixture(async root=>{
  const {writeCmAiProjectLearning}=await import('./cm-ai-learning-writer.mjs').catch(()=>({}));
  const data=input(root,{status:'no_new_lesson'});
  const result=writeCmAiProjectLearning({codeProject:root,learningInput:data.learningInput,
    retrospective:data.retrospective});
  assert.equal(result.outcome,'no_new_lesson');assert.equal(result.changed,false);
  assert.equal(result.agentsFile,null);assert(!fs.existsSync(data.target));
}));

test('F05 Learning writer preserves content and inserts candidates in the project lesson section',()=>fixture(async root=>{
  const {writeCmAiProjectLearning}=await import('./cm-ai-learning-writer.mjs').catch(()=>({}));
  const source='# Rules\n\n## 项目教训\n\n- existing\n\n## Later\n\nkeep\n',data=input(root,{source});
  const beforeMode=fs.statSync(data.target).mode&0o7777;
  const result=writeCmAiProjectLearning({codeProject:root,learningInput:data.learningInput,
    retrospective:data.retrospective});
  const written=fs.readFileSync(data.target,'utf8');
  assert.equal(result.outcome,'written');assert.equal(result.changed,true);
  assert(written.startsWith('# Rules\n\n## 项目教训\n'));assert(written.endsWith('## Later\n\nkeep\n'));
  assert(written.indexOf('Snapshot changes')<written.indexOf('## Later'));
  assert.match(written,/\[已结构化\].*cm-learning-v1:[a-f0-9]{64}/);
  assert.equal(fs.statSync(data.target).mode&0o7777,beforeMode);
  assert.equal(result.agentsFile.sha256,sha(fs.readFileSync(data.target)));
}));

test('F05 Learning writer deduplicates replay without rewriting bytes',()=>fixture(async root=>{
  const {writeCmAiProjectLearning}=await import('./cm-ai-learning-writer.mjs').catch(()=>({}));
  const data=input(root,{source:'# Rules\n'}),request={codeProject:root,learningInput:data.learningInput,
    retrospective:data.retrospective};
  const first=writeCmAiProjectLearning(request),bytes=fs.readFileSync(data.target),stat=fs.statSync(data.target);
  const nextInput={...data.learningInput,learningFiles:[{scope:'project',path:'AGENTS.md',sha256:sha(bytes)}]};
  nextInput.learningDigest=digest({version:1,feature:nextInput.feature,identity,files:nextInput.learningFiles});
  const nextRetrospective=createCmAiTaskLearningRetrospective({feature:'1.login',identity,
    learningDigest:nextInput.learningDigest,status:'lesson_candidate',candidates:data.retrospective.candidates,reason:null});
  const second=writeCmAiProjectLearning({codeProject:root,learningInput:nextInput,retrospective:nextRetrospective});
  assert.equal(first.outcome,'written');assert.equal(second.outcome,'deduplicated');assert.equal(second.changed,false);
  assert(fs.readFileSync(data.target).equals(bytes));assert.equal(fs.statSync(data.target).ino,stat.ino);
}));

test('F05 Learning writer creates only the minimal lesson section when AGENTS is absent',()=>fixture(async root=>{
  const {writeCmAiProjectLearning}=await import('./cm-ai-learning-writer.mjs').catch(()=>({}));
  const data=input(root,{classification:'memory_only'});
  const result=writeCmAiProjectLearning({codeProject:root,learningInput:data.learningInput,
    retrospective:data.retrospective});
  assert.equal(result.outcome,'written');assert.equal(result.changed,true);
  const written=fs.readFileSync(data.target,'utf8');
  assert(written.startsWith('## 项目教训\n\n'));assert.match(written,/\[仅记忆\]/);
}));

test('F05 Learning writer returns pending for stale, symlink, write failure, or already-pending input',()=>fixture(async root=>{
  const {writeCmAiProjectLearning}=await import('./cm-ai-learning-writer.mjs').catch(()=>({}));
  const stale=input(root,{source:'# Rules\n'});fs.writeFileSync(stale.target,'changed\n');
  let result=writeCmAiProjectLearning({codeProject:root,learningInput:stale.learningInput,
    retrospective:stale.retrospective});
  assert.equal(result.outcome,'writeback_pending');assert.equal(fs.readFileSync(stale.target,'utf8'),'changed\n');
  fs.unlinkSync(stale.target);fs.writeFileSync(path.join(root,'retained'),'safe\n');fs.symlinkSync('retained',stale.target);
  result=writeCmAiProjectLearning({codeProject:root,learningInput:stale.learningInput,
    retrospective:stale.retrospective});
  assert.equal(result.outcome,'writeback_pending');assert(fs.lstatSync(stale.target).isSymbolicLink());
  fs.unlinkSync(stale.target);const pending=input(root,{status:'writeback_pending'});
  result=writeCmAiProjectLearning({codeProject:root,learningInput:pending.learningInput,
    retrospective:pending.retrospective});
  assert.equal(result.outcome,'writeback_pending');assert(!fs.existsSync(pending.target));
  const candidate=input(root),open=fs.openSync;
  try{fs.openSync=(target,...args)=>{if(String(target).includes('.AGENTS.md.cm-learning.'))
    throw Object.assign(Error('fixture full'),{code:'ENOSPC'});return open(target,...args);};
    result=writeCmAiProjectLearning({codeProject:root,learningInput:candidate.learningInput,
      retrospective:candidate.retrospective});
  }finally{fs.openSync=open;}
  assert.equal(result.outcome,'writeback_pending');assert.equal(result.reason,'agents_write_failed');
  assert(!fs.existsSync(candidate.target));
}));

test('F05 Learning writer detects a concurrent edit before rename and leaves no temporary file',()=>fixture(async root=>{
  const {writeCmAiProjectLearning}=await import('./cm-ai-learning-writer.mjs').catch(()=>({}));
  const data=input(root,{source:'# Rules\n'}),write=fs.writeFileSync;let injected=false;
  try{
    fs.writeFileSync=(target,...args)=>{const result=write(target,...args);
      if(typeof target==='number'&&!injected){injected=true;write(data.target,'concurrent\n');}return result;};
    const outcome=writeCmAiProjectLearning({codeProject:root,learningInput:data.learningInput,
      retrospective:data.retrospective});
    assert.equal(outcome.outcome,'writeback_pending');assert.equal(fs.readFileSync(data.target,'utf8'),'concurrent\n');
  }finally{fs.writeFileSync=write;}
  assert(!fs.readdirSync(root).some(name=>name.startsWith('.AGENTS.md.cm-learning.')));
}));
