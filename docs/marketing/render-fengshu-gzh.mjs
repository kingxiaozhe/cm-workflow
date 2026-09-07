import fs from 'node:fs';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
const sourcePath = path.join(here, 'cm-workflow-launch-fengshu.md');
const outputPath = path.join(here, 'cm-workflow-launch-fengshu_排版_石墨极简风(graphite-minimal).html');

const raw = fs.readFileSync(sourcePath, 'utf8');
const withoutComment = raw.replace(/^<!--[\s\S]*?-->\s*/, '');
const withoutTitle = withoutComment.replace(/^#\s+.*\n+/, '');
const blocks = withoutTitle.trim().split(/\n\s*\n/).map((block) => block.trim()).filter(Boolean);

const esc = (value) => value
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;');

function inline(text) {
  const tokens = text.split(/(`[^`]+`|<https?:\/\/[^>]+>)/g).filter(Boolean);
  return tokens.map((token) => {
    if (token.startsWith('`') && token.endsWith('`')) {
      return `<span style="background:#F4F4F5;color:#27272A;padding:2px 7px;border-radius:3px;font-weight:700;font-size:14px;"><span leaf="">${esc(token.slice(1, -1))}</span></span>`;
    }
    if (token.startsWith('<http') && token.endsWith('>')) {
      const url = token.slice(1, -1);
      return `<a href="${esc(url)}" style="color:#27272A;text-decoration:none;border-bottom:2px solid #52525B;font-weight:600;"><span leaf="">${esc(url)}</span></a>`;
    }
    return `<span leaf="">${esc(token)}</span>`;
  }).join('');
}

function paragraph(text) {
  const bold = text.match(/^\*\*(.+)\*\*$/s);
  if (bold) {
    const isFinal = bold[1] === '看轮子。';
    const color = isFinal ? '#F97316' : '#52525B';
    return `  <section style="border-left:3px solid ${color};padding:16px 0 16px 24px;margin:0 10px 28px;">\n    <p style="font-size:${isFinal ? '22px' : '16px'};font-weight:800;color:#27272A;margin:0;line-height:1.7;letter-spacing:0.5px;">${inline(bold[1])}</p>\n  </section>`;
  }
  return `  <section style="padding:0 10px;">\n    <p style="margin:0 0 22px;font-size:15px;line-height:1.8;text-align:justify;color:#52525B;letter-spacing:0.3px;">${inline(text.replace(/\n+/g, ' '))}</p>\n  </section>`;
}

function image(block) {
  const match = block.match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
  if (!match) return null;
  return `  <section style="border:1px solid #E4E4E7;padding:4px;margin:0 10px 8px;">\n    <section style="margin:0;overflow:hidden;">\n      <span leaf=""><img src="${esc(match[2])}" alt="${esc(match[1])}" style="max-width:100%;height:auto;display:block;margin:0 auto;"></span>\n    </section>\n  </section>\n  <p style="font-size:12px;color:#A1A1AA;text-align:center;margin:0 10px 28px;letter-spacing:0.5px;"><span leaf="">— ${esc(match[1])}</span></p>`;
}

const chapters = [
  ['01', 'CASE STUDY', '还没起飞，先宣布落地'],
  ['02', 'FLIGHT PLAN', '给 AI 一张飞行检查单'],
  ['03', 'CROSS CHECK', '让另一个上下文复核'],
  ['04', 'EVIDENCE', '三类证据，一只黑匣子'],
  ['∞', 'THE END', '最后，只看轮子'],
];

function chapter(index, first = false) {
  const [number, tag, title] = chapters[index];
  return `  <section style="margin-top:${first ? '16px' : '56px'};margin-bottom:32px;padding:0 10px;">\n    <section style="position:relative;padding-bottom:20px;border-bottom:1px solid #E4E4E7;">\n      <p style="font-size:48px;font-weight:900;color:#E4E4E7;margin:0;line-height:1;letter-spacing:-2px;"><span leaf="">${number}</span></p>\n      <section style="margin-top:-8px;">\n        <p style="font-size:10px;color:#A1A1AA;font-weight:500;letter-spacing:3px;margin:0 0 6px;text-transform:uppercase;"><span leaf="">${tag}</span></p>\n        <h3 style="font-size:20px;font-weight:800;color:#27272A;margin:0;letter-spacing:0.5px;line-height:1.4;"><span leaf="">${title}</span></h3>\n      </section>\n    </section>\n  </section>`;
}

const coverIndex = blocks.findIndex((block) => block.includes('01-cover-touchdown.png'));
const coverBlock = coverIndex >= 0 ? blocks.splice(coverIndex, 1)[0] : '';
const cover = coverBlock ? image(coverBlock) : '';

const html = [];
html.push(`<section style="max-width:677px;margin:0 auto;background:#FFFFFF;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif;color:#52525B;line-height:1.8;letter-spacing:0.3px;overflow-x:hidden;">`);
html.push(`  <section style="margin:10px 10px 32px;padding:32px 24px 24px;border-top:1px solid #E4E4E7;border-bottom:1px solid #E4E4E7;background:#FFFFFF;">\n    <p style="font-size:11px;color:#A1A1AA;letter-spacing:2px;margin:0 0 18px;font-weight:400;"><span leaf="">QUOTE</span></p>\n    <p style="font-size:18px;font-weight:700;color:#27272A;margin:0;line-height:1.7;letter-spacing:0.5px;"><span leaf="">真正可怕的不是 AI 会犯错，而是它能把</span><span style="border-bottom:2px solid #F97316;"><span leaf="">半程记录</span></span><span leaf="">写成顺利抵达。</span></p>\n  </section>`);
if (cover) html.push(cover);
html.push(`  <section style="padding:0 10px 40px;">\n    <p style="font-size:11px;color:#A1A1AA;margin:0 0 16px;letter-spacing:2px;"><span leaf="">本文看点</span></p>\n    <section style="display:flex;justify-content:space-between;">\n      <section style="flex:1;background:#FAFAFA;border-top:1px solid #E4E4E7;padding:18px 12px 16px;margin-right:8px;">\n        <p style="font-size:11px;color:#A1A1AA;font-weight:500;margin:0 0 8px;letter-spacing:1px;"><span leaf="">01</span></p>\n        <p style="font-size:13px;font-weight:700;color:#27272A;margin:0;line-height:1.5;"><span leaf="">为什么“完成”必须有证据</span></p>\n      </section>\n      <section style="flex:1;background:#FAFAFA;border-top:1px solid #E4E4E7;padding:18px 12px 16px;margin-right:8px;">\n        <p style="font-size:11px;color:#A1A1AA;font-weight:500;margin:0 0 8px;letter-spacing:1px;"><span leaf="">02</span></p>\n        <p style="font-size:13px;font-weight:700;color:#27272A;margin:0;line-height:1.5;"><span leaf="">AI 的飞行检查单怎么走</span></p>\n      </section>\n      <section style="flex:1;background:#FAFAFA;border-top:1px solid #E4E4E7;padding:18px 12px 16px;">\n        <p style="font-size:11px;color:#A1A1AA;font-weight:500;margin:0 0 8px;letter-spacing:1px;"><span leaf="">03</span></p>\n        <p style="font-size:13px;font-weight:700;color:#27272A;margin:0;line-height:1.5;"><span leaf="">怎样留下可回看的黑匣子</span></p>\n      </section>\n    </section>\n  </section>`);

let chapterIndex = 0;
html.push(chapter(0, true));
for (const block of blocks) {
  if (block === '……') {
    chapterIndex += 1;
    html.push(`  <section style="padding:0 10px;">\n    <section style="height:1px;background:#E4E4E7;margin:0;"><span leaf=""><br></span></section>\n  </section>`);
    html.push(chapter(chapterIndex));
    continue;
  }
  const renderedImage = image(block);
  html.push(renderedImage ?? paragraph(block));
}

html.push(`  <section style="padding:12px 10px 0;">\n    <section style="text-align:center;margin:0 0 36px;">\n      <section style="display:flex;align-items:center;justify-content:center;">\n        <span style="height:1px;width:48px;background:#E4E4E7;margin-right:16px;"><span leaf=""><br></span></span>\n        <span style="font-size:10px;color:#A1A1AA;letter-spacing:4px;font-weight:500;"><span leaf="">END</span></span>\n        <span style="height:1px;width:48px;background:#E4E4E7;margin-left:16px;"><span leaf=""><br></span></span>\n      </section>\n    </section>\n  </section>`);
html.push('</section>');

fs.writeFileSync(outputPath, `${html.join('\n\n')}\n`, 'utf8');
console.log(outputPath);
