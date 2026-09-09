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
for(const mode of ['revise','scope','drift'])test(`init revision CLI: ${mode}`,{timeout:5000},async()=>{
  const project=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-init-revision-')));
  fs.writeFileSync(path.join(project,'AGENTS.md'),'Original');
  const child=spawn(process.execPath,[path.join(root,'scripts/cm-init-host.mjs'),'serve','--skill-dir',
    path.join(root,'skills/cm-init'),'--project',project,'--host-context','fixture-author'],{stdio:['pipe','pipe','pipe']});
  const closed=once(child,'close'),lines=createInterface({input:child.stdout});
  const send=value=>child.stdin.write(JSON.stringify(value)+'\n');
  let sessionId,documents,status,stderr='',reviews=0;const calls=[];
  child.stderr.on('data',chunk=>{stderr+=chunk;});
  try{
    for await(const line of lines){
      const message=JSON.parse(line);
      if(message.type==='host_ready'){
        sessionId=message.sessionId;send({requestId:'generate',operation:'advance',selection:{versionControl:'none',modules:[],analysis:'Synthetic'}});
      }else if(message.type==='host_request'){
        calls.push(message.kind);let result;
        if(message.kind==='init_generate'){
          documents=message.payload.targets.map(file=>({path:file,content:'# Initial\n'}));result={status:'generated',documents};
        }else if(message.kind==='init_verify')result={checks:Object.fromEntries(message.payload.categories.map(name=>
          [name,{status:'verified',evidence:'Synthetic check'}])),constraintChanges:[]};
        else{
          assert.equal(message.kind,'init_review');reviews++;
          const pkg=message.payload.package;
          if(reviews===2){assert.equal(pkg.revisionHistory[0].review.result.verdict,'changes_requested');
            assert.ok(pkg.documents.every(document=>document.content==='# Revised\n'));}
          result={reviewer:'codex-subagent',contextId:`fixture-reviewer-${reviews}`,independent:true,at:new Date().toISOString(),
            result:{verdict:reviews===1?'changes_requested':'approved',packageDigest:pkg.packageDigest,examinedPaths:pkg.examinedPaths,
              findings:reviews===1?[{id:'R1',severity:'P2',path:'AGENTS.md',message:'Revise draft',evidence:'Synthetic finding'}]:[],summary:'Synthetic review'}};
        }
        send({type:'host_result',sessionId,callId:message.callId,requestDigest:message.requestDigest,result});
      }else if(message.requestId==='generate'||message.requestId==='verify'||message.requestId==='verify-again')send({requestId:message.requestId==='generate'?'verify':'review',operation:'advance'});
      else if(message.requestId==='review'){
        if(reviews===2)send({requestId:'status',operation:'status'});
        else{
          if(mode==='drift')fs.writeFileSync(path.join(project,'AGENTS.md'),'Human change');
          send({requestId:'revise',operation:'prepare_revision',documents:mode==='scope'?documents.slice(1):documents.map(document=>({...document,content:'# Revised\n'}))});
        }
      }else if(message.requestId==='revise'){
        if(mode==='revise'){assert.equal(message.result.stage,'draft_generated');send({requestId:'verify-again',operation:'advance'});}
        else{assert.ok(message.error);send({requestId:'status',operation:'status'});}
      }else if(message.requestId==='status'){status=message.result;send({type:'host_close',sessionId});}
    }
    const [code]=await closed;assert.equal(code,0,stderr);
    assert.equal(status.stage,mode==='revise'?'reviewed_draft':'review_changes_requested');
    assert.equal(status.revisionHistory.length,mode==='revise'?1:0);
    assert.equal(calls.filter(kind=>kind==='init_generate').length,1);
    assert.equal(reviews,mode==='revise'?2:1);
    assert.equal(fs.readFileSync(path.join(project,'AGENTS.md'),'utf8'),mode==='drift'?'Human change':'Original');
    assert.equal(fs.existsSync(path.join(project,'.claude')),false);
  }finally{child.kill();lines.close();await closed;fs.rmSync(project,{recursive:true,force:true});}
});
