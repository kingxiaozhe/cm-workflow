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
// The exact recorded form of a real reviewed package; verification re-derives it.
export const deliveryStep=(runId,pkg,beforeFix)=>({beforeFix,runId,packageDigest:pkg.packageDigest,changes:pkg.changes.map(change=>
  ({path:change.path,before:change.before&&inventoryFile(change.before),after:change.after&&inventoryFile(change.after)}))});
// Durable order: only packages whose own review came after the parent's approving
// review count, so a transition reviewed before the parent is never replayed over
// it (for example to disguise an unreviewed revert of the parent's change).
// deliveries: [{runId,packages:[{pkg,reviewedAt}]}].
export const deliveredAfter=(item,after)=>Number.isSafeInteger(after)
  &&Number.isSafeInteger(item.reviewedAt)&&item.reviewedAt>after;
const laterPool=(deliveries,after,rootDigest,exclude=new Set())=>deliveries
  .flatMap(delivery=>delivery.packages.filter(item=>deliveredAfter(item,after))
    .map(item=>({runId:delivery.runId,pkg:readReviewPackage(item.pkg)})))
  .filter(({pkg})=>pkg.rootDigest===rootDigest&&!exclude.has(pkg.packageDigest));

const SEARCH_LIMIT=4096;
const key=file=>file===null||file===undefined?null:`${file.sha256}:${file.mode}`;
const applicable=(state,pkg)=>pkg.changes.every(change=>sameFile(state.get(change.path)??null,change.before))
  &&!pkg.changes.every(change=>sameFile(state.get(change.path)??null,change.after));
const applyMeta=(state,pkg)=>{for(const change of pkg.changes){
  if(change.after===null)state.delete(change.path);else state.set(change.path,inventoryFile(change.after));}};
// Deliveries on disjoint paths are independent; group the ones that share any
// path, transitively, and search each group separately.
function groups(candidates){
  const owner=new Map(),parent=candidates.map((_,index)=>index);
  const find=index=>parent[index]===index?index:(parent[index]=find(parent[index]));
  for(const [index,{pkg}] of candidates.entries())for(const change of pkg.changes){
    if(owner.has(change.path))parent[find(index)]=find(owner.get(change.path));else owner.set(change.path,index);
  }
  const result=new Map();
  for(const index of candidates.keys()){const root=find(index);result.set(root,[...(result.get(root)??[]),index]);}
  return [...result.values()].map(indexes=>indexes.map(index=>candidates[index]));
}
// Shortest set of transitions, each applied from its own reviewed before-state,
// that reaches goal. Breadth first over applied sets (the end state of a valid
// set does not depend on its order), deterministic by candidate order, bounded.
function shortestTransitions(start,candidates,goal){
  if(goal(start))return [];
  const queue=[{state:start,used:[],chain:[]}],seen=new Set(['']);
  for(let visited=0;queue.length&&visited<SEARCH_LIMIT;visited++){
    const {state,used,chain}=queue.shift();
    for(const [index,candidate] of candidates.entries()){
      if(used.includes(index)||!applicable(state,candidate.pkg))continue;
      const nextUsed=[...used,index].sort((a,b)=>a-b),id=nextUsed.join(',');
      if(seen.has(id))continue;seen.add(id);
      const next=new Map(state);applyMeta(next,candidate.pkg);
      if(goal(next))return [...chain,candidate];
      queue.push({state:next,used:nextUsed,chain:[...chain,candidate]});
    }
  }
  return null;
}

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

// The newest fix may have been built after later reviewed deliveries changed a
// file it touches. Insert the shortest set of them, from the groups sharing its
// paths, that yields its reviewed before-states; earlier fixes keep their
// recorded steps. Composition afterwards is strict, so no choice can bypass it.
function interleaveNewestFix({baseline,parentPackage,fixPackages,steps,deliveries,after}){
  const chain=bindChain({baseline,parentPackage,fixPackages}),newest=chain.fixes.length-1;
  const prior=[...readSteps(json(steps),chain.fixes.length)],fix=chain.fixes[newest];
  const touched=new Set(fix.changes.map(change=>change.path));
  const state=new Map([...composeState(chain,prior,newest)].map(([p,file])=>[p,inventoryFile(file)]));
  const pool=laterPool(deliveries,after,chain.base.rootDigest,new Set(prior.map(step=>step.packageDigest)));
  const added=[];
  for(const group of groups(pool).filter(group=>group.some(({pkg})=>pkg.changes.some(change=>touched.has(change.path))))){
    const paths=new Set(group.flatMap(({pkg})=>pkg.changes.map(change=>change.path)));
    const found=shortestTransitions(state,group,next=>fix.changes.filter(change=>paths.has(change.path))
      .every(change=>sameFile(next.get(change.path)??null,change.before)));
    if(!found)continue;
    for(const item of found){applyMeta(state,item.pkg);added.push(deliveryStep(item.runId,item.pkg,newest));}
  }
  need(fix.changes.every(change=>sameFile(state.get(change.path)??null,change.before))&&prior.length+added.length<=MAX_STEPS,'fix_before_mismatch');
  return [...prior,...added];
}

// A completed run's reviewed package is history: other task runs may deliver
// later, separately reviewed changes on top of it (their AGENTS.md learning
// lines, their own files, even this run's files). Every path that now differs
// from this run's own reviewed composition must be exactly such a transition,
// applied only when its reviewed before-state is the current expected state.
// The root CM workflow config outside this run's scope is user-editable policy,
// not delivered code, and is the one tolerated unreviewed difference.
export function explainReviewedDrift({root,baseline,composed,ownScope,deliveries,after,exclude=[]}){
  const base=readReviewBaseline(baseline);
  const original=new Map(base.files.map(file=>[file.path,inventoryFile(file)]));
  const expected=new Map(composed.map(file=>[file.path,inventoryFile(file)]));
  // Content and mode: a permission change is a change to a reviewed file record.
  const actual=new Map(compareReviewInventoryToBaseline(root,base,{withMode:true})
    .map(row=>[row.path,row.sha256===null?null:`${row.sha256}:${row.mode}`]));
  const scope=new Set(ownScope),tolerated=p=>CONFIG_FILENAMES.includes(p)&&!scope.has(p);
  const current=p=>actual.has(p)?actual.get(p):key(original.get(p));
  // Each independent group of later deliveries either explains its paths exactly
  // or is left out; the final comparison below then names what stays unexplained.
  for(const group of groups(laterPool(deliveries,after,base.rootDigest,new Set(exclude)))){
    const paths=[...new Set(group.flatMap(({pkg})=>pkg.changes.map(change=>change.path)))];
    const found=shortestTransitions(expected,group,next=>paths.every(p=>tolerated(p)||key(next.get(p))===current(p)));
    for(const item of found??[])applyMeta(expected,item.pkg);
  }
  const wanted=new Map([...new Set([...original.keys(),...expected.keys()])]
    .filter(p=>key(original.get(p))!==key(expected.get(p))).map(p=>[p,key(expected.get(p))]));
  const unexplained=[...new Set([...wanted.keys(),...actual.keys()])]
    .filter(p=>!tolerated(p)&&wanted.get(p)!==actual.get(p)).sort();
  if(unexplained.length){
    const error=new Error(`fix_current_code_unexplained: ${unexplained.slice(0,20).join(', ')}${unexplained.length>20?` (+${unexplained.length-20} more)`:''}`);
    error.code='fix_current_code_unexplained';error.paths=unexplained;throw error;
  }
}

// Completed run without accepted fixes: its own reviewed composition, then drift.
export function explainCompletedDelivery({root,baseline,parentPackage,deliveries,after}){
  const base=readReviewBaseline(baseline),parent=readReviewPackage(parentPackage);
  need(parent.baseIdentity===base.baselineDigest&&parent.rootDigest===base.rootDigest
    &&digest(parent.identity)===digest(base.identity),'fix_parent_binding_mismatch');
  if(base.specification)verifySpecificationMaterial(base);
  const expected=new Map(base.files.map(file=>[file.path,inventoryFile(file)]));
  for(const change of parent.changes){
    need(sameFile(expected.get(change.path)??null,change.before),'fix_before_mismatch');
    if(change.after===null)expected.delete(change.path);else expected.set(change.path,inventoryFile(change.after));
  }
  explainReviewedDrift({root,baseline:base,composed:[...expected.values()],ownScope:parent.scope,deliveries,after});
}

// steps: the latest accepted record's recorded interleaving. extend: the last
// package is a new fix whose own preceding deliveries may still be missing.
// after: the parent's approving-review time. verifySteps re-proves each step
// against its run's store and must be supplied whenever steps can exist.
export function inspectFixCodeAssociation({root,specsRoot,baseline,parentPackage,fixPackage,fixPackages,steps=[],extend=false,deliveries=null,after=null,verifySteps=null}){
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
      recorded=interleaveNewestFix({baseline,parentPackage,fixPackages:chainPackages,steps,deliveries:available(),after});
    }
  }
  if(recorded.length){need(typeof verifySteps==='function','fix_association_unverified');verifySteps(recorded);}
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
      deliveries:available(),after,exclude:recorded.map(step=>step.packageDigest)});
  }
  return associationRecord({parent,fixes,files,steps:recorded});
}
export function associationRecord({parent,fixes,files,steps}){
  return json({version:steps.length?2:1,kind:'cm-fix-code-association',parentPackageDigest:parent.packageDigest,
    fixPackageDigest:fixes.at(-1).packageDigest,currentFilesDigest:digest(files),...(steps.length?{laterDeliveries:steps}:{})});
}
