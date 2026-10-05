// Local fixture responder for the actual driver/host transport. No provider,
// account or browser is contacted; each test supplies its synthetic observation.
import fs from 'node:fs';
import {spawn} from 'node:child_process';
export function runLiveDriver(driver,plan,operation,respond,{env=process.env,timeoutMs=30000}={}){
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[driver,'--plan',plan,operation],{env,stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='',buffer='',failure=null;const requests=[];
    const startedAt=Date.now();
    const timer=setTimeout(()=>{
      failure=Object.assign(Error('fixture driver timeout'),{code:'fixture_driver_timeout',
        diagnostic:{timeoutMs,elapsedMs:Date.now()-startedAt,requestCount:requests.length,
          stdoutBytes:Buffer.byteLength(stdout),stderrBytes:Buffer.byteLength(stderr)}});
      child.kill();
    },timeoutMs);
    child.stdout.on('data',chunk=>{stdout+=chunk;});
    child.stderr.on('data',chunk=>{
      stderr+=chunk;buffer+=chunk;
      let at;while((at=buffer.indexOf('\n'))!==-1){
        const line=buffer.slice(0,at);buffer=buffer.slice(at+1);
        if(!line.startsWith('[drive] live_evidence_request: '))continue;
        const file=line.slice('[drive] live_evidence_request: '.length);
        try{
          const row=JSON.parse(fs.readFileSync(file,'utf8'));requests.push(row);
          const result=respond(row),target=file.replace('.request.json','.result.json');
          fs.writeFileSync(target+'.tmp',JSON.stringify({type:'host_result',sessionId:row.sessionId,
            callId:row.callId,requestDigest:row.requestDigest,result}),{flag:'wx',mode:0o600});
          fs.renameSync(target+'.tmp',target);
        }catch(error){failure=error;child.kill();}
      }
    });
    child.on('error',error=>{clearTimeout(timer);reject(error);});
    child.on('close',status=>{clearTimeout(timer);if(failure)reject(failure);else resolve({status,stdout,stderr,requests});});
  });
}
