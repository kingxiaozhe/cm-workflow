// A terminal history record, never a revision or an approval transfer.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {need,json,digest} from '../cm-ai/effect-contract.mjs';
import {readCmInitSource} from '../cm-init/draft-inspection.mjs';
import {replaceSessionFile,readPrdSessionFile} from './session.mjs';
import {inspectCmPrdSources} from '../../../scripts/cm-prd-entry.mjs';
import {loadConfig} from '../../../scripts/cm-workflow-config.mjs';
import {inspectPrdReview} from '../../../scripts/cm-prd-review-gate.mjs';
const limit=16*1024*1024;
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const validId=id=>typeof id==='string'&&/^prd-[a-zA-Z0-9-]{1,80}$/.test(id);
const directory=(specs,id)=>{
  need(validId(id),'prd_session_id_invalid');return path.join(specs,'.reviews/prd-sessions',id);
};
const inputs=entry=>({sourceDigest:digest(inspectCmPrdSources(entry)),configDigest:digest(loadConfig({projectRoot:entry.project}))});
export function readPrdInputsReplacement(specs,sessionId){
  const dir=directory(specs,sessionId);
  if(!fs.existsSync(dir))return null;
  need(fs.realpathSync(dir)===dir,'prd_session_path_invalid');
  const bytes=readPrdSessionFile(dir,'inputs-replaced.json');if(bytes===null)return null;
  const value=JSON.parse(bytes),{receiptDigest,...body}=value;
  need(value.version===1&&value.status==='inputs_replaced'&&value.sessionId===sessionId
    &&value.sessionState.identity.entry.specs===specs&&digest(body)===receiptDigest,'prd_replacement_changed');
  return value;
}
export function assertPrdBatchActive(specs,features){
  const base=path.join(specs,'.reviews/prd-sessions');if(!fs.existsSync(base))return;
  need(fs.realpathSync(base)===base,'prd_session_path_invalid');
  for(const id of fs.readdirSync(base).filter(validId)){
    const receipt=readPrdInputsReplacement(specs,id);
    need(!receipt||features&&features.every(f=>!receipt.features.includes(f)),'prd_batch_inputs_replaced');
  }
}
function fresh(specs,allowEmptyReviews=false){
  need(path.isAbsolute(specs)&&fs.realpathSync(specs)===specs,'prd_successor_not_fresh');
  need(!fs.readdirSync(specs).some(name=>/^\d+\./.test(name)||name==='.cm-specs-status'||name==='.reviews'&&!(allowEmptyReviews&&fs.realpathSync(path.join(specs,name))===path.join(specs,name)&&fs.readdirSync(path.join(specs,name)).length===0)),
    'prd_successor_not_fresh');
}
export function replacePrdInputs({session,sessionId,approved,reason,successorSpecs,successorSessionId}){
  need(approved===true&&typeof reason==='string'&&reason.trim(),'prd_replacement_authorization_required');
  need(validId(successorSessionId)&&successorSessionId.length>=8&&successorSessionId!==sessionId,'prd_predecessor_binding');
  const sessionState=session.state,{entry,runtime}=sessionState.identity;
  const request={approved:true,reason,successorSpecs,successorSessionId};
  const existing=readPrdInputsReplacement(entry.specs,sessionId);
  if(existing){need(digest(existing.request)===digest(request),'prd_replacement_conflict');return existing;}
  // Unknown calls remain archived as unknown; this does not resolve or replay them.
  const checkpoint=sessionState.active?.before??sessionState.checkpoint,analysis=checkpoint?.analysis;
  need(analysis&&checkpoint.change===null&&!checkpoint.publishedSummary&&analysis.stage!=='cancelled'
    &&!sessionState.checkpoint?.publishedSummary&&sessionState.checkpoint?.analysis?.stage!=='cancelled',
    'prd_replacement_not_ready');
  const oldInputs={sourceDigest:analysis.sourceDigest,configDigest:analysis.configDigest},replacementInputs=inputs(entry);
  need(digest(oldInputs)!==digest(replacementInputs),'prd_inputs_not_changed');
  need(successorSpecs!==entry.specs&&!successorSpecs.startsWith(entry.specs+path.sep)
    &&!entry.specs.startsWith(successorSpecs+path.sep),'prd_successor_not_fresh');fresh(successorSpecs);
  const nextEntry={...entry,specs:successorSpecs};
  need(inspectCmPrdSources(nextEntry).status==='ready','prd_successor_inputs_invalid');
  need(digest(inspectCmPrdSources(nextEntry).sourceInspection)===digest(inspectCmPrdSources(entry).sourceInspection),
    'prd_successor_inputs_changed');
  const features=(analysis.draft??analysis.designDraft)?.features.map(f=>f.directory)??[];
  const published=readCmInitSource(entry.specs,'.cm-specs-status');
  if(published!==null){
    const status=JSON.parse(published);
    need(Array.isArray(status.features)&&!status.features.some(feature=>features.includes(feature)),
      'prd_replacement_not_ready');
  }
  const reviewRecords=[],unreviewed=[];
  for(const feature of features){
    const slug=feature.replace(/^\d+\./,'');
    for(const stage of ['design','split']){
      const prefix=`prd-${slug}-${stage}`,base=path.join(entry.specs,'.reviews');
      const names=fs.existsSync(base)?fs.readdirSync(base).filter(n=>n.startsWith(prefix+'-')).sort():[];
      for(const name of names){const relative=`.reviews/${name}`,bytes=readCmInitSource(entry.specs,relative);
        reviewRecords.push({path:relative,sha256:sha(bytes),bytes:bytes.toString('base64')});}
      const required=stage==='split'||names.length>0||analysis.designDraft&&!analysis.designRiskSelection||analysis.designRiskSelection?.risks?.some(r=>r.feature===feature&&Object.values(r.signals).some(Boolean));
      if(required){const gate=inspectPrdReview({stage,feature:slug,evidence:path.join(base,prefix+'-r1.md'),receipt:path.join(base,prefix+'-disposition.json')});
        if(gate.outcome!=='completed')unreviewed.push({feature,stage,outcome:gate.outcome});}
    }
  }
  const body=json({version:1,status:'inputs_replaced',sessionId,reason,request,oldInputs,replacementInputs,
    successor:{sessionId:successorSessionId,entry:nextEntry,runtime,inputs:inputs(nextEntry)},features,reviewRecords,unreviewed,sessionState},limit);
  const receipt={...body,receiptDigest:digest(body)};
  // Compare again before the exclusive durable append. No old file is rewritten.
  need(digest(JSON.parse(readPrdSessionFile(directory(entry.specs,sessionId),'state.json')))===digest(sessionState)
    &&digest(session.state)===digest(sessionState)&&digest(inputs(entry))===digest(replacementInputs)
    &&digest(inputs(nextEntry))===digest(body.successor.inputs),'prd_replacement_inputs_changed');
  for(const item of reviewRecords)need(sha(readCmInitSource(entry.specs,item.path))===item.sha256,'prd_replacement_review_changed');
  replaceSessionFile(directory(entry.specs,sessionId),'inputs-replaced.json',null,JSON.stringify(receipt));
  return receipt;
}
export function readPrdPredecessor(specs){
  const bytes=readCmInitSource(specs,'.reviews/prd-predecessor.json');if(bytes===null)return null;
  const link=JSON.parse(bytes),file=link.path;
  need(path.isAbsolute(file)&&path.basename(file)==='inputs-replaced.json','prd_predecessor_binding');
  const oldSpecs=path.resolve(path.dirname(file),'../../..'),id=path.basename(path.dirname(file));
  const receipt=readPrdInputsReplacement(oldSpecs,id);
  need(receipt&&receipt.receiptDigest===link.receiptDigest&&receipt.successor.entry.specs===specs
    &&digest(link)===digest({sessionId:id,path:file,receiptDigest:receipt.receiptDigest,reason:receipt.reason}),
    'prd_predecessor_binding');return link;
}
export function bindPrdPredecessor({entry,runtime,sessionId,predecessor}){
  const existing=readPrdPredecessor(entry.specs);
  if(existing){need(!predecessor||predecessor===existing.path,'prd_predecessor_binding');}
  const file=predecessor??existing?.path;if(!file)return null;
  need(path.isAbsolute(file)&&path.basename(file)==='inputs-replaced.json'&&fs.realpathSync(file)===file,'prd_predecessor_binding');
  const oldSpecs=path.resolve(path.dirname(file),'../../..'),oldId=path.basename(path.dirname(file));
  const receipt=readPrdInputsReplacement(oldSpecs,oldId);
  need(receipt&&receipt.successor.sessionId===sessionId&&receipt.successor.runtime===runtime
    &&digest(receipt.successor.entry)===digest(entry),'prd_predecessor_binding');
  const link={sessionId:oldId,path:file,receiptDigest:receipt.receiptDigest,reason:receipt.reason};
  if(existing){
    need(digest(existing)===digest(link),'prd_predecessor_binding');
    if(!fs.existsSync(path.join(directory(entry.specs,sessionId),'state.json')))
      need(digest(inputs(entry))===digest(receipt.successor.inputs),'prd_predecessor_inputs_changed');
    return existing;
  }
  need(digest(inputs(entry))===digest(receipt.successor.inputs),'prd_predecessor_inputs_changed');fresh(entry.specs,true);
  try{fs.mkdirSync(path.join(entry.specs,'.reviews'),{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}
  replaceSessionFile(path.join(entry.specs,'.reviews'),'prd-predecessor.json',null,JSON.stringify(link));
  return link;
}
