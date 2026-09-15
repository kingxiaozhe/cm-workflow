#!/usr/bin/env node
// Authoritative dependency-free CM Workflow project configuration loader.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const CONFIG_FILENAMES=Object.freeze(['.cm-workflow.yml','.cm-workflow.yaml','.cm-workflow.json']);
export const MAX_CONFIG_BYTES=64*1024;

const PROJECT_TYPES=new Set(['auto','java-backend','web-frontend','custom']);
const WORKFLOWS=new Set(['cm-default','java-backend','web-frontend']);
const ROLE_NAMES=new Set(['analyst','planner','coder','tester','reviewer','browser_qa','external_expert']);
const ROLE_FIELDS=new Set(['adapter','model','source']);
const EXTERNAL_FIELDS=new Set([...ROLE_FIELDS,'enabled','activation','model_policy']);
const ADAPTERS=new Set(['current-ai','codex-cli','claude-cli','claude-api','openai-compatible','local','browser','external-browser']);
const SOURCES=new Set(['local','subscription','api','browser','none']);
const TEST_KINDS=new Set(['logic','commands','browser']);
const ACTIVATIONS=new Set(['explicit']);
const MODEL_POLICIES=new Set(['pro-extra-high-high-skip','strict-pro','strict-Pro']);
const MODEL_POLICY_ALIASES=Object.freeze({'strict-Pro':'strict-pro'});
const AUTO_FIX_POLICIES=new Set(['explicit','never','auto']);
const DELIVERY_MODES=new Set(['diff','branch','draft-mr']);
const RUNTIMES=new Set(['codex','claude','unknown']);
const SECRET_KEY=/(?:api[_-]?key|access[_-]?token|secret|cookie|password|private[_-]?key|credential|authorization)/i;
const SECRET_VALUE=/(?:-----BEGIN [^-]+ PRIVATE KEY-----|\b(?:AKIA|ASIA)[0-9A-Z]{16}\b|\bAIza[0-9A-Za-z_-]{20,}\b|\bsk[-_](?:ant-api\d{2}[-_])?[A-Za-z0-9_-]{12,}\b|\b(?:ghp|gho|ghu|ghs|ghr|github_pat)[-_][A-Za-z0-9_-]{8,}\b|\bxox[baprs][-_][A-Za-z0-9_-]{8,}\b|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b)/i;
const IDENTIFIER=/^[A-Za-z0-9][A-Za-z0-9._:/+@-]{0,127}$/;

export class ConfigError extends Error {
  constructor(message){super(message);this.name='ConfigError';}
}

const rawDefault={
  version:1,
  project:{type:'auto',workflow:'cm-default'},
  roles:{
    analyst:{adapter:'current-ai',model:'default',source:'local'},
    planner:{adapter:'current-ai',model:'default',source:'local'},
    coder:{adapter:'current-ai',model:'default',source:'local'},
    tester:{adapter:'local',model:'none',source:'local'},
    reviewer:{adapter:'current-ai',model:'default',source:'local'},
    browser_qa:{adapter:'browser',model:'none',source:'local'},
    external_expert:{adapter:'external-browser',model:'chatgpt-pro',source:'browser',enabled:true,
      activation:'explicit',model_policy:'pro-extra-high-high-skip'},
  },
  policies:{tests:['logic','commands','browser'],generate_cases:true,auto_fix:'explicit',delivery:'draft-mr'},
};
const deepFreeze=value=>{
  if(value&&typeof value==='object'&&!Object.isFrozen(value)){
    for(const item of Object.values(value))deepFreeze(item);
    Object.freeze(value);
  }
  return value;
};
export const DEFAULT_CONFIG=deepFreeze(structuredClone(rawDefault));

const clone=value=>structuredClone(value);
function object(value){return value!==null&&typeof value==='object'&&!Array.isArray(value);}
function define(target,key,value){Object.defineProperty(target,key,{value,writable:true,enumerable:true,configurable:true});}
function deepMerge(base,override){
  const result=clone(base);
  for(const [key,value] of Object.entries(override)){
    if(object(value)&&object(result[key]))result[key]=deepMerge(result[key],value);
    else result[key]=clone(value);
  }
  return result;
}

function stripComment(value){
  let quote=null,escaped=false;
  for(let index=0;index<value.length;index++){
    const character=value[index];
    if(quote==='"'&&escaped){escaped=false;continue;}
    if(character==='\\'&&quote==='"'){escaped=true;continue;}
    if(character==="'"||character==='"'){
      if(quote===null)quote=character;else if(quote===character)quote=null;
      continue;
    }
    if(character==='#'&&quote===null&&(index===0||/\s/.test(value[index-1])))return value.slice(0,index).trimEnd();
  }
  return value.trimEnd();
}

function splitTopLevel(value,separator=','){
  const parts=[];let start=0,depth=0,quote=null,escaped=false;
  for(let index=0;index<value.length;index++){
    const character=value[index];
    if(quote==='"'&&escaped){escaped=false;continue;}
    if(character==='\\'&&quote==='"'){escaped=true;continue;}
    if(character==="'"||character==='"'){
      if(quote===null)quote=character;else if(quote===character)quote=null;
    }else if(quote===null){
      if('[{('.includes(character))depth++;
      else if(']})'.includes(character))depth--;
      else if(character===separator&&depth===0){parts.push(value.slice(start,index).trim());start=index+1;}
    }
  }
  if(quote!==null||depth!==0)throw new ConfigError('unclosed quote or inline collection');
  parts.push(value.slice(start).trim());return parts;
}

function mappingColon(value){
  let depth=0,quote=null,escaped=false;
  for(let index=0;index<value.length;index++){
    const character=value[index];
    if(quote==='"'&&escaped){escaped=false;continue;}
    if(character==='\\'&&quote==='"'){escaped=true;continue;}
    if(character==="'"||character==='"'){
      if(quote===null)quote=character;else if(quote===character)quote=null;
    }else if(quote===null){
      if('[{('.includes(character))depth++;
      else if(']})'.includes(character))depth--;
      else if(character===':'&&depth===0&&(index+1===value.length||/\s/.test(value[index+1])))return index;
    }
  }
  return -1;
}

function parseScalar(raw){
  const value=raw.trim();
  if(!value)throw new ConfigError('empty scalar is not allowed');
  if('!&*|>'.includes(value[0]))throw new ConfigError(`unsupported YAML feature: ${value[0]}`);
  if(value.startsWith('[')&&value.endsWith(']')){
    const inner=value.slice(1,-1).trim();return inner?splitTopLevel(inner).map(parseScalar):[];
  }
  if(value.startsWith('{')&&value.endsWith('}')){
    const inner=value.slice(1,-1).trim(),result={};
    if(!inner)return result;
    for(const item of splitTopLevel(inner)){
      const colon=mappingColon(item);
      if(colon<0)throw new ConfigError(`invalid inline mapping item: ${item}`);
      const key=parseKey(item.slice(0,colon));
      if(Object.hasOwn(result,key))throw new ConfigError(`duplicate key ${JSON.stringify(key)} in inline mapping`);
      define(result,key,parseScalar(item.slice(colon+1)));
    }
    return result;
  }
  if(value.startsWith('"')||value.startsWith("'")){
    if(value.length<2||value.at(-1)!==value[0])throw new ConfigError('unterminated quoted scalar');
    if(value[0]==='"'){
      try{return JSON.parse(value);}catch(error){throw new ConfigError(`invalid quoted scalar: ${error.message}`);}
    }
    return value.slice(1,-1).replaceAll("''", "'");
  }
  const lowered=value.toLowerCase();
  if(lowered==='true'||lowered==='false')return lowered==='true';
  if(lowered==='null'||lowered==='~')return null;
  if(/^-?\d+$/.test(value))return BigInt(value);
  if(/^-?(?:\d+\.\d*|\d*\.\d+)$/.test(value))return Number.parseFloat(value);
  return value;
}

function parseKey(value){
  const key=value.trim();if(!key)throw new ConfigError('mapping key cannot be empty');
  const parsed=parseScalar(key);if(typeof parsed!=='string')throw new ConfigError('mapping keys must be strings');
  return parsed;
}

function parseYamlSubset(text){
  const lines=[];
  for(const [offset,raw] of text.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/).entries()){
    const prefix=raw.match(/^ */)[0];
    if(raw.slice(0,raw.length-raw.trimStart().length).includes('\t'))
      throw new ConfigError(`line ${offset+1}: tabs are not allowed for indentation`);
    const content=stripComment(raw.slice(prefix.length));
    if(content)lines.push([prefix.length,content,offset+1]);
  }
  if(lines.length===0)throw new ConfigError('configuration is empty');
  if(lines[0][0]!==0)throw new ConfigError(`line ${lines[0][2]}: root indentation must be zero`);
  function parseBlock(index,indent,depth=0){
    if(depth>256)throw new ConfigError('configuration nesting is too deep');
    if(index>=lines.length||lines[index][0]!==indent)throw new ConfigError('expected an indented mapping or list');
    const isList=lines[index][1]==='-'||lines[index][1].startsWith('- '),result=isList?[]:{};
    while(index<lines.length){
      const [currentIndent,content,lineNumber]=lines[index];
      if(currentIndent<indent)break;
      if(currentIndent>indent)throw new ConfigError(`line ${lineNumber}: unexpected indentation`);
      if(isList){
        if(!(content==='-'||content.startsWith('- ')))throw new ConfigError(`line ${lineNumber}: mixed mapping and list`);
        const itemText=content.slice(1).trim();let item;
        if(!itemText){
          if(index+1>=lines.length||lines[index+1][0]<=indent)throw new ConfigError(`line ${lineNumber}: empty list item`);
          [item,index]=parseBlock(index+1,lines[index+1][0],depth+1);
        }else{item=parseScalar(itemText);index++;}
        result.push(item);continue;
      }
      const colon=mappingColon(content);
      if(colon<0)throw new ConfigError(`line ${lineNumber}: expected 'key: value'`);
      const key=parseKey(content.slice(0,colon));
      if(Object.hasOwn(result,key))throw new ConfigError(`line ${lineNumber}: duplicate key ${JSON.stringify(key)}`);
      const itemText=content.slice(colon+1).trim();let item;
      if(itemText){item=parseScalar(itemText);index++;}
      else{
        if(index+1>=lines.length||lines[index+1][0]<=indent)throw new ConfigError(`line ${lineNumber}: missing value for ${JSON.stringify(key)}`);
        [item,index]=parseBlock(index+1,lines[index+1][0],depth+1);
      }
      define(result,key,item);
    }
    return [result,index];
  }
  const [value,index]=parseBlock(0,0);
  if(index!==lines.length)throw new ConfigError(`line ${lines[index][2]}: unexpected content`);
  return value;
}

function parseJsonStrict(text){
  let index=0;
  const whitespace=()=>{while(index<text.length&&/[ \t\r\n]/.test(text[index]))index++;};
  function value(depth=0){
    if(depth>256)throw new ConfigError('configuration nesting is too deep');
    whitespace();const start=index,character=text[index];
    if(character==='"'){
      index++;
      for(let escaped=false;index<text.length;index++){
        const current=text[index];
        if(escaped){escaped=false;continue;}
        if(current==='\\'){escaped=true;continue;}
        if(current==='"'){index++;try{return JSON.parse(text.slice(start,index));}catch(error){throw new ConfigError(`invalid JSON: ${error.message}`);}}
      }
      throw new ConfigError('invalid JSON: unterminated string');
    }
    if(character==='{'){
      index++;whitespace();const result={},keys=new Set();
      if(text[index]==='}'){index++;return result;}
      while(true){
        whitespace();if(text[index]!=='"')throw new ConfigError('invalid JSON: object key must be a string');
        const key=value(depth+1);if(keys.has(key))throw new ConfigError(`duplicate JSON object key ${JSON.stringify(key)}`);keys.add(key);
        whitespace();if(text[index++]!==':')throw new ConfigError("invalid JSON: expected ':'");
        define(result,key,value(depth+1));whitespace();
        if(text[index]==='}'){index++;return result;}
        if(text[index++]!==',')throw new ConfigError("invalid JSON: expected ',' or '}'");
      }
    }
    if(character==='['){
      index++;whitespace();const result=[];
      if(text[index]===']'){index++;return result;}
      while(true){result.push(value(depth+1));whitespace();if(text[index]===']'){index++;return result;}
        if(text[index++]!==',')throw new ConfigError("invalid JSON: expected ',' or ']'");}
    }
    for(const [literal,parsed] of [['true',true],['false',false],['null',null]]){
      if(text.startsWith(literal,index)){index+=literal.length;return parsed;}
    }
    const number=text.slice(index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if(number){
      index+=number[0].length;
      return /^-?(?:0|[1-9]\d*)$/.test(number[0])?BigInt(number[0]):Number(number[0]);
    }
    throw new ConfigError(`invalid JSON near byte ${index}`);
  }
  try{const parsed=value();whitespace();if(index!==text.length)throw new ConfigError(`invalid JSON near byte ${index}`);return parsed;}
  catch(error){if(error instanceof ConfigError)throw error;throw new ConfigError(`invalid JSON: ${error.message}`);}
}

function parseDocument(filePath,text){
  if(text.startsWith('\ufeff'))text=text.slice(1);
  return path.extname(filePath).toLowerCase()==='.json'?parseJsonStrict(text):parseYamlSubset(text);
}

function walkForSecrets(value,location='config'){
  if(object(value))for(const [key,item] of Object.entries(value)){
    if(SECRET_KEY.test(String(key)))throw new ConfigError(`${location}.${key}: credential fields are forbidden`);
    walkForSecrets(item,`${location}.${key}`);
  }else if(Array.isArray(value))value.forEach((item,index)=>walkForSecrets(item,`${location}[${index}]`));
  else if(typeof value==='string'&&SECRET_VALUE.test(value))throw new ConfigError(`${location}: secret-like values are forbidden`);
}

function requireMapping(value,location){if(!object(value))throw new ConfigError(`${location} must be a mapping`);return value;}
function rejectUnknown(mapping,allowed,location){
  const unknown=Object.keys(mapping).filter(key=>!allowed.has(key)).sort();
  if(unknown.length)throw new ConfigError(`${location} has unknown field(s): ${unknown.join(', ')}`);
}
function requireString(value,location,choices=null){
  if(typeof value!=='string'||!value.trim())throw new ConfigError(`${location} must be a non-empty string`);
  if(value.length>128||!IDENTIFIER.test(value))throw new ConfigError(`${location} contains unsupported characters`);
  if(choices&&!choices.has(value))throw new ConfigError(`${location} must be one of: ${[...choices].sort().join(', ')}`);
}

function validateRaw(value){
  const root=requireMapping(value,'config');rejectUnknown(root,new Set(['version','project','roles','policies']),'config');
  if(typeof root.version!=='bigint'||root.version!==1n)throw new ConfigError('config.version must equal integer 1');
  if(Object.hasOwn(root,'project')){
    const project=requireMapping(root.project,'config.project');rejectUnknown(project,new Set(['type','workflow']),'config.project');
    if(Object.hasOwn(project,'type'))requireString(project.type,'config.project.type',PROJECT_TYPES);
    if(Object.hasOwn(project,'workflow'))requireString(project.workflow,'config.project.workflow',WORKFLOWS);
  }
  if(Object.hasOwn(root,'roles')){
    const roles=requireMapping(root.roles,'config.roles');rejectUnknown(roles,ROLE_NAMES,'config.roles');
    for(const [role,rawRole] of Object.entries(roles)){
      const roleData=requireMapping(rawRole,`config.roles.${role}`),allowed=role==='external_expert'?EXTERNAL_FIELDS:ROLE_FIELDS;
      rejectUnknown(roleData,allowed,`config.roles.${role}`);
      for(const field of ['adapter','model','source'])if(Object.hasOwn(roleData,field))requireString(roleData[field],`config.roles.${role}.${field}`);
      if(role!=='external_expert'){
        if(roleData.adapter==='external-browser')throw new ConfigError(`config.roles.${role}.adapter cannot be external-browser; only external_expert may use the external browser`);
        if(roleData.adapter==='browser'&&role!=='browser_qa')throw new ConfigError(`config.roles.${role}.adapter browser is reserved for browser_qa`);
        if(roleData.source==='browser')throw new ConfigError(`config.roles.${role}.source browser is reserved for external_expert`);
      }
      if(Object.hasOwn(roleData,'enabled')&&typeof roleData.enabled!=='boolean')throw new ConfigError(`config.roles.${role}.enabled must be boolean`);
      if(Object.hasOwn(roleData,'activation'))requireString(roleData.activation,`config.roles.${role}.activation`,ACTIVATIONS);
      if(Object.hasOwn(roleData,'model_policy'))requireString(roleData.model_policy,`config.roles.${role}.model_policy`,MODEL_POLICIES);
    }
  }
  if(Object.hasOwn(root,'policies')){
    const policies=requireMapping(root.policies,'config.policies');
    rejectUnknown(policies,new Set(['tests','generate_cases','auto_fix','delivery']),'config.policies');
    if(Object.hasOwn(policies,'tests')&&(!Array.isArray(policies.tests)||policies.tests.length===0
      ||policies.tests.some(item=>typeof item!=='string'||!TEST_KINDS.has(item))))
      throw new ConfigError('config.policies.tests must be a non-empty list of logic/commands/browser');
    if(Object.hasOwn(policies,'generate_cases')&&typeof policies.generate_cases!=='boolean')
      throw new ConfigError('config.policies.generate_cases must be boolean');
    if(Object.hasOwn(policies,'auto_fix'))requireString(policies.auto_fix,'config.policies.auto_fix',AUTO_FIX_POLICIES);
    if(Object.hasOwn(policies,'delivery'))requireString(policies.delivery,'config.policies.delivery',DELIVERY_MODES);
  }
}

function validateEffective(config){
  requireString(config.project.type,'project.type',PROJECT_TYPES);requireString(config.project.workflow,'project.workflow',WORKFLOWS);
  for(const [role,roleData] of Object.entries(config.roles)){
    requireString(roleData.adapter,`roles.${role}.adapter`,ADAPTERS);
    if(role!=='external_expert'){
      if(roleData.adapter==='external-browser')throw new ConfigError(`roles.${role}.adapter cannot be external-browser; only external_expert may use it`);
      if(roleData.adapter==='browser'&&role!=='browser_qa')throw new ConfigError(`roles.${role}.adapter browser is reserved for browser_qa`);
      if(roleData.source==='browser')throw new ConfigError(`roles.${role}.source browser is reserved for external_expert`);
    }
    requireString(roleData.model,`roles.${role}.model`);requireString(roleData.source,`roles.${role}.source`,SOURCES);
    if(role==='external_expert'){
      if(roleData.adapter!=='external-browser'||roleData.source!=='browser')
        throw new ConfigError('roles.external_expert must use adapter external-browser and source browser');
      if(typeof roleData.enabled!=='boolean')throw new ConfigError('roles.external_expert.enabled must be boolean');
      requireString(roleData.activation,'roles.external_expert.activation',ACTIVATIONS);
      requireString(roleData.model_policy,'roles.external_expert.model_policy',MODEL_POLICIES);
    }
  }
  if(!Array.isArray(config.policies.tests)||config.policies.tests.length===0)throw new ConfigError('policies.tests must be a non-empty list');
  if(config.policies.tests.some(item=>typeof item!=='string'||!TEST_KINDS.has(item)))throw new ConfigError('policies.tests contains an unsupported test kind');
  if(typeof config.policies.generate_cases!=='boolean')throw new ConfigError('policies.generate_cases must be boolean');
  requireString(config.policies.auto_fix,'policies.auto_fix',AUTO_FIX_POLICIES);
  requireString(config.policies.delivery,'policies.delivery',DELIVERY_MODES);
}

function expandUser(raw){
  if(raw==='~')return os.homedir();
  if(raw.startsWith(`~${path.sep}`))return path.join(os.homedir(),raw.slice(2));
  return raw;
}
function realDirectory(raw,label){
  try{const target=fs.realpathSync(path.resolve(expandUser(raw)));if(!fs.statSync(target).isDirectory())throw new Error();return target;}
  catch{throw new ConfigError(`${label} is not a directory: ${path.resolve(expandUser(raw))}`);}
}

export function findConfig(projectRoot){
  const root=realDirectory(projectRoot,'project root');
  const candidates=CONFIG_FILENAMES.map(name=>path.join(root,name)).filter(candidate=>{
    try{return fs.statSync(candidate).isFile();}catch{return false;}
  });
  if(candidates.length>1)throw new ConfigError(`multiple CM workflow configs found: ${candidates.map(candidate=>path.basename(candidate)).join(', ')}`);
  return candidates[0]??null;
}

export function loadConfig(input){
  if(!object(input)||!Object.hasOwn(input,'projectRoot')
    ||Object.keys(input).some(key=>!['projectRoot','configPath','text'].includes(key)))throw new ConfigError('invalid config input');
  const root=realDirectory(input.projectRoot,'project root');
  let configPath=Object.hasOwn(input,'configPath')?path.resolve(expandUser(input.configPath)):findConfig(root);
  let text=Object.hasOwn(input,'text')?input.text:null;
  if(text===null&&configPath===null)return clone(DEFAULT_CONFIG);
  if(text===null){
    try{
      const stat=fs.statSync(configPath);if(!stat.isFile())throw new Error('not-file');
      if(stat.size>MAX_CONFIG_BYTES)throw new ConfigError(`configuration file exceeds ${MAX_CONFIG_BYTES} bytes: ${configPath}`);
      const bytes=fs.readFileSync(configPath);text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
    }catch(error){if(error instanceof ConfigError)throw error;throw new ConfigError(`cannot read configuration ${configPath}: ${error.message}`);}
  }else{
    if(typeof text!=='string')throw new ConfigError('configuration text must be a string');
    configPath??='.cm-workflow.yml';
  }
  if(SECRET_VALUE.test(text))throw new ConfigError('configuration contains a secret-like value');
  try{
    const raw=parseDocument(configPath,text);walkForSecrets(raw);validateRaw(raw);
    const normalizedRaw={...raw,version:Number(raw.version)};
    const effective=deepMerge(DEFAULT_CONFIG,normalizedRaw),policy=effective.roles.external_expert.model_policy;
    if(Object.hasOwn(MODEL_POLICY_ALIASES,policy))effective.roles.external_expert.model_policy=MODEL_POLICY_ALIASES[policy];
    validateEffective(effective);return effective;
  }catch(error){if(error instanceof ConfigError)throw error;if(error instanceof RangeError)throw new ConfigError('configuration nesting is too deep');throw error;}
}

function routeState(adapter,runtime){
  if(adapter==='current-ai')return 'current-runtime';
  if(adapter==='local')return 'local-tool';
  if(adapter==='browser')return 'local-browser';
  if(adapter==='external-browser')return 'external-expert';
  if((runtime==='codex'&&adapter==='codex-cli')||(runtime==='claude'&&adapter==='claude-cli'))return 'current-runtime';
  return 'declared-adapter';
}
export function resolveRole(config,role,runtime='unknown'){
  if(!ROLE_NAMES.has(role))throw new ConfigError(`unknown workflow role: ${role}`);
  if(!RUNTIMES.has(runtime))throw new ConfigError(`unknown runtime: ${runtime}`);
  if(!object(config?.roles)||!object(config.roles[role]))throw new ConfigError(`roles.${role} is missing from the effective config`);
  const result={role,...clone(config.roles[role]),runtime};
  result.route_state=role==='external_expert'&&result.enabled===false?'disabled':routeState(String(result.adapter),runtime);
  return result;
}

function stableJson(value){
  const stable=item=>Array.isArray(item)?item.map(stable):object(item)
    ?Object.fromEntries(Object.keys(item).sort().map(key=>[key,stable(item[key])])):item;
  return JSON.stringify(stable(value));
}
function usage(){const program=process.env.CM_COMPAT_PROGRAM||'cm-workflow-config.mjs';
  return `usage: ${program} [--project PATH] [--config PATH] [--role ROLE] [--runtime RUNTIME] [--print-role] [--print-effective]`;}
const LONG_OPTIONS=Object.freeze(['--project','--config','--role','--runtime','--print-role','--print-effective','--help']);
function resolveLongOption(flag){
  if(LONG_OPTIONS.includes(flag))return flag;
  if(!flag.startsWith('--'))return flag;
  const matches=LONG_OPTIONS.filter(option=>option.startsWith(flag));
  if(matches.length===1)return matches[0];
  throw new ConfigError('invalid arguments');
}
function parseCli(argv){
  const result={project:process.cwd(),runtime:'unknown',printRole:false,printEffective:false};
  for(let index=0;index<argv.length;index++){
    const argument=argv[index];
    const equals=argument.indexOf('=');
    const flag=resolveLongOption(equals>=0?argument.slice(0,equals):argument);
    const attached=equals>=0?argument.slice(equals+1):null;
    if((flag==='--help'||flag==='-h')&&attached===null)return {help:true};
    if(flag==='--print-role'&&attached===null){result.printRole=true;continue;}
    if(flag==='--print-effective'&&attached===null){result.printEffective=true;continue;}
    const key={'--project':'project','--config':'config','--role':'role','--runtime':'runtime'}[flag];
    if(!key)throw new ConfigError('invalid arguments');
    if(attached!==null){
      if(!attached&&!['project','config'].includes(key))throw new ConfigError('invalid arguments');
      result[key]=attached;continue;
    }
    if(index+1>=argv.length||(argv[index+1].length>1&&argv[index+1].startsWith('-')))
      throw new ConfigError('invalid arguments');
    result[key]=argv[++index];
  }
  if(Object.hasOwn(result,'role')&&!ROLE_NAMES.has(result.role))throw new ConfigError(`invalid role: ${result.role}`);
  if(!RUNTIMES.has(result.runtime))throw new ConfigError(`invalid runtime: ${result.runtime}`);
  return result;
}

export function main(argv=process.argv.slice(2)){
  let args;
  try{args=parseCli(argv);}catch(error){process.stderr.write(`${usage()}\nFAIL: ${error.message}\n`);return 2;}
  if(args.help){process.stdout.write(`${usage()}\n`);return 0;}
  let config;
  try{config=loadConfig({projectRoot:args.project,...(args.config?{configPath:args.config}:{})});}
  catch(error){process.stderr.write(`FAIL: ${error.message}\n`);return 1;}
  if(args.printRole&&!args.role){process.stderr.write('FAIL: --print-role requires --role\n');return 2;}
  if(args.role){
    const role=resolveRole(config,args.role,args.runtime),body=stableJson(role);
    process.stdout.write(args.printRole?`${body}\n`:`workflow role: ${body}\n`);
  }else if(args.printEffective)process.stdout.write(`${stableJson(config)}\n`);
  else process.stdout.write('workflow config: PASSED\n');
  return 0;
}

function isMainModule(entry){
  if(!entry)return false;
  try{return fs.realpathSync(entry)===fileURLToPath(import.meta.url);}catch{return path.resolve(entry)===fileURLToPath(import.meta.url);}
}
if(isMainModule(process.argv[1]))process.exitCode=main();
