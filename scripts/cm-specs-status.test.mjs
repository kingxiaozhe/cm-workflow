import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {readSpecsStatus,writeSpecsStatus} from '../runtime/js/specs-status.mjs';
import {buildManifest} from './cm-spec-manifest.mjs';
import {claimPrdReview} from './cm-prd-review-gate.mjs';
import {preparePrdReview} from '../runtime/js/cm-prd/review-preparation.mjs';
import {publishPrdReview} from '../runtime/js/cm-prd/review-publication.mjs';
import {recordPrdHostDisposition} from '../runtime/js/cm-prd/review-disposition.mjs';
import {createPrdSummaryOwner,publishPrdAwaitingReview} from '../runtime/js/cm-prd/summary.mjs';
const entry=fileURLToPath(new URL('./cm-ai-admission.mjs',import.meta.url));
const at='2026-09-18T00:00:00.000Z';
const keys=['status','summaryDigest','at','features','specFiles','testCases','approval'];
function feature(specs,name='1.guide'){
  const target=path.join(specs,name);fs.mkdirSync(target,{recursive:true});
  const docs=[{path:'requirements.md',content:'## 功能需求\n1. [F-001] Guide\n- [ ] [AC-001] Read guide'},
    {path:'design.md',content:'## 方案摘要\nDocumentation'},{path:'tasks.md',content:'- [ ] T-001: Guide'}];
  for(const doc of docs)fs.writeFileSync(path.join(target,doc.path),doc.content);
  return docs;
}
function fixture(t){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-specs-status-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const specs=path.join(root,'specs'),code=path.join(root,'code');
  fs.mkdirSync(specs);fs.mkdirSync(code);fs.writeFileSync(path.join(code,'README.md'),'existing');feature(specs);
  const target=path.join(specs,'.cm-specs-status');
  const raw=value=>fs.writeFileSync(target,JSON.stringify(value));
  const value=()=>JSON.parse(fs.readFileSync(target,'utf8'));
  const run=(...args)=>{
    const child=spawnSync(process.execPath,[entry,'--specs-dir',specs,'--code-project',code,...args],{encoding:'utf8'});
    assert.equal(child.signal,null,child.stderr);
    return {exit:child.status,result:child.stdout?JSON.parse(child.stdout):null,stderr:child.stderr};
  };
  const initial=(status='awaiting_review')=>({status,summaryDigest:'A1'.repeat(32),at,features:['1.guide'],
    specFiles:buildManifest(specs),testCases:[],approval:null});
  return {root,specs,code,target,raw,value,run,initial};
}

test('shared status storage roundtrips canonically and reads legacy metadata without granting authority',t=>{
  const f=fixture(t),expected=f.initial();
  assert.deepEqual(readSpecsStatus(f.specs),{kind:'missing'});
  assert.deepEqual(writeSpecsStatus(f.specs,expected),expected);
  assert.deepEqual(readSpecsStatus(f.specs),{kind:'valid',value:expected});
  assert.deepEqual(Object.keys(f.value()),keys);
  if(process.platform!=='win32')assert.equal(fs.statSync(f.target).mode&0o777,0o600);
  const old={...expected,status:'approved',via:'old top-level metadata',approval:{response:'开始',at,via:'old model',runtime:'old'}};
  f.raw(old);const read=readSpecsStatus(f.specs);
  assert.equal(read.kind,'valid');assert.equal(read.value.via,undefined);
  assert.deepEqual(read.value.approval,{response:'开始',at});
  writeSpecsStatus(f.specs,read.value);
  assert.deepEqual(Object.keys(f.value()),keys);assert.equal(JSON.stringify(f.value()).includes('via'),false);
  const before=fs.readFileSync(f.target);
  assert.throws(()=>writeSpecsStatus(f.specs,{...expected,approval:{response:'开始',at}}),/spec_status_invalid/);
  assert.deepEqual(fs.readFileSync(f.target),before);
  assert.throws(()=>writeSpecsStatus(f.specs,expected,{beforeRename:()=>{throw new Error('inputs_changed');}}),/inputs_changed/);
  assert.deepEqual(fs.readFileSync(f.target),before);
  assert.deepEqual(fs.readdirSync(f.specs).sort(),['.cm-specs-status','1.guide']);
  fs.unlinkSync(f.target);const external=path.join(f.root,'outside.json');fs.writeFileSync(external,JSON.stringify(expected));
  fs.symlinkSync(external,f.target);assert.equal(readSpecsStatus(f.specs).kind,'invalid');
});

test('--approve writes only the three permitted reasons with explicit human input and reruns admission',t=>{
  const f=fixture(t),approve=['--approve','--approval-response','开始'];
  f.raw(f.initial());
  assert.equal(f.run('--approval-response','开始').result.reason,'approval_write_required');
  let result=f.run(...approve);assert.equal(result.exit,0);assert.equal(result.result.state,'ready');
  assert.deepEqual(Object.keys(f.value()),keys);assert.equal(f.value().approval.response,'开始');
  assert.equal(f.value().approval.at,f.value().at);
  feature(f.specs,'2.appendix');
  assert.equal(f.run('--approval-response','开始').result.reason,'spec_features_changed');
  result=f.run(...approve);assert.equal(result.exit,0);assert.equal(result.result.state,'ready');
  assert.deepEqual(f.value().features,['1.guide','2.appendix']);assert.deepEqual(f.value().specFiles,buildManifest(f.specs));
  // Legacy stale testCases reaches the third allowlisted reason without spec drift.
  f.raw({...f.value(),testCases:[{path:'1.guide/test-cases.json',sha256:'b'.repeat(64)}]});
  assert.equal(f.run('--approval-response','开始').result.reason,'test_cases_changed');
  result=f.run(...approve);assert.equal(result.exit,0);assert.equal(result.result.state,'ready');
  for(const args of [['--approve','--yes'],['--approve','--approval-response','继续'],['--approve']]){
    f.raw({...f.value(),status:'awaiting_review',approval:null});const before=fs.readFileSync(f.target);
    const original=f.run(...args.filter(arg=>arg!=='--approve')).result;
    result=f.run(...args);assert.equal(result.exit,1);assert(result.result.approveRefused);
    const {approveRefused,...rest}=result.result;assert.deepEqual(rest,original);
    assert.deepEqual(fs.readFileSync(f.target),before);
  }
  result=f.run(...approve);assert.equal(result.result.state,'ready');
  for(const args of [approve,['--approve','--yes','--approval-response','开始'],[...approve,'--code-project',path.join(f.root,'missing')]]){
    const before=fs.readFileSync(f.target);result=f.run(...args);assert.notEqual(result.exit,0);
    assert.deepEqual(fs.readFileSync(f.target),before);
  }
  fs.appendFileSync(path.join(f.specs,'1.guide/design.md'),'\nChanged design');
  const before=fs.readFileSync(f.target),original=f.run('--approval-response','开始').result;
  assert.equal(original.reason,'spec_drift');assert.equal(original.state,'blocked');
  result=f.run(...approve);assert.equal(result.exit,1);assert.equal(result.result.approveRefused,'spec_drift');
  const {approveRefused,...rest}=result.result;assert.deepEqual(rest,original);
  assert.deepEqual(fs.readFileSync(f.target),before);
});

test('cm-prd summary digest survives approval exactly and legacy absence becomes null',async t=>{
  const f=fixture(t),docs=feature(f.specs),name='1.guide';fs.mkdirSync(path.join(f.specs,'.reviews'));
  const prepared=preparePrdReview({specs:f.specs,stage:'split',feature:name,
    draft:{draftDigest:'a'.repeat(64),features:[{name:'guide',directory:name,documents:docs}]}});
  claimPrdReview({...prepared.paths,package_sha256:prepared.packageDigest});
  publishPrdReview({specs:f.specs,reviewPackage:prepared.reviewPackage,packageDigest:prepared.packageDigest,authorContextId:'author',
    response:{reviewer:'codex-subagent',contextId:'fixture-reviewer',independent:true,at,
      result:{verdict:'approved',packageDigest:prepared.packageDigest,examinedPaths:docs.map(doc=>`${name}/${doc.path}`).sort(),
        findings:[],summary:'Synthetic fixture review; not a real independent review'}}});
  recordPrdHostDisposition({specs:f.specs,stage:'split',feature:name,packageDigest:prepared.packageDigest,decisions:[],writeEnabled:true,
    artifacts:docs.map(doc=>({path:`${name}/${doc.path}`,sha256:createHash('sha256').update(doc.content).digest('hex')}))});
  const summary=await createPrdSummaryOwner({summarize:async({evidenceDigest})=>({evidenceDigest,
    deliveryForm:'Documentation',estimatedTime:'Unknown',openQuestions:'None in fixture',risks:'Synthetic',contextScope:'Targeted',
    platformReadiness:'Not applicable',uiBaseline:'None',designRisk:[{feature:name,
      signals:{greenfieldAdr:false,architectureOrDataFlow:false,newRuntimeDependencyOrToolchain:false,publicContractDataOrSecurity:false,fiveOrMoreFunctions:false},
      evidence:['Synthetic documentation fixture']}]})})(f.specs);
  assert.equal(summary.readyForAwaitingReview,true);
  assert.equal(publishPrdAwaitingReview({specs:f.specs,summary,writeEnabled:true}).status,'awaiting_review');
  assert.equal(f.value().summaryDigest,summary.summaryDigest);assert.equal(f.value().approval,null);
  const approve=()=>f.run('--approve','--approval-response','  开始  ');
  assert.equal(approve().result.state,'ready');assert.equal(f.value().summaryDigest,summary.summaryDigest);
  assert.equal(f.value().approval.response,'  开始  ');
  // Uppercase hex must not be normalized either.
  f.raw({...f.initial(),summaryDigest:'AB'.repeat(32)});
  assert.equal(approve().result.state,'ready');assert.equal(f.value().summaryDigest,'AB'.repeat(32));
  const legacy=f.initial();delete legacy.summaryDigest;delete legacy.approval;f.raw(legacy);
  assert.equal(approve().result.state,'ready');assert.equal(f.value().summaryDigest,null);
  fs.unlinkSync(f.target);assert.equal(approve().result.state,'ready');assert.equal(f.value().summaryDigest,null);
});
