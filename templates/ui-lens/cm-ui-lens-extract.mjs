// cm-ui-lens-extract — UI 还原的对表裁判(双用途,零模型零幻觉)
// 跑在基准页(HTML 原型/Stitch 导出)= 逐元素规格表;跑在还原页 = 实测表。
// 两表对差 = 页面内循环的依据;同脚本双跑 = 多镜头验收的数据层。
// 用法: node cm-ui-lens-extract.mjs {URL或文件路径} {输出.json} [宽度=1280]
// 依赖解析照抄项目既有测试基建的惯例(npm root -g 兜底,勿自造)。
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { writeFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { execSync } from "node:child_process";
const require = createRequire(import.meta.url);
function loadPlaywright() {
  const c = ["playwright"];
  try { c.push(join(execSync("npm root -g", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(), "playwright")); } catch {}
  for (const x of c) { try { return require(x); } catch {} }
  console.error("Playwright 不可用 — 按 skill 降级路径处理"); process.exit(2);
}
const { chromium } = loadPlaywright();
const target = process.argv[2]; const out = process.argv[3] || "lens.json";
const width = parseInt(process.argv[4] || "1280", 10);
const url = existsSync(target) ? pathToFileURL(resolve(target)).href : target;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
await page.goto(url, { waitUntil: "networkidle" });
const data = await page.evaluate(() => {
  const seen = [];
  const path = (el) => {
    const parts = [];
    for (let e = el; e && e !== document.body; e = e.parentElement) {
      let p = e.tagName.toLowerCase();
      if (e.id) { parts.unshift(p + "#" + e.id); break; }
      if (e.className && typeof e.className === "string") p += "." + e.className.trim().split(/\s+/).slice(0, 2).join(".");
      const sib = e.parentElement ? [...e.parentElement.children].filter(x => x.tagName === e.tagName) : [];
      if (sib.length > 1) p += ":nth(" + sib.indexOf(e) + ")";
      parts.unshift(p);
    }
    return parts.join(">");
  };
  for (const el of document.querySelectorAll("body *")) {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;              // 不可见不入表
    const cs = getComputedStyle(el);
    const hasText = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
    seen.push({
      sel: path(el),
      geo: { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) },
      font: hasText ? { family: cs.fontFamily.split(",")[0].trim(), size: cs.fontSize, weight: cs.fontWeight, lineHeight: cs.lineHeight, letterSpacing: cs.letterSpacing } : null,
      style: { color: cs.color, bg: cs.backgroundColor, radius: cs.borderRadius, shadow: cs.boxShadow !== "none" ? cs.boxShadow : null },
    });
  }
  return seen;
});
await browser.close();
writeFileSync(out, JSON.stringify({ url: target, viewport: width, count: data.length, elements: data }, null, 1));
console.log(`lens: ${data.length} 元素 → ${out}`);
