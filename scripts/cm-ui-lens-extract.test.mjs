import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const script=fileURLToPath(new URL('../templates/ui-lens/cm-ui-lens-extract.mjs',import.meta.url));
const source=fs.readFileSync(script,'utf8');
function safeEntry(){
  // Assert the old top-level-launch program is gone before importing or running it.
  assert.match(source,/export function extractUiLens/);
  assert.match(source,/if\(process\.argv\[1\]&&resolve\(process\.argv\[1\]\)===fileURLToPath\(import\.meta\.url\)\)process\.exitCode=await main\(\);/);
}
function sample(){
  const body={};const button={tagName:'BUTTON',id:'save',className:'primary',parentElement:body,childNodes:[{nodeType:3,textContent:'Save'}],getBoundingClientRect:()=>({x:2,y:3,width:50,height:24})};
  body.children=[button];
  const document={body,querySelectorAll:selector=>{assert.equal(selector,'body *');return [button];}};
  const window={innerWidth:390,innerHeight:844,devicePixelRatio:2,location:{href:'https://prototype.example/'},getComputedStyle:()=>({fontFamily:'Rounded, sans-serif',fontSize:'16px',fontWeight:'500',lineHeight:'24px',letterSpacing:'0px',color:'rgb(0, 0, 0)',backgroundColor:'rgba(255, 255, 255, 0.5)',borderRadius:'12px',boxShadow:'none',padding:'8px',margin:'0px',gap:'4px'})};
  return {document,window};
}
test('module import has no browser launch, Playwright resolution or file write',async()=>{
  safeEntry();const mod=await import('../templates/ui-lens/cm-ui-lens-extract.mjs');assert.equal(typeof mod.extractUiLens,'function');
  const sheet=mod.extractUiLens(sample());assert.equal(sheet.source,'rendered-computed');assert.equal(sheet.channel,'codex-in-app');
  assert.deepEqual(sheet.viewport,{width:390,height:844,deviceScaleFactor:2});assert.equal(sheet.elements[0].font.family,'Rounded');assert.equal(sheet.elements[0].style.gap,'4px');
  assert.equal(Object.hasOwn(sheet,'interaction'),false);
});
test('--page-script exports self contained renderer function for an authorized browser evaluate',()=>{
  safeEntry();const result=spawnSync(process.execPath,[script,'--page-script'],{encoding:'utf8',timeout:5000});assert.equal(result.status,0,result.stderr);
  const fixture=sample(),sheet=vm.runInNewContext(result.stdout,{...fixture});assert.equal(sheet.elements[0].sel,'button#save');assert.equal(sheet.channel,'codex-in-app');
  assert.equal(result.stdout.includes('chromium.launch'),false);
});
test('CLI requires explicit browser selection before attempting a browser launch',()=>{
  safeEntry();const result=spawnSync(process.execPath,[script,'https://prototype.example/'],{encoding:'utf8',timeout:5000});assert.equal(result.status,2);
  assert.match(result.stderr,/--browser playwright/);assert.equal(result.stderr.includes('Cannot find module'),false);
});
