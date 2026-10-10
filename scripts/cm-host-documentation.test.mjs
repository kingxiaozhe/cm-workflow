import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {withHostDocumentation} from '../runtime/js/cm-ai/host-documentation.mjs';
import {requestFor,terminalFor} from '../runtime/js/cm-ai/effect-contract.mjs';

for(const mode of ['write','unchanged','later-feature','out-of-scope','unapproved-path','cancel'])
test(`pre-review documentation uses only the final approved task: ${mode}`,async()=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-docs-')));
  try{
    const codeProject=path.join(root,'code'),specsDir=path.join(root,'specs');
    fs.mkdirSync(codeProject);fs.mkdirSync(path.join(specsDir,'1.feature'),{recursive:true});
    fs.writeFileSync(path.join(codeProject,'requirements.md'),'# Requirements\n');
    fs.writeFileSync(path.join(codeProject,'README.md'),'# Before\n');
    const features=mode==='later-feature'?['1.feature','2.later']:['1.feature'];
    for(const feature of features){
      fs.mkdirSync(path.join(specsDir,feature),{recursive:true});
      for(const name of ['requirements.md','design.md'])fs.writeFileSync(path.join(specsDir,feature,name),'# Fixture\n');
      fs.writeFileSync(path.join(specsDir,feature,'tasks.md'),'- [ ] T-001: implement\n');
    }
    fs.writeFileSync(path.join(specsDir,'.cm-specs-status'),JSON.stringify({status:'approved',features}));
    const identity={repositoryId:'docs',runId:'docs-test',taskId:'T-001',attempt:1};
    const request=requestFor({invocationId:'docs-1',identity,role:'developer',provider:'codex',
      requestedModel:'fixture',contextId:'author',payload:{scope:['README.md'],requirements:[{path:'requirements.md'}],priorReview:null}});
    const controller=new AbortController();let writes=0;
    const developer={provider:'codex',requestedModel:'fixture',contextId:'author',run:async()=>{
      if(mode==='cancel')controller.abort();
      return terminalFor({version:1,invocationId:request.invocationId,contextId:'author',provider:'codex',
        effectiveModel:'unknown',status:'succeeded',accepted:true,result:{outcome:'implemented'}},request);
    }};
    const build=()=>withHostDocumentation({developer,specsDir,codeProject,feature:'1.feature',scope:['README.md'],
      documentationSync:{paths:[mode==='unapproved-path'?'extra.md':'README.md'],run:async()=>{
        writes++;
        if(mode!=='unchanged')fs.writeFileSync(path.join(codeProject,mode==='out-of-scope'?'requirements.md':'README.md'),'# Updated\n');
        return {status:'completed'};
      }}});
    if(mode==='unapproved-path')assert.throws(build,{code:'documentation_scope_required'});
    else if(['out-of-scope','cancel'].includes(mode))await assert.rejects(build().run(request,{signal:controller.signal}),
      {code:mode==='cancel'?'cancelled':'out_of_scope'});
    else assert.equal((await build().run(request,{signal:controller.signal})).status,'succeeded');
    assert.equal(writes,['later-feature','unapproved-path','cancel'].includes(mode)?0:1);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

// Q16/Q17: the adapter reports the developer answer and the documentation start
// before it asks the sync, names out-of-scope paths, tells an invalid answer from
// a blocked one, and a documentation-only redo never calls the developer.
for(const mode of ['journal','invalid','blocked','out-of-scope','redo'])
test(`documentation sync recovery contract: ${mode}`,async()=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-docs-')));
  try{
    const codeProject=path.join(root,'code'),specsDir=path.join(root,'specs');
    fs.mkdirSync(codeProject);fs.mkdirSync(path.join(specsDir,'1.feature'),{recursive:true});
    fs.writeFileSync(path.join(codeProject,'requirements.md'),'# Requirements\n');
    fs.writeFileSync(path.join(codeProject,'README.md'),'# Before\n');
    fs.writeFileSync(path.join(codeProject,'a.js'),'one\n');
    for(const name of ['requirements.md','design.md'])fs.writeFileSync(path.join(specsDir,'1.feature',name),'# Fixture\n');
    fs.writeFileSync(path.join(specsDir,'1.feature','tasks.md'),'- [ ] T-001: implement\n');
    fs.writeFileSync(path.join(specsDir,'.cm-specs-status'),JSON.stringify({status:'approved',features:['1.feature']}));
    const identity={repositoryId:'docs',runId:'docs-test',taskId:'T-001',attempt:1};
    const request=requestFor({invocationId:'docs-1',identity,role:'developer',provider:'codex',
      requestedModel:'fixture',contextId:'author',payload:{scope:['README.md','a.js'],requirements:[{path:'requirements.md'}],priorReview:null}});
    let developerCalls=0;const events=[];
    const developer={provider:'codex',requestedModel:'fixture',contextId:'author',run:async()=>{
      developerCalls++;
      return {version:1,invocationId:request.invocationId,contextId:'author',provider:'codex',
        effectiveModel:'model-x',status:'succeeded',accepted:true,result:{outcome:'implemented'}};
    }};
    const adapter=withHostDocumentation({developer,specsDir,codeProject,feature:'1.feature',scope:['README.md','a.js'],
      documentationSync:{paths:['README.md'],run:async()=>{
        fs.writeFileSync(path.join(codeProject,'README.md'),'# After\n');
        if(mode==='out-of-scope')fs.writeFileSync(path.join(codeProject,'a.js'),'two\n');
        return mode==='invalid'?{status:'done'}:mode==='blocked'?{status:'blocked'}:{status:'completed'};
      }}});
    const control={signal:new AbortController().signal,onDocumentationSync:event=>events.push(event),
      ...(mode==='redo'?{documentationRedo:{result:{outcome:'implemented'},effectiveModel:'model-y'}}:{})};
    if(['journal','redo'].includes(mode)){
      const response=await adapter.run(request,control);
      assert.equal(response.status,'succeeded');assert.equal(response.effectiveModel,mode==='redo'?'model-y':'model-x');
    }else await assert.rejects(adapter.run(request,control),mode==='out-of-scope'?{code:'out_of_scope',message:'out_of_scope: a.js'}
      :{code:mode==='invalid'?'documentation_sync_answer_invalid':'documentation_sync_blocked'});
    assert.equal(developerCalls,mode==='redo'?0:1);
    assert.equal(events.length,1);
    assert.deepEqual(Object.keys(events[0]).sort(),['documents','effectiveModel','othersDigest','result']);
    assert.equal(events[0].documents.length,1);assert.equal(events[0].documents[0].path,'README.md');
    assert.match(events[0].documents[0].sha256,/^[a-f0-9]{64}$/);assert.match(events[0].othersDigest,/^[a-f0-9]{64}$/);
    const {captureDocumentationState}=await import('../runtime/js/cm-ai/host-documentation.mjs');
    const now=captureDocumentationState({root:codeProject,specsRoot:specsDir,identity,paths:['README.md'],requirements:['requirements.md']});
    assert.notEqual(now.documents[0].sha256,events[0].documents[0].sha256,'the sync wrote README.md after the recorded start');
    assert.equal(now.othersDigest===events[0].othersDigest,mode!=='out-of-scope');
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
