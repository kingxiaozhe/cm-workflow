import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {inspectCmInitProjectAnalysis} from '../runtime/js/cm-init/project-analysis.mjs';

const repository=fileURLToPath(new URL('..',import.meta.url));
test('init analysis: actual CLI reports declarations without running or exposing script bodies',()=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-init-analysis-')));
  try{
    fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({scripts:{test:'touch SENTINEL'},
      dependencies:{react:'private-registry-value'},devDependencies:{typescript:'5'}}));
    fs.mkdirSync(path.join(root,'src'));fs.writeFileSync(path.join(root,'README.md'),'project');
    fs.writeFileSync(path.join(root,'AGENTS.md'),'retain user instructions');
    fs.writeFileSync(path.join(root,'.env'),'not an analysis source');
    const cli=spawnSync(process.execPath,[path.join(repository,'scripts/cm-init-entry.mjs'),'--analyze-project',
      '--skill-dir',path.join(repository,'skills/cm-init'),'--project',root],{encoding:'utf8',timeout:3000});
    assert.equal(cli.status,0,cli.stderr);
    const result=JSON.parse(cli.stdout).projectAnalysis;
    assert.deepEqual(result.nodePackage.scriptNames,['test']);
    assert.deepEqual(result.nodePackage.dependencyNames,['react','typescript']);
    assert.deepEqual(result.existingInstructions,['AGENTS.md']);
    assert.deepEqual(result.configurationFiles,['README.md']);
    assert.equal(result.commandsExecuted,false);assert.equal(result.writeAuthorized,false);
    assert.equal(cli.stdout.includes('private-registry-value'),false);
    assert.equal(cli.stdout.includes('touch SENTINEL'),false);
    assert.equal(fs.existsSync(path.join(root,'SENTINEL')),false);
    assert.equal(fs.readFileSync(path.join(root,'AGENTS.md'),'utf8'),'retain user instructions');
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('init analysis: non-Node, linked and invalid manifests are not invented as Node evidence',()=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-init-analysis-')));
  try{
    fs.writeFileSync(path.join(root,'Cargo.toml'),'[package]');
    let result=inspectCmInitProjectAnalysis({project:root});
    assert.deepEqual(result.manifests,['Cargo.toml']);assert.equal(result.nodePackage,null);
    fs.symlinkSync(path.join(root,'Cargo.toml'),path.join(root,'package.json'));
    result=inspectCmInitProjectAnalysis({project:root});
    assert.deepEqual(result.skippedLinks,['package.json']);assert.equal(result.nodePackage,null);
    fs.unlinkSync(path.join(root,'package.json'));fs.writeFileSync(path.join(root,'package.json'),'{');
    assert.throws(()=>inspectCmInitProjectAnalysis({project:root}),/init_package_json_invalid/);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
