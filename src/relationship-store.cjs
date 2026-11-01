'use strict';
const {randomUUID,createHash}=require('node:crypto');
const {rank}=require('./memory-search.cjs');
const {normalizeRelationshipPatch}=require('./relationship-schema.cjs');
const {sourceClosure,assertPreferenceAuthority}=require('./provenance.cjs');
const {requireOriginals}=require('./original-evidence.cjs');
const activityEvidence=require('./activity-evidence.cjs');
const PROCESSOR_VERSION='evidence-backed-understanding-2026-10-31.2';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const typed=r=>r.recordType==='claim'||r.recordType==='relationship_event';
const decisionRevisions=record=>record.transition?.sourceRevisions||{};
const dependencyRevisions=record=>({...record.sourceRevisions,...decisionRevisions(record),...activityEvidence.activityReferences(record)});
function decisionEvidence(record,byId){
  const sourceRevisions=decisionRevisions(record);
  if(record.transition?.evidenceValidity==='unavailable')return {sourceRevisions,available:false};
  const successorId=record.transition?.successorId;
  if(!successorId)return {sourceRevisions,available:true};
  // Older distinct-successor rows retain a direct record edge rather than a
  // decision-source index. Read only that successor's canonical support; never
  // recursively expand its later transitions or use summaries as evidence.
  const successor=byId.get(successorId);
  if(!successor||successor.id===record.id||successor.transition?.successorId===record.id)return {sourceRevisions,available:false};
  return {sourceRevisions:{...sourceRevisions,...successor.sourceRevisions},available:true};
}
function invalidateRelationshipDecision(record){
  const {proposal,sourceIds,sourceRevisions,...transition}=record.transition;
  const next={...record,transition:{...transition,sourceIds:[],sourceRevisions:{},evidenceValidity:'unavailable'},version:record.version+1,updatedAt:new Date().toISOString()};
  // Losing the reason for deactivation is uncertainty, not a new positive
  // observation. Keep canonical support and the opaque anti-resurrection keys.
  if(record.lifecycle!=='active'){
    next.reviewComplete=false;
  }
  const coverage=record.semanticReview?.coverage,kept=new Set(Object.keys(record.sourceRevisions||{}));
  const factCoverage=coverage&&{...coverage,
    sourceRevisions:Object.fromEntries(Object.entries(coverage.sourceRevisions||{}).filter(([id])=>kept.has(id))),
    reads:(coverage.reads||[]).filter(read=>kept.has(read.sourceId))};
  if(factCoverage)for(const field of ['completeSourceIds','requiredSourceIds','missingSourceIds','partialSourceIds'])factCoverage[field]=(coverage[field]||[]).filter(id=>kept.has(id));
  next.semanticReview={...record.semanticReview,...(record.lifecycle!=='active'?{status:'inactive_decision_needs_review'}:{}),...(factCoverage?{coverage:factCoverage}:{})};
  return next;
}
function repairRelationshipTransitions(store,scope){
  const key=store.scopeKey(scope);let changed=0;
  for(const record of store._memoryRecords(scope).filter(typed)){
    const transition=record.transition;
    if(!transition?.proposal||transition.targets?.length!==1||transition.targets[0].id!==record.id)continue;
    const next={...record};
    if(record.lifecycle!=='active'){
      const prior=record.revisions?.find(revision=>revision.version===transition.targets[0].expectedVersion);
      next.retiredSemanticSignatures=[...new Set([...(record.retiredSemanticSignatures||[]),prior?.semanticSignature].filter(Boolean))];
    }
    if(!transition.sourceRevisions){
      // Pre-fix rows already retained exact original-read revisions. Reuse that
      // captured proof, never today's revised source text or current time.
      const ids=transition.proposal.sourceIds||[],coverage=record.semanticReview?.coverage;
      const proofs=coverage?.sourceRevisions||{};
      if(ids.length&&ids.every(id=>proofs[id]&&coverage.completeSourceIds?.includes(id))){
        // Coverage can include unrelated delivered sources; dependency closure
        // is limited to the proposal and its original provenance roots.
        const byId=new Map(store.db.prepare('SELECT record FROM memory_sources WHERE scope_key=? AND deleted=0').all(key).map(row=>{const source=JSON.parse(row.record);return [source.id,source];}));
        let roots=[];try{roots=sourceClosure(byId,ids);}catch{}
        if(roots.length&&roots.every(source=>proofs[source.id]===source.revision))next.transition={...transition,sourceIds:ids,sourceRevisions:Object.fromEntries(roots.map(source=>[source.id,source.revision])),evidenceValidity:'valid'};
        else Object.assign(next,invalidateRelationshipDecision(next));
      }else Object.assign(next,invalidateRelationshipDecision(next));
    }
    const encoded=JSON.stringify(next);
    if(encoded===JSON.stringify(record))continue;
    store.db.prepare('UPDATE memory_records SET record=? WHERE scope_key=? AND id=?').run(encoded,key,record.id);
    store.db.prepare('DELETE FROM memory_dependencies WHERE scope_key=? AND id=?').run(key,record.id);
    for(const [sourceId,revision] of Object.entries(dependencyRevisions(next)))store.db.prepare('INSERT INTO memory_dependencies VALUES(?,?,?,?)').run(key,record.id,sourceId,revision);
    changed++;
  }
  if(changed)store.db.prepare('UPDATE memory_meta SET version=version+1 WHERE scope_key=?').run(key);
  return changed;
}
const meaningFields={claim:['text','subject','aspect','assertionKind','epistemicStatus','lifecycle','applicabilityKind','attribution','condition','context','validFrom','validUntil'],relationship_event:['text','activityKey','eventKind','actor','occurredAt','plannedFor']};
function prepareRelationshipPatch(store,scope,input,options={}) {
  const patch=normalizeRelationshipPatch(input),raw=new Map(store._rawMemorySources(scope).map(s=>[s.id,s]));
  const allowed=new Set(options.sourceIds||[]),records=store._memoryRecords(scope),existing=records.filter(typed),byId=new Map(existing.map(r=>[r.id,r])),transitionById=new Map(records.filter(record=>typed(record)||record.recordType==='item').map(record=>[record.id,record]));
  const checked=[];
  const activityState=activityEvidence.storedState(store,scope,raw),mintedActivities=new Map();
  const build=(value,type,retiring=false)=>{
    if(value.sourceIds.some(id=>!allowed.has(id)||!raw.has(id)))throw new Error('Unavailable or undelivered relationship evidence');
    if(options.sourceRevisions&&value.sourceIds.some(id=>options.sourceRevisions[id]!==raw.get(id).revision))throw new Error('Stale relationship source');
    let old=value.id&&(retiring?transitionById:byId).get(value.id);
    if(value.id&&!old)throw new Error('Unknown relationship record');
    if(old&&old.recordType!==type)throw new Error('Relationship record type cannot change');
    if(old&&value.expectedVersion!==undefined&&old.version!==value.expectedVersion)throw new Error('Stale relationship object version');
    if(old&&options.previousIds&&!options.previousIds.has(old.id))throw new Error('Relationship update target was not delivered');
    const nativeActivity=(type==='relationship_event'||type==='claim'&&value.currentStateProof)&&!retiring?activityEvidence.resolveProof(store,scope,value,{raw,delivered:options.deliveredSources||options.batchSources||[],old,state:activityState,minted:mintedActivities,offeredIds:options.activityContext?new Set(options.activityContext.activities.map(item=>item.id)):undefined}):null;
    if(old?.activityId&&!retiring&&!nativeActivity)throw new Error('Anchored activity updates require their original statement and activity identity proof');
    if(nativeActivity){
      const fields={...nativeActivity.fields};
      if(type==='claim'){
        if(nativeActivity.origin==='user_report'&&(value.assertionKind!=='reported'||value.attribution!=='user_report'))throw Object.assign(new Error('Activity current-state reports from private originals must retain reported/user_report attribution'),{code:'invalid_activity_event',field:'relationshipPatch.claims'});
        delete fields.occurredAt;delete fields.timeEvidence;fields.currentActivityState={status:value.currentStateProof.status,asOf:nativeActivity.statementAt,origin:nativeActivity.origin};
      }
      value={...value,...fields};delete value.activityProof;delete value.currentStateProof;
    }
    const transitionTargets=(value.transition?.targets||[]).map(target=>{
      const prior=transitionById.get(target.id);if(!prior||prior.version!==target.expectedVersion||options.previousIds&&!options.previousIds.has(prior.id))throw new Error('Stale or unavailable understanding transition target');return prior;
    });
    if(new Set(transitionTargets.map(target=>target.id)).size!==transitionTargets.length)throw new Error('Understanding transition targets must be distinct');
    const targets=[...new Map([old,...transitionTargets].filter(Boolean).map(target=>[target.id,target])).values()];
    const decisions=new Map(targets.map(target=>[target.id,decisionEvidence(target,transitionById)]));
    if(targets.some(target=>options.readOnlyIds?.has(target.id)||!decisions.get(target.id).available))throw new Error('Understanding target is read-only until its necessary original decision evidence is available');
    if(targets.some(target=>Object.entries({...target.sourceRevisions,...decisions.get(target.id).sourceRevisions,...activityEvidence.activityReferences(target)}).some(([id,revision])=>raw.get(id)?.revision!==revision)))throw new Error('Stale understanding target original evidence');
    for(const prior of transitionTargets)if(prior.recordType!==type&&prior.recordType!=='item')throw new Error('Understanding transitions cannot change record type');
    if(old&&transitionTargets.length&&(transitionTargets.length!==1||transitionTargets[0].id!==old.id))throw new Error('An existing relationship update must target only itself; omit outer id for a distinct successor');
    const reaffirm=value.transition?.operation==='reaffirm';
    if(reaffirm){
      if(transitionTargets.length!==1||transitionTargets[0].recordType!==type)throw new Error('Reaffirm exactly one same-type understanding');
      const prior=transitionTargets[0];
      if(prior.currentActivityState&&(prior.activityId!==value.activityId||prior.currentActivityState.status!==value.currentActivityState?.status))throw new Error('Reaffirm preserves the same associated activity/current-state assertion');
      if(type==='relationship_event'&&prior.activityId&&value.plannedFor===undefined&&prior.plannedFor!==undefined){value={...value,plannedFor:prior.plannedFor,plannedEvidence:prior.plannedEvidence};}
      if(value.expectedVersion!==undefined&&value.expectedVersion!==prior.version)throw new Error('Stale relationship object version');
      if(prior.lifecycle!=='active'||meaningFields[type].some(field=>field!=='text'&&!(type==='relationship_event'&&prior.activityId&&field==='activityKey')&&(prior[field]??null)!==(value[field]??null)))throw new Error('Reaffirm requires the same entity, applicability and temporal scope; use an explicit revision transition for changes');
      // Reaffirming is one versioned reread of the same understanding, even
      // when the writer supplies only the transition target and no outer id.
      old=prior;
    }
    const inPlaceTransition=!!old&&transitionTargets.length===1&&transitionTargets[0].id===old.id;
    if(inPlaceTransition&&!reaffirm&&(value.transition.operation!=='supersede'||value.lifecycle!=='superseded'))throw new Error('An in-place transition must reaffirm or explicitly supersede the existing understanding; omit outer id for a distinct successor');
    const historicalRevision=inPlaceTransition&&!reaffirm;
    const required=[...new Set([...value.sourceIds,...(nativeActivity?.identitySourceIds||[]),...targets.flatMap(target=>[...target.sourceIds,...Object.keys(decisions.get(target.id).sourceRevisions),...Object.keys(activityEvidence.activityReferences(target))])])];
    const originalRoots=sourceClosure(raw,required).map(source=>source.id);
    const delivered=options.deliveredSources||options.batchSources||[];
    const readCoverage=requireOriginals(raw,delivered,scope,originalRoots,{complete:!!old||retiring||transitionTargets.length>0});
    // Newly noticed facts may come from old originals actually reread now.
    // Every old root must be complete, even if the writer also cites a current
    // question. Current journal segments retain their existing partial policy.
    if(options.reviewedSourceIds&&!old&&!retiring&&!transitionTargets.length){
      const journalIds=options.journalSourceIds||options.reviewedSourceIds;
      const oldRoots=originalRoots.filter(id=>!journalIds.includes(id));
      if(oldRoots.length)requireOriginals(raw,delivered,scope,oldRoots,{complete:true});
    }
    let refs=historicalRevision?old.sourceIds:retiring||reaffirm?[...new Set([...old.sourceIds,...value.sourceIds])]:value.sourceIds;
    let closure=sourceClosure(raw,refs);
    if(!retiring&&type==='claim'&&value.assertionKind==='stated'&&value.subject==='contact'){
      const direct=closure.filter(s=>s.type==='qq'&&s.role==='contact');
      if(!direct.length)throw new Error('Contact statements require actual contact messages; use reported for user reports');
      // A new question may cause retrieval, but it is not a new statement by her.
      refs=direct.map(s=>s.id);closure=sourceClosure(raw,refs);
    }
    if(!retiring&&type==='claim'&&value.assertionKind==='observed'){
      const observed=closure.filter(s=>s.type==='qq');if(!observed.length)throw new Error('Observed claims require actual QQ evidence; use reported for user reports');
      refs=observed.map(s=>s.id);closure=sourceClosure(raw,refs);
    }
    if(!retiring&&type==='claim'&&value.subject==='self'&&value.aspect==='stated_preference')assertPreferenceAuthority(raw,refs);
    if(!retiring&&type==='claim'&&value.applicabilityKind==='recurring')assertPreferenceAuthority(raw,refs);
    if(type==='claim'&&value.assertionKind==='stated'&&value.subject==='contact'&&!closure.some(s=>s.type==='qq'&&s.role==='contact'))throw new Error('Contact statements require actual contact messages; use reported for user reports');
    const dates=nativeActivity&&!retiring?(reaffirm?[old.firstEvidenceAt,[old.lastEvidenceAt,nativeActivity.statementAt].sort().at(-1)]:[nativeActivity.statementAt]):refs.map(id=>raw.get(id).at).sort();
    if(old&&dates.at(-1)<old.lastEvidenceAt)throw new Error('Older backfill cannot replace newer relationship evidence');
    if(old&&options.reviewedSourceIds){const fresh=value.sourceIds.filter(id=>options.reviewedSourceIds.includes(id));const freshAt=fresh.map(id=>raw.get(id).at).sort().at(-1);const completing=old.reviewComplete===false&&fresh.some(id=>old.sourceIds.includes(id));if(freshAt&&freshAt<old.lastEvidenceAt&&!completing)throw new Error('Older newly reviewed evidence cannot retire or replace a later interpretation');}
    const {id,expectedVersion,topicKeys:inputTopics,transition:requestedTransition,...proposedSemantic}=value;
    const semantic={...proposedSemantic};
    if(reaffirm)semantic.text=old.text;
    if(historicalRevision){
      // Self-supersession marks this existing interpretation historical. Its
      // wording/provenance stays intact; proposed rewording belongs to audit.
      for(const field of meaningFields[type]){if(old[field]===undefined)delete semantic[field];else semantic[field]=old[field];}
      semantic.lifecycle='superseded';
    }
    const reviewComplete=originalRoots.every(id=>readCoverage.completeSourceIds.includes(id));
    const sourceRevisions=Object.fromEntries(closure.map(s=>[s.id,s.revision]));
    const body=retiring?{...old,lifecycle:value.lifecycle,...(type==='item'?{status:'superseded'}:{}),sourceIds:refs}: {...semantic,sourceIds:refs,topicKeys:historicalRevision?old.topicKeys||[]:value.topicKeys||[],lifecycle:value.lifecycle||'active'};
    const signature=hash({type,...semantic,sourceIds:[...refs].sort(),sourceRevisions:Object.fromEntries(Object.entries(sourceRevisions).sort(([a],[b])=>a.localeCompare(b)))});
    // Retirement changes the record's evidence, but must not erase the identity
    // of the rejected interpretation. Replaying it is an idempotent no-op;
    // genuinely new source revisions produce a different evidence signature.
    const retired=!id&&!requestedTransition&&[...existing,...checked].find(r=>r.lifecycle!=='active'&&r.retiredSemanticSignatures?.includes(signature));
    if(retired)return retired;
    const duplicate=!id&&!requestedTransition&&[...existing,...checked].find(r=>r.semanticSignature===signature);
    const previous=old||duplicate;
    if(duplicate&&duplicate.reviewComplete===reviewComplete){
      const topicKeys=[...new Set([...(duplicate.topicKeys||[]),...(inputTopics||[])])].slice(0,8);
      if(JSON.stringify(topicKeys)===JSON.stringify(duplicate.topicKeys||[]))return duplicate;
      return {...duplicate,topicKeys,version:duplicate.version+(byId.has(duplicate.id)?1:0),updatedAt:new Date().toISOString()};
    }
    const result={...body,id:previous?.id||randomUUID(),kind:type==='item'?old.kind:type==='claim'?'relationship_claim':'relationship_event',recordType:type,
      version:(previous?.version||0)+1,sourceRevisions,reviewComplete,evidenceValidity:reviewComplete?'valid':'partial',semanticSignature:signature,
      firstEvidenceAt:dates[0],lastEvidenceAt:dates.at(-1),at:dates.at(-1),reportedAt:dates.at(-1),reviewedAt:new Date().toISOString(),
      semanticReview:{status:reviewComplete?'evidence_reviewed':'partial_originals',reviewedAt:new Date().toISOString(),coverage:readCoverage},knowledgeSchemaVersion:2,
      createdAt:previous?.createdAt||new Date().toISOString(),updatedAt:new Date().toISOString()};
    if(previous?.retiredSemanticSignatures)result.retiredSemanticSignatures=previous.retiredSemanticSignatures;
    if(retiring){
      result.retiredSemanticSignatures=[...new Set([...(old.retiredSemanticSignatures||[]),old.semanticSignature].filter(Boolean))];
      for(const field of ['firstEvidenceAt','lastEvidenceAt','at','reportedAt'])if(old[field]!==undefined)result[field]=old[field];
      if(old.reportedAt===undefined)delete result.reportedAt;
      result.retirement={sourceIds:value.sourceIds,reviewedAt:result.reviewedAt};result.semanticReview.status='retired_from_originals';
    }
    if(historicalRevision){
      result.retiredSemanticSignatures=[...new Set([...(old.retiredSemanticSignatures||[]),old.semanticSignature].filter(Boolean))];
      // Marking an interpretation historical does not create new support or
      // change its evidence clocks. Reaffirmation uses admitted source dates:
      // rereads stay dated; genuine additional support can advance evidence.
      for(const field of ['firstEvidenceAt','lastEvidenceAt','at','reportedAt'])if(old[field]!==undefined)result[field]=old[field];
      if(old.reportedAt===undefined)delete result.reportedAt;
    }
    if(type==='relationship_event') {result.occurredAt=retiring||inPlaceTransition?old.occurredAt??null:value.occurredAt||null;result.occurrenceTimeStatus=retiring||inPlaceTransition?old.occurrenceTimeStatus||'unknown':value.occurredAt?'known':'unknown';result.origin=retiring||inPlaceTransition?old.origin:nativeActivity?.origin||(closure.every(s=>s.type==='qq')?'qq_observation':'user_report');}
    if(old)result.revisions=[...(old.revisions||[]),{version:old.version,semanticSignature:old.semanticSignature,operation:retiring?value.lifecycle:value.transition?.operation||'revision',reviewedAt:result.reviewedAt}];
    if(transitionTargets.length){
      result.transition={...value.transition,reviewedAt:result.reviewedAt,...(inPlaceTransition?{
        proposal:{...proposedSemantic,topicKeys:inputTopics||[]},sourceIds:value.sourceIds,
        sourceRevisions:Object.fromEntries(sourceClosure(raw,value.sourceIds).map(source=>[source.id,source.revision])),evidenceValidity:'valid'
      }:{})};
      for(const prior of transitionTargets){
        if(inPlaceTransition)continue;
        const operation=value.transition.operation;
        checked.push({...prior,lifecycle:operation==='contest'?'contested':'superseded',...(prior.recordType==='item'?{status:'superseded',semanticReview:{status:'reinterpreted_from_originals',successorId:result.id,reviewedAt:result.reviewedAt}}:{}),version:prior.version+1,
          transition:{operation,successorId:result.id,reviewedAt:result.reviewedAt},updatedAt:result.reviewedAt,
          revisions:[...(prior.revisions||[]),{version:prior.version,semanticSignature:prior.semanticSignature,operation,reviewedAt:result.reviewedAt}]});
      }
    }
    return result;
  };
  for(const c of patch.claims)checked.push(build(c,'claim'));
  for(const e of patch.events)checked.push(build(e,'relationship_event'));
  for(const r of patch.retire) {const old=transitionById.get(r.id);if(!old)throw new Error('Unknown relationship retirement');checked.push(build(r,old.recordType,true));}
  const unique=new Map();
  for(const record of checked){const prior=unique.get(record.id);if(prior&&prior!==record)throw new Error('Conflicting relationship updates for one record');unique.set(record.id,record);}
  return [...unique.values()];
}
function writeRelationshipRecords(store,scope,records) {
  const key=store.scopeKey(scope);let changed=0;const written=[];
  for(const r of records) {
    const old=store.db.prepare('SELECT record FROM memory_records WHERE scope_key=? AND id=?').get(key,r.id);
    if(old?.record===JSON.stringify(r))continue;
    store.db.prepare('INSERT INTO memory_records VALUES(?,?,?,?) ON CONFLICT(scope_key,id) DO UPDATE SET kind=excluded.kind,record=excluded.record').run(key,r.id,r.recordType,JSON.stringify(r));
    store.db.prepare('DELETE FROM memory_dependencies WHERE scope_key=? AND id=?').run(key,r.id);
    for(const [sourceId,revision] of Object.entries(dependencyRevisions(r)))store.db.prepare('INSERT INTO memory_dependencies VALUES(?,?,?,?)').run(key,r.id,sourceId,revision);
    changed++;written.push(r);
  }
  if(written.some(r=>r.recordType==='relationship_event'))store.experiences.observeRelationshipEvents(scope,written);
  return changed;
}
function relationshipView(store,scope,{query='',limit=24,asOf}={}) {
  const historical=asOf!==undefined;asOf=asOf||new Date().toISOString();
  const now=Date.parse(asOf);if(!Number.isFinite(now))throw new Error('Invalid relationship view date');
  const raw=new Map(store._rawMemorySources(scope).map(s=>[s.id,s]));
  const all=store._memoryRecords(scope).filter(typed).filter(r=>Object.entries(r.sourceRevisions||{}).every(([id,rev])=>raw.get(id)?.revision===rev&&(!historical||Date.parse(raw.get(id).at)<=now)));
  const selected=rank(all,String(query),{limit:Math.max(1,Math.min(100,Number(limit)||24))});
  const keys=new Set(selected.filter(r=>r.recordType==='relationship_event'&&!r.activityId).map(r=>r.activityKey));
  // An activity is read with its entire current milestone chain, not an isolated
  // old acceptance. The caller still budgets the resulting context as a unit.
  const eventClock=event=>event.occurredAt||event.lastEvidenceAt;
  const events=all.filter(r=>r.recordType==='relationship_event'&&(r.activityId||keys.has(r.activityKey))).map(event=>({...activityEvidence.evidenceViewRecord(event),...(!event.activityId?{identityStatus:'legacy_unbound',activityEvidenceStatus:'canonical_api_compatibility_not_native_identity_proof'}:{}),...(event.occurrenceTimeStatus==='legacy_unverified'?{occurredAt:null}:{})})).sort((a,b)=>eventClock(a).localeCompare(eventClock(b))||a.id.localeCompare(b.id));
  const claims=selected.filter(r=>r.recordType==='claim').map(r=>({...activityEvidence.evidenceViewRecord(r),applicability:r.lifecycle!=='active'?'inactive':!r.reviewComplete?'needs_review':r.validUntil&&Date.parse(r.validUntil)<now?'expired':r.validFrom&&Date.parse(r.validFrom)>now?'not_yet_valid':r.applicabilityKind==='conditional'?'conditional':r.validUntil?'current':r.applicabilityKind==='recurring'?'recurring':r.applicabilityKind==='local'?'local':r.applicabilityKind==='temporary'?'dated_context':'unspecified'}));
  const gaps=store.db.prepare('SELECT record FROM memory_gaps WHERE scope_key=?').all(store.scopeKey(scope)).map(row=>JSON.parse(row.record));
  const activities=[...keys].map(activityKey=>{
    const milestones=events.filter(e=>!e.activityId&&e.activityKey===activityKey&&e.lifecycle==='active');
    const statuses={invitation:'invited',acceptance:'accepted',decline:'declined',reschedule:'rescheduled',cancellation:'cancelled',occurred:'occurred'};
    const current=milestones.filter(e=>statuses[e.eventKind]).at(-1)||milestones.at(-1);
    const laterGap=gaps.some(gap=>gap.activityDigest===hash(activityKey)&&(!current||gap.orderAt>eventClock(current)));
    const unknownOrder=milestones.some(event=>statuses[event.eventKind]&&!event.occurredAt&&event.occurrenceTimeStatus!=='legacy_unverified');
    return {activityKey,identityStatus:'legacy_unbound',qualified:true,status:laterGap||current&&!current.reviewComplete||unknownOrder?'needs_review':statuses[current?.eventKind]||'observed',authority:laterGap?'withdrawn_evidence_gap':current?.origin==='user_report'?'legacy_user_reported':'legacy_source_statement',eventIds:milestones.map(e=>e.id),sourceIds:[...new Set(milestones.flatMap(e=>e.sourceIds))],lastEvidenceAt:current?.lastEvidenceAt||null};
  });
  const anchored=activityEvidence.publicActivities(all,gaps,raw);activities.push(...anchored.activities);
  const meta=store.db.prepare('SELECT version,processor_version FROM memory_meta WHERE scope_key=?').get(store.scopeKey(scope));
  const pending=store.db.prepare("SELECT count(*) n FROM memory_journal WHERE scope_key=? AND status='pending'").get(store.scopeKey(scope)).n;
  return {scope:{...scope},version:meta?.version||0,asOf:new Date(now).toISOString(),claims,events,self:claims.filter(r=>r.subject==='self'),contact:claims.filter(r=>r.subject==='contact'),dyad:claims.filter(r=>r.subject==='dyad'),activities,activityUncertainties:anchored.activityUncertainties,
    coverage:{pending,semanticPending:all.filter(record=>record.reviewComplete===false).length,processorVersion:meta?.processor_version||null,bootstrapPending:meta?.processor_version!==PROCESSOR_VERSION||!!store.db.prepare("SELECT 1 FROM memory_journal WHERE scope_key=? AND status='pending' AND operation='reindex' LIMIT 1").get(store.scopeKey(scope)),history:store.coverage(scope),semanticCertainty:false}};
}
function personUnderstanding(store,scope,options={}){
  const view=relationshipView(store,scope,options),group=()=>({knownFacts:[],recentCircumstances:[],uncertainties:[],boundaries:[]});
  const result={version:view.version,asOf:view.asOf,self:group(),contact:group(),dyad:group(),coverage:{...view.coverage,semanticReview:'evidence_based_not_entailment_proof'}};
  for(const claim of view.claims){
    if(claim.lifecycle!=='active')continue;
    const uncertain=!claim.reviewComplete||claim.epistemicStatus!=='supported'||claim.assertionKind==='inferred'||['expired','not_yet_valid','needs_review','unspecified'].includes(claim.applicability);
    const field=uncertain?'uncertainties':claim.aspect==='boundary'?'boundaries':['local','temporary'].includes(claim.applicabilityKind)?'recentCircumstances':'knownFacts';
    result[claim.subject][field].push(claim);
  }
  return result;
}
module.exports={PROCESSOR_VERSION,prepareRelationshipPatch,writeRelationshipRecords,relationshipView,personUnderstanding,decisionRevisions,decisionEvidence,repairRelationshipTransitions,invalidateRelationshipDecision};
