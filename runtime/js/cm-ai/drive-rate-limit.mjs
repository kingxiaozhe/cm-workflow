// Driver-side wait-and-redispatch for a review the provider rate limited
// (reviewFailure reviewer_rate_limited, 2026-10-26: Codex 429 stopped a batch
// while the weekly quota was at 3%). It only re-runs the same driver command in
// resume mode, i.e. what a person does by saying "继续": the runner's own rules
// decide whether that dispatches a review. It never sends abandon_review, never
// spends a review round and needs no extra permission: the runner grants one
// automatic no-verdict redispatch per review round (pending_review), and a
// second rate limit in the same round comes back as blocked, which stops here.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

export const RATE_LIMIT_RETRY_ENV='CM_DRIVE_RATE_LIMIT_RETRY';
// The read-only status check before a re-run (resume mode, nothing dispatched).
export const RATE_LIMIT_CHECK_ENV='CM_DRIVE_RATE_LIMIT_CHECK';
// SHA-256 of the PLAN bytes the waiting driver started from; a re-run reading
// other bytes stops before launching anything.
export const RATE_LIMIT_PLAN_DIGEST_ENV='CM_DRIVE_RATE_LIMIT_PLAN_DIGEST';
export const RATE_LIMIT_DELAYS_ENV='CM_DRIVE_RATE_LIMIT_DELAYS_MS';
// At most three waits, 15, 10 and 5 minutes, 30 minutes in all. The first is the
// longest: on 2026-10-26 the review succeeded when resumed about 15 minutes after
// the 429, and a round has only one automatic redispatch, so it should not be spent
// too early.
export const RATE_LIMIT_DEFAULT_DELAYS_MS=Object.freeze([900000,600000,300000]);
export const RATE_LIMIT_MAX_TOTAL_MS=1800000;
// Operations that dispatch the review of a pending_review round (cm-ai-conversation-entry.mjs:
// advance and decision run it; resume only reports the state and never dispatches).
// Batch advance runs the member's decision (cm-ai-batch-run.mjs reviewRetryable).
export const RATE_LIMIT_RETRY_OPERATIONS=Object.freeze(['advance','decision']);

const obj=value=>value&&typeof value==='object'&&!Array.isArray(value)?value:{};
// Overridable (tests use milliseconds); anything out of range keeps the default.
export function rateLimitDelays(env=process.env){
  const raw=env[RATE_LIMIT_DELAYS_ENV];
  if(typeof raw!=='string'||!raw)return [...RATE_LIMIT_DEFAULT_DELAYS_MS];
  const values=raw.split(',').map(item=>Number(item.trim()));
  const valid=values.length>=1&&values.length<=3&&values.every(value=>Number.isSafeInteger(value)&&value>=1)
    &&values.reduce((sum,value)=>sum+value,0)<=RATE_LIMIT_MAX_TOTAL_MS;
  return valid?values:[...RATE_LIMIT_DEFAULT_DELAYS_MS];
}
export function rateLimitRetriesDone(env=process.env){
  const value=Number(env[RATE_LIMIT_RETRY_ENV]);
  return Number.isSafeInteger(value)&&value>=1&&value<=RATE_LIMIT_DEFAULT_DELAYS_MS.length?value:0;
}
// A rate-limited review end, whatever state the runner put it in.
export const rateLimitedReview=row=>!row?.error&&obj(row?.result).reviewFailure==='reviewer_rate_limited';
// Only the runner's own automatic redispatch state qualifies.
export const rateLimitRetryable=row=>{
  const result=obj(row?.result);
  return rateLimitedReview(row)&&result.state==='pending_review'&&result.code==='review_provider_failed'&&result.pendingAction==='resume';
};
// {attempt,max,delayMs} for the next wait, or null.
export function nextRateLimitRetry(row,env=process.env){
  if(!rateLimitRetryable(row))return null;
  const delays=rateLimitDelays(env),done=rateLimitRetriesDone(env);
  return done<delays.length?{attempt:done+1,max:delays.length,delayMs:delays[done]}:null;
}
// The re-run resumes the run the first command created (same session).
export function applyRateLimitResume(plan,env=process.env){
  if(rateLimitRetriesDone(env)===0&&env[RATE_LIMIT_CHECK_ENV]!=='1'||plan?.mode!=='create')return plan;
  plan.mode='resume';plan.originalHostContext=plan.hostContext;
  return plan;
}
// Driver eligibility: an operation that can dispatch the review, and a plan the
// resume re-run accepts unchanged (create-only supersede flags are left alone).
export function rateLimitRetryEligible(operation,plan){
  const permissions=Array.isArray(plan?.permissions)?plan.permissions:[];
  return RATE_LIMIT_RETRY_OPERATIONS.includes(operation)
    &&!permissions.some(flag=>typeof flag==='string'&&(flag.startsWith('--supersede')||flag==='--accept-superseded-code-drift'));
}

export const digestBytes=bytes=>createHash('sha256').update(bytes).digest('hex');
// The PLAN file a driver command names (--plan <file>), as the driver resolves it.
export function planFileFromArgv(argv=process.argv.slice(2),cwd=process.cwd()){
  const at=argv.indexOf('--plan');
  return at!==-1&&typeof argv[at+1]==='string'&&argv[at+1]?path.resolve(cwd,argv[at+1]):null;
}
export function planDigest(file){try{return digestBytes(fs.readFileSync(file));}catch{return null;}}
// The same command with another operation (the read-only status check).
export function argvWithOperation(argv,operation){
  const at=argv.indexOf('--plan'),index=argv.findIndex((arg,i)=>i!==at&&i!==at+1&&!arg.startsWith('--'));
  if(index===-1)return null;
  const next=[...argv];next[index]=operation;return next;
}
const text=value=>typeof value==='string'&&value?value:null;
// What the timed re-run must find unchanged: the PLAN bytes, the run, task,
// round and reviewed package, and the rate-limited automatic-redispatch stop.
export function rateLimitBinding(row,digest){
  const result=obj(row?.result),identity=obj(result.identity);
  return Object.freeze({planDigest:digest,repositoryId:text(identity.repositoryId),runId:text(identity.runId),
    taskId:text(identity.taskId),attempt:Number.isSafeInteger(identity.attempt)?identity.attempt:null,
    packageDigest:text(result.packageDigest),batchId:text(result.batchId),taskKey:text(result.taskKey),
    code:text(result.code),reviewFailure:text(result.reviewFailure),pendingAction:text(result.pendingAction)});
}
// null when the status row still shows exactly the bound stop; else why not.
export function rateLimitBindingMismatch(binding,statusRow,digestNow){
  if(!binding||!binding.planDigest||!binding.runId||!binding.taskId||binding.attempt===null||!binding.packageDigest)
    return '限流时的结果缺少运行、任务、轮次或审查包标识';
  if(digestNow!==binding.planDigest)return 'PLAN 文件在等待期间被改过';
  if(!statusRow||statusRow.error)return `只读 status 没有拿到结果${statusRow?.error?.code?`（${statusRow.error.code}）`:''}`;
  const now=rateLimitBinding(statusRow,digestNow);
  for(const key of ['repositoryId','runId','taskId','attempt','packageDigest','batchId','taskKey'])
    if(now[key]!==binding[key])return `运行已不是限流时那一个（${key} 变了）`;
  if(obj(statusRow.result).state!=='pending_review'||now.code!=='review_provider_failed'
    ||now.reviewFailure!=='reviewer_rate_limited'||now.pendingAction!=='resume')
    return `运行已不停在这次限流（现在是 ${text(obj(statusRow.result).state)??'-'}/${now.code??'-'}）`;
  return null;
}
