import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {buildManifest} from './cm-spec-manifest.mjs';
import {cmInitRuleTargets} from '../runtime/js/cm-init/draft-generation.mjs';
import {bootstrapDriverGap} from './cm-ai-drive.mjs';
import {inspectDriverBootstrap,readBootstrapRulesAnswers,createBootstrapRulesResponder} from '../runtime/js/cm-ai/drive-bootstrap.mjs';

// In-process helpers never touch the invoking user's workflow or log home.
const isolatedHome=fs.mkdtempSync(path.join(os.tmpdir(),'cm-ai-drive-rules-home-'));
process.env.CM_WORKFLOW_HOME=path.join(isolatedHome,'user');
process.env.CM_WORKFLOW_LOG_HOME=path.join(isolatedHome,'logs');
after(()=>fs.rmSync(isolatedHome,{recursive:true,force:true}));
const DRIVER=fileURLToPath(new URL('./cm-ai-drive.mjs',import.meta.url));
const HOST=fileURLToPath(new URL('./cm-ai-host.mjs',import.meta.url));
const selection={versionControl:'local',modules:[],analysis:'SwiftUI iOS app: Package.swift, Sources/AITide, local Git'};
const scaffold={'Package.swift':'// swift-tools-version:5.9\nimport PackageDescription\nlet package = Package(name: "AITide", targets: [.executableTarget(name: "AITide")])\n',
  'Sources/AITide/AITideApp.swift':'import SwiftUI\n@main struct AITideApp: App { var body: some Scene { WindowGroup { Text("AITide") } } }\n',
  'scripts/verify.sh':'set -e\ntest -f Package.swift\ntest -f Sources/AITide/AITideApp.swift\nif [ "$1" = "--strict" ]; then test -f Sources/AITide/Missing.swift; fi\n'};
const learning={application:{status:'no_relevant_lesson',note:null},retrospective:{status:'no_new_lesson',candidates:[],reason:null}};

function fixture(t,{scaffolded=false}={}){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-ai-drive-rules-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const specsDir=path.join(root,'specs5'),codeProject=path.join(root,'app'),feature='1.bootstrap';
  fs.mkdirSync(path.join(specsDir,feature),{recursive:true});fs.mkdirSync(codeProject);
  fs.writeFileSync(path.join(specsDir,feature,'requirements.md'),'# SwiftUI scaffold and rules\n');
  fs.writeFileSync(path.join(specsDir,feature,'design.md'),'# Split specs5 and app roots; SwiftUI; local Git\n');
  fs.writeFileSync(path.join(specsDir,feature,'tasks.md'),
    `- [${scaffolded?'x':' '}] T-001: 生成项目骨架 scaffold\n- [ ] T-002: 生成 AGENTS.md 和 .claude/ 规范（cm-init）\n`);
  fs.writeFileSync(path.join(specsDir,'.cm-specs-status'),JSON.stringify({status:'approved',features:[feature],specFiles:buildManifest(specsDir)}));
  if(scaffolded)for(const [file,content] of Object.entries(scaffold)){
    fs.mkdirSync(path.dirname(path.join(codeProject,file)),{recursive:true});fs.writeFileSync(path.join(codeProject,file),content);
  }
  const answers=path.join(root,'answers'),bin=path.join(root,'bin');fs.mkdirSync(answers);fs.mkdirSync(bin);
  const env={...process.env,PATH:bin+path.delimiter+process.env.PATH,
    CM_WORKFLOW_HOME:path.join(root,'home'),CM_WORKFLOW_LOG_HOME:path.join(root,'logs')};
  const write=(name,value)=>{const file=path.join(answers,name);fs.mkdirSync(path.dirname(file),{recursive:true});
    fs.writeFileSync(file,typeof value==='string'?value:JSON.stringify(value));};
  // key names the run definition file and its runId; a task may get a fresh run.
  const writeRun=(taskId,scope,key=taskId)=>fs.writeFileSync(path.join(root,`run-${key}.json`),JSON.stringify({version:1,specsDir,codeProject,feature,
    identity:{repositoryId:'app',runId:`bootstrap-${key}`,taskId,attempt:1},scope,requirements:[]}));
  const writeBootstrap=value=>fs.writeFileSync(path.join(root,'bootstrap.json'),JSON.stringify({selection:value}));
  const plan=(key,mode,permissions,extra={})=>{
    const file=path.join(root,`plan-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(file,JSON.stringify({config:`run-${key}.json`,mode,hostContext:'drive-rules-host',runtime:'claude',
      permissions,answers:'answers',checks:[{id:'structure',command:['/bin/sh','scripts/verify.sh']}],...extra}));
    return file;
  };
  const drive=(file,operation)=>spawnSync(process.execPath,[DRIVER,'--plan',file,operation],{encoding:'utf8',timeout:60000,env});
  const store=key=>path.join(specsDir,'.reviews','.execution',`bootstrap-${key}`);
  const targets=cmInitRuleTargets(selection,codeProject);
  return {root,specsDir,codeProject,feature,answers,bin,env,write,writeRun,writeBootstrap,plan,drive,store,targets};
}
const rulesPermissions=['--bootstrap-config','bootstrap.json','--allow-bootstrap-write'];

// The session's own instruction documents for one attempt, as content files.
function rulesDocuments(f,attempt,{agents}={}){
  const baseAgents='# AITide\n\n## 常用命令\n\n- 结构检查: `sh scripts/verify.sh`\n';
  const contents={
    'AGENTS.md':agents??(attempt===1?baseAgents:baseAgents+'- 严格检查: `sh scripts/verify.sh --strict`（新增模块后）\n'),
    '.claude/CLAUDE.md':'# AITide\n\n## 规则\n\n@rules/coding-style.md\n@rules/testing.md\n@rules/security.md\n@rules/git-workflow.md\n',
    '.claude/rules/coding-style.md':'# 代码风格\n\nSwiftUI 视图放 Sources/AITide。\n',
    '.claude/rules/testing.md':attempt===1?'# 测试\n\n运行 `sh scripts/verify.sh`。\n'
      :'# 测试\n\n运行 `sh scripts/verify.sh`；新增 Swift 文件后补结构检查。\n',
    '.claude/rules/security.md':'# 安全\n\n不提交密钥。\n',
    '.claude/rules/git-workflow.md':'# Git\n\n本地仓库，无远端。\n'};
  const documents=f.targets.map(file=>{const local=`t002-a${attempt}/${file.replace(/[/.]/g,'_')}.md`;
    f.write(local,contents[file]);return {path:file,contentFile:local};});
  return {generate:{status:'generated',documents},contents};
}
function verifyAnswer(commands=[{id:'verify',command:['/bin/sh','scripts/verify.sh'],timeoutMs:60000}],extra={}){
  const checks=Object.fromEntries(['globs','file_references','constraint_preservation','rule_applicability']
    .map(name=>[name,{status:'verified',evidence:`Session checked ${name} against app/ before writing this file`}]));
  return {commands,commandsNotRun:null,checks,constraintChanges:[],...learning,...extra};
}
function prepareRules(f,attempt,options={}){
  const suffix=attempt===1?'':`-a${attempt}`,docs=rulesDocuments(f,attempt,options);
  f.write(`init-generate${suffix}.json`,docs.generate);f.write(`init-verify${suffix}.json`,verifyAnswer(options.commands));
  return docs.contents;
}
function assertRefusedBeforeLaunch(f,run,pattern){
  assert.equal(run.status,2,run.stderr);assert.match(run.stderr,pattern);
  assert.equal(fs.existsSync(f.store('T-002')),false,'preflight must not create the T-002 run store');
  assert.equal(fs.existsSync(path.join(f.codeProject,'.claude')),false);
}

test('help names the rules answer files and that command results come only from real runs',()=>{
  const help=spawnSync(process.execPath,[DRIVER,'--help'],{encoding:'utf8'});
  assert.equal(help.status,0);
  for(const pattern of [/init-generate\.json/,/init-verify\.json/,/init-generate-a2\.json 与 init-verify-a2\.json/,/commands 结果只来自实跑/])
    assert.match(help.stdout,pattern);
});

test('rules task driver support covers only pure single-root non-provider scope',t=>{
  const f=fixture(t,{scaffolded:true});f.writeBootstrap(selection);
  const config=path.join(f.root,'bootstrap.json');
  const definition={specsDir:f.specsDir,codeProject:f.codeProject,feature:f.feature,scope:[...f.targets],
    identity:{repositoryId:'app',runId:'t002',taskId:'T-002',attempt:1}};
  const permissions=['--bootstrap-config',config,'--allow-bootstrap-write'];
  for(const operation of ['advance','start','resume'])assert.equal(bootstrapDriverGap(operation,definition,permissions),null);
  assert.match(bootstrapDriverGap('advance',definition,[...permissions,'--protected-config','x.json']),/--protected-config/);
  assert.match(bootstrapDriverGap('advance',{...definition,codeProjects:['ios']},permissions),/codeProjects/);
  assert.match(bootstrapDriverGap('advance',{...definition,scope:[...f.targets,'README.md']},permissions),/业务文件 README\.md/);
  assert.match(bootstrapDriverGap('advance',{...definition,scope:f.targets.slice(1)},permissions),/缺少固定目标 AGENTS\.md/);
  f.writeBootstrap(null);
  assert.match(bootstrapDriverGap('advance',definition,permissions),/selection/);
});

test('rules answer files are validated before the host starts',t=>{
  const f=fixture(t,{scaffolded:true});f.writeRun('T-002',[...f.targets]);f.writeBootstrap(selection);
  const run=(extra={})=>f.drive(f.plan('T-002','create',[...rulesPermissions,...(extra.permissions??[])],extra.plan),'advance');
  assertRefusedBeforeLaunch(f,run(),/会反问 init_generate，但答案文件不存在: .*init-generate\.json/);
  const {generate}=rulesDocuments(f,1);
  const cases=[
    ['blocked generation',()=>f.write('init-generate.json',{status:'blocked',documents:[]}),/status 只能是 generated/],
    ['missing target',()=>f.write('init-generate.json',{...generate,documents:generate.documents.slice(1)}),/须逐项覆盖 targets/],
    ['unsafe content file',()=>f.write('init-generate.json',{...generate,documents:generate.documents.map((item,index)=>
      index===0?{...item,contentFile:'../outside.md'}:item)}),/路径无效/],
    ['structural issue',()=>{f.write(generate.documents[1].contentFile,'# x\n'+'line\n'.repeat(160));
      f.write('init-generate.json',generate);},/结构检查未通过: \.claude\/CLAUDE\.md:claude_line_limit/],
    ['extra key',()=>f.write('init-generate.json',{...generate,note:'x'}),/只允许 status 与 documents/],
    ['non UTF-8 content',()=>{fs.writeFileSync(path.join(f.answers,generate.documents[3].contentFile),Buffer.from([0xff,0xfe,0x41]));
      f.write('init-generate.json',generate);},/不是 UTF-8 文本/],
    ['symlinked content',()=>{const target=path.join(f.answers,generate.documents[4].contentFile);fs.rmSync(target);
      fs.writeFileSync(path.join(f.root,'outside.md'),'# outside\n');fs.symlinkSync(path.join(f.root,'outside.md'),target);
      f.write('init-generate.json',generate);},/缺少安全的内容文件/],
    ['oversized reply',()=>{f.write(generate.documents[2].contentFile,'# big\n'+'x'.repeat(70*1024)+'\n');
      f.write('init-generate.json',generate);},/超过宿主单次回复 64 KiB/],
  ];
  for(const [name,setup,pattern] of cases){
    for(const item of generate.documents)fs.rmSync(path.join(f.answers,item.contentFile),{force:true});
    rulesDocuments(f,1);f.write('init-verify.json',verifyAnswer());setup();
    assertRefusedBeforeLaunch(f,run(),pattern);
    t.diagnostic(`refused: ${name}`);
  }
  rulesDocuments(f,1);f.write('init-generate.json',generate);fs.rmSync(path.join(f.answers,'init-verify.json'));
  assertRefusedBeforeLaunch(f,run(),/会反问 init_verify，但答案文件不存在/);
  const verifyCases=[
    ['static command result',verifyAnswer(undefined,{checks:{...verifyAnswer().checks,commands:{status:'verified',evidence:'ran ok'}}}),
      /checks 不能包含 commands；命令核验只由驾驶员实跑/],
    ['no commands',verifyAnswer([]),/commands 须列出 1\.\.32 条/],
    ['unverified group',verifyAnswer(undefined,{checks:{...verifyAnswer().checks,globs:{status:'unverified',evidence:'no match yet'}}}),
      /checks\.globs 为 unverified：宿主只接受 verified\/not_applicable/],
    ['constraint change',verifyAnswer(undefined,{constraintChanges:['AGENTS.md']}),/constraintChanges 必须为空/],
    ['over budget',verifyAnswer([{id:'a',command:['/bin/sh','scripts/verify.sh']},{id:'b',command:['/bin/sh','scripts/verify.sh']}]),
      /超时合计 1800000 ms，须小于宿主开发步骤预算/],
    ['invalid Learning',verifyAnswer(undefined,{application:{status:'applied',note:null}}),/application 须为原 Learning/],
    ['rebound Learning',verifyAnswer(undefined,{application:{...learning.application,feature:'2.other'}}),/application 须为原 Learning/],
    ['invalid retrospective',verifyAnswer(undefined,{retrospective:{status:'lesson_candidate',candidates:[],reason:null}}),
      /retrospective 须为原 Learning/],
    ['bad command',verifyAnswer([{id:'bad id',command:['/bin/sh']}]),/init-verify\.json\.commands/],
    ['extra key',{...verifyAnswer(),passed:true},/init-verify\.json 需要 commands/],
    ['multi-line note',verifyAnswer(undefined,{commandsNotRun:'line one\nline two'}),/commandsNotRun 须为 null 或单行说明/],
    ['missing group',verifyAnswer(undefined,{checks:{...verifyAnswer().checks,globs:undefined}}),/checks 须恰好包含/],
    ['empty evidence',verifyAnswer(undefined,{checks:{...verifyAnswer().checks,globs:{status:'verified',evidence:' '}}}),
      /checks\.globs 须为 \{status,evidence\}/],
  ];
  for(const [name,value,pattern] of verifyCases){
    f.write('init-verify.json',value);assertRefusedBeforeLaunch(f,run(),pattern);t.diagnostic(`refused: ${name}`);
  }
  f.write('init-verify.json',verifyAnswer());f.write('init-verify-a1.json',verifyAnswer());
  assertRefusedBeforeLaunch(f,run(),/init-verify\.json 与 init-verify-a1\.json 不能同时存在/);
  fs.rmSync(path.join(f.answers,'init-verify-a1.json'));
  assertRefusedBeforeLaunch(f,run({permissions:['--allow-review-attempt','1']}),
    /缺少 .*init-generate-a2\.json；本次 advance 带 --allow-review-attempt 1.*\.reviews\/bootstrap-T-002-r1\.md.*init-verify-a2\.json/);
  // A preloaded revision runs after attempt 1 writes, so only its own shape is checked now.
  const {generate:revision}=rulesDocuments(f,2);f.write('init-generate-a2.json',revision);f.write('init-verify-a2.json',verifyAnswer());
  f.write(revision.documents[1].contentFile,'# x\n'+'line\n'.repeat(160));
  assertRefusedBeforeLaunch(f,run({permissions:['--allow-review-attempt','1']}),
    /^\[drive\] init-generate-a2\.json 结构检查未通过: \.claude\/CLAUDE\.md:claude_line_limit/m);
});

test('attempt 1 refuses existing instructions the host would not overwrite',t=>{
  const f=fixture(t,{scaffolded:true});f.writeRun('T-002',[...f.targets]);f.writeBootstrap(selection);prepareRules(f,1);
  const run=()=>f.drive(f.plan('T-002','create',rulesPermissions),'advance');
  fs.writeFileSync(path.join(f.codeProject,'AGENTS.md'),'# User-owned rules\n');
  assertRefusedBeforeLaunch(f,run(),/规范目标已存在: AGENTS\.md/);
  // A T-001 Learning section is allowed; the draft must keep every other existing line.
  fs.writeFileSync(path.join(f.codeProject,'AGENTS.md'),'# User-owned rules\n\n## 项目教训\n\n- 保留骨架教训\n');
  assertRefusedBeforeLaunch(f,run(),/必须逐字保留当前 AGENTS\.md 中「## 项目教训」段以外的全部内容/);
});

test('responder binds each host request to the preflighted attempt and its own command runs',
  {skip:process.platform==='win32'},async t=>{
  const f=fixture(t,{scaffolded:true});f.writeBootstrap(selection);
  const identity={repositoryId:'app',runId:'t002',taskId:'T-002',attempt:1};
  const definition={specsDir:f.specsDir,codeProject:f.codeProject,feature:f.feature,scope:[...f.targets],identity};
  const bootstrap=inspectDriverBootstrap({advance:true,definition,
    permissions:['--bootstrap-config',path.join(f.root,'bootstrap.json')]});
  const contents=prepareRules(f,1,{commands:[{id:'strict',command:['/bin/sh','scripts/verify.sh','--strict'],timeoutMs:60000}]});
  const answers=readBootstrapRulesAnswers({answers:f.answers,operation:'advance',definition,plan:{},bootstrap,
    reachable:{attempts:[1],reviewFirst:false,packageDigest:null}});
  // Even answer data that carried a commands entry cannot replace the driver's own run.
  answers.get(1).verify.checks={...answers.get(1).verify.checks,commands:{status:'verified',evidence:'static pass'}};
  const responder=createBootstrapRulesResponder({definition,plan:{},bootstrap,answers});
  const generate=(attempt=1,targets=f.targets)=>({kind:'init_generate',payload:{project:f.codeProject,selection:bootstrap.selection,
    targets,bootstrap:{identity:{...identity,attempt}}}});
  const documents=f.targets.map(file=>({path:file,content:contents[file]}));
  const verify=(attempt=1,docs=documents)=>({kind:'init_verify',payload:{project:f.codeProject,documents:docs,
    categories:['commands','globs','file_references','constraint_preservation','rule_applicability'],
    learningInput:{identity:{...identity,attempt}}}});
  await assert.rejects(async()=>responder.init_verify(verify()),/尚未应答对应的 init_generate/);
  assert.throws(()=>responder.init_generate({...generate(),payload:{...generate().payload,project:f.root}}),/项目根与运行定义不一致/);
  assert.throws(()=>responder.init_generate({...generate(),payload:{...generate().payload,selection:{...selection,modules:['frontend']}}}),
    /selection 与 bootstrap-config 不一致/);
  responder.init_generate(generate());
  await assert.rejects(async()=>responder.init_verify({...verify(),payload:{...verify().payload,project:f.root}}),/项目根与运行定义不一致/);
  responder.init_generate(generate());
  await assert.rejects(async()=>responder.init_verify({...verify(),payload:{...verify().payload,categories:['commands']}}),/核验分组与合同不一致/);
  assert.throws(()=>responder.init_generate(generate(2)),/第 2 轮未预检/);
  assert.throws(()=>responder.init_generate(generate(1,f.targets.slice(1))),/targets 与预检不一致/);
  assert.deepEqual(responder.init_generate(generate()).documents,documents);
  await assert.rejects(async()=>responder.init_verify(verify(2)),/轮次与刚应答的 init_generate 不一致/);
  responder.init_generate(generate());
  await assert.rejects(async()=>responder.init_verify(verify(1,documents.map(item=>item.path==='AGENTS.md'
    ?{...item,content:item.content+'drift\n'}:item))),/草稿与 init-generate 答案.*不一致/);
  responder.init_generate(generate());
  const reply=await responder.init_verify(verify());
  assert.equal(reply.checks.commands.status,'failed');
  assert.match(reply.checks.commands.evidence,/驾驶员实跑 1\/1 条草稿命令: strict: failed（host check exited 1）/);
  assert.deepEqual(reply.constraintChanges,[]);assert.deepEqual(reply.application,learning.application);
});

function reviewFixture(f){
  const source=fs.readFileSync(fileURLToPath(new URL('./fixtures/claude-review-process.mjs',import.meta.url)),'utf8');
  const revise="data.reviewPackage.identity.taskId==='T-002'&&data.reviewPackage.identity.attempt===1";
  const fake=source.replace("verdict:'approved'",`verdict:${revise}?'changes_requested':'approved'`)
    .replace('findings:[]',`findings:${revise}?[{id:'F1',severity:'P2',path:'.claude/rules/testing.md',message:'Name the structure check for new Swift files',evidence:'Synthetic revision fixture'}]:[]`);
  assert.notEqual(fake,source);
  const cli=path.join(f.bin,'claude');fs.writeFileSync(cli,fake,{mode:0o700});
  const preview=spawnSync(process.execPath,[HOST,'preflight','--config',path.join(f.root,'run-T-001.json'),
    '--review-model','fixture','--runtime','claude'],{encoding:'utf8',timeout:10000,env:f.env});
  assert.equal(preview.status,0,preview.stderr);fs.writeFileSync(path.join(f.root,'review.json'),preview.stdout);
}
const result=run=>JSON.parse(run.stdout).result;
const read=(f,file)=>fs.readFileSync(path.join(f.codeProject,file),'utf8');

test('real host drives split-root T-001 scaffold, then T-002 rules with a revision round',
  {skip:process.platform!=='darwin',timeout:180000},t=>{
  const f=fixture(t);
  const scope=Object.keys(scaffold);f.writeRun('T-001',scope);f.writeBootstrap(null);
  for(const [file,content] of Object.entries(scaffold))f.write(`t001/${file}`,content);
  f.write('develop.json',{status:'succeeded',value:{outcome:'implemented',...learning},
    edits:Object.fromEntries(scope.map(file=>[file,`t001/${file}`]))});
  reviewFixture(f);
  const review=['--review-config','review.json'];
  let run=f.drive(f.plan('T-001','create',[...rulesPermissions,...review]),'advance');
  assert.equal(run.status,0,run.stderr);assert.equal(result(run).state,'awaiting_review');
  run=f.drive(f.plan('T-001','resume',[...rulesPermissions,...review,'--allow-review-attempt','1'],{packageDigest:result(run).packageDigest}),'decision');
  assert.equal(run.status,0,run.stderr);assert.equal(result(run).state,'approved');
  run=f.drive(f.plan('T-001','resume',[...rulesPermissions,...review]),'advance');
  assert.equal(run.status,0,run.stderr);assert.equal(result(run).state,'fixture_completed');
  assert.match(fs.readFileSync(path.join(f.specsDir,f.feature,'tasks.md'),'utf8'),/\[x\] T-001/);

  f.writeRun('T-002',[...f.targets]);f.writeBootstrap(selection);
  // Missing answers are refused before the T-002 run exists.
  assertRefusedBeforeLaunch(f,f.drive(f.plan('T-002','create',[...rulesPermissions,...review]),'advance'),/init-generate\.json/);
  const first=prepareRules(f,1);
  run=f.drive(f.plan('T-002','create',[...rulesPermissions,...review]),'advance');
  assert.equal(run.status,0,run.stderr);assert.equal(result(run).state,'awaiting_review',run.stdout);
  assert.match(run.stderr,/应答 init_generate/);assert.match(run.stderr,/应答 init_verify/);assert.match(run.stderr,/应答 check/);
  assert.doesNotMatch(run.stderr,/应答 develop/);
  for(const file of f.targets)assert.equal(read(f,file),first[file],file);
  const waiting=result(run).packageDigest,state=path.join(f.store('T-002'),'state.json');
  // Review may lead straight into attempt 2 inside this advance: its answers are required first.
  let before=fs.readFileSync(state);
  run=f.drive(f.plan('T-002','resume',[...rulesPermissions,...review,'--allow-review-attempt','1']),'advance');
  assert.equal(run.status,2,run.stderr);
  assert.match(run.stderr,new RegExp(`缺少 init-generate-a2\\.json；请先以 decision 和当前 packageDigest ${waiting}.*bootstrap-T-002-r1\\.md`));
  assert.deepEqual(fs.readFileSync(state),before);
  run=f.drive(f.plan('T-002','resume',[...rulesPermissions,...review,'--allow-review-attempt','1'],{packageDigest:waiting}),'decision');
  assert.equal(run.status,0,run.stderr);assert.equal(result(run).state,'changes_requested');
  assert(fs.existsSync(path.join(f.specsDir,'.reviews','bootstrap-T-002-r1.md')));

  before=fs.readFileSync(state);
  const again=()=>f.drive(f.plan('T-002','resume',[...rulesPermissions,...review]),'advance');
  run=again();assert.equal(run.status,2,run.stderr);
  assert.match(run.stderr,/第 2 轮规范修订，但答案文件不存在: .*init-generate-a2\.json.*bootstrap-T-002-r1\.md/);
  assert.deepEqual(fs.readFileSync(state),before);
  // The revision must keep the AGENTS.md that attempt 1 wrote; refused before launch.
  prepareRules(f,2,{agents:'# AITide rewritten\n'});
  run=again();assert.equal(run.status,2,run.stderr);assert.match(run.stderr,/init-generate-a2\.json 的 AGENTS\.md 必须逐字保留/);
  assert.deepEqual(fs.readFileSync(state),before);
  const second=prepareRules(f,2);
  run=again();assert.equal(run.status,0,run.stderr);assert.equal(result(run).state,'awaiting_review',run.stdout);
  assert.equal(result(run).identity.attempt,2);
  for(const file of f.targets)assert.equal(read(f,file),second[file],file);
  assert.notEqual(second['.claude/rules/testing.md'],first['.claude/rules/testing.md']);
  // The driver's decision request carries the run definition's attempt-1 identity;
  // the second review runs inside advance with the attempt-2 review grant.
  run=f.drive(f.plan('T-002','resume',[...rulesPermissions,...review,'--allow-review-attempt','2']),'advance');
  assert.equal(run.status,0,run.stderr);assert.equal(result(run).state,'fixture_completed',run.stdout);
  assert.match(fs.readFileSync(path.join(f.specsDir,f.feature,'tasks.md'),'utf8'),/\[x\] T-002/);
  const handoff=JSON.parse(fs.readFileSync(path.join(f.specsDir,'.reviews','bootstrap-T-002-a2-handoff.json'),'utf8'));
  assert.deepEqual([...handoff.changed_files].sort(),[...f.targets].sort());
});

test('a failing init_verify command is real evidence: nothing is written and a new run recovers',
  {skip:process.platform!=='darwin',timeout:120000},t=>{
  const f=fixture(t,{scaffolded:true});f.writeRun('T-002',[...f.targets]);f.writeBootstrap(selection);
  f.writeRun('T-001',Object.keys(scaffold));reviewFixture(f);
  const permissions=[...rulesPermissions,'--review-config','review.json'];
  // The session's semantic groups say verified; only the real command decides the commands group.
  prepareRules(f,1,{commands:[{id:'strict',command:['/bin/sh','scripts/verify.sh','--strict'],timeoutMs:60000}]});
  const failed=f.drive(f.plan('T-002','create',permissions),'advance');
  assert.equal(failed.status,1,failed.stderr);
  assert.equal(result(failed).state,'unknown',failed.stdout);assert.equal(result(failed).code,'execution_error');
  assert.match(failed.stderr,/init_verify 命令核验未通过：strict: failed（host check exited 1）/);
  assert.match(failed.stderr,/"code":"bootstrap_verification_blocked"/);assert.match(failed.stderr,/新 runId/);
  assert.equal(fs.existsSync(path.join(f.codeProject,'.claude')),false);
  assert.equal(fs.existsSync(path.join(f.codeProject,'AGENTS.md')),false);
  // No pending effect remains to abandon; nothing was written, so a fresh run for T-002 proceeds.
  const abandon=f.drive(f.plan('T-002','resume',[...permissions,'--allow-abandon-effect'],
    {reason:'Old host exited after failed init_verify command'}),'abandon_effect');
  assert.equal(abandon.status,1,abandon.stdout);assert.equal(result(abandon).code,'effect_abandon_no_pending');
  f.writeRun('T-002',[...f.targets],'T-002-b');const contents=prepareRules(f,1);
  const fresh=f.drive(f.plan('T-002-b','create',permissions),'advance');
  assert.equal(fresh.status,0,fresh.stderr);assert.equal(result(fresh).state,'awaiting_review',fresh.stdout);
  for(const file of f.targets)assert.equal(read(f,file),contents[file],file);
});
