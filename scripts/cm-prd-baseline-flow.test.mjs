// Synthetic owner wiring only: no browser launch, interaction claim or real reviewer invocation.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
import {createCmPrdAnalysis} from '../runtime/js/cm-prd/analysis.mjs';
import {openPrdSession} from '../runtime/js/cm-prd/session.mjs';
import {savePrdDesign} from '../runtime/js/cm-prd/draft-save.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const sha=value=>createHash('sha256').update(value).digest('hex');
const sessionId='prd-baseline-flow';
const user='Use warm frosted glass, two warm skins and rounded type. The confirmed three-screen prototype is the pixel baseline; list native platform differences.';
const design=()=>({status:'design',summary:'Native pixel baseline design',features:[{name:'native',documents:[
  {path:'requirements.md',content:'## 功能需求\n1. [F-001] Preserve the confirmed prototype pixels and interactions.\n- [ ] [AC-001] List native differences.'},
  {path:'design.md',content:'## 方案摘要\nPreserve design-baseline/ pixels.\n## 原生差异\nList native platform differences; no automatic approval.'}]}]});
async function fixture(t,{blocked=true}={}){
  const project=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-prd-baseline-flow-')));const sessions=[];
  t.after(()=>{for(const session of sessions)session.close();fs.rmSync(project,{recursive:true,force:true});});
  const specs=path.join(project,'specs'),prototypeRoot=path.join(project,'prototype');fs.mkdirSync(specs);fs.mkdirSync(path.join(specs,'docs'));fs.mkdirSync(prototypeRoot);
  fs.writeFileSync(path.join(specs,'docs/input.md'),'Confirmed native app pixel baseline and explicit platform differences');
  fs.writeFileSync(path.join(project,'.cm-workflow.json'),JSON.stringify({version:1,roles:{reviewer:{adapter:'claude-cli',model:'default',source:'subscription'}}}));
  const html='<button>Next</button>',image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aMuoAAAAASUVORK5CYII=','base64');
  fs.writeFileSync(path.join(prototypeRoot,'index.html'),html);fs.writeFileSync(path.join(prototypeRoot,'screen.png'),image);
  const font=Buffer.alloc(32);font.write('wOF2');font.writeUInt32BE(32,8);fs.writeFileSync(path.join(prototypeRoot,'font.woff2'),font);
  const input={prototypeRoot,captureRoot:null,confirmation:{reference:'synthetic-user-message',messageDigest:digest(user),level:'pixel',nativeDifferences:'list_each_platform_difference'},
    sources:[{sourcePath:'index.html',sha256:sha(html)}],
    screenshots:[{id:'main',sourcePath:'screen.png',sha256:sha(image),width:1,height:1,page:'main',skin:'warm',state:'default'}],
    fonts:[{id:'round',sourcePath:'font.woff2',sha256:sha(font),license:'Synthetic fixture font only',source:'Synthetic test fixture'}],
    specSheet:{source:'rendered-computed',channel:'codex-in-app',url:'https://prototype.example/',viewport:{width:390,height:844,deviceScaleFactor:1},elements:[{sel:'button',geo:{x:0,y:0,w:20,h:20},font:null,style:{color:'rgb(0, 0, 0)'}}]},
    interaction:{status:'complete',channel:'codex-in-app',coverage:['main'],steps:[{id:'tap',action:'Synthetic click',result:'Synthetic next state',screenshots:['main']}]},cssSource:null};
  const entry={skillDir:path.join(root,'skills/cm-prd'),project,specs},identity={entry,runtime:'codex'};let generateCalls=0;
  const create=(restored=null,generate=async payload=>{generateCalls++;assert.equal(payload.phase,'design');return design();})=>
    createCmPrdAnalysis({input:entry,runtime:'codex',sessionId,record:()=>{},restored,
      analyze:async()=>({status:'analyzed',summary:'User-confirmed pixels',sourcePaths:['docs/input.md'],openQuestions:[]}),generate});
  const initial=create(null,async()=>{generateCalls++;return {status:'blocked',reason:'Formal baseline import was unavailable'};});
  await initial.advance(user);if(blocked)await initial.plan('Create native design from the confirmed pixels',{designOnly:true});
  const open=()=>{const session=openPrdSession({specs,sessionId,identity});let closed=false;const close=session.close;
    session.close=()=>{if(!closed){closed=true;close();}};sessions.push(session);return session;};
  const wrap=analysis=>({analysis,change:null,started:true,routeTurn:2,reviewState:null,summaryState:null,publishedSummary:false});
  const recover=analysis=>{const session=open();session.checkpoint(wrap(analysis.checkpoint()));
    const binding={...session.inspectPlanningRecovery(),reason:'Formal baseline import and approved browser extraction now available'};
    session.recoverPlanning(binding,{validateCurrent:()=>analysis.validateCurrent()});const restored=session.state.checkpoint.analysis;
    const original=session.state.planningRecoveries[0].originalCheckpoint;session.close();return {owner:create(restored),original,binding};};
  return {project,specs,prototypeRoot,input,initial,create,open,wrap,recover,getGenerateCalls:()=>generateCalls};
}
test('blocked baseline import recovers original planning then binds saved design and Claude review package',async t=>{
  const f=await fixture(t),before=f.initial.checkpoint();assert.equal(before.stage,'blocked');assert.equal(before.selfCheckRound,0);
  f.initial.importBaseline(f.input,{writeEnabled:true});assert.equal(f.initial.status().stage,'blocked');
  assert.deepEqual(f.initial.checkpoint().planning,before.planning);assert.equal(fs.readdirSync(f.specs).some(name=>/^\d+\./.test(name)),false);
  const {owner,original}=f.recover(f.initial);assert.deepEqual(original.analysis.planning,before.planning);assert.equal(owner.status().stage,'analysis_ready');
  assert.deepEqual(owner.checkpoint().messages,before.messages);assert.deepEqual(owner.checkpoint().selfCheckHistory,[]);
  await owner.plan('Continue original native design',{designOnly:true});const draft=owner.currentDesignForSave();
  assert.equal(draft.features[0].directory,'1.native');assert.equal(owner.status().selfCheckRound,0);assert.equal(f.getGenerateCalls(),2);
  assert.equal(savePrdDesign({specs:f.specs,writeEnabled:true,getDraft:()=>owner.currentDesignForSave()}).status,'design_saved');
  const published=owner.publishBaseline(['1.native'],{writeEnabled:true});assert.equal(published[0].status,'baseline_published');
  const review=owner.prepareReview('design','1.native');assert.equal(review.reviewPackage.reviewRoute.adapter,'claude-cli');
  assert.equal(review.reviewPackage.designBaseline.manifestDigest,owner.status().designBaseline.manifestDigest);
  assert.deepEqual(review.reviewPackage.designBaseline.confirmation,f.input.confirmation);assert.equal(review.reviewPackage.designBaseline.artifacts.length,4);
  assert.equal(review.packageDigest,digest(review.reviewPackage));assert.equal(review.completionAuthorized,false);
  assert.equal(fs.existsSync(path.join(f.specs,'.cm-specs-status')),false);assert.equal(fs.existsSync(path.join(f.specs,'1.native/tasks.md')),false);
  assert.equal(fs.readdirSync(path.join(f.specs,'.reviews')).some(name=>name.endsWith('-r1.md')),false);
});
test('incomplete interaction blocks generation before any new planner call',async t=>{
  const f=await fixture(t);f.input.interaction.status='incomplete';f.initial.importBaseline(f.input,{writeEnabled:true});
  const {owner}=f.recover(f.initial),calls=f.getGenerateCalls();
  await assert.rejects(owner.plan('Continue',{designOnly:true}),/prd_baseline_incomplete/);assert.equal(f.getGenerateCalls(),calls);
  assert.equal(owner.status().draft,null);assert.equal(owner.status().designDraft,null);assert.equal(owner.status().selfCheckRound,0);
  assert.equal(fs.existsSync(path.join(f.specs,'1.native')),false);
});
test('wrong user confirmation cannot import or write any baseline directory',async t=>{
  const f=await fixture(t),before=f.initial.checkpoint();f.input.confirmation.messageDigest='f'.repeat(64);
  assert.throws(()=>f.initial.importBaseline(f.input,{writeEnabled:true}),/prd_baseline_confirmation_mismatch/);
  assert.deepEqual(f.initial.checkpoint(),before);assert.equal(fs.existsSync(path.join(f.specs,'.reviews')),false);
});
for(const mode of ['source','private-copy','published-copy'])test(`analysis and review reject ${mode} drift`,async t=>{
  const f=await fixture(t);f.initial.importBaseline(f.input,{writeEnabled:true});const {owner}=f.recover(f.initial);
  await owner.plan('Continue',{designOnly:true});savePrdDesign({specs:f.specs,writeEnabled:true,getDraft:()=>owner.currentDesignForSave()});
  owner.publishBaseline(['1.native'],{writeEnabled:true});const before=owner.status().designBaseline;
  const target=mode==='source'?path.join(f.prototypeRoot,'index.html'):mode==='private-copy'?
    path.join(f.specs,path.dirname(before.path),'screenshot-1.png'):path.join(f.specs,'1.native/design-baseline/screenshot-1.png');
  fs.writeFileSync(target,'changed');assert.throws(()=>owner.prepareReview('design','1.native'),/prd_baseline_(source|asset)_changed/);
  assert.equal(fs.readdirSync(path.join(f.specs,'.reviews')).some(name=>name.endsWith('-dispatch.json')),false);
});
test('checkpoint restoration keeps exact baseline, planning history, stage and consumed counters',async t=>{
  const f=await fixture(t);f.initial.importBaseline(f.input,{writeEnabled:true});const before=f.initial.checkpoint();
  const restored=f.create(before);assert.deepEqual(restored.checkpoint(),before);assert.equal(restored.status().stage,'blocked');
  assert.deepEqual(restored.inspectBaseline().reference,before.designBaseline);
  const session=f.open();session.checkpoint(f.wrap(before));const bytes=fs.readFileSync(path.join(f.specs,'.reviews/prd-sessions',sessionId,'state.json'));
  session.close();const reopened=f.open();assert.deepEqual(reopened.state.checkpoint.analysis,before);
  assert.deepEqual(fs.readFileSync(path.join(f.specs,'.reviews/prd-sessions',sessionId,'state.json')),bytes);
});

test('same imported baseline is idempotent after transient capture cleanup',async t=>{
  const f=await fixture(t),capture=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-prd-transient-owner-')));
  t.after(()=>fs.rmSync(capture,{recursive:true,force:true}));fs.copyFileSync(path.join(f.prototypeRoot,'screen.png'),path.join(capture,'screen.png'));
  f.input.captureRoot=capture;f.initial.importBaseline(f.input,{writeEnabled:true});const before=f.initial.checkpoint();
  fs.rmSync(capture,{recursive:true});const result=f.initial.importBaseline(f.input,{writeEnabled:true});
  assert.equal(result.designBaseline.ready,true);assert.deepEqual(f.initial.checkpoint(),before);
  fs.writeFileSync(path.join(f.prototypeRoot,'index.html'),'source drift');
  assert.throws(()=>f.initial.importBaseline(f.input,{writeEnabled:true}),/prd_baseline_source_changed/);
});
