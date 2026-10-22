// Explicit, one-run integration evidence. Ordinary delivery discovery remains
// strict. This module never opens a writer, edits a product, or dispatches work.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {digest,hex,id,json,need,shape,validIdentity} from './effect-contract.mjs';
import {readReviewBaseline,readReviewPackage} from './review-package.mjs';
import {readExecutionSnapshot} from './execution-snapshot.mjs';
import {readRunnerHistory} from './durable-runner-state.mjs';
import {approvedReviewAt,completedReviewedDeliveries} from './reviewed-deliveries.mjs';
import {explainIntegratedDelivery,firstReviewAt} from './fix-code-association.mjs';
import {inspectFixFinalRegistration,inspectFixFinalResult} from '../cm-fix/final-review.mjs';
import {readIntegrationSnapshots,assertSnapshotBoundaries,verifySnapshotReview} from './integration-snapshots.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const absolute=value=>need(typeof value==='string'&&path.isAbsolute(value)&&path.normalize(value)===value
  &&!/[\x00-\x1f]/.test(value),'integration_path_invalid');
const equal=(a,b,code='integration_binding_mismatch')=>need(digest(a)===digest(b),code);
const canonical=value=>Buffer.from(JSON.stringify(value)+'\n');
const meta=({contentBase64,...value})=>value;
const learningPaths=records=>records.flatMap(row=>row.payload.type==='effect-intent'
  ?(row.payload.effect.learningInput?.learningFiles??[]).filter(file=>file.scope==='project').map(file=>file.path):[]);
const documentPath=value=>typeof value==='string'&&/^docs\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.md$/.test(value)
  &&!value.split('/').some(part=>part==='.'||part==='..'||/^(?:AGENTS|CLAUDE|SKILL)\.md$/i.test(part));

export function readIntegrationPlan(raw){
  const plan=json(raw,128*1024);shape(plan,['version','kind','author','target','sources','documents',
    ...(Object.hasOwn(plan,'snapshots')?['snapshots']:[])]);
  if(Object.hasOwn(plan,'snapshots'))readIntegrationSnapshots(plan.snapshots);
  need(plan.version===1&&plan.kind==='cm-reviewed-integration-v1','integration_plan_invalid');
  shape(plan.author,['provider','contextId']);need(plan.author.provider==='codex','integration_author_invalid');id(plan.author.contextId);
  const target=plan.target;shape(target,['identity','rootDigest','baselineDigest','packageDigest','recordCount','lastDigest']);
  validIdentity(target.identity);
  for(const key of ['rootDigest','baselineDigest','packageDigest','lastDigest'])hex(target[key]);
  need(Number.isSafeInteger(target.recordCount)&&target.recordCount>0&&target.recordCount<1024,'integration_plan_invalid');
  need(Array.isArray(plan.sources)&&plan.sources.length<=64&&Array.isArray(plan.documents)
    &&plan.documents.length<=16&&(plan.sources.length+plan.documents.length+(plan.snapshots?.files.length??0))>0,'integration_plan_invalid');
  const ids=new Set();
  for(const source of plan.sources){
    shape(source,['identity','root','revision','packageDigest']);validIdentity(source.identity);absolute(source.root);
    hex(source.revision);hex(source.packageDigest);
    need(source.identity.runId!==target.identity.runId&&!ids.has(source.identity.runId),'integration_source_invalid');
    ids.add(source.identity.runId);
  }
  const paths=new Set();
  for(const doc of plan.documents){
    shape(doc,['path','before','after']);need(documentPath(doc.path)&&!paths.has(doc.path),'integration_document_invalid');
    paths.add(doc.path);
    for(const file of [doc.before,doc.after]){
      shape(file,['path','type','mode','size','sha256']);
      need(file.path===doc.path&&file.type==='file'&&file.mode===0o644&&Number.isSafeInteger(file.size)
        &&file.size>=0&&file.size<=256*1024,'integration_document_invalid');hex(file.sha256);
    }
    need(doc.before.sha256!==doc.after.sha256,'integration_document_invalid');
  }
  return plan;
}

function bindTarget(plan,baseline,parentPackage,records){
  const base=readReviewBaseline(baseline),pkg=readReviewPackage(parentPackage),target=plan.target;
  need(base.version===2&&pkg.baseIdentity===base.baselineDigest&&pkg.rootDigest===base.rootDigest,'integration_binding_mismatch');
  equal(pkg.identity,base.identity);equal(target.identity,pkg.identity);
  need(target.rootDigest===base.rootDigest&&target.baselineDigest===base.baselineDigest
    &&target.packageDigest===pkg.packageDigest&&target.recordCount===records.length
    &&target.lastDigest===records.at(-1)?.digest,'integration_binding_mismatch');
  for(const doc of plan.documents)need(pkg.scope.includes(doc.path),'integration_document_invalid');
  assertSnapshotBoundaries(plan.snapshots,base,[pkg],learningPaths(records));
  return {base,pkg};
}

// Pure replay validates the exact prefix and keeps historical completion intact.
// Live use also reopens the pinned review and source stores; absence never clears
// a gate merely because this record could be parsed.
export function validateIntegrationRecord({record,baseline,parentPackage,records}){
  const value=json(record,256*1024);shape(value,['version','plan','reviewFile','reason','planDigest']);
  need(value.version===1&&value.reason==='Explicit reviewed integration','integration_record_invalid');
  const plan=readIntegrationPlan(value.plan);equal(value.planDigest,digest(plan));
  shape(value.reviewFile,['path','sha256']);absolute(value.reviewFile.path);hex(value.reviewFile.sha256);
  bindTarget(plan,baseline,parentPackage,records);return value;
}

function readPinnedJson(file){
  absolute(file);need(fs.realpathSync(file)===file,'integration_path_invalid');
  const stat=fs.lstatSync(file);need(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1&&stat.size<=12*1024*1024,'integration_evidence_invalid');
  const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));
  try{
    const opened=fs.fstatSync(fd);need(opened.dev===stat.dev&&opened.ino===stat.ino,'integration_evidence_changed');
    const bytes=fs.readFileSync(fd),end=fs.fstatSync(fd),named=fs.lstatSync(file);
    need(end.dev===stat.dev&&end.ino===stat.ino&&end.size===stat.size&&end.mtimeMs===stat.mtimeMs
      &&end.ctimeMs===stat.ctimeMs&&named.ino===stat.ino&&named.dev===stat.dev&&named.nlink===1,'integration_evidence_changed');
    const value=JSON.parse(bytes.toString('utf8'));
    need(bytes.equals(canonical(value)),'integration_evidence_invalid');
    return {value,reference:{path:file,sha256:sha(bytes)}};
  }finally{fs.closeSync(fd);}
}
export function readIntegrationEvidenceFile(file){
  const {value,reference}=readPinnedJson(file);shape(value,['plan','review']);
  return {evidence:{plan:readIntegrationPlan(value.plan),review:value.review},reference};
}
export const readIntegrationEvidence=file=>readIntegrationEvidenceFile(file).evidence;

// rev-parse only, with a project-external executable and no inherited Git
// environment. No hooks, target programs, filters or working-tree writes.
function gitCommonDir(root,excludedRoots){
  need(fs.realpathSync(root)===root,'integration_source_invalid');
  const inside=(dir,file)=>file===dir||file.startsWith(dir+path.sep);
  const untrusted=file=>excludedRoots.some(dir=>inside(dir,file));
  let bin=null;const safe=[];
  for(const directory of (process.env.PATH??'').split(path.delimiter)){
    if(!directory||!path.isAbsolute(directory))continue;
    try{
      const dir=fs.realpathSync(directory);if(untrusted(dir))continue;safe.push(dir);
      const candidate=fs.realpathSync(path.join(dir,process.platform==='win32'?'git.exe':'git'));
      if(!bin&&!untrusted(candidate)&&fs.statSync(candidate).isFile()){fs.accessSync(candidate,fs.constants.X_OK);bin=candidate;}
    }catch{}
  }
  need(bin,'integration_git_unavailable');
  const run=args=>spawnSync(bin,['--no-optional-locks','-c','core.fsmonitor=false','-C',root,...args],{
    env:{PATH:safe.join(path.delimiter),HOME:os.tmpdir(),USERPROFILE:os.tmpdir(),LANG:'C',LC_ALL:'C',
      GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:os.devNull,GIT_NO_REPLACE_OBJECTS:'1',GIT_NO_LAZY_FETCH:'1',GIT_TERMINAL_PROMPT:'0',
      ...(process.env.SystemRoot?{SystemRoot:process.env.SystemRoot}:{})},
    timeout:5000,maxBuffer:65536});
  const result=run(['rev-parse','--path-format=absolute','--show-toplevel','--git-common-dir']);
  need(!result.error&&result.status===0,'integration_git_unavailable');
  const lines=result.stdout.toString('utf8').trim().split('\n');
  need(lines.length===2&&fs.realpathSync(lines[0])===root,'integration_source_invalid');
  const listing=run(['worktree','list','--porcelain','-z']);
  need(!listing.error&&listing.status===0&&listing.stdout.toString('utf8').split('\0')
    .filter(line=>line==='worktree '+root).length===1,'integration_worktree_mismatch');
  return fs.realpathSync(lines[1]);
}

function hasRename(deliveries,from,to,before){
  const matches=deliveries.flatMap(row=>row.packages).filter(({pkg,reviewedAt})=>{
    if(pkg.identity.repositoryId!==from||!Number.isSafeInteger(reviewedAt)||reviewedAt>=before)return false;
    const change=pkg.changes.find(row=>row.path==='package.json');
    if(!change?.before?.contentBase64||!change?.after?.contentBase64)return false;
    try{return JSON.parse(Buffer.from(change.before.contentBase64,'base64')).name===from
      &&JSON.parse(Buffer.from(change.after.contentBase64,'base64')).name===to;}catch{return false;}
  });
  need(matches.length===1,'integration_repository_transition_unverified');
}

function resolveSources(plan,{root,specsRoot,deliveries,after}){
  let common=null;const roots=new Map(),result=[];
  const excludedRoots=[root,specsRoot,...plan.sources.map(item=>item.root)];
  for(const source of plan.sources){
    const snapshot=readExecutionSnapshot({specsRoot,identity:{repositoryId:source.identity.repositoryId,runId:source.identity.runId}});
    need(snapshot.revision===source.revision,'integration_source_changed');
    const init=snapshot.records[0]?.payload;
    need(init?.protocol==='cm-task-runner'&&init.version===3&&init.type==='init','integration_source_invalid');
    const history=readRunnerHistory(snapshot.records,init.config,3),state=history.state;
    need(history.pending===null&&state.state==='fixture_completed'&&state.taskCommit?.outcome==='fixture_committed'
      &&history.acceptedFixes.length===0&&!history.acceptedIntegration,'integration_source_not_completed');
    const pkg=readReviewPackage(state.reviewPackage),reviewedAt=approvedReviewAt(state);
    equal(pkg.identity,source.identity);
    need(pkg.packageDigest===source.packageDigest&&init.config.root===source.root
      &&pkg.rootDigest===sha(source.root)&&Number.isSafeInteger(reviewedAt)&&reviewedAt>after,'integration_source_invalid');
    need(source.root!==root||source.identity.repositoryId!==plan.target.identity.repositoryId,'integration_mapping_unnecessary');
    need(fs.realpathSync(source.root)===source.root,'integration_source_invalid');
    if(source.root!==root){
      common??=gitCommonDir(root,excludedRoots);
      if(!roots.has(source.root))roots.set(source.root,gitCommonDir(source.root,excludedRoots));
      need(roots.get(source.root)===common,'integration_worktree_mismatch');
    }
    if(source.identity.repositoryId!==plan.target.identity.repositoryId){
      need(source.root===root,'integration_repository_transition_unverified');
      hasRename(deliveries,plan.target.identity.repositoryId,source.identity.repositoryId,reviewedAt);
    }
    result.push({runId:source.identity.runId,root:source.root,taskId:source.identity.taskId,
      learningPaths:learningPaths(snapshot.records),packages:[{pkg,reviewedAt}]});
  }
  return result;
}

function verifyReview(review,plan,records){
  need(review!==null,'integration_review_required');
  shape(review,['configuration','registration','started','result']);
  need(review.configuration?.reviewVerification,'integration_verification_required');
  const registration=inspectFixFinalRegistration(review.registration,review.configuration);
  const checked=inspectFixFinalResult(review.result,registration,review.configuration,review.started);
  need(checked.observationStatus==='completed'&&checked.review.verdict==='approved','integration_review_not_approved');
  const pkg=readReviewPackage(registration.request.payload.reviewPackage);
  const config=records[0].payload.config;
  const previousThreads=readRunnerHistory(records,config,3).reviewerThreads;
  need(pkg.identity.runId!==plan.target.identity.runId
    &&review.configuration.hostContextId===plan.author.contextId
    &&registration.request.provider!==plan.author.provider
    &&!previousThreads.includes(checked.providerThreadId)
    &&checked.providerThreadId!==config.reviewInvocation.developerThreadId,'integration_review_not_independent');
  const file=pkg.requirements.find(item=>item.path==='integration/plan.json')
    ??pkg.changes.find(item=>item.path==='integration/plan.json')?.after;
  need(file?.contentBase64===canonical(plan).toString('base64'),'integration_review_binding_mismatch');
  for(const doc of plan.documents){
    const change=pkg.changes.find(item=>item.path==='integration/documents/'+doc.path);
    for(const side of ['before','after']){
      const file=change?.[side];need(file,'integration_document_not_reviewed');
      equal({...meta(file),path:doc.path},doc[side],'integration_document_not_reviewed');
    }
  }
  verifySnapshotReview(pkg,plan.snapshots);
  return checked;
}

export function verifyReviewedIntegration({root,specsRoot,baseline,parentPackage,records,plan:raw,review=null,requireReview=true}){
  const plan=readIntegrationPlan(raw),{base,pkg}=bindTarget(plan,baseline,parentPackage,records);
  need(fs.realpathSync(root)===root&&sha(root)===base.rootDigest,'integration_binding_mismatch');
  const init=records[0]?.payload,history=readRunnerHistory(records,init.config,init.version);
  need(init.version===3&&history.pending===null&&history.state.state==='fixture_completed'
    &&history.state.taskCommit?.outcome==='fixture_committed'&&history.acceptedFixes.length===0
    &&!history.acceptedIntegration,'integration_parent_not_completed');
  equal(history.state.reviewPackage,pkg);
  const after=approvedReviewAt(history.state),since=firstReviewAt(records,pkg.identity);
  need(Number.isSafeInteger(after)&&Number.isSafeInteger(since),'integration_order_unverified');
  const deliveries=completedReviewedDeliveries({specsRoot,root,identity:pkg.identity});
  const sources=resolveSources(plan,{root,specsRoot,deliveries,after});
  if(plan.snapshots){
    const instructions=[...learningPaths(records),...sources.flatMap(row=>row.learningPaths)];
    // Ordinary discovery intentionally keeps its old return contract. Reopen
    // these already-validated journals only for the new snapshot boundary.
    for(const delivery of deliveries){
      const identity=delivery.packages[0].pkg.identity;
      const saved=readExecutionSnapshot({specsRoot,identity:{repositoryId:identity.repositoryId,runId:identity.runId}});
      if(saved.records[0].payload.protocol==='cm-task-runner'){
        const initial=saved.records[0].payload;
        const current=readRunnerHistory(saved.records,initial.config,initial.version);
        need(current.pending===null&&current.state.state==='fixture_completed'
          &&current.state.taskCommit?.outcome==='fixture_committed'
          &&current.state.reviewPackage?.packageDigest===delivery.packages[0].pkg.packageDigest,'integration_source_changed');
        instructions.push(...learningPaths(saved.records));
      }
    }
    assertSnapshotBoundaries(plan.snapshots,base,[pkg,...[...deliveries,...sources].flatMap(row=>row.packages.map(item=>item.pkg))],instructions);
  }
  if(requireReview)verifyReview(review,plan,records);
  explainIntegratedDelivery({root,baseline:base,parentPackage:pkg,deliveries,after,since,sources,documents:plan.documents,snapshots:plan.snapshots});
  // Source snapshots may change while Git and tree comparisons run. Refuse
  // before adoption; this does not authorize rereading a newer revision.
  for(const source of plan.sources)need(readExecutionSnapshot({specsRoot,identity:{repositoryId:source.identity.repositoryId,
    runId:source.identity.runId}}).revision===source.revision,'integration_source_changed');
  return {version:1,planDigest:digest(plan),eligibleForAdoption:requireReview,code:requireReview?null:'integration_review_required',
    paths:[],sourceCount:sources.length};
}
export function previewReviewedIntegration(input){
  try{return verifyReviewedIntegration({...input,requireReview:input.review!=null});}
  catch(error){return {version:1,planDigest:digest(input.plan),eligibleForAdoption:false,
    code:typeof error.code==='string'?error.code:'integration_evidence_invalid',
    paths:Array.isArray(error.paths)?error.paths:[],sourceCount:input.plan?.sources?.length??0};}
}
