// Append-only projection of completed FIX log evidence into the original table.
// Caller must retain its existing serial owner; this is not a completion gate.
import fs from 'node:fs';
import path from 'node:path';
import {types} from 'node:util';
import {readReviewSourceFiles} from '../cm-ai/review-package.mjs';
import {id,need,validIdentity} from '../cm-ai/effect-contract.mjs';

const header='| 任务 | Feature | 开始 | 结束 | 审查轮次 | 独立审查拦截 | QA | 人工介入(次:原因) |';
const separator='| --- | --- | --- | --- | --- | --- | --- | --- |';
const cell=value=>String(value).replaceAll('|','&#124;').replace(/[\r\n]+/g,' ');
const same=(event,identity)=>event.workflow==='cm-fix'&&event.node==='FIX'&&event.run_id===identity.runId
  &&event.repository_id===identity.repositoryId&&event.task===identity.taskId;

export function fixMetricsRow({events,identity,dossierFile}){
  validIdentity(identity);need(/^\d{8}-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/.test(dossierFile),'invalid_fix_dossier');
  need(dossierFile.slice(9,-3)===identity.taskId.slice(6),'metrics_task_mismatch');
  const selected=events.filter(event=>same(event,identity));
  const starts=selected.filter(event=>event.event==='task_start'),ends=selected.filter(event=>event.event==='task_done');
  need(starts.length>0&&starts.length<=identity.attempt&&ends.length===1,'metrics_completion_required');
  const start=starts[0],end=ends[0];
  starts.forEach((item,index)=>need(item.attempt===index+1&&selected.indexOf(item)<selected.indexOf(end),'metrics_completion_required'));
  id(end.event_id);
  need(end.result==='completed'&&end.attempt===identity.attempt&&end.dossier_file===`fixes/${dossierFile}`,'metrics_completion_required');
  need(typeof start.at==='string'&&typeof end.at==='string'&&Number.isFinite(Date.parse(start.at))&&Number.isFinite(Date.parse(end.at))
    &&Date.parse(end.at)>=Date.parse(start.at)&&selected.indexOf(start)<selected.indexOf(end),'metrics_time_invalid');
  const reviews=selected.filter(event=>event.event==='review'&&event.review_kind==='implementation'&&event.phase==='complete');
  need(reviews.length===identity.attempt,'metrics_review_required');
  reviews.forEach((review,index)=>need(review.round===index+1&&review.attempt===review.round&&Number.isSafeInteger(review.finding_count)&&review.finding_count>=0
    &&selected.indexOf(review)>selected.indexOf(start)&&selected.indexOf(review)<selected.indexOf(end),'metrics_review_required'));
  const latest=reviews.at(-1);need(latest.result==='approved'&&/^[a-f0-9]{64}$/.test(end.package_digest)
    &&latest.package_digest===end.package_digest,'metrics_review_required');
  const interceptions=reviews.reduce((sum,review)=>sum+review.finding_count,0);
  // No complete host-intervention producer yet: absence of a pause is not zero.
  const row=[dossierFile,'fix',start.at,end.at,reviews.length,interceptions,end.walkthrough_result==='passed'?'PASS':'未知','未知:未记录完整人工介入'];
  return {line:`| ${row.map(cell).join(' | ')} |`,completionEventId:end.event_id};
}

export function appendFixMetrics({specsRoot,identity,dossierFile},{assertOwned}){
  need(typeof assertOwned==='function','metrics_owner_required');
  const owned=()=>{
    const result=assertOwned();
    if(types.isPromise(result))Promise.prototype.then.call(result,()=>{},()=>{});
    need(result===undefined,'metrics_owner_required');
  };
  owned();
  need(path.isAbsolute(specsRoot)&&fs.realpathSync(specsRoot)===specsRoot,'unsupported_path');
  const [log]=readReviewSourceFiles(specsRoot,['运行日志.jsonl']);
  const events=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.from(log.contentBase64,'base64')).trim().split('\n').map(line=>JSON.parse(line));
  const record=fixMetricsRow({events,identity,dossierFile});
  const [dossier]=readReviewSourceFiles(specsRoot,[`fixes/${dossierFile}`]);
  const completion=events.find(event=>event.event_id===record.completionEventId);
  need(completion.dossier_sha256===dossier.sha256,'metrics_dossier_changed');
  const target=path.join(specsRoot,'METRICS.md');let fd;
  try{
    fd=fs.openSync(target,fs.constants.O_RDWR|fs.constants.O_CREAT|fs.constants.O_APPEND|(fs.constants.O_NOFOLLOW??0),0o600);
    const stat=fs.fstatSync(fd);need(stat.isFile()&&stat.nlink===1&&stat.size<=1024*1024&&fs.realpathSync(target)===target,'metrics_file_invalid');
    const before=fs.readFileSync(fd),content=new TextDecoder('utf-8',{fatal:true}).decode(before);
    const matches=content.split(/\r?\n/).filter(line=>line.startsWith(`| ${dossierFile} | fix |`));
    if(matches.length){
      need(matches.length===1&&matches[0]===record.line,'metrics_row_conflict');
      const current=fs.lstatSync(target);need(!current.isSymbolicLink()&&current.dev===stat.dev&&current.ino===stat.ino&&current.size===stat.size,'metrics_file_changed');
      owned();return {...record,path:target,deduplicated:true};
    }
    if(before.length)need(content.split(/\r?\n/).includes(header),'metrics_table_invalid');
    const bytes=Buffer.from((before.length?(content.endsWith('\n')?'':'\n'):`${header}\n${separator}\n`)+record.line+'\n');
    need(before.length+bytes.length<=1024*1024,'limit_exceeded');owned();
    const current=fs.lstatSync(target);need(!current.isSymbolicLink()&&current.dev===stat.dev&&current.ino===stat.ino&&current.size===stat.size,'metrics_file_changed');
    // One append preserves existing bytes; a short/uncertain write is not success.
    need(fs.writeSync(fd,bytes)===bytes.length,'metrics_write_unknown');fs.fsyncSync(fd);
    const [written]=readReviewSourceFiles(specsRoot,['METRICS.md']),all=Buffer.from(written.contentBase64,'base64');
    need(all.subarray(0,before.length).equals(before)&&all.includes(bytes),'metrics_write_unknown');
    owned();return {...record,path:target,deduplicated:false};
  }finally{if(fd!==undefined)fs.closeSync(fd);}
}
