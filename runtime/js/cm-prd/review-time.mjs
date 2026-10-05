import {needPrd} from './validation-reason.mjs';

export function assertPrdReviewTimestamp(value){
  needPrd(typeof value==='string'&&Number.isFinite(Date.parse(value))
    &&new Date(value).toISOString()===value,'prd_review_timestamp_invalid',
    {field:'response.at',expected:'new Date().toISOString() form, e.g. 2026-09-08T00:00:00.000Z'});
}

// Recovery only: explicit timezone, exact calendar, no Date.parse rollover.
// Only exact millisecond instants are recoverable; never truncate precision or use now.
export function normalizePrdReviewTimestamp(value){
  const match=typeof value==='string'&&value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/);
  const valid=ok=>needPrd(ok,'prd_review_timestamp_invalid',
    {field:'response.at',expected:'Valid ISO calendar timestamp with explicit Z or +/-HH:mm timezone; 1-9 fractional digits'});
  valid(match);
  valid(match[8]!=='-00:00');
  const [year,month,day,hour,minute,second]=match.slice(1,7).map(Number);
  const offsetHour=Number(match[10]??0),offsetMinute=Number(match[11]??0);
  valid(month>=1&&month<=12&&day>=1&&day<=31&&hour<=23&&minute<=59&&second<=59
    &&offsetHour<=23&&offsetMinute<=59);
  const date=new Date(0);date.setUTCFullYear(year,month-1,day);date.setUTCHours(hour,minute,second,0);
  valid(date.getUTCFullYear()===year&&date.getUTCMonth()===month-1&&date.getUTCDate()===day);
  valid(!(match[7]??'').slice(3).match(/[1-9]/));
  const milliseconds=Number((match[7]??'').padEnd(3,'0').slice(0,3));
  const offset=(offsetHour*60+offsetMinute)*60000*(match[9]==='-'?-1:1);
  const utc=new Date(date.getTime()+milliseconds-offset);
  valid(utc.getUTCFullYear()>=0&&utc.getUTCFullYear()<=9999);
  const canonical=utc.toISOString();assertPrdReviewTimestamp(canonical);return canonical;
}
