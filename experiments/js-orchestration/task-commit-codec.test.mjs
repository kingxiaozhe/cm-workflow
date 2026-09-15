import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {digest} from './effect-contract.mjs';
import {planBytes,readCommitIntent,readCommitResult} from './task-commit-codec.mjs';

const sha=b=>createHash('sha256').update(b).digest('hex');
// Synthetic protocol vectors, not task-write or reviewer authority.
function vector(){
  const owner={tasksPath:'/fixture/specs/login/tasks.md',feature:'login',specsRoot:'/fixture/specs'};
  const identity={repositoryId:'fixture',runId:'codec',taskId:'T-001',attempt:1};
  const fingerprints={workflow:digest('wf'),config:digest('cfg'),inputs:digest('in')};
  const before=Buffer.from('- [ ] T-001: 中文\r\n'),after=Buffer.from('- [x] T-001: 中文\r\n');
  const body={version:1,protocol:'cm-mark-done-plan',feature:'login',taskId:'T-001',attempt:1,tasksPath:owner.tasksPath,
    mode:0o640,beforeBase64:before.toString('base64'),afterBase64:after.toString('base64'),
    beforeDigest:sha(before),afterDigest:sha(after),taskRevision:digest('revision'),
    evidence:[{path:'/fixture/specs/.reviews/\uE000',revision:digest('a')},{path:'/fixture/specs/.reviews/😀',revision:digest('b')}]};
  const plan={...body,planDigest:digest(body)};
  const intent={version:1,protocol:'cm-task-commit',type:'intent',identity,owner,fingerprints,plan,
    proof:{root:'/fixture/code',baselineDigest:digest('baseline'),packageDigest:digest('package'),receiptDigest:digest('receipt'),checksDigest:digest('checks')},
    parent:{path:'/fixture/specs/login',dev:'1',ino:'9007199254740993',mode:0o755},temporaryName:'.cm-task.12345678-1234-4567-89ab-123456789abc.tmp'};
  const intentDigest=digest('global record'),result={version:1,protocol:'cm-task-commit',type:'result',intentDigest,planDigest:plan.planDigest,outcome:'fixture_committed'};
  return {owner,identity,fingerprints,before,after,plan,intent,intentDigest,result};
}
test('C3a pure commit codec keeps C2b bytes/shape/global references',()=>{
  const v=vector(),expected={owner:v.owner,identity:v.identity,fingerprints:v.fingerprints};
  assert.deepEqual(planBytes(v.plan),{before:v.before,after:v.after});
  assert.deepEqual(readCommitIntent(v.intent,expected),v.intent);
  assert.deepEqual(readCommitResult(v.result,{intentDigest:v.intentDigest,planDigest:v.plan.planDigest}),v.result);
  assert(Object.isFrozen(readCommitIntent(v.intent,expected)));
});
const mutations={
  'protocol':v=>v.intent.protocol='other',
  'extra':v=>v.intent.extra=true,
  'identity':v=>v.intent.identity.taskId='other',
  'owner':v=>v.intent.owner.feature='other',
  'fingerprints':v=>v.intent.fingerprints.config='bad',
  'parent':v=>v.intent.parent.path='/fixture/specs',
  'parent integer':v=>v.intent.parent.ino=9007199254740992,
  'parent mode':v=>v.intent.parent.mode=-1,
  'temporary':v=>v.intent.temporaryName='../temporary',
  'overlap':v=>v.intent.proof.root='/fixture/specs/code',
  'proof':v=>v.intent.proof.receiptDigest='bad',
  'plan digest':v=>v.intent.plan.planDigest=digest('other'),
  'path':v=>v.intent.plan.tasksPath='/fixture/specs/login/../tasks.md',
  'result target':v=>v.result.intentDigest=digest('other'),
  'result plan':v=>v.result.planDigest=digest('other'),
  'result outcome':v=>v.result.outcome='completed',
};
for(const [name,mutate] of Object.entries(mutations))test(`C3a commit codec refuses ${name}`,()=>{
  const v=vector(),expected=structuredClone({owner:v.owner,identity:v.identity,fingerprints:v.fingerprints});mutate(v);
  assert.throws(()=>name.startsWith('result')?readCommitResult(v.result,{intentDigest:v.intentDigest,planDigest:v.plan.planDigest}):readCommitIntent(v.intent,expected));
});
for(const name of ['unchanged','two changes','bad Base64','raw hash','UTF16 ordering','oversize','evidence duplicates'])
test(`C3a plan codec refuses ${name} even with new plan digest`,()=>{
  const v=vector(),p=v.plan;
  if(name==='unchanged'){p.afterBase64=p.beforeBase64;p.afterDigest=p.beforeDigest;}
  if(name==='two changes'){const b=Buffer.from(p.afterBase64,'base64');b[0]=88;p.afterBase64=b.toString('base64');p.afterDigest=sha(b);}
  if(name==='bad Base64')p.beforeBase64+='\n';
  if(name==='raw hash')p.beforeDigest=digest('other');
  if(name==='UTF16 ordering')p.evidence.reverse();
  if(name==='oversize'){const b=Buffer.alloc(256*1024+1);p.beforeBase64=b.toString('base64');p.beforeDigest=sha(b);}
  if(name==='evidence duplicates')p.evidence[1]=structuredClone(p.evidence[0]);
  const {planDigest,...body}=p;p.planDigest=digest(body);assert.throws(()=>planBytes(p));
});
