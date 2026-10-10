#!/usr/bin/env node
// CI 分片：把测试文件按实测耗时分到 N 份，每个文件恰好落在一份里。
// 以前按排序后的序号轮流分，最慢的几个文件挤进同一份，那一份比别的慢近一倍。
// 现在用 ci-test-weights.json 里记的秒数做贪心分配（最重的先放进当前最轻的一份），
// 表里没有的新文件按表中位数计，所以新增测试不用先改表也会被分到某一份。
// 只决定哪份跑哪些文件，不跳过、不过滤任何文件。
// 用法：node scripts/ci-test-shards.mjs --shards 4 --index 0 scripts/a.test.mjs scripts/b.test.mjs ...
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const weightsFile=fileURLToPath(new URL('./ci-test-weights.json',import.meta.url));

export function readWeights(file=weightsFile){
  const raw=JSON.parse(fs.readFileSync(file,'utf8'));
  const weights=new Map();
  for(const [name,seconds] of Object.entries(raw.seconds??{})){
    if(!Number.isFinite(seconds)||seconds<0)throw new Error(`invalid weight for ${name}`);
    weights.set(name,seconds);
  }
  return weights;
}

export function median(values){
  const sorted=[...values].sort((a,b)=>a-b);
  if(sorted.length===0)return 1;
  const mid=Math.floor(sorted.length/2);
  return sorted.length%2?sorted[mid]:(sorted[mid-1]+sorted[mid])/2;
}

// Deterministic longest-processing-time assignment: heaviest file first, ties by
// name; each goes to the currently lightest shard, ties by lowest shard index.
export function assignShards(files,shards,weights){
  if(!Number.isInteger(shards)||shards<1)throw new Error('shards must be a positive integer');
  const unique=[...new Set(files)];
  if(unique.length!==files.length)throw new Error('duplicate test file');
  const fallback=median(weights.values());
  const weightOf=file=>weights.get(path.basename(file))??fallback;
  const order=[...files].sort((a,b)=>weightOf(b)-weightOf(a)||(a<b?-1:a>b?1:0));
  const result=Array.from({length:shards},()=>({files:[],seconds:0}));
  for(const file of order){
    let target=0;
    for(let i=1;i<shards;i++)if(result[i].seconds<result[target].seconds)target=i;
    result[target].files.push(file);result[target].seconds+=weightOf(file);
  }
  for(const shard of result)shard.files.sort();
  return result;
}

function main(argv){
  let shards=null,index=null;const files=[];
  for(let i=0;i<argv.length;i++){
    if(argv[i]==='--shards')shards=Number(argv[++i]);
    else if(argv[i]==='--index')index=Number(argv[++i]);
    else if(argv[i]==='--summary')index='summary';
    else files.push(argv[i]);
  }
  const result=assignShards(files,shards,readWeights());
  if(index==='summary'){
    result.forEach((shard,i)=>process.stdout.write(`shard ${i}: ${shard.files.length} files, ~${Math.round(shard.seconds)}s\n`));
    return;
  }
  if(!Number.isInteger(index)||index<0||index>=shards)throw new Error('index must be in [0, shards)');
  for(const file of result[index].files)process.stdout.write(file+'\n');
}

if(process.argv[1]&&fs.realpathSync(process.argv[1])===fileURLToPath(import.meta.url))main(process.argv.slice(2));
