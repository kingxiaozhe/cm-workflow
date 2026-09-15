import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {captureReviewBaseline,createReviewPackage,verifyReviewPackage,readReviewSourceFiles} from '../runtime/js/cm-ai/review-package.mjs';
import {digest} from '../runtime/js/cm-ai/contracts.mjs';

function fixture(t){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-dependency-snapshot-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'src'));
  fs.writeFileSync(path.join(root,'src/main.py'),'before');
  fs.writeFileSync(path.join(root,'requirements.md'),'preserve CLI error contract');
  const options={root,identity:{repositoryId:'fixture',runId:'deps',taskId:'T-001',attempt:1},scope:['src/main.py'],requirements:['requirements.md']};
  return {root,options};
}
const checks=[{id:'unit',command:['test'],outcome:'passed',exitCode:0,evidence:'synthetic passing result'}];

test('dependency directories and nested Python caches do not enter business snapshots',t=>{
  const {root,options}=fixture(t);
  for(const folder of ['.venv','node_modules','src/__pycache__','.pytest_cache','.ruff_cache']){
    fs.mkdirSync(path.join(root,folder),{recursive:true});
    fs.symlinkSync('/nonexistent/synthetic-dependency',path.join(root,folder,'link'));
  }
  const baseline=captureReviewBaseline(options);
  assert.deepEqual(baseline.files.map(f=>f.path),['requirements.md','src/main.py']);
  fs.writeFileSync(path.join(root,'src/main.py'),'after');
  const pkg=createReviewPackage({root,baseline,checks});
  fs.writeFileSync(path.join(root,'.venv','cache'),'generated after review');
  assert.equal(verifyReviewPackage({root,baseline,checks,reviewPackage:pkg,expectedDigest:pkg.packageDigest}).outcome,'matched');
  fs.writeFileSync(path.join(root,'unexpected.py'),'business drift');
  assert.throws(()=>createReviewPackage({root,baseline,checks}),{code:'out_of_scope'});
});

test('excluded directories cannot be selected as business edits or requirements',t=>{
  const {root,options}=fixture(t);
  fs.mkdirSync(path.join(root,'.venv'));
  fs.writeFileSync(path.join(root,'.venv','value.py'),'dependency');
  for(const field of ['scope','requirements']){
    for(const selected of ['.venv/value.py','src/node_modules/new.js','.VENV/new.py','src/Node_Modules/new.js'])
      assert.throws(()=>captureReviewBaseline({...options,[field]:[selected]}),{code:'excluded_snapshot_path'});
  }
});

test('dependency root symlinks and business symlinks remain rejected',t=>{
  const {root,options}=fixture(t);
  for(const name of ['.venv','src/linked.py']){
    fs.symlinkSync('requirements.md',path.join(root,name));
    assert.throws(()=>captureReviewBaseline(options),{code:'unsupported_file'});
    fs.unlinkSync(path.join(root,name));
  }
});

test('legacy baselines retain already-recorded dependency files and their drift checks',t=>{
  const {root,options}=fixture(t);
  const base=captureReviewBaseline(options);
  fs.mkdirSync(path.join(root,'.venv'));
  fs.writeFileSync(path.join(root,'.venv','recorded.txt'),'legacy snapshot material');
  const {baselineDigest,...body}=base;
  body.files=[...body.files,...readReviewSourceFiles(root,['.venv/recorded.txt'])].sort((a,b)=>a.path.localeCompare(b.path));
  const baseline={...body,baselineDigest:digest(body)};
  fs.writeFileSync(path.join(root,'src/main.py'),'after');
  assert.equal(createReviewPackage({root,baseline,checks}).changes.length,1);
  fs.writeFileSync(path.join(root,'.venv','recorded.txt'),'changed');
  assert.throws(()=>createReviewPackage({root,baseline,checks}),{code:'out_of_scope'});
});
