// N6 execution over already-authorized host capabilities. No model dispatch,
// browser installation, task writes, auto-fix or second completion authority.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {loadConfig,resolveRole} from '../../../scripts/cm-workflow-config.mjs';
import {validateTestCases} from '../../../scripts/validate-test-cases.mjs';
import {inspectCmAiAdmission} from './cm-ai-admission.mjs';
import {createHostCheck} from './host-check.mjs';
import {specsPermissionArgs} from './codex-config.mjs';
import {resolveCodeProjects,codeProjectPaths} from './code-projects.mjs';
import {findCmAiQaDecision,readCmAiQaRunRound,reportFile} from './cm-ai-qa-log.mjs';
import {captureReviewBaseline} from './review-package.mjs';
import {writeCmAiQaStatus} from './cm-ai-run-finalizer.mjs';
import {digest,freeze,hex,id,json,need,shape,text,validCallTimeout,validIdentity} from './effect-contract.mjs';

const writer=fileURLToPath(new URL('../../../scripts/cm-log-event.py',import.meta.url));
const order={ 'cm-default':['logic','commands','browser'],
  'java-backend':['commands','logic','browser'],'web-frontend':['commands','browser','logic'] };

function readPlan(configuration) {
  const {codeProject,specsDir,feature,commands}=configuration;
  const admission=inspectCmAiAdmission({specsDir,codeProject});
  need(['ready','complete'].includes(admission.state),admission.reason??'qa_admission_required');
  const featureRoot=path.join(specsDir,feature);
  need(fs.realpathSync(featureRoot)===featureRoot&&fs.lstatSync(featureRoot).isDirectory(),'qa_feature_invalid');
  const config=loadConfig({projectRoot:codeProject});
  const source=path.join(specsDir,feature,'test-cases.json');let cases=[];
  // Admission validates approved references and containment; read only that
  // feature's original test contract, not executable instructions from cases.
  if(fs.existsSync(source)){
    const bytes=fs.readFileSync(source);need(bytes.length<=1024*1024,'limit_exceeded');
    const contract=json(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));
    need(validateTestCases(contract).length===0&&contract.feature===feature.replace(/^\d+\./,''),'test_cases_invalid');
    cases=contract.cases;
  }
  const selected=cases.filter(item=>item.blocking||config.policies.tests.includes(item.kind));
  const wanted=new Set(selected.filter(item=>item.kind==='logic').map(item=>item.id));
  const scheduled=commands.filter(item=>config.policies.tests.includes('commands')
    ||item.caseIds.some(caseId=>wanted.has(caseId)));
  for(const item of commands)for(const caseId of item.caseIds)
    need(cases.some(candidate=>candidate.id===caseId&&candidate.kind==='logic'),'qa_command_mapping_invalid');
  const modes=order[config.project.workflow].filter(mode=>mode==='commands'
    ?scheduled.length>0||config.policies.tests.includes('commands'):selected.some(item=>item.kind===mode));
  return json({config,cases:selected,commands:scheduled,modes});
}

function logStep(configuration,binding,event,phase,data,detail) {
  const payload={node:'N6',feature:configuration.feature,task:binding.identity.taskId,
    attempt:binding.identity.attempt,repository_id:binding.identity.repositoryId,
    package_digest:binding.packageDigest,operation_id:binding.testRunId,...data};
  if(event==='test_run'){
    const decision=findCmAiQaDecision({specsDir:configuration.specsDir,feature:configuration.feature,
      identity:binding.identity,packageDigest:binding.packageDigest});
    need(decision?.status==='triggered','qa_not_triggered');
    payload.qa_decision_id=decision.decisionId;payload.attempt=binding.qaRound;
  }
  const result=spawnSync('python3',[writer,'--workflow','cm-ai','--event',event,'--phase',phase,
    '--runtime',configuration.runtime,'--project-root',configuration.codeProject,'--specs-dir',configuration.specsDir,
    '--run-id',binding.identity.runId,'--detail',detail,'--data-json',JSON.stringify(payload)],
  {env:{...process.env,CM_WORKFLOW_LOG_HOME:configuration.logHome},timeout:10000,maxBuffer:1024*1024});
  need(!result.error&&result.status===0&&result.signal===null,'qa_log_failed');
  const logged=JSON.parse(result.stdout.toString('utf8'));
  need(logged.run_id===binding.identity.runId&&logged.project_log===path.join(configuration.specsDir,'运行日志.jsonl'),'qa_log_failed');
  if(event==='test_run'&&phase.startsWith('case_'))writeCmAiQaStatus({specsDir:configuration.specsDir,
    feature:configuration.feature,identity:binding.identity,caseId:data.case_id,phase});
}

function evidence(raw) {
  const result=json(raw);need(Array.isArray(result)&&result.length>0&&result.length<=32,'qa_evidence_required');
  for(const item of result){text(item);need(item.length<=2000&&!item.includes('\0'),'qa_evidence_required');}
  return result;
}

function saveReport(configuration,binding,rows,summary) {
  const reviews=path.join(configuration.specsDir,'.reviews'),stat=fs.lstatSync(reviews);
  need(stat.isDirectory()&&!stat.isSymbolicLink()&&fs.realpathSync(reviews)===reviews,'qa_report_invalid');
  const target=path.join(reviews,`${binding.testRunId}-execution.md`);
  const body=Buffer.from(`# CM QA execution report\n\nOverall: ${summary.result}\n\n`
    +'Counts are declared command checks plus selected cases, not framework test totals.\n'
    +'Static verdicts are retained separately; only observed command/browser evidence counts as PASS.\n\n'
    +rows.map(row=>`## ${row.id}\n\n${JSON.stringify(row,null,2)}\n`).join('\n'));
  need(body.length<=1024*1024,'limit_exceeded');
  const fd=fs.openSync(target,fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_WRONLY|fs.constants.O_NOFOLLOW,0o600);
  try{fs.writeFileSync(fd,body);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  return target;
}

export function createHostQaExecutor(options) {
  const keys=['specsDir','codeProject','feature','runtime','requirements','commands','environment','timeoutMs','logHome'];
  shape(options,[...keys,...['logic','browser','specsRoot','codeProjects','bootstrap'].filter(key=>Object.hasOwn(options,key))]);
  const {logic=null,browser=null,...raw}=options,configuration=json(raw);
  for(const capability of [logic,browser])need(capability===null||typeof capability==='function');
  for(const name of ['specsDir','codeProject','logHome'])need(path.isAbsolute(configuration[name]),'unsupported_path');
  for(const name of ['specsDir','codeProject'])need(fs.realpathSync(configuration[name])===configuration[name],'unsupported_path');
  const roots=configuration.codeProjects?resolveCodeProjects(configuration.codeProject,configuration.codeProjects):null;
  if(configuration.bootstrap){
    shape(configuration.bootstrap,['requirements','scope']);need(configuration.feature==='0.bootstrap','bootstrap_task_required');
  }
  if(Object.hasOwn(configuration,'specsRoot')){
    need(configuration.specsRoot===configuration.specsDir,'execution_specs_mismatch');
    specsPermissionArgs({cwd:configuration.codeProject,specsRoot:configuration.specsRoot});
  }
  need(/^\d+\.[A-Za-z0-9._-]+$/.test(configuration.feature),'feature_invalid');
  need(['codex','claude'].includes(configuration.runtime));validCallTimeout(configuration.timeoutMs);
  const ids=new Set();need(Array.isArray(configuration.commands)&&configuration.commands.length<=32);
  for(const item of configuration.commands){
    shape(item,['id','command','caseIds',...(roots?['codeProject']:[])]);id(item.id);need(!ids.has(item.id));ids.add(item.id);
    if(roots)need(roots.includes(item.codeProject),'execution_root_mismatch');
    need(Array.isArray(item.caseIds)&&new Set(item.caseIds).size===item.caseIds.length);
    for(const caseId of item.caseIds)id(caseId);
    // Reuse the actual host checker validator, without running a command.
    createHostCheck({cwd:roots?item.codeProject:configuration.codeProject,commands:[{id:item.id,command:item.command}],timeoutMs:configuration.timeoutMs});
  }
  shape(configuration.environment,['kind','carrier','target','scope']);
  const environment=configuration.environment;
  need(['local','test'].includes(environment.scope),'qa_environment_required');text(environment.target);
  const carriers={web:['browser'],app:['ios-simulator','android-emulator','device'],miniprogram:['wechat-devtools','device']};
  need(carriers[environment.kind]?.includes(environment.carrier),'qa_environment_required');
  const plan=readPlan(configuration);
  need(!plan.cases.some(item=>ids.has(item.id)),'qa_id_conflict');
  // One missing-command item keeps an empty invocation from passing as zero tests.
  const commandCount=plan.modes.includes('commands')?Math.max(1,plan.commands.length):0;
  const caseCount=Math.max(1,commandCount+plan.cases.length);
  const mode=plan.modes.length===1&&['commands','browser'].includes(plan.modes[0])?plan.modes[0]:'all';
  const metadata=json({kind:'cm-host-qa-executor-v1',...configuration,plan,
    capabilities:{logic:logic!==null,browser:browser!==null}});
  return Object.freeze({mode,caseCount,timeoutMs:configuration.timeoutMs,configuration:metadata,
    async run(rawBinding,signal){
      let binding=json(rawBinding);
      shape(binding,['specsDir','codeProject','feature','identity','packageDigest','testRunId','mode','caseCount',
        ...(Object.hasOwn(binding,'qaRound')?['qaRound']:[])]);
      validIdentity(binding.identity);hex(binding.packageDigest);id(binding.testRunId);
      const qaRound=readCmAiQaRunRound({specsDir:binding.specsDir,feature:binding.feature,
        identity:binding.identity,packageDigest:binding.packageDigest,testRunId:binding.testRunId});
      need(!Object.hasOwn(binding,'qaRound')||binding.qaRound===qaRound,'qa_round_invalid');
      binding=json({...binding,qaRound});
      need(['specsDir','codeProject','feature'].every(key=>binding[key]===configuration[key])
        &&binding.mode===mode&&binding.caseCount===caseCount,'qa_execution_mismatch');
      const unchanged=()=>need(digest(readPlan(configuration))===digest(plan),'qa_plan_changed');
      const notCancelled=()=>need(!signal.aborted,'cancelled');notCancelled();unchanged();
      const snapshot=()=>captureReviewBaseline({root:configuration.codeProject,specsRoot:configuration.specsDir,
        identity:binding.identity,scope:configuration.bootstrap?.scope??configuration.requirements,requirements:configuration.requirements,
        ...(configuration.bootstrap?{bootstrapRequirements:configuration.bootstrap.requirements}:{}),
        ...(roots?{codeProjectPaths:codeProjectPaths(configuration.codeProject,resolveCodeProjects(configuration.codeProject,roots))}:{})});
      const before=snapshot(),rows=[],commandResults=new Map();
      const route=role=>{
        notCancelled();unchanged();
        const result=resolveRole(loadConfig({projectRoot:configuration.codeProject}),role,configuration.runtime);
        logStep(configuration,binding,'decision','route',{role,adapter:result.adapter,requested_model:result.model,
          source:result.source,purpose:'qa',route_state:result.route_state},`QA role: ${role}`);
        if(result.route_state==='declared-adapter')logStep(configuration,binding,'degrade','route',
          {role,route_state:result.route_state,outcome:'local_qa_only'},'Requested QA adapter unobserved; local evidence only');
        return result;
      };
      for(const stage of plan.modes){
        const routed=route(stage==='browser'?'browser_qa':'tester');
        if(stage==='commands'){
          if(!plan.commands.length)rows.push({id:'commands-unavailable',kind:'commands',verdict:'BLOCKED',evidence:['No declared project test command']});
          for(const command of plan.commands){
            notCancelled();
            const check=createHostCheck({cwd:roots?command.codeProject:configuration.codeProject,commands:[{id:command.id,command:command.command}],
              timeoutMs:configuration.timeoutMs,specsRoot:configuration.specsRoot??null});
            const resource={resource_id:`qa-command-${digest({testRunId:binding.testRunId,command:command.id}).slice(0,48)}`,
              resource_kind:'qa_command'};
            logStep(configuration,binding,'resource','acquired',{...resource,cleanup_required:true},'QA command resource acquired');
            let observed;
            try{
              [observed]=await check({identity:binding.identity},{signal});
              logStep(configuration,binding,'resource',observed.evidence==='host check: cleanup_failed'?'cleanup_failed':'released',
                resource,'QA command resource finished');
            }catch(error){
              logStep(configuration,binding,'resource','cleanup_failed',resource,'QA command cleanup not confirmed');throw error;
            }
            notCancelled();
            commandResults.set(command.id,observed);
            rows.push({id:command.id,kind:'commands',verdict:observed.outcome==='passed'?'PASS':observed.outcome==='failed'?'FAIL':'BLOCKED',
              exitCode:observed.exitCode,evidence:[...(roots?[`cwd=${command.codeProject}`]:[]),observed.evidence]});
          }
        }else for(const item of plan.cases.filter(candidate=>candidate.kind===stage)){
          notCancelled();
          const request=freeze({...binding,case:item,route:routed,environment,...(roots?{codeProjects:roots}:{})});
          if(stage==='logic'){
            const observed=logic===null?{verdict:'INSUFFICIENT_EVIDENCE',evidence:['Logic host unavailable']}:json(await logic(request,signal));
            notCancelled();shape(observed,['verdict','evidence']);
            need(['SUPPORTED','CONTRADICTED','INSUFFICIENT_EVIDENCE'].includes(observed.verdict),'qa_verdict_invalid');
            rows.push({id:item.id,kind:'logic',origin:item.origin,blocking:item.blocking,
              staticVerdict:observed.verdict,verdict:'BLOCKED',evidence:evidence(observed.evidence)});
          }else{
            logStep(configuration,binding,'test_run','case_start',{case_id:item.id},'QA browser case started');
            let observed;
            if(browser===null||item.expected.some(value=>value.includes('[需确认]')))
              observed={verdict:'BLOCKED',evidence:[],environment,cleanup:'not_needed'};
            else observed=json(await browser(request,signal));
            notCancelled();shape(observed,['verdict','evidence','environment','cleanup']);
            need(['PASS','FAIL','BLOCKED'].includes(observed.verdict),'qa_verdict_invalid');
            need(['completed','not_needed','failed'].includes(observed.cleanup),'qa_cleanup_required');
            let evidenceProblem=null;
            if(observed.verdict!=='BLOCKED')try{
              for(const file of evidence(observed.evidence)){
                const target=reportFile(configuration.specsDir,file);
                need(fs.statSync(target).size>0,'qa_evidence_required');
              }
            }catch{evidenceProblem='qa_evidence_required';}
            const verdict=evidenceProblem!==null||digest(observed.environment)!==digest(environment)||observed.cleanup==='failed'
              ||(item.cleanup.length>0&&observed.cleanup!=='completed')?'BLOCKED':observed.verdict;
            rows.push({id:item.id,kind:'browser',origin:item.origin,blocking:item.blocking,verdict,
              evidence:observed.evidence,evidenceProblem,environment:observed.environment,cleanup:observed.cleanup});
            logStep(configuration,binding,'test_run',verdict==='BLOCKED'?'case_blocked':'case_complete',
              {case_id:item.id,result:verdict},'QA browser case finished');
          }
        }
      }
      notCancelled();unchanged();
      // A single declared command can supply runtime evidence for several logic
      // cases. The host declares that mapping; no additional tests are invented.
      for(const row of rows.filter(item=>item.kind==='logic')){
        const mappings=plan.commands.filter(item=>item.caseIds.includes(row.id));
        const observed=mappings.map(item=>commandResults.get(item.id));
        row.verdict=row.staticVerdict==='CONTRADICTED'?'FAIL':
          observed.some(item=>item?.outcome==='failed')?'FAIL':
          observed.length>0&&observed.every(item=>item?.outcome==='passed')?'PASS':'BLOCKED';
        row.commandEvidence=mappings.map(item=>item.id);
        const item=plan.cases.find(item=>item.id===row.id);
        if(item.expected.some(value=>value.includes('[需确认]')))row.verdict='BLOCKED';
      }
      if(rows.length===0)rows.push({id:'qa-unavailable',kind:'commands',verdict:'BLOCKED',evidence:['No executable QA contract']});
      const drift=digest(before.files)!==digest(snapshot().files);
      if(drift)for(const row of rows){row.verdict='BLOCKED';row.sourceChanged=true;}
      const passed=rows.filter(item=>item.verdict==='PASS').length,failed=rows.filter(item=>item.verdict==='FAIL').length,
        blocked=rows.filter(item=>item.verdict==='BLOCKED').length;
      need(passed+failed+blocked===caseCount,'qa_result_invalid');
      const summary={result:failed>0?'FAIL':blocked>0?'BLOCKED':'PASS',passed,failed,blocked};
      const report=saveReport(configuration,binding,rows,summary);
      return json({...summary,report});
    }});
}
