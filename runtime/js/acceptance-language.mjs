// Shared wording rules for "does this spec text state or weaken an acceptance
// obligation". The standing authorization (autonomy.mjs) and tiered spec
// amendment (cm-ai/spec-amendment.mjs) must judge version notes the same way.
export const taskNames=body=>body.match(/(?<![A-Za-z0-9])T-[A-Za-z0-9][A-Za-z0-9._-]*/g)??[];
export const acceptanceLanguage=body=>/验收|必验|必跑|必须|要求|真机|物理设备|physical[- ]device|\b(?:must|required|shall|acceptance)\b/i.test(body);
export const weakensLanguage=body=>/取消|无需|不再|改为|可忽略|即可|延期|\b(?:optional|instead|waiv(?:e|ed)|no longer|not required|previous)\b/i.test(body);
// Version notes are read with full-width letters, digits and dashes as ASCII
// (Ｔ-００２, T－002), so an id cannot hide behind its full-width form.
export const versionNote=text=>String(text).normalize('NFKC');
// Whether a version note is nothing but explicit "unchanged" statements, such as
// 范围与验收不变, 行为与验收不变, 检查与断言不放宽, 无其他改动 (dogfood: real version
// tables write these on most rows). The whole note must consist of them: any other
// wording, including wording no list foresees, is not plain. This is a positive
// grammar, not a list of forbidden words (review: synonyms and negations slip past lists).
const STATEMENT=/^(?:(?:范围|行为|验收|检查|断言|用例|文案|测试|设计|其余|其他)(?:[与和及、]|\s)*)+(?:均|都|也)?(?:不变|不放宽|未改动?)$|^无其他改动$|^(?:no other changes?|scope and acceptance unchanged|unchanged)$/i;
// A version table row (| 日期 | 版本 | 说明 |) is judged by its description, the last cell.
const description=text=>{
  const note=versionNote(text).trim();
  if(!note.startsWith('|'))return note;
  const cells=note.split('|').map(cell=>cell.trim()).filter(Boolean);
  // The other cells may only be dates and version labels; anything else is not plain.
  if(cells.slice(0,-1).some(cell=>!/^(?:\d{4}-\d{1,2}-\d{1,2}|v\d+(?:\.\d+)*)$/i.test(cell)))return null;
  return cells.at(-1)??'';
};
export const plainVersionNote=text=>{
  const note=description(text);if(note===null)return false;
  const parts=note.replace(/[。.；;，,\s]+$/u,'').split(/\s*[，,；;。]\s*/u);
  return parts.length>0&&parts.every(part=>STATEMENT.test(part));
};
// Wording about tests or acceptance anywhere in a note, read broadly. The standing
// authorization stops for a version note that uses it unless the note is plain.
export const testingLanguage=body=>/验收|必验|必跑|必须|要求|真机|设备|断言|测试|检查|用例|门槛|状态码|覆盖|只需|仅测|只测|跳过|免跑|免测|不跑|不测|放宽|降低|成功路径|失败场景|\b(?:tests?|assert|accept|acceptance|check|verify|skip|omit|sufficient|relax|waive|scenario|required|must)\b/i.test(versionNote(body));
