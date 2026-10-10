// Documentation is part of the existing durable developer invocation, before
// checks/Learning/handoff/review. This adapter grants no additional file scope.
import {isFinalCmAiTask} from './cm-ai-admission.mjs';
import {captureReviewBaseline} from './review-package.mjs';
import {digest,json,shape,need,terminalFor,boundedReason} from './effect-contract.mjs';

export function validateDocumentationPaths(raw,scope){
  const paths=json(raw);
  need(Array.isArray(paths)&&new Set(paths).size===paths.length);
  for(const file of paths){
    need(typeof file==='string'&&scope.includes(file),'documentation_scope_required');
    need(/\.md$/i.test(file)&&!file.split('/').some(part=>
      ['.git','.claude','.codex','.reviews','agents.md','claude.md','tasks.md'].includes(part.toLowerCase())),
    'protected_scope');
  }
  return paths;
}

// Q16/Q17: the code root as documentation_sync sees it, split into the
// documentation paths (each path's sha256, null when absent) and one digest
// of everything else. The runner records it when the sync starts and compares
// a later state with it before it re-asks only documentation_sync: the
// documentation paths decide whether the writer changed anything, the rest
// must be exactly as the sync found it (the writer may touch nothing else).
// requirements: paths; specification: {specsRoot,feature} or null.
export function captureDocumentationState({root,specsRoot,identity,paths,requirements,specification=null}){
  const baseline=captureReviewBaseline({root,specsRoot,identity,scope:paths,requirements,
    ...(specification?{specification}:{})});
  const others=baseline.files.filter(file=>!paths.includes(file.path));
  return {files:baseline.files,documents:paths.map(file=>({path:file,
    sha256:baseline.files.find(item=>item.path===file)?.sha256??null})),othersDigest:digest(others)};
}
// Paths outside the documentation paths that differ between two captures.
export function documentationOutOfScopePaths(before,after,paths){
  const index=files=>new Map(files.filter(file=>!paths.includes(file.path)).map(file=>[file.path,digest(file)]));
  const a=index(before),b=index(after);
  return [...new Set([...a.keys(),...b.keys()])].filter(file=>a.get(file)!==b.get(file)).sort();
}
const fail=(code,message=code)=>Object.assign(new Error(message),{code});

export function withHostDocumentation({developer,documentationSync,specsDir,codeProject,feature,scope,parallelSelection=null,featureSelection}){
  shape(documentationSync,['paths','run']);need(typeof documentationSync.run==='function');
  const paths=validateDocumentationPaths(documentationSync.paths,scope),run=documentationSync.run;
  need(paths.length>0);
  return {...developer,run:async(request,control)=>{
    // A documentation-only redo (task-runner: documentation-sync-retry) reuses
    // the developer answer journaled when the failed sync started; the
    // developer is never asked again.
    const redo=control.documentationRedo;
    if(redo!==undefined)shape(redo,['result','effectiveModel']);
    const response=terminalFor(redo!==undefined?{version:1,invocationId:request.invocationId,contextId:request.contextId,
      provider:request.provider,effectiveModel:redo.effectiveModel,status:'succeeded',accepted:true,result:redo.result}
      :await developer.run(request,control),request);
    if(response.status!=='succeeded')return response;
    need(!control.signal.aborted,'cancelled');
    if(!isFinalCmAiTask({specsDir,codeProject,feature,taskId:request.identity.taskId,parallelSelection,featureSelection})){
      need(redo===undefined,'documentation_redo_mismatch');return response;
    }
    const capture=()=>captureDocumentationState({root:codeProject,specsRoot:specsDir,identity:request.identity,paths,
      requirements:request.payload.requirements.map(file=>file.path),
      specification:request.payload.specification?{specsRoot:specsDir,feature}:null});
    const before=capture();
    // The runner journals the developer answer and this start before the sync
    // is asked, so a lost sync can be re-asked alone.
    if(typeof control.onDocumentationSync==='function')control.onDocumentationSync({result:response.result,
      effectiveModel:response.effectiveModel,documents:before.documents,othersDigest:before.othersDigest});
    const result=json(await run(json({identity:request.identity,invocationId:request.invocationId,
      specsDir,codeProject,feature,paths}),control.signal));
    need(!control.signal.aborted,'cancelled');
    try{shape(result,['status']);need(['completed','blocked'].includes(result.status));}
    catch{throw fail('documentation_sync_answer_invalid');}
    need(result.status==='completed','documentation_sync_blocked');
    const after=capture();
    if(after.othersDigest!==before.othersDigest)throw fail('out_of_scope',
      boundedReason('out_of_scope: ',documentationOutOfScopePaths(before.files,after.files,paths),''));
    return response;
  }};
}
