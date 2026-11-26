#!/usr/bin/env node
// Claude 兼容安装把 docs/ 装到 <根>/cm-workflow/docs/，而源码与插件安装里 docs/ 在根目录。
// 暂存目录里本包技能 *.md 的 ../docs/… 相对引用，在此改写成 ../cm-workflow/docs/…
// （实跑教训：0.21.5 兼容安装下约 18 处链接解析到不存在的 ~/.claude/docs）。
// 遍历失败直接抛错、退出码非 0，由安装器停止安装，不当作“改写了 0 个”。
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SCOPE_FILE, makeBoundedReader, mapOutsideFences, replaceDocRefs, scopeText, stagedSkillMarkdown } from './cm-doc-links-shared.mjs';

export function rewriteText(text) {
  return mapOutsideFences(text, (part) => replaceDocRefs(part, (up, done, rest, whole) => (done ? whole : `${up}cm-workflow/${rest}`)));
}

export function rewriteTree(stageRoot) {
  const changed = [];
  const read = makeBoundedReader();
  for (const f of stagedSkillMarkdown(stageRoot)) {
    const before = read(f);
    const after = rewriteText(before);
    if (after !== before) { writeFileSync(f, after); changed.push(f); }
  }
  // 暂存目录的 skills/ 全是本包的：把这份清单随包装入，检查只看清单里的文件。
  const scope = join(stageRoot, SCOPE_FILE);
  mkdirSync(dirname(scope), { recursive: true });
  writeFileSync(scope, scopeText(stageRoot));
  return changed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = process.argv[2];
  if (!root) { console.error('用法: cm-rewrite-doc-links.mjs <暂存目录>'); process.exit(2); }
  console.log(`已改写 ${rewriteTree(root).length} 个文件的 docs 相对链接`);
}
