// Host-only initial handoff producer. It grants no review or completion authority.
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {createReviewPackage,verifyReviewPackage} from './review-package.mjs';
import {implementationSha256,loadHandoff} from '../../../scripts/cm-task-gate.mjs';
import {digest,json,shape,text,need} from './effect-contract.mjs';

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
    fs.linkSync(temp,handoffPath);
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
