import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {skillContext,requestTools} from '../runtime/js/cm-ai/tool-preview.mjs';
import {commonArgs,configFingerprint,NO_USER_INPUT_TOOL} from '../runtime/js/cm-ai/codex-config.mjs';
const retainedPreamble = "Each entry includes a name, description, and location for its `SKILL.md`. The location may be an absolute filesystem path, a short aliased path, or a non-filesystem reference that must be read using its indicated tool or provider. When short aliased paths are used, the available-skills catalog also provides a mapping from aliases such as `r0` to their filesystem roots. Expand the alias before accessing the skill.\n\nThe user's instructions take precedence over guidelines provided in a skill. If explicit user instructions conflict with a skill's instructions, prioritize the user's instructions.\n\nThe first time in a conversation that you decide to apply a skill, inform the user in the commentary channel.\n\nIf a skill causes you to ask for permission or confirmation, pause, or leave requested work unfinished, name the skill and summarize the specific instruction in the skill that led to your decision. Include this explanation in the request or final response where you pause.";
const input = text => ({input:[{content:[{text}]}]});
test('Codex 0.159.2 retained empty skill preamble is not a catalog',()=>{
 assert.equal(skillContext(input('<skills_instructions>\n### Available skills\n'+retainedPreamble+'\n</skills_instructions>')).present,false);
});
test('real, unresolved and unknown catalogs remain blocked',()=>{
 for(const content of ['- sample (file: /tmp/sample/SKILL.md)','- sample (file: r99/sample/SKILL.md)','Unrecognized catalog content'])
  assert.equal(skillContext(input('<skills_instructions>\n### Available skills\n'+retainedPreamble+'\n'+content+'\n</skills_instructions>')).present,true);
});
// codex-cli 0.167.0 / gpt-6.2-sol 实跑请求形状：两个默认工具必须被零工具判定看见。
test('a request carrying the Codex 0.167 default tools is not zero tools',()=>{
 const body={model:'gpt-6.2-sol',input:[],tools:[{type:'function',name:'request_user_input'},{type:'function',name:'view_image'}]};
 assert.deepEqual(requestTools(body).map(tool=>tool.name),['request_user_input','view_image']);
 assert.deepEqual(requestTools({...body,tools:[]}),[]);
 assert.equal(requestTools({...body,tools:{}}),null);
});
test('the fingerprint binds each review-only tool removal, so older preflight receipts no longer match',()=>{
 const options={cwd:'/fixture',model:'gpt-6.2-sol',effort:'high'},args=commonArgs(options);
 const hash=list=>createHash('sha256').update(JSON.stringify(list)).digest('hex');
 const without=(flag,value)=>args.filter((arg,i)=>!(arg===flag&&args[i+1]===value||arg===value&&args[i-1]===flag));
 assert.equal(configFingerprint(options),hash(args));
 for(const [flag,value] of [['--disable','view_image'],['-c',NO_USER_INPUT_TOOL]]){
  const older=without(flag,value);assert.equal(older.length,args.length-2);
  assert.notEqual(configFingerprint(options),hash(older));
 }
});
