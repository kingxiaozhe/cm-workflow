// Fixed immutable material transport. Adapter artifacts never issue owner receipts.
import fs from 'node:fs';
import path from 'node:path';
import {digest,need,id,hex,json,shape,validIdentity} from './effect-contract.mjs';
import {prepareCodexReviewInput,createCodexReviewRun} from './codex-review-adapter.mjs';
import {reviewResult,boundReviewText} from './review-runner.mjs';
import {codexWorker,preflightMatches} from './worker-codex.mjs';
import {previewIsolated} from './tool-preview.mjs';
import {createReviewMaterialSession} from './review-material.mjs';
import {writeImmutableWorkflowFile} from './review-evidence-file.mjs';
import {readProviderFailureDiagnostic} from './provider-failure-diagnostic.mjs';

const knownCodes=new Set(['tool_preflight_missing','cancelled','provider_failed','spawn_failed','timeout','incomplete_result',
 'process_cleanup_unknown','invalid_event','invalid_output_json','unexpected_tool_or_item','output_limit','prompt_write_failed',
 'thread_mismatch','cli_diagnostic','worker_dispatch_limit','cancelled_before_dispatch','review_verification_transport_missing','review_file_conflict','unsupported_path','limit_exceeded','invalid_input','review_package_mismatch',
 'missing_material','invalid_finding_shape','invalid_finding_id','invalid_finding_severity','invalid_finding_path','contradictory_verdict',
 'EACCES','EPERM','ENOENT','EIO','ENOSPC','EROFS','EEXIST','review_material_binding','review_material_changed',
 'review_material_closed','review_material_coverage_changed','review_material_encoding','review_material_failed','review_material_incomplete',
 'review_material_invalid','review_material_limit','review_material_page','review_material_path','review_material_tool',
 'review_material_transport','review_material_profile_unsupported','review_input_invalid','review_input_too_large']);
const safeCode=raw=>knownCodes.has(raw)?raw:'review_material_failed';
function proofBinding(request,manifest,proof,thread){
 need(proof&&[1,2].includes(proof.version),'review_material_binding');
 shape(proof,['version','kind','manifest','manifestDigest','requestDigest','packageDigest','promptSha256','promptBytes',
  'providerThreadId','callCount','pages','evidenceDigest',...(proof.version===2?['pageReadCount']:[])]);
 need(proof.kind==='cm-review-material-evidence'&&[1,2].includes(proof.version),'review_material_binding');
 const pageReads=proof.version===1?proof.callCount:proof.pageReadCount;
 need(Number.isSafeInteger(proof.callCount)&&proof.callCount>=1&&proof.callCount<=256
  &&Number.isSafeInteger(pageReads)&&pageReads>=manifest.pageCount&&pageReads<=256
  &&pageReads<=proof.callCount*(proof.version===1?1:8),'review_material_binding');
 const {evidenceDigest,...body}=proof;
 need(evidenceDigest===digest(body)&&proof.providerThreadId===thread
  &&proof.requestDigest===request.requestDigest&&proof.packageDigest===request.payload.reviewPackage.packageDigest
  &&digest(proof.manifest)===digest(manifest)&&proof.manifestDigest===digest(manifest)
  &&digest(proof.pages)===digest(manifest.pages)&&proof.promptSha256===manifest.promptSha256&&proof.promptBytes===manifest.promptBytes,
  'review_material_binding');
}
function publish(definition,name,value){
 const bytes=Buffer.from(JSON.stringify(value)+'\n'),reviewsDir=path.join(definition.specsDir,'.reviews');
 writeImmutableWorkflowFile({reviewsDir,name,bytes});
 need(fs.readFileSync(path.join(reviewsDir,name)).equals(bytes),'review_material_changed');
}
function publishProof(definition,request,manifest,proof,thread){
 proofBinding(request,manifest,proof,thread);
 publish(definition,'material-'+digest({request:request.requestDigest,thread})+'.json',proof);
}
const resultName=(request,thread)=>'material-result-'+digest({request:request.requestDigest,thread})+'.json';
function savedEvents(thread,processClosed){return [{event:'thread.started',provider_thread:thread},{event:'turn.started',item_type:null},
 {event:'item.completed',item_type:'agent_message'},{event:'turn.completed',item_type:null},processClosed];}
function stableResultBytes(reviewsDir,name){
 need(path.isAbsolute(reviewsDir)&&path.resolve(reviewsDir)===reviewsDir&&fs.realpathSync(reviewsDir)===reviewsDir,'review_material_path');
 const root=fs.lstatSync(reviewsDir,{bigint:true});need(root.isDirectory()&&!root.isSymbolicLink(),'review_material_path');
 const file=path.join(reviewsDir,name),before=fs.lstatSync(file,{bigint:true});
 const regular=st=>st.isFile()&&!st.isSymbolicLink()&&st.nlink===1n&&(st.mode&511n)===384n&&st.size<=256n*1024n;
 const same=(a,b)=>['dev','ino','size','mtimeNs','ctimeNs','mode','nlink'].every(key=>a[key]===b[key]);
 need(regular(before),'review_material_path');
 const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 try{
  const opened=fs.fstatSync(fd,{bigint:true});need(regular(opened)&&same(before,opened),'review_material_changed');
  const bytes=fs.readFileSync(fd),after=fs.fstatSync(fd,{bigint:true}),linked=fs.lstatSync(file,{bigint:true});
  need(regular(after)&&regular(linked)&&same(before,after)&&same(after,linked)&&BigInt(bytes.length)===after.size,'review_material_changed');
  const finalRoot=fs.lstatSync(reviewsDir,{bigint:true});
  need(finalRoot.isDirectory()&&!finalRoot.isSymbolicLink()&&finalRoot.dev===root.dev&&finalRoot.ino===root.ino
   &&fs.realpathSync(reviewsDir)===reviewsDir,'review_material_path');
  return bytes;
 }finally{fs.closeSync(fd);}
}
function saveResult(definition,request,manifest,proof,thread,value,processClosed){
 proofBinding(request,manifest,proof,thread);
 const bounded=boundReviewText(value);need(bounded!==null,'limit_exceeded');
 const result=reviewResult(bounded,request.payload.reviewPackage);
 const body={version:1,kind:'cm-review-material-result',invocationId:request.invocationId,identity:request.identity,
  requestDigest:request.requestDigest,packageDigest:manifest.packageDigest,manifestDigest:digest(manifest),
  providerThreadId:thread,proof,result,processClosed,events:savedEvents(thread,processClosed),ownerAccepted:false};
 publish(definition,resultName(request,thread),{...body,resultArtifactDigest:digest(body)});
}
// A preserved adapter result may help the SAME invocation recover publication.
// Callers must still verify their trusted invocation and obtain an owner receipt.
// This helper neither forwards events nor registers/accepts the result.
export function readMaterialReviewResult({definition,request,providerThreadId,executionPolicy=null}){
 id(providerThreadId);const plan=prepareCodexReviewInput(request,executionPolicy);need(plan.material,'review_material_binding');
 const bytes=stableResultBytes(path.join(definition.specsDir,'.reviews'),resultName(request,providerThreadId)),value=json(JSON.parse(bytes),256*1024);
 shape(value,['version','kind','invocationId','identity','requestDigest','packageDigest','manifestDigest','providerThreadId','proof','result','processClosed','events','ownerAccepted','resultArtifactDigest']);
 const {resultArtifactDigest,...body}=value;
 need(bytes.equals(Buffer.from(JSON.stringify(value)+'\n'))&&resultArtifactDigest===digest(body)
  &&value.version===1&&value.kind==='cm-review-material-result'&&value.ownerAccepted===false
  &&value.invocationId===request.invocationId&&digest(value.identity)===digest(request.identity)
  &&value.requestDigest===request.requestDigest&&value.packageDigest===plan.material.manifest.packageDigest
  &&value.manifestDigest===digest(plan.material.manifest)&&value.providerThreadId===providerThreadId,'review_material_binding');
 proofBinding(request,plan.material.manifest,value.proof,providerThreadId);
 shape(value.processClosed,['event','exit_code','signal','timed_out']);
 need(value.processClosed.event==='process_closed'&&value.processClosed.exit_code===0&&value.processClosed.signal===null
  &&value.processClosed.timed_out===false&&digest(value.events)===digest(savedEvents(providerThreadId,value.processClosed)),'review_material_binding');
 reviewResult(value.result,request.payload.reviewPackage);return json({...value,reconciliation:{events:value.events,
  result:{status:'succeeded',value:value.result},cleanup:'owned_process_group_closed'}},512*1024);
}
export function republishMaterialReviewProof(options){
 const saved=readMaterialReviewResult(options),manifest=prepareCodexReviewInput(options.request,options.executionPolicy??null).material.manifest;
 publishProof(options.definition,options.request,manifest,saved.proof,options.providerThreadId);return saved;
}
export async function runMaterialReview({definition,reviewOptions,request,control,executionPolicy=null},dependencies={}){
 let probe=null,session=null,material=null,thread=null,stage='input_admission',failureStage=null,outcome=null,failureRecorded=false;
 let snapshot=null,providerTerminal=null,processClosed=null,providerEndEvent=null,nativeDiagnostic=null,turnStarted=false,finalMessage=false;
 const cleanupErrors=[];
 const unknown=()=>({expectedPages:material?.pageCount??null,readPages:null,missingPages:null,toolCallCount:null,pageReadCount:null,
  toolFailures:null,toolFailureCount:null,duplicateReadCount:null,ledgerVerified:false});
 const capture=()=>{try{snapshot=session?.failureSnapshot?.()??snapshot??unknown();}catch{snapshot=unknown();}};
 const close=async(which)=>{
  const target=which==='probe'?probe:session;if(!target)return;
  if(which==='probe')probe=null;else session=null;
  try{await target.close();}catch(error){cleanupErrors.push({resource:which,code:safeCode(error.code)});throw error;}
 };
 const recordFailure=rawCode=>{
  if(failureRecorded)return;
  const code=safeCode(rawCode);
  try{
   let providerThreadId=null,invocationId=null,identity=null,requestDigest=null;
   try{id(thread);providerThreadId=thread;}catch{}
   try{id(request.invocationId);validIdentity(request.identity);hex(request.requestDigest);
    invocationId=request.invocationId;identity=json(request.identity);requestDigest=request.requestDigest;}catch{}
   const body={version:4,kind:'cm-review-material-failure',invocationId,identity,requestDigest,
    packageDigest:material?.packageDigest??null,promptSha256:material?.promptSha256??null,manifestDigest:material?digest(material):null,
    providerThreadId,stage:failureStage??stage,code,...(snapshot??unknown()),providerTerminal,providerEndEvent,processClosed,nativeDiagnostic,cleanupErrors,
    completionEligible:false};
   publish(definition,'material-failure-'+digest({request:requestDigest,invocationId,thread:providerThreadId})+'.json',
    {...body,diagnosticDigest:digest(body)});failureRecorded=true;
  }catch{
   // No raw exception, output, prompt, tool arguments, secret or model reasoning.
   process.stderr.write(JSON.stringify({diagnostic:'review_material_failure_record_unavailable',stage:failureStage??stage,code})+'\n');
  }
 };
 try{
  need(request.provider==='codex'&&request.requestedModel===reviewOptions.model,'review_material_binding');
  const plan=prepareCodexReviewInput(request,executionPolicy);need(plan.material,'review_material_binding');material=plan.material.manifest;
  const create=dependencies.session??createReviewMaterialSession;
  const preview=dependencies.preview??(options=>previewIsolated({...options,allowCodeProject:true}));
  const worker=dependencies.worker??codexWorker,sessionInput={prompt:plan.material.prompt,request};
  stage='preflight';probe=create(sessionInput);
  const preflight=await preview({...reviewOptions,material,materialTransport:probe.transport});
  need(preflightMatches(preflight,{...reviewOptions,material}),'tool_preflight_missing');
  stage='preflight_cleanup';await close('probe');need(!control.signal.aborted,'cancelled');
  stage='session';session=create(sessionInput);
  const native=worker({...reviewOptions,preflight,material,materialTransport:session.transport,onDiagnostic:value=>{
   const categories=['unknown','image_load_failed','context_limit','schema_invalid','invalid_argument','authentication','rate_limit','http_status'];
   if(value?.kind==='codex_review_exit')nativeDiagnostic={kind:'codex_review_exit',
    category:categories.includes(value.category)?value.category:'unknown',
    httpStatus:[400,401,403,408,413,422,429,500,502,503,504].includes(value.httpStatus)?value.httpStatus:null,
    stderrByteCount:Number.isSafeInteger(value.stderrByteCount)&&value.stderrByteCount>=0?value.stderrByteCount:null,
    ...(value.diagnostic?{diagnostic:readProviderFailureDiagnostic(value.diagnostic)}:{})};
   try{reviewOptions.onDiagnostic?.(value);}catch{}
  }});
  const wrapped=async(input,inner)=>{
   need(input.prompt===plan.material.prompt,'review_material_binding');let terminal=null;const finals=[];stage='provider';
   const result=await native({...input,prompt:plan.prompt},{signal:inner.signal,onEvent:event=>{
    if(event.event==='thread.started')thread=event.provider_thread;
    if(event.event==='turn.started')turnStarted=true;
    if(event.event==='item.completed'&&event.item_type==='agent_message')finalMessage=true;
    if(['turn.completed','turn.failed','error'].includes(event.event))providerEndEvent=event.event;
    if(event.event==='process_closed')processClosed={event:'process_closed',
     exit_code:Number.isInteger(event.exit_code)&&event.exit_code>=0&&event.exit_code<=255?event.exit_code:null,
     signal:/^SIG(?:ABRT|ALRM|BUS|FPE|HUP|ILL|INT|KILL|PIPE|QUIT|SEGV|TERM|TRAP|USR1|USR2)$/.test(event.signal??'')?event.signal:null,
     timed_out:typeof event.timed_out==='boolean'?event.timed_out:null};
    if(event.event==='item.completed'&&event.item_type==='agent_message'||event.event==='turn.completed'||event.event==='process_closed')finals.push(event);
    else inner.onEvent(event);
   },onTerminal:value=>{terminal=value;providerTerminal={status:['succeeded','failed'].includes(value.status)?value.status:null,
    code:value.status==='failed'?safeCode(value.code):null};}});
   capture();
   // An observed provider terminal survives local cancellation, but cancellation
   // remains the outcome. The sidecar carries no owner acceptance authority.
   if(result.status==='succeeded'||terminal?.status==='succeeded'){
    if(result.status==='succeeded'&&terminal?.status==='succeeded')need(digest(result.value)===digest(terminal.value),'review_material_binding');
    stage='coverage';const proof=session.finish(thread);
    if(terminal?.status==='succeeded'&&turnStarted&&finalMessage&&providerEndEvent==='turn.completed'
      &&processClosed?.exit_code===0&&processClosed.signal===null&&processClosed.timed_out===false){
     stage='result_publication';saveResult(definition,request,material,proof,thread,terminal.value,processClosed);
    }
    stage='proof_publication';publishProof(definition,request,material,proof,thread);
    stage='cleanup';await close('session');
    stage='terminal_forwarding';for(const event of finals)inner.onEvent(event);if(terminal)inner.onTerminal?.(terminal);
   }else{
    failureStage=stage;
    // Finish local cleanup and persist failure evidence before notifying the
    // owner about the native failed terminal. Keep the original failed result.
    try{await close('session');}catch{}
    recordFailure(result.code);
    for(const event of finals)if(event.event==='process_closed')inner.onEvent(event);
    if(terminal?.status==='failed')inner.onTerminal?.(terminal);
   }
   return result;
  };
  outcome=await createCodexReviewRun(wrapped,executionPolicy)(request,control);
 }catch(error){failureStage??=stage;outcome={status:'failed',code:safeCode(error.code)};}
 finally{
  capture();
  for(const which of ['probe','session'])try{await close(which);}catch(error){
   if(!outcome||outcome.status==='succeeded'){failureStage??='cleanup';outcome={status:'failed',code:safeCode(error.code)};}
  }
 }
 if(outcome?.status!=='succeeded'&&!(outcome?.status==='cancelled'&&cleanupErrors.length===0&&stage==='terminal_forwarding'))recordFailure(outcome?.code);
 return outcome;
}
