// Explicit binary proposals retain the same scope/stale-hash and sandbox gates.
// Bytes are imported from the frozen private answer root, never an arbitrary URL.
import {createHash} from 'node:crypto';
import {shape,need,hex} from './effect-contract.mjs';
import {importBinaryAsset,readBinaryAssetBinding} from './binary-assets.mjs';

export function binaryAssetBinding(configuration){
  if(!configuration)return null;
  return readBinaryAssetBinding({version:1,paths:configuration.paths,storeRoot:configuration.storeRoot});
}
export function prepareProtectedEdit(edit,{binaryAssets=null,scope,expected}){
  const binary=Object.hasOwn(edit,'asset');
  shape(edit,['path','beforeSha256',binary?'asset':'content',...(Object.hasOwn(edit,'mode')?['mode']:[])]);
  need(scope.includes(edit.path)&&Object.hasOwn(expected,edit.path),'out_of_scope');
  if(edit.beforeSha256!==null)hex(edit.beforeSha256);
  if(binary){
    need(binaryAssets&&binaryAssets.paths.includes(edit.path),'protected_binary_not_declared');
    need(!Object.hasOwn(edit,'mode')||edit.mode==='0644','protected_edit_invalid');
    shape(edit.asset,['path','sha256','size']);
    const asset=importBinaryAsset({binding:binaryAssetBinding(binaryAssets),sourceRoot:binaryAssets.sourceRoot,
      sourcePath:edit.asset.path,sha256:edit.asset.sha256,size:edit.asset.size});
    return {path:edit.path,beforeSha256:edit.beforeSha256,contentBlob:asset.contentBlob,size:asset.size,mode:'0644'};
  }
  need(edit.content===null||typeof edit.content==='string','protected_edit_invalid');
  need(edit.content===null||Buffer.byteLength(edit.content)<=1024*1024,'limit_exceeded');
  need(edit.content!==null||edit.beforeSha256!==null,'protected_edit_invalid');
  need(!Object.hasOwn(edit,'mode')||edit.content!==null&&['0644','0755'].includes(edit.mode),'protected_edit_invalid');
  // A declared binary target cannot use the text branch to avoid its exact-byte contract.
  need(!binaryAssets?.paths.includes(edit.path)||edit.content===null,'protected_edit_invalid');
  return edit;
}
export const protectedEditAfterHash=edit=>Object.hasOwn(edit,'contentBlob')?edit.contentBlob
  :edit.content===null?null:createHash('sha256').update(edit.content).digest('hex');
