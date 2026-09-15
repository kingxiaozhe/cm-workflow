// Local observations for cm-init step 1. Never execute manifest scripts or configs.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {freeze,need} from '../cm-ai/effect-contract.mjs';

const manifests=new Set(['package.json','Cargo.toml','go.mod','pyproject.toml','pom.xml','build.gradle',
  'build.gradle.kts','composer.json','Gemfile','pubspec.yaml','Package.swift','CMakeLists.txt']);
const ignored=new Set(['.git','node_modules','.venv','venv','.next','dist','build','target','coverage','.omx','.reviews']);
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);

export function inspectCmInitProjectAnalysis({project}){
  need(typeof project==='string'&&path.isAbsolute(project),'init_project_path_invalid');
  const root=fs.realpathSync(project);
  need(fs.statSync(root).isDirectory(),'init_project_path_invalid');
  const result={version:1,workflow:'cm-init',phase:'project_analysis',project:root,
    directories:[],manifests:[],configurationFiles:[],existingInstructions:[],skippedLinks:[],
    nodePackage:null,semanticAnalysisRequired:true,commandsExecuted:false,
    executionAuthorized:false,writeAuthorized:false};
  const names=fs.readdirSync(root).sort();
  need(names.length<=10000,'init_analysis_limit');
  for(const name of names){
    if(ignored.has(name))continue;
    const stat=fs.lstatSync(path.join(root,name));
    if(stat.isSymbolicLink()||(stat.isFile()&&stat.nlink!==1)){result.skippedLinks.push(name);continue;}
    if(stat.isDirectory())result.directories.push(name);
    if(!stat.isFile())continue;
    if(manifests.has(name)||/\.(csproj|fsproj)$/.test(name))result.manifests.push(name);
    if(/^(README(?:\.[\w-]+)?|Makefile|tsconfig(?:\.[\w-]+)?\.json|(?:eslint|prettier)\.config\.[cm]?js|\.editorconfig|\.eslintrc(?:\.\w+)?|\.prettierrc(?:\.\w+)?|project\.config\.json|app\.json)$/.test(name))
      result.configurationFiles.push(name);
    if(['AGENTS.md','CLAUDE.md'].includes(name))result.existingInstructions.push(name);
  }
  if(result.manifests.includes('package.json')){
    const file=path.join(root,'package.json');
    // Recheck through the opened descriptor; avoid following a replaced symlink.
    const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
    let bytes;
    try{
      const stat=fs.fstatSync(fd);
      need(stat.isFile()&&stat.nlink===1&&stat.size<=1048576,'init_package_file_invalid');
      bytes=Buffer.alloc(stat.size+1);
      const count=fs.readSync(fd,bytes,0,bytes.length,0);
      need(count===stat.size,'init_package_changed');bytes=bytes.subarray(0,count);
    }finally{fs.closeSync(fd);}
    let manifest;
    try{manifest=JSON.parse(bytes.toString('utf8'));}catch{need(false,'init_package_json_invalid');}
    need(record(manifest),'init_package_json_invalid');
    for(const key of ['scripts','dependencies','devDependencies','peerDependencies'])
      need(manifest[key]===undefined||record(manifest[key]),'init_package_field_invalid');
    const scripts=Object.entries(manifest.scripts??{}).sort(([a],[b])=>a.localeCompare(b));
    need(scripts.every(([,value])=>typeof value==='string'),'init_package_field_invalid');
    // Do not emit script bodies or dependency values (which may contain credentials).
    result.nodePackage={source:'package.json',sha256:crypto.createHash('sha256').update(bytes).digest('hex'),
      scriptNames:scripts.map(([name])=>name),
      dependencyNames:[...new Set(['dependencies','devDependencies','peerDependencies']
        .flatMap(key=>Object.keys(manifest[key]??{})))].sort(),
      commandEvidence:'manifest_declaration_only'};
  }
  return freeze(result);
}
