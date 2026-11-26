import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {rewriteText,rewriteTree} from './cm-rewrite-doc-links.mjs';
import {findBrokenDocLinks} from './cm-check-doc-links.mjs';
import {SCOPE_FILE,scopeText,MAX_DOC_BYTES,readBounded} from './cm-doc-links-shared.mjs';
const source=fileURLToPath(new URL('..',import.meta.url));
const tmp=t=>{const d=fs.mkdtempSync(path.join(os.tmpdir(),'cm-doc-links-'));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));return d;};
test('rewriteText 只改 ../ 开头的 docs 链接，不动项目自己的 docs/ 路径',()=>{
  assert.equal(rewriteText('[a](../../docs/x.md) [b](../../../docs/y.md#z) `docs/architecture.md`'),
    '[a](../../cm-workflow/docs/x.md) [b](../../../cm-workflow/docs/y.md#z) `docs/architecture.md`');
});
test('rewriteText 幂等',()=>{const once=rewriteText('[a](../../docs/x.md)');assert.equal(rewriteText(once),once);});
test('兼容布局：改写后链接可达，未改写时被检查拦下',t=>{
  const root=tmp(t);
  fs.mkdirSync(path.join(root,'skills/cm-s/references'),{recursive:true});
  fs.mkdirSync(path.join(root,'cm-workflow/docs'),{recursive:true});
  fs.writeFileSync(path.join(root,'cm-workflow/docs/g.md'),'x');
  fs.writeFileSync(path.join(root,'skills/cm-s/SKILL.md'),'[g](../../docs/g.md)');
  fs.writeFileSync(path.join(root,'skills/cm-s/references/r.md'),'[g](../../../docs/g.md#a) [w](https://e.com/docs/q.md)');
  fs.writeFileSync(path.join(root,SCOPE_FILE),scopeText(root));
  assert.equal(findBrokenDocLinks(root).length,2);
  assert.equal(rewriteTree(root).length,2);
  assert.deepEqual(findBrokenDocLinks(root),[]);
});
test('源码布局：所有技能 docs 链接可达',()=>{assert.deepEqual(findBrokenDocLinks(source),[]);});
test('命令行入口在含空格的路径下真的执行：改写后检查通过，缺文档时非 0 退出',t=>{
  const root=path.join(tmp(t),'with space');
  fs.mkdirSync(path.join(root,'skills/cm-x'),{recursive:true});fs.mkdirSync(path.join(root,'cm-workflow/docs'),{recursive:true});
  fs.writeFileSync(path.join(root,'cm-workflow/docs/g.md'),'x');
  fs.writeFileSync(path.join(root,'skills/cm-x/SKILL.md'),'[g](../../docs/g.md) `../../docs/g.md`\n```md\n[e](../../docs/none.md)\n```\n[ext](https://e.com/a/../docs/q.md)');
  const run=(script,...args)=>spawnSync(process.execPath,[path.join(source,'scripts',script),...args],{encoding:'utf8'});
  assert.equal(run('cm-check-doc-links.mjs',root).status,1);
  const r=run('cm-rewrite-doc-links.mjs',root);assert.equal(r.status,0);assert.match(r.stdout,/已改写 1 个/);
  const text=fs.readFileSync(path.join(root,'skills/cm-x/SKILL.md'),'utf8');
  assert.match(text,/\]\(\.\.\/\.\.\/cm-workflow\/docs\/g\.md\)/);
  assert.match(text,/\(\.\.\/\.\.\/docs\/none\.md\)/);
  assert.match(text,/https:\/\/e\.com\/a\/\.\.\/docs\/q\.md/);
  assert.equal(run('cm-check-doc-links.mjs',root).status,0);
  fs.unlinkSync(path.join(root,'cm-workflow/docs/g.md'));
  assert.equal(run('cm-check-doc-links.mjs',root).status,1);
  assert.notEqual(run('cm-rewrite-doc-links.mjs',path.join(root,'nope')).status,0);
});
test('范围清单：用户自装技能（含 cm- 开头）不归本包检查，清单里的技能照查',t=>{
  const root=tmp(t);fs.mkdirSync(path.join(root,'skills/cm-unrelated'),{recursive:true});fs.mkdirSync(path.join(root,'skills/cm-own'));fs.mkdirSync(path.join(root,'cm-workflow/docs'),{recursive:true});
  fs.writeFileSync(path.join(root,'skills/cm-own/SKILL.md'),'[g](../../cm-workflow/docs/none.md)');
  fs.writeFileSync(path.join(root,SCOPE_FILE),scopeText(root));// 此刻 cm-unrelated 还不存在
  fs.writeFileSync(path.join(root,'skills/cm-unrelated/SKILL.md'),'[g](../../docs/none.md)');
  assert.deepEqual(findBrokenDocLinks(root),['skills/cm-own/SKILL.md -> ../../cm-workflow/docs/none.md']);
});
test('范围清单被截断、为空、缺失、指向不存在文件时检查报错而不是静默通过',t=>{
  const root=tmp(t);fs.mkdirSync(path.join(root,'skills/cm-a'),{recursive:true});fs.mkdirSync(path.join(root,'skills/cm-b'));fs.mkdirSync(path.join(root,'cm-workflow/docs'),{recursive:true});
  fs.writeFileSync(path.join(root,'skills/cm-a/SKILL.md'),'x');fs.writeFileSync(path.join(root,'skills/cm-b/SKILL.md'),'x');
  assert.throws(()=>findBrokenDocLinks(root),/缺少范围清单/);
  const full=scopeText(root),scope=path.join(root,SCOPE_FILE);
  fs.writeFileSync(scope,full);assert.deepEqual(findBrokenDocLinks(root),[]);
  fs.writeFileSync(scope,full.split('\n').slice(0,2).join('\n')+'\n');assert.throws(()=>findBrokenDocLinks(root),/截断/);
  fs.writeFileSync(scope,'');assert.throws(()=>findBrokenDocLinks(root),/截断/);
  fs.writeFileSync(scope,full.replace('skills/cm-b/SKILL.md','skills/cm-gone/SKILL.md'));assert.throws(()=>findBrokenDocLinks(root),/不存在/);
  fs.writeFileSync(scope,full.replace('skills/cm-b/SKILL.md','skills/../x.md'));assert.throws(()=>findBrokenDocLinks(root),/非法路径/);
});
test('技能文档超过读取上限时报错，不整份读入',t=>{
  const root=tmp(t);fs.mkdirSync(path.join(root,'skills/cm-a'),{recursive:true});fs.mkdirSync(path.join(root,'docs'));
  fs.writeFileSync(path.join(root,'skills/cm-a/SKILL.md'),'a'.repeat(MAX_DOC_BYTES+1));
  assert.throws(()=>findBrokenDocLinks(root),/上限/);
  assert.throws(()=>rewriteTree(root),/上限/);
});
test('带命令行后缀的反引号路径、引用块内的围栏都不被改写；收尾符正常的照改',()=>{
  const keep=['`../../docs/g.md --dry-run`','> ```md\n> [a](../../docs/a.md)\n> ```','>> ~~~\n>> `../../docs/b.md`\n>> ~~~'];
  for(const text of keep)assert.equal(rewriteText(text),text,text);
  assert.equal(rewriteText('`../../docs/g.md` [x](../../docs/y.md "标题") [z](../../docs/y.md#h)'),
    '`../../cm-workflow/docs/g.md` [x](../../cm-workflow/docs/y.md "标题") [z](../../cm-workflow/docs/y.md#h)');
});
test('外链查询参数、缩进围栏、四波浪号围栏、未闭合围栏都不被改写',()=>{
  const keep=['[x](https://e.com/v?next=../../docs/g.md)','  ```md\n[a](../../docs/a.md)\n  ```','~~~~\n[b](../../docs/b.md)\n~~~~','```\n[c](../../docs/c.md)'];
  for(const text of keep)assert.equal(rewriteText(text),text,text);
});
test('围栏逐行判断：引用块结束后围栏随之结束；普通围栏里带 > 的标记不算结束',()=>{
  assert.equal(rewriteText('> ```md\n> [a](../../docs/a.md)\n\n[b](../../docs/b.md)\n'),'> ```md\n> [a](../../docs/a.md)\n\n[b](../../cm-workflow/docs/b.md)\n');
  assert.equal(rewriteText('> ```\n> [a](../../docs/a.md)\n[lazy](../../docs/l.md)\n'),'> ```\n> [a](../../docs/a.md)\n[lazy](../../cm-workflow/docs/l.md)\n');
  const plain='```\n> ```\n[c](../../docs/c.md)\n```\n';assert.equal(rewriteText(plain),plain);
  const longer='````\n```\n[d](../../docs/d.md)\n````\n[e](../../docs/e.md)';assert.equal(rewriteText(longer),'````\n```\n[d](../../docs/d.md)\n````\n[e](../../cm-workflow/docs/e.md)');
});
test('兼容布局下根有用户自己的 docs/ 也不退回全量扫描；清单路径含反斜杠或 . 段被拒；超大清单被拒',t=>{
  const root=tmp(t);fs.mkdirSync(path.join(root,'skills/cm-a'),{recursive:true});fs.mkdirSync(path.join(root,'cm-workflow/docs'),{recursive:true});fs.mkdirSync(path.join(root,'docs'));
  fs.writeFileSync(path.join(root,'skills/cm-a/SKILL.md'),'x');
  assert.throws(()=>findBrokenDocLinks(root),/缺少范围清单/);
  const scope=path.join(root,SCOPE_FILE),head='# cm-workflow doc-links scope v1 count=1\n';
  for(const bad of ['skills\\..\\x.md','skills/./cm-a/SKILL.md','skills//cm-a/SKILL.md']){fs.writeFileSync(scope,head+bad+'\n');assert.throws(()=>findBrokenDocLinks(root),/非法路径/,bad);}
  fs.writeFileSync(scope,head+'skills/cm-a/SKILL.md\n'+'\n'.repeat(MAX_DOC_BYTES));assert.throws(()=>findBrokenDocLinks(root),/上限/);
});
test('readBounded 按实际读到的字节限量，不信 stat',t=>{
  const f=path.join(tmp(t),'a.md');fs.writeFileSync(f,'a'.repeat(100));
  assert.equal(readBounded(f,100).length,100);assert.throws(()=>readBounded(f,99),/上限/);
});
test('缩进 4 格的三反引号不是结束围栏；累计预算按实际字节算',t=>{
  const text='```\n    ```\n[c](../../docs/c.md)\n```\n';assert.equal(rewriteText(text),text);
  assert.equal(rewriteText('   ```\n[c](../../docs/c.md)\n   ```\n[d](../../docs/d.md)'),'   ```\n[c](../../docs/c.md)\n   ```\n[d](../../cm-workflow/docs/d.md)');
  const root=tmp(t);fs.mkdirSync(path.join(root,'skills/cm-a'),{recursive:true});fs.mkdirSync(path.join(root,'docs'));
  const bad=Buffer.alloc(900*1024,0xff),n=Math.floor(64*1024*1024/bad.length)-1;// 非法 UTF-8 解码后字符数远大于字节数
  for(let i=0;i<n;i++){fs.mkdirSync(path.join(root,'skills/cm-a/d'+i),{recursive:true});fs.writeFileSync(path.join(root,`skills/cm-a/d${i}/r.md`),bad);}
  assert.deepEqual(findBrokenDocLinks(root),[]);
});
test('行首 Tab 加三反引号不是结束围栏',()=>{
  const text='```\n\t```\n[c](../../docs/c.md)\n```\n';assert.equal(rewriteText(text),text);
});
