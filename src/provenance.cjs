'use strict';
// Follow user-owned notes back to their real roots. A renamed or summarized
// feedback source never acquires a different authority.
function sourceClosure(sources, ids) {
  const byId=sources instanceof Map?sources:new Map(sources.map(s=>[s.id,s]));const result=new Map(),visiting=new Set();
  const visit=id=>{
    if(visiting.has(id))throw new Error('Cyclic source provenance');if(result.has(id))return;
    const source=byId.get(id);if(!source||source.deleted)throw new Error(`Unavailable source dependency: ${id}`);
    visiting.add(id);
    for(const parent of source.evidenceSourceIds||[]) {
      const current=byId.get(parent);
      if(!current||source.evidenceRevisions&&source.evidenceRevisions[parent]!==current.revision)throw new Error('Stale source dependency');
      visit(parent);
    }
    visiting.delete(id);result.set(id,source);
  };
  ids.forEach(visit);return [...result.values()];
}
function isLocalFeedback(source) {return source.type==='feedback'&&source.kind!=='recurring_authorized'||source.kind==='feedback'||source.kind==='feedback_ref';}
function assertPreferenceAuthority(sources,ids) {
  if(sourceClosure(sources,ids).some(isLocalFeedback))throw new Error('Stable preferences require explicit recurring intent, not local feedback or its copies');
}
module.exports={sourceClosure,isLocalFeedback,assertPreferenceAuthority};
