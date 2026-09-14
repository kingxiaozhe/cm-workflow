// Content composition only. This does not authenticate a review or clear a gate.
import {captureReviewBaseline,readReviewBaseline,readReviewPackage} from './review-package.mjs';
import {digest,json,need} from './effect-contract.mjs';

const inventoryFile=({contentBase64,...metadata})=>metadata;
const sameFile=(a,b)=>digest(a===null?null:inventoryFile(a))===digest(b===null?null:inventoryFile(b));

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
      need(sameFile(expected.get(change.path)??null,change.before),'fix_before_mismatch');
      if(change.after===null)expected.delete(change.path);else expected.set(change.path,change.after);
    }
  };
  apply(parent);fixes.forEach(apply);
  const files=[...expected.values()].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
  // Use the same canonical inventory for live association and journal replay.
  return {base,parent,fixes,files:base.version===1?files:files.map(inventoryFile)};
}

export function inspectFixCodeAssociation({root,specsRoot,baseline,parentPackage,fixPackage,fixPackages}){
  const {base,parent,fixes,files}=composeFixCode({baseline,parentPackage,fixPackages:fixPackages??[fixPackage]});
  const current=captureReviewBaseline({root,...(specsRoot===undefined?{}:{specsRoot}),identity:parent.identity,version:base.version,
    ...(base.codeProjectPaths?{codeProjectPaths:base.codeProjectPaths}:{}),
    scope:[...new Set([...parent.scope,...fixes.flatMap(fix=>fix.scope)])],requirements:base.requirements});
  need(current.rootDigest===base.rootDigest,'fix_parent_binding_mismatch');
  const compared=base.version===1?current.files:current.files.map(inventoryFile);
  need(digest(compared)===digest(files),'fix_current_code_unexplained');
  return json({version:1,kind:'cm-fix-code-association',parentPackageDigest:parent.packageDigest,
    fixPackageDigest:fixes.at(-1).packageDigest,currentFilesDigest:digest(compared)});
}
