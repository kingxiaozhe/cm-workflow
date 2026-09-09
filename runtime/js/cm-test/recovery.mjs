// Read original authority; never replay commands, invent completion, or mutate
// an interrupted run. A recovered verdict is historical, not a fresh test.
import fs from 'node:fs';
import path from 'node:path';
import {inspectRunClosure} from '../../../scripts/cm-log-event.mjs';
import {need,digest,json} from '../cm-ai/effect-contract.mjs';
import {inside,canonicalFuture,selectReportDirectory} from './source-snapshot.mjs';

export function inspectCmTestRecovery(config,{runId,logFile}){
  need(typeof runId==='string'&&/^test-[a-f0-9-]{36}$/.test(runId),'cm_test_run_id_invalid');
  // History does not depend on current cases, feature inventory or installed
  // Skill version. Resolve only the original storage boundary, not execution.
  need(typeof config.project==='string'&&path.isAbsolute(config.project),'cm_test_project_path_invalid');
  const admission={project:canonicalFuture(config.project),
    specs:config.arguments.specs?canonicalFuture(config.arguments.specs):null,
    requestedReportDir:config.arguments.reportDir??null};
  if(admission.specs&&inside(admission.project,admission.specs))
    need(admission.specs===path.join(admission.project,'specs'),'cm_test_specs_path_invalid');
  need(path.isAbsolute(logFile)&&fs.realpathSync(logFile)===logFile,'cm_test_log_path_invalid');
  const logHome=canonicalFuture(config.logHome);
  need(!inside(admission.project,logHome)&&(!admission.specs||!inside(admission.specs,logHome)),
    'cm_test_log_path_invalid');
  const allowed=admission.specs?logFile===path.join(admission.specs,'运行日志.jsonl'):
    inside(path.join(logHome,'runs'),logFile)&&logFile.endsWith('.jsonl');
  need(allowed,'cm_test_log_path_invalid');
  const stat=fs.lstatSync(logFile);
  need(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1&&stat.size<=32*1024*1024,'cm_test_log_invalid');
  const lines=fs.readFileSync(logFile,'utf8').split('\n').filter(Boolean);
  const records=lines.map(line=>JSON.parse(line)).filter(event=>event.run_id===runId);
  const starts=records.filter(event=>event.event==='run_start');
  need(starts.length===1&&starts[0].workflow==='cm-test'&&starts[0].project_path===admission.project,
    'cm_test_run_binding_invalid');
  const base={runId,logFile,historical:true,currentSourceVerified:false,completionAuthorized:false,
    automaticReplayAllowed:false};
  if(!starts[0].config_digest)return json({...base,status:'legacy_unbound',overall:null,
    reason:'Older run has no configuration binding; inspect its original report manually. No replay.'});
  need(starts[0].config_digest===digest(config),'cm_test_config_changed');
  const terminal=records.filter(event=>event.event==='run_done');
  if(terminal.length===0){
    const stage=records.filter(event=>event.event==='decision'&&event.phase==='test_stage').at(-1)?.stage??'preparing';
    return json({...base,status:'interrupted',overall:null,lastStage:stage,
      runClosed:inspectRunClosure(logFile,runId).closed,
      reason:'No terminal record. Inspect pending work and cleanup before deciding whether a new run is safe.'});
  }
  need(terminal.length===1&&inspectRunClosure(logFile,runId).closed,'cm_test_run_not_closed');
  const end=terminal[0],completed=records.filter(event=>event.event==='test_run'&&event.phase==='complete');
  need(completed.length===1&&completed[0].result===end.result&&completed[0].report===end.report
    &&records.indexOf(completed[0])<records.indexOf(end),'cm_test_terminal_mismatch');
  const directory=selectReportDirectory(admission,runId);
  need(typeof end.report==='string'&&path.dirname(end.report)===directory
    &&fs.realpathSync(end.report)===end.report,'cm_test_report_path_invalid');
  const reportStat=fs.lstatSync(end.report);
  need(reportStat.isFile()&&!reportStat.isSymbolicLink()&&reportStat.nlink===1&&reportStat.size<=256*1024,
    'cm_test_report_invalid');
  need(typeof end.report_digest==='string'&&digest(fs.readFileSync(end.report,'utf8'))===end.report_digest,
    'cm_test_report_changed');
  return json({...base,status:'recovered',overall:end.result,report:end.report,runStage:end.run_stage??'reported'});
}
