import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {captureReviewBaseline,createReviewPackage,readReviewPackage,verifyCompletionReviewPackage} from '../runtime/js/cm-ai/review-package.mjs';
import {hostHandoffDocument} from '../runtime/js/cm-ai/host-handoff.mjs';
import {createCodexReviewRun} from '../runtime/js/cm-ai/codex-review-adapter.mjs';
import {codexWorker} from '../runtime/js/cm-ai/worker-codex.mjs';
import {commonArgs,configFingerprint} from '../runtime/js/cm-ai/codex-config.mjs';
import {digest,requestFor} from '../runtime/js/cm-ai/effect-contract.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
const identity={repositoryId:'native-fixture',runId:'run',taskId:'T-004',attempt:2};
function fixture(t){
 const temp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-native-material-')));t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
 const [codeProject,specsDir,sourceRoot]=['code','specs','native'].map(p=>{const q=path.join(temp,p);fs.mkdirSync(q);return q;});
 for(const [name,body] of [['value.js','before'],['kept.js','kept'],['AGENTS.md','rules']])fs.writeFileSync(path.join(codeProject,name),body);
 const scope=['kept.js','value.js'];
 const baseline=captureReviewBaseline({root:codeProject,identity,scope:[...scope,'AGENTS.md'],requirements:['kept.js']});
 fs.writeFileSync(path.join(codeProject,'value.js'),'after');fs.writeFileSync(path.join(sourceRoot,'screen.png'),png);
 const manifest={version:1,report:'Simulator capture provenance; physical-iPhone and maximum-size criteria remain unverified.',sourceFiles:scope.map(p=>({path:p,sha256:hash(fs.readFileSync(path.join(codeProject,p)))})),images:[{path:'screen.png',sha256:hash(png),size:png.length,description:'Synthetic fixture, no visual acceptance'}]};
 const write=()=>fs.writeFileSync(path.join(sourceRoot,'manifest.json'),JSON.stringify(manifest));write();
 return {temp,codeProject,specsDir,sourceRoot,scope,baseline,manifest,write};
}
test('native material capture binds exact current scope, stable PNG archive and completion material',async t=>{
 const n=await import('../runtime/js/cm-ai/native-review-evidence.mjs'),f=fixture(t);
 const profile=n.readNativeEvidenceProfile({version:1,sourceRoot:f.sourceRoot,manifest:'manifest.json'},f);
 assert(Object.isFrozen(profile));assert.throws(()=>n.readNativeEvidenceProfile({...profile,extra:true},f));
 assert.throws(()=>n.readNativeEvidenceProfile({...profile,sourceRoot:f.codeProject},f));
 const link=path.join(f.temp,'linked');fs.symlinkSync(f.sourceRoot,link);assert.throws(()=>n.readNativeEvidenceProfile({...profile,sourceRoot:link},f));
 const capture=()=>n.captureNativeReviewEvidence(profile,{...f,identity});
 const check=capture();assert.equal(check.kind,'native-evidence');assert.equal(check.exitCode,0);assert.equal(check.materialDigest,digest(check.material));assert(Object.isFrozen(check.material));
 assert.equal(n.validateNativeEvidenceCheck(check,identity).materialDigest,check.materialDigest);
 assert.throws(()=>n.validateNativeEvidenceCheck(check,{...identity,runId:'other'}));
 const pkg=createReviewPackage({root:f.codeProject,baseline:f.baseline,checks:[check]});assert.deepEqual(readReviewPackage(pkg),pkg);
 const images=n.nativeEvidenceImagePaths(pkg);assert.equal(images.length,1);assert(!images[0].startsWith(f.sourceRoot));assert(fs.readFileSync(images[0]).equals(png));
 const handoff=hostHandoffDocument({baseline:f.baseline,checks:[check],reviewPackage:pkg,implementationSha256:'0'.repeat(64)}).payload;
 assert.match(handoff.verification[0].command,/MATERIAL/);assert(!handoff.verification[0].command.includes('undefined'));
 const seal=p=>{const {packageDigest,...body}=p;return {...body,packageDigest:digest(body)};};
 const altered=structuredClone(pkg);altered.checks[0].material.sourceFiles[0].sha256='0'.repeat(64);altered.checks[0].materialDigest=digest(altered.checks[0].material);altered.checksDigest=digest(altered.checks);
 assert.throws(()=>readReviewPackage(seal(altered)),{code:'invalid_package'});
 const changed=structuredClone(check);changed.material.report+=' Extra provenance';changed.materialDigest=digest(changed.material);
 assert.throws(()=>verifyCompletionReviewPackage({root:f.codeProject,baseline:f.baseline,checks:[changed],reviewPackage:pkg,expectedDigest:pkg.packageDigest}));
 f.manifest.sourceFiles.pop();f.write();assert.throws(capture);f.manifest.sourceFiles=check.material.sourceFiles.map(r=>({...r}));
 f.manifest.images[0].sha256='0'.repeat(64);f.write();assert.throws(capture);f.manifest.images[0].sha256=hash(png);
 fs.writeFileSync(path.join(f.codeProject,'value.js'),'drift');f.write();assert.throws(capture);
 fs.writeFileSync(path.join(f.codeProject,'value.js'),'after');
 fs.writeFileSync(path.join(f.sourceRoot,'screen.png'),Buffer.from('not PNG'));f.manifest.images[0].size=7;f.manifest.images[0].sha256=hash(Buffer.from('not PNG'));f.write();assert.throws(capture);
 assert.deepEqual(n.readNativeEvidenceProfile({...profile,sourceRoot:path.join(f.temp,'gone')},f,{inspectCurrent:false}),{...profile,sourceRoot:path.join(f.temp,'gone')});
 fs.writeFileSync(images[0],Buffer.alloc(png.length));assert.throws(()=>n.nativeEvidenceImagePaths(pkg));
});
test('actual Codex worker argv binds only package archived PNGs and keeps no-image argv unchanged',async t=>{
 const n=await import('../runtime/js/cm-ai/native-review-evidence.mjs'),f=fixture(t);
 const profile=n.readNativeEvidenceProfile({version:1,sourceRoot:f.sourceRoot,manifest:'manifest.json'},f),check=n.captureNativeReviewEvidence(profile,{...f,identity});
 const pkg=createReviewPackage({root:f.codeProject,baseline:f.baseline,checks:[check]});
 const request=p=>requestFor({invocationId:'review',identity,role:'reviewer',provider:'codex',requestedModel:'fixture',contextId:'fresh',payload:{reviewPackage:p,priorReview:null}});
 const options={cwd:f.codeProject,model:'fixture',effort:'high'};let argv=null,spawns=0;
 const make=()=>codexWorker({...options,schemaPath:'/fixture/schema',preflight:{passed:true,cli_model:'fixture',config_fingerprint:configFingerprint(options)},spawnProcess(cli,args){
  spawns++;argv=args;const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>true;
  queueMicrotask(()=>{for(const row of [{type:'thread.started',thread_id:'synthetic-review'},{type:'turn.started'},{type:'item.completed',item:{type:'agent_message',text:'{}'}},{type:'turn.completed'}])child.stdout.write(JSON.stringify(row)+'\n');child.stdout.end();child.stderr.end();child.emit('close',0,null);});return child;
 }});
 const control={signal:new AbortController().signal,onEvent(){}};
 assert.equal((await createCodexReviewRun(make())(request(pkg),control)).status,'succeeded');
 const paths=n.nativeEvidenceImagePaths(pkg);assert.deepEqual(argv.slice(-5,-1),['--output-schema','/fixture/schema','--image',paths[0]]);assert(argv.at(-1).includes('Native material integrity'));
 const plainCheck={id:'local',command:['fixture'],outcome:'passed',exitCode:0,evidence:'synthetic'};
 const plain=createReviewPackage({root:f.codeProject,baseline:f.baseline,checks:[plainCheck]});
 let forwarded;await createCodexReviewRun(async(r)=>{forwarded=r;return {status:'succeeded'};})(request(plain),control);assert.deepEqual(Object.keys(forwarded),['prompt']);
 assert.equal((await make()(forwarded,control)).status,'succeeded');assert.deepEqual(argv,[...commonArgs(options),'--output-schema','/fixture/schema',forwarded.prompt]);
 let nativeForwarded;await createCodexReviewRun(async r=>{nativeForwarded=r;return {status:'succeeded'};})(request(pkg),control);
 fs.writeFileSync(paths[0],Buffer.alloc(png.length));const before=spawns;
 await assert.rejects(async()=>make()(nativeForwarded,control));assert.equal(spawns,before);
});

test('evidence continuation passes all old ten and new six PNGs into actual worker argv',async t=>{
 const n=await import('../runtime/js/cm-ai/native-review-evidence.mjs');
 const {supplementedEvidencePackage}=await import('../runtime/js/cm-ai/valid-review-evidence-continuation.mjs');
 const f=fixture(t),profile={version:1,sourceRoot:f.sourceRoot,manifest:'manifest.json'};
 const captureImages=(prefix,count)=>{
  f.manifest.images=Array.from({length:count},(_,i)=>{const p=prefix+i+'.png';fs.writeFileSync(path.join(f.sourceRoot,p),png);return {path:p,sha256:hash(png),size:png.length,description:prefix+i};});f.write();
  return n.captureNativeReviewEvidence(profile,{...f,identity});
 };
 const oldCheck=captureImages('old-',10),old=createReviewPackage({root:f.codeProject,baseline:f.baseline,checks:[oldCheck,{id:'local',command:['fixture'],outcome:'passed',exitCode:0,evidence:'before review diagnostic'}]}),newCheck=captureImages('new-',6);
 const receiptBody={identity,packageDigest:old.packageDigest,result:{verdict:'blocked',findings:[{id:'B1',severity:'P1',path:'value.js',message:'More evidence',evidence:'Synthetic'}]}},receipt={...receiptBody,receiptDigest:digest(receiptBody)};
 const source={identity,hostContextId:'original-owner',revision:'0'.repeat(64),oldReceiptDigest:receipt.receiptDigest,oldPackageDigest:old.packageDigest,configDigest:'0'.repeat(64),baselineDigest:f.baseline.baselineDigest,
  candidateDigest:digest({baseIdentity:old.baseIdentity,scope:old.scope,changes:old.changes,unchangedScope:old.unchangedScope??null,requirements:old.requirements,specification:old.specification??null,handoff:old.handoff??null}),fingerprints:{workflow:'0'.repeat(64),config:'0'.repeat(64),inputs:'0'.repeat(64)}};
 const pkg=supplementedEvidencePackage(old,source,newCheck,[{id:'B1',disposition:'Author claim, not visual PASS',evidenceIds:['new-0.png']}],receipt);
 assert.deepEqual(readReviewPackage(pkg),pkg);const paths=n.nativeEvidenceImagePaths(pkg);assert.equal(paths.length,16);
 const {inspectEvidenceContinuationReviewInput,prepareCodexReviewInput}=await import('../runtime/js/cm-ai/codex-review-adapter.mjs');
 const oldRequest=requestFor({invocationId:'preview',identity,role:'reviewer',provider:'codex',requestedModel:'fixture',contextId:'fresh',payload:{reviewPackage:old,priorReview:receipt.result}});
 const preview=inspectEvidenceContinuationReviewInput(oldRequest,{version:1,reason:'Preview only',evidenceContinuation:true,source,nativeEvidence:profile,manifestDigest:newCheck.material.manifestDigest,findings:pkg.evidenceContinuation.findings},{...f,oldReceipt:receipt});
 assert.equal(preview.projectedPackageDigest,pkg.packageDigest);assert.equal(preview.imageCount,16);assert.equal(preview.archivesVerified,false);assert.equal(preview.authorizationGranted,false);
 const fullRequest=requestFor({invocationId:'preview',identity,role:'reviewer',provider:'codex',requestedModel:'fixture',contextId:'fresh',payload:{reviewPackage:pkg,priorReview:receipt.result}});assert.equal(preview.promptBytes,Buffer.byteLength(prepareCodexReviewInput(fullRequest).material?.prompt??(await import('../runtime/js/cm-ai/codex-review-adapter.mjs')).buildReviewPrompt(fullRequest,'codex')));
 let argv;const options={cwd:f.codeProject,model:'fixture',effort:'high'},worker=codexWorker({...options,schemaPath:'/fixture/schema',preflight:{passed:true,cli_model:'fixture',config_fingerprint:configFingerprint(options)},spawnProcess(cli,args){
  argv=args;const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>true;
  queueMicrotask(()=>{for(const row of [{type:'thread.started',thread_id:'fresh-evidence-review'},{type:'turn.started'},{type:'item.completed',item:{type:'agent_message',text:'{}'}},{type:'turn.completed'}])child.stdout.write(JSON.stringify(row)+'\n');child.stdout.end();child.stderr.end();child.emit('close',0,null);});return child;
 }});
 const request=requestFor({invocationId:'evidence-review',identity,role:'reviewer',provider:'codex',requestedModel:'fixture',contextId:'fresh',payload:{reviewPackage:pkg,priorReview:receipt.result}});
 assert.equal((await createCodexReviewRun(worker)(request,{signal:new AbortController().signal,onEvent(){}})).status,'succeeded');
 assert.deepEqual(argv.filter((v,i,a)=>a[i-1]==='--image'),paths,'all sixteen exact archived PNG paths, no truncation');
 verifyCompletionReviewPackage({root:f.codeProject,baseline:f.baseline,checks:[oldCheck,{...old.checks[1],evidence:'completion recheck diagnostic prose changed'}],reviewPackage:pkg,expectedDigest:pkg.packageDigest});
});
