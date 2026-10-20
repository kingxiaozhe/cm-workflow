// Review routes are package-bound source declarations, not CLI execution proof.
import {loadConfig,resolveRole} from '../../../scripts/cm-workflow-config.mjs';
import {json,need,shape} from '../cm-ai/effect-contract.mjs';

export function inspectPrdReviewRoute(raw){
  const route=json(raw);
  shape(route,['adapter','model','source','hostRuntime','configuredAdapter']);
  need(['codex','claude'].includes(route.hostRuntime)
    &&['current-ai','codex-cli','claude-cli'].includes(route.configuredAdapter)
    &&route.adapter===(route.configuredAdapter==='current-ai'?`${route.hostRuntime}-cli`:route.configuredAdapter)
    &&typeof route.model==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:/+@-]{0,127}$/.test(route.model)
    &&['local','subscription','api','browser','none'].includes(route.source),'prd_review_route_invalid');
  return route;
}

export function resolvePrdReviewRoute({project,runtime}){
  need(['codex','claude'].includes(runtime),'invalid_runtime');
  const declared=resolveRole(loadConfig({projectRoot:project}),'reviewer',runtime);
  need(['current-ai','codex-cli','claude-cli'].includes(declared.adapter),'prd_review_route_unavailable');
  return inspectPrdReviewRoute({adapter:declared.adapter==='current-ai'?`${runtime}-cli`:declared.adapter,
    model:declared.model,source:declared.source,hostRuntime:runtime,configuredAdapter:declared.adapter});
}

export function assertPrdReviewRouteMode({reviewPackage,mode}){
  if(!Object.hasOwn(reviewPackage,'reviewRoute'))return;
  const route=inspectPrdReviewRoute(reviewPackage.reviewRoute);
  // An explicitly selected reviewer must not be replaced by the author channel.
  need(mode!=='self-degraded'||route.configuredAdapter==='current-ai','prd_review_route_mismatch');
}

export function assertPrdReviewRoute({reviewPackage,response}){
  if(!Object.hasOwn(reviewPackage,'reviewRoute'))return;
  const route=inspectPrdReviewRoute(reviewPackage.reviewRoute);
  assertPrdReviewRouteMode({reviewPackage,mode:response.reviewer==='self-degraded'?'self-degraded':'independent'});
  if(response.reviewer==='self-degraded')return;
  const allowed=route.configuredAdapter==='current-ai'&&route.adapter==='codex-cli'
    ?['codex-cli','codex-subagent']:[route.adapter];
  need(allowed.includes(response.reviewer),'prd_review_route_mismatch');
}
