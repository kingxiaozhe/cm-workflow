import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {buildManifest} from './cm-spec-manifest.mjs';
import {createCmAiBatch} from './cm-ai-batch-run.mjs';
import {main} from './cm-ai-batch-plan.mjs';
import {planCmAiBatch,parallelSettings} from '../runtime/js/cm-ai/batch-plan.mjs';

const scope=file=>`\n  - 范围: \`${file}\``;
function project(t,tasks,{feature='1.work',emptyCode=false,caseKinds=null}={}){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-batch-plan-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const specsDir=path.join(root,'specs'),codeProject=path.join(root,'code');
  fs.mkdirSync(path.join(specsDir,feature),{recursive:true});fs.mkdirSync(codeProject);
  if(!emptyCode)fs.writeFileSync(path.join(codeProject,'README.md'),'# Existing project\n');
  for(const name of ['requirements.md','design.md'])fs.writeFileSync(path.join(specsDir,feature,name),'# Fixture\n');
  fs.writeFileSync(path.join(specsDir,feature,'tasks.md'),tasks);
  // caseKinds: a test contract with one blocking case per kind (browser = interactive QA).
  if(caseKinds){
    fs.writeFileSync(path.join(specsDir,feature,'requirements.md'),'- [AC-001]: fixture\n');
    fs.writeFileSync(path.join(specsDir,feature,'test-cases.json'),JSON.stringify({schemaVersion:'1.0',feature:feature.replace(/^\d+\./,''),
      cases:caseKinds.map((kind,index)=>({id:`TC-${String(index+1).padStart(3,'0')}`,origin:'user',kind,blocking:true,acIds:['AC-001'],
        taskIds:['T-001'],title:`${kind} fixture`,preconditions:[],steps:['Observe fixture'],expected:['Fixture evidence'],cleanup:[]}))}));
  }
  fs.writeFileSync(path.join(specsDir,'.cm-specs-status'),JSON.stringify({status:'approved',features:[feature],specFiles:buildManifest(specsDir)}));
  return {root,specsDir,codeProject,plan:(settings)=>planCmAiBatch({specsDir,codeProject,repositoryId:'r',batchId:'plan-batch-1',...(settings?{settings}:{})})};
}
// worktree_all:false keeps the earlier planner: only groups of two or more.
const legacy=Object.freeze({enabled:true,max:2,worktree_all:false});
// T-001 first; T-002 and T-003 each need only T-001; T-004 needs both.
const diamond=(extra={})=>`- [ ] T-001: contract${scope('a.js')}\n- [ ] T-002: left${scope(extra.left??'b.js')}${extra.leftDevice?'\n  - 设备: 需要':''}\n`
  +`- [ ] T-003: right${scope(extra.right??'c.js')}\n- [ ] T-004: final${scope('d.js')}\n\n`
  +'- T-002 依赖 T-001\n- T-003 依赖 T-001\n- T-004 依赖 T-002, T-003\n';

test('legacy (worktree_all:false): the diamond groups its two independent middle tasks, and the batch host accepts the config',t=>{
  const f=project(t,diamond()),plan=f.plan(legacy);
  assert.equal(plan.mode,'batch');assert.equal(plan.feature,'1.work');
  assert.deepEqual(plan.groups,[['T-002','T-003']]);
  assert.deepEqual(plan.config.batch.parallel,[['1.work/T-002','1.work/T-003']]);
  assert.deepEqual(plan.config.batch.tasks.map(task=>[task.taskId,task.scope]),[['T-001',['a.js']],['T-002',['b.js']],['T-003',['c.js']],['T-004',['d.js']]]);
  assert.deepEqual(Object.keys(plan.config.workflows),['1.work/T-001','1.work/T-002','1.work/T-003','1.work/T-004']);
  // The same validation the batch host runs: dependencies, final task, overlap, declared scope, device.
  assert.ok(createCmAiBatch({configuration:plan.config.batch,executionFor:async()=>({}),logHome:path.join(f.root,'log')}));
});

test('legacy: no group when a task is undeclared, overlapping, needs a device, chains, or parallelism is off',t=>{
  assert.deepEqual(project(t,diamond().replace(scope('b.js'),'')).plan(legacy),{mode:'serial',feature:'1.work',reason:'scope_undeclared'});
  assert.equal(project(t,diamond().replace(scope('b.js'),'\n  - 范围: `src/*`')).plan(legacy).reason,'scope_invalid');
  assert.deepEqual(project(t,diamond({right:'b.js'})).plan(legacy).groups,[]);
  assert.deepEqual(project(t,diamond({leftDevice:true})).plan(legacy).groups,[]);
  const chain=`- [ ] T-001: a${scope('a.js')}\n- [ ] T-002: b${scope('b.js')}\n- [ ] T-003: c${scope('c.js')}\n\n- T-002 依赖 T-001\n- T-003 依赖 T-002\n`;
  assert.deepEqual(project(t,chain).plan(legacy).groups,[]);
  const off=project(t,diamond()).plan({enabled:false,max:2});
  assert.equal(off.mode,'batch');assert.deepEqual(off.groups,[]);assert.equal(Object.hasOwn(off.config.batch,'parallel'),false);
  assert.deepEqual(project(t,diamond()).plan({...legacy,max:1}).groups,[]);
});

test('legacy: max bounds the group; a member needing a task still to run is not pulled ahead of it',t=>{
  const four=`- [ ] T-001: a${scope('a.js')}\n- [ ] T-002: b${scope('b.js')}\n- [ ] T-003: c${scope('c.js')}\n- [ ] T-004: d${scope('d.js')}\n- [ ] T-005: final${scope('e.js')}\n\n- T-005 依赖 T-001, T-002, T-003, T-004\n`;
  assert.deepEqual(project(t,four).plan(legacy).groups,[['T-001','T-002'],['T-003','T-004']]);
  assert.deepEqual(project(t,four).plan({...legacy,max:3}).groups,[['T-001','T-002','T-003']]);
  // T-003 needs T-001, which is in the group T-002 would start: it starts its own.
  const pulled=`- [ ] T-001: a${scope('a.js')}\n- [ ] T-002: b${scope('b.js')}\n- [ ] T-003: c${scope('c.js')}\n- [ ] T-004: final${scope('d.js')}\n\n- T-003 依赖 T-001\n`;
  assert.deepEqual(project(t,pulled).plan({...legacy,max:3}).groups,[['T-001','T-002']]);
  // The feature's last task never joins, even when nothing ties it to the others.
  const loose=`- [ ] T-001: a${scope('a.js')}\n- [ ] T-002: final${scope('b.js')}\n`;
  assert.deepEqual(project(t,loose).plan(legacy).groups,[]);
  // A task waiting on a later task runs after it: the batch order is the one admission
  // follows (its first task is admission's next task), and the host accepts it.
  const forward=`- [ ] T-001: a${scope('a.js')}\n- [ ] T-002: b${scope('b.js')}\n- [ ] T-003: c${scope('c.js')}\n- [ ] T-004: final${scope('d.js')}\n\n- T-001 依赖 T-003\n`;
  const ahead=project(t,forward),forwardPlan=ahead.plan({...legacy,max:3});
  assert.deepEqual(forwardPlan.config.batch.tasks.map(task=>task.taskId),['T-002','T-003','T-001','T-004']);
  assert.deepEqual(forwardPlan.groups,[['T-002','T-003']]);
  assert.ok(createCmAiBatch({configuration:forwardPlan.config.batch,executionFor:async()=>({}),logHome:path.join(ahead.root,'log')}));
  assert.deepEqual(project(t,forward).plan({enabled:false,max:2}).config.batch.tasks.map(task=>task.taskId),['T-002','T-003','T-001','T-004']);
  // A member whose prerequisite runs later never joins an earlier group.
  const later=`- [ ] T-001: a${scope('a.js')}\n- [ ] T-002: b${scope('b.js')}\n- [ ] T-003: c${scope('c.js')}\n- [ ] T-004: d${scope('d.js')}\n- [ ] T-005: final${scope('e.js')}\n\n- T-002 依赖 T-004\n`;
  const laterPlan=project(t,later).plan(legacy);
  assert.deepEqual(laterPlan.config.batch.tasks.map(task=>task.taskId),['T-001','T-003','T-004','T-002','T-005']);
  assert.deepEqual(laterPlan.groups,[['T-001','T-003']]);
  // A cycle has no order; admission already refuses it, and so does the plan.
  assert.throws(()=>project(t,`- [ ] T-001: a${scope('a.js')}\n- [ ] T-002: b${scope('b.js')}\n- [ ] T-003: final${scope('c.js')}\n\n- T-001 依赖 T-002\n- T-002 依赖 T-001\n`).plan(legacy),
    {code:'batch_plan_not_ready'});
  // The feature's last task already done: the host would refuse any group, so none is planned.
  const lastDone=`- [ ] T-001: a${scope('a.js')}\n- [ ] T-002: b${scope('b.js')}\n- [ ] T-003: c${scope('c.js')}\n- [x] T-004: final${scope('d.js')}\n`;
  const donePlan=project(t,lastDone).plan(legacy);
  assert.equal(donePlan.mode,'batch');assert.deepEqual(donePlan.groups,[]);
  // T-003 runs first, so T-002 runs last: it collects the deferred QA and cannot be a
  // member, and the host refuses a hand-written tail group for a new batch.
  const tail=`- [ ] T-001: a${scope('a.js')}\n- [ ] T-002: b${scope('b.js')}\n- [ ] T-003: c${scope('c.js')}\n\n- T-001 依赖 T-003\n- T-002 依赖 T-003\n`;
  const tailProject=project(t,tail),tailPlan=tailProject.plan({...legacy,max:3});
  assert.deepEqual(tailPlan.config.batch.tasks.map(task=>task.taskId),['T-003','T-001','T-002']);assert.deepEqual(tailPlan.groups,[]);
  assert.throws(()=>createCmAiBatch({configuration:{...tailPlan.config.batch,parallel:[['1.work/T-001','1.work/T-002']]},
    executionFor:async()=>({}),logHome:path.join(tailProject.root,'log')}),{code:'parallel_final_task_excluded'});
  // Completed tasks are satisfied prerequisites, not batch members.
  const done=diamond().replace('- [ ] T-001','- [x] T-001');
  const plan=project(t,done).plan(legacy);
  assert.deepEqual(plan.config.batch.tasks.map(task=>task.taskId),['T-002','T-003','T-004']);assert.deepEqual(plan.groups,[['T-002','T-003']]);
});

test('worktree_all (default): every task except the last ones and device tasks runs in its own worktree',t=>{
  // Diamond: T-001 alone in a worktree, then T-002 + T-003 together; T-004 (the last) in the main checkout.
  const f=project(t,diamond()),plan=f.plan();
  assert.deepEqual(plan.groups,[['T-001'],['T-002','T-003']]);
  assert.deepEqual(plan.config.batch.parallel,[['1.work/T-001'],['1.work/T-002','1.work/T-003']]);
  assert.ok(createCmAiBatch({configuration:plan.config.batch,executionFor:async()=>({}),logHome:path.join(f.root,'log')}));
  // A chain cannot pair, but each task before the last still gets a one-member group.
  const chain=`- [ ] T-001: a${scope('a.js')}\n- [ ] T-002: b${scope('b.js')}\n- [ ] T-003: c${scope('c.js')}\n\n- T-002 依赖 T-001\n- T-003 依赖 T-002\n`;
  const chained=project(t,chain),chainPlan=chained.plan();
  assert.deepEqual(chainPlan.groups,[['T-001'],['T-002']]);
  assert.ok(createCmAiBatch({configuration:chainPlan.config.batch,executionFor:async()=>({}),logHome:path.join(chained.root,'log')}));
  // max:1 never pairs; every candidate is still alone in a worktree.
  assert.deepEqual(project(t,diamond()).plan({enabled:true,max:1}).groups,[['T-001'],['T-002'],['T-003']]);
  // Overlapping scopes cannot share a group; they run one after another, each in its own worktree.
  assert.deepEqual(project(t,diamond({right:'b.js'})).plan().groups,[['T-001'],['T-002'],['T-003']]);
  // A device task stays in the main checkout; the tasks around it still get worktrees.
  const device=project(t,diamond({leftDevice:true})),devicePlan=device.plan();
  assert.deepEqual(devicePlan.groups,[['T-001'],['T-003']]);
  assert.throws(()=>createCmAiBatch({configuration:{...devicePlan.config.batch,parallel:[['1.work/T-002']]},
    executionFor:async()=>({}),logHome:path.join(device.root,'log')}),{code:'parallel_device_task'});
  // The feature's last task never gets a worktree, not even alone.
  assert.throws(()=>createCmAiBatch({configuration:{...plan.config.batch,parallel:[['1.work/T-004']]},
    executionFor:async()=>({}),logHome:path.join(f.root,'log-final')}),{code:'parallel_final_task_excluded'});
  // Two tasks: only the first gets a worktree. One task left: nothing to group.
  assert.deepEqual(project(t,`- [ ] T-001: a${scope('a.js')}\n- [ ] T-002: final${scope('b.js')}\n`).plan().groups,[['T-001']]);
  assert.deepEqual(project(t,`- [x] T-001: a${scope('a.js')}\n- [ ] T-002: final${scope('b.js')}\n`).plan().groups,[]);
  // T-003 runs first, so T-002 runs last: neither the feature's last task (T-003) nor the
  // last one to run (T-002) gets a worktree; the host refuses a hand-written one for T-002.
  const tail=`- [ ] T-001: a${scope('a.js')}\n- [ ] T-002: b${scope('b.js')}\n- [ ] T-003: c${scope('c.js')}\n\n- T-001 依赖 T-003\n- T-002 依赖 T-003\n`;
  const tailProject=project(t,tail),tailPlan=tailProject.plan();
  assert.deepEqual(tailPlan.config.batch.tasks.map(task=>task.taskId),['T-003','T-001','T-002']);assert.deepEqual(tailPlan.groups,[['T-001']]);
  assert.throws(()=>createCmAiBatch({configuration:{...tailPlan.config.batch,parallel:[['1.work/T-002']]},
    executionFor:async()=>({}),logHome:path.join(tailProject.root,'log')}),{code:'parallel_final_task_excluded'});
  // The feature's last task already done: no group at all, as before.
  assert.deepEqual(project(t,`- [ ] T-001: a${scope('a.js')}\n- [ ] T-002: b${scope('b.js')}\n- [x] T-003: final${scope('c.js')}\n`).plan().groups,[]);
  // Off switches: worktree_all:false keeps only real pairs; enabled:false plans no worktree at all.
  assert.deepEqual(project(t,diamond()).plan({enabled:true,max:2,worktree_all:false}).groups,[['T-002','T-003']]);
  assert.deepEqual(project(t,chain).plan({enabled:true,max:2,worktree_all:false}).groups,[]);
  const off=project(t,diamond()).plan({enabled:false,max:2,worktree_all:true});
  assert.deepEqual(off.groups,[]);assert.equal(Object.hasOwn(off.config.batch,'parallel'),false);
  // Serial modes are unchanged: undeclared scope and the scaffold feature.
  assert.equal(project(t,diamond().replace(scope('b.js'),'')).plan().mode,'serial');
});

test('a feature with interactive QA cases keeps its unpaired tasks in the main checkout; real groups are unchanged',t=>{
  // Interactive QA (browser, simulator) may target a server or app built from the main
  // checkout, so a task alone in a worktree would be checked against unmerged code.
  const f=project(t,diamond(),{caseKinds:['logic','browser']}),plan=f.plan();
  assert.deepEqual(plan.groups,[['T-002','T-003']]);
  assert.ok(createCmAiBatch({configuration:plan.config.batch,executionFor:async()=>({}),logHome:path.join(f.root,'log')}));
  const chain=`- [ ] T-001: a${scope('a.js')}\n- [ ] T-002: b${scope('b.js')}\n- [ ] T-003: c${scope('c.js')}\n\n- T-002 依赖 T-001\n- T-003 依赖 T-002\n`;
  assert.deepEqual(project(t,chain,{caseKinds:['browser']}).plan().groups,[]);
  // The batch host refuses a hand-written one-member group in such a feature.
  assert.throws(()=>createCmAiBatch({configuration:{...plan.config.batch,parallel:[['1.work/T-001'],['1.work/T-002','1.work/T-003']]},
    executionFor:async()=>({}),logHome:path.join(f.root,'log-solo')}),{code:'parallel_solo_interactive_qa'});
  // Logic-only cases do not stop one-member groups.
  assert.deepEqual(project(t,diamond(),{caseKinds:['logic']}).plan().groups,[['T-001'],['T-002','T-003']]);
});

test('a scaffold feature is serial; a finished project is complete; settings are validated',t=>{
  assert.deepEqual(project(t,`- [ ] T-001: scaffold\n  - 范围: 串行\n`,{feature:'0.bootstrap',emptyCode:true}).plan(),{mode:'serial',feature:'0.bootstrap',reason:'bootstrap_feature'});
  assert.deepEqual(project(t,diamond().replaceAll('- [ ]','- [x]')).plan(),{mode:'complete'});
  assert.deepEqual(parallelSettings({}),{enabled:true,max:2,worktree_all:true});
  assert.deepEqual(parallelSettings({parallel:{max:3}}),{enabled:true,max:3,worktree_all:true});
  assert.deepEqual(parallelSettings({parallel:{worktree_all:false}}),{enabled:true,max:2,worktree_all:false});
  for(const parallel of [{max:5},{max:0},{enabled:'yes'},{max:2.5},{worktree_all:'no'},{worktree_all:1}])assert.throws(()=>parallelSettings({parallel}),{code:'invalid_parallel_settings'});
});

test('the CLI reads the project parallel settings and prints the plan',t=>{
  const f=project(t,diamond());
  fs.writeFileSync(path.join(f.codeProject,'.cm-workflow.yml'),'version: 1\nparallel:\n  enabled: false\n');
  const writes=[];const original=process.stdout.write.bind(process.stdout);
  process.stdout.write=chunk=>{writes.push(String(chunk));return true;};
  let code;try{code=main(['--specs-dir',f.specsDir,'--code-project',f.codeProject,'--repository-id','r','--batch-id','plan-batch-1']);}
  finally{process.stdout.write=original;}
  assert.equal(code,0);assert.deepEqual(JSON.parse(writes.join('')).groups,[]);
});

test('the CLI reads parallel.worktree_all; the default gives every task before the last its own worktree',t=>{
  const run=f=>{
    const writes=[];const original=process.stdout.write.bind(process.stdout);
    process.stdout.write=chunk=>{writes.push(String(chunk));return true;};
    let code;try{code=main(['--specs-dir',f.specsDir,'--code-project',f.codeProject,'--repository-id','r','--batch-id','plan-batch-1']);}
    finally{process.stdout.write=original;}
    assert.equal(code,0);return JSON.parse(writes.join('')).groups;
  };
  assert.deepEqual(run(project(t,diamond())),[['T-001'],['T-002','T-003']]);
  const legacyProject=project(t,diamond());
  fs.writeFileSync(path.join(legacyProject.codeProject,'.cm-workflow.yml'),'version: 1\nparallel:\n  worktree_all: false\n');
  assert.deepEqual(run(legacyProject),[['T-002','T-003']]);
});
