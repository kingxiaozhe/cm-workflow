import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {claimPrdReview,inspectPrdReview} from './cm-prd-review-gate.mjs';
const script=fileURLToPath(new URL('./cm-prd-review-gate.mjs',import.meta.url));
function fixture(t){
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-prd-claim-')));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));fs.mkdirSync(path.join(dir,'.reviews'));
  const args={stage:'split',feature:'guide',evidence:path.join(dir,'.reviews/prd-guide-split-r1.md'),
    receipt:path.join(dir,'.reviews/prd-guide-split-disposition.json'),package_sha256:'a'.repeat(64)};
  return {dir,args,file:path.join(dir,'.reviews/prd-guide-split-dispatch.json')};
}
test('persisted attempt prevents repeat and existing r1 resumes original disposition',t=>{
  const {args,file}=fixture(t);assert.equal(inspectPrdReview(args).outcome,'dispatch_once');
  const claimed=claimPrdReview(args);assert.equal(claimed.outcome,'dispatch_claimed');assert.equal(claimed.providerAuthorized,false);
  assert.equal(fs.statSync(file).mode&0o777,0o600);
  assert.deepEqual(inspectPrdReview(args),{stage:'split',feature:'guide',outcome:'dispatch_unknown',package_sha256:'a'.repeat(64)});
  assert.throws(()=>claimPrdReview(args),/already consumed/);
  fs.writeFileSync(args.evidence,'---\nat: 2026-09-08T00:00:00Z\nreviewer: codex-subagent\nindependent: true\nscope:\n  - 1.guide/tasks.md\n---\nSynthetic result');
  assert.equal(inspectPrdReview(args).outcome,'resume_disposition');
});
test('partial dispatch records remain blocking, never reset',t=>{
  const {args,file}=fixture(t);fs.writeFileSync(file,'{');
  assert.throws(()=>inspectPrdReview(args));assert.throws(()=>claimPrdReview(args));assert.equal(fs.readFileSync(file,'utf8'),'{');
});
test('two actual CLI processes can claim only once; fresh inspector sees unknown',async t=>{
  const {args}=fixture(t);
  const run=command=>new Promise((resolve,reject)=>{
    const flags=Object.entries(args).filter(([key])=>command==='claim'||key!=='package_sha256')
      .flatMap(([key,value])=>[`--${key.replaceAll('_','-')}`,value]);
    const child=spawn(process.execPath,[script,command,...flags]);let stdout='',stderr='';
    child.stdout.on('data',bytes=>{stdout+=bytes;});child.stderr.on('data',bytes=>{stderr+=bytes;});
    child.on('error',reject);child.on('close',code=>resolve({code,stdout,stderr}));
  });
  const results=await Promise.all([run('claim'),run('claim')]);assert.equal(results.filter(result=>result.code===0).length,1);
  const after=await run('inspect');assert.equal(after.code,0,after.stderr);
  assert.equal(JSON.parse(after.stdout).outcome,'dispatch_unknown');
});
