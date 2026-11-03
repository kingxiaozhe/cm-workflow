import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {buildManifest} from './cm-spec-manifest.mjs';
import {openControlRun} from './cm-ai-run.mjs';
import {createCodexDeveloperRun} from '../runtime/js/cm-ai/codex-developer-adapter.mjs';
import {createHostCheck} from '../runtime/js/cm-ai/host-check.mjs';
import {reviewPaths} from '../runtime/js/cm-ai/review-runner.mjs';
import {previewDelivery,recordDelivery,deliveryCandidate,deliveryProjection,deliveryLines,readDeliveryRecords,deliveryFile} from '../runtime/js/cm-ai/delivery-evidence.mjs';
import {completionSummary,completionLines} from '../runtime/js/cm-ai/completion-summary.mjs';
import {deliveryMain} from './cm-delivery-evidence.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
import {PassThrough,Writable} from 'node:stream';
const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-delivery-fixture-')));
const saved={CM_WORKFLOW_HOME:process.env.CM_WORKFLOW_HOME,CM_WORKFLOW_LOG_HOME:process.env.CM_WORKFLOW_LOG_HOME};
process.env.CM_WORKFLOW_HOME=path.join(root,'home');process.env.CM_WORKFLOW_LOG_HOME=path.join(root,'logs');
after(()=>{for(const [k,v] of Object.entries(saved))if(v===undefined)delete process.env[k];else process.env[k]=v;fs.rmSync(root,{recursive:true,force:true});});
const identity={repositoryId:'delivery-fixture',runId:'delivery-run',taskId:'T-001',attempt:1},feature='1.demo';
const cli=fileURLToPath(new URL('./cm-delivery-evidence.mjs',import.meta.url));
async function fixture(){
  const local=fs.mkdtempSync(path.join(root,'project-')),specsDir=path.join(local,'specs'),codeProject=path.join(local,'code');
  fs.mkdirSync(codeProject);fs.mkdirSync(path.join(specsDir,feature),{recursive:true});
  fs.writeFileSync(path.join(codeProject,'a.mjs'),'export const a=1;\n');fs.writeFileSync(path.join(codeProject,'requirements.md'),'fixture\n');
  for(const [name,body] of [['requirements.md','# R\n'],['design.md','# D\n'],['tasks.md','- [ ] T-001: fixture\n- [ ] T-002: remaining\n']])fs.writeFileSync(path.join(specsDir,feature,name),body);
  fs.writeFileSync(path.join(specsDir,'.cm-specs-status'),JSON.stringify({status:'approved',features:[feature],specFiles:buildManifest(specsDir)}));
  const definition={version:1,codeProject,specsDir,feature,identity,scope:['a.mjs'],requirements:['requirements.md']};
  const execution={configuration:{kind:'synthetic-host-v1'},timeoutMs:4000,excludedContexts:['control'],
    developer:{provider:'codex',requestedModel:'fixture',contextId:'developer',run:createCodexDeveloperRun({requestedModel:'fixture',worker:async()=>{
      fs.writeFileSync(path.join(codeProject,'a.mjs'),'export const a=2;\n');
      return {status:'succeeded',value:{outcome:'implemented',application:{status:'no_relevant_lesson',note:null},retrospective:{status:'no_new_lesson',candidates:[],reason:null}}};}})},
    check:createHostCheck({cwd:codeProject,commands:[{id:'syntax',command:[process.execPath,'--check','a.mjs']}]}),
    verificationGate:async request=>request.acceptanceContract?{satisfied:true,items:request.acceptanceContract.obligations.map(item=>({...item,satisfied:true,evidence:'Synthetic fixture verified'}))}:{satisfied:true},
    reviewers:[{id:'reviewer',adapterId:'codex-review-adapter',provider:'codex',requestedModel:'fixture',allowed:true,available:true,contexts:['review1','review2'],run:(request,{onEvent})=>{
      onEvent({event:'thread.started',provider_thread:'independent-fixture'});onEvent({event:'turn.started',item_type:null});
      onEvent({event:'item.completed',item_type:'agent_message'});onEvent({event:'turn.completed',item_type:null});onEvent({event:'process_closed',exit_code:0,signal:null,timed_out:false});
      return {status:'succeeded',value:{verdict:'approved',packageDigest:request.payload.reviewPackage.packageDigest,examinedPaths:reviewPaths(request.payload.reviewPackage),findings:[],summary:'Synthetic independent review'}};
    }}],reviewInvocation:{developerThreadId:'author-thread',excludedThreadIds:['control']}};
  let opened=await openControlRun(definition,'create',execution);
  const ask=()=>opened.host.handle({version:1,operation:'advance',requestId:'advance',identity});
  try{assert.equal((await opened.host.handle({version:1,operation:'start',requestId:'start',identity})).state,'awaiting_review');}finally{opened.close();}
  opened=await openControlRun(definition,'resume',execution,{decision:{status:'approved'}});let result;
  try{result=await ask();assert.equal(result.state,'fixture_completed',JSON.stringify(result));}finally{opened.close();}
  const artifact=path.join(local,'build.txt'),report=path.join(local,'owner-report.txt'),verificationReport=path.join(local,'deployed-check.txt');
  fs.writeFileSync(artifact,'build bytes');fs.writeFileSync(report,'human observed flow');fs.writeFileSync(verificationReport,'post deploy check');
  const options={specsDir,repositoryId:identity.repositoryId,runId:identity.runId,feature,artifact,kind:'acceptance',
    statement:{actor:'fixture-owner',environment:'staging',outcome:'accepted',note:'fixture manual declaration'},report};
  const projection=()=>{const candidate=deliveryCandidate(options);return deliveryProjection({...options,identity,packageDigest:candidate.packageDigest,specificationDigest:candidate.specificationDigest});};
  return {local,specsDir,codeProject,options,verificationReport,result,projection};
}
const accept={confirm:async(_preview,phrase)=>phrase};

test('real completed owner: preview is read-only, explicit declaration is bound and cannot finish a feature',async()=>{
  const f=await fixture(),journal=path.join(f.specsDir,'.reviews','.execution',identity.runId,'state.json'),bytes=fs.readFileSync(journal),mtime=fs.statSync(journal).mtimeMs;
  const preview=previewDelivery(f.options);assert.equal(preview.candidate.packageDigest,f.result.packageDigest);
  assert.equal(fs.existsSync(path.join(f.specsDir,'.reviews','.delivery')),false);
  assert.equal(f.projection().productAcceptance.status,'unknown');
  await assert.rejects(recordDelivery(f.options),{code:'delivery_confirmation_required'});
  await assert.rejects(recordDelivery(f.options,{confirm:async()=> 'yes'}),{code:'delivery_confirmation_refused'});
  const record=await recordDelivery(f.options,accept);assert.equal(record.sequence,1);assert.equal(record.provenance,'interactive-terminal-declaration');
  assert.equal(readDeliveryRecords(f.specsDir).length,1);assert.equal(f.projection().productAcceptance.status,'recorded');
  const summary=completionSummary({specsDir:f.specsDir,feature,result:f.result});
  assert.equal(summary.productAcceptance.status,'recorded');assert.notEqual(summary.feature.status,'passed');assert.notEqual(summary.project.status,'completed');
  assert.match(completionLines(summary).at(-1),/staging \[.*\] 声明已记录（accepted）/);
  assert.deepEqual(fs.readFileSync(journal),bytes);assert.equal(fs.statSync(journal).mtimeMs,mtime);
  const rejected=await recordDelivery({...f.options,statement:{...f.options.statement,outcome:'rejected'}},accept);
  assert.equal(rejected.previousDigest,record.recordDigest);assert.equal(readDeliveryRecords(f.specsDir).length,2);
  assert.equal(f.projection().productAcceptance.environments[0].statement.outcome,'rejected');
});

test('confirmation rechecks artifact, report, code candidate and record head; no stale approval is applied',async()=>{
  const f=await fixture();
  for(const file of [f.options.artifact,f.options.report,path.join(f.codeProject,'a.mjs')]){
    const original=fs.readFileSync(file);
    await assert.rejects(recordDelivery(f.options,{confirm:async(_p,phrase)=>{fs.appendFileSync(file,'drift');return phrase;}}));
    fs.writeFileSync(file,original);assert.equal(readDeliveryRecords(f.specsDir).length,0);
  }
  await assert.rejects(recordDelivery(f.options,{confirm:async(_p,phrase)=>{await recordDelivery(f.options,accept);return phrase;}}),{code:'delivery_preview_changed'});
  assert.equal(readDeliveryRecords(f.specsDir).length,1);
});

test('latest declaration, environment and candidate are never replaced by an older success',async()=>{
  const f=await fixture();await recordDelivery(f.options,accept);
  const candidate=deliveryCandidate(f.options),base={specsDir:f.specsDir,feature,identity,packageDigest:candidate.packageDigest,specificationDigest:candidate.specificationDigest};
  assert.equal(deliveryProjection({...base,packageDigest:'f'.repeat(64)}).productAcceptance.status,'stale');
  assert.equal(deliveryProjection({...base,current:false}).productAcceptance.status,'stale');
  const code=path.join(f.codeProject,'a.mjs'),before=fs.readFileSync(code);fs.appendFileSync(code,'// changed');
  assert.equal(completionSummary({specsDir:f.specsDir,feature,result:f.result}).productAcceptance.status,'stale');
  fs.writeFileSync(code,before);
  assert.equal(deliveryProjection({...base,artifactSha256:'b'.repeat(64)}).productAcceptance.status,'stale');
  fs.appendFileSync(f.options.report,'changed');assert.equal(deliveryProjection(base).productAcceptance.status,'stale');
  fs.writeFileSync(f.options.report,'human observed flow');
  await recordDelivery({...f.options,statement:{...f.options.statement,environment:'production',outcome:'revoked'}},accept);
  const value=deliveryProjection(base);assert.equal(value.productAcceptance.environments.length,2);
  assert.match(deliveryLines(value)[0],/production \[.*\] 声明已记录（revoked）/);
});

test('deployment execution and post-deployment verification remain distinct, with separate evidence',async()=>{
  const f=await fixture(),options={...f.options,kind:'deployment',statement:{actor:'fixture-operator',environment:'staging',execution:'succeeded',verification:'unknown',note:'deployment declaration'}};
  await recordDelivery(options,accept);assert.equal(f.projection().deployment.environments[0].statement.verification,'unknown');
  await assert.rejects(recordDelivery({...options,statement:{...options.statement,verification:'passed'}},accept),{code:'delivery_verification_report_required'});
  await recordDelivery({...options,statement:{...options.statement,verification:'passed'},verificationReport:f.verificationReport},accept);
  fs.appendFileSync(f.verificationReport,'changed');assert.equal(f.projection().deployment.status,'stale');
  await recordDelivery({...options,statement:{...options.statement,execution:'failed'}},accept);
  assert.equal(f.projection().deployment.environments[0].statement.execution,'failed');assert.equal(readDeliveryRecords(f.specsDir).length,3);
});

test('malformed records and unsafe source links fail closed; read-only CLI cannot bypass terminal confirmation',async()=>{
  const f=await fixture();await recordDelivery(f.options,accept);
  const file=path.join(f.specsDir,'.reviews','.delivery','000001','record.json'),original=fs.readFileSync(file);
  const raw=JSON.parse(original);raw.statement.outcome='accepted-by-ai';fs.writeFileSync(file,JSON.stringify(raw));
  assert.throws(()=>readDeliveryRecords(f.specsDir));assert.equal(f.projection().productAcceptance.status,'unknown');fs.writeFileSync(file,original);
  const linked=path.join(f.local,'linked.txt');fs.symlinkSync(f.options.artifact,linked);assert.throws(()=>deliveryFile(linked));
  const args=['--specs',f.specsDir,'--repository',identity.repositoryId,'--run',identity.runId,'--feature',feature,'--artifact',f.options.artifact];
  const status=spawnSync(process.execPath,[cli,'status',...args,'--json'],{encoding:'utf8'});assert.equal(status.status,0,status.stderr);assert.equal(JSON.parse(status.stdout).productAcceptance.status,'recorded');
  const recordArgs=[...args,'--kind','acceptance','--actor','owner','--environment','staging','--note','tested','--report',f.options.report,'--outcome','accepted'];
  const refused=spawnSync(process.execPath,[cli,'record',...recordArgs],{encoding:'utf8',input:'yes\n'});
  assert.equal(refused.status,2);assert.match(refused.stderr,/delivery_interactive_terminal_required/);assert.equal(readDeliveryRecords(f.specsDir).length,1);
  const bypass=spawnSync(process.execPath,[cli,'record',...recordArgs,'--yes'],{encoding:'utf8'});assert.equal(bypass.status,2);
  assert.deepEqual(fs.readFileSync(file),original);
});

test('interactive CLI records only the displayed digest; competing publication cannot overwrite history',async()=>{
  const f=await fixture(),input=new PassThrough();input.isTTY=true;
  let shown='',errors='';const output=new Writable({write(chunk,_encoding,done){const value=chunk.toString();shown+=value;
    const phrase=value.match(/RECORD acceptance [a-f0-9]{64}/)?.[0];if(phrase)queueMicrotask(()=>input.write(phrase+'\n'));done();}});output.isTTY=true;
  const args=['record','--specs',f.specsDir,'--repository',identity.repositoryId,'--run',identity.runId,'--feature',feature,'--artifact',f.options.artifact,
    '--kind','acceptance','--actor','fixture-owner','--environment','staging','--note','manual fixture','--report',f.options.report,'--outcome','accepted'];
  assert.equal(await deliveryMain(args,{input,output,error:{write(value){errors+=value;}}}),0,errors);input.destroy();
  assert.match(shown,/interactive-terminal-declaration/);assert.equal(readDeliveryRecords(f.specsDir).length,1);
  const originalRename=fs.renameSync;let collided=false;
  fs.renameSync=function(from,to){if(!collided&&to.endsWith('000002')){collided=true;fs.mkdirSync(to);
    fs.writeFileSync(path.join(to,'record.json'),fs.readFileSync(path.join(from,'record.json')));}
    return originalRename(from,to);};
  try{await assert.rejects(recordDelivery(f.options,accept),{code:'delivery_concurrent_write'});}finally{fs.renameSync=originalRename;}
  assert.equal(readDeliveryRecords(f.specsDir).length,2,'one atomic publication survives collision');
  await recordDelivery(f.options,accept);assert.equal(readDeliveryRecords(f.specsDir).length,3,'losing stage does not block later append');
  fs.renameSync=()=>{throw Object.assign(new Error('fixture interrupted publication'),{code:'EIO'});};
  try{await assert.rejects(recordDelivery(f.options,accept),{code:'EIO'});}finally{fs.renameSync=originalRename;}
  assert.equal(readDeliveryRecords(f.specsDir).length,3);
  await recordDelivery(f.options,accept);assert.equal(readDeliveryRecords(f.specsDir).length,4,'interrupted unpublished stage is preserved without corrupting committed rows');
});

test('record capacity is rejected before confirmation, preserving a fully readable ledger',async()=>{
  const f=await fixture(),first=await recordDelivery(f.options,accept);let previous=first.recordDigest;
  const {recordDigest,...template}=first;
  for(let sequence=2;sequence<=1000;sequence++){
    const body={...template,sequence,previousDigest:previous},record={...body,recordDigest:digest(body)};
    const dir=path.join(f.specsDir,'.reviews','.delivery',String(sequence).padStart(6,'0'));fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir,'record.json'),JSON.stringify(record)+'\n');previous=record.recordDigest;
  }
  let asked=false;await assert.rejects(recordDelivery(f.options,{confirm:async()=>{asked=true;return 'yes';}}),{code:'delivery_record_limit'});
  assert.equal(asked,false);assert.equal(readDeliveryRecords(f.specsDir).length,1000);
});

test('R1 G8 environment casing and surrounding spaces cannot hide a later revocation',async()=>{
  const f=await fixture();await recordDelivery(f.options,accept);
  await recordDelivery({...f.options,statement:{...f.options.statement,environment:'Staging ',outcome:'revoked'}},accept);
  const value=f.projection().productAcceptance;assert.equal(value.environments.length,1);
  assert.equal(value.environments[0].environment,'staging');assert.equal(value.environments[0].statement.outcome,'revoked');
});

test('R1 G9 harmless Finder metadata does not hide delivery records while malformed entries still fail',async()=>{
  const f=await fixture();await recordDelivery(f.options,accept);
  const dir=path.join(f.specsDir,'.reviews','.delivery');fs.writeFileSync(path.join(dir,'.DS_Store'),'finder metadata');
  assert.equal(readDeliveryRecords(f.specsDir).length,1);assert.equal(f.projection().productAcceptance.status,'recorded');
  fs.mkdirSync(path.join(dir,'garbage'));assert.throws(()=>readDeliveryRecords(f.specsDir));
});

test('R1 G10 a display evidence budget reports unknown without hashing a large artifact',async()=>{
  const f=await fixture();await recordDelivery(f.options,accept);const candidate=deliveryCandidate(f.options);
  const value=deliveryProjection({...f.options,identity,packageDigest:candidate.packageDigest,specificationDigest:candidate.specificationDigest,maxEvidenceBytes:1});
  assert.equal(value.productAcceptance.status,'unknown');assert.equal(value.productAcceptance.environments[0].reason,'delivery_evidence_budget_exceeded');
});
