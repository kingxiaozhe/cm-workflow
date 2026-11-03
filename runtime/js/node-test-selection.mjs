// Selection adapter for the native Node test runner. This is not an execution
// receipt: it only models explicit files and options that do not filter tests.
// Keep custom reporters, preload/config hooks, discovery, globs and filters
// unknown. A successful wrapper or a reported count cannot supply this mapping.
const positiveInteger=value=>/^[1-9][0-9]*$/.test(value)
  &&Number.isSafeInteger(Number(value))&&Number(value)<=2147483647;
const values=new Map([
  ['--test-concurrency',positiveInteger],
  ['--test-timeout',positiveInteger],
  ['--test-reporter',value=>['tap','spec','dot'].includes(value)],
  ['--test-reporter-destination',value=>['stdout','stderr'].includes(value)],
]);
const file=value=>typeof value==='string'&&value.length>0&&!value.startsWith('-')&&!value.startsWith('/')
  &&!/[\\\x00-\x1f\x7f*?\[\]{}]/.test(value)
  &&value.replace(/^\.\//,'').split('/').every(part=>part&&part!=='.'&&part!=='..');

export function selectedNodeTestFiles(tokens){
  if(!Array.isArray(tokens)||tokens[0]!==process.execPath
    ||!tokens.every(token=>typeof token==='string'&&token.length>0))return null;
  const seen=new Set();let test=false,index=1;
  for(;index<tokens.length;index++){
    const token=tokens[index];
    if(token==='--'){index++;break;}
    if(!token.startsWith('-'))break;
    if(token==='--test'){
      if(test)return null;test=true;continue;
    }
    const equals=token.indexOf('='),name=equals===-1?token:token.slice(0,equals),validate=values.get(name);
    if(!validate||seen.has(name))return null;
    seen.add(name);
    const value=equals===-1?tokens[++index]:token.slice(equals+1);
    if(typeof value!=='string'||!validate(value))return null;
  }
  if(!test||seen.has('--test-reporter-destination')&&!seen.has('--test-reporter'))return null;
  const files=tokens.slice(index);
  if(files.length===0||!files.every(file))return null;
  return files.map(value=>value.replace(/^\.\//,''));
}
