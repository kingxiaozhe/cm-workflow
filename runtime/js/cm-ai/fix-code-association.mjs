// Content composition only. This does not authenticate a review or clear a gate.
import {captureReviewBaseline,compareReviewInventoryToBaseline,readReviewBaseline,readReviewPackage} from './review-package.mjs';
import {verifySpecificationMaterial} from './specification-material.mjs';
import {CONFIG_FILENAMES} from '../../../scripts/cm-workflow-config.mjs';
import {digest,hex,id,json,need,shape,text} from './effect-contract.mjs';

const inventoryFile=({contentBase64,...metadata})=>metadata;
const sameFile=(a,b)=>digest(a===null?null:inventoryFile(a))===digest(b===null?null:inventoryFile(b));
// Not a search bound: the ordered list is every qualifying delivery. The journal's
// per-record size (about 1 MiB) is the practical limit; beyond it acceptance
// fails closed.
const MAX_STEPS=1024,MAX_STEP_CHANGES=4096;

// Later reviewed deliveries of other runs that precede a QA fix in durable
// review order, recorded as metadata-only before->after transitions and the
// index of the fix they precede. They are durable association data, so replay
// never needs the other runs' stores; an empty list is the historical strict
// composition.
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
const key=file=>file===null||file===undefined?null:`${file.sha256}:${file.mode}`;
const applyMeta=(state,pkg)=>{for(const change of pkg.changes){
  if(change.after===null)state.delete(change.path);else state.set(change.path,inventoryFile(change.after));}};
// Every qualifying later package, in durable review order (ties: run id, then
// package position). Nothing is chosen or dropped by content.
function laterSequence(deliveries,after,rootDigest){
  return deliveries.flatMap(delivery=>delivery.packages.map((item,index)=>({runId:delivery.runId,index,reviewedAt:item.reviewedAt,raw:item.pkg})))
    .filter(entry=>deliveredAfter(entry,after)).map(entry=>({...entry,pkg:readReviewPackage(entry.raw)}))
    .filter(entry=>entry.pkg.rootDigest===rootDigest)
    .sort((a,b)=>a.reviewedAt-b.reviewedAt||(a.runId<b.runId?-1:a.runId>b.runId?1:0)||a.index-b.index);
}
function unexplainedError(paths){
  const error=new Error(`fix_current_code_unexplained: ${paths.slice(0,20).join(', ')}${paths.length>20?` (+${paths.length-20} more)`:''}`);
  error.code='fix_current_code_unexplained';error.paths=paths;return error;
}
// The root CM workflow config outside the run's scope is user-editable policy,
// not delivered code, and is the one tolerated unreviewed difference.
const toleratedConfig=ownScope=>{const scope=new Set(ownScope);return p=>CONFIG_FILENAMES.includes(p)&&!scope.has(p);};
// Apply one later delivery strictly: its reviewed before-state must be the
// running composition on every path it touches (tolerated config aside). None
// is ever skipped; a mismatch names the paths.
function applyDelivery(state,pkg,tolerated){
  const stale=pkg.changes.filter(change=>!tolerated(change.path)&&!sameFile(state.get(change.path)??null,change.before))
    .map(change=>change.path).sort();
  if(stale.length)throw unexplainedError(stale);
  applyMeta(state,pkg);
}
// The composition must be the current tree exactly, content and mode.
function compareCurrent({root,base,state,tolerated}){
  const original=new Map(base.files.map(file=>[file.path,inventoryFile(file)]));
  const actual=new Map(compareReviewInventoryToBaseline(root,base,{withMode:true})
    .map(row=>[row.path,row.sha256===null?null:`${row.sha256}:${row.mode}`]));
  const wanted=new Map([...new Set([...original.keys(),...state.keys()])]
    .filter(p=>key(original.get(p))!==key(state.get(p))).map(p=>[p,key(state.get(p))]));
  const unexplained=[...new Set([...wanted.keys(),...actual.keys()])]
    .filter(p=>!tolerated(p)&&wanted.get(p)!==actual.get(p)).sort();
  if(unexplained.length)throw unexplainedError(unexplained);
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

// A completed run's reviewed package is history: other task runs deliver later,
// separately reviewed changes on top of it (their AGENTS.md learning lines, their
// own files, even this run's files). Apply every one of them, in durable review
// order and strictly; the result must be the current tree exactly.
export function explainReviewedDrift({root,baseline,composed,ownScope,deliveries,after}){
  const base=readReviewBaseline(baseline);
  const state=new Map(composed.map(file=>[file.path,inventoryFile(file)])),tolerated=toleratedConfig(ownScope);
  for(const entry of laterSequence(deliveries,after,base.rootDigest))applyDelivery(state,entry.pkg,tolerated);
  compareCurrent({root,base,state,tolerated});
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

// One deterministic order for a run with QA fixes: every later delivery and each
// of this run's fixes at its own durable review time (fixTime), all applied
// strictly. Deliveries before a fix are its recorded steps (exactly the ordered
// list, re-verified against their stores); deliveries after the last fix are
// applied live. steps: the latest accepted record's list; extend: the last
// package is a new fix. The record may only grow by steps preceding that fix.
export function inspectFixCodeAssociation({root,specsRoot,baseline,parentPackage,fixPackage,fixPackages,steps=[],extend=false,
  deliveries=null,after=null,verifySteps=null,fixTime=null}){
  const chainPackages=fixPackages??[fixPackage];
  const chain=bindChain({baseline,parentPackage,fixPackages:chainPackages}),{base,parent,fixes}=chain,last=fixes.length-1;
  const prior=readSteps(json(steps),fixes.length),ownScope=[...parent.scope,...fixes.flatMap(fix=>fix.scope)];
  const tolerated=toleratedConfig(ownScope);
  const later=typeof deliveries==='function'?laterSequence(deliveries(),after,base.rootDigest):[];
  const recorded=[],tail=[];
  if(later.length){
    // Metadata-only transitions cannot rebuild legacy full-content inventories.
    need(base.version===2,'fix_before_mismatch');
    const times=fixes.map(fix=>typeof fixTime==='function'?fixTime(fix):null);
    need(times.every(Number.isSafeInteger)&&times.every((time,index)=>index===0||time>=times[index-1]),'fix_association_unverified');
    const state=composeState(chain,[],0),applyFix=applyTo(state);
    let next=0;
    for(const entry of later){
      while(next<=last&&times[next]<entry.reviewedAt)applyFix(fixes[next++]);
      // Recorded steps are replayed below by the strict composition as well.
      applyDelivery(state,entry.pkg,tolerated);
      if(next<=last)recorded.push(deliveryStep(entry.runId,entry.pkg,next));else tail.push(entry.pkg);
    }
  }
  // The latest record's list must be exactly what this order yields before its
  // own last fix; a new fix may add only the steps that precede it.
  need(digest(extend?recorded.filter(step=>step.beforeFix<last):recorded)===digest(prior),'fix_association_unverified');
  if(recorded.length){need(typeof verifySteps==='function','fix_association_unverified');verifySteps(recorded);}
  const {files}=composeFixCode({baseline,parentPackage,fixPackages:chainPackages,steps:recorded});
  if(base.specification)verifySpecificationMaterial(base);
  const current=captureReviewBaseline({root,
    ...(base.specification?{specification:{specsRoot:base.specificationRoot,feature:base.specification.feature}}:{}),...(specsRoot===undefined?{}:{specsRoot}),identity:parent.identity,version:base.version,
    ...(base.codeProjectPaths?{codeProjectPaths:base.codeProjectPaths}:{}),
    scope:[...new Set(ownScope)],requirements:base.requirements});
  need(current.rootDigest===base.rootDigest,'fix_parent_binding_mismatch');
  const compared=base.version===1?current.files:current.files.map(inventoryFile);
  if(tail.length||digest(compared)!==digest(files)){
    // Without a way to read other runs' deliveries the historical exact match holds.
    need(typeof deliveries==='function','fix_current_code_unexplained');
    const state=new Map(files.map(file=>[file.path,inventoryFile(file)]));
    for(const pkg of tail)applyDelivery(state,pkg,tolerated);
    compareCurrent({root,base,state,tolerated});
  }
  return associationRecord({parent,fixes,files,steps:recorded});
}
export function associationRecord({parent,fixes,files,steps}){
  return json({version:steps.length?2:1,kind:'cm-fix-code-association',parentPackageDigest:parent.packageDigest,
    fixPackageDigest:fixes.at(-1).packageDigest,currentFilesDigest:digest(files),...(steps.length?{laterDeliveries:steps}:{})});
}
