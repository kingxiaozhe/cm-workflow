import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {buildManifest} from './cm-spec-manifest.mjs';
import {createHostBootstrap,mergeBootstrapAgents} from '../runtime/js/cm-ai/host-bootstrap.mjs';
import {cmInitRuleTargets} from '../runtime/js/cm-init/draft-generation.mjs';

const workflowRoot=fileURLToPath(new URL('..',import.meta.url)).replace(/\/$/,'');
const selection={versionControl:'none',modules:[],analysis:'Fixture project'};

test('bootstrap AGENTS merge preserves existing Learning bytes and other constraints',()=>{
  const lesson='## 项目教训\r\n\r\n- **T-001 lesson**：原样保留。\r\n';
  const existing='# Existing rule\r\n\r\n'+lesson;
  const generated='# Generated rules\n\n# Existing rule\r\n\r\n';
  const merged=mergeBootstrapAgents(existing,generated);
  assert(merged.includes('# Existing rule\r\n\r\n'));
  assert(merged.includes(lesson));
  assert.equal(merged.split(lesson).length,2);
  assert.throws(()=>mergeBootstrapAgents(existing,'# Generated rules\n'),{code:'bootstrap_instruction_conflict'});
  assert.throws(()=>mergeBootstrapAgents(existing,generated+'## 项目教训\n- changed\n'),{code:'bootstrap_instruction_conflict'});
});

test('approved rule refresh replaces the rule body but preserves Learning bytes',()=>{
  const lesson='## 项目教训\r\n\r\n- **Earlier lesson**：逐字保留。\r\n';
  const existing='# Old rules\r\n\r\n'+lesson;
  const generated='# Updated rules\n\nNew approved invariant.\n';
  assert.equal(mergeBootstrapAgents(existing,generated,{refresh:true}),generated+'\n'+lesson);
  assert.throws(()=>mergeBootstrapAgents(existing,generated+'\n## 项目教训\n- rewritten\n',{refresh:true}),
    {code:'bootstrap_instruction_conflict'});
});

test('later same-feature rules task binds clean committed targets and rejects drift',t=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-bootstrap-refresh-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const specsDir=path.join(root,'specs'),codeProject=path.join(root,'code'),feature='1.bootstrap';
  fs.mkdirSync(path.join(specsDir,feature),{recursive:true});fs.mkdirSync(codeProject);
  for(const name of ['requirements.md','design.md'])fs.writeFileSync(path.join(specsDir,feature,name),'# Approved fixture\n');
  fs.writeFileSync(path.join(specsDir,feature,'tasks.md'),'- [x] T-001: 生成骨架 scaffold\n- [x] T-002: 生成 AGENTS.md 与 .claude/ 规则\n- [ ] T-010: 同步 AGENTS.md 与 .claude/ 规则\n');
  const targets=cmInitRuleTargets(selection);
  for(const file of targets){const target=path.join(codeProject,file);fs.mkdirSync(path.dirname(target),{recursive:true});
    fs.writeFileSync(target,file==='AGENTS.md'?'# Existing rules\n\n## 项目教训\n\n- Prior lesson\n':'# Existing rules\n');}
  const git=(...args)=>{const result=spawnSync('git',args,{cwd:codeProject,encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);return result.stdout.trim();};
  git('init','-q');git('config','user.email','fixture@example.test');git('config','user.name','Fixture');
  git('add','--',...targets);git('commit','-qm','Bootstrap rules');
  fs.writeFileSync(path.join(specsDir,'.cm-specs-status'),JSON.stringify({status:'approved',features:[feature],specFiles:buildManifest(specsDir)}));
  const identity={repositoryId:'fixture',runId:'refresh',taskId:'T-010',attempt:1};
  const definition={version:1,specsDir,codeProject,feature,identity,scope:targets,requirements:[]};
  const bootstrap=createHostBootstrap({definition,workflowRoot,selection,bridge:{call:async()=>{throw Error('unused');}},allowWrite:true});
  assert.equal(bootstrap.configuration.committedBasis.commit,git('rev-parse','HEAD'));
  assert.deepEqual(bootstrap.assertInstructionBaseline({identity,previous:null,previousWriteback:null}).originals.map(x=>x.path),targets);
  fs.writeFileSync(path.join(codeProject,'.claude/rules/testing.md'),'# Uncommitted change\n');
  assert.throws(()=>bootstrap.assertInstructionBaseline({identity,previous:null,previousWriteback:null}),
    {code:'bootstrap_instruction_conflict'});
  git('add','--','.claude/rules/testing.md');
  fs.writeFileSync(path.join(codeProject,'.claude/rules/testing.md'),'# Existing rules\n');
  assert.throws(()=>bootstrap.assertInstructionBaseline({identity,previous:null,previousWriteback:null}),
    {code:'bootstrap_instruction_conflict'});
  const unavailable=createHostBootstrap({definition,workflowRoot,selection,
    bridge:{call:async()=>{throw Error('unused');}},allowWrite:true});
  assert.equal(unavailable.configuration.committedBasisRequired,true);
  assert.deepEqual(unavailable.configuration.committedBasis,bootstrap.configuration.committedBasis);
  assert.throws(()=>unavailable.assertInstructionBaseline({identity,previous:null,previousWriteback:null}),
    {code:'bootstrap_instruction_conflict'});
  git('reset','-q','--','.claude/rules/testing.md');
  assert.deepEqual(unavailable.assertInstructionBaseline({identity,previous:null,previousWriteback:null})
    .originals.map(item=>item.path),targets);
  const marker=path.join(root,'git-config-executed'),driver=path.join(root,'git-driver');
  fs.writeFileSync(driver,`#!/bin/sh\ntouch '${marker}'\ncat\n`,{mode:0o700});
  fs.writeFileSync(path.join(codeProject,'.gitattributes'),'AGENTS.md filter=probe\n');
  git('config','core.fsmonitor',driver);
  git('config','filter.probe.clean',driver);
  git('config','filter.probe.process',driver);
  git('config','filter.probe.required','true');
  assert.deepEqual(unavailable.assertInstructionBaseline({identity,previous:null,previousWriteback:null})
    .originals.map(item=>item.path),targets);
  assert.equal(fs.existsSync(marker),false);
});

test('numbered approved bootstrap binds fixed rules targets and its own requirements',t=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-bootstrap-compat-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const specsDir=path.join(root,'specs'),codeProject=path.join(root,'code'),feature='1.bootstrap';
  fs.mkdirSync(path.join(specsDir,feature),{recursive:true});fs.mkdirSync(codeProject);
  for(const name of ['requirements.md','design.md'])fs.writeFileSync(path.join(specsDir,feature,name),'# Approved fixture\n');
  fs.writeFileSync(path.join(specsDir,feature,'tasks.md'),'- [x] T-001: 生成骨架 scaffold\n- [ ] T-002: 生成 AGENTS.md 与 .claude/ 规则\n');
  fs.writeFileSync(path.join(codeProject,'app.mjs'),'export const fixture=true;\n');
  fs.writeFileSync(path.join(specsDir,'.cm-specs-status'),JSON.stringify({status:'approved',features:[feature],specFiles:buildManifest(specsDir)}));
  const definition={version:1,specsDir,codeProject,feature,identity:{repositoryId:'fixture',runId:'rules',taskId:'T-002',attempt:1},
    scope:[...cmInitRuleTargets(selection)],requirements:[]};
  const bootstrap=createHostBootstrap({definition,workflowRoot,selection,bridge:{call:async()=>{throw Error('unused');}},allowWrite:true});
  assert.equal(bootstrap.configuration.feature,feature);
  assert.deepEqual(bootstrap.configuration.bootstrapRequirements.files.map(file=>file.path),
    [`${feature}/design.md`,`${feature}/requirements.md`]);
  assert(bootstrap.configuration.instructionPaths.includes('AGENTS.md'));
  assert(bootstrap.configuration.instructionPaths.includes('.claude/CLAUDE.md'));
  assert.throws(()=>createHostBootstrap({definition:{...definition,feature:'2.bootstrap'},workflowRoot,
    selection,bridge:{call:async()=>{throw Error('unused');}},allowWrite:true}),{code:'bootstrap_task_required'});
});
