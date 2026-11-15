// 默认 4 MiB 存档上限下的真实驾驶员与宿主（实跑 aihot 副本发现）：存档放得下、审查输入却超过
// Codex 的 1 MiB 时，开发交付当场拦为 develop_package_too_large，不再留下无法重派的审查；
// 超过 1 MiB 原内联预算但审查放得下的包走材料归档，两轮审查后完成。审查方是进程替身，不是模型证据。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const R=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const {buildManifest}=await import(R+'/scripts/cm-spec-manifest.mjs');
const {configFingerprint}=await import(R+'/runtime/js/cm-ai/codex-config.mjs');
const {JOURNAL_PAYLOAD_LIMIT}=await import(R+'/runtime/js/cm-ai/effect-contract.mjs');
const {STATE_LIMIT}=await import(R+'/runtime/js/cm-ai/execution-store-limits.mjs');
const {readRunnerHistory}=await import(R+'/runtime/js/cm-ai/durable-runner-state.mjs');
const DRIVER=R+'/scripts/cm-ai-drive.mjs',REVIEWER=R+'/scripts/fixtures/codex-review-process.mjs';
const developValue={outcome:'implemented',application:{status:'no_relevant_lesson',note:null},retrospective:{status:'no_new_lesson',candidates:[],reason:null}};
const policy={version:2,development:'conversation',bootstrap:'disabled',qa:'disabled',qaFix:'disabled'};
const big=(seed,bytes)=>'export const seed = "'+seed+'";\n'+('// '+seed+' '+'y'.repeat(80)+'\n').repeat(Math.ceil(bytes/90));
function scenario(fileBytes,check){
  assert.equal(JOURNAL_PAYLOAD_LIMIT,4*1024*1024);
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-review-input-')));
  const specsDir=path.join(root,'specs'),codeProject=path.join(root,'app'),feature='1.work',scope=['target.mjs','data.mjs'];
  const identity={repositoryId:'review-input',runId:'review-input-'+fileBytes,taskId:'T-001',attempt:1};
  fs.mkdirSync(path.join(specsDir,feature),{recursive:true});fs.mkdirSync(codeProject);
  for(const name of ['requirements.md','design.md'])fs.writeFileSync(path.join(specsDir,feature,name),'# B1\n');
  fs.writeFileSync(path.join(specsDir,feature,'tasks.md'),'- [ ] T-001: b1\n');
  fs.writeFileSync(path.join(specsDir,'.cm-specs-status'),JSON.stringify({status:'approved',features:[feature],specFiles:buildManifest(specsDir)}));
  fs.writeFileSync(path.join(codeProject,'requirements.md'),'# B1\n');fs.writeFileSync(path.join(codeProject,'target.mjs'),'export const v = 1;\n');fs.writeFileSync(path.join(codeProject,'data.mjs'),'export const d = 1;\n');
  const config=path.join(root,'run.json');
  fs.writeFileSync(config,JSON.stringify({version:1,specsDir,codeProject,feature,identity,scope,requirements:['requirements.md']}));
  const answers=path.join(root,'answers');fs.mkdirSync(answers);const bin=path.join(root,'bin');fs.mkdirSync(bin);
  fs.writeFileSync(path.join(root,'control.json'),JSON.stringify(policy));
  const env={...process.env,PATH:bin+path.delimiter+process.env.PATH,CM_WORKFLOW_HOME:path.join(root,'home'),CM_WORKFLOW_LOG_HOME:path.join(root,'logs')};
  delete env.CM_JOURNAL_PAYLOAD_LIMIT_TEST;
  const reviewer=verdict=>{let fake=fs.readFileSync(REVIEWER,'utf8');
    if(verdict==='changes_requested')fake=fake.replace("verdict:'approved'","verdict:data.reviewPackage.identity.attempt===1?'changes_requested':'approved'")
      .replace('findings:[]',"findings:data.reviewPackage.identity.attempt===1?[{id:'F1',severity:'P2',path:'target.mjs',message:'Revise',evidence:'B1 finding'}]:[]");
    fs.writeFileSync(path.join(bin,'codex'),fake,{mode:0o700});
    fs.writeFileSync(path.join(root,'review.json'),JSON.stringify({model:'fixture',preflight:{passed:true,cli_model:'fixture',prompt_transport:'stdin',config_fingerprint:configFingerprint({cwd:codeProject,model:'fixture'})}}));};
  reviewer('changes_requested');
  const develop=(seed,name)=>{fs.writeFileSync(path.join(answers,seed+'-t.mjs'),big(seed+'t',fileBytes));fs.writeFileSync(path.join(answers,seed+'-d.mjs'),big(seed+'d',fileBytes));fs.writeFileSync(path.join(answers,name),JSON.stringify({status:'succeeded',value:developValue,edits:{'target.mjs':seed+'-t.mjs','data.mjs':seed+'-d.mjs'}}));};
  const checks=[{id:'syntax',command:[process.execPath,'--check',path.join(codeProject,'target.mjs')]},{id:'syntax-data',command:[process.execPath,'--check',path.join(codeProject,'data.mjs')]}];
  const plan=extra=>{const file=path.join(root,'plan-'+Math.random().toString(36).slice(2)+'.json');
    fs.writeFileSync(file,JSON.stringify({config:'run.json',mode:'create',hostContext:'review-input-host',controlConfig:'control.json',
      permissions:['--review-config','review.json'],answers:'answers',checks,...extra}));return file;};
  const drive=(file,op)=>spawnSync(process.execPath,[DRIVER,'--plan',file,op],{encoding:'utf8',timeout:600000,env});
  const out=run=>{assert.equal(run.status,0,run.stderr.slice(-4000)+" | STDOUT "+run.stdout.slice(-1500));return JSON.parse(run.stdout).result;};
  const store=path.join(specsDir,'.reviews','.execution',identity.runId,'state.json');
  const rows=()=>JSON.parse(fs.readFileSync(store,'utf8')).records;
  try{
    develop('a1','develop.json');develop('a2','develop-a2.json');
    check({drive,plan,out,rows,specsDir,feature});
  }finally{fs.rmSync(root,{recursive:true,force:true});}
}

test('a delivery whose review input exceeds the Codex limit is refused at develop, not left as an unknown review',()=>scenario(900000,({drive,plan,rows})=>{
  const run=drive(plan({}),'advance');assert.equal(run.status,0,run.stderr.slice(-2000));
  const result=JSON.parse(run.stdout).result;
  assert.equal(result.state,'blocked');assert.equal(result.code,'develop_package_too_large');
  assert.match(result.reason,/review input for codex would exceed its limit of 1048576 bytes/);
  assert(rows().every(row=>!String(row.payload.type).startsWith('review-invocation')),'no review was dispatched');
}));

test('a package above the original 1 MiB inline budget that the review can take is archived and completes after two rounds',()=>scenario(400000,({drive,plan,out,rows,specsDir,feature})=>{
  let state=out(drive(plan({}),'advance'));
  for(let i=0;i<3&&!['approved','fixture_completed'].includes(state.state);i++)
    state=out(drive(plan({mode:'resume',...(state.packageDigest?{packageDigest:state.packageDigest}:{})}),state.state==='awaiting_review'?'decision':'advance'));
  assert.equal(state.identity.attempt,2);
  if(state.state!=='fixture_completed')state=out(drive(plan({mode:'resume',packageDigest:state.packageDigest}),'complete'));
  assert.equal(state.state,'fixture_completed');
  const list=rows();
  assert.equal(list.filter(row=>row.payload.packageMaterial).length,2);assert(list.filter(row=>row.payload.packageRef).length>=2);
  assert(Buffer.byteLength(JSON.stringify(list))<STATE_LIMIT);
  assert.equal(readRunnerHistory(list,list[0].payload.config,3).state.state,'fixture_completed');
  assert.match(fs.readFileSync(path.join(specsDir,feature,'tasks.md'),'utf8'),/\[x\] T-001/);
}));
