// Internal pure C2b payload validation. No filesystem or approval authority.
import path from 'node:path';
import {createHash} from 'node:crypto';
import {need,shape,hex,json,digest,validIdentity} from './effect-contract.mjs';
import {reviewSpecsPath} from './review-package.mjs';
const FILE_LIMIT=256*1024,sha=b=>createHash('sha256').update(b).digest('hex');
const same=(a,b)=>need(digest(a)===digest(b),'commit_history_invalid');
const absolute=p=>need(typeof p==='string'&&!p.includes('\0')&&path.isAbsolute(p)&&path.resolve(p)===p,'unsupported_path');
function base64(s){
  need(typeof s==='string'&&s.length<=Math.ceil(FILE_LIMIT/3)*4,'limit_exceeded');
  const b=Buffer.from(s,'base64');need(b.length<=FILE_LIMIT&&b.toString('base64')===s,'invalid_plan');return b;
}
export function planBytes(raw){
  const p=json(raw);
  shape(p,['version','protocol','feature','taskId','attempt','tasksPath','mode','beforeBase64','afterBase64',
    'beforeDigest','afterDigest','taskRevision','evidence','planDigest']);
  need(p.version===1&&p.protocol==='cm-mark-done-plan'&&typeof p.feature==='string'&&p.feature.length>0,'invalid_plan');
  validIdentity({repositoryId:'plan',runId:'plan',taskId:p.taskId,attempt:p.attempt});absolute(p.tasksPath);
  need(Number.isInteger(p.mode)&&p.mode>=0&&p.mode<=0o7777,'invalid_plan');
  for(const k of ['beforeDigest','afterDigest','taskRevision','planDigest'])hex(p[k]);
  need(Array.isArray(p.evidence)&&p.evidence.length>0&&p.evidence.length<=4,'invalid_plan');
  let previous;
  for(const e of p.evidence){shape(e,['path','revision']);absolute(e.path);hex(e.revision);
    need(previous===undefined||Buffer.compare(Buffer.from(previous),Buffer.from(e.path))<0,'invalid_plan');previous=e.path;}
  const {planDigest,...body}=p;need(digest(body)===planDigest,'invalid_plan');
  const before=base64(p.beforeBase64),after=base64(p.afterBase64);
  need(sha(before)===p.beforeDigest&&sha(after)===p.afterDigest,'invalid_plan');
  need(!before.equals(after),'task_already_marked');need(before.length===after.length,'invalid_plan');
  let changes=0;for(let n=0;n<before.length;n++)if(before[n]!==after[n]){
    need(before[n]===32&&after[n]===120,'invalid_plan');changes++;}
  need(changes===1,'invalid_plan');return {before,after};
}
export function readCommitIntent(raw,{owner,identity,fingerprints}){
  const p=json(raw);
  shape(p,['version','protocol','type','identity','owner','fingerprints','plan','proof','parent','temporaryName']);
  need(p.version===1&&p.protocol==='cm-task-commit'&&p.type==='intent','commit_history_invalid');
  validIdentity(p.identity);same(p.identity,identity);same(p.owner,owner);same(p.fingerprints,fingerprints);
  planBytes(p.plan);need(p.plan.feature===owner.feature&&p.plan.tasksPath===owner.tasksPath
    &&p.plan.taskId===p.identity.taskId&&p.plan.attempt===p.identity.attempt,'commit_history_invalid');
  shape(p.proof,['root','baselineDigest','packageDigest','receiptDigest','checksDigest']);absolute(p.proof.root);
  for(const k of ['baselineDigest','packageDigest','receiptDigest','checksDigest'])hex(p.proof[k]);
  reviewSpecsPath(p.proof.root,owner.specsRoot);
  shape(p.parent,['path','dev','ino','mode']);need(p.parent.path===path.dirname(owner.tasksPath)
    &&[p.parent.dev,p.parent.ino].every(n=>typeof n==='string'&&/^(0|[1-9][0-9]*)$/.test(n))
    &&Number.isInteger(p.parent.mode)&&p.parent.mode>=0&&p.parent.mode<=0o7777,'commit_history_invalid');
  need(typeof p.temporaryName==='string'&&/^\.cm-task\.[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.tmp$/.test(p.temporaryName),'commit_history_invalid');
  return p;
}
export function readCommitResult(raw,{intentDigest,planDigest}){
  const p=json(raw);shape(p,['version','protocol','type','intentDigest','planDigest','outcome']);
  need(p.version===1&&p.protocol==='cm-task-commit'&&p.type==='result'&&p.intentDigest===intentDigest
    &&p.planDigest===planDigest&&p.outcome==='fixture_committed','commit_history_invalid');
  hex(p.intentDigest);hex(p.planDigest);return p;
}
