// Host-owned copy and narrowly scoped review tools. Never runs in the source tree.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {digest,need,shape,json} from '../cm-ai/effect-contract.mjs';
import {readReviewVerification,verificationPath,inspectReviewVerificationEvidence,bindVerificationFiles} from './review-verification-contract.mjs';
import {ownedProcessCleanup} from '../cm-ai/owned-process-cleanup.mjs';
import {runVerificationCommand} from './review-verification-command.mjs';
import {verificationFailure,verificationFailureCode,bindVerificationDiagnostic} from './review-verification-diagnostic.mjs';
import {binaryVerificationVersions,readVerificationBinary,safeBinaryRoot,BINARY_TOTAL_LIMIT} from './review-verification-binary.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
function readPage(file,offset=0){
 const data=file.data;
 // Cursors count UTF-8 bytes, never UTF-16 code units. Refuse a cursor inside
 // a character and back off the end so each bounded page decodes losslessly.
 need(Number.isSafeInteger(offset)&&offset>=0&&offset<=data.length
  &&(offset===data.length||(data[offset]&192)!==128),'review_verification_offset');
 let end=Math.min(offset+16384,data.length);
 while(end<data.length&&(data[end]&192)===128)end--;
 const bytes=data.subarray(offset,end),content=bytes.toString('utf8');
 need(Buffer.from(content).equals(bytes),'review_verification_encoding');
 return {path:file.path,content,sha256:file.sha256,offset,nextOffset:end<data.length?end:null,totalBytes:data.length};
}
function read(root,p){
 verificationPath(p);let target=root;
 for(const part of p.split('/')){target=path.join(target,part);need(!fs.lstatSync(target).isSymbolicLink(),'review_verification_path');}
 const st=fs.lstatSync(target);need(st.isFile()&&st.nlink===1&&st.size<=2*1024*1024,'review_verification_path');
 const data=fs.readFileSync(target);return {path:p,sha256:sha(data),mode:st.mode&511,data};
}
const record=({data,binary,...r})=>r;
function manifest(root,config){let bytes=0,binaryBytes=0;return config.files.map(p=>{let f;try{
 if(config.binaryAssets?.paths.includes(p)){
  const {contentBase64,...metadata}=readVerificationBinary(root,p);f={path:p,...metadata,binary:true};binaryBytes+=f.size;
 }else f=read(root,p);
 }catch(e){if(e.code!=='ENOENT')throw e;f={path:p,sha256:null,mode:null,data:null};}bytes+=f.data?.length??0;
 need(bytes<=16*1024*1024&&binaryBytes<=BINARY_TOTAL_LIMIT,'review_verification_limit');return f;});}
function inspectBinaryStore(pkg,versions,copyRoot=null){
 if(!versions.length)return;
 const root=safeBinaryRoot(pkg.binaryAssets.storeRoot),copied=new Set();
 for(const r of versions){
  const destination=copyRoot!==null&&!copied.has(r.contentBlob)?path.join(copyRoot,r.contentBlob):null;
  readVerificationBinary(root,r.contentBlob,{expected:{sha256:r.sha256,size:r.size},copyTo:destination});copied.add(r.contentBlob);
 }
}
export function assertVerificationIsolation(){need(process.platform==='darwin'&&fs.existsSync('/usr/bin/sandbox-exec'),'review_verification_isolation_unavailable');}
export function validateReviewVerificationInputs({codeProject,configuration,reviewPackage}){
 assertVerificationIsolation();const config=readReviewVerification(configuration);
 need(fs.realpathSync(codeProject)===codeProject,'review_verification_path');
 const binaryFiles=binaryVerificationVersions(config,reviewPackage);
 inspectBinaryStore(reviewPackage,binaryFiles);
 const files=manifest(codeProject,config);bindVerificationFiles(files.map(record),reviewPackage);
 return files;
}
export function createReviewVerificationSession({codeProject,configuration,request,binaryReview=false}){
 const config=readReviewVerification(configuration),pkg=request.payload.reviewPackage;
 const binaryFiles=binaryVerificationVersions(config,pkg);
 const files=validateReviewVerificationInputs({codeProject,configuration:config,reviewPackage:pkg}),records=files.map(record);
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-review-verification-'))),cwd=path.join(root,'project');fs.mkdirSync(cwd,{mode:448});
 let binaryArchiveRoot;
 try{
  if(config.binaryAssets){binaryArchiveRoot=path.join(root,'binary-versions');fs.mkdirSync(binaryArchiveRoot,{mode:448});inspectBinaryStore(pkg,binaryFiles,binaryArchiveRoot);}
  for(const f of files){if(f.data===null)continue;const target=path.join(cwd,f.path);fs.mkdirSync(path.dirname(target),{recursive:true});
   if(f.binary){readVerificationBinary(codeProject,f.path,{expected:f,copyTo:target});fs.chmodSync(target,f.mode);}
   else fs.writeFileSync(target,f.data,{mode:f.mode});}
 }catch(error){fs.rmSync(root,{recursive:true,force:true});throw error;}
 const activePath=path.join(root,'active-command.json');
 const options={configuration:config,cwd,files:records,requestDigest:request.requestDigest,packageDigest:pkg.packageDigest,activePath,
  ...(config.binaryAssets?{binaryFiles,binaryArchiveRoot}:{})};
 const configPath=path.join(root,'tools.json'),evidencePath=path.join(root,'evidence.json');
 fs.writeFileSync(configPath,JSON.stringify({...options,evidencePath}),{mode:384});
 const diagnosticPath=path.join(root,'diagnostic.json');
 const tools=createVerificationTools({...options,evidencePath,diagnosticPath});
 const diagnostic=(providerThreadId,error,phase='finish')=>{
  let failure;
  const code=verificationFailureCode(error);
  // Current boundary failures outrank earlier tool failures. Only incomplete
  // evidence needs the first still-unresolved tool diagnostic.
  if(['review_verification_evidence','review_verification_check_failed','review_verification_baseline_failed'].includes(code)&&fs.existsSync(diagnosticPath))
   failure=JSON.parse(fs.readFileSync(diagnosticPath,'utf8'))[0];
  if(!failure){
   let code=verificationFailureCode(error);
   if(code==='review_verification_evidence'&&fs.existsSync(evidencePath)){
    const evidence=JSON.parse(fs.readFileSync(evidencePath,'utf8'));
    code=evidence.checks.length<config.checks.length?'review_verification_check_missing':'review_verification_mutation_missing';
   }
   failure=verificationFailure({phase,code});
  }
  return bindVerificationDiagnostic(failure,{request,configuration:config,providerThreadId});
 };
 return {cwd,configPath,transport:{cwd,mcpConfig:JSON.stringify({mcpServers:{cm_review:{command:process.execPath,args:[fileURLToPath(new URL('./review-verification-server.mjs',import.meta.url)),configPath]}}})},
  prompt:`\nUse only the cm_review tools. This is an isolated verification copy, not the source project. Read relevant files with read_file.${config.binaryAssets?` Binary paths ${JSON.stringify(config.binaryAssets.paths)} are available only through read_binary with version before or after (default after), offset and length at most 16384 bytes; SHA and size bind the complete exact file. Deleted files have only before. Binary bodies are not text. Registered checks may inspect the exact current binary copy.`:''} The ONLY callable check IDs and commands are ${JSON.stringify(config.checks)}. Package checks may have different labels; never use those labels as tool IDs. Run EVERY registered check by its exact tool ID. ${binaryReview?'Read EVERY binary before and after version listed in the review package with read_binary; all registered checks and all binary version reads are mechanically required. No mutation is authorized by this asset-only review profile.':`Then use mutate_check with an exact unique find/replace on one allowed implementation path (${config.mutationPaths.join(', ')}), selecting a check that detects that defect. The host executes baseline, mutation and exact restoration checks. A successful verdict requires all baseline checks and at least one killed and restored mutation.`} Do not claim a test was executed based on text. Tool failure or unsupported required checks are missing evidence, never success. No other tools or changes to the original project are allowed.\n`,
  call:tools.call,diagnostic,
  finish(providerThreadId){
   try{
   need(!fs.existsSync(activePath),'review_verification_cleanup');
   inspectBinaryStore(pkg,binaryFiles);
   need(digest(manifest(codeProject,config).map(record))===digest(records),'review_verification_source_drift');
   need(digest(manifest(cwd,config).map(record))===digest(records),'review_verification_copy_drift');
   const raw=JSON.parse(fs.readFileSync(evidencePath,'utf8'));
   return inspectReviewVerificationEvidence({...raw,providerThreadId},{request,configuration:config,providerThreadId,binaryReview});
   }catch(error){error.verificationDiagnostic=diagnostic(providerThreadId,error);throw error;}
  },
  async close(){
   if(fs.existsSync(activePath)){
    const {pid}=JSON.parse(fs.readFileSync(activePath,'utf8'));need(Number.isInteger(pid)&&pid>0,'review_verification_cleanup');
    try{await ownedProcessCleanup({pid,kill:()=>{}})();}
    catch(error){
     // A possibly live process still owns this private copy; retain it explicitly.
     try{process.stderr.write(JSON.stringify({diagnostic:'review_verification_cleanup_unknown',retainedDirectory:root})+'\n');}catch{}
     throw error;
    }
   }
   fs.rmSync(root,{recursive:true,force:true});}};
}
export function createVerificationTools({configuration,cwd,files,requestDigest,packageDigest,evidencePath,activePath,binaryFiles=[],binaryArchiveRoot=null,diagnosticPath=path.join(path.dirname(evidencePath),'diagnostic.json'),runCommand=runVerificationCommand}){
 const c=readReviewVerification(configuration);let calls=0,busy=false;
 const checks=new Map(),mutations=[],binaryReads=new Map();
 const failures=()=>fs.existsSync(diagnosticPath)?JSON.parse(fs.readFileSync(diagnosticPath,'utf8')):[];
 const saveFailures=items=>{
  const temporary=diagnosticPath+'.tmp';fs.writeFileSync(temporary,JSON.stringify(items),{mode:384});fs.renameSync(temporary,diagnosticPath);
 };
 const note=failure=>{
  const items=failures();
  if(!items.some(item=>item.phase===failure.phase&&item.checkId===failure.checkId))saveFailures([...items,failure].slice(0,32));
 };
 // A successful operation supersedes rejected tool inputs. Mutation evidence
 // is global: one killed/restored mutation resolves prior surviving attempts.
 const clearFailure=(id,{mutation=false}={})=>saveFailures(failures().filter(item=>
  !(item.phase==='worker'&&item.checkId===null)&&!(mutation&&item.phase==='mutation')
  &&(item.checkId!==id||!mutation&&item.phase==='mutation')));
 const resultCode=(result,fallback)=>result.outcome==='unavailable'?verificationFailureCode(result):fallback;
 const invalidate=id=>{checks.delete(id);for(let i=mutations.length-1;i>=0;i--)if(mutations[i].checkId===id)mutations.splice(i,1);};
 const persist=()=>{
  const e={version:1,requestDigest,packageDigest,profileDigest:digest(c),providerThreadId:'pending',files,snapshotDigest:digest(files),checks:c.checks.filter(x=>checks.has(x.id)).map(x=>checks.get(x.id)),mutations,
   ...(c.binaryAssets?{binaryFiles}:{}),...(c.binaryReview?{binaryReads:binaryFiles.filter(r=>binaryReads.has(r.path+'\0'+r.version)).map(({path,version,sha256,size})=>({path,version,sha256,size}))}:{})};
  const tmp=evidencePath+'.tmp';fs.writeFileSync(tmp,JSON.stringify(e),{mode:384});fs.renameSync(tmp,evidencePath);
 };
 const resetExtras=(dir=cwd)=>{
  for(const name of fs.readdirSync(dir)){
   const full=path.join(dir,name),relative=path.relative(cwd,full);
   if(c.files.includes(relative))continue;
   const st=fs.lstatSync(full);
   if(st.isDirectory()&&!st.isSymbolicLink()&&c.files.some(p=>p.startsWith(relative+'/')))resetExtras(full);
   else fs.rmSync(full,{recursive:true,force:true});
  }
 };
 const same=()=>{
  need(digest(manifest(cwd,c).map(record))===digest(files),'review_verification_copy_drift');
  if(c.binaryAssets){
   need(binaryArchiveRoot===path.join(path.dirname(cwd),'binary-versions'),'review_verification_path');
   for(const r of binaryFiles){need(c.binaryAssets.paths.includes(r.path),'review_verification_path');
    readVerificationBinary(binaryArchiveRoot,r.contentBlob,{expected:{sha256:r.sha256,size:r.size}});}
  }
 };
 const run=async(check,signal)=>{need(!fs.existsSync(activePath),'review_verification_cleanup');resetExtras();try{return await runCommand({cwd,command:check.command,timeoutMs:c.timeoutMs,signal,
  onSpawn:pid=>{const tmp=activePath+'.tmp';fs.writeFileSync(tmp,JSON.stringify({pid}),{mode:384});fs.renameSync(tmp,activePath);},
  onClose:()=>fs.rmSync(activePath,{force:true})});}finally{resetExtras();}};
 persist();
 return {async call(name,raw,signal=new AbortController().signal){
  need(!busy&&++calls<=(c.binaryReview?Math.min(256,32+2*binaryFiles.length):32),'review_verification_limit');busy=true;
  try{
   need(!fs.existsSync(activePath),'review_verification_cleanup');
   const a=json(raw,32768);same();
   if(name==='read_file'){
    shape(a,Object.hasOwn(a,'offset')?['path','offset']:['path']);need(c.files.includes(a.path),'review_verification_path');
    need(!c.binaryAssets?.paths.includes(a.path),'review_verification_encoding');
    return readPage(read(cwd,a.path),Object.hasOwn(a,'offset')?a.offset:0);
   }
   if(name==='read_binary'){
    need(!signal.aborted,'cancelled');
    shape(a,['path',...['version','offset','length'].filter(key=>Object.hasOwn(a,key))]);
    need(c.binaryAssets?.paths.includes(a.path),'review_verification_path');
    const version=a.version??'after';need(['before','after'].includes(version),'review_verification_binary_version');
    const expected=binaryFiles.find(r=>r.path===a.path&&r.version===version);need(expected,'review_verification_binary_version');
    const offset=a.offset??0,length=a.length??16384;need(Number.isSafeInteger(length)&&length>0&&length<=16384,'review_verification_offset');
    const observed=readVerificationBinary(version==='before'?binaryArchiveRoot:cwd,version==='before'?expected.contentBlob:a.path,
     {expected:{sha256:expected.sha256,size:expected.size,...(version==='after'?{mode:expected.mode}:{})},offset,length});
    if(c.binaryReview){binaryReads.set(a.path+'\0'+version,true);persist();}
    return {path:a.path,examinedPath:a.path,version,sha256:observed.sha256,totalBytes:observed.size,offset,
     nextOffset:offset+length<observed.size?offset+length:null,contentBase64:observed.contentBase64};
   }
   if(name==='run_check'){
    shape(a,['id']);const check=c.checks.find(c=>c.id===a.id);need(check,'review_verification_check');
    const startedAt=Date.now(),result=await run(check,signal);same();
    if(result.outcome==='passed'){clearFailure(a.id);checks.set(a.id,{id:a.id,commandDigest:digest(check.command),exitCode:0,outputSha256:sha(result.output),startedAt,endedAt:Date.now()});}
    else{invalidate(a.id);note(verificationFailure({phase:'check',code:resultCode(result,'review_verification_check_failed'),checkId:a.id,result}));}persist();return result;
   }
   need(name==='mutate_check','review_verification_tool');shape(a,['path','find','replace','checkId']);
   need(c.mutationPaths.includes(a.path)&&typeof a.find==='string'&&a.find.length>0&&typeof a.replace==='string'
    &&a.find!==a.replace&&a.find.length+a.replace.length<=16384&&mutations.length<8,'review_verification_mutation');
   const check=c.checks.find(c=>c.id===a.checkId);need(check,'review_verification_check');
   const f=read(cwd,a.path),text=f.data.toString('utf8');need(Buffer.from(text).equals(f.data)&&text.split(a.find).length===2,'review_verification_mutation');
   const changed=Buffer.from(text.replace(a.find,a.replace)),startedAt=Date.now();
   invalidate(a.checkId);persist();
   const baseline=await run(check,signal);same();
   if(baseline.outcome!=='passed')note(verificationFailure({phase:'baseline',code:resultCode(baseline,'review_verification_baseline_failed'),checkId:a.checkId,result:baseline}));
   need(baseline.outcome==='passed','review_verification_baseline_failed');
   clearFailure(a.checkId);
   let mutated,restored;
   try{
    fs.writeFileSync(path.join(cwd,a.path),changed,{mode:f.mode});
    mutated=await run(check,signal);
    const expected=files.map(r=>r.path===a.path?{...r,sha256:sha(changed)}:r);
    need(digest(manifest(cwd,c).map(record))===digest(expected),'review_verification_copy_drift');
   }finally{
    // Refuse a replaced path; do not follow a test-created link during restoration.
    read(cwd,a.path);fs.writeFileSync(path.join(cwd,a.path),f.data);fs.chmodSync(path.join(cwd,a.path),f.mode);same();
   }
   need(!signal.aborted,'cancelled');restored=await run(check,signal);same();
   const killed=mutated.outcome==='failed'&&Number.isInteger(mutated.exitCode)&&mutated.exitCode>0&&restored.outcome==='passed';
   if(restored.outcome==='passed')checks.set(a.checkId,{id:a.checkId,commandDigest:digest(check.command),exitCode:0,outputSha256:sha(restored.output),startedAt,endedAt:Date.now()});
   if(killed){clearFailure(a.checkId,{mutation:true});mutations.push({path:a.path,beforeSha256:f.sha256,afterSha256:sha(changed),checkId:a.checkId,baselineExitCode:0,
    mutatedExitCode:mutated.exitCode,restoredExitCode:restored.exitCode,restoredSha256:read(cwd,a.path).sha256,startedAt,endedAt:Date.now()});}
   if(restored.outcome!=='passed')note(verificationFailure({phase:'restore',code:resultCode(restored,'review_verification_restore_failed'),checkId:a.checkId,result:restored}));
   else if(!killed)note(verificationFailure({phase:'mutation',code:resultCode(mutated,'review_verification_mutation_survived'),checkId:a.checkId,result:mutated}));
   persist();return {killed,baseline,mutated,restored};
  }catch(error){if(failures().length===0)note(verificationFailure({phase:'worker',code:verificationFailureCode(error)}));throw error;}finally{busy=false;}
 }};
}

// Capability qualification runs fixed baselines only in a private snapshot. It
// never dispatches a provider, writes an owner record or invents a mutation.
export async function verifyReviewVerificationBaseline({codeProject,configuration,reviewPackage,signal=new AbortController().signal}){
 const config=readReviewVerification(configuration);
 const request={provider:'claude',requestDigest:digest({packageDigest:reviewPackage.packageDigest,profile:config}),payload:{reviewPackage}};
 let session,result,failure,phase='snapshot';
 try{
  session=createReviewVerificationSession({codeProject,configuration:config,request});phase='check';
  for(const check of config.checks){
   const result=await session.call('run_check',{id:check.id},signal);
   if(result.outcome!=='passed'){
    const error=Object.assign(new Error('review_verification_check_failed'),{code:'review_verification_check_failed'});
    error.verificationDiagnostic=session.diagnostic(null,error,'check');throw error;
   }
  }
  const source=manifest(codeProject,config).map(record),copy=manifest(session.cwd,config).map(record);
  need(digest(source)===digest(copy),'review_verification_source_drift');
  const evidence=JSON.parse(fs.readFileSync(path.join(path.dirname(session.cwd),'evidence.json'),'utf8'));
  need(digest(source)===evidence.snapshotDigest,'review_verification_source_drift');
  result={files:source,snapshotDigest:digest(source),checks:evidence.checks};
 }catch(error){
  failure=error;
  failure.verificationDiagnostic=session?session.diagnostic(null,error,phase):
   bindVerificationDiagnostic(verificationFailure({phase,code:verificationFailureCode(error)}),{request,configuration:config});
 }finally{
  try{await session?.close();}catch(error){
   error.cause=failure;failure=error;
   failure.verificationDiagnostic=bindVerificationDiagnostic(verificationFailure({phase:'cleanup',code:verificationFailureCode(error)}),{request,configuration:config});
  }
 }
 if(failure)throw failure;return result;
}
