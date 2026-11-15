// Shared wording rules for "does this spec text state or weaken an acceptance
// obligation". The standing authorization (autonomy.mjs) and tiered spec
// amendment (cm-ai/spec-amendment.mjs) must judge version notes the same way.
export const taskNames=body=>body.match(/(?<![A-Za-z0-9])T-[A-Za-z0-9][A-Za-z0-9._-]*/g)??[];
export const acceptanceLanguage=body=>/验收|必验|必跑|必须|要求|真机|物理设备|physical[- ]device|\b(?:must|required|shall|acceptance)\b/i.test(body);
export const weakensLanguage=body=>/取消|无需|不再|改为|可忽略|即可|延期|\b(?:optional|instead|waiv(?:e|ed)|no longer|not required|previous)\b/i.test(body);
// Version notes are read with full-width letters, digits and dashes as ASCII
// (Ｔ-００２, T－002), so an id cannot hide behind its full-width form.
export const versionNote=text=>String(text).normalize('NFKC');
// Whether a version note is a plain record that changes nothing a review must
// see: after removing explicit "unchanged" statements (范围与验收不变, 检查与断言
// 不放宽, 无其他改动), no wording about tests, acceptance or a change remains.
// Anything else, including wording no list foresees, is not plain (dogfood: real
// version tables write the unchanged statements on most rows).
const UNCHANGED=/(?:(?:范围|行为|验收|检查|断言|用例|文案|测试|设计)[与和及、，,\s]*)*(?:均|都|也)?(?:不变|不放宽|未改动?|保持不变)|无其他改动|其余不变|\b(?:no other changes?|unchanged)\b/gi;
const SUBSTANTIVE=/验收|必验|必跑|必须|要求|真机|设备|断言|测试|检查|用例|门槛|状态码|覆盖|只需|仅|跳过|放宽|降低|加强|提高|新增|增加|允许|删除|去掉|改|调整|替换|取消|无需|不再|可忽略|即可|延期|AC-?\d|TC-?\d|T-[A-Za-z0-9]|\b(?:test|assert|accept|check|verify|skip|only|relax|lower|raise|add|remove|drop|change|replace|allow|optional|instead|waive|must|require)/i;
export const plainVersionNote=text=>!SUBSTANTIVE.test(versionNote(text).replace(UNCHANGED,' '));
