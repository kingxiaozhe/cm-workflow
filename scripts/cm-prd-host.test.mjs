import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
for(const mode of ['codex','claude','cancel','cases','materials','draft','self-check'])test(`PRD actual CLI and original log adapter: ${mode}`,{timeout:15000},async()=>{
  const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-prd-host-')));
  for(const name of ['docs','mirror'])fs.mkdirSync(path.join(dir,name));
  fs.writeFileSync(path.join(dir,'docs/input.md'),'Synthetic requirement');
  if(mode==='materials')fs.writeFileSync(path.join(dir,'docs/extra.pdf'),'%PDF synthetic');
  if(mode==='cases'){
    fs.writeFileSync(path.join(dir,'cases.md'),'User cancellation check');
    fs.writeFileSync(path.join(dir,'.cm-workflow.json'),JSON.stringify({version:1,policies:{generate_cases:false}}));
  }
  const child=spawn(process.execPath,[path.join(root,'scripts/cm-prd-host.mjs'),'serve',
    '--skill-dir',path.join(root,'skills/cm-prd'),'--project',dir,'--specs',dir,
    '--runtime',mode==='claude'?'claude':'codex','--allow-log-write',
    ...(mode==='cases'?['--cases',path.join(dir,'cases.md')]:[]),
    ...(mode==='self-check'?['--allow-review-write','--allow-disposition-write','--allow-spec-write','--host-context','author-context']:[])],
  {env:{...process.env,CM_WORKFLOW_LOG_HOME:path.join(dir,'mirror')},stdio:['pipe','pipe','pipe']});
  const closed=once(child,'close'),lines=createInterface({input:child.stdout});
  let sessionId,calls=0,status,stderr='',checks=0,reviewedDraft,summaries=0,firstSummary,currentSummary;child.stderr.on('data',chunk=>{stderr+=chunk;});
  const send=value=>child.stdin.write(JSON.stringify(value)+'\n');
  try{
    for await(const line of lines){
      const message=JSON.parse(line);
      if(message.requestId!=='publish-old-summary')assert.equal(message.error,undefined,JSON.stringify(message));
      if(message.type==='host_ready'){sessionId=message.sessionId;send({requestId:'turn',operation:'start',text:'Analyze'});}
      else if(message.type==='host_request'){
        if(message.kind==='prd_summary'){
          summaries++;
          send({type:'host_result',sessionId,callId:message.callId,requestDigest:message.requestDigest,
            result:{evidenceDigest:message.payload.evidenceDigest,deliveryForm:`Documentation revision ${summaries}`,estimatedTime:'Human review required',
              openQuestions:'None in synthetic fixture',risks:'Synthetic responses, not live verification',contextScope:'Targeted',
              platformReadiness:'Not applicable',uiBaseline:'None',designRisk:[{feature:'1.guide',
                signals:{greenfieldAdr:false,architectureOrDataFlow:false,newRuntimeDependencyOrToolchain:false,
                  publicContractDataOrSecurity:false,fiveOrMoreFunctions:false},evidence:['Synthetic documentation-only fixture']}]}});continue;
        }
        if(message.kind==='prd_correct'){
          send({type:'host_result',sessionId,callId:message.callId,requestDigest:message.requestDigest,
            result:{documents:message.payload.documents.map(item=>({path:item.path,
              content:item.path==='1.guide/design.md'?'## 方案摘要\nCorrected synthetic design':item.content})),
            decisions:[{id:'R1',status:'applied',evidence:['Synthetic clarification'],changedPaths:['1.guide/design.md']}]}});continue;
        }
        if(message.kind==='prd_review'){
          assert.equal(mode,'self-check');assert.equal(message.payload.authorContextId,'author-context');
          send({type:'host_result',sessionId,callId:message.callId,requestDigest:message.requestDigest,
            result:{reviewer:'codex-subagent',contextId:'reviewer-context',independent:true,at:'2026-09-08T00:00:00.000Z',
              result:{verdict:'changes_requested',packageDigest:message.payload.package.packageDigest,
                examinedPaths:message.payload.examinedPaths,findings:[{id:'R1',severity:'P2',path:'1.guide/design.md',
                  message:'Clarify design',evidence:'Synthetic finding'}],summary:'Synthetic review result'}}});continue;
        }
        if(message.kind==='prd_self_check'){
          checks++;const draft=message.payload.draft;
          send({type:'host_result',sessionId,callId:message.callId,requestDigest:message.requestDigest,
            result:{draftDigest:draft.draftDigest,features:draft.features.map(feature=>({directory:feature.directory,
              checks:draft.mechanicalSelfCheck.pending.map((id,index)=>({id,status:checks===1&&index===0?'failed':'passed',evidence:['Synthetic context check']}))}))}});continue;
        }
        if(message.kind==='prd_generate'){
          assert.ok(['draft','self-check'].includes(mode));assert.equal(message.payload.role.role,'planner');
          send({type:'host_result',sessionId,callId:message.callId,requestDigest:message.requestDigest,
            result:{status:'draft',summary:'Synthetic documentation draft',features:[{name:'guide',testCasesReason:'no_observable_behavior',
              documents:['requirements.md','design.md','tasks.md'].map(file=>({path:file,
                content:file==='requirements.md'?'## 功能需求\n1. [F-001] Guide\n- [ ] [AC-001] Document setup.':file==='tasks.md'?'- [ ] T-001: Update guide':'## 方案摘要\nUnreviewed synthetic design'}))}]}});continue;
        }
        if(message.kind==='prd_materials'){
          assert.equal(mode,'materials');const source=message.payload.sources[0];
          send({type:'host_result',sessionId,callId:message.callId,requestDigest:message.requestDigest,
            result:{status:'processed',records:[{path:source.path,sha256:source.sha256,format:'pdf',pageCount:1,
              pages:[{page:1,text:'Synthetic extracted text',evidence:'synthetic tool result'}]}]}});continue;
        }
        calls++;assert.equal(message.kind,'prd_analyze');
        if(mode==='materials')assert.equal(message.payload.materialEvidence.records[0].pages[0].text,'Synthetic extracted text');
        if(mode==='cases'){
          assert.equal(message.payload.generateCases,false);
          assert.equal(message.payload.sources.userCases.content,'User cancellation check');
        }
        assert.ok(fs.existsSync(path.join(dir,'运行日志.jsonl')));
        if(mode==='cancel'){send({requestId:'cancel',operation:'cancel'});continue;}
        send({type:'host_result',sessionId,callId:message.callId,requestDigest:message.requestDigest,
          result:calls===1?{status:'question',question:'Who uses it?'}:
            {status:'analyzed',summary:'Developer need',sourcePaths:['docs/input.md',
              ...(mode==='cases'?[path.join(dir,'cases.md')]:[]),...(mode==='materials'?['docs/extra.pdf']:[])],openQuestions:[]}});
      }else if(message.requestId==='turn'){
        assert.ok(message.result||mode==='cancel');
        if(mode!=='cancel'&&calls===1)send({requestId:'turn',operation:'advance',text:'Developers'});
        else if(['draft','self-check'].includes(mode))send({requestId:'plan',operation:'advance',text:'Generate specification draft'});
        else send({requestId:'status',operation:'status'});
      }else if(message.requestId==='plan'){
        assert.equal(message.result.stage,'draft_ready');send(mode==='self-check'?{requestId:'verify',operation:'advance',text:'Self-check'}:{requestId:'status',operation:'status'});
      }else if(message.requestId==='verify'){
        if(checks===1){assert.equal(message.result.stage,'self_check_failed');send({requestId:'plan',operation:'advance',text:'Fix reported findings'});}
        else{assert.equal(message.result.stage,'self_check_reported_passed');send({requestId:'save',operation:'save_draft'});}
      }else if(message.requestId==='save'){
        assert.equal(message.result.status,'draft_saved');assert.equal(message.result.artifacts.length,3);
        assert.equal(fs.existsSync(path.join(dir,'.cm-specs-status')),false);
        send({requestId:'package',operation:'final_review_package',stage:'split',feature:'1.guide'});
      }else if(message.requestId==='package'){
        assert.equal(message.result.gate.outcome,'dispatch_once');assert.equal(message.result.dispatchAuthorized,false);
        assert.ok(message.result.reviewPackage.content.designSummary);send({requestId:'review',operation:'final_review',stage:'split',feature:'1.guide',mode:'independent'});
      }else if(message.requestId==='review'){
        assert.equal(message.result.reviewState.status,'review_recorded');
        reviewedDraft=message.result.draft;
        assert.ok(fs.existsSync(path.join(dir,'.reviews/prd-guide-split-r1.md')));
        send({requestId:'findings',operation:'review_findings',stage:'split',feature:'1.guide'});
      }else if(message.requestId==='findings'){
        assert.equal(message.result.status,'review_findings_ready');
        assert.equal(message.result.findings[0].id,'R1');
        assert.equal(message.result.next,'resolve_original_findings');
        assert.equal(message.result.completionAuthorized,false);
        // Product owns both original save and the subsequent correction write.
        for(const document of reviewedDraft.features[0].documents)assert.equal(fs.readFileSync(path.join(dir,'1.guide',document.path),'utf8'),document.content);
        send({requestId:'correct',operation:'correct_findings',stage:'split',feature:'1.guide'});
      }else if(message.requestId==='correct'){
        assert.equal(message.result.status,'correction_saved');
        assert.match(fs.readFileSync(path.join(dir,'1.guide/design.md'),'utf8'),/Corrected synthetic design/);
        send({requestId:'inspect-correction',operation:'inspect_correction',stage:'split',feature:'1.guide'});
      }else if(message.requestId==='inspect-correction'){
        assert.equal(message.result.states.every(item=>item.status==='matches_correction'),true);
        send({requestId:'resume-correction',operation:'resume_correction',stage:'split',feature:'1.guide'});
      }else if(message.requestId==='resume-correction'){
        assert.equal(message.result.status,'correction_saved');
        send({requestId:'disposition',operation:'review_disposition',stage:'split',feature:'1.guide',
          packageDigest:message.result.packageDigest,decisions:message.result.decisions,artifacts:message.result.artifacts});
      }else if(message.requestId==='disposition'){
        assert.equal(message.result.status,'disposition_recorded');
        assert.equal(message.result.gate.disposition,'applied');assert.equal(checks,3);
        assert.equal(message.result.completionAuthorized,false);
        send({requestId:'summary',operation:'prepare_summary'});
      }else if(message.requestId==='summary'){
        assert.equal(message.result.status,'human_summary_prepared');assert.equal(message.result.readyForAwaitingReview,true);
        assert.equal(message.result.totals.tasks,1);assert.equal(message.result.checklist.every(item=>!item.checked),true);
        firstSummary=message.result;send({requestId:'summary-again',operation:'prepare_summary'});
      }else if(message.requestId==='summary-again'){
        currentSummary=message.result;
        assert.equal(currentSummary.evidenceDigest,firstSummary.evidenceDigest);
        assert.notEqual(currentSummary.summaryDigest,firstSummary.summaryDigest);
        send({requestId:'publish-old-summary',operation:'publish_summary',summaryDigest:firstSummary.summaryDigest});
      }else if(message.requestId==='publish-old-summary'){
        assert.equal(message.error.code,'host_request_failed');
        assert.equal(fs.existsSync(path.join(dir,'.cm-specs-status')),false);
        send({requestId:'publish-summary',operation:'publish_summary',summaryDigest:currentSummary.summaryDigest});
      }else if(message.requestId==='publish-summary'){
        assert.equal(message.result.status,'awaiting_review');assert.equal(message.result.completionAuthorized,false);
        assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'.cm-specs-status'))).status,'awaiting_review');
        send({requestId:'status',operation:'status'});
      }else if(message.requestId==='status'){status=message.result;send({type:'host_close',sessionId});}
    }
    assert.equal((await closed)[0],0,stderr);
    assert.equal(status.stage,mode==='cancel'?'cancelled':mode==='draft'?'draft_ready':mode==='self-check'?'self_check_reported_passed':'analysis_ready');
    if(mode==='draft'){
      assert.equal(status.draft.features[0].directory,'1.guide');
      assert.equal(fs.existsSync(path.join(dir,'1.guide')),false);
    }
    const events=fs.readFileSync(path.join(dir,'运行日志.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(events.filter(event=>event.event==='run_start').length,1);
    const done=events.filter(event=>event.event==='run_done');assert.equal(done.length,1);
    assert.equal(done[0].outcome,mode==='cancel'?'cancelled':'incomplete');
    assert.equal(events.filter(event=>event.event==='decision').length,calls+(mode==='draft'?1:mode==='self-check'?2:0));
    assert.equal(fs.readFileSync(path.join(dir,'docs/input.md'),'utf8'),'Synthetic requirement');
    assert.equal(fs.existsSync(path.join(dir,'.cm-specs-status')),mode==='self-check');
    assert.equal(status.completionAuthorized,false);
  }finally{child.kill();lines.close();await closed;fs.rmSync(dir,{recursive:true,force:true});}
});
