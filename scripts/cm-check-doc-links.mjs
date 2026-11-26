#!/usr/bin/env node
// 校验本包技能 *.md 里指向 docs 的相对引用（Markdown 链接和反引号路径）在当前安装布局下可达。
// 插件/源码布局 docs 在根目录；Claude 兼容布局在 cm-workflow/docs（安装时已改写）。
import { existsSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { listDocRefs, makeBoundedReader, managedSkillMarkdown, mapOutsideFences } from './cm-doc-links-shared.mjs';

export function findBrokenDocLinks(root) {
  const broken = [];
  const read = makeBoundedReader();
  for (const file of managedSkillMarkdown(root)) {
    mapOutsideFences(read(file), (part) => {
      for (const m of listDocRefs(part)) {
        const target = m.up + (m.done || '') + m.rest;
        if (!existsSync(resolve(dirname(file), target))) broken.push(`${relative(root, file)} -> ${target}`);
      }
      return part;
    });
  }
  return broken;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let broken;
  try { broken = findBrokenDocLinks(resolve(process.argv[2] || '.')); } catch (e) { console.error(`broken docs link: ${e.message}`); process.exit(1); }
  for (const b of broken) console.error(`broken docs link: ${b}`);
  process.exit(broken.length ? 1 : 0);
}
