import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {inspectCmInitProjectScan} from '../runtime/js/cm-init/project-scan.mjs';

const repository=fileURLToPath(new URL('..',import.meta.url));
for(const mode of ['prompt','small','large','existing','missing-skill','symlink'])test(`init map decision: ${mode}`,()=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-init-map-'))),project=path.join(root,'project');
  fs.mkdirSync(project);
  try{
    if(mode==='prompt')for(let i=0;i<60;i++)fs.writeFileSync(path.join(project,`${i}.md`),'Prompt asset');
    else{
      fs.writeFileSync(path.join(project,'package.json'),'{}');fs.mkdirSync(path.join(project,'src'));
      for(let i=0;i<(mode==='large'?31:1);i++)fs.writeFileSync(path.join(project,'src',`${i}.mjs`),'export {};');
    }
    if(mode==='existing')fs.mkdirSync(path.join(project,'docs','codebase-context'),{recursive:true});
    if(mode==='missing-skill'){
      fs.mkdirSync(path.join(project,'docs'));
      fs.writeFileSync(path.join(project,'docs','codebase-context'),'invalid map path if traversal runs');
    }
    if(mode==='symlink')fs.symlinkSync(root,path.join(project,'outside'));
    fs.mkdirSync(path.join(project,'node_modules'));fs.writeFileSync(path.join(project,'node_modules','ignored.js'),'dependency');
    const result=inspectCmInitProjectScan({project,workflowRoot:mode==='missing-skill'?root:repository});
    assert.equal(result.action,{prompt:'skip',small:'skip',large:'full',existing:'incremental','missing-skill':'skip',symlink:'blocked'}[mode]);
    assert.equal(result.observations.sourceFiles,mode==='missing-skill'?null:mode==='prompt'?0:mode==='large'?31:1);
    assert.equal(result.writeAuthorized,false);assert.equal(result.executionAuthorized,false);
    assert.equal(fs.existsSync(path.join(project,'AGENTS.md')),false);
    if(mode==='large'){
      const cli=spawnSync(process.execPath,[path.join(repository,'scripts/cm-init-entry.mjs'),'--inspect-project',
        '--skill-dir',path.join(repository,'skills/cm-init'),'--project',project],{encoding:'utf8',timeout:3000});
      assert.equal(cli.status,0,cli.stderr);assert.deepEqual(JSON.parse(cli.stdout).projectScan,result);
      const original=spawnSync(process.execPath,[path.join(repository,'scripts/cm-init-entry.mjs'),
        '--skill-dir',path.join(repository,'skills/cm-init'),'--project',project],{encoding:'utf8',timeout:3000});
      assert.equal(original.status,0);assert.equal(Object.hasOwn(JSON.parse(original.stdout),'projectScan'),false);
    }
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
