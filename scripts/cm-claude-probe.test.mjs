import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import * as zlib from 'node:zlib';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {previewClaudeTools,claudeProbeSandbox} from '../runtime/js/cm-ai/claude-tool-preview.mjs';
import {previewPromptTransport,writePreviewPrompt} from '../runtime/js/cm-ai/tool-preview.mjs';

test('tool preview argument transport preserves a long Unicode argv prompt without stdin',()=>{
  const prompt='参数\n🚀'+'界'.repeat(10000);
  const transport=previewPromptTransport('argument',prompt);
  assert.equal(transport.argument,prompt);assert.equal(transport.stdin,null);
  assert.deepEqual(transport.stdio,['ignore','pipe','pipe']);
  let stdinAccesses=0;
  const cleanup=writePreviewPrompt({get stdin(){stdinAccesses++;throw Error('stdin accessed');}},
    'argument',prompt,()=>assert.fail('argument transport wrote stdin'));
  cleanup();assert.equal(stdinAccesses,0);
});

// Authored without local execution; verification by reviewer outside the sandbox is pending.
// The sink intentionally retains protocol checks, never the decoded body bytes.
for(const encoding of ['gzip','zstd','br'])test(`Claude probe ${encoding} body reaches only its declared decoder`,
  {skip:process.platform!=='darwin'||(encoding==='zstd'&&typeof zlib.zstdCompressSync!=='function')},async()=>{
    const payload={model:'fixture',messages:[{role:'user',content:`synthetic ${encoding} payload`}],tools:[]};
    const source=`let input='';process.stdin.on('data',s=>input+=s);process.stdin.on('end',async()=>{
      const zlib=require('node:zlib');const body=Buffer.from(JSON.stringify(${JSON.stringify(payload)}));
      const encoded=${JSON.stringify(encoding)}==='gzip'?zlib.gzipSync(body):
        ${JSON.stringify(encoding)}==='zstd'?zlib.zstdCompressSync(body):body;
      await fetch(process.env.ANTHROPIC_BASE_URL+'/v1/messages',{method:'POST',
        headers:{'x-api-key':'cm-synthetic-local-probe','content-encoding':${JSON.stringify(encoding)}},body:encoded});
      process.exit(1);
    });`;
    const {preflight}=await previewClaudeTools({cwd:process.cwd(),model:'fixture',
      spawnProcess:(command,args,options)=>spawn(command,[...args.slice(0,2),process.execPath,'-e',source],options)});
    assert.equal(preflight.message_requests,1);
    assert.equal(preflight.listener_closed,true);
    if(encoding==='br'){
      assert.equal(preflight.passed,false);
      assert.equal(preflight.request_checks[0].encoding_supported,false);
      assert.equal(preflight.request_checks[0].json,false);
    }else{
      assert.equal(preflight.passed,true);
      assert.equal(preflight.request_checks[0].json,true);
      assert.equal(preflight.request_checks[0].model_matches,true);
      assert.equal(preflight.request_checks[0].messages_array,true);
      assert.equal(preflight.request_checks[0].tools_allowed,true);
      assert.equal(preflight.request_checks[0].synthetic_auth,true);
    }
  });

test('probe accepts only empty tools or one internal StructuredOutput tool',
  {skip:process.platform!=='darwin'},async()=>{
    for(const [tools,passed] of [[[],true],[[{name:'StructuredOutput'}],true],[[{name:'Bash'}],false],
      [[{name:'StructuredOutput'},{name:'Bash'}],false],[[{name:'StructuredOutput'},{name:'StructuredOutput'}],false],
      [[null],false],['StructuredOutput',false]]){
      const source=`let input='';process.stdin.on('data',s=>input+=s);process.stdin.on('end',async()=>{
        const response=await fetch(process.env.ANTHROPIC_BASE_URL+'/v1/messages',{method:'POST',
          headers:{'x-api-key':'cm-synthetic-local-probe'},
          body:JSON.stringify({model:'fixture',messages:[{role:'user',content:input}],tools:${JSON.stringify(tools)}})});
        await response.text();process.exit(1);
      });`;
      const result=await previewClaudeTools({cwd:process.cwd(),model:'fixture',
        spawnProcess:(command,args,options)=>spawn(command,[...args.slice(0,2),process.execPath,'-e',source],options)});
      assert.equal(result.preflight.passed,passed,JSON.stringify(tools));
      assert.equal(result.preflight.message_requests,1);
      assert.equal(result.preflight.message_requests_expected,'1-2');
      assert.equal(result.preflight.listener_closed,true);
      assert.equal(result.preflight.request_checks[0].tools_allowed,passed);
      assert.equal('tools_empty' in result.preflight.request_checks[0],false);
    }
  });

test('probe accepts at most two compliant requests and validates every request',
  {skip:process.platform!=='darwin'},async t=>{
    const empty={model:'fixture',tools:[]};
    const structured={model:'fixture',tools:[{name:'StructuredOutput'}]};
    const cases=[
      ['two empty tool lists',[empty,empty],true],
      ['two StructuredOutput tool lists',[structured,structured],true],
      ['empty and StructuredOutput tool lists',[empty,structured],true],
      ['second request includes Bash',[structured,{...empty,tools:[{name:'Bash'}]}],false],
      ['second request changes model',[empty,{...empty,model:'different-model'}],false],
      ['three compliant requests',[empty,structured,empty],false],
    ];
    for(const [name,requests,passed] of cases)await t.test(name,async()=>{
      // Keep the fixture alive after SIGTERM so the worker's real cleanup captures
      // the entire sequence deterministically, without delaying the probe's abort.
      const source=`process.on('SIGTERM',()=>{});setInterval(()=>{},1000);
        let input='';process.stdin.on('data',s=>input+=s);process.stdin.on('end',async()=>{
          for(const request of ${JSON.stringify(requests)}){
            const response=await fetch(process.env.ANTHROPIC_BASE_URL+'/v1/messages',{method:'POST',
              headers:{'x-api-key':'cm-synthetic-local-probe'},
              body:JSON.stringify({...request,messages:[{role:'user',content:input}]})});
            await response.text();
          }
        });`;
      const {preflight}=await previewClaudeTools({cwd:process.cwd(),model:'fixture',
        spawnProcess:(command,args,options)=>spawn(command,[...args.slice(0,2),process.execPath,'-e',source],options)});
      assert.equal(preflight.message_requests,requests.length);
      assert.equal(preflight.local_requests,requests.length);
      assert.equal(preflight.message_requests_expected,'1-2');
      assert.equal(preflight.passed,passed);
      assert.equal(preflight.stopped_by_probe,true);
      assert.equal(preflight.process_code,'cancelled');
      assert.equal(preflight.listener_closed,true);
      assert.deepEqual(preflight.request_checks.map(checks=>checks.tools_allowed),
        requests.map(request=>request.tools.every(tool=>tool.name==='StructuredOutput')));
      assert.deepEqual(preflight.request_checks.map(checks=>checks.model_matches),
        requests.map(request=>request.model==='fixture'));
    });
  });

test('diagnostic still accepts one tool-free message request from an older CLI',
  {skip:process.platform!=='darwin'},async()=>{
    const fixture=fileURLToPath(new URL('./fixtures/claude-review-process.mjs',import.meta.url));
    const result=await previewClaudeTools({cwd:process.cwd(),model:'fixture-plain-error',
      spawnProcess:(command,args,options)=>{
        assert.equal(options.env.CLAUDE_CODE_TMPDIR,options.env.CLAUDE_CONFIG_DIR);
        assert.equal(options.env.TMPDIR,options.env.CLAUDE_CONFIG_DIR);
        return spawn(command,[...args.slice(0,2),process.execPath,fixture,...args.slice(3)],options);
      }});
    assert.equal(result.preflight.passed,true);assert.equal(result.preflight.local_requests,2);
    assert.equal(result.preflight.message_requests,1);
    assert.equal(result.preflight.message_requests_expected,'1-2');
    assert.equal(result.preflight.stopped_by_probe,true);assert.equal(result.preflight.listener_closed,true);
  });
test('probe sandbox denies sibling writes and connections to a different loopback port',
  {skip:process.platform!=='darwin'},async()=>{
    const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-probe-isolation-')));
    const allowed=path.join(root,'allowed');fs.mkdirSync(allowed);
    const denied=path.join(root,'denied');let requests=0;
    const server=http.createServer((_request,response)=>{requests++;response.end('unexpected');});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const port=server.address().port,other=port===65535?port-1:port+1;
    try {
      const source=`const fs=require('node:fs'),http=require('node:http');
        try{fs.writeFileSync(${JSON.stringify(denied)},'bad');process.exit(2)}catch{}
        const r=http.get('http://127.0.0.1:${port}',()=>process.exit(3));
        r.on('error',()=>process.exit(0));r.setTimeout(2000,()=>process.exit(4));`;
      const child=spawn('/usr/bin/sandbox-exec',['-p',claudeProbeSandbox(allowed,other),process.execPath,'-e',source],
        {stdio:'ignore'});
      const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
      assert.equal(code,0);assert.equal(requests,0);assert.equal(fs.existsSync(denied),false);
    } finally {
      server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
      fs.rmSync(root,{recursive:true,force:true});
    }
  });
test('malformed request target returns a failed receipt and closes the listener',
  {skip:process.platform!=='darwin'},async()=>{
    const fixture=fileURLToPath(new URL('./fixtures/claude-review-process.mjs',import.meta.url));
    const result=await previewClaudeTools({cwd:process.cwd(),model:'fixture-invalid-target',
      spawnProcess:(command,args,options)=>spawn(command,[...args.slice(0,2),process.execPath,fixture,...args.slice(3)],options)});
    assert.equal(result.preflight.passed,false);assert.equal(result.preflight.local_requests,1);
    assert.equal(result.preflight.listener_closed,true);assert.equal(result.preflight.exit_code,1);
    assert.deepEqual(result.preflight.request_checks,[{complete:false}]);
  });
