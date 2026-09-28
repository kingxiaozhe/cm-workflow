// Content composition only. This does not authenticate a review or clear a gate.
import {captureReviewBaseline,compareReviewInventoryToBaseline,readReviewBaseline,readReviewPackage} from './review-package.mjs';
import {verifySpecificationMaterial} from './specification-material.mjs';
import {CONFIG_FILENAMES} from '../../../scripts/cm-workflow-config.mjs';
import {digest,hex,id,json,need,shape,text} from './effect-contract.mjs';

const inventoryFile=({contentBase64,...metadata})=>metadata;
const sameFile=(a,b)=>digest(a===null?null:inventoryFile(a))===digest(b===null?null:inventoryFile(b));
const MAX_STEPS=64,MAX_STEP_CHANGES=256;

// Later reviewed deliveries of other runs that a QA fix was built on top of,
// recorded as metadata-only before->after transitions and the index of the fix
// they precede. They are durable association data, so replay never needs the
// other runs' stores; an empty list is the historical strict composition.
function readSteps(raw,fixCount){
  need(Array.isArray(raw)&&raw.length<=MAX_STEPS,'fix_association_invalid');
  let previous=0;const seen=new Set();
  for(const step of raw){
    shape(step,['beforeFix','runId','packageDigest','changes']);
    need(Number.isInteger(step.beforeFix)&&step.beforeFix>=previous&&step.beforeFix<fixCount,'fix_association_invalid');
    previous=step.beforeFix;id(step.runId);hex(step.packageDigest);
    need(!seen.has(step.packageDigest),'fix_association_invalid');seen.add(step.packageDigest);
    need(Array.isArray(step.changes)&&step.changes.length>0&&step.changes.length<=MAX_STEP_CHANGES,'fix_association_invalid');
    const paths=new Set();
    for(const change of step.changes){
      shape(change,['path','before','after']);text(change.path);
      need(!paths.has(change.path)&&(change.before!==null||change.after!==null),'fix_association_invalid');paths.add(change.path);
      for(const file of [change.before,change.after])if(file!==null){
        shape(file,['path','type','mode','size','sha256']);hex(file.sha256);
        need(file.path===change.path&&file.type==='file'&&Number.isInteger(file.mode)&&Number.isSafeInteger(file.size)
          &&file.size>=0,'fix_association_invalid');
      }
    }
  }
  return raw;
}
const stepFor=(runId,pkg,beforeFix)=>({beforeFix,runId,packageDigest:pkg.packageDigest,changes:pkg.changes.map(change=>
  ({path:change.path,before:change.before&&inventoryFile(change.before),after:change.after&&inventoryFile(change.after)}))});

function bindChain({baseline,parentPackage,fixPackages}){
  const base=readReviewBaseline(baseline),parent=readReviewPackage(parentPackage);
  need(Array.isArray(fixPackages)&&fixPackages.length>0&&fixPackages.length<=2,'fix_chain_invalid');
  const fixes=fixPackages.map(readReviewPackage);
  need(parent.baseIdentity===base.baselineDigest&&parent.rootDigest===base.rootDigest
    &&digest(parent.identity)===digest(base.identity),'fix_parent_binding_mismatch');
  for(const fix of fixes)need(fix.rootDigest===parent.rootDigest&&fix.identity.repositoryId===parent.identity.repositoryId
    &&fix.identity.runId!==parent.identity.runId,'fix_parent_binding_mismatch');
  need(new Set(fixes.map(fix=>fix.identity.runId)).size===fixes.length,'fix_chain_invalid');
  return {base,parent,fixes};
}
const applyTo=expected=>pkg=>{
  for(const change of pkg.changes){
    need(sameFile(expected.get(change.path)??null,change.before),'fix_before_mismatch');
    if(change.after===null)expected.delete(change.path);else expected.set(change.path,change.after);
  }
};
// Strict order: parent, then for each fix its recorded preceding steps and the fix.
// stopBefore returns the expected tree just before that fix is applied.
function composeState({base,parent,fixes},steps,stopBefore=null){
  const expected=new Map(base.files.map(file=>[file.path,file])),apply=applyTo(expected);
  apply(parent);
  for(const [index,fix] of fixes.entries()){
    steps.filter(step=>step.beforeFix===index).forEach(apply);
    if(index===stopBefore)break;
    apply(fix);
  }
  return expected;
}

export function composeFixCode({baseline,parentPackage,fixPackages,steps=[]}){
  const chain=bindChain({baseline,parentPackage,fixPackages}),{base,parent,fixes}=chain;
  const recorded=readSteps(json(steps),fixes.length);
  // Metadata-only transitions cannot rebuild legacy full-content inventories.
  need(!recorded.length||base.version===2,'fix_before_mismatch');
  const files=[...composeState(chain,recorded).values()].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
  // Use the same canonical inventory for live association and journal replay.
  return {base,parent,fixes,files:base.version===1?files:files.map(inventoryFile)};
}

// The newest fix may have been built after another task's reviewed delivery
// changed a file it touches. Insert only deliveries on its files whose own
// reviewed before-state matches, until its before-states hold; earlier fixes
// keep their recorded steps. A wrong choice cannot pass: composition is strict.
function interleaveNewestFix({baseline,parentPackage,fixPackages,steps,pool}){
  const chain=bindChain({baseline,parentPackage,fixPackages}),newest=chain.fixes.length-1;
  const chosen=[...readSteps(json(steps),chain.fixes.length)];
  const touched=new Set(chain.fixes[newest].changes.map(change=>change.path));
  while(chosen.length<=MAX_STEPS){
    const expected=composeState(chain,chosen,newest);
    const at=p=>expected.get(p)??null;
    if(chain.fixes[newest].changes.every(change=>sameFile(at(change.path),change.before)))return chosen;
    const used=new Set(chosen.map(step=>step.packageDigest));
    const next=pool.find(({pkg})=>!used.has(pkg.packageDigest)&&pkg.rootDigest===chain.base.rootDigest
      &&pkg.changes.some(change=>touched.has(change.path))
      &&pkg.changes.every(change=>sameFile(at(change.path),change.before))
      &&!pkg.changes.every(change=>sameFile(at(change.path),change.after)));
    need(next,'fix_before_mismatch');
    chosen.push(stepFor(next.runId,next.pkg,newest));
  }
  need(false,'fix_before_mismatch');
}

// A completed run's reviewed package is history: other task runs may deliver
// later, separately reviewed changes on top of it (their AGENTS.md learning
// lines, their own files, even this run's files). Every path that now differs
// from this run's own reviewed composition must be exactly such a transition,
// applied only when its reviewed before-state is the current expected state.
// The root CM workflow config outside this run's scope is user-editable policy,
// not delivered code, and is the one tolerated unreviewed difference.
export function explainReviewedDrift({root,baseline,composed,ownScope,deliveries,exclude=[]}){
  const base=readReviewBaseline(baseline);
  const original=new Map(base.files.map(file=>[file.path,inventoryFile(file)]));
  const expected=new Map(composed.map(file=>[file.path,inventoryFile(file)]));
  const skip=new Set(exclude);
  const pool=deliveries.flatMap(delivery=>delivery.packages.map(readReviewPackage)).filter(pkg=>!skip.has(pkg.packageDigest));
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
  // Content and mode: a permission change is a change to a reviewed file record.
  const state=(map,p)=>map.has(p)?`${map.get(p).sha256}:${map.get(p).mode}`:null;
  const wanted=new Map([...new Set([...original.keys(),...expected.keys()])]
    .filter(p=>state(original,p)!==state(expected,p)).map(p=>[p,state(expected,p)]));
  const actual=new Map(compareReviewInventoryToBaseline(root,base,{withMode:true})
    .map(row=>[row.path,row.sha256===null?null:`${row.sha256}:${row.mode}`]));
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

// steps: the latest accepted record's recorded interleaving. extend: the last
// package is a new fix whose own preceding deliveries may still be missing.
export function inspectFixCodeAssociation({root,specsRoot,baseline,parentPackage,fixPackage,fixPackages,steps=[],extend=false,deliveries=null}){
  const chainPackages=fixPackages??[fixPackage];
  let loaded=null;
  const available=()=>{
    need(typeof deliveries==='function','fix_current_code_unexplained');
    return loaded??=deliveries();
  };
  let recorded=steps;
  if(extend&&typeof deliveries==='function'){
    try{composeFixCode({baseline,parentPackage,fixPackages:chainPackages,steps});}
    catch(error){
      if(error.code!=='fix_before_mismatch')throw error;
      recorded=interleaveNewestFix({baseline,parentPackage,fixPackages:chainPackages,steps,
        pool:available().flatMap(delivery=>delivery.packages.map(pkg=>({runId:delivery.runId,pkg:readReviewPackage(pkg)})))});
    }
  }
  const {base,parent,fixes,files}=composeFixCode({baseline,parentPackage,fixPackages:chainPackages,steps:recorded});
  if(base.specification)verifySpecificationMaterial(base);
  const current=captureReviewBaseline({root,
    ...(base.specification?{specification:{specsRoot:base.specificationRoot,feature:base.specification.feature}}:{}),...(specsRoot===undefined?{}:{specsRoot}),identity:parent.identity,version:base.version,
    ...(base.codeProjectPaths?{codeProjectPaths:base.codeProjectPaths}:{}),
    scope:[...new Set([...parent.scope,...fixes.flatMap(fix=>fix.scope)])],requirements:base.requirements});
  need(current.rootDigest===base.rootDigest,'fix_parent_binding_mismatch');
  const compared=base.version===1?current.files:current.files.map(inventoryFile);
  // The association binds the reviewed fix-chain composition, including any
  // recorded interleaved deliveries (version 2). Other later deliveries are
  // verified live and never enter it, so replay needs no other run's store.
  if(digest(compared)!==digest(files)){
    explainReviewedDrift({root,baseline:base,composed:files,ownScope:[...parent.scope,...fixes.flatMap(fix=>fix.scope)],
      deliveries:available(),exclude:recorded.map(step=>step.packageDigest)});
  }
  return associationRecord({parent,fixes,files,steps:recorded});
}
export function associationRecord({parent,fixes,files,steps}){
  return json({version:steps.length?2:1,kind:'cm-fix-code-association',parentPackageDigest:parent.packageDigest,
    fixPackageDigest:fixes.at(-1).packageDigest,currentFilesDigest:digest(files),...(steps.length?{laterDeliveries:steps}:{})});
}
