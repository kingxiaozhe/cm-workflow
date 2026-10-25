// Jev judge for the skill hints hook: asks TypeSafe's Jev which author skill, if any,
// the user's message is asking for. The hook uses it for the few rules that start a
// skill (`invoke` in cm-skill-hints.json); keywords stay the fallback.
//
// Decided 2026-10-25 (方案-技能自动调用): only with a TypeSafe key (env or the macOS
// keychain); only the first SEND_CHARS characters leave the machine, and a message
// that looks like it holds a secret is never sent. At most BUDGET_MS in all and at most
// two requests: the second goes out at once when the first fails, or alongside it when
// the first has not answered within HEDGE_MS. Measured 2026-10-25 from fresh processes
// (as the hook runs): answers take 0.7–1.5 s, but about a quarter of new connections
// hang without ever answering, so waiting longer on one request does not help. Any
// failure returns {error}, so the caller falls back to keywords and the message is
// never held up.
// The key is never logged or printed; errors carry a category, never the response text.
import {execFileSync} from 'node:child_process';

export const JEV_URL='https://api.typesafe.ai/v1/systemone';
export const JEV_MODEL='jev-latest';
export const SEND_CHARS=500;
export const BUDGET_MS=3000;
export const HEDGE_MS=1000;
export const THRESHOLD=0.5;
export const NONE='none';
const KEY_NAME='TYPESAFE_API_KEY';

// What stays local (decided 2026-10-25 after five review rounds): any message that
// names a credential at all (password, token, key, 密码, 密钥 …), whatever follows it,
// and any message holding a known key shape or a long mixed-case run. Earlier versions
// tried to tell a labelled value ("密码是 x") from a description ("token 是什么"); every
// round found another way to write a value that slipped through (a value starting like
// a description, punctuation, quotes around the word). Not sending any message that
// mentions a credential has no such gap. It costs little: such a message only falls back
// to keywords, and none of the 50 exam phrasings mentions one. A credential pasted with
// no recognisable shape and no credential word can still pass, which the docs say.
// Matched on a folded copy of the message that keeps letters and digits only: full-width
// forms made plain and accents split off (NFKD), lower case, and every other character dropped (spaces,
// punctuation, underscores, zero-width and other invisible characters, combining marks),
// so "API  key", "api_key", "ＡＰＩ ｋｅｙ", "pass word" and "API\u200Bkey" all read the
// same. Dropping them can join two words into a credential word by accident; that only
// costs the Jev call.
const CREDENTIAL_WORD=/apikey|secret|token|passwd|password|pwd|passcode|accesskey|privatekey|credential|密钥|秘钥|密码|口令|令牌|凭证|凭据/;
const fold=text=>text.normalize('NFKD').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,'');
const SECRET_PATTERNS=[
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAIza[0-9A-Za-z_-]{30,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}/i,
];
// A long run of letters and digits mixing cases and digits looks like a token; plain hex
// (commit ids, hashes) does not.
const tokenLike=word=>word.length>=32&&!/^[0-9a-f]+$/i.test(word)&&/[a-z]/.test(word)&&/[A-Z]/.test(word)&&/\d/.test(word);
export const hasSecret=text=>CREDENTIAL_WORD.test(fold(text))
  ||SECRET_PATTERNS.some(pattern=>pattern.test(text))
  ||(text.match(/[A-Za-z0-9_+/=-]{32,}/g)??[]).some(tokenLike);

// The key comes from TYPESAFE_API_KEY, else (macOS only) the login keychain, the same
// place jev-mcp reads. Empty when neither has it.
export function apiKey(env=process.env,{platform=process.platform,run=execFileSync,timeoutMs=1000}={}){
  const fromEnv=String(env[KEY_NAME]??'').trim();
  if(fromEnv)return fromEnv;
  // Without USER the lookup would match any account's item, so it is not tried.
  if(platform!=='darwin'||!env.USER)return '';
  try{
    return String(run('security',['find-generic-password','-a',env.USER,'-s',KEY_NAME,'-w'],
      {encoding:'utf8',timeout:timeoutMs,stdio:['ignore','pipe','ignore']})).trim();
  }catch{return '';}
}

// First SEND_CHARS characters, counted by code point so a CJK or emoji is never split.
export const clip=text=>Array.from(text).slice(0,SEND_CHARS).join('');

// A choice may carry `near`: the look-alike situation that is not it. It becomes its own
// option, so Jev has somewhere to put the near miss; picking it counts as none.
export const nearLabel=skill=>`${skill}~near`;
export function question(choices){
  const criteria={};
  for(const choice of choices){
    criteria[choice.skill]=choice.when;
    if(choice.near)criteria[nearLabel(choice.skill)]=choice.near;
  }
  criteria[NONE]='以上都不是：用户在问别的事、在讨论或执行具体任务，或只是顺带提到这些词';
  return {type:'choice',instructions:'用户这条消息是在请求下面哪一件事？只看用户本人此刻要做什么。',criteria};
}

// Exactly what is sent; the exam's recordings are keyed by its hash.
export const requestBody=(prompt,choices)=>JSON.stringify({model:JEV_MODEL,state:clip(prompt),questions:{skill:question(choices)}});

// {skill, probability} when Jev answered (skill null = none of them), else {error}.
// `choices` is [{skill, when, near?}]; `when` describes the situation in the user's words.
export async function judge({prompt,choices,env=process.env,fetchImpl=globalThis.fetch,key,
  budgetMs=BUDGET_MS,hedgeMs=HEDGE_MS,now=Date.now}){
  if(!choices?.length)return {error:'no-choices'};
  if(hasSecret(prompt))return {error:'secret'};
  const started=now();
  const token=key??apiKey(env);
  if(!token)return {error:'no-key'};
  // The key in use is the one credential known for sure: a message holding it stays local.
  if(prompt.includes(token))return {error:'secret'};
  const left=budgetMs-(now()-started);
  if(left<=50)return {error:'timeout'};
  const body=requestBody(prompt,choices);
  return new Promise(resolve=>{
    const controllers=[];
    let settled=false;
    let pending=0;
    let error='timeout';
    const finish=value=>{
      if(settled)return;
      settled=true;
      clearTimeout(hedge);
      clearTimeout(deadline);
      for(const controller of controllers)controller.abort();
      resolve(value);
    };
    const send=()=>{
      if(settled||controllers.length>=2)return;
      const controller=new AbortController();
      controllers.push(controller);
      pending++;
      fetchImpl(JEV_URL,{method:'POST',signal:controller.signal,
        headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body})
        .then(async response=>{
          // Overloaded or rate-limited is worth the second request; other client errors are not.
          if(response.status>=500||response.status===429)throw Object.assign(new Error('server'),{category:`http-${response.status===429?'429':'5xx'}`});
          if(!response.ok)return finish({error:'http-4xx'});
          let reply;
          try{reply=await response.json();}catch{return finish({error:'bad-reply'});}
          finish(read(reply,choices));
        })
        .catch(caught=>{
          pending--;
          if(settled)return;
          error=caught?.category??(caught?.name==='AbortError'?'timeout':'network');
          if(controllers.length<2)send();
          else if(!pending)finish({error});
        });
    };
    const hedge=setTimeout(send,Math.min(hedgeMs,left));
    const deadline=setTimeout(()=>finish({error:'timeout'}),left);
    send();
  });
}

// A reply counts only when it gives a probability in [0, 1] for every option asked;
// anything else is bad-reply, so the caller falls back to keywords instead of taking
// a malformed answer as "none" or as a skill.
function read(reply,choices){
  const probabilities=reply?.answers?.skill?.probabilities;
  if(!probabilities||typeof probabilities!=='object'||Array.isArray(probabilities))return {error:'bad-reply'};
  const asked=Object.keys(question(choices).criteria);
  const valid=label=>typeof probabilities[label]==='number'&&probabilities[label]>=0&&probabilities[label]<=1;
  if(!asked.every(valid))return {error:'bad-reply'};
  let best=null;
  for(const choice of choices){
    const p=probabilities[choice.skill];
    if(!best||p>best.probability)best={skill:choice.skill,probability:p};
  }
  if(best.probability<THRESHOLD)return {skill:null,probability:probabilities[NONE]};
  return best;
}
