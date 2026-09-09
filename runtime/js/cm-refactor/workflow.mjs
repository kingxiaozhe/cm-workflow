// Fixed cm-refactor flow; the host proposes text, the owner applies and judges it.
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {inspectCmRefactorAdmission} from '../../../scripts/cm-refactor-entry.mjs';
import {loadConfig,resolveRole} from '../../../scripts/cm-workflow-config.mjs';
import {checkN4,checkN5,implementationSha256,validateReview} from '../../../scripts/cm-task-gate.mjs';
import {createHostCheck} from '../cm-ai/host-check.mjs';
import {writeImmutableWorkflowFile} from '../cm-ai/review-evidence-file.mjs';
import {mergeLessons} from '../cm-ai/cm-ai-learning-writer.mjs';
import {readLearningRetrospectiveContent} from '../cm-ai/cm-ai-context-refresh.mjs';
import {need,shape,json,digest} from '../cm-ai/effect-contract.mjs';
import {inside,canonicalFuture,snapshotSource} from '../cm-test/source-snapshot.mjs';
import {openRefactorRecords,readText,replaceText,sha} from './records.mjs';
const nonempty=value=>typeof value==='string'&&value.trim().length>0;
const markdown=value=>'```json\n'+JSON.stringify(value,null,2)+'\n```\n';
const relative=name=>typeof name==='string'&&!path.isAbsolute(name)&&!name.includes('\\')
  &&name.split('/').every(part=>part&&part!=='.'&&part!=='..');
const protectedName=name=>/(^|\/)(AGENTS\.md|CLAUDE\.md|\.env(?:\..*)?|\.claude|\.codex|\.git|.*\.(pem|key|p12))(\/|$)/i.test(name);
function orderedUnits(units,scope,assembly){
  need(Array.isArray(units)&&units.length>0,'refactor_units_invalid');const seen=new Set(),done=new Set(),result=[];
  for(const unit of units){shape(unit,['id','files','dependsOn']);need(/^[a-z][a-z0-9-]*$/.test(unit.id)&&!seen.has(unit.id)
    &&Array.isArray(unit.files)&&unit.files.length>0&&Array.isArray(unit.dependsOn),'refactor_units_invalid');seen.add(unit.id);}
  const files=units.flatMap(unit=>unit.files);
  need(new Set(files).size===files.length&&digest([...files,...assembly].sort())===digest([...scope].sort()),'refactor_units_coverage');
  while(result.length<units.length){const next=units.find(unit=>!done.has(unit.id)&&unit.dependsOn.every(id=>done.has(id)));
    need(next,'refactor_dependency_cycle');result.push(next);done.add(next.id);}
  return result;
}
export function createCmRefactorHost(raw,{call}){
  const config=json(raw,256*1024),optional=['batch','testSetup','writebackPaths'];
  shape(config,['skillDir','project','specs','runtime','target','slug','scope','crossModule','baselineCommands','judgeCommand','mutations','logHome',...optional.filter(key=>Object.hasOwn(config,key))]);
  need(nonempty(config.target)&&/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(config.slug),'refactor_target_invalid');
  const admission=inspectCmRefactorAdmission({skillDir:config.skillDir,project:config.project,
    ...(config.specs?{specs:config.specs}:{}),intent:'structure-only',targetPresent:true});
  const {project,specs,workflowRoot}=admission;
  need(['codex','claude'].includes(config.runtime)&&typeof call==='function','refactor_runtime_invalid');
  need(Array.isArray(config.scope)&&config.scope.length>0&&new Set(config.scope).size===config.scope.length
    &&typeof config.crossModule==='boolean','refactor_scope_invalid');
  const archiveRoot=specs?path.join(specs,'refactors'):path.join(project,'docs','refactors'),directory=path.join(archiveRoot,config.slug);
  const reviews=specs?path.join(specs,'.reviews'):path.join(archiveRoot,'.reviews');
  for(const target of [archiveRoot,reviews,config.logHome])need(path.isAbsolute(target)&&canonicalFuture(target)===target,'refactor_archive_invalid');
  need(!inside(project,config.logHome)&&(!specs||!inside(specs,config.logHome)),'refactor_log_home_invalid');
  const setup=config.testSetup??{paths:[]},writebacks=config.writebackPaths??[],batch=config.batch??{assemblyFiles:[],cheapCommands:[],maxPasses:6};
  need(Array.isArray(setup.paths)&&Array.isArray(writebacks)&&Array.isArray(batch.assemblyFiles)&&Array.isArray(batch.cheapCommands)
    &&Number.isInteger(batch.maxPasses)&&batch.maxPasses>=3&&batch.maxPasses<=9,'refactor_options_invalid');
  need(Array.isArray(config.baselineCommands)&&config.baselineCommands.length>0&&Array.isArray(config.judgeCommand)
    &&Array.isArray(config.mutations)&&config.mutations.length>=2,'refactor_judge_setup_required');
  for(const name of [...config.scope,...setup.paths])need(relative(name)&&!protectedName(name)
    &&!inside(archiveRoot,path.join(project,name))&&(!specs||!inside(specs,path.join(project,name))),'refactor_protected_scope');
  for(const name of writebacks)need(relative(name)&&(name==='AGENTS.md'||name==='CLAUDE.md'||name==='README.md'
    ||/^\.claude\/rules\/[a-zA-Z0-9._-]+\.md$/.test(name)),'refactor_writeback_scope');
  need(new Set([...config.scope,...setup.paths,...writebacks]).size===config.scope.length+setup.paths.length+writebacks.length,'refactor_scope_overlap');
  const records=openRefactorRecords(directory),routes={};
  for(const role of ['coder','tester','reviewer'])routes[role]=resolveRole(loadConfig({projectRoot:project}),role,config.runtime);
  let controller=new AbortController(),active=false,view=records.progress??{stage:records.context?'interrupted':'ready',reason:null};
  let context=records.context,files={},reports=view.reports??[],judgeBefore=null,analysis=null,proposal=null,rulebook=null,reviewResult=null;
  let attempt=1,commandCount=0,hostCalls=0,humanCalls=0,interceptions=0,initialPlan=null;
  const feature=`refactor-${config.slug}`,task=`T-REFACTOR-${config.slug}`;
  const absolute=name=>path.join(project,name);
  const managedNames=[...config.scope,...setup.paths,...writebacks];
  const lessons=specs?path.join(specs,'LESSONS.md'):path.join(archiveRoot,'LESSONS.md');
  const unknown=()=>[...records.effects.values()].some(entry=>['host','command'].includes(entry.kind)&&!Object.hasOwn(entry,'result'));
  const ignored=target=>inside(archiveRoot,target)||inside(reviews,target)||(specs&&['运行日志.jsonl','.cm-run.json','.cm-run.lock','.cm-status.json']
    .some(name=>target===path.join(specs,name)));
  function guard(){
    need(context&&digest(config)===context.configDigest,'refactor_config_changed');
    for(const target of [archiveRoot,reviews])need(canonicalFuture(target)===target,'refactor_archive_changed');
    const expected=new Map(Object.entries(context.original).map(([name,content])=>[absolute(name),{content,mode:context.modes[name]}]));
    expected.set(lessons,{content:context.lessons,mode:context.lessonsMode});
    if(specs)expected.set(path.join(specs,'METRICS.md'),{content:context.metrics,mode:context.metricsMode});
    for(const entry of records.effects.values())if(entry.kind==='write'){
      const {target,before,after,mode}=entry.input,current=readText(target);
      // An interrupted atomic replacement has only two legitimate values.
      if(!Object.hasOwn(entry,'result'))need(current===before||current===after,'refactor_write_conflict');
      expected.set(target,{content:Object.hasOwn(entry,'result')?after:current,mode});
    }
    for(const entry of records.effects.values())if(entry.kind==='publish'){
      const current=readText(entry.input.target);need(current===null||current===entry.input.content,'refactor_evidence_changed');
    }
    for(const [target,{content,mode}] of expected){need(readText(target)===content,'refactor_source_changed');
      if(content!==null)need((fs.statSync(target).mode&0o777)===mode,'refactor_source_changed');}
    const now=snapshotSource(project,archiveRoot);
    need(now.gitState?.head===context.baseline.gitState?.head,'refactor_git_changed');
    for(const name of new Set([...Object.keys(context.baseline.files),...Object.keys(now.files)])){
      const target=absolute(name);if(expected.has(target)||ignored(target))continue;
      need(digest(context.baseline.files[name]??null)===digest(now.files[name]??null),'refactor_out_of_scope_change');
    }
  }
  function status(){return json({...view,runId:context?.runId??null,attempt:active?attempt:view.attempt??attempt,scope:config.scope,reports,
    commandCount:active?commandCount:view.commandCount??0,hostCalls:active?hostCalls:view.hostCalls??0,
    baselineCount:config.baselineCommands.length,differentialCount:judgeBefore?.cases.length??view.differentialCount??0,completionAuthorized:false},1024*1024);}
  function projectStatus(){if(specs){const target=path.join(specs,'.cm-status.json');replaceText(target,readText(target),JSON.stringify({node:'REFACTOR',feature,task,
    detail:`Refactor ${config.slug}: ${view.stage}`,state:view.stage==='done'?'run_done':view.stage,at:new Date().toTimeString().slice(0,8)})+'\n',0o600);}}
  function progress(stage,reason=null){view={stage,reason,attempt,reports:[...reports],commandCount,hostCalls,differentialCount:judgeBefore?.cases.length??0};records.progressWrite(view);projectStatus();}
  const identity=()=>({repositoryId:'cm-refactor',runId:context.runId,taskId:task,attempt});
  async function event(key,event,phase,data={}){
    return records.effect(`log/${key}`,'log',{event,phase,data},()=>{
      const args=[path.join(workflowRoot,'scripts/cm-log-event.py'),'--workflow','cm-refactor','--event',event,'--runtime',config.runtime,
        '--project-root',project,'--run-id',context.runId,'--detail',`Refactor ${config.slug}: ${key}`,
        '--data-json',JSON.stringify({node:'REFACTOR',feature,task,...data})];
      if(specs)args.push('--specs-dir',specs);if(phase)args.push('--phase',phase);
      const out=spawnSync('python3',args,{env:{...process.env,CM_WORKFLOW_LOG_HOME:config.logHome},timeout:10000,maxBuffer:1024*1024});
      need(!out.error&&out.status===0,'refactor_log_failed');return JSON.parse(out.stdout.toString());
    },(_entry,perform)=>perform()); // Original writer deduplicates the exact deterministic event identity.
  }
  async function recover(entry,perform){
    guard();const response=json(await call('refactor_recover',{kind:entry.kind,input:entry.input,
      instructions:'Trusted host reconciliation only. Inspect original invocation/process receipt. Return {decision:completed,result,evidence} only for the actual recorded outcome, or {decision:not_started,evidence} with proof no dispatch/execution occurred. Unknown => {decision:unknown,evidence}. Never infer from time or repeat an unknown review/command. No new execution.'},controller.signal),4*1024*1024);
    need(nonempty(response.evidence),'refactor_unknown_effect');
    if(response.decision==='not_started')return perform();
    need(response.decision==='completed','refactor_unknown_effect');
    if(entry.kind==='command'){
      need(response.cleanupConfirmed===true,'refactor_cleanup_unconfirmed');
      const key=[...records.effects.entries()].find(([,value])=>value===entry)[0].slice('command/'.length);
      await event(`${key}-release`,'resource','released',{resource_id:`cmd-${sha(key).slice(0,24)}`,resource_kind:'refactor_judge'});
    }
    return response.result;
  }
  async function invoke(key,kind,payload){
    const input={kind,payload};hostCalls++;
    return records.effect(`host/${key}`,'host',input,async()=>{
      guard();need(!controller.signal.aborted,'cancelled');const at=Date.now();
      const result=json(await call(kind,payload,controller.signal),1024*1024);
      guard();need(!controller.signal.aborted,'cancelled');return {value:result,durationMs:Date.now()-at};
    },recover).then(result=>result.value);
  }
  async function confirm(key,gate,payload){
    humanCalls++;await event(`${key}-pause`,'pause',gate);progress(`awaiting_${gate}`);
    const response=await invoke(key,'refactor_confirm',{gate,...payload,
      instructions:'Show the current user the exact scope/evidence and obtain their explicit decision; {decision:approved|rejected}. Do not assume consent or execute tools.'});
    shape(response,['decision']);need(['approved','rejected'].includes(response.decision),'refactor_decision_invalid');
    await event(`${key}-resume`,'resume',gate,{decision:response.decision});return response.decision==='approved';
  }
  async function write(key,target,before,after,mode=0o644){
    // Cached steps reconstruct virtual text, while guard checks the latest durable disk version.
    if(!records.effects.has(`write/${key}`))guard();
    await records.write(`write/${key}`,target,before,after,mode);
    if(inside(project,target))files[path.relative(project,target)]=after;
  }
  async function publish(key,target,value){
    const content=typeof value==='string'?value:JSON.stringify(value,null,2)+'\n';
    const perform=()=>{
      need(canonicalFuture(path.dirname(target))===path.dirname(target),'refactor_archive_changed');fs.mkdirSync(path.dirname(target),{recursive:true,mode:0o700});
      return writeImmutableWorkflowFile({reviewsDir:path.dirname(target),name:path.basename(target),bytes:Buffer.from(content)});
    };
    await records.effect(`publish/${key}`,'publish',{target,content},perform,perform);
    if(readText(target)===null)perform();else need(readText(target)===content,'refactor_evidence_changed');
    if(!reports.includes(target))reports.push(target);return target;
  }
  async function command(key,argv){
    commandCount++;return records.effect(`command/${key}`,'command',{argv},async()=>{
      guard();need(!controller.signal.aborted,'cancelled');const resource={resource_id:`cmd-${sha(key).slice(0,24)}`,resource_kind:'refactor_judge'};
      await event(`${key}-acquire`,'resource','acquired',{...resource,cleanup_required:true});let stdout='',stderr='';
      const check=createHostCheck({cwd:project,commands:[{id:'judge',command:argv}],onOutput:({stream,chunk})=>{
        if(stream==='stdout')stdout+=chunk.toString();else stderr+=chunk.toString();need(Buffer.byteLength(stdout+stderr)<=256*1024,'refactor_output_limit');}});
      const [observed]=await check({identity:identity()},{signal:controller.signal});
      const clean=observed.evidence!=='host check: cleanup_failed';await event(`${key}-release`,'resource',clean?'released':'cleanup_failed',resource);
      guard();need(clean,'refactor_cleanup_failed');return {observed,stdout,stderr};
    },recover);
  }
  async function judge(key){
    const out=await command(key,config.judgeCommand);need(out.observed.outcome==='passed','refactor_judge_failed');
    const value=json(JSON.parse(out.stdout),256*1024);shape(value,['cases']);
    need(Array.isArray(value.cases)&&value.cases.length>0,'refactor_judge_invalid');const seen=new Set();
    for(const item of value.cases){shape(item,['id','input','output']);need(nonempty(item.id)&&!seen.has(item.id),'refactor_judge_invalid');seen.add(item.id);}return value;
  }
  async function baseline(key){for(const item of config.baselineCommands){const out=await command(`${key}/${item.id}`,item.command);
    need(out.observed.outcome==='passed','refactor_baseline_failed');}}
  async function equivalents(key){await baseline(`${key}/baseline`);const after=await judge(`${key}/differential`);
    await publish(`${key}-diff`,path.join(directory,`${key.replaceAll('/','-')}-diff.md`),markdown({before:judgeBefore,after}));
    need(digest(after)===digest(judgeBefore),'refactor_behavior_changed');return after;}
  const source=names=>names.map(name=>({path:name,content:files[name]??null,beforeDigest:digest(files[name]??null)}));
  async function apply(key,items,allowed,{annotation=false}={}){
    need(Array.isArray(items)&&new Set(items.map(item=>item.path)).size===items.length,'refactor_proposal_invalid');
    for(const item of items){shape(item,['path','beforeDigest','content']);need(allowed.includes(item.path)
      &&item.beforeDigest===digest(files[item.path]??null)&&(item.content===null||typeof item.content==='string'),'refactor_proposal_scope');
      if(annotation&&item.content!==null){const match=/\/\/ REFACTOR STATUS: confidence=(high|medium|low) todos=(\d+)/.exec(item.content);
        need(match&&Number(match[2])===(item.content.match(/TODO\(refactor\)/g)??[]).length,'refactor_status_tail_invalid');}}
    for(const item of items)await write(`${key}/${item.path}`,absolute(item.path),files[item.path]??null,item.content,context.modes[item.path]??0o644);
  }
  async function restore(key,before){for(const [name,value] of Object.entries(before))if(!name.startsWith('__')&&files[name]!==value)
    await write(`${key}/${name}`,absolute(name),files[name],value,context.modes[name]??0o644);}
  async function prepareJudges(){
    if(setup.paths.some(name=>files[name]===null)){
      const result=await invoke('judge-prepare','refactor_prepare_tests',{target:config.target,files:source(config.scope),assets:source(setup.paths),
        baselineCommands:config.baselineCommands,judgeCommand:config.judgeCommand,route:routes.tester,
        instructions:'Return {files:[{path,beforeDigest,content}]} only for declared test assets. Lock current behavior including bugs and boundary cases; preserve original environment resolution. No direct writes or commands, no new dependencies.'});
      await apply('judge-prepare',result.files,setup.paths);
    }
    for(let revision=1;revision<=3;revision++){
      const key=`judge-${revision}`;let failure=null;const mutations=[];
      try{
        await baseline(`${key}/baseline`);judgeBefore=await judge(`${key}/original`);
        for(let n=0;n<config.mutations.length;n++){
          const mutation=config.mutations[n];shape(mutation,['path','find','replace']);
          need(config.scope.includes(mutation.path)&&nonempty(mutation.find)&&typeof mutation.replace==='string'
            &&mutation.find!==mutation.replace,'refactor_mutation_invalid');
          const old=files[mutation.path];need(typeof old==='string'&&old.split(mutation.find).length===2,'refactor_mutation_not_unique');
          await write(`${key}-mutant-${n}`,absolute(mutation.path),old,old.replace(mutation.find,mutation.replace),context.modes[mutation.path]);
          let observed;try{observed=await judge(`${key}/mutant-${n}`);}finally{
            await write(`${key}-restore-${n}`,absolute(mutation.path),files[mutation.path],old,context.modes[mutation.path]);}
          const inputs=value=>value.cases.map(({id,input})=>({id,input}));
          const detected=digest(inputs(observed))===digest(inputs(judgeBefore))&&digest(observed)!==digest(judgeBefore);
          mutations.push({mutation,detected,observed});need(detected,'refactor_judge_missed_mutation');
        }
      }catch(error){if(unknown())throw error;failure=error.code??error.message;}
      await publish(key,path.join(directory,`${key}-report.md`),markdown({judgeBefore,mutations,failure}));
      if(!failure)return;
      need(!controller.signal.aborted,'cancelled');need(setup.paths.length&&revision<3,failure);
      const result=await invoke(`${key}-repair`,'refactor_prepare_tests',{failure,mutations,files:source(config.scope),assets:source(setup.paths),
        baselineCommands:config.baselineCommands,judgeCommand:config.judgeCommand,route:routes.tester,
        instructions:'Diagnose judge first; correct only declared test harness, never production behavior or configured mutations. Return {files:[{path,beforeDigest,content}]}. No commands or direct writes.'});
      await apply(`${key}-repair`,result.files,setup.paths);await event(`${key}-repair`,'decision','judge_repair',{reason:failure});
    }
  }
  async function defineRules(key,previous=null,findings=null){
    const plan=await invoke(key,'refactor_batch',{action:'plan',target:config.target,project,
      files:source(config.scope).map(({path,content,beforeDigest})=>({path,exists:content!==null,beforeDigest})),assemblyFiles:batch.assemblyFiles,
      previous,findings,route:routes.coder,instructions:'Return {rulebook,units:[{id,files,dependsOn}],sample:[file],perFileEstimate,reason}. Resolve naming/shape/prohibitions/escape hatch. File AND module dependencies must be acyclic; encode both into unit dependsOn. Cover scope exactly including declared assembly exclusions. sample chooses hardest files: <10 files ceil(20%), >=10 choose 2-3. perFileEstimate is estimated tokens per file, not observed usage. No writes.'});
    need(nonempty(plan.rulebook)&&nonempty(plan.reason)&&Number.isFinite(plan.perFileEstimate)&&plan.perFileEstimate>0,'refactor_rulebook_invalid');
    const units=orderedUnits(plan.units,config.scope,batch.assemblyFiles);
    const count=config.scope.length<10?Math.max(1,Math.ceil(config.scope.length*.2)):2;
    need(Array.isArray(plan.sample)&&new Set(plan.sample).size===plan.sample.length&&plan.sample.length>=count&&plan.sample.length<=Math.max(count,3)
      &&plan.sample.every(name=>config.scope.includes(name)&&files[name]!==null),'refactor_sample_invalid');
    return {...plan,units};
  }
  async function batchFlow(prefix,findings){
    const denies=JSON.parse(readText(path.join(workflowRoot,'templates/refactor/cm-refactor-denies.json')));
    let plan=prefix==='a1'?{...initialPlan}:await defineRules(`${prefix}/plan`,rulebook,findings),revision=1;
    const trial={};
    for(const variant of ['guided','blind'])trial[variant]=await invoke(`${prefix}/bakeoff-${variant}`,'refactor_batch',{
      action:'bakeoff',variant,files:source(plan.sample),target:config.target,...(variant==='guided'?{rulebook:plan.rulebook}:{}),
      denies,route:routes.coder,instructions:'Use a fresh isolated text-only author context for this variant, no other variant history. Return {files:[{path,beforeDigest,content}],channelId}. No tools/writes/git/heavy tests. Blind variant receives no rulebook or rulebook history.'});
    need(nonempty(trial.guided.channelId)&&nonempty(trial.blind.channelId)&&trial.guided.channelId!==trial.blind.channelId,'refactor_bakeoff_not_independent');
    const adjudication=await invoke(`${prefix}/bakeoff-judge`,'refactor_batch',{action:'adjudicate',files:source(plan.sample),rulebook:plan.rulebook,trial,
      instructions:'Use third fresh context, no authorship. Return {channelId,rulebook,decisions:[{path,verdict,reason}]}; classify every differing file as rule_correct/rule_missing/rule_wrong. No writes.'});
    need(nonempty(adjudication.channelId)&&![trial.guided.channelId,trial.blind.channelId].includes(adjudication.channelId)
      &&nonempty(adjudication.rulebook)&&Array.isArray(adjudication.decisions),'refactor_bakeoff_invalid');
    for(const name of plan.sample){const a=trial.guided.files.find(item=>item.path===name),b=trial.blind.files.find(item=>item.path===name);
      need(a&&b,'refactor_bakeoff_coverage');if(digest(a.content)!==digest(b.content))need(adjudication.decisions.some(row=>row.path===name
        &&['rule_correct','rule_missing','rule_wrong'].includes(row.verdict)&&nonempty(row.reason)),'refactor_bakeoff_coverage');}
    plan.rulebook=adjudication.rulebook;
    await publish(`${prefix}-bakeoff`,path.join(directory,`${prefix}-bakeoff.md`),markdown({trial,adjudication}));
    // Pilot uses the same generation/cheap checks/assembly/equivalence pipeline; discard its products.
    let pilotPassed=false;
    for(let cycle=1;cycle<=3;cycle++){
      const pilotBefore={...files},trialResult=await runBatch(`${prefix}/pilot-${cycle}`,plan.sample,plan.rulebook,revision,[],true);
      await restore(`${prefix}/pilot-discard-${cycle}`,pilotBefore);files.__needs=pilotBefore.__needs??[];
      if(trialResult.passed){pilotPassed=true;break;}
      if(cycle<3){const revised=await defineRules(`${prefix}/pilot-revise-${cycle}`,plan.rulebook,trialResult);
        need(digest(revised.units)===digest(plan.units),'refactor_revision_scope_changed');plan.rulebook=revised.rulebook;}
    }
    need(pilotPassed,'refactor_pilot_failed');
    if(!await confirm(`${prefix}/rulebook`,'rulebook',{rulebook:plan.rulebook,units:plan.units,trial:adjudication,
      budget:{files:config.scope.length,perFileEstimate:plan.perFileEstimate,total:config.scope.length*plan.perFileEstimate}}))return false;
    let history=[{revision,reason:plan.reason,approvedBy:'current-user',rulebook:plan.rulebook}];
    async function saveRules(){rulebook=plan.rulebook;const content='# RULEBOOK\n\n'+rulebook+'\n\n## 修订史\n\n'+markdown(history);
      history.at(-1).rendered=content;
      await write(`${prefix}-rules-${revision}`,path.join(directory,'RULEBOOK.md'),readVirtualRulebook,content,0o600);readVirtualRulebook=content;}
    let readVirtualRulebook=prefix==='a1'?null:files.__rulebook??null;await saveRules();
    for(let index=0;index<plan.units.length;index++){
      const unit=plan.units[index],errors=Object.create(null);let passed=false;
      for(let cycle=1;cycle<=batch.maxPasses;cycle++){
        const key=`${prefix}/batch-${index+1}-${cycle}`,before={...files};
        await event(`${key}-start`,'task_start',null,{batch:index+1,total:plan.units.length,cycle});
        const result=await runBatch(key,unit.files,rulebook,revision,[],false);
        if(result.passed){passed=true;await event(`${key}-done`,'task_done',null,{batch:index+1,total:plan.units.length,differential_groups:judgeBefore.cases.length});break;}
        await restore(`${key}-rollback`,before);await publish(`${key}-rollback`,path.join(directory,`${key.replaceAll('/','-')}-rollback.md`),markdown({unit,cycle,failure:result.failure,baselineHead:context.baseline.gitState?.head??null}));
        await event(`${key}-rollback`,'error','rollback',{batch:index+1,cycle,reason:result.failure});
        const diagnosed=await invoke(`${key}-diagnose`,'refactor_batch',{action:'diagnose',failure:result.failure,output:result.output,rulebook,
          instructions:'Return {errorClass,reason}; identify root error category, not individual filename/line; judge-wide anomalies must be treated as judge faults first. No writes.'});
        need(nonempty(diagnosed.errorClass)&&nonempty(diagnosed.reason),'refactor_diagnosis_invalid');
        errors[diagnosed.errorClass]=(errors[diagnosed.errorClass]??0)+1;
        if(errors[diagnosed.errorClass]===3){
          const revised=await defineRules(`${key}-revise`,rulebook,{...diagnosed,failure:result.failure});
          need(digest(revised.units)===digest(plan.units),'refactor_revision_scope_changed');
          if(!await confirm(`${key}-rulebook`,'rulebook_revision',{previous:rulebook,next:revised.rulebook,reason:diagnosed.reason}))return false;
          plan.rulebook=revised.rulebook;revision++;history.push({revision,reason:diagnosed.reason,approvedBy:'current-user',rulebook:plan.rulebook});await saveRules();
          await event(`${key}-rules`,'decision','rule_revision',{revision,reason:diagnosed.reason});
        }
      }
      need(passed,'refactor_batch_retry_exhausted');
    }
    files.__rulebook=readVirtualRulebook;return true;
  }
  async function runBatch(key,names,rules,revision,needs=[],pilot=false){
    const before={...files},rows=[];let output=null;
    try{
      for(const name of names){
        const result=await invoke(`${key}/unit-${name}`,'refactor_batch',{action:'generate',files:source([name]),rulebook:rules,rulebookRevision:revision,
          assemblyFiles:batch.assemblyFiles,route:routes.coder,
          denies:JSON.parse(readText(path.join(workflowRoot,'templates/refactor/cm-refactor-denies.json'))),
          instructions:'Text-only worker; no commands/writes/git/tests. Return {files:[{path,beforeDigest,content}],needs:[{id,path,instruction}],summary}. Only assigned file; deletion content=null. Non-deleted output includes // REFACTOR STATUS: confidence=high|medium|low todos=N in language-appropriate comment. Report every assembly/registration/doc need, do not implement it.'});
        need(Array.isArray(result.needs)&&nonempty(result.summary),'refactor_unit_invalid');
        for(const item of result.needs)need(nonempty(item.id)&&[...batch.assemblyFiles,...writebacks.filter(n=>['README.md','CLAUDE.md'].includes(n))].includes(item.path)
          &&nonempty(item.instruction),'refactor_assembly_scope');
        needs.push(...result.needs);await apply(`${key}/unit-${name}`,result.files,[name],{annotation:true});
        const content=files[name],match=content===null?null:/confidence=(high|medium|low) todos=(\d+)/.exec(content);
        const host=records.effects.get(`host/${key}/unit-${name}`)?.result;
        rows.push({file:name,agent:'current-host-isolated-author',model:routes.coder.model??null,rulebook_rev:revision,
          diff_pass:false,todos:match?Number(match[2]):0,confidence:match?.[1]??'deleted',duration:host?.durationMs??null,phase:pilot?'pilot':'production',batch:key});
        for(const check of batch.cheapCommands){if(files[name]===null)continue;
          output=await command(`${key}/${name}/${check.id}`,check.command.map(arg=>arg.replaceAll('{file}',name)));need(output.observed.outcome==='passed','refactor_cheap_check_failed');}
      }
      const assemblyNeeds=needs.filter(item=>batch.assemblyFiles.includes(item.path));
      if(assemblyNeeds.length){
        const result=await invoke(`${key}/assembly`,'refactor_batch',{action:'assemble',needs:assemblyNeeds,files:source(batch.assemblyFiles),rulebook:rules,
          instructions:'Main host assembly, NOT delegated worker. Consume every need including loading/registration/build manifests. Return {files:[{path,beforeDigest,content}],resolved:[id]}; no direct writes/commands.'});
        need(Array.isArray(result.resolved)&&assemblyNeeds.every(item=>result.resolved.includes(item.id)),'refactor_assembly_incomplete');
        await apply(`${key}/assembly`,result.files,batch.assemblyFiles);
      }
      await equivalents(key);rows.forEach(row=>{row.diff_pass=true;});
      await publish(`${key}-units`,path.join(directory,`${key.replaceAll('/','-')}-units.md`),markdown({rows,needs,pilot}));
      const logTarget=path.join(directory,'batch-log.jsonl'),old=files.__batchLog??null;
      const next=(old??'')+rows.map(row=>JSON.stringify(row)).join('\n')+'\n';await write(`${key}-batch-log`,logTarget,old,next,0o600);files.__batchLog=next;
      files.__needs=[...(files.__needs??[]),...needs.filter(item=>!batch.assemblyFiles.includes(item.path))];
      return {passed:true};
    }catch(error){
      if(unknown()||controller.signal.aborted||['refactor_unknown_effect','refactor_source_changed','refactor_out_of_scope_change','refactor_write_conflict'].includes(error.code))throw error;
      await restore(`${key}/failed-restore`,Object.fromEntries(Object.entries(before).filter(([name])=>!name.startsWith('__'))));
      const failure=error.code??error.message;await publish(`${key}-failure`,path.join(directory,`${key.replaceAll('/','-')}-failure.md`),markdown({failure,output,rows,pilot}));
      return {passed:false,failure,output};
    }
  }
  async function writeback(prefix){
    let result;
    if(context.batch||writebacks.length||analysis.claimedMemos.length)result=await invoke(`${prefix}/retrospective`,'refactor_retrospective',{
      analysis,proposal,rulebook,needs:files.__needs??[],files:source(writebacks),lessons:context.lessons,route:routes.coder,
      docSyncerSkill:path.join(workflowRoot,'skills/cm-doc-syncer/SKILL.md'),
      instructions:'Main host retrospective; read the supplied doc-syncer Skill for structure synchronization. Return {learningApplication,learning:{status,candidates,reason},conventions:[{path,text,evidence}],documentation:[{path,beforeDigest,content}],resolved:[needId],unfixedDefects:[],metricAfter}. Only evidence-backed max3 Learning candidates; no_new_lesson is valid. Preserve all instructions; conventions append only, not permissions. Every README/CLAUDE structure need must be resolved. No direct writes, no bug fixes.'});
    else result={learningApplication:proposal.learningApplication,learning:typeof proposal.learningRetrospective==='string'
      ?{status:proposal.learningRetrospective,candidates:[],reason:null}:proposal.learningRetrospective,
      conventions:proposal.conventions,documentation:[],resolved:[],unfixedDefects:proposal.unfixedDefects,metricAfter:proposal.metricAfter};
    need(nonempty(result.learningApplication)&&Array.isArray(result.conventions)&&Array.isArray(result.documentation)
      &&Array.isArray(result.resolved)&&Array.isArray(result.unfixedDefects)&&Number.isFinite(result.metricAfter),'refactor_retrospective_invalid');
    const learning=readLearningRetrospectiveContent(result.learning);need(learning.status!=='writeback_pending','refactor_learning_writeback_required');
    if(learning.status==='lesson_candidate'){
      need(writebacks.includes('AGENTS.md'),'refactor_learning_permission_required');
      const old=files['AGENTS.md']??null,next=mergeLessons(old??'',{...learning,identity:identity(),feature});
      await write(`${prefix}-learning`,absolute('AGENTS.md'),old,next,context.modes['AGENTS.md']??0o644);
    }
    let lessonText=files.__lessons??context.lessons;
    for(let n=0;n<result.conventions.length;n++){
      const item=result.conventions[n];need(nonempty(item.text)&&Array.isArray(item.evidence)&&item.evidence.length>0,'refactor_convention_invalid');
      const marker=`<!-- cm-refactor-convention:${digest(item)} -->`;
      if(fs.existsSync(path.join(project,'.claude','rules'))){need(writebacks.includes(item.path)&&/^\.claude\/rules\/.+\.md$/.test(item.path),'refactor_convention_permission_required');
        const old=files[item.path]??null,next=(old??'').includes(marker)?old:(old??'')+'\n'+item.text+'\n'+marker+'\n';
        await write(`${prefix}-convention-${n}`,absolute(item.path),old,next,context.modes[item.path]??0o644);
      }else if(!(lessonText??'').includes(marker))lessonText=(lessonText??'')+`\n[仅记忆] ${item.text}\n证据：${item.evidence.join('、')}。请在 cm-init 后迁入项目规则。\n${marker}\n`;
    }
    for(const memo of analysis.claimedMemos){need(nonempty(memo)&&!memo.includes('\n')&&(context.lessons??'').split(/\r?\n/).includes(memo),'refactor_memo_invalid');
      const next=`${memo} [已认领] 档案：${dossierPath()}`;
      if(!(lessonText??'').includes(next)){need(lessonText.split(memo).length===2,'refactor_memo_conflict');lessonText=lessonText.replace(memo,next);}}
    if(lessonText!==files.__lessons){await write(`${prefix}-lessons`,lessons,files.__lessons??context.lessons,lessonText,context.lessonsMode);files.__lessons=lessonText;}
    need(result.documentation.every(item=>['README.md','CLAUDE.md'].includes(item.path)&&writebacks.includes(item.path)),'refactor_documentation_scope');
    need((files.__needs??[]).every(item=>result.resolved.includes(item.id)),'refactor_documentation_incomplete');
    await apply(`${prefix}-documentation`,result.documentation,writebacks);
    return {...result,learning};
  }
  const dossierPath=()=>context.batch?path.join(directory,'dossier.md'):path.join(archiveRoot,`${context.startedAt.slice(0,10).replaceAll('-','')}-${config.slug}.md`);
  async function flow(){
    files={...context.original};reports=[];commandCount=0;hostCalls=0;humanCalls=0;interceptions=0;rulebook=null;reviewResult=null;proposal=null;judgeBefore=null;attempt=1;
    await event('start','run_start',null);await event('g0','node_enter',null);
    for(const [role,route] of Object.entries(routes))await event(`route-${role}`,'decision','route',{role,adapter:route.adapter,requested_model:route.model,source:route.source,route_state:route.route_state});
    analysis=await invoke('analysis','refactor_analyze',{target:config.target,project,scope:config.scope,
      files:source(config.scope).map(({path,content,beforeDigest})=>({path,exists:content!==null,beforeDigest})),route:routes.coder,
      learningPath:absolute('AGENTS.md'),lessonsPath:lessons,instructions:'Read applicable root/nested instructions, callers and related pending structural memos. Return {decision:proceed|no_refactor,metric:{name,before,unit},impact:[],claimedMemos:[exact source lines],reason}. Quantify real benefit. Behavior changes must not proceed. No writes/commands.'});
    need(['proceed','no_refactor'].includes(analysis.decision)&&nonempty(analysis.reason)&&Array.isArray(analysis.claimedMemos)
      &&Number.isFinite(analysis.metric?.before),'refactor_analysis_invalid');
    if(analysis.decision==='no_refactor'){await event('not-needed','run_done',null,{result:'not_needed'});progress('not_needed');return false;}
    if(context.batch)initialPlan=await defineRules('initial-plan');
    if(!await confirm('g0','g0',{analysis,scope:config.scope,track:context.batch?'batch':'light',testPaths:setup.paths,writebackPaths:writebacks,
      budget:initialPlan?{files:config.scope.length,perFileEstimate:initialPlan.perFileEstimate,total:config.scope.length*initialPlan.perFileEstimate}:null,
      baselineCommands:config.baselineCommands,judgeCommand:config.judgeCommand,mutations:config.mutations,
      warning:'Source additions/deletions and declared project-only rules/tests writeback are included. No provider/install/Git authorization.'})){
      await event('rejected','run_done',null,{result:'rejected'});progress('rejected');return false;}
    await event('judge','node_enter',null);await prepareJudges();
    for(attempt=1;attempt<=2;attempt++){
      const prefix=`a${attempt}`;await event(`${prefix}-execute`,'node_enter',null);progress('implementing');
      if(!context.batch)await event(`${prefix}-task`,'task_start',null,{attempt});
      if(context.batch){if(!await batchFlow(prefix,reviewResult)){progress('rulebook_rejected');return false;}}
      else{
        proposal=await invoke(`${prefix}/apply`,'refactor_apply',{target:config.target,analysis,attempt,files:source(config.scope),findings:reviewResult,route:routes.coder,
          instructions:'Propose structure-only replacements, no file writes/commands/bug fixes. Return {files:[{path,beforeDigest,content}],summary,metricAfter,unfixedDefects:[],conventions:[],learningApplication,learningRetrospective}. New lessons must be reported, not hidden.'});
        need(proposal.files.every(item=>item.content!==null),'refactor_deletion_requires_batch');await apply(`${prefix}/apply`,proposal.files,config.scope);
        try{await equivalents(prefix);}catch(error){if(!unknown())await restore(`${prefix}/rollback`,Object.fromEntries(config.scope.map(name=>[name,context.original[name]])));throw error;}
      }
      const retrospective=await writeback(prefix);
      const changed=managedNames.filter(name=>(files[name]??null)!==context.original[name]);
      need(changed.length>0,'refactor_no_change');
      const payload={schema_version:1,task_id:task,attempt,status:'ready_for_review',changed_files:changed,
        implementation_sha256:await records.effect(`${prefix}-implementation`,'hash',{changed},()=>implementationSha256(project,changed)),
        verification:[{command:'baseline + differential + judge self-validation',status:'passed',evidence:`${config.baselineCommands.length} baseline commands; ${judgeBefore.cases.length} groups equal; ${config.mutations.length} mutations detected`}],
        evidence:[`learning: applied ${retrospective.learningApplication}`,`learning: retrospective ${changed.includes('AGENTS.md')?'written AGENTS.md':'no_new_lesson'}`,
          ...reports,`LESSONS reviewed SHA: ${sha(files.__lessons??context.lessons??'')}`],blockers:[],scope_deviation:[]};
      const handoff=await publish(`${prefix}-handoff`,path.join(reviews,`${feature}-${task}-${prefix}-handoff.json`),payload);
      const options={handoff,reviewsDir:reviews,feature,task,projectRoot:project,requireLearning:true};
      // Cached reviewed attempts use their exact archived snapshot; current N5 is rechecked before finish.
      await records.effect(`${prefix}-n4`,'gate',{handoff},()=>{guard();return checkN4(options);});
      await event(`${prefix}-review-start`,'review','start',{attempt});
      const reviewed=await invoke(`${prefix}/review`,'refactor_review',{handoff,handoffSha256:sha(JSON.stringify(payload,null,2)+'\n'),attempt,feature,task,
        files:changed.map(name=>({path:name,before:context.original[name],after:files[name]})),analysis,retrospective,rulebook,judgeBefore,reports,
        lessons:{path:lessons,before:context.lessons,after:files.__lessons??context.lessons},project,baselineCommands:config.baselineCommands,judgeCommand:config.judgeCommand,
        preTaskDirty:context.baseline.gitState,route:routes.reviewer,
        instructions:'Fresh independent reviewer per runtime/review.md, no author history. Review ALL diff including tests/Learning/rules/docs/LESSONS and judge coverage. Return {markdown} with original N4 header binding exact handoff SHA, attempt=round, scope, findings. No writes or unapproved provider. Missing channel is blocked, never invent approval.'});
      const review=await publish(`${prefix}-review`,path.join(reviews,`${feature}-${task}-r${attempt}.md`),reviewed.markdown);
      reviewResult=validateReview(review,{task,attempt,handoff,changedFiles:changed});interceptions+=Number(reviewResult.blocking_findings);
      await event(`${prefix}-review-complete`,'review','complete',{attempt,verdict:reviewResult.verdict,blocking_findings:Number(reviewResult.blocking_findings)});
      if(reviewResult.verdict==='changes_requested'&&attempt===1){reviewResult={...reviewResult,markdown:reviewed.markdown};continue;}
      guard();checkN5(options);proposal={...retrospective,changed,options};progress('awaiting_finish');return true;
    }
    need(false,'refactor_review_exhausted');
  }
  async function finish(){
    const previous=[...records.effects.entries()].filter(([key])=>/^host\/finish-\d+$/.test(key));
    const pending=previous.find(([,entry])=>!Object.hasOwn(entry,'result'));
    const approved=previous.find(([,entry])=>entry.result?.value?.decision==='approved');
    const selected=pending??approved,key=selected?selected[0].slice(5):`finish-${previous.length+1}`;
    const presented=selected?selected[1].input.payload:{analysis,metricAfter:proposal.metricAfter,reports,baselineCount:config.baselineCommands.length,
      budget:{estimatedTokens:initialPlan?config.scope.length*initialPlan.perFileEstimate:null,observedTokens:null,
        hostDurationMs:[...records.effects.values()].filter(entry=>entry.kind==='host').reduce((sum,entry)=>sum+(entry.result?.durationMs??0),0)},
      differentialCount:judgeBefore.cases.length,hostCalls,commandCount,unfixedDefects:proposal.unfixedDefects};
    if(!await confirm(key,'finish',presented)){progress('awaiting_finish');return;}
    need(!unknown(),'refactor_unknown_effect');guard();checkN5(proposal.options);
    const calls=[...records.effects.values()].filter(entry=>entry.kind==='host'&&Object.hasOwn(entry,'result'));
    const usage={agentCalls:calls.filter(entry=>entry.input.kind!=='refactor_confirm').length,
      hostDurationMs:calls.reduce((sum,entry)=>sum+(entry.result.durationMs??0),0),
      estimatedTokens:initialPlan?config.scope.length*initialPlan.perFileEstimate:null,observedTokens:null};
    await publish('dossier',dossierPath(),'# Refactor dossier\n\n'+markdown({analysis,metricAfter:proposal.metricAfter,changed:proposal.changed,reports,
      delivery:'diff',hostCalls,commandCount,baselineCount:config.baselineCommands.length,differentialCount:judgeBefore.cases.length,
      learning:proposal.learning,unfixedDefects:proposal.unfixedDefects,deviations:[],usage}));
    if(specs){const header='| 任务 | Feature | 开始 | 结束 | 审查轮次 | 独立审查拦截 | QA | 人工介入(次:原因) |',old=context.metrics;
      need(!old||old.split(/\r?\n/).includes(header),'refactor_metrics_format');
      const at=await records.effect('finish-time','clock',{},()=>new Date().toISOString());
      const line=`| ${task} | refactor | ${context.startedAt} | ${at} | ${attempt} | ${interceptions} | 等价通过 | ${calls.filter(entry=>entry.input.kind==='refactor_confirm').length}:人门; delivery-diff; agents=${usage.agentCalls}; host_ms=${usage.hostDurationMs}; estimate_tokens=${usage.estimatedTokens??'unavailable'}; actual_tokens=unavailable; commands=${commandCount} |\n`;
      await write('metrics',path.join(specs,'METRICS.md'),old,(old??`${header}\n| --- | --- | --- | --- | --- | --- | --- | --- |\n`)+(old&&!old.endsWith('\n')?'\n':'')+line,context.metricsMode);}
    guard();checkN5(proposal.options);await event('task-finish','task_done',null,{attempt});
    await event('run-finish','run_done',null,{result:'done',baseline_count:config.baselineCommands.length,differential_count:judgeBefore.cases.length});progress('done');
  }
  return Object.freeze({async handle(request){
    need(request&&typeof request.operation==='string','invalid_request');
    if(request.operation==='status'){
      if(context)try{guard();}catch(error){return {...status(),stage:'correction_required',reason:error.code??error.message,historicalStage:view.stage};}return status();}
    if(request.operation==='cancel'){controller.abort();return {...status(),stage:'cancelled'};}
    need(!active,'refactor_busy');active=true;controller=new AbortController();
    try{
      need(['start','resume','finish'].includes(request.operation),'invalid_request');records.acquire();
      if(!context){
        need(request.operation==='start','refactor_not_started');
        need(fs.readdirSync(directory).every(name=>name==='.writer.json'),'refactor_legacy_recovery_required');
        need(!fs.existsSync(path.join(reviews,`${feature}-${task}-a1-handoff.json`)),'refactor_legacy_recovery_required');
        const original=Object.fromEntries(managedNames.map(name=>[name,readText(absolute(name))]));
        const batchTrack=Boolean(config.batch)||config.scope.length>3||config.crossModule||config.scope.some(name=>original[name]===null);
        const baselineSnapshot=snapshotSource(project,archiveRoot);need(!batchTrack||baselineSnapshot.gitState,'refactor_batch_requires_git');
        context={configDigest:digest(config),runId:`refactor-${randomUUID()}`,startedAt:new Date().toISOString(),original,
          modes:Object.fromEntries(managedNames.map(name=>[name,original[name]===null?0o644:fs.statSync(absolute(name)).mode&0o777])),
          baseline:baselineSnapshot,batch:batchTrack,lessons:readText(lessons),lessonsMode:fs.existsSync(lessons)?fs.statSync(lessons).mode&0o777:0o644,
          metrics:specs?readText(path.join(specs,'METRICS.md')):null,metricsMode:specs&&fs.existsSync(path.join(specs,'METRICS.md'))?fs.statSync(path.join(specs,'METRICS.md')).mode&0o777:0o600};records.initialize(context);
      }else{guard();if(view.stage==='done')return status();need(request.operation!=='start','refactor_resume_required');}
      if(await flow()){
        if(request.operation==='resume'){
          const rounds=[...records.effects.keys()].map(key=>/^command\/resume-check\/(\d+)\//.exec(key)).filter(Boolean).map(match=>Number(match[1]));
          const last=Math.max(0,...rounds),complete=records.effects.get(`resume-check-${last}-complete`);
          const n=last===0?1:Object.hasOwn(complete??{},'result')?last+1:last;
          await equivalents(`resume-check/${n}`);guard();checkN5(proposal.options);
          await records.effect(`resume-check-${n}-complete`,'checkpoint',{round:n},()=>({completed:true}),()=>({completed:true}));
        }
        if(request.operation==='finish')await finish();
      }
      projectStatus();
      return status();
    }catch(error){view={...view,stage:controller.signal.aborted?'cancelled':'blocked',reason:error.code??error.message};
      try{records.progressWrite(view);projectStatus();}catch{}return status();
    }finally{records.release();active=false;}
  }});
}
