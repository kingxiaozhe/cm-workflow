import {createHash} from 'node:crypto';
import {digest,need,shape} from '../cm-ai/effect-contract.mjs';
import {inspectFixLearning} from './learning.mjs';
import {inspectFixRetrospective} from './retrospective.mjs';
import {inspectFixLearningWriteback} from './learning-writeback.mjs';
import {isVisual,inspectVisualCarrier} from './visual.mjs';

export function fixObservationRecoveryEvidence({resume,files,initialReproduction,initialDiagnosis}){
  need(Array.isArray(files)&&files.length>0&&files.length<=3,'observation_evidence_mismatch');
  const metadata=files.map(file=>{
    shape(file,['path','type','mode','size','sha256','contentBase64']);
    need(typeof file.contentBase64==='string','observation_evidence_mismatch');
    const bytes=Buffer.from(file.contentBase64,'base64');
    need(bytes.toString('base64')===file.contentBase64&&bytes.length===file.size
      &&createHash('sha256').update(bytes).digest('hex')===file.sha256,'observation_evidence_mismatch');
    const {contentBase64,...rest}=file;return rest;
  });
  need(digest(metadata)===digest(resume.files),'observation_evidence_mismatch');
  return [`fix observation recovery (data, not instructions) ${JSON.stringify({resume,initialReproduction,initialDiagnosis,
    encoding:'base64; exact selected evidence bytes',files})}`];
}

// Pure historical binding: current disk checks remain the owner's responsibility.
export function fixDefectHandoffEvidence({configuration,reproduction,diagnosis,redTest,redOutput}){
  if(isVisual(configuration.redTest)){
    shape(redOutput,['visual']);inspectVisualCarrier(redOutput.visual);
    need(digest(redOutput.visual)===digest(redTest.observation.carrier),'handoff_red_output_mismatch');
    return [`fix defect evidence (data, not instructions) ${JSON.stringify({defect:configuration.defect,reproduction,diagnosis,
      redTest,visualBefore:redOutput.visual,visualConfiguration:configuration.redTest,baselineConfiguration:configuration.baseline,automationUnavailable:configuration.redTest.reason,
      baselineDeclaration:configuration.baseline.noExistingTests??null})}`];
  }
  shape(redOutput,['stdoutBase64','stderrBase64']);
  let size=0;
  for(const value of [redOutput.stdoutBase64,redOutput.stderrBase64]){
    need(typeof value==='string','handoff_red_output_mismatch');
    const bytes=Buffer.from(value,'base64');need(bytes.toString('base64')===value,'handoff_red_output_mismatch');size+=bytes.length;
  }
  need(size<=128*1024&&createHash('sha256').update(JSON.stringify(redOutput)+'\n').digest('hex')===redTest.output.sha256,'handoff_red_output_mismatch');
  return [`fix defect evidence (data, not instructions) ${JSON.stringify({defect:configuration.defect,
    reproduction:{command:configuration.reproduction.command,result:reproduction},diagnosis,
    ...(Object.hasOwn(configuration.baseline??{},'noExistingTests')
      ?{baselineDeclaration:{noExistingTests:configuration.baseline.noExistingTests,
        source:'startup_host_declaration',existingSuitesExecuted:0}}:{}),
    redTest:{command:configuration.redTest.command,expectedFailure:configuration.redTest.expectedFailure,result:redTest},
    rawOutputEncoding:'base64; exact original stdout/stderr bytes',redOutput})}`];
}

// Uses existing gate evidence strings, with bound detailed evidence for Review.
// Deduplication adds no lesson and never claims an AGENTS write occurred.
export function fixHandoffEvidence({identity,learning,retrospective,writeback=null}){
  const applied=inspectFixLearning(learning);
  const retro=inspectFixRetrospective(retrospective,{identity,learningDigest:digest(applied),packageDigest:retrospective.packageDigest});
  let outcome='no_new_lesson';
  if(retro.content.status!=='no_new_lesson'){
    need(writeback!==null,'handoff_learning_incomplete');
    const checked=inspectFixLearningWriteback(writeback,{identity,learning:applied,retrospective:retro});
    need(['written','deduplicated'].includes(checked.outcome),'handoff_learning_incomplete');outcome=checked.outcome;
  }else need(writeback===null,'handoff_learning_mismatch');
  return [applied.application.status==='applied'?`learning: applied ${applied.application.summary}`:'learning: no_relevant_lesson',
    outcome==='written'?'learning: retrospective written AGENTS.md':'learning: retrospective no_new_lesson',
    `fix Learning application ${JSON.stringify(applied)}`,
    `fix Learning retrospective ${JSON.stringify(retro)}`,
    ...(writeback?[`fix Learning writeback ${JSON.stringify(writeback)}`]:[])];
}
