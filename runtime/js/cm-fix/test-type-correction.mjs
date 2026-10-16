// Pure, explicit callback annotation. The owner separately binds scope/history.
// Emit equivalence is a runtime-byte proof, not a TypeScript type-correctness proof.
import fs from 'node:fs';
import path from 'node:path';
import * as nodeModule from 'node:module';
import {createHash,randomUUID} from 'node:crypto';
import {digest,json,need,shape,hex} from '../cm-ai/effect-contract.mjs';
import {readReviewSourceRecords,readReviewSourceFiles} from '../cm-ai/review-package.mjs';
import {validateDeveloperScope} from '../cm-ai/developer-adapter.mjs';
import {verificationPath} from './review-verification-contract.mjs';

const sha=b=>createHash('sha256').update(b).digest('hex');
const identifier=/^[A-Za-z_$][A-Za-z0-9_$]*$/;
function sourcePath(value){
 verificationPath(value);validateDeveloperScope([value]);
 need(/\.(?:spec|test)\.tsx?$/.test(value),'test_type_correction_path');
}
function emit(prefix){
 need(Number(process.versions.node.split('.')[0])>=24&&typeof nodeModule.stripTypeScriptTypes==='function','test_type_correction_runtime');
 try{return nodeModule.stripTypeScriptTypes(prefix,{mode:'transform'});}
 catch{need(false,'test_type_correction_syntax');}
}
function derive(before,{line,parameter,annotation}){
 sourcePath(before.path);
 need(Number.isSafeInteger(line)&&line>=1&&typeof parameter==='string'&&identifier.test(parameter),'test_type_correction_declaration');
 need(typeof annotation==='string'&&annotation.trim().length>0&&annotation===annotation.trim()
  &&Buffer.byteLength(annotation)<=256&&/^[A-Za-z0-9_$ \t.,:[\]?|&(){}<>"';-]+$/.test(annotation)
  &&!/\b(?:any|unknown|as|satisfies|import|asserts|typeof|new|this|extends|infer|keyof)\b/.test(annotation),'test_type_correction_annotation');
 const bytes=Buffer.from(before.contentBase64,'base64'),text=bytes.toString('utf8');
 need(Buffer.from(text).equals(bytes)&&!/[\0\u2028\u2029]/.test(text),'test_type_correction_syntax');
 const lines=text.split('\n');need(line<=lines.length,'test_type_correction_declaration');
 const selected=lines[line-1],escaped=parameter.replace(/[$]/g,'\\$');
 const pattern=new RegExp(`(?<![\\p{ID_Continue}$\\u200c\\u200d])${escaped}([ \\t]*)=>`,'gu');
 const matches=[...selected.matchAll(pattern)];need(matches.length===1,'test_type_correction_match');
 const match=matches[0],replacement=`(${parameter}: ${annotation})${match[1]}=>`;
 const corrected=selected.slice(0,match.index)+replacement+selected.slice(match.index+match[0].length);
 const prefix=lines.slice(0,line).join('\n'),afterPrefix=[...lines.slice(0,line-1),corrected].join('\n'),emitted=emit(prefix);
 need(emit(afterPrefix)===emitted,'test_type_correction_emit_changed');
 // A match in erased type-only material is not an executable callback. Renaming
 // its parameter must alter emitted JS; this also rejects type-literal strings.
 let probe='__cm_type_parameter_probe__';while(prefix.includes(probe))probe+='_';
 const probeLine=selected.slice(0,match.index)+probe+selected.slice(match.index+parameter.length);
 need(emit([...lines.slice(0,line-1),probeLine].join('\n'))!==emitted,'test_type_correction_match');
 const output=Buffer.from([...lines.slice(0,line-1),corrected,...lines.slice(line)].join('\n'));
 const after=readReviewSourceRecords([{...before,size:output.length,sha256:sha(output),contentBase64:output.toString('base64')}])[0];
 return {after,emitSha256:sha(emitted)};
}
export function createTestTypeCorrection({file,declaration}){
 const before=readReviewSourceRecords([file])[0],d=json(declaration);
 shape(d,['kind','path','beforeSha256','line','parameter','annotation']);hex(d.beforeSha256);
 need(d.kind==='callback-type-annotation'&&d.path===before.path&&d.beforeSha256===before.sha256,'test_type_correction_binding');
 const {after,emitSha256}=derive(before,d);
 return inspectTestTypeCorrection({kind:d.kind,path:d.path,line:d.line,parameter:d.parameter,annotation:d.annotation,before,after,emitSha256,nodeVersion:process.version});
}
export function inspectTestTypeCorrection(raw){
 const c=json(raw,6*1024*1024);shape(c,['kind','path','line','parameter','annotation','before','after','emitSha256','nodeVersion']);hex(c.emitSha256);
 need(c.nodeVersion===process.version,'test_type_correction_runtime');
 const before=readReviewSourceRecords([c.before])[0],after=readReviewSourceRecords([c.after])[0];
 need(c.kind==='callback-type-annotation'&&c.path===before.path&&c.path===after.path,'test_type_correction_binding');
 const derived=derive(before,c);
 need(digest(derived.after)===digest(after)&&derived.emitSha256===c.emitSha256,'test_type_correction_binding');return c;
}
export function readTestTypeCorrectionFile({root,path:relative}){
 sourcePath(relative);
 need(typeof root==='string'&&path.isAbsolute(root)&&fs.realpathSync(root)===root,'test_type_correction_path');
 let cursor=root;
 for(const part of relative.split('/')){cursor=path.join(cursor,part);need(!fs.lstatSync(cursor).isSymbolicLink(),'test_type_correction_path');}
 return readReviewSourceFiles(root,[relative])[0];
}
export function applyTestTypeCorrection({root,correction}){
 const c=inspectTestTypeCorrection(correction),read=()=>readTestTypeCorrectionFile({root,path:c.path}),current=read();
 if(digest(current)===digest(c.after))return {outcome:'already_applied'};
 need(digest(current)===digest(c.before),'test_type_correction_stale');
 const target=path.join(root,c.path),directory=path.dirname(target),temporary=path.join(directory,`.cm-test-type-${randomUUID()}`);let fd;
 try{
  fd=fs.openSync(temporary,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
  fs.writeFileSync(fd,Buffer.from(c.after.contentBase64,'base64'));fs.fchmodSync(fd,c.after.mode);fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
  need(digest(read())===digest(c.before),'test_type_correction_stale');
  const st=fs.lstatSync(temporary);
  need(st.isFile()&&!st.isSymbolicLink()&&st.nlink===1&&(st.mode&0o7777)===c.after.mode
   &&sha(fs.readFileSync(temporary))===c.after.sha256,'test_type_correction_stale');
  fs.renameSync(temporary,target);const dir=fs.openSync(directory,fs.constants.O_RDONLY);
  try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}
  need(digest(read())===digest(c.after),'test_type_correction_stale');return {outcome:'applied'};
 }finally{if(fd!==undefined)fs.closeSync(fd);try{fs.unlinkSync(temporary);}catch(error){if(error.code!=='ENOENT')throw error;}}
}
