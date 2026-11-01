'use strict';
const { randomUUID, createHash } = require('node:crypto');
const {readableDiscussionTurns,discussionTurnFingerprint}=require('./discussion-compaction-store.cjs');
const {publicActivities,evidenceViewRecord,assertLossReferences}=require('./activity-evidence.cjs');
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const now = () => new Date().toISOString();
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
function text(value, name, maximum = 16000, empty = false) {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > maximum) throw new Error(`Invalid ${name}`);
  return value;
}
function ref(value) {
  if (!plain(value) || typeof value.artifactId !== 'string' || !value.artifactId || value.artifactId.length > 300 || !Number.isSafeInteger(value.version) || value.version < 1) throw new Error('Invalid artifact reference');
  return { artifactId: value.artifactId, version: value.version };
}
const refKey = value => `${value.artifactId}@${value.version}`;
const unique = values => [...new Set(values)];
function visibleResponseText(turn={}) {
  const body=text(turn.text ?? '', 'assistant response text', 100000, true);
  const explanation=turn.discussionExplanation?.text;
  const parts=explanation===undefined?[body]:[text(explanation,'discussion explanation text',6000),body];
  return unique(parts.filter(value=>value.length)).join('\n\n');
}

class ExperienceStore {
  constructor(store, { scopeKey } = {}) {
    this.store = store; this.db = store.db; this.scopeKey = scopeKey || (scope => store.scopeKey(scope));
    this.db.exec(`CREATE TABLE IF NOT EXISTS experience_objects(
      scope_key TEXT NOT NULL,kind TEXT NOT NULL,id TEXT NOT NULL,record TEXT NOT NULL,
      PRIMARY KEY(scope_key,kind,id));
      CREATE INDEX IF NOT EXISTS experience_kind ON experience_objects(scope_key,kind);`);
  }
  _all(scope, kind) { return this.db.prepare('SELECT record FROM experience_objects WHERE scope_key=? AND kind=? ORDER BY rowid').all(this.scopeKey(scope), kind).map(row => JSON.parse(row.record)); }
  _get(scope, kind, id) { const row = this.db.prepare('SELECT record FROM experience_objects WHERE scope_key=? AND kind=? AND id=?').get(this.scopeKey(scope), kind, id); return row ? JSON.parse(row.record) : null; }
  _put(scope, kind, id, value) { this.db.prepare('INSERT INTO experience_objects VALUES(?,?,?,?) ON CONFLICT(scope_key,kind,id) DO UPDATE SET record=excluded.record').run(this.scopeKey(scope), kind, id, JSON.stringify(value)); return value; }
  _raw(scope) { const row = this.db.prepare('SELECT record FROM companion WHERE scope_key=?').get(this.scopeKey(scope)); return { goal: { version: 0, text: '' }, turns: [], feedback: [], notes: [], runs: [], ...(row ? JSON.parse(row.record) : {}) }; }
  _sources(scope) { return new Map(this.store._rawMemorySources(scope, this._raw(scope)).map(source => [source.id, source])); }
  _refs(scope, ids) { const live = this._sources(scope); return unique(ids || []).map(id => { const source = live.get(id); if (!source) throw new Error('Experience evidence is unavailable in this conversation'); return { sourceId: id, revision: source.revision }; }); }
  _transaction(fn) { return this.store._atomic(fn); }
  artifact(scope, reference) { const checked = ref(reference); return this._get(scope, 'artifact', refKey(checked)); }
  readableArtifact(scope, reference) {
    const artifact=this.artifact(scope,reference);
    if(!artifact||artifact.kind!=='response'||artifact.availability==='redacted')return artifact;
    const turn=this._raw(scope).turns.find(turn=>turn.id===artifact.assistantTurnId&&turn.role==='assistant'&&turn.artifactRef&&refKey(turn.artifactRef)===refKey(artifact.ref));
    if(!turn)return artifact;
    const view=this.projectGeneratedTurns(scope,[turn])[0];
    // Feedback and experience links evaluate an exact artifact. A legacy
    // parent whose duplicated leaf is now hidden cannot supply its old body
    // as an alternate read path or silently become a different target.
    return view&&visibleResponseText(view)===artifact.body?artifact:{...artifact,body:'',availability:'unavailable'};
  }
  resolveMessageCandidate(scope, selection) {
    const fail=()=>{throw new Error('Editing reference artifact changed or is unavailable in this conversation');};
    if(!plain(selection)||typeof selection.turnId!=='string'||!Number.isSafeInteger(selection.suggestionIndex)||selection.suggestionIndex<0) return fail();
    const reference=ref(selection.artifactRef),artifact=this.artifact(scope,reference);
    const turn=this._raw(scope).turns.find(item=>item.id===selection.turnId&&item.role==='assistant'&&!item.memoryExcluded);
    const item=turn?.suggestions?.[selection.suggestionIndex];
    const state=this.artifactStates(scope,[reference])[0];
    if(!artifact||!artifact.ref||refKey(artifact.ref)!==refKey(reference)||artifact.kind!=='message_candidate'||artifact.assistantTurnId!==selection.turnId||
      !item?.artifactRef||refKey(item.artifactRef)!==refKey(reference)||
      !artifact.parentRef||!turn.artifactRef||refKey(artifact.parentRef)!==refKey(turn.artifactRef)||
      state.availability!=='active'||typeof artifact.body!=='string'||!artifact.body.trim()||artifact.body.length>1200||
      item.text!==artifact.body||artifact.bodyDigest!==digest(artifact.body))return fail();
    const dependency={artifactRef:reference,turnId:selection.turnId,suggestionIndex:selection.suggestionIndex,
      kind:artifact.kind,bodyDigest:artifact.bodyDigest,
      witness:digest({ref:reference,turnId:selection.turnId,index:selection.suggestionIndex,kind:artifact.kind,
        parentRef:artifact.parentRef,bodyDigest:artifact.bodyDigest,stateWitness:state.witness})};
    return {text:artifact.body,dependency};
  }
  resolveActionOption(scope,selection){
    const fail=()=>{throw new Error('Selected direction artifact changed or is unavailable in this conversation');};
    if(!plain(selection)||typeof selection.turnId!=='string'||!Number.isSafeInteger(selection.optionIndex)||selection.optionIndex<0)return fail();
    const reference=ref(selection.artifactRef),artifact=this.artifact(scope,reference);
    const turn=this._raw(scope).turns.find(item=>item.id===selection.turnId&&item.role==='assistant'&&!item.memoryExcluded),item=turn?.expressionOptions?.[selection.optionIndex];
    const state=this.artifactStates(scope,[reference])[0];
    if(!artifact||artifact.kind!=='action_option'||artifact.assistantTurnId!==selection.turnId||
      !item?.artifactRef||refKey(item.artifactRef)!==refKey(reference)||!artifact.parentRef||!turn.artifactRef||refKey(artifact.parentRef)!==refKey(turn.artifactRef)||
      state.availability!=='active'||typeof artifact.body!=='string'||!artifact.body.trim()||item.label!==artifact.body||artifact.bodyDigest!==digest(artifact.body)||
      !Array.isArray(item.quotes)||item.quotes.length>8)return fail();
    const live=this._sources(scope),tuples=item.quotes.map(quote=>({sourceId:quote.sourceId,text:quote.text,revision:quote.revision}));
    if(tuples.some(quote=>{const source=live.get(quote.sourceId);return typeof quote.sourceId!=='string'||typeof quote.text!=='string'||!quote.text.trim()||typeof quote.revision!=='string'||
      !source||source.deleted||source.excluded||source.use==='disabled'||source.revision!==quote.revision;}))return fail();
    const tupleDigest=digest(tuples),style=typeof item.style==='string'?item.style:undefined;
    const dependency={artifactRef:reference,turnId:selection.turnId,optionIndex:selection.optionIndex,kind:'action_option',bodyDigest:artifact.bodyDigest,tupleDigest,
      witness:digest({ref:reference,turnId:selection.turnId,index:selection.optionIndex,kind:'action_option',parentRef:artifact.parentRef,bodyDigest:artifact.bodyDigest,tupleDigest,style,stateWitness:state.witness})};
    return {label:artifact.body,...(style!==undefined?{style}:{}),dependency};
  }
  assertInputArtifactsCurrent(scope, references=[]) {
    if(!Array.isArray(references)||references.length>8)throw new Error('Invalid editing reference dependencies');
    return references.map(expected=>{
      const current=(expected.kind==='action_option'?this.resolveActionOption(scope,expected):this.resolveMessageCandidate(scope,expected)).dependency;
      if(digest(current)!==digest(expected))throw new Error('Editing reference artifact changed before commit');
      return current;
    });
  }
  projectGeneratedTurns(scope, turns) {
    const artifacts=new Map(this._all(scope,'artifact').map(item=>[refKey(item.ref),item])),live=this._sources(scope);
    const read=(reference,kind,turnId,body,parentRef)=>{
      if(!reference)return null;
      const artifact=artifacts.get(refKey(reference));
      if(!artifact||!artifact.ref||refKey(artifact.ref)!==refKey(reference)||artifact.kind!==kind||artifact.assistantTurnId!==turnId||
        parentRef&&(!artifact.parentRef||refKey(artifact.parentRef)!==refKey(parentRef))||
        artifact.body!==body||artifact.bodyDigest!==digest(artifact.body))return null;
      const availability=this._artifactAvailability(artifact,live);
      return ['active','stale'].includes(availability)?availability:null;
    };
    return (turns||[]).flatMap(turn=>{
      if(turn.role!=='assistant')return [turn];
      const availability=read(turn.artifactRef,'response',turn.id,visibleResponseText(turn));
      if(!availability)return [];
      const projected={...turn,...(availability==='stale'?{artifactAvailability:'stale'}:{})};
      for(const [field,kind,bodyKey]of [['suggestions','message_candidate','text'],['expressionOptions','action_option','label']]){
        if(!turn[field])continue;
        projected[field]=turn[field].map(item=>{
          const state=read(item.artifactRef,kind,turn.id,item[bodyKey],turn.artifactRef);
          if(state)return state==='active'?item:{...item,availability:'stale'};
          // Keep positional identity for references; unavailable bodies never
          // fall back to retained text, labels, or an adjacent suggestion.
          return {artifactRef:item.artifactRef,availability:'unavailable',[bodyKey]:'',...(field==='expressionOptions'?{quotes:[]}:{})};
        });
      }
      // Older draft carriers duplicated the outward body in turn.text. Treat
      // that exact alias as owned by the same leaf when projecting a withdrawn
      // candidate. Independent parent prose and sibling bodies stay readable;
      // retained raw turns and artifact hashes remain unchanged.
      if(turn.kind==='draft'&&(turn.suggestions||[]).some((item,index)=>item.text&&item.text===turn.text&&projected.suggestions[index]?.availability==='unavailable'))projected.text='';
      if(projected.semanticReview?.findings?.length){
        const fields=new Map(require('./candidate-field-paths.cjs').candidateFields(projected).map(field=>[field.path,field.value])),before=projected.semanticReview.findings;
        const findings=availability==='stale'?[]:before.filter(finding=>fields.has(finding.path)&&fields.get(finding.path).trim()&&(!finding.quote||fields.get(finding.path).includes(finding.quote))&&(finding.evidence||[]).every(ref=>live.get(ref.sourceId)?.revision===ref.revision&&live.get(ref.sourceId)?.text?.includes(ref.quote)));
        if(findings.length!==before.length)projected.semanticReview={...projected.semanticReview,status:'incomplete',findings};
      }
      return [projected];
    });
  }
  projectCompanion(scope, record) {
    const turns=this.projectGeneratedTurns(scope,record.turns),visibleIds=new Set(turns.map(turn=>turn.id));
    const hiddenIds=new Set((record.turns||[]).filter(turn=>!visibleIds.has(turn.id)).map(turn=>turn.id));
    const live=this._sources(scope),artifacts=new Map(this._all(scope,'artifact').map(item=>[refKey(item.ref),item]));
    const current=this._raw(scope),currentTurns=this.projectGeneratedTurns(scope,current.turns);
    const turnFingerprints=new Map(readableDiscussionTurns({...current,turns:currentTurns}).map(turn=>[turn.id,discussionTurnFingerprint(turn)]));
    const available=(value,witnesses)=>{
      if(!value||typeof value!=='object')return true;
      if(Array.isArray(value))return value.every(item=>available(item,witnesses));
      if(value.artifactRef){const artifact=artifacts.get(refKey(value.artifactRef));if(!artifact||!['active','stale'].includes(this._artifactAvailability(artifact,live)))return false;}
      for(const field of ['turnFingerprints','discussionTurnFingerprints'])if(Object.hasOwn(value,field)){
        if(!plain(value[field]))return false;
        for(const [id,expected]of Object.entries(value[field])){
          if(turnFingerprints.get(id)!==expected)return false;
          witnesses.add(id);
        }
      }
      if(Object.hasOwn(value,'turnFingerprint')){
        const id=value.turnId||value.originalTurnId||value.id;
        if(typeof value.turnFingerprint!=='string'||turnFingerprints.get(id)!==value.turnFingerprint)return false;
        witnesses.add(id);
      }
      return Object.values(value).every(item=>available(item,witnesses));
    };
    const covered=(value,witnesses)=>{
      if(!value||typeof value!=='object')return true;
      if(Array.isArray(value))return value.every(item=>covered(item,witnesses));
      const checkpoint=value.discussionCompaction;
      if(checkpoint?.summary&&(!Array.isArray(checkpoint.sourceTurnIds)||!checkpoint.sourceTurnIds.length||checkpoint.sourceTurnIds.some(id=>!witnesses.has(id))))return false;
      if(value.role==='assistant'&&value.originalTurnId&&value.text&&typeof value.turnFingerprint!=='string')return false;
      if(value.purpose==='discussion_compaction'&&Array.isArray(value.turns)&&value.turns.some(turn=>!witnesses.has(turn.id)))return false;
      return Object.values(value).every(item=>covered(item,witnesses));
    };
    const rawOutputs=new Map(current.turns.filter(turn=>turn.role==='assistant').map(turn=>[turn.id,turn]));
    const projectedOutputs=new Map(currentTurns.map(turn=>[turn.id,turn]));
    const inspectable=run=>{
      // A whole-candidate check captures the generated output before its leaf
      // artifacts exist. Its completed diagnostic belongs to that exact output
      // view; it cannot recover a subsequently withdrawn leaf from the request.
      const output=rawOutputs.get(run.replyId),view=projectedOutputs.get(run.replyId);
      if(output&&(!view||discussionTurnFingerprint(output)!==discussionTurnFingerprint(view)))return false;
      const witnesses=new Set();return !hiddenIds.has(run.replyId)&&available(run,witnesses)&&covered(run,witnesses);
    };
    // Captured model inputs are diagnostics, not an alternate UI history from
    // which a withdrawn generated body may be recovered.
    return {...record,turns,runs:(record.runs||[]).filter(inspectable)};
  }
  _artifactAvailability(artifact,live) {
    let availability=artifact.availability||'unknown';
    const sources=(artifact.sourceIds||[]).map(id=>({sourceId:id,revision:live.get(id)?.revision||null}));
    if(availability!=='redacted'&&sources.some(source=>!source.revision))availability='redacted';
    else if(availability==='active'&&(artifact.sourceRefs||[]).some(reference=>live.get(reference.sourceId)?.revision!==reference.revision))availability='stale';
    return availability;
  }
  artifactsForRequest(scope, requestId) { return this._all(scope, 'artifact').filter(a => a.requestId === requestId && a.kind === 'response'); }
  refsForTurn(scope, turnId) {
    const refs=this._all(scope,'artifact').filter(a=>a.assistantTurnId===turnId).map(a=>a.ref);
    const turn=(this._raw(scope).turns||[]).find(t=>t.id===turnId&&t.role==='assistant');
    if(turn){refs.push(turn.artifactRef||{artifactId:`turn:${turnId}`,version:1});for(const [i,item]of (turn.suggestions||[]).entries())refs.push(item.artifactRef||{artifactId:`turn:${turnId}:draft:${i}`,version:1});for(const [i,item]of (turn.expressionOptions||[]).entries())refs.push(item.artifactRef||{artifactId:`turn:${turnId}:option:${i}`,version:1});}
    return [...new Map(refs.map(r=>[refKey(r),r])).values()];
  }
  artifactStates(scope, references) {
    const requested=references===undefined?[...(this._get(scope,'draft','main')?.artifactRefs||[]),...this._all(scope,'artifact').slice(-64).reverse().map(a=>a.ref)]:references;
    if(!Array.isArray(requested)||references!==undefined&&requested.length>64)throw new Error('At most 64 artifact states can be read at once');
    const live=this._sources(scope),refs=[...new Map(requested.map(value=>{const r=ref(value);return [refKey(r),r]})).values()].slice(0,72);
    return refs.map(reference=>{
      const artifact=this.artifact(scope,reference);if(!artifact)return {ref:reference,availability:'unknown',witness:null};
      const availability=this._artifactAvailability(artifact,live);
      const sources=(artifact.sourceIds||[]).map(id=>({sourceId:id,revision:live.get(id)?.revision||null}));
      return {ref:reference,availability,witness:digest({ref:reference,availability,sources,invalidatedAt:artifact.invalidatedAt||null})};
    });
  }
  _reviewValid(draft,states) {
    return draft?.reviewStatus==='reviewed'&&states.every(state=>['active','stale'].includes(state.availability)&&(draft.reviewWitnesses||[]).some(w=>refKey(w.ref)===refKey(state.ref)&&w.witness===state.witness));
  }
  invalidateArtifacts(scope,references,{mode='forget',knownTurnId}={}) {
    return this._transaction(()=>{
      if(!['correct','forget'].includes(mode)||!Array.isArray(references))throw new Error('Invalid artifact invalidation');
      const refs=references.map(ref),known=knownTurnId?new Set(this.refsForTurn(scope,knownTurnId).map(refKey)):null;
      for(const reference of refs)if(!this.artifact(scope,reference)){
        if(!known?.has(refKey(reference)))throw new Error('Artifact is unavailable in this conversation');
        this._put(scope,'artifact',refKey(reference),{ref:reference,assistantTurnId:knownTurnId,kind:'deleted_legacy_artifact',body:'',availability:'redacted',sourceIds:[],sourceRefs:[],createdAt:now(),invalidatedAt:now()});
      }
      return this.invalidateSources(scope,[],{mode,artifactRefs:refs});
    });
  }


  recordArtifacts(scope, turn, metadata = {}) {
    return this._transaction(() => {
      if (turn.role !== 'assistant') throw new Error('Only assistant output creates assistance artifacts');
      text(turn.id, 'assistant turn id', 256);
      const inputArtifactRefs=this.assertInputArtifactsCurrent(scope,metadata.inputArtifactRefs||[]);
      const inputEvidenceLossRefs=assertLossReferences(this.store,scope,metadata.inputEvidenceLossRefs||[]);
      const requestedRefs=metadata.inputSourceRefs||[];
      const sourceRefs = this._refs(scope,requestedRefs.length?requestedRefs.map(r=>r.sourceId):turn.sourceIds || []), raw = this._raw(scope);
      if(requestedRefs.some(r=>sourceRefs.find(s=>s.sourceId===r.sourceId)?.revision!==r.revision))throw new Error('Artifact generation-stage evidence changed before commit');
      if (metadata.manifest?.sourceRevisions && sourceRefs.some(s => metadata.manifest.sourceRevisions[s.sourceId] && metadata.manifest.sourceRevisions[s.sourceId] !== s.revision)) throw new Error('Artifact sources changed before commit');
      const stages = metadata.generationStages || [];
      const delivered = clone(metadata.deliveredMethodRefs || [...new Map(stages.flatMap(s => s.deliveredMethodRefs || []).map(m => [`${m.methodId}:${m.version}`, m])).values()]);
      const stageReports=stages.flatMap(s=>s.reportedUsedMethodRefs||[]);
      const reported = clone(metadata.reportedUsedMethodRefs || (stageReports.length?stageReports:(turn.methodIds || []).map(id => ({ methodId: id, version: delivered.find(m => m.methodId === id)?.version || 'unknown' }))));
      const common = { requestId: turn.requestId || null, assistantTurnId: turn.id, inputArtifactRefs,...(inputEvidenceLossRefs.length?{inputEvidenceLossRefs}:{}), sourceRefs, sourceIds: sourceRefs.map(s => s.sourceId),
        goalVersion: metadata.goalRef?.version ?? metadata.goalVersion ?? raw.goal?.version ?? 0, deliveredMethodRefs: delivered, reportedUsedMethodRefs: reported,
        generationStages: clone(stages), modelRef: metadata.modelRef || metadata.model || null, promptVersion: metadata.promptVersion || metadata.manifest?.promptVersion || null };
      const save = (id, kind, body, extra = {}) => {
        const previous = this._all(scope, 'artifact').filter(a => a.ref.artifactId === id).at(-1);
        const signature = digest({ kind, body, sourceRefs, inputArtifactRefs,...(inputEvidenceLossRefs.length?{inputEvidenceLossRefs}:{}), delivered, reported, extra });
        if (previous?.signature === signature && previous.availability === 'active') return previous.ref;
        const reference = { artifactId: id, version: (previous?.ref.version || 0) + 1 };
        this._put(scope, 'artifact', refKey(reference), { ...common, ...extra, ref: reference, kind, body: text(body, 'artifact body', 100000, true), bodyDigest: digest(body), signature, createdAt: now(), availability: 'active' });
        return reference;
      };
      const responseRef = save(`turn:${turn.id}`, 'response', visibleResponseText(turn));
      const suggestionRefs = (turn.suggestions || []).map((suggestion, index) => save(`turn:${turn.id}:draft:${index}`, 'message_candidate', suggestion.text, { parentRef: responseRef, label: suggestion.style || '' }));
      const optionRefs = (turn.expressionOptions || []).map((option, index) => save(`turn:${turn.id}:option:${index}`, 'action_option', option.label, { parentRef: responseRef }));
      return { responseRef, suggestionRefs, optionRefs };
    });
  }

  materializeLegacyArtifacts(scope, raw) {
    return this._transaction(() => {
      const before = JSON.stringify(raw), live = new Map(this.store._rawMemorySources(scope, raw).map(source => [source.id, source]));
      for (const turn of raw.turns || []) {
        if (turn.role !== 'assistant') continue;
        const existingResponse = turn.artifactRef && this.artifact(scope, turn.artifactRef);
        const missingRefs = !turn.artifactRef || (turn.suggestions || []).some(item => !item.artifactRef) || (turn.expressionOptions || []).some(item => !item.artifactRef);
        if (!missingRefs && !(existingResponse?.provenance === 'legacy_turn_materialization' && !existingResponse.legacyMetadataVersion)) continue;
        const matchingTurns = (raw.turns || []).filter(item => item.role === 'assistant' && item.requestId === turn.requestId);
        const runs = (raw.runs || []).filter(run => run.replyId === turn.id || turn.requestId && matchingTurns.length === 1 && (run.id === turn.requestId || run.requestId === turn.requestId));
        const manifests = runs.flatMap(run => [run.manifest, ...(run.requests || []).map(request => request.manifest)]).filter(Boolean);
        const recordedRevisions = Object.assign({}, turn.sourceRevisions || {}, ...manifests.map(manifest => manifest.sourceRevisions || {}));
        const sourceIds = unique([...(turn.sourceIds || []), ...manifests.flatMap(manifest => manifest.sourceIds || []), ...Object.keys(recordedRevisions)]).filter(id => /^(qq|private|note):/.test(id));
        const sourceRefs = sourceIds.filter(id => typeof recordedRevisions[id] === 'string').map(sourceId => ({sourceId, revision: recordedRevisions[sourceId]}));
        // Retained manifests can preserve old revisions, but cannot establish a
        // complete generation trace retroactively. Never substitute today's ones.
        const common = {requestId: turn.requestId || null, assistantTurnId: turn.id, sourceIds, sourceRefs,
          deliveredMethodRefs: [], reportedUsedMethodRefs: (turn.methodIds || []).map(methodId => ({methodId, version: 'unknown'})),
          generationStages: [], goalVersion: null, modelRef: null, promptVersion: null, provenance: 'legacy_turn_materialization',
          legacyMetadataVersion: 1, provenanceStatus: 'generation_trace_incomplete', createdAt: turn.createdAt || now()};
        const save = (provided, id, kind, body, extra = {}) => {
          const reference = provided ? ref(provided) : {artifactId: id, version: 1}, old = this.artifact(scope, reference);
          // An explicit missing version stays unknown; do not fabricate it from
          // a current display row or revive an existing redaction tombstone.
          if (provided && !old || old && (old.provenance !== 'legacy_turn_materialization' || old.legacyMetadataVersion)) return reference;
          const inherited = extra.parentRef && this.artifact(scope, extra.parentRef)?.availability;
          const availability = old?.availability === 'redacted' || inherited === 'redacted' || sourceIds.some(id => !live.has(id)) ? 'redacted' : 'stale';
          const savedBody = availability === 'redacted' ? '' : body || '';
          this._put(scope, 'artifact', refKey(reference), {...common, ...extra, ref: reference, kind, body: savedBody,
            ...(availability === 'redacted' ? {label: '', invalidatedAt: old?.invalidatedAt || now()} : {bodyDigest: digest(savedBody)}), availability});
          return reference;
        };
        turn.artifactRef = save(turn.artifactRef, `turn:${turn.id}`, 'response', turn.text);
        for (const [index, item] of (turn.suggestions || []).entries()) item.artifactRef = save(item.artifactRef, `turn:${turn.id}:draft:${index}`, 'message_candidate', item.text, {parentRef: turn.artifactRef, label: item.style || ''});
        for (const [index, item] of (turn.expressionOptions || []).entries()) item.artifactRef = save(item.artifactRef, `turn:${turn.id}:option:${index}`, 'action_option', item.label, {parentRef: turn.artifactRef});
        if (this.artifact(scope, turn.artifactRef)?.availability === 'redacted') {turn.text = '';for (const item of turn.suggestions || []) item.text = '';for (const item of turn.expressionOptions || []) item.label = '';}
      }
      return JSON.stringify(raw) !== before;
    });
  }

  migrateLegacy(scope, raw) {
    return this._transaction(() => {
      const rows = this._all(scope, 'feedback'), known = new Set(rows.map(f => f.id));
      for (const legacy of raw.feedback || []) {
        if (known.has(legacy.id)) continue;
        const target = this._legacyTarget(scope, raw, legacy.requestId);
        this._put(scope, 'feedback', legacy.id, { ...clone(legacy), sourceId: `private:feedback-${legacy.id}`, kind: 'local', applicability: 'local',
          revision: 1, targetRef: target, targetStatus: target.kind === 'artifact' ? 'available' : 'missing', legacy: true });
        known.add(legacy.id);
      }
      for (const turn of raw.turns || []) {
        if (!['feedback', 'feedback_ref'].includes(turn.kind)) continue;
        if (this._get(scope, 'alias', `private:${turn.id}`)) continue;
        const matches = this._all(scope, 'feedback').filter(f => f.id === turn.feedbackId || f.requestId === turn.requestId && turn.text === `对助手建议的反馈：${f.text}`);
        if (matches.length === 1) this._put(scope, 'alias', `private:${turn.id}`, { sourceId: `private:${turn.id}`, canonicalId: matches[0].sourceId, learnable: false });
        else if (matches.length > 1) this._put(scope, 'alias', `private:${turn.id}`, { sourceId: `private:${turn.id}`, canonicalId: null, possibleDuplicates: matches.map(f => f.id), learnable: false });
        else if (turn.kind === 'feedback' && turn.text?.trim()) {
          const id = `legacy-${turn.id}`, saved = { id, sourceId: `private:feedback-${id}`, text: turn.text.replace(/^对助手建议的反馈：/, ''), kind: 'local', applicability: 'local',
            requestId: turn.requestId || null, revision: 1, targetRef: { kind: 'unresolved_legacy', requestId: turn.requestId || null, reason: 'Original feedback target unavailable' }, targetStatus: 'missing', createdAt: turn.createdAt, legacy: true };
          this._put(scope, 'feedback', id, saved); this._put(scope, 'alias', `private:${turn.id}`, { sourceId: `private:${turn.id}`, canonicalId: saved.sourceId, learnable: false });
        }
      }
    });
  }
  _legacyTarget(scope, raw, requestId) {
    const existing = this.artifactsForRequest(scope, requestId);
    if (existing.length === 1) return { kind: 'artifact', artifactRef: existing[0].ref };
    const turns = (raw.turns || []).filter(t => t.role === 'assistant' && t.requestId === requestId);
    if (!existing.length && turns.length === 1) {
      const turn = turns[0], reference = { artifactId: `turn:${turn.id}`, version: 1 };
      this._put(scope, 'artifact', refKey(reference), { ref: reference, kind: 'response', body: turn.text || '', bodyDigest: digest(turn.text || ''), requestId,
        assistantTurnId: turn.id, createdAt: turn.createdAt, availability: 'stale', sourceIds: turn.sourceIds || [], sourceRefs: [],
        deliveredMethodRefs: [], reportedUsedMethodRefs: (turn.methodIds || []).map(methodId => ({ methodId, version: 'unknown' })), generationStages: [], provenance: 'legacy_turn_materialization' });
      return { kind: 'artifact', artifactRef: reference };
    }
    return { kind: 'unresolved_legacy', requestId: requestId || null, reason: existing.length + turns.length ? 'Several possible target versions' : 'Original target unavailable' };
  }
  listFeedback(scope) { return this._all(scope, 'feedback').filter(f => !f.redacted); }
  sourceRows(scope) {
    return this.listFeedback(scope).map(f => ({ id: f.sourceId, type: 'feedback', text: f.text, at: f.updatedAt || f.createdAt,
      role: 'user', kind: 'local', use: 'discussion', version: f.revision, requestId: f.requestId, targetRef: f.targetRef, canonicalFeedbackId: f.id, applicability: 'local' }));
  }
  canonicalSource(scope, sourceId) { return this._get(scope, 'alias', sourceId)?.canonicalId || sourceId; }
  remapSources(scope, mappings) {
    return this._transaction(()=>{
      const map=new Map(mappings.filter(m=>m.from&&(m.from!==m.to||m.revision)).map(m=>[m.from,m]));if(!map.size)return 0;let updates=0;
      const walk=value=>{
        if(Array.isArray(value))return value.map(walk);
        if(!plain(value))return value;
        const copy={...value};
        for(const key of ['sourceIds','evidenceSourceIds'])if(Array.isArray(copy[key]))copy[key]=unique(copy[key].map(id=>map.get(id)?.to||id));
        for(const key of ['sourceRevisions','evidenceRevisions'])if(plain(copy[key])){const revised={};for(const [id,revision]of Object.entries(copy[key])){const replacement=map.get(id);revised[replacement?.to||id]=replacement?.to?replacement.revision:revision}copy[key]=revised;}
        if(copy.sourceId&&map.get(copy.sourceId)?.to){const replacement=map.get(copy.sourceId);copy.sourceId=replacement.to;if(copy.revision!==undefined)copy.revision=replacement.revision;}
        for(const [key,child]of Object.entries(copy))if(!['text','body','sourceIds','evidenceSourceIds','sourceRevisions','evidenceRevisions'].includes(key)&&typeof child==='object'&&child!==null)copy[key]=walk(child);
        return copy;
      };
      for(const lane of ['artifact','event','draft','case','adaptation'])for(const item of this._all(scope,lane)){
        const revised=walk(item);if(JSON.stringify(revised)===JSON.stringify(item))continue;
        if(lane==='artifact'&&revised.availability!=='redacted')revised.availability='stale';
        if(lane==='adaptation'&&revised.status==='active'){revised.status='candidate';revised.version++;}
        this._put(scope,lane,lane==='artifact'?refKey(revised.ref):revised.id,revised);updates++;
      }
      return updates;
    });
  }
  _target(scope, target, requestId) {
    if (!target) return this._legacyTarget(scope, this._raw(scope), requestId);
    if (!plain(target)) throw new Error('Invalid feedback target');
    if (target.kind === 'artifact') {
      const artifact = this.artifact(scope, target.artifactRef);
      if (!artifact || artifact.availability === 'redacted') throw new Error('Feedback artifact is unavailable in this conversation');
      return { kind: 'artifact', artifactRef: artifact.ref };
    }
    if (target.kind === 'actual_message') {
      text(target.messageId, 'original QQ message ID', 256);
      const message = this.store.messages(scope).find(m => m.messageId === target.messageId && !m.recalled);
      if (!message || !this._sources(scope).has(`qq:${message.messageId}`)) throw new Error('Feedback message is unavailable in this conversation');
      return { kind: 'actual_message', messageId: message.messageId, sourceRevision: digest(message) };
    }
    if (target.kind === 'experience' && this._get(scope, 'case', target.experienceId)) return { kind: 'experience', experienceId: target.experienceId };
    throw new Error('Unknown feedback target');
  }
  addFeedback(scope, args) {
    return this._transaction(() => {
      text(args.text, 'feedback text', 10000);
      if (args.kind && !['local', 'recurring'].includes(args.kind)) throw new Error('Invalid feedback applicability');
      // Even an explicit recurring request remains user feedback here. The
      // authorized preference action is a separate operation, never a type flag.
      if (args.clientEventId) {
        text(args.clientEventId, 'feedback event id', 256);
        const prior = this._all(scope, 'feedback').find(f => f.clientEventId === args.clientEventId);
        if (prior) { if (prior.text !== args.text || args.requestId && prior.requestId !== args.requestId || args.targetRef && JSON.stringify(prior.targetRef) !== JSON.stringify(this._target(scope,args.targetRef,args.requestId))) throw new Error('Feedback event ID reused with different content or target'); return prior; }
      }
      const targetRef = this._target(scope, args.targetRef, args.requestId);
      if (!args.targetRef && targetRef.kind === 'unresolved_legacy' && !this._raw(scope).turns?.some(t => t.role === 'assistant' && t.requestId === args.requestId) && !this._raw(scope).runs?.some(r => r.id === args.requestId || r.requestId === args.requestId)) throw new Error('No matching feedback request in this conversation');
      const target = targetRef.kind === 'artifact' ? this.artifact(scope, targetRef.artifactRef) : null;
      if (args.expectedDigest && target?.bodyDigest !== args.expectedDigest) throw new Error('Feedback target version changed');
      const id = randomUUID(), saved = { id, sourceId: `private:feedback-${id}`, text: args.text, kind: 'local', applicability: 'local', requestId: args.requestId || target?.requestId || null,
        clientEventId: args.clientEventId || null, targetRef, targetStatus: target?.availability === 'stale' ? 'stale' : targetRef.kind === 'unresolved_legacy' ? 'missing' : 'available', revision: 1, createdAt: now() };
      this._put(scope, 'feedback', id, saved); return saved;
    });
  }
  hydrateFeedback(scope, feedbackId) {
    const feedback = this._get(scope, 'feedback', feedbackId);
    if (!feedback || feedback.redacted) return null;
    let target = null;
    if (feedback.targetRef.kind === 'artifact') {
      const artifact = this.readableArtifact(scope, feedback.targetRef.artifactRef);
      if (artifact && !['redacted','unavailable'].includes(artifact.availability)) target = { artifactRef: artifact.ref, body: artifact.body, kind: artifact.kind, availability: artifact.availability,
        authority: 'generated_evaluation_target', deliveredMethodRefs: artifact.deliveredMethodRefs, reportedUsedMethodRefs: artifact.reportedUsedMethodRefs,
        generationStages: artifact.generationStages, sourceIds: artifact.sourceIds || [] };
    } else if (feedback.targetRef.kind === 'actual_message') {
      const message = this.store.messages(scope).find(m => m.messageId === feedback.targetRef.messageId && !m.recalled);
      if (message) target = { messageId: message.messageId, body: message.text, kind: 'actual_message', authority: 'actual_qq', sourceIds: [`qq:${message.messageId}`] };
    } else if (feedback.targetRef.kind === 'experience') target = this._publicCase(scope, this._get(scope, 'case', feedback.targetRef.experienceId));
    const live = this._sources(scope);
    return { feedback: { id: feedback.id, sourceId: feedback.sourceId, text: feedback.text, kind: 'local', targetRef: feedback.targetRef }, target,
      missing: !target, sourceIds: unique([feedback.sourceId, ...(target?.sourceIds || []).filter(id => live.has(id))]),
      correctionContext: target?.availability === 'stale' ? (target.sourceIds || []).map(id => live.get(id)).filter(Boolean).map(s => ({ sourceId: s.id, text: s.text, revision: s.revision })) : [] };
  }

  recordInteraction(scope, args) {
    return this._transaction(() => {
      const allowed = ['draft_adopted','draft_edited','draft_reviewed','clipboard_write','manual_copy_offered','draft_fill','draft_independent'];
      if (!allowed.includes(args.type)) throw new Error('UI events cannot report actual sends or method success');
      text(args.clientEventId, 'interaction event id', 256);
      const previous = this._get(scope, 'event', args.clientEventId);
      if (previous) { if (previous.signature !== digest(args)) throw new Error('Interaction event ID reused with different content'); return { event: previous, draft: this.draft(scope)||{id:'main',revision:0,text:'',artifactRefs:[],availability:'active',reviewStatus:'none'} }; }
      const body=text(args.text,'draft text',16000,true),artifactRefs=(args.artifactRefs||[]).map(ref);
      if(artifactRefs.length>8)throw new Error('Too many draft origins');
      const draftId=args.draftId||'main';text(draftId,'draft id',256);const existing=this._get(scope,'draft',draftId);
      const mutatesDraft=['draft_adopted','draft_edited','draft_reviewed','draft_independent'].includes(args.type);
      if(mutatesDraft&&args.expectedRevision!==undefined&&args.expectedRevision!==(existing?.revision||0))throw new Error('Draft changed in another window; keep your text and reload its version');
      const sameOrigins=JSON.stringify(artifactRefs.map(refKey).sort())===JSON.stringify((existing?.artifactRefs||[]).map(refKey).sort());
      const legacyOrigins=artifactRefs.length>0&&!existing?.artifactRefs?.length&&artifactRefs.every(reference=>this.artifact(scope,reference)?.provenance==='legacy_turn_materialization');
      const states=this.artifactStates(scope,artifactRefs),unavailable=states.some(s=>!['active','stale'].includes(s.availability)),stale=states.some(s=>s.availability==='stale');
      if(unavailable)throw new Error('Draft origin was removed or changed; review the current source');
      let reviewStatus='none',reviewWitnesses=[];
      if(args.type==='draft_reviewed'){
        if(!artifactRefs.length||!sameOrigins||args.expectedRevision===undefined)throw new Error('Review must retain the exact existing draft origins and revision');
        const witnesses=args.artifactWitnesses;
        if(!Array.isArray(witnesses)||witnesses.length!==states.length||states.some(state=>!witnesses.some(w=>w?.ref&&refKey(w.ref)===refKey(state.ref)&&w.witness===state.witness)))throw new Error('Artifact review witness changed; reread the current source before confirming');
        reviewStatus='reviewed';reviewWitnesses=states.map(s=>({ref:s.ref,witness:s.witness}));
      }else if(stale){
        const reviewed=sameOrigins&&this._reviewValid(existing,states);
        if(args.type==='draft_edited'&&(sameOrigins||legacyOrigins)){reviewStatus=reviewed?'reviewed':'required';reviewWitnesses=reviewed?existing.reviewWitnesses:[];}
        else if(['clipboard_write','manual_copy_offered','draft_fill'].includes(args.type)&&reviewed&&existing.text===body){reviewStatus='reviewed';reviewWitnesses=existing.reviewWitnesses;}
        else throw new Error('Draft origin was removed or changed; explicit review is required');
      }else if(args.type==='draft_edited'&&sameOrigins&&this._reviewValid(existing,states)){reviewStatus='reviewed';reviewWitnesses=existing.reviewWitnesses;}
      if(args.type==='draft_edited'&&existing?.artifactRefs?.length&&!sameOrigins)throw new Error('Draft edits must retain their original artifact refs');
      if(!['succeeded','failed','cancelled','unknown'].includes(args.outcome||'succeeded'))throw new Error('Invalid interaction outcome');
      const at=now(),proposed={id:draftId,revision:(existing?.revision||0)+1,text:body,bodyDigest:digest(body),artifactRefs,reviewStatus,reviewWitnesses,
        originStatus:!artifactRefs.length?'unlinked':args.type==='draft_reviewed'?'reviewed_after_correction':args.type==='draft_edited'&&legacyOrigins?'legacy_origin_recovered':args.type==='draft_edited'?'unclear':artifactRefs.length>1?'combined':'adopted',updatedAt:at,availability:stale&&reviewStatus!=='reviewed'?'stale':'active'};
      const draft=mutatesDraft?proposed:existing||{id:draftId,revision:0,text:'',artifactRefs:[],availability:'active',reviewStatus:'none'};
      const event={id:args.clientEventId,clientEventId:args.clientEventId,type:args.type,draftId,draftRevision:draft.text===body?draft.revision:null,artifactRefs,reviewStatus,reviewWitnesses,
        text:body,bodyDigest:digest(body),outcome:args.outcome||'succeeded',eventAt:args.eventAt&&Number.isFinite(Date.parse(args.eventAt))?new Date(args.eventAt).toISOString():at,
        receivedAt:at,signature:digest(args),authority:'ui_observed',sent:false};
      if(mutatesDraft)this._put(scope,'draft',draftId,draft);this._put(scope,'event',event.id,event);
      if(['clipboard_write','draft_fill','draft_adopted'].includes(event.type)&&event.outcome==='succeeded')this.observeMessages(scope,this.store.messages(scope).filter(m=>m.direction==='outgoing'&&Math.abs(m.timestamp-Date.parse(event.eventAt))<=86400000));
      return {event,draft};
    });
  }
  draft(scope) {
    const draft=this._get(scope,'draft','main');if(!draft)return null;
    if(draft.availability==='redacted')return draft;
    const states=this.artifactStates(scope,draft.artifactRefs||[]);
    if(states.some(s=>s.availability==='redacted'))return {...draft,text:'',availability:'redacted',reviewStatus:'required'};
    if(states.some(s=>s.availability==='unknown'))return {...draft,availability:'unknown',reviewStatus:'required'};
    if(states.some(s=>s.availability==='stale')&&!this._reviewValid(draft,states))return {...draft,availability:'stale',reviewStatus:'required'};
    return draft;
  }
  _actualRef(message) { return { kind: 'qq_message', messageId: message.messageId, sourceRevision: digest(message), eventAt: new Date(message.timestamp).toISOString() }; }
  observeMessages(scope, records) {
    return this._transaction(() => {
      const excluded = new Set(this.store.ignoredSources ? this.store.ignoredSources(scope) : []);
      for (const message of records) {
        if (['accountUid','accountUin','peerUid','peerUin'].some(key => message[key] !== scope[key])) throw new Error('Actual message does not belong to this experience scope');
        if (message.kind !== 'actual' || message.recalled || excluded.has(`qq:${message.messageId}`)) continue;
        if (typeof message.messageId !== 'string') throw new Error('Original QQ ID must remain a string');
        if (message.direction === 'outgoing') {
          const id = `qq:${message.messageId}`;
          const existing=this._get(scope, 'case', id);if(existing?.status==='invalidated')continue;
          const timestamp = Number(message.timestamp), events = this._all(scope, 'event').filter(e => ['clipboard_write', 'draft_fill', 'draft_adopted'].includes(e.type) && e.outcome === 'succeeded' && e.text?.trim() === message.text?.trim() && timestamp >= Date.parse(e.eventAt) - 5000 && timestamp - Date.parse(e.eventAt) <= 86400000);
          const refs = [...new Map(events.flatMap(e => e.artifactRefs || []).filter(r => this.artifact(scope, r)?.availability === 'active').map(r => [refKey(r), r])).values()];
          const links = refs.map(reference => ({ id: randomUUID(), artifactRefs: [reference], checkpointRefs: events.filter(e => e.artifactRefs.some(r => refKey(r) === refKey(reference))).map(e => e.id), actualMessageIds: [message.messageId], status: 'candidate', reason: 'Matching text and event time; usage is not established', revision: 1 }));
          if(existing){const before=existing.links.length;for(const link of links)if(!existing.links.some(old=>old.artifactRefs.some(r=>refKey(r)===refKey(link.artifactRefs[0]))))existing.links.push(link);if(existing.links.length!==before){if(existing.attribution==='unlinked')existing.attribution='candidate';this._put(scope,'case',id,existing)}continue;}
          this._put(scope, 'case', id, { id, createdAt: now(), eventAt: new Date(timestamp).toISOString(), goalVersion: this._raw(scope).goal?.version || 0,
            actualActions: [this._actualRef(message)], sourceIds: [id], links, observations: [], feedbackIds: [], status: 'open', attribution: refs.length ? 'candidate' : 'unlinked' });
        } else if (message.direction === 'incoming') {
          const cases = this._all(scope, 'case').filter(c => c.eventAt && Date.parse(c.eventAt) <= Number(message.timestamp) && Number(message.timestamp) - Date.parse(c.eventAt) <= 7 * 86400000).slice(-4);
          for (const item of cases) {
            if (item.observations.some(o => o.messageId === message.messageId)) continue;
            item.observations.push({ kind: 'subsequent_message', messageId: message.messageId, sourceId: `qq:${message.messageId}`, sourceRevision: digest(message), eventAt: new Date(message.timestamp).toISOString(), relevance: 'unconfirmed', authority: 'actual_qq' });
            item.status = 'observation_available'; this._put(scope, 'case', item.id, item);
          }
        }
      }
    });
  }
  observeRelationshipEvents(scope, records) {
    return this._transaction(()=>{
      const live=this._sources(scope);
      for(const rawEvent of records.filter(r=>r.recordType==='relationship_event')){
        const event=evidenceViewRecord(rawEvent);
        if(!Array.isArray(event.sourceIds)||!event.sourceIds.length||event.sourceIds.some(id=>!live.has(id)||live.get(id).revision!==event.sourceRevisions?.[id]))throw new Error('Activity observation needs current scoped source revisions');
        const id=event.activityId||`activity:${digest(event.activityKey)}`,old=this._get(scope,'case',id);
        const item=old||{id,createdAt:now(),eventAt:event.occurredAt||null,reportedAt:event.reportedAt||event.at,occurrenceTimeStatus:event.occurrenceTimeStatus||'unknown',goalVersion:this._raw(scope).goal?.version||0,actualActions:[],sourceIds:[],links:[],observations:[],feedbackIds:[],status:'open',attribution:'unlinked'};
        item.activityId=event.activityId||event.activityKey;item.sourceIds=unique([...item.sourceIds,...event.sourceIds]);
        item.observations=item.observations.filter(o=>o.relationshipEventId!==event.id);
        item.observations.push({kind:'activity_event',relationshipEventId:event.id,eventKind:event.eventKind,text:event.text,sourceIds:event.sourceIds,sourceRevisions:event.sourceRevisions,eventAt:event.occurredAt||null,reportedAt:event.reportedAt||event.at,occurrenceTimeStatus:event.occurrenceTimeStatus||'unknown',authority:event.origin==='qq_observation'?'derived_from_qq_statements':'derived_from_user_report',lifecycle:event.lifecycle});
        item.status='observation_available';item.eventAt=event.occurredAt||null;item.reportedAt=event.reportedAt||event.at;item.occurrenceTimeStatus=event.occurrenceTimeStatus||'unknown';
        if(event.eventKind==='occurred'&&event.lifecycle==='active')item.actualActions=[{kind:'user_reported_activity',activityId:event.activityId||event.activityKey,sourceIds:event.sourceIds,sourceRevisions:event.sourceRevisions,eventAt:event.occurredAt||null,reportedAt:event.reportedAt||event.at,occurrenceTimeStatus:event.occurrenceTimeStatus||'unknown',authority:'reported_not_directly_observed'}];
        this._put(scope,'case',id,item);
      }
    });
  }
  confirmLink(scope, args) {
    return this._transaction(() => {
      const item = this._get(scope, 'case', args.caseId);
      if (!item || item.status === 'invalidated') throw new Error('Experience is unavailable');
      if (!['user_confirmed', 'rejected'].includes(args.status)) throw new Error('Usage needs an explicit user confirmation or rejection');
      const link = item.links.find(l => l.id === args.linkId); if (!link) throw new Error('Unknown experience link');
      if (args.expectedVersion !== undefined && args.expectedVersion !== link.revision) throw new Error('Experience link changed');
      if (link.artifactRefs.some(r => this.artifact(scope, r)?.availability !== 'active')) throw new Error('Related suggestion is no longer current');
      if (args.actualMessageIds !== undefined) {
        if (!Array.isArray(args.actualMessageIds) || !args.actualMessageIds.length || args.actualMessageIds.length > 8 || args.actualMessageIds.some(id => typeof id !== 'string')) throw new Error('Choose one to eight original QQ message IDs');
        const messages = this.store.messages(scope), selected = args.actualMessageIds.map(id => messages.find(m => m.messageId === id && m.direction === 'outgoing' && !m.recalled));
        if (selected.some(m => !m)) throw new Error('Linked actual messages must be outgoing evidence in this conversation');
        link.actualMessageIds = unique(args.actualMessageIds);item.actualActions=selected.map(m=>this._actualRef(m));item.sourceIds=selected.map(m=>`qq:${m.messageId}`);
      }
      link.status = args.status; link.revision++; link.confirmation = { authority: 'user_report', text: typeof args.text === 'string' ? text(args.text, 'link explanation', 2000) : args.status === 'user_confirmed' ? '用户确认这次实际表达参考了该建议' : '用户说明这次表达并未采用该建议', at: now() };
      item.attribution = args.status; this._put(scope, 'case', item.id, item); this.store.touchContext?.(scope); return this._publicCase(scope, item);
    });
  }
  review(scope, args) {
    return this._transaction(() => {
      if(args.feedbackId){
        const feedback=this._get(scope,'feedback',args.feedbackId);
        if(!feedback||feedback.redacted||feedback.targetRef?.kind!=='experience'||feedback.targetRef.experienceId!==args.caseId)throw new Error('Review target is unavailable in this conversation');
        if(args.clientEventId&&feedback.lastCorrectionEventId===args.clientEventId){if(feedback.text!==args.text)throw new Error('Review event ID reused with different content');return {experience:this._publicCase(scope,this._get(scope,'case',args.caseId)),feedback};}
        if(args.expectedVersion!==feedback.revision)throw new Error('Review changed; reopen its current version before correcting');
        feedback.text=text(args.text,'corrected experience review',10000);feedback.revision++;feedback.updatedAt=now();feedback.lastCorrectionEventId=args.clientEventId||null;this._put(scope,'feedback',feedback.id,feedback);this.store.touchContext?.(scope);
        return {experience:this._publicCase(scope,this._get(scope,'case',args.caseId)),feedback};
      }
      if(args.clientEventId){const previous=this._all(scope,'feedback').find(f=>f.clientEventId===args.clientEventId);if(previous){if(previous.text!==args.text||previous.targetRef?.kind!=='experience'||args.caseId&&previous.targetRef.experienceId!==args.caseId)throw new Error('Review event ID reused with different content');return {experience:this._publicCase(scope,this._get(scope,'case',previous.targetRef.experienceId)),feedback:previous};}}
      let item = args.caseId ? this._get(scope, 'case', args.caseId) : null;
      if (args.caseId && !item) throw new Error('Unknown experience');
      if (!item) item = { id: randomUUID(), createdAt: now(), eventAt: now(), goalVersion: this._raw(scope).goal?.version || 0, actualActions: [], sourceIds: [], links: [], observations: [], feedbackIds: [], status: 'open', attribution: 'independent_user_report' };
      text(args.text, 'experience review', 10000);
      this._put(scope, 'case', item.id, item);
      const feedback = this.addFeedback(scope, { text: args.text, targetRef: { kind: 'experience', experienceId: item.id }, clientEventId: args.clientEventId });
      if (!item.feedbackIds.includes(feedback.id)) item.feedbackIds.push(feedback.id);
      item.status = 'reviewed'; item.reviewedAt = now(); this._put(scope, 'case', item.id, item);this.store.touchContext?.(scope);
      return { experience: this._publicCase(scope, item), feedback };
    });
  }
  adapt(scope, args) {
    return this._transaction(() => {
      if (!['propose', 'activate', 'retire', 'revise'].includes(args.operation)) throw new Error('Invalid experience adaptation operation');
      const old = args.id && this._get(scope, 'adaptation', args.id);
      if (args.id && !old) throw new Error('Unknown adaptation');
      if (old && args.expectedVersion !== undefined && old.version !== args.expectedVersion) throw new Error('Adaptation changed');
      if (!old && args.operation !== 'propose') throw new Error('Create a concrete proposal first');
      const sourceIds = unique(args.sourceIds || old?.sourceIds || []), sourceRefs = args.operation === 'retire' ? old.sourceRefs : this._refs(scope, sourceIds);
      if (!sourceIds.length) throw new Error('An adaptation needs current source-backed feedback');
      if (args.operation === 'activate' && (old.status === 'invalidated' || old.sourceRefs.some(r => sourceRefs.find(s => s.sourceId === r.sourceId)?.revision !== r.revision))) throw new Error('Guidance evidence changed; revise the concrete proposal before activation');
      const guidance = text(args.text ?? old?.text, 'personal guidance', 2000), applicability = text(args.applicability ?? old?.applicability, 'guidance applicability', 1000);
      const methodRef=args.methodRef||old?.methodRef||null;
      if(methodRef&&(!plain(methodRef)||typeof methodRef.methodId!=='string'||!methodRef.methodId||typeof methodRef.version!=='string'||!methodRef.version))throw new Error('Guidance method reference needs its delivered version');
      if(!old){const duplicate=this._all(scope,'adaptation').find(a=>a.text===guidance&&a.applicability===applicability&&JSON.stringify(a.methodRef)===JSON.stringify(methodRef)&&JSON.stringify(a.sourceRefs)===JSON.stringify(sourceRefs)&&!['retired','invalidated'].includes(a.status));if(duplicate)return duplicate;}
      const saved = { id: old?.id || randomUUID(), version: (old?.version || 0) + 1, text: guidance, applicability,
        methodRef, sourceIds, sourceRefs, caseIds: args.caseIds || old?.caseIds || [],
        status: args.operation === 'activate' ? 'active' : args.operation === 'retire' ? 'retired' : 'candidate', scope: 'this_relationship',
        authority: args.operation === 'activate' ? 'user_approved_assistance_guidance' : 'provisional_assistance_guidance', claim: 'assistance_fit_not_romantic_causality', createdAt: old?.createdAt || now(), updatedAt: now() };
      if (saved.caseIds.some(id => !this._get(scope, 'case', id))) throw new Error('Adaptation references another or missing experience');
      this._put(scope, 'adaptation', saved.id, saved);if(saved.status==='active'||old?.status==='active')this.store.touchContext?.(scope);return saved;
    });
  }
  proposeFromModel(scope, proposal, { allowedSourceIds=[],allowedCaseIds=[],deliveredMethods=[] }={}) {
    return this._transaction(()=>{
      if(!plain(proposal)||Object.keys(proposal).some(key=>!['text','applicability','methodId','sourceIds','caseIds'].includes(key)))throw new Error('Unauthorized experience proposal fields');
      if(!Array.isArray(proposal.sourceIds)||!proposal.sourceIds.length||proposal.sourceIds.some(id=>typeof id!=='string'||!allowedSourceIds.includes(id)))throw new Error('Experience proposal evidence was not delivered');
      const canonical=this.sourceRows(scope),sourceIds=unique(proposal.sourceIds);
      if(!sourceIds.some(id=>canonical.some(f=>f.id===id)))throw new Error('A personal assistance proposal requires canonical user feedback');
      const caseIds=proposal.caseIds||[];
      if(!Array.isArray(caseIds)||caseIds.some(id=>typeof id!=='string'||!allowedCaseIds.includes(id)))throw new Error('Experience proposal case was not delivered');
      const method=deliveredMethods.find(m=>(m.methodId||m.id)===proposal.methodId);
      if(!method||typeof method.version!=='string')throw new Error('Experience proposal method was not delivered with a version');
      return this.adapt(scope,{operation:'propose',text:proposal.text,applicability:proposal.applicability,methodRef:{methodId:proposal.methodId,version:method.version},sourceIds,caseIds});
    });
  }

  pruneSemanticReview(scope,record,{sourceIds=[],artifactRefs=[]}={}) {
    const retained=record||this._raw(scope),sources=new Set(sourceIds),artifacts=new Set(artifactRefs.map(refKey));let changed=false;
    for(const turn of retained.turns||[]){
      if(!turn.semanticReview?.findings?.length)continue;
      const before=turn.semanticReview.findings;
      const all=(turn.sourceIds||[]).some(id=>sources.has(id))||turn.artifactRef&&artifacts.has(refKey(turn.artifactRef));
      const filtered=all?[]:before.filter(finding=>{
        if((finding.evidence||[]).some(ref=>sources.has(ref.sourceId)))return false;
        for(const [field,index]of [['suggestions',/^suggestions\[(\d+)\]\./],['expressionOptions',/^expressionOptions\[(\d+)\]\./]]){
          const match=index.exec(finding.path),reference=match&&turn[field]?.[Number(match[1])]?.artifactRef;
          if(reference&&artifacts.has(refKey(reference)))return false;
        }
        return true;
      });
      if(filtered.length!==before.length){turn.semanticReview={...turn.semanticReview,status:'incomplete',findings:filtered};changed=true;}
    }
    if(changed&&!record)this.db.prepare('UPDATE companion SET record=? WHERE scope_key=?').run(this.store._serializeCompanion(retained),this.scopeKey(scope));
    return changed;
  }
  invalidateEvidenceLosses(scope,lossRefs,{mode='forget'}={}) {
    const changed=new Set(lossRefs),artifacts=this._all(scope,'artifact').filter(artifact=>(artifact.inputEvidenceLossRefs||[]).some(ref=>changed.has(ref.lossRef)));
    return this.invalidateArtifacts(scope,artifacts.map(artifact=>artifact.ref),{mode});
  }
  invalidateSources(scope, ids, { mode = 'correct', artifactRefs=[] } = {}) {
    return this._transaction(() => {
      const changed = new Set(ids), affected = new Set(artifactRefs.map(refKey));
      const artifacts=this._all(scope,'artifact'),feedbacks=this._all(scope,'feedback'),cases=this._all(scope,'case'),aliases=this._all(scope,'alias');
      // Resolve the complete dependency closure before returning to the source
      // journal. A long chain of evaluated answers must not need one pass each.
      let advanced=true;
      while(advanced){
        const before=changed.size+affected.size;
        for(const alias of aliases)if(changed.has(alias.canonicalId)||(alias.possibleDuplicates||[]).some(id=>changed.has(`private:feedback-${id}`)))changed.add(alias.sourceId);
        for(const artifact of artifacts)if(artifact.availability!=='redacted'&&(affected.has(refKey(artifact.ref))||artifact.parentRef&&affected.has(refKey(artifact.parentRef))||(artifact.inputArtifactRefs||[]).some(input=>affected.has(refKey(input.artifactRef)))||(artifact.sourceIds||[]).some(id=>changed.has(id)))){
          affected.add(refKey(artifact.ref));const target=mode==='forget'?'redacted':'stale';
          if(artifact.availability!==target){artifact.availability=target;artifact.invalidatedAt=now();if(mode==='forget'){artifact.body='';artifact.label='';delete artifact.bodyDigest;delete artifact.signature}this._put(scope,'artifact',refKey(artifact.ref),artifact);}
        }
        const affectedCases=new Set(cases.filter(item=>item.sourceIds.some(id=>changed.has(id))||item.observations.some(o=>changed.has(o.sourceId)||(o.sourceIds||[]).some(id=>changed.has(id)))).map(item=>item.id));
        for(const feedback of feedbacks){
          const depends=feedback.targetRef?.kind==='artifact'&&affected.has(refKey(feedback.targetRef.artifactRef))||feedback.targetRef?.kind==='actual_message'&&changed.has(`qq:${feedback.targetRef.messageId}`)||feedback.targetRef?.kind==='experience'&&affectedCases.has(feedback.targetRef.experienceId);
          if(!(depends||mode==='forget'&&changed.has(feedback.sourceId)))continue;
          const targetStatus=mode==='forget'?'redacted':'stale';if(feedback.targetStatus===targetStatus&&(mode!=='forget'||feedback.redacted))continue;
          feedback.targetStatus=targetStatus;feedback.revision++;changed.add(feedback.sourceId);if(mode==='forget'){feedback.text='';feedback.redacted=true}this._put(scope,'feedback',feedback.id,feedback);
        }
        advanced=changed.size+affected.size>before;
      }
      for (const lane of ['draft', 'event']) for (const item of this._all(scope, lane)) if ((item.artifactRefs || []).some(r => affected.has(refKey(r)))) {
        item.availability = mode === 'forget' ? 'redacted' : 'stale';item.reviewStatus='required';delete item.reviewWitnesses;
        if (mode === 'forget') { item.text = ''; delete item.bodyDigest; delete item.signature; }
        this._put(scope, lane, item.id, item);
      }
      for (const item of cases) {
        let modified = false;
        for (const link of item.links) if (link.artifactRefs.some(r => affected.has(refKey(r)))) { if(link.status!=='invalidated'){link.status = 'invalidated'; link.revision++;modified=true}if (mode === 'forget'&&link.confirmation){delete link.confirmation;modified=true} }
        if (item.sourceIds.some(id => changed.has(id))) {
          item.status = 'invalidated'; modified = true;
          if(item.activityId){delete item.activityId;item.actualActions=item.actualActions.filter(action=>!(action.sourceIds||[]).some(id=>changed.has(id)));}
        }
        const before = item.observations.length; item.observations = item.observations.filter(o => !changed.has(o.sourceId)&&!(o.sourceIds||[]).some(id=>changed.has(id)));
        if (before !== item.observations.length) modified = true;
        if (modified) this._put(scope, 'case', item.id, item);
      }
      for (const item of this._all(scope, 'adaptation')) if (item.sourceIds.some(id => changed.has(id))) {
        if(item.status!=='invalidated'){item.status = 'invalidated'; item.version++;} if (mode === 'forget') { item.text = ''; item.applicability = ''; }
        this._put(scope, 'adaptation', item.id, item);
      }
      this.pruneSemanticReview(scope,null,{sourceIds:[...changed],artifactRefs:[...affected].map(key=>{const at=key.lastIndexOf('@');return {artifactId:key.slice(0,at),version:Number(key.slice(at+1))};})});
      return [...changed];
    });
  }
  _publicCase(scope, item) {
    if (!item) return null;
    const messages = new Map(this.store.messages(scope).filter(m => !m.recalled).map(m => [m.messageId, m]));
    const live=this._sources(scope);
    const events=this.store._memoryRecords(scope).filter(record=>record.recordType==='relationship_event');
    const unverified=event=>event&&(event.knowledgeSchemaVersion!==2||event.occurrenceTimeStatus==='legacy_unverified'||event.semanticReview?.status==='legacy_unreviewed');
    const timeView=(record,event)=>unverified(event)?{...record,eventAt:null,reportedAt:event.reportedAt||event.lastEvidenceAt,occurrenceTimeStatus:'legacy_unverified'}:record;
    const observations=item.observations.map(o=>timeView(o,events.find(event=>event.id===o.relationshipEventId)));
    const actions=item.actualActions.map(action=>timeView(action,action.kind==='user_reported_activity'&&events.find(event=>(event.activityId||event.activityKey)===action.activityId&&event.sourceIds.length===(action.sourceIds||[]).length&&event.sourceIds.every(id=>action.sourceIds.includes(id)))));
    const gaps=this.db.prepare('SELECT record FROM memory_gaps WHERE scope_key=?').all(this.scopeKey(scope)).map(row=>JSON.parse(row.record));
    const activityState=item.activityId&&publicActivities(this.store._memoryRecords(scope),gaps,live).activities.find(activity=>activity.activityId===item.activityId);
    const legacyTime=[...observations,...actions].find(record=>record.occurrenceTimeStatus==='legacy_unverified');
    return { ...clone(item),...(activityState?{activityState,activityLabel:activityState.activityKey}:{}),...(legacyTime?{eventAt:null,reportedAt:legacyTime.reportedAt,occurrenceTimeStatus:'legacy_unverified'}:{}),actualActions: actions.map(a => ({ ...a, text: item.status === 'invalidated' ? '' : a.kind==='qq_message'?messages.get(a.messageId)?.text || '':'用户报告活动发生', availability: item.status === 'invalidated' || a.kind==='qq_message'&&!messages.has(a.messageId) ? 'unavailable' : 'available' })),
      links: item.links.map(link => ({ ...clone(link), artifacts: link.artifactRefs.map(r => this.readableArtifact(scope, r)).filter(Boolean).map(a => ({ ref: a.ref, text: ['redacted','unavailable'].includes(a.availability) ? '' : a.body, availability: a.availability })) })),
      observations: observations.map(o => ({ ...o, text: o.kind==='activity_event'?(o.sourceIds||[]).every(id=>live.get(id)?.revision===o.sourceRevisions?.[id])?o.text:'':messages.get(o.messageId)?.text || '' })),
      reviews: item.feedbackIds.map(id => this._get(scope, 'feedback', id)).filter(f => f && !f.redacted).map(f => ({ id: f.id, sourceId: f.sourceId, text: f.text, targetRef: f.targetRef,version:f.revision })) };
  }
  list(scope, { limit = 20 } = {}) {
    const count = Math.max(1, Math.min(100, Number(limit) || 20));
    return { cases: this._all(scope, 'case').slice(-count).reverse().map(item => this._publicCase(scope, item)), adaptations: this._all(scope, 'adaptation').filter(a => a.status !== 'invalidated').slice(-count).reverse(), draft: this.draft(scope),artifactStates:this.artifactStates(scope) };
  }
  context(scope, { query = '', limit = 4 } = {}) {
    const count = Math.max(1, Math.min(8, Number(limit) || 4)), terms = unique((query.match(/[\p{Script=Han}]{2}|[a-zA-Z0-9]{3,}/gu) || []).map(t => t.toLowerCase()));
    const relevant = value => !terms.length || terms.some(term => JSON.stringify(value).toLowerCase().includes(term));
    const available = this.listFeedback(scope), matchedFeedback = available.filter(relevant), selectedFeedback = (matchedFeedback.length ? matchedFeedback : available.slice(-2)).slice(-count);
    const targets = selectedFeedback.map(f => this.hydrateFeedback(scope, f.id)).filter(Boolean);
    const cases = this._all(scope, 'case').filter(c => c.status !== 'invalidated').map(c => this._publicCase(scope, c)).filter(relevant).slice(-count);
    const live=this._sources(scope);
    const active=this._all(scope,'adaptation').map((value,index)=>({value,index})).filter(({value:a})=>a.status==='active'&&a.authority==='user_approved_assistance_guidance'&&a.scope==='this_relationship'&&
      Array.isArray(a.sourceIds)&&a.sourceIds.length&&Array.isArray(a.sourceRefs)&&a.sourceRefs.length&&a.sourceIds.every(id=>a.sourceRefs.some(reference=>reference?.sourceId===id))&&
      a.sourceRefs.every(reference=>reference&&typeof reference.revision==='string'&&!!reference.revision&&live.has(reference.sourceId)&&live.get(reference.sourceId).revision===reference.revision))
      .sort((a,b)=>(Date.parse(b.value.updatedAt||b.value.createdAt)||0)-(Date.parse(a.value.updatedAt||a.value.createdAt)||0)||b.index-a.index).map(({value})=>value);
    const lexical=a=>terms.length&&terms.some(term=>`${a.text} ${a.applicability}`.toLowerCase().includes(term));
    const matched=active.filter(lexical).slice(0,count),matchedIds=new Set(matched.map(a=>a.id));
    const fallback=active.filter(a=>!matchedIds.has(a.id)&&!lexical(a)).slice(0,Math.min(2,count-matched.length));
    const adaptations=[...matched.map(a=>({...clone(a),matchBasis:'lexical',applicabilityStatus:'needs_model_check'})),
      ...fallback.map(a=>({...clone(a),matchBasis:'recent_active_fallback',applicabilityStatus:'needs_model_check'}))];
    return { scope:clone(scope),cases, adaptations, evaluationTargets: targets,
      constraints: ['Actual message occurrence is separate from confirmed suggestion use.', 'Feedback and generated evaluation targets do not establish her feelings or method causality.',
        'Activated guidance is a scoped candidate, not proof of current applicability. Check its conditions and the latest user intent; irrelevant, negated or conflicting guidance must not be applied.'] };
  }
}
module.exports = { ExperienceStore, visibleResponseText };
