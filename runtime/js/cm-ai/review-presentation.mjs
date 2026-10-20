// Lossless presentation inside the same no-tools prompt. Canonical evidence stays unchanged.
import {createHash} from 'node:crypto';
import {json,need,shape,hex,digest,validIdentity} from './effect-contract.mjs';
import {readReviewPackage} from './review-package.mjs';
export function compactReviewData(raw){
  const input=json(raw,10*1024*1024);
  need(!Object.hasOwn(input,'presentation')&&!Object.hasOwn(input,'contents')&&input.reviewPackage?.packageDigest,'review_presentation_invalid');
  return compactInlineContent(input,input.reviewPackage.packageDigest);
}
function compactInlineContent(input,packageDigest,selected=null){
  const contents={},keys=new Map();
  const visit=(value,route=[])=>{
    if(Array.isArray(value))return value.map((item,i)=>visit(item,[...route,String(i)]));
    if(value===null||typeof value!=='object')return value;
    const eligible=selected===null||inPackage(route,selected);
    if(eligible)need(!Object.hasOwn(value,'contentRef'),'review_presentation_invalid');
    const out=Object.fromEntries(Object.entries(value).map(([key,item])=>[key,visit(item,[...route,key])]));
    if(!eligible||typeof value.contentBase64!=='string')return out;
    const bytes=Buffer.from(value.contentBase64,'base64');
    need(bytes.toString('base64')===value.contentBase64,'review_presentation_invalid');
    const hash=createHash('sha256').update(bytes).digest('hex');
    if(Object.hasOwn(value,'sha256'))need(hash===value.sha256,'review_presentation_invalid');
    if(Object.hasOwn(value,'size'))need(bytes.length===value.size,'review_presentation_invalid');
    const key=hash+':'+bytes.length;let ref=keys.get(key);
    if(!ref){
      ref='content-'+(keys.size+1);keys.set(key,ref);
      let text;try{text=new TextDecoder('utf8',{fatal:true}).decode(bytes);}catch{}
      // Byte-exact decoding: BOM or invalid UTF-8 retains the original base64.
      const utf8=text!==undefined&&Buffer.from(text,'utf8').equals(bytes);
      contents[ref]={sha256:hash,size:bytes.length,encoding:utf8?'utf8':'base64',content:utf8?text:value.contentBase64};
    }
    delete out.contentBase64;out.contentRef=ref;return out;
  };
  return {presentation:{version:1,kind:'complete-inline-content-table',
    packageDigest},...visit(input),contents};
}
export function expandReviewData(raw){
  const {presentation,contents,...data}=raw;
  need(presentation?.version===1&&presentation.kind==='complete-inline-content-table','review_presentation_invalid');
  const visit=value=>{
    if(Array.isArray(value))return value.map(visit);
    if(value===null||typeof value!=='object')return value;
    const out=Object.fromEntries(Object.entries(value).map(([key,item])=>[key,visit(item)]));
    if(!Object.hasOwn(value,'contentRef'))return out;
    const content=contents[value.contentRef];need(content,'review_presentation_invalid');
    const bytes=Buffer.from(content.content,content.encoding==='utf8'?'utf8':'base64');
    need(bytes.length===content.size&&createHash('sha256').update(bytes).digest('hex')===content.sha256,'review_presentation_invalid');
    delete out.contentRef;out.contentBase64=bytes.toString('base64');return out;
  };
  return visit(data);
}

// Physical storage only, for the existing standalone fix owner. The state marker
// explicitly selects encoded sequences: a legacy small lookalike keeps its meaning.
const FIX_WORKFLOW='cm-fix-stages-v1',PAYLOAD_LIMIT=1024*1024,INPUT_LIMIT=10*1024*1024,STATE_LIMIT=16*1024*1024;
const STORAGE_KIND='cm-fix-review-payloads-v1',PAYLOAD_KIND='cm-fix-journal-review-payload';
const storageCode='review_storage_invalid';
const sizeOf=value=>Buffer.byteLength(JSON.stringify(value));
const sameBytes=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
export function fixJournalWorkflow(state){
  const first=state.records?.[0];
  return first?.id==='fix-configuration'&&first.kind==='intent'&&first.payload?.workflow===FIX_WORKFLOW
    &&state.fingerprints?.workflow===digest(FIX_WORKFLOW)?FIX_WORKFLOW:null;
}
const inPackage=(route,paths)=>paths.some(p=>route.length>=p.length&&p.every((part,i)=>route[i]===part));
// These are the actual durable fix-owner payload forms. This is not an arbitrary
// recursive search for a token package hidden inside unrelated application data.
function packageLocations(value,{validate=true}={}){
  need(object(value),storageCode);let locations;
  if(value.kind==='cm-review-package')locations=[[]];
  else if(Object.hasOwn(value,'writeback')&&Object.hasOwn(value,'reviewPackage')){
    shape(value,['writeback','reviewPackage']);const w=value.writeback;
    shape(w,['identity','learningDigest','retrospectiveDigest','packageDigest','outcome','changed','agentsFile','reason','completionEligible']);
    validIdentity(w.identity);[w.learningDigest,w.retrospectiveDigest,w.packageDigest].forEach(hex);
    need(['written','deduplicated'].includes(w.outcome)&&w.changed===(w.outcome==='written')
      &&w.reason===null&&w.completionEligible===false,storageCode);
    shape(w.agentsFile,['scope','path','sha256']);
    need(w.agentsFile.scope==='project'&&w.agentsFile.path==='AGENTS.md',storageCode);hex(w.agentsFile.sha256);
    locations=[['reviewPackage']];
  }else if(Object.hasOwn(value,'request')){
    shape(value,['request','authorizationAt','registeredAt','grant']);
    const r=value.request;
    shape(r,['version','invocationId','identity','role','provider','requestedModel','contextId','payload','requestDigest']);
    validIdentity(r.identity);hex(r.requestDigest);shape(r.payload,['reviewPackage','priorReview']);
    need(r.version===1&&r.role==='reviewer'&&typeof r.invocationId==='string'&&r.invocationId.startsWith('fix-final.')
      &&['codex','claude'].includes(r.provider)&&typeof r.requestedModel==='string'&&r.requestedModel.trim()
      &&typeof r.contextId==='string'&&r.contextId.trim()&&object(value.grant)
      &&Number.isSafeInteger(value.authorizationAt)&&value.authorizationAt>=0
      &&Number.isSafeInteger(value.registeredAt)&&value.registeredAt>=value.authorizationAt,storageCode);
    if(validate){const {requestDigest,...body}=r;need(digest(body)===requestDigest,storageCode);}
    locations=[['request','payload','reviewPackage']];
  }else need(false,storageCode);
  const packages=locations.map(route=>route.reduce((node,key)=>node[key],value));
  need(packages.every(pkg=>object(pkg)&&pkg.kind==='cm-review-package'),storageCode);
  if(validate){
    packages.forEach(readReviewPackage);
    const identity=value.request?.identity??value.writeback?.identity;
    if(identity)need(packages.every(pkg=>digest(pkg.identity)===digest(identity)),storageCode);
  }
  return {paths:locations,packages};
}
export function packFixJournalPayload(raw,{workflow}={}){
  const value=json(raw,INPUT_LIMIT),logicalBytes=sizeOf(value);
  if(logicalBytes<=PAYLOAD_LIMIT)return value;
  need(workflow===FIX_WORKFLOW,'limit_exceeded');
  const {paths,packages}=packageLocations(value);
  // No duplicated anchor package in the temporary input: the canonical package
  // already inside payload supplies the presentation digest to the same visitor.
  const data=compactInlineContent({payload:value},packages[0].packageDigest,paths.map(p=>['payload',...p]));
  const packed={version:1,kind:PAYLOAD_KIND,logicalBytes,logicalDigest:digest(value),data};
  return json(packed,PAYLOAD_LIMIT);
}
function payloadPlan(raw,{workflow}={}){
  need(workflow===FIX_WORKFLOW,storageCode);
  const value=json(raw,PAYLOAD_LIMIT);
  shape(value,['version','kind','logicalBytes','logicalDigest','data']);
  need(value.version===1&&value.kind===PAYLOAD_KIND&&Number.isSafeInteger(value.logicalBytes)
    &&value.logicalBytes>PAYLOAD_LIMIT&&value.logicalBytes<=INPUT_LIMIT,storageCode);hex(value.logicalDigest);
  const data=value.data;shape(data,['presentation','payload','contents']);
  shape(data.presentation,['version','kind','packageDigest']);
  need(data.presentation.version===1&&data.presentation.kind==='complete-inline-content-table',storageCode);hex(data.presentation.packageDigest);
  need(object(data.contents),storageCode);
  const {paths}=packageLocations(data.payload,{validate:false});
  const names=Object.keys(data.contents),lengths=new Map(),used=new Set();
  for(const [index,name] of names.entries()){
    need(name==='content-'+(index+1),storageCode);
    const item=data.contents[name];shape(item,['sha256','size','encoding','content']);hex(item.sha256);
    need(Number.isSafeInteger(item.size)&&item.size>=0&&item.size<=INPUT_LIMIT
      &&['utf8','base64'].includes(item.encoding)&&typeof item.content==='string',storageCode);
    // Table bytes are bounded by the physical payload, independently of the
    // claimed size. Never allocate from an attacker-supplied size field.
    const bytes=Buffer.from(item.content,item.encoding==='utf8'?'utf8':'base64');
    need(bytes.length===item.size&&(item.encoding!=='base64'||bytes.toString('base64')===item.content)
      &&createHash('sha256').update(bytes).digest('hex')===item.sha256,storageCode);
    lengths.set(name,4*Math.ceil(bytes.length/3));
  }
  let nodes=0;
  const measure=(node,depth=0,route=[])=>{
    need(depth<=40&&++nodes<=PAYLOAD_LIMIT,storageCode);
    if(node===null||typeof node!=='object')return sizeOf(node);
    if(Array.isArray(node))return 2+Math.max(0,node.length-1)+node.reduce((n,item,i)=>n+measure(item,depth+1,[...route,String(i)]),0);
    const reference=inPackage(route,paths)&&Object.hasOwn(node,'contentRef');
    if(reference)need(typeof node.contentRef==='string'&&lengths.has(node.contentRef)
      &&!Object.hasOwn(node,'contentBase64'),storageCode);
    const entries=Object.entries(node).filter(([key])=>!reference||key!=='contentRef');
    let bytes=2+Math.max(0,entries.length+(reference?1:0)-1);
    for(const [key,item] of entries)bytes+=sizeOf(key)+1+measure(item,depth+1,[...route,key]);
    if(reference){used.add(node.contentRef);bytes+=sizeOf('contentBase64')+1+2+lengths.get(node.contentRef);}
    need(bytes<=INPUT_LIMIT,'limit_exceeded');return bytes;
  };
  const logicalBytes=measure(data.payload);
  need(logicalBytes===value.logicalBytes&&used.size===names.length,storageCode);
  return {value,logicalBytes,paths};
}
export function unpackFixJournalPayload(raw,{workflow}={}){
  const physical=json(raw,PAYLOAD_LIMIT);
  if(!object(physical)||physical.kind!==PAYLOAD_KIND)return physical;
  const {value,paths}=payloadPlan(physical,{workflow});
  const visit=(node,route=[])=>{
    if(Array.isArray(node))return node.map((item,i)=>visit(item,[...route,String(i)]));
    if(node===null||typeof node!=='object')return node;
    const out=Object.fromEntries(Object.entries(node).map(([key,item])=>[key,visit(item,[...route,key])]));
    if(inPackage(route,paths)&&Object.hasOwn(node,'contentRef')){
      const entry=value.data.contents[node.contentRef];
      delete out.contentRef;out.contentBase64=Buffer.from(entry.content,entry.encoding==='utf8'?'utf8':'base64').toString('base64');
    }
    return out;
  };
  const payload=json(visit(value.data.payload),INPUT_LIMIT),{packages}=packageLocations(payload);
  need(sizeOf(payload)===value.logicalBytes&&digest(payload)===value.logicalDigest
    &&packages[0].packageDigest===value.data.presentation.packageDigest,storageCode);
  // Exact fixed point rejects alternate encodings, extra tables and collisions.
  need(sameBytes(packFixJournalPayload(payload,{workflow}),value),storageCode);return payload;
}
export function packFixJournalState(raw){
  const state=json(raw,STATE_LIMIT);need(!Object.hasOwn(state,'storageEncoding'),storageCode);
  const workflow=fixJournalWorkflow(state),sequences=[];
  const records=state.records.map(record=>{
    const payload=packFixJournalPayload(record.payload,{workflow});
    if(sizeOf(record.payload)>PAYLOAD_LIMIT)sequences.push(record.seq);
    return {...record,payload};
  });
  return json({...state,records,...(sequences.length?{storageEncoding:{version:1,kind:STORAGE_KIND,records:sequences}}:{})},STATE_LIMIT);
}
export function unpackFixJournalState(raw){
  const physical=json(raw,STATE_LIMIT);
  if(!Object.hasOwn(physical,'storageEncoding')){
    need(Array.isArray(physical.records),storageCode);
    physical.records.forEach(record=>json(record.payload,PAYLOAD_LIMIT));
    return physical;
  }
  shape(physical,['version','identity','fingerprints','records','revision','storageEncoding']);
  const workflow=fixJournalWorkflow(physical);need(workflow===FIX_WORKFLOW,storageCode);
  const marker=physical.storageEncoding;shape(marker,['version','kind','records']);
  need(marker.version===1&&marker.kind===STORAGE_KIND&&Array.isArray(physical.records)
    &&physical.records.length<=1024&&Array.isArray(marker.records)&&marker.records.length>0
    &&marker.records.every((seq,i)=>Number.isSafeInteger(seq)&&seq>1&&seq<=physical.records.length
      &&(i===0||seq>marker.records[i-1])),storageCode);
  const selected=new Set(marker.records),{storageEncoding,...logical}=physical;
  // Plan every expansion before allocating any expanded payload. Per-payload
  // caps alone would permit many individually valid envelopes to exhaust memory.
  let bytes=sizeOf(logical);
  for(const [index,record] of physical.records.entries()){
    need(record.seq===index+1,storageCode);
    if(selected.has(record.seq))bytes+=payloadPlan(record.payload,{workflow}).logicalBytes-sizeOf(record.payload);
    else json(record.payload,PAYLOAD_LIMIT);
    need(bytes<=STATE_LIMIT,'limit_exceeded');
  }
  logical.records=physical.records.map(record=>selected.has(record.seq)
    ?{...record,payload:unpackFixJournalPayload(record.payload,{workflow})}:record);
  need(sizeOf(logical)===bytes&&sameBytes(packFixJournalState(logical),physical),storageCode);
  return json(logical,STATE_LIMIT);
}
