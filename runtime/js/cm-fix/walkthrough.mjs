// Impact-driven walkthrough over existing command and current-host QA capabilities.
// Host observations are not independent reviews and never complete a task.
import {createHostCheck} from '../cm-ai/host-check.mjs';
import {readReviewSourceFiles} from '../cm-ai/review-package.mjs';
import {digest,hex,id,json,need,shape,text,validCallTimeout,validIdentity} from '../cm-ai/effect-contract.mjs';

export function readFixWalkthrough(raw,cwd){
  const config=json(raw,64*1024);
  shape(config,['flows','timeoutMs',...(Object.hasOwn(config,'environment')?['environment']:[])]);validCallTimeout(config.timeoutMs);
  need(Array.isArray(config.flows)&&config.flows.length>0&&config.flows.length<=32,'walkthrough_plan_required');
  const ids=new Set();
  for(const flow of config.flows){
    shape(flow,['id','modules','steps','expected','kind',...(flow.kind==='commands'?['command']:[])]);
    id(flow.id);need(!ids.has(flow.id),'walkthrough_id_conflict');ids.add(flow.id);
    need(['commands','browser','logic'].includes(flow.kind),'walkthrough_kind_invalid');
    for(const key of ['modules','steps','expected']){
      need(Array.isArray(flow[key])&&flow[key].length>0&&flow[key].length<=32,'walkthrough_plan_required');
      for(const item of flow[key])text(item);
    }
    need(new Set(flow.modules).size===flow.modules.length,'walkthrough_module_mismatch');
    if(flow.kind==='commands')createHostCheck({cwd,commands:[{id:flow.id,command:flow.command}],timeoutMs:config.timeoutMs});
    if(flow.kind==='browser'){
      shape(config.environment,['kind','carrier','target','scope']);
      const {kind,carrier,target,scope}=config.environment;text(target);
      need(['local','test'].includes(scope)&&({web:['browser'],app:['ios-simulator','android-emulator','device'],miniprogram:['wechat-devtools','device']})[kind]?.includes(carrier),'walkthrough_environment_required');
    }
  }
  return config;
}

export function fixWalkthroughBinding({identity,packageDigest,diagnosis,configuration}){
  validIdentity(identity);hex(packageDigest);
  const covered=new Set(configuration.flows.flatMap(flow=>flow.modules));
  need(diagnosis.affectedModules.length===covered.size&&diagnosis.affectedModules.every(module=>covered.has(module)),'walkthrough_module_mismatch');
  return json({identity,packageDigest,diagnosisDigest:digest(diagnosis),configurationDigest:digest(configuration)});
}

const files=(root,paths)=>paths.length?readReviewSourceFiles(root,paths).map(({contentBase64,...metadata})=>metadata):[];
export function inspectFixWalkthrough(raw,{binding,configuration}){
  const result=json(raw);shape(result,['binding','rows','status','completionEligible']);
  need(digest(result.binding)===digest(binding)&&result.completionEligible===false,'walkthrough_binding_mismatch');
  need(Array.isArray(result.rows)&&result.rows.length===configuration.flows.length,'walkthrough_result_mismatch');
  result.rows.forEach((row,index)=>{
    const flow=configuration.flows[index];shape(row,['id','kind','verdict','observation','evidenceFiles','evidenceProblem']);
    need(row.id===flow.id&&row.kind===flow.kind,'walkthrough_result_mismatch');
    need(Array.isArray(row.evidenceFiles)&&[null,'walkthrough_evidence_required'].includes(row.evidenceProblem),'walkthrough_result_mismatch');
    if(flow.kind!=='browser')need(row.evidenceProblem===null,'walkthrough_result_mismatch');
    let verdict;
    if(flow.kind==='commands'){
      const observed=row.observation;shape(observed,['id','command','outcome','exitCode','evidence']);
      need(observed.id===flow.id&&digest(observed.command)===digest(flow.command),'walkthrough_result_mismatch');text(observed.evidence);
      need(observed.outcome==='unavailable'?observed.exitCode===null:Number.isInteger(observed.exitCode)&&observed.exitCode>=0&&observed.exitCode<=255&&observed.outcome===(observed.exitCode===0?'passed':'failed'),'walkthrough_result_mismatch');
      verdict=observed.outcome==='passed'?'PASS':observed.outcome==='failed'?'FAIL':'BLOCKED';
      need(row.evidenceFiles.length===0,'walkthrough_result_mismatch');
    }else if(flow.kind==='logic'){
      shape(row.observation,['verdict','evidence']);
      need(['SUPPORTED','CONTRADICTED','INSUFFICIENT_EVIDENCE'].includes(row.observation.verdict),'walkthrough_result_mismatch');
      verdict=row.observation.verdict==='CONTRADICTED'?'FAIL':'BLOCKED';need(row.evidenceFiles.length===0,'walkthrough_result_mismatch');
    }else{
      const observed=row.observation;shape(observed,['verdict','evidence','environment','cleanup']);
      need(['PASS','FAIL','BLOCKED'].includes(observed.verdict)&&['completed','not_needed','failed'].includes(observed.cleanup),'walkthrough_result_mismatch');
      need(Array.isArray(observed.evidence),'walkthrough_result_mismatch');
      need(row.evidenceProblem?row.evidenceFiles.length===0:row.evidenceFiles.length===observed.evidence.length,'walkthrough_result_mismatch');
      row.evidenceFiles.forEach((file,i)=>{
        shape(file,['path','type','mode','size','sha256']);need(file.type==='file'&&file.path===[...observed.evidence].sort()[i]&&Number.isInteger(file.mode)&&Number.isInteger(file.size)&&file.size>0&&/^[a-f0-9]{64}$/.test(file.sha256),'walkthrough_evidence_required');
      });
      verdict=row.evidenceProblem||digest(observed.environment)!==digest(configuration.environment)||observed.cleanup!=='completed'||!row.evidenceFiles.length?'BLOCKED':observed.verdict;
    }
    need(Array.isArray(row.observation.evidence)||flow.kind==='commands','walkthrough_evidence_required');
    if(flow.kind!=='commands'){
      need(row.observation.evidence.length<=32,'walkthrough_evidence_required');for(const item of row.observation.evidence)text(item);
    }
    if(flow.expected.some(value=>value.includes('[需确认]')))verdict='BLOCKED';
    need(row.verdict===verdict,'walkthrough_result_mismatch');
  });
  const status=result.rows.some(row=>row.verdict==='FAIL')?'failed':result.rows.every(row=>row.verdict==='PASS')?'passed':'blocked';
  need(result.status===status,'walkthrough_result_mismatch');return result;
}

export function verifyFixWalkthroughEvidence(result,specsRoot){
  for(const row of result.rows)if(row.evidenceFiles.length)
    need(digest(files(specsRoot,row.evidenceFiles.map(file=>file.path)))===digest(row.evidenceFiles),'walkthrough_evidence_changed');
}

export function createFixWalkthrough({cwd,specsRoot,identity,packageDigest,diagnosis,configuration},{browser=null,logic=null,protectedSpecsRoot=null}={}){
  const config=readFixWalkthrough(configuration,cwd),binding=fixWalkthroughBinding({identity,packageDigest,diagnosis,configuration:config});
  let used=false;
  return {binding,async run({authorized=false,signal}){
    need(authorized===true,'walkthrough_authorization_required');need(!used,'walkthrough_already_attempted');need(!signal.aborted,'cancelled');used=true;
    const controller=new AbortController();let timedOut=false,rejectWait;
    const interrupted=new Promise((resolve,reject)=>{rejectWait=reject;});
    // Also consume rejection when only command checks are running.
    interrupted.catch(()=>{});
    const stop=()=>rejectWait(Object.assign(new Error(timedOut?'walkthrough_timeout':'cancelled'),{code:timedOut?'walkthrough_timeout':'cancelled'}));
    const cancel=()=>controller.abort();
    controller.signal.addEventListener('abort',stop,{once:true});signal.addEventListener('abort',cancel,{once:true});
    const timer=setTimeout(()=>{timedOut=true;controller.abort();},config.timeoutMs);
    const notCancelled=()=>need(!controller.signal.aborted,timedOut?'walkthrough_timeout':'cancelled');
    const hostCall=(capability,request)=>Promise.race([
      Promise.resolve().then(()=>{notCancelled();return capability(request,controller.signal);}),interrupted]);
    try{
    const rows=[];
    for(const flow of config.flows){
      notCancelled();let observation,evidenceFiles=[],verdict,evidenceProblem=null;
      if(flow.kind==='commands'){
        [observation]=await createHostCheck({cwd,commands:[{id:flow.id,command:flow.command}],timeoutMs:config.timeoutMs,specsRoot:protectedSpecsRoot})({identity},{signal:controller.signal});
        verdict=observation.outcome==='passed'?'PASS':observation.outcome==='failed'?'FAIL':'BLOCKED';
      }else if(flow.kind==='logic'){
        observation=logic?json(await hostCall(logic,{binding,case:flow})):{verdict:'INSUFFICIENT_EVIDENCE',evidence:['Logic host unavailable']};
        verdict=observation.verdict==='CONTRADICTED'?'FAIL':'BLOCKED';
      }else{
        observation=browser&&!flow.expected.some(value=>value.includes('[需确认]'))?json(await hostCall(browser,{binding,case:flow,environment:config.environment})):
          {verdict:'BLOCKED',evidence:[],environment:config.environment,cleanup:'not_needed'};
        try{evidenceFiles=files(specsRoot,observation.evidence);need(evidenceFiles.every(file=>file.size>0),'walkthrough_evidence_required');}
        catch{evidenceFiles=[];evidenceProblem='walkthrough_evidence_required';}
        verdict=evidenceProblem||digest(observation.environment)!==digest(config.environment)||observation.cleanup!=='completed'||!evidenceFiles.length?'BLOCKED':observation.verdict;
      }
      notCancelled();
      if(flow.expected.some(value=>value.includes('[需确认]')))verdict='BLOCKED';
      rows.push({id:flow.id,kind:flow.kind,verdict,observation,evidenceFiles,evidenceProblem});
    }
    const status=rows.some(row=>row.verdict==='FAIL')?'failed':rows.every(row=>row.verdict==='PASS')?'passed':'blocked';
    return inspectFixWalkthrough({binding,rows,status,completionEligible:false},{binding,configuration:config});
    }finally{clearTimeout(timer);signal.removeEventListener('abort',cancel);controller.signal.removeEventListener('abort',stop);}
  }};
}
