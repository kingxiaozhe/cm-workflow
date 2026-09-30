import test from 'node:test';
import assert from 'node:assert/strict';
import {skillContext} from '../runtime/js/cm-ai/tool-preview.mjs';
const retainedPreamble = "Each entry includes a name, description, and location for its `SKILL.md`. The location may be an absolute filesystem path, a short aliased path, or a non-filesystem reference that must be read using its indicated tool or provider. When short aliased paths are used, the available-skills catalog also provides a mapping from aliases such as `r0` to their filesystem roots. Expand the alias before accessing the skill.\n\nThe user's instructions take precedence over guidelines provided in a skill. If explicit user instructions conflict with a skill's instructions, prioritize the user's instructions.\n\nThe first time in a conversation that you decide to apply a skill, inform the user in the commentary channel.\n\nIf a skill causes you to ask for permission or confirmation, pause, or leave requested work unfinished, name the skill and summarize the specific instruction in the skill that led to your decision. Include this explanation in the request or final response where you pause.";
const input = text => ({input:[{content:[{text}]}]});
test('Codex 0.159.2 retained empty skill preamble is not a catalog',()=>{
 assert.equal(skillContext(input('<skills_instructions>\n### Available skills\n'+retainedPreamble+'\n</skills_instructions>')).present,false);
});
test('real, unresolved and unknown catalogs remain blocked',()=>{
 for(const content of ['- sample (file: /tmp/sample/SKILL.md)','- sample (file: r99/sample/SKILL.md)','Unrecognized catalog content'])
  assert.equal(skillContext(input('<skills_instructions>\n### Available skills\n'+retainedPreamble+'\n'+content+'\n</skills_instructions>')).present,true);
});
