// Shared synthetic host and real project assets; no native Codex sandbox required.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {digest} from '../../runtime/js/cm-ai/effect-contract.mjs';
const root=fileURLToPath(new URL('../..',import.meta.url));
const original='export const calc = x => x < 0 ? 0 : x + 1;\n';
const replacement='export function calc(x) { if (x < 0) return 0; return x + 1; }\n';
function fixture(t){
  const temp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-refactor-host-'))),project=path.join(temp,'project');
  fs.mkdirSync(project);fs.writeFileSync(path.join(project,'input.mjs'),original);
  fs.writeFileSync(path.join(project,'baseline.mjs'),"import assert from 'node:assert/strict'; import {calc} from './input.mjs'; assert.equal(calc(-1),0); assert.equal(calc(2),3);\n");
  fs.writeFileSync(path.join(project,'judge.mjs'),"import {calc} from './input.mjs'; console.log(JSON.stringify({cases:[-2,0,2].map((x,i)=>({id:String(i),input:x,output:calc(x)}))}));\n");
  t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
  return {temp,project,config:{skillDir:path.join(root,'skills/cm-refactor'),project,specs:null,runtime:'codex',
    target:'Synthetic structure-only refactor',slug:'extract',scope:['input.mjs'],crossModule:false,
    baselineCommands:[{id:'baseline',command:[process.execPath,'baseline.mjs']}],judgeCommand:[process.execPath,'judge.mjs'],
    mutations:[{path:'input.mjs',find:'x + 1',replace:'x + 2'},{path:'input.mjs',find:'x < 0',replace:'x < -5'}],logHome:path.join(temp,'logs')}};
}
function response(kind,payload,mode='normal'){
  if(kind==='refactor_analyze')return {decision:'proceed',metric:{name:'Synthetic nesting',before:2,unit:'levels'},impact:[],claimedMemos:[],reason:'Synthetic simplification'};
  if(kind==='refactor_confirm')return {decision:mode==='reject'?'rejected':'approved'};
  if(kind==='refactor_apply')return {files:[{path:'input.mjs',beforeDigest:digest(original),content:mode==='behavior-change'?replacement.replace('x + 1','x + 9'):replacement}],
    summary:'Synthetic explicit function extraction',metricAfter:1,unfixedDefects:[],conventions:[],
    learningApplication:'No additional relevant project lesson in this fixture',learningRetrospective:'no_new_lesson'};
  assert.equal(kind,'refactor_review');
  return {markdown:`---\nat: 2026-09-08T18:00:00+00:00\nreviewer: codex-subagent\nindependent: true\ntask: ${payload.task}\nattempt: ${payload.attempt}\nround: ${payload.attempt}\nverdict: approved\nblocking_findings: 0\nhandoff: ${path.basename(payload.handoff)}\nhandoff_sha256: ${mode==='stale-review'?'0'.repeat(64):payload.handoffSha256}\nscope:\n  - input.mjs\n---\n\nZero findings in synthetic review; not a live independent reviewer invocation.\n`};
}
function fullResponse(kind,payload){
  if(kind==='refactor_review'){
    const value=response(kind,payload);value.markdown=value.markdown.replace('  - input.mjs',payload.files.map(file=>'  - '+file.path).join('\n'));return value;
  }
  if(kind==='refactor_prepare_tests')return {files:payload.assets.map(file=>({...file,content:file.path==='baseline.mjs'
    ?"import assert from 'node:assert/strict'; import {calc} from './input.mjs'; assert.equal(calc(2),3);\n"
    :"import {calc} from './input.mjs'; console.log(JSON.stringify({cases:[-2,0,2].map((x,i)=>({id:String(i),input:x,output:calc(x)}))}));\n"}))};
  if(kind==='refactor_retrospective')return {learningApplication:'Apply original behavior contract',learning:{status:'lesson_candidate',reason:null,
    candidates:[{classification:'structured',trigger:'Boundary-sensitive refactor',action:'Keep negative inputs in differential judge',evidence:['judge.mjs']}]},
    conventions:[{path:'.claude/rules/shape.md',text:'Use named function exports.',evidence:['input.mjs']}],documentation:payload.files.filter(file=>file.path==='README.md')
      .map(file=>({...file,content:(file.content??'')+'\nRefactored module structure.\n'})),resolved:(payload.needs??[]).map(item=>item.id),unfixedDefects:[],metricAfter:1};
  if(kind==='refactor_batch'){
    if(payload.action==='plan')return {rulebook:'Named functions; preserve values; do not fix bugs.',units:payload.files.filter(file=>!payload.assemblyFiles.includes(file.path))
      .map((file,i)=>({id:`unit-${i}`,files:[file.path],dependsOn:i?[`unit-${i-1}`]:[]})),sample:['input.mjs'],perFileEstimate:300,reason:'Reduce nesting'};
    if(payload.action==='bakeoff')return {channelId:payload.variant,files:payload.files.map(file=>({...file,content:replacement}))};
    if(payload.action==='adjudicate')return {channelId:'third',rulebook:payload.rulebook,decisions:[]};
    if(payload.action==='assemble')return {files:payload.files.map(file=>({...file,content:'export {calc} from "./input.mjs";\n'})),resolved:payload.needs.map(item=>item.id)};
    if(payload.action==='generate')return {files:payload.files.map(file=>({...file,content:file.path==='old.mjs'?null:
      (file.path==='input.mjs'?replacement:'export const helper = 1;\n')+'// REFACTOR STATUS: confidence=high todos=0\n'})),
      needs:payload.files[0].path==='input.mjs'?[{id:'entry-wire',path:'entry.mjs',instruction:'Preserve entry export'}]:[],summary:'Structure only'};
    if(payload.action==='diagnose')return {errorClass:'syntax',reason:'Same generator rule produces invalid syntax'};
  }
  return response(kind,payload);
}

export {fixture,response,fullResponse,original,replacement};
