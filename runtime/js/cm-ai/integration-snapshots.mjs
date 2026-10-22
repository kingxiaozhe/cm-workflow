// Exact additions of reviewed evidence copies, never an ignore rule or an
// instruction-promotion mechanism. These helpers do not read or write a product.
import {hex,need,shape} from './effect-contract.mjs';

const snapshotPath=p=>typeof p==='string'
  &&/^reports\/(?:[A-Za-z0-9][A-Za-z0-9_.-]*\/)+AGENTS\.md$/.test(p)
  &&!p.split('/').some(part=>['.git','node_modules'].includes(part));

export function readIntegrationSnapshots(value){
  shape(value,['files','provenanceSha256']);hex(value.provenanceSha256);
  need(Array.isArray(value.files)&&value.files.length>0&&value.files.length<=64,'integration_snapshot_invalid');
  let previous='',total=0;
  for(const file of value.files){
    shape(file,['path','type','mode','size','sha256']);
    need(snapshotPath(file.path)&&file.path>previous&&file.type==='file'
      &&[0o644,0o664].includes(file.mode)&&Number.isSafeInteger(file.size)&&file.size>=0
      &&file.size<=256*1024,'integration_snapshot_invalid');
    hex(file.sha256);previous=file.path;total+=file.size;
  }
  need(total<=2*1024*1024,'integration_snapshot_invalid');
  return value;
}

export function assertSnapshotBoundaries(snapshots,base,packages,learningPaths=[]){
  if(!snapshots)return;
  readIntegrationSnapshots(snapshots);
  const existing=new Set(base.files.map(file=>file.path));
  const protectedPaths=new Set([...base.scope,...base.requirements,...learningPaths,
    ...packages.flatMap(pkg=>[...pkg.scope,...pkg.requirements.map(file=>file.path),
      ...pkg.changes.map(file=>file.path),...(pkg.instructions??[]).map(file=>file.path)])]);
  for(const file of snapshots.files){
    const directory=file.path.slice(0,-'AGENTS.md'.length);
    need(!existing.has(file.path)&&![...protectedPaths].some(p=>p===file.path||p.startsWith(directory)),
      'integration_snapshot_protected');
  }
}

export function verifySnapshotReview(pkg,snapshots){
  if(!snapshots)return;
  const provenance=pkg.requirements.find(file=>file.path==='integration/snapshot-provenance.json');
  need(provenance?.sha256===snapshots.provenanceSha256&&typeof provenance.contentBase64==='string',
    'integration_snapshot_not_reviewed');
  for(const expected of snapshots.files){
    // Keep copied instructions in data files. Hash deduplication retains all
    // bytes while the plan separately binds every target path and original mode.
    const file=pkg.requirements.find(item=>item.path==='integration/snapshots/'+expected.sha256+'.txt');
    need(file?.type==='file'&&file.sha256===expected.sha256&&file.size===expected.size
      &&typeof file.contentBase64==='string','integration_snapshot_not_reviewed');
  }
}
