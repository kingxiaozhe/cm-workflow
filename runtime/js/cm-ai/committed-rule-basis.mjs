// Read committed bootstrap targets as raw Git blobs. Project Git configuration
// is data, not a command source; no hooks, attributes, or filters may run.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';

const inside=(root,target)=>target===root||target.startsWith(root+path.sep);
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');

function trustedGit(root){
  for(const directory of (process.env.PATH??'').split(path.delimiter)){
    if(!directory||!path.isAbsolute(directory))continue;
    try{const bin=fs.realpathSync(path.join(directory,process.platform==='win32'?'git.exe':'git'));
      if(!inside(root,bin)&&fs.statSync(bin).isFile()){fs.accessSync(bin,fs.constants.X_OK);return bin;}
    }catch{}
  }
  return null;
}

export function readCommittedRuleBasis(root,targets,{requireCleanIndex=true}={}){
  const bin=trustedGit(root);if(!bin)return null;
  const safePath=(process.env.PATH??'').split(path.delimiter).filter(directory=>{
    if(!directory||!path.isAbsolute(directory))return false;
    try{return !inside(root,fs.realpathSync(directory));}catch{return false;}
  }).join(path.delimiter);
  const env={PATH:safePath,HOME:os.tmpdir(),USERPROFILE:os.tmpdir(),TMPDIR:os.tmpdir(),TMP:os.tmpdir(),TEMP:os.tmpdir(),
    LANG:'C.UTF-8',LC_ALL:'C.UTF-8',GIT_NO_REPLACE_OBJECTS:'1',GIT_NO_LAZY_FETCH:'1',GIT_TERMINAL_PROMPT:'0',
    GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:os.devNull,
    ...(process.env.SystemRoot?{SystemRoot:process.env.SystemRoot}:{})};
  const common=['--no-optional-locks','-c','core.fsmonitor=false','-C',root];
  const run=(args,options=[])=>spawnSync(bin,[...common,...options,...args],{env,timeout:10000,maxBuffer:2*1024*1024});
  const config=run(['config','--name-only','--get-regexp','^filter\\..*\\.(clean|process|required)$']);
  if(config.error||![0,1].includes(config.status))return null;
  const disabled=[];
  for(const key of config.stdout.toString('utf8').split('\n').filter(Boolean)){
    if(!/^filter\.[^\x00-\x1f]+\.(clean|process|required)$/.test(key))return null;
    disabled.push('-c',`${key}=${key.endsWith('.required')?'false':''}`);
  }
  const git=args=>{
    const result=run(args,disabled);
    if(result.error||result.status!==0)return null;
    return result.stdout;
  };
  const top=git(['rev-parse','--show-toplevel']),head=git(['rev-parse','HEAD']);
  if(!top||!head)return null;
  try{if(fs.realpathSync(top.toString('utf8').trim())!==root)return null;}catch{return null;}
  const commit=head.toString('utf8').trim();if(!/^[a-f0-9]{40,64}$/.test(commit))return null;
  const tree=git(['ls-tree','--full-tree','-r','-z',commit,'--',...targets.map(file=>`:(literal)${file}`)]);
  if(!tree)return null;
  const entries=new Map();
  for(const record of tree.toString('utf8').split('\0').filter(Boolean)){
    const match=record.match(/^(100644|100755) blob ([a-f0-9]{40,64})\t(.+)$/);
    if(!match||!targets.includes(match[3])||entries.has(match[3]))return null;
    entries.set(match[3],match[2]);
  }
  if(requireCleanIndex){
    const index=git(['ls-files','--stage','-z','--',...targets.map(file=>`:(literal)${file}`)]);
    if(!index)return null;
    const staged=new Map();
    for(const record of index.toString('utf8').split('\0').filter(Boolean)){
      const match=record.match(/^(100644|100755) ([a-f0-9]{40,64}) 0\t(.+)$/);
      if(!match||!targets.includes(match[3])||staged.has(match[3]))return null;
      staged.set(match[3],match[2]);
    }
    if(targets.some(file=>entries.get(file)!==staged.get(file)))return null;
  }
  const files=[];
  for(const file of targets){
    const object=entries.get(file),bytes=object?git(['cat-file','blob',object]):null;
    if(object&&(!bytes||bytes.length>1024*1024))return null;
    files.push({path:file,sha256:bytes===null?null:sha(bytes)});
  }
  return {commit,files};
}
