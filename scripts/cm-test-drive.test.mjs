import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
const root=fileURLToPath(new URL('..',import.meta.url));
const driver=path.join(root,'scripts/cm-test-drive.mjs');
const write=(file,value)=>fs.writeFileSync(file,JSON.stringify(value));
const contract=(kind='logic')=>({schemaVersion:'1.0',feature:'guide',cases:[{id:'TC-001',origin:'user',kind,blocking:true,
  acIds:[],taskIds:[],title:'Invalid input',preconditions:[],steps:['Call invalid input'],expected:['Returns error'],cleanup:[]}]});
function setup(t,kind='logic'){
  const temp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-test-drive-'))),project=path.join(temp,'project');
  fs.mkdirSync(project);fs.writeFileSync(path.join(project,'input.mjs'),'export const valid = value => value !== null;\n');
  const cases=path.join(temp,'cases.json');write(cases,contract(kind));
  const config={skillDir:path.join(root,'skills/cm-test'),project,runtime:'codex',arguments:{cases,...(kind==='browser'?{browser:true}:{logic:true})},
    sources:['input.mjs'],commands:[],environment:{scope:'local',kind:'web',carrier:'browser',target:'fixture-local-ui'},
    logHome:path.join(temp,'logs')};
  write(path.join(temp,'config.json'),config);const answers=path.join(temp,'answers');fs.mkdirSync(answers);
  const selected=contract(kind);write(path.join(answers,'qa-logic.json'),{contractDigest:digest(selected),results:[{id:'TC-001',verdict:'SUPPORTED',
    evidence:[{path:'input.mjs',line:1}],explanation:'Code rejects null input'}]});
  const session=path.join(temp,'session'),planPath=path.join(temp,'plan.json');
  write(planPath,{config:'config.json',answers:'answers',sessionDir:'session'});
  const run=(operation,which=driver)=>spawnSync(process.execPath,[which,'--plan',planPath,operation],{encoding:'utf8',timeout:120000});
  t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
  return {temp,project,config,answers,session,planPath,run};
}
test('real host: status is read-only, logic start and historical resume',t=>{
  const f=setup(t);let out=f.run('status');assert.equal(out.status,0,out.stderr);
  assert.equal(JSON.parse(out.stdout).result.stage,'ready');assert.equal(fs.existsSync(f.session),false);
  out=f.run('start');assert.equal(out.status,0,out.stderr);
  const result=JSON.parse(out.stdout).result;assert.equal(result.overall,'REVIEWED');assert.equal(result.executionPassed,0);
  const journal=path.join(f.session,'execution.jsonl'),before=fs.readFileSync(journal);
  out=f.run('status');assert.equal(out.status,0,out.stderr);assert.equal(JSON.parse(out.stdout).result.stage,'reported');
  assert.deepEqual(fs.readFileSync(journal),before);
  write(f.planPath,{config:'config.json',answers:'answers',sessionDir:'session',resolution:null});
  out=f.run('resume');assert.equal(out.status,0,out.stderr);assert.equal(JSON.parse(out.stdout).result.historical,true);
});
test('missing, malformed and out-of-scope judgement refuse without session',t=>{
  for(const change of ['missing','malformed','scope']){
    const f=setup(t),file=path.join(f.answers,'qa-logic.json');
    if(change==='missing')fs.unlinkSync(file);
    if(change==='malformed')write(file,{contractDigest:digest(contract()),results:[{id:'TC-001',verdict:'PASS',evidence:[],explanation:'bad'}]});
    if(change==='scope')write(file,{contractDigest:digest(contract()),results:[{id:'TC-001',verdict:'SUPPORTED',
      evidence:[{path:'../outside.mjs',line:1}],explanation:'bad citation'}]});
    const out=f.run('start');assert.equal(out.status,2,out.stderr);assert.match(out.stderr,/qa_logic|qa-logic/);
    assert.equal(fs.existsSync(f.session),false);
  }
});
test('browser execution evidence cannot come from a static answer file',t=>{
  const f=setup(t,'browser');write(path.join(f.answers,'qa-browser.json'),{verdict:'PASS',evidence:['fake.md'],
    environment:f.config.environment,cleanup:'completed'});
  const out=f.run('start');assert.equal(out.status,2,out.stderr);assert.match(out.stderr,/缺少真实执行 runner: qa_browser/);
  assert.equal(fs.existsSync(f.session),false);
});
test('resume requires original session binding and explicit null resolution',t=>{
  const f=setup(t);assert.equal(f.run('start').status,0);
  let out=f.run('resume');assert.equal(out.status,2,out.stderr);assert.match(out.stderr,/PLAN 缺少字段 resolution/);
  write(f.planPath,{config:'config.json',answers:'answers',sessionDir:'session',resolution:{result:{overall:'PASS'}}});
  out=f.run('resume');assert.equal(out.status,2,out.stderr);assert.match(out.stderr,/原动作回执不能由静态答案伪造/);
  write(f.planPath,{config:'config.json',answers:'answers',sessionDir:'session',resolution:null});
  write(path.join(f.temp,'config.json'),{...f.config,runtime:'claude'});
  out=f.run('resume');assert.equal(out.status,2,out.stderr);assert.match(out.stderr,/resume 配置绑定不匹配/);
});
test('mutation probes catch static browser answer, omitted schema check, dropped resume binding',t=>{
  const source=fs.readFileSync(driver,'utf8');
  const mutant=(from,to)=>{
    assert.ok(source.includes(from));const file=path.join(root,'scripts',`.cm-test-drive-mutant-${process.pid}-${Math.random().toString(36).slice(2)}.mjs`);
    fs.writeFileSync(file,source.replace(from,to));t.after(()=>fs.rmSync(file,{force:true}));return file;
  };
  const browser=setup(t,'browser');let out=browser.run('start');assert.equal(out.status,2);
  const changed=source.replace("if(admission.modes.includes('browser')&&(admission.operation==='explore'||contract?.cases?.some(item=>item.kind==='browser')))","if(false)")
    .replace('answerFor:row=>answers[row.kind]??null',"answerFor:row=>row.kind==='qa_browser'?readJson(path.join(answerRoot,'qa-browser.json'),'qa_browser'):answers[row.kind]??null");
  const staticFile=path.join(root,'scripts',`.cm-test-drive-static-mutant-${process.pid}.mjs`);fs.writeFileSync(staticFile,changed);
  t.after(()=>fs.rmSync(staticFile,{force:true}));
  const report=path.join(browser.project,'docs/test-reports','fake.md');fs.mkdirSync(path.dirname(report),{recursive:true});fs.writeFileSync(report,'Fabricated browser result');
  write(path.join(browser.answers,'qa-browser.json'),{verdict:'PASS',evidence:[report],environment:browser.config.environment,cleanup:'completed'});
  out=browser.run('start',staticFile);assert.notEqual(out.status,2,'static evidence mutation bypassed refusal');
  const malformed=setup(t);write(path.join(malformed.answers,'qa-logic.json'),{contractDigest:digest(contract()),results:[{id:'TC-001',verdict:'PASS',evidence:[],explanation:'bad'}]});
  out=malformed.run('start');assert.equal(out.status,2);
  out=malformed.run('start',mutant("if(kind==='qa_logic'){","if(false&&kind==='qa_logic'){"));
  assert.notEqual(out.status,2,'schema mutation escaped preflight');
  const resumed=setup(t);assert.equal(resumed.run('start').status,0);
  write(resumed.planPath,{config:'config.json',answers:'answers',sessionDir:'session',resolution:null});
  write(path.join(resumed.temp,'config.json'),{...resumed.config,runtime:'claude'});
  out=resumed.run('resume');assert.equal(out.status,2);
  out=resumed.run('resume',mutant("context?.workflow==='cm-test'&&context.configDigest===digest(config)","true"));
  assert.notEqual(out.status,2,'binding mutation reached host');
});
