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
