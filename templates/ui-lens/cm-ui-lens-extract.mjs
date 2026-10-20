// Rendered values only. Importing this module neither resolves nor launches a browser.
// Built-in browser: node cm-ui-lens-extract.mjs --page-script, then evaluate its result.
// The optional Playwright CLI is only for separately authorized automated fixtures:
// node cm-ui-lens-extract.mjs --browser playwright URL OUTPUT.json [WIDTH=1280]
import {createRequire} from 'node:module';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {writeFileSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {execFileSync} from 'node:child_process';

// Self-contained so a supported in-app-browser evaluate can use the same function.
// A channel is a source declaration. Geometry/style reads do not prove interaction coverage.
export function extractUiLens({document:doc=document,window:win=window,channel='codex-in-app'}={}){
  const elements=[];
  const selector=el=>{
    const parts=[];
    for(let e=el;e&&e!==doc.body;e=e.parentElement){
      let part=e.tagName.toLowerCase();
      if(e.id){parts.unshift(part+'#'+e.id);break;}
      if(e.className&&typeof e.className==='string')part+='.'+e.className.trim().split(/\s+/).slice(0,2).join('.');
      const siblings=e.parentElement?[...e.parentElement.children].filter(x=>x.tagName===e.tagName):[];
      // This is a stable element identifier retained from the existing extractor, not a CSS selector.
      if(siblings.length>1)part+=':nth('+siblings.indexOf(e)+')';parts.unshift(part);
    }return parts.join('>');
  };
  for(const el of doc.querySelectorAll('body *')){
    const rect=el.getBoundingClientRect();if(rect.width<1||rect.height<1)continue;
    const cs=win.getComputedStyle(el),hasText=[...el.childNodes].some(node=>node.nodeType===3&&node.textContent.trim());
    elements.push({sel:selector(el),geo:{x:+rect.x.toFixed(1),y:+rect.y.toFixed(1),w:+rect.width.toFixed(1),h:+rect.height.toFixed(1)},
      font:hasText?{family:cs.fontFamily.split(',')[0].trim(),size:cs.fontSize,weight:cs.fontWeight,lineHeight:cs.lineHeight,letterSpacing:cs.letterSpacing}:null,
      style:{color:cs.color,bg:cs.backgroundColor,radius:cs.borderRadius,shadow:cs.boxShadow!=='none'?cs.boxShadow:null,padding:cs.padding,margin:cs.margin,gap:cs.gap}});
  }
  return {source:'rendered-computed',channel,url:win.location.href,
    viewport:{width:win.innerWidth,height:win.innerHeight,deviceScaleFactor:win.devicePixelRatio||1},elements};
}
function playwright(){
  const require=createRequire(import.meta.url),candidates=['playwright'];
  try{candidates.push(join(execFileSync('npm',['root','-g'],{stdio:['ignore','pipe','ignore'],timeout:10000}).toString().trim(),'playwright'));}catch{}
  for(const candidate of candidates){try{return require(candidate);}catch{}}
  throw new Error('Playwright 不可用；不会自动安装。当前宿主应使用内置浏览器和 --page-script。');
}
export async function main(args=process.argv.slice(2)){
  if(args.length===1&&args[0]==='--page-script'){process.stdout.write(`(${extractUiLens.toString()})()\n`);return 0;}
  if(args[0]!=='--browser'||args[1]!=='playwright'||args.length<4||args.length>5){
    process.stderr.write('需要显式 --browser playwright URL OUTPUT.json [WIDTH]；内置浏览器使用 --page-script。\n');return 2;
  }
  const [,,target,out,widthText='1280']=args,width=Number(widthText);
  if(!Number.isInteger(width)||width<1||width>16384){process.stderr.write('视口宽度无效。\n');return 2;}
  let browser;
  try{
    const url=existsSync(target)?pathToFileURL(resolve(target)).href:target;
    browser=await playwright().chromium.launch();const page=await browser.newPage({viewport:{width,height:900},deviceScaleFactor:1});
    await page.goto(url,{waitUntil:'networkidle'});
    const data=await page.evaluate(`(${extractUiLens.toString()})({channel:'playwright'})`);
    writeFileSync(out,JSON.stringify(data,null,1));process.stdout.write(`lens: ${data.elements.length} 元素 → ${out}\n`);return 0;
  }catch(error){process.stderr.write(`${error.message}\n`);return 2;}
  finally{await browser?.close();}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))process.exitCode=await main();
