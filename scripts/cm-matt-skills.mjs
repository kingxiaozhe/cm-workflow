#!/usr/bin/env node
// Optional companion skills from mattpocock/skills (MIT): report which are installed
// and, only when the user runs `install`, copy a pinned and fully verified set.
//
// CM never depends on these skills and never installs them on its own (decided
// 2026-10-20: CM is public and other people install it). Installers and /cm-check
// only print what is missing plus one command. `install` fetches one fixed commit,
// reads blobs straight from git (no checkout, nothing downloaded is executed),
// checks every file against the SHA-256 list below, and writes nothing unless the
// whole set verifies. Existing skills with the same name are never overwritten.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

export const UPSTREAM=Object.freeze({
  repo:'https://github.com/mattpocock/skills.git',
  commit:'5beb35b040e3de97e54fa9e386d7e42d15c295c2',
  license:{path:'LICENSE',sha256:'0e7ac423bf2c6e223b7c5b156f8cf72da49d748e56a1641402c31f22ad07dbb5'},
});

// Ordered by how often a CM user reaches for them; hints list missing ones in this order.
export const SKILLS=Object.freeze([
  {name:'grill-with-docs',dir:'skills/engineering/grill-with-docs',use:'在仓库里追问技术方案，结论留进术语表和决策记录',files:{
    'SKILL.md':'7de372c13488f1ee96cc11cd8907b56b6809cc93eef776eeddd37de6b6cbe3fe',
    'agents/openai.yaml':'94cd0ab161fb468a836349f5ed482ba58ce8e709a05c57ce533d739dbd35cca9'}},
  {name:'grill-me',dir:'skills/productivity/grill-me',use:'不在仓库里，只想把一个想法问透',files:{
    'SKILL.md':'caaf8b8de1684f96e26b28f3c29189db5c89cce4b73e1c93d86164f66ef88637',
    'agents/openai.yaml':'c061e39c3e0f9d865fb1b97556d485704af2a8a58f4b8221a8917a5c2074a32b'}},
  {name:'grilling',dir:'skills/productivity/grilling',use:'追问类技能背后的引擎，由其他技能自动调用',files:{
    'SKILL.md':'befdff1e27a1dfe2a294d5871169ac1afe16d983911daa4f32627514a48c1e15',
    'agents/openai.yaml':'1411d7df7d99b7e621a1ff8283c8133cc2464be63d064e52d8ce169c6800ee9b'}},
  {name:'improve-codebase-architecture',dir:'skills/engineering/improve-codebase-architecture',use:'想重构但不知从哪下手时，找出重构机会并出报告',files:{
    'HTML-REPORT.md':'581e8bb5a521e46bbda8ca7e19b15948bed882187108092ebb90c62513b77528',
    'SKILL.md':'552240a5ab5cec6b67c15dd1ad6e9f6962b1bca6ce870059a8c2713760c20392',
    'agents/openai.yaml':'c8cb20f68ebf0edb4e497bc11ae5fcaa196004e661cd189015b04f4109ced7f1'}},
  {name:'codebase-design',dir:'skills/engineering/codebase-design',use:'讨论模块边界和接口设计时自动起作用',files:{
    'DEEPENING.md':'f3dd099ce99289bd213914d8ee3e2429b78309c3957ca4583f7659551b1d53c1',
    'DESIGN-IT-TWICE.md':'52b52e75655a27aea59c6966b410bac82448968ad46ef1ebb9f07c274e3ae010',
    'SKILL.md':'2c20617f87ec8af6a434859f381b2f061a69b530444e74eb39e78bb016a6d1e2',
    'agents/openai.yaml':'edebc9e4fcfe102114012575eaa9600b9b5fd08c311664f389c36e7bc717740f'}},
  {name:'domain-modeling',dir:'skills/engineering/domain-modeling',use:'讨论术语、写决策记录时保持叫法一致',files:{
    'ADR-FORMAT.md':'944c92aa790e8fbdc9199640b170979abb8a34ba8d0fe18c2a01a63bce140ca0',
    'GLOSSARY-FORMAT.md':'21dcc40cdec8e151a829b98ab1517c1867bc444e3665134a98c6983411996801',
    'SKILL.md':'7b925d7b1e341a2eeae33ad68a8a8c0ab889a38ddd22a7598e4c240e5a7556a3',
    'agents/openai.yaml':'f6bf2aa996c6e6f53fdd0708e18a0d16a56aed8322cca59fedbe3c0d2c75f06b'}},
  {name:'prototype',dir:'skills/engineering/prototype',use:'逻辑或界面想不清时，做个用完就扔的原型',files:{
    'LOGIC.md':'f61c7d249e786a79ef289018901c348271e1798dd0b0bc5607b5c6f4d4a01ab9',
    'SKILL.md':'714de632d116bb73f65cdb5a882db15b9369a6713b9a47c0fad827848f0bfbe3',
    'UI.md':'723211e878acbc7b6ff09755263f3295cde724ba902ff0064da41eed51d45ad3',
    'agents/openai.yaml':'5af65e43ab41a350436697b81e27b7f848d36782043b73c322bb2c9fa9cc55dc'}},
  {name:'wayfinder',dir:'skills/engineering/wayfinder',use:'一个会话装不下的大活，拆成决策票逐张处理',files:{
    'SKILL.md':'9be7b478c389605a24517d27752f278933588da97a1b5921b165f455edf4c5b7',
    'agents/openai.yaml':'88bc81a11a6d52ac67aeaa76b8b619e387020d47c5133a4dd4927fd15c4ad073'}},
  {name:'setup-matt-pocock-skills',dir:'skills/engineering/setup-matt-pocock-skills',use:'每个仓库跑一次，为 wayfinder 做准备',files:{
    'SKILL.md':'f148858ffb7f63c03c06fca06e6fdb1d91a35c6b293244b8fdfacd5f4cc028c4',
    'agents/openai.yaml':'9527de0110541c45712319025155aeab8dc7d77c6ed6e5e83271bab1851ab939',
    'domain.md':'593a7042218689f1d24df89df14eaf0a20e19e0d0a7d479a01947ac78f0784b9',
    'issue-tracker-github.md':'f0653fe106dd8ee7b33be27bd7fe3104b40555896cb45f61997aed20467020c3',
    'issue-tracker-gitlab.md':'591a9e7057382aaccdfbed3f7ea3f2ad07e0cd29f012d18b82ee4e485fd81e24',
    'issue-tracker-local.md':'7dcda20a2eb4bdc89b95d1143423c0691309921cadae3132e6424f371030506e',
    'triage-labels.md':'ae512af838c78b8750471c42cd2b20fa32319553e61d84c9a23d171b40ce14aa'}},
  {name:'handoff',dir:'skills/productivity/handoff',use:'CM 之外的长讨论，换新会话前写交接',files:{
    'SKILL.md':'4cbb043950dad2ffd3662ff1a5a0b51ae676004b5cae10e3787e8ee7a4ee69d3',
    'agents/openai.yaml':'5c479fd562c691851690e8b18c8501045bef0943c10743d636b2fae26add1d28'}},
  {name:'writing-for-agents',dir:'skills/productivity/writing-for-agents',use:'写技能或改 CLAUDE.md / AGENTS.md 时自动起作用',files:{
    'SKILL-MECHANICS.md':'c768e6307c7c10728c401c213f2c4ba71c542127eeb7ad2956aabd15a0fa0059',
    'SKILL.md':'551adca942227b44192edba88acd4e8db911f0121ce58ad16944ccf6a896a74a',
    'agents/openai.yaml':'eacb24b2a618cfb81dacb0416f4fdd75ddf3a8060f8ddb99aae1b1e301907e4b'}},
  {name:'wait-what',dir:'skills/productivity/wait-what',use:'上一条回复没看懂，让模型换个说法重讲',files:{
    'SKILL.md':'d961bb37defd975c539427edb8f450cdbccdcdd552e213c1ece46676a7970905',
    'agents/openai.yaml':'b41faadf741d51e4ea184148b2d1854d93f947aaf754c7844f70a00f04194999'}},
]);

const HINT_STATE='matt-skills-hint';
const sha256=buffer=>crypto.createHash('sha256').update(buffer).digest('hex');
const homeOf=env=>env.HOME||os.homedir();

export const skillRoots=(env=process.env)=>[
  {runtime:'claude',label:'Claude',root:path.join(path.resolve(env.CLAUDE_HOME||path.join(homeOf(env),'.claude')),'skills')},
  {runtime:'codex',label:'Codex',root:path.join(homeOf(env),'.agents','skills')},
];

// "author" only when every pinned file matches; a same-named directory with other
// content is "other" (another skill or another version), never counted as installed.
export function skillState(root,skill){
  const dir=path.join(root,skill.name);
  try{fs.lstatSync(dir);}catch(error){if(error.code==='ENOENT')return 'missing';return 'other';}
  for(const [relative,expected] of Object.entries(skill.files)){
    let content;
    try{content=fs.readFileSync(path.join(dir,relative));}catch{return 'other';}
    if(sha256(content)!==expected)return 'other';
  }
  return 'author';
}

export function status({env=process.env,skills=SKILLS}={}){
  return skillRoots(env).map(({runtime,label,root})=>({runtime,label,root,
    skills:skills.map(skill=>({name:skill.name,use:skill.use,state:skillState(root,skill)}))}));
}

const tilde=(file,env)=>{
  const home=homeOf(env);
  return file===home||file.startsWith(home+path.sep)?'~'+file.slice(home.length):file;
};
// Printed for the user to copy: a plain ~ path when it is shell-safe, else single-quoted.
export function installCommand(env=process.env,script=fileURLToPath(import.meta.url)){
  const short=tilde(script,env);
  const shown=/^[\w~./-]+$/.test(short)?short:`'${script.replace(/'/g,`'\\''`)}'`;
  return `node ${shown} install`;
}

function hintStatePath(env){
  return path.join(path.resolve(env.CM_WORKFLOW_HOME||path.join(homeOf(env),'.cm-workflow')),HINT_STATE);
}

// Installer hint: the full list the first time a given set is missing, one line after.
export function hint({env=process.env,skills=SKILLS,command=installCommand(env)}={}){
  const report=status({env,skills});
  const missing=report.flatMap(r=>r.skills.filter(s=>s.state!=='author').map(s=>`${r.runtime}:${s.name}:${s.state}`));
  if(!missing.length)return `✓ 推荐搭配的 ${skills.length} 个 Matt Pocock 技能已齐（Claude 与 Codex）。\n`;
  const fingerprint=missing.join('\n');
  const stateFile=hintStatePath(env);
  let seen='';
  try{seen=fs.readFileSync(stateFile,'utf8');}catch{/* 首次提示 */}
  const names=[...new Set(report.flatMap(r=>r.skills.filter(s=>s.state!=='author').map(s=>s.name)))];
  let text;
  if(seen===fingerprint){
    text=`ℹ 推荐的 Matt Pocock 技能还缺 ${names.length} 个（可选，CM 不依赖）。安装：${command}\n`;
  }else{
    const lines=['ℹ 推荐搭配 Matt Pocock 的技能（可选，CM 不依赖，不会自动安装）。'];
    const width=Math.max(...names.map(n=>n.length));
    const absentOf=r=>r.skills.filter(s=>s.state!=='author');
    const key=r=>absentOf(r).map(s=>`${s.name}:${s.state}`).join(',');
    // Both directories missing the same set is the common case: list it once.
    const groups=report.every(r=>key(r)===key(report[0]))
      ?[{title:report.map(r=>`${r.label}（${tilde(r.root,env)}）`).join('和')+'都',absent:absentOf(report[0])}]
      :report.filter(r=>absentOf(r).length).map(r=>({title:`${r.label}（${tilde(r.root,env)}）`,absent:absentOf(r)}));
    for(const g of groups){
      lines.push(`  ${g.title}缺 ${g.absent.length} 个：`);
      for(const s of g.absent)lines.push(`    ${s.name.padEnd(width)}  ${s.use}${s.state==='other'?'（已有同名技能但内容不同，安装时会跳过）':''}`);
    }
    lines.push(`  安装（只拉固定提交 ${UPSTREAM.commit.slice(0,7)}，逐个文件核对，不覆盖已有技能）：`);
    lines.push(`    ${command}`);
    text=lines.join('\n')+'\n';
  }
  try{fs.mkdirSync(path.dirname(stateFile),{recursive:true});fs.writeFileSync(stateFile,fingerprint);}catch{/* 记不住只是下次再列全 */}
  return text;
}

const STATE_TEXT={missing:'missing',other:'same name, different content (not the pinned author version)'};
export function statusText({env=process.env,skills=SKILLS,command=installCommand(env)}={}){
  const lines=[];
  for(const r of status({env,skills})){
    const count=r.skills.filter(s=>s.state==='author').length;
    lines.push(`recommended skills [${r.runtime}] ${count}/${r.skills.length} author versions in ${tilde(r.root,env)}`);
    for(const s of r.skills)if(s.state!=='author')lines.push(`recommended skills [${r.runtime}] ${s.name}: ${STATE_TEXT[s.state]}`);
  }
  if(lines.length>2)lines.push(`recommended skills install (optional, never automatic): ${command}`);
  return lines.join('\n')+'\n';
}

class VerifyError extends Error{}

function git(args,options={}){
  return execFileSync('git',args,{stdio:['ignore','pipe','pipe'],maxBuffer:64*1024*1024,
    env:{...process.env,GIT_TERMINAL_PROMPT:'0',GIT_CONFIG_NOSYSTEM:'1'},...options});
}

// Fetches the pinned commit into a private bare repository and returns every
// pinned file's bytes. Throws VerifyError before anything is written elsewhere.
export function fetchVerified({source,upstream,skills,workdir}){
  const repo=path.join(workdir,'repo.git');
  git(['init','-q','--bare',repo]);
  try{git(['-C',repo,'fetch','-q','--no-tags','--depth','1',source,upstream.commit]);}
  catch{
    try{git(['-C',repo,'fetch','-q','--no-tags',source,'+refs/heads/*:refs/remotes/source/*']);}
    catch(error){throw new VerifyError(`无法从 ${source} 拉取：${String(error.stderr||error.message).trim().split('\n').pop()}`);}
  }
  let commit;
  try{commit=git(['-C',repo,'rev-parse','--verify','-q',`${upstream.commit}^{commit}`]).toString().trim();}
  catch{throw new VerifyError(`来源里找不到固定提交 ${upstream.commit}`);}
  if(commit!==upstream.commit)throw new VerifyError(`提交号不一致：期望 ${upstream.commit}，得到 ${commit}`);

  const blob=(file,expected)=>{
    let content;
    try{content=git(['-C',repo,'cat-file','blob',`${commit}:${file}`]);}
    catch{throw new VerifyError(`缺少文件 ${file}`);}
    if(sha256(content)!==expected)throw new VerifyError(`${file} 的 SHA-256 与内置清单不一致`);
    return content;
  };
  const license=blob(upstream.license.path,upstream.license.sha256);
  const result=new Map();
  for(const skill of skills){
    let listing;
    try{listing=git(['-C',repo,'ls-tree','-r','-z','--full-tree',commit,'--',`${skill.dir}/`]).toString();}
    catch{throw new VerifyError(`无法列出 ${skill.dir}`);}
    const entries=listing.split('\0').filter(Boolean).map(line=>{
      const [meta,file]=line.split('\t');
      const [mode,type]=meta.split(' ');
      return {mode,type,relative:file.slice(skill.dir.length+1)};
    });
    for(const e of entries){
      if(e.type!=='blob'||(e.mode!=='100644'&&e.mode!=='100755'))throw new VerifyError(`${skill.dir}/${e.relative} 不是普通文件（${e.mode}）`);
    }
    const actual=entries.map(e=>e.relative).sort();
    const expected=Object.keys(skill.files).sort();
    if(actual.join('\n')!==expected.join('\n')){
      const extra=actual.filter(f=>!expected.includes(f));
      const lost=expected.filter(f=>!actual.includes(f));
      throw new VerifyError(`${skill.dir} 的文件列表与清单不一致${extra.length?`，多出 ${extra.join(', ')}`:''}${lost.length?`，缺少 ${lost.join(', ')}`:''}`);
    }
    const files=new Map();
    for(const relative of expected)files.set(relative,blob(`${skill.dir}/${relative}`,skill.files[relative]));
    files.set('LICENSE',license);
    result.set(skill.name,files);
  }
  return result;
}

// Writes into a sibling staging directory first, then renames into place, so a
// skill directory either appears complete or not at all. The final existence check
// covers a directory created after planning (e.g. another install running).
export function placeSkill(root,name,files){
  const target=path.join(root,name);
  const stage=path.join(root,`.cm-matt-skills.${process.pid}.${name}`);
  fs.rmSync(stage,{recursive:true,force:true});
  try{
    for(const [relative,content] of files){
      const file=path.join(stage,relative);
      fs.mkdirSync(path.dirname(file),{recursive:true});
      fs.writeFileSync(file,content,{mode:0o644});
    }
    try{fs.lstatSync(target);return 'exists';}catch(error){if(error.code!=='ENOENT')return 'exists';}
    fs.renameSync(stage,target);
    return 'installed';
  }catch(error){
    if(['ENOTEMPTY','EEXIST','ENOTDIR'].includes(error.code))return 'exists';
    throw error;
  }finally{
    fs.rmSync(stage,{recursive:true,force:true});
  }
}

export function install({env=process.env,source=UPSTREAM.repo,upstream=UPSTREAM,skills=SKILLS,tmpRoot=os.tmpdir(),write=text=>process.stdout.write(text)}={}){
  try{execFileSync('git',['--version'],{stdio:'ignore'});}
  catch{write('✗ 未找到 git，无法安装；未写入任何文件。\n');return 1;}
  const roots=skillRoots(env);
  const plan=roots.map(r=>({...r,todo:skills.filter(s=>skillState(r.root,s)==='missing'),
    skipped:skills.map(s=>({name:s.name,state:skillState(r.root,s)})).filter(s=>s.state!=='missing')}));
  if(plan.every(r=>!r.todo.length)){
    write(`✓ 无需安装：两个目录都已有这 ${skills.length} 个同名技能。\n`);
    for(const r of plan)for(const s of r.skipped)if(s.state==='other')write(`  跳过 ${r.label} ${s.name}：已有同名技能但内容不同，未覆盖\n`);
    return 0;
  }
  write(`拉取 ${source} 的固定提交 ${upstream.commit.slice(0,7)} 并逐个文件核对……\n`);
  const workdir=fs.mkdtempSync(path.join(tmpRoot,'cm-matt-skills-'));
  let verified;
  try{verified=fetchVerified({source,upstream,skills,workdir});}
  catch(error){
    fs.rmSync(workdir,{recursive:true,force:true});
    if(!(error instanceof VerifyError))throw error;
    write(`✗ 核对失败，整批放弃，未写入任何文件：${error.message}\n`);
    return 1;
  }
  fs.rmSync(workdir,{recursive:true,force:true});
  write(`✓ ${skills.length} 个技能共 ${skills.reduce((n,s)=>n+Object.keys(s.files).length,0)} 个文件和 LICENSE 均与内置清单一致。\n`);

  let failed=0;
  for(const r of plan){
    const installed=[];
    const skipped=r.skipped.map(s=>`${s.name}（${s.state==='author'?'已是作者版':'已有同名技能但内容不同'}）`);
    if(r.todo.length){
      try{fs.mkdirSync(r.root,{recursive:true});}
      catch(error){write(`✗ ${r.label} 目录 ${tilde(r.root,env)} 无法创建：${error.message}\n`);failed++;continue;}
    }
    for(const skill of r.todo){
      try{
        if(placeSkill(r.root,skill.name,verified.get(skill.name))==='installed')installed.push(skill.name);
        else skipped.push(`${skill.name}（安装时已出现同名目录）`);
      }catch(error){write(`✗ ${r.label} ${skill.name} 写入失败：${error.message}\n`);failed++;}
    }
    write(`${r.label}（${tilde(r.root,env)}）：新装 ${installed.length} 个${installed.length?`：${installed.join('、')}`:''}\n`);
    if(skipped.length)write(`  跳过 ${skipped.length} 个，未覆盖：${skipped.join('、')}\n`);
  }
  if(failed){write(`⚠ 有 ${failed} 处写入失败，见上；已装好的技能保留。\n`);return 1;}
  write('装完的技能要开新会话才能看到。\n');
  return 0;
}

const USAGE='用法: cm-matt-skills.mjs status | hint | install [--source <git 地址或本地路径>]\n';

export function main(argv=process.argv.slice(2),{env=process.env,write=text=>process.stdout.write(text),error=text=>process.stderr.write(text)}={}){
  const [command,...rest]=argv;
  if(command==='status'&&!rest.length){write(statusText({env}));return 0;}
  if(command==='hint'&&!rest.length){write(hint({env}));return 0;}
  if(command==='install'){
    let source=UPSTREAM.repo;
    if(rest.length===2&&rest[0]==='--source'&&rest[1])source=rest[1];
    else if(rest.length){error(USAGE);return 2;}
    return install({env,source,write});
  }
  error(USAGE);
  return 2;
}

if(process.argv[1]&&fs.realpathSync(process.argv[1])===fs.realpathSync(fileURLToPath(import.meta.url))){
  process.exitCode=main();
}
