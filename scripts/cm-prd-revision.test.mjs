import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createCmPrdAnalysis} from '../runtime/js/cm-prd/analysis.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
for(const mode of ['repair','limit','scope'])test(`bounded self-check revision: ${mode}`,async t=>{
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-prd-revision-')));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));fs.mkdirSync(path.join(dir,'docs'));
  fs.writeFileSync(path.join(dir,'docs/input.md'),'Documentation request');let drafts=0,checks=0;
  const host=createCmPrdAnalysis({input:{skillDir:path.join(root,'skills/cm-prd'),project:dir,specs:dir},
    runtime:'codex',record:async()=>{},analyze:async()=>({status:'analyzed',summary:'Guide',sourcePaths:['docs/input.md'],openQuestions:[]}),
    generate:async payload=>{
      drafts++;assert.equal(payload.revision===null,drafts===1);
      return {status:'draft',summary:'Guide',features:[{name:mode==='scope'&&drafts===2?'outside':'guide',testCasesReason:'no_observable_behavior',
        documents:[{path:'requirements.md',content:'- [ ] [AC-001] Document setup.'},
          {path:'tasks.md',content:'- [ ] T-001: Update guide'},{path:'design.md',content:`# Design v${drafts}`}]}]};
    },checkContext:async({draft})=>{
      checks++;return {draftDigest:draft.draftDigest,features:draft.features.map(feature=>({directory:feature.directory,
        checks:draft.mechanicalSelfCheck.pending.map((id,index)=>({id,status:index===0&&(checks===1||mode==='limit')?'failed':'passed',
          evidence:['Synthetic context finding']}))}))};
    }});
  await host.advance('Analyze');await host.plan('Draft');assert.equal((await host.verify()).stage,'self_check_failed');
  if(mode==='scope'){await assert.rejects(host.plan('Fix findings'),/prd_revision_scope_changed/);return;}
  await host.plan('Fix findings');const result=await host.verify();
  assert.equal(result.stage,mode==='repair'?'self_check_reported_passed':'self_check_needs_human');
  assert.equal(result.selfCheckRound,2);assert.equal(result.selfCheckHistory.length,1);
  await assert.rejects(host.plan('Again'));await assert.rejects(host.verify());
  assert.equal(drafts,2);assert.equal(checks,2);assert.deepEqual(fs.readdirSync(dir),['docs']);
});
