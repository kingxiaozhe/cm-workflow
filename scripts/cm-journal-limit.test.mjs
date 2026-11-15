// 存档单条上限 4 MiB（Wue specs8 T-001 的审查包约 1.17 MB，1 MiB 时装不下）：
// 默认值、只许调小的测试开关、普通运行的大记录写入与读回、cm-fix 压缩标记不误打。
import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {JOURNAL_PAYLOAD_LIMIT} from '../runtime/js/cm-ai/effect-contract.mjs';
import {openExecutionStore} from '../runtime/js/cm-ai/execution-store.mjs';
import {appendFits} from '../runtime/js/cm-ai/execution-store-limits.mjs';
import {packFixJournalState} from '../runtime/js/cm-ai/review-presentation.mjs';
import {readExecutionSnapshot} from '../runtime/js/cm-ai/execution-snapshot.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const isolated=fs.mkdtempSync(path.join(os.tmpdir(),'cm-journal-limit-'));
after(()=>fs.rmSync(isolated,{recursive:true,force:true}));
const limitWith=value=>{
  const env={...process.env};delete env.CM_JOURNAL_PAYLOAD_LIMIT_TEST;if(value!==undefined)env.CM_JOURNAL_PAYLOAD_LIMIT_TEST=value;
  const run=spawnSync(process.execPath,['--input-type=module','-e',`import {JOURNAL_PAYLOAD_LIMIT} from ${JSON.stringify(path.join(root,'runtime/js/cm-ai/effect-contract.mjs'))};process.stdout.write(String(JOURNAL_PAYLOAD_LIMIT));`],{encoding:'utf8',env});
  assert.equal(run.status,0,run.stderr);return Number(run.stdout);
};

test('默认 4 MiB；测试开关只许调小，调大与非法值忽略',()=>{
  const MiB=1024*1024;
  assert.equal(limitWith(undefined),4*MiB);
  assert.equal(limitWith(String(MiB)),MiB);
  for(const bad of [String(8*MiB),String(4*MiB),'abc','-1',String(1024),'1.5'])assert.equal(limitWith(bad),4*MiB,bad);
  assert.equal(JOURNAL_PAYLOAD_LIMIT,4*MiB,'本测试进程没有设开关');
});

test('普通运行：1.2 MB 的记录写得进、读得回，不被打上 cm-fix 压缩标记',()=>{
  const specsRoot=fs.realpathSync(fs.mkdtempSync(path.join(isolated,'store-')));
  const options={specsRoot,identity:{repositoryId:'size',runId:'size-run'},fingerprints:{workflow:'a'.repeat(64),config:'b'.repeat(64),inputs:'c'.repeat(64)}};
  let store=openExecutionStore({...options,create:true});
  const payload={s:'x'.repeat(1200*1024)};
  try{
    const input={id:'big',kind:'result',payload,expectedRevision:store.snapshot().revision};
    assert.equal(appendFits(store.snapshot(),input),true);
    store.append(input);
  }finally{store.close();}
  store=openExecutionStore({...options,create:false});
  try{assert.deepEqual(store.snapshot().records.at(-1).payload,payload);}finally{store.close();}
  const file=fs.readdirSync(path.join(specsRoot,'.reviews','.execution','size-run')).find(name=>name==='state.json');
  const physical=JSON.parse(fs.readFileSync(path.join(specsRoot,'.reviews','.execution','size-run',file),'utf8'));
  assert.equal(Object.hasOwn(physical,'storageEncoding'),false);
  // 只读发现路径（驾驶员 status/advance 先走它）按同一上限读回，不再写死 1 MiB（Wue specs8 T-001 第 2 轮 limit_exceeded）
  assert.deepEqual(readExecutionSnapshot({specsRoot,identity:{repositoryId:'size',runId:'size-run'}}).records.at(-1).payload,payload);
});

test('整份状态打包：非 cm-fix 运行的大记录不打压缩标记',()=>{
  const state={version:1,identity:{repositoryId:'r',runId:'r'},fingerprints:{workflow:'a'.repeat(64)},revision:'0'.repeat(64),
    records:[{version:1,seq:1,id:'init',kind:'intent',payload:{s:'x'.repeat(1100*1024)},previousDigest:null,digest:'0'.repeat(64)}]};
  assert.equal(Object.hasOwn(packFixJournalState(state),'storageEncoding'),false);
});

// Wue specs8 T-001: the store accepted a 1.2 MB develop checkpoint but the runner's
// own payload builder still used json()'s 1 MiB default, failed inside the store
// operation and poisoned the run as store_failure.
test('the runner builds and bounds a record between 1 MiB and the journal limit, and refuses one above it', async () => {
  const {runnerPayload,runnerPayloadV3,boundRunnerRecord}=await import('../runtime/js/cm-ai/durable-runner-state.mjs');
  const big={effectId:'develop-1',blob:'x'.repeat(1200*1024)};
  for(const payload of [runnerPayloadV3('effect-checkpoint',big),runnerPayload('effect-checkpoint',big,2)]){
    assert.ok(Buffer.byteLength(JSON.stringify(payload))>1024*1024);
    assert.doesNotThrow(()=>boundRunnerRecord({id:'runner.000002',kind:'result',payload},2));
  }
  assert.throws(()=>runnerPayloadV3('effect-checkpoint',{blob:'x'.repeat(JOURNAL_PAYLOAD_LIMIT)}));
});
