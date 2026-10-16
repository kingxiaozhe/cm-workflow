// An additive configuration-discovery correction. Never accepts replacement argv.
import fs from 'node:fs';
import path from 'node:path';
import {digest,json,need,shape} from '../cm-ai/effect-contract.mjs';
import {readReviewSourceFiles} from '../cm-ai/review-package.mjs';
import {verificationPath} from './review-verification-contract.mjs';
export const COMMAND_CORRECTION='fix-command-correction';
export const correctionRow=records=>records.find(r=>r.id===COMMAND_CORRECTION)??null;
const jest=argv=>Array.isArray(argv)&&argv.length>1&&/(?:^|[\\/])jest[\\/]bin[\\/]jest\.js$/.test(argv[1]);
function selected(config){return [
  ...(config.redTest?.command?[{id:'red-test',cwd:config.redTest.cwd,command:config.redTest.command}]:[]),
  ...(config.baseline?.commands??[]).map(c=>({...c,id:`baseline.${c.id}`,cwd:config.baseline.cwd})),
  ...(config.walkthrough?.flows??[]).filter(f=>f.kind==='commands').map(f=>({id:`walkthrough.${f.id}`,cwd:config.reproduction.cwd,command:f.command})),
 ];}
function configFile(root,relative){
 verificationPath(relative);need(relative.endsWith('/package.json')||relative==='package.json','fix_command_correction_config');
 const [file]=readReviewSourceFiles(root,[relative]);
 need(file.size<=128*1024,'fix_command_correction_config');
 let parsed;try{parsed=JSON.parse(Buffer.from(file.contentBase64,'base64').toString('utf8'));}catch{need(false,'fix_command_correction_config');}
 need(parsed.jest&&typeof parsed.jest==='object'&&!Array.isArray(parsed.jest),'fix_command_correction_config');
 const {contentBase64,...metadata}=file;return metadata;
}
export function deriveJestCorrection(configuration,declaration,file){
 const d=json(declaration);shape(d,['kind','path']);verificationPath(d.path);
 need(d.kind==='jest-config-path'&&d.path===file.path,'fix_command_correction_config');
 const root=configuration.reproduction.cwd,commands=selected(configuration).filter(c=>jest(c.command)&&!c.command.some(v=>v==='--config'||v.startsWith('--config=')));
 need(commands.length>0,'fix_command_correction_unavailable');
 const directory=path.posix.dirname(d.path);
 for(const c of commands){
  const at=c.command.indexOf('--rootDir');
  need(c.cwd===root&&at>=0&&c.command[at+1]===directory,'fix_command_correction_config');
 }
 return commands.map(c=>({id:c.id,before:c.command,after:[...c.command,'--config',d.path]}));
}
export function applyCommandCorrection(configuration,payload){
 const {target}=payload,derived=deriveJestCorrection(configuration,target.declaration,target.configFile);
 need(digest(derived)===digest(target.commands),'fix_command_correction_binding');
 const byId=new Map(derived.map(c=>[c.id,c.after]));
 return json({...configuration,
  ...(configuration.redTest?{redTest:{...configuration.redTest,command:byId.get('red-test')??configuration.redTest.command}}:{}),
  ...(configuration.baseline?{baseline:{...configuration.baseline,commands:configuration.baseline.commands.map(c=>({...c,command:byId.get(`baseline.${c.id}`)??c.command}))}}:{}),
  ...(configuration.walkthrough?{walkthrough:{...configuration.walkthrough,flows:configuration.walkthrough.flows.map(f=>({...f,...(byId.has(`walkthrough.${f.id}`)?{command:byId.get(`walkthrough.${f.id}`)}:{})}))}}:{}),
 });
}
export function readCorrectionConfig(configuration,declaration){return configFile(configuration.reproduction.cwd,declaration.path);}
export function assertCorrectionConfigCurrent(configuration,payload){
 need(digest(readCorrectionConfig(configuration,payload.target.declaration))===digest(payload.target.configFile),'fix_command_correction_drift');
}
export function correctionFiles(configuration,declaration){
 const root=configuration.reproduction.cwd,paths=[...new Set([declaration.path,...(configuration.reviewVerification?.files??[]),...(configuration.repair?.scope??[]),...(configuration.repair?.requirements??[]),...(configuration.redTest?.testFiles??[])])].sort();
 return paths.map(p=>{
  verificationPath(p);let cursor=root;
  for(const part of p.split('/')){cursor=path.join(cursor,part);try{need(!fs.lstatSync(cursor).isSymbolicLink(),'fix_command_correction_drift');}catch(e){if(e.code!=='ENOENT')throw e;return {path:p,sha256:null,mode:null};}}
  const [{sha256,mode}]=readReviewSourceFiles(root,[p]);return {path:p,sha256,mode};
 });
}
// New drivers reject a deterministic launch error before creating a frozen run.
export function assertJestConfigurationDiscovery(configuration){
 for(const c of selected(configuration)){
  if(!jest(c.command)||c.command.some(v=>v==='--config'||v.startsWith('--config=')))continue;
  let directory=c.cwd,found=false;
  for(;;){
   if(['js','ts','mjs','cjs','json'].some(ext=>fs.existsSync(path.join(directory,`jest.config.${ext}`)))){found=true;break;}
   try{if(fs.statSync(path.join(directory,'package.json')).isFile()){found=true;break;}}catch{}
   const parent=path.dirname(directory);if(parent===directory)break;directory=parent;
  }
  need(found,'fix_jest_config_path_required');
 }
}
