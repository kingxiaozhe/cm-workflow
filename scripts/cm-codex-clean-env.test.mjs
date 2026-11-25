import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {previewTools} from '../runtime/js/cm-ai/tool-preview.mjs';
import {cleanEnvironment} from '../runtime/js/cm-ai/codex-config.mjs';

// 2026-11-25: on a macOS system proxy the Codex child of tool-preview sent its loopback
// probe through the proxy (502). The probe child alone gets a fixed loopback exemption;
// host proxy values (addresses or bypass lists) reach no CM child.
const PROXY_KEYS=['NO_PROXY','no_proxy','HTTP_PROXY','http_proxy','HTTPS_PROXY','https_proxy','ALL_PROXY','all_proxy'];
function withHostProxy(t){
  const saved=Object.fromEntries(PROXY_KEYS.map(k=>[k,process.env[k]]));
  t.after(()=>{for(const [k,v] of Object.entries(saved)){if(v===undefined)delete process.env[k];else process.env[k]=v;}});
  process.env.NO_PROXY='internal.example.test,127.0.0.1';
  process.env.no_proxy='internal.example.test';
  for(const k of PROXY_KEYS.slice(2))process.env[k]='http://proxy.example.test:8080';
}

test('tool-preview probe child gets only the fixed loopback proxy exemption',async t=>{
  withHostProxy(t);
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cm-js-b1-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const dump=path.join(dir,'env.json'),cli=path.join(dir,'fake-codex.mjs');
  fs.writeFileSync(cli,`#!/usr/bin/env node\nimport fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(dump)},JSON.stringify(process.env));\nprocess.exit(1);\n`,{mode:0o755});
  const receipt=await previewTools({cwd:fs.realpathSync(dir),model:'gpt-6.2-sol',cli,promptTransport:'argument',allowCodeProject:true});
  assert.equal(receipt.passed,false);
  const env=JSON.parse(fs.readFileSync(dump,'utf8'));
  assert.equal(env.NO_PROXY,'127.0.0.1');
  assert.equal(env.no_proxy,'127.0.0.1');
  for(const k of PROXY_KEYS.slice(2))assert.equal(k in env,false,k);
  assert.equal(JSON.stringify(env).includes('internal.example.test'),false);
});

test('other CM children still get no host proxy values',t=>{
  withHostProxy(t);
  const env=cleanEnvironment();
  for(const k of PROXY_KEYS)assert.equal(k in env,false,k);
});
