import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {buildManifest} from './cm-spec-manifest.mjs';
import {inspectContinuationPlan} from '../runtime/js/cm-ai/continuation-preflight.mjs';
import {captureReviewBaseline} from '../runtime/js/cm-ai/review-package.mjs';
import {CONTINUATION_HELP,PREFLIGHT_HELP,SUPERSEDE_HELP} from '../runtime/js/cm-ai/recovery-capabilities.mjs';
const root=fileURLToPath(new URL('..',import.meta.url));
const implemented={outcome:'implemented',application:{status:'no_relevant_lesson',note:null},retrospective:{status:'no_new_lesson',candidates:[],reason:null}};
function fixture(t){
 const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-preflight-')));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const app=path.join(dir,'app'),specs=path.join(dir,'specs'),answers=path.join(dir,'answers');
 for(const p of [app,path.join(specs,'1.work'),answers])fs.mkdirSync(p,{recursive:true});
 for(const file of ['requirements.md','design.md'])fs.writeFileSync(path.join(specs,'1.work',file),'# Fixture\n');
 fs.writeFileSync(path.join(specs,'1.work/tasks.md'),'- [ ] T-001: read-only fixture\n');
 fs.writeFileSync(path.join(specs,'.cm-specs-status'),JSON.stringify({status:'approved',features:['1.work'],specFiles:buildManifest(specs)}));
 fs.writeFileSync(path.join(app,'requirements.md'),'# Fixture\n');fs.writeFileSync(path.join(app,'main.mjs'),'old\n');
 const definition={version:1,codeProject:app,specsDir:specs,feature:'1.work',identity:{repositoryId:'preflight',runId:'preflight-readonly',taskId:'T-001',attempt:1},scope:['main.mjs'],requirements:['requirements.md']};
 fs.writeFileSync(path.join(dir,'run.json'),JSON.stringify(definition));
 const plan={mode:'create',config:'run.json',hostContext:'never-start',permissions:[],answers:'answers',checks:[{id:'would-write',command:[process.execPath,'-e',"require('fs').writeFileSync('side-effect','bad')"]}]};
 fs.writeFileSync(path.join(dir,'PLAN.json'),JSON.stringify(plan));fs.writeFileSync(path.join(answers,'new.mjs'),'new\n');
 fs.writeFileSync(path.join(answers,'develop.json'),JSON.stringify({status:'succeeded',value:implemented,edits:{'main.mjs':'new.mjs'}}));
 const snap=()=>Object.fromEntries(fs.readdirSync(app).map(f=>[f,fs.readFileSync(path.join(app,f),'base64')]));
 return {dir,app,specs,answers,plan,definition,snap,file:path.join(dir,'PLAN.json')};
}
test('preflight estimates real encoded task material without model, command, writer, file or state writes',t=>{
 const f=fixture(t),before=f.snap(),r=inspectContinuationPlan(f.file);
 assert.equal(r.readOnly,true);assert.deepEqual(r.issues,[],JSON.stringify(r));assert.equal(r.status,'estimated');
 assert.ok(r.capacity.packageBytes>0);assert.equal(r.capacity.inlineBytes,r.capacity.packageBytes+r.capacity.components.existingFrame+r.capacity.components.result+r.capacity.components.learning+16384+512);
 assert.equal(r.capacity.budget,1048576-r.capacity.reserve);assert.ok(r.capacity.fits);
 assert.ok(r.unknown.some(s=>s.includes('reviewer verdict')));assert.deepEqual(r.actions,[]);
 assert.deepEqual(f.snap(),before);assert.ok(!fs.existsSync(path.join(f.specs,'.reviews/.execution')));
});
test('preflight rejects missing resume history and out-of-scope delivery and never suggests advance',t=>{
 const f=fixture(t);f.plan.mode='resume';fs.writeFileSync(f.file,JSON.stringify(f.plan));
 let r=inspectContinuationPlan(f.file);assert.equal(r.status,'blocked');assert.equal(r.actions.length,0);
 f.plan.mode='create';fs.writeFileSync(f.file,JSON.stringify(f.plan));
 fs.writeFileSync(path.join(f.answers,'develop.json'),JSON.stringify({status:'succeeded',value:implemented,edits:{'foreign.mjs':'new.mjs'}}));
 r=inspectContinuationPlan(f.file);assert.equal(r.status,'blocked');assert.ok(r.issues.some(row=>row.code==='out_of_scope'));assert.deepEqual(r.actions,[]);
});
test('both CLI help surfaces and public recovery documents share the actual continuation/supersede contract',()=>{
 for(const script of ['cm-ai-drive.mjs','cm-ai-host.mjs']){
  const r=spawnSync(process.execPath,[path.join(root,'scripts',script),'--help'],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);
  for(const text of [CONTINUATION_HELP,PREFLIGHT_HELP,SUPERSEDE_HELP])assert.ok(r.stdout.includes(text),script);
 }
 for(const rel of ['docs/cm-control-policy-v2.md','skills/cm-ai/references/js-host-recovery.md','skills/cm-ai/SKILL.md']){
  const text=fs.readFileSync(path.join(root,rel),'utf8');assert.ok(text.includes('--task-review-origin'),rel);assert.ok(text.includes('preflight'),rel);
 }
 const text=fs.readFileSync(path.join(root,'skills/cm-ai/references/js-host-recovery.md'),'utf8');
 for(const phrase of ['v2 supersede 未开放','v2 当前不开放 supersede','预算用尽后的 supersede 在 v2 未开放'])assert.ok(!text.includes(phrase),phrase);
});

test('preflight shares driver permission and control-file rules instead of offering unusable launches',t=>{
 const f=fixture(t);
 for(const change of [p=>p.permissions=['--unsupported'],p=>{p.permissions=['--review-config'];},p=>{p.controlConfig='/absolute/config.json';}]){
  const p=structuredClone(f.plan);change(p);fs.writeFileSync(f.file,JSON.stringify(p));assert.throws(()=>inspectContinuationPlan(f.file),/permissions|controlConfig/);
 }
});

test('already-applied task changes with an empty delivery use task origin rather than the continuation execution baseline',t=>{
 const f=fixture(t),origin=captureReviewBaseline({root:f.app,identity:f.definition.identity,scope:f.definition.scope,requirements:f.definition.requirements});
 fs.writeFileSync(path.join(f.app,'main.mjs'),'already applied task code\n');
 const execution=captureReviewBaseline({root:f.app,identity:f.definition.identity,scope:f.definition.scope,requirements:f.definition.requirements});
 fs.writeFileSync(path.join(f.dir,'origin.json'),JSON.stringify(origin));fs.writeFileSync(path.join(f.dir,'execution.json'),JSON.stringify(execution));
 const script=`import fs from 'node:fs';
import {createHash} from 'node:crypto';import {driverTaskBaseline,baselineScope,preflightDevelopDeliveries} from ${JSON.stringify(new URL('./cm-ai-drive.mjs',import.meta.url).href)};
 const origin=JSON.parse(fs.readFileSync(process.argv[1])),execution=JSON.parse(fs.readFileSync(process.argv[2]));
 preflightDevelopDeliveries({deliveries:[{file:'develop-a2.json',attempt:2,value:{status:'succeeded',value:${JSON.stringify(implemented)},edits:{}}}],
 answersRoot:process.argv[3],codeProject:process.argv[4],scope:['main.mjs'],requirements:['requirements.md'],
 baseline:baselineScope(driverTaskBaseline({original:execution,taskContinuation:{baseline:origin}}),['main.mjs'])});
 process.stdout.write('retained task diff accepted');`;
 const r=spawnSync(process.execPath,['--input-type=module','-e',script,path.join(f.dir,'origin.json'),path.join(f.dir,'execution.json'),f.answers,f.app],{encoding:'utf8'});
 assert.equal(r.status,0,r.stderr);assert.equal(r.stdout,'retained task diff accepted');
});


test('binary create preflight validates large sources read-only without claiming archived package capacity',t=>{
 const f=fixture(t),asset='font.otf',bytes=Buffer.alloc(2*1024*1024+7,0xa5);
 f.definition.scope.push(asset);fs.writeFileSync(path.join(f.dir,'run.json'),JSON.stringify(f.definition));
 fs.writeFileSync(path.join(f.answers,asset),bytes);
 const protection={checkCommands:[{id:'safe',command:[process.execPath,'--version']}],timeoutMs:30000,binaryAssets:{version:1,paths:[asset],sourceRoot:f.answers}};
 fs.writeFileSync(path.join(f.dir,'protected.json'),JSON.stringify(protection));
 f.plan.permissions=['--protected-conversation-config','protected.json'];fs.writeFileSync(f.file,JSON.stringify(f.plan));
 const answer={status:'succeeded',value:implemented,edits:{'main.mjs':'new.mjs',[asset]:asset}};
 fs.writeFileSync(path.join(f.answers,'develop.json'),JSON.stringify(answer));
 const before=f.snap(),r=inspectContinuationPlan(f.file);
 assert.deepEqual(r.issues,[],JSON.stringify(r));assert.equal(r.status,'estimated');
 assert.equal(r.binaryAssets.sources[0].size,bytes.length);
 assert.equal(r.binaryAssets.sources[0].beforeSha256,null);
 assert.equal(r.binaryAssets.sources[0].afterSha256,createHash('sha256').update(bytes).digest('hex'));
 assert.equal(r.capacity.fits,null);assert.equal(r.capacity.binaryArchiveVerified,false);
 assert.ok(r.unknown.some(s=>s.includes('binary archive')));assert.deepEqual(r.actions,[]);
 assert.deepEqual(f.snap(),before);assert.ok(fs.readFileSync(path.join(f.answers,asset)).equals(bytes));
 assert.ok(!fs.existsSync(path.join(f.specs,'.reviews')),'read-only preflight must not publish assets or execution state');
 fs.unlinkSync(path.join(f.answers,asset));fs.symlinkSync(path.join(f.answers,'new.mjs'),path.join(f.answers,asset));
 const rejected=inspectContinuationPlan(f.file);assert.equal(rejected.status,'blocked');
 assert.ok(rejected.issues.some(row=>['binary_asset_file','preflight_unavailable'].includes(row.code)),JSON.stringify(rejected));
 assert.deepEqual(rejected.actions,[]);
});
