// Host-owned writeback; no provider, task marking, or review approval.
import fs from 'node:fs';
import {types} from 'node:util';
import {digest,hex,json,need,shape,validIdentity} from '../cm-ai/effect-contract.mjs';
import {readReviewBaseline,readReviewPackage,verifyReviewPackage,readReviewSourceFiles} from '../cm-ai/review-package.mjs';
import {writeProjectLearningContent} from '../cm-ai/cm-ai-learning-writer.mjs';
import {inspectFixLearning} from './learning.mjs';
import {inspectFixRetrospective} from './retrospective.mjs';

export function inspectFixLearningWriteback(raw,{identity,learning,retrospective}){
  const value=json(raw,64*1024);
  shape(value,['identity','learningDigest','retrospectiveDigest','packageDigest','outcome','changed','agentsFile','reason','completionEligible']);
  need(digest(value.identity)===digest(identity)&&value.learningDigest===digest(learning)
    &&value.retrospectiveDigest===digest(retrospective)&&value.packageDigest===retrospective.packageDigest
    &&value.completionEligible===false,'writeback_binding_mismatch');
  const expected=learning.files.find(file=>file.path==='AGENTS.md')??null;
  if(value.agentsFile!==null){shape(value.agentsFile,['scope','path','sha256']);
    need(value.agentsFile.scope==='project'&&value.agentsFile.path==='AGENTS.md');hex(value.agentsFile.sha256);}
  if(retrospective.content.status==='no_new_lesson')need(value.outcome==='no_new_lesson'&&value.changed===false
    &&value.reason===null&&digest(value.agentsFile)===digest(expected),'invalid_writeback');
  else if(retrospective.content.status==='writeback_pending')need(value.outcome==='writeback_pending'&&value.changed===null
    &&value.reason===retrospective.content.reason&&digest(value.agentsFile)===digest(expected),'invalid_writeback');
  else if(value.outcome==='written'||value.outcome==='deduplicated')need(value.changed===(value.outcome==='written')
    &&value.agentsFile!==null&&value.reason===null,'invalid_writeback');
  else need(value.outcome==='writeback_pending'&&value.changed===null
    &&['agents_changed','agents_unsafe','agents_too_large','agents_write_failed'].includes(value.reason),'invalid_writeback');
  return value;
}

export function fixLearningReviewBaseline(raw){
  const {baselineDigest,...before}=readReviewBaseline(raw);
  const data={...before,scope:[...new Set([...before.scope,'AGENTS.md'])].sort(),
    requirements:[...new Set([...before.requirements,...(before.files.some(file=>file.path==='AGENTS.md')?['AGENTS.md']:[])])].sort()};
  return readReviewBaseline({...data,baselineDigest:digest(data)});
}

export function inspectFixLearningReviewPackage(raw,{baseline,previous,writeback}){
  const pkg=readReviewPackage(raw),expanded=fixLearningReviewBaseline(baseline);
  need(['written','deduplicated'].includes(writeback.outcome),'invalid_writeback');
  need(digest(pkg.identity)===digest(previous.identity)&&pkg.rootDigest===previous.rootDigest
    &&pkg.baseIdentity===expanded.baselineDigest&&digest(pkg.scope)===digest(expanded.scope)
    &&digest(pkg.checks)===digest(previous.checks)&&!Object.hasOwn(pkg,'handoff'),'writeback_package_mismatch');
  need(digest(pkg.changes.filter(file=>file.path!=='AGENTS.md'))===digest(previous.changes.filter(file=>file.path!=='AGENTS.md')),'writeback_package_mismatch');
  need(digest(pkg.requirements.filter(file=>file.path!=='AGENTS.md'))===digest(previous.requirements.filter(file=>file.path!=='AGENTS.md')),'writeback_package_mismatch');
  const change=pkg.changes.find(file=>file.path==='AGENTS.md'),agents=change?.after??pkg.requirements.find(file=>file.path==='AGENTS.md');
  need(agents&&agents.sha256===writeback.agentsFile.sha256&&agents.size<=256*1024,'writeback_package_mismatch');
  const before=baseline.files.find(file=>file.path==='AGENTS.md')??null;
  const priorChange=previous.changes.find(file=>file.path==='AGENTS.md');
  const priorAgents=priorChange?priorChange.after:before;
  need(agents.mode===(before?.mode??0o644),'writeback_package_mismatch');
  if(change)need(digest(change.before)===digest(before)&&digest(change.after)===digest(agents),'writeback_package_mismatch');
  if(writeback.changed)need(change&&digest(agents)!==digest(priorAgents),'writeback_package_mismatch');
  else need(digest(change??null)===digest(priorChange??null)&&digest(agents)===digest(priorAgents),'writeback_package_mismatch');
  return pkg;
}

export function prepareFixLearningWriteback(options){
  shape(options,['identity','codeProject','learning','retrospective','baseline','reviewPackage']);
  const {identity}=options;validIdentity(identity);
  need(/^T-FIX-[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(identity.taskId),'invalid_fix_identity');
  const root=fs.realpathSync(options.codeProject);
  need(root===options.codeProject,'writeback_root_unsafe');
  const learning=inspectFixLearning(options.learning),baseline=readReviewBaseline(options.baseline),pkg=readReviewPackage(options.reviewPackage);
  need(digest(identity)===digest(baseline.identity),'identity_mismatch');
  need(pkg.checks.length>0&&pkg.checks.every(check=>check.outcome==='passed'),'writeback_checks_required');
  const retrospective=inspectFixRetrospective(options.retrospective,{identity,learningDigest:digest(learning),packageDigest:pkg.packageDigest});
  const expected=learning.files.find(file=>file.path==='AGENTS.md')??null;
  const binding=json({identity,learningDigest:digest(learning),retrospectiveDigest:digest(retrospective),packageDigest:pkg.packageDigest});
  const verify=()=>{
    verifyReviewPackage({root,baseline,checks:pkg.checks,reviewPackage:pkg,expectedDigest:pkg.packageDigest});
    const evidence=[...new Set(retrospective.content.candidates.flatMap(candidate=>candidate.evidence))];
    if(evidence.length)readReviewSourceFiles(root,evidence);
  };
  verify();let used=false;
  return Object.freeze({binding,execute({authorized=false,register}){
    need(authorized===true,'learning_writeback_authorization_required');need(!used,'learning_writeback_already_attempted');
    need(typeof register==='function','learning_writeback_registration_required');verify();
    used=true;const registration=register(binding);
    if(types.isPromise(registration))Promise.prototype.then.call(registration,()=>{},()=>{});
    need(registration===undefined,'learning_writeback_sync_registration_required');
    verify();
    const result=writeProjectLearningContent({codeProject:root,expected,identity,feature:`fix-${identity.taskId.slice(6)}`,
      content:retrospective.content});
    return inspectFixLearningWriteback({...binding,...result,completionEligible:false},{identity,learning,retrospective});
  }});
}
