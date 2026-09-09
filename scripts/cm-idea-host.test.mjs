import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {writeReviewEvidence} from '../runtime/js/cm-ai/review-evidence-file.mjs';
const root=fileURLToPath(new URL('..',import.meta.url));
test('idea save exclusive publication rejects identical concurrent file',()=>{
  const directory=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-idea-race-')));
  const target=path.join(directory,'prd-fixture.md'),bytes=Buffer.from('Same draft');
  try{
    assert.throws(()=>writeReviewEvidence({reviewsDir:directory,name:'prd-fixture.md',bytes,exclusive:true,
      validate:()=>fs.writeFileSync(target,bytes,{mode:0o600,flag:'wx'})}),/review_file_conflict/);
    assert.deepEqual(fs.readFileSync(target),bytes);
    assert.deepEqual(fs.readdirSync(directory),['prd-fixture.md']);
    // Existing review publishers retain their default idempotent behavior.
    assert.equal(writeReviewEvidence({reviewsDir:directory,name:'prd-fixture.md',bytes}).outcome,'published');
  }finally{fs.rmSync(directory,{recursive:true,force:true});}
});
for(const mode of ['dialogue','wrong-level','cancel','save-success','save-reject','save-conflict','save-denied','save-late'])test(`idea host CLI: ${mode}`,{timeout:5000},async()=>{
  const project=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-idea-host-')));
  const child=spawn(process.execPath,[path.join(root,'scripts/cm-idea-host.mjs'),'serve','--skill-dir',path.join(root,'skills/cm-idea'),
    ...(mode.startsWith('save-')&&!['save-denied','save-late'].includes(mode)?['--save-root',project]:[])],
    {cwd:project,stdio:['pipe','pipe','pipe']});
  const closed=once(child,'close'),lines=createInterface({input:child.stdout});
  const send=value=>child.stdin.write(JSON.stringify(value)+'\n');let sessionId,calls=0,status,stderr='';
  child.stderr.on('data',chunk=>{stderr+=chunk;});
  try{
    for await(const line of lines){
      const message=JSON.parse(line);
      if(message.type==='host_ready'){
        sessionId=message.sessionId;send({requestId:'turn',operation:'start',text:'Synthetic idea'});
      }else if(message.type==='host_request'){
        if(message.kind==='idea_confirm_save'){
          calls++;assert.equal(message.payload.path,path.join(project,'prd','prd-fixture.md'));
          assert.equal(fs.existsSync(path.join(project,'prd')),false);
          if(mode==='save-conflict'){fs.mkdirSync(path.join(project,'prd'));fs.writeFileSync(message.payload.path,'User content');}
          send({type:'host_result',sessionId,callId:message.callId,requestDigest:message.requestDigest,
            result:{decision:mode==='save-reject'?'rejected':'approved'}});continue;
        }
        assert.equal(message.kind,'idea_interview');calls++;
        assert.equal(message.payload.messages.length,(calls-1)*2+1);
        assert.ok(fs.existsSync(message.payload.reference));
        if(mode==='cancel'){send({requestId:'cancel',operation:'cancel'});continue;}
        const result=mode==='dialogue'&&calls===1?{status:'question',question:'Who is the primary user?',productType:'B'}:
          {status:'draft',content:'# Synthetic PRD',maturity:mode==='wrong-level'?'L3':mode.startsWith('save-')||calls===2?'L1':'L2',productType:'B',followup:'What should change?'};
        send({type:'host_result',sessionId,callId:message.callId,requestDigest:message.requestDigest,result});
      }else if(message.requestId==='turn'){
        if(mode==='dialogue'&&calls<3)send({requestId:'turn',operation:'advance',text:calls===1?'Developers':'Please deepen to L2',maturity:calls===1?'L1':'L2'});
        else if(mode==='save-late')send({requestId:'prepare',operation:'prepare_save',saveRoot:project});
        else if(mode.startsWith('save-'))send({requestId:'save',operation:'finish',filename:'prd-fixture.md'});
        else send({requestId:'status',operation:'status'});
      }else if(message.requestId==='prepare'){
        assert.equal(message.result.writeAuthorized,false);assert.deepEqual(fs.readdirSync(project),[]);
        send({requestId:'save',operation:'finish',filename:'prd-fixture.md'});
      }else if(message.requestId==='save')send({requestId:'status',operation:'status'});
      else if(message.requestId==='status'){status=message.result;send({type:'host_close',sessionId});}
    }
    const [code]=await closed;assert.equal(code,0,stderr);
    assert.equal(calls,mode==='dialogue'?3:mode.startsWith('save-')&&mode!=='save-denied'?2:1);
    assert.equal(status.stage,{dialogue:'draft_ready','wrong-level':'failed',cancel:'cancelled',
      'save-success':'saved','save-reject':'draft_ready','save-conflict':'save_blocked','save-denied':'draft_ready','save-late':'saved'}[mode]);
    if(mode==='dialogue'){assert.equal(status.draft.maturity,'L2');assert.equal(status.turns,3);}
    assert.equal(status.writeAuthorized,false);assert.equal(status.completionAuthorized,false);
    if(['save-success','save-conflict','save-late'].includes(mode)){
      const file=path.join(project,'prd','prd-fixture.md');
      assert.equal(fs.readFileSync(file,'utf8'),mode!=='save-conflict'?'# Synthetic PRD':'User content');
      if(mode==='save-success'){assert.equal(status.saved.path,file);assert.equal(fs.statSync(file).mode&0o777,0o600);}
    }else assert.deepEqual(fs.readdirSync(project),[]);
  }finally{child.kill();lines.close();await closed;fs.rmSync(project,{recursive:true,force:true});}
});
