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
// Operations whose rate-limited stop is retried (cm-ai-conversation-entry.mjs: advance and
// decision dispatch the review; resume only reports the state and never dispatches).
// Single-task driver only: the batch host has no operation that checks such a
// precondition and redispatches just that review under its lock.
// The retry itself is always a decision bound to the frozen stop (never the
// original advance), so it can only redispatch that one review.
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
  // A refused (e.g. stale) request dispatched nothing and is never retried.
  return rateLimitedReview(row)&&result.outcome!=='rejected'&&result.staleRetry!==true
    &&result.state==='pending_review'&&result.code==='review_provider_failed'&&result.pendingAction==='resume';
};
// {attempt,max,delayMs} for the next wait, or null.
export function nextRateLimitRetry(row,env=process.env){
  if(!rateLimitRetryable(row)||expectedReviewStop(row)===null)return null;
  const delays=rateLimitDelays(env),done=rateLimitRetriesDone(env);
  return done<delays.length?{attempt:done+1,max:delays.length,delayMs:delays[done]}:null;
}
// The re-run resumes the run the first command created (same session).
export function applyRateLimitResume(plan,env=process.env){
  if(rateLimitRetriesDone(env)===0||plan?.mode!=='create')return plan;
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
const text=value=>typeof value==='string'&&value?value:null;
// The frozen precondition a timed retry sends with its decision (the cm-ai host
// checks it under the run's writer lock, cm-ai-conversation-entry.mjs
// rateLimitStopMatches): the round's identity, the reviewed package and the
// failed review invocation. null when the result does not carry all of them.
export const RATE_LIMIT_EXPECTED_ENV='CM_DRIVE_RATE_LIMIT_EXPECTED';
export function expectedReviewStop(row){
  const result=obj(row?.result),identity=obj(result.identity);
  if(!['repositoryId','runId','taskId'].every(key=>text(identity[key]))||!Number.isSafeInteger(identity.attempt)
    ||!/^[a-f0-9]{64}$/.test(result.packageDigest??'')||!text(result.reviewInvocationId))return null;
  return {identity:{repositoryId:identity.repositoryId,runId:identity.runId,taskId:identity.taskId,attempt:identity.attempt},
    packageDigest:result.packageDigest,invocationId:result.reviewInvocationId};
}
export function readExpectedReviewStop(env=process.env){
  const raw=env[RATE_LIMIT_EXPECTED_ENV];if(typeof raw!=='string'||!raw)return null;
  let value;try{value=JSON.parse(raw);}catch{return null;}
  return expectedReviewStop({result:{identity:value?.identity,packageDigest:value?.packageDigest,reviewInvocationId:value?.invocationId}});
}
