// Read-only capacity evidence. No filesystem, writer, model call, state mutation,
// scope authority or grant. Owner append validation remains authoritative.
import {digest,json,need,shape,hex,freeze,validIdentity,JOURNAL_PAYLOAD_LIMIT} from './effect-contract.mjs';
import {STATE_LIMIT,PHYSICAL_LIMIT,RECORD_LIMIT,appendFits} from './execution-store-limits.mjs';
import {checkpointPackageBudget,checkpointStoragePlan,packageMaterialReference,packageMaterialEligible} from './checkpoint-package-material.mjs';
export {packageMaterialEligible};
const INVALID='recovery_capacity_invalid',size=value=>Buffer.byteLength(JSON.stringify(value));
const must=value=>need(value,INVALID);
const limits=freeze({payload:JOURNAL_PAYLOAD_LIMIT,appendInput:JOURNAL_PAYLOAD_LIMIT+1024,state:STATE_LIMIT,physical:PHYSICAL_LIMIT,records:RECORD_LIMIT});
function measure({records:rawRecords,effectId,checkpoint:rawCheckpoint,identity:rawIdentity,reserve,enabled,
  type='effect-checkpoint',binding={},snapshot:rawSnapshot=null,physicalBytes=null}){
  const records=json(rawRecords,STATE_LIMIT),checkpoint=json(rawCheckpoint,STATE_LIMIT),identity=json(rawIdentity);
  validIdentity(identity);must(Array.isArray(records)&&typeof enabled==='boolean');
  const original={effectId,checkpoint,version:3,protocol:'cm-task-runner',type,...json(binding)};
  const inlineBytes=size(original),packageBytes=checkpoint.reviewPackage===null?0:size(checkpoint.reviewPackage);
  const reference=checkpoint.reviewPackage===null?null:packageMaterialReference(records,checkpoint.reviewPackage,identity);
  const capacity=checkpointPackageBudget({inlineBytes,packageBytes,reserve,enabled,referenced:reference!==null});
  const mode=enabled&&reference!==null?'reference':capacity.material?'material':'inline';
  let stored=checkpoint,fields={};
  if(capacity.fits){const plan=checkpointStoragePlan({records,effectId,checkpoint,identity,reserve,enabled,type,binding});
    stored=plan.checkpoint;fields=plan.payloadFields;
  }else if(mode==='reference'){stored={...checkpoint,reviewPackage:null};fields={packageRef:reference};}
  else if(mode==='material')fields={packageMaterial:true};
  const payload={...original,checkpoint:stored,...fields},encodedBytes=size(payload);
  const recordBody={version:1,seq:records.length+1,id:`runner.${String(records.length+1).padStart(6,'0')}`,kind:'result',payload,
    previousDigest:records.at(-1)?.digest??null};
  const record={...recordBody,digest:digest(recordBody)},unverified=[];
  let revision=null,nextStateBytes=null,appendInputBytes=null;
  const checks={payload:encodedBytes<=limits.payload,futureCheckpoint:capacity.fits,appendInput:null,
    recordCount:records.length<limits.records,state:null,physical:null};
  if(rawSnapshot===null)unverified.push('state');
  else{
    const snapshot=json(rawSnapshot,STATE_LIMIT);shape(snapshot,['version','identity','fingerprints','records','revision']);
    shape(snapshot.identity,['repositoryId','runId']);shape(snapshot.fingerprints,['workflow','config','inputs']);
    Object.values(snapshot.fingerprints).forEach(hex);must(snapshot.version===1);
    const {revision:oldRevision,...body}=snapshot;
    must(oldRevision===digest(body)&&digest(snapshot.records)===digest(records)
      &&snapshot.identity.repositoryId===identity.repositoryId&&snapshot.identity.runId===identity.runId);
    revision=oldRevision;
    const input={id:record.id,kind:record.kind,payload,expectedRevision:revision};appendInputBytes=size(input);
    const next={...body,records:[...records,record]},nextState={...next,revision:digest(next)};
    nextStateBytes=size(nextState)+1;
    checks.appendInput=appendInputBytes<=limits.appendInput;
    checks.state=nextStateBytes<=limits.state&&appendFits(snapshot,input);
  }
  if(physicalBytes===null||nextStateBytes===null)unverified.push('physical');
  else {must(Number.isSafeInteger(physicalBytes)&&physicalBytes>=0);checks.physical=physicalBytes+nextStateBytes<=limits.physical;}
  // The append wrapper only adds a bounded id/kind/revision when no snapshot
  // was provided; use its exact fixed-length revision stand-in for measurement.
  if(appendInputBytes===null){appendInputBytes=size({id:record.id,kind:record.kind,payload,expectedRevision:'0'.repeat(64)});
    checks.appendInput=appendInputBytes<=limits.appendInput;}
  const fits=Object.values(checks).every(value=>value!==false);
  const code=!checks.payload?'checkpoint_payload_too_large':!checks.futureCheckpoint?'checkpoint_review_reserve_exceeded'
    :!checks.appendInput?'checkpoint_append_input_limit':!checks.recordCount?'checkpoint_record_limit'
    :checks.state===false?'checkpoint_state_limit':checks.physical===false?'checkpoint_physical_limit':null;
  return freeze({version:1,eligible:enabled,identity,revision,fits,mode,inlineBytes,encodedBytes,recordBytes:size(record),appendInputBytes,
    packageBytes,reserve,budget:capacity.budget,nextStateBytes,limits,checks,unverified,code});
}
export function measureCheckpointCapacity(options){return measure(options);}
export function inspectRecoveryCapacity({version,config,...options}){
  return measure({...options,enabled:packageMaterialEligible(config,version)});
}
