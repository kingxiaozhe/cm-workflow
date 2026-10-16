// Bounded failure metadata, never a verdict, raw output or identity proof.
import {createHash} from 'node:crypto';
import {digest,json,need,shape,hex,id} from '../cm-ai/effect-contract.mjs';
const phases=new Set(['snapshot','worker','check','baseline','mutation','restore','finish','callback','cleanup']);
const codes=new Set(['review_verification_failed','review_verification_check_failed','review_verification_check_missing',
  'review_verification_mutation_missing','review_verification_mutation_survived','review_verification_restore_failed',
  'review_verification_baseline_failed','review_verification_binding','review_verification_invalid',
  'review_verification_package_binding','review_verification_source_drift','review_verification_copy_drift',
  'review_verification_cleanup','review_verification_evidence','review_verification_path','review_verification_limit',
  'review_verification_mutation','review_verification_check','review_verification_prompt_contract',
  'review_verification_callback_failed','fix_verification_recovery_binding','reviewer_auth_failed','review_verification_isolation_unavailable','review_verification_tool','cancelled','review_verification_cleanup_unknown','process_cleanup_unknown',
  'verification_cleanup_unknown','verification_timeout','verification_cancelled','verification_signal_exit',
  'verification_spawn_failed','verification_isolation_failed','verification_isolation_unsupported',
  'verification_path_invalid','verification_command_invalid','verification_output_limit','verification_output_failed',
  'verification_observer_failed']);
export const verificationFailureCode=error=>{
  try{
    const property=error!==null&&['object','function'].includes(typeof error)?Object.getOwnPropertyDescriptor(error,'code'):null;
    return property&&Object.hasOwn(property,'value')&&codes.has(property.value)?property.value:'review_verification_failed';
  }catch{return 'review_verification_failed';}
};
export function verificationFailure({phase='finish',code='review_verification_failed',checkId=null,result=null}){
  const output=typeof result?.output==='string'?result.output:null;
  return {phase:phases.has(phase)?phase:'finish',code:codes.has(code)?code:'review_verification_failed',checkId,
    exitCode:Number.isInteger(result?.exitCode)?result.exitCode:null,
    outcome:['passed','failed','unavailable'].includes(result?.outcome)?result.outcome:null,
    outputSha256:output===null?null:digestOutput(output),
    runtimeFailure:output!==null&&/SyntaxError: The requested module '[^'\r\n]{1,240}' does not provide an export named '[A-Za-z_$][\w$]{0,100}'/.test(output)?'module_export_missing':null};
}
// Matches the byte-level output digest used by successful verification records.
const digestOutput=output=>createHash('sha256').update(output).digest('hex');
export function bindVerificationDiagnostic(failure,{request,configuration,providerThreadId=null}){
  return {version:1,requestDigest:request.requestDigest,packageDigest:request.payload.reviewPackage.packageDigest,
    profileDigest:digest(configuration),providerThreadId,...failure};
}
export function inspectVerificationDiagnostic(raw,{request,configuration,providerThreadId}){
  const d=json(raw,4096);
  shape(d,['version','requestDigest','packageDigest','profileDigest','providerThreadId','phase','code','checkId','exitCode','outcome','outputSha256','runtimeFailure']);
  need(request.provider==='claude'&&d.version===1&&d.requestDigest===request.requestDigest&&d.packageDigest===request.payload.reviewPackage.packageDigest
    &&d.profileDigest===digest(configuration)&&d.providerThreadId===providerThreadId,'review_verification_binding');
  if(d.providerThreadId!==null)id(d.providerThreadId);
  need(phases.has(d.phase)&&codes.has(d.code)&&
    (d.checkId===null||configuration.checks.some(c=>c.id===d.checkId))&&
    (d.exitCode===null||Number.isInteger(d.exitCode)&&d.exitCode>=0&&d.exitCode<=255)&&
    (d.outcome===null||['passed','failed','unavailable'].includes(d.outcome))&&
    (d.runtimeFailure===null||d.runtimeFailure==='module_export_missing'),'review_verification_invalid');
  if(d.outputSha256!==null)hex(d.outputSha256);
  return d;
}
export function splitVerificationResult(result){
  if(!result||!Object.hasOwn(result,'verificationDiagnostic'))return {result};
  const {verificationDiagnostic,...observationResult}=json(result,1024*1024);
  need(observationResult.status==='failed','review_verification_invalid');
  return {result:observationResult,verificationDiagnostic};
}

// Owner callback rejection overrides a worker that swallows the exception or
// returns an approval anyway. Persist only host-bound failure metadata.
export function verificationCallbackFailure(error,context){
  const code=verificationFailureCode(error);
  return {status:'failed',code,verificationDiagnostic:bindVerificationDiagnostic(verificationFailure({phase:'callback',code}),context)};
}

// Failure metadata is optional. Reject it independently without dropping the
// already-failed observation; none of this path can create a completed review.
export function inspectResultWithFailureDiagnostic(value,inspect,context){
  try{return {value,inspection:inspect(value)};}catch(error){
    if(!context.configuration||value?.observation?.result?.status!=='failed'||!Object.hasOwn(value,'verificationDiagnostic'))throw error;
    const {verificationDiagnostic,...without}=value;
    inspect(without);
    const code=verificationFailureCode(error);
    const safe={...without,verificationDiagnostic:bindVerificationDiagnostic(verificationFailure({phase:'finish',code}),context)};
    return {value:safe,inspection:inspect(safe)};
  }
}
