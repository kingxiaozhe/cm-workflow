// Fixed, immutable prototype assets. Channel fields are source declarations, not browser attestation.
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {need,shape,json,digest} from '../cm-ai/effect-contract.mjs';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const HASH=/^[a-f0-9]{64}$/;
// Binary fonts are normally much larger than text specs; do not copy them into session JSON.
// A variable CJK font can exceed64MiB. Individual assets share the existing total ceiling.
const MAX_TOTAL=128*1024*1024,MAX_FILE=MAX_TOTAL,MAX_FILES=256,MAX_JSON=2*1024*1024;
const nonempty=value=>typeof value==='string'&&value.trim().length>0&&value.length<=8192&&!value.includes('\0');
function directory(root){
  need(typeof root==='string'&&path.isAbsolute(root)&&path.resolve(root)===root,'prd_baseline_path');
  const stat=fs.lstatSync(root);need(stat.isDirectory()&&!stat.isSymbolicLink()&&fs.realpathSync(root)===root,'prd_baseline_path');return root;
}
function contained(root,child){return child===root||child.startsWith(`${root}${path.sep}`);}
// A crash may leave exactly our staging name as the second link. This is a
// read-only shape check, not process identity proof or permission to delete it.
function ownStagingLink(root,stat){
  if(stat.nlink!==2||(stat.mode&0o777)!==0o600)return false;
  const parent=directory(path.dirname(root));
  return fs.readdirSync(parent).some(name=>{
    if(!/^\.baseline-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(name))return false;
    const other=fs.lstatSync(path.join(parent,name));
    return other.isFile()&&!other.isSymbolicLink()&&other.nlink===2&&(other.mode&0o777)===0o600
      &&other.dev===stat.dev&&other.ino===stat.ino;
  });
}
function file(root,relative,max=MAX_FILE,allowStaging=false){
  directory(root);need(nonempty(relative)&&!path.isAbsolute(relative)&&!relative.includes('\\')
    &&relative.split('/').every(part=>part&&part!=='.'&&part!=='..'),'prd_baseline_path');
  const target=path.join(root,relative);need(contained(root,target),'prd_baseline_path');
  let current=root;for(const part of relative.split('/')){current=path.join(current,part);need(!fs.lstatSync(current).isSymbolicLink(),'prd_baseline_path');}
  const stat=fs.lstatSync(target);need(stat.isFile()&&(stat.nlink===1||allowStaging&&ownStagingLink(root,stat))&&stat.size<=max&&fs.realpathSync(target)===target,'prd_baseline_path');
  const bytes=fs.readFileSync(target);need(bytes.length===stat.size,'prd_baseline_source_changed');return bytes;
}
function mkdir(root,name){
  directory(root);need(/^[a-zA-Z0-9._-]+$/.test(name)&&!['.','..'].includes(name),'prd_baseline_path');
  const target=path.join(root,name);try{fs.mkdirSync(target,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}
  directory(target);return target;
}
function preflight(directoryPath,files,complete=true){
  directory(directoryPath);
  const expected=new Set(files.map(item=>item.name));
  need(!complete||fs.readdirSync(directoryPath).every(name=>expected.has(name)),'prd_baseline_conflict');
  for(const item of files){const target=path.join(directoryPath,item.name);if(!fs.existsSync(target)){
    // existsSync follows dangling links; lstat must still reject them.
    try{fs.lstatSync(target);need(false,'prd_baseline_conflict');}catch(e){if(e.code!=='ENOENT')throw e;}continue;}
    const stat=fs.lstatSync(target);need(stat.isFile()&&!stat.isSymbolicLink()&&(stat.nlink===1||ownStagingLink(directoryPath,stat))&&(stat.mode&0o777)===0o600
      &&fs.readFileSync(target).equals(item.bytes),'prd_baseline_conflict');}
}
function write(directoryPath,item){
  preflight(directoryPath,[item],false);const target=path.join(directoryPath,item.name);
  if(fs.existsSync(target))return;
  const temp=path.join(path.dirname(directoryPath),`.baseline-${randomUUID()}`);let fd;
  try{fd=fs.openSync(temp,'wx',0o600);fs.writeFileSync(fd,item.bytes);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
    try{fs.linkSync(temp,target);}catch(e){if(e.code!=='EEXIST')throw e;preflight(directoryPath,[item],false);}
    fs.unlinkSync(temp);const dir=fs.openSync(directoryPath,'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}
  }finally{if(fd!==undefined)fs.closeSync(fd);try{fs.unlinkSync(temp);}catch(e){if(e.code!=='ENOENT')throw e;}}
}
function sessionRoot(specs,sessionId,create=false){
  directory(specs);need(/^prd-[A-Za-z0-9-]{1,80}$/.test(sessionId),'prd_baseline_binding');let root=specs;
  for(const segment of ['.reviews','prd-sessions',sessionId,'design-baselines'])root=create?mkdir(root,segment):directory(path.join(root,segment));return root;
}
function imageSize(bytes,ext){
  if(ext==='.png'){
    need(bytes.length>=45&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
      &&bytes.toString('ascii',12,16)==='IHDR'&&bytes.readUInt32BE(8)===13,'prd_baseline_image');
    let offset=8,ended=false;while(offset+12<=bytes.length){const len=bytes.readUInt32BE(offset);need(offset+len+12<=bytes.length,'prd_baseline_image');
      const kind=bytes.toString('ascii',offset+4,offset+8);offset+=len+12;if(kind==='IEND'){need(len===0&&offset===bytes.length,'prd_baseline_image');ended=true;break;}}
    need(ended,'prd_baseline_image');return {width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20)};
  }
  need(['.jpg','.jpeg'].includes(ext)&&bytes.length>=4&&bytes[0]===255&&bytes[1]===216
    &&bytes.at(-2)===255&&bytes.at(-1)===217,'prd_baseline_image');
  let at=2;while(at+4<bytes.length){need(bytes[at]===255,'prd_baseline_image');while(bytes[at]===255)at++;
    const marker=bytes[at++];if(marker===217||marker===218)break;if(marker===1||marker>=208&&marker<=215)continue;
    const length=bytes.readUInt16BE(at);need(length>=2&&at+length<=bytes.length,'prd_baseline_image');
    if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)){
      need(length>=8,'prd_baseline_image');return {height:bytes.readUInt16BE(at+3),width:bytes.readUInt16BE(at+5)};}
    at+=length;
  }need(false,'prd_baseline_image');
}
function fontMagic(bytes,ext){
  const magic=bytes.subarray(0,4);need(bytes.length>=12&&(
    ext==='.woff2'&&bytes.length>=32&&magic.equals(Buffer.from('wOF2'))&&bytes.readUInt32BE(8)===bytes.length
    ||ext==='.woff'&&bytes.length>=44&&magic.equals(Buffer.from('wOFF'))&&bytes.readUInt32BE(8)===bytes.length
    ||ext==='.otf'&&magic.equals(Buffer.from('OTTO'))
    ||ext==='.ttf'&&magic.equals(Buffer.from([0,1,0,0]))),'prd_baseline_font');
}
function inspectInput({project,input,stored=null}){
  directory(project);input=json(input,MAX_JSON);shape(input,['prototypeRoot','captureRoot','confirmation','sources','screenshots','fonts','specSheet','interaction','cssSource']);
  const prototypeRoot=directory(input.prototypeRoot);need(contained(project,prototypeRoot),'prd_baseline_path');
  // Captures are transient imports; the immutable stored image is authoritative after import.
  const captureRoot=stored===null?(input.captureRoot===null?prototypeRoot:directory(input.captureRoot)):directory(stored.dir);
  shape(input.confirmation,['reference','messageDigest','level','nativeDifferences']);need(nonempty(input.confirmation.reference)&&HASH.test(input.confirmation.messageDigest)&&input.confirmation.level==='pixel'
    &&input.confirmation.nativeDifferences==='list_each_platform_difference','prd_baseline_confirmation');
  const arrays=[input.sources,input.screenshots,input.fonts];need(arrays.every(Array.isArray)&&input.sources.length>0&&input.screenshots.length>0
    &&arrays.reduce((n,a)=>n+a.length,0)<=MAX_FILES,'prd_baseline_limit');
  let total=0;const sources=[],artifacts=[],files=[],seen=new Set();
  const read=(root,row,kind)=>{need(nonempty(row.sourcePath)&&HASH.test(row.sha256),'prd_baseline_binding');
    const key=`${kind}:${row.sourcePath}`;need(!seen.has(key),'prd_baseline_duplicate');seen.add(key);
    const imported=stored!==null&&kind==='screenshot'?stored.manifest.artifacts.find(item=>item.kind==='screenshot'&&item.sourcePath===row.sourcePath):null;
    const bytes=file(root,imported?.name??row.sourcePath,MAX_FILE,imported!==null);need(sha(bytes)===row.sha256,'prd_baseline_source_changed');total+=bytes.length;need(total<=MAX_TOTAL,'prd_baseline_limit');return bytes;};
  for(const row of input.sources){shape(row,['sourcePath','sha256']);need(/\.(html?|css|m?js|json|txt|svg)$/i.test(row.sourcePath),'prd_baseline_source');
    const bytes=read(prototypeRoot,row,'source');sources.push({...row,size:bytes.length});}
  const imageIds=new Set();
  input.screenshots.forEach((row,index)=>{shape(row,['id','sourcePath','sha256','width','height','page','skin','state']);
    need([row.id,row.page,row.skin,row.state].every(nonempty)&&!imageIds.has(row.id),'prd_baseline_image');imageIds.add(row.id);
    const bytes=read(captureRoot,row,'screenshot'),ext=path.extname(row.sourcePath).toLowerCase(),size=imageSize(bytes,ext);
    need(Number.isSafeInteger(row.width)&&Number.isSafeInteger(row.height)&&row.width>0&&row.height>0&&row.width<=16384&&row.height<=16384
      &&size.width===row.width&&size.height===row.height,'prd_baseline_image');
    const name=`screenshot-${index+1}${ext==='.jpeg'?'.jpg':ext}`;files.push({name,bytes});artifacts.push({kind:'screenshot',name,sha256:sha(bytes),size:bytes.length,...row});});
  const fontIds=new Set();
  input.fonts.forEach((row,index)=>{shape(row,['id','sourcePath','sha256','license','source']);need(nonempty(row.id)&&!fontIds.has(row.id)
    &&(row.license===null||nonempty(row.license))&&(row.source===null||nonempty(row.source)),'prd_baseline_font');fontIds.add(row.id);
    const bytes=read(prototypeRoot,row,'font'),ext=path.extname(row.sourcePath).toLowerCase();fontMagic(bytes,ext);
    const name=`font-${index+1}${ext}`;files.push({name,bytes});artifacts.push({kind:'font',name,...row,size:bytes.length});});
  const sheet=input.specSheet;shape(sheet,['source','channel','url','viewport','elements']);
  shape(sheet.viewport,['width','height','deviceScaleFactor']);need(sheet.source==='rendered-computed'&&sheet.channel==='codex-in-app'&&nonempty(sheet.url)
    &&['http:','https:','file:'].includes(new URL(sheet.url).protocol)&&!new URL(sheet.url).username&&!new URL(sheet.url).password&&Array.isArray(sheet.elements)&&sheet.elements.length>0&&sheet.elements.length<=10000
    &&[sheet.viewport.width,sheet.viewport.height].every(v=>Number.isSafeInteger(v)&&v>0&&v<=16384)
    &&Number.isFinite(sheet.viewport.deviceScaleFactor)&&sheet.viewport.deviceScaleFactor>0&&sheet.viewport.deviceScaleFactor<=8,'prd_baseline_sheet');
  for(const item of sheet.elements){shape(item,['sel','geo','font','style']);need(nonempty(item.sel),'prd_baseline_sheet');shape(item.geo,['x','y','w','h']);
    need(Object.values(item.geo).every(Number.isFinite)&&item.geo.w>0&&item.geo.h>0&&item.style&&typeof item.style==='object'&&!Array.isArray(item.style)
      &&(item.font===null||typeof item.font==='object'&&!Array.isArray(item.font)),'prd_baseline_sheet');}
  const interaction=input.interaction;shape(interaction,['status','channel','coverage','steps']);
  need(['complete','incomplete'].includes(interaction.status)&&interaction.channel==='codex-in-app'&&Array.isArray(interaction.coverage)
    &&interaction.coverage.every(nonempty)&&new Set(interaction.coverage).size===interaction.coverage.length&&Array.isArray(interaction.steps)
    &&interaction.steps.length<=1000,'prd_baseline_interaction');const stepIds=new Set();
  for(const step of interaction.steps){shape(step,['id','action','result','screenshots']);need([step.id,step.action,step.result].every(nonempty)
    &&!stepIds.has(step.id)&&Array.isArray(step.screenshots)&&step.screenshots.length>0&&step.screenshots.every(id=>imageIds.has(id)),'prd_baseline_interaction');stepIds.add(step.id);}
  if(input.cssSource!==null){shape(input.cssSource,['source','parameters']);need(input.cssSource.source==='css-source'
    &&input.cssSource.parameters&&typeof input.cssSource.parameters==='object','prd_baseline_sheet');}
  const ready=interaction.status==='complete'&&interaction.steps.length>0&&input.screenshots.every(row=>interaction.coverage.includes(row.page))
    &&input.fonts.length>0&&input.fonts.every(row=>nonempty(row.license)&&nonempty(row.source));
  const bytes=Buffer.from(JSON.stringify(sheet));files.push({name:'spec-sheet.json',bytes});artifacts.push({kind:'spec-sheet',name:'spec-sheet.json',sha256:sha(bytes),size:bytes.length});
  return {input,sources,artifacts,files,ready};
}
function reference(manifest,manifestDigest){return {sessionId:manifest.sessionId,manifestDigest,
  path:`.reviews/prd-sessions/${manifest.sessionId}/design-baselines/${manifestDigest}/manifest.json`,
  sourceDigest:manifest.sourceDigest,configDigest:manifest.configDigest,ready:manifest.ready,completionAuthorized:false};}
function readStored({specs,sessionId,baseline}){
  shape(baseline,['sessionId','manifestDigest','path','sourceDigest','configDigest','ready','completionAuthorized']);
  need(baseline.sessionId===sessionId&&HASH.test(baseline.manifestDigest)&&baseline.completionAuthorized===false,'prd_baseline_binding');
  const root=sessionRoot(specs,sessionId),dir=directory(path.join(root,baseline.manifestDigest));
  need((fs.lstatSync(path.join(dir,'manifest.json')).mode&0o777)===0o600,'prd_baseline_conflict');
  const manifest=JSON.parse(file(dir,'manifest.json',MAX_JSON,true));need(digest(manifest)===baseline.manifestDigest
    &&digest(reference(manifest,baseline.manifestDigest))===digest(baseline),'prd_baseline_binding');
  need(manifest.sessionId===sessionId&&manifest.version===1,'prd_baseline_binding');
  need(digest(fs.readdirSync(dir).sort())===digest([...manifest.artifacts.map(row=>row.name),'manifest.json'].sort()),'prd_baseline_asset_changed');
  for(const artifact of manifest.artifacts){need(/^(screenshot-\d+\.(png|jpg)|font-\d+\.(woff2?|ttf|otf)|spec-sheet\.json)$/.test(artifact.name),'prd_baseline_binding');
    need((fs.lstatSync(path.join(dir,artifact.name)).mode&0o777)===0o600,'prd_baseline_conflict');
    const bytes=file(dir,artifact.name,MAX_FILE,true);need(bytes.length===artifact.size&&sha(bytes)===artifact.sha256,'prd_baseline_asset_changed');}
  return {manifest,reference:baseline,dir};
}
export function importPrdDesignBaseline({project,specs,sessionId,input,sourceDigest,configDigest,writeEnabled}){
  need(writeEnabled===true,'prd_baseline_write_disabled');directory(specs);need(HASH.test(sourceDigest)&&HASH.test(configDigest),'prd_baseline_binding');
  const inspected=inspectInput({project,input}),{sources,artifacts,files,ready}=inspected;
  const manifest={version:1,sessionId,project,sourceDigest,configDigest,input:inspected.input,sources,artifacts,ready,
    evidenceSource:'host-reported-browser-observations',completionAuthorized:false};
  const bytes=Buffer.from(JSON.stringify(manifest));need(bytes.length<=MAX_JSON,'prd_baseline_limit');const manifestDigest=digest(manifest);
  const root=sessionRoot(specs,sessionId,true),dir=mkdir(root,manifestDigest),all=[...files,{name:'manifest.json',bytes}];
  preflight(dir,all);for(const item of all)write(dir,item);
  return reference(manifest,manifestDigest);
}
export function inspectPrdDesignBaseline({project,specs,sessionId,baseline,sourceDigest,configDigest}){
  const stored=readStored({specs,sessionId,baseline}),{manifest}=stored;
  need(project===manifest.project&&sourceDigest===manifest.sourceDigest&&configDigest===manifest.configDigest,'prd_baseline_binding');
  const observed=inspectInput({project,input:manifest.input,stored});
  need(digest(observed.sources)===digest(manifest.sources)&&digest(observed.artifacts)===digest(manifest.artifacts)&&observed.ready===manifest.ready,'prd_baseline_source_changed');
  return {manifest,reference:baseline};
}
export function publishPrdBaselineForFeature({specs,sessionId,baseline,feature,writeEnabled}){
  need(writeEnabled===true,'prd_baseline_write_disabled');need(/^[1-9]\d*\.[a-z0-9]+(?:-[a-z0-9]+)*$/.test(feature),'prd_baseline_path');
  const stored=readStored({specs,sessionId,baseline}),{manifest,dir}=stored;
  inspectPrdDesignBaseline({project:manifest.project,specs,sessionId,baseline,sourceDigest:manifest.sourceDigest,configDigest:manifest.configDigest});
  need(manifest.ready,'prd_baseline_incomplete');
  const featureRoot=mkdir(specs,feature),target=mkdir(featureRoot,'design-baseline');
  const names=[...manifest.artifacts.map(row=>row.name),'manifest.json'],files=names.map(name=>({name,bytes:file(dir,name,MAX_FILE,true)}));
  preflight(target,files);for(const item of files)write(target,item);
  return {status:'baseline_published',manifestDigest:baseline.manifestDigest,feature,
    artifacts:files.map(item=>({path:`${feature}/design-baseline/${item.name}`,sha256:sha(item.bytes)})),completionAuthorized:false};
}

// Review/readback path is intentionally read-only; publishing is never a substitute for inspection.
export function inspectPrdPublishedBaseline({project,specs,sessionId,baseline,sourceDigest,configDigest,feature}){
  need(/^[1-9]\d*\.[a-z0-9]+(?:-[a-z0-9]+)*$/.test(feature),'prd_baseline_path');
  const {manifest}=inspectPrdDesignBaseline({project,specs,sessionId,baseline,sourceDigest,configDigest});
  need(manifest.ready,'prd_baseline_incomplete');
  const stored=readStored({specs,sessionId,baseline}),target=directory(path.join(directory(path.join(specs,feature)),'design-baseline'));
  const names=[...manifest.artifacts.map(row=>row.name),'manifest.json'];
  need(digest(fs.readdirSync(target).sort())===digest([...names].sort()),'prd_baseline_asset_changed');
  const artifacts=names.map(name=>{
    const original=file(stored.dir,name,MAX_FILE,true),current=file(target,name,MAX_FILE,true);
    need((fs.lstatSync(path.join(target,name)).mode&0o777)===0o600&&current.equals(original),'prd_baseline_asset_changed');
    return {path:`${feature}/design-baseline/${name}`,sha256:sha(current)};
  });
  return {manifestDigest:baseline.manifestDigest,feature,artifacts,confirmation:manifest.input.confirmation,ready:true};
}

// Revision snapshots contain hashes, never binary asset bodies. Only a published
// manifest with its exact private baseline may use the asset limits; other files
// keep the text reader's limits. The returned rows preserve the legacy tree shape.
export function inspectPrdBaselineChangeTree({specs,feature}){
  directory(specs);need(/^[1-9]\d*\.[a-z0-9]+(?:-[a-z0-9]+)*$/.test(feature),'prd_baseline_path');
  const root=directory(path.join(specs,feature)),target=path.join(root,'design-baseline');
  try{fs.lstatSync(target);}catch(error){if(error.code==='ENOENT')return null;throw error;}
  directory(target);
  try{fs.lstatSync(path.join(target,'manifest.json'));}catch(error){if(error.code==='ENOENT')return null;throw error;}
  const manifest=JSON.parse(file(target,'manifest.json',MAX_JSON,true)),baseline=reference(manifest,digest(manifest));
  const inspected=inspectPrdPublishedBaseline({project:manifest.project,specs,sessionId:manifest.sessionId,baseline,
    sourceDigest:manifest.sourceDigest,configDigest:manifest.configDigest,feature});
  return inspected.artifacts.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
}
