import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {isFixMapPath,prepareFixRepair} from '../runtime/js/cm-fix/repair.mjs';
import {createFixRedTest} from '../runtime/js/cm-fix/red-test.mjs';
import {createFixBaseline} from '../runtime/js/cm-fix/baseline.mjs';
import {createHostToolBridge} from '../runtime/js/cm-ai/host-tool-bridge.mjs';

const maps=['00-index','06-core-modules','09-changelog'].map(name=>`mobile/docs/codebase-context/${name}.md`);

async function fixture(action){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'fix-monorepo-map-')));
  const cwd=path.join(root,'code'),specsRoot=path.join(root,'specs');
  fs.mkdirSync(cwd);fs.mkdirSync(path.join(specsRoot,'.reviews'),{recursive:true});
  const write=(file,body)=>{fs.mkdirSync(path.dirname(path.join(cwd,file)),{recursive:true});fs.writeFileSync(path.join(cwd,file),body);};
  write('value.mjs','export const value=1;');
  write('red.mjs',"import {value} from './value.mjs';if(value!==2){console.error('TARGET BUG');process.exit(1)}");
  write('existing.mjs',"import {value} from './value.mjs';if(typeof value!=='number')process.exit(1)");
  for(const file of maps)write(file,'# Previous map');
  const identity={repositoryId:'fixture',runId:'monorepo-map',taskId:'T-FIX-map',attempt:1};
  const signal=new AbortController().signal,bridge=createHostToolBridge();
  try{
    const redTest={cwd,testFiles:['red.mjs'],command:[process.execPath,'red.mjs'],expectedFailure:{exitCode:1,outputIncludes:'TARGET BUG'},timeoutMs:2000};
    const baseline={cwd,testFiles:['existing.mjs'],commands:[{id:'existing',command:[process.execPath,'existing.mjs']}],timeoutMs:2000};
    const redEvidence=await createFixRedTest(redTest,{identity,specsRoot})({identity},{authorized:true,signal});
    const beforeBaseline=await createFixBaseline(baseline)({identity},{authorized:true,signal});
    const options={identity,specsRoot,codeProject:cwd,scope:['value.mjs',...maps],requirements:['value.mjs'],defect:'Wrong constant',
      diagnosis:{status:'diagnosed',affectedPaths:['value.mjs'],rootCause:'Wrong constant'},redTest,baseline,redEvidence,beforeBaseline};
    await action({root,cwd,write,options,bridge,signal,capabilities:{bridge,assertReviewReady(){}}});
  }finally{bridge.close();fs.rmSync(root,{recursive:true,force:true});}
}

test('monorepo map recognition keeps exact filenames and canonical developer paths',()=>{
  for(const prefix of ['', 'mobile/', 'packages/mobile/']){
    for(const name of ['00-index','01-overview','02-directory','03-architecture','04-api-routes','05-data-models',
      '06-core-modules','07-business-logic','08-conventions','09-changelog']){
      assert.equal(isFixMapPath(`${prefix}docs/codebase-context/${name}.md`),true);
    }
  }
  for(const file of [null,7,'mobile/docs/unrelated.md','mobile/docs/codebase-context/extra.md',
    'mobile/docs/codebase-context/00-index.md.bak','mobile/docs/codebase-context-extra/00-index.md',
    'mobile/docs/codebase-context/nested/00-index.md','mobile//docs/codebase-context/00-index.md',
    '../mobile/docs/codebase-context/00-index.md','mobile/../docs/codebase-context/00-index.md',
    '/mobile/docs/codebase-context/00-index.md','mobile\\docs/codebase-context/00-index.md',
    '.claude/docs/codebase-context/00-index.md','mobile/AGENTS.md/docs/codebase-context/00-index.md',
    'mobile/.cm-state/docs/codebase-context/00-index.md'])assert.equal(isFixMapPath(file),false,String(file));
});

test('real repair accepts only scoped subproject maps alongside diagnosed code',()=>fixture(async({options,bridge,signal,write,capabilities})=>{
  bridge.attach(row=>{
    if(row.type!=='host_request')return;
    assert.deepEqual(row.payload.scope,options.scope);
    write('value.mjs','export const value=2;');
    for(const file of maps)write(file,'# Updated map');
    bridge.accept({type:'host_result',sessionId:row.sessionId,callId:row.callId,requestDigest:row.requestDigest,result:{outcome:'repaired'}});
  });
  const repair=prepareFixRepair(options,capabilities);
  const result=await repair.execute({authorized:true,signal,register(){}});
  assert.deepEqual(result.changedFiles,[...maps,'value.mjs']);
  assert.equal(result.completionEligible,false);
}));

test('map exception never admits arbitrary documents or developer-protected paths',()=>fixture(({options,capabilities})=>{
  for(const file of ['mobile/docs/unrelated.md','mobile/docs/codebase-context/00-index.md.bak',
    'mobile/docs/codebase-context/nested/00-index.md']){
    assert.throws(()=>prepareFixRepair({...options,scope:['value.mjs',file]},capabilities),{code:'repair_scope_mismatch'});
  }
  for(const file of ['mobile/../docs/codebase-context/00-index.md','mobile//docs/codebase-context/00-index.md']){
    assert.throws(()=>prepareFixRepair({...options,scope:['value.mjs',file]},capabilities));
  }
  assert.throws(()=>prepareFixRepair({...options,scope:['value.mjs','.claude/docs/codebase-context/00-index.md']},capabilities),{code:'protected_scope'});
}));

test('legal map spelling does not authorize writes outside the original repair scope',()=>fixture(async({options,bridge,signal,write,capabilities})=>{
  const outside='packages/other/docs/codebase-context/00-index.md';
  assert.equal(isFixMapPath(outside),true);
  bridge.attach(row=>{
    if(row.type!=='host_request')return;
    write(outside,'# Unapproved map');
    bridge.accept({type:'host_result',sessionId:row.sessionId,callId:row.callId,requestDigest:row.requestDigest,result:{outcome:'repaired'}});
  });
  await assert.rejects(prepareFixRepair(options,capabilities).execute({authorized:true,signal,register(){}}),{code:'out_of_scope'});
}));

test('map exception retains snapshot symlink rejection',()=>fixture(({root,cwd,options,capabilities})=>{
  const target=path.join(root,'external-map.md');fs.writeFileSync(target,'# External');
  fs.rmSync(path.join(cwd,maps[0]));fs.symlinkSync(target,path.join(cwd,maps[0]));
  assert.throws(()=>prepareFixRepair(options,capabilities),{code:'unsupported_file'});
  assert.equal(fs.readFileSync(target,'utf8'),'# External');
}));
