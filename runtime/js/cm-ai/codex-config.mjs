// Experimental B1 only; no global configuration changes and no provider fallback.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readReviewVerification,verificationTools} from '../cm-fix/review-verification-contract.mjs';
import {readReviewMaterialManifest} from './review-material.mjs';
import {externalEffort} from './external-models.mjs';

// Native profile, not an outer sandbox. Keep the built-in workspace protections.
// Reference: https://learn.chatgpt.com/docs/permissions (beta, checked locally).
export function specsPermissionArgs({cwd,specsRoot}) {
  for(const p of [cwd,specsRoot])if(typeof p!=='string'||!path.isAbsolute(p)
    ||path.resolve(p)!==p||fs.realpathSync(p)!==p||!fs.lstatSync(p).isDirectory())
    throw Object.assign(new Error('unsupported_path'),{code:'unsupported_path'});
  if(cwd===specsRoot||cwd.startsWith(specsRoot+path.sep))
    throw Object.assign(new Error('overlapping_roots'),{code:'overlapping_roots'});
  const q=JSON.stringify;
  const filesystem=`{${q(specsRoot)}="read",":workspace_roots"={"AGENTS.md"="read","CLAUDE.md"="read",".claude"="read"}}`;
  return ['-c','default_permissions="cm-specs"','-c',
    `permissions.cm-specs={extends=":workspace",filesystem=${filesystem},network={enabled=false}}`];
}

export const disabledFeatures = Object.freeze([
  'apps', 'browser_use', 'browser_use_external', 'browser_use_full_cdp_access',
  'computer_use', 'in_app_browser', 'hooks', 'plugins', 'remote_plugin',
  'shell_tool', 'unified_exec', 'shell_snapshot', 'multi_agent', 'goals',
  'memories', 'image_generation', 'code_mode_host', 'workspace_dependencies',
  'skill_mcp_dependency_install', 'tool_suggest',
]);

export function commonArgs({ cwd, model, effort, disabledSkills = [], verification = null, verificationTransport = null, material = null, materialTransport = null }) {
  if (!/^[a-zA-Z0-9._-]+$/.test(model)) throw new Error('invalid model');
  const args=['exec', '--ignore-user-config', '--strict-config', '--ephemeral',
    '--sandbox', 'read-only', '--skip-git-repo-check', '--cd', cwd, '--json',
    ...disabledFeatures.flatMap(name => ['--disable', name]),
    '-c', 'approval_policy="never"', '-c', 'web_search="disabled"',
    '-c', 'project_doc_max_bytes=0', '-c', 'mcp_servers={}',
    '-c', 'check_for_update_on_startup=false', '-c', 'analytics.enabled=false',
    '-c', `model="${model}"`, '-c', `model_reasoning_effort=${JSON.stringify(externalEffort('codex',effort))}`,
    // Codex 0.153.4 injects a <skills_instructions> catalog built from every skill root
    // (~/.codex/skills, ~/.agents/skills, ...) even with --ignore-user-config, skills.config
    // disables, skip_host_skill_discovery or --ignore-rules. Only this key removes the block.
    // Measured 2026-09-16 (empty cwd, no-op prompt): 18249 -> 11706 input tokens and no
    // "skills context budget" notice. skills.config stays as the per-folder defence.
    '-c', 'skills.include_instructions=false',
    '-c', `skills.config=[${[...disabledSkills].sort().map(folder =>
      `{path=${JSON.stringify(folder)},enabled=false}`).join(',')}]`];
  if(verification){
    const config=readReviewVerification(verification);
    if(!config.binaryReview)throw Object.assign(Error('unsupported_verification'),{code:'unsupported_verification'});
    const server=fileURLToPath(new URL('../cm-fix/review-verification-server.mjs',import.meta.url));
    let copy='CM_ISOLATED_REVIEW_COPY',configPath='CM_ISOLATED_REVIEW_CONFIG';
    if(verificationTransport){
      const transport=JSON.parse(verificationTransport.mcpConfig),mcp=transport?.mcpServers?.cm_review;
      copy=verificationTransport.cwd;
      if(Object.keys(transport).join(',')!=='mcpServers'||Object.keys(transport.mcpServers).join(',')!=='cm_review'
        ||!mcp||Object.keys(mcp).sort().join(',')!=='args,command'||mcp.command!==process.execPath
        ||!Array.isArray(mcp.args)||mcp.args.length!==2||mcp.args[0]!==server
        ||typeof copy!=='string'||!path.isAbsolute(copy)||fs.realpathSync(copy)!==copy
        ||path.basename(copy)!=='project'||!path.basename(path.dirname(copy)).startsWith('cm-review-verification-')
        ||mcp.args[1]!==path.join(path.dirname(copy),'tools.json'))
        throw Object.assign(Error('review_verification_transport_missing'),{code:'review_verification_transport_missing'});
      configPath=mcp.args[1];
    }
    args[args.indexOf('--cd')+1]=copy;
    const names=verificationTools(config).map(name=>name.slice('mcp__cm_review__'.length));
    args[args.indexOf('mcp_servers={}')]=`mcp_servers={cm_review={command=${JSON.stringify(process.execPath)},args=${JSON.stringify([server,configPath])},enabled_tools=${JSON.stringify(names)},required=true}}`;
    // Current models force code-mode-only tool metadata. Keep its execution host
    // provider disabled; only the fixed MCP namespace is callable directly.
    args.push('-c','features.code_mode={enabled=false,direct_only_tool_namespaces=["mcp__cm_review"]}',
      '-c','features.code_mode_host={enabled=false,disable_in_process_fallback=false}',
      '-c','agents.enabled=false','--disable','sleep_tool','--disable','view_image',
      '--disable','default_mode_request_user_input','-c','tools.experimental_request_user_input.enabled=false',
      '-c','mcp_optional_startup_grace_ms=0');
  }
  if(material){
    if(verification)throw Object.assign(Error('review_material_configuration'),{code:'review_material_configuration'});
    readReviewMaterialManifest(material);
    const server=fileURLToPath(new URL('./review-material-server.mjs',import.meta.url));
    let copy='CM_ISOLATED_MATERIAL_COPY',configPath='CM_ISOLATED_MATERIAL_CONFIG';
    if(materialTransport){
      const transport=JSON.parse(materialTransport.mcpConfig),mcp=transport?.mcpServers?.cm_review;
      copy=materialTransport.cwd;
      if(Object.keys(transport).join(',')!=='mcpServers'||Object.keys(transport.mcpServers).join(',')!=='cm_review'
        ||!mcp||Object.keys(mcp).sort().join(',')!=='args,command'||mcp.command!==process.execPath
        ||!Array.isArray(mcp.args)||mcp.args.length!==2||mcp.args[0]!==server
        ||typeof copy!=='string'||!path.isAbsolute(copy)||fs.realpathSync(copy)!==copy
        ||path.basename(copy)!=='project'||!path.basename(path.dirname(copy)).startsWith('cm-review-material-')
        ||mcp.args[1]!==path.join(path.dirname(copy),'tools.json'))
        throw Object.assign(Error('review_material_transport'),{code:'review_material_transport'});
      configPath=mcp.args[1];
    }
    args[args.indexOf('--cd')+1]=copy;
    args[args.indexOf('mcp_servers={}')]=`mcp_servers={cm_review={command=${JSON.stringify(process.execPath)},args=${JSON.stringify([server,configPath])},enabled_tools=["read_material"],required=true}}`;
    // At most16KiB source/page; JSON escapes can expand it sixfold. This
    // material-only envelope prevents native tool-result truncation.
    args.push('-c','tool_output_token_limit=131072');
    args.push('-c','features.code_mode={enabled=false,direct_only_tool_namespaces=["mcp__cm_review"]}',
      '-c','features.code_mode_host={enabled=false,disable_in_process_fallback=false}',
      '-c','agents.enabled=false','--disable','sleep_tool','--disable','view_image',
      '--disable','default_mode_request_user_input','-c','tools.experimental_request_user_input.enabled=false',
      '-c','mcp_optional_startup_grace_ms=0');
  }
  return args;
}

export function configFingerprint(options) {
  if(options.material)return createHash('sha256').update(JSON.stringify({cwd:options.cwd,args:commonArgs({...options,materialTransport:null}),material:readReviewMaterialManifest(options.material)})).digest('hex');
  if(options.verification)return createHash('sha256').update(JSON.stringify({cwd:options.cwd,
    args:commonArgs({...options,verificationTransport:null}),verification:readReviewVerification(options.verification)})).digest('hex');
  return createHash('sha256').update(JSON.stringify(commonArgs(options))).digest('hex');
}

export function cleanEnvironment() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL', 'CODEX_HOME'].includes(key)));
}
