// Existing-test baseline, at command granularity. Not a test-count parser or approval.
import {createHostCheck} from '../cm-ai/host-check.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {redTestFiles} from './red-test.mjs';
import {digest,json,need,shape,text,validCallTimeout,validIdentity} from '../cm-ai/effect-contract.mjs';

// A startup-trusted declaration, never an inferred skip or a passing command.
function noExistingTests(config){
  if(!Object.hasOwn(config,'noExistingTests'))return false;
  shape(config,['cwd','testFiles','commands','timeoutMs','noExistingTests']);
  text(config.noExistingTests);need(config.noExistingTests.trim().length>0
    &&Buffer.byteLength(config.noExistingTests)<=1000,'invalid_no_existing_tests');
  need(Array.isArray(config.testFiles)&&config.testFiles.length===0
    &&Array.isArray(config.commands)&&config.commands.length===0,'invalid_no_existing_tests');
  need(path.isAbsolute(config.cwd)&&fs.realpathSync(config.cwd)===config.cwd
    &&fs.lstatSync(config.cwd).isDirectory(),'baseline_project_mismatch');
  validCallTimeout(config.timeoutMs);return true;
}

export const fixBaselineFiles=config=>noExistingTests(config)?[]:redTestFiles(config);

export function inspectFixBaseline(raw,config,files){
  const absent=noExistingTests(config);
  const value=json(raw);shape(value,['status','observations','testFiles','completionEligible',...(absent?['noExistingTests']:[])]);
  need(value.completionEligible===false&&digest(value.testFiles)===digest(files),'baseline_mismatch');
  if(absent){
    need(value.status==='recorded'&&value.noExistingTests===config.noExistingTests
      &&Array.isArray(value.observations)&&value.observations.length===0
      &&Array.isArray(files)&&files.length===0,'baseline_mismatch');
    return value;
  }
  need(Array.isArray(value.observations)&&value.observations.length>0
    &&value.observations.length<=config.commands.length,'baseline_mismatch');
  let unavailable=false;
  value.observations.forEach((observed,index)=>{
    need(!unavailable,'baseline_mismatch');shape(observed,['id','command','outcome','exitCode','evidence']);
    need(observed.id===config.commands[index].id&&digest(observed.command)===digest(config.commands[index].command),'baseline_mismatch');
    text(observed.evidence);unavailable=observed.outcome==='unavailable';
    need(unavailable?observed.exitCode===null:Number.isInteger(observed.exitCode)&&observed.exitCode>=0&&observed.exitCode<=255
      &&observed.outcome===(observed.exitCode===0?'passed':'failed'),'baseline_mismatch');
  });
  need(value.status===(unavailable?'blocked':'recorded')&&(unavailable||value.observations.length===config.commands.length),'baseline_mismatch');
  return value;
}

export function createFixBaseline(options,{specsRoot=null}={}){
  const config=json(options),absent=noExistingTests(config);
  shape(config,['cwd','testFiles','commands','timeoutMs',...(absent?['noExistingTests']:[])]);
  // Validate the whole ordered list once; invoke separately so an existing failure
  // does not prevent recording later suites. Unavailable execution still stops.
  if(!absent)createHostCheck({...config,specsRoot});
  const checks=config.commands.map(command=>createHostCheck({...config,commands:[command],specsRoot}));
  let used=false;
  return async(request,{authorized,signal})=>{
    need(authorized===true,'baseline_authorization_required');need(!used,'baseline_already_attempted');
    shape(request,['identity']);validIdentity(request.identity);
    need(!signal.aborted,'cancelled');const files=fixBaselineFiles(config);used=true;
    if(absent)return inspectFixBaseline({status:'recorded',observations:[],testFiles:[],
      noExistingTests:config.noExistingTests,completionEligible:false},config,files);
    const observations=[];
    for(const check of checks){
      const [result]=await check(request,{signal});observations.push(result);
      if(result.outcome==='unavailable')break;
    }
    need(digest(fixBaselineFiles(config))===digest(files),'baseline_files_changed');
    return inspectFixBaseline({status:observations.at(-1).outcome==='unavailable'?'blocked':'recorded',
      observations,testFiles:files,completionEligible:false},config,files);
  };
}
