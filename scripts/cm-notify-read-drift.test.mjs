// Two readers enforce the notify.json safe-read boundary: the sender's async
// readRegularFile (runtime/js/notify-send.mjs, a self-contained file copied
// alone to ~/.cm-workflow/notify/) and the runtime's synchronous
// readRegularFileSync (runtime/js/notify-safe-read.mjs, imported by notify.mjs
// and therefore free of process-exit side effects). The security logic exists
// twice, so this file runs one fixture matrix through both and fails when
// either changes behaviour alone.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {readRegularFile,MAX_FILE_BYTES} from '../runtime/js/notify-send.mjs';
import {readRegularFileSync,MAX_NOTIFY_FILE_BYTES} from '../runtime/js/notify-safe-read.mjs';

const posix=process.platform!=='win32';
const JSON_TEXT=JSON.stringify({version:1,command:['/bin/true']});
const sandbox=t=>{const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-read-drift-')));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;};
const mkfifo=file=>assert.equal(spawnSync('mkfifo',['-m','600',file]).status,0);
const clone=(st,over)=>Object.assign(Object.create(Object.getPrototypeOf(st)),st,over);

// One scenario = files to create + optional hooks into the check/open window.
// Hooks are written once; each reader gets them through its own fileOps shape.
//   lstat(st)  -> st seen by the path check      open(file,flags) before the open
//   fstat(st)  -> st seen on the opened handle    openError -> open throws this
function asyncOps(hooks,calls){
  return {
    lstat:async(file,options)=>(hooks.lstat??(x=>x))(await fsp.lstat(file,options)),
    open:async(file,flags)=>{
      calls.push(flags);hooks.open?.(file,flags);
      if(hooks.openError)throw hooks.openError;
      const handle=await fsp.open(file,flags);
      return {stat:async options=>(hooks.fstat??(x=>x))(await handle.stat(options)),
        read:(...args)=>handle.read(...args),close:()=>handle.close()};
    }};
}
function syncOps(hooks,calls){
  return {...fs,
    lstatSync:(file,options)=>(hooks.lstat??(x=>x))(fs.lstatSync(file,options)),
    openSync:(file,flags)=>{
      calls.push(flags);hooks.open?.(file,flags);
      if(hooks.openError)throw hooks.openError;
      return fs.openSync(file,flags);
    },
    fstatSync:(fd,options)=>(hooks.fstat??(x=>x))(fs.fstatSync(fd,options))};
}
const eacces=()=>Object.assign(new Error('denied'),{code:'EACCES'});
// A blocking open of a FIFO would hang the process; the stand-in fails fast.
const toFifo=(file,flags)=>{fs.unlinkSync(file);mkfifo(file);if(!(flags&fs.constants.O_NONBLOCK))throw new Error('blocking open on a FIFO');};

const SCENARIOS=[
  {name:'regular file',make:d=>write(d,JSON_TEXT),ok:{bytes:Buffer.from(JSON_TEXT),text:JSON_TEXT}},
  {name:'BOM file: bytes keep it, text drops it',make:d=>write(d,'\uFEFF'+JSON_TEXT),ok:{bytes:Buffer.from('\uFEFF'+JSON_TEXT),text:JSON_TEXT}},
  {name:'invalid UTF-8: bytes fine, text refused',make:d=>write(d,Buffer.from([0x7b,0xff,0xfe,0x7d])),
    ok:{bytes:Buffer.from([0x7b,0xff,0xfe,0x7d])},textRefused:{state:'invalid',reason:undefined}},
  {name:'exactly 64 KiB',make:d=>write(d,JSON_TEXT+' '.repeat(64*1024-JSON_TEXT.length)),ok:{size:64*1024}},
  {name:'64 KiB + 1',make:d=>write(d,JSON_TEXT+' '.repeat(64*1024+1-JSON_TEXT.length)),refused:{state:'invalid',reason:'too_large'}},
  {name:'missing',make:()=>{},refused:{state:'missing',reason:undefined}},
  {name:'path below a regular file (ENOTDIR)',make:d=>{write(d,'x');return path.join(d,'notify.json','inner');},refused:{state:'invalid',reason:undefined}},
  {name:'symlink to a valid file',make:d=>{fs.writeFileSync(path.join(d,'real.json'),JSON_TEXT);fs.symlinkSync(path.join(d,'real.json'),path.join(d,'notify.json'));},refused:{state:'invalid',reason:'permission'}},
  {name:'dangling symlink',make:d=>fs.symlinkSync(path.join(d,'nowhere.json'),path.join(d,'notify.json')),refused:{state:'invalid',reason:'permission'}},
  {name:'FIFO',posix:true,make:d=>mkfifo(path.join(d,'notify.json')),refused:{state:'invalid',reason:'permission'}},
  {name:'directory',make:d=>fs.mkdirSync(path.join(d,'notify.json')),refused:{state:'invalid',reason:'permission'}},
  // `other.json` exists before the check, so it has its own identity; at the swap
  // it is renamed onto the target. unlink+create could be handed the freed inode
  // back (ext4 does), which would make the identity check legitimately pass.
  {name:'swapped for another regular file between check and open',make:d=>{fs.writeFileSync(path.join(d,'other.json'),'{}');return write(d,JSON_TEXT);},
    hooks:d=>({open:file=>{
      const before=fs.statSync(file,{bigint:true});fs.renameSync(path.join(d,'other.json'),file);
      assert.notEqual(fs.statSync(file,{bigint:true}).ino,before.ino,'fixture invalid: the swapped-in file must have another inode');}}),refused:{state:'invalid',reason:'permission'},flags:true},
  // Identity is dev AND ino: each one alone must be enough to refuse.
  {name:'same ino but another device after the check',make:d=>write(d,JSON_TEXT),hooks:()=>({fstat:st=>clone(st,{dev:st.dev+1n})}),refused:{state:'invalid',reason:'permission'}},
  {name:'same device but another ino after the check',make:d=>write(d,JSON_TEXT),hooks:()=>({fstat:st=>clone(st,{ino:st.ino+1n})}),refused:{state:'invalid',reason:'permission'}},
  {name:'swapped for a FIFO between check and open',posix:true,make:d=>write(d,JSON_TEXT),hooks:()=>({open:toFifo}),refused:{state:'invalid',reason:'permission'},flags:true},
  {name:'grown past the cap after the check',make:d=>write(d,JSON_TEXT),hooks:()=>({fstat:st=>clone(st,{size:BigInt(64*1024+1)})}),refused:{state:'invalid',reason:'too_large'}},
  {name:'handle is not a regular file after the check',make:d=>write(d,JSON_TEXT),hooks:()=>({fstat:st=>clone(st,{isFile:()=>false})}),refused:{state:'invalid',reason:'permission'}},
  {name:'open fails (EACCES)',make:d=>write(d,JSON_TEXT),hooks:()=>({openError:eacces()}),refused:{state:'invalid',reason:undefined},flags:true},
];
function write(dir,content){const file=path.join(dir,'notify.json');fs.writeFileSync(file,content);return file;}

async function outcome(read,raw){
  try{return {value:await read(raw)};}
  catch(error){const d=error.detail??error;return {state:d.state,reason:d.reason};}
}
const normalize=(result,raw)=>result.value===undefined?result:{value:raw?Buffer.from(result.value).toString('hex'):result.value};

test('drift guard: the runtime sync reader and the sender async reader take the same decision for every fixture, bytes and text',async t=>{
  assert.equal(MAX_NOTIFY_FILE_BYTES,MAX_FILE_BYTES,'both readers cap at the same size');
  for(const scenario of SCENARIOS){
    if(scenario.posix&&!posix)continue;
    for(const raw of [true,false]){
      const mode=raw?'bytes':'text';
      const results=[];
      for(const kind of ['async','sync']){
        const dir=sandbox(t);
        const target=scenario.make(dir)??path.join(dir,'notify.json');
        const hooks=scenario.hooks?scenario.hooks(dir):{},calls=[];
        const read=kind==='async'
          ?()=>readRegularFile(target,'notify.json',{fileOps:asyncOps(hooks,calls),bytes:raw})
          :()=>Promise.resolve().then(()=>readRegularFileSync(target,'notify.json',{fileOps:syncOps(hooks,calls),bytes:raw}));
        const result=await outcome(read,raw);
        if(scenario.flags&&calls.length){
          assert.notEqual(calls[0]&fs.constants.O_NONBLOCK,0,`${scenario.name} (${kind}): open is non-blocking`);
          assert.notEqual(calls[0]&fs.constants.O_NOFOLLOW,0,`${scenario.name} (${kind}): open does not follow links`);
        }
        results.push(normalize(result,raw));
        const label=`${scenario.name} / ${mode} / ${kind}`;
        if(!raw&&scenario.textRefused)assert.deepEqual(result,scenario.textRefused,label);
        else if(scenario.refused)assert.deepEqual(result,scenario.refused,label);
        else{
          assert.equal(result.value!==undefined,true,`${label}: accepted`);
          if(scenario.ok.size!==undefined)assert.equal(result.value.length,scenario.ok.size,label);
          else assert.deepEqual(raw?Buffer.from(result.value):result.value,raw?scenario.ok.bytes:scenario.ok.text,label);
        }
      }
      assert.deepEqual(results[0],results[1],`${scenario.name} / ${mode}: async and sync readers agree`);
    }
  }
});

test('runtime sync reader: reads from the handle it checked and always closes it',{skip:!posix},t=>{
  const dir=sandbox(t);const file=write(dir,JSON_TEXT);
  const closed=[];
  const ops={...fs,closeSync:fd=>{closed.push(fd);fs.closeSync(fd);}};
  assert.equal(readRegularFileSync(file,'notify.json',{fileOps:ops}),JSON_TEXT);
  assert.equal(closed.length,1);
  closed.length=0;
  assert.throws(()=>readRegularFileSync(file,'notify.json',{fileOps:{...ops,fstatSync:()=>{throw new Error('boom');}}}),error=>error.state==='invalid');
  assert.equal(closed.length,1,'fd closed when the check after open throws');
});

// notify.mjs is imported by every host; importing it must never end the
// process. The sender (a CLI entry) may exit on an unsupported Node, so the
// runtime must not import it, directly or through anything it imports.
const RUNTIME=new URL('../runtime/js/',import.meta.url);
// Small scanner, not a parser: static imports/re-exports (also over several
// lines), side-effect imports and dynamic import() with a literal specifier.
// A dynamic import() with anything else as its argument is reported as
// `nonLiteral` so the test fails instead of silently missing a dependency.
export function scanImports(source){
  const code=source.replace(/\/\*[\s\S]*?\*\//g,'').replace(/^\s*\/\/.*$/gm,'');
  const specifiers=[];
  for(const m of code.matchAll(/\b(?:import|export)\b[^;'"`()]*?\bfrom\s*['"]([^'"]+)['"]/g))specifiers.push(m[1]);
  for(const m of code.matchAll(/\bimport\s*['"]([^'"]+)['"]/g))specifiers.push(m[1]);
  let literal=0;
  for(const m of code.matchAll(/\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g)){specifiers.push(m[2]);literal+=1;}
  const nonLiteral=[...code.matchAll(/\bimport\s*\(/g)].length-literal;
  return {specifiers,nonLiteral};
}
// Files of the runtime import graph, as paths relative to runtime/js/.
// Relative specifiers resolve from the importing file's own directory; the
// only other specifiers allowed are node: built-ins.
function importGraph(entry,seen=new Set()){
  if(seen.has(entry))return seen;seen.add(entry);
  const base=new URL(entry,RUNTIME);
  const {specifiers,nonLiteral}=scanImports(fs.readFileSync(base,'utf8'));
  assert.equal(nonLiteral,0,`${entry} has a dynamic import() with a non-literal specifier; the import graph cannot be checked`);
  for(const specifier of specifiers){
    if(specifier.startsWith('node:'))continue;
    assert(specifier.startsWith('.'),`${entry} imports ${specifier}: only node: built-ins and relative files are allowed`);
    importGraph(path.relative(fileURLToPath(RUNTIME),fileURLToPath(new URL(specifier,base))),seen);
  }
  return seen;
}
test('import scanner: multi-line static imports, dynamic import() with a literal, non-literal dynamic import()',()=>{
  const multi=scanImports(`import {\n  a,\n  b,\n} from './multi.mjs';\nexport * from "./re.mjs";\nimport './side.mjs';\n// import {x} from './comment.mjs';\n/* import('./block.mjs') */\nconst lazy=await import('./lazy/dyn.mjs');`);
  assert.deepEqual(multi.specifiers.sort(),['./lazy/dyn.mjs','./multi.mjs','./re.mjs','./side.mjs']);
  assert.equal(multi.nonLiteral,0);
  assert.equal(scanImports('const m=await import(name);import(`./${x}.mjs`);import("./ok.mjs");').nonLiteral,2);
  assert.equal(scanImports('console.log(import.meta.url);').nonLiteral,0);
});

const importChild=(file,env={})=>spawnSync(process.execPath,['--input-type=module','-e',
  `await import(${JSON.stringify(pathToFileURL(file).href)});console.log('imported');`],{encoding:'utf8',timeout:10000,env:{...process.env,...env}});

test('importing runtime/js/notify.mjs has no process-exit side effect, also when import.meta.main is missing',t=>{
  const graph=[...importGraph('notify.mjs')];
  assert(graph.includes('notify-safe-read.mjs'));
  assert(!graph.some(file=>file.includes('notify-send')),`the runtime must not import the sender: ${graph}`);
  for(const file of graph){
    const source=fs.readFileSync(new URL(file,RUNTIME),'utf8');
    assert(!/process\.exit\s*\(/.test(source),`${file} must not call process.exit`);
  }
  // Plain import in a child: exits 0.
  const plain=importChild(fileURLToPath(new URL('notify.mjs',RUNTIME)));
  assert.equal(plain.status,0,plain.stderr);assert.match(plain.stdout,/imported/);
  // Simulated Node without import.meta.main: copy the whole import graph with
  // every `import.meta.main` replaced by `undefined`, import that copy.
  const copy=(files,dir)=>{for(const file of files){
    const target=path.join(dir,file);fs.mkdirSync(path.dirname(target),{recursive:true});
    fs.writeFileSync(target,fs.readFileSync(new URL(file,RUNTIME),'utf8').replaceAll('import.meta.main','undefined'));}};
  const runtimeCopy=sandbox(t);copy(graph.concat(['notify-run.mjs']),runtimeCopy);
  const simulated=importChild(path.join(runtimeCopy,'notify.mjs'));
  assert.equal(simulated.status,0,simulated.stderr);assert.match(simulated.stdout,/imported/);
  // Negative control: the same simulation does kill an import of the sender,
  // so the check above is able to fail.
  const senderCopy=sandbox(t);copy(['notify-send.mjs'],senderCopy);
  const control=importChild(path.join(senderCopy,'notify-send.mjs'));
  assert.equal(control.status,3);assert.doesNotMatch(control.stdout,/imported/);
});
