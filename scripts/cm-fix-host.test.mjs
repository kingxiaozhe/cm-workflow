import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {PassThrough,Writable} from 'node:stream';
import {main} from './cm-fix-host.mjs';
import {startFixRun} from '../runtime/js/cm-fix/start.mjs';

test('fix CLI requires launch authorization and uses duplex diagnosis, resume and original store',async()=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-fix-cli-')));
  const specsRoot=path.join(root,'specs'),cwd=path.join(root,'code');fs.mkdirSync(specsRoot);fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(cwd,'AGENTS.md'),'Verify exact failure before modifying code.');
  const config=path.join(root,'config.json');
  fs.writeFileSync(config,JSON.stringify({specsRoot,identity:{repositoryId:'fixture',runId:'fix-cli-run',taskId:'T-FIX-cli',attempt:1},
    defect:'Synthetic defect',reproduction:{cwd,command:[process.execPath,'-e',
      "require('node:fs').appendFileSync('visits','1');process.stderr.write('BUG');process.exit(3)"],
      expectedFailure:{exitCode:3,outputIncludes:'BUG'},timeoutMs:2000}}));
  try{
    const args=['serve','--config',config,'--mode','create','--host-context','fixture-host','--allow-reproduction'];
    assert.equal(await main(args.slice(0,-1),{error:new Writable({write(c,e,cb){cb();}})}),1);
    assert.equal(fs.existsSync(path.join(specsRoot,'.reviews')),false);
    const definition=JSON.parse(fs.readFileSync(config,'utf8'));
    const startOptions={specsRoot,identity:definition.identity,configuration:{reproduction:definition.reproduction}};
    const badConfig=path.join(cwd,'.cm-workflow.json');fs.writeFileSync(badConfig,'{');
    assert.throws(()=>startFixRun(startOptions),{code:'invalid_workflow_config'});
    assert.equal(fs.existsSync(path.join(specsRoot,'运行日志.jsonl')),false);
    assert.equal(fs.existsSync(path.join(cwd,'visits')),false);fs.unlinkSync(badConfig);
    for(const mode of ['create','resume']){
      args[4]=mode;const input=new PassThrough();let calls=0;const replies=[];
      const output=new Writable({write(chunk,encoding,callback){
        const row=JSON.parse(chunk.toString());replies.push(row);
        if(row.type==='host_ready')input.write(JSON.stringify({requestId:'advance',operation:'advance'})+'\n');
        if(row.type==='host_request'){
          if(row.kind==='fix_learning'){
            assert.equal(row.payload.context[0].content,'Verify exact failure before modifying code.');
            input.write(JSON.stringify({type:'host_result',sessionId:row.sessionId,callId:row.callId,requestDigest:row.requestDigest,
              result:{contextDigest:row.payload.contextDigest,status:'applied',summary:'AGENTS.md: verify exact exit and signature before repair'}})+'\n');
            callback();return;
          }
          calls++;assert.equal(row.kind,'fix_diagnose');
          input.write(JSON.stringify({type:'host_result',sessionId:row.sessionId,callId:row.callId,requestDigest:row.requestDigest,
            result:{status:'diagnosed',rootCause:'Fixture constant',affectedPaths:['value.mjs'],affectedModules:['value'],
              plan:'Correct after red test',crossLayer:false}})+'\n');
        }
        if(row.requestId==='advance')setImmediate(()=>input.write(JSON.stringify({requestId:'complete',operation:'complete'})+'\n'));
        if(row.requestId==='complete')input.end();
        callback();
      }});
      assert.equal(await main(args,{input,output,error:output}),0);
      assert.equal(calls,mode==='create'?1:0);
      assert.equal(replies.find(row=>row.requestId==='advance').result.stage,'red_test_required');
      assert.equal(replies.find(row=>row.requestId==='advance').result.completionEligible,false);
      assert.equal(replies.find(row=>row.requestId==='advance').result.learning.application.status,'applied');
      assert.equal(replies.find(row=>row.requestId==='complete').error.code,'host_request_failed');
      assert.equal(fs.readFileSync(path.join(cwd,'visits'),'utf8'),'1');
      startFixRun(startOptions); // Interrupted startup replay deduplicates original events.
      const events=fs.readFileSync(path.join(specsRoot,'运行日志.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
      assert.equal(events.filter(row=>row.event==='run_start').length,1);
      assert.equal(events.filter(row=>row.event==='task_start'&&row.node==='FIX').length,1);
      assert.equal(events.filter(row=>row.event==='decision'&&row.phase==='route').length,3);
      assert.equal(events.some(row=>row.event==='run_done'),false);
    }
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('fix CLI red and baseline flags authorize separate real commands across resume',{timeout:15000},async()=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'fix-cli-checks-')));
  const cwd=path.join(root,'code'),specsRoot=path.join(root,'specs');fs.mkdirSync(cwd);fs.mkdirSync(specsRoot);
  fs.writeFileSync(path.join(cwd,'red.mjs'),"import fs from 'node:fs';fs.appendFileSync('red-calls','1');console.error('BUG');process.exit(1)");
  fs.writeFileSync(path.join(cwd,'existing.mjs'),"import fs from 'node:fs';fs.appendFileSync('baseline-calls','1')");
  const config=path.join(root,'config.json');
  fs.writeFileSync(config,JSON.stringify({specsRoot,identity:{repositoryId:'fixture',runId:'cli-checks',taskId:'T-FIX-checks',attempt:1},defect:'Synthetic',
    reproduction:{cwd,command:[process.execPath,'-e',"console.error('BUG');process.exit(1)"],expectedFailure:{exitCode:1,outputIncludes:'BUG'},timeoutMs:2000},
    redTest:{cwd,testFiles:['red.mjs'],command:[process.execPath,'red.mjs'],expectedFailure:{exitCode:1,outputIncludes:'BUG'},timeoutMs:2000},
    baseline:{cwd,testFiles:['existing.mjs'],commands:[{id:'existing',command:[process.execPath,'existing.mjs']}],timeoutMs:2000}}));
  try{
    for(const [index,flags] of [[],['--allow-red-test'],['--allow-baseline'],['--allow-red-test','--allow-baseline']].entries()){
      const input=new PassThrough(),rows=[],errors=[];let cursor=0;
      const ops=index===0?['advance','red_test','baseline']:['red_test','baseline'];
      const next=()=>cursor<ops.length?input.write(JSON.stringify({requestId:ops[cursor],operation:ops[cursor++]})+'\n'):input.end();
      const output=new Writable({write(chunk,encoding,callback){
        const row=JSON.parse(chunk.toString());rows.push(row);
        if(row.type==='host_ready')setImmediate(next);
        if(row.type==='host_request'){
          const result=row.kind==='fix_learning'?{contextDigest:row.payload.contextDigest,status:'no_relevant_lesson',summary:'No relevant lesson'}:
            {status:'diagnosed',rootCause:'Wrong constant',affectedPaths:['red.mjs'],affectedModules:['one'],plan:'Correct constant',crossLayer:false};
          input.write(JSON.stringify({type:'host_result',sessionId:row.sessionId,callId:row.callId,requestDigest:row.requestDigest,result})+'\n');
        }
        if(Object.hasOwn(row,'requestId'))setImmediate(next);callback();
      }});
      const code=await main(['serve','--config',config,'--mode',index===0?'create':'resume','--host-context','fixture-host','--allow-reproduction',...flags],
        {input,output,error:new Writable({write(chunk,encoding,cb){errors.push(chunk.toString());cb();}})});
      assert.equal(code,0,errors.join(''));
      const red=rows.find(row=>row.requestId==='red_test'),baseline=rows.find(row=>row.requestId==='baseline');
      if(index===0){assert(red.error);assert.equal(baseline.result.stage,'red_test_required');}
      if(index===1){assert.equal(red.result.stage,'baseline_required');assert(baseline.error);}
      if(index>=2){assert.equal(baseline.result.stage,'repair_required');assert.equal(baseline.result.completionEligible,false);}
      assert.equal(fs.existsSync(path.join(cwd,'red-calls')),index>0);
      assert.equal(fs.existsSync(path.join(cwd,'baseline-calls')),index>1);
    }
    assert.equal(fs.readFileSync(path.join(cwd,'red-calls'),'utf8'),'1');
    assert.equal(fs.readFileSync(path.join(cwd,'baseline-calls'),'utf8'),'1');
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
