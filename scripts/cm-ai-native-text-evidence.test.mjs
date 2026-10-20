import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {inspectNativeTextEvidence,captureNativeTextEvidence,validateNativeTextEvidence,nativeTextEvidencePresentation} from '../runtime/js/cm-ai/native-text-evidence.mjs';
import {captureNativeReviewEvidence,inspectNativeReviewReadiness,validateNativeEvidenceCheck} from '../runtime/js/cm-ai/native-review-evidence.mjs';
import {captureReviewBaseline,createReviewPackage,readReviewPackage} from '../runtime/js/cm-ai/review-package.mjs';
import {expandReviewData} from '../runtime/js/cm-ai/review-presentation.mjs';
import {requestFor,digest} from '../runtime/js/cm-ai/effect-contract.mjs';
import {buildReviewPrompt,prepareCodexReviewInput,inspectNativeTextReviewInput,createCodexReviewRun} from '../runtime/js/cm-ai/codex-review-adapter.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
const identity={repositoryId:'fixture',runId:'original',taskId:'T-004',attempt:2};
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
function setup(t){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-text-evidence-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const [codeProject,specsDir,sourceRoot,textRoot]=['code','specs','native','text'].map(n=>{const p=path.join(root,n);fs.mkdirSync(p);return p;});
 fs.writeFileSync(path.join(codeProject,'AGENTS.md'),'rules');fs.writeFileSync(path.join(codeProject,'target.js'),'before');
 fs.writeFileSync(path.join(codeProject,'requirement.md'),'Synthetic fixed requirement.');
 const baseline=captureReviewBaseline({root:codeProject,identity,scope:['AGENTS.md','target.js'],requirements:['requirement.md']});fs.writeFileSync(path.join(codeProject,'target.js'),'after');
 fs.writeFileSync(path.join(sourceRoot,'screen.png'),png);
 const files=[],add=(id,p,mediaType,body)=>{fs.writeFileSync(path.join(textRoot,p),body);const b=Buffer.from(body);files.push({id,path:p,mediaType,sha256:sha(b),size:b.length,description:'Synthetic complete method/data'});};
 add('data','data.json','application/json',JSON.stringify({corners:[1,2,3,4],unit:'image-pixel',limits:'not visual acceptance',body:'完整数据\\"\n'.repeat(30000)}));
 add('method','method.py','text/x-python','print("must never run")\n#'+'method'.repeat(140000));
 const text={version:1,sourceRoot:textRoot,files,requirements:[{id:'all-corners',fileId:'data',pointers:['/corners/3','/unit','/limits']},{id:'full-method',fileId:'method',pointers:[]}]};
 const manifest={version:2,report:'Synthetic provenance. Not visual approval.',sourceFiles:[{path:'target.js',sha256:sha('after')}],images:[{path:'screen.png',sha256:sha(png),size:png.length,description:'Synthetic PNG'}],textEvidence:text};
 const profile={version:1,sourceRoot,manifest:'native.json'},context={codeProject,specsDir,scope:['target.js'],identity};
 const write=()=>fs.writeFileSync(path.join(sourceRoot,'native.json'),JSON.stringify(manifest));write();
 const request=pkg=>requestFor({invocationId:'fixture-review',identity,role:'reviewer',provider:'codex',requestedModel:'fixture',contextId:'fresh',payload:{reviewPackage:pkg,priorReview:null}});
 return {root,codeProject,specsDir,sourceRoot,textRoot,text,manifest,profile,context,baseline,write,request};
}
test('one complete native text batch stays exact through archive, package, shared full prompt and existing material plan',async t=>{
 const f=setup(t);const ready=inspectNativeReviewReadiness(f.profile,f.context);assert.equal(ready.ready,true);assert.equal(fs.existsSync(path.join(f.specsDir,'.reviews')),false);
 const check=captureNativeReviewEvidence(f.profile,f.context),pkg=createReviewPackage({root:f.codeProject,baseline:f.baseline,checks:[check]});
 assert.deepEqual(readReviewPackage(pkg),pkg);assert.equal(pkg.checks[0].material.version,2);assert(Buffer.byteLength(JSON.stringify(pkg.checks))<65536);
 assert.equal(validateNativeEvidenceCheck(check,identity).materialDigest,digest(check.material));
 const request=f.request(pkg),prompt=buildReviewPrompt(request,'codex'),data=JSON.parse(prompt.split('<cm-review-data-json>\n')[1]);
 const shown=data.nativeTextEvidence[0];assert.equal(shown.files.length,2);
 const expanded=expandReviewData(data);
 for(const file of expanded.nativeTextEvidence[0].files){const b=Buffer.from(file.contentBase64,'base64');assert.equal(sha(b),file.sha256);assert(b.equals(fs.readFileSync(path.join(f.textRoot,file.path))));}
 assert.equal(JSON.parse(buildReviewPrompt({...request,provider:'claude',requestDigest:digest({...(({requestDigest,...body})=>body)(request),provider:'claude'})},'claude').split('<cm-review-data-json>\n')[1]).nativeTextEvidence[0].files.length,2);
 const preview=inspectNativeTextReviewInput(request,f.text,f.context);assert.equal(preview.transportReady,true);assert.equal(preview.notDispatchable,true);assert.equal(preview.visualAcceptance,'unknown');
 const prepared=prepareCodexReviewInput(request);assert(prepared.material);assert(prepared.material.manifest.pageCount<=256);
 let forwarded;await createCodexReviewRun(async x=>{forwarded=x;return {status:'succeeded'};})(request,{signal:new AbortController().signal,onEvent(){}});
 assert.equal(forwarded.prompt,prompt);assert.equal(forwarded.nativeReviewPackage.packageDigest,pkg.packageDigest);
 fs.rmSync(f.textRoot,{recursive:true});assert.deepEqual(readReviewPackage(pkg),pkg,'replay uses frozen archive, not vanished source');
 assert.equal(nativeTextEvidencePresentation(pkg)[0].files.length,2);
 const copied=structuredClone(check.material.textEvidence);copied.identity.runId='other';assert.throws(()=>validateNativeTextEvidence(copied,identity));
 const bad=structuredClone(pkg);bad.checks[0].material.textEvidence.files[0].sha256='0'.repeat(64);bad.checks[0].materialDigest=digest(bad.checks[0].material);bad.checksDigest=digest(bad.checks);const {packageDigest,...body}=bad;bad.packageDigest=digest(body);assert.throws(()=>readReviewPackage(bad));
 const m=check.material.textEvidence;fs.writeFileSync(path.join(m.storeRoot,m.files[0].contentBlob),'tampered');assert.throws(()=>buildReviewPrompt(request,'codex'));
});
test('readonly preflight lists independent file and pointer gaps at once, with no archive or code execution',t=>{
 const f=setup(t);fs.unlinkSync(path.join(f.textRoot,'method.py'));f.text.files[0].sha256='0'.repeat(64);
 f.text.files.push({id:'missing',path:'missing.json',mediaType:'application/json',sha256:'0'.repeat(64),size:1,description:'missing'});
 let result=inspectNativeTextEvidence(f.text,f.context);assert.equal(result.ready,false);assert(result.issues.length>=3);assert.equal(fs.existsSync(path.join(f.specsDir,'.reviews')),false);
 f.text.files[0].sha256=sha(fs.readFileSync(path.join(f.textRoot,'data.json')));f.text.requirements[0].pointers=['/absent-a','/absent-b'];
 result=inspectNativeTextEvidence(f.text,f.context);assert.equal(result.issues.filter(i=>i.code==='native_text_required_pointer_missing').length,2);
 assert.throws(()=>captureNativeTextEvidence(f.text,f.context));assert.equal(fs.existsSync(path.join(f.specsDir,'.reviews')),false);
 const manifestFile=path.join(f.root,'text.json');fs.writeFileSync(manifestFile,JSON.stringify(f.text));
 const cli=spawnSync(process.execPath,['scripts/cm-native-text-preflight.mjs','--manifest',manifestFile,'--code-project',f.codeProject,'--specs-dir',f.specsDir],{encoding:'utf8'});
 assert.equal(cli.status,2,cli.stderr);assert.equal(JSON.parse(cli.stdout).readOnly,true);assert.equal(fs.existsSync(path.join(f.specsDir,'.reviews')),false);
 f.write();fs.unlinkSync(path.join(f.sourceRoot,'screen.png'));fs.writeFileSync(path.join(f.codeProject,'target.js'),'drift');
 result=inspectNativeReviewReadiness(f.profile,f.context);assert(result.issues.some(i=>i.code==='native_evidence_source_changed'));assert(result.issues.some(i=>i.code==='native_evidence_image_missing_changed_or_invalid'));assert(result.issues.some(i=>i.code==='native_text_required_pointer_missing'));
});
test('source boundaries, exact types, identity and budgets fail closed; old v1 evidence stays unchanged',t=>{
 const f=setup(t);const inspect=()=>inspectNativeTextEvidence(f.text,f.context);
 f.text.files[1].path='../method.py';assert.equal(inspect().ready,false);f.text.files[1].path='method.py';
 const file=path.join(f.textRoot,'method.py');fs.unlinkSync(file);fs.symlinkSync(path.join(f.codeProject,'target.js'),file);assert.equal(inspect().ready,false);fs.unlinkSync(file);fs.writeFileSync(file,'print("must never run")\n');
 fs.linkSync(file,path.join(f.root,'hardlink'));assert.equal(inspect().ready,false);fs.unlinkSync(path.join(f.root,'hardlink'));
 f.text.files[1].size=1048577;assert.equal(inspect().ready,false);f.text.files[1].size=fs.statSync(file).size;
 f.text.files[1].mediaType='application/json';assert.equal(inspect().ready,false);f.text.files[1].mediaType='text/x-python';
 f.text.sourceRoot=f.codeProject;assert.equal(inspect().ready,false);f.text.sourceRoot=f.textRoot;
 const invalid=Buffer.from([0xff]);fs.writeFileSync(file,invalid);f.text.files[1].size=1;f.text.files[1].sha256=sha(invalid);assert.equal(inspect().ready,false);
 delete f.manifest.textEvidence;f.manifest.version=1;f.write();const old=captureNativeReviewEvidence(f.profile,f.context);assert.equal(old.material.version,1);assert(!Object.hasOwn(old.material,'textEvidence'));assert.deepEqual(validateNativeEvidenceCheck(old,identity),old);
 f.manifest.textEvidence={};f.write();assert.throws(()=>captureNativeReviewEvidence(f.profile,f.context),'v1 must not silently accept extensions');
});

test('interrupted same-byte publication recovers only on explicit capture; readonly validation never repairs',t=>{
 const f=setup(t),m=captureNativeTextEvidence(f.text,f.context),file=m.files[0],target=path.join(m.storeRoot,file.sha256);
 const stage=path.join(m.storeRoot,`stage-${file.sha256}-00000000-0000-4000-8000-000000000000`);
 fs.linkSync(target,stage);assert.throws(()=>validateNativeTextEvidence(m,identity));assert(fs.existsSync(stage));
 assert.deepEqual(captureNativeTextEvidence(f.text,f.context),m);assert.equal(fs.existsSync(stage),false);assert.equal(fs.statSync(target).nlink,1);
 fs.linkSync(target,stage);fs.unlinkSync(target);assert.deepEqual(captureNativeTextEvidence(f.text,f.context),m);assert(fs.existsSync(target));assert.equal(fs.existsSync(stage),false);
});

test('JSON token presentation keeps duplicate keys, numeric lexemes and string whitespace and expands exact bytes',async()=>{
 const {compactReviewData,expandReviewData}=await import('../runtime/js/cm-ai/review-presentation.mjs');
 const raw=' { \n  "n": 9007199254740993, "n": 1e+00, "spaced": "a  b\\n", "rows": [\n'+('    1,\n'.repeat(500))+'    2\n ] } ';
 const bytes=Buffer.from(raw),original={reviewPackage:{packageDigest:'0'.repeat(64)},nativeTextEvidence:[{files:[{id:'data',mediaType:'application/json',size:bytes.length,sha256:sha(bytes),contentBase64:bytes.toString('base64')}]}]};
 const compact=compactReviewData(original),view=Object.values(compact.contents)[0];assert.equal(view.encoding,'json-token-view');assert.equal(compact.presentation.version,2);
 const disguised=structuredClone(compact);disguised.presentation.version=1;assert.throws(()=>expandReviewData(disguised));
 const ordinary=compactReviewData({reviewPackage:{packageDigest:'0'.repeat(64)},file:{contentBase64:Buffer.from('ordinary source').toString('base64')}});assert.equal(ordinary.presentation.version,1);
 const broken=structuredClone(compact);Object.values(broken.contents)[0].originalGzipBase64='AA==';assert.throws(()=>expandReviewData(broken));
 assert.match(view.content,/9007199254740993,"n":1e\+00/);assert.match(view.content,/a  b/);assert.deepEqual(expandReviewData(compact),original);
 view.content=view.content.replace('9007199254740993','9007199254740992');assert.throws(()=>expandReviewData(compact));
});

test('JSON Pointer array references reject length, dash, leading zeros and out-of-range indices across readiness and archives',t=>{
 const f=setup(t),doc=path.join(f.textRoot,'data.json'),row=f.text.files[0];
 const write=value=>{const bytes=Buffer.from(JSON.stringify(value));fs.writeFileSync(doc,bytes);row.sha256=sha(bytes);row.size=bytes.length;};
 write({corners:[]});f.text.requirements[0].pointers=['/corners/length'];
 assert.equal(inspectNativeTextEvidence(f.text,f.context).ready,false);assert.throws(()=>captureNativeTextEvidence(f.text,f.context));
 const allowed=structuredClone(f.text);allowed.requirements[0].pointers=[];const archived=captureNativeTextEvidence(allowed,f.context),tampered=structuredClone(archived);
 tampered.requirements[0].pointers=['/corners/length'];assert.throws(()=>validateNativeTextEvidence(tampered,identity));
 write({corners:['one']});
 for(const pointer of ['/corners/length','/corners/01','/corners/-','/corners/1','/corners/9007199254740992']){
  f.text.requirements[0].pointers=[pointer];const result=inspectNativeTextEvidence(f.text,f.context);assert.equal(result.ready,false,pointer);
  assert(result.issues.some(i=>i.code==='native_text_required_pointer_missing'));
 }
 f.text.requirements[0].pointers=['/corners/0'];assert.equal(inspectNativeTextEvidence(f.text,f.context).ready,true);
 write({corners:{length:4}});f.text.requirements[0].pointers=['/corners/length'];assert.equal(inspectNativeTextEvidence(f.text,f.context).ready,true,'ordinary object field stays valid');
});

test('read-only native projection equals capture metadata and full text without creating archives',async t=>{
 const {projectNativeReviewEvidence}=await import('../runtime/js/cm-ai/native-review-evidence.mjs');const f=setup(t);
 const projected=projectNativeReviewEvidence(f.profile,f.context);assert.equal(fs.existsSync(path.join(f.specsDir,'.reviews')),false);
 const captured=captureNativeReviewEvidence(f.profile,f.context);assert.deepEqual(projected.check,captured);
 assert.deepEqual(projected.textPresentation,nativeTextEvidencePresentation({identity,checks:[captured]})[0]);
});

test('lossless carriers enforce original logical bytes in readiness, capture, cumulative archive and stored validation',async t=>{
 const {createNativeJsonCarrier}=await import('../runtime/js/cm-ai/native-json-carrier.mjs'),f=setup(t);
 const original=Buffer.from('{'+(' '.repeat(1600000))+'"value":1}');
 const files=Array.from({length:3},(_,i)=>{const bytes=createNativeJsonCarrier(original,`original-${i}.json`),p=`carrier-${i}.json`;assert(bytes.length<1024*1024);fs.writeFileSync(path.join(f.textRoot,p),bytes);return {id:`carrier-${i}`,path:p,mediaType:'application/x-cm-lossless-json-evidence',sha256:sha(bytes),size:bytes.length,description:'Exact derived carrier; original bytes retained in gzip'};});
 const request=rows=>({version:1,sourceRoot:f.textRoot,files:rows,requirements:rows.map(row=>({id:row.id+'-data',fileId:row.id,pointers:['/data/value']}))});
 const tooLarge=request(files);assert.equal(inspectNativeTextEvidence(tooLarge,f.context).ready,false);assert.throws(()=>captureNativeTextEvidence(tooLarge,f.context));assert.equal(fs.existsSync(path.join(f.specsDir,'.reviews')),false);
 const first=captureNativeTextEvidence(request([files[0]]),f.context),second=captureNativeTextEvidence(request([files[1]]),f.context);assert.equal(validateNativeTextEvidence(first,identity).files.length,1);
 const before=fs.readdirSync(first.storeRoot).sort();assert.throws(()=>captureNativeTextEvidence(request([files[2]]),f.context),{code:'native_text_limit'});assert.deepEqual(fs.readdirSync(first.storeRoot).sort(),before,'archive cannot exceed original-byte aggregate or delete old material to fit');
 // All three physical blobs would fit easily. A stored binding still rejects their logical sum.
 const third=files[2];fs.writeFileSync(path.join(first.storeRoot,third.sha256),fs.readFileSync(path.join(f.textRoot,third.path)),{mode:0o600});
 const all={...first,files:files.map(row=>({...row,contentBlob:row.sha256})),requirements:tooLarge.requirements};assert.throws(()=>validateNativeTextEvidence(all,identity),{code:'native_text_limit'});
 const originalCarrier=fs.readFileSync(path.join(f.textRoot,files[0].path)),invalid=Buffer.from(originalCarrier.toString().replace('"value":1','"value":2'));
 assert(!invalid.equals(originalCarrier));fs.writeFileSync(path.join(f.textRoot,'bad-carrier.json'),invalid);const bad={...files[0],path:'bad-carrier.json',sha256:sha(invalid),size:invalid.length};assert.equal(inspectNativeTextEvidence(request([bad]),f.context).ready,false);
});
