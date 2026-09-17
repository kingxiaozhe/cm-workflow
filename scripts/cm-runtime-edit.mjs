// Lossless edits for the exact JSON/YAML subset accepted by cm-workflow-config.
// Validate with that authority before and after edits; never serialize the file.
import {ConfigError} from './cm-workflow-config.mjs';

const EOL=/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/g;
function unquote(key){return key.startsWith('"')?JSON.parse(key):key.startsWith("'")?key.slice(1,-1).replaceAll("''", "'"):key;}
function contentEnd(text){
  let quote=null;
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(quote==='"'&&c==='\\'){i++;continue;}
    if(quote&&c===quote){if(quote==="'"&&text[i+1]==="'"){i++;continue;}quote=null;}
    else if(!quote&&(c==='"'||c==="'"))quote=c;
    else if(!quote&&c==='#'&&(i===0||/\s/.test(text[i-1])))return text.slice(0,i).trimEnd().length;
  }
  return text.trimEnd().length;
}
function parts(text,start,end){
  const result=[];let quote=null,depth=0,from=start;
  for(let i=start;i<end;i++){
    const c=text[i];
    if(quote==='"'&&c==='\\'){i++;continue;}
    if(quote&&c===quote){if(quote==="'"&&text[i+1]==="'"){i++;continue;}quote=null;}
    else if(!quote&&(c==='"'||c==="'"))quote=c;
    else if(!quote){
      if(c==='{'||c==='[')depth++;
      if(c==='}'||c===']')depth--;
      if(c===','&&depth===0){result.push([from,i]);from=i+1;}
    }
  }
  if(text.slice(from,end).trim())result.push([from,end]);
  return result;
}
const KEY=/^\s*("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^:\s][^:]*?)\s*:[ \t]*/;
function flowNode(text,start,end,json){
  const children=new Map();
  for(const [from,to] of parts(text,start+1,end-1)){
    const match=KEY.exec(text.slice(from,to));
    if(!match)throw new ConfigError('cannot locate mapping key for lossless edit');
    let valueStart=from+match[0].length,valueEnd=to;
    while(/\s/.test(text[valueStart]??'')&&valueStart<to)valueStart++;
    while(valueEnd>valueStart&&/\s/.test(text[valueEnd-1]))valueEnd--;
    children.set(unquote(match[1]),{start:valueStart,end:valueEnd});
  }
  return {kind:'flow',start,end,children,json};
}
function blockNode(text,start,end,indent){
  const lines=[];let cursor=start;
  for(const match of text.slice(start,end).matchAll(new RegExp(EOL.source,'g'))){
    const stop=start+match.index;
    lines.push({start:cursor,end:stop,next:stop+match[0].length});cursor=stop+match[0].length;
  }
  if(cursor<end)lines.push({start:cursor,end,next:end});
  const meaningful=lines.map(line=>{
    const raw=text.slice(line.start,line.end),length=contentEnd(raw);
    return {...line,raw:raw.slice(0,length),length,indent:raw.match(/^ */)[0].length};
  }).filter(line=>line.raw.trim());
  const children=new Map();
  for(let i=0;i<meaningful.length;i++){
    const line=meaningful[i];if(line.indent!==indent)continue;
    const match=KEY.exec(line.raw);if(!match)continue;
    let last=i;
    while(last+1<meaningful.length&&meaningful[last+1].indent>indent)last++;
    const valueStart=line.start+match[0].length;
    children.set(unquote(match[1]),line.raw.slice(match[0].length).trim()
      ?{start:valueStart,end:line.start+line.length}
      :{start:line.next,end:meaningful[last].next,indent:meaningful[i+1]?.indent??indent+2,block:true});
  }
  return {kind:'block',start,end,indent,children,insert:meaningful.at(-1)?.next??end};
}
function render(value,json){
  if(json)return JSON.stringify(value);
  if(typeof value==='string')return value;
  return '{'+Object.entries(value).map(([key,item])=>`${key}: ${render(item,false)}`).join(', ')+'}';
}
function replace(text,start,end,value){return text.slice(0,start)+value+text.slice(end);}
function edit(text,node,keys,value,eol){
  const [key,...rest]=keys,child=node.children.get(key);
  if(child){
    if(rest.length===0)return replace(text,child.start,child.end,render(value,node.json));
    const nested=child.block?blockNode(text,child.start,child.end,child.indent)
      :text[child.start]==='{'?flowNode(text,child.start,child.end,node.json):null;
    if(!nested)throw new ConfigError(`cannot edit mapping ${keys.join('.')}`);
    return edit(text,nested,rest,value,eol);
  }
  const nested=rest.reduceRight((result,name)=>({[name]:result}),value);
  const addition=(node.json?JSON.stringify(key):key)+': '+render(nested,node.json);
  if(node.kind==='flow')return replace(text,node.end-1,node.end-1,(node.children.size?', ':'')+addition);
  const at=node.insert,needsBreak=at>0&&!new RegExp(EOL.source+'$').test(text.slice(0,at));
  return replace(text,at,at,(needsBreak?eol:'')+' '.repeat(node.indent)+addition+eol);
}
export function editRuntimeDeclaration(text,configPath,preset){
  const json=configPath.endsWith('.json'),eol=text.match(EOL)?.[0]??'\n';
  const fields=[['runtimes','available',preset.runtimes.available],
    ...['coder','reviewer'].flatMap(role=>['adapter','source'].map(field=>['roles',role,field,preset.roles[role][field]]))];
  for(const field of fields){
    const value=field.at(-1),keys=field.slice(0,-1),start=text.startsWith('\ufeff')?1:0;
    let root;
    if(json){const from=text.indexOf('{',start),to=text.lastIndexOf('}')+1;root=flowNode(text,from,to,true);}
    else root=blockNode(text,start,text.length,0);
    text=edit(text,root,keys,value,eol);
  }
  return text;
}
