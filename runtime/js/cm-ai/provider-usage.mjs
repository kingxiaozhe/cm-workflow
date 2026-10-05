import {types} from 'node:util';
// Accept only actual CLI terminal usage, never answer text, estimates or heartbeats.
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const count=value=>Number.isSafeInteger(value)&&value>=0;
export function readProviderUsage(provider,raw){
  if(!record(raw)||!count(raw.input_tokens)||!count(raw.output_tokens))return {usage_state:'unavailable'};
  const result={usage_state:'observed',input_tokens:raw.input_tokens,output_tokens:raw.output_tokens};
  const fields=provider==='codex'?{cached_input_tokens:'cache_read_tokens',cache_write_input_tokens:'cache_write_tokens',reasoning_output_tokens:'reasoning_tokens'}:
    provider==='claude'?{cache_read_input_tokens:'cache_read_tokens',cache_creation_input_tokens:'cache_write_tokens'}:null;
  if(fields===null)return {usage_state:'unavailable'};
  for(const [source,target] of Object.entries(fields))if(Object.hasOwn(raw,source)){
    if(!count(raw[source]))return {usage_state:'unavailable'};result[target]=raw[source];
  }
  if(record(raw.output_tokens_details)&&Object.hasOwn(raw.output_tokens_details,'reasoning_tokens')){
    const reasoning=raw.output_tokens_details.reasoning_tokens;
    if(!count(reasoning)||reasoning>raw.output_tokens)return {usage_state:'unavailable'};
    if(Object.hasOwn(result,'reasoning_tokens')&&result.reasoning_tokens!==reasoning)return {usage_state:'unavailable'};
    result.reasoning_tokens=reasoning; // A subset annotation: NEVER added to output_tokens.
  }
  if(provider==='codex'&&result.cache_read_tokens>result.input_tokens)return {usage_state:'unavailable'};
  if(result.reasoning_tokens>result.output_tokens)return {usage_state:'unavailable'};
  return result;
}
export function createProviderUsageCapture(provider,onUsage){
  let value=null,conflict=false,completed=false;
  return {
    terminal(usage){
      const next=readProviderUsage(provider,usage);
      if(value!==null&&JSON.stringify(value)!==JSON.stringify(next))conflict=true;
      value??=next;
    },
    complete(){
      if(completed)return;completed=true;
      try{const returned=onUsage?.(conflict?{usage_state:'unavailable'}:value??{usage_state:'unavailable'});
        if(types.isPromise(returned))Promise.prototype.then.call(returned,()=>{},()=>{});
      }catch{/* accounting cannot retry or decide execution */}
    },
  };
}
