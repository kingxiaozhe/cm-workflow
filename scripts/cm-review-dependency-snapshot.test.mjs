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
  const pkg=createReviewPackage({root,baseline,checks});
  assert.equal(verifyReviewPackage({root,baseline,checks,reviewPackage:pkg,expectedDigest:pkg.packageDigest}).outcome,'matched');
  const {unchangedScope,packageDigest,...legacyBody}=pkg;
  const legacyPackage={...legacyBody,packageDigest:digest(legacyBody)};
  assert.equal(verifyReviewPackage({root,baseline,checks,reviewPackage:legacyPackage,expectedDigest:legacyPackage.packageDigest}).outcome,'matched');
  const corrupt=structuredClone(body);
  corrupt.files.find(file=>file.path==='.venv/recorded.txt').contentBase64=Buffer.from('forged').toString('base64');
  assert.throws(()=>createReviewPackage({root,baseline:{...corrupt,baselineDigest:digest(corrupt)},checks}),{code:'invalid_baseline'});
  fs.writeFileSync(path.join(root,'.venv','recorded.txt'),'changed');
  assert.throws(()=>createReviewPackage({root,baseline,checks}),{code:'out_of_scope'});
  fs.unlinkSync(path.join(root,'.venv','recorded.txt'));
  assert.throws(()=>createReviewPackage({root,baseline,checks}),{code:'out_of_scope'});
});

function installCocoaPods(root,prefix){
  const pods=path.join(root,prefix);
  fs.mkdirSync(path.join(pods,'Headers/Private/DoubleConversion/double-conversion'),{recursive:true});
  fs.mkdirSync(path.join(pods,'Pods.xcodeproj'));
  fs.writeFileSync(path.join(pods,'Manifest.lock'),'PODFILE CHECKSUM: synthetic');
  fs.writeFileSync(path.join(path.dirname(pods),'Podfile.lock'),'PODFILE CHECKSUM: synthetic');
  fs.writeFileSync(path.join(pods,'DoubleConversion.h'),'generated pod header');
  fs.symlinkSync('../../../../DoubleConversion.h',path.join(pods,'Headers/Private/DoubleConversion/double-conversion/bignum-dtoa.h'));
  return pods;
}

test('generated CocoaPods trees stay out of the snapshot instead of blocking it',t=>{
  const {root,options}=fixture(t);
  installCocoaPods(root,'mobile/ios/Pods');
  const baseline=captureReviewBaseline(options);
  // Podfile.lock is authored and checked in; only the generated tree disappears.
  assert.deepEqual(baseline.files.map(f=>f.path),
    ['mobile/ios/Podfile.lock','requirements.md','src/main.py']);
  fs.writeFileSync(path.join(root,'src/main.py'),'after');
  const pkg=createReviewPackage({root,baseline,checks});
  assert.equal(verifyReviewPackage({root,baseline,checks,reviewPackage:pkg,expectedDigest:pkg.packageDigest}).outcome,'matched');
  for(const field of ['scope','requirements'])
    assert.throws(()=>captureReviewBaseline({...options,[field]:['mobile/ios/Pods/DoubleConversion.h']}),{code:'excluded_snapshot_path'});
});

test('an authored pods directory is still snapshotted and its symlinks still fail closed',t=>{
  const {root,options}=fixture(t);
  fs.mkdirSync(path.join(root,'src/pods'),{recursive:true});
  fs.writeFileSync(path.join(root,'src/pods/scheduler.py'),'business code');
  assert.deepEqual(captureReviewBaseline(options).files.map(f=>f.path),
    ['requirements.md','src/main.py','src/pods/scheduler.py']);
  fs.symlinkSync('../../requirements.md',path.join(root,'src/pods/linked.py'));
  assert.throws(()=>captureReviewBaseline(options),{code:'unsupported_file'});
});

test('a Pods directory missing any one CocoaPods artefact keeps the symlink guard',t=>{
  for(const missing of ['Pods/Manifest.lock','Pods/Pods.xcodeproj','Podfile.lock']){
    const {root,options}=fixture(t);
    installCocoaPods(root,'mobile/ios/Pods');
    fs.rmSync(path.join(root,'mobile/ios',missing),{recursive:true,force:true});
    assert.throws(()=>captureReviewBaseline(options),{code:'unsupported_file'},missing);
  }
});

// The traversal and the scope guard must ask one predicate, not two that agree
// by coincidence. They once did not: the traversal probed every directory for
// the generated entries while the guard additionally required the name "pods".
// A directory called src/ holding an empty Manifest.lock and an empty
// Pods.xcodeproj/ was then skipped whole — taking a file explicitly declared in
// scope out of the review with no error raised anywhere.
test('a directory that is not named pods is never treated as a generated tree',t=>{
  const {root,options}=fixture(t);
  fs.writeFileSync(path.join(root,'src/Manifest.lock'),'');
  fs.mkdirSync(path.join(root,'src/Pods.xcodeproj'));
  fs.writeFileSync(path.join(root,'Podfile.lock'),'');
  const baseline=captureReviewBaseline(options);
  assert.ok(baseline.files.some(f=>f.path==='src/main.py'),
    'a declared scope file was silently dropped from the snapshot');
  // A file added inside the disguise must stay visible: out_of_scope is the
  // snapshot seeing it and refusing it, which is the opposite of vanishing.
  fs.writeFileSync(path.join(root,'src/added.py'),'new');
  fs.writeFileSync(path.join(root,'src/main.py'),'after');
  assert.throws(()=>createReviewPackage({root,baseline,checks}),{code:'out_of_scope'},
    'a file added after the baseline stayed invisible to the review package');
});

// Whatever the predicate accepts leaves the review silently, so the two callers
// must never diverge again. Assert they are the same predicate, not two rules.
test('the scope guard rejects exactly what the traversal skips',t=>{
  const {root,options}=fixture(t);
  installCocoaPods(root,'mobile/ios/Pods');
  assert.deepEqual(captureReviewBaseline(options).files.map(f=>f.path),
    ['mobile/ios/Podfile.lock','requirements.md','src/main.py']);
  for(const field of ['scope','requirements'])
    assert.throws(()=>captureReviewBaseline({...options,[field]:['mobile/ios/Pods/DoubleConversion.h']}),
      {code:'excluded_snapshot_path'},field);
  // Remove one artefact: the tree comes back into the snapshot, and the guard
  // must stop rejecting it in the same step.
  fs.rmSync(path.join(root,'mobile/ios/Podfile.lock'));
  fs.rmSync(path.join(root,'mobile/ios/Pods/Headers'),{recursive:true,force:true});
  assert.ok(captureReviewBaseline(options).files.some(f=>f.path==='mobile/ios/Pods/DoubleConversion.h'));
  assert.deepEqual(captureReviewBaseline({...options,scope:['mobile/ios/Pods/DoubleConversion.h']})
    .files.some(f=>f.path==='mobile/ios/Pods/DoubleConversion.h'),true);
});
