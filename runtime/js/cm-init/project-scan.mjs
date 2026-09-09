// cm-init step 1.5: filesystem observations and the existing map decision.
// No commands, source-content reads, map generation or project writes.
import fs from 'node:fs';
import path from 'node:path';
import {freeze,need} from '../cm-ai/effect-contract.mjs';

const manifests=new Set(['package.json','Cargo.toml','go.mod','pyproject.toml','pom.xml','build.gradle','build.gradle.kts','composer.json','Gemfile','pubspec.yaml','Package.swift','CMakeLists.txt']);
const sourceDirectories=new Set(['src','app','lib','pages','components','server','client','contracts']);
const sourceExtensions=new Set(['.js','.mjs','.cjs','.jsx','.ts','.tsx','.vue','.svelte','.py','.rs','.go','.java','.kt','.kts','.cs','.c','.h','.cpp','.hpp','.swift','.rb','.php','.dart','.sol']);
const ignored=new Set(['.git','node_modules','.venv','venv','.next','dist','build','target','coverage','.omx','.reviews']);

function directory(raw){
  need(typeof raw==='string'&&path.isAbsolute(raw),'init_project_path_invalid');
  const root=fs.realpathSync(raw);
  need(fs.lstatSync(root).isDirectory(),'init_project_path_invalid');return root;
}

export function inspectCmInitProjectScan({project,workflowRoot}){
  const root=directory(project),workflow=directory(workflowRoot);
  const observations={manifests:[],sourceDirectories:[],sourceFiles:null,skippedSymlinks:[],mapExists:null};
  let entries=0;
  function walk(relative=''){
    for(const name of fs.readdirSync(path.join(root,relative)).sort()){
      if(ignored.has(name))continue;
      need(++entries<=10000,'init_scan_limit');
      const file=relative?`${relative}/${name}`:name;
      const stat=fs.lstatSync(path.join(root,file));
      if(stat.isSymbolicLink()){observations.skippedSymlinks.push(file);continue;}
      if(relative===''&&stat.isFile()&&(manifests.has(name)||/\.(csproj|fsproj)$/.test(name)))observations.manifests.push(file);
      if(relative===''&&stat.isDirectory()&&sourceDirectories.has(name))observations.sourceDirectories.push(name);
      if(file==='docs/codebase-context'){
        need(stat.isDirectory(),'init_map_path_invalid');observations.mapExists=true;continue;
      }
      if(stat.isDirectory())walk(file);
      else if(stat.isFile()&&sourceExtensions.has(path.extname(name).toLowerCase()))observations.sourceFiles++;
    }
  }
  const skill=path.join(workflow,'skills','codebase-context','SKILL.md');
  let skillAvailable=false;
  try{const stat=fs.lstatSync(skill);skillAvailable=stat.isFile()&&!stat.isSymbolicLink()&&fs.realpathSync(skill)===skill;}
  catch(error){if(error.code!=='ENOENT')throw error;}
  if(!skillAvailable)return freeze({version:1,workflow:'cm-init',phase:'codebase_map_decision',project:root,
    action:'skip',reason:'codebase_skill_unavailable',observations,skillAvailable,
    executionAuthorized:false,writeAuthorized:false});
  observations.sourceFiles=0;observations.mapExists=false;
  walk();
  let action,reason;
  if(observations.skippedSymlinks.length){action='blocked';reason='project_inventory_incomplete';}
  else if(!observations.manifests.length&&!observations.sourceDirectories.length){action='skip';reason='project_shape_not_applicable';}
  else if(observations.mapExists){action='incremental';reason='existing_codebase_map';}
  else if(observations.sourceFiles>30){action='full';reason='large_project_without_map';}
  else{action='skip';reason='small_project';}
  return freeze({version:1,workflow:'cm-init',phase:'codebase_map_decision',project:root,action,reason,
    observations,skillAvailable,executionAuthorized:false,writeAuthorized:false});
}
