// Documentation is part of the existing durable developer invocation, before
// checks/Learning/handoff/review. This adapter grants no additional file scope.
import {isFinalCmAiTask} from './cm-ai-admission.mjs';
import {captureReviewBaseline} from './review-package.mjs';
import {digest,json,shape,need,terminalFor} from './effect-contract.mjs';

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

export function withHostDocumentation({developer,documentationSync,specsDir,codeProject,feature,scope}){
  shape(documentationSync,['paths','run']);need(typeof documentationSync.run==='function');
  const paths=validateDocumentationPaths(documentationSync.paths,scope),run=documentationSync.run;
  need(paths.length>0);
  return {...developer,run:async(request,control)=>{
    const response=terminalFor(await developer.run(request,control),request);
    if(response.status!=='succeeded')return response;
    need(!control.signal.aborted,'cancelled');
    if(!isFinalCmAiTask({specsDir,codeProject,feature,taskId:request.identity.taskId}))return response;
    const baseline=captureReviewBaseline({root:codeProject,specsRoot:specsDir,identity:request.identity,
      scope:paths,requirements:request.payload.requirements.map(file=>file.path)});
    const result=json(await run(json({identity:request.identity,invocationId:request.invocationId,
      specsDir,codeProject,feature,paths}),control.signal));
    need(!control.signal.aborted,'cancelled');shape(result,['status']);
    need(result.status==='completed','documentation_sync_blocked');
    const after=captureReviewBaseline({root:codeProject,specsRoot:specsDir,identity:request.identity,
      scope:paths,requirements:request.payload.requirements.map(file=>file.path)});
    need(digest(baseline.files.filter(file=>!paths.includes(file.path)))===
      digest(after.files.filter(file=>!paths.includes(file.path))),'out_of_scope');
    return response;
  }};
}
