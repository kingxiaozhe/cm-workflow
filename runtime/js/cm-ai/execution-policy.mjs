// Explicit, versioned policy for NEW executions. No defaults, migration or budgets.
import fs from 'node:fs';
import path from 'node:path';
import {digest,json,need,id,shape} from './effect-contract.mjs';
import {isSupportedExecutionPlatform} from './execution-platform.mjs';
import {fixArchiveRoot} from '../cm-fix/layout.mjs';
import {readExecutionSnapshot} from './execution-snapshot.mjs';
import {scanRows} from './log-rows.mjs';
export const EXECUTION_POLICY_V1=Object.freeze({version:1,responseRecovery:'mechanical-v1',
  checkReuse:'declared-adjacent-v1',reviewPresentation:'utf8-v1',usage:'provider-terminal-v1'});
export function readExecutionPolicy(raw){
  const value=json(raw);need(digest(value)===digest(EXECUTION_POLICY_V1),'execution_policy_invalid');return value;
}
export function readLaunchExecutionPolicy({definition,mode,enabled=false}){
  need(['create','resume'].includes(mode),'invalid_mode');
  if(mode==='create')return enabled?readExecutionPolicy(EXECUTION_POLICY_V1):null;
  let snapshot;
  try{snapshot=readExecutionSnapshot({specsRoot:definition.specsDir,identity:{repositoryId:definition.identity.repositoryId,runId:definition.identity.runId}});}
  catch(error){if(error.code!=='ENOENT')throw error;need(!enabled,'execution_policy_legacy_run');return null;}
  const saved=snapshot.records.find(row=>row.payload.type==='init')?.payload.config.executionPolicy??null;
  need(!enabled||saved!==null,'execution_policy_legacy_run');return saved===null?null:readExecutionPolicy(saved);
}
const batchRoot=batch=>path.join(batch.specsDir,'.cm-execution-policy-v1');
const batchIdentity=batch=>{id(batch.batchId);return {repositoryId:batch.repositoryId,runId:'batch-policy-'+digest(batch.batchId).slice(0,32)};};
export function readBatchExecutionPolicy({batch,started,enabled=false}){
  const identity=batchIdentity(batch),root=batchRoot(batch),file=path.join(root,'.reviews','.execution',identity.runId,'state.json');
  if(fs.existsSync(file)){
    const snapshot=readExecutionSnapshot({specsRoot:root,identity});
    need(snapshot.records.length===1&&snapshot.records[0].id==='batch-policy'&&snapshot.records[0].kind==='result','execution_policy_batch_binding');
    const record=snapshot.records[0].payload;shape(record,['kind','batchId','planDigest','executionPolicy']);
    need(record.kind==='cm-execution-policy-v1'&&record.batchId===batch.batchId&&record.planDigest===digest(batch),'execution_policy_batch_binding');
    return readExecutionPolicy(record.executionPolicy);
  }
  const log=path.join(batch.specsDir,'运行日志.jsonl');
  if(fs.existsSync(log))scanRows(log,row=>{if(row.workflow==='cm-ai'&&row.run_id===batch.batchId&&row.event==='decision'&&row.phase==='batch_start')started=true;});
  need(!started||!enabled,'execution_policy_legacy_run');return enabled&&!started?readExecutionPolicy(EXECUTION_POLICY_V1):null;
}
export async function freezeBatchExecutionPolicy(batch,executionPolicy){
  if(executionPolicy===null)return;
  const root=batchRoot(batch),identity=batchIdentity(batch);
  if(fs.existsSync(path.join(root,'.reviews','.execution',identity.runId,'state.json'))){
    need(digest(readBatchExecutionPolicy({batch,started:true}))===digest(executionPolicy),'execution_policy_batch_binding');return;
  }
  need(isSupportedExecutionPlatform(),'unsupported_platform');
  const {openExecutionStore}=await import('./execution-store.mjs');
  try{fs.mkdirSync(root,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}
  need(fs.realpathSync(root)===root,'execution_policy_batch_binding');
  const payload={kind:'cm-execution-policy-v1',batchId:batch.batchId,planDigest:digest(batch),executionPolicy:readExecutionPolicy(executionPolicy)};
  const store=openExecutionStore({specsRoot:root,identity,create:true,fingerprints:{workflow:digest(payload.kind),config:digest(batch),inputs:digest(payload)}});
  try{store.append({id:'batch-policy',kind:'result',payload,expectedRevision:store.snapshot().revision});}finally{store.close();}
}
export function readFixExecutionPolicy({config,mode,enabled=false}){
  if(mode==='create')return enabled?readExecutionPolicy(EXECUTION_POLICY_V1):null;
  need(mode==='resume','invalid_mode');
  const snapshot=readExecutionSnapshot({specsRoot:fixArchiveRoot(config.specsRoot,config.reproduction.cwd),identity:{repositoryId:config.identity.repositoryId,runId:config.identity.runId}});
  const saved=snapshot.records[0]?.payload.configuration?.executionPolicy??null;
  need(!enabled||saved!==null,'execution_policy_legacy_run');return saved===null?null:readExecutionPolicy(saved);
}
