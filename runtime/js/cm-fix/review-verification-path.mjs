import {need} from '../cm-ai/effect-contract.mjs';
export function verificationPath(value){
 need(typeof value==='string'&&value.length<=240&&!value.includes('\\')&&!value.includes('\0')
  &&!value.startsWith('/')&&value.split('/').every(p=>p&&p!=='.'&&p!=='..')
  &&!value.split('/').some(p=>/^(?:\.env(?:\..*)?|\.git|\.reviews|\.codex|\.claude|\.ssh|\.aws|\.npmrc|\.netrc|\.pypirc|credentials\.json|id_rsa|node_modules)$/i.test(p)),'review_verification_path');
 return value;
}
