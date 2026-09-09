// Bind a trusted host configuration to current log evidence. Reports never
// supply executable configuration, scope or authority.
import {readHostQaFixHandoff} from './host-qa-fix.mjs';
import {qaFixIdentity,inspectFixQaSource} from '../cm-fix/qa-source.mjs';
import {digest,json,need,shape,validIdentity} from './effect-contract.mjs';

export function bindQaFixDefinition({template,identity,packageDigest,testRunId}){
  const fixed=json(template,64*1024);
  shape(fixed,['specsRoot','feature','identity','configuration']);validIdentity(fixed.identity);
  validIdentity(identity);
  need(digest({...identity,attempt:fixed.identity.attempt})===digest(fixed.identity)
    &&identity.attempt>=fixed.identity.attempt&&identity.attempt<=2,'qa_fix_source_mismatch');
  need(!Object.hasOwn(fixed.configuration,'qaSource'),'invalid_fix_template');
  const handoff=readHostQaFixHandoff({specsDir:fixed.specsRoot,codeProject:fixed.configuration.reproduction.cwd,
    feature:fixed.feature,identity,packageDigest,testRunId});
  need(handoff.status!=='blocked','fix_qa_source_blocked');
  const qaSource={feature:fixed.feature,identity,packageDigest,testRunId,handoffDigest:handoff.handoffDigest};
  const definition={specsRoot:fixed.specsRoot,identity:qaFixIdentity(qaSource),configuration:{...fixed.configuration,qaSource}};
  inspectFixQaSource(definition);
  return json(definition,64*1024);
}
