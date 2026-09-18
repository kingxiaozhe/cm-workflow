// Low-level step for the forthcoming fix owner. Caller owns durable registration,
// log/start records and command authorization; this is not a repair/completion grant.
import {createHostCheck} from '../cm-ai/host-check.mjs';
import {digest,json,need,shape,text} from '../cm-ai/effect-contract.mjs';
import {isVisual,visualConfiguration,visualBefore,inspectVisualBefore} from './visual.mjs';

// Shared by execution results and the existing root-cause package reader.
export function inspectFixReproductionAttempts(value,{requireAttempts=false}={}){
  // Missing fields remain legal during historical replay; new observation entry
  // and publication require an actual recorded attempt, never inferred history.
  if(Object.hasOwn(value,'attempts')){
    need(Array.isArray(value.attempts),'invalid_fix_reproduction_attempts');
    for(const attempt of value.attempts){
      shape(attempt,['scenario','dimension','outcome']);text(attempt.scenario);text(attempt.dimension);
      need(['reproduced','not_reproduced','unsupported'].includes(attempt.outcome),'invalid_fix_reproduction_attempts');
    }
    if(value.attempts.length)need(value.attempts.at(-1).outcome===
      ({reproduced:'reproduced',not_reproduced:'not_reproduced',blocked:'unsupported'})[value.status],
      'fix_reproduction_attempts_mismatch');
  }
  if(requireAttempts||value.next==='observation'&&Object.hasOwn(value,'attempts'))
    need(value.attempts?.length>0,'fix_reproduction_attempts_required');
}

export function inspectFixReproduction(raw,config,{requireAttempts=false}={}){
  const value=json(raw);shape(value,['status','next','observation',...(Object.hasOwn(value,'attempts')?['attempts']:[])]);
  inspectFixReproductionAttempts(value,{requireAttempts});
  if(isVisual(config)){
    inspectVisualBefore(value.observation,config);
    need(value.status==='reproduced'&&value.next==='diagnose','reproduction_mismatch');return value;
  }
  const observed=value.observation;
  shape(observed,['id','command','outcome','exitCode','evidence','signatureMatched']);
  need(observed.id==='reproduce'&&digest(observed.command)===digest(config.command),'reproduction_mismatch');
  need(typeof observed.signatureMatched==='boolean','reproduction_mismatch');text(observed.evidence);
  need(observed.outcome==='unavailable'?observed.exitCode===null:
    Number.isInteger(observed.exitCode)&&observed.exitCode>=0&&observed.exitCode<=255
      &&observed.outcome===(observed.exitCode===0?'passed':'failed'),'reproduction_mismatch');
  const reproduced=observed.outcome==='failed'&&observed.exitCode===config.expectedFailure.exitCode&&observed.signatureMatched;
  const status=observed.outcome==='unavailable'?'blocked':reproduced?'reproduced':'not_reproduced';
  need(value.status===status&&value.next===(status==='blocked'?'resolve_execution':reproduced?'diagnose':'observation'),
    'reproduction_mismatch');return value;
}

export function createFixReproduction(options,{specsRoot=null}={}){
  if(isVisual(options)){
    const config=json(visualConfiguration(options));let used=false;
    return async(request,{signal,authorized})=>{
      need(authorized===true,'reproduction_authorization_required');need(!signal.aborted,'cancelled');
      need(!used,'reproduction_already_attempted');used=true;
      return inspectFixReproduction({status:'reproduced',next:'diagnose',observation:visualBefore(config),
        attempts:[{scenario:config.steps.join(" → "),dimension:'按描述（未改变维度）',outcome:'reproduced'}]},config,{requireAttempts:true});
    };
  }
  shape(options,['cwd','command','expectedFailure','timeoutMs']);
  const config=json(options);
  shape(config.expectedFailure,['exitCode','outputIncludes']);
  need(Number.isInteger(config.expectedFailure.exitCode)&&config.expectedFailure.exitCode>0
    &&config.expectedFailure.exitCode<=255,'invalid_failure_signature');
  const check=createHostCheck({cwd:config.cwd,commands:[{id:'reproduce',command:config.command}],
    timeoutMs:config.timeoutMs,outputIncludes:config.expectedFailure.outputIncludes,specsRoot});
  need(typeof config.expectedFailure.outputIncludes==='string','invalid_failure_signature');
  let used=false;
  return async(request,{signal,authorized})=>{
    need(authorized===true,'reproduction_authorization_required');
    need(!signal.aborted,'cancelled');need(!used,'reproduction_already_attempted');used=true;
    const [observed]=await check(request,{signal});
    const reproduced=observed.outcome==='failed'&&observed.exitCode===config.expectedFailure.exitCode
      &&observed.signatureMatched===true;
    return inspectFixReproduction({status:observed.outcome==='unavailable'?'blocked':reproduced?'reproduced':'not_reproduced',
      next:observed.outcome==='unavailable'?'resolve_execution':reproduced?'diagnose':'observation',
      observation:observed,attempts:[{scenario:JSON.stringify(config.command),dimension:'按描述（未改变维度）',
        outcome:observed.outcome==='unavailable'?'unsupported':reproduced?'reproduced':'not_reproduced'}]},config,{requireAttempts:true});
  };
}
