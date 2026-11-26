// 改写与检查共用同一套“哪些是指向本包 docs 的相对引用”的识别规则，避免两边漂移。
import { closeSync, existsSync, lstatSync, openSync, readSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// 范围清单：安装器在暂存目录生成、随包装入 <根>/cm-workflow/，列出本包自带的 skills/**/*.md。
// 检查只看清单里的文件，所以用户自装的技能（含同样以 cm- 开头的）不会被误判；
// 两个安装器（含不生成安装清单的 PowerShell）用同一份，不依赖安装清单的发布时机。
export const SCOPE_FILE = 'cm-workflow/doc-links-scope.txt';
const SCOPE_HEADER = '# cm-workflow doc-links scope v1';
// 单个技能文档读取上限；超过按错误处理，不整份读进内存（与快照的预算同口径）。
export const MAX_DOC_BYTES = 1024 * 1024;
export const MAX_TOTAL_BYTES = 64 * 1024 * 1024;

// 只认两种写法：Markdown 链接目标 ](…) 和整段反引号路径 `…`，且路径后必须紧跟收尾符：
//   链接：) 或 # 或 空白+标题；反引号：` 或 #。
// 外链（https://x/?next=../../docs/y）、普通文字、带命令行后缀的反引号（`../docs/g.md --dry-run`）都不算。
// 兼容安装已改写形态 ../cm-workflow/docs/ 也要认，检查才能发现它指向的文档被删。
const PATH = String.raw`((?:\.\.\/)+)(cm-workflow\/)?(docs\/[^\s)\`'"#>\]]*)`;
const DOC_REF = new RegExp(
  String.raw`(?<=\]\()` + PATH + String.raw`(?=[)#]|\s+["'(])|(?<=\`)` + PATH + String.raw`(?=[\`#])`,
  'g',
);

// 统一成 (上级前缀, 已含 cm-workflow/ 否, docs 路径) 回调；返回值替换原匹配。
export function replaceDocRefs(text, fn) {
  return text.replace(DOC_REF, (...a) => fn(a[1] ?? a[4], a[2] ?? a[5], a[3] ?? a[6], a[0]));
}
export function listDocRefs(text) {
  const out = [];
  replaceDocRefs(text, (up, done, rest, whole) => { out.push({ up, done, rest }); return whole; });
  return out;
}

// 围栏代码块（``` 或 ~~~，可缩进 0–3 格、可在引用块 > 内，结束围栏可更长，未闭合则到文末）里的示例不改、不查。
// 逐行判断：引用块层数（> 的个数）比开围栏时少，说明引用块已结束，围栏随之结束，该行按正文处理；
// 结束围栏必须与开围栏同字符、不短于它、层数相同、后面只有空白。
// 缩进总共至多 3 格：无引用块时只认开头的缩进；有引用块时 > 之后允许再缩进至多 3 格。
const LINE_PREFIX = /^(?:[ ]{0,3}((?:>[ \t]?)+)[ ]{0,3}|[ ]{0,3})/; // 缩进只数空格：Tab 占 4 列，已超上限
export function mapOutsideFences(text, fn) {
  let out = '';
  let plain = '';
  let fence = null; // {ch, len, depth}
  for (const line of text.split(/(?<=\n)/)) {
    const pm = line.match(LINE_PREFIX);
    const depth = ((pm[1] || '').match(/>/g) || []).length;
    const rest = line.slice(pm[0].length);
    if (fence && depth < fence.depth) fence = null;
    if (fence) {
      const close = rest.match(/^(`{3,}|~{3,})[ \t]*\r?\n?$/);
      if (depth === fence.depth && close && close[1][0] === fence.ch && close[1].length >= fence.len) fence = null;
      out += line;
      continue;
    }
    const open = rest.match(/^(`{3,}|~{3,})/);
    if (open) {
      out += fn(plain) + line;
      plain = '';
      fence = { ch: open[1][0], len: open[1].length, depth };
    } else plain += line;
  }
  return out + fn(plain);
}

function walk(dir, out) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) walk(p, out);
    else if (name.endsWith('.md')) out.push(p);
  }
}

// 暂存目录里 skills/ 全是本包的：改写与生成范围清单用它。
export function stagedSkillMarkdown(stageRoot) {
  const out = [];
  walk(join(stageRoot, 'skills'), out);
  return out;
}

export function scopeText(stageRoot) {
  const rel = stagedSkillMarkdown(stageRoot).map((p) => p.slice(stageRoot.length + 1).split('\\').join('/'));
  return `${SCOPE_HEADER} count=${rel.length}\n${rel.join('\n')}\n`;
}

// 本包管理的技能文档。
//  - 有范围清单：只取清单里的文件；头部数量与实际行数不符（被截断）、清单为空、清单里的文件缺失，都抛错，不静默跳过。
//  - 无清单且根下有 cm-workflow/docs（兼容安装布局；源码与插件根没有 cm-workflow/，与用户自己的 docs/ 无关）：抛错，因为无法区分本包与用户自装技能。
//  - 其余（源码、插件、安装暂存目录）：skills/ 全是本包的。
export function managedSkillMarkdown(root) {
  const scope = join(root, SCOPE_FILE);
  if (existsSync(scope)) {
    const lines = readBounded(scope, MAX_DOC_BYTES).split('\n').filter((l) => l !== '');
    const head = lines[0] && lines[0].match(/^# cm-workflow doc-links scope v1 count=(\d+)$/);
    const files = lines.slice(1);
    if (!head || Number(head[1]) !== files.length || files.length === 0) {
      throw new Error(`范围清单损坏或被截断: ${SCOPE_FILE}`);
    }
    return files.map((rel) => {
      if (!/^skills\/.+\.md$/.test(rel) || rel.includes('\\') || rel.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) throw new Error(`范围清单含非法路径: ${rel}`);
      const p = join(root, rel);
      if (!existsSync(p)) throw new Error(`范围清单里的文件不存在: ${rel}`);
      return p;
    });
  }
  if (existsSync(join(root, 'cm-workflow', 'docs'))) {
    throw new Error(`兼容安装缺少范围清单 ${SCOPE_FILE}，无法区分本包技能与自装技能；请重新安装`);
  }
  const out = [];
  walk(join(root, 'skills'), out);
  return out;
}

// 限量读取：最多读 limit+1 字节，超过 limit 即抛错；不依赖先 stat 再读（文件可能在两步之间变大）。
function readBuffer(file, limit) {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(limit + 1);
    let n = 0;
    for (;;) {
      const got = readSync(fd, buf, n, buf.length - n, null);
      if (got === 0) break;
      n += got;
      if (n > limit) throw new Error(`文件超过 ${limit} 字节上限: ${file}`);
    }
    return buf.subarray(0, n);
  } finally { closeSync(fd); }
}
export function readBounded(file, limit) { return readBuffer(file, limit).toString('utf8'); }

// 技能文档读取：单文件 MAX_DOC_BYTES，累计 MAX_TOTAL_BYTES，均按实际读到的字节算。
export function makeBoundedReader() {
  let total = 0;
  return (file) => {
    const buf = readBuffer(file, Math.min(MAX_DOC_BYTES, MAX_TOTAL_BYTES - total));
    total += buf.length; // 实际读到的字节数，不是解码后的字符数
    return buf.toString('utf8');
  };
}
