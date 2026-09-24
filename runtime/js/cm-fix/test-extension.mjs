// Additive revision evidence. Coverage observations never replace the original red.
import {readReviewBaseline,readReviewSourceFiles} from '../cm-ai/review-package.mjs';
import {validateDeveloperScope} from '../cm-ai/developer-adapter.mjs';
import {digest,json,need,shape,text} from '../cm-ai/effect-contract.mjs';
import {inspectFixBaseline} from './baseline.mjs';

export const inventory=files=>files.map(({contentBase64,...metadata})=>metadata).sort((a,b)=>a.path.localeCompare(b.path));
export function readTestExtensionPlan(raw,{configuration,feedback,files}){
  const value=json(raw);shape(value,['testFiles','command','reason','findingIds']);
  validateDeveloperScope(value.testFiles);text(value.reason);
  need(value.reason.trim().length>0&&value.reason.length<=2000&&Array.isArray(value.command)&&value.command.length>0,'fix_test_extension_invalid');
  value.command.forEach(text);
  need(feedback.review.verdict==='changes_requested'&&Array.isArray(value.findingIds)&&value.findingIds.length>0
    &&new Set(value.findingIds).size===value.findingIds.length
    &&value.findingIds.every(id=>feedback.review.findings.some(f=>f.id===id)),'fix_test_extension_finding_required');
  const existingTests=[...configuration.redTest.testFiles,...configuration.baseline.testFiles];
  need(value.testFiles.every(file=>!configuration.repair.scope.some(source=>source.toLowerCase()===file.toLowerCase())
    &&(existingTests.includes(file)||!files.some(old=>old.path.toLowerCase()===file.toLowerCase()))),'fix_test_extension_scope');
  return value;
}
export const extensionConfig=(configuration,plan)=>({cwd:configuration.redTest.cwd,testFiles:plan.testFiles,
  commands:[{id:'revision-tests',command:plan.command}],timeoutMs:configuration.redTest.timeoutMs});
export function inspectExtensionCheck(raw,configuration,plan,files){
  return inspectFixBaseline(raw,extensionConfig(configuration,plan),files);
}
export function currentTestFiles(original,extension){
  if(!extension)return original;
  const changed=new Map(extension.files.map(file=>[file.path,file]));
  return original.map(file=>changed.get(file.path)??file);
}
export function verifyExtensionFiles(cwd,extension){
  if(extension)need(digest(inventory(readReviewSourceFiles(cwd,extension.plan.testFiles)))===digest(extension.files),'fix_test_extension_drift');
}
export function extendRevisionReviewBaseline(original,author){
  if(!author)return original;
  const {baselineDigest,...body}=readReviewBaseline(original),before=readReviewBaseline(author);
  const material=new Map(before.files.map(file=>[file.path,file]));
  body.scope=[...new Set([...body.scope,...before.scope])].sort();
  body.files=body.files.map(file=>{
    if(Object.hasOwn(file,'contentBase64')||!before.scope.includes(file.path))return file;
    const full=material.get(file.path);
    need(full&&digest(inventory([full]))===digest(inventory([file])),'fix_revision_source_mismatch');return full;
  });
  return readReviewBaseline({...body,baselineDigest:digest(body)});
}
