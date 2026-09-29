// Explicit restart boundary. Discovery reads old stores as immutable snapshots;
// only the new runner may record the authorization and move named projections.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {readExecutionSnapshot} from './execution-snapshot.mjs';
import {readRunnerHistory} from './durable-runner-state.mjs';
import {supersedeWorkflowFile} from './review-evidence-file.mjs';
import {need,digest} from './effect-contract.mjs';
import {readEvidenceSupersession,supersedableEvidenceName} from './reviewed-evidence-supersession-record.mjs';
import {boundReviewText} from './review-runner.mjs';
import {scanRows} from './cm-ai-qa-log.mjs';
import {taskDeclarations,approvedTaskGrammar} from '../spec-task-line.mjs';
import {compareReviewInventoryToBaseline,readReviewBaseline} from './review-package.mjs';

const writer=fileURLToPath(new URL('../../../scripts/cm-log-event.py',import.meta.url));
const unavailable=reason=>{const error=new Error('supersede_unavailable');error.code='supersede_unavailable';error.reason=reason;throw error;};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const codeDrift=reason=>{const error=new Error('supersede_code_drift');error.code='supersede_code_drift';error.reason=reason;throw error;};
const driftInstruction='这些文件与直接前驱运行开工前的基线不一致。手动还原这些文件后重建运行；或确认保留这些改动时加 --accept-superseded-code-drift 重建（这些文件会被当成已有代码，不进新运行的审查改动）。';

function verifyOldCodeBaseline(codeProject,rawBaseline){
  // Legacy journals without a complete V2 inventory cannot prove code drift.
  if(rawBaseline?.version!==2)return [];
  const baseline=readReviewBaseline(rawBaseline);
  let current;
  try{
    if(fs.realpathSync(codeProject)!==codeProject||!fs.lstatSync(codeProject).isDirectory())
      codeDrift(`无法安全核对代码根目录。${driftInstruction}`);
    current=compareReviewInventoryToBaseline(codeProject,baseline);
  }catch(error){
    if(error.code==='supersede_code_drift')throw error;
    codeDrift(`无法安全核对代码树（${error.code??'read_failed'}）。${driftInstruction}`);
  }
  // The shared comparison filters both sides with one ignore-decision union.
  return current;
}

// The direct predecessor's last review receipt, or the context it carried itself
// when it never reached a review. Bounded like any journaled review text.
function carriedReviewFrom(runId,state,supersession){
  const result=state.receipts.at(-1)?.result;
  if(!result)return supersession?.carriedReview??null;
  const bounded=boundReviewText({verdict:result.verdict,packageDigest:result.packageDigest,
    examinedPaths:[],findings:result.findings,summary:result.summary});
  return bounded?{previousRunId:runId,verdict:bounded.verdict,summary:bounded.summary,findings:bounded.findings}:null;
}

function taskChecked(tasksPath,taskId){
  const rows=taskDeclarations(fs.readFileSync(tasksPath,'utf8'),
    {grammar:approvedTaskGrammar(path.dirname(path.dirname(tasksPath)))}).filter(task=>task.id===taskId);
  if(rows.length!==1)unavailable('tasks.md 中任务身份不唯一或不存在');
  return rows[0].completed;
}

function qaTerminal(specsDir,runId,taskId){
  const log=path.join(specsDir,'运行日志.jsonl');if(!fs.existsSync(log))return 'never_finished';
  let result='never_finished';
  scanRows(log,row=>{
    if(row.workflow!=='cm-ai'||row.run_id!==runId||row.task!==taskId)return;
    if(row.event==='run_done')result='completed';
    else if(result!=='completed'&&row.event==='test_run'&&row.phase==='complete')result=row.result;
  });
  return result;
}

function evidenceNames(reviewsDir,feature,taskId){
  return fs.readdirSync(reviewsDir,{withFileTypes:true}).filter(entry=>entry.isFile()
    &&supersedableEvidenceName(entry.name,feature,taskId))
    .map(entry=>entry.name).sort();
}

export function oldWriterOpen(execution,runId,{lsofPath}={}){
  // Inspect descriptor ownership without opening the old SQLite store.
  const writerFile=path.join(execution,runId,'writer.sqlite');
  const lsof=lsofPath??['/usr/sbin/lsof','/usr/bin/lsof'].find(file=>fs.existsSync(file));
  if(lsof){
    const result=spawnSync(lsof,['-F','p','--',writerFile],
      {timeout:10000,maxBuffer:64*1024,encoding:'utf8'});
    const diagnostics=(result.stderr??'').split(/\r?\n/).filter(line=>line.trim()&&!/^lsof: WARNING:/.test(line));
    if(result.error||result.signal||![0,1].includes(result.status)||diagnostics.length)
      unavailable(`无法核对旧运行 ${runId} 的 writer 状态`);
    if(result.status===0&&!/^p\d+$/m.test(result.stdout))unavailable(`无法核对旧运行 ${runId} 的 writer 状态`);
    return result.status===0;
  }
  const fuser='/usr/bin/fuser';
  if(process.platform==='linux'&&fs.existsSync(fuser)){
    const result=spawnSync(fuser,[writerFile],{timeout:3000,maxBuffer:64*1024,encoding:'utf8'});
    if(result.error||result.signal||![0,1].includes(result.status))
      unavailable(`无法核对旧运行 ${runId} 的 writer 状态`);
    if(result.status===0&&!/\b\d+\b/.test(result.stdout))unavailable(`无法核对旧运行 ${runId} 的 writer 状态`);
    return result.status===0;
  }
  unavailable(`缺少核对旧运行 ${runId} writer 占用的本地工具`);
}

export function prepareReviewedEvidenceSupersession({specsDir,codeProject,feature,identity,reason,tasksPath,acceptSupersededCodeDrift=false}){
  if(typeof reason!=='string'||!reason.trim()||Buffer.byteLength(reason,'utf8')>500||/[\r\n\0]/.test(reason))
    unavailable('必须提供单行且不超过 500 字节的 --supersede-reason');
  if(taskChecked(tasksPath,identity.taskId))unavailable('tasks.md 已将任务标为完成；若 QA BLOCKED 后确需重跑，先将该任务改回 - [ ]，再以 --supersede-reviewed-evidence 和 --supersede-reason 创建新运行');
  const reviewsDir=path.join(specsDir,'.reviews');
  if(!fs.existsSync(reviewsDir))unavailable('没有同 feature、task 的旧运行');
  const execution=path.join(reviewsDir,'.execution');
  const previousRunIds=[],priorRuns=[],alreadySuperseded=new Set();
  if(fs.existsSync(execution))for(const entry of fs.readdirSync(execution,{withFileTypes:true})){
    if(!entry.isDirectory()||entry.name===identity.runId)continue;
    const stateFile=path.join(execution,entry.name,'state.json');
    if(!fs.existsSync(stateFile))continue;
    let snapshot;
    try{snapshot=readExecutionSnapshot({specsRoot:specsDir,
      identity:{repositoryId:identity.repositoryId,runId:entry.name}});}
    catch(error){if(error.code==='identity_mismatch')continue;throw error;}
    const first=snapshot.records[0]?.payload;
    if(first?.config?.identity?.taskId!==identity.taskId||first?.config?.taskLearning?.feature!==feature)continue;
    if(first.config.identity.repositoryId!==identity.repositoryId||first.config.identity.runId!==entry.name
      ||first.config.root!==codeProject||first.config.completion?.owner?.specsRoot!==specsDir
      ||first.config.completion?.owner?.tasksPath!==tasksPath)
      unavailable(`旧运行 ${entry.name} 的任务身份或路径不匹配`);
    if(first.version!==3)unavailable(`旧运行 ${entry.name} 的 journal 版本无法验证`);
    const history=readRunnerHistory(snapshot.records,first.config,3);
    if(history.pending){
      const exit=history.pendingAbandonable?'abandon_effect':
        history.pending.kind==='review'&&history.state.reviewInvocation?.registration
          &&history.state.reviewInvocation.result===null?'abandon_review':'原运行恢复入口';
      unavailable(`旧运行 ${entry.name} 的 ${history.pending.kind} effect 已中断且未结；先确认旧 host 和子进程已退出，再在原 run 上使用 ${exit}，随后重新发起 supersede`);
    }
    if(!['blocked','cancelled','unknown','fixture_completed'].includes(history.state.state))
      unavailable(`旧运行 ${entry.name} 仍可继续或有未结操作`);
    if(oldWriterOpen(execution,entry.name))unavailable(`旧运行 ${entry.name} 的 writer 仍被进程持有`);
    const qa=qaTerminal(specsDir,entry.name,identity.taskId);
    if(history.state.state==='fixture_completed'&&!['BLOCKED','never_finished'].includes(qa))
      unavailable(qa==='completed'?`旧运行 ${entry.name} 已完成（run_done）`
        :['PASS','PASSED'].includes(qa)?`旧运行 ${entry.name} 的 QA 已通过`
        :['FAIL','FAILED'].includes(qa)?`旧运行 ${entry.name} 的最新 QA 结果为 FAIL（未通过），失败要修复而不是重开发：在原运行上用 QA 修复（fix_advance / fix_run）处理；修复子运行的审查卡在结果未知时，确认旧进程已退出后用 abandon_review 放弃一次再重审`
        :`旧运行 ${entry.name} 的最新 QA 结果为 ${qa}，不是 BLOCKED，不能用重开发替换；请在原运行上按该结果的恢复入口处理`);
    priorRuns.push({runId:entry.name,baseline:first.baseline,
      carriedReview:carriedReviewFrom(entry.name,history.state,history.supersession)});
    for(const runId of history.supersession?.previousRunIds??[])alreadySuperseded.add(runId);
    previousRunIds.push(entry.name);
  }
  if(!previousRunIds.length)unavailable('没有同 feature、task 的旧运行');
  const drift=priorRuns.filter(run=>!alreadySuperseded.has(run.runId))
    .flatMap(run=>verifyOldCodeBaseline(codeProject,run.baseline)
      .map(file=>({predecessorRunId:run.runId,...file})))
    .sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:
      a.predecessorRunId<b.predecessorRunId?-1:a.predecessorRunId>b.predecessorRunId?1:0);
  if(drift.length&&!acceptSupersededCodeDrift){
    const paths=[...new Set(drift.map(file=>file.path))],listed=paths.slice(0,20).join('、');
    codeDrift(`${listed}${paths.length>20?` 等 ${paths.length-20} 个`:''}：${driftInstruction}`);
  }
  // A run that stopped before any handoff or review has nothing to archive; the
  // record still ends the prior runs and carries any accepted code drift.
  const previous=new Set(previousRunIds);
  const carriedReview=priorRuns.filter(run=>!alreadySuperseded.has(run.runId)&&run.carriedReview
    &&previous.has(run.carriedReview.previousRunId))
    .sort((a,b)=>a.runId<b.runId?-1:a.runId>b.runId?1:0).at(-1)?.carriedReview??null;
  const names=evidenceNames(reviewsDir,feature,identity.taskId);
  const files=names.map(name=>{
    const p=path.join(reviewsDir,name),stat=fs.lstatSync(p);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)unavailable(`证据文件不可安全归档：${name}`);
    return {name,sha256:hash(fs.readFileSync(p))};
  });
  return readEvidenceSupersession({version:1,feature,taskId:identity.taskId,newRunId:identity.runId,
    previousRunIds:previousRunIds.sort(),reason,files,authorizedAt:new Date().toISOString(),
    ...(drift.length?{acceptedCodeDrift:drift}:{}),...(carriedReview?{carriedReview}:{})});
}

// A plain create (no supersede) must not silently adopt a previous run's
// unreviewed edits as its baseline. Same comparison as supersede, over the runs
// of this task that no later run has superseded; the only way to keep the
// edits is the explicit supersede record with --accept-superseded-code-drift.
export function assertNoUnrecordedPriorCode({specsDir,codeProject,feature,identity,tasksPath}){
  const execution=path.join(specsDir,'.reviews','.execution');
  if(!fs.existsSync(execution))return;
  const priorRuns=[],superseded=new Set();
  for(const entry of fs.readdirSync(execution,{withFileTypes:true})){
    if(!entry.isDirectory()||entry.name===identity.runId)continue;
    if(!fs.existsSync(path.join(execution,entry.name,'state.json')))continue;
    let snapshot;
    try{snapshot=readExecutionSnapshot({specsRoot:specsDir,
      identity:{repositoryId:identity.repositoryId,runId:entry.name}});}
    catch(error){if(error.code==='identity_mismatch')continue;throw error;}
    const first=snapshot.records[0]?.payload;
    // Other tasks, roots and pre-V3 journals are out of this comparison (the
    // latter cannot prove drift, as in supersede).
    if(first?.version!==3||first.config?.identity?.taskId!==identity.taskId
      ||first.config?.taskLearning?.feature!==feature||first.config.root!==codeProject
      ||first.config.completion?.owner?.tasksPath!==tasksPath)continue;
    const record=snapshot.records[1]?.payload;
    if(record?.type==='evidence-superseded')for(const runId of readEvidenceSupersession(record.record).previousRunIds)
      superseded.add(runId);
    priorRuns.push({runId:entry.name,baseline:first.baseline});
  }
  const drift=priorRuns.filter(run=>!superseded.has(run.runId))
    .flatMap(run=>verifyOldCodeBaseline(codeProject,run.baseline).map(file=>({runId:run.runId,path:file.path})));
  if(!drift.length)return;
  const paths=[...new Set(drift.map(file=>file.path))].sort(),runs=[...new Set(drift.map(file=>file.runId))].sort();
  codeDrift(`旧运行 ${runs.join('、')} 开工后这些文件被改动，且没有替代记录：${paths.slice(0,20).join('、')}`
    +`${paths.length>20?` 等 ${paths.length-20} 个`:''}。新运行不会把它们当成已有代码。`
    +'可选：回到旧运行继续；手动还原这些文件后再新建；或旧运行结束后用 --supersede-reviewed-evidence --supersede-reason 原因 '
    +'--accept-superseded-code-drift 新建（改动记入替代记录，作为已有代码，不进新运行的审查改动）。');
}

export function archiveReviewedEvidence(reviewsDir,raw){
  const record=readEvidenceSupersession(raw);
  const archive=path.join(reviewsDir,'.superseded');
  for(const file of record.files){
    const source=path.join(reviewsDir,file.name),target=path.join(archive,`${file.name}.${file.sha256.slice(0,16)}`);
    let archived=false;
    if(fs.existsSync(target)){
      const stat=fs.lstatSync(target);
      need(stat.isFile()&&!stat.isSymbolicLink()&&hash(fs.readFileSync(target))===file.sha256,'supersede_archive_conflict');
      archived=true;
    }
    if(fs.existsSync(source)){
      const stat=fs.lstatSync(source);
      need(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink<=2,'supersede_file_changed');
      if(hash(fs.readFileSync(source))===file.sha256)supersedeWorkflowFile(reviewsDir,file.name);
      else need(archived,'supersede_file_changed'); // New run has already published its own bytes.
    }
    need(fs.existsSync(target)&&hash(fs.readFileSync(target))===file.sha256,'supersede_archive_missing');
  }
  return record;
}

export function recordEvidenceSupersession({specsDir,codeProject,identity,record,logHome}){
  const data={node:'N3',feature:record.feature,task:record.taskId,
    previous_run_count:record.previousRunIds.length,file_count:record.files.length,
    record_digest:digest(record),reason:record.reason};
  const args=[writer,'--workflow','cm-ai','--event','supersede','--runtime','codex',
    '--project-root',codeProject,'--specs-dir',specsDir,'--run-id',identity.runId,
    '--at',record.authorizedAt,'--detail','显式归档旧任务证据','--data-json',JSON.stringify(data)];
  const result=spawnSync('python3',args,{timeout:10000,maxBuffer:1024*1024,
    ...(logHome?{env:{...process.env,CM_WORKFLOW_LOG_HOME:logHome}}:{})});
  need(!result.error&&result.status===0,'supersede_log_failed');
}
