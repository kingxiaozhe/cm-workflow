import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {PassThrough,Writable} from 'node:stream';
import {main} from './cm-fix-host.mjs';
import {configFingerprint} from '../runtime/js/cm-ai/codex-config.mjs';
import {openFixExecution} from '../runtime/js/cm-fix/execution.mjs';
import {createFixReviewHost} from '../runtime/js/cm-fix/host-review.mjs';
import {createFixHost} from '../runtime/js/cm-fix/host.mjs';
import {eventsAt} from '../runtime/js/cm-fix/finish.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
import {verifyVisualCarrier,observeVisualAfter} from '../runtime/js/cm-fix/visual.mjs';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7l8AAAAASUVORK5CYII=','base64');
function carrier(file,caption){const bytes=Buffer.concat([png,Buffer.from(caption)]);fs.writeFileSync(file,bytes);
  return {path:file,kind:'screenshot',sha256:createHash('sha256').update(bytes).digest('hex'),description:`Synthetic fixture: ${caption}`};}
function fixture(t){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'fix-visual-bare-'))),cwd=path.join(root,'code');fs.mkdirSync(cwd);
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.writeFileSync(path.join(cwd,'style.css'),'button { color:red; }');
  fs.writeFileSync(path.join(cwd,'.cm-workflow.json'),JSON.stringify({version:1,policies:{delivery:'diff'}}));
  const environment={scope:'local',kind:'web',carrier:'browser',target:'http://127.0.0.1:3000'};
  const visual={kind:'visual',cwd,timeoutMs:2000,before:carrier(path.join(root,'before.png'),'before'),
    reason:'Pure visual fixture: automated red assertion unavailable',environment,steps:['Inspect button'],expected:['Button has the intended color']};
  const config={identity:{repositoryId:'fixture',runId:'visual-bare',taskId:'T-FIX-color',attempt:1},defect:'Button color is incorrect',
    reproduction:visual,redTest:{...visual,testFiles:[]},
    baseline:{cwd,testFiles:[],commands:[],timeoutMs:2000,noExistingTests:'Fixture has no existing automated suites'},
    repair:{scope:['style.css'],requirements:['style.css']},walkthrough:{timeoutMs:2000,environment,
      flows:[{id:'button',kind:'browser',modules:['button'],steps:['Inspect button'],expected:['Color is correct']}]} };
  return {root,cwd,config,archive:path.join(cwd,'docs','fixes')};
}
const diagnosed={status:'diagnosed',rootCause:'Wrong color',affectedPaths:['style.css'],plan:'Correct the color',crossLayer:false,
  affectedModules:['button'],investigation:{discardedAlternatives:[],boundaryAnalysis:null}};
const control={authorized:true,signal:new AbortController().signal};
const prepare=async()=>({contextDigest:digest([]),files:[],application:{contextDigest:digest([]),status:'no_relevant_lesson',summary:'Synthetic fixture'}});

for(const mode of ['visual','command'])test(`bare ${mode} CLI uses original review/finalizer, no metrics or fabricated commands; restart is read-only`,async t=>{
  const f=fixture(t),configPath=path.join(f.root,'config.json'),reviewPath=path.join(f.root,'review.json');
  if(mode==='command'){
    fs.writeFileSync(path.join(f.cwd,'regression.mjs'),"import fs from 'node:fs';if(!fs.readFileSync('style.css','utf8').includes('blue')){console.error('WRONG_COLOR');process.exit(1)}");
    const command=[process.execPath,'regression.mjs'];
    f.config.reproduction={cwd:f.cwd,command,timeoutMs:2000,expectedFailure:{exitCode:1,outputIncludes:'WRONG_COLOR'}};
    f.config.redTest={...f.config.reproduction,testFiles:['regression.mjs']};
    f.config.walkthrough={timeoutMs:2000,flows:[{id:'button',kind:'commands',command,modules:['button'],steps:['Read color'],expected:['Blue']}]};
  }
  fs.writeFileSync(configPath,JSON.stringify(f.config));
  fs.writeFileSync(reviewPath,JSON.stringify({model:'synthetic',disabledSkills:[],preflight:{passed:true,cli_model:'synthetic',prompt_transport:'stdin',
    config_fingerprint:configFingerprint({cwd:f.cwd,model:'synthetic',disabledSkills:[],promptTransport:'stdin'})}}));
  const args=['serve','--config',configPath,'--mode','create','--host-context','fixture-host','--allow-reproduction','--review-config',reviewPath,
    '--allow-red-test','--allow-baseline','--allow-repair','--allow-regression','--allow-final-review','--allow-walkthrough','--allow-finish'];
  let reviews=0,repairs=0,visualCalls=0,hostCalls=0,after;
  const reviewWorkerFactory=()=>async({prompt},{onEvent})=>{
    reviews++;const data=JSON.parse(prompt.split('<cm-review-data-json>\n')[1]);
    if(mode==='visual'){
    assert.equal(data.reviewPackage.checks[0].kind,'visual');assert.equal(Object.hasOwn(data.reviewPackage.checks[0],'command'),false);
    assert.equal(Object.hasOwn(data.reviewPackage.checks[0],'exitCode'),false);
    const handoff=JSON.parse(Buffer.from(data.reviewPackage.handoff.contentBase64,'base64'));
    assert.match(handoff.verification[0].command,/visual/i);
    assert.ok(handoff.evidence.some(row=>row.includes(f.config.reproduction.before.sha256)));
    }else{assert.equal(data.reviewPackage.checks[0].outcome,'passed');assert.deepEqual(data.reviewPackage.checks[0].command,f.config.redTest.command);}
    for(const event of [{event:'thread.started',provider_thread:'fixture-independent-review'},{event:'turn.started',item_type:null},
      {event:'item.completed',item_type:'agent_message'},{event:'turn.completed',item_type:null},{event:'process_closed',exit_code:0,signal:null,timed_out:false}])onEvent(event);
    return {status:'succeeded',value:{verdict:'approved',packageDigest:data.reviewPackage.packageDigest,examinedPaths:data.examinedPaths,findings:[],summary:'Synthetic independent review'}};
  };
  const operations=['advance','red_test','baseline','repair','regression','retrospective','handoff','final_review','publish_review','check_n5','post_review_regression','walkthrough','publish_dossier','finish'];
  async function launch(mode,ops){
    const input=new PassThrough(),rows=[];let index=0,stderr='';
    const next=()=>index<ops.length?input.write(JSON.stringify({requestId:ops[index],operation:ops[index++]})+'\n'):input.end();
    const output=new Writable({write(bytes,encoding,done){
      try{const row=JSON.parse(bytes);rows.push(row);if(row.type==='host_ready')setImmediate(next);
        if(row.type==='host_request'){
          hostCalls++;let result;
          if(row.kind==='fix_learning')result={contextDigest:row.payload.contextDigest,status:'no_relevant_lesson',summary:'Synthetic fixture'};
          else if(row.kind==='fix_diagnose')result=diagnosed;
          else if(row.kind==='fix_repair'){repairs++;fs.writeFileSync(path.join(f.cwd,'style.css'),'button { color:blue; }');result={outcome:'repaired'};}
          else if(row.kind==='fix_retrospective')result={status:'no_new_lesson',candidates:[],reason:null};
          else if(row.kind==='qa_browser'&&row.payload.before){visualCalls++;
            after=carrier(path.join(f.archive,'.reviews',`after-${visualCalls}.png`),`after ${visualCalls}`);
            result={verdict:'PASS',after,environment:f.config.reproduction.environment,cleanup:'completed',explanation:'Synthetic observed comparison'};
          }else if(row.kind==='qa_browser')result={verdict:'PASS',evidence:[path.relative(f.archive,after.path)],environment:f.config.reproduction.environment,cleanup:'completed'};
          else assert.fail(row.kind);
          input.write(JSON.stringify({type:'host_result',sessionId:row.sessionId,callId:row.callId,requestDigest:row.requestDigest,result})+'\n');
        }
        if(Object.hasOwn(row,'requestId'))setImmediate(next);done();
      }catch(error){done(error);input.end();}
    }});
    const current=[...args];current[4]=mode;
    assert.equal(await main(current,{input,output,error:new Writable({write(c,e,done){stderr+=c;done();}}),reviewWorkerFactory}),0,stderr);
    assert.ok(rows.every(row=>!row.error),JSON.stringify(rows.filter(row=>row.error)));
    return rows.filter(row=>row.requestId);
  }
  const rows=await launch('create',operations);assert.equal(rows.at(-1).result.stage,'completed',JSON.stringify(rows.map(r=>[r.requestId,r.result.stage])));
  assert.equal(repairs,1);assert.equal(reviews,1);assert.equal(visualCalls,mode==='visual'?2:0);
  assert.equal(fs.existsSync(path.join(f.cwd,'specs')),false);assert.equal(fs.existsSync(path.join(f.archive,'fixes')),false);
  assert.equal(fs.existsSync(path.join(f.archive,'METRICS.md')),false);
  const logs=eventsAt(f.archive,{archiveMode:'bare'});assert.equal(logs.filter(row=>row.event==='task_done').length,1);
  assert.equal(logs.find(row=>row.event==='run_done').metrics_skipped,'no_specs');assert.ok(logs.every(row=>!row.specs_path));
  const done=logs.find(row=>row.event==='task_done');assert.equal(path.dirname(done.dossier_file),'.');
  assert.match(fs.readFileSync(path.join(f.archive,done.dossier_file),'utf8'),/跳过 METRICS/);
  const calls=hostCalls;const resumed=await launch('resume',['status','finish']);assert.equal(resumed.at(-1).result.stage,'completed');assert.equal(hostCalls,calls);
  assert.deepEqual(eventsAt(f.archive,{archiveMode:'bare'}),logs);
});

test('visual missing/drifted carrier refuses admission; lost after observation stays unknown without redispatch',async t=>{
  const f=fixture(t);let owner,calls=0;
  const {identity,...config}=f.config,options={identity,configuration:{hostContextId:'fixture-host',...config},create:true};
  const dependencies={prepare,assertReviewReady(){},bridge:{async call(kind){
    if(kind==='fix_diagnose')return diagnosed;
    if(kind==='fix_repair'){fs.writeFileSync(path.join(f.cwd,'style.css'),'button { color:blue; }');return {outcome:'repaired'};}
    if(kind==='qa_browser'){calls++;throw Error('synthetic lost original visual result');}assert.fail(kind);
  }}};
  const before=f.config.reproduction.before;
  assert.throws(()=>verifyVisualCarrier({...before,path:path.join(f.root,'missing.png')}));
  assert.throws(()=>verifyVisualCarrier({...before,sha256:'0'.repeat(64)}),{code:'fix_visual_carrier_changed'});
  let observedSignal;
  await assert.rejects(observeVisualAfter({...f.config.redTest,timeoutMs:20},{identity,signal:control.signal,specsRoot:f.archive,
    bridge:{call:async(kind,payload,signal)=>{observedSignal=signal;return new Promise(()=>{});}}}),{code:'fix_visual_timeout'});
  assert.equal(observedSignal.aborted,true);
  try{
    owner=openFixExecution(options,dependencies);assert.equal((await owner.advance(control)).stage,'red_test_required');
    assert.equal((await owner.runRedTest(control)).stage,'baseline_required');assert.equal((await owner.captureBaseline(control)).stage,'repair_required');
    assert.equal((await owner.repair(control)).stage,'regression_required');assert.equal((await owner.runRegression(control)).stage,'unknown');
    owner.close();owner=openFixExecution({...options,create:false},dependencies);
    assert.equal((await owner.runRegression(control)).stage,'unknown');assert.equal(calls,1);assert.equal(owner.status().completionEligible,false);
    owner.cancel();owner.close();owner=openFixExecution({...options,create:false},dependencies);assert.equal(owner.status().stage,'cancelled');
  }finally{owner?.close();}
});

test('identical-byte visual FAIL persists defect_remaining and permits original reviewed retry after reopen',async t=>{
  const f=fixture(t);let owner,observations=0,reviews=0;
  const {identity,...config}=f.config,permissions=['--allow-reproduction','--allow-red-test','--allow-baseline','--allow-repair','--allow-regression','--allow-final-review'];
  const review={model:'synthetic',disabledSkills:[],preflight:{passed:true,cli_model:'synthetic',prompt_transport:'stdin',
    config_fingerprint:configFingerprint({cwd:f.cwd,model:'synthetic',disabledSkills:[],promptTransport:'stdin'})}};
  const assembly=createFixReviewHost({codeProject:f.cwd,hostContextId:'fixture-host',review,permissions,workerFactory:()=>async({prompt},{onEvent})=>{
    reviews++;const data=JSON.parse(prompt.split('<cm-review-data-json>\n')[1]);
    for(const event of [{event:'thread.started',provider_thread:'identical-fail-review'},{event:'turn.started',item_type:null},
      {event:'item.completed',item_type:'agent_message'},{event:'turn.completed',item_type:null},{event:'process_closed',exit_code:0,signal:null,timed_out:false}])onEvent(event);
    return {status:'succeeded',value:{verdict:'approved',packageDigest:data.reviewPackage.packageDigest,examinedPaths:data.examinedPaths,findings:[],summary:'Synthetic review'}};
  }});
  const options={identity,configuration:{hostContextId:'fixture-host',...config,causeReview:assembly.reviewer},create:true};
  const dependencies={prepare,...assembly.execution,bridge:{async call(kind){
    if(kind==='fix_diagnose')return diagnosed;
    if(kind==='fix_repair'){fs.writeFileSync(path.join(f.cwd,'style.css'),'button { color:blue; }');return {outcome:'repaired'};}
    if(kind==='fix_retrospective')return {status:'no_new_lesson',candidates:[],reason:null};
    if(kind==='qa_browser'){
      observations++;const failed=observations===2;
      const after=carrier(path.join(f.archive,'.reviews',`observation-${observations}.png`),failed?'before':'corrected');
      if(failed){assert.equal(after.sha256,f.config.reproduction.before.sha256);assert.notEqual(after.path,f.config.reproduction.before.path);}
      return {verdict:failed?'FAIL':'PASS',after,environment:f.config.reproduction.environment,cleanup:'completed',explanation:'Synthetic visual observation'};
    }
    assert.fail(kind);
  }}};
  try{
    owner=openFixExecution(options,dependencies);
    const host=createFixHost({owner,config:f.config,permissions,finalAuthority:assembly.finalAuthority});
    for(const operation of ['advance','red_test','baseline','repair','regression','retrospective','handoff','final_review','publish_review','check_n5'])
      await host.handle({requestId:operation,operation});
    assert.equal(owner.status().stage,'post_review_regression_required');
    const failed=await owner.runRegression({...control,postReview:true});
    assert.equal(failed.stage,'post_review_regression_blocked');assert.equal(failed.postReviewRegression.status,'defect_remaining');
    assert.equal(failed.pending,null);assert.equal(failed.postReviewRegression.red.verdict,'FAIL');
    owner.close();owner=openFixExecution({...options,create:false},dependencies);
    assert.deepEqual(owner.status().postReviewRegression,failed.postReviewRegression);
    assert.equal((await owner.runRegression({...control,postReview:true})).stage,'post_review_regression_blocked');
    assert.equal(observations,2);assert.equal(reviews,1);
    assert.equal((await owner.prepareRevision(control)).stage,'revision_prepared');
  }finally{owner?.close();}
});
