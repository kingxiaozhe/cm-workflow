// Execution choices and stale-command protection, not human authentication.
import fs from 'node:fs';
import {digest,json,need,shape,validIdentity,hex,id} from './effect-contract.mjs';
import {parseModelJson} from './model-configuration-file.mjs';

export const CONTROL_RECOVERY_OPERATIONS=Object.freeze(['abandon_review','abandon_effect','develop_redo',
  'bootstrap_review_recover','reconcile_review']);
export const CONTROL_FIX_RECOVERY_OPERATIONS=Object.freeze(['abandon_step','abandon_review','rediagnose',
  'rerun_blocked_step','recover_final_review','reconcile_review']);
export function readControlPolicy(raw){
  const value=json(raw);shape(value,['version','development','bootstrap','qa','qaFix']);
  need(value.version===2&&['conversation','provider'].includes(value.development)
    &&['disabled','write'].includes(value.bootstrap)&&['disabled','run'].includes(value.qa)
    &&['disabled','manual','auto'].includes(value.qaFix),'invalid_input');
  need(value.qaFix==='disabled'||value.qa==='run','invalid_input');
  return value;
}
export function readControlPolicyFile(file){
  const before=fs.lstatSync(file);
  need(before.isFile()&&!before.isSymbolicLink()&&before.nlink===1&&before.size<=65536,'invalid_input');
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try{
    const bytes=fs.readFileSync(fd),after=fs.fstatSync(fd),current=fs.lstatSync(file);
    need([after,current].every(s=>['dev','ino','size','mtimeMs','ctimeMs'].every(k=>s[k]===before[k]))
      &&bytes.length===before.size,'snapshot_changed');
    const text=bytes.toString('utf8');need(Buffer.from(text).equals(bytes),'invalid_input');
    return readControlPolicy(parseModelJson(text));
  }finally{fs.closeSync(fd);}
}
export function controlPolicyFromSnapshot(snapshot){
  return snapshot.records.find(row=>row.payload.type==='init')?.payload.config?.controlPolicy??null;
}
export function assertControlEntry(snapshot,policy){
  const saved=controlPolicyFromSnapshot(snapshot);
  need((saved===null)===(policy===null),'fingerprint_mismatch');
  if(saved!==null)need(digest(readControlPolicy(saved))===digest(readControlPolicy(policy)),'fingerprint_mismatch');
}
export function readControlTarget(raw){
  const v=json(raw);shape(v,['version','identity','state','code','packageDigest','effectId','invocationId','revision',
    ...(Object.hasOwn(v,'child')?['child']:[])]);
  need(v.version===2&&typeof v.state==='string'&&(v.code===null||typeof v.code==='string'),'invalid_input');
  validIdentity(v.identity);hex(v.revision);
  if(v.packageDigest!==null)hex(v.packageDigest);
  for(const key of ['effectId','invocationId'])if(v[key]!==null)id(v[key]);
  if(Object.hasOwn(v,'child'))readFixControlTarget(v.child);
  return v;
}
export function readFixControlTarget(raw){
  const v=json(raw);shape(v,['runId','revision','stage']);id(v.runId);hex(v.revision);
  need(typeof v.stage==='string'&&v.stage.length>0&&v.stage.length<=128,'invalid_input');return v;
}
export function controlTarget(status,snapshot){
  const intent=snapshot.records.findLast(row=>row.payload.type==='effect-intent')?.payload.effect??null;
  const registration=snapshot.records.findLast(row=>row.payload.type==='review-invocation-registered')?.payload;
  return readControlTarget({version:2,identity:status.identity,state:status.state,code:status.code??null,
    packageDigest:status.packageDigest??null,effectId:intent?.id??null,
    invocationId:registration?.binding?.invocationId??null,revision:snapshot.revision});
}
export function isControlRecovery(request){
  return CONTROL_RECOVERY_OPERATIONS.includes(request.operation)
    ||request.operation==='fix_action'&&CONTROL_FIX_RECOVERY_OPERATIONS.includes(request.fixOperation);
}
export function assertExpectedControl(expected,current){
  need(expected!==undefined,'invalid_input');
  need(digest(readControlTarget(expected))===digest(readControlTarget(current)),'snapshot_changed');
}
// The existing store owns the writer lock. This guard never queues a previewed
// command behind another mutation; validation and invocation share that owner.
export function withControlPolicyHost(host,{identity,snapshot,launchTarget=null}){
  let busy=false;
  return {...host,async handle(raw){
    let ownsBusy=false,checking=true;
    try{
      const request=json(raw);need(request.version===2,'fingerprint_mismatch');
      if(busy&&!['status','cancel','fix_status'].includes(request.operation))return {outcome:'rejected',code:'host_busy'};
      const recovering=isControlRecovery(request);
      need(recovering||!Object.hasOwn(request,'expectedControl'),'invalid_input');
      const {expectedControl,...wire}=request;wire.version=1;
      // A busy poll cannot publish a recovery target.
      if(busy)return host.handle(wire);
      busy=true;ownsBusy=true;
      if(recovering){
        checking=false;
        const status=await host.handle({version:1,requestId:request.requestId,operation:'status',identity});
        checking=true;
        if(request.operation==='fix_action'){
          need(expectedControl!==undefined,'invalid_input');readControlTarget(expectedControl);
          need(Object.hasOwn(expectedControl,'child'),'invalid_input');
          const {child,...parent}=expectedControl;assertExpectedControl(parent,controlTarget(status,snapshot()));
          wire.expectedFixControl=readFixControlTarget(child);
        }else assertExpectedControl(expectedControl,controlTarget(status,snapshot()));
        need(digest(wire.identity)===digest(status.identity),'snapshot_changed');
      }
      checking=false;
      const result=await host.handle(wire);
      if(request.operation==='fix_status'&&result.childControlTarget){
        const parent=await host.handle({version:1,requestId:request.requestId,operation:'status',identity});
        return {...result,controlTarget:{...controlTarget(parent,snapshot()),child:readFixControlTarget(result.childControlTarget)}};
      }
      if(result.identity&&result.state&&request.operation==='status')
        return {...result,controlTarget:controlTarget(result,snapshot()),
          ...(launchTarget?{launchControlTarget:launchTarget(snapshot())}: {})};
      return result;
    }catch(error){
      if(checking&&['invalid_input','snapshot_changed','fingerprint_mismatch'].includes(error.code))
        return {outcome:'rejected',code:error.code,reason:error.code==='snapshot_changed'
          ?'恢复目标已经变化；先核对当前状态和原操作，不自动更新旧目标后重试。':'恢复需要 status 返回的当前 controlTarget；旧运行使用原兼容入口。'};
      throw error;
    }finally{if(ownsBusy)busy=false;}
  }};
}
