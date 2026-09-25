// Host-only initial handoff producer. It grants no review or completion authority.
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {createReviewPackage,verifyReviewPackage} from './review-package.mjs';
import {supersedeWorkflowFile} from './review-evidence-file.mjs';
import {implementationSha256,loadHandoff} from '../../../scripts/cm-task-gate.mjs';
import {digest,json,shape,text,need} from './effect-contract.mjs';

export const REVIEWED_HANDOFF_HINT='仅 QA 卡住时，配置错误用 --revise-qa-config PREVIOUS.json --qa-config-revision-reason … 恢复原运行，宿主或环境证据不足用 --rerun-blocked-qa。确需重跑任务时，用 --supersede-reviewed-evidence --supersede-reason … 新建运行。';
function reviewedHandoffConflict(){
  const error=new Error('handoff_exists');error.code='handoff_exists';error.reason=REVIEWED_HANDOFF_HINT;throw error;
}

function prepareHostHandoff(raw){
  const input=json(raw,16*1024*1024);
  shape(input,['root','baseline','checks','handoffPath',...(Object.hasOwn(input,'evidence')?['evidence']:[])]);
  const evidence=input.evidence??[];
  need(Array.isArray(evidence)&&evidence.length<=32,'invalid_handoff_evidence');
  for(const item of evidence)text(item);
  const {root,baseline,checks,handoffPath}=input;
  text(handoffPath);
  need(path.isAbsolute(handoffPath)&&path.resolve(handoffPath)===handoffPath,'unsupported_path');
  const parent=path.dirname(handoffPath);
  need(fs.realpathSync(parent)===parent&&fs.lstatSync(parent).isDirectory(),'unsupported_path');
  const reviewPackage=createReviewPackage({root,baseline,checks});
  const changedFiles=reviewPackage.changes.map(change=>change.path);
  const passed=checks.every(check=>check.outcome==='passed');
  const payload={schema_version:1,task_id:baseline.identity.taskId,attempt:baseline.identity.attempt,
    status:passed?'ready_for_review':'blocked',changed_files:changedFiles,
    implementation_sha256:implementationSha256(root,changedFiles),
    verification:checks.map(check=>({command:check.kind==='visual'
      ?`Visual inspection (not a shell command): ${check.before.kind} before/after comparison`
      :JSON.stringify(check.command),
      status:check.outcome==='passed'?'passed':'failed',evidence:check.evidence})),
    evidence:[`host review package ${reviewPackage.packageDigest}`,...evidence],
    blockers:passed?[]:checks.filter(check=>check.outcome!=='passed').map(check=>`check ${check.id}: ${check.outcome}`),
    scope_deviation:[]};
  const bytes=Buffer.from(JSON.stringify(payload,null,2)+'\n');
  need(bytes.length<=256*1024,'limit_exceeded');
  return {root,baseline,checks,handoffPath,parent,reviewPackage,changedFiles,payload,bytes};
}

// Same serialization as publication, without creating files or registering work.
export function checkHostHandoffSize(raw){prepareHostHandoff(raw);}

export function verifyHostHandoff(raw){
  const {root,baseline,checks,handoffPath,reviewPackage,payload}=prepareHostHandoff(raw);
  const bound=createReviewPackage({root,baseline,checks,handoffPath});
  const actual=loadHandoff(handoffPath,{task:baseline.identity.taskId,attempt:baseline.identity.attempt});
  need(digest(actual)===digest(payload),'handoff_content_mismatch');
  verifyReviewPackage({root,baseline,checks,reviewPackage:bound,expectedDigest:bound.packageDigest,handoffPath});
  return {outcome:'matched',handoffSha256:bound.handoff.sha256,packageDigest:reviewPackage.packageDigest};
}

// A handoff a review already consumed is approval evidence and is never replaced.
// One left by a run that died before review is not: it must not block every retry
// of the same task forever. The receipt names the handoff it reviewed, so the two
// cases are distinguishable without guessing from timestamps or run identity.
function reviewConsumedHandoff(parent,name,attempt){
  const suffix=`-a${attempt}-handoff.json`;
  if(!name.endsWith(suffix))return true;
  const receipt=path.join(parent,`${name.slice(0,-suffix.length)}-r${attempt}.md`);
  let body;
  try{
    const info=fs.lstatSync(receipt);
    // Receipts are written under a 256 KiB cap. Anything larger is not one, and
    // guessing about it must not license replacing approval evidence.
    if(!info.isFile()||info.isSymbolicLink()||info.size>256*1024)return true;
    body=fs.readFileSync(receipt,'utf8');
  }catch(error){
    if(error.code==='ENOENT')return false;
    throw error;
  }
  // Search the real front matter rather than a fixed line count: the scope list
  // after handoff: is as long as the task's changed file list, so any reordering
  // of these fields would silently push handoff: out of a fixed window and turn
  // reviewed evidence into a supersedable leftover. Unterminated or unrecognised
  // front matter fails closed.
  const lines=body.split('\n');
  if(lines[0]?.trim()!=='---')return true;
  const end=lines.findIndex((line,index)=>index>0&&line.trim()==='---');
  if(end===-1)return true;
  return lines.slice(1,end).some(line=>line.trim()===`handoff: ${name}`);
}

// Publish with no-replace semantics, resolving only the collisions that are
// provably safe to resolve. Returns nothing; throws on a conflict it may not touch.
function publishHandoff(parent,handoffPath,temp,bytes,attempt){
  try{fs.linkSync(temp,handoffPath);return;}
  catch(error){if(error.code!=='EEXIST')throw error;}
  const info=fs.lstatSync(handoffPath);
  need(info.isFile()&&!info.isSymbolicLink(),'handoff_exists');
  const existing=fs.readFileSync(handoffPath);
  // Republishing identical bytes is the crash-after-link case, already published.
  if(existing.equals(bytes))return;
  if(reviewConsumedHandoff(parent,path.basename(handoffPath),attempt))reviewedHandoffConflict();
  // Crash-after-link retries stamp the checked bytes; a second read could change the archive name.
  supersedeWorkflowFile(parent,path.basename(handoffPath),existing);
  fs.linkSync(temp,handoffPath);
}

export function createHostHandoff(raw){
  const {root,baseline,checks,handoffPath,parent,reviewPackage,changedFiles,payload,bytes}=prepareHostHandoff(raw);
  const temp=path.join(parent,`.cm-initial-handoff-${randomUUID()}`);
  let fd;
  try{
    fd=fs.openSync(temp,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL,0o600);
    fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
    loadHandoff(temp,{task:baseline.identity.taskId,attempt:baseline.identity.attempt});
    verifyReviewPackage({root,baseline,checks,reviewPackage,expectedDigest:reviewPackage.packageDigest});
    need(payload.implementation_sha256===implementationSha256(root,changedFiles),'snapshot_changed');
    // Atomic no-replace publication, unlike rename which could overwrite approval.
    publishHandoff(parent,handoffPath,temp,bytes,baseline.identity.attempt);
    fs.unlinkSync(temp);
    const dir=fs.openSync(parent,fs.constants.O_RDONLY);
    try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}
    return {outcome:'created',status:payload.status,
      handoffSha256:createHash('sha256').update(bytes).digest('hex')};
  }finally{
    if(fd!==undefined)fs.closeSync(fd);
    try{fs.unlinkSync(temp);}catch(error){if(error.code!=='ENOENT')throw error;}
  }
}
