import {readProjectInstructionContext} from '../cm-ai/cm-ai-context-refresh.mjs';
import {digest,json,need,shape,text} from '../cm-ai/effect-contract.mjs';

export function inspectFixLearning(raw){
  const value=json(raw,64*1024);shape(value,['contextDigest','files','application']);
  need(Array.isArray(value.files),'invalid_fix_learning');
  for(const file of value.files){
    shape(file,['scope','path','sha256']);need(file.scope==='project','invalid_fix_learning');
    text(file.path);need(/^[a-f0-9]{64}$/.test(file.sha256),'invalid_fix_learning');
  }
  need(value.contextDigest===digest(value.files),'invalid_fix_learning');
  shape(value.application,['contextDigest','status','summary']);
  need(value.application.contextDigest===value.contextDigest,'invalid_fix_learning');
  need(['applied','no_relevant_lesson'].includes(value.application.status),'invalid_fix_learning');
  text(value.application.summary);
  need(value.application.summary.length<=1000&&!/[\r\n\0]/.test(value.application.summary),'invalid_fix_learning');
  return value;
}

export function createFixLearningPreparation({bridge,codeProject,applicableAgentFiles=[]}){
  return async({identity,defect},signal)=>{
    const context=readProjectInstructionContext(codeProject,applicableAgentFiles);
    const files=context.map(({content,...metadata})=>metadata),contextDigest=digest(files);
    const application=await bridge.call('fix_learning',{identity,defect,codeProject,contextDigest,context,
      instruction:'Read these current project instructions. Return contextDigest, status applied or no_relevant_lesson, and one-line summary of source lesson and verification action. This operation is read-only; do not execute commands or edit files.'},signal);
    need(!signal.aborted,'cancelled');
    const latest=readProjectInstructionContext(codeProject,applicableAgentFiles).map(({content,...metadata})=>metadata);
    need(digest(latest)===contextDigest,'fix_learning_context_changed');
    return inspectFixLearning({contextDigest,files,application});
  };
}
