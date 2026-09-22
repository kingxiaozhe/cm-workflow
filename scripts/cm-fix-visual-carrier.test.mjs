import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {verifyVisualCarrier} from '../runtime/js/cm-fix/visual.mjs';

// 纯视觉修复的证据载体可以是截图也可以是录屏——cm-fix-host 的帮助里写着
// kind:screenshot|video。但 video 那一半从来没有测试走过，现有用例只造过截图，
// 连一个文件头常量都没出现过（docs/untested-branches.md 的 A 类第二条）。
//
// 这里要钉的不是「字符串能不能通过校验」，而是真正值钱的那条：载体的**声明**必须
// 和文件的**实际字节**对上。声明成录屏却塞张图，或者反过来，都必须被拒——否则
// 「视觉证据」就只是一个可以随便填的字段。
const magic={
  png:Buffer.from([137,80,78,71,13,10,26,10]),
  jpeg:Buffer.from([255,216,255,224]),
  gif:Buffer.from('GIF89a'),
  // MP4/MOV：前 4 字节是长度，紧跟 'ftyp'
  mp4:Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from('ftypisom')]),
  webm:Buffer.from([26,69,223,163]),
};
function carrier(t,head,kind,{corruptHash=false}={}){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'visual-carrier-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const file=path.join(root,'evidence.bin');
  // 补足尾巴，确保不是靠长度而是靠文件头判定。
  const bytes=Buffer.concat([head,Buffer.alloc(64,7)]);
  fs.writeFileSync(file,bytes);
  const sha256=corruptHash?'0'.repeat(64):createHash('sha256').update(bytes).digest('hex');
  return {path:file,sha256,kind,description:'Synthetic carrier for the fixture'};
}

test('a video carrier is accepted for the container formats the contract names',t=>{
  for(const format of ['mp4','webm']){
    const value=carrier(t,magic[format],'video');
    assert.deepEqual(verifyVisualCarrier(value),value,format);
  }
});

test('a screenshot carrier still accepts the image formats, unchanged',t=>{
  for(const format of ['png','jpeg','gif']){
    const value=carrier(t,magic[format],'screenshot');
    assert.deepEqual(verifyVisualCarrier(value),value,format);
  }
});

test('the declared kind must match the actual bytes, in both directions',t=>{
  // 这条才是这段校验存在的理由：声明不能脱离字节。
  for(const [head,kind] of [['png','video'],['jpeg','video'],['mp4','screenshot'],['webm','screenshot']])
    assert.throws(()=>verifyVisualCarrier(carrier(t,magic[head],kind)),
      {code:'fix_visual_carrier_invalid'},`${head} 不该被当成 ${kind}`);
});

test('bytes that are neither an image nor a video are refused whichever kind is claimed',t=>{
  const text=Buffer.from('this is just a text file pretending to be evidence');
  for(const kind of ['screenshot','video'])
    assert.throws(()=>verifyVisualCarrier(carrier(t,text,kind)),{code:'fix_visual_carrier_invalid'},kind);
});

test('a video carrier whose file no longer matches its hash is refused as changed',t=>{
  // 录屏和截图走同一条哈希绑定，但之前只在截图上验过。
  assert.throws(()=>verifyVisualCarrier(carrier(t,magic.mp4,'video',{corruptHash:true})),
    {code:'fix_visual_carrier_changed'});
});
