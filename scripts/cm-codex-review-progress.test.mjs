import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {captureReviewBaseline,createReviewPackage} from '../runtime/js/cm-ai/review-package.mjs';
import {createHostHandoff} from '../runtime/js/cm-ai/host-handoff.mjs';
import {createHostReviewAuthority} from '../runtime/js/cm-ai/host-review-authority.mjs';
import {createCodexReviewRun} from '../runtime/js/cm-ai/codex-review-adapter.mjs';
import {codexWorker} from '../runtime/js/cm-ai/worker-codex.mjs';
import {configFingerprint} from '../runtime/js/cm-ai/codex-config.mjs';
import {createFixFinalReview} from '../runtime/js/cm-fix/final-review.mjs';

// Synthetic raw CLI stream through the actual worker/adapter/fix observer.
// No provider process, real project, credentials or completion writes.
for(const mode of ['progress','tool','late-progress','early-progress','missing-result','wrong-digest','private-event','private-error',
  'startup-notice','early-notice','late-notice','duplicate-notice','changed-notice','notice-only']){
  test(`fix final review raw Codex stream: ${mode}`,async t=>{
    const temp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-review-progress-')));
    t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
    const root=path.join(temp,'code');fs.mkdirSync(root);
    fs.writeFileSync(path.join(root,'value.js'),'before');
    const identity={repositoryId:'fixture',runId:'progress',taskId:'T-FIX-one',attempt:1};
    const baseline=captureReviewBaseline({root,identity,scope:['value.js'],requirements:['value.js']});
    fs.writeFileSync(path.join(root,'value.js'),'after');
    const checks=[{id:'synthetic',command:['synthetic'],outcome:'passed',exitCode:0,evidence:'Fixture only'}];
    const handoffPath=path.join(temp,'handoff.json');
    createHostHandoff({root,baseline,checks,handoffPath,evidence:['learning: no_relevant_lesson','learning: retrospective no_new_lesson']});
    const pkg=createReviewPackage({root,baseline,checks,handoffPath});
    const reviewer={reviewerId:'final-reviewer',adapterId:'codex-review-adapter',provider:'codex',requestedModel:'fixture',contextId:'logical',excludedThreadIds:[]};
    const configuration={hostContextId:'author',reviewer};
    const authority=createHostReviewAuthority({hostContextId:'author',reviewerId:reviewer.reviewerId,adapterId:reviewer.adapterId,decide:async()=>({status:'approved'})});
    const signal=new AbortController().signal;
    await authority.hostDecisionProvider.decide({identity,packageDigest:pkg.packageDigest},signal);
    let registered=null,started=null,spawns=0;const events=[];
    const options={cwd:root,model:'fixture'};
    const worker=codexWorker({...options,schemaPath:'/unused',cli:'/must-not-run',timeoutMs:1000,
      preflight:{passed:true,cli_model:options.model,config_fingerprint:configFingerprint(options)},
      spawnProcess(){
        spawns++;assert(registered);
        const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.killed=false;
        let closed=false;
        const close=(code,exitSignal=null)=>{if(closed)return;closed=true;child.stdout.end();child.stderr.end();child.emit('close',code,exitSignal);};
        child.kill=exitSignal=>{child.killed=true;queueMicrotask(()=>close(null,exitSignal));return true;};
        queueMicrotask(()=>{
          const progress=['item.started','item.updated','item.completed'].map(type=>({type,item:{type:'reasoning',text:'synthetic'}}));
          progress.push(...['item.started','item.updated'].map(type=>({type,item:{type:'agent_message',text:''}})));
          const result={verdict:'approved',packageDigest:mode==='wrong-digest'?'0'.repeat(64):pkg.packageDigest,examinedPaths:['value.js'],findings:[],summary:'Synthetic'};
          const notice={type:'item.completed',item:{type:'error',message:'Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; enable `features.code_mode_host` and install `codex-code-mode-host`.'}};
          const rows=mode==='notice-only'?[{type:'thread.started',thread_id:'fresh-provider'},notice]:[
            ...(mode==='early-progress'?progress:[]),...(mode==='early-notice'?[notice]:[]),
            {type:'thread.started',thread_id:'fresh-provider'},
            ...(['startup-notice','duplicate-notice'].includes(mode)?[notice]:[]),
            ...(mode==='duplicate-notice'?[notice]:[]),
            ...(mode==='changed-notice'?[{...notice,item:{...notice.item,message:notice.item.message+' synthetic unknown diagnostic'}}]:[]),
            {type:'turn.started'},...(mode==='late-notice'?[notice]:[]),
            ...progress,...(mode==='tool'?[{type:'item.started',item:{type:'command_execution'}}]:[]),
            ...(mode==='private-event'?[{type:'private-provider-text',item:{type:'private-item-text'}}]:[]),
            ...(mode==='missing-result'?[]:[{type:'item.completed',item:{type:'agent_message',text:JSON.stringify(result)}}]),
            {type:'turn.completed'},...(mode==='late-progress'?progress:[])];
          for(const row of rows){if(child.killed)break;child.stdout.write(JSON.stringify(row)+'\n');}
          if(!child.killed)close(0);
        });
        return child;
      }});
    const adapter=createCodexReviewRun(worker);
    let errorGetterCalls=0;
    const run=(request,control)=>{
      if(mode==='private-error')throw Object.defineProperty(new Error('private-provider-text'),'code',
        {get(){errorGetterCalls++;throw Error('private-code-text');}});
      return adapter(request,{...control,onEvent:e=>{events.push(e);return control.onEvent(e);}});
    };
    const review=createFixFinalReview({reviewPackage:pkg,configuration,timeoutMs:2000},{authorize:authority.authorize,run});
    const result=await review({signal,register:r=>{registered=r;},onStarted:id=>{started=id;}});
    const success=['progress','startup-notice'].includes(mode);
    if(success)assert.equal(result.outcome,'observed');
    else if(result.outcome==='observed'){
      assert.equal(result.inspection.observationStatus,'unknown');
      assert.equal(result.inspection.review,null);
    }else assert.equal(result.outcome,'unknown');
    if(mode==='tool')assert.deepEqual(result.diagnostic,{phase:'event',code:'observation_invalid',event:'item.started',itemType:'command_execution'});
    if(mode==='wrong-digest')assert.deepEqual(result.diagnostic,{phase:'result',code:'review_package_mismatch'});
    if(mode==='private-event')assert.deepEqual(result.diagnostic,{phase:'event',code:'observation_invalid',event:'other',itemType:'other'});
    if(mode==='private-error')assert.deepEqual(result.diagnostic,{phase:'transport',code:'execution_error'});
    assert.equal(errorGetterCalls,0);assert(!(JSON.stringify(result.diagnostic)??'').includes('private-'));
    assert.equal(result.completionEligible,false);assert.equal(spawns,mode==='private-error'?0:1);
    if(success){
      assert.equal(started,'fresh-provider');assert.equal(result.inspection.review.verdict,'approved');
      assert.deepEqual(events.map(e=>e.event),['thread.started','turn.started','item.completed','turn.completed','process_closed']);
    }
    await assert.rejects(review({signal,register(){},onStarted(){}}),{code:'final_review_already_attempted'});
    assert.equal(spawns,mode==='private-error'?0:1);
  });
}
