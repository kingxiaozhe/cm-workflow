// Prompt-only, lossless V2. Never used by the V1 journal storage codec.
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {compactReviewData,expandReviewData} from './review-presentation.mjs';
import {digest,json,need,shape,hex} from './effect-contract.mjs';

const CODE='review_presentation_delta_invalid',INPUT_LIMIT=10*1024*1024,PHYSICAL_LIMIT=11*1024*1024;
const ENTRY_PARTS=1024,TOTAL_PARTS=4096,LINE_LIMIT=65536;
const size=value=>Buffer.byteLength(JSON.stringify(value),'utf8');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const integer=value=>Number.isSafeInteger(value)&&value>=0;
function literal(bytes){
  let text;try{text=new TextDecoder('utf8',{fatal:true}).decode(bytes);}catch{}
  return text!==undefined&&Buffer.from(text,'utf8').equals(bytes)
    ?{encoding:'utf8',content:text}:{encoding:'base64',content:bytes.toString('base64')};
}
function literalBytes(item){
  shape(item,['encoding','content']);
  need(['utf8','base64'].includes(item.encoding)&&typeof item.content==='string',CODE);
  const bytes=Buffer.from(item.content,item.encoding==='utf8'?'utf8':'base64');
  need(isDeepStrictEqual(literal(bytes),item),CODE);return bytes;
}
function pairBases(data){
  const pairs=new Map();
  for(const change of data.reviewPackage?.changes??[]){
    const before=change?.before,after=change?.after;
    if(!before||!after||typeof change.path!=='string'||before.path!==change.path||after.path!==change.path
      ||typeof before.contentRef!=='string'||typeof after.contentRef!=='string'||before.contentRef===after.contentRef)continue;
    const bases=pairs.get(after.contentRef)??new Set();bases.add(before.contentRef);pairs.set(after.contentRef,bases);
  }
  return pairs;
}
function prefixSuffix(base,target){
  const limit=Math.min(base.length,target.length);let prefix=0,suffix=0;
  while(prefix<limit&&base[prefix]===target[prefix])prefix++;
  while(suffix<limit-prefix&&base[base.length-suffix-1]===target[target.length-suffix-1])suffix++;
  return [...(prefix?[{copy:{offset:0,size:prefix}}]:[]),
    ...(target.length>prefix+suffix?[{insert:literal(target.subarray(prefix,target.length-suffix))}]:[]),
    ...(suffix?[{copy:{offset:base.length-suffix,size:suffix}}]:[])];
}
function lines(bytes){
  const result=[];let start=0;
  while(start<bytes.length){
    if(result.length>=LINE_LIMIT)return null;
    const newline=bytes.indexOf(10,start),end=newline<0?bytes.length:newline+1;
    result.push([start,end]);start=end;
  }
  return result;
}
function anchoredParts(base,target){
  const oldLines=lines(base),newLines=lines(target);if(!oldLines||!newLines)return null;
  const anchors=new Map();
  for(const [start,end] of oldLines){
    if(end-start<32)continue;
    const key=base.subarray(start,end).toString('base64');
    anchors.set(key,anchors.has(key)?null:start);
  }
  const parts=[];let insertStart=0,previousEnd=null,lastCopyEnd=0;
  for(const [start,end] of newLines){
    const bytes=target.subarray(start,end);
    const offset=previousEnd!==null&&base.subarray(previousEnd,previousEnd+bytes.length).equals(bytes)
      ?previousEnd:anchors.get(bytes.toString('base64'));
    if(offset===undefined||offset===null||offset<lastCopyEnd){previousEnd=null;continue;}
    if(start>insertStart)parts.push({insert:literal(target.subarray(insertStart,start))});
    const last=parts.at(-1);
    if(last?.copy&&last.copy.offset+last.copy.size===offset)last.copy.size+=bytes.length;
    else parts.push({copy:{offset,size:bytes.length}});
    if(parts.length>ENTRY_PARTS)return null;
    insertStart=end;previousEnd=offset+bytes.length;lastCopyEnd=previousEnd;
  }
  if(insertStart<target.length)parts.push({insert:literal(target.subarray(insertStart))});
  return parts.length<=ENTRY_PARTS?parts:null;
}
export function compactReviewDataV2(raw){
  const input=json(raw,INPUT_LIMIT),v1=compactReviewData(input),pairs=pairBases(v1),contents={};
  let partCount=0;
  for(const [name,entry] of Object.entries(v1.contents)){
    let selected=entry;
    // One same-path pair, never an all-contents similarity search. The base
    // must already be a full table entry; delta chains are not produced.
    const baseRef=[...(pairs.get(name)??[])].find(ref=>Object.hasOwn(contents,ref)&&contents[ref].encoding!=='delta-v2');
    if(baseRef){
      const base=literalBytes({encoding:contents[baseRef].encoding,content:contents[baseRef].content});
      const target=literalBytes({encoding:entry.encoding,content:entry.content});
      for(const parts of [prefixSuffix(base,target),anchoredParts(base,target)]){
        if(!parts||parts.length>ENTRY_PARTS||partCount+parts.length>TOTAL_PARTS||!parts.some(part=>part.copy))continue;
        const candidate={sha256:entry.sha256,size:entry.size,encoding:'delta-v2',baseRef,parts};
        if(size(candidate)<size(selected))selected=candidate;
      }
    }
    contents[name]=selected;if(selected.encoding==='delta-v2')partCount+=selected.parts.length;
  }
  const {presentation,...data}=v1;
  const result={presentation:{version:2,kind:'complete-inline-content-delta',packageDigest:presentation.packageDigest,
    logicalBytes:size(input),logicalDigest:digest(input)},...data,contents};
  need(isDeepStrictEqual(expandReviewDataV2(result),input),CODE);return result;
}
export function expandReviewDataV2(raw){
  const value=json(raw,PHYSICAL_LIMIT),{presentation,contents,...data}=value;
  shape(presentation,['version','kind','packageDigest','logicalBytes','logicalDigest']);
  need(presentation.version===2&&presentation.kind==='complete-inline-content-delta'
    &&integer(presentation.logicalBytes)&&presentation.logicalBytes<=INPUT_LIMIT, CODE);
  hex(presentation.packageDigest);hex(presentation.logicalDigest);
  need(data.reviewPackage?.packageDigest===presentation.packageDigest
    &&contents!==null&&typeof contents==='object'&&!Array.isArray(contents),CODE);
  const pairs=pairBases(data),plans=new Map(),used=new Set();let totalBytes=0,partCount=0;
  for(const [index,[name,entry]] of Object.entries(contents).entries()){
    need(name==='content-'+(index+1)&&entry!==null&&typeof entry==='object'&&!Array.isArray(entry),CODE);
    hex(entry.sha256);need(integer(entry.size)&&entry.size<=INPUT_LIMIT,CODE);
    totalBytes+=entry.size;need(totalBytes<=INPUT_LIMIT,'limit_exceeded');
    if(entry.encoding!=='delta-v2'){
      shape(entry,['sha256','size','encoding','content']);
      const bytes=literalBytes({encoding:entry.encoding,content:entry.content});
      need(bytes.length===entry.size&&sha(bytes)===entry.sha256,CODE);plans.set(name,{bytes});continue;
    }
    shape(entry,['sha256','size','encoding','baseRef','parts']);
    // Only backward references to complete entries from this same path pair.
    const base=plans.get(entry.baseRef);
    need(base?.bytes&&pairs.get(name)?.has(entry.baseRef)&&Array.isArray(entry.parts)
      &&entry.parts.length>0&&entry.parts.length<=ENTRY_PARTS,CODE);
    partCount+=entry.parts.length;need(partCount<=TOTAL_PARTS,CODE);
    let length=0,lastCopyEnd=0,copies=0;const segments=[];
    for(const part of entry.parts){
      need(part!==null&&typeof part==='object'&&!Array.isArray(part),CODE);
      if(Object.hasOwn(part,'copy')){
        shape(part,['copy']);shape(part.copy,['offset','size']);const {offset,size}=part.copy;
        need(integer(offset)&&integer(size)&&size>0&&offset>=lastCopyEnd&&offset+size<=base.bytes.length,CODE);
        lastCopyEnd=offset+size;length+=size;copies++;segments.push({offset,size});
      }else{
        shape(part,['insert']);const bytes=literalBytes(part.insert);need(bytes.length>0,CODE);
        length+=bytes.length;segments.push({bytes});
      }
      need(length<=entry.size,CODE);
    }
    need(length===entry.size&&copies>0,CODE);plans.set(name,{base:base.bytes,segments});
  }
  // Measure every expanded occurrence before allocating reconstructed files or
  // base64 strings. A small repeated reference must not amplify past the cap.
  const measure=node=>{
    if(node===null||typeof node!=='object')return size(node);
    if(Array.isArray(node))return 2+Math.max(0,node.length-1)+node.reduce((n,item)=>n+measure(item),0);
    const ref=Object.hasOwn(node,'contentRef'),entry=ref?contents[node.contentRef]:null;
    if(ref){
      need(typeof node.contentRef==='string'&&Object.hasOwn(contents,node.contentRef)&&!Object.hasOwn(node,'contentBase64'),CODE);
      if(Object.hasOwn(node,'sha256'))need(node.sha256===entry.sha256,CODE);
      if(Object.hasOwn(node,'size'))need(node.size===entry.size,CODE);
      used.add(node.contentRef);
    }
    const entries=Object.entries(node).filter(([key])=>!ref||key!=='contentRef');
    const measured=2+Math.max(0,entries.length+(ref?1:0)-1)
      +entries.reduce((n,[key,item])=>n+size(key)+1+measure(item),0)
      +(ref?size('contentBase64')+3+4*Math.ceil(entry.size/3):0);
    need(measured<=INPUT_LIMIT,'limit_exceeded');return measured;
  };
  need(measure(data)===presentation.logicalBytes&&used.size===plans.size,CODE);
  const expandedContents={};
  for(const [name,plan] of plans){
    const entry=contents[name];
    const bytes=plan.bytes??Buffer.concat(plan.segments.map(part=>part.bytes??plan.base.subarray(part.offset,part.offset+part.size)),entry.size);
    need(bytes.length===entry.size&&sha(bytes)===entry.sha256,CODE);
    expandedContents[name]={sha256:entry.sha256,size:entry.size,...literal(bytes)};
  }
  const expanded=expandReviewData({presentation:{version:1,kind:'complete-inline-content-table',packageDigest:presentation.packageDigest},...data,contents:expandedContents});
  need(size(expanded)===presentation.logicalBytes&&digest(expanded)===presentation.logicalDigest,CODE);
  return expanded;
}
