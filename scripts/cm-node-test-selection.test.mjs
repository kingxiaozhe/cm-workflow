import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import test from 'node:test';
import {selectedNodeTestFiles} from '../runtime/js/node-test-selection.mjs';
import {mandatoryCheckCoverage} from '../runtime/js/check-coverage.mjs';
import {createHostCheck} from '../runtime/js/cm-ai/host-check.mjs';
import {acceptanceCoverage} from '../runtime/js/cm-ai/acceptance-contract.mjs';

const files=['a.test.mjs','b.test.mjs'];
const argv=(...options)=>[process.execPath,'--test',...options,...files];
const coverage=command=>mandatoryCheckCoverage({requiredTests:files,commands:[command]});
const identity={repositoryId:'node-selection',runId:'native-fixture',taskId:'T-001',attempt:1};
const supported=spawnSync(process.execPath,['--help'],{encoding:'utf8'}).stdout;

test('native non-filtering options select exact explicit files without changing argv',()=>{
  for(const options of [
    ['--test-concurrency=2'],['--test-concurrency','2'],
    ['--test-timeout=1000'],['--test-timeout','1000'],
    ...['tap','spec','dot'].flatMap(value=>[['--test-reporter',value],[`--test-reporter=${value}`]]),
    ['--test-reporter=tap','--test-reporter-destination=stdout'],
    ['--test-reporter','spec','--test-reporter-destination','stderr'],
    ['--test-concurrency=2','--test-timeout=1000','--test-reporter=dot','--'],
  ]){
    const command=Object.freeze(argv(...options));
    assert.deepEqual(selectedNodeTestFiles(command),files,JSON.stringify(options));
    assert.deepEqual(coverage(command),{satisfied:true,missing:[],unverifiable:[]});
  }
  assert.deepEqual(selectedNodeTestFiles([process.execPath,'--test-reporter=tap','--test','./a.test.mjs']),['a.test.mjs']);
});

test('every supported option rejects absent, invalid or duplicate values',()=>{
  const cases=[
    ['--test-concurrency'],['--test-timeout'],['--test-reporter'],['--test-reporter-destination'],
    ...['0','-1','1.5','Infinity','2147483648','01',''].flatMap(value=>[
      [`--test-concurrency=${value}`],[`--test-timeout=${value}`]]),
    ['--test-reporter=./custom.mjs'],['--test-reporter=node:custom'],['--test-reporter='],
    ['--test-reporter-destination=stdout'],
    ['--test-reporter=tap','--test-reporter-destination=a.test.mjs'],
    ['--test-reporter=tap','--test-reporter-destination='],
    ['--test','--test'],
    ...[['--test-concurrency=1'],['--test-timeout=1000'],['--test-reporter=tap'],
      ['--test-reporter=tap','--test-reporter-destination=stdout']].map(options=>[...options,...options]),
  ];
  for(const options of cases)assert.deepEqual(coverage(argv(...options)),
    {satisfied:false,missing:files,unverifiable:files},JSON.stringify(options));
});

test('filters, npm wrappers, custom execution hooks and unknown options stay unverifiable',()=>{
  for(const options of [
    ['--test-name-pattern=small'],['--test-skip-pattern=important'],['--test-shard=1/2'],['--test-only'],
    ['--test-rerun-failures=prior.json'],['--test-global-setup=setup.mjs'],['--test-isolation=none'],
    ['--import=preload.mjs'],['--require=preload.cjs'],['--experimental-config-file=config.json'],
    ['--test-update-snapshots'],['--future-filter=small'],['--test-reporter=tap','--test-only'],
  ])assert.deepEqual(coverage(argv(...options)).unverifiable,files,JSON.stringify(options));
  for(const command of [['npm','test','--',...files],['npm','run','test','--',...files],
    ['node','--test',...files],['/project/node','--test',...files]])
    assert.deepEqual(coverage(command).unverifiable,files);
});

test('options stop at the first file and missing files remain missing',()=>{
  for(const command of [[process.execPath,'--test','a.test.mjs','--test-concurrency=1','b.test.mjs'],
    [process.execPath,'--test','*.test.mjs'],[process.execPath,'--test'],
    [process.execPath,'--test-reporter=tap',...files],
    [process.execPath,'--test','--','--test-only',...files]])
    assert.deepEqual(coverage(command).unverifiable,files);
  assert.deepEqual(coverage([process.execPath,'--test','--test-reporter=tap','./a.test.mjs']),
    {satisfied:false,missing:['b.test.mjs'],unverifiable:[]});
  assert.deepEqual(coverage([process.execPath,'--test','--test-reporter=tap','a.test.mjs.bak']),
    {satisfied:false,missing:files,unverifiable:[]});
});

// Real native subprocesses, isolated temporary files, no npm or external access.
// Options unavailable in an older supported Node are not injected into user
// commands; here those specific executions are explicitly skipped.
for(const [name,options] of [
  ['concurrency',['--test-concurrency','1']],
  ['timeout',['--test-timeout=1000']],
  ['tap',['--test-reporter=tap']],['spec',['--test-reporter','spec']],['dot',['--test-reporter=dot']],
  ['destination',['--test-reporter=tap','--test-reporter-destination','stderr']],
  ['separator',['--test-reporter=tap','--',]],
])test(`actual host Node execution with ${name} preserves both selected files`,
  {skip:!supported.includes(options[0].split('=')[0])},async()=>{
    const cwd=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-node-selection-')));
    try{
      for(const [index,file] of files.entries())fs.writeFileSync(path.join(cwd,file),
        `import test from 'node:test';import fs from 'node:fs';test('selected ${index}',()=>fs.writeFileSync('ran-${index}','yes'));\n`);
      const command=argv(...options),check=createHostCheck({cwd,commands:[{id:'node-tests',command}],timeoutMs:10000});
      const observed=await check({identity},{signal:new AbortController().signal});
      assert.equal(observed[0].outcome,'passed');assert.deepEqual(observed[0].command,command);
      for(let index=0;index<files.length;index++)assert.equal(fs.readFileSync(path.join(cwd,`ran-${index}`),'utf8'),'yes');
      assert.equal(acceptanceCoverage({requiredTests:files,requiredCommands:[['node',...command.slice(1)]]},observed).satisfied,true);
    }finally{fs.rmSync(cwd,{recursive:true,force:true});}
  });

test('native command failure remains failure even when its file selection is modeled',async()=>{
  const cwd=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-node-selection-fail-')));
  try{
    fs.writeFileSync(path.join(cwd,files[0]),"import test from 'node:test';test('failure',()=>{throw Error('fixture');});\n");
    const command=[process.execPath,'--test','--test-reporter=tap',files[0]],
      check=createHostCheck({cwd,commands:[{id:'node-tests',command}],timeoutMs:10000});
    const observed=await check({identity},{signal:new AbortController().signal});
    assert.equal(observed[0].outcome,'failed');
    assert.equal(acceptanceCoverage({requiredTests:[files[0]],requiredCommands:[['node',...command.slice(1)]]},observed).satisfied,false);
  }finally{fs.rmSync(cwd,{recursive:true,force:true});}
});
