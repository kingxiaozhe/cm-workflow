import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHostCheck} from '../runtime/js/cm-ai/host-check.mjs';
import {createProjectExecution} from '../runtime/js/cm-ai/host-project-execution.mjs';

const identity={repositoryId:'ipc-fixture',runId:'ipc-check',taskId:'T-001',attempt:1};
const control=()=>({signal:new AbortController().signal});
const command=(code)=>({id:'ipc',command:[process.execPath,'-e',code]});
async function fixture(run){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-ipc-test-'))),cwd=path.join(root,'code'),specsRoot=path.join(cwd,'specs');
  fs.mkdirSync(specsRoot,{recursive:true});fs.mkdirSync(path.join(cwd,'.claude'));
  for(const [name,value]of [['specs/tasks.md','host-owned'],['AGENTS.md','instructions'],['CLAUDE.md','instructions'],['.claude/rule.md','instructions']])fs.writeFileSync(path.join(cwd,name),value);
  try{return await run({root,cwd,specsRoot});}finally{fs.rmSync(root,{recursive:true,force:true});}
}
function fakeCodex(root){
  const bin=path.join(root,'bin');fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin,'codex'),`#!${process.execPath}\nconst fs=require('node:fs');
    if(process.argv.includes('--help')){console.log(fs.existsSync('unsupported')?'no scoped IPC flag':'--allow-unix-socket');process.exit(0);}
    const args=process.argv.slice(2),i=args.indexOf('--');const tmp=args[i+1]==='/usr/bin/env'?args[i+2].slice('TMPDIR='.length):process.env.TMPDIR;const trace={args,tmp,sandboxTmp:process.env.TMPDIR,mode:fs.statSync(tmp).mode&511};
    fs.writeFileSync('trace.json',JSON.stringify(trace));console.log('READY');
    if(fs.existsSync('hang'))setInterval(()=>{},1000);else process.exit(fs.existsSync('fail')?7:0);\n`,{mode:0o700});
  return bin;
}
for(const failed of [false,true])test(`protected IPC launcher confines temporary socket grant and preserves ${failed?'failure':'success'} result`,
  {skip:process.platform==='win32'},()=>fixture(async({root,cwd,specsRoot})=>{
    const previous=process.env.PATH;process.env.PATH=fakeCodex(root)+path.delimiter+previous;
    if(failed)fs.writeFileSync(path.join(cwd,'fail'),'1');
    try{
      const check=createHostCheck({cwd,specsRoot,commands:[command('process.exit(0)')]});
      const [result]=await check({identity},control());const trace=JSON.parse(fs.readFileSync(path.join(cwd,'trace.json')));
      assert.equal(result.outcome,failed?'failed':'passed');assert.equal(result.exitCode,failed?7:0);
      assert.equal(trace.sandboxTmp,process.env.TMPDIR);
      assert.deepEqual(trace.args.slice(trace.args.indexOf('--')+1),['/usr/bin/env','TMPDIR='+trace.tmp,process.execPath,'-e','process.exit(0)']);
      assert.equal(trace.mode,0o700);assert.match(path.basename(trace.tmp),/^cmc-/);
      const i=trace.args.indexOf('--allow-unix-socket');assert(i>=0);assert.equal(trace.args[i+1],trace.tmp);
      assert.equal(trace.args.filter(a=>a==='--allow-unix-socket').length,1);
      assert(trace.args.some(a=>a.includes('network={enabled=false}')));
      assert(trace.args.some(a=>a.includes(JSON.stringify(specsRoot)+'="read"')));
      assert(!fs.existsSync(trace.tmp),'owned temporary root survived check completion');
    }finally{process.env.PATH=previous;}
  }));
test('protected IPC cancellation cleans only its owned temporary root after child close',
  {skip:process.platform==='win32'},()=>fixture(async({root,cwd,specsRoot})=>{
    const previous=process.env.PATH;process.env.PATH=fakeCodex(root)+path.delimiter+previous;fs.writeFileSync(path.join(cwd,'hang'),'1');
    try{
      const ac=new AbortController();const check=createHostCheck({cwd,specsRoot,timeoutMs:5000,commands:[command('unused')],
        onOutput:()=>{ac.abort();}});
      await assert.rejects(check({identity},{signal:ac.signal}),{code:'cancelled'});
      const trace=JSON.parse(fs.readFileSync(path.join(cwd,'trace.json')));assert.match(path.basename(trace.tmp),/^cmc-/);
      assert(!fs.existsSync(trace.tmp));assert(fs.existsSync(root));
    }finally{process.env.PATH=previous;}
  }));
test('unprotected host check preserves its inherited TMPDIR',()=>fixture(async({cwd})=>{
  const file=path.join(cwd,'tmp.txt'),check=createHostCheck({cwd,commands:[command(`require('node:fs').writeFileSync(${JSON.stringify(file)},process.env.TMPDIR??'unset')`)]});
  assert.equal((await check({identity},control()))[0].outcome,'passed');assert.equal(fs.readFileSync(file,'utf8'),process.env.TMPDIR??'unset');
}));
test('protected proposal scope guard still refuses out-of-scope edits before applying them',()=>fixture(async({cwd,specsRoot})=>{
  const definition={codeProject:cwd,specsDir:specsRoot,identity,scope:['allowed.txt']};
  const execution=createProjectExecution({definition,protection:{checkCommands:[command('process.exit(0)')],timeoutMs:5000}});
  await assert.rejects(execution.commit({scope:['allowed.txt'],edits:[{path:'outside.txt',beforeSha256:null,content:'bad'}],
    expected:{'allowed.txt':null},identity,signal:new AbortController().signal}),{code:'out_of_scope'});
  assert(!fs.existsSync(path.join(cwd,'outside.txt')));
}));

test('protected IPC refuses unsupported native permission capability before project execution',
  {skip:process.platform==='win32'},()=>fixture(async({root,cwd,specsRoot})=>{
    const previous=process.env.PATH;process.env.PATH=fakeCodex(root)+path.delimiter+previous;fs.writeFileSync(path.join(cwd,'unsupported'),'1');
    try{
      const [result]=await createHostCheck({cwd,specsRoot,commands:[command('unused') ]})({identity},control());
      assert.equal(result.outcome,'unavailable');assert.equal(result.exitCode,null);
      assert.equal(result.evidence,'host check: unix_socket_permission_unavailable');assert(!fs.existsSync(path.join(cwd,'trace.json')));
    }finally{process.env.PATH=previous;}
  }));
test('protected IPC never creates a host temporary directory within specs or the project',
  {skip:process.platform==='win32'},()=>fixture(async({root,cwd,specsRoot})=>{
    const previous=process.env.PATH,oldTmp=process.env.TMPDIR;process.env.PATH=fakeCodex(root)+path.delimiter+previous;
    try{
      for(const tmp of [cwd,specsRoot]){
        process.env.TMPDIR=tmp;const before=fs.readdirSync(tmp).sort();
        const [result]=await createHostCheck({cwd,specsRoot,commands:[command('unused')]})({identity},control());
        assert.equal(result.outcome,'unavailable');assert.equal(result.evidence,'host check: temporary_directory_unavailable');
        assert.deepEqual(fs.readdirSync(tmp).sort(),before);assert(!fs.existsSync(path.join(cwd,'trace.json')));
      }
    }finally{process.env.PATH=previous;if(oldTmp===undefined)delete process.env.TMPDIR;else process.env.TMPDIR=oldTmp;}
  }));

for(const earlierFailure of [false,true])test(`protected IPC retains its private root when cleanup is unknown${earlierFailure?' after output failure':''}`,
  {skip:process.platform==='win32'},()=>fixture(async({root,cwd,specsRoot})=>{
    const previous=process.env.PATH,killProcess=process.kill;process.env.PATH=fakeCodex(root)+path.delimiter+previous;
    let ownedPid=null,tmp=null;
    process.kill=(pid,signal)=>{if(pid===-ownedPid)throw Object.assign(new Error('synthetic cleanup permission refusal'),{code:'EPERM'});return killProcess.call(process,pid,signal);};
    try{
      const [result]=await createHostCheck({cwd,specsRoot,commands:[command('unused')],onSpawn:e=>{ownedPid=e.pid;},
        onOutput:()=>{if(earlierFailure)throw Error('synthetic output failure');}})({identity},control());
      tmp=JSON.parse(fs.readFileSync(path.join(cwd,'trace.json'))).tmp;
      assert.equal(result.outcome,'unavailable');assert.equal(result.exitCode,null);
      assert.equal(result.evidence,earlierFailure?'host check: output_capture_failed; cleanup_failed':'host check: cleanup_failed');
      assert(fs.existsSync(tmp),'cleanup uncertainty must retain its owned root even after another failure');
    }finally{process.kill=killProcess;process.env.PATH=previous;if(tmp!==null)fs.rmSync(tmp,{recursive:true,force:true});}
  }));
