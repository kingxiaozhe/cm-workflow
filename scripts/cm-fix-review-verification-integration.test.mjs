import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawn,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createFixReviewHost} from '../runtime/js/cm-fix/host-review.mjs';
import {claudeWorker,claudeReviewFingerprint,claudeReviewArgs} from '../runtime/js/cm-ai/worker-claude.mjs';
import {openFixExecution} from '../runtime/js/cm-fix/execution.mjs';
const verification={files:['value.mjs','value.test.mjs'],checks:[{id:'unit',command:[process.execPath,'value.test.mjs']}],mutationPaths:['value.mjs'],timeoutMs:5000};
test('isolated Claude args preserve native tool prohibition and bind the exact profile',()=>{
 const base=claudeReviewArgs('synthetic'),args=claudeReviewArgs('synthetic',null,verification,{mcpConfig:'FIXED'});
 assert(base.includes('--safe-mode'));assert(!base.includes('--restricted'));assert.equal(base[base.indexOf('--mcp-config')+1],'{"mcpServers":{}}');
 assert(args.includes('--restricted'));assert(!args.includes('--safe-mode'));assert.equal(args[args.indexOf('--mcp-config')+1],'FIXED');
 assert.equal(args[args.indexOf('--tools')+1],'');assert.equal(args[args.indexOf('--setting-sources')+1],'');
 const options={cwd:'/fixture',model:'synthetic'};
 assert.notEqual(claudeReviewFingerprint(options),claudeReviewFingerprint({...options,verification}));
 assert.notEqual(claudeReviewFingerprint({...options,verification}),claudeReviewFingerprint({...options,verification:{...verification,timeoutMs:6000}}));
});
for(const mode of ['valid','missing-mutation','failed-check'])test(`real MCP server and CLI protocol ${mode} preserves mechanical cause evidence across resume`,{skip:process.platform!=='darwin',timeout:30000},async()=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'fix-tools-integration-'))),cwd=path.join(root,'code'),specsRoot=path.join(root,'specs');
 fs.mkdirSync(cwd);fs.mkdirSync(specsRoot);
 fs.writeFileSync(path.join(cwd,'value.mjs'),'export const value=1;');
 fs.writeFileSync(path.join(cwd,'value.test.mjs'),mode==='failed-check'?"process.stderr.write('SYNTHETIC_PRIVATE_OUTPUT_DO_NOT_PERSIST');process.exit(1);":"import {value} from './value.mjs';if(value!==1)process.exit(1);");
 fs.writeFileSync(path.join(cwd,'.cm-workflow.json'),JSON.stringify({version:1,policies:{delivery:'diff'},roles:{coder:{adapter:'codex-cli'},reviewer:{adapter:'claude-cli'}},runtimes:{available:'both'}}));
 const review={model:'synthetic',disabledSkills:[],preflight:{passed:true,provider:'claude',prompt_transport:'stdin',config_fingerprint:claudeReviewFingerprint({cwd,model:'synthetic',verification})}};
 let calls=0,owner;
 const fixture=fileURLToPath(new URL('./fixtures/fix-verification-claude.mjs',import.meta.url));
 const host=createFixReviewHost({codeProject:cwd,hostContextId:'author',runtime:'codex',reviewRuntime:'claude',review,verification,permissions:['--allow-cause-review'],workerFactory:options=>claudeWorker({...options,spawnProcess:(_cli,args,opts)=>{calls++;return spawn(process.execPath,[fixture,...args],{...opts,env:{...opts.env,CM_VERIFICATION_FIXTURE_MODE:mode}});}})});
 const identity={repositoryId:'fixture',runId:'tools-integration',taskId:'T-FIX-tools',attempt:1};
 const configuration={hostContextId:'author',reviewRuntime:'claude',causeReview:host.reviewer,reviewVerification:verification,defect:'Fixture missing value guard',reproduction:{cwd,command:[process.execPath,'-e',"console.error('BUG');process.exit(3)"],expectedFailure:{exitCode:3,outputIncludes:'BUG'},timeoutMs:1000}};
 try{
  owner=openFixExecution({specsRoot,identity,configuration,create:true},{...host.execution,bridge:{async call(){return {status:'diagnosed',rootCause:'Synthetic root cause',plan:'Correct within scope after red test',affectedPaths:['value.mjs'],affectedModules:['value'],crossLayer:true};}}});
  await owner.advance({authorized:true});
  await host.authority.hostDecisionProvider.decide({identity,packageDigest:owner.causeReviewPackage().packageDigest},new AbortController().signal);
  const result=await owner.reviewCause();assert.equal(result.stage,mode==='valid'?'red_test_required':'unknown',JSON.stringify(result));assert.equal(calls,1);
  owner.close();owner=openFixExecution({specsRoot,identity,configuration,create:false},host.execution);
  assert.equal((await owner.reviewCause()).stage,result.stage);assert.equal(calls,1);
  const rows=JSON.parse(fs.readFileSync(path.join(specsRoot,'.reviews/.execution/tools-integration/state.json'))).records;
  const saved=rows.find(r=>r.id==='fix-cause-result').payload;
  if(mode!=='valid'){
   assert.equal(saved.observation.result.code,'review_verification_evidence');
   assert.equal(saved.verificationDiagnostic.code,mode==='failed-check'?'review_verification_check_failed':'review_verification_mutation_missing');
   assert.equal(saved.verificationDiagnostic.providerThreadId,'synthetic-isolated-review');
   assert(!JSON.stringify(saved.verificationDiagnostic).includes('SYNTHETIC_PRIVATE_OUTPUT'));
   assert(!Object.hasOwn(saved,'verification'));return;
  }
  const proof=saved.verification;
  assert.equal(proof.providerThreadId,'synthetic-isolated-review');assert.equal(proof.checks.length,1);assert.equal(proof.mutations.length,1);
  assert.deepEqual([proof.mutations[0].baselineExitCode,proof.mutations[0].mutatedExitCode,proof.mutations[0].restoredExitCode],[0,1,0]);
  assert.equal(fs.readFileSync(path.join(cwd,'value.mjs'),'utf8'),'export const value=1;');
 }finally{owner?.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('synthetic local preflight checks the actual MCP tool catalog through the same args',{skip:process.platform!=='darwin',timeout:30000},async()=>{
 const {previewClaudeTools}=await import('../runtime/js/cm-ai/claude-tool-preview.mjs');
 const {createReviewVerificationSession}=await import('../runtime/js/cm-fix/review-verification.mjs');
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'fix-tools-preflight-')));
 fs.writeFileSync(path.join(root,'value.mjs'),'export const value=1;');fs.writeFileSync(path.join(root,'value.test.mjs'),'');
 const s=createReviewVerificationSession({codeProject:root,configuration:verification,request:{requestDigest:'a'.repeat(64),payload:{reviewPackage:{packageDigest:'b'.repeat(64),files:[]}}}});
 try{
  const fixture=fileURLToPath(new URL('./fixtures/fix-verification-claude.mjs',import.meta.url));
  const receipt=await previewClaudeTools({cwd:root,model:'synthetic',verification,verificationTransport:s.transport,
   spawnProcess:(command,args,options)=>{assert.equal(command,'/usr/bin/sandbox-exec');return spawn(command,[...args.slice(0,2),process.execPath,fixture,...args.slice(3)],options);}});
  assert.equal(receipt.preflight.passed,true,JSON.stringify(receipt));
  assert(receipt.preflight.request_checks.some(c=>c.tool_names?.includes('mcp__cm_review__mutate_check')));
  assert.equal(receipt.preflight.config_fingerprint,claudeReviewFingerprint({cwd:root,model:'synthetic',verification}));
 }finally{await s.close();fs.rmSync(root,{recursive:true,force:true});}
});


test('one snapshot refuses a second MCP server before it can reset evidence',{skip:process.platform!=='darwin',timeout:10000},async()=>{
 const {createReviewVerificationSession}=await import('../runtime/js/cm-fix/review-verification.mjs');
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'fix-tools-single-server-')));
 fs.writeFileSync(path.join(root,'value.mjs'),'export const value=1;');fs.writeFileSync(path.join(root,'value.test.mjs'),'');
 const s=createReviewVerificationSession({codeProject:root,configuration:verification,request:{requestDigest:'a'.repeat(64),payload:{reviewPackage:{packageDigest:'b'.repeat(64),files:[]}}}});
 try{
  const server=fileURLToPath(new URL('../runtime/js/cm-fix/review-verification-server.mjs',import.meta.url));
  const args=[server,s.configPath],options={input:JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize'})+'\n',encoding:'utf8',timeout:3000};
  assert.equal(spawnSync(process.execPath,args,options).status,0);
  const second=spawnSync(process.execPath,args,options);
  assert.equal(second.status,1);assert.match(second.stderr,/review_verification_server_already_started/);assert.equal(second.stdout,'');
 }finally{await s.close();fs.rmSync(root,{recursive:true,force:true});}
});
