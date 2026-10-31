'use strict';
const {randomUUID,createHash}=require('node:crypto');
const {rank}=require('./memory-search.cjs');
const {normalizeRelationshipPatch}=require('./relationship-schema.cjs');
const {sourceClosure,assertPreferenceAuthority}=require('./provenance.cjs');
const {requireOriginals}=require('./original-evidence.cjs');
const PROCESSOR_VERSION='evidence-backed-understanding-2026-10-31.1';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const typed=r=>r.recordType==='claim'||r.recordType==='relationship_event';
function prepareRelationshipPatch(store,scope,input,options={}) {
  const patch=normalizeRelationshipPatch(input),raw=new Map(store._rawMemorySources(scope).map(s=>[s.id,s]));
  const allowed=new Set(options.sourceIds||[]),records=store._memoryRecords(scope),existing=records.filter(typed),byId=new Map(existing.map(r=>[r.id,r])),transitionById=new Map(records.filter(record=>typed(record)||record.recordType==='item').map(record=>[record.id,record]));
  const checked=[];
  const build=(value,type,retiring=false)=>{
    if(value.sourceIds.some(id=>!allowed.has(id)||!raw.has(id)))throw new Error('Unavailable or undelivered relationship evidence');
    if(options.sourceRevisions&&value.sourceIds.some(id=>options.sourceRevisions[id]!==raw.get(id).revision))throw new Error('Stale relationship source');
    const old=value.id&&byId.get(value.id);
    if(value.id&&!old)throw new Error('Unknown relationship record');
    if(old&&old.recordType!==type)throw new Error('Relationship record type cannot change');
    if(old&&value.expectedVersion!==undefined&&old.version!==value.expectedVersion)throw new Error('Stale relationship object version');
    if(old&&options.previousIds&&!options.previousIds.has(old.id))throw new Error('Relationship update target was not delivered');
    const transitionTargets=(value.transition?.targets||[]).map(target=>{
      const prior=transitionById.get(target.id);if(!prior||prior.version!==target.expectedVersion||options.previousIds&&!options.previousIds.has(prior.id))throw new Error('Stale or unavailable understanding transition target');return prior;
    });
    const required=[...new Set([...value.sourceIds,...(old?.sourceIds||[]),...transitionTargets.flatMap(target=>target.sourceIds)])];
    const originalRoots=sourceClosure(raw,required).map(source=>source.id);
    const delivered=options.deliveredSources||options.batchSources||[];
    const readCoverage=requireOriginals(raw,delivered,scope,originalRoots,{complete:!!old||retiring||transitionTargets.length>0});
    if(options.reviewedSourceIds&&!value.sourceIds.some(id=>options.reviewedSourceIds.includes(id)))throw new Error('Relationship update needs newly reviewed evidence');
    let refs=retiring?[...new Set([...old.sourceIds,...value.sourceIds])]:value.sourceIds;
    let closure=sourceClosure(raw,refs);
    if(type==='claim'&&value.assertionKind==='stated'&&value.subject==='contact'){
      const direct=closure.filter(s=>s.type==='qq'&&s.role==='contact');
      if(!direct.length)throw new Error('Contact statements require actual contact messages; use reported for user reports');
      // A new question may cause retrieval, but it is not a new statement by her.
      refs=direct.map(s=>s.id);closure=sourceClosure(raw,refs);
    }
    if(type==='claim'&&value.assertionKind==='observed'){
      const observed=closure.filter(s=>s.type==='qq');if(!observed.length)throw new Error('Observed claims require actual QQ evidence; use reported for user reports');
      refs=observed.map(s=>s.id);closure=sourceClosure(raw,refs);
    }
    if(type==='claim'&&value.subject==='self'&&value.aspect==='stated_preference')assertPreferenceAuthority(raw,refs);
    if(type==='claim'&&value.applicabilityKind==='recurring')assertPreferenceAuthority(raw,refs);
    if(type==='claim'&&value.assertionKind==='stated'&&value.subject==='contact'&&!closure.some(s=>s.type==='qq'&&s.role==='contact'))throw new Error('Contact statements require actual contact messages; use reported for user reports');
    const dates=refs.map(id=>raw.get(id).at).sort();
    if(old&&dates.at(-1)<old.lastEvidenceAt)throw new Error('Older backfill cannot replace newer relationship evidence');
    if(old&&options.reviewedSourceIds){const fresh=value.sourceIds.filter(id=>options.reviewedSourceIds.includes(id));const freshAt=fresh.map(id=>raw.get(id).at).sort().at(-1);const completing=old.reviewComplete===false&&fresh.some(id=>old.sourceIds.includes(id));if(freshAt&&freshAt<old.lastEvidenceAt&&!completing)throw new Error('Older newly reviewed evidence cannot retire or replace a later interpretation');}
    const {id,expectedVersion,topicKeys:inputTopics,...semantic}=value;
    const reviewComplete=originalRoots.every(id=>readCoverage.completeSourceIds.includes(id));
    const sourceRevisions=Object.fromEntries(closure.map(s=>[s.id,s.revision]));
    const body=retiring?{...old,lifecycle:value.lifecycle,sourceIds:refs}: {...semantic,sourceIds:refs,topicKeys:value.topicKeys||[],lifecycle:value.lifecycle||'active'};
    const signature=hash({type,...semantic,sourceIds:[...refs].sort(),sourceRevisions:Object.fromEntries(Object.entries(sourceRevisions).sort(([a],[b])=>a.localeCompare(b)))});
    // Retirement changes the record's evidence, but must not erase the identity
    // of the rejected interpretation. Replaying it is an idempotent no-op;
    // genuinely new source revisions produce a different evidence signature.
    const retired=!id&&[...existing,...checked].find(r=>r.lifecycle!=='active'&&r.retiredSemanticSignatures?.includes(signature));
    if(retired)return retired;
    const duplicate=!id&&[...existing,...checked].find(r=>r.semanticSignature===signature);
    const previous=old||duplicate;
    if(duplicate&&duplicate.reviewComplete===reviewComplete){
      const topicKeys=[...new Set([...(duplicate.topicKeys||[]),...(inputTopics||[])])].slice(0,8);
      if(JSON.stringify(topicKeys)===JSON.stringify(duplicate.topicKeys||[]))return duplicate;
      return {...duplicate,topicKeys,version:duplicate.version+(byId.has(duplicate.id)?1:0),updatedAt:new Date().toISOString()};
    }
    const result={...body,id:previous?.id||randomUUID(),kind:type==='claim'?'relationship_claim':'relationship_event',recordType:type,
      version:(previous?.version||0)+1,sourceRevisions,reviewComplete,evidenceValidity:reviewComplete?'valid':'partial',semanticSignature:signature,
      firstEvidenceAt:dates[0],lastEvidenceAt:dates.at(-1),at:dates.at(-1),reportedAt:dates.at(-1),reviewedAt:new Date().toISOString(),
      semanticReview:{status:reviewComplete?'evidence_reviewed':'partial_originals',reviewedAt:new Date().toISOString(),coverage:readCoverage},knowledgeSchemaVersion:2,
      createdAt:previous?.createdAt||new Date().toISOString(),updatedAt:new Date().toISOString()};
    if(retiring)result.retiredSemanticSignatures=[...new Set([...(old.retiredSemanticSignatures||[]),old.semanticSignature])];
    if(type==='relationship_event') {result.occurredAt=value.occurredAt||null;result.occurrenceTimeStatus=value.occurredAt?'known':'unknown';result.origin=closure.every(s=>s.type==='qq')?'qq_observation':'user_report';}
    if(old)result.revisions=[...(old.revisions||[]),{version:old.version,semanticSignature:old.semanticSignature,operation:retiring?value.lifecycle:value.transition?.operation||'revision',reviewedAt:result.reviewedAt}];
    if(transitionTargets.length){
      result.transition={...value.transition,reviewedAt:result.reviewedAt};
      for(const prior of transitionTargets){
        if(prior.recordType!==type&&prior.recordType!=='item')throw new Error('Understanding transitions cannot change record type');
        const operation=value.transition.operation;
        if(operation==='reaffirm'&&transitionTargets.length!==1)throw new Error('Reaffirm exactly one understanding');
        if(operation==='reaffirm'&&prior.text!==value.text)throw new Error('Changed understanding requires an explicit revision transition');
        checked.push({...prior,lifecycle:operation==='contest'?'contested':'superseded',...(prior.recordType==='item'?{status:'superseded',semanticReview:{status:'reinterpreted_from_originals',successorId:result.id,reviewedAt:result.reviewedAt}}:{}),version:prior.version+1,
          transition:{operation,successorId:result.id,reviewedAt:result.reviewedAt},updatedAt:result.reviewedAt,
          revisions:[...(prior.revisions||[]),{version:prior.version,semanticSignature:prior.semanticSignature,operation,reviewedAt:result.reviewedAt}]});
      }
    }
    return result;
  };
  for(const c of patch.claims)checked.push(build(c,'claim'));
  for(const e of patch.events)checked.push(build(e,'relationship_event'));
  for(const r of patch.retire) {const old=byId.get(r.id);if(!old)throw new Error('Unknown relationship retirement');checked.push(build(r,old.recordType,true));}
  const unique=new Map();
  for(const record of checked){const prior=unique.get(record.id);if(prior&&prior.semanticSignature!==record.semanticSignature)throw new Error('Conflicting relationship updates for one record');unique.set(record.id,record);}
  return [...unique.values()];
}
function writeRelationshipRecords(store,scope,records) {
  const key=store.scopeKey(scope);let changed=0;const written=[];
  for(const r of records) {
    const old=store.db.prepare('SELECT record FROM memory_records WHERE scope_key=? AND id=?').get(key,r.id);
    if(old?.record===JSON.stringify(r))continue;
    store.db.prepare('INSERT INTO memory_records VALUES(?,?,?,?) ON CONFLICT(scope_key,id) DO UPDATE SET kind=excluded.kind,record=excluded.record').run(key,r.id,r.recordType,JSON.stringify(r));
    store.db.prepare('DELETE FROM memory_dependencies WHERE scope_key=? AND id=?').run(key,r.id);
    for(const [sourceId,revision] of Object.entries(r.sourceRevisions))store.db.prepare('INSERT INTO memory_dependencies VALUES(?,?,?,?)').run(key,r.id,sourceId,revision);
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
  const keys=new Set(selected.filter(r=>r.recordType==='relationship_event').map(r=>r.activityKey));
  // An activity is read with its entire current milestone chain, not an isolated
  // old acceptance. The caller still budgets the resulting context as a unit.
  const eventClock=event=>event.occurredAt||event.lastEvidenceAt;
  const events=all.filter(r=>r.recordType==='relationship_event'&&keys.has(r.activityKey)).map(event=>event.occurrenceTimeStatus==='legacy_unverified'?{...event,occurredAt:null}:event).sort((a,b)=>eventClock(a).localeCompare(eventClock(b))||a.id.localeCompare(b.id));
  const claims=selected.filter(r=>r.recordType==='claim').map(r=>({...r,applicability:r.lifecycle!=='active'?'inactive':!r.reviewComplete?'needs_review':r.validUntil&&Date.parse(r.validUntil)<now?'expired':r.validFrom&&Date.parse(r.validFrom)>now?'not_yet_valid':r.applicabilityKind==='conditional'?'conditional':r.validUntil?'current':r.applicabilityKind==='recurring'?'recurring':r.applicabilityKind==='local'?'local':r.applicabilityKind==='temporary'?'dated_context':'unspecified'}));
  const gaps=store.db.prepare('SELECT record FROM memory_gaps WHERE scope_key=?').all(store.scopeKey(scope)).map(row=>JSON.parse(row.record));
  const activities=[...keys].map(activityKey=>{
    const milestones=events.filter(e=>e.activityKey===activityKey&&e.lifecycle==='active');
    const statuses={invitation:'invited',acceptance:'accepted',decline:'declined',reschedule:'rescheduled',cancellation:'cancelled',occurred:'occurred'};
    const current=milestones.filter(e=>statuses[e.eventKind]).at(-1)||milestones.at(-1);
    const laterGap=gaps.some(gap=>gap.activityDigest===hash(activityKey)&&(!current||gap.orderAt>eventClock(current)));
    const unknownOrder=milestones.some(event=>statuses[event.eventKind]&&!event.occurredAt&&event.occurrenceTimeStatus!=='legacy_unverified');
    return {activityKey,status:laterGap||current&&!current.reviewComplete||unknownOrder?'needs_review':statuses[current?.eventKind]||'observed',authority:laterGap?'withdrawn_evidence_gap':current?.origin==='user_report'?'user_reported':'source_backed_statement',eventIds:milestones.map(e=>e.id),sourceIds:[...new Set(milestones.flatMap(e=>e.sourceIds))],lastEvidenceAt:current?.lastEvidenceAt||null};
  });
  const meta=store.db.prepare('SELECT version,processor_version FROM memory_meta WHERE scope_key=?').get(store.scopeKey(scope));
  const pending=store.db.prepare("SELECT count(*) n FROM memory_journal WHERE scope_key=? AND status='pending'").get(store.scopeKey(scope)).n;
  return {scope:{...scope},version:meta?.version||0,asOf:new Date(now).toISOString(),claims,events,self:claims.filter(r=>r.subject==='self'),contact:claims.filter(r=>r.subject==='contact'),dyad:claims.filter(r=>r.subject==='dyad'),activities,
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
module.exports={PROCESSOR_VERSION,prepareRelationshipPatch,writeRelationshipRecords,relationshipView,personUnderstanding};
