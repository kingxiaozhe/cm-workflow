// Offline fixtures: every fetch reads a local fake repository, never the network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {UPSTREAM,SKILLS,skillRoots,skillState,status,statusText,hint,install,installCommand,main,placeSkill,gitEnv,autoInstall,installGate,settledSkills,localPath,autoPath} from './cm-matt-skills.mjs';

const root=fileURLToPath(new URL('..',import.meta.url));
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const sha256=text=>crypto.createHash('sha256').update(text).digest('hex');
const git=(cwd,...args)=>execFileSync('git',['-c','user.name=cm-test','-c','user.email=cm-test@example.invalid','-c','commit.gpgsign=false',...args],{cwd,stdio:['ignore','pipe','pipe']}).toString().trim();

function tempDir(t,prefix){
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),prefix)));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  return dir;
}

const FAKE_FILES={
  LICENSE:'MIT License\nfake upstream\n',
  'skills/productivity/alpha/SKILL.md':'---\nname: alpha\n---\nalpha\n',
  'skills/productivity/alpha/agents/openai.yaml':'alpha: yes\n',
  'skills/engineering/beta/SKILL.md':'---\nname: beta\n---\nbeta\n',
  'skills/engineering/beta/NOTES.md':'beta notes\n',
};

// A fake upstream whose pinned manifest matches FAKE_FILES; `mutate` runs before
// the commit so a test can make the repository disagree with that manifest.
function fakeUpstream(t,mutate=()=>{}){
  const repo=tempDir(t,'cm-matt-repo-');
  git(repo,'init','-q');
  for(const [file,text] of Object.entries(FAKE_FILES)){
    fs.mkdirSync(path.dirname(path.join(repo,file)),{recursive:true});
    fs.writeFileSync(path.join(repo,file),text);
  }
  const skills=[
    {name:'alpha',dir:'skills/productivity/alpha',use:'alpha use',files:{
      'SKILL.md':sha256(FAKE_FILES['skills/productivity/alpha/SKILL.md']),
      'agents/openai.yaml':sha256(FAKE_FILES['skills/productivity/alpha/agents/openai.yaml'])}},
    {name:'beta',dir:'skills/engineering/beta',use:'beta use',files:{
      'SKILL.md':sha256(FAKE_FILES['skills/engineering/beta/SKILL.md']),
      'NOTES.md':sha256(FAKE_FILES['skills/engineering/beta/NOTES.md'])}},
  ];
  mutate(repo);
  git(repo,'add','-A');
  git(repo,'commit','-q','-m','fixture');
  const commit=git(repo,'rev-parse','HEAD');
  return {repo,skills,upstream:{repo,commit,license:{path:'LICENSE',sha256:sha256(FAKE_FILES.LICENSE)}}};
}

function home(t){
  const dir=tempDir(t,'cm-matt-home-');
  const tmpRoot=path.join(dir,'tmp');
  fs.mkdirSync(tmpRoot);
  return {dir,tmpRoot,env:{HOME:dir,CM_WORKFLOW_HOME:path.join(dir,'.cm-workflow')},
    claude:path.join(dir,'.claude','skills'),codex:path.join(dir,'.agents','skills')};
}

function runInstall(h,f,extra={}){
  let text='';
  const code=install({env:h.env,source:f.repo,upstream:f.upstream,skills:f.skills,tmpRoot:h.tmpRoot,write:s=>{text+=s;},...extra});
  return {code,text};
}

// Every path under a directory with its bytes, so "nothing written" is checked exactly.
function snapshot(dir){
  if(!fs.existsSync(dir))return null;
  const out={};
  const walk=d=>{for(const name of fs.readdirSync(d).sort()){
    const p=path.join(d,name),st=fs.lstatSync(p),rel=path.relative(dir,p);
    if(st.isSymbolicLink())out[rel]=`link:${fs.readlinkSync(p)}`;
    else if(st.isDirectory()){out[rel]='dir';walk(p);}
    else out[rel]=fs.readFileSync(p,'utf8');
  }};
  walk(dir);
  return out;
}

test('pinned manifest: fixed full commit, thirteen skills, well-formed checksums',()=>{
  assert.equal(UPSTREAM.commit,'5beb35b040e3de97e54fa9e386d7e42d15c295c2');
  assert.equal(UPSTREAM.repo,'https://github.com/mattpocock/skills.git');
  assert.match(UPSTREAM.license.sha256,/^[0-9a-f]{64}$/);
  assert.deepEqual(SKILLS.map(s=>s.name).sort(),['codebase-design','domain-modeling','grill-me','grill-with-docs','grilling',
    'handoff','improve-codebase-architecture','prototype','retro','setup-matt-pocock-skills','wait-what','wayfinder','writing-for-agents']);
  for(const skill of SKILLS){
    assert.equal(path.basename(skill.dir),skill.name);
    assert.ok(skill.files['SKILL.md'],`${skill.name} pins SKILL.md`);
    assert.ok(!('LICENSE' in skill.files),'LICENSE comes from the repository root');
    for(const [file,sum] of Object.entries(skill.files)){
      assert.match(sum,/^[0-9a-f]{64}$/,`${skill.name}/${file}`);
      assert.ok(!file.startsWith('/')&&!file.split('/').includes('..'),file);
    }
  }
  assert.equal(SKILLS.reduce((n,s)=>n+Object.keys(s.files).length,0),39);
});

test('install copies every verified skill with LICENSE into both directories',t=>{
  const f=fakeUpstream(t),h=home(t);
  const {code,text}=runInstall(h,f);
  assert.equal(code,0,text);
  for(const dir of [h.claude,h.codex]){
    assert.equal(fs.readFileSync(path.join(dir,'alpha/agents/openai.yaml'),'utf8'),FAKE_FILES['skills/productivity/alpha/agents/openai.yaml']);
    assert.equal(fs.readFileSync(path.join(dir,'beta/NOTES.md'),'utf8'),FAKE_FILES['skills/engineering/beta/NOTES.md']);
    assert.equal(fs.readFileSync(path.join(dir,'alpha/LICENSE'),'utf8'),FAKE_FILES.LICENSE);
    assert.equal(fs.readFileSync(path.join(dir,'beta/LICENSE'),'utf8'),FAKE_FILES.LICENSE);
    assert.deepEqual(fs.readdirSync(dir).sort(),['alpha','beta'],'no staging directory is left behind');
  }
  assert.ok(status({env:h.env,skills:f.skills,upstream:f.upstream}).every(r=>r.skills.every(s=>s.state==='author')));
  assert.deepEqual(fs.readdirSync(h.tmpRoot),[],'the private fetch repository is removed');
  assert.match(text,/Claude.*新装 2 个/);
  assert.match(text,/Codex.*新装 2 个/);
});

test('existing same-name skills are skipped, reported and left byte-for-byte unchanged',t=>{
  const f=fakeUpstream(t),h=home(t);
  fs.mkdirSync(path.join(h.claude,'alpha'),{recursive:true});
  fs.writeFileSync(path.join(h.claude,'alpha/SKILL.md'),'my own alpha\n');
  fs.mkdirSync(h.codex,{recursive:true});
  fs.symlinkSync('/srv/elsewhere/beta',path.join(h.codex,'beta'));
  const before={claude:snapshot(path.join(h.claude,'alpha')),link:fs.readlinkSync(path.join(h.codex,'beta'))};
  const {code,text}=runInstall(h,f);
  assert.equal(code,0,text);
  assert.deepEqual(snapshot(path.join(h.claude,'alpha')),before.claude,'a hand-made skill is never overwritten');
  assert.equal(fs.readlinkSync(path.join(h.codex,'beta')),before.link,'a dangling link counts as existing');
  assert.ok(fs.existsSync(path.join(h.claude,'beta/SKILL.md')));
  assert.ok(fs.existsSync(path.join(h.codex,'alpha/SKILL.md')));
  assert.match(text,/跳过 1 个，未覆盖：alpha（已有同名技能但内容不同）/);
  assert.match(text,/跳过 1 个，未覆盖：beta（已有同名技能但内容不同）/);
});

test('a directory that appears after planning is still never replaced',t=>{
  const dir=tempDir(t,'cm-matt-place-');
  const files=new Map([['SKILL.md',Buffer.from('new\n')]]);
  for(const make of [p=>{fs.mkdirSync(p);},p=>{fs.mkdirSync(p);fs.writeFileSync(path.join(p,'SKILL.md'),'mine\n');},p=>fs.writeFileSync(p,'file\n'),p=>fs.symlinkSync('/srv/x',p)]){
    const target=path.join(dir,'late');
    make(target);
    const before=snapshot(dir);
    assert.equal(placeSkill(dir,'late',files),'exists');
    assert.deepEqual(snapshot(dir),before,'the late directory and its parent stay untouched');
    fs.rmSync(target,{recursive:true,force:true});
  }
  assert.equal(placeSkill(dir,'fresh',files),'installed');
  assert.equal(fs.readFileSync(path.join(dir,'fresh/SKILL.md'),'utf8'),'new\n');
  assert.deepEqual(fs.readdirSync(dir),['fresh']);
});

for(const [name,mutate,reason] of [
  ['a changed file',repo=>fs.writeFileSync(path.join(repo,'skills/engineering/beta/NOTES.md'),'tampered\n'),/NOTES\.md 的 SHA-256 与内置清单不一致/],
  ['a changed LICENSE',repo=>fs.writeFileSync(path.join(repo,'LICENSE'),'other\n'),/LICENSE 的 SHA-256/],
  ['an extra file',repo=>fs.writeFileSync(path.join(repo,'skills/productivity/alpha/extra.md'),'x\n'),/多出 extra\.md/],
  ['a missing file',repo=>fs.rmSync(path.join(repo,'skills/engineering/beta/NOTES.md')),/缺少 NOTES\.md/],
  ['a symlink in a skill',repo=>{fs.rmSync(path.join(repo,'skills/engineering/beta/NOTES.md'));fs.symlinkSync('/srv/notes',path.join(repo,'skills/engineering/beta/NOTES.md'));},/不是普通文件（120000）/],
]){
  test(`${name} aborts the whole install before anything is written`,t=>{
    const f=fakeUpstream(t,mutate),h=home(t);
    fs.mkdirSync(path.join(h.claude,'mine'),{recursive:true});
    fs.writeFileSync(path.join(h.claude,'mine/SKILL.md'),'keep\n');
    const before=snapshot(h.claude);
    const {code,text}=runInstall(h,f);
    assert.equal(code,1,text);
    assert.match(text,/核对失败，整批放弃，未写入任何文件/);
    assert.match(text,reason);
    assert.deepEqual(snapshot(h.claude),before);
    assert.equal(snapshot(h.codex),null,'the Codex directory is not even created');
    assert.deepEqual(fs.readdirSync(h.tmpRoot),[]);
  });
}

test('a source without the pinned commit is refused; the CLI cannot swap the manifest',t=>{
  const f=fakeUpstream(t),h=home(t);
  let text='';
  const code=main(['install','--source',f.repo],{env:h.env,write:s=>{text+=s;}});
  assert.equal(code,1,text);
  assert.match(text,new RegExp(`无法从 .* 拉取固定提交 ${UPSTREAM.commit}`));
  assert.equal(snapshot(h.claude),null);
  assert.equal(snapshot(h.codex),null);
  for(const argv of [['install','--manifest','/srv/m.json'],['install','--source'],['status','--json'],['download'],[]]){
    assert.equal(main(argv,{env:h.env,write:()=>{},error:()=>{}}),2,argv.join(' '));
  }
});

test('a relative local source is read from the current directory',t=>{
  const f=fakeUpstream(t),h=home(t);
  const cwd=process.cwd();
  t.after(()=>process.chdir(cwd));
  process.chdir(path.dirname(f.repo));
  const {code,text}=runInstall(h,f,{source:`./${path.basename(f.repo)}`});
  assert.equal(code,0,text);
  assert.match(text,new RegExp(`拉取 ${f.repo.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')} 的固定提交`));
  assert.ok(fs.existsSync(path.join(h.claude,'alpha/SKILL.md')));
});

test('downloaded files are copied, never executed',t=>{
  const marker=path.join(tempDir(t,'cm-matt-marker-'),'ran');
  const f=fakeUpstream(t,repo=>{
    const script=path.join(repo,'skills/productivity/alpha/run.sh');
    fs.writeFileSync(script,`#!/bin/sh\ntouch '${marker}'\n`,{mode:0o755});
  });
  f.skills[0].files['run.sh']=sha256(`#!/bin/sh\ntouch '${marker}'\n`);
  const h=home(t);
  const {code,text}=runInstall(h,f);
  assert.equal(code,0,text);
  assert.ok(fs.existsSync(path.join(h.claude,'alpha/run.sh')));
  assert.equal(fs.statSync(path.join(h.claude,'alpha/run.sh')).mode&0o111,0,'copied without execute bits');
  assert.equal(fs.existsSync(marker),false);
});

test('status counts only pinned author content; a same-named skill is "other"',t=>{
  const f=fakeUpstream(t),h=home(t);
  runInstall(h,f);
  fs.writeFileSync(path.join(h.codex,'alpha/SKILL.md'),'edited\n');
  fs.rmSync(path.join(h.codex,'beta'),{recursive:true});
  const [claude,codex]=skillRoots(h.env);
  const license=f.upstream.license.sha256;
  assert.equal(skillState(claude.root,f.skills[0],license),'author');
  assert.equal(skillState(codex.root,f.skills[0],license),'other');
  assert.equal(skillState(codex.root,f.skills[1],license),'missing');
  fs.writeFileSync(path.join(claude.root,'beta/.DS_Store'),'finder');
  assert.equal(skillState(claude.root,f.skills[1],license),'author','Finder metadata does not demote a skill');
  const text=statusText({env:h.env,skills:f.skills,upstream:f.upstream,command:'node /srv/cm/scripts/cm-matt-skills.mjs install'});
  assert.match(text,/recommended skills \[claude\] 2\/2 author versions/);
  assert.match(text,/recommended skills \[codex\] 0\/2 author versions/);
  assert.match(text,/\[codex\] alpha: same name, different content/);
  assert.match(text,/\[codex\] beta: missing/);
  assert.match(text,/install \(optional\): node \/srv\/cm\/scripts\/cm-matt-skills\.mjs install/);
});

test('installer hint: full list once, one line while the same set is missing, full again when it changes',t=>{
  const f=fakeUpstream(t),h=home(t);
  const command='node /srv/cm/scripts/cm-matt-skills.mjs install';
  const first=hint({env:h.env,skills:f.skills,upstream:f.upstream,command});
  assert.match(first,/Claude（~\/\.claude\/skills）和Codex（~\/\.agents\/skills）都缺 2 个/);
  assert.match(first,/alpha +alpha use/);
  assert.match(first,/CM 不依赖）/);
  assert.ok(first.includes(command));
  const second=hint({env:h.env,skills:f.skills,upstream:f.upstream,command});
  assert.equal(second.trim().split('\n').length,1);
  assert.match(second,/还缺 2 个.*node \/srv\/cm/);
  fs.mkdirSync(path.join(h.codex,'alpha'),{recursive:true});
  fs.writeFileSync(path.join(h.codex,'alpha/SKILL.md'),'other\n');
  const third=hint({env:h.env,skills:f.skills,upstream:f.upstream,command});
  assert.match(third,/Claude（~\/\.claude\/skills）缺 2 个/);
  assert.match(third,/Codex（~\/\.agents\/skills）缺 2 个/);
  assert.match(third,/alpha +alpha use（已有同名技能但内容不同，安装时会跳过）/);
  fs.rmSync(path.join(h.codex,'alpha'),{recursive:true});
  runInstall(h,f);
  assert.match(hint({env:h.env,skills:f.skills,upstream:f.upstream,command}),/^✓ 推荐搭配的 2 个 Matt Pocock 技能已齐/);
});

test('a gap that closes and then reopens identically is listed in full again',t=>{
  const f=fakeUpstream(t),h=home(t);
  const ask=()=>hint({env:h.env,skills:f.skills,upstream:f.upstream,command:'x'}).trim().split('\n').length;
  const removeAlpha=()=>{for(const dir of [h.claude,h.codex])fs.rmSync(path.join(dir,'alpha'),{recursive:true});};
  runInstall(h,f);
  removeAlpha();
  assert.ok(ask()>1);
  assert.equal(ask(),1);
  runInstall(h,f);
  assert.equal(ask(),1,'all present');
  removeAlpha();
  assert.ok(ask()>1,'the same gap after being closed is new again');
});

test('the hint state never writes through a link planted at its path',t=>{
  const f=fakeUpstream(t),h=home(t);
  const stateFile=path.join(h.env.CM_WORKFLOW_HOME,'matt-skills-hint');
  fs.mkdirSync(h.env.CM_WORKFLOW_HOME,{recursive:true});
  const victim=path.join(h.dir,'victim.txt');
  fs.writeFileSync(victim,'precious\n');
  fs.symlinkSync(victim,stateFile);
  hint({env:h.env,skills:f.skills,upstream:f.upstream,command:'x'});
  assert.equal(fs.readFileSync(victim,'utf8'),'precious\n');
  assert.equal(fs.lstatSync(stateFile).isSymbolicLink(),false,'the link entry itself is replaced');
  // A hard link holding the very fingerprint the hint would trust: still not trusted.
  const shared=path.join(h.dir,'shared.txt');
  fs.writeFileSync(shared,fs.readFileSync(stateFile,'utf8'));
  const sharedBefore=fs.readFileSync(shared,'utf8');
  fs.rmSync(stateFile);
  fs.linkSync(shared,stateFile);
  const text=hint({env:h.env,skills:f.skills,upstream:f.upstream,command:'x'});
  assert.ok(text.trim().split('\n').length>1,'a hard-linked state file is not trusted');
  assert.equal(fs.readFileSync(shared,'utf8'),sharedBefore,'the shared inode is not rewritten');
  assert.deepEqual(fs.readdirSync(h.env.CM_WORKFLOW_HOME).filter(n=>n.endsWith('.tmp')),[]);
});

test('author state needs the exact file set and the upstream LICENSE',t=>{
  const f=fakeUpstream(t),h=home(t);
  runInstall(h,f);
  const license=f.upstream.license.sha256;
  const [claude,codex]=skillRoots(h.env);
  fs.writeFileSync(path.join(claude.root,'alpha/LICENSE'),'changed\n');
  assert.equal(skillState(claude.root,f.skills[0],license),'other');
  fs.rmSync(path.join(claude.root,'beta/LICENSE'));
  assert.equal(skillState(claude.root,f.skills[1],license),'other');
  fs.writeFileSync(path.join(codex.root,'alpha/extra.md'),'x\n');
  assert.equal(skillState(codex.root,f.skills[0],license),'other');
  fs.symlinkSync('/srv/notes',path.join(codex.root,'beta/link.md'));
  assert.equal(skillState(codex.root,f.skills[1],license),'other');
});

test('an unusable skills root is a reported failure, never "already installed"',t=>{
  const f=fakeUpstream(t),h=home(t);
  fs.mkdirSync(path.dirname(h.claude),{recursive:true});
  fs.writeFileSync(h.claude,'not a directory\n');
  const {code,text}=runInstall(h,f);
  assert.equal(code,1,text);
  assert.match(text,/Claude 技能目录 .* 不是目录，这一侧不安装/);
  assert.ok(fs.existsSync(path.join(h.codex,'alpha/SKILL.md')),'the other side still installs');
  assert.equal(fs.readFileSync(h.claude,'utf8'),'not a directory\n');
  const report=status({env:h.env,skills:f.skills,upstream:f.upstream});
  assert.equal(report[0].problem,'不是目录');
  assert.ok(report[0].skills.every(s=>s.state==='unreadable'));
  assert.match(statusText({env:h.env,skills:f.skills,upstream:f.upstream,command:'x'}),/\[claude\] WARN skills directory .*: 不是目录/);
  fs.rmSync(path.join(h.codex,'alpha'),{recursive:true});
  fs.rmSync(path.join(h.codex,'beta'),{recursive:true});
  fs.rmSync(h.claude);
  fs.symlinkSync('/srv/missing-target',h.claude);
  const again=runInstall(h,f);
  assert.equal(again.code,1);
  assert.match(again.text,/是失效的链接/);
});

test('git runs without the user configuration or GIT_* control variables',t=>{
  const leaked={GIT_DIR:'/srv/not-a-repo',GIT_CONFIG_COUNT:'1',GIT_CONFIG_KEY_0:'core.hooksPath',
    GIT_CONFIG_VALUE_0:'/srv/hooks',GIT_CONFIG_PARAMETERS:"'core.hookspath'='/srv/hooks'",GIT_SSH_COMMAND:'/srv/ssh',
    GIT_ASKPASS:'/srv/askpass',https_proxy:'http://proxy.invalid:1'};
  const env=gitEnv({...leaked,PATH:'/usr/bin'},'/srv/fetch-home');
  for(const key of ['GIT_DIR','GIT_CONFIG_COUNT','GIT_CONFIG_KEY_0','GIT_CONFIG_VALUE_0','GIT_CONFIG_PARAMETERS','GIT_SSH_COMMAND'])
    assert.equal(env[key],undefined,key);
  assert.equal(env.GIT_ASKPASS,'');
  assert.equal(env.GIT_CONFIG_GLOBAL,os.devNull);
  assert.equal(env.GIT_CONFIG_NOSYSTEM,'1');
  assert.equal(env.HOME,'/srv/fetch-home');
  assert.equal(env.https_proxy,'http://proxy.invalid:1','proxies pass through');
  // End to end: leaked variables that would break or hook a git call change nothing.
  const f=fakeUpstream(t),h=home(t);
  const marker=path.join(h.dir,'hook-ran');
  const hooks=path.join(h.dir,'hooks');
  fs.mkdirSync(hooks);
  for(const name of ['reference-transaction','post-checkout','post-merge'])
    fs.writeFileSync(path.join(hooks,name),`#!/bin/sh\ntouch '${marker}'\n`,{mode:0o755});
  const saved={...process.env};
  t.after(()=>{for(const key of Object.keys(process.env))if(!(key in saved))delete process.env[key];Object.assign(process.env,saved);});
  Object.assign(process.env,{GIT_DIR:'/srv/not-a-repo',GIT_CONFIG_COUNT:'1',GIT_CONFIG_KEY_0:'core.hooksPath',GIT_CONFIG_VALUE_0:hooks});
  const {code,text}=runInstall(h,f);
  assert.equal(code,0,text);
  assert.equal(fs.existsSync(marker),false);
});

test('the printed command is shell-safe',()=>{
  const env={HOME:'/srv/u'};
  assert.equal(installCommand(env,'/srv/u/.claude/scripts/cm-matt-skills.mjs'),'node ~/.claude/scripts/cm-matt-skills.mjs install');
  assert.equal(installCommand(env,"/srv/my dir/it's/cm-matt-skills.mjs"),`node '/srv/my dir/it'\\''s/cm-matt-skills.mjs' install`);
});

test('installers put the skills in by default and accept --no-matt-skills; /cm-check only reports',()=>{
  for(const [file,dest] of [['install.sh','$DEST'],['install-codex.sh','$PLUGIN_DEST']]){
    const text=read(file);
    assert.ok(text.includes(`node "${dest}/scripts/cm-matt-skills.mjs" auto \${SKIP_MATT_SKILLS:+--no-matt-skills} </dev/null || true`),file);
    assert.ok(text.includes('--no-matt-skills) SKIP_MATT_SKILLS=1 ;;'),`${file} accepts --no-matt-skills`);
    assert.ok(!/cm-matt-skills\.mjs"? install/.test(text),`${file} never runs the manual install`);
  }
  const ps=read('install.ps1');
  assert.ok(ps.includes('[switch]$NoMattSkills'),'install.ps1 accepts -NoMattSkills');
  assert.ok(ps.includes('$MattArgs = @("auto")')&&ps.includes('if ($NoMattSkills) { $MattArgs += "--no-matt-skills" }'),'install.ps1 runs auto');
  const checker=read('scripts/cm-check-runtime.sh');
  assert.match(checker,/if \[ "\$PRINT_EFFECTIVE" -eq 1 \] && \[ -f "\$ROOT\/scripts\/cm-matt-skills\.mjs" \]; then\n    "\$NODE_BIN" "\$ROOT\/scripts\/cm-matt-skills\.mjs" status \|\|\n      warn /);
  for(const [skill,name] of [['cm-challenge','grill-with-docs'],['cm-refactor','improve-codebase-architecture']]){
    const text=read(`skills/${skill}/SKILL.md`);
    assert.ok(text.includes('cm-matt-skills.mjs" status'),skill);
    assert.ok(text.includes(name),skill);
    assert.match(text,/照旧/,`${skill} keeps its own flow when the author skill is absent`);
  }
});

// ---- install-time default ----
async function runAuto(h,f,extra={}){
  let text='';
  const code=await autoInstall({env:h.env,source:f.repo,upstream:f.upstream,skills:f.skills,tmpRoot:h.tmpRoot,write:s=>{text+=s;},command:'x',...extra});
  return {code,text};
}
const readRecord=h=>JSON.parse(fs.readFileSync(autoPath(h.env),'utf8'));
const writeLocal=(h,text)=>{fs.mkdirSync(path.dirname(localPath(h.env)),{recursive:true});fs.writeFileSync(localPath(h.env),text);};

test('auto installs the missing skills into both directories by default and records what is there',async t=>{
  const f=fakeUpstream(t),h=home(t);
  const {code,text}=await runAuto(h,f);
  assert.equal(code,0);
  for(const root of [h.claude,h.codex])for(const s of f.skills)assert.equal(skillState(root,s,f.upstream.license.sha256),'author');
  assert.match(text,/新装 2 个：alpha、beta/);
  assert.match(text,/--no-matt-skills 只管这一次/);
  assert.deepEqual(readRecord(h),{version:1,installed:{claude:['alpha','beta'],codex:['alpha','beta']}});
  const again=await runAuto(h,f);
  assert.equal(again.code,0);
  assert.match(again.text,/无需安装/);
  assert.deepEqual(readRecord(h),{version:1,installed:{claude:['alpha','beta'],codex:['alpha','beta']}});
});

test('a skill the user removed after CM saw it there is never put back; one not yet seen still is',async t=>{
  const f=fakeUpstream(t),h=home(t);
  await runAuto(h,f);
  fs.rmSync(path.join(h.claude,'alpha'),{recursive:true});
  fs.rmSync(path.join(h.codex,'alpha'),{recursive:true});
  fs.rmSync(path.join(h.codex,'beta'),{recursive:true});
  // Pretend CM never saw beta at codex: it is missing and unsettled, so it is installed again.
  fs.writeFileSync(autoPath(h.env),JSON.stringify({version:1,installed:{claude:['alpha','beta'],codex:['alpha']}})+'\n');
  const {code,text}=await runAuto(h,f);
  assert.equal(code,0);
  assert.equal(skillState(h.claude,f.skills[0],f.upstream.license.sha256),'missing');
  assert.equal(skillState(h.codex,f.skills[0],f.upstream.license.sha256),'missing');
  assert.equal(skillState(h.codex,f.skills[1],f.upstream.license.sha256),'author');
  assert.match(text,/Codex[^\n]*新装 1 个：beta/);
  assert.match(text,/alpha 之前装过后被你删掉，不再自动装回/);
  assert.deepEqual(readRecord(h),{version:1,installed:{claude:['alpha','beta'],codex:['alpha','beta']}});
  const both=await runAuto(h,f);
  assert.ok(!/新装/.test(both.text),'nothing left to install');
  assert.match(both.text,/不再自动装回/);
});

test('a skill already there before the first auto run counts as seen, so removing it later is respected',async t=>{
  const f=fakeUpstream(t),h=home(t);
  const first=await runAuto(h,f,{skills:[f.skills[0]]});
  assert.equal(first.code,0);
  const second=await runAuto(h,f);
  assert.equal(second.code,0);
  assert.deepEqual(readRecord(h).installed,{claude:['alpha','beta'],codex:['alpha','beta']});
  fs.rmSync(path.join(h.claude,'alpha'),{recursive:true});
  const third=await runAuto(h,f);
  assert.equal(skillState(h.claude,f.skills[0],f.upstream.license.sha256),'missing');
  assert.match(third.text,/不再自动装回/);
});

test('--no-matt-skills and CM_MATT_SKILLS_INSTALL=off skip this run and only hint; {"install": false} turns it off for good',async t=>{
  const f=fakeUpstream(t),h=home(t);
  for(const extra of [{skip:true},{env:{...h.env,CM_MATT_SKILLS_INSTALL:'off'}}]){
    const {code,text}=await runAuto(h,f,extra);
    assert.equal(code,0);
    assert.match(text,/这次不自动安装（只管这一次/);
    assert.match(text,/推荐(搭配 Matt Pocock 的技能|的 Matt Pocock 技能还缺 2 个)/,'the plain hint still says what is missing');
    assert.equal(snapshot(h.claude),null);
    assert.equal(snapshot(h.codex),null);
    assert.ok(!fs.existsSync(autoPath(h.env)),'an opted-out run settles nothing');
  }
  writeLocal(h,'{"install": false}\n');
  const off=await runAuto(h,f);
  assert.equal(off.code,0);
  assert.match(off.text,/install 为 false，不自动安装；要装运行 x/);
  assert.equal(snapshot(h.claude),null);
  assert.ok(!fs.existsSync(autoPath(h.env)));
  assert.match(statusText({env:h.env,skills:f.skills,upstream:f.upstream,command:'x'}),/auto-install at install time: off \(/);
});

test('a local file CM cannot use pauses the default: a warning, nothing written, the file kept',async t=>{
  for(const bad of ['','   ','{bad','{"install": "no"}','[]','{"install": 1}']){
    const f=fakeUpstream(t),h=home(t);
    writeLocal(h,bad);
    const {code,text}=await runAuto(h,f);
    assert.equal(code,1,JSON.stringify(bad));
    assert.match(text,/⚠ 作者技能：.*这次不自动安装；改好后重装或运行 x/);
    assert.equal(snapshot(h.claude),null);
    assert.equal(fs.readFileSync(localPath(h.env),'utf8'),bad);
    assert.match(statusText({env:h.env,skills:f.skills,upstream:f.upstream,command:'x'}),/auto-install at install time: paused \(/);
  }
});

test('a record CM cannot read pauses the default and is kept as is',async t=>{
  for(const bad of ['{"version": 2, "installed": {}}','{"version": 1, "installed": {"other": []}}','{"version": 1, "installed": {"claude": ["Bad Name"]}}','nope']){
    const f=fakeUpstream(t),h=home(t);
    fs.mkdirSync(path.dirname(autoPath(h.env)),{recursive:true});
    fs.writeFileSync(autoPath(h.env),bad);
    const {code,text}=await runAuto(h,f);
    assert.equal(code,1,bad);
    assert.match(text,/⚠ 作者技能：.*异常/);
    assert.match(text,/推荐搭配 Matt Pocock 的技能/);
    assert.equal(snapshot(h.claude),null);
    assert.equal(fs.readFileSync(autoPath(h.env),'utf8'),bad);
    assert.equal(settledSkills(h.env).state,'invalid');
  }
});

test('a fetch that fails only warns and names the manual command; nothing is written or recorded',async t=>{
  const f=fakeUpstream(t),h=home(t);
  const {code,text}=await runAuto(h,f,{upstream:{...f.upstream,commit:'0'.repeat(40)}});
  assert.equal(code,1);
  assert.match(text,/✗ 核对失败，整批放弃，未写入任何文件/);
  assert.match(text,/作者技能不影响 CM 使用；稍后可手动运行 x/);
  assert.equal(snapshot(h.claude),null);
  assert.equal(snapshot(h.codex),null);
  assert.ok(!fs.existsSync(autoPath(h.env)));
});

test('the gate reads the environment and the local file only',t=>{
  const h=home(t);
  assert.equal(installGate(h.env),null);
  assert.deepEqual(installGate(h.env,true),{optOut:'安装参数 --no-matt-skills'});
  assert.deepEqual(installGate({...h.env,CM_MATT_SKILLS_INSTALL:'off'}),{optOut:'环境变量 CM_MATT_SKILLS_INSTALL=off'});
  assert.equal(installGate({...h.env,CM_MATT_SKILLS_INSTALL:'on'}),null);
  writeLocal(h,'{"install": true}');
  assert.equal(installGate(h.env),null);
});

test('the auto command parses its arguments like install',async t=>{
  const f=fakeUpstream(t),h=home(t);
  let text='',err='';
  assert.equal(await main(['auto','--bogus'],{env:h.env,write:s=>{text+=s;},error:s=>{err+=s;}}),2);
  assert.equal(await main(['auto','--source'],{env:h.env,write:s=>{text+=s;},error:s=>{err+=s;}}),2);
  assert.match(err,/auto \[--no-matt-skills\]/);
  assert.equal(await main(['auto','--no-matt-skills','--source',f.repo],{env:{...h.env},write:s=>{text+=s;},error:s=>{err+=s;}}),0);
  assert.match(text,/这次不自动安装/);
  assert.equal(snapshot(h.claude),null);
});

test('a same-named skill with other content counts as seen too: removed later, it is not put back',async t=>{
  const f=fakeUpstream(t),h=home(t);
  fs.mkdirSync(path.join(h.claude,'alpha'),{recursive:true});
  fs.writeFileSync(path.join(h.claude,'alpha','SKILL.md'),'mine\n');
  const first=await runAuto(h,f);
  assert.equal(first.code,0);
  assert.match(first.text,/跳过 1 个，未覆盖：alpha（已有同名技能但内容不同）/);
  assert.equal(fs.readFileSync(path.join(h.claude,'alpha','SKILL.md'),'utf8'),'mine\n');
  assert.deepEqual(readRecord(h).installed,{claude:['alpha','beta'],codex:['alpha','beta']});
  fs.rmSync(path.join(h.claude,'alpha'),{recursive:true});
  const second=await runAuto(h,f);
  assert.equal(second.code,0);
  assert.equal(skillState(h.claude,f.skills[0],f.upstream.license.sha256),'missing');
  assert.match(second.text,/Claude 的 alpha 之前装过后被你删掉，不再自动装回/);
});

test('an unreadable skill is never recorded as seen',async t=>{
  const f=fakeUpstream(t),h=home(t);
  fs.mkdirSync(h.claude,{recursive:true});
  fs.writeFileSync(path.join(h.claude,'alpha'),'not a directory\n');
  const {code}=await runAuto(h,f);
  assert.equal(code,0);
  assert.deepEqual(readRecord(h).installed,{claude:['alpha','beta'],codex:['alpha','beta']},'a file at the name is "other": present, kept, seen');
  const g=fakeUpstream(t),k=home(t);
  fs.mkdirSync(k.claude,{recursive:true});
  fs.mkdirSync(path.join(k.claude,'alpha'),{mode:0o000});
  try{
    if(process.getuid?.()!==0){
      const r=await runAuto(k,g);
      assert.equal(r.code,1,'an unreadable skill is reported as a failure');
      assert.deepEqual(readRecord(k).installed,{claude:['beta'],codex:['alpha','beta']});
    }
  }finally{fs.chmodSync(path.join(k.claude,'alpha'),0o755);}
});
