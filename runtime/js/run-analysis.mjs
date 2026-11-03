// Read-only analysis of one stable authoritative specs log; never execution authority.
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {readStableLogRows} from './cm-ai/log-rows.mjs';

const MAX_BYTES=32*1024*1024,MAX_ROWS=100000;
const label=value=>typeof value==='string'&&value.length>0&&value.length<=128
  &&!/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value);
const key=parts=>JSON.stringify(parts);
const fail=()=>{throw Object.assign(new Error('run_analysis_log_invalid'),{code:'run_analysis_log_invalid'});};
const timestamp=value=>typeof value==='string'&&/T.*(?:Z|[+-]\d\d:\d\d)$/.test(value)&&Number.isFinite(Date.parse(value))?Date.parse(value):null;
const usageScript=fileURLToPath(new URL('../../scripts/cm-usage-report.py',import.meta.url));
const usageBridge=`import json,runpy,sys
from pathlib import Path
from datetime import datetime,timezone
m=runpy.run_path(sys.argv[1],run_name='cm_usage_report')
data=json.load(sys.stdin)
refs=[m['RunRef'](r,'unknown','unknown','unknown',datetime.now(timezone.utc),'','snapshot.jsonl') for r in data]
report=m['build_report'](Path('.').resolve(),refs,data)
report['source']='specs-local-stable-snapshot'
report['summary']['invalid_claims']=sum(1 for rows in data.values() for _,row in rows if row.get('event')=='model_call' and m['claim_row_error'](row) is not None)
print(json.dumps(report,separators=(',',':')))
`;
function usageReport(rows){
  const grouped=Object.create(null);
  const fields=['run_id','event_id','event','phase','call_id','workflow','runtime','stage','role','adapter','requested_model',
    'effective_model','source','purpose','outcome','usage_state','input_tokens','output_tokens','cache_read_tokens','cache_write_tokens','reasoning_tokens','duration_ms'];
  rows.forEach((row,index)=>{
    if(!grouped[row.run_id])grouped[row.run_id]=[];
    if(!['model_call','model_usage'].includes(row.event))return;
    const minimal={};
    for(const field of fields)if(Object.hasOwn(row,field)){
      const value=row[field];
      // Invalid identities must remain invalid, rather than becoming a valid alias.
      minimal[field]=typeof value==='string'&&!label(value)||typeof value==='number'&&!Number.isSafeInteger(value)?null:value;
    }
    grouped[row.run_id].push([index+1,minimal]);
  });
  const result=spawnSync('python3',['-I','-c',usageBridge,usageScript],{input:JSON.stringify(grouped),encoding:'utf8',
    timeout:20000,maxBuffer:MAX_BYTES,windowsHide:true});
  if(result.error||result.status!==0)return {status:'unavailable',reason:'usage_reader_unavailable'};
  try{
    const report=JSON.parse(result.stdout),summary=report.summary;
    const complete=summary.observed_calls>0&&!summary.unavailable_calls&&!summary.unresolved_claims&&!summary.invalid_calls&&!summary.invalid_claims;
    return {status:complete?'observed':summary.observed_calls?'partial':'unavailable',...report};
  }catch{return {status:'unavailable',reason:'usage_reader_unavailable'};}
}
function unionDuration(intervals){
  let total=0,end=null;
  for(const [start,stop] of intervals.sort((a,b)=>a[0]-b[0])){
    total+=Math.max(0,stop-Math.max(start,end??start));end=Math.max(end??stop,stop);
  }
  return total;
}
function timingReport(rows){
  const groups=new Map();let unrecognized=0;
  rows.forEach((row,index)=>{
    if(row.event!=='progress'||!['start','complete'].includes(row.phase))return;
    const prd=row.workflow==='cm-prd'&&Number.isSafeInteger(row.segment)&&row.segment>=1;
    // AI host operations have unique ids and no segment; never infer PRD segment 1.
    const ai=row.workflow==='cm-ai'&&!Object.hasOwn(row,'segment')
      &&['developing','checking','verifying','review_starting','reviewing'].includes(row.phase_name)
      &&label(row.feature)&&label(row.task)&&Number.isSafeInteger(row.attempt)&&row.attempt>=1;
    if(!label(row.operation_id)||!label(row.phase_name)||!prd&&!ai){unrecognized++;return;}
    const protocol=ai?'cm-ai-host-operation':'cm-prd-segment';
    const id=key([row.run_id,row.workflow,row.operation_id,row.phase_name,protocol,
      ...(ai?[row.feature,row.task,row.attempt]:[row.segment])]);
    if(!groups.has(id))groups.set(id,{runId:row.run_id,workflow:row.workflow,stage:row.phase_name,protocol,start:[],complete:[]});
    groups.get(id)[row.phase].push({row,index});
  });
  const stages=new Map(),intervalsByRun=new Map();let incomplete=0,pauses=0,paired=0,combined=0;
  for(const group of groups.values()){
    const {start,complete}=group;
    if(start.length!==1||complete.length!==1){incomplete++;continue;}
    const first=start[0],last=complete[0],a=timestamp(first.row.at),b=timestamp(last.row.at);
    const allowed=group.protocol==='cm-ai-host-operation'?['returned','failed','aborted']:['completed','awaiting_input','blocked'];
    if(a===null||b===null||b<a||first.index>=last.index||!allowed.includes(last.row.outcome)){
      incomplete++;continue;
    }
    paired++;if(last.row.outcome==='awaiting_input')pauses++;
    const isCombined=first.row.timing_scope==='combined_host_call'||last.row.timing_scope==='combined_host_call';
    if(isCombined)combined++;
    const id=key([group.runId,group.workflow,group.stage]);
    if(!stages.has(id))stages.set(id,{runId:group.runId,workflow:group.workflow,stage:group.stage,durationMs:0,pairedSegments:0,combinedSegments:0,outcomes:{}});
    const stage=stages.get(id);stage.durationMs+=b-a;stage.pairedSegments++;stage.combinedSegments+=Number(isCombined);
    stage.outcomes[last.row.outcome]=(stage.outcomes[last.row.outcome]??0)+1;
    if(!intervalsByRun.has(group.runId))intervalsByRun.set(group.runId,[]);
    intervalsByRun.get(group.runId).push([a,b]);
  }
  return {status:paired?(incomplete||unrecognized?'partial':'observed'):'unavailable',
    pairedSegments:paired,incompleteSegments:incomplete,unrecognizedEvents:unrecognized,closedForInput:pauses,combinedSegments:combined,
    activeIntervalUnionMs:paired?[...intervalsByRun.values()].reduce((n,v)=>n+unionDuration(v),0):null,
    waitingMs:null,waitingStatus:'unavailable',stages:[...stages.values()],
    scope:'Only matched progress segments; overlapping stages are not additive; gaps and unpaired time are unknown.'};
}
function repetitionReport(rows){
  const groups=new Map();let unrecognized=0;
  for(const row of rows){
    // These are recorded starts/claims, not proof that a command ran or that work was redundant.
    let kind,identity,execution;
    if(row.event==='model_call'&&row.phase==='claimed'){
      kind='model_call_claim';identity=[row.workflow,row.stage,row.role,row.adapter,row.requested_model,row.source,row.purpose];execution=row.call_id;
    }else if(row.event==='test_run'&&row.phase==='start'){
      kind='qa_invocation_start';identity=[row.workflow,row.feature,row.task];execution=row.operation_id;
    }else continue;
    if(!identity.every(label)||!label(execution)){unrecognized++;continue;}
    const id=key([row.run_id,kind,...identity]);
    if(!groups.has(id))groups.set(id,{runId:row.run_id,kind,identity,executions:new Set()});
    groups.get(id).executions.add(execution);
  }
  const repeated=[...groups.values()].filter(x=>x.executions.size>1).map(({executions,...group})=>({...group,count:executions.size,additionalOccurrences:executions.size-1}));
  return {status:groups.size?'observed':'unavailable',groups:repeated,unrecognizedEvents:unrecognized,
    commandReexecution:'unavailable',interpretation:'Repeated recorded starts/claims only; necessity, command equality and waste are not inferred.'};
}
export function analyzeRunRows(input,{runId=null}={}){
  if(!Array.isArray(input)||input.length>MAX_ROWS||runId!==null&&!label(runId))fail();
  const seen=new Map(),rows=[];let historicalRows=0,duplicates=0;
  for(const row of input){
    if(!row||typeof row!=='object'||Array.isArray(row))fail();
    if(!label(row.run_id)){historicalRows++;continue;}
    if(row.event_id!==undefined){
      if(!label(row.event_id))fail();
      const id=row.event_id,encoded=JSON.stringify(row);
      if(seen.has(id)){if(seen.get(id)!==encoded)fail();if(runId===null||row.run_id===runId)duplicates++;continue;}seen.set(id,encoded);
    }
    if(runId===null||row.run_id===runId)rows.push(row);
  }
  if(runId!==null&&!rows.length)throw Object.assign(new Error('run_analysis_run_not_found'),{code:'run_analysis_run_not_found'});
  const usage=usageReport(rows),timing=timingReport(rows),repetitions=repetitionReport(rows);
  return {schemaVersion:1,source:'specs-local-log',readOnly:true,runs:[...new Set(rows.map(x=>x.run_id))],
    rows:rows.length,ignoredHistoricalRows:historicalRows,deduplicatedEvents:duplicates,
    usage,timing,repetitions,
    authority:'Diagnostic observations only; no acceptance, completion, deployment or permission decision.'};
}
export function inspectRunAnalysis({specs,runId=null}){
  let count=0;
  const rows=readStableLogRows(path.join(specs,'运行日志.jsonl'),()=>{if(++count>MAX_ROWS)fail();return true;},'run_analysis_log_unavailable',{maxBytes:MAX_BYTES});
  return analyzeRunRows(rows,{runId});
}
export function runAnalysisLines(report){
  const lines=[`CM 运行分析：${report.runs.length} 个运行，${report.rows} 条记录（只读）`];
  const u=report.usage,s=u.summary;
  lines.push(`Token：${u.status}${s?`；已观测调用 ${s.observed_calls}，缺失 ${s.unavailable_calls}，未闭合 ${s.unresolved_claims}，无效 ${s.invalid_calls+s.invalid_claims}`:''}`);
  if(s?.observed_calls)lines.push(`已观测 Token 小计：input ${s.input_tokens}，output ${s.output_tokens}；不是缺失调用的估算。`);
  const t=report.timing;
  lines.push(`阶段耗时：${t.status}；完整配对 ${t.pairedSegments}，未配对/无效 ${t.incompleteSegments+t.unrecognizedEvents}`);
  if(t.activeIntervalUnionMs!==null)lines.push(`已观测活动区间并集：${t.activeIntervalUnionMs} ms；等待时长未知，重叠阶段不相加。`);
  for(const stage of t.stages)lines.push(`${stage.runId} / ${stage.stage}：${stage.durationMs} ms${stage.combinedSegments?'（含共享调用区间）':''}；结束事件 ${Object.entries(stage.outcomes).map(([outcome,count])=>`${outcome}=${count}`).join(', ')}`);
  lines.push(`重复启动/调用声明组：${report.repetitions.groups.length}；未判断必要性，测试命令重复执行次数未知。`);
  for(const group of report.repetitions.groups)lines.push(`${group.runId} / ${group.kind} / ${group.identity.join(' / ')}：${group.count} 次`);
  lines.push('分析不改变验收、检查、重试或完成门禁。');return lines;
}
