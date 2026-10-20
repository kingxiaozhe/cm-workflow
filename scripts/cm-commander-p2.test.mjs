// Commander phase 2: dispatch registry with deadlines, dispatch preflight, the
// recovery decision table, and the acceptance replay of the aihot record
// (30 reopens and 8 stopped background jobs, 重开原因分类-2026-10-14.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {addDispatch,finishDispatch,readRegistry,openDispatches,registryDir,registryProblem} from '../runtime/js/commander/dispatch-registry.mjs';
import {decideRecovery,DECISIONS} from '../runtime/js/commander/decision.mjs';
import {answerValueFindings,answerChangeFindings,checkDevices,deviceFindings,checksDriftFindings} from '../runtime/js/commander/preflight.mjs';
import {composeLedger,registryInput} from '../runtime/js/commander/ledger.mjs';
import {inspectFixDiagnosis} from '../runtime/js/cm-fix/diagnosis.mjs';
import {main} from './cm-commander.mjs';
import {answerAttempt} from './cm-commander-preflight.mjs';

const isolated=fs.mkdtempSync(path.join(os.tmpdir(),'cm-commander-p2-home-'));
process.env.CM_WORKFLOW_HOME=path.join(isolated,'user');process.env.CM_WORKFLOW_LOG_HOME=path.join(isolated,'logs');
test.after(()=>fs.rmSync(isolated,{recursive:true,force:true}));
const NOW='2026-10-20T10:00:00.000Z';
const later=minutes=>new Date(Date.parse(NOW)+minutes*60000).toISOString();
const specs=t=>{const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-commander-p2-specs-')));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;};
const UDID='0A1B2C3D-4E5F-6789-ABCD-EF0123456789',UDID2='1B2C3D4E-5F60-789A-BCDE-F0123456789A';
const registryFile=dir=>path.join(registryDir(dir),'dispatch.jsonl');

test('the registry records a deadline, closes once, and reports overdue jobs; it never writes into specs',t=>{
  const dir=specs(t),before=fs.readdirSync(dir);
  const {id,deadline}=addDispatch(dir,{label:'xcodebuild test',deadlineMinutes:30,runId:'run-1',resources:[`device:${UDID}`],now:NOW});
  assert.equal(deadline,later(30));
  assert.deepEqual(fs.readdirSync(dir),before,'the registry lives under the CM home, not in specs');
  assert.ok(registryDir(dir).startsWith(process.env.CM_WORKFLOW_HOME));
  let open=openDispatches(readRegistry(dir),later(29));
  assert.equal(open.length,1);assert.equal(open[0].overdue,false);
  open=openDispatches(readRegistry(dir),later(45));
  assert.equal(open[0].overdue,true);assert.equal(open[0].overdueMinutes,15);
  finishDispatch(dir,{id,now:later(46)});
  assert.equal(openDispatches(readRegistry(dir),later(50)).length,0);
  assert.throws(()=>finishDispatch(dir,{id}),{code:'dispatch_already_done'});
  assert.throws(()=>finishDispatch(dir,{id:'nope'}),{code:'unknown_dispatch'});
  assert.throws(()=>addDispatch(dir,{label:'again',deadlineMinutes:5,id}),{code:'dispatch_exists'});
  assert.equal(registryProblem(readRegistry(dir)),null);
});

test('the registry refuses bad input and a held lock; done is checked inside the lock',t=>{
  const dir=specs(t);
  for(const [input,code] of [[{label:'',deadlineMinutes:5},'invalid_label'],[{label:'a\nb',deadlineMinutes:5},'invalid_label'],
    [{label:'x',deadlineMinutes:0},'invalid_deadline'],[{label:'x',deadlineMinutes:1.5},'invalid_deadline'],
    [{label:'x',deadlineMinutes:24*60+1},'invalid_deadline'],[{label:'x',deadlineMinutes:5,resources:['gpu:1']},'invalid_resource'],
    [{label:'x',deadlineMinutes:5,runId:'../x'},'invalid_run_id']])
    assert.throws(()=>addDispatch(dir,input),{code},JSON.stringify(input));
  const {id}=addDispatch(dir,{label:'ok',deadlineMinutes:5,now:NOW});
  const lock=path.join(registryDir(dir),'dispatch.lock'),bytes=fs.readFileSync(registryFile(dir));
  fs.writeFileSync(lock,'');
  assert.throws(()=>addDispatch(dir,{label:'x',deadlineMinutes:5}),{code:'registry_locked'},'a held lock is reported, never broken');
  assert.throws(()=>finishDispatch(dir,{id}),{code:'registry_locked'},'finishing waits for the same lock as the check');
  assert.deepEqual(fs.readFileSync(registryFile(dir)),bytes);fs.rmSync(lock);
});

test('a torn tail refuses the next append and keeps the bytes; bad rows are reported, never read as "no jobs"',t=>{
  const dir=specs(t);
  addDispatch(dir,{label:'first',deadlineMinutes:5,now:NOW,id:'a'});
  fs.appendFileSync(registryFile(dir),'{"v":1,"op":"add","id":"torn"');
  const before=fs.readFileSync(registryFile(dir));
  assert.throws(()=>addDispatch(dir,{label:'second',deadlineMinutes:5}),{code:'registry_torn'});
  assert.deepEqual(fs.readFileSync(registryFile(dir)),before,'nothing is appended after a torn tail');
  assert.equal(registryProblem(readRegistry(dir)),'registry_torn');
  const clean=specs(t);addDispatch(clean,{label:'x',deadlineMinutes:5,now:NOW});
  fs.appendFileSync(registryFile(clean),'not json\n');
  assert.equal(registryProblem(readRegistry(clean)),'registry_invalid_rows:1');
  const listed=main(['dispatch','list','--specs',clean]);
  assert.equal(listed.code,1);assert.match(listed.text,/登记有问题.*registry_invalid_rows:1/);
  assert.equal(main(['dispatch','list','--specs',clean,'--json']).code,1);
  assert.equal(registryInput(clean,NOW).registryError,'registry_invalid_rows:1','the ledger sees the bad rows');
  assert.equal(registryInput(dir,NOW).registryError,'registry_torn');
  assert.deepEqual(registryInput(specs(t),NOW),{dispatches:[],registryError:null},'no registry at all is simply empty');
});

test('the decision table commits only where the record settles it; every first step is reading status',()=>{
  const cases=[
    [{verified:false},'read_status',false],[{state:'unknown',pending:'develop'},'wait',false],
    [{state:'blocked',code:'spec_drift'},'spec_change',true],[{state:'blocked',code:'protected_scope'},'human_sync',true],
    [{state:'blocked',code:'execution_error'},'escalate',true],[{state:'unknown',code:'reconciliation_required'},'escalate',true],
    [{state:'blocked',code:'review_transport_timeout'},'read_status',true],[{state:'blocked',code:'develop_checks_not_passed'},'read_status',true],
    [{state:'blocked',code:'review_package_changed'},'read_status',true],[{state:'blocked',code:'review_blocked'},'read_status',true],
    [{state:'blocked',code:'develop_retry_limit'},'read_status',true],[{state:'cancelled',code:'cancelled'},'read_status',true],
    [{state:'blocked',code:'something_new'},'read_status',false]];
  for(const [input,decision,approval] of cases){
    const out=decideRecovery(input);
    assert.equal(out.decision,decision,JSON.stringify(input));assert.equal(out.needsApproval,approval,JSON.stringify(input));
    assert.ok(DECISIONS.includes(out.decision));assert.match(out.steps[0],/读 status/,JSON.stringify(input));
  }
  assert.ok(decideRecovery({state:'blocked',code:'develop_retry_limit'}).candidates.some(c=>/development_rework/.test(c)),
    'an exhausted develop budget may still offer the original run’s rework');
  assert.ok(decideRecovery({state:'blocked',code:'review_transport_timeout'}).candidates.some(c=>/abandon_review.*需用户批准/.test(c)));
  const redo=decideRecovery({state:'blocked',code:'documentation_sync_answer_missing'});
  assert.equal(redo.needsApproval,true,'develop_redo is an explicit recovery');
  assert.ok(redo.candidates.some(c=>/develop_redo.*需用户批准/.test(c)));
  assert.equal(decideRecovery({state:'blocked',code:'something_new'}).needsApproval,false,'nothing listed, nothing to approve');
});

const identity={repositoryId:'r',runId:'run-1',taskId:'T-001',attempt:1};
const answer=(application,retrospective={status:'no_new_lesson',candidates:[],reason:null},edits={'a.mjs':'a.txt'})=>
  ({status:'succeeded',value:{outcome:'implemented',application,retrospective},edits});
const lesson={status:'lesson_candidate',reason:null,candidates:[{classification:'structured',trigger:'t',action:'a',evidence:['a.mjs']}]};

test('preflight: an answer over a host bound is an error before dispatch; within bounds passes',()=>{
  assert.deepEqual(answerValueFindings(answer({status:'applied',note:'x'.repeat(512)}),{feature:'1.work',identity}),[]);
  const long=answerValueFindings(answer({status:'applied',note:'x'.repeat(513)}),{feature:'1.work',identity});
  assert.equal(long[0].code,'develop_answer_invalid');assert.match(long[0].message,/513 个字符/);
  assert.equal(answerValueFindings(answer({status:'applied',note:'😀'.repeat(257)}),{feature:'1.work',identity}).length,1,'an emoji counts as 2');
  const retro=answerValueFindings(answer({status:'no_relevant_lesson',note:null},{status:'lesson_candidate',candidates:[],reason:null}),{feature:'1.work',identity});
  assert.equal(retro[0].part,'retrospective');
  assert.deepEqual(answerValueFindings({status:'failed'},{feature:'1.work',identity}),[]);
});

test('preflight: a no-op answer is an error; a real change, a deletion or a lesson-only delivery is not',t=>{
  const root=specs(t),answersDir=path.join(root,'answers'),codeProject=path.join(root,'app');
  fs.mkdirSync(answersDir);fs.mkdirSync(codeProject);
  fs.writeFileSync(path.join(codeProject,'a.mjs'),'same\n');fs.writeFileSync(path.join(answersDir,'a.txt'),'same\n');
  fs.writeFileSync(path.join(answersDir,'b.txt'),'new\n');
  const value=answer({status:'no_relevant_lesson',note:null}),at={answersDir,codeProject};
  assert.equal(answerChangeFindings(value,at)[0].code,'develop_no_change');
  assert.deepEqual(answerChangeFindings({...value,edits:{'a.mjs':'a.txt','b.mjs':'b.txt'}},at),[]);
  assert.deepEqual(answerChangeFindings({...value,edits:{'a.mjs':{delete:true}}},at),[]);
  assert.equal(answerChangeFindings({...value,edits:{'gone.mjs':{delete:true}}},at)[0].code,'develop_no_change');
  assert.equal(answerChangeFindings({...value,edits:{}},at)[0].code,'develop_no_change');
  assert.deepEqual(answerChangeFindings(answer({status:'no_relevant_lesson',note:null},lesson,{}),at),[],
    'a lesson candidate changes AGENTS.md through the writeback, so it is a delivery');
});

const xcode=(id,extra=[],device=UDID)=>({id,command:['xcodebuild','test','-scheme','App','-destination',`platform=iOS Simulator,id=${device}`,...extra]});
test('preflight devices: only addressed devices count, ids compare in one form, parallel and multiple destinations differ',()=>{
  const held=[{label:'别的会话的 UI 测试',runId:'other',resources:[`device:${UDID.toLowerCase()}`]}];
  assert.equal(deviceFindings([xcode('ui')],held)[0].code,'device_busy','a lowercase registration is the same device');
  assert.deepEqual(deviceFindings([xcode('ui')],held,{runId:'other'}),[],'a run does not block itself');
  assert.deepEqual(checkDevices([{id:'db',command:['node','check-db.mjs','--record-id',UDID]}]).devices,[],'an unrelated UUID is not a device');
  assert.deepEqual(checkDevices([{id:'boot',command:['xcrun','simctl','boot',UDID]}]).devices,[UDID]);
  const wrapped={id:'sh',command:['sh','-c',`xcrun simctl boot ${UDID} && xcodebuild test -destination 'id=${UDID2}'`]};
  assert.deepEqual(checkDevices([wrapped]).devices.sort(),[UDID,UDID2].sort());
  assert.equal(deviceFindings([wrapped],[])[0].code,'parallel_simulators','two devices in one check');
  assert.equal(deviceFindings([xcode('ui',['-parallel-testing-worker-count','4'])],[])[0].code,'parallel_simulators');
  assert.equal(deviceFindings([xcode('ui',['-destination','platform=iOS Simulator,name=iPhone 15'])],[])[0].code,'multiple_destinations');
  assert.deepEqual(deviceFindings([xcode('ui',['-parallel-testing-enabled','NO'])],[]),[]);
});

test('preflight drift: completion checks must equal the approved package’s',()=>{
  const recorded=[{id:'syntax',command:['node','--check','a.mjs']}];
  assert.deepEqual(checksDriftFindings(recorded,recorded),[]);
  assert.equal(checksDriftFindings([{id:'syntax',command:['node','--check','b.mjs']}],recorded)[0].code,'checks_changed_since_review');
  assert.deepEqual(checksDriftFindings(undefined,recorded),[]);
});

function preflightProject(t,{scope=['a.mjs'],develop}={}){
  const root=specs(t),specsDir=path.join(root,'specs5'),codeProject=path.join(root,'app'),answersDir=path.join(root,'answers');
  for(const dir of [specsDir,codeProject,answersDir])fs.mkdirSync(dir);
  fs.writeFileSync(path.join(codeProject,'a.mjs'),'old\n');fs.writeFileSync(path.join(answersDir,'a.txt'),'old\n');
  if(develop)for(const [name,value] of Object.entries(develop))fs.writeFileSync(path.join(answersDir,name),JSON.stringify(value));
  fs.writeFileSync(path.join(root,'run.json'),JSON.stringify({version:1,specsDir,codeProject,feature:'1.work',identity,scope,requirements:[]}));
  const plan=(extra={})=>{const file=path.join(root,`plan-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(file,JSON.stringify({config:'run.json',mode:'create',answers:'answers',checks:[xcode('ui')],...extra}));return file;};
  return {root,specsDir,plan};
}
const preflight=(file,operation)=>{const out=main(['preflight','--plan',file,'--operation',operation,'--json']);return {code:out.code,...JSON.parse(out.text)};};

test('preflight reads the attempt the driver will: 1 on create, the journal’s own attempt on resume',()=>{
  assert.equal(answerAttempt('create',null),1);
  assert.equal(answerAttempt('resume',{state:'changes_requested',attempt:2}),2,'the runner already moved to 2: develop-a2.json');
  assert.equal(answerAttempt('resume',{state:'developing',attempt:1}),1);
  assert.equal(answerAttempt('resume',null),null);
});

test('preflight CLI: start-check errors and the commander’s own add up for a develop step, exit 1',t=>{
  const p=preflightProject(t,{scope:['a.mjs','AGENTS.md'],develop:{'develop.json':answer({status:'applied',note:'x'.repeat(600)})}});
  addDispatch(p.specsDir,{label:'另一条运行的 UI 测试',deadlineMinutes:60,runId:'other',resources:[`device:${UDID}`]});
  const out=preflight(p.plan(),'start'),codes=out.findings.map(item=>item.code);
  assert.equal(out.code,1);
  for(const code of ['protected_scope','develop_answer_invalid','develop_no_change','device_busy'])assert.ok(codes.includes(code),`${code} in ${codes}`);
  assert.match(main(['preflight','--plan',p.plan(),'--operation','start']).text,/develop\.json：开发应答会在派出后被判无效/);
  assert.equal(main(['preflight','--plan',path.join(p.root,'missing.json'),'--operation','start','--json']).code,1);
  assert.equal(main(['preflight','--plan',p.plan()]).code,2,'the operation is required');
});

test('preflight CLI: answers are judged only for a develop step, a refused start check is an error, both a1 names conflict',t=>{
  const p=preflightProject(t,{develop:{'develop.json':answer({status:'applied',note:'x'.repeat(600)})}});
  const status=preflight(p.plan(),'status');
  assert.ok(!status.findings.some(item=>item.code.startsWith('develop_')),'a read-only status step does not judge answers');
  const bad=preflightProject(t,{scope:[]});
  const refused=preflight(bad.plan(),'status');
  assert.equal(refused.code,1);assert.ok(refused.findings.some(item=>item.code==='start_check_refused'));
  assert.doesNotMatch(main(['preflight','--plan',bad.plan(),'--operation','status']).text,/体检通过/);
  const both=preflightProject(t,{develop:{'develop.json':answer({status:'no_relevant_lesson',note:null}),
    'develop-a1.json':answer({status:'no_relevant_lesson',note:null})}});
  assert.ok(preflight(both.plan(),'start').findings.some(item=>item.code==='develop_answer_ambiguous'));
  const resume=preflight(p.plan({mode:'resume'}),'resume');
  assert.ok(resume.findings.some(item=>item.code==='answer_check_skipped'),'without a readable journal the attempt is unknown, so answers are skipped and said so');
  assert.match(main(['preflight','--plan',p.plan({mode:'resume'}),'--operation','resume']).text,/跳过/);
});

const ready={state:'ready',reason:'task_selected',nextTask:{feature:'1.work',id:'T-002'}};
const features=[{name:'1.work',tasks:[{id:'T-001',completed:false,dropped:false,dependsOn:[]},{id:'T-002',completed:false,dropped:false,dependsOn:[]}]}];
const noLog={present:true,invalid:0,runs:new Map()};
const job=(id,overdue,extra={})=>({id,label:`job-${id}`,runId:null,resources:[],deadline:NOW,startedAt:NOW,doneAt:null,overdue,overdueMinutes:overdue?30:0,...extra});

test('ledger: an overdue job is checked first, an open one is waited on, an unhealthy registry blocks new work',t=>{
  const overdue=composeLedger({specsDir:'/s',admission:ready,features,runs:[],log:noLog,now:NOW,dispatches:[job('a',true)]});
  assert.equal(overdue.next.kind,'overdue_dispatch');assert.match(overdue.next.why,/30 分钟/);
  const open=composeLedger({specsDir:'/s',admission:ready,features,runs:[],log:noLog,now:NOW,dispatches:[job('b',false)]});
  assert.equal(open.next.kind,'wait_dispatch','single-flight covers registered jobs too');
  for(const problem of ['EACCES','registry_torn','registry_invalid_rows:1']){
    const broken=composeLedger({specsDir:'/s',admission:ready,features,runs:[],log:noLog,now:NOW,registryError:problem});
    assert.equal(broken.next.kind,'check_records',problem);
  }
  const stopped=composeLedger({specsDir:'/s',admission:ready,features,log:noLog,now:NOW,
    runs:[{runId:'r',kind:'cm-ai',verified:true,feature:'1.work',taskId:'T-001',state:'blocked',code:'develop_retry_limit',attempt:2,
      pending:null,committed:false,trustedPrevious:[],claimedPrevious:[],records:9}]});
  assert.equal(stopped.next.decision.decision,'read_status');assert.equal(stopped.next.decision.needsApproval,true);
});

// Acceptance replay of the 30 aihot reopens. Each is mapped, on its recorded
// cause, to what now happens before dispatch:
//   blocked   — an error stops the step (exit 1/2) before any host or run;
//   warned    — a warning names the cause, but the step may still be sent;
//   resolved  — the current design removed the cause itself;
//   variant   — only a neighbouring variant is caught, not the recorded path;
//   workflow  — a workflow code defect, not a dispatch-time matter;
//   none      — not caught yet (task difficulty, external, scope change...).
// Inputs are rebuilt from the recorded cause; the original journals are not replayed.
const REPLAY=[
  [1,'A','workflow'],[2,'A','workflow'],
  [3,'D','resolved','review-package.mjs verifyCompletionReviewPackage: 检查说明文字可变，文件与结果须一致'],
  [4,'D','warned','cm-start-check: dirty scope files warn'],[5,'C','blocked','commander device_busy'],[6,'C','none'],
  [7,'B','blocked','commander develop_answer_invalid'],[8,'C','warned','cm-start-check: two xcodebuild test checks on one scheme warn'],
  [9,'E','none'],[10,'D','warned','cm-start-check: dirty scope files warn（只能提示，不能证明代码来源）'],[11,'A','workflow'],[12,'A','workflow'],
  [13,'B','blocked','cm-ai-develop-driver-gaps: #19 scope material above 2 MiB is refused before launch（四张 PNG 截图）'],
  [14,'B','blocked','cm-start-check: protected scope paths are errors and exit 1'],[15,'E','none'],[16,'E','none'],
  [17,'B','blocked','cm-fix-drive: inspectFixDiagnosis 在开宿主前校验 crossLayer 与 affectedModules'],
  [18,'C','none'],[19,'E','none'],[20,'C','none'],[21,'E','none'],[22,'E','none'],[23,'F','none'],[24,'E','none'],[25,'F','none'],
  [26,'C','warned','commander parallel_simulators（日志量过大未覆盖）'],[27,'A','workflow'],
  [28,'B','variant','commander develop_no_change 只覆盖 cm-ai 开发应答；原事故是 cm-fix 测试应答 test-edits.json'],
  [29,'E','none'],[30,'A','workflow']];

test('replay: the 30 aihot reopens — of the 11 judged stoppable, 5 are blocked, 4 warned, 1 resolved, 1 only as a variant',t=>{
  assert.equal(REPLAY.length,30);
  const byClass=REPLAY.reduce((map,[,cls])=>({...map,[cls]:(map[cls]??0)+1}),{});
  assert.deepEqual(byClass,{A:6,B:5,C:6,D:3,E:8,F:2},'same classification as the 2026-10-14 record');
  const stoppable=new Set([3,4,5,7,8,10,13,14,17,26,28]);
  const tally=REPLAY.filter(([n])=>stoppable.has(n)).reduce((map,[,,via])=>({...map,[via]:(map[via]??0)+1}),{});
  assert.deepEqual(tally,{resolved:1,warned:4,blocked:5,variant:1});
  // The commander's own blocks, through the real CLI: exit 1 before dispatch.
  const p=preflightProject(t,{develop:{'develop.json':answer({status:'applied',note:'x'.repeat(600)},undefined,{'a.mjs':'b.txt'})}});
  fs.writeFileSync(path.join(p.root,'answers','b.txt'),'new\n');
  const seven=preflight(p.plan(),'start');
  assert.equal(seven.code,1);assert.ok(seven.findings.some(item=>item.code==='develop_answer_invalid'&&item.level==='error'),'#7');
  const five=preflightProject(t,{develop:{'develop.json':answer({status:'no_relevant_lesson',note:null},undefined,{'a.mjs':'b.txt'})}});
  fs.writeFileSync(path.join(five.root,'answers','b.txt'),'new\n');
  addDispatch(five.specsDir,{label:'同一模拟器上并行跑的别的测试',deadlineMinutes:60,runId:'other',resources:[`device:${UDID}`]});
  const busy=preflight(five.plan(),'start');
  assert.equal(busy.code,1);assert.ok(busy.findings.some(item=>item.code==='device_busy'&&item.level==='error'),'#5');
  // #17: the existing cm-fix validator refuses a diagnosis without the required fields.
  const diagnosis={status:'diagnosed',rootCause:'r',affectedPaths:['a.mjs'],plan:'p',crossLayer:false,affectedModules:['a']};
  inspectFixDiagnosis(diagnosis);
  for(const field of ['crossLayer','affectedModules']){const {[field]:missing,...rest}=diagnosis;assert.throws(()=>inspectFixDiagnosis(rest),`#17 ${field}`);}
  // #26 is a warning, not a block.
  const parallel=deviceFindings([xcode('ui',['-parallel-testing-worker-count','4'])],[]);
  assert.equal(parallel[0].level,'warn');
  t.diagnostic(JSON.stringify(Object.fromEntries(['blocked','warned','resolved','variant','workflow','none']
    .map(via=>[via,REPLAY.filter(r=>r[2]===via).map(r=>r[0])]))));
});

test('replay: the 8 stopped background jobs are each found once past their deadline (when registered)',t=>{
  const dir=specs(t);
  const jobs=[['会话自写的等待命令：条件写错',20],['会话自写的找报告命令：没设超时',20],['等待 Codex 报告的轮询',30],['等宿主结束的轮询',30],
    ['cm-ai-drive 后台步骤：没设超时',60],['cm-ai-drive 后台步骤：超过外层时限',60],['codex exec 没关 stdin',45],['cm-fix 补测无输出',45]];
  for(const [label,minutes] of jobs)addDispatch(dir,{label,deadlineMinutes:minutes,now:NOW});
  const dispatches=openDispatches(readRegistry(dir),later(61));
  assert.equal(dispatches.filter(job=>job.overdue).length,8);
  const ledger=composeLedger({specsDir:dir,admission:ready,features,runs:[],log:noLog,now:later(61),dispatches});
  assert.equal(ledger.next.kind,'overdue_dispatch');
  assert.equal([ledger.next,...ledger.queue].filter(item=>item.kind==='overdue_dispatch').length,8);
  assert.equal(composeLedger({specsDir:dir,admission:ready,features,runs:[],log:noLog,now:later(10),
    dispatches:openDispatches(readRegistry(dir),later(10))}).next.kind,'wait_dispatch','before any deadline nothing is flagged');
});

test('CLI: dispatch add / list / done round trip, and usage errors exit 2',t=>{
  const dir=specs(t);
  const added=main(['dispatch','add','--specs',dir,'--label','ui test','--deadline-minutes','15','--device',UDID.toLowerCase(),'--json']);
  assert.equal(added.code,0);const {id}=JSON.parse(added.text);
  assert.match(main(['dispatch','list','--specs',dir]).text,new RegExp(`\\[进行\\] ${id} ui test.*device:${UDID}`));
  assert.equal(main(['dispatch','done','--specs',dir,'--id',id]).code,0);
  assert.match(main(['dispatch','list','--specs',dir]).text,/没有未结束的登记/);
  assert.equal(main(['dispatch','add','--specs',dir,'--label','x']).code,2);
  assert.equal(main(['dispatch','nope','--specs',dir]).code,2);
  assert.throws(()=>main(['dispatch','add','--specs',dir,'--label','x','--deadline-minutes','abc']),{code:'invalid_deadline'});
});
