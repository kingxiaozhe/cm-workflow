// Lossless derived attachment: source paths are provenance, never filesystem inputs.
import {createHash} from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';
import {need} from './effect-contract.mjs';
const FILE=1024*1024,TOTAL=4*FILE;
const check=ok=>need(ok,'lossless_json_evidence_invalid');
const sha=b=>createHash('sha256').update(b).digest('hex');
export function jsonTokens(text){
 JSON.parse(text);let quoted=false,escaped=false,out='';
 for(const c of text){
  if(quoted){out+=c;if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;}
  else if(c==='"'){quoted=true;out+=c;}else if(!' \t\r\n'.includes(c))out+=c;
 }return out;
}
function utf8(bytes){
 const text=new TextDecoder('utf8',{fatal:true,ignoreBOM:true}).decode(bytes);
 check(Buffer.from(text).equals(bytes));return text;
}
// A validated JSON object's top-level raw values; never reserialize its data.
// Decoded key uniqueness catches escaped aliases as well as literal duplicates.
function fields(tokens,names){
 check(tokens[0]==='{'&&tokens.at(-1)==='}');const result=new Map();let at=1;
 const stringEnd=start=>{let escaped=false;for(let i=start+1;i<tokens.length;i++){
  if(escaped)escaped=false;else if(tokens[i]==='\\')escaped=true;else if(tokens[i]==='"')return i+1;
 }check(false);};
 while(at<tokens.length-1){
  check(tokens[at]==='"');const keyEnd=stringEnd(at),key=JSON.parse(tokens.slice(at,keyEnd));
  check(names.includes(key)&&!result.has(key)&&tokens[keyEnd]===':');at=keyEnd+1;const start=at;
  if(tokens[at]==='"')at=stringEnd(at);
  else if(tokens[at]==='{'||tokens[at]==='['){
   let depth=0,quoted=false,escaped=false;
   for(;at<tokens.length;at++){const c=tokens[at];if(quoted){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;}
    else if(c==='"')quoted=true;else if(c==='{'||c==='[')depth++;else if(c==='}'||c===']'){if(--depth===0){at++;break;}}}
  }else while(at<tokens.length&&!(',}').includes(tokens[at]))at++;
  check(at>start);result.set(key,tokens.slice(start,at));
  if(tokens[at]==='}')break;check(tokens[at]===',');at++;
 }
 check(result.size===names.length&&at===tokens.length-1);return result;
}
function sourceMetadata(source){
 check(source&&typeof source==='object'&&!Array.isArray(source)&&Object.keys(source).length===3
  &&['path','sha256','size'].every(k=>Object.hasOwn(source,k)));
 check(typeof source.path==='string'&&source.path.length>0&&source.path.length<=1024&&source.path.normalize('NFC')===source.path
  &&!/[\\:\x00-\x1f\x7f-\x9f]/.test(source.path)&&source.path.split('/').every(s=>s&&s!=='.'&&s!=='..'));
 check(typeof source.sha256==='string'&&/^[a-f0-9]{64}$/.test(source.sha256));
 check(Number.isSafeInteger(source.size)&&source.size>0&&source.size<=TOTAL);return source;
}
export function validateLosslessJsonEvidence(bytes){
 try{
  check(Buffer.isBuffer(bytes)&&bytes.length>0&&bytes.length<=FILE);
  const tokens=jsonTokens(utf8(bytes)),top=fields(tokens,['kind','version','source','originalGzipBase64','data']);
  check(top.get('kind')==='"cm-lossless-json-evidence"'&&top.get('version')==='1');
  const sourceFields=fields(top.get('source'),['path','sha256','size']);
  const source=sourceMetadata(Object.fromEntries([...sourceFields].map(([k,v])=>[k,JSON.parse(v)])));
  const base64=JSON.parse(top.get('originalGzipBase64'));check(typeof base64==='string'&&base64.length<=2*FILE);
  const compressed=Buffer.from(base64,'base64');check(compressed.toString('base64')===base64);
  const original=gunzipSync(compressed,{maxOutputLength:source.size});
  check(original.length===source.size&&sha(original)===source.sha256&&jsonTokens(utf8(original))===top.get('data'));
  return Object.freeze({originalSize:source.size,source:Object.freeze(source)});
 }catch{need(false,'lossless_json_evidence_invalid');}
}
export function createNativeJsonCarrier(bytes,sourcePath){
 check(Buffer.isBuffer(bytes)&&bytes.length>0&&bytes.length<=TOTAL);
 const source=sourceMetadata({path:sourcePath,sha256:sha(bytes),size:bytes.length});
 const data=jsonTokens(utf8(bytes)),originalGzipBase64=gzipSync(bytes).toString('base64');
 // data is the original token string, not JSON.stringify(JSON.parse(data)).
 const prefix=JSON.stringify({kind:'cm-lossless-json-evidence',version:1,source,originalGzipBase64});
 const carrier=Buffer.from(prefix.slice(0,-1)+',"data":'+data+'}');
 validateLosslessJsonEvidence(carrier);return carrier;
}
