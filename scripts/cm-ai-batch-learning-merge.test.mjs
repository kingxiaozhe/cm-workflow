import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {mergeLessons} from '../runtime/js/cm-ai/cm-ai-learning-writer.mjs';

// Two parallel members each write their lesson into AGENTS.md in their own
// worktree; the batch merges with AGENTS.md merge=union (cm-ai-batch-run.mjs
// unionAttributes). When the base has no "## 项目教训" section, both members
// create it. Git refines the identical added lines as common, so the merged
// file has one heading and both lessons, not a conflict or a doubled heading.
const git=(cwd,args)=>{const run=spawnSync('git',['-C',cwd,'-c','user.email=t@example.invalid','-c','user.name=t',...args],{encoding:'utf8'});
  assert.equal(run.status,0,run.stderr);return run.stdout.trim();};
const lesson=(taskId,trigger)=>({feature:'1.work',identity:{repositoryId:'r',runId:'u',taskId,attempt:1},
  candidates:[{classification:'memory_only',trigger,action:`${trigger} 的做法`,evidence:['src/a.js']}]});

for(const base of ['# 项目\n\n规则\n','# 项目\n\n## 项目教训\n\n- 旧教训\n\n## 其他\n\n内容\n'])
  test(`two members' lessons merge into one section (${base.includes('项目教训')?'section exists':'no section yet'})`,t=>{
    const repo=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-learning-union-')));
    t.after(()=>fs.rmSync(repo,{recursive:true,force:true}));
    git(repo,['init','-q','-b','base']);fs.writeFileSync(path.join(repo,'AGENTS.md'),base);git(repo,['add','.']);git(repo,['commit','-qm','base']);
    for(const [branch,taskId,trigger] of [['a','T-002','左边的教训'],['b','T-003','右边的教训']]){
      git(repo,['checkout','-q','-b',branch,'base']);
      fs.writeFileSync(path.join(repo,'AGENTS.md'),mergeLessons(fs.readFileSync(path.join(repo,'AGENTS.md'),'utf8'),lesson(taskId,trigger)));
      git(repo,['commit','-qam',branch]);
    }
    git(repo,['checkout','-q','a']);
    fs.writeFileSync(path.join(repo,'.git','info','attributes'),'AGENTS.md merge=union\n');
    git(repo,['merge','-q','--no-ff','--no-edit','b']);
    const merged=fs.readFileSync(path.join(repo,'AGENTS.md'),'utf8');
    assert.equal(merged.match(/^## 项目教训$/gm).length,1,merged);
    assert.match(merged,/左边的教训/);assert.match(merged,/右边的教训/);
    if(base.includes('## 其他'))assert.ok(merged.indexOf('右边的教训')<merged.indexOf('## 其他'),'lessons stay inside their section');
  });
