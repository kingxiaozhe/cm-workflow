// Provider text is untrusted. Persist fixed classifications and fingerprints,
// never arbitrary provider messages, headers, prompts or stderr.
import {createHash} from 'node:crypto';
import {json,need,shape,hex} from './effect-contract.mjs';

const CODES=Object.freeze({
  context_length_exceeded:'context_limit',request_too_large:'input_limit',
  rate_limit_exceeded:'rate_limit',insufficient_quota:'quota',usage_limit_reached:'quota',
  billing_hard_limit_reached:'quota',invalid_api_key:'authentication',
  authentication_required:'authentication',unauthorized:'authentication',
  model_not_found:'model_unavailable',invalid_image:'image_load_failed',
  image_load_failed:'image_load_failed',unsupported_image:'image_load_failed',
  invalid_json_schema:'schema_invalid',invalid_argument:'invalid_argument',
  invalid_request_error:'invalid_request',server_error:'server',internal_server_error:'server',
});
const STATUS=[400,401,403,408,413,422,429,500,502,503,504];
const SOURCES=['stdout_error','stdout_turn_failed','stderr'];
const CATEGORIES=['unknown','conflict','http_status',...new Set(Object.values(CODES))];
const sha=value=>createHash('sha256').update(value).digest('hex');

export function providerFailureDiagnostic(raw,source){
  need(SOURCES.includes(source),'provider_diagnostic_invalid');
  const value=raw&&typeof raw==='object'&&!Array.isArray(raw)?raw:{};
  const error=value.error&&typeof value.error==='object'&&!Array.isArray(value.error)?value.error:{};
  const message=typeof error.message==='string'?error.message:typeof value.message==='string'?value.message:
    typeof value.error==='string'?value.error:typeof raw==='string'?raw:null;
  const bytes=message===null?null:Buffer.from(message,'utf8');
  const rawCode=typeof error.code==='string'?error.code:value.code;
  let code=typeof rawCode==='string'&&Object.hasOwn(CODES,rawCode)?rawCode:null;
  if(code===null&&bytes!==null&&bytes.length<=4096){
    const fixed=message.trim().toLowerCase().replace(/^error: /,'');
    if(Object.hasOwn(CODES,fixed))code=fixed;
    if(fixed==='failed to load image')code='image_load_failed';
  }
  const status=error.status??value.status;
  let httpStatus=STATUS.includes(status)?status:null;
  if(httpStatus===null&&source==='stderr'&&bytes!==null&&bytes.length<=4096){
    const match=/^error: http (400|401|403|408|413|422|429|500|502|503|504)$/.exec(message.trim().toLowerCase());
    if(match)httpStatus=Number(match[1]);
  }
  return readProviderFailureDiagnostic({version:1,source,category:code?CODES[code]:httpStatus?'http_status':'unknown',
    code,httpStatus,messageBytes:bytes?.length??0,messageSha256:bytes===null?null:sha(bytes)});
}

export function readProviderFailureDiagnostic(raw){
  const d=json(raw,1024);shape(d,['version','source','category','code','httpStatus','messageBytes','messageSha256']);
  need(d.version===1&&SOURCES.includes(d.source)&&CATEGORIES.includes(d.category),'provider_diagnostic_invalid');
  need(d.code===null||Object.hasOwn(CODES,d.code),'provider_diagnostic_invalid');
  need(d.httpStatus===null||STATUS.includes(d.httpStatus),'provider_diagnostic_invalid');
  need(Number.isSafeInteger(d.messageBytes)&&d.messageBytes>=0,'provider_diagnostic_invalid');
  if(d.messageSha256===null)need(d.messageBytes===0,'provider_diagnostic_invalid');else hex(d.messageSha256);
  need(d.category===(d.code?CODES[d.code]:d.category==='conflict'?'conflict':d.httpStatus?'http_status':'unknown'),
    'provider_diagnostic_invalid');
  if(d.category==='conflict')need(d.code===null&&d.httpStatus===null,'provider_diagnostic_invalid');
  return d;
}

// Called on no more than two stdout terminal dialects. Unknown never erases a
// known classification; disagreeing known codes/statuses become conflict.
export function mergeProviderFailureDiagnostics(first,second){
  if(!first)return readProviderFailureDiagnostic(second);
  const a=readProviderFailureDiagnostic(first),b=readProviderFailureDiagnostic(second);
  if(a.category==='conflict'||b.category==='conflict')return {...b,category:'conflict',code:null,httpStatus:null};
  if(a.category==='unknown')return b;
  if(b.category==='unknown')return a;
  if(a.code===b.code&&a.httpStatus===b.httpStatus)return b;
  return {...b,category:'conflict',code:null,httpStatus:null};
}
