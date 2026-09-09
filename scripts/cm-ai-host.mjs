#!/usr/bin/env node
// Opt-in current-conversation host. Review requires a separately authorized
// attempt and the registered V3 boundary; preflight is only local diagnostics.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readRunDefinition,openControlRun,createCodexExecution} from './cm-ai-run.mjs';
import {createConversationExecution as executionFor} from '../runtime/js/cm-ai/host-conversation-execution.mjs';
import {createHostToolBridge} from '../runtime/js/cm-ai/host-tool-bridge.mjs';
import {serveCmAiHost} from '../runtime/js/cm-ai/host-session.mjs';
import {createQaFixOwnerHost} from '../runtime/js/cm-ai/host-qa-fix-owner.mjs';
import {createFixLearningPreparation} from '../runtime/js/cm-fix/learning.mjs';
import {createFixReviewHost} from '../runtime/js/cm-fix/host-review.mjs';
import {createHostReviewAuthority} from '../runtime/js/cm-ai/host-review-authority.mjs';
import {readHostWorkflowConfiguration} from '../runtime/js/cm-ai/host-workflow-capabilities.mjs';
import {digest,json,need,shape} from '../runtime/js/cm-ai/effect-contract.mjs';
export {executionFor as createConversationExecution,reviewConfiguration as readConversationReviewConfiguration};
export {conversationProtection} from '../runtime/js/cm-ai/host-conversation-execution.mjs';
export function readConversationProtection(file){
  const stat=fs.lstatSync(file);need(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=64*1024,'invalid_protected_config');
  const config=json(JSON.parse(fs.readFileSync(file,'utf8')));shape(config,['checkCommands','timeoutMs']);return config;
}
export function readBootstrapConfiguration(file){
  const stat=fs.lstatSync(file);need(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=64*1024,'invalid_bootstrap_config');
  const config=json(JSON.parse(fs.readFileSync(file,'utf8')));shape(config,['selection']);return config;
}
const fixLocalPermissions=new Map(['red-test','baseline','regression','learning-writeback','walkthrough','finish',
  'test-author','repair','cause-review','final-review']
  .map(name=>[`--allow-qa-fix-${name}`,`--allow-${name}`]));

const usage='cm-ai-host.mjs serve --config PATH --mode create|resume --host-context ID --allow-development [--runtime codex|claude] [--review-config PATH] [--allow-review-attempt 1|2] [--workflow-config PATH] [--allow-qa]\ncm-ai-host.mjs preflight --config PATH --review-model MODEL [--runtime codex|claude] (synthetic loopback only)';

function reviewConfiguration(file){
  const info=fs.lstatSync(file);
  need(info.isFile()&&!info.isSymbolicLink()&&info.size<=64*1024,'invalid_review_config');
  const config=json(JSON.parse(fs.readFileSync(file,'utf8')));
  shape(config,['model','preflight',...(Object.hasOwn(config,'disabledSkills')?['disabledSkills']:[])]);
  need(typeof config.model==='string'&&/^[a-zA-Z0-9._-]+$/.test(config.model),'invalid_review_config');
  const disabledSkills=config.disabledSkills??[];
  need(Array.isArray(disabledSkills)&&disabledSkills.length<=4096
    &&disabledSkills.every(item=>typeof item==='string'&&path.isAbsolute(item)&&!/[\n\r\0]/.test(item)),'invalid_review_config');
  return json({...config,disabledSkills});
}

async function protectedExecutionFor(definition,hostContextId,extra,review,mode,workflow,bridge,bootstrap=null){
  need((extra.get('--runtime')??'codex')==='codex','protected_runtime_unsupported');
  need(review!==null,'review_configuration_required');
  need(['1','2'].includes(extra.get('--allow-provider-development-attempt')),'provider_development_authorization_required');
  const attempt=Number(extra.get('--allow-provider-development-attempt'));
  need(mode!=='create'||attempt===1,'invalid_development_attempt');
  // Child fix configuration is checked before opening the parent store below.
  const file=extra.get('--protected-config'),info=fs.lstatSync(file);
  need(info.isFile()&&!info.isSymbolicLink()&&info.size<=64*1024,'invalid_protected_config');
  const config=json(JSON.parse(fs.readFileSync(file,'utf8')));shape(config,['model','checkCommands','timeoutMs']);
  const authority=createHostReviewAuthority({hostContextId,reviewerId:'reviewer',adapterId:'codex-review-adapter',
    decide:async binding=>String(binding.identity.attempt)===extra.get('--allow-review-attempt')?{status:'approved'}:null});
  return createCodexExecution({codeProject:definition.codeProject,specsRoot:definition.specsDir,
    developerModel:config.model,checkCommands:config.checkCommands,timeoutMs:config.timeoutMs,
    hostContextId,developerContextId:'cm-protected-author',reviewerModel:review.model,
    reviewerPreflight:review.preflight,disabledSkills:review.disabledSkills,
    ...(workflow?{workflow:{definition,configuration:workflow}}:{}),
    ...(bootstrap?{bootstrap:{definition,selection:bootstrap.selection}}:{})},
  {hostDecision:null,developmentAttempt:attempt,hostDecisionProvider:authority.hostDecisionProvider,authorizeReview:authority.authorize,
    ...(workflow?{workflow:{bridge,allowQa:extra.has('--allow-qa')}}:{}),
    ...(bootstrap?{bootstrap:{bridge,allowWrite:extra.has('--allow-bootstrap-write')}}:{}),
    authorizeDevelopment:request=>({status:request.identity.attempt===attempt
      &&digest({...request.identity,attempt:1})===digest(definition.identity)?'approved':'denied'})});
}


export async function main(argv=process.argv.slice(2),{input=process.stdin,output=process.stdout,error=process.stderr}={}){
  if(argv.length===1&&['--help','-h'].includes(argv[0]))output.write('Approved 0.bootstrap only: --bootstrap-config PATH {selection:null for scaffold, or original cm-init selection for rules} and --allow-bootstrap-write. Original scope must include fixed instruction targets; they are host-written inside the original task effect, checked/reviewed and reloaded. No Git/install/network grant. Optional codeProjects selects disjoint real roots below codeProject; prefix scope/requirements and use protected current-session checks with a declared codeProject per command.\n');
  if(argv.length===1&&['--help','-h'].includes(argv[0]))output.write('Protected current-session mode (Codex or Claude; also batch): --protected-conversation-config PATH with {checkCommands,timeoutMs}. No extra model call. The current host returns scoped UTF-8 edits; native Codex sandbox applies them and runs the declared checks. Original author runtime, per-attempt Review and QA permissions remain required. Do not combine with --protected-config. Same original 64KiB transport limit; unavailable/binary changes stop, never switch to direct writes.\n');
  if(argv.length===1&&['--help','-h'].includes(argv[0]))output.write('Protected single-task Codex mode: add --protected-config PATH --allow-provider-development-attempt 1|2 and --review-config PATH. Protected config is {model,checkCommands,timeoutMs}; roots and host identity come from the original run definition and launch. This explicitly permits one task attempt of real developer execution and its declared native-sandbox checks; --allow-development alone does not. Review separately requires --allow-review-attempt 1|2. Diagnostics are required but are not review authorization. Optional original --workflow-config PATH and --allow-qa connect protected QA commands and documentation within the same developer invocation before Review; host semantic/browser/inspection requests retain their original contracts, not arbitrary writes. Default current-session mode is unchanged. Protected parent mode rejects Claude; original QA-fix options require child configuration.protectSpecs=true and all original child action permissions. Protected fix writes use text proposals, not direct host edits. The original QA/documentation/finalizer gates remain required. No installation or Git authority.\n');
  if(argv.length===1&&['--help','-h'].includes(argv[0]))output.write('--auto-qa-fix optionally connects parent advance -> fix_run -> re-QA. Requires --qa-fix-template-config, --allow-qa-fix-start, original action permissions and project policies.auto_fix=auto. Explicit/never policies stop. Unknown, blocked or incomplete repair stops; status/cancel remain available and no fourth QA round is dispatched.\n');
  if(argv.length===1&&['--help','-h'].includes(argv[0]))output.write('--qa-fix-template-config PATH is an alternative to --qa-fix-owner-config. Supply {specsRoot, feature, identity: parent identity, configuration: original fix configuration without qaSource}. Each fix request binds it to the latest completed QA failure; identity/digests are generated, commands/scope/permissions are not. Existing child configuration remains immutable.\n');
  if(argv.length===1&&['--help','-h'].includes(argv[0]))output.write('fix_run continuously executes normal stages of the fixed QA child using the same binding as fix_advance. Requires --allow-qa-fix-start and every original per-action permission/configuration. Stops on unknown, blocked, observation, revision-required or unchanged state. It does not auto-switch child configuration or run parent QA.\n');
  if(argv.length===1&&['--help','-h'].includes(argv[0]))output.write('fix_action delegates to the shared original cm-fix dispatcher. Local flags: --allow-qa-fix-red-test, --allow-qa-fix-baseline, --allow-qa-fix-regression, --allow-qa-fix-learning-writeback, --allow-qa-fix-walkthrough, --allow-qa-fix-finish. Adapter flags: --allow-qa-fix-test-author, --allow-qa-fix-repair, --allow-qa-fix-cause-review, --allow-qa-fix-final-review, with separate --qa-fix-review-config PATH and matching original child reviewer metadata. All require --allow-qa-fix-start and the original action configuration/gates. Parent --review-config/--allow-review-attempt do not grant child review permission.\n');
  if(argv.length===1&&['--help','-h'].includes(argv[0]))output.write('--allow-qa-fix-start additionally permits fix_advance to create or resume the fixed QA child and run only its original Learning/reproduction/diagnosis stages. Child hostContextId and runtime must match this host. It does not authorize test authoring, repair, independent provider Review, finish, Git or re-QA. Active child status/cancel use the original child owner; repeated advance never resets an unknown or completed step.\n');
  if(argv.length===1&&['--help','-h'].includes(argv[0]))output.write('--qa-fix-owner-config PATH enables read-only fix_status. The file contains the existing fix owner definition {specsRoot, identity, configuration}, including its exact original qaSource and immutable configuration, not provider grants. fix_status binds the parent identity/packageDigest/testRunId, serially closes the parent writer, opens only an existing child, reads its original completion evidence, closes it and resumes the same parent. It does not create/execute repairs, rerun QA or clear correction gates.\n');
  if(argv.length===1&&['--help','-h'].includes(argv[0])){output.write(usage+'\n');return 0;}
  let run,bridge;
  try{
    if(argv[0]==='preflight'){
      need((argv.length===5||argv.length===7)&&argv[1]==='--config'&&argv[3]==='--review-model','invalid_arguments');
      const runtime=argv.length===5?'codex':argv[6];
      need(argv.length===5||argv[5]==='--runtime','invalid_arguments');
      need(['codex','claude'].includes(runtime),'invalid_runtime');
      const definition=readRunDefinition(argv[2]);
      if(runtime==='claude'){
        const {previewClaudeTools}=await import('../runtime/js/cm-ai/claude-tool-preview.mjs');
        const config=await previewClaudeTools({cwd:definition.codeProject,model:argv[4]});
        output.write(JSON.stringify(config)+'\n');return config.preflight.passed?0:1;
      }
      const {previewIsolated}=await import('../runtime/js/cm-ai/tool-preview.mjs');
      const receipt=await previewIsolated({cwd:definition.codeProject,model:argv[4],allowCodeProject:true,promptTransport:'stdin'});
      // No raw startup diagnostics, headers, prompt or discovered content.
      output.write(JSON.stringify({model:argv[4],disabledSkills:receipt.disabledSkillFolders,preflight:{passed:receipt.passed,
        cli_model:receipt.cli_model,config_fingerprint:receipt.config_fingerprint,prompt_transport:receipt.prompt_transport,
        real_model_requests:receipt.real_model_requests,listener_closed:receipt.listener_closed}})+'\n');
      return receipt.passed?0:1;
    }
    need(argv.length>=8&&argv[0]==='serve'&&argv[1]==='--config'&&argv[3]==='--mode'
      &&argv[5]==='--host-context'&&argv[7]==='--allow-development','host_launch_authorization_required');
    const extra=new Map();
    for(let index=8;index<argv.length;index++){
      const name=argv[index];need(!extra.has(name),'invalid_arguments');
      need(['--bootstrap-config','--allow-bootstrap-write','--protected-conversation-config','--protected-config','--allow-provider-development-attempt','--review-config','--allow-review-attempt','--workflow-config','--allow-qa','--runtime','--qa-fix-owner-config','--qa-fix-template-config','--qa-fix-review-config','--allow-qa-fix-start','--auto-qa-fix',...fixLocalPermissions.keys()].includes(name),'invalid_arguments');
      if(['--allow-bootstrap-write','--allow-qa','--allow-qa-fix-start','--auto-qa-fix',...fixLocalPermissions.keys()].includes(name))extra.set(name,true);
      else{need(typeof argv[index+1]==='string'&&!argv[index+1].startsWith('--'),'invalid_arguments');extra.set(name,argv[++index]);}
    }
    const review=extra.has('--review-config')?reviewConfiguration(extra.get('--review-config')):null;
    const workflow=extra.has('--workflow-config')?readHostWorkflowConfiguration(extra.get('--workflow-config')):null;
    let allowedAttempt=null;
    if(extra.has('--allow-review-attempt')){need(['1','2'].includes(extra.get('--allow-review-attempt')),'invalid_arguments');allowedAttempt=Number(extra.get('--allow-review-attempt'));}
    need(!extra.has('--allow-qa')||workflow?.qa!=null,'invalid_arguments');
    const hasFix=extra.has('--qa-fix-owner-config')||extra.has('--qa-fix-template-config');
    need(!(extra.has('--qa-fix-owner-config')&&extra.has('--qa-fix-template-config')),'invalid_fix_config');
    need(!extra.has('--allow-qa-fix-start')||hasFix,'qa_fix_source_required');
    need(!extra.has('--qa-fix-review-config')||hasFix,'qa_fix_source_required');
    need(!extra.has('--auto-qa-fix')||(extra.has('--qa-fix-template-config')&&extra.has('--allow-qa-fix-start')),'qa_fix_auto_authorization_required');
    need(![...fixLocalPermissions.keys()].some(flag=>extra.has(flag))||extra.has('--allow-qa-fix-start'),'qa_fix_start_authorization_required');
    need(!extra.has('--allow-provider-development-attempt')||extra.has('--protected-config'),'protected_configuration_required');
    need(!(extra.has('--protected-config')&&extra.has('--protected-conversation-config')),'invalid_arguments');
    const protection=extra.has('--protected-conversation-config')?readConversationProtection(extra.get('--protected-conversation-config')):null;
    const bootstrap=extra.has('--bootstrap-config')?readBootstrapConfiguration(extra.get('--bootstrap-config')):null;
    need(!extra.has('--allow-bootstrap-write')||bootstrap!==null,'bootstrap_configuration_required');
    const definition=readRunDefinition(argv[2]);bridge=createHostToolBridge();
    const templated=extra.has('--qa-fix-template-config');let fix=null;
    if(hasFix){
      const file=extra.get(templated?'--qa-fix-template-config':'--qa-fix-owner-config'),info=fs.lstatSync(file);
      need(info.isFile()&&!info.isSymbolicLink()&&info.size<=64*1024,'invalid_fix_config');
      fix=json(JSON.parse(fs.readFileSync(file,'utf8')),64*1024);
      if(extra.has('--protected-config')||protection)need(fix.configuration?.protectSpecs===true,'protected_fix_required');
    }
    const execution=extra.has('--protected-config')
      ?await protectedExecutionFor(definition,argv[6],extra,review,argv[4],workflow,bridge,bootstrap)
      :executionFor(definition,argv[6],bridge,review,allowedAttempt,workflow,extra.has('--allow-qa'),extra.get('--runtime')??'codex',
        {...(protection?{protection}:{}),...(bootstrap?{bootstrap:{...bootstrap,allowWrite:extra.has('--allow-bootstrap-write')}}:{})});
    run=await openControlRun(definition,argv[4],execution);
    if(run.blocked){output.write(JSON.stringify({outcome:'blocked',admission:run.blocked})+'\n');return 1;}
    if(hasFix){
      need(fs.realpathSync(fix.specsRoot)===fs.realpathSync(definition.specsDir)
        &&fs.realpathSync(fix.configuration.reproduction.cwd)===fs.realpathSync(definition.codeProject)
        &&(templated?fix.feature:fix.configuration.qaSource.feature)===definition.feature,'qa_fix_source_mismatch');
      if(templated)need(digest(fix.identity)===digest(definition.identity),'qa_fix_source_mismatch');
      if(extra.has('--allow-qa-fix-start'))need(fix.configuration.hostContextId===argv[6]
        &&(fix.configuration.runtime??'codex')===(extra.get('--runtime')??'codex'),'qa_fix_host_mismatch');
      const fixPermissions=[...fixLocalPermissions].filter(([flag])=>extra.has(flag)).map(([,permission])=>permission);
      const fixReview=extra.has('--qa-fix-review-config')?reviewConfiguration(extra.get('--qa-fix-review-config')):null;
      need(!fixPermissions.includes('--allow-test-author')||(fix.configuration.testAuthor&&fixReview),'test_author_configuration_required');
      need(!fixPermissions.includes('--allow-repair')||(fix.configuration.repair&&fixReview),'repair_configuration_required');
      const fixReviewHost=createFixReviewHost({codeProject:definition.codeProject,
        hostContextId:fix.configuration.hostContextId,runtime:fix.configuration.runtime??'codex',
        review:fixReview,permissions:fixPermissions});
      if(fixReview)need(digest(fix.configuration.causeReview??null)===digest(fixReviewHost.reviewer),'qa_fix_review_configuration_mismatch');
      const host=createQaFixOwnerHost({parent:run,...(templated?{template:fix}:{fix}),reopenParent:()=>openControlRun(definition,'resume',execution),
        fixPermissions,fixAuthorities:{authority:fixReviewHost.authority,finalAuthority:fixReviewHost.finalAuthority},
        allowStart:extra.has('--allow-qa-fix-start'),autoFix:extra.has('--auto-qa-fix'),fixExecution:{bridge,...fixReviewHost.execution,
          prepare:createFixLearningPreparation({bridge,codeProject:definition.codeProject,
            applicableAgentFiles:fix.configuration.applicableAgentFiles??[]})}});
      run={host,close:host.close};
    }
    // PTY sessions are used by desktop tool hosts. Disable echo only on this
    // process's own terminal so tool results are not mistaken for output frames.
    const rawMode=input.isTTY&&typeof input.setRawMode==='function';if(rawMode)input.setRawMode(true);
    try{await serveCmAiHost({host:run.host,input,output,toolBridge:bridge});}
    finally{if(rawMode)input.setRawMode(false);}
    return 0;
  }catch(cause){
    const code=typeof cause?.code==='string'&&/^[a-z][a-z0-9_]{0,63}$/.test(cause.code)?cause.code:'host_launch_failed';
    error.write(JSON.stringify({error:{code}})+'\n');return 1;
  }finally{bridge?.close();run?.close();}
}
if(process.argv[1]&&fs.realpathSync(process.argv[1])===fileURLToPath(import.meta.url))process.exitCode=await main();
