// Experimental B1 only; no global configuration changes and no provider fallback.
import { createHash } from 'node:crypto';

export const disabledFeatures = Object.freeze([
  'apps', 'browser_use', 'browser_use_external', 'browser_use_full_cdp_access',
  'computer_use', 'in_app_browser', 'hooks', 'plugins', 'remote_plugin',
  'shell_tool', 'unified_exec', 'shell_snapshot', 'multi_agent', 'goals',
  'memories', 'image_generation', 'code_mode_host', 'workspace_dependencies',
  'skill_mcp_dependency_install', 'tool_suggest',
]);

export function commonArgs({ cwd, model, disabledSkills = [] }) {
  if (!/^[a-zA-Z0-9._-]+$/.test(model)) throw new Error('invalid model');
  return ['exec', '--ignore-user-config', '--strict-config', '--ephemeral',
    '--sandbox', 'read-only', '--skip-git-repo-check', '--cd', cwd, '--json',
    ...disabledFeatures.flatMap(name => ['--disable', name]),
    '-c', 'approval_policy="never"', '-c', 'web_search="disabled"',
    '-c', 'project_doc_max_bytes=0', '-c', 'mcp_servers={}',
    '-c', 'check_for_update_on_startup=false', '-c', 'analytics.enabled=false',
    '-c', `model="${model}"`, '-c', 'model_reasoning_effort="high"',
    '-c', `skills.config=[${[...disabledSkills].sort().map(folder =>
      `{path=${JSON.stringify(folder)},enabled=false}`).join(',')}]`];
}

export function configFingerprint(options) {
  return createHash('sha256').update(JSON.stringify(commonArgs(options))).digest('hex');
}

export function cleanEnvironment() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL', 'CODEX_HOME'].includes(key)));
}
