import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {spawn} from 'node:child_process';
import {previewClaudeTools} from '../runtime/js/cm-ai/claude-tool-preview.mjs';
import {claudeWorker,claudeReviewFingerprint,claudePreflightMatches,claudeAliasModelMatches} from '../runtime/js/cm-ai/worker-claude.mjs';

const concrete='claude-opus-5-5';
const options={cwd:process.cwd(),model:concrete,cli:'synthetic-cli'};
const receipt={passed:true,provider:'claude',prompt_transport:'stdin',
  config_fingerprint:claudeReviewFingerprint({...options,model:concrete}),
  model_resolution:{requested_model:'default',resolved_model:concrete,resolution_context:'synthetic-api-key-probe'}};
function probeSpawn(resolve,observed,oneShotTools=false){
  let toolStarts=0;
  return (command,args,settings)=>{
    const model=args[args.indexOf('--model')+1];observed.push(model);
    const payloads=resolve(model,observed.length,args);
    const tools=args.includes('--restricted')&&(!oneShotTools||++toolStarts===1)
      ?['mcp__cm_review__read_file','mcp__cm_review__run_check','mcp__cm_review__mutate_check'].map(name=>({name})):[];
    const source=`process.on('SIGTERM',()=>{});process.stdin.resume();process.stdin.on('end',async()=>{
      for(const model of ${JSON.stringify(payloads)}){
        await fetch(process.env.ANTHROPIC_BASE_URL+'/v1/messages',{method:'POST',
          headers:{'x-api-key':'cm-synthetic-local-probe'},
          body:JSON.stringify({model,messages:[{role:'user',content:'synthetic'}],tools:${JSON.stringify(tools)}})});
      }process.exit(1);
    });`;
    return spawn(command,[...args.slice(0,2),process.execPath,'-e',source],settings);
  };
}
test('Claude alias receipt pins a concrete worker model without rewriting requested configuration',async()=>{
  assert.equal(claudePreflightMatches(receipt,options),true);
  const calls=[];
  const worker=claudeWorker({...options,preflight:receipt,killProcess:()=>{},spawnProcess:(cli,args)=>{
    calls.push({cli,args});const child=new EventEmitter();child.pid=12345;
    child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();
    child.stdin.on('finish',()=>queueMicrotask(()=>{
      child.stdout.write(JSON.stringify({type:'system',subtype:'init',session_id:'alias-review'})+'\n');
      child.stdout.write(JSON.stringify({type:'assistant',session_id:'alias-review',parent_tool_use_id:null,message:{role:'assistant',content:[{type:'text',text:'review'}]}})+'\n');
      child.stdout.write(JSON.stringify({type:'result',subtype:'success',session_id:'alias-review',is_error:false,
        num_turns:1,structured_output:{verdict:'approved'},result:'{"verdict":"approved"}'})+'\n');
      child.emit('close',0,null);
    }));return child;
  }});
  const result=await worker({prompt:'synthetic'}, {signal:new AbortController().signal,onEvent:()=>{}});
  assert.equal(result.status,'succeeded');assert.equal(calls.length,1);
  assert.equal(calls[0].args[calls[0].args.indexOf('--model')+1],concrete);
  assert.equal(options.model,concrete);
  assert.equal(receipt.model_resolution.requested_model,'default');
});
test('Claude alias receipt rejects stale bindings, wrong family, extra fields and explicit-id substitution',async()=>{
  for(const [value,config]of [
    [{...receipt,model_resolution:{...receipt.model_resolution,requested_model:'unknown-alias'}},options],
    [{...receipt,model_resolution:{...receipt.model_resolution,resolved_model:'claude-sonnet-5-5'}},options],
    [{...receipt,model_resolution:{...receipt.model_resolution,extra:true}},options],
    [{...receipt,model_resolution:null},options],
    [{...receipt,model_resolution:{requested_model:concrete,resolved_model:concrete,resolution_context:'synthetic-api-key-probe'}},{...options,model:concrete}],
    [{...receipt,model_resolution:{requested_model:'sonnet',resolved_model:concrete,resolution_context:'synthetic-api-key-probe'}},{...options,model:'sonnet'}],
    [receipt,{...options,cwd:'/different-project'}],
    [receipt,{...options,model:'default'}],
    [receipt,{...options,effort:'high'}],
  ]){
    assert.equal(claudePreflightMatches(value,config),false,JSON.stringify([value.model_resolution,config]));
    const worker=claudeWorker({...config,preflight:value,spawnProcess:()=>assert.fail('invalid receipt dispatched')});
    assert.equal((await worker({prompt:'synthetic'},{signal:new AbortController().signal,onEvent:()=>{}})).code,'tool_preflight_missing');
  }
});
test('legacy Claude preflight receipts retain their original fingerprint and dispatch contract',()=>{
  const old={...receipt,config_fingerprint:claudeReviewFingerprint(options)};delete old.model_resolution;
  assert.equal(claudePreflightMatches(old,options),true);
  assert.equal(claudePreflightMatches(old,{...options,model:'default'}),false);
});
for(const alias of ['default','opus','sonnet','haiku'])test(`Claude alias ${alias} is captured then verified by a separate concrete-id probe`,
  {skip:process.platform!=='darwin'},async()=>{
    const resolved=alias==='default'?concrete:`claude-${alias}-5-5`,calls=[];
    const result=await previewClaudeTools({cwd:process.cwd(),model:alias,cli:'synthetic-cli',
      spawnProcess:probeSpawn(()=>[resolved],calls)});
    assert.equal(result.preflight.passed,true);assert.deepEqual(calls,[alias,resolved]);
    assert.equal(result.model,resolved);
    assert.deepEqual(result.preflight.model_resolution,{requested_model:alias,resolved_model:resolved,resolution_context:'synthetic-api-key-probe'});
    assert.equal(result.preflight.config_fingerprint,claudeReviewFingerprint({...options,model:resolved}));
    assert.equal(claudePreflightMatches(result.preflight,{...options,model:resolved}),true);
  });
test('Claude alias discovery cannot permit explicit mismatch, wrong family, unsafe ids or divergent requests',
  {skip:process.platform!=='darwin'},async()=>{
    for(const [alias,requests]of [[concrete,['claude-sonnet-5-5']],['sonnet',[concrete]],
      ['default',['default']],['default',['private-content']],['default',['claude-opus-5-5\nsecret']],
      ['default',[concrete,'claude-sonnet-5-5']]]){
      const calls=[];const result=await previewClaudeTools({cwd:process.cwd(),model:alias,
        spawnProcess:probeSpawn(()=>requests,calls)});
      assert.equal(result.preflight.passed,false,JSON.stringify([alias,requests]));
      assert.equal(calls.length,1);assert.equal(Object.hasOwn(result.preflight,'model_resolution'),false);
      assert(!JSON.stringify(result).includes('private-content'));assert(!JSON.stringify(result).includes('secret'));
    }
  });
test('Claude alias concrete-id recheck cannot accept a second alias resolution',
  {skip:process.platform!=='darwin'},async()=>{
    const calls=[];const result=await previewClaudeTools({cwd:process.cwd(),model:'default',
      spawnProcess:probeSpawn((_model,index)=>[index===1?concrete:'claude-sonnet-5-5'],calls)});
    assert.deepEqual(calls,['default',concrete]);assert.equal(result.preflight.passed,false);
  });

test('Claude alias family contract accepts version token order and rejects ambiguous or unbounded ids',()=>{
  for(const [alias,id,expected]of [
    ['default','claude-opus-5-5',true],['opus','claude-opus-5-5',true],
    ['haiku','claude-3-5-haiku-20241022',true],['sonnet','claude-sonnet-5-5',true],
    ['sonnet','claude-opus-5-5',false],['opus','claude-3-5-haiku-20241022',false],
    ['default','claude-opus-sonnet-5',false],['default','claude-opus-opus-5',false],
    ['default','claude-opus',false],['default','claude-5-5',false],
    ['default','claude-opus-5-secret',false],['default','claude-opus-'+ '5'.repeat(100),false],
    ['opusplan','claude-opus-5-5',false],['default',null,false],
  ])assert.equal(claudeAliasModelMatches(alias,id),expected,JSON.stringify([alias,id]));
});

test('Claude alias verification transport is consumed only by the concrete probe',
  {skip:process.platform!=='darwin'},async()=>{
    const calls=[],restricted=[];
    const verification={files:['synthetic.mjs'],checks:[{id:'synthetic',command:[process.execPath,'--version']}],
      mutationPaths:['synthetic.mjs'],timeoutMs:1000};
    const result=await previewClaudeTools({cwd:process.cwd(),model:'default',verification,
      verificationTransport:{mcpConfig:'synthetic-once-only-transport'},
      spawnProcess:probeSpawn((_model,_index,args)=>{restricted.push(args.includes('--restricted'));return [concrete];},calls,true)});
    assert.equal(result.preflight.passed,true);assert.deepEqual(calls,['default',concrete]);
    assert.deepEqual(restricted,[false,true]);
    assert.equal(claudePreflightMatches(result.preflight,{...options,cli:'claude',verification}),true);
    assert.equal(claudePreflightMatches(result.preflight,{...options,cli:'claude'}),false);
  });
