#!/usr/bin/env node
// cm-test 单步驾驶员。表由 cm-test-host.mjs -> cm-test/host.mjs 的 handle/run/invoke
// 及 host-session.mjs operationNames 推出；只列此宿主接受的 operation。
// operation  possible host_request kinds                 proof
// start      change_impact (impact,有变更), test_cases    host.mjs run: impact/generation;
//            (缺合同或 generate), qa_logic (logic cases), host.mjs run: logic/browser.
//            qa_browser (browser cases/explore)
// resume     同 start 的剩余种类，或无新反问             host.mjs handle resume -> run;
//            已记录 effect 直接回放                      session.mjs effect.
// status,    none                                        host.mjs handle status/cancel.
// cancel
// host.mjs 自己运行 config.commands 并记录真实退出码；没有 host_request 命令证据。
// qa_browser 由显式 liveEvidence 当前会话执行；未配置时发送前拒绝。
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {inspectCmTestAdmission} from './cm-test-entry.mjs';
import {createCmTestHost} from '../runtime/js/cm-test/host.mjs';
import {validateTestCases} from './validate-test-cases.mjs';
import {inspectCmTestLogicResults} from '../runtime/js/cm-test/logic-results.mjs';
import {collectBranchImpact,inspectImpactAnalysis} from '../runtime/js/cm-test/branch-impact.mjs';
import {readSourceFiles,snapshotSource,selectReportDirectory,checkSourceEvidence} from '../runtime/js/cm-test/source-snapshot.mjs';
import {createHostCheck} from '../runtime/js/cm-ai/host-check.mjs';
import {inspectDeclaredTestCommand} from '../runtime/js/cm-test/declared-command.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
import {stderr,stop,readJson,loadPlanFile,requireFields,preflightAnswers,driveHost} from '../runtime/js/cm-ai/drive-core.mjs';

import {driverLiveEvidence} from '../runtime/js/cm-ai/live-evidence.mjs';

// PLAN.liveEvidence: fresh current-session evidence; see docs/live-evidence-drivers.md.
const HOST=fileURLToPath(new URL('./cm-test-host.mjs',import.meta.url));
const KNOWN=new Set(['start','resume','status','cancel']);
const FILES={change_impact:'change-impact.json',test_cases:'test-cases.json',qa_logic:'qa-logic.json'};
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const valid=(condition,label)=>{if(!condition)stop(2,`答案格式错误：${label}`);};
const safeFile=file=>fs.existsSync(file)&&fs.lstatSync(file).isFile()&&!fs.lstatSync(file).isSymbolicLink();

function main(){
  if(process.argv.length===3&&['--help','-h'].includes(process.argv[2])){
    process.stdout.write('用法: cm-test-drive.mjs --plan PLAN.json <start|resume|status|cancel>\nPLAN: config, answers, sessionDir (resume), resolution:null 或 {key,requestDigest,discard:true,evidence,cleanup?}（作废后重问，qa_* 需 cleanup:"completed"）。浏览器执行用 PLAN.liveEvidence {directory,kinds:["qa_browser"],timeoutMs?}；未配置时预检拒绝。\n');return;
  }
  const {operation,plan,base}=loadPlanFile({name:'cm-test-drive.mjs',known:KNOWN});
  requireFields(plan,['config']);
  const configPath=path.resolve(base,plan.config),config=readJson(configPath,'宿主配置');
  if(config===undefined)stop(2,`宿主配置不存在: ${configPath}`);
  valid(safeFile(configPath)&&fs.statSync(configPath).size<=64*1024,'宿主配置文件');
  const root=fileURLToPath(new URL('..',import.meta.url));
  valid(config.skillDir===path.join(root,'skills/cm-test'),'config.skillDir 必须指向当前 checkout');
  let admission;
  try{admission=inspectCmTestAdmission({...config.arguments,skillDir:config.skillDir,project:config.project});}
  catch(error){stop(2,`宿主配置准入失败: ${error.code??error.message}`);}
  valid(admission.status==='ready','宿主配置准入');
  try{createCmTestHost(config,{call:()=>{throw Error('preflight must not call host')}});}
  catch(error){stop(2,`宿主配置无效: ${error.code??error.message}`);}
  valid(['codex','claude'].includes(config.runtime)&&Array.isArray(config.sources)&&Array.isArray(config.commands)
    &&config.commands.length<=32&&path.isAbsolute(config.logHome),'config.runtime/sources/commands/logHome');
  if(admission.operation==='impact')valid(config.commands.length===0&&config.environment===null,'impact 只读配置');
  if(operation==='resume'){
    requireFields(plan,['sessionDir','resolution']);
    const resolution=plan.resolution;
    // discard: V1/V4 作废最后一个应答（已记录被拒或结果未知）后重问；qa_* 需 cleanup:"completed"（资源已释放）。
    valid(resolution===null||object(resolution)&&resolution.discard===true&&typeof resolution.key==='string'
      &&typeof resolution.requestDigest==='string'&&typeof resolution.evidence==='string'&&resolution.evidence.trim()
      &&Object.keys(resolution).every(key=>['key','requestDigest','discard','evidence','cleanup'].includes(key)),
    'resume 只接受 resolution:null 或 {key,requestDigest,discard:true,evidence,cleanup?}；原动作回执不能由静态答案伪造');
    const session=path.resolve(base,plan.sessionDir);
    if(!safeFile(path.join(session,'execution.jsonl')))stop(2,`恢复记录不存在: ${path.join(session,'execution.jsonl')}`);
    const rows=fs.readFileSync(path.join(session,'execution.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
    const context=rows.find(row=>row.type==='context')?.value;
    valid(context?.workflow==='cm-test'&&context.configDigest===digest(config),'resume 配置绑定不匹配');
    const pending=new Map(),inputs=new Map();let last=null;
    for(const row of rows){if(row.type==='intent'){pending.set(row.key,row.kind);inputs.set(row.key,row.input);last=row.key;}
      if(row.type==='result')pending.delete(row.key);if(row.type==='discard'){pending.delete(row.key);inputs.delete(row.key);last=null;}}
    if(resolution!==null){
      const input=inputs.get(resolution.key),kind=input?.kind,release=['qa_logic','qa_browser'].includes(kind);
      if(resolution.key!==last||!['change_impact','test_cases','qa_logic','qa_browser'].includes(kind)||digest(input)!==resolution.requestDigest)
        stop(2,'discard 只能作废最后一个 change_impact/test_cases/qa_logic/qa_browser 应答，key/requestDigest 取自宿主 status');
      if(release&&resolution.cleanup!=='completed')
        stop(2,`${kind} 会操作浏览器或设备：先确认会话已清理或资源已释放（设备可能仍在使用），再带 cleanup:"completed"`);
      pending.delete(resolution.key);
    }
    for(const [key,kind] of pending)if(['host','command'].includes(kind))stop(2,`缺少原执行回执 runner: ${kind} ${key}；不能从静态文件恢复。change_impact/test_cases 可用 resolution {key,requestDigest,discard:true,evidence} 作废后重问；qa_* 另需 cleanup:"completed"`);
  }else if(operation==='start'&&plan.sessionDir){
    const session=path.resolve(base,plan.sessionDir);
    valid(!fs.existsSync(path.join(session,'execution.jsonl')),'start 的 sessionDir 已有记录，请用 resume');
  }
  const existingSession=plan.sessionDir&&safeFile(path.join(path.resolve(base,plan.sessionDir),'execution.jsonl'));
  const answerRoot=plan.answers?path.resolve(base,plan.answers):null;
  const asks=[];let contract=null,impact=null,sources=[];
  if(['start','resume'].includes(operation)){
    if(admission.operation==='impact'){
      try{impact=collectBranchImpact(admission.project,admission.comparison,config.sources,config.mapPaths??[]);}
      catch(error){stop(2,`impact 定义无效: ${error.code??error.message}`);}
      if(impact.changes.length)asks.push('change_impact');
    }else{
      const runId='test-drive-preflight';
      let snapshot;try{snapshot=snapshotSource(admission.project,selectReportDirectory(admission,runId));
        sources=readSourceFiles(admission.project,config.sources,snapshot);}catch(error){stop(2,`sources 定义无效: ${error.code??error.message}`);}
      const caseFile=admission.cases??(admission.specs&&admission.feature?path.join(admission.specs,admission.feature,'test-cases.json'):null);
      if(caseFile&&safeFile(caseFile)){
        if(path.extname(caseFile)==='.json'){
          contract=readJson(caseFile,'用例合同');const failures=validateTestCases(contract);
          valid(failures.length===0,`用例合同 ${caseFile}: ${failures.join('; ')}`);
        }
      }
      if(admission.operation==='generate_cases'||contract===null)asks.push('test_cases');
      for(const item of config.commands){
        try{inspectDeclaredTestCommand(item,sources);createHostCheck({cwd:admission.project,commands:[{id:item.id,command:item.command}]});}
        catch(error){stop(2,`声明命令无效 ${item?.id??'?'}: ${error.code??error.message}`);}
      }
    }
  }
  const loadAnswer=kind=>{
    const file=path.join(answerRoot??'',FILES[kind]);
    if(!answerRoot||!safeFile(file))stop(2,`步骤 ${operation} 会反问 ${kind}，但答案文件不存在: ${file}`);
    const value=readJson(file,kind);valid(value!==undefined,`${kind}: ${file}`);
    try{
      if(kind==='change_impact')inspectImpactAnalysis(impact,value);
      if(kind==='test_cases'){
        valid(object(value)&&Object.keys(value).sort().join(',')==='contract,report'&&typeof value.report==='string'&&value.report.trim(),'test_cases.report');
        const errors=validateTestCases(value.contract);valid(errors.length===0,`test_cases.contract: ${errors.join('; ')}`);
        contract=value.contract;
        if(admission.operation!=='generate_cases'&&!admission.cases)
          contract={...contract,cases:contract.cases.map(item=>({...item,origin:'inferred',
            expected:item.expected.map(text=>text.startsWith('[需确认]')?text:`[需确认] 当前行为刻画: ${text}`)}))};
      }
      if(kind==='qa_logic'){
        const selected=admission.cases?{...contract,cases:contract.cases.map(item=>({...item,origin:'user'}))}:contract;
        inspectCmTestLogicResults(selected,{...value,contractDigest:digest(selected)});
        valid(value.contractDigest===digest(selected),'qa_logic.contractDigest');
        checkSourceEvidence(value.results,sources);
      }
    }catch(error){stop(2,`答案格式错误：${kind}: ${error.code??error.message}`);}
    return value;
  };
  const answers=preflightAnswers(asks,loadAnswer);
  let live;
  try{live=driverLiveEvidence(plan,{base,protectedRoots:[admission.project,admission.specs],allowedKinds:['qa_browser']});}
  catch(error){stop(2,error.message);}
  if(['start','resume'].includes(operation)&&admission.operation!=='impact'){
    if(admission.modes.includes('browser')&&(admission.operation==='explore'||contract?.cases?.some(item=>item.kind==='browser')))
      if(!live.has('qa_browser'))stop(2,'缺少真实执行 runner: qa_browser；不能从静态答案文件应答');
    if(admission.modes.includes('logic')&&contract?.cases?.some(item=>item.kind==='logic'))
      answers.qa_logic=loadAnswer('qa_logic');
  }
  stderr(`预检通过：${operation}`);
  driveHost({host:HOST,args:['serve','--config',configPath,...(plan.sessionDir
    &&(['start','resume'].includes(operation)||operation==='status'&&existingSession)
    ?['--session-dir',path.resolve(base,plan.sessionDir)]:[])],
    cwd:admission.project,operation,request:operation==='resume'?{resolution:plan.resolution}:{},answers,paths:{},
    answerFor:(row,answers,paths,control)=>live.has(row.kind)?live.answer(row,control):answers[row.kind]??null});
}
main();
