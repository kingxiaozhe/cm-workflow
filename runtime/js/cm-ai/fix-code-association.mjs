// Content composition only. This does not authenticate a review or clear a gate.
import {captureReviewBaseline,compareReviewInventoryToBaseline,readReviewBaseline,readReviewPackage} from './review-package.mjs';
import {verifySpecificationMaterial} from './specification-material.mjs';
import {CONFIG_FILENAMES} from '../../../scripts/cm-workflow-config.mjs';
import {digest,hex,id,json,need,shape} from './effect-contract.mjs';

const inventoryFile=({contentBase64,...metadata})=>metadata;
const sameFile=(a,b)=>digest(a===null?null:inventoryFile(a))===digest(b===null?null:inventoryFile(b));
// Recorded steps are compact (run id and package digest). The list is not a
// search bound: it is every qualifying delivery, and the whole accepted-fix
// record is size-checked before it is persisted.
const MAX_STEPS=2048;

// Later reviewed deliveries of other runs that precede a QA fix, recorded as the
// ordered list of their packages and the index of the fix each precedes. The
// file transitions are re-derived from the runs' verified stores, never taken
// from the journal; an empty list is the historical strict composition.
export function readSteps(raw,fixCount){
  need(Array.isArray(raw)&&raw.length<=MAX_STEPS,'fix_association_invalid');
  let previous=0;const seen=new Set();
  for(const step of raw){
    shape(step,['beforeFix','runId','packageDigest']);
    need(Number.isInteger(step.beforeFix)&&step.beforeFix>=previous&&step.beforeFix<fixCount,'fix_association_invalid');
    previous=step.beforeFix;id(step.runId);hex(step.packageDigest);
    need(!seen.has(step.packageDigest),'fix_association_invalid');seen.add(step.packageDigest);
  }
  return raw;
}
// The recorded form of a real reviewed package.
export const deliveryStep=(runId,pkg,beforeFix)=>({beforeFix,runId,packageDigest:pkg.packageDigest});
const compact=steps=>steps.map(({beforeFix,runId,packageDigest})=>({beforeFix,runId,packageDigest}));
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
const strict=()=>false;
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
// Strict order: parent, then for each fix its recorded preceding steps and the
// fix. Steps are resolved: each carries the real reviewed package (pkg).
function composeState({base,parent,fixes},steps){
  const expected=new Map(base.files.map(file=>[file.path,file])),apply=applyTo(expected);
  apply(parent);
  for(const [index,fix] of fixes.entries()){
    for(const step of steps.filter(step=>step.beforeFix===index))applyDelivery(expected,step.pkg,strict);
    apply(fix);
  }
  return expected;
}

// steps: resolved steps [{beforeFix,runId,packageDigest,pkg}] whose packages were
// read from the named runs' verified stores.
export function composeFixCode({baseline,parentPackage,fixPackages,steps=[]}){
  const chain=bindChain({baseline,parentPackage,fixPackages}),{base,parent,fixes}=chain;
  readSteps(json(compact(steps)),fixes.length);
  const resolved=steps.map(step=>{const pkg=readReviewPackage(step.pkg);
    need(pkg.packageDigest===step.packageDigest&&pkg.rootDigest===base.rootDigest,'fix_association_unverified');return {...step,pkg};});
  // Metadata-only transitions cannot rebuild legacy full-content inventories.
  need(!resolved.length||base.version===2,'fix_before_mismatch');
  const files=[...composeState(chain,resolved).values()].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
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

// One deterministic order for a run with QA fixes, from facts fixed at
// acceptance. The accepted record's ordered list stays exactly as it is; every
// other qualifying delivery is applied after the last fix, in review order. A new
// fix (extend) takes, before itself, every qualifying delivery not yet recorded
// whose review preceded its own final review (fixTime), all in review order. So a
// delivery that was reviewed before a fix but committed only after its acceptance
// is simply applied after that fix. Every step and every later delivery applies
// strictly; the result must be the current tree exactly.
export function inspectFixCodeAssociation({root,specsRoot,baseline,parentPackage,fixPackage,fixPackages,steps=[],extend=false,
  deliveries=null,after=null,fixTime=null}){
  const chainPackages=fixPackages??[fixPackage];
  const chain=bindChain({baseline,parentPackage,fixPackages:chainPackages}),{base,parent,fixes}=chain,last=fixes.length-1;
  const prior=readSteps(json(steps),extend?last:fixes.length),ownScope=[...parent.scope,...fixes.flatMap(fix=>fix.scope)];
  const tolerated=toleratedConfig(ownScope);
  const later=typeof deliveries==='function'?laterSequence(deliveries(),after,base.rootDigest):[];
  const slot=(runId,packageDigest)=>`${runId}\0${packageDigest}`;
  const found=new Map(later.map(entry=>[slot(entry.runId,entry.pkg.packageDigest),entry]));
  // Each recorded step must still be a completed, later reviewed delivery.
  const recorded=prior.map(step=>{const entry=found.get(slot(step.runId,step.packageDigest));
    need(entry,'fix_association_unverified');return {...step,pkg:entry.pkg};});
  const used=new Set(recorded.map(step=>slot(step.runId,step.packageDigest)));
  let rest=later.filter(entry=>!used.has(slot(entry.runId,entry.pkg.packageDigest)));
  if(extend&&rest.length){
    const time=typeof fixTime==='function'?fixTime(fixes[last]):null;
    need(Number.isSafeInteger(time),'fix_association_unverified');
    recorded.push(...rest.filter(entry=>entry.reviewedAt<time).map(entry=>({...deliveryStep(entry.runId,entry.pkg,last),pkg:entry.pkg})));
    rest=rest.filter(entry=>entry.reviewedAt>=time);
  }
  const {files}=composeFixCode({baseline,parentPackage,fixPackages:chainPackages,steps:recorded});
  if(base.specification)verifySpecificationMaterial(base);
  const current=captureReviewBaseline({root,
    ...(base.specification?{specification:{specsRoot:base.specificationRoot,feature:base.specification.feature}}:{}),...(specsRoot===undefined?{}:{specsRoot}),identity:parent.identity,version:base.version,
    ...(base.codeProjectPaths?{codeProjectPaths:base.codeProjectPaths}:{}),
    scope:[...new Set(ownScope)],requirements:base.requirements});
  need(current.rootDigest===base.rootDigest,'fix_parent_binding_mismatch');
  const compared=base.version===1?current.files:current.files.map(inventoryFile);
  if(rest.length||digest(compared)!==digest(files)){
    // Without a way to read other runs' deliveries the historical exact match holds.
    need(typeof deliveries==='function','fix_current_code_unexplained');
    // Metadata-only transitions cannot rebuild legacy full-content inventories.
    need(!rest.length||base.version===2,'fix_before_mismatch');
    const state=new Map(files.map(file=>[file.path,inventoryFile(file)]));
    for(const entry of rest)applyDelivery(state,entry.pkg,tolerated);
    compareCurrent({root,base,state,tolerated});
  }
  return associationRecord({parent,fixes,files,steps:compact(recorded)});
}
export function associationRecord({parent,fixes,files,steps}){
  return json({version:steps.length?2:1,kind:'cm-fix-code-association',parentPackageDigest:parent.packageDigest,
    fixPackageDigest:fixes.at(-1).packageDigest,currentFilesDigest:digest(files),...(steps.length?{laterDeliveries:steps}:{})});
}
