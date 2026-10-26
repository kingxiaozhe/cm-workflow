// Driver-side wait-and-redispatch for a review the provider rate limited
// (reviewFailure reviewer_rate_limited, 2026-10-26: Codex 429 stopped a batch
// while the weekly quota was at 3%). It only re-runs the same driver command in
// resume mode, i.e. what a person does by saying "继续": the runner's own rules
// decide whether that dispatches a review. It never sends abandon_review, never
// spends a review round and needs no extra permission: the runner grants one
// automatic no-verdict redispatch per review round (pending_review), and a
// second rate limit in the same round comes back as blocked, which stops here.
export const RATE_LIMIT_RETRY_ENV='CM_DRIVE_RATE_LIMIT_RETRY';
export const RATE_LIMIT_DELAYS_ENV='CM_DRIVE_RATE_LIMIT_DELAYS_MS';
// At most three waits of 10 minutes, about 30 minutes in all (2026-10-26: the
// review succeeded when resumed about 15 minutes after the 429).
export const RATE_LIMIT_DEFAULT_DELAYS_MS=Object.freeze([600000,600000,600000]);
export const RATE_LIMIT_MAX_TOTAL_MS=1800000;
// Operations that can dispatch a review of the current round.
export const RATE_LIMIT_RETRY_OPERATIONS=Object.freeze(['advance','resume','decision']);

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
