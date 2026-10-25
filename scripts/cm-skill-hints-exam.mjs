#!/usr/bin/env node
// The auto-invoke exam (方案-技能自动调用 第 8–9 条): 50 phrasings in
// cm-skill-hints.exam.json, 30 that should start an author skill and 20 that should
// not. Scored through the real hook, with every invoke skill counted as installed.
//
//   node scripts/cm-skill-hints-exam.mjs               score with real Jev (needs a TypeSafe key)
//   node scripts/cm-skill-hints-exam.mjs --record      same, and save Jev's answers into the exam file
//   node scripts/cm-skill-hints-exam.mjs --keywords    score the keyword fallback alone, no network
//
// The repository test replays the recorded answers through a fake Jev, so every change
// is scored without calling Jev. Each answer is keyed by the hash of the exact request
// it answered (model, clipped message, question), so changing a phrasing or a rule's
// `when`/`near` text leaves it unmatched and the test fails until it is re-recorded.
// Target: hit rate >= 95% on the should-use cases, false triggers <= 5% on the others,
// both for all 50 and for the 43 that reach Jev (7 open with a command the host runs).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {hook,loadRules,defaultRulesPath,opensWithCommand,typed} from './cm-skill-hints.mjs';
import {apiKey,requestBody} from './cm-skill-judge.mjs';

export const EXAM_NAME='cm-skill-hints.exam.json';
export const examPath=()=>path.join(path.dirname(fileURLToPath(import.meta.url)),EXAM_NAME);
export const TARGET={hit:0.95,falseTrigger:0.05};

export function readExam(file=examPath()){return JSON.parse(fs.readFileSync(file,'utf8'));}
export function invokeChoices(rulesFile=defaultRulesPath()){
  const {rules}=loadRules({env:{HOME:'/nonexistent',CM_WORKFLOW_HOME:'/nonexistent/.cm'},rulesFile});
  return rules.filter(rule=>rule.invoke).map(rule=>({skill:rule.skill,when:rule.invoke.when,near:rule.invoke.near}));
}
export const bodyHash=body=>crypto.createHash('sha256').update(body).digest('hex').slice(0,16);
// The request this case sends today; a recording made for any other request does not apply.
export const expectedRequest=(item,choices=invokeChoices())=>bodyHash(requestBody(item.prompt,choices));

// Every invoke skill counts as the installed author version; roots point at /srv paths
// that are never read.
export const installedCheck=skills=>({skills:skills.map(name=>({name,files:{}})),license:'',
  skillState:()=>'author',skillRoots:()=>[{runtime:'claude',root:'/srv/skills'},{runtime:'codex',root:'/srv/agents-skills'}]});

// Which skill the hook started for this output, or null.
export function startedSkill(output){
  if(!output)return null;
  const parsed=JSON.parse(output);
  const context=parsed.hookSpecificOutput?.additionalContext;
  return context?/作者技能 ([\w.:-]+)/.exec(context)?.[1]??null:null;
}

// A should-use case passes when the hook started that skill, or when the user typed
// the command themself (the host runs it, the hook stays out). A should-not case
// passes when the hook started nothing.
export function passed(item,started,host='claude'){
  if(item.expect===null)return started===null;
  if(started===item.expect)return true;
  return started===null&&opensWithCommand(item.prompt)&&typed(item.prompt,item.expect,host);
}

function rates(results){
  const should=results.filter(item=>item.expect!==null);
  const shouldNot=results.filter(item=>item.expect===null);
  const hit=should.filter(item=>item.pass).length/should.length;
  const falseTrigger=shouldNot.filter(item=>!item.pass).length/shouldNot.length;
  return {hit,falseTrigger,should:should.length,shouldNot:shouldNot.length,
    ok:hit>=TARGET.hit&&falseTrigger<=TARGET.falseTrigger,failed:results.filter(item=>!item.pass)};
}
// All 50, and separately the ones judged at all (a command-led message never is), so
// the command cases cannot dilute either rate.
export function score(results){
  const all=rates(results);
  const judged=rates(results.filter(item=>!item.command));
  return {...all,judged,ok:all.ok&&judged.ok};
}

// Runs every case through hook(). `fetchImpl` is the Jev transport (real or fake);
// with `keywordsOnly` Jev is switched off. Each case gets its own temporary CM home.
export async function runExam({exam=readExam(),fetchImpl,key='exam-key',keywordsOnly=false,host='claude',onReply}={}){
  const skills=invokeChoices().map(choice=>choice.skill);
  const results=[];
  for(const item of exam.cases){
    const home=fs.mkdtempSync(path.join(os.tmpdir(),'cm-skill-exam-'));
    try{
      if(keywordsOnly)fs.writeFileSync(path.join(home,'skill-hints.local.json'),JSON.stringify({judge:false}));
      const env={HOME:home,CM_WORKFLOW_HOME:home,CM_WORKFLOW_LOG_HOME:path.join(home,'logs')};
      const transport=fetchImpl&&(async(url,options)=>{
        const response=await fetchImpl(url,options);
        if(!onReply)return response;
        const text=await response.text();
        if(response.ok)onReply(item,JSON.parse(text),options.body);
        return new Response(text,{status:response.status,headers:{'Content-Type':'application/json'}});
      });
      const started=Date.now();
      const output=await hook({prompt:item.prompt,session_id:item.id},{env,host,
        loadAuthor:async()=>installedCheck(skills),judgeOptions:{key,fetchImpl:transport}});
      const skill=startedSkill(output);
      results.push({id:item.id,expect:item.expect,started:skill,pass:passed(item,skill,host),command:opensWithCommand(item.prompt),ms:Date.now()-started});
    }finally{fs.rmSync(home,{recursive:true,force:true});}
  }
  return results;
}

// A fake Jev that answers from the exam's recording, keyed by the hash of the exact
// request body; an unrecorded request gets a 400, so the hook falls back to keywords.
export function replayFetch(exam){
  const byRequest=new Map(exam.cases.filter(item=>item.jev).map(item=>[item.jev.request,item.jev.probabilities]));
  return async(url,options)=>{
    const probabilities=byRequest.get(bodyHash(options.body));
    if(!probabilities)return new Response('{"error":"not recorded"}',{status:400});
    return new Response(JSON.stringify({answers:{skill:{type:'choice',probabilities}}}),{status:200});
  };
}

const percent=value=>`${(value*100).toFixed(1)}%`;
async function cli(argv){
  const record=argv.includes('--record');
  const keywordsOnly=argv.includes('--keywords');
  const exam=readExam();
  let key='exam-key';
  if(!keywordsOnly){
    key=apiKey(process.env);
    if(!key){process.stderr.write('没有 TypeSafe 密钥（TYPESAFE_API_KEY 或钥匙串），无法跑真实 Jev；可用 --keywords 只考关键词。\n');return 2;}
  }
  let tokens={input:0,output:0,calls:0};
  const replies=new Map();
  const started=Date.now();
  const results=await runExam({exam,keywordsOnly,key,fetchImpl:keywordsOnly?undefined:globalThis.fetch,onReply:(item,reply,body)=>{
    replies.set(item.id,{request:bodyHash(body),probabilities:reply?.answers?.skill?.probabilities});
    tokens={input:tokens.input+(reply?.usage?.input_tokens??0),output:tokens.output+(reply?.usage?.output_tokens??0),calls:tokens.calls+1};
  }});
  const result=score(results);
  for(const item of results)process.stdout.write(`${item.pass?'ok':'XX'} ${item.id} 期望=${item.expect??'无'} 实际=${item.started??'无'} ${item.ms}ms\n`);
  process.stdout.write(`\n全部：该用命中 ${percent(result.hit)}（${result.should} 句），不该用误触发 ${percent(result.falseTrigger)}（${result.shouldNot} 句）。\n`
    +`经判断的（去掉 ${results.filter(item=>item.command).length} 句命令开头）：该用命中 ${percent(result.judged.hit)}（${result.judged.should} 句），`
    +`不该用误触发 ${percent(result.judged.falseTrigger)}（${result.judged.shouldNot} 句）。\n${result.ok?'达标':'未达标'}。用时 ${((Date.now()-started)/1000).toFixed(1)} 秒`
    +(keywordsOnly?'，只用关键词。\n':`，Jev 调用 ${tokens.calls} 次，输入 ${tokens.input} / 输出 ${tokens.output} token。\n`));
  if(record&&!keywordsOnly){
    const missing=exam.cases.filter(item=>!opensWithCommand(item.prompt)&&!replies.get(item.id));
    if(missing.length){process.stderr.write(`有 ${missing.length} 句没拿到 Jev 回答（${missing.map(item=>item.id).join('、')}），未保存；请重跑。\n`);return 1;}
    exam.recorded={date:new Date().toISOString().slice(0,10)};
    for(const item of exam.cases){const reply=replies.get(item.id);if(reply)item.jev=reply;else delete item.jev;}
    fs.writeFileSync(examPath(),JSON.stringify(exam,null,2)+'\n');
    process.stdout.write(`已保存 Jev 回答到 ${examPath()}。\n`);
  }
  return result.ok?0:1;
}

if(process.argv[1]&&fs.realpathSync(process.argv[1])===fs.realpathSync(fileURLToPath(import.meta.url))){
  process.exitCode=await cli(process.argv.slice(2));
}
