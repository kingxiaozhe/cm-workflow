// Shared wording rules for "does this spec text state or weaken an acceptance
// obligation". The standing authorization (autonomy.mjs) and tiered spec
// amendment (cm-ai/spec-amendment.mjs) must judge version notes the same way.
export const taskNames=body=>body.match(/(?<![A-Za-z0-9])T-[A-Za-z0-9][A-Za-z0-9._-]*/g)??[];
export const acceptanceLanguage=body=>/验收|必验|必跑|必须|要求|真机|物理设备|physical[- ]device|\b(?:must|required|shall|acceptance)\b/i.test(body);
export const weakensLanguage=body=>/取消|无需|不再|改为|可忽略|即可|延期|\b(?:optional|instead|waiv(?:e|ed)|no longer|not required|previous)\b/i.test(body);
