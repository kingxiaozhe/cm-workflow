// Execute declared root-local operations and aggregate into the original task.
// Root selection is data, not a second scheduler or a task completion authority.
import {captureProtectedEdits,commitProtectedEdits} from '../cm-fix/protected-edits.mjs';
import {groupCodeProjectPaths,resolveCodeProjects} from './code-projects.mjs';
import {createHostCheck} from './host-check.mjs';
import {specsPermissionArgs} from './codex-config.mjs';
import {digest,json,need,shape,id} from './effect-contract.mjs';

export function createProjectExecution({definition,protection}){
  const data=json(definition),config=json(protection);
  const roots=data.codeProjects?resolveCodeProjects(data.codeProject,data.codeProjects):[data.codeProject];
  for(const root of roots)specsPermissionArgs({cwd:root,specsRoot:data.specsDir});
  const groups=scope=>data.codeProjects?groupCodeProjectPaths(data.codeProject,roots,scope)
    :[{codeProject:data.codeProject,prefix:'',paths:scope}];
  const full=(group,file)=>group.prefix?group.prefix+'/'+file:file;
  const commands=config.checkCommands;
  need(Array.isArray(commands)&&commands.length>0&&commands.length<=32,'invalid_check_config');
  const ids=new Set();
  const checks=commands.map(command=>{
    shape(command,['id','command',...(data.codeProjects?['codeProject']:[])]);id(command.id);
    need(!ids.has(command.id),'invalid_check_config');ids.add(command.id);
    const cwd=data.codeProjects?command.codeProject:data.codeProject;
    need(roots.includes(cwd),'execution_root_mismatch');
    const check=createHostCheck({cwd,specsRoot:data.specsDir,timeoutMs:config.timeoutMs,
      commands:[{id:command.id,command:command.command}]});
    return {cwd,check};
  });
  need(roots.every(root=>checks.some(item=>item.cwd===root)),'code_project_checks_required');
  const recheck=()=>{if(data.codeProjects)need(digest(resolveCodeProjects(data.codeProject,roots))===digest(roots),'execution_root_mismatch');};
  return Object.freeze({
    expected(scope){recheck();return Object.fromEntries(groups(scope).flatMap(group=>
      Object.entries(group.paths.length?captureProtectedEdits(group.codeProject,group.paths):{}).map(([file,hash])=>[full(group,file),hash])));},
    async commit({scope,edits,expected,identity,signal}){
      recheck();need(Array.isArray(edits),'protected_edit_invalid');
      for(const edit of edits)need(scope.includes(edit.path),'out_of_scope');
      // Precheck all roots before the first root writes; no claim of atomicity.
      const selected=groups(scope);
      for(const group of selected)for(const [file,hash] of Object.entries(group.paths.length?captureProtectedEdits(group.codeProject,group.paths):{}))
        need(hash===expected[full(group,file)],'protected_edit_stale');
      for(const group of selected){
        const local=edits.filter(edit=>group.paths.some(file=>full(group,file)===edit.path))
          .map(edit=>({...edit,path:group.prefix?edit.path.slice(group.prefix.length+1):edit.path}));
        if(!local.length)continue;
        await commitProtectedEdits({cwd:group.codeProject,specsRoot:data.specsDir,scope:group.paths,edits:local,
          expected:Object.fromEntries(group.paths.map(file=>[file,expected[full(group,file)]])),identity,signal,timeoutMs:config.timeoutMs});
      }
    },
    async check(request,control){
      recheck();const result=[];
      for(const item of checks){
        const [row]=await item.check(request,control);
        result.push(data.codeProjects?{...row,evidence:`cwd=${item.cwd}; ${row.evidence}`}:row);
        if(row.outcome!=='passed')break;
      }
      return result;
    },
  });
}
