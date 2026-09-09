import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import {createFixReviewHost} from '../runtime/js/cm-fix/host-review.mjs';
import {configFingerprint} from '../runtime/js/cm-ai/codex-config.mjs';
import {claudeReviewFingerprint} from '../runtime/js/cm-ai/worker-claude.mjs';

for(const runtime of ['codex','claude'])test(`${runtime} fix assembly keeps child review permissions separate and lazy`,async()=>{
  const codeProject=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'fix-review-assembly-')));
  try{
    let workers=0;
    const model='synthetic',review={model,disabledSkills:[],preflight:runtime==='codex'
      ?{passed:true,cli_model:model,prompt_transport:'stdin',config_fingerprint:configFingerprint({cwd:codeProject,model,disabledSkills:[],promptTransport:'stdin'})}
      :{passed:true,provider:'claude',prompt_transport:'stdin',config_fingerprint:claudeReviewFingerprint({cwd:codeProject,model})}};
    const base={codeProject,hostContextId:'child-host',runtime,review,workerFactory:()=>{workers++;throw Error('No provider dispatch in this fixture');}};
    const binding={identity:{repositoryId:'fixture',runId:'child-run',taskId:'T-FIX-qa',attempt:1},packageDigest:'a'.repeat(64)};
    for(const allowed of ['--allow-cause-review','--allow-final-review']){
      const permissions=[allowed],host=createFixReviewHost({...base,permissions});
      permissions.push(allowed==='--allow-cause-review'?'--allow-final-review':'--allow-cause-review');
      const signal=new AbortController().signal;
      assert.equal((await host.authority.hostDecisionProvider.decide(binding,signal)).status,
        allowed==='--allow-cause-review'?'approved':'denied');
      assert.equal((await host.finalAuthority.hostDecisionProvider.decide(binding,signal)).status,
        allowed==='--allow-final-review'?'approved':'denied');
      assert.equal(host.reviewer.provider,runtime);host.execution.assertReviewReady();
    }
    assert.throws(()=>createFixReviewHost({...base,review:null,permissions:['--allow-repair']}),{code:'review_configuration_required'});
    assert.throws(()=>createFixReviewHost({...base,review:{...review,preflight:{...review.preflight,passed:false}},
      permissions:['--allow-final-review']}),{code:'tool_preflight_missing'});
    assert.equal(workers,0);
  }finally{fs.rmSync(codeProject,{recursive:true,force:true});}
});
