import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {buildManifest} from './cm-spec-manifest.mjs';
import {createCmAiBatch} from './cm-ai-batch-run.mjs';
import {main} from './cm-ai-batch-plan.mjs';
import {planCmAiBatch,parallelSettings} from '../runtime/js/cm-ai/batch-plan.mjs';

const scope=file=>`\n  - 范围: \`${file}\``;
function project(t,tasks,{feature='1.work',emptyCode=false,caseKinds=null,taskGrammar=null}={}){
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
  fs.writeFileSync(path.join(specsDir,'.cm-specs-status'),JSON.stringify({status:'approved',features:[feature],specFiles:buildManifest(specsDir),...(taskGrammar?{taskGrammar}:{})}));
  return {root,specsDir,codeProject,plan:(settings,workflow)=>planCmAiBatch({specsDir,codeProject,repositoryId:'r',batchId:'plan-batch-1',...(settings?{settings}:{}),...(workflow?{workflow}:{})})};
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

// A task alone in a worktree should not hit a fixed N6 checkpoint there: the batch has no
// QA repair path. The planner predicts it with the same N6 rules (host-qa-policy.mjs) and
// keeps such a task in the main checkout; the batch host refuses a hand-written one.
const chainOf=(count,done=0)=>Array.from({length:count},(_,index)=>`- [${index<done?'x':' '}] T-00${index+1}: t${index+1}${scope(`f${index+1}.js`)}\n`).join('')
  +'\n'+Array.from({length:count-1},(_,index)=>`- T-00${index+2} 依赖 T-00${index+1}\n`).join('');
const host=(f,batch,workflows={})=>createCmAiBatch({configuration:batch,workflows,executionFor:async()=>({}),logHome:path.join(f.root,`log-${Math.random()}`)});
test('one-member groups stop before a task could be the fifth without QA',t=>{
  // Nothing assessed yet: tasks 1-4 may run alone; task 5 could trigger five_tasks_without_qa.
  const f=project(t,chainOf(7)),plan=f.plan();
  assert.deepEqual(plan.groups,[['T-001'],['T-002'],['T-003'],['T-004']]);
  assert.ok(host(f,plan.config.batch));
  assert.throws(()=>host(f,{...plan.config.batch,parallel:[['1.work/T-005']]}),{code:'parallel_solo_qa_checkpoint'});
  // Two tasks already completed without a QA row count, as the decision counts them.
  assert.deepEqual(project(t,chainOf(7,2)).plan().groups,[['T-003'],['T-004']]);
  // Real groups defer their QA and are unaffected.
  assert.deepEqual(project(t,chainOf(7)).plan({enabled:true,max:2,worktree_all:false}).groups,[]);
});
test('a fifth task kept in the main checkout resets the count when the host policy decides QA',t=>{
  // Ticket 05: T-005 stays in the main checkout as the fifth without QA, so its QA
  // triggers for certain and T-006 starts from zero again. That holds only where the
  // host policy decides QA: a workflow configuration, or the batch's control policy.
  const none={qa:{criticalPaths:{}},applicableAgentFiles:[]};
  const keys=ids=>ids.map(id=>[`T-00${id}`]);
  const f=project(t,chainOf(9)),plan=f.plan(undefined,none);
  assert.deepEqual(plan.groups,keys([1,2,3,4,6,7,8]));
  const every=workflow=>Object.fromEntries(plan.config.batch.tasks.map(task=>[`1.work/${task.taskId}`,workflow]));
  assert.ok(host(f,plan.config.batch,every(none)));
  assert.ok(host(f,{...plan.config.batch,controlPolicy:{version:2,development:'conversation',bootstrap:'disabled',qa:'disabled',qaFix:'disabled'}}));
  // Without either the session supplies the decision, which may skip: no certain reset.
  assert.deepEqual(f.plan().groups,keys([1,2,3,4]));
  assert.throws(()=>host(f,plan.config.batch),{code:'parallel_solo_qa_checkpoint',reason:/^1\.work\/T-006: /});
  // A task kept in the main checkout for a registered path may or may not trigger (the
  // decision sees the files actually changed), so both counts stay possible after it.
  const auth={qa:{criticalPaths:{authentication:['f2.js']}},applicableAgentFiles:[]};
  assert.deepEqual(f.plan(undefined,auth).groups,keys([1,3,4,6,8]));
  assert.throws(()=>host(f,{...plan.config.batch,parallel:[1,3,4,6,7].map(id=>[`1.work/T-00${id}`])},every(auth)),{code:'parallel_solo_qa_checkpoint',reason:/T-007/});
  // Tasks completed with no QA row at all stay counted after a triggered QA.
  assert.deepEqual(project(t,chainOf(9,2)).plan(undefined,none).groups,keys([3,4,6,7]));
});
test('the count walk keeps every reset a group, qa:null or several features may hide',t=>{
  // Review r1 (ticket 05). Each case once let a one-member group reach five in its worktree.
  const none={qa:{criticalPaths:{}},applicableAgentFiles:[]};
  const solo=ids=>ids.map(id=>[`1.work/T-00${id}`]);
  const every=(batch,workflow)=>Object.fromEntries(batch.tasks.map(task=>[`1.work/${task.taskId}`,workflow]));
  // 1. A workflow with qa:null keeps the session-supplied QA decision: no certain reset.
  const f=project(t,chainOf(9)),reset=f.plan(undefined,none);
  assert.deepEqual(f.plan(undefined,{qa:null,applicableAgentFiles:[]}).groups,solo([1,2,3,4]).map(([key])=>[key.slice(7)]));
  assert.throws(()=>host(f,reset.config.batch,every(reset.config.batch,{qa:null,applicableAgentFiles:[]})),
    {code:'parallel_solo_qa_checkpoint',reason:/^1\.work\/T-006: /});
  // 2. A blocked member of a real group reruns in the main checkout and may trigger QA
  // there, after the other members' rows: the count after the group may be low.
  const grouped=`- [ ] T-001: t1${scope('f1.js')}\n- [ ] T-002: t2${scope('f2.js')}\n`
    +Array.from({length:7},(_,index)=>`- [ ] T-00${index+3}: t${index+3}${scope(`f${index+3}.js`)}\n`).join('')
    +'\n- T-003 依赖 T-001, T-002\n'+Array.from({length:6},(_,index)=>`- T-00${index+4} 依赖 T-00${index+3}\n`).join('');
  const g=project(t,grouped),plan=g.plan(undefined,none);
  assert.deepEqual(plan.groups,[['T-001','T-002'],['T-003'],['T-004'],['T-008']]);
  assert.ok(host(g,plan.config.batch,every(plan.config.batch,none)));
  assert.throws(()=>host(g,{...plan.config.batch,parallel:[['1.work/T-001','1.work/T-002'],...solo([3,4,6,7,8])]},every(plan.config.batch,none)),
    {code:'parallel_solo_qa_checkpoint',reason:/^1\.work\/T-006: /});
  // 3. A hand-written group out of task order starts at its first member (T-001 and T-005
  // run first), and a blocked later member reruns only once it is the first unfinished
  // task, after the outside tasks before it (review r2: T-003 rerun after T-002 reset the
  // count, T-008 reached five). With one-member groups, groups must be contiguous.
  const free=Array.from({length:9},(_,index)=>`- [ ] T-00${index+1}: t${index+1}${scope(`f${index+1}.js`)}\n`).join('');
  const h=project(t,free),batch=h.plan(undefined,none).config.batch;
  assert.throws(()=>host(h,{...batch,parallel:[['1.work/T-001','1.work/T-005'],...solo([7,8])]},every(batch,none)),
    {code:'parallel_solo_split_group',reason:/^1\.work\/T-001,1\.work\/T-005: /});
  assert.throws(()=>host(h,{...batch,parallel:[['1.work/T-001','1.work/T-003'],...solo([8])]},every(batch,none)),
    {code:'parallel_solo_split_group',reason:/^1\.work\/T-001,1\.work\/T-003: /});
  // Contiguous in task order is enough, whatever the order inside the group; and with no
  // one-member group there is no count to protect.
  assert.ok(host(h,{...batch,parallel:[['1.work/T-002','1.work/T-001'],...solo([8])]},every(batch,none)));
  assert.ok(host(h,{...batch,parallel:[['1.work/T-001','1.work/T-005']]},every(batch,none)));
  // 4. The count spans features and a closing feature leaves floor: no one-member group
  // in a batch of several features.
  const more=path.join(h.specsDir,'2.more');fs.mkdirSync(more);
  for(const name of ['requirements.md','design.md'])fs.writeFileSync(path.join(more,name),'# Fixture\n');
  fs.writeFileSync(path.join(more,'tasks.md'),`- [ ] T-001: g1${scope('g1.js')}\n`);
  fs.writeFileSync(path.join(h.specsDir,'.cm-specs-status'),JSON.stringify({status:'approved',features:['1.work','2.more'],specFiles:buildManifest(h.specsDir)}));
  assert.throws(()=>host(h,{...batch,tasks:[...batch.tasks,{feature:'2.more',taskId:'T-001',scope:['g1.js'],requirements:[]}],
    parallel:solo([1])},{...every(batch,none),'2.more/T-001':none}),{code:'parallel_solo_multi_feature'});
});
test('one-member groups skip a task whose scope hits a registered QA critical path',t=>{
  const workflow={qa:{criticalPaths:{authentication:['a.js']}},applicableAgentFiles:[]};
  const f=project(t,diamond());
  // T-001 changes a.js (authentication): it stays in the main checkout.
  assert.deepEqual(f.plan(undefined,workflow).groups,[['T-002','T-003']]);
  // A registered path a real group member changes does not matter: that QA is deferred.
  assert.deepEqual(f.plan(undefined,{qa:{criticalPaths:{payment:['b.js']}},applicableAgentFiles:[]}).groups,[['T-001'],['T-002','T-003']]);
  // The batch host checks the workflows it is launched with, whatever the plan said.
  const plan=f.plan();
  assert.deepEqual(plan.groups,[['T-001'],['T-002','T-003']]);
  assert.throws(()=>host(f,plan.config.batch,{'1.work/T-001':workflow}),{code:'parallel_solo_qa_checkpoint'});
  // Learning writes AGENTS.md, so a registered AGENTS.md path counts as well.
  assert.throws(()=>host(f,plan.config.batch,{'1.work/T-001':{qa:{criticalPaths:{api:['AGENTS.md']}},applicableAgentFiles:[]}}),
    {code:'parallel_solo_qa_checkpoint'});
  assert.ok(host(f,plan.config.batch,{'1.work/T-001':{qa:{criticalPaths:{api:['other.js']}},applicableAgentFiles:[]}}));
});
test('one-member groups need the project configuration a worktree gets from Git',t=>{
  // Review r2: a Git-ignored local .cm-workflow.yml does not reach the worktree, where QA
  // reloads the configuration. Here it narrows tests to commands, so the main checkout sees
  // no applicable browser case while the worktree (defaults) would plan one.
  const f=project(t,diamond(),{caseKinds:['logic','browser']});
  const cases=path.join(f.specsDir,'1.work','test-cases.json'),contract=JSON.parse(fs.readFileSync(cases,'utf8'));
  contract.cases.find(item=>item.kind==='browser').blocking=false;fs.writeFileSync(cases,JSON.stringify(contract));
  fs.writeFileSync(path.join(f.specsDir,'.cm-specs-status'),JSON.stringify({status:'approved',features:['1.work'],specFiles:buildManifest(f.specsDir)}));
  const git=(...args)=>{const result=spawnSync('git',['-C',f.codeProject,...args],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);return result.stdout;};
  git('init','-q','-b','main');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');
  fs.writeFileSync(path.join(f.codeProject,'.gitignore'),'.cm-workflow.yml\n');
  fs.writeFileSync(path.join(f.codeProject,'.cm-workflow.yml'),'version: 1\npolicies:\n  tests: [commands]\n');
  git('add','-A');git('commit','-qm','base');assert.equal(git('status','--porcelain'),'');
  const plan=f.plan();
  assert.deepEqual(plan.groups,[['T-002','T-003']]);
  assert.throws(()=>host(f,{...plan.config.batch,parallel:[['1.work/T-001'],['1.work/T-002','1.work/T-003']]}),{code:'parallel_solo_config_untracked'});
  // Committed as it is, the same bytes reach every worktree: one-member groups are back.
  fs.writeFileSync(path.join(f.codeProject,'.gitignore'),'');git('add','-A');git('commit','-qm','track config');
  assert.deepEqual(f.plan().groups,[['T-001'],['T-002','T-003']]);
  // Review r3: tracked and `git status` clean is not enough. With skip-worktree the main
  // checkout keeps a local override that a worktree (checked out from HEAD) never sees.
  fs.writeFileSync(path.join(f.codeProject,'.cm-workflow.yml'),'version: 1\n');git('commit','-qam','default config in HEAD');
  git('update-index','--skip-worktree','.cm-workflow.yml');
  fs.writeFileSync(path.join(f.codeProject,'.cm-workflow.yml'),'version: 1\npolicies:\n  tests: [commands]\n');
  assert.equal(git('status','--porcelain'),'');
  const diverged=f.plan();
  assert.deepEqual(diverged.groups,[['T-002','T-003']]);
  assert.throws(()=>host(f,{...diverged.config.batch,parallel:[['1.work/T-001'],['1.work/T-002','1.work/T-003']]}),{code:'parallel_solo_config_diverged'});
  // The same holds for assume-unchanged.
  git('update-index','--no-skip-worktree','.cm-workflow.yml');git('checkout','--','.cm-workflow.yml');
  git('update-index','--assume-unchanged','.cm-workflow.yml');
  fs.writeFileSync(path.join(f.codeProject,'.cm-workflow.yml'),'version: 1\npolicies:\n  tests: [commands]\n');
  assert.equal(git('status','--porcelain'),'');
  assert.deepEqual(f.plan().groups,[['T-002','T-003']]);
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

test('the CLI reads --workflow-config and keeps a task hitting a registered QA path in the main checkout',t=>{
  const f=project(t,diamond()),workflow=path.join(f.root,'workflow.json');
  fs.writeFileSync(workflow,JSON.stringify({qa:{commands:[],environment:{kind:'web',carrier:'browser',target:'fixture',scope:'local'},
    criticalPaths:{authentication:['a.js']}},documentationPaths:[],applicableAgentFiles:[]}));
  const writes=[];const original=process.stdout.write.bind(process.stdout);
  process.stdout.write=chunk=>{writes.push(String(chunk));return true;};
  let code;try{code=main(['--specs-dir',f.specsDir,'--code-project',f.codeProject,'--repository-id','r','--batch-id','plan-batch-1','--workflow-config',workflow]);}
  finally{process.stdout.write=original;}
  assert.equal(code,0);assert.deepEqual(JSON.parse(writes.join('')).groups,[['T-002','T-003']]);
});

// Grammar 3 (design 3.3/3.5): the session's walkthrough stays in the batch as the
// serial last task; the plan lists it in batch.memberDevelopment and fills workflows.
const workflowConfig=Object.freeze({qa:null,documentationPaths:[],applicableAgentFiles:[]});
const walkthrough='\n  - 开发: 会话';
test('grammar 3: the session last task stays serial in the batch and is listed in memberDevelopment',t=>{
  const tasks=diamond().replace(`- [ ] T-004: final${scope('d.js')}`,`- [ ] T-004: final${scope('d.js')}${walkthrough}`);
  const f=project(t,tasks,{taskGrammar:3}),plan=f.plan(legacy,workflowConfig);
  assert.deepEqual(plan.groups,[['T-002','T-003']]);
  assert.deepEqual(plan.config.batch.tasks.map(task=>task.taskId),['T-001','T-002','T-003','T-004']);
  assert.deepEqual(plan.config.batch.memberDevelopment,{'1.work/T-004':'session'});
  assert.deepEqual(Object.keys(plan.config.batch),['version','repositoryId','batchId','specsDir','codeProject','tasks','parallel','memberDevelopment']);
  assert.deepEqual(Object.values(plan.config.workflows),[workflowConfig,workflowConfig,workflowConfig,workflowConfig]);
  // Under grammar 2 the same bytes have no session task: the field is absent.
  const two=project(t,tasks,{taskGrammar:2}).plan(legacy,workflowConfig);
  assert.equal(Object.hasOwn(two.config.batch,'memberDevelopment'),false);
});
test('without a session task the plan has the exact pre-grammar-3 shape; a workflow config fills workflows',t=>{
  for(const taskGrammar of [null,2,3]){
    const f=project(t,diamond(),{taskGrammar}),plan=f.plan(legacy);
    assert.deepEqual(plan.config,{batch:{version:1,repositoryId:'r',batchId:'plan-batch-1',specsDir:f.specsDir,codeProject:f.codeProject,
      tasks:[['T-001','a.js'],['T-002','b.js'],['T-003','c.js'],['T-004','d.js']].map(([taskId,file])=>({feature:'1.work',taskId,scope:[file],requirements:[]})),
      parallel:[['1.work/T-002','1.work/T-003']]},
      workflows:{'1.work/T-001':null,'1.work/T-002':null,'1.work/T-003':null,'1.work/T-004':null}});
    assert.deepEqual(f.plan(legacy,workflowConfig).config.workflows,Object.fromEntries(['T-001','T-002','T-003','T-004'].map(id=>[`1.work/${id}`,workflowConfig])));
  }
});
test('the CLI writes --workflow-config into every member workflows entry',t=>{
  const f=project(t,diamond()),file=path.join(f.root,'workflow.json');
  fs.writeFileSync(file,JSON.stringify(workflowConfig));
  const writes=[];const original=process.stdout.write.bind(process.stdout);
  process.stdout.write=chunk=>{writes.push(String(chunk));return true;};
  let code;try{code=main(['--specs-dir',f.specsDir,'--code-project',f.codeProject,'--repository-id','r','--batch-id','plan-batch-1','--workflow-config',file]);}
  finally{process.stdout.write=original;}
  assert.equal(code,0);
  assert.ok(Object.values(JSON.parse(writes.join('')).config.workflows).every(item=>JSON.stringify(item)===JSON.stringify(workflowConfig)));
});
test('grammar 3 session tasks: not final, several, or (defensively) grouped are refused by code',t=>{
  const chain=(marks)=>[1,2,3].map(n=>`- [ ] T-00${n}: t${n}${scope(`${n}.js`)}${marks.includes(n)?walkthrough:''}`).join('\n')+'\n';
  assert.throws(()=>project(t,chain([2]),{taskGrammar:3}).plan(),{code:'session_task_not_final'});
  assert.throws(()=>project(t,chain([2,3]),{taskGrammar:3}).plan(),{code:'session_task_multiple'});
  assert.equal(project(t,chain([2]),{taskGrammar:2}).plan().mode,'batch','grammar 2 ignores the mark');
  // The final task is never a group member; one marked session is still listed alone.
  const plan=project(t,chain([3]),{taskGrammar:3}).plan();
  assert.ok(plan.groups.every(group=>!group.includes('T-003')));assert.deepEqual(plan.config.batch.memberDevelopment,{'1.work/T-003':'session'});
});
