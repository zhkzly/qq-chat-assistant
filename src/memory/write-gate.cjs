'use strict';
// M3 Write Gate — decision-split memory write admission (greenfield design §2.2).
//
// The generation model proposes observation-bound CONTENT only. Every other
// decision in this module is program-owned:
//   - per-record validation and admission (generalized partial commit),
//   - applicability classification (corrections become scoped overlays with
//     the narrowest default scope; they are never preference reclassifications),
//   - stability promotion authority (user attestation or program counting only;
//     a model `explicitPreference` flag is never accepted as attestation),
//   - journal progress (the review journal always advances past a batch whose
//     remaining proposals are all quarantined — the B1 journal-jam fix),
//   - transition-chain atomicity (a supersede/contest/merge successor and its
//     targets commit or quarantine as one unit).
//
// Integration shape (greenfield design §4.3 MW1 "shimmed against current
// tables"): this module is additive. It owns three new tables
// (memory_overlays, memory_preference_candidates, memory_preferences) created
// lazily, reuses the existing memory_journal/memory_records/memory_receipts
// tables, and does not modify Store.applyMemoryBatch or any existing caller.
// Clean results delegate to Store.applyMemoryBatch unchanged (zero drift);
// only results that today would be rejected as a whole enter the gate path.
// Validation fidelity for survivors is preserved by probing the REAL apply
// path inside rolled-back transactions, so no validation logic is duplicated.
//
// Evidence class: source-only structural implementation verified by
// deterministic unit tests on fictional stores; no semantic-quality claim.
const {randomUUID}=require('node:crypto');
const {sourceClosure,isLocalFeedback}=require('../provenance.cjs');
const {ownerAuthoredRecord,observationSpeaker}=require('../speaker-identity.cjs');
const {coverageFor}=require('../original-evidence.cjs');

const GATE_VERSION='memory-write-gate-m3-2026-11-01.1';

// Receipt vocabulary for gate decisions. These quarantine receipts replace the
// preference-only PREFERENCE_GATE_CODES quarantine of the legacy path with a
// generalized per-record vocabulary (design §2.2 "failure handling").
const RECEIPT_CODES=Object.freeze({
  // A durable/preference proposal whose evidence closure contains local
  // feedback is recorded NARROWER as a scoped overlay instead of being
  // rejected (misclassification degrades to "recorded narrower").
  PREFERENCE_DEMOTED_TO_OVERLAY:'preference_demoted_to_scoped_overlay',
  // A durable user preference without owner-authored statement evidence needs
  // user attestation; the claim is not stored active, only a candidate is.
  PREFERENCE_REQUIRES_ATTESTATION:'preference_promotion_requires_user_attestation',
  // Legacy kind=preference items are never active records from model output;
  // they become attestation candidates (any explicitPreference flag ignored).
  LEGACY_PREFERENCE_REQUIRES_ATTESTATION:'legacy_preference_item_requires_user_attestation',
  // A record failed the real per-record validation; quarantined in isolation.
  RECORD_VALIDATION_FAILED:'record_validation_failed',
  // Records that are individually valid but conflict with each other; the
  // later conflicting proposal(s) are quarantined so the rest commit.
  RECORD_CONFLICT_QUARANTINED:'record_conflict_quarantined',
});

// Applicability kinds that explicitly deny durability. Mirror of the legacy
// SCOPED_CORRECTION_APPLICABILITY set (relationship-store.cjs).
const SCOPED_APPLICABILITY=new Set(['local','temporary']);

// Rejections of Store.applyMemoryBatch that mean "this result does not
// correspond to this batch" (frame errors) are returned unchanged and the
// journal does not advance. Only the two record-level reasons enter the gate
// path: 'invalid_memory_result' (a thrown per-record validation error) and
// 'legacy_rewrite_not_allowed_in_recovery' (only result.items triggers it).
// Any unknown rejection reason also passes through unchanged (conservative).
const RECORD_LEVEL_REASONS=new Set(['invalid_memory_result','legacy_rewrite_not_allowed_in_recovery']);
const isFrameRejection=reason=>!RECORD_LEVEL_REASONS.has(reason);
const PROBE_ROLLBACK=Symbol('write-gate-probe-rollback');

const nowIso=()=>new Date().toISOString();
const episodeKeyOf=overlay=>overlay.scope.bound?.episodeKey
  ||(overlay.evidence.issuedAt||overlay.recordedAt).slice(0,10);

// Program-owned applicability classification for one typed claim proposal.
// Pure function over the proposal and its resolved evidence closure; never
// reads the model's own stability attestation.
function classifyClaim(record,closure) {
  const durableUserPreference=record.subject==='self'&&record.aspect==='stated_preference'
    &&!SCOPED_APPLICABILITY.has(record.applicabilityKind||'unspecified');
  const claimsRecurring=record.applicabilityKind==='recurring';
  const feedbackEvidence=closure.filter(isLocalFeedback);
  if((durableUserPreference||claimsRecurring)&&feedbackEvidence.length)
    return {decision:'overlay',feedbackEvidence};
  if(durableUserPreference&&!closure.some(ownerAuthoredRecord))
    return {decision:'candidate'};
  return {decision:'claim',
    stabilityAuthority:durableUserPreference?'owner_statement_evidence'
      :claimsRecurring?(closure.some(ownerAuthoredRecord)?'owner_statement_evidence':'other_statement_evidence')
      :'not_applicable'};
}

function createWriteGate({store,config={}}) {
  const repetitionThreshold=Math.max(2,Math.min(10,Number(config.repetitionThreshold)||3));
  const quarantineThreshold=Math.max(0,Math.min(1,Number(config.quarantineThreshold)||0.25));
  const quarantineMinBatches=Math.max(1,Math.min(1000,Number(config.quarantineMinBatches)||3));
  let tablesReady=false;
  const ensureTables=()=>{
    if(tablesReady)return;
    store.db.exec(`CREATE TABLE IF NOT EXISTS memory_overlays(scope_key TEXT NOT NULL,id TEXT NOT NULL,record TEXT NOT NULL,PRIMARY KEY(scope_key,id));
CREATE TABLE IF NOT EXISTS memory_preference_candidates(scope_key TEXT NOT NULL,id TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',record TEXT NOT NULL,PRIMARY KEY(scope_key,id));
CREATE TABLE IF NOT EXISTS memory_preferences(scope_key TEXT NOT NULL,id TEXT NOT NULL,record TEXT NOT NULL,PRIMARY KEY(scope_key,id));`);
    tablesReady=true;
  };

  // ---- Decision-split classification (no writes) ----
  // Splits a decoded result into survivor units, scoped overlays, preference
  // candidates and per-record receipts. Survivor units keep their original
  // field path for receipts.
  function classify(scope,batch,result) {
    const key=store.scopeKey(scope);
    // Read through the public synced projection so classification sees the
    // same source state the apply path will see after its own _syncMemory.
    const raw=new Map(store.memorySources(scope).map(source=>[source.id,source]));
    const survivors=[],overlays=[],candidates=[],receipts=[],authorities=[];
    const closureOf=ids=>{try{return sourceClosure(raw,ids);}catch{return null;}};
    const overlayFor=(record,field,feedbackEvidence)=>{
      // Narrowest default scope: the correction reaches the next exchange
      // bound to the feedback observation that carried it. issuedAt is source
      // time, not wall-clock time.
      const bound=feedbackEvidence.slice().sort((a,b)=>a.at.localeCompare(b.at)||a.id.localeCompare(b.id)).at(-1);
      const evidenceIds=[...new Set([...record.sourceIds,...feedbackEvidence.map(source=>source.id)])]
        .filter(id=>raw.has(id));
      return {id:`ov_${randomUUID()}`,gateVersion:GATE_VERSION,
        target:{kind:'claim',subject:record.subject||'self',aspect:record.aspect||'stated_preference'},
        scope:{kind:'next_exchange',bound:{sourceId:bound.id}},
        text:record.text,evidence:{sourceIds:evidenceIds,
          sourceRevisions:Object.fromEntries(evidenceIds.map(id=>[id,raw.get(id).revision])),
          issuedAt:bound.at},
        speaker:observationSpeaker(bound),issuedAt:bound.at,recordedAt:nowIso(),status:'active',
        demotion:{fromApplicabilityKind:record.applicabilityKind||'unspecified',field}};
    };
    const candidateFor=(record,field,basis,extra={})=>({
      id:`pc_${randomUUID()}`,gateVersion:GATE_VERSION,basis,
      subject:record.subject||'self',aspect:record.aspect||'stated_preference',
      text:record.text,evidence:{sourceIds:record.sourceIds.filter(id=>raw.has(id)),
        sourceRevisions:Object.fromEntries(record.sourceIds.filter(id=>raw.has(id)).map(id=>[id,raw.get(id).revision]))},
      status:'pending',createdAt:nowIso(),updatedAt:nowIso(),field,...extra});
    const claimUnits=(result.relationshipPatch?.claims||[]);
    claimUnits.forEach((record,index)=>{
      const field=`relationshipPatch.claims[${index}]`;
      const closure=closureOf(record.sourceIds||[]);
      if(!closure){survivors.push({slice:'claims',record,field});return;} // probe will report the exact error
      const verdict=classifyClaim(record,closure);
      if(verdict.decision==='overlay'){
        const overlay=overlayFor(record,field,verdict.feedbackEvidence);
        overlays.push(overlay);
        receipts.push({field,code:RECEIPT_CODES.PREFERENCE_DEMOTED_TO_OVERLAY,
          message:'A durable preference proposal backed by local feedback evidence was recorded narrower as a scoped overlay',
          allowedShape:'File the correction with applicability local/temporary, or quote the account owner own explicit recurring statement as evidence',
          reclassifiedAs:{kind:'overlay',id:overlay.id,scope:overlay.scope}});
      }else if(verdict.decision==='candidate'){
        const candidate=candidateFor(record,field,'demoted_preference');
        candidates.push(candidate);
        receipts.push({field,code:RECEIPT_CODES.PREFERENCE_REQUIRES_ATTESTATION,
          message:'Stable preference promotion needs the account owner own explicit statement evidence or a user attestation; filed as a pending candidate',
          allowedShape:'Cite the owner own explicit recurring statement, or keep the correction scoped (local/temporary)',
          reclassifiedAs:{kind:'preference_candidate',id:candidate.id}});
      }else{
        survivors.push({slice:'claims',record,field});
        authorities.push({field,stabilityAuthority:verdict.stabilityAuthority});
      }
    });
    for(const [slice,records] of [['events',result.relationshipPatch?.events||[]],['retire',result.relationshipPatch?.retire||[]]])
      records.forEach((record,index)=>survivors.push({slice,record,field:`relationshipPatch.${slice}[${index}]`}));
    for(const [slice,records] of [['items',result.items||[]],['episodes',result.episodes||[]],['legacyRetire',result.retire||[]]])
      records.forEach((record,index)=>{
        const field=slice==='legacyRetire'? `retire[${index}]` : `${slice}[${index}]`;
        if(slice==='items'&&record.kind==='preference'){
          // The model never attests: an explicitPreference flag on the wire is
          // ignored and receipted, never honored (design §2.2).
          const candidate=candidateFor(record,field,'legacy_preference_item',
            record.explicitPreference===true?{modelAttestationIgnored:true}:{});
          candidates.push(candidate);
          receipts.push({field,code:RECEIPT_CODES.LEGACY_PREFERENCE_REQUIRES_ATTESTATION,
            message:record.explicitPreference===true
              ?'Model-authored explicitPreference attestation ignored; filed as a pending candidate for user attestation'
              :'Legacy preference items become pending candidates; only user attestation activates a preference',
            allowedShape:'A sourced fact/uncertainty, or a scoped correction; stable preferences are activated only by user attestation',
            reclassifiedAs:{kind:'preference_candidate',id:candidate.id}});
          return;
        }
        survivors.push({slice,record,field});
      });
    return {scopeKey:key,raw,survivors,overlays,candidates,receipts,authorities};
  }

  // ---- Rollback probe of the real apply path ----
  // Runs Store.applyMemoryBatch inside a transaction that is always rolled
  // back, so a probe never persists. Because Store._atomic reenters safely
  // (it checks db.isTransaction), the inner apply runs unchanged inside our
  // outer transaction and all of its writes vanish on rollback.
  function probeApply(scope,batch,result) {
    let outcome;
    try{store._atomic(()=>{outcome=store.applyMemoryBatch(scope,batch,result);throw PROBE_ROLLBACK;});}
    catch(error){if(error!==PROBE_ROLLBACK)throw error;}
    return outcome;
  }

  function subsetResult(result,units) {
    const pick=slice=>units.filter(unit=>unit.slice===slice).map(unit=>unit.record);
    const subset={reviewedSourceIds:result.reviewedSourceIds,
      items:pick('items'),episodes:pick('episodes'),retire:pick('legacyRetire'),
      relationshipPatch:{claims:pick('claims'),events:pick('events'),retire:pick('retire')}};
    if(result.originalDelivery!==undefined)subset.originalDelivery=result.originalDelivery;
    return subset;
  }

  // Deterministic culprit isolation. Finds minimal failing units by probing
  // subsets; individually-valid records that only fail together are conflict
  // groups whose later members are quarantined so the earlier ones commit.
  function isolate(scope,batch,result,survivors) {
    const receipts=[];
    const receiptFor=(unit,code,message,extra={})=>({field:unit.field,code,message,...extra,
      ...(unit.record.transition?{chain:{operation:unit.record.transition.operation,
        targets:unit.record.transition.targets.map(target=>target.id)}}:{})});
    const probe=units=>probeApply(scope,batch,subsetResult(result,units));
    if(!survivors.length)return {cleanResult:null,receipts};
    if(probe(survivors).applied)return {cleanResult:subsetResult(result,survivors),receipts};
    const findFailing=units=>{
      const rejection=probe(units);
      if(rejection.applied)return null;
      if(units.length===1)
        return {unit:units[0],code:RECEIPT_CODES.RECORD_VALIDATION_FAILED,message:rejection.detail||rejection.reason};
      const mid=Math.ceil(units.length/2),left=units.slice(0,mid),right=units.slice(mid);
      const fromLeft=findFailing(left),fromRight=findFailing(right);
      if(fromLeft&&fromLeft.conflict&&fromRight&&!fromRight.conflict)return fromRight;
      if(fromRight&&fromRight.conflict&&fromLeft&&!fromLeft.conflict)return fromLeft;
      if(fromLeft&&!fromLeft.conflict)return fromLeft;
      if(fromRight&&!fromRight.conflict)return fromRight;
      if(fromLeft)return fromLeft;
      if(fromRight)return fromRight;
      // Both halves apply alone but the union fails: a cross-record conflict.
      return {conflict:true,units,detail:rejection.detail||rejection.reason};
    };
    let remaining=[...survivors];
    while(remaining.length) {
      const found=findFailing(remaining);
      if(!found)break;
      if(found.conflict){
        // Keep the earliest proposal, quarantine the later conflicting ones.
        for(const unit of found.units.slice(1))receipts.push(receiptFor(unit,RECEIPT_CODES.RECORD_CONFLICT_QUARANTINED,
          `Conflicting proposals for one record; the later conflicting proposal was quarantined (${found.detail})`));
        const dropped=new Set(found.units.slice(1));
        remaining=remaining.filter(unit=>!dropped.has(unit));
      }else{
        receipts.push(receiptFor(found.unit,found.code,found.message));
        remaining=remaining.filter(unit=>unit!==found.unit);
      }
      if(probe(remaining).applied)break;
    }
    return {cleanResult:remaining.length?subsetResult(result,remaining):null,receipts};
  }

  // ---- Gate apply: drop-in replacement for Store.applyMemoryBatch ----
  // Decision order:
  //   1. classify every proposal (program-owned, no writes);
  //   2. if the classifier made no decision (the common case), apply the
  //      result through Store.applyMemoryBatch unchanged — zero drift for
  //      clean results; frame rejections pass through with the journal
  //      unmoved, record-level failures continue into isolation;
  //   3. otherwise (or after a record-level failure) commit through the gate:
  //      survivors isolated per record, reclassifications persisted, journal
  //      always advancing with a receipt for everything refused.
  function apply(scope,batch,result) {
    ensureTables();
    const classified=classify(scope,batch,result);
    const gateDecided=classified.overlays.length>0||classified.candidates.length>0||classified.receipts.length>0;
    if(!gateDecided){
      const direct=store.applyMemoryBatch(scope,batch,result);
      if(direct.applied)return direct;
      if(isFrameRejection(direct.reason))return direct;
      return commitGated(scope,batch,result,classified,direct);
    }
    return commitGated(scope,batch,result,classified,null);
  }

  function commitGated(scope,batch,result,classified,directRejection) {
    const key=store.scopeKey(scope);
    const isolation=isolate(scope,batch,result,classified.survivors);
    return store._atomic(()=>{
      let applied=null;
      if(isolation.cleanResult){
        applied=store.applyMemoryBatch(scope,batch,isolation.cleanResult);
        if(!applied.applied)return applied;
      }
      const receipts=[...classified.receipts,...isolation.receipts];
      const writeOverlay=overlay=>store.db.prepare('INSERT OR REPLACE INTO memory_overlays VALUES(?,?,?)')
        .run(key,overlay.id,JSON.stringify(overlay));
      const writeCandidate=candidate=>store.db.prepare('INSERT OR REPLACE INTO memory_preference_candidates VALUES(?,?,?,?)')
        .run(key,candidate.id,candidate.status,JSON.stringify(candidate));
      classified.overlays.forEach(writeOverlay);
      classified.candidates.forEach(writeCandidate);
      const gate={version:GATE_VERSION,receipts,
        reclassifications:{overlays:classified.overlays.map(overlay=>({id:overlay.id,scope:overlay.scope,field:overlay.demotion.field})),
          candidates:classified.candidates.map(candidate=>({id:candidate.id,basis:candidate.basis,field:candidate.field}))},
        stabilityAuthorities:classified.authorities};
      if(applied){
        // Decorate the legacy receipt so the quarantine and gate decisions
        // stay visible beside the committed records.
        const row=store.db.prepare('SELECT record FROM memory_receipts WHERE scope_key=? AND batch_id=?').get(key,batch.id);
        const receipt={...JSON.parse(row.record),
          quarantinedRecords:[...(JSON.parse(row.record).quarantinedRecords||[]),...receipts],gate};
        store.db.prepare('UPDATE memory_receipts SET record=? WHERE scope_key=? AND batch_id=?').run(JSON.stringify(receipt),key,batch.id);
        return {applied:true,receipt};
      }
      // No record committed, yet the journal advances: every remaining
      // proposal is quarantined or reclassified, and the receipt preserves
      // exactly what was refused (B1 fix: quarantine never jams the journal).
      const raw=new Map(store.memorySources(scope).map(source=>[source.id,source]));
      const actualDelivery=result.originalDelivery
        ||[...batch.sources,...(batch.contextSources||[])].filter(source=>!source.deleted);
      for(const event of batch.events){
        const length=raw.get(event.id)?.text.length||0;
        const end=Number.isSafeInteger(event.end)?event.end:length;
        store.db.prepare("UPDATE memory_journal SET status=?,cursor=? WHERE seq=? AND scope_key=? AND status='pending'")
          .run(end>=length?'reviewed':'pending',end,event.seq,key);
      }
      let originalCoverage;
      try{originalCoverage=coverageFor(raw,actualDelivery,scope,{requiredSourceIds:actualDelivery.map(source=>source.id)});}
      catch{originalCoverage={version:'original-evidence-v1',unavailable:directRejection?.detail||directRejection?.reason||'gate_reclassification'};}
      const receipt={batchId:batch.id,kind:'gate_quarantine_commit',
        reviewedSourceIds:batch.reviewedSourceIds,
        sourceRevisions:Object.fromEntries(batch.events.map(event=>[event.id,event.revision])),
        seqFrom:batch.events[0]?.seq??null,seqTo:batch.events.at(-1)?.seq??null,
        segments:batch.events.map(event=>({sourceId:event.id,offset:event.offset,end:event.end})),
        originalCoverage,reviewedAt:nowIso(),quarantinedRecords:receipts,gate,
        outcome:classified.overlays.length||classified.candidates.length?'gate_reclassified':'gate_quarantined_no_change',
        updates:0};
      store.db.prepare('INSERT INTO memory_receipts VALUES(?,?,?)').run(key,batch.id,JSON.stringify(receipt));
      store.db.prepare('UPDATE memory_meta SET version=version+1,error=NULL WHERE scope_key=?').run(key);
      return {applied:true,receipt};
    });
  }

  // ---- Overlay read model ----
  function listOverlays(scope){
    ensureTables();
    return store.db.prepare('SELECT record FROM memory_overlays WHERE scope_key=? ORDER BY rowid').all(store.scopeKey(scope))
      .map(row=>JSON.parse(row.record));
  }
  // Read-time projection (design §2.4 correction integration): overlays apply
  // inside their scope only. A next_exchange overlay stops applying once a
  // LATER feedback observation exists in the same scope (the next exchange
  // happened); withdrawn overlays never apply.
  function activeOverlays(scope){
    const key=store.scopeKey(scope);
    const overlays=listOverlays(scope).filter(overlay=>overlay.status==='active');
    const laterFeedback=store.db.prepare('SELECT record FROM memory_sources WHERE scope_key=? AND deleted=0').all(key)
      .map(row=>JSON.parse(row.record)).filter(source=>source.type==='feedback')
      .map(source=>source.at).filter(at=>at).sort();
    return overlays.filter(overlay=>{
      if(overlay.scope.kind!=='next_exchange')return true;
      return !laterFeedback.some(at=>at>overlay.issuedAt);
    });
  }

  // ---- Preference candidates, attestation and repetition counting ----
  function listCandidates(scope,status){
    ensureTables();
    return store.db.prepare(status
      ?'SELECT record FROM memory_preference_candidates WHERE scope_key=? AND status=? ORDER BY rowid'
      :'SELECT record FROM memory_preference_candidates WHERE scope_key=? ORDER BY rowid')
      .all(...(status?[store.scopeKey(scope),status]:[store.scopeKey(scope)])).map(row=>JSON.parse(row.record));
  }
  function listPreferences(scope){
    ensureTables();
    return store.db.prepare('SELECT record FROM memory_preferences WHERE scope_key=? ORDER BY rowid').all(store.scopeKey(scope))
      .map(row=>JSON.parse(row.record));
  }
  // Program counting (design §2.1/§2.2): N independent corrections from
  // distinct episodes, counted by code per (subject, aspect) key. Reaching the
  // threshold only makes a promotion ELIGIBLE; activation is user-attested.
  function promotionState(scope){
    const overlays=listOverlays(scope);
    const groups=new Map();
    for(const overlay of overlays){
      const promotionKey=`${overlay.target.subject}|${overlay.target.aspect}`;
      const group=groups.get(promotionKey)||{promotionKey,subject:overlay.target.subject,aspect:overlay.target.aspect,overlays:[]};
      group.overlays.push(overlay);groups.set(promotionKey,group);
    }
    for(const group of groups.values()){
      const episodes=new Set(group.overlays.map(episodeKeyOf));
      group.distinctEpisodes=episodes.size;
      group.eligible=episodes.size>=repetitionThreshold&&group.overlays.length>=repetitionThreshold;
    }
    return {repetitionThreshold,groups:[...groups.values()]};
  }
  // File (never activate) a promotion candidate from counted overlays. The
  // candidate text is copied verbatim from the user's own latest correction
  // words, never model-generated. Dismissed keys are never re-filed.
  function filePromotionCandidate(scope,{promotionKey,text,evidenceSourceIds}){
    ensureTables();
    return store._atomic(()=>{
      const key=store.scopeKey(scope);
      const existing=store.db.prepare('SELECT status,record FROM memory_preference_candidates WHERE scope_key=?').all(key)
        .map(row=>({status:row.status,record:JSON.parse(row.record)}));
      const sameKey=existing.filter(entry=>entry.record.promotionKey===promotionKey);
      if(sameKey.some(entry=>entry.status!=='dismissed'))return {filed:false,reason:'already_pending_or_attested',existing:sameKey[0]?.record};
      if(someDismissed(sameKey))return {filed:false,reason:'key_dismissed_by_user'};
      const candidate={id:`pc_${randomUUID()}`,gateVersion:GATE_VERSION,basis:'repetition_count',
        promotionKey,text,evidence:{sourceIds:evidenceSourceIds||[]},status:'pending',
        createdAt:nowIso(),updatedAt:nowIso()};
      store.db.prepare('INSERT INTO memory_preference_candidates VALUES(?,?,?,?)').run(key,candidate.id,'pending',JSON.stringify(candidate));
      return {filed:true,candidate};
    });
  }
  const someDismissed=entries=>entries.some(entry=>entry.status==='dismissed');
  // User-only attestation channel: promotes a pending candidate to an active
  // user-owned preference record. Idempotent.
  function attestPreference(scope,{candidateId,observationId,event}){
    ensureTables();
    return store._atomic(()=>{
      const key=store.scopeKey(scope);
      const row=store.db.prepare('SELECT status,record FROM memory_preference_candidates WHERE scope_key=? AND id=?').get(key,candidateId);
      if(!row)return {applied:false,reason:'unknown_candidate'};
      const candidate=JSON.parse(row.record);
      if(row.status==='attested'){
        const pref=JSON.parse(store.db.prepare('SELECT record FROM memory_preferences WHERE scope_key=? AND id=?').get(key,candidate.promotedPreferenceId)?.record||'null');
        return pref?{applied:true,preference:pref,idempotent:true}:{applied:false,reason:'promoted_record_missing'};
      }
      if(row.status==='dismissed')return {applied:false,reason:'candidate_dismissed'};
      if(observationId!==undefined){
        const source=store._rawMemorySources(scope).find(item=>item.id===observationId);
        if(!source||!ownerAuthoredRecord(source))return {applied:false,reason:'attestation_source_not_owner_authored'};
      }
      const preference={id:`pref_${randomUUID()}`,gateVersion:GATE_VERSION,aspect:candidate.aspect,
        subject:candidate.subject,text:candidate.text,
        attestation:observationId!==undefined?{kind:'owner_statement',observationId,at:nowIso()}
          :{kind:'ui_event',event:event||{kind:'user_attestation'},at:nowIso()},
        lifecycle:'active',sourceCandidateId:candidate.id,
        evidence:candidate.evidence,createdAt:nowIso(),updatedAt:nowIso()};
      store.db.prepare('INSERT INTO memory_preferences VALUES(?,?,?)').run(key,preference.id,JSON.stringify(preference));
      const updated={...candidate,status:'attested',updatedAt:nowIso(),promotedPreferenceId:preference.id};
      store.db.prepare('UPDATE memory_preference_candidates SET status=?,record=? WHERE scope_key=? AND id=?')
        .run('attested',JSON.stringify(updated),key,candidate.id);
      return {applied:true,preference,candidate:updated};
    });
  }
  function dismissCandidate(scope,{candidateId}){
    ensureTables();
    return store._atomic(()=>{
      const key=store.scopeKey(scope);
      const row=store.db.prepare('SELECT status,record FROM memory_preference_candidates WHERE scope_key=? AND id=?').get(key,candidateId);
      if(!row)return {applied:false,reason:'unknown_candidate'};
      if(row.status!=='pending')return {applied:false,reason:'not_pending'};
      const updated={...JSON.parse(row.record),status:'dismissed',updatedAt:nowIso()};
      store.db.prepare('UPDATE memory_preference_candidates SET status=?,record=? WHERE scope_key=? AND id=?')
        .run('dismissed',JSON.stringify(updated),key,candidateId);
      return {applied:true,candidate:updated};
    });
  }

  // ---- Quarantine-rate metric (corruption-protection input, design §2.4c) ----
  function quarantineReport(scope){
    const key=store.scopeKey(scope);
    const receipts=store.db.prepare('SELECT record FROM memory_receipts WHERE scope_key=? ORDER BY rowid').all(key)
      .map(row=>JSON.parse(row.record));
    let proposedTotal=0,quarantinedTotal=0,batches=0;
    for(const receipt of receipts){
      const quarantined=(receipt.quarantinedRecords||[]).length,updates=receipt.updates||0;
      const proposed=quarantined+updates;
      if(proposed<=0)continue;
      batches++;proposedTotal+=proposed;quarantinedTotal+=quarantined;
    }
    const rate=proposedTotal?quarantinedTotal/proposedTotal:0;
    return {batches,proposedTotal,quarantinedTotal,rate,threshold:quarantineThreshold,
      minBatches:quarantineMinBatches,alert:batches>=quarantineMinBatches&&rate>quarantineThreshold};
  }

  return {version:GATE_VERSION,apply,classify,isolate,
    listOverlays,activeOverlays,listCandidates,listPreferences,promotionState,
    filePromotionCandidate,attestPreference,dismissCandidate,quarantineReport,
    config:{repetitionThreshold,quarantineThreshold,quarantineMinBatches}};
}

// Adapter for the existing maintenance engine: a Proxy over the real Store
// whose applyMemoryBatch routes through a per-store write gate. Everything
// else (memoryBatch, memoryStatus, recordMemoryError, budget APIs) reaches
// the real store unchanged, so src/memory-engine.cjs maintainMemory works
// unmodified while every applied batch passes the decision-split gate.
function createGatedStore(target,{config}={}){
  const gate=createWriteGate({store:target,config});
  return new Proxy(target,{
    get(object,property){
      if(property==='applyMemoryBatch')return (scope,batch,result)=>gate.apply(scope,batch,result);
      if(property==='__writeGate')return gate;
      const value=Reflect.get(object,property);
      return typeof value==='function'?value.bind(object):value;
    }
  });
}

module.exports={GATE_VERSION,RECEIPT_CODES,createWriteGate,createGatedStore,classifyClaim};
