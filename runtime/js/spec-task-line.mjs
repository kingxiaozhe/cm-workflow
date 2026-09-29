// The one tasks.md declaration grammar. Admission, the cm-prd checks, N5
// mark-done and the approval manifest's runtime-mark normalization all read
// task lines through this file, so a task one of them accepts is a task for all.
//
// A declaration is a list item with a checkbox at any indentation, an optional
// `~~` strike, a T-id and then an ASCII colon, a full-width colon or whitespace:
//   - [ ] T-003: 描述   - [x] T-003 描述   - [ ] T-003：描述   ····- [ ] T-003 - 描述
// The full-width colon is accepted rather than rejected: Chinese input methods
// produce it, cm-failover already accepted it, and rejecting it would force a
// spec revision for punctuation alone. Lines inside ``` / ~~~ fences (the
// manifest's original fence rule) are examples, never declarations.
//
// The grammar is versioned by the approval that bound the bytes: approvals
// written by this version record taskGrammar 2 in .cm-specs-status. Approvals
// recorded earlier keep the exact pre-grammar parse (grammar 1) so an existing
// approved tasks.md never changes meaning, e.g. an unfenced `- [ ] T-001：例`
// beside the real `- [ ] T-001:` stays prose instead of becoming a duplicate.
// cm-prd drafts and new approvals always use grammar 2.
import fs from 'node:fs';
import path from 'node:path';
export const TASK_GRAMMAR=2;
export const LEGACY_TASK_GRAMMAR=1;
const LEGACY_DECLARATION=/^((\s*-\s*)\[([ xX])\]\s+(?:~~)?(T-[A-Za-z0-9][A-Za-z0-9._-]*))(?=[:\s])[:\s]*(.*)$/;
const DECLARATION=/^(\s*-\s*)\[([ xX])\]\s+(?:~~)?(T-[A-Za-z0-9][A-Za-z0-9._-]*)(?=[:：\s])/u;
const FENCE=/^[ ]{0,3}(`{3,}|~{3,})/;

export function matchTaskDeclaration(line){
  const match=DECLARATION.exec(line);
  if(!match)return null;
  return {id:match[3],completed:match[2]!==' ',markOffset:match[1].length+1,
    rest:line.slice(match[0].length)};
}

// Physical lines (\r\n, \r or \n) with their character offsets. Fenced lines are
// reported but flagged, so callers keep exact line numbers for diagnostics.
export function specLines(text){
  const lines=[],parts=text.split(/(\r\n|\r|\n)/);let fence=null,width=0,start=0;
  for(let index=0;index*2<parts.length;index++){
    const body=parts[index*2],opener=FENCE.exec(body);let fenced=true;
    if(fence!==null){
      if(opener&&opener[1][0]===fence&&opener[1].length>=width&&/^[\t\n\v\f\r ]*$/.test(body.slice(opener[0].length))){fence=null;width=0;}
    }else if(opener){fence=opener[1][0];width=opener[1].length;}
    else fenced=false;
    lines.push({index,start,body,fenced});
    start+=body.length+(parts[index*2+1]??'').length;
  }
  return lines;
}

// Lines of tasks.md with their declaration (or null) under the given grammar.
// `description` is the text after the id with the grammar's own separator stripped.
export function taskLines(text,{grammar=TASK_GRAMMAR}={}){
  if(grammar===TASK_GRAMMAR)return specLines(text).map(line=>{
    const declaration=line.fenced?null:matchTaskDeclaration(line.body);
    return {...line,declaration:declaration&&{...declaration,description:declaration.rest.replace(/^[:：\s]+/u,'')}};
  });
  if(grammar!==LEGACY_TASK_GRAMMAR)throw Object.assign(new Error('task_grammar_invalid'),{code:'task_grammar_invalid'});
  // Exactly the pre-grammar admission parser: \r?\n lines, no fence handling.
  const lines=[],parts=text.split(/(\r?\n)/);let start=0;
  for(let index=0;index*2<parts.length;index++){
    const body=parts[index*2],match=LEGACY_DECLARATION.exec(body);
    lines.push({index,start,body,fenced:false,declaration:match&&{id:match[4],completed:match[3]!==' ',
      markOffset:match[2].length+1,rest:body.slice(match[1].length),description:match[5]}});
    start+=body.length+(parts[index*2+1]??'').length;
  }
  return lines;
}

export function taskDeclarations(text,{grammar=TASK_GRAMMAR}={}){
  return taskLines(text,{grammar}).flatMap(line=>line.declaration?[{...line,...line.declaration}]:[]);
}

// The grammar the current approval bound; anything but an approval written with
// taskGrammar 2 (older approvals, awaiting review, missing or unreadable status)
// is read with the pre-grammar parser, which is what approved those bytes.
export function approvedTaskGrammar(specsDir){
  try{
    const status=JSON.parse(fs.readFileSync(path.join(specsDir,'.cm-specs-status'),'utf8'));
    return status?.status==='approved'&&status.taskGrammar===TASK_GRAMMAR?TASK_GRAMMAR:LEGACY_TASK_GRAMMAR;
  }catch{return LEGACY_TASK_GRAMMAR;}
}

// Runtime completion marks are the only task-line bytes that change after approval.
export function resetTaskMarks(text){
  let result='',cursor=0;
  for(const item of taskDeclarations(text)){
    if(!item.completed)continue;
    const offset=item.start+item.markOffset;
    result+=text.slice(cursor,offset)+' ';cursor=offset+1;
  }
  return result+text.slice(cursor);
}

// Byte-level twin of resetTaskMarks for approval digests. Invalid UTF-8 stays
// byte-exact: each line is decoded only to find the ASCII checkbox position.
export function resetTaskMarkBytes(bytes){
  const out=Buffer.from(bytes),decoder=new TextDecoder('utf-8',{ignoreBOM:true});
  let fence=null,width=0;
  for(let start=0;start<bytes.length;){
    let end=start;while(end<bytes.length&&bytes[end]!==0x0a&&bytes[end]!==0x0d)end++;
    const line=decoder.decode(bytes.subarray(start,end));
    const opener=FENCE.exec(line);
    if(fence!==null){
      if(opener&&opener[1][0]===fence&&opener[1].length>=width&&/^[\t\n\v\f\r ]*$/.test(line.slice(opener[0].length))){fence=null;width=0;}
    }else if(opener){fence=opener[1][0];width=opener[1].length;}
    else{
      const declaration=matchTaskDeclaration(line);
      if(declaration?.completed){
        const offset=start+Buffer.byteLength(line.slice(0,declaration.markOffset));
        if(out[offset-1]!==0x5b||(out[offset]|0x20)!==0x78)throw new Error('task checkbox byte offset mismatch');
        out[offset]=0x20;
      }
    }
    start=end+(bytes[end]===0x0d&&bytes[end+1]===0x0a?2:1);
  }
  return out;
}
