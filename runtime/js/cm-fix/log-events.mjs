// cm-fix's view of the run log: its own rows, in log order. The log only grows;
// reading it whole under the 1 MiB review-material limit made every fix run fail
// at completion once a project's 运行日志.jsonl passed 1 MiB (2026-10-07,
// api-native-reading-fix-story-return). Read it line by line, with the same file
// guarantees as before; callers still select their own run identity.
import fs from 'node:fs';
import path from 'node:path';
import {readStableLogRows} from '../cm-ai/log-rows.mjs';
import {need} from '../cm-ai/effect-contract.mjs';

const fixRows=file=>readStableLogRows(file,row=>row!==null&&typeof row==='object'&&!Array.isArray(row)&&row.workflow==='cm-fix','fix_log_failed');
export function eventsAt(specsRoot,configuration={}){
  need(path.isAbsolute(specsRoot)&&fs.realpathSync(specsRoot)===specsRoot,'unsupported_path');
  if(configuration.archiveMode==='bare'){
    const directory=path.join(specsRoot,'.reviews','host-log-mirror','runs');
    if(!fs.existsSync(directory))return [];
    need(fs.realpathSync(directory)===directory,'fix_log_failed');
    const rows=[];
    for(const month of fs.readdirSync(directory).sort()){
      need(/^\d{4}-\d{2}$/.test(month)&&fs.realpathSync(path.join(directory,month))===path.join(directory,month),'fix_log_failed');
      for(const file of fs.readdirSync(path.join(directory,month)).sort())
        if(file.endsWith('.jsonl'))rows.push(...fixRows(path.join(directory,month,file)));
    }
    return rows;
  }
  const log=path.join(specsRoot,'运行日志.jsonl');
  if(!fs.existsSync(log))return [];
  return fixRows(log);
}
