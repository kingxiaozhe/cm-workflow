#!/usr/bin/env node
// 盘点 runtime 里「只能取这几个值」的枚举，逐个看测试有没有碰过。
//
// 为什么要有这个：一轮真实实跑里修掉的四个缺陷是同一个形状——文档承诺了某个选项，
// 代码里也确实有那条分支，但从来没有测试走过它。交付方式三选一只测了一种、统计表
// 列名「语义升级」只测了新名字、跨会话恢复一条都没有、iOS 软链接没测过。它们不是
// 被写坏的，是没人走过。这个脚本把同一形状的其余候选一次性列出来。
//
// 输出是候选，不是待办：内部记录类型和 typeof 判断也会被匹配到，人得自己分类。
// 分好类的结果见 docs/untested-branches.md；改完代码后重跑本脚本对照。
//
//   node scripts/audit-untested-enums.mjs            列出所有缺覆盖的枚举取值
//   node scripts/audit-untested-enums.mjs --summary  只报数字
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const summaryOnly=process.argv.includes('--summary');

const walk=dir=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(entry=>{
  const full=path.join(dir,entry.name);
  return entry.isDirectory()?walk(full):full.endsWith('.mjs')?[full]:[];
});

const tests=fs.readdirSync(path.join(root,'scripts'))
  .filter(name=>name.endsWith('.test.mjs'))
  .map(name=>fs.readFileSync(path.join(root,'scripts',name),'utf8')).join('\n');
const covered=value=>tests.includes(`'${value}'`)||tests.includes(`"${value}"`);

// 只认最常见的一种写法：['a','b'].includes(x)。漏掉别的写法好过误报一堆。
const pattern=/\[((?:'[a-z][a-z0-9_.-]*',\s*){1,8}'[a-z][a-z0-9_.-]*')\]\.includes\(/g;
const findings=[];
for(const file of walk(path.join(root,'runtime/js'))) {
  fs.readFileSync(file,'utf8').split('\n').forEach((line,index)=>{
    for(const match of line.matchAll(pattern)) {
      const values=match[1].split(',').map(value=>value.trim().slice(1,-1));
      const missing=values.filter(value=>!covered(value));
      if(missing.length)findings.push({file:path.relative(root,file),line:index+1,values,missing});
    }
  });
}

const values=new Set(findings.flatMap(finding=>finding.missing));
if(!summaryOnly) {
  const byModule=new Map();
  for(const finding of findings) {
    const module=finding.file.split('/')[2]??finding.file;
    byModule.set(module,[...(byModule.get(module)??[]),finding]);
  }
  for(const [module,list] of [...byModule].sort((a,b)=>b[1].length-a[1].length)) {
    process.stdout.write(`\n${module} (${list.length} 处)\n`);
    for(const finding of list)
      process.stdout.write(`  ${finding.file}:${finding.line}  缺 ${finding.missing.join(',')}`
        +`  枚举 ${finding.values.join('|')}\n`);
  }
  process.stdout.write('\n');
}
process.stdout.write(`缺覆盖的枚举取值 ${values.size} 个，分布在 ${findings.length} 处\n`);
