// Content composition only. This does not authenticate a review or clear a gate.
import {captureReviewBaseline,readReviewBaseline,readReviewPackage} from './review-package.mjs';
import {digest,json,need} from './effect-contract.mjs';

export function composeFixCode({baseline,parentPackage,fixPackages}){
  const base=readReviewBaseline(baseline),parent=readReviewPackage(parentPackage);
  need(Array.isArray(fixPackages)&&fixPackages.length>0&&fixPackages.length<=2,'fix_chain_invalid');
  const fixes=fixPackages.map(readReviewPackage);
  need(parent.baseIdentity===base.baselineDigest&&parent.rootDigest===base.rootDigest
    &&digest(parent.identity)===digest(base.identity),'fix_parent_binding_mismatch');
  for(const fix of fixes)need(fix.rootDigest===parent.rootDigest&&fix.identity.repositoryId===parent.identity.repositoryId
    &&fix.identity.runId!==parent.identity.runId,'fix_parent_binding_mismatch');
  need(new Set(fixes.map(fix=>fix.identity.runId)).size===fixes.length,'fix_chain_invalid');
  const expected=new Map(base.files.map(file=>[file.path,file]));
  const apply=pkg=>{
    for(const change of pkg.changes){
      need(digest(expected.get(change.path)??null)===digest(change.before),'fix_before_mismatch');
      if(change.after===null)expected.delete(change.path);else expected.set(change.path,change.after);
    }
  };
  apply(parent);fixes.forEach(apply);
  const files=[...expected.values()].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
  return {base,parent,fixes,files};
}

export function inspectFixCodeAssociation({root,specsRoot,baseline,parentPackage,fixPackage,fixPackages}){
  const {base,parent,fixes,files}=composeFixCode({baseline,parentPackage,fixPackages:fixPackages??[fixPackage]});
  const current=captureReviewBaseline({root,...(specsRoot===undefined?{}:{specsRoot}),identity:parent.identity,
    scope:[...new Set([...parent.scope,...fixes.flatMap(fix=>fix.scope)])],requirements:base.requirements});
  need(current.rootDigest===base.rootDigest,'fix_parent_binding_mismatch');
  need(digest(current.files)===digest(files),'fix_current_code_unexplained');
  return json({version:1,kind:'cm-fix-code-association',parentPackageDigest:parent.packageDigest,
    fixPackageDigest:fixes.at(-1).packageDigest,currentFilesDigest:digest(current.files)});
}
