import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createFixLearningPreparation} from '../runtime/js/cm-fix/learning.mjs';
import {openFixExecution} from '../runtime/js/cm-fix/execution.mjs';
import {createHostToolBridge} from '../runtime/js/cm-ai/host-tool-bridge.mjs';

test('fix learning rereads nested instructions on resume and preserves reproduction history',async()=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'fix-learning-')));
  const cwd=path.join(root,'code'),specsRoot=path.join(root,'specs');fs.mkdirSync(cwd);fs.mkdirSync(specsRoot);
  fs.mkdirSync(path.join(cwd,'src'));fs.writeFileSync(path.join(cwd,'src','AGENTS.md'),'First instruction');
  const identity={repositoryId:'fixture',runId:'learning-run',taskId:'T-FIX-learning',attempt:1};
  const options={specsRoot,identity,create:true,configuration:{hostContextId:'fixture-host',defect:'Synthetic',applicableAgentFiles:['src/AGENTS.md'],
    reproduction:{cwd,command:[process.execPath,'-e',"require('node:fs').appendFileSync('visits','1');process.stderr.write('BUG');process.exit(3)"],
      expectedFailure:{exitCode:3,outputIncludes:'BUG'},timeoutMs:2000}}};
  const seen=[];const bridge={async call(kind,payload){
    assert.equal(kind,'fix_learning');seen.push(payload.context);
    return {contextDigest:payload.contextDigest,status:'applied',summary:'src/AGENTS.md: preserve exact reproduction evidence'};
  }};
  const prepare=createFixLearningPreparation({bridge,codeProject:cwd,applicableAgentFiles:['src/AGENTS.md']});
  let owner;
  try{
    owner=openFixExecution(options,{prepare});assert.equal((await owner.advance({authorized:true})).stage,'diagnose');
    const before=owner.status().learning.contextDigest;owner.close();
    owner=null;
    assert.throws(()=>openFixExecution({...options,create:false,configuration:{...options.configuration,applicableAgentFiles:[]}}),
      {code:'fingerprint_mismatch'});
    fs.writeFileSync(path.join(cwd,'src','AGENTS.md'),'Second instruction');
    // A diagnosis bridge is supplied only now, so the recovered pending stage can proceed.
    const diagnosisBridge={async call(){return {status:'needs_evidence',rootCause:'Need more evidence',
      affectedPaths:['src/value.mjs'],affectedModules:['src'],plan:'Observe next failure',crossLayer:false};}};
    owner=openFixExecution({...options,create:false},{prepare,bridge:diagnosisBridge});
    assert.equal((await owner.advance({authorized:true})).stage,'observation');
    const observed=owner.publishDossier();assert.equal(observed.stage,'observation');assert.equal(observed.completionEligible,false);
    assert.match(fs.readFileSync(observed.dossier.path,'utf8'),/Observe next failure/);
    assert.match(fs.readFileSync(observed.dossier.path,'utf8'),/needs_evidence/);
    assert.notEqual(owner.status().learning.contextDigest,before);
    assert.equal(seen[1][0].content,'Second instruction');
    assert.equal(fs.readFileSync(path.join(cwd,'visits'),'utf8'),'1');
    owner.close();owner=null;
    const unanswered=createHostToolBridge();unanswered.attach(()=>{});
    owner=openFixExecution({...options,identity:{...identity,runId:'learning-timeout'},configuration:{...options.configuration,
      reproduction:{...options.configuration.reproduction,timeoutMs:25}}},
    {prepare:createFixLearningPreparation({bridge:unanswered,codeProject:cwd,applicableAgentFiles:['src/AGENTS.md']})});
    try{
      await assert.rejects(owner.advance({authorized:true}),{code:'fix_learning_interrupted'});
      assert.equal(owner.status().stage,'reproduce');
      assert.equal(fs.readFileSync(path.join(cwd,'visits'),'utf8'),'1');
    }finally{unanswered.close();}
    owner.close();owner=null;
    const mutate={async call(kind,payload){fs.writeFileSync(path.join(cwd,'src','AGENTS.md'),'Changed while reading');
      return {contextDigest:payload.contextDigest,status:'no_relevant_lesson',summary:'No relevant lesson'};}};
    await assert.rejects(createFixLearningPreparation({bridge:mutate,codeProject:cwd,applicableAgentFiles:['src/AGENTS.md']})
      ({identity,defect:'Synthetic'},new AbortController().signal),{code:'fix_learning_context_changed'});
    const fresh={...options,identity:{...identity,runId:'learning-failed'}};
    owner=openFixExecution(fresh,{prepare:createFixLearningPreparation({bridge:{async call(kind,payload){
      fs.writeFileSync(path.join(cwd,'src','AGENTS.md'),'Concurrent change during owner preparation');
      return {contextDigest:payload.contextDigest,status:'no_relevant_lesson',summary:'No relevant lesson'};
    }},codeProject:cwd,applicableAgentFiles:['src/AGENTS.md']})});
    await assert.rejects(owner.advance({authorized:true}),{code:'fix_learning_context_changed'});
    assert.equal(owner.status().stage,'reproduce');assert.equal(owner.status().learning,null);
    assert.equal(fs.readFileSync(path.join(cwd,'visits'),'utf8'),'1');
  }finally{owner?.close();fs.rmSync(root,{recursive:true,force:true});}
});
