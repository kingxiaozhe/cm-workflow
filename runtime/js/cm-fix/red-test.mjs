// Executes an already-authored regression test and preserves private raw red output.
// Test creation, baseline regression and repair remain separate owner stages.
import path from 'node:path';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {createHostCheck} from '../cm-ai/host-check.mjs';
import {readReviewSourceFiles} from '../cm-ai/review-package.mjs';
import {writeReviewEvidence} from '../cm-ai/review-evidence-file.mjs';
import {digest,json,need,shape,validIdentity} from '../cm-ai/effect-contract.mjs';
import {inspectFixReproduction} from './reproduce.mjs';
import {isVisual,visualConfiguration,visualBefore,inspectVisualBefore,verifyVisualCarrier} from './visual.mjs';

export const redTestFiles=config=>isVisual(config)?(visualConfiguration(config),[]):readReviewSourceFiles(config.cwd,config.testFiles).map(({contentBase64,...metadata})=>metadata);

// History validation is separate from current disk checks: drift must not erase a past run.
export function inspectFixRedTest(raw,config,identity,registeredFiles){
  if(isVisual(config)){
    const value=json(raw);shape(value,['status','observation','testFiles','completionEligible']);inspectVisualBefore(value.observation,config);
    need(value.status==='red_confirmed'&&value.completionEligible===false&&digest(value.testFiles)===digest([])
      &&digest(registeredFiles)===digest([]),'red_test_mismatch');return value;
  }
  const value=json(raw);shape(value,['status','observation','testFiles','output','completionEligible']);
  const observed=value.observation;
  need(observed.id==='red-test','red_test_mismatch');
  const reproduced=observed.outcome==='failed'&&observed.exitCode===config.expectedFailure.exitCode&&observed.signatureMatched===true;
  const status=observed.outcome==='unavailable'?'blocked':reproduced?'red_confirmed':'not_red';
  inspectFixReproduction({status:status==='blocked'?'blocked':reproduced?'reproduced':'not_reproduced',
    next:status==='blocked'?'resolve_execution':reproduced?'diagnose':'observation',observation:{...observed,id:'reproduce'}},config);
  need(value.status===status&&value.completionEligible===false&&digest(value.testFiles)===digest(registeredFiles),'red_test_mismatch');
  shape(value.output,['path','sha256','complete']);
  need(value.output.path===`.reviews/fix-${identity.taskId.slice(6)}-a${identity.attempt}-red-output.md`
    &&/^[a-f0-9]{64}$/.test(value.output.sha256)&&value.output.complete===(observed.outcome!=='unavailable'),'red_test_mismatch');
  return value;
}

export function verifyFixRedEvidence(value,config,specsRoot){
  if(isVisual(config)){inspectVisualBefore(value.observation,config);return {visual:verifyVisualCarrier(value.observation.carrier)};}
  need(digest(redTestFiles(config))===digest(value.testFiles),'red_test_files_changed');
  const [file]=readReviewSourceFiles(specsRoot,[value.output.path]);
  need(file.mode===0o600&&file.size<=256*1024&&file.sha256===value.output.sha256,'red_output_changed');
  const raw=JSON.parse(Buffer.from(file.contentBase64,'base64').toString('utf8'));
  shape(raw,['stdoutBase64','stderrBase64']);
  let total=0,matched=false;
  for(const encoded of [raw.stdoutBase64,raw.stderrBase64]){
    need(typeof encoded==='string','red_output_changed');const bytes=Buffer.from(encoded,'base64');
    need(bytes.toString('base64')===encoded,'red_output_changed');total+=bytes.length;
    matched ||= bytes.toString('utf8').includes(config.expectedFailure.outputIncludes);
  }
  need(total<=128*1024&&(!value.output.complete||matched===value.observation.signatureMatched),'red_output_changed');
  return raw;
}

export function createFixRedTest(config,{specsRoot,identity,protectedSpecsRoot=null}){
  if(isVisual(config)){
    visualConfiguration(config);let used=false;
    return async(request,{signal,authorized})=>{
      need(authorized===true,'red_test_authorization_required');need(!used,'red_test_already_attempted');
      need(digest(request.identity)===digest(identity),'identity_mismatch');need(!signal.aborted,'cancelled');used=true;
      return inspectFixRedTest({status:'red_confirmed',observation:visualBefore(config),testFiles:[],completionEligible:false},config,identity,[]);
    };
  }
  config=json(config);identity=json(identity);validIdentity(identity);
  shape(config,['cwd','testFiles','command','expectedFailure','timeoutMs']);
  shape(config.expectedFailure,['exitCode','outputIncludes']);
  need(Number.isInteger(config.expectedFailure.exitCode)&&config.expectedFailure.exitCode>0&&config.expectedFailure.exitCode<=255,'invalid_failure_signature');
  need(typeof config.expectedFailure.outputIncludes==='string','invalid_failure_signature');
  const slug=/^T-FIX-([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(identity.taskId)?.[1];need(slug,'invalid_fix_slug');
  const outputName=`fix-${slug}-a${identity.attempt}-red-output.md`;
  let used=false,total=0;const stdout=[],stderr=[];
  const run=createHostCheck({cwd:config.cwd,specsRoot:protectedSpecsRoot,commands:[{id:'red-test',command:config.command}],timeoutMs:config.timeoutMs,
    outputIncludes:config.expectedFailure.outputIncludes,onOutput:({stream,chunk})=>{
      total+=chunk.length;need(total<=128*1024,'red_output_limit');
      (stream==='stdout'?stdout:stderr).push(chunk);
    }});
  return async(request,{signal,authorized})=>{
    need(authorized===true,'red_test_authorization_required');need(!used,'red_test_already_attempted');
    need(digest(request.identity)===digest(identity),'identity_mismatch');
    const files=redTestFiles(config);
    used=true;
    const [observed]=await run(request,{signal});
    const after=redTestFiles(config);
    need(digest(after)===digest(files),'red_test_files_changed');
    const red=observed.outcome==='failed'&&observed.exitCode===config.expectedFailure.exitCode&&observed.signatureMatched===true;
    // Never label truncated, missing-command, timeout or unrelated output as valid red evidence.
    const status=observed.outcome==='unavailable'?'blocked':red?'red_confirmed':'not_red';
    const bytes=Buffer.from(JSON.stringify({stdoutBase64:Buffer.concat(stdout).toString('base64'),stderrBase64:Buffer.concat(stderr).toString('base64')})+'\n');
    const evidence=writeReviewEvidence({reviewsDir:path.join(specsRoot,'.reviews'),name:outputName,bytes,
      validate:file=>need((fs.lstatSync(file).mode&0o777)===0o600,'red_output_permissions')});
    return json({status,observation:observed,testFiles:files,output:{path:`.reviews/${path.basename(evidence.path)}`,
      sha256:createHash('sha256').update(bytes).digest('hex'),complete:observed.outcome!=='unavailable'&&total<=128*1024},completionEligible:false});
  };
}
