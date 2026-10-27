#!/usr/bin/env node
// Optional companion skills from mattpocock/skills (MIT): report which are installed
// and copy a pinned and fully verified set.
//
// CM never depends on these skills. Since 2026-10-27 the installers put them in by
// default (`auto`, replacing the earlier report-only hint decided 2026-10-20), unless
// the user says no: --no-matt-skills or CM_MATT_SKILLS_INSTALL=off for one run,
// {"install": false} in ~/.cm-workflow/matt-skills.local.json for good, and a skill the
// user removed after CM saw it there is never put back (see "settled skills" below).
// A fetch that fails only warns; CM itself is installed either way. /cm-check only
// reports. `install` and `auto` fetch one fixed commit, read blobs straight from git
// (no checkout, nothing downloaded is executed), check every file against the SHA-256
// list below, and write nothing unless the whole set verifies. Existing skills with
// the same name are never overwritten.
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
  {name:'retro',dir:'skills/engineering/retro',use:'cm-ai 收尾后复盘这一轮，看哪些错该交给脚本拦、哪些该写进指引',files:{
    'SKILL.md':'33fbc28568e3146f20fd908b12998bc0ab30aa4f4c87288199a40793efa94696',
    'agents/openai.yaml':'cb6fb9d7e6b4be5975f41f6def1dd00a1255bad5d9b02696b124c924a8b8745c'}},
]);

const HINT_STATE='matt-skills-hint';
export const LOCAL_NAME='matt-skills.local.json';
export const AUTO_NAME='matt-skills.auto.json';
const MAX_READ=1024*1024;
const RUNTIMES=['claude','codex'];
const NOTE={other:'（已有同名技能但内容不同，安装时会跳过）',unreadable:'（无法读取，安装时会报错）'};
const sha256=buffer=>crypto.createHash('sha256').update(buffer).digest('hex');
const homeOf=env=>env.HOME||os.homedir();
export const cmHome=env=>path.resolve(env.CM_WORKFLOW_HOME||path.join(homeOf(env),'.cm-workflow'));
export const localPath=env=>path.join(cmHome(env),LOCAL_NAME);
export const autoPath=env=>path.join(cmHome(env),AUTO_NAME);

export const skillRoots=(env=process.env)=>[
  {runtime:'claude',label:'Claude',root:path.join(path.resolve(env.CLAUDE_HOME||path.join(homeOf(env),'.claude')),'skills')},
  {runtime:'codex',label:'Codex',root:path.join(homeOf(env),'.agents','skills')},
];

// Files under a directory as relative paths; null when anything is not a plain
// file or directory (a link inside a skill is never the pinned author content).
// Finder's .DS_Store is ignored so browsing a skill folder does not demote it.
function listFiles(dir,prefix=''){
  const out=[];
  for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
    if(entry.name==='.DS_Store')continue;
    const relative=prefix?`${prefix}/${entry.name}`:entry.name;
    if(entry.isDirectory()){
      const nested=listFiles(path.join(dir,entry.name),relative);
      if(!nested)return null;
      out.push(...nested);
    }else if(entry.isFile())out.push(relative);
    else return null;
  }
  return out;
}

// "author": exactly the pinned files plus the upstream LICENSE, byte for byte.
// "other": a same-named skill with any other content, never counted as installed.
// "missing": nothing at that name. "unreadable": the state cannot be determined
// (root is not a directory, no permission), which callers report as a failure.
// The skill directory itself may be a link (e.g. a release symlink); its contents may not.
export function skillState(root,skill,license=UPSTREAM.license.sha256){
  const dir=path.join(root,skill.name);
  try{fs.lstatSync(dir);}catch(error){return error.code==='ENOENT'?'missing':'unreadable';}
  const expected={...skill.files,LICENSE:license};
  try{
    if(!fs.statSync(dir).isDirectory())return 'other';
    const actual=listFiles(dir);
    if(!actual||actual.sort().join('\n')!==Object.keys(expected).sort().join('\n'))return 'other';
    for(const [relative,sum] of Object.entries(expected)){
      if(sha256(fs.readFileSync(path.join(dir,relative)))!==sum)return 'other';
    }
  }catch(error){
    return ['EACCES','EPERM','EIO'].includes(error.code)?'unreadable':'other';
  }
  return 'author';
}

// Why a skills root cannot be used, or null. A missing root is fine (install creates it).
export function rootProblem(root){
  try{
    if(!fs.statSync(root).isDirectory())return '不是目录';
    fs.accessSync(root,fs.constants.R_OK|fs.constants.X_OK);
    return null;
  }catch(error){
    if(error.code==='ENOENT'){
      try{fs.lstatSync(root);return '是失效的链接';}catch{/* 真的不存在 */}
      return null;
    }
    return `无法访问（${error.code}）`;
  }
}

export function status({env=process.env,skills=SKILLS,upstream=UPSTREAM}={}){
  return skillRoots(env).map(({runtime,label,root})=>{
    const problem=rootProblem(root);
    return {runtime,label,root,problem,
      skills:skills.map(skill=>({name:skill.name,use:skill.use,
        state:problem?'unreadable':skillState(root,skill,upstream.license.sha256)}))};
  });
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

// The hint state is a disposable cache. It is read only when it is a plain,
// singly linked file, and replaced by renaming a freshly created file over the
// entry, so a link planted at that path is replaced, never written through.
function readHintState(file){
  try{
    const st=fs.lstatSync(file);
    if(!st.isFile()||st.nlink!==1)return null;
    return fs.readFileSync(file,'utf8');
  }catch{return null;}
}
function writeHintState(file,text){
  const temporary=`${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try{
    fs.mkdirSync(path.dirname(file),{recursive:true});
    fs.writeFileSync(temporary,text,{flag:'wx',mode:0o600});
    fs.renameSync(temporary,file);
  }catch{/* 记不住只是下次再列全 */}
  finally{try{fs.unlinkSync(temporary);}catch{/* 已改名或未创建 */}}
}

// Installer hint: the full list the first time a given set is missing, one line after.
export function hint({env=process.env,skills=SKILLS,upstream=UPSTREAM,command=installCommand(env)}={}){
  const report=status({env,skills,upstream});
  const missing=report.flatMap(r=>r.skills.filter(s=>s.state!=='author').map(s=>`${r.runtime}:${s.name}:${s.state}`));
  const fingerprint=missing.join('\n');
  const stateFile=hintStatePath(env);
  const seen=readHintState(stateFile);
  if(!missing.length){
    // Recorded so a gap that reappears later is listed in full again.
    if(seen!=='')writeHintState(stateFile,'');
    return `✓ 推荐搭配的 ${skills.length} 个 Matt Pocock 技能已齐（Claude 与 Codex）。\n`;
  }
  const names=[...new Set(report.flatMap(r=>r.skills.filter(s=>s.state!=='author').map(s=>s.name)))];
  let text;
  if(seen===fingerprint){
    text=`ℹ 推荐的 Matt Pocock 技能还缺 ${names.length} 个（可选，CM 不依赖）。安装：${command}\n`;
  }else{
    const lines=['ℹ 推荐搭配 Matt Pocock 的技能（可选，CM 不依赖）。'];
    const width=Math.max(...names.map(n=>n.length));
    const absentOf=r=>r.skills.filter(s=>s.state!=='author');
    const key=r=>absentOf(r).map(s=>`${s.name}:${s.state}`).join(',');
    // Both directories missing the same set is the common case: list it once.
    const groups=report.every(r=>key(r)===key(report[0]))
      ?[{title:report.map(r=>`${r.label}（${tilde(r.root,env)}）`).join('和')+'都',absent:absentOf(report[0])}]
      :report.filter(r=>absentOf(r).length).map(r=>({title:`${r.label}（${tilde(r.root,env)}）`,absent:absentOf(r)}));
    for(const g of groups){
      lines.push(`  ${g.title}缺 ${g.absent.length} 个：`);
      for(const s of g.absent)lines.push(`    ${s.name.padEnd(width)}  ${s.use}${NOTE[s.state]||''}`);
    }
    for(const r of report)if(r.problem)lines.push(`  ⚠ ${r.label} 技能目录 ${tilde(r.root,env)} ${r.problem}，安装前请先处理。`);
    lines.push(`  安装（只拉固定提交 ${UPSTREAM.commit.slice(0,7)}，逐个文件核对，不覆盖已有技能）：`);
    lines.push(`    ${command}`);
    text=lines.join('\n')+'\n';
  }
  writeHintState(stateFile,fingerprint);
  return text;
}

const STATE_TEXT={missing:'missing',other:'same name, different content (not the pinned author version)',unreadable:'cannot be read'};
export function statusText({env=process.env,skills=SKILLS,upstream=UPSTREAM,command=installCommand(env)}={}){
  const lines=[];
  for(const r of status({env,skills,upstream})){
    if(r.problem)lines.push(`recommended skills [${r.runtime}] WARN skills directory ${tilde(r.root,env)}: ${r.problem}`);
    const count=r.skills.filter(s=>s.state==='author').length;
    lines.push(`recommended skills [${r.runtime}] ${count}/${r.skills.length} author versions in ${tilde(r.root,env)}`);
    for(const s of r.skills)if(s.state!=='author')lines.push(`recommended skills [${r.runtime}] ${s.name}: ${STATE_TEXT[s.state]}`);
  }
  if(lines.length>2)lines.push(`recommended skills install (optional): ${command}`);
  const gate=installGate(env,false);
  const settled=settledSkills(env);
  lines.push(`recommended skills auto-install at install time: ${gate?.optOut?`skipped this run (${gate.optOut})`:gate?.off?`off (${gate.off})`
    :gate?.pause?`paused (${gate.pause})`:settled.state==='invalid'?`paused (${autoPath(env)} ${settled.reason})`:'on'}`
    +`; seen installed: ${RUNTIMES.map(runtime=>`${runtime} ${(settled.installed[runtime]||[]).length}`).join(', ')}`);
  return lines.join('\n')+'\n';
}

class VerifyError extends Error{}

// Git sees none of the user's configuration or GIT_* control variables: no system
// or global config, no config injected through the environment, no hooks, no
// credential helper or askpass, and only https/file transports. Proxy and CA
// variables pass through so networks that need a proxy still work.
const PASS_ENV=['PATH','LANG','LC_ALL','SYSTEMROOT','TMPDIR','http_proxy','https_proxy','HTTP_PROXY','HTTPS_PROXY',
  'all_proxy','ALL_PROXY','no_proxy','NO_PROXY','SSL_CERT_FILE','SSL_CERT_DIR'];
export function gitEnv(base=process.env,home){
  const env={};
  for(const key of PASS_ENV)if(base[key]!==undefined)env[key]=base[key];
  return {...env,HOME:home,XDG_CONFIG_HOME:home,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:os.devNull,
    GIT_TERMINAL_PROMPT:'0',GIT_ASKPASS:'',SSH_ASKPASS:'',GCM_INTERACTIVE:'never'};
}
const GIT_SAFETY=['-c','core.hooksPath='+os.devNull,'-c','credential.helper=','-c','core.fsmonitor=false',
  '-c','protocol.allow=never','-c','protocol.https.allow=always','-c','protocol.file.allow=always'];
// Every git call is bounded so an optional download can never hold an install for long.
export const GIT_TIMEOUT_MS=120000;
function git(args,home){
  return execFileSync('git',[...GIT_SAFETY,...args],{stdio:['ignore','pipe','pipe'],maxBuffer:64*1024*1024,
    cwd:home,env:gitEnv(process.env,home),timeout:GIT_TIMEOUT_MS,killSignal:'SIGKILL'});
}

// Fetches the pinned commit into a private bare repository and returns every
// pinned file's bytes. Throws VerifyError before anything is written elsewhere.
export function fetchVerified({source,upstream,skills,workdir}){
  const repo=path.join(workdir,'repo.git');
  const run=args=>git(args,workdir);
  run(['init','-q','--bare','--template=',repo]);
  // Only the pinned commit, one level deep; a source that cannot serve it by id is refused.
  try{run(['-C',repo,'fetch','-q','--no-tags','--no-recurse-submodules','--depth','1',source,upstream.commit]);}
  catch(error){
    const reason=error.code==='ETIMEDOUT'||error.signal==='SIGKILL'?`超过 ${GIT_TIMEOUT_MS/1000} 秒未完成，已中止`
      :String(error.stderr||error.message).trim().split('\n').pop();
    throw new VerifyError(`无法从 ${source} 拉取固定提交 ${upstream.commit}：${reason}`);
  }
  let commit;
  try{commit=run(['-C',repo,'rev-parse','--verify','-q',`${upstream.commit}^{commit}`]).toString().trim();}
  catch{throw new VerifyError(`来源里找不到固定提交 ${upstream.commit}`);}
  if(commit!==upstream.commit)throw new VerifyError(`提交号不一致：期望 ${upstream.commit}，得到 ${commit}`);

  const blob=(file,expected)=>{
    let content;
    try{content=run(['-C',repo,'cat-file','blob',`${commit}:${file}`]);}
    catch{throw new VerifyError(`缺少文件 ${file}`);}
    if(sha256(content)!==expected)throw new VerifyError(`${file} 的 SHA-256 与内置清单不一致`);
    return content;
  };
  const license=blob(upstream.license.path,upstream.license.sha256);
  const result=new Map();
  for(const skill of skills){
    let listing;
    try{listing=run(['-C',repo,'ls-tree','-r','-z','--full-tree',commit,'--',`${skill.dir}/`]).toString();}
    catch{throw new VerifyError(`无法列出 ${skill.dir}`);}
    const entries=listing.split('\0').filter(Boolean).map(line=>{
      const tab=line.indexOf('\t');
      const [mode,type]=line.slice(0,tab).split(' ');
      const file=line.slice(tab+1);
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

// Claims the name with an exclusive mkdir, which fails when anything (directory,
// file, link) already sits there, so an existing skill can never be replaced, even
// one created a moment ago by another process. Files are staged next to it and
// moved in; on any failure only the directory this call created is removed.
export function placeSkill(root,name,files){
  const target=path.join(root,name);
  const stage=fs.mkdtempSync(path.join(root,`.cm-matt-skills.${name}.`));
  let claimed=false;
  try{
    for(const [relative,content] of files){
      const file=path.join(stage,relative);
      fs.mkdirSync(path.dirname(file),{recursive:true});
      fs.writeFileSync(file,content,{flag:'wx',mode:0o644});
    }
    try{fs.mkdirSync(target);}catch(error){if(error.code==='EEXIST')return 'exists';throw error;}
    claimed=true;
    for(const entry of fs.readdirSync(stage))fs.renameSync(path.join(stage,entry),path.join(target,entry));
    claimed=false;
    return 'installed';
  }finally{
    if(claimed)fs.rmSync(target,{recursive:true,force:true});
    fs.rmSync(stage,{recursive:true,force:true});
  }
}

// `settled` maps a runtime to skill names CM once saw installed there and are now gone:
// the user removed them, so they are left out and reported, never put back.
export function install({env=process.env,source=UPSTREAM.repo,upstream=UPSTREAM,skills=SKILLS,tmpRoot=os.tmpdir(),write=text=>process.stdout.write(text),settled={}}={}){
  try{git(['--version'],tmpRoot);}
  catch{write('✗ 未找到 git，无法安装；未写入任何文件。\n');return 1;}
  const plan=status({env,skills,upstream}).map(r=>({...r,
    todo:r.problem?[]:skills.filter(s=>r.skills.find(x=>x.name===s.name).state==='missing'&&!(settled[r.runtime]||[]).includes(s.name)),
    removed:r.problem?[]:r.skills.filter(s=>s.state==='missing'&&(settled[r.runtime]||[]).includes(s.name)),
    skipped:r.skills.filter(s=>s.state==='author'||s.state==='other'),
    unreadable:r.problem?[]:r.skills.filter(s=>s.state==='unreadable')}));
  let failed=0;
  for(const r of plan){
    if(r.problem){write(`✗ ${r.label} 技能目录 ${tilde(r.root,env)} ${r.problem}，这一侧不安装。\n`);failed++;}
    for(const s of r.unreadable){write(`✗ ${r.label} ${s.name} 无法读取，未判断也未安装。\n`);failed++;}
  }
  if(plan.every(r=>!r.todo.length)){
    if(!failed&&plan.every(r=>!r.removed.length))write(`✓ 无需安装：两个目录都已有这 ${skills.length} 个同名技能。\n`);
    for(const r of plan)for(const s of r.skipped)if(s.state==='other')write(`  跳过 ${r.label} ${s.name}：已有同名技能但内容不同，未覆盖\n`);
    for(const r of plan)if(r.removed.length)write(`  ${r.label} 的 ${r.removed.map(s=>s.name).join('、')} 之前装过后被你删掉，不再自动装回\n`);
    return failed?1:0;
  }
  // git runs inside a private temporary directory, so a local path is fixed to the caller's cwd first.
  if(!/^[a-z][a-z0-9+.-]*:\/\//i.test(source))source=path.resolve(source);
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

  for(const r of plan){
    if(r.problem)continue;
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
    if(r.removed.length)write(`  ${r.removed.map(s=>s.name).join('、')} 之前装过后被你删掉，不再自动装回\n`);
  }
  if(failed){write(`⚠ 有 ${failed} 处失败，见上；已装好的技能保留。\n`);return 1;}
  write('装完的技能要开新会话才能看到。\n');
  return 0;
}

// ---- Install-time default ("auto") ----
// Only a regular file of bounded size is read; every config is strict JSON (an empty file
// is a problem, never rewritten).
function readJson(file){
  let text;
  try{
    const st=fs.lstatSync(file);
    if(!st.isFile())return {error:'not-file'};
    if(st.size>MAX_READ)return {error:'too-large'};
    text=fs.readFileSync(file,'utf8');
  }catch(error){if(error.code==='ENOENT')return {missing:true};return {error:error.code||'read'};}
  if(!text.trim())return {error:'empty'};
  try{return {value:JSON.parse(text),text};}catch{return {error:'parse'};}
}
const plainObject=value=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value);
class Drift extends Error{}
// Replace by renaming a fresh file over the path; `before` runs right before the rename.
function writeAtomic(file,text,{before}={}){
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const temporary=`${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try{
    fs.writeFileSync(temporary,text,{flag:'wx',mode:0o600});
    before?.();
    fs.renameSync(temporary,file);
  }finally{try{fs.unlinkSync(temporary);}catch{/* 已改名或未创建 */}}
}

// The user's local file: {"install": false} turns the install-time default off for good.
export function localShapeError(value){
  if(!plainObject(value))return '应为对象';
  if(value.install!==undefined&&typeof value.install!=='boolean')return 'install 只能是 true 或 false';
  return null;
}
export function readLocal(env){
  const local=readJson(localPath(env));
  if(local.missing)return {settings:{},error:null,missing:true};
  if(local.error)return {settings:{},error:`读取失败（${local.error}）`};
  const shape=localShapeError(local.value);
  return shape?{settings:{},error:`格式异常（${shape}）`}:{settings:local.value,error:null};
}

// Settled skills: ~/.cm-workflow/matt-skills.auto.json records, per runtime, every skill
// the install-time default has seen installed there (put in by it, or found already
// there). A settled skill that is missing later was removed by the user, and no install
// puts it back. --no-matt-skills and CM_MATT_SKILLS_INSTALL=off cover one run only and
// settle nothing. A record CM cannot read or whose shape is unknown is kept as is, and no
// install adds anything while it is there.
function readRecord(env){
  const read=readJson(autoPath(env));
  if(read.missing)return {state:'missing',read,installed:{}};
  const value=read.value;
  const names=list=>Array.isArray(list)&&list.every(name=>typeof name==='string'&&/^[a-z0-9][a-z0-9-]*$/.test(name));
  if(read.error||!plainObject(value)||value.version!==1||!plainObject(value.installed)
    ||!Object.keys(value.installed).every(runtime=>RUNTIMES.includes(runtime)&&names(value.installed[runtime])))
    return {state:'invalid',read,reason:read.error??'格式异常',installed:{}};
  return {state:'ok',read,installed:Object.fromEntries(RUNTIMES.map(runtime=>[runtime,[...new Set(value.installed[runtime]||[])]]))};
}
export function settledSkills(env){
  const record=readRecord(env);
  return {state:record.state,reason:record.reason,installed:record.installed};
}
const recordWarning=(env,reason)=>`⚠ 作者技能：${autoPath(env)} 异常（${reason}），已保留原样；修好或删掉它之前，安装不会自动装作者技能。\n`;
// Adds the skills now present to the record, under the shared config lock. Never throws.
async function noteRecord(env,found,{lockWaitMs}={}){
  const file=autoPath(env);
  try{
    const {withConfigLock,LockBusy}=await import('./cm-config-lock.mjs');
    try{
      return withConfigLock(env,file,()=>{
        const record=readRecord(env);
        if(record.state==='invalid')return {warning:recordWarning(env,record.reason)};
        const next=Object.fromEntries(RUNTIMES.map(runtime=>[runtime,
          [...new Set([...(record.installed[runtime]||[]),...(found[runtime]||[])])].sort()]));
        // Nothing new to note: an existing record stays as it is, and no record is created for nothing.
        if(RUNTIMES.every(runtime=>next[runtime].length===(record.installed[runtime]||[]).length))return {installed:next};
        writeAtomic(file,JSON.stringify({version:1,installed:next})+'\n',{before:()=>{
          const now=readJson(file);
          if(record.read.missing?!now.missing:now.text!==record.read.text)throw new Drift();
        }});
        return {installed:next};
      },lockWaitMs===undefined?{}:{waitMs:lockWaitMs});
    }catch(error){
      const why=error instanceof Drift?'刚被其他程序改动':error instanceof LockBusy?'另一个 CM 程序正在改它':error.message;
      return {warning:`⚠ 作者技能：未能记下已装的技能（${file}：${why}）；不影响本次安装，下次安装再记。\n`};
    }
  }catch(error){return {warning:`⚠ 作者技能：未能记下已装的技能（${file}：${error.message}）。\n`};}
}

// Why an install must not add skills now, or null. `optOut` is the user skipping this run;
// `off` is {"install": false}; `pause` is a local file CM cannot use, so it does nothing.
export function installGate(env,skip=false){
  if(skip)return {optOut:'安装参数 --no-matt-skills'};
  if(env.CM_MATT_SKILLS_INSTALL==='off')return {optOut:'环境变量 CM_MATT_SKILLS_INSTALL=off'};
  const local=readLocal(env);
  if(local.error)return {pause:`${localPath(env)} ${local.error}`};
  if(local.settings.install===false)return {off:`${localPath(env)} 里 install 为 false`};
  return null;
}
const OFF_NOTE=env=>`不想要：重装加 --no-matt-skills 只管这一次；永久关闭在 ${localPath(env)} 写 {"install": false}；你删掉的技能不会再自动装回。`;

// Run by the installers. Installs the missing skills into both directories unless the user
// said no, records what is there, and never throws; 1 means a warning (CM itself is
// installed either way).
export async function autoInstall({env=process.env,source=UPSTREAM.repo,upstream=UPSTREAM,skills=SKILLS,tmpRoot=os.tmpdir(),
  write=text=>process.stdout.write(text),skip=false,command=installCommand(env),lockWaitMs}={}){
  try{
    const gate=installGate(env,skip);
    if(gate?.optOut){
      write(`作者技能：按${gate.optOut}，这次不自动安装（只管这一次，下次不带它安装照常装）。\n`);
      write(hint({env,skills,upstream,command}));
      return 0;
    }
    if(gate?.off){write(`作者技能：${gate.off}，不自动安装；要装运行 ${command}\n`);return 0;}
    if(gate){write(`⚠ 作者技能：${gate.pause}，这次不自动安装；改好后重装或运行 ${command}\n`);return 1;}
    const settled=settledSkills(env);
    if(settled.state==='invalid'){write(recordWarning(env,settled.reason));write(hint({env,skills,upstream,command}));return 1;}
    // Seen = a skill of that name is there, the pinned author version or not ("other" is kept
    // as it is and must enjoy the same removal protection). Unreadable is never "seen".
    const present=()=>Object.fromEntries(status({env,skills,upstream}).map(r=>[r.runtime,r.skills.filter(s=>s.state==='author'||s.state==='other').map(s=>s.name)]));
    const code=install({env,source,upstream,skills,tmpRoot,write,settled:settled.installed});
    if(code!==0)write(`  作者技能不影响 CM 使用；稍后可手动运行 ${command}\n`);
    const noted=await noteRecord(env,present(),{lockWaitMs});
    if(noted.warning)write(noted.warning);
    write(`  ${OFF_NOTE(env)}\n`);
    return Math.max(code,noted.warning?1:0);
  }catch(error){
    write(`⚠ 作者技能未处理：${error.message}\n`);
    return 1;
  }
}

const USAGE='用法: cm-matt-skills.mjs status | hint | install [--source <git 地址或本地路径>] | auto [--no-matt-skills] [--source <git 地址或本地路径>]\n';

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
  if(command==='auto'){
    let source=UPSTREAM.repo,skip=false;
    const args=[...rest];
    if(args[0]==='--no-matt-skills'){skip=true;args.shift();}
    if(args.length===2&&args[0]==='--source'&&args[1])source=args[1];
    else if(args.length){error(USAGE);return 2;}
    return autoInstall({env,source,write,skip});
  }
  error(USAGE);
  return 2;
}

if(process.argv[1]&&fs.realpathSync(process.argv[1])===fs.realpathSync(fileURLToPath(import.meta.url))){
  Promise.resolve(main()).then(code=>{process.exitCode=code;});
}
