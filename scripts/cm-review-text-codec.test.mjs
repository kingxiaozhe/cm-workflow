import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import * as review from '../runtime/js/cm-ai/review-package.mjs';
import {compactReviewData,expandReviewData} from '../runtime/js/cm-ai/review-presentation.mjs';
import {buildCodexReviewPrompt} from '../runtime/js/cm-ai/codex-review-adapter.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const identity={repositoryId:'codec-repo',runId:'codec-run',taskId:'T-001',attempt:1};
const checks=[{id:'codec',command:['node','--test'],outcome:'passed',exitCode:0,evidence:'fixture'}];
const material=Buffer.from('{"name":"fixture","integrity":"sha512-recorded","resolved":"https://registry.npmjs.org/fixture"}\n'.repeat(7000));
const inline=(name,bytes)=>({path:name,type:'file',mode:0o644,size:bytes.length,sha256:sha(bytes),contentBase64:bytes.toString('base64')});
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cm-text-codec-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.writeFileSync(path.join(root,'code.mjs'),'before\n');fs.writeFileSync(path.join(root,'requirements.md'),'approved\n');
  fs.writeFileSync(path.join(root,'package-lock.json'),material);fs.writeFileSync(path.join(root,'extra.json'),'{}\n');
  const original=review.captureReviewBaseline({root,identity,scope:['code.mjs'],requirements:['requirements.md']});
  const scope=['code.mjs','package-lock.json'];
  const sources=review.captureScopeRevisionSources(root,original,scope);
  return{root,original,sources,baseline:review.extendReviewBaseline(original,scope,sources)};
}
test('large scope material preserves exact bytes and full review text below the unchanged journal budget',t=>{
  const f=fixture(t),before=f.sources[0];
  assert.equal(typeof before.contentGzipBase64,'string');assert.equal(Object.hasOwn(before,'contentBase64'),false);
  assert.deepEqual(review.readReviewFileBytes(before),material);assert.equal(before.size,material.length);assert.equal(before.sha256,sha(material));
  assert.equal(review.readReviewSourceFiles(f.root,['package-lock.json'])[0].contentBase64,material.toString('base64'),'ordinary source API keeps its legacy encoding');
  const alternate=structuredClone(f.baseline),stored=Buffer.from(before.contentGzipBase64,'base64');
  stored.writeUInt32LE(1,4);alternate.files.find(row=>row.path==='package-lock.json').contentGzipBase64=stored.toString('base64');
  const {baselineDigest:oldDigest,...alternateBody}=alternate;alternate.baselineDigest=digest(alternateBody);
  assert.throws(()=>review.createReviewPackage({root:f.root,baseline:alternate,checks}),/empty_changes/,'gzip header differences are not source edits');
  const after=Buffer.from(material.toString().replace('"name":"fixture"','"name":"changed"'));
  fs.writeFileSync(path.join(f.root,'package-lock.json'),after);
  const pkg=review.createReviewPackage({root:f.root,baseline:f.baseline,checks});
  const change=pkg.changes.find(row=>row.path==='package-lock.json');
  assert.deepEqual(review.readReviewFileBytes(change.before),material);assert.deepEqual(review.readReviewFileBytes(change.after),after);
  assert(Buffer.byteLength(JSON.stringify(pkg))<1024*1024);assert(material.toString('base64').length+after.toString('base64').length>1024*1024);
  const projected=review.projectedReviewPackage({root:f.root,baseline:f.baseline,checks,scopeFiles:[{path:'package-lock.json',contentBase64:after.toString('base64'),mode:before.mode}]});
  assert.deepEqual(projected,pkg);
  const data={reviewPackage:pkg,priorReview:null,examinedPaths:pkg.changes.map(row=>row.path)};
  const presentation=compactReviewData(data);assert.deepEqual(expandReviewData(presentation),data);
  assert(Object.values(presentation.contents).some(row=>row.encoding==='utf8'&&row.content===after.toString('utf8')));
  const body={version:1,invocationId:'codec-review',identity,role:'reviewer',provider:'codex',requestedModel:'fixture',contextId:'codec-context',payload:{reviewPackage:pkg,priorReview:null}};
  const prompt=buildCodexReviewPrompt({...body,requestDigest:digest(body)});
  const shown=JSON.parse(prompt.split('<cm-review-data-json>\n')[1]);
  assert(shown.presentation,'compressed records always receive complete inline text, without an optional policy');
  assert.deepEqual(expandReviewData(shown).reviewPackage,pkg);
  assert(Object.values(shown.contents).some(row=>row.content===after.toString()));
  review.verifyReviewPackage({root:f.root,baseline:f.baseline,checks,reviewPackage:pkg,expectedDigest:pkg.packageDigest});
});
test('compressed record rejects malformed gzip, duplicate encoding, wrong size/hash, and excessive decoded bytes',t=>{
  const good=fixture(t).sources[0];
  for(const bad of [{...good,contentGzipBase64:'AAAA'},{...good,contentBase64:material.toString('base64')},
    {...good,size:good.size-1},{...good,sha256:'0'.repeat(64)},
    {...good,contentGzipBase64:gzipSync(Buffer.alloc(review.REVIEW_MATERIAL_LIMITS.file+1,97)).toString('base64')}])
    assert.throws(()=>review.readReviewSourceRecords([bad]));
  const old=inline('legacy.txt',Buffer.from('original inline evidence\n'));
  assert.deepEqual(review.readReviewFileBytes(old),Buffer.from('original inline evidence\n'));
  assert.deepEqual(review.readReviewSourceRecords([old]),[old]);
});
test('repeated scope additions retain earlier full material paths and legacy baseline comparison',t=>{
  const f=fixture(t);fs.writeFileSync(path.join(f.root,'extra.json'),'{}\n');
  const scope=[...f.baseline.scope,'extra.json'].sort();
  const extended=review.extendReviewBaseline(f.baseline,scope,review.captureScopeRevisionSources(f.root,f.baseline,scope));
  assert.deepEqual(extended.scopeRevisionPaths,['extra.json','package-lock.json']);
  const fresh=review.captureReviewBaseline({root:f.root,identity,scope:f.baseline.scope,requirements:['requirements.md']});
  // Scope-revision metadata is retained when a fresh snapshot is compared.
  const {baselineDigest,...body}=fresh;body.scopeRevisionPaths=f.baseline.scopeRevisionPaths;
  assert.equal(review.compareReviewBaseline({...body,baselineDigest:digest(body)},f.baseline),true);
});
