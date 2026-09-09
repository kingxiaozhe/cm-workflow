import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
import {captureReviewBaseline,createReviewPackage} from '../runtime/js/cm-ai/review-package.mjs';
import {prepareFixLearningWriteback,fixLearningReviewBaseline,inspectFixLearningReviewPackage} from '../runtime/js/cm-fix/learning-writeback.mjs';

test('fix writeback reuses the existing merge, requires registration and preserves pending versus written',()=>{
  for(const status of ['no_new_lesson','lesson_candidate','writeback_pending']){
    const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'fix-learning-writeback-')));
    try{
      const original='# Project\n\nKeep this instruction.\n';fs.writeFileSync(path.join(root,'AGENTS.md'),original);
      fs.writeFileSync(path.join(root,'value.mjs'),'export const value=1;');
      const identity={repositoryId:'fixture',runId:'writeback',taskId:'T-FIX-demo',attempt:1};
      const files=[{scope:'project',path:'AGENTS.md',sha256:createHash('sha256').update(original).digest('hex')}];
      const learning={files,contextDigest:digest(files),application:{contextDigest:digest(files),status:'no_relevant_lesson',summary:'Fixture'}};
      const baseline=captureReviewBaseline({root,identity,scope:['value.mjs'],requirements:['value.mjs']});
      fs.writeFileSync(path.join(root,'value.mjs'),'export const value=2;');
      const reviewPackage=createReviewPackage({root,baseline,checks:[{id:'fixture',command:['synthetic'],outcome:'passed',exitCode:0,evidence:'Synthetic package only'}]});
      const content={status,candidates:status==='no_new_lesson'?[]:[{classification:'memory_only',trigger:'Wrong constant',action:'Inspect expected value',evidence:['value.mjs']}],reason:status==='writeback_pending'?'Evidence needs human assessment':null};
      const retrospective={identity,learningDigest:digest(learning),packageDigest:reviewPackage.packageDigest,content,completionEligible:false};
      const options={identity,codeProject:root,learning,retrospective,baseline,reviewPackage};
      const writer=prepareFixLearningWriteback(options);let registered=0;
      assert.throws(()=>writer.execute({register(){}}),{code:'learning_writeback_authorization_required'});
      const result=writer.execute({authorized:true,register(binding){assert.equal(binding.retrospectiveDigest,digest(retrospective));assert.equal(fs.readFileSync(path.join(root,'AGENTS.md'),'utf8'),original);registered++;}});
      assert.equal(registered,1);assert.equal(result.completionEligible,false);
      assert.equal(result.outcome,status==='lesson_candidate'?'written':status);
      const after=fs.readFileSync(path.join(root,'AGENTS.md'),'utf8');assert(after.startsWith(original));
      if(status==='lesson_candidate'){assert(after.includes('## 项目教训'));assert(after.includes('[仅记忆]'));}
      else assert.equal(after,original);
      assert.throws(()=>writer.execute({authorized:true,register(){}}),{code:'learning_writeback_already_attempted'});
      fs.writeFileSync(path.join(root,'value.mjs'),'export const value=3;');
      assert.throws(()=>prepareFixLearningWriteback(options));
    }finally{fs.rmSync(root,{recursive:true,force:true});}
  }
});

test('cumulative Learning packages retain prior lessons for append and deduplicated writeback',()=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'fix-learning-cumulative-')));
  try{
    const original='# Project\n\nKeep this instruction.\n';
    fs.writeFileSync(path.join(root,'AGENTS.md'),original);fs.writeFileSync(path.join(root,'value.mjs'),'export const value=1;');
    const identity={repositoryId:'fixture',runId:'cumulative',taskId:'T-FIX-demo',attempt:2};
    const baseline=fixLearningReviewBaseline(captureReviewBaseline({root,identity,scope:['value.mjs'],requirements:['value.mjs']}));
    fs.writeFileSync(path.join(root,'value.mjs'),'export const value=2;');
    const checks=[{id:'fixture',command:['synthetic'],outcome:'passed',exitCode:0,evidence:'Synthetic package only'}];
    const content={status:'lesson_candidate',candidates:[{classification:'memory_only',trigger:'Wrong constant',action:'Inspect expected value',evidence:['value.mjs']}],reason:null};
    const write=content=>{
      const reviewPackage=createReviewPackage({root,baseline,checks});
      const files=[{scope:'project',path:'AGENTS.md',sha256:createHash('sha256').update(fs.readFileSync(path.join(root,'AGENTS.md'))).digest('hex')}];
      const learning={files,contextDigest:digest(files),application:{contextDigest:digest(files),status:'no_relevant_lesson',summary:'Fixture'}};
      const retrospective={identity,learningDigest:digest(learning),packageDigest:reviewPackage.packageDigest,content,completionEligible:false};
      const writer=prepareFixLearningWriteback({identity,codeProject:root,learning,retrospective,baseline,reviewPackage});
      const writeback=writer.execute({authorized:true,register(){}});
      const pkg=createReviewPackage({root,baseline,checks});
      inspectFixLearningReviewPackage(pkg,{baseline,previous:reviewPackage,writeback});
      return {pkg,writeback,previous:reviewPackage};
    };
    const first=write(content);assert.equal(first.writeback.outcome,'written');
    const repeated=write(content);assert.equal(repeated.writeback.outcome,'deduplicated');assert.deepEqual(repeated.pkg,first.pkg);
    const next=write({...content,candidates:[{...content.candidates[0],trigger:'Second boundary',action:'Preserve earlier lessons'}]});
    assert.equal(next.writeback.outcome,'written');
    const changed=next.pkg.changes.find(file=>file.path==='AGENTS.md');
    assert.equal(Buffer.from(changed.before.contentBase64,'base64').toString(),original);
    const after=Buffer.from(changed.after.contentBase64,'base64').toString();assert(after.includes('Wrong constant'));assert(after.includes('Second boundary'));
    fs.chmodSync(path.join(root,'value.mjs'),0o755);
    const forged=createReviewPackage({root,baseline,checks});
    assert.throws(()=>inspectFixLearningReviewPackage(forged,{baseline,previous:next.previous,writeback:next.writeback}),{code:'writeback_package_mismatch'});
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
