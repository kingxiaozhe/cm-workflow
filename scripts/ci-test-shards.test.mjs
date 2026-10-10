import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {assignShards,median,readWeights} from './ci-test-shards.mjs';

const script=fileURLToPath(new URL('./ci-test-shards.mjs',import.meta.url));
const scriptsDir=fileURLToPath(new URL('.',import.meta.url));
const realFiles=fs.readdirSync(scriptsDir).filter(name=>name.endsWith('.test.mjs')).map(name=>`scripts/${name}`).sort();

test('every test file lands in exactly one shard for any shard count',()=>{
  const weights=readWeights();
  for(let shards=1;shards<=6;shards++){
    const result=assignShards(realFiles,shards,weights);
    assert.equal(result.length,shards);
    const all=result.flatMap(shard=>shard.files);
    assert.equal(all.length,realFiles.length);
    assert.deepEqual([...all].sort(),realFiles);
  }
});

test('assignment is deterministic and independent of input order',()=>{
  const weights=readWeights();
  const forward=assignShards(realFiles,4,weights),backward=assignShards([...realFiles].reverse(),4,weights);
  assert.deepEqual(backward,forward);
});

test('heaviest-first assignment keeps every shard within one file of the average',()=>{
  const weights=new Map([['a.test.mjs',100],['b.test.mjs',90],['c.test.mjs',50],['d.test.mjs',40],['e.test.mjs',10],['f.test.mjs',10]]);
  const files=[...weights.keys()].map(name=>`scripts/${name}`);
  const result=assignShards(files,2,weights);
  assert.deepEqual(result.map(shard=>shard.seconds),[150,150]);
  const real=readWeights(),shards=assignShards(realFiles,4,real);
  const total=shards.reduce((sum,shard)=>sum+shard.seconds,0);
  const heaviest=Math.max(...realFiles.map(file=>real.get(file.slice('scripts/'.length))??median(real.values())));
  for(const shard of shards)assert(shard.seconds<=total/4+heaviest,`${shard.seconds} > ${total/4}+${heaviest}`);
});

test('a file missing from the weight table counts as the median and is still scheduled',()=>{
  const weights=new Map([['a.test.mjs',1],['b.test.mjs',5],['c.test.mjs',9]]);
  assert.equal(median(weights.values()),5);
  const result=assignShards(['scripts/a.test.mjs','scripts/b.test.mjs','scripts/c.test.mjs','scripts/new.test.mjs'],2,weights);
  // c(9) -> 0, b(5) -> 1, new(median 5) -> 1, a(1) -> 0.
  assert.deepEqual(result.map(shard=>shard.files),[['scripts/a.test.mjs','scripts/c.test.mjs'],['scripts/b.test.mjs','scripts/new.test.mjs']]);
  assert.deepEqual(result.map(shard=>shard.seconds),[10,10]);
});

test('duplicate files and invalid shard counts are refused',()=>{
  assert.throws(()=>assignShards(['scripts/a.test.mjs','scripts/a.test.mjs'],2,new Map()),/duplicate/);
  for(const shards of [0,1.5,NaN])assert.throws(()=>assignShards(['scripts/a.test.mjs'],shards,new Map()),/positive integer/);
});

test('CLI prints exactly its shard and the shards together cover the input',()=>{
  const printed=[];
  for(let index=0;index<4;index++){
    const run=spawnSync(process.execPath,[script,'--shards','4','--index',String(index),...realFiles],{encoding:'utf8'});
    assert.equal(run.status,0,run.stderr);
    printed.push(...run.stdout.trim().split('\n').filter(Boolean));
  }
  assert.deepEqual(printed.sort(),realFiles);
  const bad=spawnSync(process.execPath,[script,'--shards','4','--index','4',...realFiles],{encoding:'utf8'});
  assert.notEqual(bad.status,0);assert.match(bad.stderr,/index must be/);
});
