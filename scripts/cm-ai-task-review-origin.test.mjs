// Isolated Git-object fixtures and pure origin bindings, never a model or owner run.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
import {captureReviewBaseline,createReviewPackage} from '../runtime/js/cm-ai/review-package.mjs';
import {captureTaskReviewOrigin,applyTaskReviewOrigin,verifyTaskReviewOrigin} from '../runtime/js/cm-ai/task-review-origin.mjs';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
function fixture(t){
  const directory=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-task-origin-')));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const repo=path.join(directory,'repo'),root=path.join(repo,'apps','fixture');fs.mkdirSync(root,{recursive:true});
  const git=(args,input)=>{const r=spawnSync('git',['-C',repo,...args],{input,encoding:'utf8',env:{...process.env,
    GIT_AUTHOR_NAME:'Fixture',GIT_AUTHOR_EMAIL:'fixture@example.invalid',GIT_COMMITTER_NAME:'Fixture',GIT_COMMITTER_EMAIL:'fixture@example.invalid'},timeout:10000});
    assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
  git(['init','--quiet']);
  // Raw fixture objects only: no index, real-project commit, hooks or filters.
  const blob=git(['hash-object','-w','--stdin'],'Git original code\n'),added=git(['hash-object','-w','--stdin'],'Git original added\n');
  const appTree=git(['mktree'],`100644 blob ${added}\tadded-a.js\n100644 blob ${blob}\tcode.js\n`);
  const apps=git(['mktree'],`040000 tree ${appTree}\tfixture\n`),tree=git(['mktree'],`040000 tree ${apps}\tapps\n`);
  const commit=git(['commit-tree',tree], 'Fixture tree\n');
  fs.writeFileSync(path.join(root,'AGENTS.md'),'# Original execution instructions\n');
  fs.writeFileSync(path.join(root,'requirements.md'),'# Frozen supporting requirement\n');
  fs.writeFileSync(path.join(root,'new-required.md'),'# A required task file absent from Git\n');
  fs.writeFileSync(path.join(root,'code.js'),'run start differs from Git\n');
  const additions=['added-a.js','added-b.js','added-c.js','added-d.js'];
  for(const p of additions)fs.writeFileSync(path.join(root,p),'already present current input '+p+'\n');
  const identity={repositoryId:'origin',runId:'origin-run',taskId:'T-001',attempt:1};
  const config={identity,scope:['code.js','new-required.md']};
  const original=captureReviewBaseline({root,identity,scope:['AGENTS.md',...config.scope].sort(),requirements:['new-required.md','requirements.md']});
  fs.writeFileSync(path.join(root,'code.js'),'r1 delivery\n');
  const checks=[{id:'synthetic',command:['node','--check','code.js'],outcome:'passed',exitCode:0,evidence:'Pure package fixture, not an executed check'}];
  const pkg=createReviewPackage({root,baseline:original,checks});
  const result={verdict:'changes_requested',packageDigest:pkg.packageDigest,examinedPaths:['code.js'],findings:[],summary:'Synthetic prior review material'};
  const receiptBody={identity,packageDigest:pkg.packageDigest,baseIdentity:pkg.baseIdentity,result};
  const receipt={...receiptBody,receiptDigest:digest(receiptBody)};
  const state={attempt:2,state:'blocked',code:'develop_package_too_large',cancellationRequested:false,cancelAfterCommit:false,workflowError:null,taskCommit:null,
    reviewPackage:pkg,priorReview:result,receipts:[receipt],reviewInvocation:null,
    cache:[{effect:{kind:'develop',identity:{...identity,attempt:2}},result:{state:'blocked',code:'develop_package_too_large'}}]};
  const scope=[...config.scope,...additions].sort();
  const authorization={version:1,commit,additions:additions.map(p=>{const bytes=fs.readFileSync(path.join(root,p));return {
    path:p,source:'Explicit fixture authorization for '+p,sha256:sha(bytes),size:bytes.length,mode:fs.statSync(path.join(root,p)).mode&0o7777};})};
  const args={root,original,scope,commit,state,config,authorization};
  return {...args,git,repo,directory,additions,args,capture:()=>captureTaskReviewOrigin(args)};
}
test('Git origin covers all old and added scope while execution metadata stays current and instructions stay original',t=>{
  const f=fixture(t),original=JSON.stringify(f.original),record=f.capture();
  assert.equal(record.prefix,'apps/fixture/');assert.equal(record.commit,f.commit);
  const before=record.beforeFiles.find(row=>row.path==='code.js').file;
  assert.equal(Buffer.from(before.contentBase64,'base64').toString(),'Git original code\n');
  const current=record.currentFiles.find(row=>row.path==='code.js').file;
  assert.equal(current.sha256,sha('r1 delivery\n'));assert.equal(Object.hasOwn(current,'contentBase64'),false);
  assert.equal(record.beforeFiles.find(row=>row.path==='added-b.js').file,null);
  const derived=applyTaskReviewOrigin({...f.args,record});
  assert.equal(derived.baseline.identity.attempt,2);assert.equal(derived.originDigest,digest(record));
  assert.deepEqual(derived.baseline.files.find(file=>file.path==='AGENTS.md'),f.original.files.find(file=>file.path==='AGENTS.md'));
  assert.equal(JSON.stringify(f.original),original);
  assert.deepEqual(verifyTaskReviewOrigin(record,f.args),record);
});
test('required scope files missing from Git become creation diffs without losing current requirement material',t=>{
  const f=fixture(t),record=f.capture(),{baseline}=applyTaskReviewOrigin({...f.args,record});
  assert.deepEqual(baseline.taskReviewOrigin.missingRequirements,['new-required.md']);
  const pkg=createReviewPackage({root:f.root,baseline,checks:[{id:'synthetic',command:['node'],outcome:'passed',exitCode:0,evidence:'Pure fixture only'}]});
  const created=pkg.changes.find(c=>c.path==='new-required.md');assert.equal(created.before,null);assert.ok(created.after.contentBase64);
  assert.equal(pkg.requirements.find(r=>r.path==='new-required.md').sha256,created.after.sha256);
  assert.equal(Buffer.from(pkg.changes.find(c=>c.path==='code.js').before.contentBase64,'base64').toString(),'Git original code\n');
  const added=pkg.changes.find(c=>c.path==='added-a.js');assert.equal(Buffer.from(added.before.contentBase64,'base64').toString(),'Git original added\n');
});
test('authorization must name each exact existing addition, source and current SHA without capability extras',t=>{
  const f=fixture(t);
  for(const change of [a=>a.additions.pop(),a=>a.additions[0].source='',a=>a.additions[0].sha256='0'.repeat(64),
    a=>a.additions[0].size++,a=>a.additions[0].mode^=0o111,a=>a.commit='0'.repeat(40),a=>a.commands=[]]){
    const authorization=structuredClone(f.authorization);change(authorization);
    assert.throws(()=>captureTaskReviewOrigin({...f.args,authorization}));
  }
  fs.unlinkSync(path.join(f.root,f.additions[0]));assert.throws(()=>f.capture());
});
test('current source drift, file links, case aliases and invalid UTF8 are refused',t=>{
  const f=fixture(t),record=f.capture(),file=path.join(f.root,f.additions[0]),bytes=fs.readFileSync(file);
  fs.appendFileSync(file,'changed');assert.throws(()=>verifyTaskReviewOrigin(record,f.args));fs.writeFileSync(file,bytes);
  fs.chmodSync(file,0o755);assert.throws(()=>verifyTaskReviewOrigin(record,f.args));fs.chmodSync(file,record.currentFiles.find(r=>r.path===f.additions[0]).file.mode);
  const link=path.join(f.root,'link');fs.linkSync(file,link);assert.throws(()=>f.capture());fs.unlinkSync(link);
  fs.renameSync(file,link);fs.symlinkSync(link,file);assert.throws(()=>f.capture());fs.unlinkSync(file);fs.renameSync(link,file);
  fs.renameSync(file,file+'.CASE');assert.throws(()=>f.capture());fs.renameSync(file+'.CASE',file);
  fs.writeFileSync(file,Buffer.from([255,254]));assert.throws(()=>f.capture());
});
test('pure replay refuses wrong original baseline, old review receipt, mutated material and already-reviewed second attempts',t=>{
  const f=fixture(t),record=f.capture(),apply=(r,state=f.state)=>applyTaskReviewOrigin({...f.args,record:r,state});
  for(const change of [r=>r.sourceBaselineDigest='0'.repeat(64),r=>r.priorPackageDigest='0'.repeat(64),r=>r.priorReceiptDigest='0'.repeat(64),
    r=>r.beforeFiles[0].file.contentBase64=Buffer.from('tampered').toString('base64'),r=>r.currentFiles[0].file.sha256='0'.repeat(64),r=>r.prefix='../']){
    const changed=structuredClone(record);change(changed);assert.throws(()=>apply(changed));
  }
  for(const change of [s=>s.attempt=1,s=>s.state='unknown',s=>s.cancellationRequested=true,s=>s.priorReview.verdict='approved',
    s=>s.receipts.push({...s.receipts[0],identity:{...s.receipts[0].identity,attempt:2}})]){
    const state=structuredClone(f.state);change(state);assert.throws(()=>apply(record,state));
  }
});
test('new scope refuses protected, requirement, ignored, dependency and case-alias additions',t=>{
  const f=fixture(t);
  for(const added of ['AGENTS.md','requirements.md','node_modules/test.js','Pods/test.swift','.build/temp.js','../escape','CODE.js'])
    assert.throws(()=>captureTaskReviewOrigin({...f.args,scope:[...f.scope,added].sort()}));
});

test('Git plumbing excludes repo-local executables and never runs configured hooks or content filters',t=>{
  const f=fixture(t),marker=path.join(f.directory,'executed'),bin=path.join(f.repo,'bin');fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin,'git'),`#!/bin/sh\necho unsafe > '${marker}'\nexit 1\n`,{mode:0o700});
  f.git(['config','core.fsmonitor',`echo unsafe > '${marker}'`]);
  f.git(['config','filter.origin-test.process',`echo unsafe > '${marker}'`]);
  f.git(['config','filter.origin-test.required','true']);
  fs.writeFileSync(path.join(f.root,'.gitattributes'),'*.js filter=origin-test\n');
  const oldPath=process.env.PATH;process.env.PATH=bin+path.delimiter+oldPath;
  try{const record=f.capture();assert.equal(record.prefix,'apps/fixture/');assert.equal(fs.existsSync(marker),false);}
  finally{process.env.PATH=oldPath;}
});
