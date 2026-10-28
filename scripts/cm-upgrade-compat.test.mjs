// 升级兼容的完整生命周期（审查 R2-02）：升级前（f73402d）创建、带在途操作的 PRD 会话，
// 用新代码恢复 → 开始新操作 → 发布 → 批准，全程穿过真实宿主与准入 CLI。
//
// 夹具格式依据：f73402d 的 runtime/js/cm-prd/session.mjs openPrdSession/begin/call
// （state.json 只有 version/identity/checkpoint/active/segments；active 为
// {request,before,calls,selfCheckRules?}，规则字段在更早的宿主里不存在；未收到结果的
// 调用只有 {callId,requestDigest,kind,payload}），f73402d 的 cm-ai-admission.mjs
// approveCmAiSpecs（批准状态字段与顺序，taskGrammar:2；更早的批准没有该字段），
// task-scope-record.mjs recordPrdTaskScopes（{version,enforced,exempt}）。
// 外壳逐字段手写；检查点与生成请求负载由 analysis.mjs 产生，它在 f73402d 与本分支之间
// 逐字节未变。最后一条测试在 f73402d 可用时真实运行旧宿主，核对手写夹具与真实存档逐字节一致。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {createCmPrdAnalysis} from '../runtime/js/cm-prd/analysis.mjs';
import {checkPrdDraftMechanics,matchesPrdDraftMechanics} from '../runtime/js/cm-prd/self-check.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
import {buildManifest} from './cm-spec-manifest.mjs';

const TIMEOUT=Number(process.env.CM_TEST_FIXTURE_TIMEOUT_MS??120000);
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const UPGRADE_BASE='f73402d';
const ANALYZED={status:'analyzed',summary:'Developer need',sourcePaths:['docs/input.md'],openQuestions:[]};
const PLAN={requestId:'plan',operation:'advance',text:'Generate specification draft'};
// 升级前宿主在第一次生成请求发出后被杀时留下的分段计数（真实旧宿主运行观察）。
const SEGMENTS={context_load:1,requirements_analysis:2,task_split:1,design_generation:1};

// 在途操作登记的回答：规则 1 跳过 T-002/a，规则 2 起拒绝它；规则 3 起要求每个任务写范围；
// 规则 4（语法 3）还会发现会话任务 T-001 不是最后一个。四条规则得到四份不同的报告。
const TASKS_V1=['- [ ] T-001: Update guide','  - 范围: `README.md`','  - 开发: 会话',
  '- [ ] T-002: Walk guide','  - 范围: `docs/qa.md`','- [ ] T-003: Polish guide','- [ ] T-002/a: Hidden task',''].join('\n');
// 修正后的回答：规则 1-3 全部通过（`开发: 会话` 只是说明文字），规则 4 下仍报 session_task_not_final。
const TASKS_V2=['- [ ] T-001: Update guide','  - 范围: `README.md`','  - 开发: 会话',
  '- [ ] T-002: Walk guide','  - 范围: `docs/qa.md`',''].join('\n');
const reply=tasks=>({status:'draft',summary:'Synthetic documentation draft',features:[{name:'guide',testCasesReason:'no_observable_behavior',
  documents:[{path:'requirements.md',content:'## 功能需求\n1. [F-001] Guide\n- [ ] [AC-001] Document setup.'},
    {path:'design.md',content:'## 方案摘要\nUnreviewed synthetic design'},{path:'tasks.md',content:tasks}]}]});
const EXPECTED_V1={1:[],2:['tasks_invalid'],3:['tasks_invalid','task_scope_missing'],
  4:['tasks_invalid','task_scope_missing','session_task_not_final']};

function project(t,{prior}){
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-upgrade-prd-')));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  for(const name of ['docs','mirror'])fs.mkdirSync(path.join(dir,name));
  fs.writeFileSync(path.join(dir,'docs/input.md'),'Synthetic requirement');
  if(prior!=='none'){
    // 升级前已批准并做完的一个 feature；状态按 f73402d approveCmAiSpecs 的字段顺序手写，
    // 无字段版本是语法 2 出现前的批准。
    fs.mkdirSync(path.join(dir,'1.history'));
    for(const [file,content] of Object.entries({'requirements.md':'## 功能需求\n1. [F-001] History\n- [x] [AC-001] Kept.',
      'design.md':'## 方案摘要\nHistory','tasks.md':'- [x] T-001: Old work\n'}))
      fs.writeFileSync(path.join(dir,'1.history',file),content,{mode:0o600});
    const at='2026-10-01T00:00:00.000Z',specFiles=buildManifest(dir);
    fs.writeFileSync(path.join(dir,'.cm-specs-status'),JSON.stringify({status:'approved',summaryDigest:'a'.repeat(64),at,
      features:['1.history'],specFiles,testCases:[],approval:{response:'开始',at},...(prior==='grammar2'?{taskGrammar:2}:{})})+'\n');
  }
  return dir;
}

// 升级前会话存档：会话没有 taskGrammar/selfCheckRules，在途的 plan 操作已发出生成请求、
// 宿主随后中断（调用没有 result）。rules=null 是规则字段出现前的宿主写的。
async function legacySession(dir,{sessionId,rules,skillDir=path.join(root,'skills/cm-prd'),callId='0d2c7f5e-2b1a-4c3d-9e8f-7a6b5c4d3e2f'}){
  const entry={skillDir,project:dir,specs:dir};let routeTurn=0,payload=null;
  const analysis=createCmPrdAnalysis({input:entry,runtime:'codex',record:async({event})=>{if(event==='decision')routeTurn++;},
    analyze:async()=>structuredClone(ANALYZED),
    generate:async value=>{payload=JSON.parse(JSON.stringify(value));throw Object.assign(new Error('host stopped'),{code:'host_stopped'});}});
  await analysis.advance('Analyze');
  const checkpoint={analysis:analysis.checkpoint(),change:null,started:true,routeTurn,reviewState:null,summaryState:null,publishedSummary:false};
  await assert.rejects(analysis.plan(PLAN.text),{code:'host_stopped'});
  const call={callId,requestDigest:digest({kind:'prd_generate',payload}),kind:'prd_generate',payload};
  const state={version:1,identity:{entry,runtime:'codex'},checkpoint,
    active:{request:PLAN,before:checkpoint,calls:[call],...(rules===null?{}:{selfCheckRules:rules})},segments:SEGMENTS};
  if(sessionId!==undefined){
    for(const relative of ['.reviews','.reviews/prd-sessions',`.reviews/prd-sessions/${sessionId}`])
      fs.mkdirSync(path.join(dir,relative),{mode:0o700,recursive:true});
    fs.writeFileSync(path.join(dir,'.reviews/prd-sessions',sessionId,'state.json'),JSON.stringify(state),{mode:0o600});
  }
  return {state,call};
}

function host(dir,sessionId,onRequest){
  const child=spawn(process.execPath,[path.join(root,'scripts/cm-prd-host.mjs'),'serve','--skill-dir',path.join(root,'skills/cm-prd'),
    '--project',dir,'--specs',dir,'--runtime','codex','--allow-log-write','--allow-review-write','--allow-disposition-write',
    '--allow-spec-write','--host-context','author-context','--session',sessionId],
  {env:{...process.env,CM_WORKFLOW_LOG_HOME:path.join(dir,'mirror')},stdio:['pipe','pipe','pipe']});
  let stderr='',bridge=null,readyResolve;const waiting=new Map(),ready=new Promise(resolve=>{readyResolve=resolve;});
  child.stderr.on('data',chunk=>{stderr+=chunk;});
  const closed=once(child,'close'),lines=createInterface({input:child.stdout});
  const write=value=>child.stdin.write(JSON.stringify(value)+'\n');
  const loop=(async()=>{for await(const line of lines){
    const message=JSON.parse(line);
    if(message.type==='host_ready'){bridge=message.sessionId;readyResolve();}
    else if(message.type==='host_request')write({type:'host_result',sessionId:bridge,callId:message.callId,
      requestDigest:message.requestDigest,result:await onRequest(message)});
    else if(Object.hasOwn(message,'requestId')){const resolve=waiting.get(message.requestId);waiting.delete(message.requestId);resolve(message);}
  }})();
  return {
    async send(request){await ready;const answer=new Promise(resolve=>waiting.set(request.requestId,resolve));write(request);
      const message=await answer;assert.equal(message.error,undefined,`${request.requestId}: ${JSON.stringify(message.error)} ${stderr}`);return message.result;},
    async close(){await ready;write({type:'host_close',sessionId:bridge});const [code]=await closed;await loop;assert.equal(code,0,stderr);},
    kill(){child.kill();},
  };
}

const sessionFile=(dir,sessionId)=>path.join(dir,'.reviews/prd-sessions',sessionId,'state.json');
const readState=(dir,sessionId)=>JSON.parse(fs.readFileSync(sessionFile(dir,sessionId),'utf8'));
const noBinding=state=>!Object.hasOwn(state,'taskGrammar')&&!Object.hasOwn(state,'selfCheckRules');
const codes=report=>report.findings.map(item=>item.code);

// rules：在途操作登记的规则（null=无字段，按规则 1）；prior：发布前 .cm-specs-status 的样子。
for(const [rules,prior] of [[null,'none'],[1,'grammar2'],[2,'legacy'],[3,'none']])
  test(`升级前会话（在途操作规则 ${rules??'无字段'}，已有状态 ${prior}）恢复→新操作→发布→批准`,{timeout:TIMEOUT},async t=>{
    const dir=project(t,{prior}),sessionId=`prd-legacy-${rules??'none'}`,applied=rules??1;
    const {call}=await legacySession(dir,{sessionId,rules});
    const feature=prior==='none'?'1.guide':'2.guide';
    // 新操作期间（请求已发出、结果未回）读存档：规则来自会话的旧字面量 3，会话本身不被改写。
    const observed=[];
    const watch=()=>{const state=readState(dir,sessionId);observed.push(state.active?.selfCheckRules);
      assert.ok(noBinding(state),'升级前的会话不补写版本字段');};
    let checks=0,v1Digest=null;
    const session=host(dir,sessionId,async message=>{
      const {kind,payload}=message;
      if(kind==='prd_generate'){watch();return reply(TASKS_V2);}
      if(kind==='prd_self_check'){watch();checks++;const draft=payload.draft;
        // 第一次只为规则 1 的旧回答（它机械自检通过）报一个上下文失败，促成一次新的生成操作。
        return {draftDigest:draft.draftDigest,features:draft.features.map(item=>({directory:item.directory,
          checks:draft.mechanicalSelfCheck.pending.map((id,index)=>({id,status:draft.draftDigest===v1Digest&&index===0?'failed':'passed',
            evidence:['Synthetic context check']}))}))};}
      if(kind==='prd_review')return {reviewer:'codex-subagent',contextId:'reviewer-context',independent:true,at:'2026-10-27T00:00:00.000Z',
        result:{verdict:'changes_requested',packageDigest:payload.package.packageDigest,examinedPaths:payload.examinedPaths,
          findings:[{id:'R1',severity:'P2',path:`${feature}/design.md`,message:'Clarify design',evidence:'Synthetic finding'}],summary:'Synthetic review'}};
      if(kind==='prd_correct')return {documents:payload.documents.map(item=>({path:item.path,
        content:item.path===`${feature}/design.md`?'## 方案摘要\nCorrected synthetic design':item.content})),
        decisions:[{id:'R1',status:'applied',evidence:['Synthetic clarification'],changedPaths:[`${feature}/design.md`]}]};
      if(kind==='prd_summary')return {evidenceDigest:payload.evidenceDigest,deliveryForm:'Documentation',estimatedTime:'Human review required',
        openQuestions:'None',risks:'Synthetic responses',contextScope:'Targeted',platformReadiness:'Not applicable',uiBaseline:'None',
        designRisk:[{feature,signals:{greenfieldAdr:false,architectureOrDataFlow:false,newRuntimeDependencyOrToolchain:false,
          publicContractDataOrSecurity:false,fiveOrMoreFunctions:false},evidence:['Synthetic documentation-only fixture']}]};
      throw new Error(`unexpected host request ${kind}`);
    });
    try{
      // 1. 恢复在途操作：消费原生成请求的结果，按它自己登记的规则重放。
      let status=await session.send({requestId:'resume',operation:'resume',resolution:{callId:call.callId,requestDigest:call.requestDigest,
        result:reply(TASKS_V1),evidence:'Planner reply delivered before the host stopped'}});
      let state=readState(dir,sessionId);
      assert.ok(noBinding(state));assert.equal(state.active,null);
      const draft=state.checkpoint.analysis.draft,report=draft.mechanicalSelfCheck;
      assert.deepEqual(codes(report),EXPECTED_V1[applied],`在途操作沿用规则 ${applied}`);
      assert.deepEqual(report,checkPrdDraftMechanics(draft,{rules:applied}));
      assert.ok(matchesPrdDraftMechanics(draft,report),'历史报告摘要仍匹配');
      assert.equal(status.stage,applied===1?'draft_ready':'draft_self_check_failed');
      v1Digest=draft.draftDigest;
      // 2. 之后每个新操作都按会话固定的规则 3；修正稿在规则 4 下会失败，在这里通过。
      for(let guard=0;status.stage!=='self_check_reported_passed';guard++){
        assert.ok(guard<4,status.stage);
        status=await session.send(status.stage==='draft_ready'?{requestId:`verify-${guard}`,operation:'advance',text:'Self-check'}
          :{requestId:`fix-${guard}`,operation:'advance',text:'Fix reported findings'});
      }
      state=readState(dir,sessionId);
      const fixed=state.checkpoint.analysis.draft;
      assert.deepEqual(codes(fixed.mechanicalSelfCheck),[]);
      assert.deepEqual(codes(checkPrdDraftMechanics(fixed,{rules:4})),['session_task_not_final'],'规则 4 会拒绝修正稿');
      assert.ok(observed.length>=2&&observed.every(value=>value===3),`新操作登记规则 3：${observed}`);
      // 3. 保存：规则 3 的保存写旧格式的范围记录，后续重查不按语法 3 读。
      const saved=await session.send({requestId:'save',operation:'save_draft'});
      assert.equal(saved.status,'draft_saved');
      const slug=feature.replace(/^\d+\./,'');
      assert.equal(fs.readFileSync(path.join(dir,`.reviews/prd-${slug}-task-scope.json`),'utf8'),
        JSON.stringify({version:1,enforced:true,exempt:[]})+'\n');
      assert.equal(fs.readFileSync(path.join(dir,feature,'tasks.md'),'utf8'),TASKS_V2);
      // 4. 拆分审查、修正、处置、汇总（各处重查都在会话规则下通过）。
      await session.send({requestId:'package',operation:'final_review_package',stage:'split',feature});
      const reviewed=await session.send({requestId:'review',operation:'final_review',stage:'split',feature,mode:'independent'});
      assert.equal(reviewed.reviewState.status,'review_recorded');
      await session.send({requestId:'findings',operation:'review_findings',stage:'split',feature});
      assert.equal((await session.send({requestId:'correct',operation:'correct_findings',stage:'split',feature})).status,'correction_saved');
      const corrected=await session.send({requestId:'resume-correction',operation:'resume_correction',stage:'split',feature});
      const disposed=await session.send({requestId:'disposition',operation:'review_disposition',stage:'split',feature,
        packageDigest:corrected.packageDigest,decisions:corrected.decisions,artifacts:corrected.artifacts});
      assert.equal(disposed.status,'disposition_recorded');
      const summary=await session.send({requestId:'summary',operation:'prepare_summary'});
      assert.equal(summary.readyForAwaitingReview,true,JSON.stringify(summary.blockers));
      // 5. 发布：首次发布写会话绑定的语法 2；已有状态沿用它的语法（旧版无字段的保持无字段）。
      const published=await session.send({requestId:'publish',operation:'publish_summary',summaryDigest:summary.summaryDigest});
      assert.equal(published.status,'awaiting_review');
      const awaiting=JSON.parse(fs.readFileSync(path.join(dir,'.cm-specs-status'),'utf8'));
      assert.equal(awaiting.status,'awaiting_review');
      if(prior==='legacy')assert.equal(Object.hasOwn(awaiting,'taskGrammar'),false,'无字段的旧状态保持无字段');
      else assert.equal(awaiting.taskGrammar,2);
      assert.ok(noBinding(readState(dir,sessionId)));
    }finally{await session.close().catch(()=>session.kill());}
    // 6. 批准：沿用待审状态携带的语法，没有携带的写 2，从不升成 3。
    const approve=spawnSync(process.execPath,[path.join(root,'scripts/cm-ai-admission.mjs'),'--specs-dir',dir,'--code-project',dir,
      '--approve','--approval-response','开始'],{encoding:'utf8',env:process.env});
    const approved=JSON.parse(fs.readFileSync(path.join(dir,'.cm-specs-status'),'utf8'));
    assert.equal(approved.status,'approved',approve.stdout+approve.stderr);
    assert.equal(approved.taskGrammar,2);
    assert.deepEqual(approved.features,prior==='none'?['1.guide']:['1.history','2.guide']);
  });

// 手写夹具与升级前宿主真实写出的存档逐字节一致（只在本地有 f73402d 时可核对）。
const oldAvailable=spawnSync('git',['-C',root,'cat-file','-e',`${UPGRADE_BASE}^{commit}`]).status===0;
test('手写的升级前会话存档与 f73402d 宿主真实写出的逐字节一致',{timeout:TIMEOUT,
  skip:oldAvailable?false:`本地没有 ${UPGRADE_BASE}（浅克隆），跳过真实旧宿主比对`},async t=>{
  const old=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-upgrade-old-')));
  t.after(()=>fs.rmSync(old,{recursive:true,force:true}));
  const archive=spawnSync('git',['-C',root,'archive','--format=tar',UPGRADE_BASE],{maxBuffer:256*1024*1024});
  assert.equal(archive.status,0,String(archive.stderr));
  assert.equal(spawnSync('tar',['-x','-C',old],{input:archive.stdout}).status,0);
  const dir=project(t,{prior:'none'}),skillDir=path.join(old,'skills/cm-prd');
  const child=spawn(process.execPath,[path.join(old,'scripts/cm-prd-host.mjs'),'serve','--skill-dir',skillDir,'--project',dir,'--specs',dir,
    '--runtime','codex','--allow-log-write'],{env:{...process.env,CM_WORKFLOW_LOG_HOME:path.join(dir,'mirror')},stdio:['pipe','pipe','pipe']});
  const closed=once(child,'close'),lines=createInterface({input:child.stdout});let stderr='',bridge;
  child.stderr.on('data',chunk=>{stderr+=chunk;});
  const send=value=>child.stdin.write(JSON.stringify(value)+'\n');
  for await(const line of lines){
    const message=JSON.parse(line);
    if(message.type==='host_ready'){bridge=message.sessionId;send({requestId:'turn',operation:'start',text:'Analyze'});}
    else if(message.type==='host_request'&&message.kind==='prd_analyze')send({type:'host_result',sessionId:bridge,callId:message.callId,
      requestDigest:message.requestDigest,result:ANALYZED});
    else if(message.requestId==='turn'){assert.equal(message.result?.stage,'analysis_ready',stderr);send(PLAN);}
    // 生成请求发出后宿主中断：升级前在途操作的真实样子。
    else if(message.type==='host_request'&&message.kind==='prd_generate'){child.kill('SIGKILL');break;}
  }
  lines.close();await closed;
  const [sessionId]=fs.readdirSync(path.join(dir,'.reviews/prd-sessions'));
  const real=fs.readFileSync(sessionFile(dir,sessionId),'utf8');
  const recorded=JSON.parse(real);
  assert.equal(recorded.active.selfCheckRules,3,'f73402d 的宿主登记规则 3');
  // 调用编号是会话自己随机生成的，只有它取自真实存档。
  const {state}=await legacySession(dir,{rules:3,skillDir,callId:recorded.active.calls[0].callId});
  assert.equal(JSON.stringify(state),real);
});
