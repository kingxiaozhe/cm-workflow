// Durable cm-init / cm-test sessions bind the policy documents they ran under.
// The external answer gap fixes (batch 3) added recovery sections to two of
// them, which would refuse every session created before (idea_session_binding_
// changed / cm_test_session_binding_changed) — not even status could run.
// This is a controlled migration, not a relaxed check: an older binding is
// accepted only when it is one of the known legacy digests below, every other
// bound file is byte-identical to that legacy version, and the changed document
// is one of the known successors. Any other drift still refuses. When a bound
// document changes again, add its new digest to the successors (a test checks
// that the current documents are listed).
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
export const sha256=text=>createHash('sha256').update(text).digest('hex');
// origin/main 0b3040e (before batch 3).
export const LEGACY_INIT_POLICIES=Object.freeze([Object.freeze({since:'0b3040e',
  policyDigest:'d467afb7082e608c0be4b2affca9a1005edc13a39d61202abede6dfead8e0d6f',
  changed:'skills/cm-init/references/js-host.md',
  files:Object.freeze({
    'skills/cm-init/SKILL.md':'4b69e2a2fa14676e3aa105729ba3dccc9f54053b2876cad0af1bf66e344bd7ec',
    'skills/cm-init/references/js-host.md':'da04c4bc6d9c5a40b99a8dd6c2c44e9c719663b4032bbf2b0ef0ae4c53948e8a',
    'templates/rules/backend-api.md':'4c2b8d85358c81081ab3d039b23a5fb9cb8640f069b222253d612bb48bafdc7e',
    'templates/rules/coding-style.md':'74b789f8aa44f2ec9643ea85d05705c702ceb278f7cc10731ca5fe78320af796',
    'templates/rules/database.md':'b7c69d7b29870db0f725c0bf80c1d1b989f0c315a5d8f0fb9d311008922b6926',
    'templates/rules/finance.md':'faeac9aedc4aec79161940ae422f56c65872e63c5909642a3fe27714e5646e9c',
    'templates/rules/frontend.md':'9247f607f050ed18cfdc2ac28ee5d0b8b2f4b54b757d860fed3be5dae0a9a976',
    'templates/rules/git-workflow.md':'28142563f8146ffe155da0b845035bcfccf828bc6312c26c9166d655e76b31cd',
    'templates/rules/miniprogram.md':'43193532bfa1237f2f4c085eb854b332e6589ea6e3176b8bc0adbeb56f96fc3f',
    'templates/rules/security.md':'afa53ae25dc434a690006cb7eabeb33d2656ce7371d1f7c57d70ca6b385b7fbc',
    'templates/rules/smart-contract.md':'eabe294e3194ddbe2eff5470736db4985c3e88c1cbbc1f21a8262dd4fa15d2b7',
    'templates/rules/testing.md':'e992de31f24b99d0b2bc9fd105c61ea9b0d6bc298190a3cf830a8f6a506c8455'})})]);
export const LEGACY_TEST_POLICIES=Object.freeze([Object.freeze({since:'0b3040e',
  policy:'0a80dde424c5aea90fc05ea2bb919a8bdb1ae4a2788d252e2b97a7de135f8bf4',changed:'skills/cm-test/references/js-host.md'})]);
// Known versions of the changed documents that may continue a legacy binding.
export const POLICY_DOC_SUCCESSORS=Object.freeze({
  'skills/cm-init/references/js-host.md':Object.freeze(['d3d6ad0b02ee7d3863302c49a9434b1a9f423e8ab4ff332cd9ad077a0b270fb1']),
  'skills/cm-test/references/js-host.md':Object.freeze(['0a6023c9036693a93a17650872b634b33d68eecc2fbece188519e94e31452e8c']),
});
// cm-init: files is the current [[relativePath, content|null], ...] policy list.
export function legacyInitBindings({project,workflowRoot,files}){
  const current=Object.fromEntries(files.map(([file,content])=>[file,content===null?null:sha256(content)]));
  return LEGACY_INIT_POLICIES.filter(legacy=>{
    const names=Object.keys(legacy.files).sort();
    return JSON.stringify(names)===JSON.stringify(Object.keys(current).sort())
      &&names.every(file=>file===legacy.changed?POLICY_DOC_SUCCESSORS[file].includes(current[file]):current[file]===legacy.files[file]);
  }).map(legacy=>({project,workflowRoot,policyDigest:legacy.policyDigest}));
}
// cm-test: binding is the current binding; skillDir holds references/js-host.md.
export function legacyTestBindings(binding,skillDir){
  const doc=sha256(fs.readFileSync(path.join(skillDir,'references/js-host.md'),'utf8'));
  return LEGACY_TEST_POLICIES.filter(legacy=>POLICY_DOC_SUCCESSORS[legacy.changed].includes(doc))
    .map(legacy=>({...binding,policy:legacy.policy}));
}
