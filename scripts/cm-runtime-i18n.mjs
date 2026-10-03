// Human-readable runtime text only; persisted keys and preset identifiers stay stable.
export function runtimeLanguage(env=process.env,intlLocale=()=>Intl.DateTimeFormat().resolvedOptions().locale){
  if(['zh','en'].includes(env.CM_WORKFLOW_LANG))return env.CM_WORKFLOW_LANG;
  const locale=env.LC_ALL||env.LC_MESSAGES||env.LANG;
  if(locale)return /^zh/i.test(locale)?'zh':'en';
  try{return /^zh/i.test(intlLocale()||'')?'zh':'en';}catch{return 'en';}
}
export const messages={
  menu:{zh:'运行时配置：[1] 保留当前配置（推荐，默认） [2] 修改运行时预设 [3] 查看高级模型配置说明 [1]: ',en:'Runtime configuration: [1] Keep current configuration (recommended, default) [2] Change runtime preset [3] Advanced model configuration [1]: '},
  kept:{zh:'已保留当前配置，未写入文件。\n',en:'Kept current configuration; no files written.\n'},
  builtin:{zh:'内置默认（未声明）',en:'Built-in defaults (undeclared)'},
  tools:{zh:'你手上有哪个 AI 工具？[1] 只有 Codex [2] 只有 Claude [3] 两个都有: ',en:'Which AI tools do you have? [1] Codex only [2] Claude only [3] Both: '},
  coder:{zh:'谁写代码？[1] Codex（Claude 审，推荐） [2] Claude（Codex 审）: ',en:'Who writes code? [1] Codex (Claude reviews, recommended) [2] Claude (Codex reviews): '},
  scope:{zh:'改哪一层？[1] 当前项目（{project}） [2] 用户级默认（{user}） [{default}]: ',en:'Which scope? [1] Current project ({project}) [2] User default ({user}) [{default}]: '},
  create:{zh:'将从模板新建项目配置：{file}\n',en:'Will create project configuration from the template: {file}\n'},
  current:{zh:'当前用户级默认: {available} / {preset}\n',en:'Current user default: {available} / {preset}\n'},
  invalid:{zh:'当前用户级默认无效（{file}）: {error}；文件已保留，请先修正后重试。\n',en:'Invalid user default ({file}): {error}; file preserved. Correct it before retrying.\n'},
  keep:{zh:'保留？[Y/n] ',en:'Keep it? [Y/n] '},
  configure:{zh:'现在配置用户默认？可跳过，稍后用 cm-runtime 配置。[y/N] ',en:'Configure a user default now? Optional; use cm-runtime later. [y/N] '},
  preview:{zh:'将写入: {file}\n范围: {scope}\n预设: {preset}\n写入字段（当前值 -> 候选值）:\n{fields}\n影响: {impact}\n当前项目有效值:\n{current}\n保存后当前项目有效值:\n{effective}\n',en:'Will write: {file}\nScope: {scope}\nPreset: {preset}\nFields to write (current -> candidate):\n{fields}\nImpact: {impact}\nCurrent project effective values:\n{current}\nProject effective values after saving:\n{effective}\n'},
  overridden:{zh:'项目已声明 runtimes.available，当前项目继续使用项目声明；用户默认仅供未声明的项目继承。已有 run 不变。',en:'The project declares runtimes.available and overrides this user default; only undeclared projects inherit it. Existing runs unchanged.'},
  userImpact:{zh:'只影响未声明 runtimes.available 的项目；项目显式角色字段仍优先，其他项目须各自校验。已有 run 不变。',en:'Applies only to projects without runtimes.available; explicit project role fields still win. Other projects require their own validation. Existing runs unchanged.'},
  projectImpact:{zh:'当前项目将使用此声明，只影响新 run。模型别名和其他已有字段保留。',en:'This project will use the declaration for new runs. Model aliases and other existing fields are retained.'},
  notProject:{zh:'安装器只配置用户默认，未核对任何项目的有效值。',en:'Installer configures user defaults only; no project effective values were checked.'},
  modelWarning:{zh:'模型别名原样保留；更换 adapter 后，非默认模型未必兼容。校验通过仅证明配置合同有效，不证明模型可调用或配额可用。\n',en:'Model aliases are retained; a non-default model may be incompatible with a changed adapter. Validation proves the configuration contract only, not model access or quota.\n'},
  drift:{zh:'预览后的配置已改变: {file}；未保存，请重新预览并确认。',en:'Configuration changed after preview: {file}; not saved. Generate a fresh preview and confirm again.'},
  advanced:{zh:'高级模型配置说明：建议保留当前默认，仅在有明确需要时手工编辑项目 .cm-workflow.yml 的模型别名。\n合同说明: {doc}\n校验: node "{validator}" --project "<项目路径>" --print-effective\n校验不证明 provider 兼容或配额可用；预设切换保留模型别名。\nunset --user 只删除用户默认，项目声明仍优先，不是恢复所有默认值。\n',en:'Advanced model configuration: keep current defaults unless you have a specific need; edit model aliases manually in the project .cm-workflow.yml.\nContract: {doc}\nValidate: node "{validator}" --project "<project path>" --print-effective\nValidation does not prove provider compatibility or quota; preset changes preserve model aliases.\nunset --user removes only user defaults; project declarations still win. It is not a reset of all settings.\n'},
  absent:{zh:'未声明',en:'Undeclared'},
  confirm:{zh:'确认？[y/N] ',en:'Confirm? [y/N] '},
  cancelled:{zh:'已放弃，未修改运行时声明。\n',en:'Cancelled; runtime declaration unchanged.\n'},
  installed:{zh:'✓ 用户级运行时默认已写入 {file} ({preset})\n',en:'✓ User runtime default saved to {file} ({preset})\n'},
  comment:{zh:'用 cm-runtime set --user <preset> 修改用户级默认。',en:'Use cm-runtime set --user <preset> to change the user default.'},
  declared:{zh:'（已声明未派发）',en:' (declared, not dispatched)'},
  cli:{zh:'{runtime} CLI: 可解析（可解析≠配额可用）',en:'{runtime} CLI: resolvable (presence does not prove quota)'},
  warning:{zh:'WARN: runtimes.available 声明 {available}，但本机 {runtime} CLI 不可解析（可解析≠配额可用）',en:'WARN: runtimes.available declares {available}, but {runtime} CLI is not resolvable (presence does not prove quota)'},
  saved:{zh:'已保存 {file}: {preset} ({source})；已有 run 不变',en:'Saved {file}: {preset} ({source}); existing runs unchanged'},
  removed:{zh:'已删除用户默认: {file}；项目声明仍优先',en:'Removed user default: {file}; project declarations still take precedence'},
  help:{zh:'cm-runtime [--project PATH]：无参数在 TTY 下先查看配置，默认保留；非 TTY 显示用法并退出 2。',en:'cm-runtime [--project PATH]: no command shows current configuration in a TTY and defaults to keeping it; non-TTY prints usage and exits 2.'},
  failed:{zh:'运行时声明未完成: {error}',en:'Runtime declaration incomplete: {error}'},
};
export function runtimeText(key,lang=runtimeLanguage(),values={}){
  return messages[key][lang].replace(/\{(\w+)\}/g,(_,name)=>String(values[name]??`{${name}}`));
}
