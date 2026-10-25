import test from 'node:test';
import assert from 'node:assert/strict';
import {judge,hasSecret,apiKey,clip,question,nearLabel,JEV_URL,SEND_CHARS,NONE} from './cm-skill-judge.mjs';
import {readExam,runExam,replayFetch,score,invokeChoices,expectedRequest,TARGET} from './cm-skill-hints-exam.mjs';
import {opensWithCommand} from './cm-skill-hints.mjs';

// Never a real call: every test hands judge() its own fetch.
const CHOICES=[{skill:'handoff',when:'写交接'},{skill:'wayfinder',when:'拆决策票',near:'只是排个计划'}];
// Full answers: a probability for each option asked (two skills, one look-alike, none).
const HANDOFF={handoff:0.97,wayfinder:0.01,'wayfinder~near':0.01,none:0.01};
const WAYFINDER={handoff:0.01,wayfinder:0.97,'wayfinder~near':0.01,none:0.01};
const reply=(probabilities,status=200)=>new Response(JSON.stringify({answers:{skill:{type:'choice',probabilities}}}),{status});
function recorder(...steps){
  const calls=[];
  const fetchImpl=async(url,options)=>{
    calls.push({url,options,body:JSON.parse(options.body)});
    const step=steps[Math.min(calls.length-1,steps.length-1)];
    return typeof step==='function'?step(options):step;
  };
  return {calls,fetchImpl};
}
// Credential-shaped strings are built at run time so the repository scan never sees one.
const fake={
  openai:'sk-'+'a1B2'.repeat(6),
  github:'ghp_'+'Z9y8'.repeat(6),
  aws:'AKIA'+'ABCDEFGH12345678',
  slack:'xoxb-'+'1234-5678-abcdef',
  pem:'-----BEGIN RSA '+'PRIVATE KEY-----',
  jwt:'eyJ'+'hbGciOiJIUzI1'+'.'+'eyJzdWIiOiIxMjM0'+'.'+'SflKxwRJSMeKKF2QT4',
  assign:'api_key'+' = '+'q7w8e9r0t1',
  chinese:'密码'+'：'+'hunter22',
  bare:'Ab3'+'x9Kq2LmN8pQr4StU6vWx0YzA1bC3dE5f',
  // In words, and a bare hex key next to a credential word.
  words:'TypeSafe 密钥'+'是 '+'a1'.repeat(32),
  english:'my pass'+'word is hunter22',
  hex:'API key'+': '+'0f'.repeat(16),
  // No separator and plain hex: only the credential word nearby gives it away.
  near:'这是 TypeSafe 的 api key '+'0f'.repeat(16)+' 帮我配上',
  // A labelled value counts however short.
  shortWords:'密码'+'是 1234',
  shortEnglish:'my pass'+'word is abcde',
  shortAssign:'token'+'=xyz',
};

test('a message that looks like it holds a credential is never sent to Jev',async()=>{
  for(const [name,secret] of Object.entries(fake)){
    assert.ok(hasSecret(`帮我看看 ${secret} 这个配置`),name);
    const {calls,fetchImpl}=recorder(reply(HANDOFF));
    assert.deepEqual(await judge({prompt:`写个交接，配置里有 ${secret}`,choices:CHOICES,key:'k',fetchImpl}),{error:'secret'},name);
    assert.equal(calls.length,0,name);
  }
});

test('commit ids, hashes and ordinary text are not taken for credentials',()=>{
  for(const text of ['回滚到 0ddd39e5c3a1b2f4e6d8a0b1c2d3e4f5a6b7c8d9','sha256 是 e0a0932e42188fde6a8a93314616ca3ede14c6ddf029e98c10cb2c8b9fb6a425',
    '上下文快满了，写个交接吧','把 token 过期时间改成 2 小时','密码输错三次要锁定账号','the password field should be masked','token 是什么意思',
    'the password is required','密码是多少位比较安全','密码是必填项','password is not set'])
    assert.equal(hasSecret(text),false,text);
});

test('only the first 500 characters are sent, counted by character not byte',async()=>{
  const prompt='交'.repeat(SEND_CHARS)+'这部分不该发出去😀';
  const {calls,fetchImpl}=recorder(reply(HANDOFF));
  await judge({prompt,choices:CHOICES,key:'k',fetchImpl});
  assert.equal(calls[0].body.state,'交'.repeat(SEND_CHARS));
  assert.equal(Array.from(clip('😀'.repeat(SEND_CHARS+3))).length,SEND_CHARS);
  assert.equal(calls[0].url,JEV_URL);
  assert.equal(calls[0].options.headers.Authorization,'Bearer k');
});

test('a message holding the key in use is never sent, whatever its shape',async()=>{
  const {calls,fetchImpl}=recorder(reply(HANDOFF));
  assert.deepEqual(await judge({prompt:'配置里写的是 plainkey123 吗',choices:CHOICES,key:'plainkey123',fetchImpl}),{error:'secret'});
  assert.equal(calls.length,0);
});

test('without a key nothing is sent',async()=>{
  const {calls,fetchImpl}=recorder(reply(HANDOFF));
  assert.deepEqual(await judge({prompt:'写个交接',choices:CHOICES,env:{},fetchImpl}),{error:'no-key'});
  assert.equal(calls.length,0);
});

test('the key comes from the environment, else the macOS keychain, never without USER',()=>{
  const seen=[];
  const run=(command,args)=>{seen.push([command,...args]);return 'from-keychain\n';};
  assert.equal(apiKey({TYPESAFE_API_KEY:' env-key ',USER:'u'},{platform:'darwin',run}),'env-key');
  assert.equal(seen.length,0);
  assert.equal(apiKey({USER:'u'},{platform:'darwin',run}),'from-keychain');
  assert.deepEqual(seen.at(-1),['security','find-generic-password','-a','u','-s','TYPESAFE_API_KEY','-w']);
  assert.equal(apiKey({},{platform:'darwin',run}),'');
  assert.equal(apiKey({USER:'u'},{platform:'linux',run}),'');
  assert.equal(seen.length,1);
  assert.equal(apiKey({USER:'u'},{platform:'darwin',run:()=>{throw new Error('denied');}}),'');
});

test('the question lists each skill, its look-alike and a none option',()=>{
  const asked=question(CHOICES);
  assert.equal(asked.type,'choice');
  assert.deepEqual(Object.keys(asked.criteria),['handoff','wayfinder',nearLabel('wayfinder'),NONE]);
});

test('Jev\'s best skill above the threshold is the verdict; below it, or a look-alike, is none',async()=>{
  const ask=async probabilities=>judge({prompt:'x',choices:CHOICES,key:'k',fetchImpl:recorder(reply(probabilities)).fetchImpl});
  assert.deepEqual(await ask({handoff:0.9,wayfinder:0.05,[nearLabel('wayfinder')]:0,none:0.05}),{skill:'handoff',probability:0.9});
  assert.equal((await ask({handoff:0.4,wayfinder:0.1,[nearLabel('wayfinder')]:0,none:0.5})).skill,null);
  assert.equal((await ask({handoff:0.1,wayfinder:0.3,[nearLabel('wayfinder')]:0.6,none:0})).skill,null);
});

test('a reply without a valid probability for every option asked is bad-reply, never none or a skill',async()=>{
  const ask=async probabilities=>judge({prompt:'x',choices:CHOICES,key:'k',fetchImpl:recorder(reply(probabilities)).fetchImpl});
  const full={handoff:0.1,wayfinder:0.1,[nearLabel('wayfinder')]:0.1,none:0.7};
  for(const bad of [{},[],{...full,handoff:true},{...full,handoff:2},{...full,wayfinder:-0.1},{...full,none:'0.7'},
    {handoff:0.9,wayfinder:0.05,none:0.05}])
    assert.deepEqual(await ask(bad),{error:'bad-reply'},JSON.stringify(bad));
  assert.deepEqual(await ask(full),{skill:null,probability:0.7});
});

test('a dropped connection or server error is retried once',async()=>{
  let r=recorder(()=>{throw new TypeError('fetch failed');},reply(HANDOFF));
  assert.equal((await judge({prompt:'x',choices:CHOICES,key:'k',fetchImpl:r.fetchImpl})).skill,'handoff');
  assert.equal(r.calls.length,2);
  r=recorder(new Response('busy',{status:503}),reply(WAYFINDER));
  assert.equal((await judge({prompt:'x',choices:CHOICES,key:'k',fetchImpl:r.fetchImpl})).skill,'wayfinder');
  r=recorder(new Response('slow down',{status:429}),reply(WAYFINDER));
  assert.equal((await judge({prompt:'x',choices:CHOICES,key:'k',fetchImpl:r.fetchImpl})).skill,'wayfinder');
  r=recorder(()=>{throw new TypeError('fetch failed');});
  assert.deepEqual(await judge({prompt:'x',choices:CHOICES,key:'k',fetchImpl:r.fetchImpl}),{error:'network'});
  assert.equal(r.calls.length,2);
});

test('a client error or unreadable reply is not retried and never echoes the key or reply',async()=>{
  let r=recorder(new Response('bad key k-secret',{status:401}));
  assert.deepEqual(await judge({prompt:'x',choices:CHOICES,key:'k-secret',fetchImpl:r.fetchImpl}),{error:'http-4xx'});
  assert.equal(r.calls.length,1);
  r=recorder(new Response('not json',{status:200}));
  assert.deepEqual(await judge({prompt:'x',choices:CHOICES,key:'k',fetchImpl:r.fetchImpl}),{error:'bad-reply'});
  r=recorder(new Response('{"answers":{}}',{status:200}));
  assert.deepEqual(await judge({prompt:'x',choices:CHOICES,key:'k',fetchImpl:r.fetchImpl}),{error:'bad-reply'});
});

const hang=options=>new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(Object.assign(new Error('aborted'),{name:'AbortError'}))));
const later=(ms,response)=>()=>new Promise(resolve=>setTimeout(()=>resolve(response),ms));

test('a hanging Jev is cut off within the budget, the second request included',async()=>{
  const r=recorder(hang);
  const started=Date.now();
  assert.deepEqual(await judge({prompt:'x',choices:CHOICES,key:'k',fetchImpl:r.fetchImpl,budgetMs:400,hedgeMs:200}),{error:'timeout'});
  const took=Date.now()-started;
  assert.ok(took>=350&&took<700,`took ${took}ms`);
  assert.equal(r.calls.length,2);
  assert.ok(r.calls.every(call=>call.options.signal.aborted),'both requests are aborted at the deadline');
});

test('a first request that has not answered by the hedge time gets a second alongside; the first answer wins',async()=>{
  const r=recorder(hang,later(50,reply(WAYFINDER)));
  const started=Date.now();
  assert.equal((await judge({prompt:'x',choices:CHOICES,key:'k',fetchImpl:r.fetchImpl,budgetMs:2000,hedgeMs:100})).skill,'wayfinder');
  assert.ok(Date.now()-started<500);
  assert.equal(r.calls.length,2);
  assert.ok(r.calls[0].options.signal.aborted,'the hung request is aborted once an answer arrives');
});

test('a prompt answer sends only one request',async()=>{
  const r=recorder(reply(HANDOFF));
  assert.equal((await judge({prompt:'x',choices:CHOICES,key:'k',fetchImpl:r.fetchImpl,hedgeMs:100})).skill,'handoff');
  await new Promise(resolve=>setTimeout(resolve,200));
  assert.equal(r.calls.length,1);
});

// ---- the exam (方案-技能自动调用 第 8–9 条) ----

test('exam: 50 phrasings, 30 should start a skill and 20 should not, the 17 from 2026-10-24 included',()=>{
  const {cases}=readExam();
  assert.equal(cases.length,50);
  assert.equal(cases.filter(item=>item.expect!==null).length,30);
  assert.equal(cases.filter(item=>item.source==='2026-10-24').length,17);
  assert.equal(new Set(cases.map(item=>item.id)).size,50);
  const skills=new Set(invokeChoices().map(choice=>choice.skill));
  for(const item of cases)assert.ok(item.expect===null||skills.has(item.expect),item.id);
});

test('exam: every judged phrasing has a recorded answer for the exact request it sends today',()=>{
  const choices=invokeChoices();
  for(const item of readExam().cases){
    if(opensWithCommand(item.prompt)){assert.equal(item.jev,undefined,item.id);continue;}
    assert.equal(item.jev?.request,expectedRequest(item,choices),
      `${item.id}：考题原文或规则的 when/near 改了，录下的 Jev 回答已过期；运行 node scripts/cm-skill-hints-exam.mjs --record 重录`);
  }
});

test('exam: a changed phrasing no longer matches its recording',async()=>{
  const exam=readExam();
  const fake=replayFetch(exam);
  // A phrasing the keyword fallback misses, so only a (wrongly) replayed answer could pass it.
  const item=exam.cases.find(entry=>entry.id==='handoff-3');
  const changed={...exam,cases:[{...item,prompt:item.prompt+'。'}]};
  const [result]=await runExam({exam:changed,fetchImpl:fake});
  assert.equal(result.pass,false);
});

test('exam: command cases cannot dilute the judged rates',()=>{
  const negative=(id,pass,command)=>({id,expect:null,pass,command});
  const results=[{id:'p',expect:'handoff',pass:true,command:false},negative('bad',false,false),
    ...Array.from({length:15},(_,i)=>negative(`n${i}`,true,false)),...Array.from({length:4},(_,i)=>negative(`c${i}`,true,true))];
  const result=score(results);
  assert.equal(result.falseTrigger,1/20);
  assert.equal(result.judged.falseTrigger,1/16);
  assert.equal(result.ok,false);
});

test('exam: the hook meets the target with the recorded Jev answers',async()=>{
  const exam=readExam();
  const result=score(await runExam({exam,fetchImpl:replayFetch(exam)}));
  assert.ok(result.hit>=TARGET.hit,`命中 ${result.hit}，未过：${result.failed.map(item=>item.id).join('、')}`);
  assert.ok(result.falseTrigger<=TARGET.falseTrigger,`误触发 ${result.falseTrigger}，未过：${result.failed.map(item=>item.id).join('、')}`);
  assert.ok(result.judged.ok,`经判断的：命中 ${result.judged.hit}，误触发 ${result.judged.falseTrigger}`);
});

test('exam: the keyword fallback alone never triggers on more than 5% of should-not phrasings, command cases left out',async()=>{
  const result=score(await runExam({keywordsOnly:true}));
  assert.ok(result.judged.falseTrigger<=TARGET.falseTrigger,`误触发 ${result.judged.falseTrigger}：${result.judged.failed.map(item=>item.id).join('、')}`);
});
