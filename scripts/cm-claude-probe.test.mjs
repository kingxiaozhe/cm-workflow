import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {previewClaudeTools,claudeProbeSandbox} from '../runtime/js/cm-ai/claude-tool-preview.mjs';

test('diagnostic stops the process after exactly one tool-free local request',
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
