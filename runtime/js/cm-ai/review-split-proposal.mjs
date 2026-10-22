// Saved PRD authority for one parent-to-three-child review-only succession.
// Reads the actual owner archive/session/specs. It never saves or confirms them.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {need,digest} from './effect-contract.mjs';
import {taskLines,TASK_GRAMMAR,LEGACY_TASK_GRAMMAR} from '../spec-task-line.mjs';
import {inspectPrdChangeSnapshot,inspectPrdChangeProposal} from '../cm-prd/change.mjs';
import {loadConfig} from '../../../scripts/cm-workflow-config.mjs';
import {buildManifest,normalizeRuntimeMarks} from '../../../scripts/cm-spec-manifest.mjs';
import {parseFeatureTaskText} from './cm-ai-admission.mjs';
import {verifySplitMaterial} from './review-split-material.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
const names=['requirements.md','design.md','tasks.md','test-cases.json'];
const same=(a,b,code)=>{need(a!==undefined&&b!==undefined,code);need(digest(a)===digest(b),code);};
function readJson(file,max=4*1024*1024){
 need(path.isAbsolute(file)&&fs.realpathSync(file)===file,'split_proposal_path');
 const before=fs.lstatSync(file);need(before.isFile()&&!before.isSymbolicLink()&&before.nlink===1&&before.size<=max,'split_proposal_file');
 const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 try{const bytes=fs.readFileSync(fd),after=fs.fstatSync(fd),current=fs.lstatSync(file);
  need([after,current].every(s=>['dev','ino','size','mtimeMs','ctimeMs'].every(k=>s[k]===before[k])),'split_proposal_changed');
  return {bytes,value:JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(bytes))};
 }finally{fs.closeSync(fd);}
}
// A complete declaration includes its original indented continuations and line endings.
function entries(text,grammar){
 need(typeof text==='string','split_proposal_tasks');const lines=taskLines(text,{grammar}),out=new Map();let owner=null;
 const end=offset=>{if(owner){need(!out.has(owner.id),'split_proposal_duplicate_task');out.set(owner.id,{...owner,text:text.slice(owner.start,offset)});owner=null;}};
 for(const row of lines){
  if(row.declaration){end(row.start);owner={...row.declaration,start:row.start,indent:/^[ \t]*/.exec(row.body)[0].length,body:row.body};}
  else if(owner&&row.body.trim()&&(/^\s*#/.test(row.body)||/^[ \t]*/.exec(row.body)[0].length<=owner.indent))end(row.start);
 }
 end(text.length);return out;
}
function normalizedRef(token,paths){
 need(typeof token==='string'&&token&&!/[\\\x00-\x1f]/.test(token)&&!path.isAbsolute(token)
   &&!token.split('/').some(p=>!p||p==='.'||p==='..'),'split_proposal_scope');
 const exact=paths.filter(p=>p===token||p.replace(/^mobile\//,'')===token);
 const candidates=exact.length?exact:paths.filter(p=>path.basename(p)===token);
 need(candidates.length===1,'split_proposal_scope_ambiguous');return candidates[0];
}
function refs(line,label){
 const tokens=[...line.matchAll(/`([^`]+)`/g)].map(m=>m[1]);
 need(tokens.length>0&&line.replace(/`[^`]+`/g,'').trim()==='',label);return tokens;
}
function responsibilities(entry,allPaths){
 const scope=[],tests=[];let reviewOnly=0,scopeRows=0,testRows=0;
 for(const line of entry.text.split(/\r\n|\r|\n/).slice(1)){
  if(/^\s+- review-only\s*$/.test(line)){reviewOnly++;continue;}
  const s=/^\s+- scope:\s*(.*)$/.exec(line),t=/^\s+- test-groups:\s*(.*)$/.exec(line);
  if(s){scopeRows++;scope.push(...refs(s[1],'split_proposal_scope').map(v=>normalizedRef(v,allPaths)));}
  if(t){testRows++;tests.push(...refs(t[1],'split_proposal_tests').map(v=>{
   const match=/^(.+):(\d+)-(\d+)$/.exec(v);need(match&&Number(match[2])>0&&Number(match[3])>=Number(match[2]),'split_proposal_tests');
   return `${normalizedRef(match[1],allPaths)}:${Number(match[2])}-${Number(match[3])}`;
  }));}
 }
 need(reviewOnly===1&&scopeRows===1&&testRows===1&&new Set(scope).size===scope.length&&new Set(tests).size===tests.length,'split_proposal_responsibility_required');
 return {scope:scope.sort(),tests:tests.sort()};
}
// Scene metadata is an exact contract, not a natural-language ownership guess.
// The caller supplies the report returned by the material verifier, never the
// candidate's self-reported counters or an unrelated proposal digest.
export function assertSplitSceneProposalEntry(entry,plan,child,report){
 need(plan?.sceneCoverage?.version===1&&/^[a-f0-9]{64}$/.test(plan.sceneCoverage.coverageDigest),'split_proposal_scene_contract');
 need(report?.integrityVerified===true&&report.taskId===child?.taskId&&report.scene?.taskId===child.taskId
  &&report.sceneCoverage?.version===1&&report.sceneCoverage.coverageDigest===plan.sceneCoverage.coverageDigest
  &&report.coverageDigest===plan.sceneCoverage.coverageDigest,'split_proposal_scene_material');
 need(typeof entry?.text==='string'&&typeof report.scene.scene==='string'&&report.scene.scene.length>0
  &&!/[\r\n]/.test(report.scene.scene)&&/^[a-f0-9]{64}$/.test(child.material?.sha256)
  &&report.fileSha256===child.material.sha256&&/^[a-f0-9]{64}$/.test(report.requestSha256),'split_proposal_scene_material');
 const images=report.readableImages,materials=report.coverage?.materials;
 need(Array.isArray(images)&&images.length>0&&Array.isArray(materials),'split_proposal_scene_material');
 const token=(origin,id)=>{need(['native','continuation'].includes(origin)&&typeof id==='string'&&id.length>0&&!/[`\s\x00-\x1f]/.test(id),'split_proposal_scene_material');return origin+':'+id;};
 const imageIds=images.map(row=>token(row.origin,row.path)),sourceIds=materials.filter(row=>row.owners?.includes(child.taskId)).map(row=>token(row.origin,row.fileId));
 need(new Set(imageIds).size===imageIds.length&&sourceIds.length>0&&new Set(sourceIds).size===sourceIds.length,'split_proposal_scene_material');
 const quoted=rows=>rows.map(row=>'`'+row+'`').join(' ');
 const expected=[
  'review-scene: '+report.scene.scene,
  'scene-contract: `'+plan.sceneCoverage.coverageDigest+'`',
  'scene-material: `'+child.material.sha256+'` `'+report.requestSha256+'`',
  'scene-images: '+quoted(imageIds),
  'scene-sources: '+quoted(sourceIds),
  'scene-closure: all-required-scenes',
 ];
 const actual=entry.text.split(/\r\n|\r|\n/).slice(1).filter(line=>/^\s+- (?:review-scene|scene-[^:]*):/.test(line))
  .map(line=>line.replace(/^\s+- /,''));
 same(actual,expected,'split_proposal_scene_binding');
 return {taskId:child.taskId,scene:report.scene.scene,images:imageIds.length,sources:sourceIds.length,coverageDigest:plan.sceneCoverage.coverageDigest};
}
// Dependencies live outside complete task entries. Retain the historical parent
// edge, inherit its prerequisites for all three review scenes, and replace only
// downstream references to the parent. No old task text is relaxed here.
export function assertSplitSceneDependencies(before,after,parent,children){
 const section=text=>{
  need([...text.matchAll(/^## 依赖关系[ \t]*\r?$/gm)].length===1,'split_proposal_scene_dependencies');
  const match=/^## 依赖关系[ \t]*\r?\n([\s\S]*?)(?=^## |$(?![\s\S]))/m.exec(text);
  need(match,'split_proposal_scene_dependencies');return match[1];
 };
 const original=section(before),actual=section(after),lines=original.match(/[^\n]*\n|[^\n]+$/g)??[];
 const rows=lines.map(line=>({line,match:/^(- )([^\s]+)( 依赖 )([^\r\n]+)(\r?\n)?$/.exec(line)}));
 const originalParent=rows.filter(row=>row.match?.[2]===parent);
 need(originalParent.length===1&&children.length===3,'split_proposal_scene_dependencies');
 const escaped=parent.replace(/[^A-Za-z0-9_]/g,'\\$&'),token=new RegExp('(?<![A-Za-z0-9_-])'+escaped+'(?![A-Za-z0-9_-])','g');
 let inherited=false;
 const expected=rows.map(({line,match:m})=>{
  if(!m)return line;
  need(!children.includes(m[2]),'split_proposal_scene_dependencies');
  if(m[2]===parent){inherited=true;return line+children.map(id=>m[1]+id+m[3]+m[4]+(m[5]??'\n')).join('');}
  return m[1]+m[2]+m[3]+m[4].replace(token,children.join(', '))+(m[5]??'');
 }).join('');
 need(inherited&&actual===expected,'split_proposal_scene_dependencies');
 const oldGraph=parseFeatureTaskText(before,{strictTaskIds:true}),newGraph=parseFeatureTaskText(after,{strictTaskIds:true});
 need(!oldGraph.error&&!newGraph.error,'split_proposal_scene_dependencies');
 const expectedGraph=new Map([...oldGraph.dependencies].map(([id,deps])=>[id,id===parent?deps:deps.flatMap(dep=>dep===parent?children:[dep])]));
 for(const child of children)expectedGraph.set(child,[...oldGraph.dependencies.get(parent)]);
 const graphRows=graph=>[...graph].sort(([a],[b])=>a.localeCompare(b));
 same(graphRows(newGraph.dependencies),graphRows(expectedGraph),'split_proposal_scene_dependencies');
 return {parent,children:[...children],preservedParent:true};
}
function casesOnlyReassigned(before,after,parent,children){
 need(before&&after&&Array.isArray(before.cases)&&Array.isArray(after.cases),'split_proposal_cases');
 const {cases:old,...a}=before,{cases:next,...b}=after;same(a,b,'split_proposal_case_semantics');
 need(old.length===next.length,'split_proposal_case_semantics');
 for(const [index,c]of old.entries()){
  const n=next[index];need(n?.id===c.id,'split_proposal_case_semantics');
  if(!['TC-001','TC-010'].includes(c.id)){same(c,n,'split_proposal_case_semantics');continue;}
  const {taskIds:oldIds,...oldCase}=c,{taskIds:newIds,...newCase}=n;
  same(oldCase,newCase,'split_proposal_case_semantics');
  const expected=oldIds.flatMap(id=>id===parent?children:[id]);same(newIds,expected,'split_proposal_case_responsibility');
 }
}
export function assertSavedSplitProposal(plan){
 need(plan&&typeof plan.specsDir==='string'&&typeof plan.codeProject==='string'&&typeof plan.feature==='string'
  &&plan.parent&&typeof plan.parent.taskId==='string'&&Array.isArray(plan.children)&&plan.children.length===3
  &&plan.children.every(c=>c&&typeof c.taskId==='string'&&Array.isArray(c.paths)&&c.paths.every(p=>typeof p==='string')
   &&Array.isArray(c.tests)&&c.tests.every(t=>typeof t==='string')),'split_proposal_plan');
 const ids=plan.children.map(c=>c.taskId);same(ids,['a','b','c'].map(s=>plan.parent.taskId+s),'split_proposal_children');
 const file=plan.proposal?.file;
 need(file&&typeof plan.proposal.sessionId==='string'&&file.path===path.join(plan.specsDir,'.reviews','prd-sessions',plan.proposal.sessionId,'state.json'),'split_proposal_identity');
 const loaded=readJson(file.path,16*1024*1024),session=loaded.value;
 need(hash(loaded.bytes)===file.sha256,'split_proposal_changed');
 need(session.active===null&&session.identity?.entry?.specs===plan.specsDir&&session.identity?.entry?.project===plan.codeProject
  &&session.identity?.entry?.change===plan.feature,'split_proposal_identity');
 // Use the owner's exact stable persisted phase. A confirmed-but-unsaved file
 // will change during save and cannot be a recoverable registration binding.
 const state=session.checkpoint?.change,proposal=state?.proposal,confirmation=state?.confirmation;
 need(state?.stage==='awaiting_review'&&state.saved?.status==='awaiting_review','split_proposal_saved_required');
 need(confirmation?.approved===true&&confirmation.proposalDigest===plan.proposal.proposalDigest
  &&proposal?.proposalDigest===plan.proposal.proposalDigest&&state.saved.revisionDigest===proposal.proposalDigest,'split_proposal_confirmation_required');
 same(state.selected,[plan.feature],'split_proposal_selection');
 need(proposal.removed?.length===0&&proposal.features?.length===1&&proposal.features[0].directory===plan.feature,'split_proposal_selection');
 const before=state.before;need(before?.directories?.includes(plan.feature)&&before.files&&before.trees,'split_proposal_before');
 const config=loadConfig({projectRoot:plan.codeProject});same(state.configDigest,digest(config),'split_proposal_configuration_changed');
 const raw={status:'draft',summary:proposal.summary,features:proposal.features.map(f=>({directory:f.directory,documents:f.documents,testCasesReason:f.testCasesReason})),removed:proposal.removed};
 const rebuilt=inspectPrdChangeProposal(before,raw,state.selected,config);
 same(rebuilt,proposal,'split_proposal_rebuild');
 const archiveName=`.reviews/prd-change-${proposal.proposalDigest}.json`;
 need(state.saved.archive===archiveName,'split_proposal_archive');
 const archived=readJson(path.join(plan.specsDir,archiveName)),archive={version:1,before,proposal,selected:state.selected};
 same(archived.value,archive,'split_proposal_archive');
 need(archived.bytes.equals(Buffer.from(JSON.stringify(archive)+'\n')),'split_proposal_archive_changed');
 const current=inspectPrdChangeSnapshot(plan.specsDir),expectedFiles={...before.files,...proposal.files};
 same(current.directories,before.directories,'split_proposal_inventory');same(current.files,expectedFiles,'split_proposal_disk_changed');
 same(current.reviews,before.reviews,'split_proposal_review_changed');
 for(const dir of before.directories){
  const assets=rows=>rows.filter(r=>!names.includes(r.path.slice(dir.length+1)));
  same(assets(current.trees[dir]??[]),assets(before.trees[dir]??[]),'split_proposal_asset_changed');
 }
 const status=JSON.parse(current.status??'null');
 need(status?.status==='awaiting_review'&&status.revisionDigest===proposal.proposalDigest,'split_proposal_status_changed');
 same(status.specFiles,buildManifest(plan.specsDir),'split_proposal_manifest_changed');
 for(const key of ['status','at','revisionDigest','features','specFiles','testCases','taskGrammar'])
  if(Object.hasOwn(state.saved,key)||Object.hasOwn(status,key))same(state.saved[key],status[key],'split_proposal_saved_status');
 const oldTasks=before.files[`${plan.feature}/tasks.md`],newTasks=proposal.files[`${plan.feature}/tasks.md`];
 const grammar=JSON.parse(before.status??'null')?.taskGrammar===TASK_GRAMMAR?TASK_GRAMMAR:LEGACY_TASK_GRAMMAR;
 const old=entries(oldTasks,grammar),next=entries(newTasks,TASK_GRAMMAR),parent=old.get(plan.parent.taskId),dropped=next.get(plan.parent.taskId);
 need(parent&&!parent.completed&&dropped&&!dropped.completed&&/\[DROPPED\b[^\]]*\]/.test(dropped.body),'split_proposal_parent_history');
 // Only the DROPPED marker may change the original parent's complete entry.
 need(dropped.text.replace(/[ \t]*\[DROPPED\b[^\]]*\]/,'')===parent.text,'split_proposal_parent_history');
 for(const [id,entry]of old)if(id!==plan.parent.taskId)need(next.get(id)?.text===entry.text,'split_proposal_task_history');
 same([...next.keys()].filter(id=>!old.has(id)).sort(),[...ids].sort(),'split_proposal_children');
 if(plan.sceneCoverage)assertSplitSceneDependencies(oldTasks,newTasks,plan.parent.taskId,ids);
 need(plan.originalPackage&&typeof plan.originalPackage.path==='string'&&/^[a-f0-9]{64}$/.test(plan.originalPackage.sha256),'split_proposal_parent_package');
 const original=readJson(plan.originalPackage.path,16*1024*1024),pkg=original.value,{packageDigest,...packageBody}=pkg;
 need(hash(original.bytes)===plan.originalPackage.sha256&&digest(packageBody)===packageDigest
  &&['repositoryId','runId','taskId','attempt'].every(key=>pkg.identity?.[key]===plan.parent[key]),'split_proposal_parent_package');
 const paths=pkg.changes.map(c=>c.path);
 const parsed=parseFeatureTaskText(newTasks,{grammar:TASK_GRAMMAR,strictTaskIds:true});need(!parsed.error,'split_proposal_tasks');
 for(const child of plan.children){
  const entry=next.get(child.taskId),task=parsed.tasks.find(t=>t.id===child.taskId);
  need(entry&&task&&!task.completed&&!task.dropped&&/\[NEW\b[^\]]*\]/.test(entry.body),'split_proposal_child_pending');
  const declared=responsibilities(entry,paths);same(declared.scope,[...child.paths].sort(),'split_proposal_scope_mismatch');
  same(declared.tests,[...child.tests].sort(),'split_proposal_test_mismatch');
  if(plan.sceneCoverage){
   need(child.material&&typeof child.material.path==='string','split_proposal_scene_material');
   const report=verifySplitMaterial(child.material.path,{expectedSha256:child.material.sha256,expectedCoverageDigest:plan.sceneCoverage.coverageDigest});
   assertSplitSceneProposalEntry(entry,plan,child,report);
  }
 }
 const acceptance=text=>text.split(/\r\n|\r|\n/).filter(line=>/^\s*-\s*\[[ xX]\]\s*\[AC-[A-Za-z0-9._-]+\]/.test(line));
 same(acceptance(before.files[`${plan.feature}/requirements.md`]),acceptance(proposal.files[`${plan.feature}/requirements.md`]),'split_proposal_acceptance_changed');
 casesOnlyReassigned(JSON.parse(before.files[`${plan.feature}/test-cases.json`]),JSON.parse(proposal.files[`${plan.feature}/test-cases.json`]),plan.parent.taskId,ids);
 need(proposal.changedUserCases.length===0||confirmation.allowUserCaseChanges===true,'split_user_cases_confirmation_required');
 // Bind the parent's original approved source when that older package retained
 // it. Completion marks use exactly the approval grammar's normalization.
 if(pkg.specification){
  need(pkg.specification.feature===plan.feature&&pkg.specification.task.id===plan.parent.taskId,'split_proposal_original_specification');
  for(const row of pkg.specification.sources){
   const text=before.files[row.path];need(typeof text==='string','split_proposal_original_specification');
   need(hash(Buffer.from(normalizeRuntimeMarks(text,path.basename(row.path),{legacy:grammar!==TASK_GRAMMAR})))===row.sha256,'split_proposal_original_specification');
  }
 }
 return {proposalDigest:proposal.proposalDigest,stage:state.stage,savedRevisionDigest:state.saved.revisionDigest,
  preservedOriginalTasks:old.size,preservedCompletedTasks:[...old.values()].filter(t=>t.completed).length,children:ids};
}
