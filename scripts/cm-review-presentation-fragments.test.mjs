import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {compactReviewData,expandReviewData,jsonTokens} from '../runtime/js/cm-ai/review-presentation.mjs';
import {createNativeJsonCarrier,validateLosslessJsonEvidence} from '../runtime/js/cm-ai/native-json-carrier.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
const row=bytes=>({mediaType:'application/json',size:bytes.length,sha256:sha(bytes),contentBase64:bytes.toString('base64')});
const lexeme='{"same":900719925474099312345,"same":-0,"exponent":1e+300,"escape":"a\\u0062  \\n","padding":"'+('text '.repeat(100))+'"}';
const make=()=>{
 const before=Buffer.from(' { "rows": [\n'+Array(50).fill(lexeme).join(',\n')+'] }\n');
 const after=Buffer.from(' { "rows": [\n'+Array(49).fill(lexeme).join(',\n')+'],"more":true }\n');
 return {reviewPackage:{packageDigest:'a'.repeat(64),files:[row(before),row(after)]},priorReview:null};
};
test('inline JSON fragment view preserves every original byte and lexical token with shared complete subtrees',()=>{
 const raw=make();raw.reviewPackage.empty={size:0,sha256:sha(Buffer.alloc(0)),contentBase64:''};
 const snapshot=JSON.stringify(raw),shown=compactReviewData(raw);
 assert.equal(shown.presentation.version,3);assert(Object.keys(shown.jsonFragments).length>0);
 const text=Object.values(shown.jsonFragments).join('');
 for(const lex of ['900719925474099312345','"same":-0','1e+300','\\u0062','  '])assert(text.includes(lex));
 assert.deepEqual(expandReviewData(shown),raw);assert.equal(JSON.stringify(raw),snapshot);
 assert(Buffer.byteLength(JSON.stringify(shown))<Buffer.byteLength(JSON.stringify(raw)));
 assert(Object.values(shown.jsonFragments).every(s=>jsonTokens(s)===s));
});
test('fragment view rejects unknown refs, duplicate definitions, unsafe keys, schema drift and wrong original evidence',()=>{
 const shown=compactReviewData(make()),key=Object.keys(shown.jsonFragments)[0];
 const mutations=[
  s=>{s.jsonFragments['f99999']=s.jsonFragments[key];},
  s=>{s.jsonFragments['f99999']='{"unused":true}';},
  s=>{Object.values(s.contents).find(c=>c.encoding==='json-fragment-view').parts=[{jsonFragmentRef:'absent'}];},
  s=>{Object.values(s.contents).find(c=>c.encoding==='json-fragment-view').parts=[{jsonFragmentRef:'__proto__'}];},
  s=>{Object.values(s.contents).find(c=>c.encoding==='json-fragment-view').parts=[{jsonFragmentRef:key,extra:true}];},
  s=>{Object.values(s.contents).find(c=>c.encoding==='json-fragment-view').size=1024*1024+1;},
  s=>{Object.values(s.contents).find(c=>c.encoding==='json-fragment-view').sha256='0'.repeat(64);},
  s=>{Object.values(s.contents).find(c=>c.encoding==='json-fragment-view').originalGzipBase64+='!';},
  s=>{Object.values(s.contents).find(c=>c.encoding==='json-fragment-view').originalGzipBase64=gzipSync(Buffer.alloc(2*1024*1024,32)).toString('base64');},
  s=>{s.jsonFragments[key]=s.jsonFragments[key].replace('900719925474099312345','900719925474099312344');},
  s=>{s.jsonFragments[key]={jsonFragmentRef:key};},
  s=>{s.presentation.version=2;},
  s=>{s.presentation.packageDigest='b'.repeat(64);},
  s=>{s.contents=JSON.parse('{"__proto__":{}}');},
  s=>{s.contents['content-99999']={...Object.values(s.contents)[0]};},
  s=>{Object.values(s.contents)[0].hidden=true;},
  s=>{s.reviewPackage.files[0].contentBase64='AA==';},
 ];
 for(const mutate of mutations){const bad=structuredClone(shown);mutate(bad);assert.throws(()=>expandReviewData(bad));}
 const cycle=structuredClone(shown);cycle.jsonFragments[key]=cycle;assert.throws(()=>expandReviewData(cycle));
});
test('old v1/v2 remain byte-exact and malformed JSON cannot be a token or fragment view',()=>{
 const one={reviewPackage:{packageDigest:'0'.repeat(64),file:row(Buffer.from('plain text'))}};
 assert.throws(()=>compactReviewData(one),'typed malformed JSON still fails');
 const legacy={reviewPackage:{packageDigest:'0'.repeat(64),file:{contentBase64:Buffer.from('plain text').toString('base64')}}};
 const v1=compactReviewData(legacy);assert.equal(v1.presentation.version,1);assert.deepEqual(expandReviewData(v1),legacy);
 const bytes=Buffer.from('{\n"n":9007199254740993,\n"rows":[\n'+Array(500).fill('  1').join(',\n')+'\n]}');
 const raw={reviewPackage:{packageDigest:'0'.repeat(64),file:row(bytes)}};const v2=compactReviewData(raw);
 assert.equal(v2.presentation.version,2);assert.deepEqual(expandReviewData(v2),raw);
});
test('derived JSON carrier preserves duplicate keys, numbers, whitespace and provenance without source access',()=>{
 const bytes=Buffer.from(' { "rows": [\n'+Array(100).fill(lexeme).join(',\n')+'] }\n');
 const carrier=createNativeJsonCarrier(bytes,'does-not-exist/original.json');
 const result=validateLosslessJsonEvidence(carrier);assert.equal(result.originalSize,bytes.length);
 assert.deepEqual(result.source,{path:'does-not-exist/original.json',sha256:sha(bytes),size:bytes.length});
 assert(carrier.toString('utf8').includes('"data":'+jsonTokens(bytes.toString('utf8'))));
 assert(carrier.length<=1024*1024);
});
test('carrier refuses hidden duplicates, malformed data, source mismatch, over-limit bytes and gzip bombs',()=>{
 const original=Buffer.from(' { "same": 900719925474099312345, "same": -0 }\n');
 const carrier=createNativeJsonCarrier(original,'original.json'),text=carrier.toString('utf8');
 const parsed=JSON.parse(text);
 const bad=[
  text.replace('"version":1','"version":1,"version":1'),
  text.replace('"version":1','"version":1,"\\u0076ersion":1'),
  text.replace('"source":{','"source":{"path":"wrong",'),
  text.replace('900719925474099312345','900719925474099312344'),
  text.replace('"same":-0','"same":0'),
  JSON.stringify({...parsed,source:{...parsed.source,sha256:'0'.repeat(64)}}),
  JSON.stringify({...parsed,source:{...parsed.source,size:4*1024*1024+1}}),
  JSON.stringify({...parsed,source:{...parsed.source,path:'../bad.json'}}),
  JSON.stringify({...parsed,originalGzipBase64:parsed.originalGzipBase64+'!'}),
  JSON.stringify({...parsed,originalGzipBase64:gzipSync(Buffer.alloc(4*1024*1024+1,32)).toString('base64')}),
  text.replace('"data":','"__proto__":{},"data":'),
 ];
 for(const value of bad)assert.throws(()=>validateLosslessJsonEvidence(Buffer.from(value)),/lossless_json_evidence_invalid/);
 assert.throws(()=>validateLosslessJsonEvidence(Buffer.alloc(1024*1024+1,32)));
 assert.throws(()=>createNativeJsonCarrier(Buffer.alloc(4*1024*1024+1,32),'bad.json'));
});
