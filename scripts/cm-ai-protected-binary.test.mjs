// Real protected host/sandbox fixtures. Reviewer output is synthetic and is
// explicitly not independent review evidence for the implementation itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {protectedDevelopEdits} from './cm-ai-drive.mjs';
import {identity,protectedResultFixture,implementedValue,runCli,lastCheckpoint,syntheticReviewConfig} from './cm-ai-host-fixture.mjs';

const target='assets/fonts/fixture.ttf';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const result=run=>run.rows.find(row=>row.requestId==='advance')?.result;
// The verdict remains synthetic, but every verification tool invocation goes
// through the real session-owned MCP server and its OS sandbox. The fixture
// cannot manufacture collected evidence by returning an approved string.
function installBinaryReviewer(f,{useTools=true,verdict='approved',provider='claude'}={}){
  if(provider==='codex'){
    const real=spawnSync('/usr/bin/which',['codex'],{encoding:'utf8'}).stdout.trim();
    const source=new URL('./fixtures/binary-review-codex.mjs',import.meta.url).href;
    fs.writeFileSync(path.join(f.root,'synthetic-review-bin','codex'),`#!${process.execPath}\n`
      +`const {spawnSync}=await import('node:child_process');\n`
      +`if(process.argv[2]==='sandbox'){const r=spawnSync(${JSON.stringify(real)},process.argv.slice(2),{stdio:'inherit'});process.exitCode=r.status??1;}\n`
      +`else await import(${JSON.stringify(source)});\n`,{mode:0o700});
    f.runtime='codex';
    const index=f.args.indexOf('--runtime');
    if(index<0)f.args.push('--runtime','codex');else f.args[index+1]='codex';
    fs.writeFileSync(f.reviewFile,JSON.stringify(syntheticReviewConfig(f.codeProject,'codex')));
    return;
  }
  const source=String.raw`#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {randomUUID} from 'node:crypto';
if(process.argv.includes('--version')){console.log('2.1.274 (Claude Code)');process.exit(0);}
let prompt='';for await(const chunk of process.stdin)prompt+=chunk;
const args=process.argv.slice(2),encoded=args[args.indexOf('--mcp-config')+1];
const mcp=JSON.parse(encoded).mcpServers.cm_review;
let child=null,closed=null,pending=new Map(),sequence=0;
const rpc=(method,params)=>new Promise((resolve,reject)=>{
 const id=++sequence;pending.set(id,{resolve,reject});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,...(params?{params}:{})})+'\n');
});
const call=async(name,arguments_)=>{
 const row=await rpc('tools/call',{name,arguments:arguments_});assert.notEqual(row.isError,true,JSON.stringify(row));
 return JSON.parse(row.content[0].text);
};
try{
 let tools=[];
 if(mcp){
  child=spawn(mcp.command,mcp.args,{stdio:['pipe','pipe','inherit']});
  closed=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',code=>{
   for(const waiter of pending.values())waiter.reject(Error('MCP exited '+code));pending.clear();resolve(code);
  });});
  createInterface({input:child.stdout,crlfDelay:Infinity}).on('line',line=>{
   const row=JSON.parse(line),waiter=pending.get(row.id);if(!waiter)return;pending.delete(row.id);
   row.error?waiter.reject(Error(JSON.stringify(row.error))):waiter.resolve(row.result);
  });
  tools=(await rpc('tools/list')).tools;
 }
 if(process.env.ANTHROPIC_API_KEY==='cm-synthetic-local-probe'){
  assert.match(process.env.ANTHROPIC_BASE_URL,/^http:\/\/127\.0\.0\.1:\d+$/);
  const base=process.env.ANTHROPIC_BASE_URL,model=args[args.indexOf('--model')+1];
  await fetch(base+'/api/hello',{method:'HEAD'});
  await fetch(base+'/v1/messages',{method:'POST',headers:{'x-api-key':'cm-synthetic-local-probe'},
   body:JSON.stringify({model,messages:[{role:'user',content:prompt}],tools:tools.map(t=>({...t,name:'mcp__cm_review__'+t.name}))})});
  process.exitCode=1;
 }else{
  const marker='<cm-review-data-json>\n',data=JSON.parse(prompt.slice(prompt.indexOf(marker)+marker.length).split('\n')[0]);
  if(${JSON.stringify(useTools)}){
   assert(mcp,'binary review must use its real isolated tools');
   for(const change of data.reviewPackage.changes)for(const version of ['before','after']){
    const file=change[version];if(file?.contentBlob){const read=await call('read_binary',{path:change.path,version,length:16});
     assert.equal(read.sha256,file.sha256);assert.equal(read.totalBytes,file.size);}
   }
   for(const file of data.reviewPackage.unchangedScope??[])if(file.contentBlob){
    const read=await call('read_binary',{path:file.path,version:'after',length:16});assert.equal(read.sha256,file.sha256);
   }
   const checked=await call('run_check',{id:'asset-integrity'});assert.equal(checked.outcome,'passed',JSON.stringify(checked));
  }
  const verdict=${JSON.stringify(verdict)};
  const value={verdict,packageDigest:data.reviewPackage.packageDigest,examinedPaths:data.examinedPaths,
   findings:verdict==='changes_requested'?[{id:'F1',severity:'P2',path:'target.mjs',message:'Revise the text constant',evidence:'Synthetic scoped revision request'}]:[],
   summary:'Synthetic verdict after real isolated binary tool verification'},session_id=randomUUID();
  for(const event of [{type:'system',subtype:'init',session_id},{type:'assistant',session_id,parent_tool_use_id:null,
   message:{role:'assistant',content:[{type:'text',text:JSON.stringify(value)}]}},
   {type:'result',subtype:'success',session_id,is_error:false,num_turns:1,structured_output:value,result:JSON.stringify(value)}])console.log(JSON.stringify(event));
 }
}finally{if(child){child.stdin.end();assert.equal(await closed,0);}}
`;
  fs.writeFileSync(path.join(f.root,'synthetic-review-bin','claude'),source,{mode:0o700});
  f.runtime='claude';if(!f.args.includes('--runtime'))f.args.push('--runtime','claude');
  fs.writeFileSync(f.reviewFile,JSON.stringify(syntheticReviewConfig(f.codeProject,'claude')));
}
function fixture(t,{permission=true,bytes=Buffer.alloc(1024*1024+4097,0xa5),provider='claude'}={}){
  const f=protectedResultFixture();
  t.after(()=>fs.rmSync(f.root,{recursive:true,force:true}));
  bytes.writeUInt32BE(65536,0); // sfnt signature only; these bytes are not a font glyph validation fixture.
  installBinaryReviewer(f,{provider});
  const definition=JSON.parse(fs.readFileSync(f.config));
  definition.scope.push(target);fs.writeFileSync(f.config,JSON.stringify(definition));
  const sourceRoot=path.join(f.root,'answers');fs.mkdirSync(sourceRoot);
  const source=path.join(sourceRoot,'font.ttf');fs.writeFileSync(source,bytes);
  const protectionFile=f.args[f.args.indexOf('--protected-conversation-config')+1];
  const protection=JSON.parse(fs.readFileSync(protectionFile));
  const binaryAssets={version:1,paths:[target],sourceRoot};
  if(permission)protection.binaryAssets=binaryAssets;
  fs.writeFileSync(protectionFile,JSON.stringify(protection));
  f.operation='start';
  f.develop=payload=>({status:'succeeded',value:implementedValue(),edits:[
    {path:'target.mjs',beforeSha256:payload.expected['target.mjs'],content:'export const value = 42;\n'},
    {path:target,beforeSha256:payload.expected[target],asset:{path:'font.ttf',sha256:hash(bytes),size:bytes.length},mode:'0644'},
  ]});
  return Object.assign(f,{sourceRoot,source,bytes,binaryAssets,protectionFile});
}
function noCodeWritten(f){
  assert.equal(fs.existsSync(path.join(f.codeProject,'target.mjs')),false,'a rejected mixed proposal must not partly write its text edit');
  assert.equal(fs.existsSync(path.join(f.codeProject,target)),false,'a rejected proposal must not write the binary asset');
}
function stateFile(f){return path.join(f.specsDir,'.reviews','.execution',identity.runId,'state.json');}
function operation(f,name,{attempt=1,packageDigest}={}){
  f.request={version:1,operation:name,requestId:'advance',identity:{...identity,attempt},
    ...(packageDigest?{packageDigest}:{})};
}
function reviewEvidenceFiles(f){
  const root=path.join(f.specsDir,'.reviews','.binary-review',identity.repositoryId,identity.runId);
  return fs.readdirSync(root).flatMap(request=>fs.readdirSync(path.join(root,request))
    .filter(name=>name.endsWith('.json')).map(name=>path.join(root,request,name)));
}
function removeReviewEvidence(f){
  const saved=reviewEvidenceFiles(f).map(file=>({file,bytes:fs.readFileSync(file)}));
  assert.ok(saved.length>0,'the actual review must have produced tool evidence');
  for(const item of saved)fs.unlinkSync(item.file);
  return ()=>{for(const {file,bytes} of saved)fs.writeFileSync(file,bytes,{mode:0o600,flag:'wx'});};
}

test('protected binary driver emits bounded external source references and preserves old text shape',t=>{
  const f=fixture(t);
  fs.writeFileSync(path.join(f.sourceRoot,'text.txt'),'\ufeffexport const value = 42;\r\n');
  const edits=protectedDevelopEdits({'target.mjs':'text.txt',[target]:'font.ttf'},f.sourceRoot,f.codeProject,
    {'target.mjs':null,[target]:null},f.binaryAssets);
  assert.deepEqual(edits,[{path:'target.mjs',beforeSha256:null,content:'\ufeffexport const value = 42;\r\n'},
    {path:target,beforeSha256:null,asset:{path:'font.ttf',sha256:hash(f.bytes),size:f.bytes.length}}]);
  assert.deepEqual(protectedDevelopEdits({'target.mjs':'text.txt'},f.sourceRoot,f.codeProject,{'target.mjs':null}),[edits[0]]);
  assert.deepEqual(protectedDevelopEdits({[target]:{delete:true}},f.sourceRoot,f.codeProject,{[target]:hash(f.bytes)},f.binaryAssets),
    [{path:target,beforeSha256:hash(f.bytes),content:null}]);
});

test('protected binary driver rejects an undeclared binary and executable binary mode',t=>{
  const f=fixture(t);
  assert.throws(()=>protectedDevelopEdits({[target]:'font.ttf'},f.sourceRoot,f.codeProject,{[target]:null}));
  assert.throws(()=>protectedDevelopEdits({[target]:{file:'font.ttf',mode:'0755'}},f.sourceRoot,f.codeProject,{[target]:null},f.binaryAssets));
});

test('real protected driver CLI preflights >2 MiB binary references then starts and resumes the same owner',t=>{
  const f=fixture(t,{bytes:Buffer.alloc(3*1024*1024+7,0xb7)});
  fs.writeFileSync(path.join(f.sourceRoot,'target.mjs'),'export const value = 42;\n');
  fs.writeFileSync(path.join(f.sourceRoot,'develop.json'),JSON.stringify({status:'succeeded',value:implementedValue(),
    edits:{'target.mjs':'target.mjs',[target]:{file:'font.ttf',mode:'0644'}}}));
  const cli=fileURLToPath(new URL('./cm-ai-drive.mjs',import.meta.url));
  const planFile=path.join(f.root,'PLAN.json');
  const writePlan=mode=>fs.writeFileSync(planFile,JSON.stringify({config:f.config,mode,
    runtime:'claude',
    hostContext:'native-host-fixture',...(mode==='resume'?{originalHostContext:'native-host-fixture'}:{}),
    permissions:['--protected-conversation-config',f.protectionFile,'--review-config',f.reviewFile],answers:'answers'}));
  const drive=operation=>spawnSync(process.execPath,[cli,'--plan',planFile,operation],
    {encoding:'utf8',env:f.env,timeout:30000});
  writePlan('create');
  const started=drive('start');assert.equal(started.status,0,started.stderr);
  assert.equal(JSON.parse(started.stdout).result.state,'awaiting_review',started.stdout);
  assert.deepEqual(fs.readFileSync(path.join(f.codeProject,target)),f.bytes);
  assert.ok(fs.statSync(stateFile(f)).size<512*1024,'preflight and owner preserve bounded reference-only records');
  writePlan('resume');
  const completed=drive('advance');assert.equal(completed.status,0,completed.stderr);
  assert.equal(JSON.parse(completed.stdout).result.state,'fixture_completed',completed.stdout);
  assert.match(fs.readFileSync(path.join(f.specsDir,'1.work','tasks.md'),'utf8'),/- \[x\] T-001/);
  const before=fs.readFileSync(stateFile(f));
  const resumed=drive('status');assert.equal(resumed.status,0,resumed.stderr);
  assert.equal(JSON.parse(resumed.stdout).result.state,'fixture_completed',resumed.stdout);
  assert.deepEqual(fs.readFileSync(stateFile(f)),before);
});

for(const provider of ['claude','codex'])test(`real protected mixed >1 MiB binary ${provider==='codex'?'Codex native MCP ':''}runs checks, synthetic review, completion and exact durable resume`,async t=>{
  const f=fixture(t,{provider});
  const started=await runCli(f,'normal');
  assert.equal(started.code,0,started.stderr);
  assert.equal(result(started)?.state,'awaiting_review',JSON.stringify(result(started)));
  assert.deepEqual(fs.readFileSync(path.join(f.codeProject,target)),f.bytes);
  assert.equal(fs.statSync(path.join(f.codeProject,target)).mode&0o777,0o644);
  assert.equal(fs.readFileSync(path.join(f.codeProject,'target.mjs'),'utf8'),'export const value = 42;\n');
  const state=JSON.parse(fs.readFileSync(stateFile(f)));
  const serialized=JSON.stringify(state);
  assert.ok(serialized.length<512*1024,'binary bytes must not inflate the owner journal');
  assert.equal(serialized.includes(f.bytes.toString('base64')),false);
  const storeRoot=path.join(f.specsDir,'.reviews','.binary-assets',identity.repositoryId,identity.runId);
  assert.deepEqual(fs.readFileSync(path.join(storeRoot,hash(f.bytes))),f.bytes);
  const checkpoint=lastCheckpoint(f);
  assert.ok(checkpoint.currentChecks.some(check=>check.id==='syntax'&&check.outcome==='passed'&&check.exitCode===0),
    'the protected owner must run its original fixed syntax check before review');
  const pkg=checkpoint.reviewPackage;
  assert.ok(pkg,'the actual owner must construct its review package');
  const binary=pkg.changes.find(change=>change.path===target)?.after;
  assert.deepEqual(binary,{path:target,type:'file',mode:0o644,size:f.bytes.length,sha256:hash(f.bytes),contentBlob:hash(f.bytes)});
  assert.deepEqual(pkg.binaryAssets,{version:1,paths:[target],storeRoot});
  assert.deepEqual(state.records[0].payload.baseline.binaryAssets,pkg.binaryAssets,
    'the original owner baseline freezes the same binary capability');
  f.operation='advance';
  const completed=await runCli(f,'normal','resume');
  assert.equal(completed.code,0,completed.stderr);
  assert.equal(result(completed)?.state,'fixture_completed',JSON.stringify(result(completed)));
  const completedState=JSON.parse(fs.readFileSync(stateFile(f)));
  assert.deepEqual(completedState.records.slice(0,state.records.length),state.records,
    'review and completion append to the original protected owner history');
  const accepted=lastCheckpoint(f);
  assert.equal(accepted.receipt.execution.provider,provider);
  if(provider==='codex')assert.equal(accepted.receipt.execution.providerThreadId,'synthetic-binary-codex-review');
  assert.equal(accepted.receipt.result.verdict,'approved');
  assert.equal(accepted.receipt.packageDigest,pkg.packageDigest);
  const reviewRoot=path.join(f.specsDir,'.reviews','.binary-review',identity.repositoryId,identity.runId);
  const reviews=fs.readdirSync(reviewRoot).flatMap(requestDir=>fs.readdirSync(path.join(reviewRoot,requestDir))
    .filter(name=>name.endsWith('.json')).map(name=>JSON.parse(fs.readFileSync(path.join(reviewRoot,requestDir,name)))));
  assert.ok(reviews.some(row=>row.provider===provider&&row.evidence.binaryReads.some(read=>read.path===target&&read.version==='after'
    &&read.sha256===hash(f.bytes)&&read.size===f.bytes.length)
    &&row.evidence.checks.some(check=>check.id==='asset-integrity'&&check.exitCode===0)),
  'completion must bind the real tool reads and sandbox integrity check, not the synthetic verdict alone');
  const task=fs.readFileSync(path.join(f.specsDir,'1.work','tasks.md'),'utf8');
  assert.match(task,/- \[x\] T-001/);
  const completedBytes=fs.readFileSync(stateFile(f));
  // A valid resume verifies the content-addressed store; it does not need the
  // author's temporary source bytes after the proposal has been imported.
  fs.unlinkSync(f.source);
  f.develop=()=>{throw new Error('completed resume must not redevelop');};
  const replay=await runCli(f,'normal','resume');
  assert.equal(replay.code,0,replay.stderr);
  assert.equal(result(replay)?.state,'fixture_completed',JSON.stringify(result(replay)));
  assert.deepEqual(replay.calls,[]);
  assert.deepEqual(fs.readFileSync(stateFile(f)),completedBytes);
  assert.deepEqual(fs.readFileSync(path.join(f.codeProject,target)),f.bytes);
});

test('protected binary text-only approved review cannot complete without actual asset tool evidence',async t=>{
  const f=fixture(t),started=await runCli(f,'normal');
  assert.equal(started.code,0,started.stderr);
  assert.equal(result(started)?.state,'awaiting_review',JSON.stringify(result(started)));
  installBinaryReviewer(f,{useTools:false});f.operation='advance';
  const review=await runCli(f,'normal','resume');assert.equal(review.code,0,review.stderr);
  assert.notEqual(result(review)?.state,'fixture_completed',JSON.stringify(result(review)));
  assert.notEqual(result(review)?.state,'approved',JSON.stringify(result(review)));
  assert.match(fs.readFileSync(path.join(f.specsDir,'1.work','tasks.md'),'utf8'),/- \[ \] T-001/);
  assert.equal(fs.existsSync(path.join(f.specsDir,'.reviews','work-T-001-r1.md')),false,
    'a synthetic approved verdict without tool evidence must not publish an accepted review receipt');
  assert.deepEqual(fs.readFileSync(path.join(f.codeProject,target)),f.bytes);
});

test('completed protected binary owner rejects missing review sidecar without rewriting its history',async t=>{
  const f=fixture(t),started=await runCli(f,'normal');assert.equal(started.code,0,started.stderr);
  f.operation='advance';const completed=await runCli(f,'normal','resume');
  assert.equal(completed.code,0,completed.stderr);assert.equal(result(completed)?.state,'fixture_completed',JSON.stringify(result(completed)));
  const before=fs.readFileSync(stateFile(f)),restore=removeReviewEvidence(f);
  f.develop=()=>{throw new Error('history verification cannot redevelop');};operation(f,'status');
  try{
    const missing=await runCli(f,'normal','resume');assert.equal(missing.code,1,missing.stderr);
    assert.match(missing.stderr,/"error":\{"code":"host_launch_failed"/,missing.stderr);
    assert.deepEqual(missing.calls,[]);assert.deepEqual(fs.readFileSync(stateFile(f)),before);
  }finally{restore();}
  const resumed=await runCli(f,'normal','resume');assert.equal(resumed.code,0,resumed.stderr);
  assert.equal(result(resumed)?.state,'fixture_completed',JSON.stringify(result(resumed)));
  assert.deepEqual(resumed.calls,[]);assert.deepEqual(fs.readFileSync(stateFile(f)),before);
  assert.match(fs.readFileSync(path.join(f.specsDir,'1.work','tasks.md'),'utf8'),/- \[x\] T-001/);
});

test('approved protected binary owner cannot complete after losing its real tool evidence',async t=>{
  const f=fixture(t),started=await runCli(f,'normal');assert.equal(started.code,0,started.stderr);
  operation(f,'decision',{packageDigest:result(started).packageDigest});
  const approved=await runCli(f,'normal','resume');assert.equal(approved.code,0,approved.stderr);
  assert.equal(result(approved)?.state,'approved',JSON.stringify(result(approved)));
  const before=fs.readFileSync(stateFile(f)),restore=removeReviewEvidence(f);
  f.develop=()=>{throw new Error('missing evidence must not redevelop');};
  operation(f,'complete',{packageDigest:result(approved).packageDigest});
  try{
    const missing=await runCli(f,'normal','resume');assert.equal(missing.code,1,missing.stderr);
    assert.match(missing.stderr,/"error":\{"code":"host_launch_failed"/,missing.stderr);
    assert.deepEqual(missing.calls,[]);assert.deepEqual(fs.readFileSync(stateFile(f)),before);
    assert.match(fs.readFileSync(path.join(f.specsDir,'1.work','tasks.md'),'utf8'),/- \[ \] T-001/);
  }finally{restore();}
});

test('protected binary round two resumes with an unchanged >2 MiB asset and completes after real tool review',async t=>{
  const f=fixture(t,{bytes:Buffer.alloc(3*1024*1024+7,0xc9)});
  // The binary is already present in the original baseline. An asset first
  // introduced in r1 remains a change against that original baseline in r2.
  fs.mkdirSync(path.dirname(path.join(f.codeProject,target)),{recursive:true});
  fs.writeFileSync(path.join(f.codeProject,target),f.bytes,{mode:0o644});
  installBinaryReviewer(f,{verdict:'changes_requested'});
  const started=await runCli(f,'normal');assert.equal(started.code,0,started.stderr);
  operation(f,'decision',{packageDigest:result(started).packageDigest});
  const reviewed=await runCli(f,'normal','resume');assert.equal(reviewed.code,0,reviewed.stderr);
  assert.equal(result(reviewed)?.state,'changes_requested',JSON.stringify(result(reviewed)));
  assert.deepEqual(fs.readFileSync(path.join(f.codeProject,target)),f.bytes);
  installBinaryReviewer(f);
  f.develop=payload=>({status:'succeeded',value:implementedValue(),edits:[
    {path:'target.mjs',beforeSha256:payload.expected['target.mjs'],content:'export const value = 43;\n'},
  ]});
  operation(f,'start',{attempt:2});
  const revised=await runCli(f,'normal','resume');assert.equal(revised.code,0,revised.stderr);
  assert.equal(result(revised)?.state,'awaiting_review',JSON.stringify(result(revised)));
  const checkpoint=lastCheckpoint(f),unchanged=checkpoint.reviewPackage.unchangedScope.find(file=>file.path===target);
  assert.deepEqual(unchanged,{path:target,type:'file',mode:0o644,size:f.bytes.length,sha256:hash(f.bytes),contentBlob:hash(f.bytes)});
  const beforeReview=fs.readFileSync(stateFile(f));
  f.develop=()=>{throw new Error('round two restore must not repeat development');};operation(f,'status',{attempt:2});
  const restored=await runCli(f,'normal','resume');assert.equal(restored.code,0,restored.stderr);
  assert.equal(result(restored)?.state,'awaiting_review',JSON.stringify(result(restored)));
  assert.deepEqual(fs.readFileSync(stateFile(f)),beforeReview);
  operation(f,'advance',{attempt:2});
  const completed=await runCli(f,'normal','resume');assert.equal(completed.code,0,completed.stderr);
  assert.equal(result(completed)?.state,'fixture_completed',JSON.stringify(result(completed)));
  const completeBytes=fs.readFileSync(stateFile(f));operation(f,'status',{attempt:2});
  const replay=await runCli(f,'normal','resume');assert.equal(replay.code,0,replay.stderr);
  assert.equal(result(replay)?.state,'fixture_completed',JSON.stringify(result(replay)));
  assert.deepEqual(fs.readFileSync(stateFile(f)),completeBytes);
  assert.equal(fs.readFileSync(path.join(f.codeProject,'target.mjs'),'utf8'),'export const value = 43;\n');
  assert.deepEqual(fs.readFileSync(path.join(f.codeProject,target)),f.bytes);
  const latest=reviewEvidenceFiles(f).map(file=>JSON.parse(fs.readFileSync(file))).find(row=>row.identity.attempt===2);
  assert.ok(latest?.evidence.binaryReads.some(read=>read.path===target&&read.version==='after'&&read.sha256===hash(f.bytes)));
});

test('protected binary corrupt stored bytes cannot resume into review or completion',async t=>{
  const f=fixture(t),started=await runCli(f,'normal');
  assert.equal(started.code,0,started.stderr);
  assert.equal(result(started)?.state,'awaiting_review',JSON.stringify(result(started)));
  const blob=path.join(f.specsDir,'.reviews','.binary-assets',identity.repositoryId,identity.runId,hash(f.bytes));
  fs.writeFileSync(blob,Buffer.alloc(f.bytes.length,0x77));
  const before=fs.readFileSync(stateFile(f));
  f.operation='advance';
  f.develop=()=>{throw new Error('store corruption must never redevelop');};
  const replay=await runCli(f,'normal','resume');
  assert.ok(replay.code!==0||['blocked','unknown'].includes(result(replay)?.state),JSON.stringify(result(replay)));
  assert.deepEqual(fs.readFileSync(stateFile(f)),before,'refused stored bytes must not replace historical owner evidence');
  assert.match(fs.readFileSync(path.join(f.specsDir,'1.work','tasks.md'),'utf8'),/- \[ \] T-001/);
  assert.deepEqual(fs.readFileSync(path.join(f.codeProject,target)),f.bytes,'invalid stored evidence must not rewrite the project');
});

for(const variant of ['no-permission','bad-digest','stale-source','symlink-source','hardlink-source','oversize','executable'])
test(`protected binary ${variant} rejects the complete mixed proposal before code writes`,async t=>{
  const f=fixture(t,{permission:variant!=='no-permission'}),original=f.develop;
  if(variant==='symlink-source'){
    const real=path.join(f.sourceRoot,'real.ttf');fs.renameSync(f.source,real);fs.symlinkSync(real,f.source);
  }
  if(variant==='hardlink-source')fs.linkSync(f.source,path.join(f.sourceRoot,'linked.ttf'));
  if(variant==='stale-source')fs.writeFileSync(f.source,Buffer.alloc(f.bytes.length,0x44));
  if(variant==='oversize')fs.truncateSync(f.source,128*1024*1024+1);
  f.develop=payload=>{
    const value=original(payload),edit=value.edits.at(-1);
    if(variant==='bad-digest')edit.asset.sha256='0'.repeat(64);
    if(variant==='oversize')edit.asset.size=128*1024*1024+1;
    if(variant==='executable')edit.mode='0755';
    return value;
  };
  const run=await runCli(f,'normal');assert.equal(run.code,0,run.stderr);
  assert.equal(result(run)?.state,'blocked',JSON.stringify(result(run)));
  assert.equal(result(run)?.code,'developer_result_invalid',JSON.stringify(result(run)));
  noCodeWritten(f);
});

test('protected binary cancelled host cannot apply a pending proposal',async t=>{
  const f=fixture(t);
  const cancelled=await runCli(f,'cancel');
  assert.equal(cancelled.code,0,cancelled.stderr);
  assert.equal(result(cancelled)?.state,'cancelled',JSON.stringify(result(cancelled)));
  noCodeWritten(f);
});

test('old protected text owner still reaches completion without binary configuration',async t=>{
  const f=protectedResultFixture();t.after(()=>fs.rmSync(f.root,{recursive:true,force:true}));
  f.operation='start';
  f.develop=payload=>({status:'succeeded',value:implementedValue(),edits:[
    {path:'target.mjs',beforeSha256:payload.expected['target.mjs'],content:'export const value = 42;\n'},
  ]});
  const started=await runCli(f,'normal');assert.equal(started.code,0,started.stderr);
  assert.equal(result(started)?.state,'awaiting_review',JSON.stringify(result(started)));
  assert.equal(JSON.stringify(lastCheckpoint(f)).includes('binaryAssets'),false);
  f.operation='advance';
  const completed=await runCli(f,'normal','resume');assert.equal(completed.code,0,completed.stderr);
  assert.equal(result(completed)?.state,'fixture_completed',JSON.stringify(result(completed)));
});
