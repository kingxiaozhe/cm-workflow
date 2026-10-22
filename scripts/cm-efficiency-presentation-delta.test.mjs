import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {compactReviewData,expandReviewData} from '../runtime/js/cm-ai/review-presentation.mjs';
import {compactReviewDataV2,expandReviewDataV2} from '../runtime/js/cm-ai/review-presentation-delta.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
import {buildReviewPrompt} from '../runtime/js/cm-ai/codex-review-adapter.mjs';
import {EXECUTION_POLICY_V1,EXECUTION_POLICY_V2,readExecutionPolicy,readLaunchExecutionPolicy,readFixExecutionPolicy} from '../runtime/js/cm-ai/execution-policy.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const byteSize=value=>Buffer.byteLength(JSON.stringify(value));
const clone=value=>structuredClone(value);
const file=(path,bytes)=>({path,type:'file',mode:420,size:bytes.length,sha256:sha(bytes),contentBase64:bytes.toString('base64')});
const change=(path,before,after)=>({path,before:before===null?null:file(path,before),after:after===null?null:file(path,after)});
const lines=count=>Array.from({length:count},(_,i)=>'line '+String(i).padStart(5,'0')+' carries complete unchanged review evidence.\n');
function pair(){
  const before=lines(240),after=[...before];
  after[7]='First explicit change with 中文 and 😀.\n';
  after[85]='Second separated change preserves all other code.\n';
  after[179]='Third separated change is complete evidence.\n';
  return [Buffer.from(before.join('')),Buffer.from(after.join(''))];
}
const dataFor=changes=>({reviewPackage:{packageDigest:'a'.repeat(64),changes,
  specification:{acceptanceCriteria:['AC-001'],interfaceContracts:['GET /fixture'],systemContext:'Complete context'},
  checks:[{id:'unit',command:['fixture'],outcome:'passed',exitCode:0,evidence:'Synthetic evidence'}]},
  priorReview:{verdict:'changes_requested',findings:[{path:'source.mjs',message:'Original finding'}]},examinedPaths:changes.map(item=>item.path)});
function reviewRequest(provider='claude',{binary=false}={}){
  let [before,after]=pair();
  if(binary){before=Buffer.from(Array.from({length:16384},(_,i)=>i%256));after=Buffer.from(before);after[8192]=255;}
  const changes=[change('source.mjs',before,after)];
  const requirements=[file('requirements.md',Buffer.from('AC-001: preserve exact evidence.\n'))];
  const checks=[{id:'unit',command:['fixture'],outcome:'passed',exitCode:0,evidence:'Synthetic evidence'}];
  const identity={repositoryId:'fixture',runId:'presentation-delta',taskId:'T-001',attempt:1};
  const pkg={version:1,kind:'cm-review-package',identity,rootDigest:'b'.repeat(64),baseIdentity:'c'.repeat(64),
    scope:['source.mjs'],changes,requirements,checks,artifactDigest:digest(changes),
    requirementsDigest:digest(requirements),checksDigest:digest(checks)};
  pkg.packageDigest=digest(pkg);
  const request={version:1,invocationId:'review-delta',identity,role:'reviewer',provider,
    requestedModel:'fixture-model',contextId:'fresh-review',payload:{reviewPackage:pkg,priorReview:null}};
  request.requestDigest=digest(request);return request;
}
const deltaEntry=presented=>Object.values(presented.contents).find(item=>item.encoding==='delta-v2');
const bad=value=>assert.throws(()=>expandReviewDataV2(value),error=>['invalid_input','limit_exceeded','review_presentation_delta_invalid'].includes(error.code));
const mutate=(presented,edit)=>{const copy=clone(presented);edit(copy);bad(copy);};
const splitPrompt=prompt=>JSON.parse(prompt.split('\n<cm-review-data-json>\n')[1]);

test('V2 reconstructs exact Unicode, CRLF, BOM, binary, empty and partial-byte boundary evidence',()=>{
  const prefix=Buffer.from('complete unchanged evidence\r\n'.repeat(80));
  const cases=[
    [Buffer.concat([prefix,Buffer.from('😀尾')]),Buffer.concat([prefix,Buffer.from('😁尾')])],
    [Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),prefix,Buffer.from('old')]),Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),prefix,Buffer.from('new')])],
    [Buffer.concat([prefix,Buffer.from([255,128,0,17])]),Buffer.concat([prefix,Buffer.from([255,129,0,17])])],
    [Buffer.from('old'),Buffer.alloc(0)],[Buffer.alloc(0),Buffer.from('new')],
    [prefix,Buffer.concat([prefix,Buffer.from('tail without LF')])],
    [prefix,Buffer.concat([Buffer.from('head without LF'),prefix])]
  ];
  const original=dataFor(cases.map(([before,after],i)=>change('file-'+i,before,after)));
  original.reviewPackage.handoff=file('handoff.json',Buffer.from('{"complete":"所有材料"}\n'));
  const bytes=JSON.stringify(original),presented=compactReviewDataV2(original);
  assert.deepEqual(expandReviewDataV2(presented),original);assert.equal(JSON.stringify(original),bytes);
  assert.equal(presented.presentation.logicalDigest,digest(original));
  assert.equal(presented.presentation.logicalBytes,Buffer.byteLength(bytes));
  assert.deepEqual(compactReviewDataV2(original),presented);
  assert(Object.values(presented.contents).some(item=>item.encoding==='base64'));
  assert(Object.values(presented.contents).some(item=>item.parts?.some(part=>part.insert?.encoding==='base64')));
});

test('multiple separated edits retain the whole source and materially shrink the inline representation',()=>{
  const [before,after]=pair(),original=dataFor([change('source.mjs',before,after)]);
  const v1=compactReviewData(original),v2=compactReviewDataV2(original),entry=deltaEntry(v2);
  assert(entry.parts.length>3);assert(byteSize(v2)<byteSize(v1)*0.65);
  assert.deepEqual(expandReviewDataV2(v2),original);
  assert.deepEqual(expandReviewData(v1),original);
  assert.deepEqual(v2.contents[entry.baseRef],v1.contents[entry.baseRef]);
  assert.equal(entry.sha256,sha(after));assert.equal(entry.size,after.length);
});

test('only a prior full before entry for the same path can be a base and delta chains are never emitted',()=>{
  const [before,after]=pair(),next=Buffer.concat([after,Buffer.from('third revision\n')]);
  const original=dataFor([change('a',before,after),change('b',after,next),
    change('deleted',before,null),change('new',null,Buffer.concat([before,Buffer.from('added\n')]))]);
  const presented=compactReviewDataV2(original);
  assert.equal(Object.values(presented.contents).filter(item=>item.encoding==='delta-v2').length,1);
  for(const entry of Object.values(presented.contents))if(entry.encoding==='delta-v2')assert.notEqual(presented.contents[entry.baseRef].encoding,'delta-v2');
  assert.deepEqual(expandReviewDataV2(presented),original);
  const reversed=dataFor([{path:'reverse',after:file('reverse',after),before:file('reverse',before)}]);
  assert.equal(Object.values(compactReviewDataV2(reversed).contents).some(item=>item.encoding==='delta-v2'),false);
});

test('V2 rejects changed metadata, malformed full content, dangling references and hidden unused evidence',()=>{
  const presented=compactReviewDataV2(dataFor([change('source.mjs',...pair())]));
  for(const edit of [
    v=>v.presentation.version=1,v=>v.presentation.kind='other',v=>v.presentation.packageDigest='b'.repeat(64),
    v=>v.presentation.logicalDigest='b'.repeat(64),v=>v.presentation.logicalBytes++,
    v=>v.presentation.extra=true,v=>v.contents['content-1']=null,
    v=>v.contents['content-1'].content+='changed',v=>v.contents['content-1'].encoding='unknown',
    v=>v.contents['content-1'].content='\ud800',v=>v.contents['content-1'].size++,
    v=>v.contents['content-1'].sha256='b'.repeat(64),
    v=>v.reviewPackage.changes[0].before.contentRef='missing',
    v=>v.reviewPackage.changes[0].before.contentBase64='',
    v=>v.reviewPackage.changes[0].before.size++,
    v=>v.reviewPackage.changes[0].after.sha256='b'.repeat(64),
    v=>v.contents['content-3']=clone(v.contents['content-1'])
  ])mutate(presented,edit);
  mutate(presented,v=>{const entry=v.contents['content-1'];entry.content=Buffer.from(entry.content).toString('base64')+'!';entry.encoding='base64';});
});

test('V2 rejects forward, self, chained and cross-path base references even with a valid logical digest',()=>{
  const [before,after]=pair(),original=dataFor([change('source.mjs',before,after),change('other',after,Buffer.concat([after,Buffer.from('next\n')]))]);
  const presented=compactReviewDataV2(original);
  for(const baseRef of ['missing','content-2','content-3','__proto__'])mutate(presented,v=>deltaEntry(v).baseRef=baseRef);
  mutate(presented,v=>v.reviewPackage.changes[0].before.path='different-path');
  mutate(presented,v=>{const entry=v.contents['content-3'];v.contents['content-3']={sha256:entry.sha256,size:entry.size,
    encoding:'delta-v2',baseRef:'content-2',parts:[{copy:{offset:0,size:after.length}},{insert:{encoding:'utf8',content:'next\n'}}]};});
});

test('V2 rejects nonintegral, overlapping, out-of-range and corrupted recipes without accepting partial bytes',()=>{
  const presented=compactReviewDataV2(dataFor([change('source.mjs',...pair())]));
  for(const edit of [
    e=>e.parts=[],e=>e.parts=[null],e=>e.parts[0].copy.offset=-1,e=>e.parts[0].copy.offset=0.5,
    e=>e.parts[0].copy.offset=Number.MAX_SAFE_INTEGER+1,e=>e.parts[0].copy.size=0,
    e=>e.parts[0].copy.size=NaN,e=>e.parts[0].copy.size=1e9,e=>e.parts[0].extra=true,
    e=>e.parts.find(p=>p.insert).insert.content+='corrupt',
    e=>e.parts.find(p=>p.insert).insert={encoding:'utf8',content:''},
    e=>e.parts.find(p=>p.insert).insert={encoding:'base64',content:'YQ=='},
    e=>e.parts.filter(p=>p.copy)[1].copy.offset=0,
    e=>e.sha256='b'.repeat(64),e=>e.size++,e=>e.parts[0].copy.offset++
  ])mutate(presented,v=>edit(deltaEntry(v)));
});

test('V2 enforces entry and total part budgets and fragmented generation falls back to complete evidence',()=>{
  const presented=compactReviewDataV2(dataFor([change('source.mjs',...pair())]));
  mutate(presented,v=>deltaEntry(v).parts=Array.from({length:1025},(_,i)=>({copy:{offset:i,size:1}})));
  const changes=Array.from({length:5},(_,i)=>{
    const before=Buffer.from('x'.repeat(1100)+i),after=Buffer.from('x'.repeat(1023)+i);
    return change('budget-'+i,before,after);
  });
  const many=compactReviewDataV2(dataFor(changes));
  for(const item of many.reviewPackage.changes){
    const entry=many.contents[item.after.contentRef];
    entry.encoding='delta-v2';entry.baseRef=item.before.contentRef;delete entry.content;
    entry.parts=[...Array.from({length:1023},(_,i)=>({copy:{offset:i,size:1}})),{insert:{encoding:'utf8',content:item.path.at(-1)}}];
  }
  bad(many);
  const before=lines(1500),after=before.map((line,i)=>i%2?line:'changed '+line);
  after[0]='changed-first\n';after[after.length-1]='changed-last\n';
  const original=dataFor([change('fragmented',Buffer.from(before.join('')),Buffer.from(after.join('')))]);
  const generated=compactReviewDataV2(original);
  assert.equal(Object.values(generated.contents).some(item=>item.encoding==='delta-v2'),false);
  assert.deepEqual(expandReviewDataV2(generated),original);
});

test('V2 bounds source, physical input, reconstructed data and repeated-reference amplification',()=>{
  const original=dataFor([change('source',null,Buffer.from('x'.repeat(1024*1024)))]);
  const presented=compactReviewDataV2(original);
  const oversized=clone(presented);oversized.padding='x'.repeat(11*1024*1024);bad(oversized);
  mutate(presented,v=>v.presentation.logicalBytes=10*1024*1024+1);
  mutate(presented,v=>v.contents['content-1'].size=10*1024*1024+1);
  mutate(presented,v=>{v.amplification=Array.from({length:9},()=>({contentRef:'content-1'}));v.presentation.logicalBytes=10*1024*1024;});
  assert.throws(()=>compactReviewDataV2({...original,padding:'x'.repeat(10*1024*1024)}),{code:'limit_exceeded'});
  const cyclic={...original};cyclic.cycle=cyclic;
  assert.throws(()=>compactReviewDataV2(cyclic),{code:'invalid_input'});
  const cycle=clone(presented);cycle.cycle=cycle;bad(cycle);
  const withGetter={...original};Object.defineProperty(withGetter,'getter',{enumerable:true,get(){throw new Error('must not run');}});
  assert.throws(()=>compactReviewDataV2(withGetter),{code:'invalid_input'});
});

test('the line budget keeps complete fallback and duplicate lines do not create ambiguous recipes',()=>{
  for(const [before,after] of [
    [Buffer.from('repeat\n'.repeat(65537)),Buffer.from('repeat\n'.repeat(65537)+'tail')],
    [Buffer.from('same unchanged long repeated line evidence\n'.repeat(1000)),Buffer.from('head\n'+'same unchanged long repeated line evidence\n'.repeat(1000))]
  ]){
    const original=dataFor([change('lines',before,after)]),presented=compactReviewDataV2(original);
    assert.deepEqual(expandReviewDataV2(presented),original);
    for(const entry of Object.values(presented.contents))if(entry.parts)assert(entry.parts.length<=1024);
  }
});

test('V2 is an explicit policy while create defaults and existing V1 values remain unchanged',()=>{
  assert.deepEqual(readExecutionPolicy(EXECUTION_POLICY_V1),EXECUTION_POLICY_V1);
  assert.deepEqual(readExecutionPolicy(EXECUTION_POLICY_V2),EXECUTION_POLICY_V2);
  assert.equal(readLaunchExecutionPolicy({mode:'create',definition:{}}),null);
  assert.deepEqual(readLaunchExecutionPolicy({mode:'create',definition:{},enabled:true}),EXECUTION_POLICY_V1);
  assert.equal(readFixExecutionPolicy({mode:'create',config:{}}),null);
  assert.deepEqual(readFixExecutionPolicy({mode:'create',config:{},enabled:true}),EXECUTION_POLICY_V1);
  for(const value of [{...EXECUTION_POLICY_V1,version:2},{...EXECUTION_POLICY_V2,version:1},
    {...EXECUTION_POLICY_V2,usage:'other'},{...EXECUTION_POLICY_V2,extra:true}])assert.throws(()=>readExecutionPolicy(value),{code:'execution_policy_invalid'});
});

test('default and V1 prompts match the frozen pre-V2 bytes for both existing adapter variants',()=>{
  // The source and transport candidate had different pre-existing unchangedScope
  // wording. These exact hashes came from each adapter before this change.
  const expected={full:new Set(['0225b45e3b444006158a57ea88d73ea524d2081bf56388ae956757666f0c7b3e','4d05a234f3152d085548f2c8edcffcb8fff2aab740229619f180b264a18736a6']),
    v1:new Set(['a8b531f73aed71d7112318d368f8023ea16165b60fefc0c8d5049fb20b88fab5','bbb93fe8bc37fb5bcc3742a8e16f523545f61b81b75add46652ca64a07eb0feb'])};
  for(const provider of ['claude','codex']){
    const request=reviewRequest(provider),full=buildReviewPrompt(request,provider);
    assert.equal(full,buildReviewPrompt(request,provider,null));
    assert(expected.full.has(sha(full)));
    const v1=buildReviewPrompt(request,provider,EXECUTION_POLICY_V1);
    assert(expected.v1.has(sha(v1)));assert.equal(splitPrompt(v1).presentation.version,1);
  }
});

test('explicit V2 prompts contain complete reversible data and preserve request and package digests',()=>{
  for(const provider of ['claude','codex'])for(const binary of [false,true]){
    const request=reviewRequest(provider,{binary}),before=JSON.stringify(request),v1=buildReviewPrompt(request,provider,EXECUTION_POLICY_V1);
    const prompt=buildReviewPrompt(request,provider,EXECUTION_POLICY_V2),presented=splitPrompt(prompt);
    assert.equal(presented.presentation.version,2);assert(Buffer.byteLength(prompt)<Buffer.byteLength(v1));
    assert.deepEqual(expandReviewDataV2(presented),{reviewPackage:request.payload.reviewPackage,priorReview:null,examinedPaths:['requirements.md','source.mjs']});
    if(binary)assert.equal(v1,buildReviewPrompt(request,provider));
    assert.equal(JSON.stringify(request),before);assert.equal(presented.presentation.packageDigest,request.payload.reviewPackage.packageDigest);
    assert(prompt.includes('Byte offsets are not character offsets'));
    assert.equal(prompt.split('No tools or follow-up fetches.').length,2);
  }
});
