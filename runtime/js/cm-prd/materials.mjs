// Validate host-reported source processing, not independent proof or write authority.
import {need,shape,json,digest} from '../cm-ai/effect-contract.mjs';
const nonempty=value=>typeof value==='string'&&value.trim().length>0;
export function inspectPrdMaterialResults(raw,sources){
  const value=json(raw,64*1024);shape(value,['status','records']);
  need(value.status==='processed'&&Array.isArray(value.records),'prd_material_invalid');
  const expected=sources.filter(source=>source.format!=='text');
  need(value.records.length===expected.length,'prd_material_coverage');
  const seen=new Set(),openQuestions=[];
  for(const record of value.records){
    need(record&&typeof record==='object','prd_material_invalid');
    const source=expected.find(source=>source.path===record.path);
    need(source&&!seen.has(record.path)&&source.sha256===record.sha256,'prd_material_binding');seen.add(record.path);
    if(source.format==='pdf'){
      shape(record,['path','sha256','format','pageCount','pages']);
      need(record.format==='pdf'&&Number.isSafeInteger(record.pageCount)&&record.pageCount>0
        &&Array.isArray(record.pages)&&record.pages.length===record.pageCount,'prd_pdf_coverage');
      record.pages.forEach((page,index)=>{
        shape(page,['page','text','evidence']);
        need(page.page===index+1&&nonempty(page.text)&&nonempty(page.evidence),'prd_pdf_page_invalid');
      });
    }else{
      need(source.format==='html','prd_material_unsupported');
      shape(record,['path','sha256','format','pages']);
      need(record.format==='html'&&Array.isArray(record.pages)&&record.pages.length>0,'prd_html_coverage');
      const urls=new Set();
      for(const page of record.pages){
        shape(page,['url','interactiveCount','elements','evidence']);
        need(nonempty(page.url)&&!urls.has(page.url)&&nonempty(page.evidence)
          &&Number.isSafeInteger(page.interactiveCount)&&page.interactiveCount>=0
          &&Array.isArray(page.elements)&&page.elements.length===page.interactiveCount,'prd_html_coverage');
        urls.add(page.url);const ids=new Set();
        for(const element of page.elements){
          shape(element,['id','action','result','kind','screenshot','question']);
          need(nonempty(element.id)&&!ids.has(element.id)&&nonempty(element.action)
            &&nonempty(element.result)&&nonempty(element.screenshot)
            &&['function','dead_zone'].includes(element.kind),'prd_html_element_invalid');
          ids.add(element.id);
          if(element.kind==='dead_zone'){
            need(nonempty(element.question),'prd_dead_zone_question_missing');openQuestions.push(element.question);
          }else need(element.question===null,'prd_html_element_invalid');
        }
      }
    }
  }
  return json({records:value.records,openQuestions,source:'host_reported_material_processing',
    evidenceDigest:digest(value),independentVerification:false,writeAuthorized:false});
}
