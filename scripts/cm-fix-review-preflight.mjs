#!/usr/bin/env node
// Synthetic local capability probe; no review or permission is issued here.
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {previewClaudeTools} from '../runtime/js/cm-ai/claude-tool-preview.mjs';
import {createReviewVerificationSession} from '../runtime/js/cm-fix/review-verification.mjs';
import {readReviewVerification} from '../runtime/js/cm-fix/review-verification-contract.mjs';
import {need} from '../runtime/js/cm-ai/effect-contract.mjs';
export async function previewFixReviewVerification({codeProject,configuration,model,effort}){
 const verification=readReviewVerification(configuration);
 const session=createReviewVerificationSession({codeProject,configuration:verification,
  request:{provider:'claude',requestDigest:'0'.repeat(64),payload:{reviewPackage:{packageDigest:'0'.repeat(64),files:[]}}}});
 try{return {...await previewClaudeTools({cwd:codeProject,model,effort,verification,verificationTransport:session.transport}),timeoutMs:900000};}
 finally{await session.close();}
}
if(process.argv[1]&&fs.realpathSync(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
  const a=process.argv.slice(2);need((a.length===4||a.length===6)&&a[0]==='--config'&&a[2]==='--model'&&(a.length===4||a[4]==='--effort'),'invalid_arguments');
  const st=fs.lstatSync(a[1]);need(st.isFile()&&!st.isSymbolicLink()&&st.size<=65536,'invalid_fix_config');
  const run=JSON.parse(fs.readFileSync(a[1],'utf8'));
  const result=await previewFixReviewVerification({codeProject:run.reproduction.cwd,configuration:run.reviewVerification,model:a[3],...(a[5]?{effort:a[5]}:{})});
  process.stdout.write(JSON.stringify(result)+'\n');process.exitCode=result.preflight.passed?0:1;
 }catch(e){process.stderr.write(JSON.stringify({code:/^[a-z_]+$/.test(e.code??'')?e.code:'review_verification_preflight_failed'})+'\n');process.exitCode=1;}
}
