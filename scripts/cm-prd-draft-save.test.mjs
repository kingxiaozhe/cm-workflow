import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
import {savePrdDraft} from '../runtime/js/cm-prd/draft-save.mjs';
function fixture(t){
  const specs=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-prd-save-')));
  t.after(()=>fs.rmSync(specs,{recursive:true,force:true}));
  const draft={summary:'Synthetic draft',features:[{name:'guide',directory:'1.guide',documents:[
    {path:'requirements.md',content:'# Requirements'}, {path:'design.md',content:'# Design'},
    {path:'tasks.md',content:'- [ ] T-001: Document'}, {path:'test-cases.json',content:'{"synthetic":true}'}]}]};
  draft.draftDigest=digest(draft);
  return {specs,draft,args:{specs,writeEnabled:true,getDraft:()=>draft}};
}
test('save exact Markdown and JSON, explicit identical resume, no approval',t=>{
  const {specs,draft,args}=fixture(t);const result=savePrdDraft(args);
  assert.equal(result.status,'draft_saved');assert.equal(result.artifacts.length,4);
  for(const document of draft.features[0].documents){
    const file=path.join(specs,'1.guide',document.path);
    assert.equal(fs.readFileSync(file,'utf8'),document.content);assert.equal(fs.statSync(file).mode&0o777,0o600);
  }
  assert.equal(savePrdDraft(args).status,'draft_saved');
  assert.equal(fs.existsSync(path.join(specs,'.cm-specs-status')),false);
  assert.equal(result.completionAuthorized,false);
});
test('disabled and conflict preflight produce zero new spec writes',t=>{
  const {specs,args}=fixture(t);assert.throws(()=>savePrdDraft({...args,writeEnabled:false}),/not_enabled/);
  assert.deepEqual(fs.readdirSync(specs),[]);fs.mkdirSync(path.join(specs,'1.guide'));
  fs.writeFileSync(path.join(specs,'1.guide/tasks.md'),'User content');
  assert.throws(()=>savePrdDraft(args),/save_conflict/);
  assert.deepEqual(fs.readdirSync(path.join(specs,'1.guide')),['tasks.md']);
});
test('partial save preserves evidence and only an explicit unchanged resume fills missing files',t=>{
  const {specs,args,draft}=fixture(t);let calls=0;
  const result=savePrdDraft({...args,getDraft:()=>{if(++calls===3)throw Error('interrupted');return draft;}});
  assert.equal(result.status,'draft_save_unknown');
  assert.deepEqual(fs.readdirSync(path.join(specs,'1.guide')),['requirements.md']);
  assert.equal(savePrdDraft(args).status,'draft_saved');
});
test('linked feature directory is rejected without following it',t=>{
  const {specs,args}=fixture(t);fs.mkdirSync(path.join(specs,'elsewhere'));
  fs.symlinkSync('elsewhere',path.join(specs,'1.guide'));
  assert.throws(()=>savePrdDraft(args),/init_draft_link/);
  assert.deepEqual(fs.readdirSync(path.join(specs,'elsewhere')),[]);
});

test('lossy surrogate encoding cannot change the draft during save',t=>{
  const {specs,args,draft}=fixture(t);draft.features[0].documents[0].content='Invalid \ud800';
  draft.draftDigest=digest({summary:draft.summary,features:draft.features});
  assert.throws(()=>savePrdDraft(args),/encoding_invalid/);
  assert.deepEqual(fs.readdirSync(specs),[]);
});

test('identical public-readable file is rejected without chmod or partial new writes',t=>{
  const {specs,args,draft}=fixture(t);fs.mkdirSync(path.join(specs,'1.guide'));
  const file=path.join(specs,'1.guide/tasks.md'),content=draft.features[0].documents[2].content;
  fs.writeFileSync(file,content);fs.chmodSync(file,0o644);
  assert.throws(()=>savePrdDraft(args),/save_permissions/);
  assert.deepEqual(fs.readdirSync(path.join(specs,'1.guide')),['tasks.md']);
  assert.equal(fs.readFileSync(file,'utf8'),content);assert.equal(fs.statSync(file).mode&0o777,0o644);
});
