// Resolve declarations, never rewrite argv or run an implicit install/fallback.
import {need} from '../cm-ai/effect-contract.mjs';
import {checkSourceEvidence} from './source-snapshot.mjs';

export function inspectDeclaredTestCommand(item,sources){
  checkSourceEvidence([{evidence:[item.declaration]}],sources);
  need(Array.isArray(item.command)&&item.command.length>0
    &&item.command.every(arg=>typeof arg==='string'&&arg.length>0&&!arg.includes('\0')),'cm_test_commands_invalid');
  const source=sources.find(file=>file.path===item.declaration.path);
  if(source.path!=='package.json'){
    need(source.content.split('\n')[item.declaration.line-1].includes(item.command.join(' ')),
      'cm_test_command_not_declared');
    return {kind:'literal'};
  }
  const [manager,verb,name,...rest]=item.command;
  need(['npm','pnpm','yarn','bun'].includes(manager),'cm_test_command_not_declared');
  // Only script execution forms, never exec/dlx/install, workspace selection,
  // cwd overrides, or flags that turn a missing script into success.
  // `bun test` is a built-in runner, not the package script named "test".
  const implicit=manager!=='bun'&&verb==='test'&&item.command.length===2;
  need(implicit||(verb==='run'&&typeof name==='string'&&/^[A-Za-z0-9][A-Za-z0-9:._-]*$/.test(name)
    &&(rest.length===0||(rest[0]==='--'&&rest.length>1))),'cm_test_command_not_declared');
  const script=implicit?'test':name;
  let manifest;try{manifest=JSON.parse(source.content);}catch{need(false,'cm_test_package_invalid');}
  need(manifest&&typeof manifest==='object'&&!Array.isArray(manifest)&&manifest.scripts
    &&Object.hasOwn(manifest.scripts,script)&&typeof manifest.scripts[script]==='string'
    &&manifest.scripts[script].trim(),'cm_test_command_not_declared');
  // Lifecycle scripts are part of the declared execution, not invisible extras.
  const lifecycle=Object.fromEntries([`pre${script}`,script,`post${script}`]
    .filter(key=>Object.hasOwn(manifest.scripts,key)).map(key=>[key,manifest.scripts[key]]));
  return {kind:'package-script',manager,script,lifecycle,packageDigest:source.sha256};
}
