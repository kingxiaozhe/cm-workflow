// An explicitly selected type-name split, not a TypeScript semantic proof.
// The owner binds approval and history; this module reports file facts only.
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {digest,json,need,shape,hex} from '../cm-ai/effect-contract.mjs';
import {readReviewSourceRecords,readReviewSourceFiles} from '../cm-ai/review-package.mjs';
import {validateDeveloperScope} from '../cm-ai/developer-adapter.mjs';
import {readReviewVerification,verificationPath} from './review-verification-contract.mjs';

const sha=b=>createHash('sha256').update(b).digest('hex');
const identifier=/^[A-Za-z_$][A-Za-z0-9_$]*$/;
function sourcePath(value){
  verificationPath(value);validateDeveloperScope([value]);
  need(/\.ts$/.test(value)&&!value.endsWith('.d.ts'),'type_import_correction_path');
}
function derive(before,typeNames){
  sourcePath(before.path);
  const bytes=Buffer.from(before.contentBase64,'base64'),text=bytes.toString('utf8');
  need(Buffer.from(text).equals(bytes)&&!text.includes('\0'),'type_import_correction_syntax');
  const newline=text.indexOf('\n'),end=newline<0?text.length:newline;
  const first=text.slice(0,end),eol=first.endsWith('\r')?'\r\n':'\n',line=first.replace(/\r$/,'');
  // Start at byte zero: never search comments, strings or subsequent statements.
  const match=/^import[ \t]+\{[ \t]*([A-Za-z_$][A-Za-z0-9_$]*(?:[ \t]*,[ \t]*[A-Za-z_$][A-Za-z0-9_$]*)*)[ \t]*\}[ \t]+from[ \t]+(['"])([A-Za-z0-9_@./-]+)\2;[ \t]*$/.exec(line);
  need(match,'type_import_correction_syntax');
  const names=match[1].split(',').map(n=>n.trim());
  need(new Set(names).size===names.length&&!names.some(n=>['type','as','default'].includes(n)),'type_import_correction_syntax');
  need(Array.isArray(typeNames)&&typeNames.length>0&&typeNames.length<names.length
    &&new Set(typeNames).size===typeNames.length&&typeNames.every(n=>typeof n==='string'&&identifier.test(n)&&names.includes(n)),
    'type_import_correction_names');
  const selected=new Set(typeNames),types=names.filter(n=>selected.has(n)),values=names.filter(n=>!selected.has(n));
  const module=`${match[2]}${match[3]}${match[2]}`;
  const replacement=`import type { ${types.join(', ')} } from ${module};${eol}import { ${values.join(', ')} } from ${module};`;
  const afterBytes=Buffer.from(replacement+(newline<0?'':eol+text.slice(newline+1)));
  return readReviewSourceRecords([{...before,size:afterBytes.length,sha256:sha(afterBytes),contentBase64:afterBytes.toString('base64')}])[0];
}

export function createTypeImportCorrection({file,declaration,scope,verification,reviewPackage}){
  const before=readReviewSourceRecords([file])[0],d=json(declaration);
  shape(d,['kind','path','beforeSha256','typeNames']);hex(d.beforeSha256);
  need(d.kind==='type-import-split'&&d.path===before.path&&d.beforeSha256===before.sha256,'type_import_correction_binding');
  validateDeveloperScope(scope);const profile=readReviewVerification(verification);
  need(scope.includes(d.path)&&profile.files.includes(d.path)&&profile.mutationPaths.includes(d.path),'type_import_correction_scope');
  hex(reviewPackage.packageDigest);
  const originals=[...(reviewPackage.files??[]),...(reviewPackage.contextFiles??[])].filter(f=>f.path===d.path);
  need(originals.length>0&&originals.every(f=>digest(readReviewSourceRecords([f])[0])===digest(before)),'type_import_correction_binding');
  return inspectTypeImportCorrection({kind:d.kind,path:d.path,typeNames:d.typeNames,before,after:derive(before,d.typeNames)});
}
export function inspectTypeImportCorrection(raw){
  const c=json(raw,3*1024*1024);shape(c,['kind','path','typeNames','before','after']);
  const before=readReviewSourceRecords([c.before])[0],after=readReviewSourceRecords([c.after])[0];
  need(c.kind==='type-import-split'&&c.path===before.path&&c.path===after.path,'type_import_correction_binding');
  need(digest(derive(before,c.typeNames))===digest(after),'type_import_correction_binding');
  return c;
}
export function readTypeImportCorrectionFile({root,path:relative}){
  sourcePath(relative);
  need(typeof root==='string'&&path.isAbsolute(root)&&fs.realpathSync(root)===root,'type_import_correction_path');
  let cursor=root;
  for(const part of relative.split('/')){
    cursor=path.join(cursor,part);
    need(!fs.lstatSync(cursor).isSymbolicLink(),'type_import_correction_path');
  }
  return readReviewSourceFiles(root,[relative])[0];
}
export function applyTypeImportCorrection({root,correction}){
  const c=inspectTypeImportCorrection(correction),read=()=>readTypeImportCorrectionFile({root,path:c.path});
  const current=read();
  if(digest(current)===digest(c.after))return {outcome:'already_applied'};
  need(digest(current)===digest(c.before),'type_import_correction_stale');
  const target=path.join(root,c.path),directory=path.dirname(target),temporary=path.join(directory,`.cm-type-import-${randomUUID()}`);
  let fd;
  try{
    fd=fs.openSync(temporary,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
    fs.writeFileSync(fd,Buffer.from(c.after.contentBase64,'base64'));fs.fchmodSync(fd,c.after.mode);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
    need(digest(read())===digest(c.before),'type_import_correction_stale');
    const temporaryStat=fs.lstatSync(temporary);
    need(temporaryStat.isFile()&&!temporaryStat.isSymbolicLink()&&temporaryStat.nlink===1
      &&(temporaryStat.mode&0o7777)===c.after.mode&&sha(fs.readFileSync(temporary))===c.after.sha256,'type_import_correction_stale');
    fs.renameSync(temporary,target);
    const dir=fs.openSync(directory,fs.constants.O_RDONLY);
    try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}
    need(digest(read())===digest(c.after),'type_import_correction_stale');
    return {outcome:'applied'};
  }finally{
    if(fd!==undefined)fs.closeSync(fd);
    try{fs.unlinkSync(temporary);}catch(error){if(error.code!=='ENOENT')throw error;}
  }
}
