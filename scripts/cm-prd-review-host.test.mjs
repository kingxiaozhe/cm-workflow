import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {preparePrdReview} from '../runtime/js/cm-prd/review-preparation.mjs';
import {runPrdHostReview} from '../runtime/js/cm-prd/review-host.mjs';
for(const mode of ['success','denied','disconnect','cancel','mode-switch'])test(`host review once: ${mode}`,async t=>{
  const specs=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-prd-review-host-')));
  t.after(()=>fs.rmSync(specs,{recursive:true,force:true}));
  const draft={draftDigest:'a'.repeat(64),features:[{directory:'1.guide',name:'guide',documents:[
    {path:'requirements.md',content:'## 功能需求\n1. [F-001] Guide'},
    {path:'design.md',content:'## 方案摘要\nGuide'},{path:'tasks.md',content:'- [ ] T-001: Guide'}]}]};
  const prepare=()=>preparePrdReview({specs,draft,stage:'split',feature:'1.guide'}),controller=new AbortController();
  let calls=0;
  const run=()=>runPrdHostReview({specs,prepared:prepare(),authorContextId:'author',writeEnabled:mode!=='denied',mode:'independent',
    revalidate:prepare,signal:controller.signal,review:async payload=>{
      calls++;
      if(mode==='disconnect')throw Error('Disconnected');
      if(mode==='cancel')controller.abort();
      return {reviewer:mode==='mode-switch'?'self-degraded':'codex-subagent',contextId:'reviewer',independent:true,
        at:'2026-09-08T00:00:00.000Z',result:{verdict:'approved',packageDigest:payload.package.packageDigest,
          examinedPaths:payload.examinedPaths,findings:[],summary:'Synthetic review'}};
    }});
  if(mode==='denied'){await assert.rejects(run());assert.equal(calls,0);assert.deepEqual(fs.readdirSync(specs),[]);return;}
  const result=await run();assert.equal(calls,1);
  assert.equal(result.status,mode==='success'?'review_recorded':mode==='cancel'?'review_cancelled':'review_unknown');
  const file=path.join(specs,'.reviews/prd-guide-split-r1.md');assert.equal(fs.existsSync(file),mode==='success');
  if(['disconnect','mode-switch'].includes(mode)){assert.equal((await run()).status,'review_existing');assert.equal(calls,1);}
});
