import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url));
for(const mode of ['analyzed','blocked','missing-choice','cancel'])test(`init analysis CLI: ${mode}`,{timeout:5000},async()=>{
  const project=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-init-analysis-')));
  fs.writeFileSync(path.join(project,'README.md'),'Synthetic project');
  const child=spawn(process.execPath,[path.join(root,'scripts/cm-init-host.mjs'),'serve','--skill-dir',
    path.join(root,'skills/cm-init'),'--project',project],{stdio:['pipe','pipe','pipe']});
  const closed=once(child,'close'),lines=createInterface({input:child.stdout});
  const send=value=>child.stdin.write(JSON.stringify(value)+'\n');
  let sessionId,status,stderr='';const calls=[];
  child.stderr.on('data',chunk=>{stderr+=chunk;});
  try{
    for await(const line of lines){
      const message=JSON.parse(line);
      if(message.type==='host_ready'){
        sessionId=message.sessionId;send({requestId:'analyze',operation:'start'});
      }else if(message.type==='host_request'){
        calls.push(message.kind);let result;
        if(message.kind==='init_analyze'){
          assert.equal(message.payload.observations.semanticAnalysisRequired,true);
          if(mode==='cancel'){send({requestId:'cancel',operation:'cancel'});continue;}
          result=mode==='blocked'?{status:'blocked',reason:'Synthetic missing project evidence'}:
            {status:'analyzed',selection:{versionControl:'none',modules:[],analysis:'Synthetic project analysis'},
              evidence:'Synthetic host report, not live verification',noGitDecision:mode==='missing-choice'?null:'explicit_user_refusal'};
        }else{
          assert.equal(message.kind,'init_generate');
          assert.equal(message.payload.selection.analysis,'Synthetic project analysis');
          assert.equal(message.payload.selection.versionControl,'none');
          result={status:'generated',documents:message.payload.targets.map(file=>({path:file,content:'# Synthetic rule\n'}))};
        }
        send({type:'host_result',sessionId,callId:message.callId,requestDigest:message.requestDigest,result});
      }else if(message.requestId==='analyze')send({requestId:mode==='analyzed'?'generate':'status',operation:mode==='analyzed'?'advance':'status'});
      else if(message.requestId==='generate')send({requestId:'status',operation:'status'});
      else if(message.requestId==='status'){status=message.result;send({type:'host_close',sessionId});}
    }
    const [code]=await closed;assert.equal(code,0,stderr);
    assert.deepEqual(calls,mode==='analyzed'?['init_analyze','init_generate']:['init_analyze']);
    assert.equal(status.stage,{analyzed:'draft_generated',blocked:'analysis_blocked','missing-choice':'failed',cancel:'cancelled'}[mode]);
    assert.equal(status.writeAuthorized,false);
    assert.deepEqual(fs.readdirSync(project),['README.md']);
  }finally{child.kill();lines.close();await closed;fs.rmSync(project,{recursive:true,force:true});}
});
