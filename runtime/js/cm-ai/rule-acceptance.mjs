// Explicit, committed rule changes are review material, never developer scope.
import {json,shape,hex,need,freeze} from './effect-contract.mjs';
const CODE='rule_acceptance_invalid';
export const acceptedRulePath=p=>p==='AGENTS.md'||/^\.claude\/rules\/[a-zA-Z0-9][a-zA-Z0-9._-]*\.md$/.test(p);
export function readRuleAcceptance(raw){
  const r=json(raw);shape(r,['version','sourceBaselineDigest','candidateCommit','source','files']);
  need(r.version===1&&typeof r.candidateCommit==='string'&&/^[a-f0-9]{40}$/.test(r.candidateCommit),CODE);
  hex(r.sourceBaselineDigest);
  need(typeof r.source==='string'&&r.source.trim().length>0&&Buffer.byteLength(r.source)<=500&&!/[\r\n\0]/.test(r.source),CODE);
  need(Array.isArray(r.files)&&r.files.length>0&&r.files.length<=8,CODE);
  let prior=null,total=0;
  for(const f of r.files){
    shape(f,['path','creationSha256','sha256','size','mode']);hex(f.creationSha256);hex(f.sha256);
    need(typeof f.path==='string'&&acceptedRulePath(f.path)&&(prior===null||prior<f.path)
      &&f.creationSha256!==f.sha256&&Number.isSafeInteger(f.size)&&f.size>=0&&f.size<=1024*1024
      &&[0o644,0o755].includes(f.mode),CODE);
    prior=f.path;total+=f.size;
  }
  need(total<=2*1024*1024,CODE);return freeze(r);
}
export function assertAcceptedRuleFiles(raw,files){
  const r=readRuleAcceptance(raw),byPath=new Map(files.map(f=>[f.path,f]));
  for(const f of r.files){const current=byPath.get(f.path);
    need(current&&current.sha256===f.sha256&&current.size===f.size&&current.mode===f.mode,'rule_acceptance_changed');
  }return r;
}
