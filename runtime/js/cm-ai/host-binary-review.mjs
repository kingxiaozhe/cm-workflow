// Binary review always observes the exact assets through isolated native tools.
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {digest,id,hex,need,shape} from './effect-contract.mjs';
import {readBinaryAssetBinding,readBinaryAssetBytes} from './binary-assets.mjs';
import {claudeWorker,claudePreflightMatches} from './worker-claude.mjs';
import {previewClaudeTools} from './claude-tool-preview.mjs';
import {createClaudeReviewRun} from './claude-review-adapter.mjs';
import {codexWorker,preflightMatches} from './worker-codex.mjs';
import {previewIsolated} from './tool-preview.mjs';
import {createCodexReviewRun} from './codex-review-adapter.mjs';
import {createReviewVerificationSession,validateReviewVerificationInputs} from '../cm-fix/review-verification.mjs';
import {readReviewVerification,inspectReviewVerificationEvidence} from '../cm-fix/review-verification-contract.mjs';
import {binaryVerificationVersions} from '../cm-fix/review-verification-binary.mjs';
// Fixed host-authored program, not project code or an author-provided command.
const INTEGRITY=`const fs=require('node:fs'),p=require('node:path'),h=require('node:crypto');for(const r of JSON.parse(process.argv.slice(1).join(''))){if(r.deleted){if(fs.existsSync(r.path))process.exit(2);continue}const b=fs.readFileSync(r.path);if(b.length!==r.size||h.createHash('sha256').update(b).digest('hex')!==r.sha256)process.exit(3);const e=p.extname(r.path).toLowerCase(),s=b.subarray(0,12).toString('latin1');let ok=b.length>0;if(e==='.ttf')ok=b.length>=12&&b.readUInt32BE(0)===65536;else if(e==='.otf')ok=b.length>=12&&s.startsWith('OTTO');else if(e==='.woff'||e==='.woff2')ok=b.length>=(e==='.woff'?44:48)&&s.startsWith(e==='.woff'?'wOFF':'wOF2')&&b.readUInt32BE(8)===b.length;else if(e==='.png')ok=b.length>=45&&b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))&&s.slice(8,12)===String.fromCharCode(0,0,0,13)&&b.toString('ascii',12,16)==='IHDR';else if(e==='.jpg'||e==='.jpeg')ok=b.length>=4&&b[0]===255&&b[1]===216&&b.at(-2)===255&&b.at(-1)===217;else if(e==='.gif')ok=b.length>=13&&/^GIF8[79]a/.test(s);else if(e==='.webp')ok=b.length>=12&&s.startsWith('RIFF')&&s.slice(8)==='WEBP';else if(e==='.ico')ok=b.length>=6&&b.readUInt32BE(0)===256;else if(e==='.avif'||e==='.heic')ok=b.length>=16&&s.slice(4,8)==='ftyp';if(!ok)process.exit(4)}`;
export function binaryAssetReviewProfile({definition,binaryAssets,request,instructionPaths=null}){
 const pkg=request.payload.reviewPackage,binding=readBinaryAssetBinding(pkg.binaryAssets,request.identity);
 const {sourceRoot,...configured}=binaryAssets;
 need(pkg.kind==='cm-review-package'&&digest(readBinaryAssetBinding(configured,request.identity))===digest(binding),'binary_review_binding');
 const agents=new Set(['AGENTS.md']);
 for(const p of definition.scope)for(let d=path.posix.dirname(p);d!=='.';d=path.posix.dirname(d))agents.add(d+'/AGENTS.md');
 const boundPaths=new Set([...definition.scope,...definition.requirements,...(pkg.instructions??[]).map(r=>r.path),
  ...(pkg.requirements??[]).map(r=>r.path),...(pkg.unchangedScope??[]).map(r=>r.path),...(pkg.changes??[]).map(r=>r.path)]);
 if(instructionPaths!==null)need(Array.isArray(instructionPaths)&&new Set(instructionPaths).size===instructionPaths.length
  &&instructionPaths.every(p=>typeof p==='string'&&path.posix.basename(p)==='AGENTS.md'&&(agents.has(p)||boundPaths.has(p))),'binary_review_instruction_paths');
 const files=[...new Set([...definition.scope,...definition.requirements,...(pkg.instructions??[]).map(r=>r.path),
  ...(pkg.requirements??[]).map(r=>r.path),...(pkg.unchangedScope??[]).map(r=>r.path),...(pkg.changes??[]).map(r=>r.path),
  ...(instructionPaths??[...agents].filter(p=>fs.existsSync(path.join(definition.codeProject,p))))])].sort();
 const raw={files,checks:[{id:'asset-integrity',command:[process.execPath,'-e',INTEGRITY,'[]']}],mutationPaths:[],
  timeoutMs:60000,binaryAssets:{version:1,paths:[...binding.paths]},binaryReview:{version:1}};
 const versions=binaryVerificationVersions(raw,pkg),after=versions.filter(r=>r.version==='after').map(({path,size,sha256})=>({path,size,sha256}));
 for(const p of binding.paths)if(!after.some(r=>r.path===p))after.push({path:p,deleted:true});
 const encoded=JSON.stringify(after),chunks=[];for(let i=0;i<encoded.length;i+=1800)chunks.push(encoded.slice(i,i+1800));
 raw.checks[0].command=[process.execPath,'-e',INTEGRITY,...chunks];
 return readReviewVerification(raw);
}
function privateDirectory(root,parts,create=true){
 need(fs.realpathSync(root)===root,'binary_review_evidence_path');let current=root;
 for(const [i,part] of parts.entries()){current=path.join(current,part);if(create)try{fs.mkdirSync(current,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}
  const s=fs.lstatSync(current);need(s.isDirectory()&&!s.isSymbolicLink()&&fs.realpathSync(current)===current
   &&(i===0||(s.mode&0o077)===0),'binary_review_evidence_path');}
 return current;
}
export function verifyBinaryReviewEvidence({definition,binaryAssets,request,providerThreadId,inspectCurrent=true}){
 need(typeof inspectCurrent==='boolean','binary_review_evidence_binding');
 id(request.identity.repositoryId);id(request.identity.runId);hex(request.requestDigest);id(providerThreadId);
 const root=privateDirectory(definition.specsDir,['.reviews','.binary-review',request.identity.repositoryId,request.identity.runId,request.requestDigest],false);
 const file=path.join(root,digest(providerThreadId)+'.json'),st=fs.lstatSync(file);
 need(st.isFile()&&!st.isSymbolicLink()&&st.nlink===1&&(st.mode&0o777)===0o600&&st.size<=256*1024,'binary_review_evidence_path');
 const bytes=fs.readFileSync(file),value=JSON.parse(bytes),{evidenceDigest,...body}=value;
 shape(value,['version','identity','requestDigest','packageDigest','provider','requestedModel','profileDigest','providerThreadId','configuration','evidence','evidenceDigest']);
 need(bytes.equals(Buffer.from(JSON.stringify(value)+'\n')),'binary_review_evidence_changed');
 const configuration=binaryAssetReviewProfile({definition,binaryAssets,request,
  instructionPaths:inspectCurrent?null:value.configuration.files.filter(p=>path.posix.basename(p)==='AGENTS.md')});
 need(evidenceDigest===digest(body)&&value.version===1&&digest(value.identity)===digest(request.identity)
  &&value.requestDigest===request.requestDigest&&value.packageDigest===request.payload.reviewPackage.packageDigest
  &&value.provider===request.provider&&value.requestedModel===request.requestedModel
  &&value.providerThreadId===providerThreadId&&value.profileDigest===digest(configuration)
  &&digest(value.configuration)===digest(configuration),'binary_review_evidence_changed');
 const evidence=inspectReviewVerificationEvidence(value.evidence,{request,configuration,providerThreadId,binaryReview:true});
 // A completed historical receipt proves its original review. Later product
 // changes are handled by the owner's existing correction projection, while
 // immutable review bytes and the original mechanical evidence remain strict.
 for(const {version,...record} of evidence.binaryFiles)
  readBinaryAssetBytes({binding:request.payload.reviewPackage.binaryAssets,record:{...record,type:'file'}});
 if(inspectCurrent){
  const current=validateReviewVerificationInputs({codeProject:definition.codeProject,configuration,reviewPackage:request.payload.reviewPackage})
   .map(({data,binary,...record})=>record);
  need(digest(current)===evidence.snapshotDigest,'binary_review_source_drift');
 }
 return {path:file,evidenceDigest,evidence};
}
export function persistBinaryReviewEvidence({definition,request,configuration,evidence,providerThreadId}){
 id(request.identity.repositoryId);id(request.identity.runId);hex(request.requestDigest);id(providerThreadId);
 const root=privateDirectory(definition.specsDir,['.reviews','.binary-review',request.identity.repositoryId,request.identity.runId,request.requestDigest]);
 const body={version:1,identity:request.identity,requestDigest:request.requestDigest,packageDigest:request.payload.reviewPackage.packageDigest,
  provider:request.provider,requestedModel:request.requestedModel,
  profileDigest:digest(configuration),providerThreadId,configuration,evidence};
 const envelope={...body,evidenceDigest:digest(body)},bytes=Buffer.from(JSON.stringify(envelope)+'\n');need(bytes.length<=256*1024,'binary_review_evidence_limit');
 const target=path.join(root,digest(providerThreadId)+'.json'),temporary=path.join(root,'.'+randomUUID());let fd;
 try{fd=fs.openSync(temporary,'wx',0o600);fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
  try{fs.linkSync(temporary,target);}catch(e){if(e.code!=='EEXIST')throw e;}fs.unlinkSync(temporary);
  const st=fs.lstatSync(target);need(st.isFile()&&!st.isSymbolicLink()&&st.nlink===1&&(st.mode&0o777)===0o600,'binary_review_evidence_path');
  const observed=fs.readFileSync(target),parsed=JSON.parse(observed),{evidenceDigest,...payload}=parsed;
  need(observed.equals(bytes)&&evidenceDigest===digest(payload),'binary_review_evidence_changed');
  const dir=fs.openSync(root,'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}return {path:target,evidenceDigest};
 }finally{if(fd!==undefined)fs.closeSync(fd);try{fs.unlinkSync(temporary);}catch(e){if(e.code!=='ENOENT')throw e;}}
}
export async function runBinaryAssetReview({definition,binaryAssets,reviewOptions,request,control,executionPolicy},dependencies={}){
 const codex=request.provider==='codex';
 // Keep the existing injected callbacks usable by both provider fixtures. The
 // default bridge shares the same binary profile, session and evidence gates.
 const preview=dependencies.preview??(codex?async options=>({preflight:await previewIsolated({...options,allowCodeProject:true})}):previewClaudeTools);
 const worker=dependencies.worker??(codex?codexWorker:claudeWorker);
 const matches=codex?preflightMatches:claudePreflightMatches,adapter=codex?createCodexReviewRun:createClaudeReviewRun;
 let probe,session,result,thread=null;
 try{
  need(['codex','claude'].includes(request.provider)&&request.requestedModel===reviewOptions.model,'binary_review_provider');
  need(!control.signal.aborted,'cancelled');
  const verification=binaryAssetReviewProfile({definition,binaryAssets,request});
  probe=createReviewVerificationSession({codeProject:definition.codeProject,configuration:verification,request,binaryReview:true});
  const observed=await preview({...reviewOptions,verification,verificationTransport:probe.transport});
  need(matches(observed.preflight,{...reviewOptions,verification}),'tool_preflight_missing');
  await probe.close();probe=null;need(!control.signal.aborted,'cancelled');
  session=createReviewVerificationSession({codeProject:definition.codeProject,configuration:verification,request,binaryReview:true});
  const native=worker({...reviewOptions,preflight:observed.preflight,verification,verificationTransport:session.transport});
  const wrapped=async(input,inner)=>{
   need(input.prompt.includes('Use no tools and do not execute code.'),'review_verification_prompt_contract');
   const prompt=input.prompt.replaceAll('Use no tools and do not execute code.','Use only the isolated cm_review verification tools.')
    .replaceAll('No tools or follow-up fetches.','Only registered isolated verification tools are available.')+session.prompt;
   const answer=await native({prompt},{...inner,onEvent:event=>{if(event.event==='thread.started')thread=event.provider_thread;inner.onEvent(event);}});
   if(answer.status==='succeeded'){
    need(!control.signal.aborted,'cancelled');const evidence=session.finish(thread);
    persistBinaryReviewEvidence({definition,request,configuration:verification,evidence,providerThreadId:thread});
    verifyBinaryReviewEvidence({definition,binaryAssets,request,providerThreadId:thread});
   }
   return answer;
  };
  result=await adapter(wrapped,executionPolicy)(request,control);
 }catch(error){result={status:'failed',code:/^[a-z_]+$/.test(error.code??'')?error.code:'binary_review_failed'};}
 finally{try{await probe?.close();await session?.close();}catch{result={status:'failed',code:'review_verification_cleanup'};}}
 if(control.signal.aborted)return {status:'failed',code:'cancelled'};
 return result;
}
