import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createInterface} from 'node:readline';
import {once} from 'node:events';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
import {publishCmInitReviewEvidence} from '../runtime/js/cm-init/review-evidence.mjs';
const repository=fileURLToPath(new URL('..',import.meta.url));
for(const mode of ['generate','cancel','verify','unverified','verify-drift','confirm','confirm-approve','confirm-reject','confirm-drift','review-package','review-package-drift','review-package-encoding','review-result-approved','review-result-changes','review-result-self','review-result-digest','write-success','write-partial','write-denied','write-drift','write-evidence-conflict','write-evidence-permissions'])test(`init host actual JSONL CLI: ${mode}`,{timeout:5000},async()=>{
  const project=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-init-host-')));
  fs.writeFileSync(path.join(project,'AGENTS.md'),mode==='review-package-encoding'?Buffer.from([0xff,0x42]):'Preserve original rule');
  const child=spawn(process.execPath,[path.join(repository,'scripts/cm-init-host.mjs'),'serve',
    '--skill-dir',path.join(repository,'skills/cm-init'),'--project',project,'--host-context','fixture-author',
    ...(mode.startsWith('write-')&&mode!=='write-denied'?['--allow-write']:[])],{stdio:['pipe','pipe','pipe']});
  const closed=once(child,'close');const messages=[];let calls=0,sessionId,reviewPackage;
  const send=value=>child.stdin.write(JSON.stringify(value)+'\n');
  const lines=createInterface({input:child.stdout});let stderr='';child.stderr.on('data',chunk=>{stderr+=chunk;});
  try{
    for await(const line of lines){
      const message=JSON.parse(line);messages.push(message);
      if(message.type==='host_ready'){
        sessionId=message.sessionId;send({requestId:'generate',operation:'advance',selection:{versionControl:'none',modules:[],analysis:'Synthetic fixture'}});
      }else if(message.type==='host_request'){
        calls++;
        if(message.kind==='init_write'){
          const archive=fs.readFileSync(path.join(project,'.reviews',`cm-init-${message.payload.review.packageDigest}.md`),'utf8');
          const saved=JSON.parse(archive.split('```json\n')[1].split('\n```')[0]);
          assert.equal(saved.reviewPackage.originals.find(file=>file.path==='AGENTS.md').content,'Preserve original rule');
          assert.deepEqual(saved.reviewPackage.documents,message.payload.documents);
          assert.deepEqual(saved.review,message.payload.review);
          assert.equal(message.payload.project,project);
          for(const document of mode==='write-partial'?message.payload.documents.slice(0,1):message.payload.documents){
            const target=path.join(project,document.path);fs.mkdirSync(path.dirname(target),{recursive:true});
            fs.writeFileSync(target,document.content);
          }
          send({type:'host_result',sessionId,callId:message.callId,requestDigest:message.requestDigest,result:{status:'written'}});
        }else if(message.kind==='init_review'){
          assert.equal(message.payload.authorContextId,'fixture-author');
          const pkg=message.payload.package;
          reviewPackage=pkg;
          send({type:'host_result',sessionId,callId:message.callId,requestDigest:message.requestDigest,
            result:{reviewer:'codex-subagent',contextId:mode==='review-result-self'?'fixture-author':'fixture-independent',
              independent:true,at:new Date().toISOString(),result:{verdict:mode==='review-result-changes'?'changes_requested':'approved',
                packageDigest:mode==='review-result-digest'?'wrong':pkg.packageDigest,examinedPaths:pkg.examinedPaths,
                findings:mode==='review-result-changes'?[{id:'R1',severity:'P2',path:pkg.examinedPaths[0],message:'Fixture finding',evidence:'Synthetic evidence'}]:[],
                summary:'Synthetic review, not a real independent reviewer'}}});
        }else if(message.kind==='init_confirm'){
          assert.deepEqual(message.payload.changes.map(change=>change.path),['AGENTS.md']);
          assert.equal(message.payload.changes[0].before,'Preserve original rule');
          assert.match(message.payload.changes[0].after,/# Fixture/);
          if(mode==='confirm-drift')fs.writeFileSync(path.join(project,'AGENTS.md'),'Concurrent user change');
          send({type:'host_result',sessionId,callId:message.callId,requestDigest:message.requestDigest,
            result:{decision:mode==='confirm-reject'?'rejected':'approved'}});
        }else if(message.kind==='init_verify'){
          if(mode==='verify-drift')fs.writeFileSync(path.join(project,'AGENTS.md'),'Concurrent user change');
          send({type:'host_result',sessionId,callId:message.callId,requestDigest:message.requestDigest,
            result:{checks:Object.fromEntries(message.payload.categories.map(category=>[category,
              {status:mode==='unverified'?'unverified':'verified',evidence:'Synthetic host assertion, not live evidence'}])),
            constraintChanges:mode.startsWith('confirm')?['AGENTS.md']:[]}});
        }else{
          assert.equal(message.kind,'init_generate');
          if(mode==='cancel')send({requestId:'cancel',operation:'cancel'});
          else send({type:'host_result',sessionId,callId:message.callId,requestDigest:message.requestDigest,
            result:{status:'generated',documents:message.payload.targets.map(file=>({path:file,content:'# Fixture\nPreserve original rule\n'}))}});
        }
      }else if(message.requestId==='generate')send(['generate','cancel'].includes(mode)
        ?{requestId:'status',operation:'status'}:{requestId:'verify',operation:'advance'});
      else if(message.requestId==='verify'){
        if(mode==='review-package-drift')fs.writeFileSync(path.join(project,'AGENTS.md'),'Concurrent user change');
        send(mode.startsWith('review-result')||mode.startsWith('write-')?{requestId:'review',operation:'advance'}:mode.startsWith('confirm-')?{requestId:'confirm',operation:'advance'}:mode.startsWith('review-package')
          ?{requestId:'package',operation:'final_review_package'}:{requestId:'status',operation:'status'});
      }
      else if(message.requestId==='package')send(mode==='review-package'
        ?{requestId:'package-again',operation:'final_review_package'}:{requestId:'status',operation:'status'});
      else if(message.requestId==='package-again')send({requestId:'status',operation:'status'});
      else if(message.requestId==='confirm')send({requestId:'status',operation:'status'});
      else if(message.requestId==='review'){
        if(mode==='write-evidence-permissions'){
          const saved=publishCmInitReviewEvidence({project,reviewPackage,review:message.result.review});
          fs.chmodSync(saved.path,0o644);
        }
        if(mode==='write-evidence-conflict'){
          fs.mkdirSync(path.join(project,'.reviews'));
          fs.writeFileSync(path.join(project,'.reviews',`cm-init-${message.result.review.packageDigest}.md`),'User evidence');
        }
        if(mode==='write-drift')fs.writeFileSync(path.join(project,'AGENTS.md'),'Concurrent user change');
        send(mode.startsWith('write-')?{requestId:'write',operation:'advance'}:{requestId:'status',operation:'status'});
      }
      else if(message.requestId==='write')send({requestId:'status',operation:'status'});
      else if(message.requestId==='status')send({type:'host_close',sessionId});
    }
    const [code]=await closed;assert.equal(code,0,stderr);assert.equal(calls,
      ['write-success','write-partial'].includes(mode)?4:['generate','cancel'].includes(mode)?1:
        mode.startsWith('confirm-')||mode.startsWith('review-result')||mode.startsWith('write-')?3:2);
    const status=messages.find(message=>message.requestId==='status').result;
    assert.equal(status.stage,{generate:'draft_generated',cancel:'cancelled',verify:'review_required',
      unverified:'verification_blocked','verify-drift':'failed',confirm:'confirmation_required',
      'confirm-approve':'review_required','confirm-reject':'confirmation_rejected','confirm-drift':'failed',
      'review-package':'review_required','review-package-drift':'review_required','review-package-encoding':'review_required',
      'review-result-approved':'reviewed_draft','review-result-changes':'review_changes_requested',
      'review-result-self':'failed','review-result-digest':'failed',
'write-success':'rules_written','write-partial':'write_incomplete','write-denied':'reviewed_draft','write-drift':'reviewed_draft','write-evidence-conflict':'reviewed_draft','write-evidence-permissions':'reviewed_draft'}[mode]);
    if(mode==='write-evidence-conflict'){
      assert.ok(messages.find(message=>message.requestId==='write').error);
      assert.equal(status.writeResult,null);assert.equal(status.reviewEvidence,null);
      assert.equal(fs.readFileSync(path.join(project,'.reviews',`cm-init-${status.review.packageDigest}.md`),'utf8'),'User evidence');
    }
    if(mode==='write-success'){
      assert.equal(fs.statSync(status.reviewEvidence.path).mode&0o777,0o600);
      assert.ok(status.writeResult.files.every(file=>file.status==='written'));
      assert.equal(messages.find(message=>message.requestId==='write').result.completionAuthorized,false);
    }
    if(mode==='write-partial'){
      assert.equal(status.writeResult.files.filter(file=>file.status==='written').length,1);
      assert.ok(status.writeResult.files.some(file=>file.status==='unchanged'));
    }
    if(['write-success','write-partial'].includes(mode)){
      assert.equal(status.reviewEvidence.kind,'cm-init-review-archive');
      assert.equal(status.reviewEvidence.completionAuthorized,false);
      assert.ok(fs.existsSync(path.join(project,'.reviews',`cm-init-${status.review.packageDigest}.md`)));
      const recover=()=>spawnSync(process.execPath,[path.join(repository,'scripts/cm-init-entry.mjs'),
        '--inspect-recovery',status.review.packageDigest,'--skill-dir',path.join(repository,'skills/cm-init'),
        '--project',project],{encoding:'utf8'});
      const recovered=recover();assert.equal(recovered.status,0,recovered.stderr);
      const inspection=JSON.parse(recovered.stdout).recoveryInspection;
      assert.equal(inspection.status,mode==='write-success'?'matches_reviewed_draft':'incomplete');
      assert.equal(inspection.writeAuthorized,false);assert.equal(inspection.completionAuthorized,false);
      fs.writeFileSync(path.join(project,'AGENTS.md'),'Concurrent recovery change');
      const conflict=recover();assert.equal(conflict.status,0,conflict.stderr);
      assert.equal(JSON.parse(conflict.stdout).recoveryInspection.status,'conflict');
      fs.writeFileSync(path.join(project,'AGENTS.md'),'# Fixture\nPreserve original rule\n');
    }
    if(['write-denied','write-drift'].includes(mode))assert.equal(status.writeResult,null);
    if(mode==='write-evidence-permissions'){
      assert.ok(messages.find(message=>message.requestId==='write').error);
      assert.equal(status.writeResult,null);assert.equal(status.reviewEvidence,null);
      assert.equal(fs.statSync(path.join(project,'.reviews',`cm-init-${status.review.packageDigest}.md`)).mode&0o777,0o644);
    }
    if(['review-result-approved','review-result-changes'].includes(mode)){
      assert.equal(status.review.source,'current_host_review_attestation');assert.equal(status.writeAuthorized,false);
      assert.equal(messages.find(message=>message.requestId==='review').result.completionAuthorized,false);
    }
    if(['review-result-self','review-result-digest'].includes(mode))assert.equal(status.review,null);
    if(mode==='review-package'){
      const first=messages.find(message=>message.requestId==='package').result;
      assert.deepEqual(first,messages.find(message=>message.requestId==='package-again').result);
      assert.equal(first.package.kind,'cm-init-draft-review-package');
      const {packageDigest,...body}=first.package;assert.equal(packageDigest,digest(body));
      assert.equal(first.package.originals.find(file=>file.path==='AGENTS.md').content,'Preserve original rule');
      assert.deepEqual(first.package.examinedPaths,first.package.documents.map(file=>file.path).sort());
      assert.equal(first.package.verification.source,'current_host_report');assert.equal(first.writeAuthorized,false);
    }
    if(['review-package-drift','review-package-encoding'].includes(mode))assert.ok(messages.find(message=>message.requestId==='package').error);
    if(['confirm-approve','confirm-reject'].includes(mode)){
      assert.equal(status.confirmation.draftDigest,status.verification.draftDigest);
      assert.deepEqual(status.confirmation.paths,['AGENTS.md']);assert.equal(status.writeAuthorized,false);
    }
    if(mode==='confirm-drift')assert.equal(status.confirmation,null);
    if(['verify','unverified','confirm'].includes(mode)){
      assert.equal(status.verification.source,'current_host_report');assert.equal(status.writeAuthorized,false);
    }
    if(mode==='verify-drift')assert.equal(status.verification,null);
    if(mode==='generate')assert.equal(status.result.inspection.status,'structurally_checked');
    if(mode==='review-package-encoding')assert.deepEqual(fs.readFileSync(path.join(project,'AGENTS.md')),Buffer.from([0xff,0x42]));
    else assert.equal(fs.readFileSync(path.join(project,'AGENTS.md'),'utf8'),mode.endsWith('-drift')?'Concurrent user change':
      ['write-success','write-partial'].includes(mode)?'# Fixture\nPreserve original rule\n':'Preserve original rule');
    assert.equal(fs.existsSync(path.join(project,'.claude')),mode==='write-success');
    if(mode==='write-partial'){
      await resumeFixture(project,status.review.packageDigest,false);
      await resumeFixture(project,status.review.packageDigest,true);
      await resumeFixture(project,status.review.packageDigest,true,true);
      // Reconstruct the archive-published, zero-targets-written crash prefix.
      fs.rmSync(path.join(project,'.claude'),{recursive:true});
      fs.writeFileSync(path.join(project,'AGENTS.md'),'Preserve original rule');
      const archive=path.join(project,'.reviews',`cm-init-${status.review.packageDigest}.md`);
      const originalArchive=fs.readFileSync(archive);
      await resumeFixture(project,status.review.packageDigest,true,false,true);
      assert.deepEqual(fs.readFileSync(archive),originalArchive);
    }
  }finally{child.kill();lines.close();await closed;fs.rmSync(project,{recursive:true,force:true});}
});

async function resumeFixture(project,packageDigest,allowWrite,alreadyWritten=false,zeroWritten=false){
  const child=spawn(process.execPath,[path.join(repository,'scripts/cm-init-host.mjs'),'serve',
    '--skill-dir',path.join(repository,'skills/cm-init'),'--project',project,'--host-context','resumed-author',
    ...(allowWrite?['--allow-write']:[]),'--resume-draft',packageDigest],{stdio:['pipe','pipe','pipe']});
  const closed=once(child,'close'),lines=createInterface({input:child.stdout});
  const send=value=>child.stdin.write(JSON.stringify(value)+'\n');
  const calls=[];let sessionId,final,stderr='';child.stderr.on('data',chunk=>{stderr+=chunk;});
  try{
    for await(const line of lines){
      const message=JSON.parse(line);
      if(message.type==='host_ready'){
        sessionId=message.sessionId;send({requestId:'begin',operation:alreadyWritten?'status':'advance'});
      }else if(message.type==='host_request'){
        calls.push(message.kind);let result;
        if(message.kind==='init_verify')result={checks:Object.fromEntries(message.payload.categories.map(name=>
          [name,{status:'verified',evidence:zeroWritten?'Synthetic host assertion, not live evidence':'Synthetic fresh recovery verification'}])),constraintChanges:[]};
        else if(message.kind==='init_review'){
          const pkg=message.payload.package;
          assert.equal(pkg.originals.find(file=>file.path==='AGENTS.md').content,zeroWritten?'Preserve original rule':'# Fixture\nPreserve original rule\n');
          assert.equal(pkg.recoveryOrigin.packageDigest,packageDigest);assert.notEqual(pkg.packageDigest,packageDigest);
          result={reviewer:'codex-subagent',contextId:'resumed-reviewer',independent:true,at:new Date().toISOString(),
            result:{verdict:'approved',packageDigest:pkg.packageDigest,examinedPaths:pkg.examinedPaths,
              findings:[],summary:'Synthetic fresh recovery review'}};
        }else if(message.kind==='init_write'){
          assert.equal(message.payload.documents.some(file=>file.path==='AGENTS.md'),zeroWritten);
          for(const document of message.payload.documents){
            const target=path.join(project,document.path);fs.mkdirSync(path.dirname(target),{recursive:true});
            fs.writeFileSync(target,document.content);
          }
          result={status:'written'};
        }else assert.fail(`Unexpected recovery call ${message.kind}`);
        send({type:'host_result',sessionId,callId:message.callId,requestDigest:message.requestDigest,result});
      }else if(message.requestId==='final'&&message.result){final=message.result;send({type:'host_close',sessionId});}
      else if(message.result?.stage==='review_required'||message.result?.stage==='reviewed_draft'){
        if(message.requestId==='final'){final=message.result;send({type:'host_close',sessionId});}
        else send({requestId:'next',operation:'advance'});
      }else if(message.error||message.result?.stage==='rules_written')send({requestId:'final',operation:'status'});
      else if(message.result?.stage==='rules_present'){final=message.result;send({type:'host_close',sessionId});}
    }
    const [code]=await closed;assert.equal(code,0,stderr);
    assert.deepEqual(calls,alreadyWritten?[]:['init_verify','init_review',...(allowWrite?['init_write']:[])]);
    assert.equal(final.stage,alreadyWritten?'rules_present':allowWrite?'rules_written':'reviewed_draft');
    assert.equal(fs.readFileSync(path.join(project,'AGENTS.md'),'utf8'),'# Fixture\nPreserve original rule\n');
  }finally{child.kill();lines.close();await closed;}
}
