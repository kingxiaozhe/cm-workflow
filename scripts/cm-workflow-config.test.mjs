import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const scriptsRoot=fileURLToPath(new URL('.',import.meta.url));
const entryPath=path.join(scriptsRoot,'cm-workflow-config.mjs');
const pythonPath=path.join(scriptsRoot,'cm_workflow_config.py');
const pythonExecutable=process.env.CM_PYTHON_BIN||'python3';

const validYaml=`version: 1
project:
  type: java-backend
  workflow: java-backend
roles:
  planner:
    adapter: claude-api
    model: claude-opus
    source: api
  coder:
    adapter: codex-cli
    model: gpt-5.6-sol
    source: subscription
  external_expert:
    enabled: true
    activation: explicit
    model_policy: pro-extra-high-high-skip
policies:
  tests:
    - logic
    - commands
  generate_cases: true
  auto_fix: explicit
  delivery: draft-mr`;

const fixture=async fn=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-workflow-config-js-')));
  try{return await fn(root);}finally{fs.rmSync(root,{recursive:true,force:true});}
};

test('JS config authority preserves defaults, YAML merge, canonical aliases, and route states',()=>fixture(async root=>{
  const api=await import('./cm-workflow-config.mjs');
  const defaults=api.loadConfig({projectRoot:root});
  assert.deepEqual(defaults,api.DEFAULT_CONFIG);
  assert.equal(api.resolveRole(defaults,'coder','codex').route_state,'current-runtime');
  assert.equal(api.resolveRole(defaults,'tester','codex').route_state,'local-tool');
  assert.equal(api.resolveRole(defaults,'browser_qa','codex').route_state,'local-browser');
  assert.equal(api.resolveRole(defaults,'external_expert','codex').route_state,'external-expert');

  const configPath=path.join(root,'.cm-workflow.yml');
  fs.writeFileSync(configPath,validYaml);
  const configured=api.loadConfig({projectRoot:root});
  assert.equal(configured.project.type,'java-backend');
  assert.equal(configured.roles.coder.adapter,'codex-cli');
  assert.deepEqual(configured.roles.analyst,api.DEFAULT_CONFIG.roles.analyst);
  assert.deepEqual(configured.policies.tests,['logic','commands']);
  assert.equal(api.resolveRole(configured,'planner','codex').route_state,'declared-adapter');

  const alias=api.loadConfig({projectRoot:root,configPath:path.join(root,'alias.yml'),
    text:'version: 1\nroles:\n  external_expert:\n    model_policy: strict-Pro\n'});
  assert.equal(alias.roles.external_expert.model_policy,'strict-pro');
  const disabled=api.loadConfig({projectRoot:root,configPath:path.join(root,'disabled.yml'),
    text:'version: 1\nroles:\n  external_expert:\n    enabled: false\n'});
  assert.equal(api.resolveRole(disabled,'external_expert','codex').route_state,'disabled');
}));

test('JS config authority rejects unsupported syntax, duplicate keys, secrets, and permission-shaped routes',()=>fixture(async root=>{
  const {ConfigError,loadConfig,resolveRole}=await import('./cm-workflow-config.mjs');
  const bad=(name,text)=>()=>loadConfig({projectRoot:root,configPath:path.join(root,name),text});
  for(const [name,text] of [
    ['unknown.yml','version: 1\nforbidden: true\n'],
    ['secret-key.yml','version: 1\napi_key: leaked\n'],
    ['secret-value.yml','version: 1\nroles:\n  coder:\n    model: sk-testvalue123\n'],
    ['secret-comment.yml','# sk-testvalue123\nversion: 1\n'],
    ['alias.yml','version: 1\nroles: &defaults\n  coder: *defaults\n'],
    ['external-coder.yml','version: 1\nroles:\n  coder:\n    adapter: external-browser\n    model: chatgpt-pro\n    source: browser\n'],
    ['browser-coder.yml','version: 1\nroles:\n  coder:\n    adapter: browser\n    model: none\n    source: local\n'],
    ['browser-source.yml','version: 1\nroles:\n  analyst:\n    adapter: current-ai\n    model: default\n    source: browser\n'],
    ['external-api.yml','version: 1\nroles:\n  external_expert:\n    adapter: claude-api\n    model: claude-opus\n    source: api\n'],
    ['persistent-auto.yml','version: 1\nroles:\n  external_expert:\n    activation: auto\n'],
    ['boolean-version.yml','version: true\n'],
    ['float-version.yml','version: 1.0\n'],
    ['duplicate.yml','version: 1\nproject: {type: auto, type: custom}\n'],
    ['duplicate.json','{"version":1,"project":{"type":"auto","type":"custom"}}'],
    ['exponent-version.json','{"version":1e0}'],
    ['nbsp-whitespace.json','{"version":\u00a01}'],
    ['form-feed-whitespace.json','{"version":\f1}'],
    ['bad-tests.yml','version: 1\npolicies:\n  tests:\n    - [logic]\n'],
  ])assert.throws(bad(name,text),ConfigError,name);
  assert.throws(()=>resolveRole(loadConfig({projectRoot:root}),'not-a-role'),ConfigError);
  assert.throws(()=>resolveRole(loadConfig({projectRoot:root}),'coder','other'),ConfigError);
}));

test('JS config authority preserves file discovery, BOM, size, UTF-8, and nesting boundaries',()=>fixture(async root=>{
  const {ConfigError,MAX_CONFIG_BYTES,loadConfig}=await import('./cm-workflow-config.mjs');
  const jsonPath=path.join(root,'.cm-workflow.json');
  fs.writeFileSync(jsonPath,JSON.stringify({version:1,project:{type:'web-frontend'}}));
  assert.equal(loadConfig({projectRoot:root}).project.type,'web-frontend');
  fs.rmSync(jsonPath);
  const bomPath=path.join(root,'.cm-workflow.yml');
  fs.writeFileSync(bomPath,'\ufeffversion: 1\nproject:\n  type: custom\n');
  assert.equal(loadConfig({projectRoot:root}).project.type,'custom');
  for(const separator of ['\r','\u2028']){
    const text=['version: 1','project:','  type: custom',''].join(separator);
    assert.equal(loadConfig({projectRoot:root,configPath:path.join(root,'lines.yml'),text}).project.type,'custom');
  }
  fs.writeFileSync(path.join(root,'.cm-workflow.yaml'),'version: 1\n');
  assert.throws(()=>loadConfig({projectRoot:root}),ConfigError);
  fs.rmSync(path.join(root,'.cm-workflow.yaml'));
  fs.writeFileSync(bomPath,Buffer.from([0xff,0xfe,0xfd]));
  assert.throws(()=>loadConfig({projectRoot:root}),ConfigError);
  fs.writeFileSync(bomPath,'version: 1\n#'+('x'.repeat(MAX_CONFIG_BYTES)));
  assert.throws(()=>loadConfig({projectRoot:root}),ConfigError);
  const deep=['version: 1'];
  for(let index=0;index<1100;index++)deep.push('  '.repeat(index)+`nested${index}:`);
  deep.push('  '.repeat(1100)+'value: 1');
  assert.throws(()=>loadConfig({projectRoot:root,configPath:path.join(root,'deep.yml'),text:deep.join('\n')}),ConfigError);
  assert.throws(()=>loadConfig({projectRoot:path.join(root,'missing')}),ConfigError);
}));

test('JS CLI is authoritative and Python CLI is an output-compatible forwarder',()=>fixture(root=>{
  const configPath=path.join(root,'.cm-workflow.json');
  fs.writeFileSync(configPath,JSON.stringify({version:1,project:{type:'web-frontend'}}));
  const cases=[
    ['--project',root,'--print-effective'],
    [`--project=${root}`,'--print-effective'],
    ['--project',root,'--role','coder','--runtime','codex','--print-role'],
    [`--project=${root}`,'--role=coder','--runtime=codex','--print-role'],
    ['--project',root],
    ['--project',root,'--print-role'],
  ];
  for(const args of cases){
    const js=spawnSync(process.execPath,[entryPath,...args],{encoding:'utf8'});
    const py=spawnSync(pythonExecutable,[pythonPath,...args],{encoding:'utf8'});
    assert.equal(py.status,js.status,args.join(' '));
    assert.equal(py.stdout,js.stdout,args.join(' '));
    assert.equal(py.stderr.replaceAll('cm_workflow_config.py','cm-workflow-config.mjs'),js.stderr,args.join(' '));
  }
  const help=spawnSync(pythonExecutable,[pythonPath,'--help'],{encoding:'utf8'});
  assert.equal(help.status,0);
  assert.match(help.stdout,/^usage: cm_workflow_config\.py \[-h\]/);
  assert.match(help.stdout,/Validate and print CM Workflow project configuration/);
  assert.match(help.stdout,/--role \{analyst,browser_qa,coder,external_expert,planner,reviewer,tester\}/);
  const invalidRole=spawnSync(pythonExecutable,[pythonPath,'--role','not-a-role','--print-role'],{encoding:'utf8'});
  assert.equal(invalidRole.status,2);
  assert.match(invalidRole.stderr,/^usage: cm_workflow_config\.py \[-h\]/);
  assert.match(invalidRole.stderr,/cm_workflow_config\.py: error: argument --role: invalid choice: 'not-a-role'/);
  const wrapper=fs.readFileSync(pythonPath,'utf8');
  assert(!wrapper.includes('DEFAULT_CONFIG'));
  assert(!wrapper.includes('_parse_yaml_subset'));
}));

test('frozen Python authority vectors preserve numeric token and equals-form behavior',()=>fixture(root=>{
  const configPath=path.join(root,'.cm-workflow.yml');
  for(const text of ['version: 1.0\n','version: 1e0\n']){
    fs.writeFileSync(configPath,text);
    const result=spawnSync(process.execPath,[entryPath,'--project',root],{encoding:'utf8'});
    assert.equal(result.status,1,text.trim());
  }
  fs.writeFileSync(configPath,'version: 1\n');
  const equals=spawnSync(process.execPath,[entryPath,`--project=${root}`,'--role=coder','--runtime=codex','--print-role'],{encoding:'utf8'});
  assert.equal(equals.status,0);
  assert.equal(JSON.parse(equals.stdout).route_state,'current-runtime');
  for(const args of [['--help=x'],['-h=x']]){
    const malformedHelp=spawnSync(process.execPath,[entryPath,...args],{encoding:'utf8'});
    assert.equal(malformedHelp.status,2,args.join(' '));
  }
  for(const args of [['--project','-h'],['--config','-x']]){
    const missingValue=spawnSync(process.execPath,[entryPath,...args],{encoding:'utf8'});
    assert.equal(missingValue.status,2,args.join(' '));
  }
  const abbreviated=spawnSync(process.execPath,[entryPath,`--proj=${root}`,'--print-effective'],{encoding:'utf8'});
  assert.equal(abbreviated.status,0);
  assert.equal(JSON.parse(abbreviated.stdout).version,1);
  const emptyProject=spawnSync(process.execPath,[entryPath,'--project=','--print-effective'],{encoding:'utf8',cwd:root});
  assert.equal(emptyProject.status,0);
  assert.equal(JSON.parse(emptyProject.stdout).version,1);
}));
