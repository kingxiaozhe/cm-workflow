import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {isSupportedExecutionPlatform} from '../runtime/js/cm-ai/execution-platform.mjs';
import {openFixExecution} from '../runtime/js/cm-fix/execution.mjs';
import {openExecutionStore} from '../runtime/js/cm-ai/execution-store.mjs';
import {startFixRun} from '../runtime/js/cm-fix/start.mjs';

// 驾驭员是宿主的中间人：开进程、发一条指令、代答反问、打结果。它的价值有两条要
// 拿真宿主验：确实能把一轮开起来并走下去；答案没备齐时停在发指令之前，不把运行做死。
const DRIVER=fileURLToPath(new URL('./cm-fix-drive.mjs',import.meta.url));
const skip=!isSupportedExecutionPlatform();

function fixture(t){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-fix-drive-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const cwd=path.join(root,'code');fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(cwd,'value.mjs'),'export const value=1;');
  fs.writeFileSync(path.join(cwd,'red.mjs'),"import {value} from './value.mjs';if(value!==2){console.error('BUG');process.exit(1)}");
  fs.writeFileSync(path.join(cwd,'existing.mjs'),"import {value} from './value.mjs';if(typeof value!=='number')process.exit(1)");
  const check=[process.execPath,'red.mjs'],failure={exitCode:1,outputIncludes:'BUG'};
  // 裸项目：不给 specsRoot，档案落在 code/docs/fixes，不需要 codex 沙箱。
  const config={identity:{repositoryId:'fixture',runId:'drive-demo',taskId:'T-FIX-drive',attempt:1},
    defect:'Synthetic wrong constant',
    reproduction:{cwd,command:check,expectedFailure:failure,timeoutMs:2000},
    redTest:{cwd,testFiles:['red.mjs'],command:check,expectedFailure:failure,timeoutMs:2000},
    baseline:{cwd,testFiles:['existing.mjs'],commands:[{id:'existing',command:[process.execPath,'existing.mjs']}],timeoutMs:2000}};
  fs.writeFileSync(path.join(root,'fix-config.json'),JSON.stringify(config));
  const answers=path.join(root,'answers');fs.mkdirSync(answers);
  const plan=(overrides={})=>{
    const file=path.join(root,`plan-${Object.keys(overrides).join('-')||'create'}.json`);
    fs.writeFileSync(file,JSON.stringify({config:'fix-config.json',cwd,mode:'create',hostContext:'drive-fixture-host',
      permissions:[],answers:'answers',...overrides}));
    return file;
  };
  return {root,cwd,answers,plan,archive:path.join(cwd,'docs','fixes')};
}
const learning={status:'applied',summary:'Reproduce before repairing; keep the existing constant test as the red gate.'};
const diagnosis={status:'diagnosed',rootCause:'Constant is 1 where the contract expects 2',affectedPaths:['value.mjs'],
  plan:'Set the constant to 2 after the red test',crossLayer:false,affectedModules:['value'],
  investigation:{discardedAlternatives:[],boundaryAnalysis:null}};

// 不管成功失败都要同时拿到两路输出：结果在 stdout，「应答了什么 / 为什么停」在 stderr。
function drive(planFile,operation){
  const run=spawnSync(process.execPath,[DRIVER,'--plan',planFile,operation],{encoding:'utf8',stdio:['ignore','pipe','pipe']});
  return {status:run.status,stdout:run.stdout??'',stderr:run.stderr??''};
}

test('the driver opens a real host, answers its questions from files and reports the stage',{skip},t=>{
  const f=fixture(t);
  fs.writeFileSync(path.join(f.answers,'learning.json'),JSON.stringify(learning));
  fs.writeFileSync(path.join(f.answers,'diagnosis.json'),JSON.stringify(diagnosis));
  const run=drive(f.plan(),'advance');
  assert.equal(run.status,0,run.stderr);
  const reply=JSON.parse(run.stdout);
  assert.equal(reply.result.stage,'red_test_required');
  assert.equal(reply.result.diagnosis.rootCause,diagnosis.rootCause);
  assert.match(run.stderr,/应答 fix_learning/);
  assert.match(run.stderr,/应答 fix_diagnose/);
});

test('a missing answer stops the driver before any instruction is sent, so no run is created',{skip},t=>{
  const f=fixture(t);
  fs.writeFileSync(path.join(f.answers,'learning.json'),JSON.stringify(learning));
  // 故意不写 diagnosis.json：advance 会问诊断，宿主一步做半就永久 unknown，所以必须在这儿就停。
  const run=drive(f.plan(),'advance');
  assert.equal(run.status,2);
  assert.match(run.stderr,/diagnosis\.json/);
  assert.equal(fs.existsSync(path.join(f.archive,'.reviews','.execution')),false,'不该留下半个运行');
});

test('on resume the driver reuses the recorded learning instead of demanding the file again',{skip},t=>{
  const f=fixture(t);
  fs.writeFileSync(path.join(f.answers,'learning.json'),JSON.stringify(learning));
  fs.writeFileSync(path.join(f.answers,'diagnosis.json'),JSON.stringify(diagnosis));
  assert.equal(drive(f.plan(),'advance').status,0);
  // 换一个空的答案目录模拟新会话：没有 learning.json，靠存档里那份。
  const empty=path.join(f.root,'answers-empty');fs.mkdirSync(empty);
  const resumed=f.plan({mode:'resume',permissions:['--allow-red-test'],answers:'answers-empty'});
  const run=drive(resumed,'red_test');
  assert.equal(run.status,0,run.stderr);
  assert.match(run.stderr,/复用存档里已记的学习记录/);
  assert.equal(JSON.parse(run.stdout).result.stage,'baseline_required');
});

test('the driver refuses unknown operations and malformed plans without touching the host',{skip},t=>{
  const f=fixture(t);
  assert.equal(drive(f.plan(),'make_it_pass').status,2);
  fs.writeFileSync(path.join(f.root,'bad.json'),JSON.stringify({config:'fix-config.json',cwd:f.cwd,mode:'resume',
    hostContext:'h',permissions:['--allow-everything!'],answers:'answers'}));
  const bad=drive(path.join(f.root,'bad.json'),'status');
  assert.equal(bad.status,2);
  assert.match(bad.stderr,/permissions/);
  assert.equal(fs.existsSync(path.join(f.archive,'.reviews')),false);
});

test('the driver abandons a local unknown step using only plan reason and flag',{skip},t=>{
  const f=fixture(t),config=JSON.parse(fs.readFileSync(path.join(f.root,'fix-config.json')));
  const {identity,...definition}=config;
  const owner=openFixExecution({specsRoot:null,identity:config.identity,
    configuration:{...definition,hostContextId:'drive-fixture-host'},create:true});
  owner.close();
  startFixRun({specsRoot:f.archive,identity,configuration:{...definition,hostContextId:'drive-fixture-host',archiveMode:'bare'}});
  const statePath=path.join(f.archive,'.reviews','.execution',config.identity.runId,'state.json');
  const state=JSON.parse(fs.readFileSync(statePath));
  const store=openExecutionStore({specsRoot:f.archive,identity:state.identity,fingerprints:state.fingerprints,create:false});
  store.append({id:'fix-reproduce-intent',kind:'intent',payload:{stage:'reproduce'},expectedRevision:store.snapshot().revision});store.close();
  const plan=f.plan({mode:'resume',permissions:['--allow-abandon'],reason:'Lost local reproduction result',answers:undefined});
  const result=drive(plan,'abandon_step');
  assert.equal(result.status,0,JSON.stringify(result));
  assert.equal(JSON.parse(result.stdout).result.stage,'reproduce');
  assert(JSON.parse(fs.readFileSync(statePath)).records.some(row=>row.id==='fix-abandoned-1'));
});
