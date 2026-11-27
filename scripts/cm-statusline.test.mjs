// 状态条只显示属于当前会话项目的 CM 状态（按 stdin 的 cwd 判断）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const script=fileURLToPath(new URL('../templates/statusline/cm-statusline.sh',import.meta.url));
function fixture(fn){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-statusline-')));
  try{
    const home=path.join(root,'home'),project=path.join(root,'proj'),specs=path.join(project,'specs','feat');
    fs.mkdirSync(path.join(home,'.claude'),{recursive:true});fs.mkdirSync(specs,{recursive:true});
    fs.mkdirSync(path.join(root,'proj2'));fs.mkdirSync(path.join(root,'other'));
    fs.writeFileSync(path.join(home,'.claude','cm-current-specs'),specs);
    fs.writeFileSync(path.join(specs,'.cm-status.json'),JSON.stringify({node:'N3',feature:'1.x',task:'T-001',detail:'正在开发接口',state:'running'}));
    fn({root,home,project,specs});
  }finally{fs.rmSync(root,{recursive:true,force:true});}
}
const run=(home,input)=>spawnSync('/bin/bash',[script],{input:JSON.stringify(input),env:{...process.env,HOME:home},encoding:'utf8'}).stdout;

test('shows CM status when cwd is the project, inside specs, or via workspace.current_dir',()=>fixture(({home,project,specs})=>{
  for(const input of [{cwd:project},{cwd:specs},{workspace:{current_dir:project}}])
    assert.match(run(home,input),/正在开发接口/,JSON.stringify(input));
}));
test('hides another project\'s status, a prefix-lookalike dir, and a missing cwd',()=>fixture(({root,home})=>{
  for(const input of [{cwd:path.join(root,'other')},{cwd:path.join(root,'proj2')},{model:{display_name:'M'}}]){
    const out=run(home,input);
    assert(!out.includes('正在开发接口')&&!out.includes('可能已中断'),JSON.stringify(input)+out);
  }
}));

test('inherited GIT_DIR / GIT_WORK_TREE cannot pull in another project\'s status',()=>fixture(({root,home,project})=>{
  assert.equal(spawnSync('git',['init','-q',project]).status,0);
  const env={...process.env,HOME:home,GIT_DIR:path.join(project,'.git'),GIT_WORK_TREE:project};
  const out=spawnSync('/bin/bash',[script],{input:JSON.stringify({cwd:path.join(root,'other')}),env,encoding:'utf8'}).stdout;
  assert(!out.includes('正在开发接口'),out);
}));

test('a cwd that is "/", an ancestor of HOME, or a deleted directory never shows another project\'s status',()=>fixture(({root,home})=>{
  const gone=path.join(root,'gone');fs.mkdirSync(gone);fs.rmSync(gone,{recursive:true});
  for(const cwd of ['/',root,home,gone]){
    const out=run(home,{cwd});assert(!out.includes('正在开发接口')&&!out.includes('可能已中断'),cwd+out);
  }
}));

test('a pointer to HOME with a stale status file never leaks into projects under HOME',()=>fixture(({home})=>{
  const other=path.join(home,'work','other');fs.mkdirSync(other,{recursive:true});
  fs.writeFileSync(path.join(home,'.claude','cm-current-specs'),home);
  fs.writeFileSync(path.join(home,'.cm-status.json'),JSON.stringify({node:'N3',feature:'1.x',task:'T-001',detail:'正在开发接口',state:'running'}));
  const out=run(home,{cwd:other});assert(!out.includes('正在开发接口')&&!out.includes('可能已中断'),out);
}));
