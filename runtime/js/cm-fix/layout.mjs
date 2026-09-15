// Explicit bare-project archive adapter; never creates a specs/task skeleton.
import fs from 'node:fs';
import path from 'node:path';
import {canonicalFuture} from '../cm-test/source-snapshot.mjs';
import {need} from '../cm-ai/effect-contract.mjs';

export function fixArchiveRoot(specsRoot,cwd,create=false){
  if(specsRoot!=null)return fs.realpathSync(specsRoot);
  need(path.isAbsolute(cwd)&&fs.realpathSync(cwd)===cwd,'unsupported_path');
  const target=path.join(cwd,'docs','fixes');
  need(canonicalFuture(target)===target,'unsupported_path');
  if(create)fs.mkdirSync(target,{recursive:true,mode:0o700});
  need(fs.realpathSync(target)===target&&fs.lstatSync(target).isDirectory(),'unsupported_path');
  return target;
}
export const fixDossierRelative=(configuration,name)=>configuration.archiveMode==='bare'?name:`fixes/${name}`;
export const fixDossierDirectory=(root,configuration)=>configuration.archiveMode==='bare'?root:path.join(root,'fixes');
