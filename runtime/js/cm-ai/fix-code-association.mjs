// Content composition only. This does not authenticate a review or clear a gate.
import {captureReviewBaseline,compareReviewInventoryToBaseline,readReviewBaseline,readReviewPackage} from './review-package.mjs';
import {verifySpecificationMaterial} from './specification-material.mjs';
import {CONFIG_FILENAMES} from '../../../scripts/cm-workflow-config.mjs';
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

// A completed run's reviewed package is history: other task runs may deliver
// later, separately reviewed changes on top of it (their AGENTS.md learning
// lines, their own files, even this run's files). Every path that now differs
// from this run's own reviewed composition must be exactly such a transition,
// applied only when its reviewed before-state is the current expected state.
// The root CM workflow config outside this run's scope is user-editable policy,
// not delivered code, and is the one tolerated unreviewed difference.
export function explainReviewedDrift({root,baseline,composed,ownScope,deliveries}){
  const base=readReviewBaseline(baseline);
  const original=new Map(base.files.map(file=>[file.path,inventoryFile(file)]));
  const expected=new Map(composed.map(file=>[file.path,inventoryFile(file)]));
  const pool=deliveries.flatMap(delivery=>delivery.packages.map(readReviewPackage));
  const at=p=>expected.get(p)??null;
  for(let applied=true;applied;){
    applied=false;
    const index=pool.findIndex(pkg=>pkg.rootDigest===base.rootDigest
      &&pkg.changes.every(change=>sameFile(at(change.path),change.before))
      &&!pkg.changes.every(change=>sameFile(at(change.path),change.after)));
    if(index===-1)break;
    for(const change of pool[index].changes){
      if(change.after===null)expected.delete(change.path);else expected.set(change.path,inventoryFile(change.after));
    }
    pool.splice(index,1);applied=true;
  }
  const sha=(map,p)=>map.get(p)?.sha256??null;
  const wanted=new Map([...new Set([...original.keys(),...expected.keys()])]
    .filter(p=>sha(original,p)!==sha(expected,p)).map(p=>[p,sha(expected,p)]));
  const actual=new Map(compareReviewInventoryToBaseline(root,base).map(row=>[row.path,row.sha256]));
  const scope=new Set(ownScope);
  const unexplained=[...new Set([...wanted.keys(),...actual.keys()])]
    .filter(p=>!(CONFIG_FILENAMES.includes(p)&&!scope.has(p))&&wanted.get(p)!==actual.get(p)).sort();
  if(unexplained.length){
    const error=new Error(`fix_current_code_unexplained: ${unexplained.slice(0,20).join(', ')}${unexplained.length>20?` (+${unexplained.length-20} more)`:''}`);
    error.code='fix_current_code_unexplained';error.paths=unexplained;throw error;
  }
}

// Completed run without accepted fixes: its own reviewed composition, then drift.
export function explainCompletedDelivery({root,baseline,parentPackage,deliveries}){
  const base=readReviewBaseline(baseline),parent=readReviewPackage(parentPackage);
  need(parent.baseIdentity===base.baselineDigest&&parent.rootDigest===base.rootDigest
    &&digest(parent.identity)===digest(base.identity),'fix_parent_binding_mismatch');
  if(base.specification)verifySpecificationMaterial(base);
  const expected=new Map(base.files.map(file=>[file.path,inventoryFile(file)]));
  for(const change of parent.changes){
    need(sameFile(expected.get(change.path)??null,change.before),'fix_before_mismatch');
    if(change.after===null)expected.delete(change.path);else expected.set(change.path,inventoryFile(change.after));
  }
  explainReviewedDrift({root,baseline:base,composed:[...expected.values()],ownScope:parent.scope,deliveries});
}

export function inspectFixCodeAssociation({root,specsRoot,baseline,parentPackage,fixPackage,fixPackages,deliveries=null}){
  const {base,parent,fixes,files}=composeFixCode({baseline,parentPackage,fixPackages:fixPackages??[fixPackage]});
  if(base.specification)verifySpecificationMaterial(base);
  const current=captureReviewBaseline({root,
    ...(base.specification?{specification:{specsRoot:base.specificationRoot,feature:base.specification.feature}}:{}),...(specsRoot===undefined?{}:{specsRoot}),identity:parent.identity,version:base.version,
    ...(base.codeProjectPaths?{codeProjectPaths:base.codeProjectPaths}:{}),
    scope:[...new Set([...parent.scope,...fixes.flatMap(fix=>fix.scope)])],requirements:base.requirements});
  need(current.rootDigest===base.rootDigest,'fix_parent_binding_mismatch');
  const compared=base.version===1?current.files:current.files.map(inventoryFile);
  // The association always binds the reviewed fix-chain composition. Later
  // reviewed deliveries of other runs are verified live and never enter it, so
  // journal replay reproduces the record exactly as before.
  if(digest(compared)!==digest(files)){
    need(typeof deliveries==='function','fix_current_code_unexplained');
    explainReviewedDrift({root,baseline:base,composed:files,ownScope:[...parent.scope,...fixes.flatMap(fix=>fix.scope)],
      deliveries:deliveries()});
  }
  return json({version:1,kind:'cm-fix-code-association',parentPackageDigest:parent.packageDigest,
    fixPackageDigest:fixes.at(-1).packageDigest,currentFilesDigest:digest(files)});
}
