'use strict';
// M5 Maintenance Orchestrator — scheduling skeleton (greenfield design §2.4).
//
// Owns WHEN maintenance passes run, never WHAT they admit: admission is the
// M3 write gate's decision and this module never edits or removes gate
// receipts. Passes currently scheduled over the existing tables:
//   - journal: delegates to the existing maintenance engine (src/memory-engine.cjs
//     maintainMemory), optionally through a gated store (createGatedStore).
//   - correction_integration: projects scoped overlays at read time and files
//     preference promotion candidates when the program repetition counter
//     reaches its threshold (proposed to the user, never auto-applied).
//   - expiry: recomputes applicability against asOf; stale understandings are
//     flagged needs_current_interpretation, never silently current.
//   - withdrawal: withdrawn/recalled/excluded evidence propagates to derived
//     records as a rescope flag (until_evidence + review) with original
//     wording preserved; deletion semantics stay with the existing sync pass.
//   - corruption_protection: derived-vs-source revision audit (stale rows are
//     flagged needs_revalidation, never silently kept) plus the quarantine-rate
//     metric with its alert threshold.
//
// Scheduling is single-flight per scope and epoch-guarded: every pass records
// the memory_meta version before/after and drift is surfaced when a pass that
// changed nothing still moved the epoch. The full determinism replay (rebuild
// derived state from the observation log and diff) belongs to the M1/M2 data
// stream and is the documented seam at the bottom of this file.
//
// Evidence class: source-only structural skeleton verified by deterministic
// unit tests on fictional stores; no semantic-quality claim.
const {createWriteGate}=require('./write-gate.cjs');
const {maintainMemory}=require('../memory-engine.cjs');

const ORCHESTRATOR_VERSION='maintenance-orchestrator-m5-2026-11-01.1';
const nowIso=()=>new Date().toISOString();

function createMaintenanceOrchestrator({store,settings={},runMaintenance=maintainMemory,gate,config={}}) {
  const corruptionEveryN=Math.max(1,Math.min(1000,Number(config.corruptionEveryN)||5));
  const writeGate=gate||createWriteGate({store,config});
  const inFlight=new Map();
  const runIndexByScope=new Map();

  const epoch=scope=>Number(store.db.prepare('SELECT version FROM memory_meta WHERE scope_key=?').get(store.scopeKey(scope))?.version||0);
  const typedRows=scope=>store.db.prepare("SELECT kind,record FROM memory_records WHERE scope_key=?").all(store.scopeKey(scope))
    .map(row=>({kind:row.kind,record:JSON.parse(row.record)}));
  const bumpMeta=scope=>store.db.prepare('UPDATE memory_meta SET version=version+1 WHERE scope_key=?').run(store.scopeKey(scope));

  // ---- Pass planner (pure given status + config) ----
  function plan(scope,{status,runIndex}={}){
    const state=status||store.memoryStatus(scope);
    const passes=[];
    if(state.pending>0||state.recoveryReady>0||state.semanticPending>0)
      passes.push({kind:'journal',reason:state.pending?'pending_sources':state.recoveryReady?'recovery_ready':'semantic_review_unfinished'});
    if(writeGate.listOverlays(scope).length)
      passes.push({kind:'correction_integration',reason:'scoped_overlays_present'});
    passes.push({kind:'expiry',reason:'asof_applicability_recompute'});
    passes.push({kind:'withdrawal',reason:'tombstone_propagation'});
    const quarantine=writeGate.quarantineReport(scope);
    if(runIndex%corruptionEveryN===0)passes.push({kind:'corruption_protection',reason:runIndex===0?'initial_audit':'periodic_audit'});
    else if(quarantine.alert)passes.push({kind:'corruption_protection',reason:'quarantine_rate_alert'});
    return {version:ORCHESTRATOR_VERSION,scopeKey:store.scopeKey(scope),epoch:epoch(scope),passes,quarantine};
  }

  // ---- Expiry / applicability pass ----
  // Stale understandings render as needs_current_interpretation: the flag is
  // monotonic (set once per record) and never rewrites meaning or wording.
  function expiryPass(scope,{asOf=nowIso()}={}){
    const at=Date.parse(asOf);
    if(!Number.isFinite(at))throw new Error('Invalid expiry asOf date');
    const flagged=[],already=[];
    const changed=store._atomic(()=>{
      let dirty=false;
      for(const {record} of typedRows(scope)){
        if(record.recordType!=='claim'||record.lifecycle!=='active')continue;
        if(record.semanticReview?.needsCurrentInterpretation){already.push(record.id);continue;}
        const expired=record.validUntil&&Date.parse(record.validUntil)<at;
        const notYet=record.validFrom&&Date.parse(record.validFrom)>at;
        if(!expired&&!notYet)continue;
        record.semanticReview={...record.semanticReview,
          needsCurrentInterpretation:{asOf,reason:expired?'valid_until_passed':'valid_from_future',flaggedAt:nowIso()}};
        store.db.prepare('UPDATE memory_records SET record=? WHERE scope_key=? AND id=?')
          .run(JSON.stringify(record),store.scopeKey(scope),record.id);
        flagged.push({id:record.id,subject:record.subject,aspect:record.aspect,
          reason:expired?'valid_until_passed':'valid_from_future',
          ...(expired?{validUntil:record.validUntil}:{validFrom:record.validFrom})});
        dirty=true;
      }
      if(dirty)bumpMeta(scope);
      return dirty;
    });
    return {asOf,flagged,alreadyFlagged:already.length,changed};
  }

  // Read-model view of dated applicability as of a point in time.
  function staleUnderstandings(scope,{asOf=nowIso()}={}){
    const at=Date.parse(asOf);
    if(!Number.isFinite(at))throw new Error('Invalid asOf date');
    return typedRows(scope).filter(({record})=>record.recordType==='claim'&&record.lifecycle==='active')
      .map(({record})=>{
        if(record.validUntil&&Date.parse(record.validUntil)<at)
          return {id:record.id,subject:record.subject,aspect:record.aspect,interpretation:'needs_current_interpretation',validUntil:record.validUntil};
        if(record.validFrom&&Date.parse(record.validFrom)>at)
          return {id:record.id,subject:record.subject,aspect:record.aspect,interpretation:'not_yet_valid',validFrom:record.validFrom};
        return null;
      }).filter(Boolean);
  }

  // ---- Withdrawal propagation pass ----
  // Active derived records whose stored evidence revisions no longer match the
  // live source table (withdrawn, recalled, excluded or revised sources that
  // escaped the sync cleanup) are rescoped to until_evidence with a review
  // flag; the original wording and provenance are preserved untouched.
  function withdrawalPass(scope){
    const key=store.scopeKey(scope);
    const sources=new Map(store.db.prepare('SELECT source_id,revision,deleted FROM memory_sources WHERE scope_key=?').all(key)
      .map(row=>[row.source_id,row]));
    const flagged=[];
    store._atomic(()=>{
      let dirty=false;
      for(const {record} of typedRows(scope)){
        if(record.lifecycle!=='active'||record.semanticReview?.evidenceRescope)continue;
        const broken=Object.keys(record.sourceRevisions||{}).filter(id=>{
          const source=sources.get(id);
          return !source||source.deleted||source.revision!==record.sourceRevisions[id];
        });
        if(!broken.length)continue;
        record.semanticReview={...record.semanticReview,
          evidenceRescope:{to:'until_evidence',reason:'source_withdrawn_or_revised',sources:broken,at:nowIso()}};
        store.db.prepare('UPDATE memory_records SET record=? WHERE scope_key=? AND id=?').run(JSON.stringify(record),key,record.id);
        flagged.push({id:record.id,sources:broken});
        dirty=true;
      }
      if(dirty)bumpMeta(scope);
      return dirty;
    });
    return {flagged,changed:flagged.length>0};
  }

  // ---- Corruption protection pass ----
  // (a) revision-integrity audit over every typed row (including inactive
  // ones): stale derived rows are flagged needs_revalidation — never silently
  // kept — and reported for semantic-recovery routing; (b) the quarantine-rate
  // metric: persistent model misfiling is a protocol problem, not a data
  // problem, so the alert is surfaced rather than auto-repaired.
  function corruptionPass(scope){
    const key=store.scopeKey(scope);
    const sources=new Map(store.db.prepare('SELECT source_id,revision,deleted FROM memory_sources WHERE scope_key=?').all(key)
      .map(row=>[row.source_id,row]));
    const flagged=[],staleDerived=[];
    store._atomic(()=>{
      let dirty=false;
      for(const {record} of typedRows(scope)){
        if(record.recordType!=='claim'&&record.recordType!=='relationship_event')continue;
        const broken=Object.keys(record.sourceRevisions||{}).filter(id=>{
          const source=sources.get(id);
          return !source||source.deleted||source.revision!==record.sourceRevisions[id];
        });
        if(!broken.length)continue;
        staleDerived.push(record.id);
        if(record.semanticReview?.evidenceRescope||record.semanticReview?.needsRevalidation)continue;
        record.semanticReview={...record.semanticReview,
          needsRevalidation:{sources:broken,detectedAt:nowIso(),basis:'source_revision_mismatch'}};
        store.db.prepare('UPDATE memory_records SET record=? WHERE scope_key=? AND id=?').run(JSON.stringify(record),key,record.id);
        flagged.push({id:record.id,sources:broken});
        dirty=true;
      }
      if(dirty)bumpMeta(scope);
      return dirty;
    });
    return {staleDerived,flagged,quarantine:writeGate.quarantineReport(scope)};
  }

  // ---- Correction integration pass ----
  // Applies overlays at read time inside their scope (the read model lives in
  // the gate); this pass performs the widening proposal rule: when the program
  // counter sees enough independent corrections from distinct episodes, a
  // preference candidate is filed for the user to attest. Never auto-applied.
  function correctionIntegrationPass(scope){
    const state=writeGate.promotionState(scope);
    const filed=[];
    for(const group of state.groups){
      if(!group.eligible)continue;
      const latest=group.overlays.slice().sort((a,b)=>a.issuedAt.localeCompare(b.issuedAt)).at(-1);
      const bound=latest.scope.bound?.sourceId;
      const row=bound&&store.db.prepare('SELECT record FROM memory_sources WHERE scope_key=? AND source_id=?').get(store.scopeKey(scope),bound);
      const source=row&&JSON.parse(row.record);
      // Candidate text is the user's own correction words, copied verbatim
      // from the bound observation — never model-generated wording.
      const text=source?String(source.text||'').slice(0,400):latest.text;
      const outcome=writeGate.filePromotionCandidate(scope,{promotionKey:group.promotionKey,text,
        evidenceSourceIds:bound?[bound]:[]});
      if(outcome.filed)filed.push(outcome.candidate);
    }
    return {repetitionThreshold:state.repetitionThreshold,
      groups:state.groups.map(group=>({promotionKey:group.promotionKey,overlays:group.overlays.length,distinctEpisodes:group.distinctEpisodes,eligible:group.eligible})),
      filed};
  }

  // ---- Epoch-guarded, single-flight run ----
  async function run(scope,{signal,onProgress,maxBatches}={}){
    const key=store.scopeKey(scope);
    if(inFlight.has(key))
      return {status:'already_running',planned:plan(scope,{runIndex:runIndexByScope.get(key)||0})};
    const runIndex=(runIndexByScope.get(key)||0)+1;
    runIndexByScope.set(key,runIndex);
    const promise=(async()=>{
      const planned=plan(scope,{runIndex});
      const report={version:ORCHESTRATOR_VERSION,status:null,planned,passes:{},epochDrift:[]};
      try{
        for(const pass of planned.passes){
          const before=epoch(scope);
          let result,expectedBump=0;
          if(pass.kind==='journal'){
            result=await runMaintenance({store,scope,settings,signal,
              ...(maxBatches!==undefined?{maxBatches}:{}),...(onProgress?{onProgress}:{})});
            report.status=result.status;
          }else if(pass.kind==='correction_integration'){
            result=correctionIntegrationPass(scope);expectedBump=result.filed.length?0:0;
          }else if(pass.kind==='expiry'){
            result=expiryPass(scope);expectedBump=result.changed?1:0;
          }else if(pass.kind==='withdrawal'){
            result=withdrawalPass(scope);expectedBump=result.changed?1:0;
          }else if(pass.kind==='corruption_protection'){
            result=corruptionPass(scope);expectedBump=result.flagged.length?1:0;
          }
          report.passes[pass.kind]=result;
          const delta=epoch(scope)-before;
          if(pass.kind!=='journal'&&delta!==expectedBump)
            report.epochDrift.push({pass:pass.kind,delta,expectedDelta:expectedBump});
        }
        if(!report.status)report.status='complete';
      }catch(error){
        report.status='error';
        report.error={message:String(error&&error.message||error).slice(0,300)};
      }finally{
        inFlight.delete(key);
      }
      report.epoch={start:planned.epoch,end:epoch(scope)};
      return report;
    })();
    inFlight.set(key,promise);
    return promise;
  }

  // "Run maintenance to completion" entry point (replay-adapter contract,
  // design §6.3): loop bounded rounds until the journal is drained or a round
  // stops making progress.
  async function runToCompletion(scope,options={}){
    const maxRounds=Math.max(1,Math.min(20,Number(options.maxRounds)||4));
    const rounds=[];
    let report=null;
    for(let round=0;round<maxRounds;round++){
      report=await run(scope,{...(options.maxBatches!==undefined?{maxBatches:options.maxBatches}:{})});
      const journal=report.passes.journal;
      rounds.push({status:report.status,batches:journal?.batches??null,pending:journal?.pending??null});
      const status=store.memoryStatus(scope);
      if(!status.pending&&!status.recoveryReady)break;
      if(report.status==='error'||report.status==='stopped'||report.status==='already_running')break;
      if(journal&&!journal.batches)break;
    }
    return {rounds,final:report,status:store.memoryStatus(scope)};
  }

  return {version:ORCHESTRATOR_VERSION,plan,run,runToCompletion,
    expiryPass,withdrawalPass,corruptionPass,correctionIntegrationPass,staleUnderstandings,
    gate:writeGate,config:{corruptionEveryN}};
}

module.exports={ORCHESTRATOR_VERSION,createMaintenanceOrchestrator};
