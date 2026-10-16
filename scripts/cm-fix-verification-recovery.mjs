#!/usr/bin/env node
// Read-only inspection: no writer, provider, installation, or source writes.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {inspectFixVerificationRecovery} from '../runtime/js/cm-fix/execution.mjs';
import {inspectVerificationDiagnostic} from '../runtime/js/cm-fix/review-verification-diagnostic.mjs';
import {readExecutionSnapshot} from '../runtime/js/cm-ai/execution-snapshot.mjs';
import {digest,need} from '../runtime/js/cm-ai/effect-contract.mjs';
export async function main(argv=process.argv.slice(2),{output=process.stdout,error=process.stderr}={}){
 let configuration,reviewPackage;
 try{
  need([2,4].includes(argv.length)&&argv[0]==='--config'&&(argv.length===2||argv[2]==='--source-correction'),'invalid_arguments');
  let sourceCorrection;
  if(argv.length===4){
   const stat=fs.lstatSync(argv[3]);need(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=64*1024,'invalid_arguments');
   sourceCorrection=JSON.parse(fs.readFileSync(argv[3],'utf8'));
  }
  const c=JSON.parse(fs.readFileSync(argv[1],'utf8'));
  const specsRoot=fs.realpathSync(c.specsRoot??path.join(c.reproduction.cwd,'docs','fixes'));
  const snapshot=readExecutionSnapshot({specsRoot,identity:{repositoryId:c.identity.repositoryId,runId:c.identity.runId}});
  need(digest(c.identity)===digest(snapshot.records[0].payload.identity),'fix_verification_recovery_binding');
  configuration=snapshot.records[0].payload.configuration.reviewVerification;reviewPackage=snapshot.records.findLast(r=>r.id.endsWith('-registered')&&r.payload.request?.role==='reviewer')?.payload.request.payload.reviewPackage;
  const expected=await inspectFixVerificationRecovery({specsRoot,identity:{repositoryId:c.identity.repositoryId,runId:c.identity.runId},...(sourceCorrection===undefined?{}:{sourceCorrection})});
  output.write(JSON.stringify({eligible:true,expected})+'\n');return 0;
 }catch(e){
  const code=/^[a-z_]{1,64}$/.test(e?.code??'')?e.code:'fix_verification_recovery_unavailable';
  // Only contract-validated structured diagnostics, never raw errors/command output.
  let diagnostic;try{if(e.verificationDiagnostic&&configuration&&reviewPackage)diagnostic=inspectVerificationDiagnostic(e.verificationDiagnostic,{configuration,providerThreadId:null,request:{provider:'claude',requestDigest:digest({packageDigest:reviewPackage.packageDigest,profile:configuration}),payload:{reviewPackage}}});}catch{}
  error.write(JSON.stringify({eligible:false,code,...(diagnostic?{verificationDiagnostic:diagnostic}:{})})+'\n');return 1;
 }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))process.exitCode=await main();
