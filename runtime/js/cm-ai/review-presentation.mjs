// Lossless presentation inside the same no-tools prompt. Canonical evidence stays unchanged.
import {createHash} from 'node:crypto';
import {json,need} from './effect-contract.mjs';
export function compactReviewData(raw){
  const input=json(raw,10*1024*1024),contents={},keys=new Map();
  need(!Object.hasOwn(input,'presentation')&&!Object.hasOwn(input,'contents')&&input.reviewPackage?.packageDigest,'review_presentation_invalid');
  const visit=value=>{
    if(Array.isArray(value))return value.map(visit);
    if(value===null||typeof value!=='object')return value;
    need(!Object.hasOwn(value,'contentRef'),'review_presentation_invalid');
    const out=Object.fromEntries(Object.entries(value).map(([key,item])=>[key,visit(item)]));
    if(typeof value.contentBase64!=='string')return out;
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
    packageDigest:input.reviewPackage.packageDigest},...visit(input),contents};
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
