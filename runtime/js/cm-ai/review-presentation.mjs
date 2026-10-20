// Lossless presentation inside the same no-tools prompt. Canonical evidence stays unchanged.
import {createHash} from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';
import {json,need} from './effect-contract.mjs';
import {readReviewFileBytes} from './review-package.mjs';
import {jsonTokens} from './native-json-carrier.mjs';
export {jsonTokens};
const FILE=1024*1024,INPUT=10*FILE;
const FRAGMENTS=4096,PARTS=8192,ALL_PARTS=65536;
const byteSize=value=>Buffer.byteLength(JSON.stringify(value));
const valid=(ok)=>need(ok,'review_presentation_invalid');
// The optimization has its own bounded work space. Exhaustion keeps complete
// literal evidence; it never increases a transport, file or provider budget.
function subtreeRanges(tokens){
 const stack=[],ranges=[];let quoted=false,escaped=false;
 for(let i=0;i<tokens.length;i++){const c=tokens[i];
  if(quoted){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;continue;}
  if(c==='"')quoted=true;else if(c==='{'||c==='[')stack.push(i);
  else if(c==='}'||c===']'){const start=stack.pop();if(i+1-start>=256&&ranges.length<ALL_PARTS)ranges.push({start,end:i+1});}
 }return ranges;
}
function fragmentTable(contents,sources){
 const candidates=new Map(),entries=[];let sampled=0,stored=0;
 for(const [ref,bytes] of sources){
  if(bytes.length>FILE)continue;let tokens;
  try{tokens=jsonTokens(new TextDecoder('utf8',{fatal:true,ignoreBOM:true}).decode(bytes));}catch{continue;}
  const ranges=subtreeRanges(tokens),accepted=[];entries.push({ref,bytes,tokens,ranges:accepted});
  for(const r of ranges){const length=r.end-r.start;if(sampled+length>64*FILE)continue;sampled+=length;
   const text=tokens.slice(r.start,r.end);let c=candidates.get(text);
   if(!c){const n=Buffer.byteLength(text);if(candidates.size>=8192||stored+n>16*FILE)continue;
    c={text,count:0};candidates.set(text,c);stored+=n;}
   c.count++;accepted.push({...r,candidate:c});
  }
 }
 const selected=[...candidates.values()].filter(c=>c.count>=2&&(c.count-1)*byteSize(c.text)-c.count*45>128)
  .sort((a,b)=>b.text.length-a.text.length||b.count-a.count).slice(0,FRAGMENTS);
 if(!selected.length)return null;
 const ids=new Map(selected.map((c,i)=>[c.text,'f'+(i+1)])),proposed={...contents};
 let partCount=0;
 for(const {ref,bytes,tokens,ranges} of entries){
  const matching=ranges.map(r=>({...r,id:ids.get(r.candidate.text)})).filter(r=>r.id)
   .sort((a,b)=>a.start-b.start||b.end-a.end),parts=[];let offset=0;
  for(const r of matching){if(r.start<offset)continue;if(r.start>offset)parts.push(tokens.slice(offset,r.start));
   parts.push({jsonFragmentRef:r.id});offset=r.end;}
  if(offset<tokens.length)parts.push(tokens.slice(offset));
  if(!parts.some(p=>typeof p!=='string')||parts.length>PARTS||partCount+parts.length>ALL_PARTS)continue;
  const view={sha256:contents[ref].sha256,size:bytes.length,encoding:'json-fragment-view',parts,
   originalGzipBase64:gzipSync(bytes).toString('base64')};
  if(byteSize(view)<byteSize(contents[ref])){proposed[ref]=view;partCount+=parts.length;}
 }
 const used=new Set(Object.values(proposed).filter(c=>c.encoding==='json-fragment-view')
  .flatMap(c=>c.parts.filter(p=>typeof p!=='string').map(p=>p.jsonFragmentRef)));
 const fragments=Object.fromEntries([...ids].filter(([,id])=>used.has(id)).map(([text,id])=>[id,text]));
 if(!used.size||byteSize(fragments)>4*FILE||byteSize({contents:proposed,jsonFragments:fragments})>=byteSize({contents}))return null;
 return {contents:proposed,jsonFragments:fragments};
}
function originalBytes(content){
 valid(Number.isSafeInteger(content.size)&&content.size>0&&content.size<=FILE);
 valid(typeof content.originalGzipBase64==='string'&&content.originalGzipBase64.length<=2*FILE);
 const compressed=Buffer.from(content.originalGzipBase64,'base64');valid(compressed.toString('base64')===content.originalGzipBase64);
 try{return gunzipSync(compressed,{maxOutputLength:content.size});}catch{valid(false);}
}
export function compactReviewData(raw){
  const input=json(raw,INPUT),contents={},keys=new Map(),sources=new Map();let sourceBytes=0;
  need(!Object.hasOwn(input,'presentation')&&!Object.hasOwn(input,'contents')&&!Object.hasOwn(input,'jsonFragments')&&input.reviewPackage?.packageDigest,'review_presentation_invalid');
  const visit=value=>{
    if(Array.isArray(value))return value.map(visit);
    if(value===null||typeof value!=='object')return value;
    need(!Object.hasOwn(value,'contentRef'),'review_presentation_invalid');
    const out=Object.fromEntries(Object.entries(value).map(([key,item])=>[key,visit(item)]));
    const compressed=Object.hasOwn(value,'contentGzipBase64');
    if(!compressed&&typeof value.contentBase64!=='string')return out;
    let bytes;
    if(compressed){try{bytes=readReviewFileBytes(value);}catch{need(false,'review_presentation_invalid');}}
    else{bytes=Buffer.from(value.contentBase64,'base64');
      need(bytes.toString('base64')===value.contentBase64,'review_presentation_invalid');}
    const hash=createHash('sha256').update(bytes).digest('hex');
    if(Object.hasOwn(value,'sha256'))need(hash===value.sha256,'review_presentation_invalid');
    if(Object.hasOwn(value,'size'))need(bytes.length===value.size,'review_presentation_invalid');
    const key=hash+':'+bytes.length;let ref=keys.get(key);
    if(!ref){
      ref='content-'+(keys.size+1);keys.set(key,ref);if(sourceBytes+bytes.length<=INPUT){sources.set(ref,bytes);sourceBytes+=bytes.length;}
      let text;try{text=new TextDecoder('utf8',{fatal:true}).decode(bytes);}catch{}
      // Byte-exact decoding: BOM or invalid UTF-8 retains the original base64.
      const utf8=text!==undefined&&Buffer.from(text,'utf8').equals(bytes);
      const original={sha256:hash,size:bytes.length,encoding:utf8?'utf8':'base64',content:utf8?text:bytes.toString('base64')};
      if(utf8&&['application/json','application/x-cm-lossless-json-evidence'].includes(value.mediaType)){
        const view={sha256:hash,size:bytes.length,encoding:'json-token-view',content:jsonTokens(text),
          originalGzipBase64:gzipSync(bytes).toString('base64')};
        contents[ref]=Buffer.byteLength(JSON.stringify(view))<Buffer.byteLength(JSON.stringify(original))?view:original;
      }else contents[ref]=original;
    }
    delete out.contentBase64;out.contentRef=ref;return out;
  };
  const shown=visit(input),fragmented=fragmentTable(contents,sources);
  const version=fragmented?3:Object.values(contents).some(c=>c.encoding==='json-token-view')?2:1;
  return {presentation:{version,kind:'complete-inline-content-table',
    packageDigest:input.reviewPackage.packageDigest},...shown,...(fragmented??{contents})};
}
export function expandReviewData(raw){
  const input=json(raw,INPUT),{presentation,contents,jsonFragments,...data}=input;
  valid([1,2,3].includes(presentation?.version)&&presentation.kind==='complete-inline-content-table');
  valid(contents&&typeof contents==='object'&&!Array.isArray(contents));
  valid(Object.keys(contents).every(k=>/^content-[1-9][0-9]*$/.test(k)));
  const v3=presentation.version===3,used=new Set(),usedContents=new Set(),decoded=new Map();let allParts=0,decodedBytes=0;
  valid(v3?jsonFragments&&typeof jsonFragments==='object'&&!Array.isArray(jsonFragments):!Object.hasOwn(input,'jsonFragments'));
  if(v3){
    valid(Object.keys(presentation).length===3&&presentation.packageDigest===data.reviewPackage?.packageDigest);
    for(const content of Object.values(contents)){
      valid(content&&typeof content==='object'&&!Array.isArray(content));
      const names=content.encoding==='json-fragment-view'?['sha256','size','encoding','parts','originalGzipBase64']:
        content.encoding==='json-token-view'?['sha256','size','encoding','content','originalGzipBase64']:['sha256','size','encoding','content'];
      valid(Object.keys(content).length===names.length&&names.every(k=>Object.hasOwn(content,k)));
      valid(Number.isSafeInteger(content.size)&&content.size>=0&&content.size<=FILE&&typeof content.sha256==='string'&&/^[a-f0-9]{64}$/.test(content.sha256));
    }
    const names=Object.keys(jsonFragments);valid(names.length>0&&names.length<=FRAGMENTS&&byteSize(jsonFragments)<=4*FILE);
    const unique=new Set();for(const name of names){const text=jsonFragments[name];
      valid(/^f[1-9][0-9]*$/.test(name)&&typeof text==='string'&&Buffer.byteLength(text)<=FILE&&!unique.has(text));
      try{valid((text[0]==='{'||text[0]==='[')&&jsonTokens(text)===text);}catch{valid(false);}unique.add(text);
    }
  }
  const visit=value=>{
    if(Array.isArray(value))return value.map(visit);
    if(value===null||typeof value!=='object')return value;
    const out=Object.fromEntries(Object.entries(value).map(([key,item])=>[key,visit(item)]));
    if(!Object.hasOwn(value,'contentRef'))return out;
    valid(typeof value.contentRef==='string'&&/^content-[1-9][0-9]*$/.test(value.contentRef)&&Object.hasOwn(contents,value.contentRef));
    usedContents.add(value.contentRef);if(v3)valid(!Object.hasOwn(value,'contentBase64'));
    const content=contents[value.contentRef];valid(content&&typeof content==='object'&&!Array.isArray(content));let bytes;
    if(decoded.has(value.contentRef))bytes=decoded.get(value.contentRef);
    else if(['json-token-view','json-fragment-view'].includes(content.encoding)){
      valid(presentation.version>=2);bytes=originalBytes(content);let tokens=content.content;
      if(content.encoding==='json-fragment-view'){
        valid(v3&&Object.keys(content).length===5&&['sha256','size','encoding','parts','originalGzipBase64'].every(k=>Object.hasOwn(content,k)));
        valid(Array.isArray(content.parts)&&content.parts.length>0&&content.parts.length<=PARTS);
        allParts+=content.parts.length;valid(allParts<=ALL_PARTS);let length=0;
        tokens=content.parts.map(part=>{
          let text;if(typeof part==='string'){valid(part.length>0);text=part;}
          else{valid(part&&typeof part==='object'&&!Array.isArray(part)&&Object.keys(part).length===1&&Object.hasOwn(part,'jsonFragmentRef'));
            const ref=part.jsonFragmentRef;valid(typeof ref==='string'&&Object.hasOwn(jsonFragments,ref));used.add(ref);text=jsonFragments[ref];}
          length+=Buffer.byteLength(text);valid(length<=content.size);return text;
        }).join('');
      }
      try{valid(jsonTokens(new TextDecoder('utf8',{fatal:true,ignoreBOM:true}).decode(bytes))===tokens);}catch{valid(false);}
    }else{valid(['utf8','base64'].includes(content.encoding)&&typeof content.content==='string');bytes=Buffer.from(content.content,content.encoding==='utf8'?'utf8':'base64');
      if(content.encoding==='base64')valid(bytes.toString('base64')===content.content);}
    valid(bytes.length===content.size&&createHash('sha256').update(bytes).digest('hex')===content.sha256);
    if(!decoded.has(value.contentRef)){decodedBytes+=bytes.length;valid(decodedBytes<=INPUT);decoded.set(value.contentRef,bytes);}delete out.contentRef;
    if(Object.hasOwn(out,'contentGzipBase64')){
      try{valid(readReviewFileBytes(out).equals(bytes));}catch{valid(false);}
    }else out.contentBase64=bytes.toString('base64');
    return out;
  };
  const expanded=visit(data);if(v3)valid(used.size===Object.keys(jsonFragments).length&&usedContents.size===Object.keys(contents).length);return expanded;
}
