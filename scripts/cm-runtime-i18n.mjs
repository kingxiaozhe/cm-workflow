// Human-readable runtime text only; persisted keys and preset identifiers stay stable.
export function runtimeLanguage(env=process.env,intlLocale=()=>Intl.DateTimeFormat().resolvedOptions().locale){
  if(['zh','en'].includes(env.CM_WORKFLOW_LANG))return env.CM_WORKFLOW_LANG;
  const locale=env.LC_ALL||env.LC_MESSAGES||env.LANG;
  if(locale)return /^zh/i.test(locale)?'zh':'en';
  try{return /^zh/i.test(intlLocale()||'')?'zh':'en';}catch{return 'en';}
}
export const messages={
  tools:{zh:'你手上有哪个 AI 工具？[1] 只有 Codex [2] 只有 Claude [3] 两个都有: ',en:'Which AI tools do you have? [1] Codex only [2] Claude only [3] Both: '},
  coder:{zh:'谁写代码？[1] Codex（Claude 审，推荐） [2] Claude（Codex 审）: ',en:'Who writes code? [1] Codex (Claude reviews, recommended) [2] Claude (Codex reviews): '},
  scope:{zh:'改哪一层？[1] 当前项目（{project}） [2] 用户级默认（{user}） [{default}]: ',en:'Which scope? [1] Current project ({project}) [2] User default ({user}) [{default}]: '},
  create:{zh:'将从模板新建项目配置：{file}\n',en:'Will create project configuration from the template: {file}\n'},
  current:{zh:'当前用户级默认: {available} / {preset}\n',en:'Current user default: {available} / {preset}\n'},
  invalid:{zh:'当前用户级默认无效: {error}\n',en:'Invalid user default: {error}\n'},
  keep:{zh:'保留？[Y/n] ',en:'Keep it? [Y/n] '},
  preview:{zh:'将写入: {file}\n预设: {preset}\n当前值:\n{current}\n',en:'Will write: {file}\nPreset: {preset}\nCurrent value:\n{current}\n'},
  absent:{zh:'未声明',en:'Undeclared'},
  confirm:{zh:'确认？[Y/n] ',en:'Confirm? [Y/n] '},
  cancelled:{zh:'已放弃，未修改运行时声明。\n',en:'Cancelled; runtime declaration unchanged.\n'},
  installed:{zh:'✓ 用户级运行时默认已写入 {file} ({preset})\n',en:'✓ User runtime default saved to {file} ({preset})\n'},
  comment:{zh:'用 cm-runtime set --user <preset> 修改用户级默认。',en:'Use cm-runtime set --user <preset> to change the user default.'},
  declared:{zh:'（已声明未派发）',en:' (declared, not dispatched)'},
  cli:{zh:'{runtime} CLI: 可解析（可解析≠配额可用）',en:'{runtime} CLI: resolvable (presence does not prove quota)'},
  warning:{zh:'WARN: runtimes.available 声明 {available}，但本机 {runtime} CLI 不可解析（可解析≠配额可用）',en:'WARN: runtimes.available declares {available}, but {runtime} CLI is not resolvable (presence does not prove quota)'},
  saved:{zh:'已保存 {file}: {preset} ({source})；已有 run 不变',en:'Saved {file}: {preset} ({source}); existing runs unchanged'},
  removed:{zh:'已删除用户默认: {file}；项目声明仍优先',en:'Removed user default: {file}; project declarations still take precedence'},
  help:{zh:'cm-runtime [--project PATH]：无参数在 TTY 下进入交互向导；非 TTY 显示用法并退出 2。',en:'cm-runtime [--project PATH]: no command opens the interactive wizard in a TTY; non-TTY prints usage and exits 2.'},
  failed:{zh:'运行时声明未完成: {error}',en:'Runtime declaration incomplete: {error}'},
};
export function runtimeText(key,lang=runtimeLanguage(),values={}){
  return messages[key][lang].replace(/\{(\w+)\}/g,(_,name)=>String(values[name]??`{${name}}`));
}
