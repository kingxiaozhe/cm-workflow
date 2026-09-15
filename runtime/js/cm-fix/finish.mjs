// Serial closeout using the original N5 gate, dossier, metrics and log authority.
import fs from 'node:fs';
import path from 'node:path';
import {types} from 'node:util';
import {checkN5} from '../../../scripts/cm-task-gate.mjs';
import {readReviewSourceFiles} from '../cm-ai/review-package.mjs';
import {digest,need} from '../cm-ai/effect-contract.mjs';
import {publishFixDossier} from './dossier.mjs';
import {appendFixMetrics,fixMetricsRow} from './metrics.mjs';
import {logFixEvent} from './start.mjs';
import {loadConfig} from '../../../scripts/cm-workflow-config.mjs';
import {fixDossierRelative} from './layout.mjs';

export function eventsAt(specsRoot,configuration={}){
  if(configuration.archiveMode==='bare'){
    const base='.reviews/host-log-mirror/runs',directory=path.join(specsRoot,base);
    if(!fs.existsSync(directory))return [];
    const names=[];
    for(const month of fs.readdirSync(directory).sort()){
      need(/^\d{4}-\d{2}$/.test(month)&&fs.realpathSync(path.join(directory,month))===path.join(directory,month),'fix_log_failed');
      for(const file of fs.readdirSync(path.join(directory,month)).sort())if(file.endsWith('.jsonl'))names.push(`${base}/${month}/${file}`);
    }
    return names.flatMap(name=>{
      const [file]=readReviewSourceFiles(specsRoot,[name]);
      return new TextDecoder('utf-8',{fatal:true}).decode(Buffer.from(file.contentBase64,'base64')).trim().split('\n').filter(Boolean).map(JSON.parse);
    });
  }
  if(!fs.existsSync(path.join(specsRoot,'运行日志.jsonl')))return [];
  const [file]=readReviewSourceFiles(specsRoot,['运行日志.jsonl']);
  const body=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.from(file.contentBase64,'base64')).trim();
  return body?body.split('\n').map(JSON.parse):[];
}
const matches=(row,identity)=>row.workflow==='cm-fix'&&row.node==='FIX'&&row.run_id===identity.runId
  &&row.repository_id===identity.repositoryId&&row.task===identity.taskId&&row.attempt===identity.attempt;
export const isFixObservationExit=row=>row.event==='run_done'&&row.phase==='observation'&&row.result==='observing';

function requireCloseoutEvidence(status){
  need(status.handoffEvidenceCoverage==='defect_and_learning'&&status.walkthrough?.status==='passed'
    &&status.diagnosis.investigation&&(!status.diagnosis.crossLayer||status.diagnosis.investigation.boundaryAnalysis),'fix_closeout_evidence_required');
}

function lessonRecord(identity,status){
  const candidates=status.retrospective.content.candidates;
  const marker=`<!-- cm-fix-lessons ${identity.runId} ${identity.taskId} a${identity.attempt} -->`;
  const block=`${marker}\n## ${identity.taskId} — 已审复盘记录\n\n`
    +JSON.stringify(candidates,null,2).split('\n').map(line=>`    ${line}`).join('\n')+'\n';
  return {marker,block};
}
function appendLessons({specsRoot,identity,status},verify){
  if(!status.retrospective.content.candidates.length)return;
  const {marker,block}=lessonRecord(identity,status);
  const target=path.join(specsRoot,'LESSONS.md');verify();let fd;
  try{
    fd=fs.openSync(target,fs.constants.O_RDWR|fs.constants.O_CREAT|fs.constants.O_APPEND|(fs.constants.O_NOFOLLOW??0),0o600);
    const before=fs.fstatSync(fd);need(before.isFile()&&before.nlink===1&&before.size<=1024*1024,'fix_lessons_invalid');
    const content=fs.readFileSync(fd).toString('utf8');
    if(content.includes(marker)){need(content.split(marker).length===2&&content.includes(block),'fix_lessons_conflict');return;}
    const bytes=Buffer.from((content.endsWith('\n')||!content?'':'\n')+block);need(before.size+bytes.length<=1024*1024,'limit_exceeded');
    verify();const current=fs.lstatSync(target);need(!current.isSymbolicLink()&&current.dev===before.dev&&current.ino===before.ino&&current.size===before.size,'fix_lessons_changed');
    need(fs.writeSync(fd,bytes)===bytes.length,'fix_lessons_write_unknown');fs.fsyncSync(fd);
    const [written]=readReviewSourceFiles(specsRoot,['LESSONS.md']);need(Buffer.from(written.contentBase64,'base64').toString('utf8').includes(block),'fix_lessons_write_unknown');
  }finally{if(fd!==undefined)fs.closeSync(fd);}
}

export function fixCompletionProjection({specsRoot,identity,status,configuration={}}){
  const bare=configuration.archiveMode==='bare';
  const events=eventsAt(specsRoot,configuration),done=events.filter(row=>matches(row,identity)&&row.event==='task_done'),
    ended=events.filter(row=>matches(row,identity)&&row.event==='run_done'&&!isFixObservationExit(row));
  if(!done.length&&!ended.length)return status;
  const completionHistory={taskDoneEventIds:done.map(row=>row.event_id),runDoneEventIds:ended.map(row=>row.event_id)};
  try{
    requireCloseoutEvidence(status);
    need(done.length===1&&ended.length<=1,'fix_completion_conflict');const task=done[0];
    need(task.result==='completed'&&task.package_digest===status.n5?.packageDigest,'fix_completion_conflict');
    const dossierFile=path.posix.basename(task.dossier_file);
    const record=bare?null:fixMetricsRow({events,identity,dossierFile});
    const records=readReviewSourceFiles(specsRoot,[task.dossier_file,...(bare?[]:['METRICS.md'])]);
    const archive=records.find(file=>file.path===task.dossier_file),table=records.find(file=>file.path==='METRICS.md');
    need(archive.sha256===task.dossier_sha256,'fix_completion_conflict');
    if(status.retrospective.content.candidates.length){
      const {marker,block}=lessonRecord(identity,status),[lessons]=readReviewSourceFiles(specsRoot,['LESSONS.md']);
      const content=Buffer.from(lessons.contentBase64,'base64').toString('utf8');
      need(content.split(marker).length===2&&content.includes(block),'fix_lessons_conflict');
    }
    if(!bare){const rows=Buffer.from(table.contentBase64,'base64').toString('utf8').split(/\r?\n/);
      need(rows.filter(line=>line.startsWith(`| ${dossierFile} | fix |`)).length===1&&rows.includes(record.line),'fix_metrics_missing');}
    need(ended.length===1&&ended[0].completion_event_id===task.event_id&&(bare?ended[0].metrics_skipped==='no_specs':ended[0].metrics_row_digest===digest(record.line))
      &&ended[0].package_digest===task.package_digest&&events.indexOf(ended[0])>events.indexOf(task),'fix_run_pending');
    return {...status,completionHistory,...(status.stage==='closeout_required'?{stage:'completed',completionEligible:true}:{})};
  }catch{return {...status,completionHistory,...(status.stage==='closeout_required'?{stage:'closeout_incomplete'}:{})};}
}

export function finishFix({specsRoot,identity,configuration,status,registeredAt},{assertOwned}){
  need(['closeout_required','closeout_incomplete','completed'].includes(status.stage),'fix_closeout_unavailable');
  requireCloseoutEvidence(status);
  const feature=`fix-${identity.taskId.slice(6)}`,reviewsDir=path.join(specsRoot,'.reviews');
  const verify=()=>{
    const owned=assertOwned();if(types.isPromise(owned))Promise.prototype.then.call(owned,()=>{},()=>{});
    need(owned===undefined,'fix_owner_required');
    need(loadConfig({projectRoot:configuration.reproduction.cwd}).policies.delivery==='diff','fix_delivery_authorization_required');
    const gate=checkN5({handoff:path.join(reviewsDir,`${feature}-${identity.taskId}-a${identity.attempt}-handoff.json`),
      reviewsDir,feature,task:identity.taskId,projectRoot:configuration.reproduction.cwd,requireLearning:true});
    need(digest(gate)===digest(status.n5.gate),'n5_evidence_changed');
  };
  verify();
  const dossier=publishFixDossier({specsRoot,identity,configuration,status:{...status,stage:'closeout_required',completionEligible:false},registeredAt,final:true});
  appendLessons({specsRoot,identity,status},verify);
  const bare=configuration.archiveMode==='bare';
  const data={result:'completed',package_digest:status.n5.packageDigest,dossier_file:fixDossierRelative(configuration,path.basename(dossier.path)),
    dossier_sha256:dossier.sha256,walkthrough_result:'passed'};
  // Validate the required log inputs before claiming task completion.
  const provisional={workflow:'cm-fix',node:'FIX',run_id:identity.runId,repository_id:identity.repositoryId,task:identity.taskId,attempt:identity.attempt,
    event:'task_done',event_id:'preflight',at:new Date().toISOString(),...data};
  const events=eventsAt(specsRoot,configuration),prior=events.filter(row=>matches(row,identity)&&row.event==='task_done');
  if(!bare)fixMetricsRow({events:prior.length?events:[...events,provisional],identity,dossierFile:path.basename(dossier.path)});
  verify();
  const task=logFixEvent({specsRoot,identity,configuration,event:'task_done',detail:'JS defect verified and dossier finalized',data});
  const metrics=bare?null:appendFixMetrics({specsRoot,identity,dossierFile:path.basename(dossier.path)},{assertOwned:verify});
  verify();
  logFixEvent({specsRoot,identity,configuration,event:'run_done',detail:'JS defect closeout completed',data:{...data,
    completion_event_id:task.event_id,...(bare?{metrics_skipped:'no_specs'}:{metrics_row_digest:digest(metrics.line)})}});
  verify();
  return fixCompletionProjection({specsRoot,identity,configuration,status:{...status,stage:'closeout_required',completionEligible:false}});
}
