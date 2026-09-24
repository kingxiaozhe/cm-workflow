import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const driver=path.join(root,'scripts/cm-prd-drive.mjs');
const pending=['task_boundary_and_existing_asset_overlap','acceptance_verifiability','user_case_semantics',
  'test_contract_applicability','brownfield_references_and_B2_B3_B5_if_applicable'];
function fixture(t,{pdf=false}={}){
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-prd-drive-')));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const project=path.join(dir,'project'),answers=path.join(dir,'answers');
  fs.mkdirSync(path.join(project,'docs'),{recursive:true});fs.mkdirSync(answers);
  fs.writeFileSync(path.join(project,'docs/input.md'),'Synthetic requirement');
  if(pdf)fs.writeFileSync(path.join(project,'docs/input.pdf'),'%PDF synthetic');
  const plan={project,specs:project,answers,request:{text:'Analyze'}};
  const write=(name,value)=>fs.writeFileSync(path.join(answers,name),JSON.stringify(value));
  const drive=(operation,patch={})=>{
    fs.writeFileSync(path.join(dir,'plan.json'),JSON.stringify({...plan,...patch}));
    const run=spawnSync(process.execPath,[driver,'--plan',path.join(dir,'plan.json'),operation],
      {encoding:'utf8',env:{...process.env,CM_WORKFLOW_LOG_HOME:path.join(dir,'mirror')},timeout:30000});
    return {...run,json:run.stdout.trim()?JSON.parse(run.stdout):null};
  };
  return {dir,project,answers,plan,write,drive,store:id=>path.join(project,'.reviews/prd-sessions',id,'state.json')};
}
const analyzed={status:'analyzed',summary:'Developer need',sourcePaths:['docs/input.md'],openQuestions:[]};
const draft={status:'draft',summary:'Synthetic documentation draft',features:[{name:'guide',testCasesReason:'no_observable_behavior',
  documents:[{path:'requirements.md',content:'## 功能需求\n1. [F-001] Guide\n- [ ] [AC-001] Document setup.'},
    {path:'design.md',content:'## 方案摘要\nSynthetic design'},
    {path:'tasks.md',content:'- [ ] T-001: Update guide'}]}]};
function draftReady(t){
  const f=fixture(t);f.write('analyze.json',analyzed);f.write('generate.json',draft);
  const start=f.drive('start');assert.equal(start.status,0,start.stderr);
  f.plan.session=start.json.result.runId;f.plan.request={text:'Draft'};
  const generated=f.drive('advance');assert.equal(generated.status,0,generated.stderr);
  assert.equal(generated.json.result.stage,'draft_ready');
  f.plan.request={text:'Self-check'};
  return f;
}
function assertSelfCheckPreflight(f,expected){
  const sessions=path.join(f.project,'.reviews/prd-sessions');
  const beforeSessions=fs.readdirSync(sessions);
  const beforeState=fs.readFileSync(f.store(f.plan.session));
  const log=path.join(f.project,'运行日志.jsonl');const beforeLog=fs.readFileSync(log);
  const run=f.drive('advance');
  assert.equal(run.status,2,run.stderr);assert.match(run.stderr,expected);
  assert.equal(run.stdout,'');
  assert.deepEqual(fs.readdirSync(sessions),beforeSessions,'preflight must create no new session directory');
  assert.deepEqual(fs.readFileSync(f.store(f.plan.session)),beforeState,'preflight must not change the existing session');
  assert.deepEqual(fs.readFileSync(log),beforeLog,'preflight must not launch the host');
}
test('real host: start, draft, read-only status, and a command-backed self-check',t=>{
  const f=fixture(t);f.write('analyze.json',analyzed);f.write('generate.json',draft);
  const start=f.drive('start');assert.equal(start.status,0,start.stderr);assert.equal(start.json.result.stage,'analysis_ready');
  const session=start.json.result.runId;f.plan.session=session;f.plan.request={text:'Draft'};
  const generated=f.drive('advance');assert.equal(generated.status,0,generated.stderr);
  assert.equal(generated.json.result.stage,'draft_ready');
  const before=fs.readFileSync(f.store(session));const status=f.drive('status',{request:{}});
  assert.equal(status.status,0,status.stderr);assert.equal(status.json.result.stage,'draft_ready');
  assert.equal(fs.readFileSync(f.store(session)).toString(),before.toString());
  f.plan.request={text:'Self-check'};f.plan.contextChecks=[{id:'read-source',command:[process.execPath,'-e',
    "require('fs').readFileSync('docs/input.md','utf8')"]}];
  f.plan.contextJudgements={'1.guide':Object.fromEntries(pending.map(id=>[id,'passed']))};
  const checked=f.drive('advance');assert.equal(checked.status,0,checked.stderr);
  assert.equal(checked.json.result.stage,'self_check_reported_passed');
  assert.match(checked.json.result.contextCheck.features[0].checks[0].evidence[0],/exited 0/);
});
test('preflight refuses missing and malformed answers before creating a session',t=>{
  const f=fixture(t);const missing=f.drive('start');assert.equal(missing.status,2);assert.match(missing.stderr,/analyze\.json/);
  assert.equal(fs.existsSync(path.join(f.project,'.reviews/prd-sessions')),false);
  f.write('analyze.json',{status:'analyzed',summary:'x',sourcePaths:[],openQuestions:[]});
  const invalid=f.drive('start');assert.equal(invalid.status,2);assert.match(invalid.stderr,/analyze.json.sourcePaths/);
  assert.equal(fs.existsSync(path.join(f.project,'.reviews/prd-sessions')),false);
});
test('preflight refuses static execution evidence and unsupported materials runner',t=>{
  const f=fixture(t,{pdf:true});f.write('analyze.json',{...analyzed,sourcePaths:['docs/input.md','docs/input.pdf']});
  const run=f.drive('start');assert.equal(run.status,2);assert.match(run.stderr,/prd_materials/);
  assert.equal(fs.existsSync(path.join(f.project,'.reviews/prd-sessions')),false);
  fs.writeFileSync(path.join(f.answers,'materials.json'),'{}');
  const staticRun=f.drive('start');assert.equal(staticRun.status,2);assert.match(staticRun.stderr,/prd_materials|materials.json/);
  assert.equal(fs.existsSync(path.join(f.project,'.reviews/prd-sessions')),false);
});
test('resume requires the original bound call and evidence before launch',t=>{
  const f=fixture(t);f.write('analyze.json',analyzed);
  const start=f.drive('start');assert.equal(start.status,0,start.stderr);f.plan.session=start.json.result.runId;
  const before=fs.readFileSync(f.store(f.plan.session));
  const run=f.drive('resume',{request:{resolution:{callId:'wrong',requestDigest:'wrong',result:analyzed,evidence:'receipt'}}});
  assert.equal(run.status,2);assert.match(run.stderr,/恢复存档没有待定操作|绑定/);
  assert.equal(fs.readFileSync(f.store(f.plan.session)).toString(),before.toString());
});
test('static self-check evidence is refused before the host changes its session',t=>{
  const f=fixture(t);f.write('analyze.json',analyzed);const start=f.drive('start');assert.equal(start.status,0,start.stderr);
  f.plan.session=start.json.result.runId;f.plan.request={text:'Draft'};f.write('generate.json',draft);
  assert.equal(f.drive('advance').status,0);const before=fs.readFileSync(f.store(f.plan.session));
  f.plan.request={text:'Self-check'};f.plan.contextChecks=[{id:'read-source',command:[process.execPath,'-e','process.exit(0)']}];
  f.plan.contextJudgements={'1.guide':Object.fromEntries(pending.map(id=>[id,'passed']))};
  fs.writeFileSync(path.join(f.answers,'self-check.json'),'{}');
  const run=f.drive('advance');assert.equal(run.status,2);assert.match(run.stderr,/self-check.json.*执行证据/);
  assert.equal(fs.readFileSync(f.store(f.plan.session)).toString(),before.toString());
});
test('self-check preflight requires real contextChecks before host launch',t=>{
  const f=draftReady(t);
  f.plan.contextJudgements={'1.guide':Object.fromEntries(pending.map(id=>[id,'passed']))};
  assertSelfCheckPreflight(f,/步骤会反问 prd_self_check，但 PLAN\.contextChecks 缺少真实命令列表/);
});
test('self-check preflight requires contextJudgements before host launch',t=>{
  const f=draftReady(t);
  f.plan.contextChecks=[{id:'read-source',command:[process.execPath,'-e',
    "require('fs').readFileSync('docs/input.md','utf8')"]}];
  assertSelfCheckPreflight(f,/prd_self_check 缺少 PLAN\.contextJudgements（逐项人工判断）/);
});
test('change mode rejects an edit to an unselected existing feature before launch',t=>{
  const f=fixture(t);
  for(const name of ['1.guide','2.other']){
    fs.mkdirSync(path.join(f.project,name));
    for(const doc of draft.features[0].documents)fs.writeFileSync(path.join(f.project,name,doc.path),doc.content);
  }
  f.plan.change='1.guide';f.write('analyze.json',{status:'analyzed',summary:'Change need',openQuestions:[]});
  const start=f.drive('start');assert.equal(start.status,0,start.stderr);
  f.plan.session=fs.readdirSync(path.join(f.project,'.reviews/prd-sessions'))[0];f.plan.request={text:'Requirements'};
  f.write('generate.json',{status:'documents',summary:'Other feature',removed:[],features:[
    {directory:'2.other',documents:[{path:'requirements.md',content:'Out of scope'}]}]});
  const before=fs.readFileSync(f.store(f.plan.session));const refused=f.drive('advance');
  assert.equal(refused.status,2);assert.match(refused.stderr,/越过 scope/);
  assert.equal(fs.readFileSync(f.store(f.plan.session)).toString(),before.toString());
});
test('real host unknown call resumes with its original callId and requestDigest',async t=>{
  const f=fixture(t);const session='prd-resume-fixture';f.plan.session=session;
  const host=spawn(process.execPath,[path.join(root,'scripts/cm-prd-host.mjs'),'serve','--skill-dir',path.join(root,'skills/cm-prd'),
    '--project',f.project,'--specs',f.project,'--runtime','codex','--allow-log-write','--session',session],
  {env:{...process.env,CM_WORKFLOW_LOG_HOME:path.join(f.dir,'mirror')},stdio:['pipe','pipe','pipe']});
  let pending,hostSession,diagnostics='';host.stderr.on('data',c=>diagnostics+=c);
  const closed=new Promise(resolve=>host.on('close',resolve));
  for await(const line of createInterface({input:host.stdout})){
    const row=JSON.parse(line);
    if(row.type==='host_ready'){
      hostSession=row.sessionId;host.stdin.write(JSON.stringify({requestId:'one',operation:'start',text:'Analyze'})+'\n');
    }else if(row.type==='host_request'){
      pending=row;host.stdin.write(JSON.stringify({type:'host_close',sessionId:hostSession})+'\n');break;
    }
  }
  assert.ok(pending,diagnostics);host.stdin.end();await closed;
  const original=JSON.parse(fs.readFileSync(f.store(session))).active.calls[0];
  assert.equal(original.kind,'prd_analyze');assert.equal(pending.kind,'prd_analyze');
  const resumed=f.drive('resume',{request:{resolution:{callId:original.callId,requestDigest:original.requestDigest,
    result:analyzed,evidence:'Original operator result recovered from local transcript'}}});
  assert.equal(resumed.status,0,resumed.stderr);assert.equal(resumed.json.result.stage,'analysis_ready');
  assert.equal(JSON.parse(fs.readFileSync(f.store(session))).active,null);
});
