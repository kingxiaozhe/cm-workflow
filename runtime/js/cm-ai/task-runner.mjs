// Trusted synthetic fixture host; explicit V2 supports isolated task-file writes.
import { randomUUID } from 'node:crypto';
import { types } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import { captureReviewBaseline, createReviewPackage, verifyReviewPackage } from './review-package.mjs';
import { digest,need,shape,id,text,json,freeze,arrayItems,validIdentity,validTaskLearningInput,validCallTimeout,requestFor,terminalFor,failureCode } from './effect-contract.mjs';
import { reviewResult,reviewReceipt } from './review-runner.mjs';
import { checkCompletion } from './gate-bridge.mjs';
import { runnerPayload,runnerPayloadV3,readRunnerHistory,attemptBaseline,boundRunnerRecord,
  controlledState,validateReviewDispatchGrant,validateTaskLearningReviewPackage } from './durable-runner-state.mjs';
import {commitRunnerFixture} from './task-commit.mjs';
import {inspectProviderReview} from './provider-review-observation.mjs';
import {attachCmAiTaskLearningApplicationEvidence,attachCmAiTaskLearningEvidence,
  readCmAiTaskLearningApplication} from './cm-ai-context-refresh.mjs';
import {readCmAiProjectLearningWriteback,writeCmAiProjectLearning} from './cm-ai-learning-writer.mjs';
import {verifyCmAiTaskLearningHandoff,writeCmAiTaskLearningHandoff} from './cm-ai-learning-handoff-writer.mjs';
import {createHostHandoff} from './host-handoff.mjs';
import {inspectFixCodeAssociation} from './fix-code-association.mjs';
import {validateAcceptedFix} from './accepted-fix.mjs';
import {inspectCmAiQaFailure} from './cm-ai-qa-log.mjs';
import {readHostQaFixHistory} from './host-qa-fix.mjs';
import {publishHostReview} from './host-review-file.mjs';
import {reviewExclusions} from './effect-contract.mjs';
import {bootstrapConfiguration,readBootstrapEvidence} from './host-bootstrap.mjs';
import {validateCodeProjectPaths,assertCodeProjectSelections} from './code-projects.mjs';

// Keep default V1 imports free of SQLite initialization/warnings. Native ownership
// is loaded synchronously only at the explicit V2 boundary (Node24.14+).
const requireNative=createRequire(import.meta.url);
const taskOwnerTarget=store=>requireNative('./task-owner.mjs').taskOwnerTarget(store);

const commitCapabilities=new WeakMap();
// This fixed resolver returns data, not a configurable journal port or issuer.
export function resolveFixtureCommit(token,store,action,payload) {
  const entry=commitCapabilities.get(token);
  need(entry!==undefined && entry.store===store,'commit_capability_invalid');
  need(action==='guard'?arguments.length===3:
    ['append-intent','append-result'].includes(action)&&arguments.length===4,'commit_phase_invalid');
  return entry.resolve(action,payload);
}

const NativePromise=Promise,promisePrototype=Promise.prototype,nativeThen=Promise.prototype.then;
const nativeSpecies=Object.getOwnPropertyDescriptor(NativePromise,Symbol.species);
function directPromiseObservation(value) {
  let object=value;
  for(let depth=0;object && depth<40;depth++,object=Object.getPrototypeOf(object)) {
    if(types.isProxy(object))return false;
    const descriptor=Object.getOwnPropertyDescriptor(object,'constructor');
    if(!descriptor)continue;
    if(!Object.hasOwn(descriptor,'value'))return false;
    if(descriptor.value===undefined)return true;
    if(descriptor.value!==NativePromise)return false;
    const species=Object.getOwnPropertyDescriptor(NativePromise,Symbol.species);
    return species && Reflect.ownKeys(species).length===Reflect.ownKeys(nativeSpecies).length
      && Reflect.ownKeys(nativeSpecies).every(key=>species[key]===nativeSpecies[key]);
  }
  return object===null;
}
// Observation is not admission. Bypass custom then/constructor/species hooks while
// attaching rejection cleanup, restoring any temporary descriptor before callbacks run.
// Immutable accessor-bearing containers are outside the trusted adapter contract;
// their producer must already own rejection handling (there is no safe JS escape hatch).
function observePromise(value,onFulfilled,onRejected) {
  const own=Object.getOwnPropertyDescriptor(value,'constructor');
  if(directPromiseObservation(value)) {
    Reflect.apply(nativeThen,value,[onFulfilled,onRejected]);return true;
  }
  if(!(own ? own.configurable || (Object.hasOwn(own,'value') && own.writable) : Object.isExtensible(value)))return false;
  try {
    if(own && !own.configurable)Object.defineProperty(value,'constructor',{value:undefined});
    else Object.defineProperty(value,'constructor',{value:undefined,configurable:true});
    Reflect.apply(nativeThen,value,[onFulfilled,onRejected]);return true;
  } finally {
    if(own)Object.defineProperty(value,'constructor',own);
    else Reflect.deleteProperty(value,'constructor');
  }
}
const ignorePromiseResult=()=>{};

export function createTaskRunner(options) {
  const taskMode=options && Object.hasOwn(options,'taskCompletion');
  const requestedVersion=taskMode&&options?.persistence?.version;
  const invocationMode=requestedVersion===3;
  const optionKeys=['root','identity','scope','requirements','developer','reviewers','excludedContexts','check',taskMode?'taskCompletion':'commit'];
  if(options && Object.hasOwn(options,'timeoutMs'))optionKeys.push('timeoutMs');
  if(options && Object.hasOwn(options,'persistence'))optionKeys.push('persistence');
  if(options && Object.hasOwn(options,'taskLearning'))optionKeys.push('taskLearning');
  if(options && Object.hasOwn(options,'bootstrap'))optionKeys.push('bootstrap');
  if(options && Object.hasOwn(options,'codeProjectPaths'))optionKeys.push('codeProjectPaths');
  if(invocationMode)optionKeys.push('reviewInvocation');
  shape(options,optionKeys);
  const {check,commit}=options;need(typeof check==='function' && (taskMode||typeof commit==='function'));
  if(taskMode)need(Object.hasOwn(options,'persistence'),'runner_completion');
  const config=json({root:options.root,identity:options.identity,scope:options.scope,requirements:options.requirements,
    ...(Object.hasOwn(options,'codeProjectPaths')?{codeProjectPaths:validateCodeProjectPaths(options.codeProjectPaths)}:{}),
    excludedContexts:options.excludedContexts,timeoutMs:Object.hasOwn(options,'timeoutMs')?options.timeoutMs:1000});
  if(config.codeProjectPaths)assertCodeProjectSelections(config.codeProjectPaths,[...config.scope,...config.requirements]);
  validIdentity(config.identity);need(config.identity.attempt===1);
  validCallTimeout(config.timeoutMs);
  need(Array.isArray(config.excludedContexts) && config.excludedContexts.length>0);config.excludedContexts.forEach(id);
  shape(options.developer,['provider','requestedModel','contextId','run']);
  const developer={...json({provider:options.developer.provider,requestedModel:options.developer.requestedModel,
    contextId:options.developer.contextId}),run:options.developer.run};
  id(developer.contextId);text(developer.requestedModel);need(['codex','claude'].includes(developer.provider) && typeof developer.run==='function');
  const candidates=arrayItems(options.reviewers);need(candidates.length<=2);
  const used=new Set([...config.excludedContexts,developer.contextId]),ids=new Set();
  const reviewers=candidates.map(r=>{
    shape(r,['id','provider','requestedModel','allowed','available','contexts','run',...(invocationMode?['adapterId']:[])]);
    const {run}=r,v=json({id:r.id,provider:r.provider,requestedModel:r.requestedModel,allowed:r.allowed,available:r.available,contexts:r.contexts});
    id(v.id);need(!ids.has(v.id));ids.add(v.id);text(v.requestedModel);
    need(['codex','claude'].includes(v.provider) && typeof v.allowed==='boolean' && typeof v.available==='boolean' && typeof run==='function');
    need(Array.isArray(v.contexts) && v.contexts.length===2);
    for(const c of v.contexts){id(c);need(!used.has(c),'not_independent');used.add(c);}
    if(invocationMode)id(r.adapterId);
    return {...v,...(invocationMode?{adapterId:r.adapterId}:{}),run};
  });
  let invocationConfig=null,authorize=null;
  if(invocationMode){
    need(reviewers.length===1&&['codex','claude'].includes(reviewers[0].provider)&&reviewers[0].allowed&&reviewers[0].available,'runner_invocation');
    shape(options.reviewInvocation,['developerThreadId','excludedThreadIds','authorize']);
    authorize=options.reviewInvocation.authorize;need(typeof authorize==='function','runner_invocation');
    invocationConfig=json({developerThreadId:options.reviewInvocation.developerThreadId,
      excludedThreadIds:options.reviewInvocation.excludedThreadIds});
    id(invocationConfig.developerThreadId);need(Array.isArray(invocationConfig.excludedThreadIds)
      &&invocationConfig.excludedThreadIds.length>0&&invocationConfig.excludedThreadIds.length<=32,'runner_invocation');
    const actual=new Set([invocationConfig.developerThreadId]);
    for(const thread of invocationConfig.excludedThreadIds){id(thread);need(!actual.has(thread),'runner_invocation');actual.add(thread);}
  }
  let metadata=json({...config,developer:{provider:developer.provider,requestedModel:developer.requestedModel,contextId:developer.contextId},
    reviewers:reviewers.map(({run,...r})=>r),...(invocationMode?{reviewInvocation:invocationConfig}:{}),
    ...(Object.hasOwn(options,'taskLearning')?{taskLearning:json(options.taskLearning)}:{})});
  const taskLearning=metadata.taskLearning??null;
  if(taskLearning!==null){need(taskMode,'runner_learning');
    shape(taskLearning,['feature',...(Object.hasOwn(taskLearning,'hostHandoff')?['hostHandoff']:[])]);
    text(taskLearning.feature);if(Object.hasOwn(taskLearning,'hostHandoff'))need(taskLearning.hostHandoff===true,'runner_learning');}
  const bootstrap=options.bootstrap??null;
  if(bootstrap!==null){
    need(taskMode&&taskLearning?.hostHandoff===true,'bootstrap_task_required');
    metadata=json({...metadata,bootstrap:bootstrapConfiguration(bootstrap,{root:config.root,identity:config.identity,
      scope:config.scope,feature:taskLearning.feature})});
  }
  let store=null,journal=null,restored=null,storeRevision=null,poisoned=false;
  let completion=null,storeIdentity=null,storeOperating=false,liveToken=null,completeEffect=null,taskCommit=null;
  const version=taskMode?(invocationMode?3:2):1;
  if(Object.hasOwn(options,'persistence')) {
    shape(options.persistence,['store','mode',...(taskMode?['version']:[])]);store=options.persistence.store;
    if(taskMode){need(options.persistence.version===version,'runner_version');completion={owner:taskOwnerTarget(store)};}
    need(store && typeof store.snapshot==='function' && typeof store.append==='function');
    need(['create','resume'].includes(options.persistence.mode));
    const saved=store.snapshot();
    need(saved.identity.repositoryId===config.identity.repositoryId && saved.identity.runId===config.identity.runId,'identity_mismatch');
    journal=saved.records;storeRevision=saved.revision;
    if(taskMode){
      const selection=json(options.taskCompletion);shape(selection,['reviewsDir','handoffs']);
      const absolute=p=>need(typeof p==='string'&&!p.includes('\0')&&path.isAbsolute(p)&&path.resolve(p)===p,'unsupported_path');
      absolute(selection.reviewsDir);need(fs.realpathSync(selection.reviewsDir)===selection.reviewsDir
        &&fs.lstatSync(selection.reviewsDir).isDirectory(),'unsupported_path');
      need(Array.isArray(selection.handoffs)&&selection.handoffs.length===2);
      for(const [index,p] of selection.handoffs.entries()){absolute(p);
        if(taskLearning!==null)need(p===path.join(selection.reviewsDir,
          `${completion.owner.feature}-${config.identity.taskId}-a${index+1}-handoff.json`),'runner_completion');
        try{const s=fs.lstatSync(p);
        need(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&fs.realpathSync(p)===p,'unsupported_file');
      }catch(error){if(error.code!=='ENOENT')throw error;}}
      completion=json({version:1,mode:'fixture-task',owner:completion.owner,fingerprints:saved.fingerprints,...selection});
      storeIdentity=saved.identity;metadata=json({...metadata,completion});
    }
    if(options.persistence.mode==='resume')restored=readRunnerHistory(journal,metadata,version);
    else need(journal.length===0,'runner_exists');
  }
  const original=restored?.original??captureReviewBaseline(configToBaseline(metadata));
  const controller=new AbortController(),calls=[],cache=new Map(),session=restored?.session??randomUUID(),registered=new Map(),receipts=[];
  let state=reviewers.some(r=>r.allowed&&r.available)?'ready':'pending_review',code=null,attempt=1;
  let busy=false,pending=null,sequence=0,base=original,reviewPackage=null,currentChecks=null,workflowRunning=false;
  let receipt=null,priorReview=null,cancelAfterCommit=false,workflowError=null,cancellationRequested=false,reviewInvocation=null;
  let learningResult=null;
  const acceptedFixes=structuredClone(restored?.acceptedFixes??[]);
  const handoffBinding=(pkg=reviewPackage)=>pkg&&Object.hasOwn(pkg,'handoff')
    ?{handoffPath:completion.handoffs[pkg.identity.attempt-1]}:{};
  function publishRegisteredReview(inspectOnly=false){
    if(!invocationMode||taskLearning?.hostHandoff!==true||!receipt||!reviewPackage?.handoff)return;
    need(inspectOnly||!busy,'busy');
    publishHostReview({reviewsDir:completion.reviewsDir,feature:completion.owner.feature,inspectOnly,
      ...handoffBinding(),reviewPackage,receipt,registered:registered.get(receipt.id),
      at:reviewInvocation.registration.registeredAt});
  }
  const privateStatus=()=>json({state,code,identity:{...config.identity,attempt},packageDigest:reviewPackage?.packageDigest??null,
    receipt,receipts,calls,cancelAfterCommit,workflowError,...(store?{cancellationRequested}:{}),...(taskMode?{taskCommit}:{}),
    ...(invocationMode?{reviewInvocation}:{}),...(taskLearning!==null?{learningWriteback:learningResult?.writeback??null}:{})},16*1024*1024);
  let publication;
  const status=()=>{
    const current=store?publication:privateStatus();
    if(!busy&&!poisoned)try{publishRegisteredReview(true);}
    catch{return freeze({...current,code:'review_publication_required'});}
    if(current.state!=='fixture_completed')return current;
    try {
      if(acceptedFixes.length){
        for(const item of acceptedFixes){
          const {handoffDigest,...binding}=item.evidence.qaSource;
          const history=readHostQaFixHistory({...binding,specsDir:completion.owner.specsRoot,codeProject:config.root});
          need(history.handoffDigest===handoffDigest,'fix_qa_source_changed');
        }
        inspectFixCodeAssociation({root:config.root,specsRoot:completion.owner.specsRoot,baseline:base,
          parentPackage:reviewPackage,fixPackages:acceptedFixes.map(item=>item.evidence.reviewPackage)});
        const last=acceptedFixes.at(-1);
        return freeze({...current,acceptedQaFix:{qaRound:last.qaRound,testRunId:last.evidence.qaSource.testRunId,
          evidenceDigest:digest(last)}});
      }
      verifyReviewPackage({root:config.root,baseline:base,checks:currentChecks,
        reviewPackage,expectedDigest:reviewPackage.packageDigest,...handoffBinding()});
      return current;
    } catch {return freeze({...current,code:'correction_review_required'});}
  };
  const halt=(next,why)=>{state=next;code=why;};
  function frame(){return {state,code,attempt,session,sequence,reviewPackage,currentChecks,receipt,receipts,calls,
    cache:[...cache.values()],priorReview,cancelAfterCommit,workflowError,cancellationRequested,...(taskMode?{taskCommit}:{}),
    ...(invocationMode?{reviewInvocation}:{}),...(taskLearning!==null?{learningResult}:{})};}
  const same=(a,b,why)=>need(digest(a)===digest(b),why);
  function revoke(){if(liveToken){commitCapabilities.delete(liveToken);liveToken=null;}}
  function storeOperation(fn){
    if(poisoned||storeOperating){poison();need(false,'store_failure');}
    storeOperating=true;
    try{const value=fn();need(!poisoned,'store_failure');return value;}
    catch(error){poison();throw error;}finally{storeOperating=false;}
  }
  function currentStore(){
    same(taskOwnerTarget(store),completion.owner,'task_owner_mismatch');const current=store.snapshot();
    same(current.identity,storeIdentity,'identity_mismatch');same(current.fingerprints,completion.fingerprints,'identity_mismatch');
    need(current.revision===storeRevision,'runner_store_changed');need(!poisoned,'store_failure');return current;
  }
  function candidate(type,fields){
    const basic={id:`runner.${String(journal.length+1).padStart(6,'0')}`,
      kind:{init:'result','effect-intent':'intent','effect-checkpoint':'result',control:'cancel',
        'task-commit-intent':'commit-intent','task-commit-result':'commit-result',
        'review-invocation-registered':'intent','review-invocation-started':'result','review-invocation-result':'result',
        'qa-fix-accepted':'result'}[type],
      payload:version===3?runnerPayloadV3(type,fields):runnerPayload(type,fields,version)};
    const body={version:1,seq:journal.length+1,...basic,previousDigest:journal.at(-1)?.digest??null};
    const record={...body,digest:digest(body)};boundRunnerRecord(record,body.seq);
    return {record,parsed:readRunnerHistory([...journal,record],metadata,version)};
  }
  function persist(type,fields) {
    if(!store)return;
    if(taskMode)return storeOperation(()=>{
      const current=currentStore(),{record,parsed}=candidate(type,fields);
      need(!poisoned,'store_failure');
      store.append({id:record.id,kind:record.kind,payload:record.payload,expectedRevision:storeRevision});
      const saved=store.snapshot();need(!poisoned,'store_failure');
      const {revision:old,...body}=current,expected={...body,records:[...journal,record]};
      same(saved,{...expected,revision:digest(expected)},'runner_store_changed');
      need(!poisoned,'store_failure');journal=saved.records;storeRevision=saved.revision;
      if(type.startsWith('task-commit-'))taskCommit=parsed.state.taskCommit;
      return record;
    });
    need(!poisoned,'store_failure');
    const current=store.snapshot();need(current.revision===storeRevision,'runner_store_changed');
    const record={id:`runner.${String(journal.length+1).padStart(6,'0')}`,
      kind:{init:'result','effect-intent':'intent','effect-checkpoint':'result',control:'cancel'}[type],payload:runnerPayload(type,fields)};
    boundRunnerRecord(record,journal.length+1);
    const next=[...journal,record];readRunnerHistory(next,metadata);
    store.append({...record,expectedRevision:storeRevision});const saved=store.snapshot();journal=saved.records;storeRevision=saved.revision;
  }
  function poison() {
    poisoned=true;revoke();halt('unknown','store_failure');controller.abort();publication=privateStatus();return publication;
  }
  function nativeCompletion(fresh){
    const input=json({selectors:{tasksPath:completion.owner.tasksPath,feature:completion.owner.feature,
      reviewsDir:completion.reviewsDir,handoff:completion.handoffs[attempt-1]},root:config.root,
      identity:{...config.identity,attempt},baseline:base,reviewPackage,checks:fresh,receipt,
      registered:registered.get(receipt?.id),execution:calls.find(c=>c.invocationId===receipt?.id)},16*1024*1024);
    need(completeEffect?.effect.identity.attempt===attempt&&state==='committing'&&busy,'commit_phase_invalid');
    const token=Object.freeze({});liveToken=token;
    let phase='prepared';
    const ack=()=>json({owner:completion.owner,identity:input.identity,fingerprints:completion.fingerprints,
      inputDigest:digest(input),phase,intentDigest:taskCommit?.intentDigest??null,
      planDigest:taskCommit?.planDigest??null,resultDigest:taskCommit?.resultDigest??null});
    commitCapabilities.set(token,{store,resolve:(action,payload)=>{
      need(liveToken===token&&state==='committing'&&busy&&completeEffect,'commit_capability_invalid');
      if(action==='guard'){storeOperation(currentStore);return ack();}
      need(action==='append-intent'?phase==='prepared':phase==='intent','commit_phase_invalid');
      const fields={effectId:completeEffect.effect.id,completeIntentDigest:completeEffect.digest,commit:json(payload)};
      const type=action==='append-intent'?'task-commit-intent':'task-commit-result';
      // Invalid caller data is rejected before invoking the appender. The actual
      // append repeats preflight against its protected current cursor.
      candidate(type,fields);
      persist(type,fields);need(!poisoned&&liveToken===token,'store_failure');
      phase=action==='append-intent'?'intent':'result';return ack();
    }});
    try{
      const result=commitRunnerFixture(token,store,input,controller.signal);
      need(!poisoned&&phase==='result'&&taskCommit?.resultDigest,'commit_unknown');
      same(result,{outcome:'fixture_committed',intentDigest:taskCommit.intentDigest,planDigest:taskCommit.planDigest},'commit_unknown');
    }finally{revoke();}
  }
  if(restored) {
    const s=structuredClone(restored.state);
    ({state,code,attempt,sequence,reviewPackage,currentChecks,receipt,priorReview,cancelAfterCommit,workflowError,cancellationRequested}=s);
    if(taskLearning!==null)learningResult=s.learningResult;
    if(taskMode)taskCommit=s.taskCommit;
    if(invocationMode)reviewInvocation=s.reviewInvocation;
    calls.push(...s.calls);receipts.push(...s.receipts);s.cache.forEach(c=>cache.set(c.effect.id,c));
    receipts.forEach(r=>registered.set(r.id,r));base=attemptBaseline(original,attempt);
  } else persist('init',{config:metadata,baseline:original,session});
  publication=privateStatus();
  function control(event) {
    if(poisoned)return false;
    try{persist('control',{event});return true;}catch{poison();return false;}
  }
  function cancel() {
    if(poisoned)return status();
    if(['committing','fixture_completed'].includes(state)){
      if(!cancelAfterCommit && control('late-cancel')){cancelAfterCommit=true;cancellationRequested=true;
        publication=json({...publication,cancelAfterCommit:true,...(store?{cancellationRequested}:{})},16*1024*1024);}
      return status();
    }
    if(!['blocked','unknown','cancelled'].includes(state) && control('cancel')){
      halt('cancelled','cancelled');cancellationRequested=true;controller.abort();publication=json({...publication,state,code,...(store?{cancellationRequested}:{})},16*1024*1024);
    }
    return status();
  }
  function active(){need(!poisoned,'store_failure');need(state!=='cancelled','cancelled');}
  async function bounded(fn,request) {
    active();let timer,abort;
    try {
      const boxed=await Promise.race([
        new Promise((resolve,reject)=>{
          // Validate synchronous values before resolving any Promise with them.
          const accept=value=>{try {resolve({value:json(value)});}catch(error){reject(error);}};
          queueMicrotask(()=>{
            try {
              active();const returned=fn(request,{signal:controller.signal});
              if(types.isPromise(returned)) {
                const supported=Object.getPrototypeOf(returned)===promisePrototype
                  && !Object.hasOwn(returned,'constructor');
                const observed=observePromise(returned,supported?accept:ignorePromiseResult,
                  supported?reject:ignorePromiseResult);
                need(supported && observed);
              } else accept(returned);
            } catch(error){reject(error);}
          });
        }),
        new Promise((_,reject)=>{
          abort=()=>reject(Object.assign(new Error('cancelled'),{code:'cancelled'}));
          controller.signal.addEventListener('abort',abort,{once:true});
          timer=setTimeout(()=>{reject(Object.assign(new Error('call_timeout'),{code:'call_timeout'}));controller.abort();},config.timeoutMs);
        })
      ]);
      return boxed.value;
    } finally {clearTimeout(timer);controller.signal.removeEventListener('abort',abort);}
  }
  async function invoke(adapter,role,contextId,payload) {
    const request=requestFor({invocationId:`${session}.${++sequence}`,identity:{...config.identity,attempt},
      role,provider:adapter.provider,requestedModel:adapter.requestedModel,contextId,payload});
    const call={invocationId:request.invocationId,contextId,provider:adapter.provider,requestedModel:adapter.requestedModel,
      effectiveModel:'unknown',channel:'fixture',started:true,terminal:'running',requestDigest:request.requestDigest,resultDigest:null};
    calls.push(call);
    try {
      const response=terminalFor(await bounded(adapter.run,request),request);active();
      call.terminal=response.status;call.effectiveModel=response.effectiveModel;call.resultDigest=digest(response.result);
      if(Object.hasOwn(response,'providerThreadId'))call.providerThreadId=response.providerThreadId;
      return {request,response,call};
    } catch(error){call.terminal=state==='cancelled'?'cancelled':'unknown';throw error;}
  }
  function acceptReview(request,call,rawResult,fallbackReasons=[]) {
    const result=reviewResult(rawResult,reviewPackage);
    verifyReviewPackage({root:config.root,baseline:base,checks:currentChecks,
      reviewPackage,expectedDigest:reviewPackage.packageDigest,...handoffBinding()});
    receipt=reviewReceipt({request,call,result,reviewPackage,developerProvider:developer.provider,fallbackReasons});
    registered.set(receipt.id,receipt);receipts.push(receipt);priorReview=result;
    if(result.verdict==='approved'){state='approved';code=null;}
    else if(result.verdict==='changes_requested' && attempt===1) {
      state='changes_requested';code=null;attempt=2;
      const {baselineDigest:old,...data}=original,newData={...data,identity:{...config.identity,attempt}};
      base=freeze({...newData,baselineDigest:digest(newData)});
    } else halt('blocked',result.verdict==='changes_requested'?'review_limit':'review_blocked');
  }
  const clock=Date.now.bind(Date);
  const safeTime=()=>{const value=clock();need(Number.isSafeInteger(value),'clock_invalid');return value;};
  const resultView=fields=>json(Object.fromEntries(Object.entries(fields)
    .filter(([key])=>!['effectId','invocationId'].includes(key))),512*1024);
  async function invokeObserved(adapter,contextId,payload,effectId) {
    const nextSequence=sequence+1,request=requestFor({invocationId:`${session}.${nextSequence}`,
      identity:{...config.identity,attempt},role:'reviewer',provider:adapter.provider,
      requestedModel:adapter.requestedModel,contextId,payload});
    let authorizationAt;
    try{authorizationAt=safeTime();}catch{halt('unknown','clock_invalid');return;}
    let grant;
    try{
      const returned=authorize(request,Object.freeze({authorizationAt}));
      if(types.isPromise(returned)){
        observePromise(returned,ignorePromiseResult,ignorePromiseResult);
        if(state==='cancelled'||controller.signal.aborted)return;
        need(false,'authorization_invalid');
      }
      if(state==='cancelled'||controller.signal.aborted)return;
      grant=json(returned);
      if(digest(grant)===digest({status:'denied',code:'permission_denied'})){
        halt('pending_review','permission_denied');return;
      }
    }catch(error){
      if(state==='cancelled'||controller.signal.aborted)return;
      halt('unknown',failureCode(error)==='clock_invalid'?'clock_invalid':'authorization_invalid');return;
    }
    if(state==='cancelled'||controller.signal.aborted)return;
    let registeredAt;
    try{registeredAt=safeTime();}catch{halt('unknown','clock_invalid');return;}
    if(registeredAt<authorizationAt){halt('unknown','clock_invalid');return;}
    try{grant=validateReviewDispatchGrant(grant,{request,reviewerId:adapter.id,adapterId:adapter.adapterId,
      packageDigest:reviewPackage.packageDigest,hostContextIds:[invocationConfig.developerThreadId,...invocationConfig.excludedThreadIds],
      authorizationAt,registeredAt});}
    catch{halt('unknown','authorization_invalid');return;}
    const registrationFields={effectId,reviewerId:adapter.id,adapterId:adapter.adapterId,requestDigest:request.requestDigest,
      authorizationAt,registeredAt,grant};
    persist('review-invocation-registered',registrationFields);
    sequence=nextSequence;
    const registration=json({reviewerId:adapter.id,adapterId:adapter.adapterId,requestDigest:request.requestDigest,
      authorizationAt,registeredAt,grant});
    const call={invocationId:request.invocationId,contextId,provider:request.provider,requestedModel:adapter.requestedModel,
      effectiveModel:'unknown',channel:'host-authorized',started:false,terminal:'running',requestDigest:request.requestDigest,
      resultDigest:null,providerThreadId:null};
    calls.push(call);
    let dispatchAt=null,notDispatched=null;
    try{dispatchAt=safeTime();if(dispatchAt<registeredAt)notDispatched='clock_invalid';
      else if(dispatchAt>=grant.expiresAt)notDispatched='grant_expired';}
    catch{notDispatched='clock_invalid';}
    if(notDispatched){
      const fields={effectId,invocationId:request.invocationId,dispatchAt,outcome:'not_dispatched',observation:null,inspection:null,
        reconciliationRequired:true,reason:notDispatched};
      persist('review-invocation-result',fields);const result=resultView(fields);
      Object.assign(call,{terminal:'not_dispatched',resultDigest:digest(result)});
      reviewInvocation=json({registration,started:null,result});halt('pending_review',notDispatched);return;
    }
    call.started=true;
    const expectation={request,developerThreadId:invocationConfig.developerThreadId,
      excludedThreadIds:reviewExclusions(invocationConfig,calls,developer.contextId)};
    const events=[];let started=null,sealed=false,invalid=false,invalidReject;
    const localController=new AbortController();
    const abort=()=>localController.abort();controller.signal.addEventListener('abort',abort,{once:true});
    const observation=result=>json({version:1,kind:'cm-provider-review-observation',requestDigest:request.requestDigest,
      events,result},512*1024);
    const rejectedObservation=()=>json({version:1,kind:'cm-provider-review-observation',requestDigest:request.requestDigest,
      events,result:{status:'invalid',code:'observation_invalid'}},512*1024);
    const invalidFields=()=>({effectId,invocationId:request.invocationId,dispatchAt,outcome:'unknown',
      observation:rejectedObservation(),inspection:null,reconciliationRequired:true,reason:'observation_invalid'});
    const invalidPromise=new Promise((_,reject)=>{invalidReject=reject;});
    const onEvent=raw=>{
      if(sealed)return false;
      let event;
      try{event=json(raw,64*1024);const candidate=json({version:1,kind:'cm-provider-review-observation',
        requestDigest:request.requestDigest,events:[...events,event],result:{status:'failed',code:'in_progress'}},512*1024);
        inspectProviderReview(JSON.stringify(candidate),JSON.stringify(expectation));
        if(event.event==='thread.started'){
          need(started===null&&event.provider_thread!==request.contextId,'observation_invalid');
          persist('review-invocation-started',{effectId,invocationId:request.invocationId,providerThreadId:event.provider_thread});
          started=event.provider_thread;call.providerThreadId=started;
        }
        events.push(event);return true;
      }catch(error){
        try{event=json(raw,64*1024);}catch{event={event:'invalid',item_type:null};}
        try{json({version:1,kind:'cm-provider-review-observation',requestDigest:request.requestDigest,
          events:[...events,event],result:{status:'invalid',code:'observation_invalid'}},512*1024);}
        catch{event={event:'invalid',item_type:null};}
        events.push(event);invalid=true;sealed=true;localController.abort();
        invalidReject(Object.assign(new Error('observation_invalid'),{code:'observation_invalid'}));return false;
      }
    };
    let timer,timedOut=false,cancelReject;
    try{
      let raw;
      try{
        raw=await Promise.race([
          new Promise((resolve,reject)=>queueMicrotask(()=>{
            try{
              need(!localController.signal.aborted,'cancelled');
              const returned=adapter.run(request,{signal:localController.signal,onEvent});
              if(types.isPromise(returned)){
                const supported=Object.getPrototypeOf(returned)===promisePrototype&&!Object.hasOwn(returned,'constructor');
                const observed=observePromise(returned,supported?resolve:ignorePromiseResult,supported?reject:ignorePromiseResult);
                need(supported&&observed);
              }else resolve(returned);
            }catch(error){reject(error);}
          })),
          invalidPromise,
          new Promise((_,reject)=>{timer=setTimeout(()=>{timedOut=true;localController.abort();
            reject(Object.assign(new Error('call_timeout'),{code:'call_timeout'}));},config.timeoutMs);}),
          new Promise((_,reject)=>{cancelReject=()=>reject(Object.assign(new Error('cancelled'),{code:'cancelled'}));
            controller.signal.addEventListener('abort',cancelReject,{once:true});})
        ]);
      }catch(error){
        sealed=true;
        let fields;
        if(invalid){fields=invalidFields();}
        else if(timedOut){fields={effectId,invocationId:request.invocationId,dispatchAt,outcome:'timed_out',
          observation:observation({status:'failed',code:'timeout'}),inspection:null,reconciliationRequired:true};}
        else if(state==='cancelled'){fields={effectId,invocationId:request.invocationId,dispatchAt,outcome:'cancelled',
          observation:observation({status:'cancelled',code:'cancelled'}),inspection:null,reconciliationRequired:true};}
        else {
          const recorded=observation({status:'failed',code:failureCode(error)}),inspection=inspectProviderReview(JSON.stringify(recorded),JSON.stringify(expectation));
          fields={effectId,invocationId:request.invocationId,dispatchAt,outcome:'unknown',observation:recorded,inspection,reconciliationRequired:true};
        }
        persist('review-invocation-result',fields);const result=resultView(fields);
        Object.assign(call,{terminal:fields.outcome==='cancelled'?'cancelled':'unknown',resultDigest:digest(result)});
        reviewInvocation=json({registration,started,result});
        if(fields.outcome==='cancelled')halt('cancelled','cancelled');
        else halt('unknown',fields.reason??fields.inspection?.code??'reconciliation_required');return;
      }
      sealed=true;
      let providerResult;
      try{
        providerResult=json(raw);
        if(providerResult?.status==='succeeded')shape(providerResult,['status','value']);
        else {shape(providerResult,['status','code']);need(['failed','cancelled'].includes(providerResult.status));
          text(providerResult.code);need(providerResult.code.length<=256);}
      }catch(error){
        const recorded=observation({status:'failed',code:failureCode(error)}),inspection=inspectProviderReview(JSON.stringify(recorded),JSON.stringify(expectation));
        const fields={effectId,invocationId:request.invocationId,dispatchAt,outcome:'unknown',observation:recorded,inspection,reconciliationRequired:true};
        persist('review-invocation-result',fields);const result=resultView(fields);
        Object.assign(call,{terminal:'unknown',resultDigest:digest(result)});reviewInvocation=json({registration,started,result});
        halt('unknown',inspection.code??'reconciliation_required');return;
      }
      let recorded,inspection;
      try{recorded=observation(providerResult);inspection=inspectProviderReview(JSON.stringify(recorded),JSON.stringify(expectation));}
      catch{
        const fields=invalidFields();persist('review-invocation-result',fields);const result=resultView(fields);
        Object.assign(call,{terminal:'unknown',resultDigest:digest(result)});reviewInvocation=json({registration,started,result});
        halt('unknown','observation_invalid');return;
      }
      const observed=inspection.observationStatus==='completed';
      const fields={effectId,invocationId:request.invocationId,dispatchAt,outcome:observed?'observed':'unknown',
        observation:recorded,inspection,reconciliationRequired:!observed};
      persist('review-invocation-result',fields);const result=resultView(fields);
      Object.assign(call,{terminal:observed?'succeeded':'unknown',resultDigest:digest(observed?inspection.review:result)});
      reviewInvocation=json({registration,started,result});
      if(observed)acceptReview(request,call,inspection.review);
      else halt('unknown',inspection.code??'reconciliation_required');
    }finally{sealed=true;clearTimeout(timer);controller.signal.removeEventListener('abort',abort);
      if(cancelReject)controller.signal.removeEventListener('abort',cancelReject);}
  }
  async function collectChecks(){return json(await bounded(check,json({identity:{...config.identity,attempt}})));}
  async function perform(v) {
    if(v.kind==='develop') {
      need(['ready','changes_requested'].includes(state),'stage_mismatch');state='developing';receipt=null;
      const previousBootstrap=learningResult?.bootstrap??null;
      const previousWriteback=learningResult?.writeback??null;
      if(taskLearning!==null)learningResult=null;
      const adapter=bootstrap===null?developer:{...developer,run:(request,control)=>
        bootstrap.run(request,control,developer.run,{previous:previousBootstrap,previousWriteback,baseline:original})};
      const result=await invoke(adapter,'developer',developer.contextId,{scope:config.scope,
        requirements:original.files.filter(f=>config.requirements.includes(f.path)),priorReview,
        ...(Object.hasOwn(v,'learningInput')?{learningInput:v.learningInput}:{})});
      if(result.response.status!=='succeeded'){halt(result.response.status==='unknown'?'unknown':'blocked',result.response.status);return;}
      if(taskLearning===null)shape(result.response.result,['outcome']);
      else {
        const instructionBootstrap=metadata.bootstrap?.mode==='instructions';
        shape(result.response.result,['outcome','application','retrospective',...(instructionBootstrap?['bootstrap']:[])]);
        need(result.response.result.outcome==='implemented','invalid_result');
        const instructionEvidence=instructionBootstrap?readBootstrapEvidence(result.response.result.bootstrap,
          metadata.bootstrap,v.identity):null;
        if(instructionEvidence)need(instructionEvidence.invocationId===result.request.invocationId,'identity_mismatch');
        const application=readCmAiTaskLearningApplication(result.response.result.application);
        need(application.feature===v.learningInput.feature
          &&digest(application.identity)===digest(v.learningInput.identity)
          &&application.learningDigest===v.learningInput.learningDigest,'identity_mismatch');
        const retrospective=json(result.response.result.retrospective,16*1024);
        const writeback=readCmAiProjectLearningWriteback(writeCmAiProjectLearning({codeProject:config.root,
          learningInput:v.learningInput,retrospective},instructionEvidence?.files.find(file=>file.path==='AGENTS.md').afterSha256??null),
        {learningInput:v.learningInput,retrospective});
        learningResult=freeze({application,retrospective,writeback,...(instructionEvidence?{bootstrap:instructionEvidence}:{})});
        if(writeback.outcome==='writeback_pending'){halt('blocked','learning_writeback_pending');return;}
        if(taskLearning.hostHandoff===true){
          currentChecks=await collectChecks();active();
          createHostHandoff({root:config.root,baseline:base,checks:currentChecks,
            handoffPath:completion.handoffs[attempt-1]});
        }
        writeCmAiTaskLearningHandoff({handoffPath:completion.handoffs[attempt-1],feature:taskLearning.feature,
          identity:{...config.identity,attempt},learningInput:v.learningInput,application,retrospective,writeback});
      }
      need(result.response.result.outcome==='implemented','invalid_result');
      if(taskLearning?.hostHandoff!==true)currentChecks=await collectChecks();active();
      const nextPackage=createReviewPackage({root:config.root,baseline:base,checks:currentChecks,
        ...(taskLearning?.hostHandoff===true?{handoffPath:completion.handoffs[attempt-1]}:{})});
      if(taskLearning!==null)validateTaskLearningReviewPackage(nextPackage,learningResult.writeback,v.learningInput,
        learningResult.bootstrap??null,metadata.bootstrap??null);
      reviewPackage=nextPackage;
      state='awaiting_review';return;
    }
    if(v.kind==='review') {
      state='reviewing';verifyReviewPackage({root:config.root,baseline:base,checks:currentChecks,
        reviewPackage,expectedDigest:reviewPackage.packageDigest,...handoffBinding()});
      if(invocationMode){await invokeObserved(reviewers[0],reviewers[0].contexts[attempt-1],{reviewPackage,priorReview},v.id);return;}
      const fallbackReasons=[];
      for(const candidate of reviewers) {
        active();
        if(!candidate.allowed || !candidate.available){fallbackReasons.push({id:candidate.id,reason:!candidate.allowed?'not_authorized':'unavailable'});continue;}
        const {request,response,call}=await invoke(candidate,'reviewer',candidate.contexts[attempt-1],{reviewPackage,priorReview});
        if(['unavailable','auth_required','permission_denied'].includes(response.status)) {
          fallbackReasons.push({id:candidate.id,reason:response.status});continue;
        }
        if(response.status!=='succeeded'){halt(response.status==='unknown'?'unknown':'pending_review',response.status);return;}
        acceptReview(request,call,response.result,fallbackReasons);
        return;
      }
      halt('pending_review','review_channels_unavailable');return;
    }
    if(v.kind==='complete') {
      const fresh=await collectChecks();active();
      try {
        verifyReviewPackage({root:config.root,baseline:base,checks:fresh,reviewPackage,expectedDigest:reviewPackage.packageDigest,...handoffBinding()});
      } catch(error){halt('blocked',failureCode(error));return;}
      if(taskLearning!==null)try {
        const learningInput=currentLearningInput();
        verifyCmAiTaskLearningHandoff({handoffPath:completion.handoffs[attempt-1],feature:taskLearning.feature,
          identity:{...config.identity,attempt},learningInput,
          ...(Object.hasOwn(learningResult,'application')?{application:learningResult.application}:{}),
          retrospective:learningResult.retrospective,
          writeback:learningResult.writeback});
      } catch {halt('blocked','package_mismatch');return;}
      try {
        checkCompletion({receipt,registered:registered.get(receipt?.id),execution:calls.find(c=>c.invocationId===receipt?.id),
          reviewPackage,identity:{...config.identity,attempt}});
      } catch(error){halt('blocked',failureCode(error));return;}
      active();state='committing';
      if(taskMode){nativeCompletion(fresh);state='fixture_completed';return;}
      const returned=commit(json({identity:{...config.identity,attempt},packageDigest:reviewPackage.packageDigest,receiptDigest:receipt.receiptDigest}));
      if(types.isPromise(returned)) {
        observePromise(returned,ignorePromiseResult,ignorePromiseResult);need(false,'async_commit');
      }
      const result=json(returned);shape(result,['outcome']);need(result.outcome==='fixture_completed','commit_unknown');
      state='fixture_completed';return;
    }
  }
  function executeEffect(raw) {
    let v;
    try {
      need(!poisoned,'store_failure');v=json(raw);
      shape(v,['version','id','identity','kind',...(Object.hasOwn(v,'learningInput')?['learningInput']:[])]);id(v.id);validIdentity(v.identity);
      need(v.version===1 && ['develop','review','complete'].includes(v.kind));
      if(v.kind==='develop'&&taskLearning!==null)need(Object.hasOwn(v,'learningInput'),'runner_learning');
      if(Object.hasOwn(v,'learningInput')){need(v.kind==='develop'&&taskLearning!==null,'runner_learning');
        validTaskLearningInput(v.learningInput,v.identity,taskLearning.feature);}
      for(const k of ['repositoryId','runId','taskId'])need(v.identity[k]===config.identity[k],'identity_mismatch');
      // Publication is retryable local projection, never a provider redispatch.
      // Recovered/cached reviews can repair a missing file from the same receipt.
      try{publishRegisteredReview();}catch(error){
        if(error.code==='busy')throw error;
        need(false,'review_publication_required');
      }
      const old=cache.get(v.id);
      if(old){need(old.digest===digest(v),'intent_conflict');return Promise.resolve(old.result);}
      if(restored?.pending?.id===v.id){need(digest(restored.pending)===digest(v),'intent_conflict');return Promise.resolve(status());}
      need(!busy,'busy');need(v.identity.attempt===attempt,'attempt_mismatch');
      const allowed={develop:['ready','changes_requested'],review:['awaiting_review'],complete:['approved']};
      need(allowed[v.kind].includes(state),'stage_mismatch');need(cache.size<6,'limit_exceeded');
      if(v.kind==='develop'&&bootstrap!==null)bootstrap.assertWriteAuthorized();
    } catch(error){return Promise.resolve(freeze({outcome:'rejected',code:error.code??'invalid_input'}));}
    if(store) {
      try {
        if(state==='ready')need(digest(captureReviewBaseline(configToBaseline(metadata)))===digest(original),'package_mismatch');
        else verifyReviewPackage({root:config.root,baseline:state==='changes_requested'?attemptBaseline(original,attempt-1):base,
          checks:reviewPackage.checks,reviewPackage,expectedDigest:reviewPackage.packageDigest,...handoffBinding()});
      } catch {return Promise.resolve(freeze({outcome:'rejected',code:'package_mismatch'}));}
      try{const record=persist('effect-intent',{effect:v});
        if(taskMode&&v.kind==='complete')completeEffect={effect:v,digest:record.digest};
      }catch{return Promise.resolve(poison());}
    }
    busy=true;code=null;
    pending=(async()=>{
      try {await perform(v);}
      catch(error){if(state!=='cancelled')halt('unknown',failureCode(error));}
      if(poisoned)return status();
      const result=privateStatus();cache.set(v.id,{effect:v,digest:digest(v),result});
      try{persist('effect-checkpoint',{effectId:v.id,checkpoint:frame()});publication=result;return result;}
      catch{return poison();}
    })().finally(()=>{busy=false;pending=null;completeEffect=null;}).then(result=>{
      if(poisoned)return result;
      try{publishRegisteredReview();return result;}
      catch{return freeze({...result,code:'review_publication_required'});}
    });
    return pending;
  }
  function attachLearningEvidence(raw) {
    need(taskLearning!==null,'runner_learning');need(!poisoned,'store_failure');need(!busy,'busy');
    need(state==='awaiting_review','stage_mismatch');
    const input=json(raw,256*1024);shape(input,['handoff','application','retrospective']);
    const currentIdentity={...config.identity,attempt},learningInput=currentLearningInput();
    const applied=attachCmAiTaskLearningApplicationEvidence({handoff:input.handoff,feature:taskLearning.feature,
      identity:currentIdentity,learningInput,application:input.application});
    return attachCmAiTaskLearningEvidence({handoff:applied,feature:taskLearning.feature,
      identity:currentIdentity,learningInput,retrospective:input.retrospective});
  }
  function currentLearningInput() {
    const currentIdentity={...config.identity,attempt};
    const develop=[...cache.values()].filter(entry=>entry.effect.kind==='develop'
      &&digest(entry.effect.identity)===digest(currentIdentity));
    need(develop.length===1&&Object.hasOwn(develop[0].effect,'learningInput'),'runner_learning');
    return develop[0].effect.learningInput;
  }
  async function defaultWorkflow(ctx) {
    for(let round=1;round<=2;round++) {
      const effect=kind=>ctx.executeEffect({version:1,id:`${kind}-${round}`,identity:{...config.identity,attempt:round},kind});
      if((await effect('develop')).state!=='awaiting_review')return;
      const reviewed=await effect('review');
      if(reviewed.state==='changes_requested')continue;
      if(reviewed.state==='approved')await effect('complete');
      return;
    }
  }
  async function run(workflow=defaultWorkflow) {
    if(workflowRunning || busy)return freeze({outcome:'rejected',code:'busy'});
    if(typeof workflow!=='function')return freeze({outcome:'rejected',code:'invalid_input'});
    workflowRunning=true;let lease=true;
    const ctx=Object.freeze({executeEffect:v=>lease?executeEffect(v):Promise.resolve(freeze({outcome:'rejected',code:'workflow_closed'}))});
    try {await workflow(ctx);}
    catch {
      if(workflowError===null && control('workflow-error')) {
        const next=controlledState(frame(),'workflow-error',busy||restored?.pending!=null,version);
        ({state,code,workflowError}=next);
        publication=json({...publication,workflowError,...(!busy?{state,code}:{})},16*1024*1024);
      }
    }
    finally {
      lease=false;
      if(pending){const waiting=pending;cancel();await waiting;}
      workflowRunning=false;
    }
    return status();
  }
  // Read-only content comparison, not completion authority or a JSON operation.
  const inspectFixAssociation=fixPackage=>{
    need(!busy&&!poisoned,'host_busy');
    const current=status();
    need(current.state==='fixture_completed'&&current.code!=='review_publication_required','qa_fix_parent_not_completed');
    return inspectFixCodeAssociation({root:config.root,
      ...(completion?{specsRoot:completion.owner.specsRoot}:{}),
      baseline:base,parentPackage:reviewPackage,
      fixPackages:acceptedFixes.some(item=>item.evidence.reviewPackage.packageDigest===fixPackage.packageDigest)
        ?acceptedFixes.map(item=>item.evidence.reviewPackage)
        :[...acceptedFixes.map(item=>item.evidence.reviewPackage),fixPackage]});
  };
  const acceptCompletedFix=raw=>{
    need(invocationMode&&store&&!busy&&!poisoned,'fix_accept_unavailable');
    const evidence=json(raw,12*1024*1024),association=inspectFixAssociation(evidence.reviewPackage);
    const existing=acceptedFixes.find(item=>item.evidence.qaSource.testRunId===evidence.qaSource.testRunId);
    if(existing){need(digest(existing.evidence)===digest(evidence),'fix_evidence_changed');return json(existing,12*1024*1024);}
    const source=evidence.qaSource;
    const failure=inspectCmAiQaFailure({specsDir:completion.owner.specsRoot,feature:source.feature,
      identity:source.identity,packageDigest:source.packageDigest,testRunId:source.testRunId});
    const record=validateAcceptedFix({record:{evidence,association,qaRound:failure.qaRound},previous:acceptedFixes,
      baseline:base,parentPackage:reviewPackage,feature:taskLearning?.feature});
    persist('qa-fix-accepted',{record});acceptedFixes.push(record);
    return json(record,12*1024*1024);
  };
  const api={executeEffect,status,cancel,run,inspectFixAssociation,acceptCompletedFix};
  if(bootstrap!==null)api.inspectBootstrapAdmission=()=>bootstrap.inspectAdmission(original);
  if(taskLearning!==null)api.attachLearningEvidence=attachLearningEvidence;
  return Object.freeze(api);
}
function configToBaseline(c){
  const scope=Object.hasOwn(c,'taskLearning')&&!c.scope.includes('AGENTS.md')?[...c.scope,'AGENTS.md']:c.scope;
  return {root:c.root,identity:c.identity,scope,requirements:c.requirements,
    ...(c.codeProjectPaths?{codeProjectPaths:c.codeProjectPaths}:{}),
    ...(c.bootstrap?{bootstrapRequirements:c.bootstrap.bootstrapRequirements}:{}),
    ...(c.completion?{specsRoot:c.completion.owner.specsRoot}:{})};
}
