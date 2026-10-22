// Isolated no-provider sample for the production split preparation and material paths.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {fileURLToPath} from 'node:url';
import {openExecutionStore} from '../runtime/js/cm-ai/execution-store.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
import {inspectPrdChangeSnapshot,inspectPrdChangeProposal,createPrdChange} from '../runtime/js/cm-prd/change.mjs';
import {openPrdSession} from '../runtime/js/cm-prd/session.mjs';
import {loadConfig} from './cm-workflow-config.mjs';
import {prepareReviewSplitMaterials,verifySplitMaterial} from '../runtime/js/cm-ai/review-split-material.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
const source=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export function splitFixture(options={}){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-review-split-'))),specsDir=path.join(root,'specs'),codeProject=path.join(root,'code');
 fs.mkdirSync(specsDir);fs.mkdirSync(codeProject);
 const write=(name,value)=>{const f=path.join(root,name);fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,typeof value==='string'?value:JSON.stringify(value),{mode:0o600});return ref(f);};
 const ref=f=>({path:f,sha256:sha(fs.readFileSync(f))});
 const record=(name,text,gzip=false)=>{const b=Buffer.from(text);return {path:name,type:'file',mode:0o644,size:b.length,sha256:sha(b),...(gzip?{contentGzipBase64:gzipSync(b).toString('base64')}:{contentBase64:b.toString('base64')})};};
 const identity={repositoryId:'fixture',runId:'parent',taskId:'T-004',attempt:2},fingerprints={workflow:digest('workflow'),config:digest('config'),inputs:digest('inputs')};
 const definitions=[['mobile/src/ui/GlassSurface.tsx','export const surface=1;\n','T-004a'],['mobile/src/ui/GlassHeader.tsx','export const header=1;\n','T-004b'],['mobile/src/ui/BrandBar.tsx','export const brand=1;\n','T-004c'],['mobile/src/__tests__/warm-frost-shell.spec.tsx',"it('shared assertion', () => { expect(1).toBe(1); });\n",'T-004a']];
 const changes=definitions.map(([p,text])=>({path:p,before:null,after:record(p,text)}));
 changes.push({path:'mobile/package-lock.json',before:record('mobile/package-lock.json','{"version":1,"dependencies":{}}',true),after:record('mobile/package-lock.json','{"version":2,"dependencies":{}}',true)});
 for(const c of changes){const f=path.join(codeProject,c.path);fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,Buffer.from(c.after.contentBase64??'', 'base64'));if(c.after.contentGzipBase64)fs.writeFileSync(f,'{"version":2,"dependencies":{}}');fs.chmodSync(f,0o644);}
 const manifest=origin=>{const text=origin+' evidence complete',hash=sha(text),storeRoot=path.join(root,'text-'+origin);fs.mkdirSync(storeRoot);fs.writeFileSync(path.join(storeRoot,hash),text);
  const files=[{id:'evidence-1',path:'REPORT.md',mediaType:'text/markdown',sha256:hash,size:Buffer.byteLength(text),contentBlob:hash,description:'fixture'}];
  return {version:2,manifestDigest:digest(origin),images:[],binaryAssets:{storeRoot},textEvidence:{version:1,identity,storeRoot,manifestDigest:digest(files),files,requirements:[{id:'req1',fileId:'evidence-1',pointers:[]}]}};};
 const native=manifest('native'),continuation=manifest('continuation');
 const body={version:1,kind:'cm-review-package',identity,rootDigest:digest(codeProject),baseIdentity:digest('original-baseline'),scope:changes.map(c=>c.path),changes,
  requirements:[],checks:[{id:'native-evidence',kind:'native-evidence',material:native}],artifactDigest:digest(changes),
  evidenceContinuation:{newEvidence:{material:continuation}}};
 const pkg={...body,packageDigest:digest(body)},packageFile=write('package.json',pkg);
 const finding={id:'R1',severity:'P1',message:'Original finding remains open'},receiptBody={id:'old-review',result:{findings:[finding]}};
 const receipt={...receiptBody,receiptDigest:digest(receiptBody)},calls=Array.from({length:18},(_,i)=>({invocationId:'old.'+(i+1),terminal:'failed'}));
 const initial=openExecutionStore({specsRoot:specsDir,identity:{repositoryId:identity.repositoryId,runId:identity.runId},fingerprints,create:true});
 initial.append({id:'init',kind:'intent',payload:{type:'init',config:{identity}},expectedRevision:initial.snapshot().revision});
 initial.append({id:'last',kind:'result',payload:{type:'effect-checkpoint',checkpoint:{state:'blocked',attempt:2,sequence:18,calls,receipts:[receipt],reviewPackage:pkg}},expectedRevision:initial.snapshot().revision});
 const snapshot=initial.snapshot();initial.close();
 const testRows=[{path:definitions[3][0],start:1,end:1,description:'shared assertion',owners:['T-004a','T-004b','T-004c']}];
 const coverageMatrix=changes.flatMap(c=>{
  const owners=c.path.includes('/__tests__/')?['T-004a','T-004b','T-004c']:[definitions.find(d=>d[0]===c.path)?.[2]??'T-004a'];
  return owners.map(owner=>({path:c.path,owner,beforeSha256:c.before?.sha256??null,afterSha256:c.after.sha256,mode:'full_original_before_after',testGroupOwnership:c.path.includes('/__tests__/')?testRows:null}));
 });
 const inventoryFile=write('inventory.json',{source:{originalPackageFileSha256:packageFile.sha256,originalPackageDigest:pkg.packageDigest,originalIdentity:identity,
  originalStatePath:path.join(specsDir,'.reviews','.execution','parent','state.json'),originalStateFileSha256:sha(fs.readFileSync(path.join(specsDir,'.reviews','.execution','parent','state.json'))),formalCalls:18},
  coverageMatrix,testCaseOwnershipMatrix:testRows,priorFindingsOwnership:[{receiptId:receipt.id,receiptDigest:receipt.receiptDigest,finding,owners:['T-004a','T-004b','T-004c']}]});
 const prepared=prepareReviewSplitMaterials({packageFile:packageFile.path,inventoryFile:inventoryFile.path});
 const materialFiles=prepared.packets.map(packet=>write(packet.taskId+'.material.json',{version:1,kind:'cm-review-split-material',source:prepared.source,coverageDigest:prepared.coverageDigest,...packet}));
 const reports=materialFiles.map(f=>verifySplitMaterial(f.path));
 const completed=['T-001','T-002','T-003'].map(id=>`- [x] ${id}: Completed exact bytes`);
 const completedEntries=completed.map((line,i)=>line+`\n  - Keep original continuation for T-${String(i+1).padStart(3,'0')}`);
 const pending=Array.from({length:9},(_,i)=>`- [ ] T-${String(i+5).padStart(3,'0')}: Existing task`);
 const version='\n| Date | Version | Change |\n| --- | --- | --- |\n| 2026-10-19 | v2 | Original |\n';
 const oldParent='- [ ] T-004: Original task\n  - Preserve original parent continuation';
 const oldTasks=[...completedEntries,oldParent,...pending].join('\n')+version;
 const responsibilities=taskId=>{
  const owned=changes.filter(c=>coverageMatrix.some(r=>r.path===c.path&&r.owner===taskId)).map(c=>c.path);
  return [`- [ ] ${taskId}: [NEW v3] Review original implementation`,'  - review-only',
   '  - scope: '+owned.map(p=>'`'+p+'`').join(' '),
   '  - test-groups: '+testRows.filter(r=>r.owners.includes(taskId)).map(r=>'`'+`${r.path}:${r.start}-${r.end}`+'`').join(' ')].join('\n');
 };
 let newTasks=[...completedEntries,oldParent.replace('Original task','Original task [DROPPED v3: retain original history]'),
  ...['a','b','c'].map(s=>responsibilities('T-004'+s)),...pending].join('\n')+version+'| 2026-10-22 | v3 | Review split |\n';
 if(options.unrelated)newTasks=oldTasks+'| 2026-10-22 | v3 | Unrelated version note |\n';
 if(options.tasksTransform)newTasks=options.tasksTransform(newTasks); 
 const oldCases={schemaVersion:'1.0',feature:'app-warm-frost',cases:[{id:'TC-001',origin:'user',kind:'logic',blocking:true,acIds:['AC-001'],taskIds:['T-004'],title:'Preserve original acceptance',preconditions:[],steps:['Check the existing implementation'],expected:['Original assertions hold'],cleanup:[]}]};
 for(let number=2;number<=10;number++)oldCases.cases.push({...structuredClone(oldCases.cases[0]),
  id:`TC-${String(number).padStart(3,'0')}`,taskIds:number===10?['T-003','T-004']:['T-005'],
  title:number===10?'Second original acceptance':`Unaffected original case ${number}`});
 const newCases=structuredClone(oldCases);if(!options.unrelated)for(const c of newCases.cases)
  if(['TC-001','TC-010'].includes(c.id))c.taskIds=c.taskIds.flatMap(id=>id==='T-004'?['T-004a','T-004b','T-004c']:[id]);
 if(options.casesTransform)options.casesTransform(newCases);
 const documents=[{path:'requirements.md',content:'- [ ] [AC-001] Original acceptance'+version},
  {path:'design.md',content:'# Original design'+version},{path:'tasks.md',content:oldTasks},{path:'test-cases.json',content:JSON.stringify(oldCases)}];
 for(const doc of documents)write('specs/4.app-warm-frost/'+doc.path,doc.content);
 write('specs/.cm-specs-status',{status:'approved',taskGrammar:2});
 const before=inspectPrdChangeSnapshot(specsDir),proposedDocuments=documents.map(doc=>({...doc,content:doc.path==='tasks.md'?newTasks:doc.path==='test-cases.json'?JSON.stringify(newCases):doc.content}));
 const proposal=inspectPrdChangeProposal(before,{status:'draft',summary:'Split existing review only',features:[{directory:'4.app-warm-frost',documents:proposedDocuments,testCasesReason:null}],removed:[]},['4.app-warm-frost'],{policies:{generate_cases:true}});
 const proposalDigest=proposal.proposalDigest;
 // Real PRD owner lifecycle; the confirmation is exclusively a synthetic
 // test input, and the provider sentinel makes any invocation a test failure.
 const prdIdentity={entry:{specs:specsDir,project:codeProject,change:'4.app-warm-frost'},runtime:'codex'};
 const restored={stage:'change_confirmation',before,selected:['4.app-warm-frost'],proposal,confirmation:null,
  configDigest:digest(loadConfig({projectRoot:codeProject})),userCases:null};
 let providerCalls=0;
 const owner=createPrdChange({admission:{specs:specsDir,project:codeProject,cases:null,feature:'4.app-warm-frost'},runtime:'codex',restored,
  call:()=>{providerCalls++;throw Error('No provider allowed in fixture');}});
 owner.confirm({proposalDigest,approved:true,allowUserCaseChanges:true});
 const saved=options.unsaved?null:owner.save(true);
 const session=openPrdSession({specs:specsDir,sessionId:'prd-fixture',identity:prdIdentity});
 try{session.commit({change:owner.checkpoint()});}finally{session.close();}
 const prd=ref(path.join(specsDir,'.reviews','prd-sessions','prd-fixture','state.json'));
 const bindingFiles={run:write('run.json',{identity}),policy:write('POLICY.json',{frozen:true}),review:write('review.json',{model:'gpt-6.1-sol',reasoning:'high'}),protected:write('protected.json',{}),workflow:write('workflow.json',{})};
 for(const [role,name]of [['source-manifest','package.json'],['source-runner','scripts/cm-ai-run.mjs'],['source-store','runtime/js/cm-ai/execution-store.mjs'],['source-contract','runtime/js/cm-ai/review-only-split.mjs'],['source-material','runtime/js/cm-ai/review-split-material.mjs'],['source-proposal','runtime/js/cm-ai/review-split-proposal.mjs']])bindingFiles[role]=ref(path.join(source,name));
 const ownership={paths:Object.fromEntries(changes.map(c=>[c.path,coverageMatrix.filter(r=>r.path===c.path).map(r=>r.owner)])),tests:testRows.map(r=>({id:`${r.path}:${r.start}-${r.end}`,owners:r.owners})),
  findings:[{id:'old-review:R1',owners:['T-004a','T-004b','T-004c'],disposition:'open'}],sources:reports[0].coverage.materials.map(r=>({id:r.origin+':'+r.fileId,owners:r.owners}))};
 const parent={...identity,prefixCount:snapshot.records.length,revision:snapshot.revision,fingerprints,callCount:18,callLedgerDigest:digest(calls)};
 const plan={version:1,kind:'cm-review-only-split',specsDir,codeProject,feature:'4.app-warm-frost',parent,originalPackage:packageFile,
  bindings:Object.entries(bindingFiles).map(([role,file])=>({role,file})),proposal:{sessionId:'prd-fixture',file:prd,proposalDigest},manifests:[write('native-manifest.json',native),write('continuation-manifest.json',continuation)],ownership,
  children:['T-004a','T-004b','T-004c'].map((taskId,i)=>({taskId,runId:'cm-review-only-fixture-'+taskId,paths:changes.filter(c=>ownership.paths[c.path].includes(taskId)).map(c=>c.path),tests:ownership.tests.filter(t=>t.owners.includes(taskId)).map(t=>t.id),findings:['old-review:R1'],material:materialFiles[i]}))};
 return {root,plan,pkg,snapshot,reports,proposal,before,completed,oldCases,newCases,newTasks,owner,saved,providerCalls,write,ref,cleanup:()=>fs.rmSync(root,{recursive:true,force:true})};
}
