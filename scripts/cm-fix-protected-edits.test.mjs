import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {applyProtectedEdits,protectedFixBridge} from '../runtime/js/cm-fix/protected-edits.mjs';

test('protected text edits validate whole scope and original bytes before any write',()=>{
  const cwd=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-edit-fixture-')));
  const hash=text=>createHash('sha256').update(text).digest('hex');
  const base={path:'a.mjs',beforeSha256:hash('old'),content:'new'};
  fs.writeFileSync(path.join(cwd,'a.mjs'),'old');
  try{
    for(const edit of [{...base,path:'outside.mjs'},{...base,beforeSha256:hash('stale')},
      {path:'AGENTS.md',beforeSha256:null,content:'bad'}]){
      assert.throws(()=>applyProtectedEdits({cwd,scope:['a.mjs'],edits:[edit]}));
      assert.equal(fs.readFileSync(path.join(cwd,'a.mjs'),'utf8'),'old');
    }
    fs.symlinkSync('a.mjs',path.join(cwd,'linked.mjs'));
    assert.throws(()=>applyProtectedEdits({cwd,scope:['a.mjs','linked.mjs'],edits:[base,
      {path:'linked.mjs',beforeSha256:hash('old'),content:'bad'}]}),{code:'unsupported_path'});
    assert.equal(fs.readFileSync(path.join(cwd,'a.mjs'),'utf8'),'old');
    fs.linkSync(path.join(cwd,'a.mjs'),path.join(cwd,'hard.mjs'));
    assert.throws(()=>applyProtectedEdits({cwd,scope:['a.mjs'],edits:[base]}),{code:'protected_edit_invalid'});
    fs.unlinkSync(path.join(cwd,'hard.mjs'));
    applyProtectedEdits({cwd,scope:['a.mjs','tests/new.mjs'],edits:[base,{path:'tests/new.mjs',beforeSha256:null,content:'test'}]});
    assert.equal(fs.readFileSync(path.join(cwd,'a.mjs'),'utf8'),'new');
    applyProtectedEdits({cwd,scope:['a.mjs'],edits:[{...base,beforeSha256:hash('new'),content:null}]});
    assert(!fs.existsSync(path.join(cwd,'a.mjs')));
  }finally{fs.rmSync(cwd,{recursive:true,force:true});}
});

test('protected test-author response uses native edits and rejects late bytes, without a provider',async()=>{
  const cwd=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-edit-author-'))),specsRoot=path.join(cwd,'specs');
  fs.mkdirSync(specsRoot);let mode='normal';
  const bridge=protectedFixBridge({cwd,specsRoot,timeoutMs:5000,bridge:{call:async(kind,payload)=>{
    assert.equal(kind,'fix_test_author');assert.equal(payload.editMode,'protected-text-v1');
    if(mode==='blocked')return {outcome:'blocked',edits:[]};
    if(mode==='stale')fs.writeFileSync(path.join(cwd,'test.mjs'),'user edit');
    return {outcome:'authored',edits:[{path:'test.mjs',beforeSha256:payload.expected['test.mjs'],content:'// test\n'}]};
  }}});
  const payload={identity:{repositoryId:'test',runId:'protected-test',taskId:'T-FIX-test',attempt:1},
    codeProject:cwd,scope:['test.mjs'],instructions:'Only author this test.'};
  try{
    assert.deepEqual(await bridge.call('fix_test_author',payload,new AbortController().signal),{outcome:'authored'});
    assert.equal(fs.readFileSync(path.join(cwd,'test.mjs'),'utf8'),'// test\n');
    mode='blocked';assert.deepEqual(await bridge.call('fix_test_author',payload,new AbortController().signal),{outcome:'blocked'});
    mode='stale';await assert.rejects(bridge.call('fix_test_author',payload,new AbortController().signal),{code:'protected_edit_failed'});
    assert.equal(fs.readFileSync(path.join(cwd,'test.mjs'),'utf8'),'user edit');
    const controller=new AbortController();controller.abort();
    await assert.rejects(bridge.call('fix_test_author',payload,controller.signal),{code:'cancelled'});
  }finally{fs.rmSync(cwd,{recursive:true,force:true});}
});
