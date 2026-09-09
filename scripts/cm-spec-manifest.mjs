#!/usr/bin/env node
// Semantic approval manifest; no writes, installation or external dependencies.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {TextDecoder} from 'node:util';

const required=['requirements.md','design.md','tasks.md'];
const feature=/^\p{Decimal_Number}+\.[^\n]+$(?![\s\S])/u;
const fail=message=>{throw new Error(message);};
const record=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
// UTF-8 ordering matches Python's Unicode code-point ordering for valid names.
const compare=(a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b));
const exists=p=>{try{fs.statSync(p);return true;}catch(e){if(['ENOENT','ENOTDIR'].includes(e.code))return false;throw e;}};

export function semanticDigest(file){
  let bytes=fs.readFileSync(file);
  const name=path.basename(file);
  if(['tasks.md','requirements.md'].includes(name)){
    const marker=name==='tasks.md'?/^([ ]{0,3}-[ \t]+)\[[xX]\]([ \t]+T-[A-Za-z0-9][A-Za-z0-9._-]*[ \t]*:)/
      :/^([ ]{0,3}-[ \t]+)\[[xX]\]([ \t]+\[AC-[A-Za-z0-9][A-Za-z0-9._-]*\])/;
    let fenceChar=null,width=0;
    // Latin-1 is a reversible byte view, including invalid UTF-8 and CRLF.
    const lines=bytes.toString('latin1').match(/[^\r\n]*(?:\r\n|\r|\n|$)/g)??[];
    bytes=Buffer.from(lines.map(line=>{
      const fence=/^[ ]{0,3}(`{3,}|~{3,})/.exec(line);
      if(fenceChar!==null){
        if(fence&&fence[1][0]===fenceChar&&fence[1].length>=width
          &&/^[\t\n\v\f\r ]*$/.test(line.slice(fence[0].length))){fenceChar=null;width=0;}
        return line;
      }
      if(fence){fenceChar=fence[1][0];width=fence[1].length;return line;}
      if(line.startsWith('    ')||line.startsWith('\t'))return line;
      return line.replace(marker,'$1[ ]$2');
    }).join(''),'latin1');
  }
  return createHash('sha256').update(bytes).digest('hex');
}

export function buildManifest(specsDir){
  if(!exists(specsDir)||!fs.statSync(specsDir).isDirectory())fail(`specs directory does not exist: ${specsDir}`);
  const features=fs.readdirSync(specsDir).filter(name=>feature.test(name)).sort(compare);
  if(!features.length)fail('specs directory contains no numbered feature directories');
  const rows=[];
  for(const name of features){
    const dir=path.join(specsDir,name),stat=fs.lstatSync(dir);
    if(stat.isSymbolicLink()||!stat.isDirectory())fail(`numbered feature must be a regular directory: ${dir}`);
    for(const filename of required){
      const file=path.join(dir,filename);
      if(!exists(file)||!fs.statSync(file).isFile())fail(`missing required spec file: ${name}/${filename}`);
      if(fs.lstatSync(file).isSymbolicLink())fail(`approved spec file must not be a symlink: ${file}`);
    }
    for(const filename of [...required,'test-cases.json']){
      const file=path.join(dir,filename);if(!exists(file))continue;
      if(!fs.statSync(file).isFile())fail(`approved spec path must be a file: ${file}`);
      if(fs.lstatSync(file).isSymbolicLink())fail(`approved spec file must not be a symlink: ${file}`);
      rows.push({path:`${name}/${filename}`,sha256:semanticDigest(file)});
    }
  }
  return rows.sort((a,b)=>compare(a.path,b.path));
}

export function verifyManifest(manifest,statusFile){
  const value=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(fs.readFileSync(statusFile)));
  if(!record(value))fail('status file root must be an object');
  if(!Array.isArray(value.specFiles)||!value.specFiles.length)fail('status file has no approved specFiles manifest');
  const seen=new Set(),rows=value.specFiles.map((item,index)=>{
    if(!record(item)||Object.keys(item).sort().join(',')!=='path,sha256')fail(`specFiles[${index}] must contain path and sha256 only`);
    const p=item.path;
    if(typeof p!=='string'||p.startsWith('/')||p.includes('\\')||p.split('/').includes('..')||seen.has(p))
      fail(`specFiles[${index}].path is invalid or duplicated`);
    if(typeof item.sha256!=='string'||!/^[0-9a-f]{64}$/.test(item.sha256))fail(`specFiles[${index}].sha256 is invalid`);
    seen.add(p);return {path:p,sha256:item.sha256};
  });
  if(value.status!=='approved')fail('status file must have status approved before manifest verification');
  if(JSON.stringify(rows)!==JSON.stringify(manifest))fail('approved spec manifest does not match current spec files');
}

// Resolve symlinks before '..', like pathlib.resolve, rather than normalizing
// the spelling first. Both CLI inputs must exist for a successful operation.
const expand=p=>fs.realpathSync.native(p==='~'?os.homedir():p.startsWith('~/')?os.homedir()+'/'+p.slice(2):p);
export function main(argv=process.argv.slice(2),{stdout=process.stdout,stderr=process.stderr}={}){
  if(argv.length===1&&['-h','--help'].includes(argv[0])){stdout.write('usage: cm-spec-manifest.mjs specs_dir [--status-file PATH]\n');return 0;}
  try{
    let specs,status,options=true;
    for(let i=0;i<argv.length;i++){
      const arg=argv[i];
      if(options&&arg==='--'){options=false;continue;}
      if(options&&arg==='--status-file'){
        if(i+1>=argv.length)fail('invalid arguments');status=argv[++i];continue;
      }
      if(options&&arg.startsWith('--status-file=')){status=arg.slice('--status-file='.length);continue;}
      if(options&&arg.startsWith('-')||specs!==undefined)fail('invalid arguments');
      specs=arg;
    }
    if(specs===undefined)fail('invalid arguments');
    const specFiles=buildManifest(expand(specs));
    if(status!==undefined)verifyManifest(specFiles,expand(status));
    stdout.write(JSON.stringify({schema_version:1,...(status!==undefined?{status:'matched'}:{}),specFiles})+'\n');return 0;
  }catch(error){stderr.write(`cm-spec-manifest: ${error.message}\n`);return 1;}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))process.exitCode=main();
