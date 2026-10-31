'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { rank } = require('./memory-search.cjs');
const { ExperienceStore } = require('./experience-store.cjs');
const { assertPreferenceAuthority, sourceClosure } = require('./provenance.cjs');
const { PROCESSOR_VERSION, prepareRelationshipPatch, writeRelationshipRecords, relationshipView } = require('./relationship-store.cjs');
const { emptyTopics, pruneTopics, topicView, prepareTopicPatch, normalizeTopicPatch } = require('./topic-store.cjs');
const { DiscussionCompactionStore, validateDiscussionTurnFingerprints } = require('./discussion-compaction-store.cjs');
const {readOriginalEvidence,coverageFor,requireOriginals}=require('./original-evidence.cjs');
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const { DatabaseSync } = require('node:sqlite');
const {publicRecord}=require('./media.cjs');
const { compare, sameScope, qqSourceMetadata } = require('./messages.cjs');
function messageEvidence(message) {
  const { sequence, senderUid, ...evidence } = message;
  return JSON.stringify(evidence);
}
function sourceRevision(source) {
  if(source.type!=='qq')return hash(source);
  // Ordering and redundant scoped author identity can enrich legacy sources
  // without discarding their derived memory. A reply edge remains evidence.
  const {sequence,senderUid,senderUin,...evidence}=source;
  return hash(evidence);
}
const scopeFields = ['accountUid', 'accountUin', 'peerUid', 'peerUin'];
function scopeKey(scope) {
  if (!scope || scopeFields.some(key => typeof scope[key] !== 'string' || !scope[key].trim() || scope[key].length > 256)) throw new Error('Invalid conversation scope: four nonempty string identifiers are required');
  return JSON.stringify(scopeFields.map(key => scope[key]));
}
function plain(value) { return !!value && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null); }
function textValue(value, name, max = 100000, allowEmpty = false) {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim()) || value.length > max) throw new Error(`Invalid ${name}: expected ${allowEmpty ? '' : 'nonempty '}string of at most ${max} characters`);
  return value;
}
function identifier(value, name = 'identifier') { return textValue(value, name, 256); }
function sourceList(value, name = 'sourceIds') {
  if (!Array.isArray(value) || value.some(id => typeof id !== 'string' || !/^(qq|private|note):.+$/.test(id) || id.length > 300)) throw new Error(`Invalid ${name}`);
  return [...new Set(value)];
}
function normalizeResponseRecovery(value) {
  if(!plain(value)||Object.keys(value).some(key=>!['kind','reasonCode','metadataApplied','intentSourceIds','intentSourceRevisions'].includes(key))||!['private_help','restricted_draft'].includes(value.kind)||value.reasonCode!=='structured_output_invalid'||value.metadataApplied!==false)throw new Error('Invalid program response recovery marker');
  const intentSourceIds=sourceList(value.intentSourceIds||[],'response recovery intent sources');
  if(intentSourceIds.length>1||intentSourceIds.some(id=>!id.startsWith('private:'))||value.kind==='restricted_draft'&&intentSourceIds.length)throw new Error('Invalid response recovery intent sources');
  if(value.intentSourceRevisions!==undefined&&(!plain(value.intentSourceRevisions)||Object.keys(value.intentSourceRevisions).some(id=>!intentSourceIds.includes(id))||intentSourceIds.some(id=>typeof value.intentSourceRevisions[id]!=='string')))throw new Error('Invalid response recovery intent source revisions');
  return {kind:value.kind,reasonCode:value.reasonCode,metadataApplied:false,intentSourceIds,...(value.intentSourceRevisions?{intentSourceRevisions:{...value.intentSourceRevisions}}:{})};
}
function normalizeMetadataReviewPending(value) {
  if(!plain(value)||Object.keys(value).some(key=>!['reasonCode','sourceIds','sourceRevisions'].includes(key))||value.reasonCode!=='auxiliary_metadata_rejected')throw new Error('Invalid pending metadata review marker');
  const sourceIds=sourceList(value.sourceIds,'pending metadata review sources');
  if(value.sourceIds.length!==1||sourceIds.length!==1||!sourceIds[0].startsWith('private:'))throw new Error('Pending metadata review requires one private user source');
  if(!plain(value.sourceRevisions)||Object.keys(value.sourceRevisions).length!==1||typeof value.sourceRevisions[sourceIds[0]]!=='string'||!value.sourceRevisions[sourceIds[0]])throw new Error('Invalid pending metadata source revision');
  return {reasonCode:value.reasonCode,sourceIds,sourceRevisions:{...value.sourceRevisions}};
}
function normalizePrivateReviewReceipt(value) {
  if(!plain(value)||Object.keys(value).some(key=>!['applied','sourceIds','sourceRevisions'].includes(key))||value.applied!==true)throw new Error('Invalid private review receipt');
  const sourceIds=sourceList(value.sourceIds,'private review sources');
  if(!sourceIds.length||sourceIds.length>64||sourceIds.some(id=>!id.startsWith('private:')))throw new Error('Invalid private review sources');
  if(value.sourceRevisions!==undefined&&(!plain(value.sourceRevisions)||Object.keys(value.sourceRevisions).some(id=>!sourceIds.includes(id))||sourceIds.some(id=>typeof value.sourceRevisions[id]!=='string')))throw new Error('Invalid private review source revisions');
  return {applied:true,sourceIds,...(value.sourceRevisions?{sourceRevisions:{...value.sourceRevisions}}:{})};
}
function emptyState(version = 0) {
  return { version, focus: '', items: [], openThreads: [], unknowns: [], possiblyStale: true, coverage: { complete: false, sourceIds: [] } };
}
const TASK_SEMANTICS_VERSION = 1;
function emptyCompanion() { return { taskSemanticsVersion: TASK_SEMANTICS_VERSION, revision: 0, goal: { text: '', version: 0 }, notes: [], turns: [], state: emptyState(), topics: emptyTopics(), runs: [], feedback: [], pendingActions: [], actionReceipts: [] }; }
function changedSource(record, invalidate = false) {
  record.revision++;
  if (invalidate) {
    // Deletion/correction must also remove verbatim private copies in generated payloads.
    record.state = emptyState(record.state.version + 1);
    record.runs = [];
    record.turns = record.turns.filter(turn => turn.role === 'user');
    record.feedback = [];
    record.pendingActions = [];
    record.actionReceipts = [];
  } else {
    record.state.possiblyStale = true;
    record.state.coverage = { ...record.state.coverage, complete: false };
  }
}
class Store {
  constructor(filename) {
    if (filename !== ':memory:') fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    if (filename !== ':memory:') fs.chmodSync(filename, 0o600);
    try {
      this.db.exec('PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON; BEGIN IMMEDIATE');
      const schemaVersion=this.db.prepare('PRAGMA user_version').get().user_version;
      if(schemaVersion>2)throw new Error(`Unsupported newer store schema version: ${schemaVersion}`);
      this.db.exec(`CREATE TABLE IF NOT EXISTS messages(
      account_uid TEXT NOT NULL, peer_uid TEXT NOT NULL, message_id TEXT NOT NULL, record TEXT NOT NULL,
      PRIMARY KEY(account_uid,peer_uid,message_id));
      CREATE TABLE IF NOT EXISTS coverage(account_uid TEXT NOT NULL,peer_uid TEXT NOT NULL,record TEXT NOT NULL,
      PRIMARY KEY(account_uid,peer_uid));
      CREATE TABLE IF NOT EXISTS companion(scope_key TEXT PRIMARY KEY,record TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_sources(scope_key TEXT NOT NULL,source_id TEXT NOT NULL,revision TEXT NOT NULL,record TEXT NOT NULL,deleted INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(scope_key,source_id));
      CREATE TABLE IF NOT EXISTS memory_journal(seq INTEGER PRIMARY KEY AUTOINCREMENT,scope_key TEXT NOT NULL,source_id TEXT NOT NULL,revision TEXT NOT NULL,operation TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',cursor INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS memory_pending ON memory_journal(scope_key,status,seq);
      CREATE TABLE IF NOT EXISTS memory_records(scope_key TEXT NOT NULL,id TEXT NOT NULL,kind TEXT NOT NULL,record TEXT NOT NULL,PRIMARY KEY(scope_key,id));
      CREATE TABLE IF NOT EXISTS memory_dependencies(scope_key TEXT NOT NULL,id TEXT NOT NULL,source_id TEXT NOT NULL,revision TEXT NOT NULL,PRIMARY KEY(scope_key,id,source_id));
      CREATE INDEX IF NOT EXISTS memory_source_dependencies ON memory_dependencies(scope_key,source_id);
      CREATE TABLE IF NOT EXISTS memory_exclusions(scope_key TEXT NOT NULL,source_id TEXT NOT NULL,PRIMARY KEY(scope_key,source_id));
      CREATE TABLE IF NOT EXISTS memory_receipts(scope_key TEXT NOT NULL,batch_id TEXT NOT NULL,record TEXT NOT NULL,PRIMARY KEY(scope_key,batch_id));
      CREATE TABLE IF NOT EXISTS memory_meta(scope_key TEXT PRIMARY KEY,version INTEGER NOT NULL DEFAULT 0,error TEXT);
      CREATE TABLE IF NOT EXISTS memory_migrations(scope_key TEXT NOT NULL,version INTEGER NOT NULL,record TEXT NOT NULL,PRIMARY KEY(scope_key,version));
      CREATE TABLE IF NOT EXISTS memory_gaps(scope_key TEXT NOT NULL,id TEXT NOT NULL,record TEXT NOT NULL,PRIMARY KEY(scope_key,id));
      CREATE TABLE IF NOT EXISTS memory_pending_proposals(scope_key TEXT NOT NULL,id TEXT NOT NULL,record TEXT NOT NULL,PRIMARY KEY(scope_key,id));`);
    if(!this.db.prepare('PRAGMA table_info(memory_journal)').all().some(c=>c.name==='cursor'))this.db.exec('ALTER TABLE memory_journal ADD COLUMN cursor INTEGER NOT NULL DEFAULT 0');
    if(!this.db.prepare('PRAGMA table_info(memory_journal)').all().some(c=>c.name==='queued_at')){this.db.exec('ALTER TABLE memory_journal ADD COLUMN queued_at TEXT');this.db.prepare('UPDATE memory_journal SET queued_at=? WHERE queued_at IS NULL').run(new Date().toISOString());}
    if(!this.db.prepare('PRAGMA table_info(memory_meta)').all().some(c=>c.name==='processor_version'))this.db.exec('ALTER TABLE memory_meta ADD COLUMN processor_version TEXT');
    this.experiences = new ExperienceStore(this, {scopeKey});
    this.discussionCompactions = new DiscussionCompactionStore(this);
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL,description TEXT NOT NULL)');
    this.db.prepare('INSERT OR IGNORE INTO schema_migrations VALUES(?,?,?)').run(1,new Date().toISOString(),'Relationship and experience storage; semantic bootstrap is tracked separately');
    this.db.prepare('INSERT OR IGNORE INTO schema_migrations VALUES(?,?,?)').run(2,new Date().toISOString(),'Evidence-backed knowledge metadata; structural conversion is not semantic review');
    this.db.exec('PRAGMA user_version=2; COMMIT');
    } catch(error) {if(this.db.isTransaction)this.db.exec('ROLLBACK');this.db.close();throw error;}
    this.insert = this.db.prepare(`INSERT INTO messages VALUES(?,?,?,?)
      ON CONFLICT(account_uid,peer_uid,message_id) DO UPDATE SET record=excluded.record`);
  }
  add(scope, records) {
    scopeKey(scope);
    let changes = 0;
    let invalidates = false;
    const accepted=[];
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const message of records) {
        if (!sameScope(message, scope) || message.kind !== 'actual') throw new Error('Message scope or provenance rejected');
        if(typeof message.messageId!=='string'||!message.messageId||message.messageId.length>256)throw new Error('Original QQ message ID must remain a string');
        const data = JSON.stringify(message);
        const old = this.db.prepare('SELECT record FROM messages WHERE account_uid=? AND peer_uid=? AND message_id=?')
          .get(scope.accountUid, scope.peerUid, message.messageId);
        if (old?.record === data) continue;
        // Native history may finish after a live recall. QQ recalls cannot be undone
        // by a stale nonrecalled copy of the same scoped message.
        if (old && !message.recalled) {
          const previous = JSON.parse(old.record);
          if (previous.recalled && sameScope(previous, scope)) continue;
        }
        if (old && messageEvidence(JSON.parse(old.record)) !== messageEvidence(message)) invalidates = true;
        this.insert.run(scope.accountUid, scope.peerUid, message.messageId, data);
        changes++;accepted.push(message);
      }
      if (changes) {
        const companion = this._getCompanion(scope);
        changedSource(companion, invalidates);
        this._writeCompanion(scope, companion);
        this.experiences.observeMessages(scope, accepted);
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return changes;
  }
  scopeKey(scope) { return scopeKey(scope); }
  getCompanion(scope) {
    // Mutation paths keep the original record. UI and model consumers receive
    // the same scoped artifact projection without overwriting retained turns.
    return this.experiences.projectCompanion(scope,this._getCompanion(scope));
  }
  _getCompanion(scope) {
    return this._atomic(()=>{
      const row = this.db.prepare('SELECT record FROM companion WHERE scope_key=?').get(scopeKey(scope));
      const stored=row&&JSON.parse(row.record);
      let record=stored ? { ...emptyCompanion(), ...stored, taskSemanticsVersion:stored.taskSemanticsVersion||0 } : emptyCompanion();
      this.experiences.migrateLegacy(scope,record);
      record=this._normalizeFeedbackReferences(scope,record);
      if(this.experiences.materializeLegacyArtifacts(scope,record))this.db.prepare('INSERT INTO companion VALUES(?,?) ON CONFLICT(scope_key) DO UPDATE SET record=excluded.record').run(scopeKey(scope),this._serializeCompanion(record));
      record.feedback=this.experiences.listFeedback(scope);
      for(const turn of record.turns)if(turn.kind==='feedback_ref'&&turn.feedbackId){const f=record.feedback.find(f=>f.id===turn.feedbackId);turn.text=f?`对助手建议的反馈：${f.text}`:'已移除的反馈';}
      if(this._pruneDiscussionDerived(scope,record)){
        changedSource(record);this.db.prepare('INSERT INTO companion VALUES(?,?) ON CONFLICT(scope_key) DO UPDATE SET record=excluded.record').run(scopeKey(scope),this._serializeCompanion(record));
        this._syncMemory(scope,record);record.feedback=this.experiences.listFeedback(scope);
      }
      const taskMigrated=this._migrateTaskSemantics(record,this._rawMemorySources(scope,record));
      const taskPruned=record.topics.items.length&&pruneTopics(record,this._rawMemorySources(scope,record));
      if(taskMigrated||taskPruned){
        this._invalidateTaskDerived(scope);
        this.db.prepare('INSERT INTO companion VALUES(?,?) ON CONFLICT(scope_key) DO UPDATE SET record=excluded.record').run(scopeKey(scope),this._serializeCompanion(record));
      }
      // Legacy origin is derived in scoped read views. Mutating an original
      // turn here would change fingerprints and invalidate legitimate history.
      record.consultationTask=topicView(scope,record.topics);
      return record;
    });
  }
  _migrateTaskSemantics(record,sources) {
    if(record.taskSemanticsVersion>=TASK_SEMANTICS_VERSION)return false;
    const previous={...emptyState(),...record.state},live=new Map(sources.map(source=>[source.id,source]));
    const hasControls=previous.focus||(previous.openThreads||[]).length||(previous.unknowns||[]).length;
    const ids=[...new Set([...(previous.coverage?.sourceIds||[]),...(previous.openThreads||[]).flatMap(item=>item.sourceIds||[])])].filter(id=>live.has(id));
    const review=hasControls?{status:'needs_review',reason:'legacy_controls_are_historical_not_current_intent',focus:previous.focus,openThreads:previous.openThreads,unknowns:previous.unknowns,
      sourceIds:ids,sourceRevisions:Object.fromEntries(ids.map(id=>[id,live.get(id).revision])),observedAt:ids.map(id=>live.get(id).at).sort().at(-1)||null}:null;
    record.state={...previous,version:previous.version+1,focus:'',openThreads:[],unknowns:[],possiblyStale:true,
      items:(previous.items||[]).map(item=>({...item,sourceRevisions:Object.fromEntries((item.sourceIds||[]).filter(id=>live.has(id)).map(id=>[id,live.get(id).revision])),
        observedAt:(item.sourceIds||[]).map(id=>live.get(id)?.at).filter(Boolean).sort().at(-1)||null,evidenceStatus:'legacy_needs_review'})),
      ...(review?{legacyTaskReviews:[...(previous.legacyTaskReviews||[]),review]}:{})};
    record.taskSemanticsVersion=TASK_SEMANTICS_VERSION;
    return true;
  }
  _invalidateTaskDerived(scope) {
    this.db.prepare('DELETE FROM discussion_compactions WHERE scope_key=?').run(scopeKey(scope));
  }
  _normalizeFeedbackReferences(scope,record) {
    const canonical=new Map(this.experiences.sourceRows(scope).map(source=>[source.id,{...source,revision:hash(source)}]));
    const mappings=[];
    for(const turn of record.turns.filter(t=>['feedback','feedback_ref'].includes(t.kind))){
      const from=`private:${turn.id}`,to=this.experiences.canonicalSource(scope,from),source=canonical.get(to);
      if(from!==to&&source)mappings.push({from,to,revision:source.revision});
    }
    for(const row of this.db.prepare('SELECT source_id,record FROM memory_sources WHERE scope_key=? AND deleted=0').all(scopeKey(scope))){
      const old=JSON.parse(row.record),source=canonical.get(row.source_id);
      if(old.type==='feedback'&&!old.canonicalFeedbackId&&source&&old.text===source.text)mappings.push({from:row.source_id,to:row.source_id,revision:source.revision});
    }
    const map=new Map(mappings.map(m=>[m.from,m])),before=JSON.stringify(record);
    const walk=value=>{
      if(Array.isArray(value))return value.map(walk);if(!plain(value))return value;
      const copy={...value};
      for(const key of ['sourceIds','evidenceSourceIds'])if(Array.isArray(copy[key]))copy[key]=[...new Set(copy[key].map(id=>map.get(id)?.to||id))];
      for(const key of ['sourceRevisions','evidenceRevisions'])if(plain(copy[key]))copy[key]=Object.fromEntries(Object.entries(copy[key]).map(([id,rev])=>[map.get(id)?.to||id,map.get(id)?.revision||rev]));
      if(copy.sourceId&&map.has(copy.sourceId)){const m=map.get(copy.sourceId);copy.sourceId=m.to;if(copy.revision!==undefined)copy.revision=m.revision;}
      for(const [key,child]of Object.entries(copy))if(!['text','body','sourceIds','evidenceSourceIds','sourceRevisions','evidenceRevisions'].includes(key)&&child&&typeof child==='object')copy[key]=walk(child);
      return copy;
    };
    const updated=walk(record);
    for(const turn of updated.turns.filter(t=>['feedback','feedback_ref'].includes(t.kind))){const m=map.get(`private:${turn.id}`);if(m){turn.kind='feedback_ref';turn.feedbackId=m.to.slice('private:feedback-'.length);delete turn.text;}}
    if(mappings.length)this.experiences.remapSources(scope,mappings);
    // In ambiguous migration cases preserve editable text but withhold uncertain
    // provenance from model input until the user supplies an independent source.
    for(const note of updated.notes){
      const ambiguous=(note.evidenceSourceIds||[]).map(id=>this.experiences._get(scope,'alias',id)).filter(a=>a?.possibleDuplicates?.length);
      if(ambiguous.length){note.use='disabled';note.needsSourceReview=true;note.possibleEvidenceSourceIds=[...new Set(ambiguous.flatMap(a=>a.possibleDuplicates.map(id=>`private:feedback-${id}`)))];}
      if(note.kind==='preference'&&note.evidenceSourceIds){try{assertPreferenceAuthority(new Map(this._rawMemorySources(scope,updated).map(s=>[s.id,s])),note.evidenceSourceIds);}catch{note.kind='material';note.needsPreferenceReview=true;}}
    }
    updated.feedback=[];
    if(JSON.stringify(updated)!==before){
      changedSource(updated);this.db.prepare('INSERT INTO companion VALUES(?,?) ON CONFLICT(scope_key) DO UPDATE SET record=excluded.record').run(scopeKey(scope),this._serializeCompanion(updated));
    }
    return updated;
  }
  contextGeneration(scope) {
    const row=this.db.prepare('SELECT record FROM companion WHERE scope_key=?').get(scopeKey(scope));
    const record=row?JSON.parse(row.record):emptyCompanion();
    const memory=this.db.prepare('SELECT version FROM memory_meta WHERE scope_key=?').get(scopeKey(scope));
    return `${record.revision||0}:${record.state?.version||0}:${memory?.version||0}:${record.topics?.version||0}`;
  }
  _atomic(fn) {
    const owns=!this.db.isTransaction;
    if(owns)this.db.exec('BEGIN IMMEDIATE');
    try { const result=fn();if(owns)this.db.exec('COMMIT');return result; }
    catch(error){if(owns)this.db.exec('ROLLBACK');throw error;}
  }
  _serializeCompanion(record) {
    // Feedback bodies belong to ExperienceStore. Rendered timeline text is a
    // projection; every persistence path, including state CAS, uses this shape.
    const {consultationTask,...persisted}=record;
    return JSON.stringify({...persisted,feedback:[],turns:record.turns.map(turn=>turn.kind==='feedback_ref'?{...turn,text:undefined}:turn)});
  }
  _writeCompanion(scope, record) {
    this._atomic(()=>{
      this._pruneDiscussionDerived(scope,record);
      this._pruneProvenance(scope,record);
      this.db.prepare('INSERT INTO companion VALUES(?,?) ON CONFLICT(scope_key) DO UPDATE SET record=excluded.record')
        .run(scopeKey(scope), this._serializeCompanion(record));
      this._syncMemory(scope, record);
      this.discussionCompactions.prune(scope,record);
    });
  }
  _pruneDiscussionDerived(scope,record) {
    const removed=new Set(),bound=record.turns.length+1;
    for(let pass=0;pass<bound;pass++){
      const invalid=record.turns.filter(turn=>turn.role==='assistant'&&turn.discussionTurnFingerprints&&(()=>{
        try{validateDiscussionTurnFingerprints(record,turn.discussionTurnFingerprints,{newTurnId:turn.id,store:this,scope});return false;}catch{return true;}
      })());
      if(!invalid.length)break;
      for(const turn of invalid){removed.add(turn.id);this.experiences.invalidateArtifacts(scope,this.experiences.refsForTurn(scope,turn.id),{mode:'forget',knownTurnId:turn.id});}
      record.turns=record.turns.filter(turn=>!removed.has(turn.id));
    }
    if(removed.size){
      record.state=emptyState(record.state.version+1);
      record.runs=record.runs.filter(run=>!removed.has(run.replyId));
    }
    return removed.size;
  }
  _sourceIds(scope, record = this._getCompanion(scope)) {
    return new Set(this._rawMemorySources(scope,record).map(s=>s.id));
  }
  setGoal(scope, text, metadata = {}) {
    return this._atomic(()=>{
      textValue(text, 'goal', 10000, true);
      const record = this._getCompanion(scope);
      if (record.goal.text !== text) {
        record.goal = { text, version: record.goal.version + 1 };
        if(metadata.evidenceSourceIds) { record.goal.evidenceSourceIds=sourceList(metadata.evidenceSourceIds);if(record.goal.evidenceSourceIds.some(id=>!this._sourceIds(scope,record).has(id)))throw new Error('Invalid goal source');record.goal.evidenceRevisions=Object.fromEntries(this._rawMemorySources(scope,record).filter(s=>record.goal.evidenceSourceIds.includes(s.id)).map(s=>[s.id,s.revision])); }
        // A changed aim invalidates the plan, not the user's conversation history.
        changedSource(record);record.state=emptyState(record.state.version+1);record.runs=[];
        const active=record.topics.items.find(topic=>topic.id===record.topics.activeId&&topic.lifecycle==='active');
        if(active){active.lifecycle='paused';active.version++;active.updatedAt=new Date().toISOString();active.lifecycleEvidenceStatus='goal_changed_needs_review';active.lifecycleSourceIds=[];active.lifecycleSourceRevisions={};record.topics.activeId=null;record.topics.version++;}
        this._invalidateTaskDerived(scope);
        record.pendingActions=record.pendingActions.filter(action=>action.action?.type!=='set_goal');
        this._writeCompanion(scope, record);
      }
      return record.goal;
    });
  }
  saveNote(scope, note) {
    return this._atomic(()=>{
      if (!plain(note)) throw new Error('Invalid note');
      textValue(note.text, 'note text');
      if (!['discussion', 'draft', 'disabled'].includes(note.use)) throw new Error('Invalid note use');
      const record = this._getCompanion(scope);
      const id = note.id === undefined ? randomUUID() : identifier(note.id, 'note id');
      const index = record.notes.findIndex(item => item.id === id), old = record.notes[index];
      if (old && old.text === note.text && old.use === note.use && (note.kind===undefined||note.kind===old.kind) && note.evidenceSourceIds===undefined && note.sourceIds===undefined) return old;
      const now = new Date().toISOString();
      const saved = { id, text: note.text, use: note.use, version: (old?.version || 0) + 1, createdAt: old?.createdAt || now, updatedAt: now };
      if(note.kind!==undefined) { if(!['material','preference'].includes(note.kind))throw new Error('Invalid note kind');saved.kind=note.kind; } else if(old?.kind)saved.kind=old.kind;
      if(note.evidenceSourceIds||note.sourceIds) {
        saved.evidenceSourceIds=sourceList(note.evidenceSourceIds||note.sourceIds);
        if(saved.evidenceSourceIds.some(id=>!this._sourceIds(scope,record).has(id)))throw new Error('Invalid note source');
        saved.evidenceRevisions=Object.fromEntries(this._rawMemorySources(scope,record).filter(s=>saved.evidenceSourceIds.includes(s.id)).map(s=>[s.id,s.revision]));
      } else if(old?.evidenceSourceIds){saved.evidenceSourceIds=old.evidenceSourceIds;saved.evidenceRevisions=old.evidenceRevisions;}
      if(saved.kind==='preference'&&saved.evidenceSourceIds)assertPreferenceAuthority(new Map(this._rawMemorySources(scope,record).map(s=>[s.id,s])),saved.evidenceSourceIds);
      if (index < 0) record.notes.push(saved); else record.notes[index] = saved;
      changedSource(record, !!old); this._writeCompanion(scope, record);
      return saved;
    });
  }
  deleteNote(scope, id) {
    return this._atomic(()=>{
      identifier(id, 'note id'); const record = this._getCompanion(scope);
      const index = record.notes.findIndex(note => note.id === id);
      if (index < 0) return false;
      record.notes.splice(index, 1); changedSource(record, true); this._writeCompanion(scope, record); return true;
    });
  }
  appendTurn(scope, turn) {
    return this._atomic(()=>{
      if (!plain(turn) || !['user', 'assistant'].includes(turn.role)) throw new Error('Invalid private turn role');
      if(turn.kind!=='feedback_ref')textValue(turn.text, 'turn text', 100000, turn.role === 'assistant');
      textValue(turn.kind, 'turn kind', 100);
      const record = this._getCompanion(scope);
      const id = turn.id === undefined ? randomUUID() : identifier(turn.id, 'turn id');
      if (record.turns.some(item => item.id === id)) throw new Error('Private turn id already exists');
      const saved = { id, role: turn.role, kind: turn.kind, text: turn.text||'', createdAt: new Date().toISOString() };
      if(turn.discussionExplanation!==undefined){
        const explanation=turn.discussionExplanation;
        if(turn.role!=='assistant'||!plain(explanation)||Object.keys(explanation).some(key=>!['kind','text'].includes(key))||
          !['discussion','question','options','review','acknowledgment'].includes(explanation.kind))throw new Error('Invalid assistant discussion explanation');
        textValue(explanation.text,'discussion explanation',6000);
        saved.discussionExplanation={kind:explanation.kind,text:explanation.text};
      }
      if(turn.kind==='feedback_ref'){saved.feedbackId=identifier(turn.feedbackId,'feedback id');if(!record.feedback.some(f=>f.id===saved.feedbackId))throw new Error('Unknown feedback reference');}
      if(turn.kind==='feedback'){const canonical=record.feedback.filter(f=>f.requestId===turn.requestId&&turn.text===`对助手建议的反馈：${f.text}`);if(canonical.length===1){saved.kind='feedback_ref';saved.feedbackId=canonical[0].id;}}
      if (turn.requestId !== undefined) saved.requestId = identifier(turn.requestId, 'request id');
      if(turn.origin!==undefined){
        if(turn.role!=='assistant'||!['automatic','user'].includes(turn.origin))throw new Error('Invalid assistant origin');
        saved.origin=turn.origin;
      }
      if(turn.replyDisposition!==undefined){
        if(turn.role!=='assistant'||!['wait','clarify','unavailable'].includes(turn.replyDisposition))throw new Error('Invalid replyDisposition');
        saved.replyDisposition=turn.replyDisposition;
      }
      if (turn.sourceIds !== undefined) {
        saved.sourceIds = sourceList(turn.sourceIds);
        const live = this._sourceIds(scope, record);
        if (saved.sourceIds.some(source => !live.has(source))) throw new Error('Invalid private turn source');
      }
      if (turn.suggestions !== undefined) {
        if (!Array.isArray(turn.suggestions)) throw new Error('Invalid suggestions');
        saved.suggestions = JSON.parse(JSON.stringify(turn.suggestions));
      }
      if(turn.expressionOptions!==undefined) {
        if(!Array.isArray(turn.expressionOptions)||turn.expressionOptions.length>8)throw new Error('Invalid expression options');
        saved.expressionOptions=JSON.parse(JSON.stringify(turn.expressionOptions));
      }
      if(turn.actionReceipts!==undefined) {
        if(!Array.isArray(turn.actionReceipts)||turn.actionReceipts.length>8||turn.actionReceipts.some(r=>!plain(r)))throw new Error('Invalid action receipts');
        saved.actionReceipts=JSON.parse(JSON.stringify(turn.actionReceipts));
      }
      if(turn.methodIds!==undefined) {
        if(!Array.isArray(turn.methodIds)||turn.methodIds.length>12||turn.methodIds.some(id=>typeof id!=='string'||id.length>100))throw new Error('Invalid method IDs');
        saved.methodIds=[...turn.methodIds];
      }
      const checkPrivateMetadataSources=(ids,expected={})=>{
        const live=new Map(this._rawMemorySources(scope,record).map(source=>[source.id,source])),delivered=new Set(turn.sourceIds||[]),refs=new Map((turn.artifactMetadata?.inputSourceRefs||[]).map(ref=>[ref.sourceId,ref.revision]));
        for(const id of ids){const source=live.get(id),direct=source?.role==='user'&&(source.type==='private'&&source.kind!=='feedback_continue'||source.type==='feedback'&&source.kind==='local'&&!!source.canonicalFeedbackId);
          if(!direct||!delivered.has(id)&&!refs.has(id)||refs.has(id)&&refs.get(id)!==source.revision||expected[id]!==undefined&&expected[id]!==source.revision)throw new Error('Unavailable or undelivered private metadata source');}
        return Object.fromEntries(ids.map(id=>[id,live.get(id).revision]));
      };
      if(turn.metadataReviewPending!==undefined){
        if(turn.role!=='assistant')throw new Error('Pending metadata review is assistant program metadata');
        if(turn.privateReviewReceipt!==undefined)throw new Error('Pending metadata review cannot claim an applied private review');
        const pending=normalizeMetadataReviewPending(turn.metadataReviewPending);
        saved.metadataReviewPending={...pending,sourceRevisions:checkPrivateMetadataSources(pending.sourceIds,pending.sourceRevisions)};
      }
      if(turn.responseRecovery!==undefined){
        if(turn.role!=='assistant')throw new Error('Response recovery is assistant program metadata');
        const recovery=normalizeResponseRecovery(turn.responseRecovery);
        if(recovery.kind==='private_help'&&(!['discussion','review','question'].includes(turn.kind)||turn.suggestions?.length||turn.expressionOptions?.length)||recovery.kind==='restricted_draft'&&turn.kind!=='draft')throw new Error('Response recovery does not match the private help or restricted draft artifact');
        saved.responseRecovery={...recovery,intentSourceRevisions:checkPrivateMetadataSources(recovery.intentSourceIds,recovery.intentSourceRevisions)};
      }
      if(turn.privateReviewReceipt!==undefined){
        if(turn.role!=='assistant'||saved.responseRecovery?.kind==='private_help')throw new Error('Private help recovery cannot claim an applied private review');
        const receipt=normalizePrivateReviewReceipt(turn.privateReviewReceipt);saved.privateReviewReceipt={...receipt,sourceRevisions:checkPrivateMetadataSources(receipt.sourceIds,receipt.sourceRevisions)};
      }
      if(turn.role==='assistant'&&turn.artifactMetadata?.discussionTurnFingerprints!==undefined){
        const references=validateDiscussionTurnFingerprints(record,turn.artifactMetadata.discussionTurnFingerprints,{newTurnId:saved.id,store:this,scope});
        if(Object.keys(references).length)saved.discussionTurnFingerprints=references;
      }
      if(turn.role==='assistant'){const refs=this.experiences.recordArtifacts(scope,saved,turn.artifactMetadata||{});saved.artifactRef=refs.responseRef;if(saved.suggestions)saved.suggestions=saved.suggestions.map((x,i)=>({...x,artifactRef:refs.suggestionRefs[i]}));if(saved.expressionOptions)saved.expressionOptions=saved.expressionOptions.map((x,i)=>({...x,artifactRef:refs.optionRefs[i]}));}
      record.turns.push(saved);
      if (turn.role === 'user'&&!['feedback','feedback_ref'].includes(saved.kind)) changedSource(record);
      this._writeCompanion(scope, record); return saved;
    });
  }
  deleteTurn(scope, id) {
    return this._atomic(()=>{
      identifier(id, 'turn id'); const record = this._getCompanion(scope);
      const index = record.turns.findIndex(turn => turn.id === id);
      if (index < 0) return false;
      const turn=record.turns[index];
      if(turn.kind==='feedback_ref'&&turn.feedbackId&&record.feedback.some(f=>f.id===turn.feedbackId))return this.forgetSource(scope,`private:feedback-${turn.feedbackId}`);
      if(turn.role==='assistant')this.experiences.invalidateArtifacts(scope,this.experiences.refsForTurn(scope,turn.id),{mode:'forget',knownTurnId:turn.id});
      else if(turn.kind==='feedback')this.experiences.invalidateSources(scope,[`private:${turn.id}`],{mode:'forget'});
      record.turns.splice(index,1);
      // Deleting an output removes that artifact family, not its still-valid raw
      // sources or unrelated answers grounded in those same sources.
      if(turn.role==='user')changedSource(record,true);
      else {changedSource(record);record.runs=[];}
      this._writeCompanion(scope, record); return true;
    });
  }
  saveRun(scope, run) {
    return this._atomic(()=>{
      if (!plain(run)) throw new Error('Invalid run');
      const record = this._getCompanion(scope), saved = JSON.parse(JSON.stringify(run));
      saved.id = saved.id === undefined ? randomUUID() : identifier(saved.id, 'run id');
      if (saved.requestId !== undefined) identifier(saved.requestId, 'request id');
      if (saved.baseRevision !== undefined && saved.baseRevision !== record.revision) throw new Error('Stale run revision');
      const previous = record.runs.find(item => item.id === saved.id), now = new Date().toISOString();
      saved.createdAt = previous?.createdAt || now; saved.updatedAt = now;
      record.runs = [...record.runs.filter(item => item.id !== saved.id), saved].slice(-12);
      this._writeCompanion(scope, record); return saved;
    });
  }
  addFeedback(scope, feedback) {
    return this._atomic(()=>{
      const record=this._getCompanion(scope),saved=this.experiences.addFeedback(scope,feedback);
      if(record.feedback.some(f=>f.id===saved.id)&&record.turns.some(t=>t.feedbackId===saved.id))return saved;
      if(!record.turns.some(t=>t.feedbackId===saved.id))record.turns.push({id:randomUUID(),role:'user',kind:'feedback_ref',feedbackId:saved.id,requestId:saved.requestId,createdAt:saved.createdAt});
      changedSource(record);record.feedback=this.experiences.listFeedback(scope);this._writeCompanion(scope,record);return saved;
    });
  }
  touchContext(scope) {
    return this._atomic(()=>{const record=this._getCompanion(scope);changedSource(record);this._writeCompanion(scope,record);return record.revision;});
  }
  relationshipView(scope, options={}) { this.ensureKnowledgeMigration(scope);return {...relationshipView(this,scope,options),understanding:this.personUnderstanding(scope,options)}; }
  topicView(scope) {
    return this._atomic(()=>topicView(scope,this._getCompanion(scope).topics));
  }
  topicAction(scope,{id,expectedVersion,operation,...fields}={}) {
    return this._atomic(()=>{
      if(!['create','update','pause','complete','cancel','resume','remove'].includes(operation))throw new Error('未知的话题操作');
      if(Object.keys(fields).some(key=>!['objective','direction','constraints','stage','progress','unknowns','interpretationStatus'].includes(key)))throw new Error('话题操作包含不支持的字段');
      if(operation==='create'&&id!==undefined)throw new Error('Topic creation cannot choose an existing identifier');
      const before=this._getCompanion(scope),topic=operation==='create'?null:before.topics.items.find(item=>item.id===identifier(id,'topic id'));
      if(operation!=='create'&&!topic)throw new Error('这个话题已不存在，请刷新后核对');
      if(operation!=='create'&&(!Number.isSafeInteger(expectedVersion)||expectedVersion!==topic.version)||operation==='create'&&expectedVersion!==undefined&&expectedVersion!==before.topics.version)throw new Error('话题已经变化，请刷新后核对版本');
      const patch=operation==='remove'?null:normalizeTopicPatch({operation,...(operation==='create'?{}:{topicId:id}),...fields});
      const command={create:'建立这次讨论任务。',update:'调整这次讨论任务。',pause:'暂停这次话题，等待我另行决定是否继续。',complete:'这次话题已经聊清楚了，结束它的当前目的、方向和限制。',cancel:'取消这次话题，不再沿用它的当前目的、方向和限制。',resume:'恢复这次话题的当前目的、方向和限制。',remove:'移除这次话题，不再把它作为当前或保留话题。'}[operation];
      const requestId=randomUUID(),turn=this.appendTurn(scope,{role:'user',kind:'user_control',requestId,text:`${command}\n话题：${topic?.objective||fields.objective||id||''}\n${Object.keys(fields).length?JSON.stringify(fields):''}\n只操作这个讨论话题，保留原始聊天、私下历史和长期关系目标。`});
      const sourceId=`private:${turn.id}`,record=this._getCompanion(scope);
      if(operation==='remove'){
        this._commitTaskTransition(scope,record,{...record.topics,version:record.topics.version+1,activeId:record.topics.activeId===id?null:record.topics.activeId,items:record.topics.items.filter(item=>item.id!==id)});
      }else{
        const source=this._rawMemorySources(scope,record).find(item=>item.id===sourceId);
        const receipt=this.applyTopicPatch(scope,{...patch,purposeSourceIds:[sourceId],...(patch.progress?.length?{observationSourceIds:[sourceId]}:{}),intentQuote:command},{baseRevision:record.revision,baseTopicVersion:record.topics.version,activeId:record.topics.activeId,sourceIds:[sourceId],sourceRevisions:{[sourceId]:source.revision},currentSourceId:sourceId,origin:'user_control',requestId});
        if(!receipt.applied)throw new Error(`话题未更新：${receipt.detail||receipt.reason}`);
        id=receipt.topicId;
      }
      const next=this._getCompanion(scope),updated=next.topics.items.find(item=>item.id===id);
      return {applied:true,operation,topicId:id,lifecycle:updated?.lifecycle||'removed',topicVersion:next.topics.version,revision:next.revision,sourceId};
    });
  }
  _commitTaskTransition(scope,record,topics,{invalidateDiscussion=true}={}) {
    record.topics=topics;
    if(invalidateDiscussion)this._invalidateTaskDerived(scope);
    this._writeCompanion(scope,record);
  }
  getDiscussionCompaction(scope,options={}) { return this.discussionCompactions.get(scope,options); }
  saveDiscussionCompaction(scope,record,expected={}) { return this.discussionCompactions.save(scope,record,expected); }
  previewTopicPatch(scope,patch,options={}) {
    const record=this._getCompanion(scope),key=scopeKey(scope);
    const reject=reason=>({valid:false,reason});
    if(options.scopeKey!==undefined&&options.scopeKey!==key)return reject('wrong_scope');
    if(options.baseRevision!==record.revision)return reject('stale_revision');
    if(options.baseTopicVersion!==record.topics.version)return reject('stale_topic_version');
    if(Object.hasOwn(options,'activeId')&&options.activeId!==record.topics.activeId)return reject('stale_active_topic');
    try{prepareTopicPatch(record,this._rawMemorySources(scope,record),patch,options);return {valid:true};}
    catch(error){return {valid:false,reason:error.code==='topic_proposal_inapplicable'?'inapplicable_optional_proposal':'invalid_topic_patch',detail:error.message,...(error.code?{code:error.code}:{}),...(error.field?{field:error.field}:{})};}
  }
  applyTopicPatch(scope,patch,options={}) {
    try{return this._atomic(()=>{
      const record=this._getCompanion(scope),key=scopeKey(scope);
      const reject=reason=>({applied:false,reason,revision:record.revision,topicVersion:record.topics.version,version:record.topics.version,activeId:record.topics.activeId});
      if(options.scopeKey!==undefined&&options.scopeKey!==key)return reject('wrong_scope');
      if(!Number.isSafeInteger(options.baseRevision)||options.baseRevision!==record.revision)return reject('stale_revision');
      if(!Number.isSafeInteger(options.baseTopicVersion)||options.baseTopicVersion!==record.topics.version)return reject('stale_topic_version');
      if(Object.hasOwn(options,'activeId')&&options.activeId!==record.topics.activeId)return reject('stale_active_topic');
      const checked=prepareTopicPatch(record,this._rawMemorySources(scope,record),patch,options);
      if(checked.changes)this._commitTaskTransition(scope,record,checked.topics,{invalidateDiscussion:checked.invalidateDiscussion});
      return {applied:true,changes:checked.changes,topicId:checked.topicId,revision:record.revision,topicVersion:record.topics.version,version:record.topics.version,activeId:record.topics.activeId};
    });}catch(error){return {applied:false,reason:'invalid_topic_patch',detail:error.message};}
  }
  correctRelationshipClaim(scope, {id,expectedVersion,text,operation}={}) {
    try{return this._atomic(()=>{
      identifier(id,'claim id');if(!['correct','withdraw'].includes(operation))throw new Error('Unknown claim correction operation');
      if(operation==='correct')textValue(text,'claim correction text',1000);
      const old=this._memoryRecords(scope).find(r=>r.recordType==='claim'&&r.id===id);
      if(!old)return {applied:false,reason:'claim_unavailable'};
      if(!Number.isSafeInteger(expectedVersion)||old.version!==expectedVersion)return {applied:false,reason:'stale_claim_version'};
      const live=new Map(this._rawMemorySources(scope).map(s=>[s.id,s]));
      if(Object.entries(old.sourceRevisions).some(([sid,rev])=>live.get(sid)?.revision!==rev))return {applied:false,reason:'claim_source_unavailable'};
      const turn=this.appendTurn(scope,{role:'user',kind:'claim_correction',text:operation==='correct'?text:'用户要求停用一条助手理解。'}),sourceId=`private:${turn.id}`;
      const patch={retire:[{id,expectedVersion,sourceIds:[sourceId],lifecycle:'withdrawn'}],claims:operation==='correct'?[{subject:old.subject,aspect:old.aspect,text:`用户说明：${text}`,assertionKind:'reported',epistemicStatus:'supported',sourceIds:[sourceId],topicKeys:old.topicKeys||[]}]:[]};
      const sources=this._rawMemorySources(scope),deliveredSources=sources.map(source=>({...source,scope:{...scope}}));
      const checked=prepareRelationshipPatch(this,scope,patch,{sourceIds:sources.map(s=>s.id),deliveredSources,explicitUserCorrection:true});
      writeRelationshipRecords(this,scope,checked);this.db.prepare('UPDATE memory_meta SET version=version+1 WHERE scope_key=?').run(scopeKey(scope));
      return {applied:true,sourceId,claimId:checked.find(r=>r.id!==id)?.id||null,revision:this._getCompanion(scope).revision};
    });}catch(error){return {applied:false,reason:'invalid_claim_correction',detail:error.message};}
  }

  applyRelationshipPatch(scope, patch, options={}) {
    try{return this._atomic(()=>{
      this.ensureKnowledgeMigration(scope);
      const record=this._getCompanion(scope),key=scopeKey(scope);
      if(!Number.isSafeInteger(options.baseRevision)||options.baseRevision!==record.revision)return {applied:false,reason:'stale_revision'};
      this._syncMemory(scope,record);
      const version=this.db.prepare('SELECT version FROM memory_meta WHERE scope_key=?').get(key)?.version||0;
      if(options.baseMemoryVersion!==undefined&&options.baseMemoryVersion!==version)return {applied:false,reason:'stale_memory_version'};
      const checked=prepareRelationshipPatch(this,scope,patch,options),changed=writeRelationshipRecords(this,scope,checked);
      if(changed)this.db.prepare('UPDATE memory_meta SET version=version+1 WHERE scope_key=?').run(key);
      return {applied:true,changes:changed,version:version+(changed?1:0)};
    });}catch(error){return {applied:false,reason:'invalid_relationship_patch',detail:error.message};}
  }
  maintainLocal(scope) {
    return this._atomic(()=>{
      this.ensureKnowledgeMigration(scope);
      const key=scopeKey(scope);this._syncMemory(scope);
      const meta=this.db.prepare('SELECT processor_version FROM memory_meta WHERE scope_key=?').get(key);
      let queued=0;
      if(meta.processor_version!==PROCESSOR_VERSION){
        const support=new Set(this.db.prepare('SELECT DISTINCT source_id FROM memory_dependencies WHERE scope_key=?').all(key).map(r=>r.source_id));
        const live=this.db.prepare('SELECT source_id,revision,record FROM memory_sources WHERE scope_key=? AND deleted=0').all(key).sort((a,b)=>Number(support.has(b.source_id))-Number(support.has(a.source_id))||Date.parse(JSON.parse(b.record).at)-Date.parse(JSON.parse(a.record).at));
        for(const source of live){
          if(this.db.prepare("SELECT 1 FROM memory_journal WHERE scope_key=? AND source_id=? AND revision=? AND status='pending'").get(key,source.source_id,source.revision))continue;
          this.db.prepare("UPDATE memory_journal SET status='superseded' WHERE scope_key=? AND source_id=? AND status='reviewed'").run(key,source.source_id);
          this.db.prepare("INSERT INTO memory_journal(scope_key,source_id,revision,operation,queued_at) VALUES(?,?,?,'reindex',?)").run(key,source.source_id,source.revision,new Date().toISOString());queued++;
        }
        this.db.prepare('UPDATE memory_meta SET processor_version=?,version=version+? WHERE scope_key=?').run(PROCESSOR_VERSION,queued?1:0,key);
      }
      return {queued,processorVersion:PROCESSOR_VERSION};
    });
  }
  memorySchedulingStatus(scope) {
    const key=scopeKey(scope),rows=this.db.prepare("SELECT j.seq,j.queued_at,s.record FROM memory_journal j JOIN memory_sources s ON s.scope_key=j.scope_key AND s.source_id=j.source_id AND s.revision=j.revision WHERE j.scope_key=? AND j.status='pending' ORDER BY j.seq").all(key);
    const at=rows.map(r=>r.queued_at).filter(Boolean).sort();
    const latestEvent=this.db.prepare('SELECT max(queued_at) at FROM memory_journal WHERE scope_key=?').get(key)?.at;
    const receipt=this.db.prepare('SELECT record FROM memory_receipts WHERE scope_key=? ORDER BY rowid DESC LIMIT 1').get(key);
    return {pending:rows.length,oldestPendingAt:at[0]||null,lastEventAt:latestEvent||null,lastMaintenanceAt:receipt?JSON.parse(receipt.record).reviewedAt:null};
  }
  applyState(scope, patch, options = {}) {
    const record = this._getCompanion(scope);
    const rejected = (reason, detail) => ({ applied: false, reason, ...(detail ? { detail } : {}), revision: record.revision, stateVersion: record.state.version });
    if (!Number.isSafeInteger(options.baseRevision) || options.baseRevision !== record.revision) return rejected('stale_revision');
    if (options.baseStateVersion !== undefined && options.baseStateVersion !== record.state.version) return rejected('stale_state_version');
    if (options.baseTopicVersion !== undefined && options.baseTopicVersion !== record.topics.version) return rejected('stale_topic_version');
    try {
      if (!plain(patch) || Object.keys(patch).some(key => !['focus', 'items', 'openThreads', 'unknowns'].includes(key))) throw new Error('State patch has unauthorized fields');
      const sources=new Map(this._rawMemorySources(scope,record).map(source=>[source.id,source]));
      const allowed = sourceList(options.sourceIds || []), live = this._sourceIds(scope,record), allowedSet = new Set(allowed);
      if (allowed.some(id => !live.has(id))) throw new Error('State patch references an unavailable or nonfactual source');
      const next = { ...record.state };
      if (patch.focus !== undefined) next.focus = textValue(patch.focus, 'state focus', 1000, true);
      for (const key of ['items', 'openThreads']) {
        if (patch[key] === undefined) continue;
        if (!Array.isArray(patch[key]) || patch[key].length > 16) throw new Error(`Invalid state ${key}: expected an array with at most 16 entries`);
        next[key] = patch[key].map(item => {
          const keys = key === 'openThreads' ? ['text', 'sourceIds', 'status'] : ['text', 'sourceIds'];
          if (!plain(item) || Object.keys(item).some(field => !keys.includes(field))) throw new Error(`Unauthorized state ${key} field`);
          const ids = sourceList(item.sourceIds);
          if (!ids.length || ids.some(id => !allowedSet.has(id))) throw new Error(`Invalid state ${key} evidence`);
          const checked = { text: textValue(item.text, `state ${key} text`, 1000), sourceIds: ids,
            sourceRevisions:Object.fromEntries(ids.map(id=>[id,sources.get(id).revision])),observedAt:ids.map(id=>sources.get(id).at).sort().at(-1),evidenceStatus:'source_bound' };
          if (item.status !== undefined) checked.status = textValue(item.status, 'open thread status', 100);
          return checked;
        });
      }
      if (patch.unknowns !== undefined) {
        if (!Array.isArray(patch.unknowns) || patch.unknowns.length > 12) throw new Error('Invalid state unknowns: expected an array with at most 12 entries');
        next.unknowns = patch.unknowns.map(value => textValue(value, 'state unknown', 1000));
      }
      // Legacy state-control inputs remain reviewable history. Only a grounded
      // ConsultationTask transition can decide the persisted current task.
      const controls={focus:next.focus,openThreads:next.openThreads,unknowns:next.unknowns};
      if(controls.focus||controls.openThreads.length||controls.unknowns.length){
        const sourceIds=[...allowed];
        next.legacyTaskReviews=[...(next.legacyTaskReviews||[]),{...controls,status:'needs_review',reason:'legacy_controls_are_historical_not_current_intent',
          sourceIds,sourceRevisions:Object.fromEntries(sourceIds.map(id=>[id,sources.get(id).revision])),observedAt:sourceIds.map(id=>sources.get(id).at).sort().at(-1)||null}];
      }
      next.focus='';next.openThreads=[];next.unknowns=[];
      if (!plain(options.coverage) || typeof options.coverage.complete !== 'boolean') throw new Error('A reviewed coverage descriptor is required');
      const covered = sourceList(options.coverage.sourceIds), coveredSet = new Set(covered);
      if (covered.some(id => !allowedSet.has(id))) throw new Error('Coverage exceeds reviewed sources');
      const complete = options.coverage.complete && [...live].every(id => coveredSet.has(id));
      next.coverage = { complete, sourceIds: covered, reviewedRevision: record.revision };
      next.possiblyStale = !complete; next.version++;
      record.state = next;
      // SQLite also checks the version at write time, including another connection's writes.
      const committed = this.db.prepare(`INSERT INTO companion VALUES(?,?)
        ON CONFLICT(scope_key) DO UPDATE SET record=excluded.record
        WHERE json_extract(companion.record,'$.revision')=?
          AND json_extract(companion.record,'$.state.version')=?
          AND json_extract(companion.record,'$.topics.version')=?`)
        .run(scopeKey(scope), this._serializeCompanion(record), record.revision, next.version - 1, record.topics.version);
      if (!committed.changes) {
        const current = this._getCompanion(scope);
        return { applied: false, reason: current.revision !== record.revision ? 'stale_revision' : current.topics.version !== record.topics.version ? 'stale_topic_version' : 'stale_state_version', revision: current.revision, stateVersion: current.state.version };
      }
      return { applied: true, revision: record.revision, stateVersion: next.version };
    } catch (error) { return rejected('invalid_patch', error.message); }
  }
  _pruneProvenance(scope,record) {
    const feedbackIds=new Set(this.experiences.listFeedback(scope).map(f=>f.id));
    record.turns=record.turns.filter(turn=>{
      if(turn.kind!=='feedback')return true;
      const alias=this.experiences._get(scope,'alias',`private:${turn.id}`);
      if(alias?.possibleDuplicates?.some(id=>!feedbackIds.has(id)))return false;
      if(alias?.canonicalId?.startsWith('private:feedback-')&&!feedbackIds.has(alias.canonicalId.slice('private:feedback-'.length)))return false;
      return true;
    });
    // Natural-language extracted notes and goals retain revision-bound evidence.
    // Delete/correct a source and copies derived from its old version disappear.
    let removed=true;
    while(removed) {
      const live=new Map(this._rawMemorySources(scope,record).map(s=>[s.id,s.revision]));
      const valid=value=>value.needsSourceReview?(value.possibleEvidenceSourceIds||[]).every(id=>live.has(id)):!value.evidenceSourceIds||value.evidenceSourceIds.every(id=>live.has(id)&&(!value.evidenceRevisions||value.evidenceRevisions[id]===live.get(id)));
      const count=record.notes.length;record.notes=record.notes.filter(valid);removed=count!==record.notes.length;
      if(!valid(record.goal))record.goal={text:'',version:record.goal.version+1};
    }
    const sources=this._rawMemorySources(scope,record),live=new Map(sources.map(source=>[source.id,source]));
    record.state.items=(record.state.items||[]).filter(item=>item.sourceIds?.length&&item.sourceIds.every(id=>live.has(id)&&(!item.sourceRevisions||item.sourceRevisions[id]===live.get(id).revision)));
    if(record.state.legacyTaskReviews)record.state.legacyTaskReviews=record.state.legacyTaskReviews.filter(review=>(review.sourceIds||[]).every(id=>live.has(id)&&(!review.sourceRevisions||review.sourceRevisions[id]===live.get(id).revision)));
    if(record.topics.items.length&&pruneTopics(record,sources))this._invalidateTaskDerived(scope);
  }
  _rawMemorySources(scope, record=this._getCompanion(scope)) {
    record={...emptyCompanion(),...record};
    const excluded=new Set(this.db.prepare('SELECT source_id FROM memory_exclusions WHERE scope_key=?').all(scopeKey(scope)).map(r=>r.source_id));
    const sources=[
      ...this.messages(scope).filter(m=>!m.recalled).map(m=>({id:`qq:${m.messageId}`,type:'qq',text:m.text,at:new Date(m.timestamp).toISOString(),role:m.direction==='outgoing'?'user':'contact',direction:m.direction,use:'discussion',messageId:m.messageId,...qqSourceMetadata(m)})),
      ...record.turns.filter(t=>t.role==='user'&&!t.memoryExcluded&&!['feedback','feedback_ref'].includes(t.kind)).map(t=>({id:`private:${t.id}`,type:'private',text:t.text,at:t.createdAt,role:'user',use:'discussion',kind:t.kind,version:t.version||1})),
      ...record.notes.filter(n=>n.use!=='disabled').map(n=>({id:`note:${n.id}`,type:'note',text:n.text,at:n.updatedAt,use:n.use,kind:n.kind||'material',version:n.version,...(n.evidenceSourceIds?{evidenceSourceIds:n.evidenceSourceIds}:{}),...(n.evidenceRevisions?{evidenceRevisions:n.evidenceRevisions}:{})})),
      ...this.experiences.sourceRows(scope)
    ].filter(s=>!excluded.has(s.id));
    return sources.map(s=>({...s,revision:sourceRevision(s)}));
  }
  _syncMemory(scope, record=this._getCompanion(scope)) {
    // A source invalidation can redact feedback about an affected artifact, which
    // can itself support a note. Resolve this finite dependency chain in the same
    // transaction before any caller can observe or index a surviving copy.
    const bound=record.notes.length+this.experiences.listFeedback(scope).length+4;
    const notesBefore=JSON.stringify(record.notes),goalBefore=JSON.stringify(record.goal),turnsBefore=JSON.stringify(record.turns),topicsBefore=JSON.stringify(record.topics);
    let live=[];
    for(let pass=0;pass<bound;pass++){
      this._pruneProvenance(scope,record);
      const result=this._syncMemoryPass(scope,record);live=result.live;
      if(!result.changed){
        if(notesBefore!==JSON.stringify(record.notes)||goalBefore!==JSON.stringify(record.goal)||turnsBefore!==JSON.stringify(record.turns)||topicsBefore!==JSON.stringify(record.topics))this.db.prepare('INSERT INTO companion VALUES(?,?) ON CONFLICT(scope_key) DO UPDATE SET record=excluded.record').run(scopeKey(scope),this._serializeCompanion(record));
        return live;
      }
    }
    throw new Error('Source invalidation did not reach a stable projection');
  }
  _syncMemoryPass(scope, record) {
    let changed=0;
    const key=scopeKey(scope),live=this._rawMemorySources(scope,record),byId=new Map(live.map(s=>[s.id,s]));
    const old=this.db.prepare('SELECT * FROM memory_sources WHERE scope_key=?').all(key),oldIds=new Set(old.map(s=>s.source_id));
    this.db.prepare('INSERT OR IGNORE INTO memory_meta(scope_key) VALUES(?)').run(key);
    const write=(source,operation,mode=operation==='remove'?'forget':'correct')=>{
      changed++;
      if(oldIds.has(source.id))this.experiences.invalidateSources(scope,[source.id],{mode});
      // The journal stores identities only. Removed/revised text cannot survive
      // in old queued events or be restored by a delayed consolidation response.
      this.db.prepare("UPDATE memory_journal SET status='superseded' WHERE scope_key=? AND source_id=? AND status='pending'").run(key,source.id);
      this.db.prepare('INSERT INTO memory_sources VALUES(?,?,?,?,?) ON CONFLICT(scope_key,source_id) DO UPDATE SET revision=excluded.revision,record=excluded.record,deleted=excluded.deleted').run(key,source.id,source.revision,JSON.stringify(source),source.deleted?1:0);
      this.db.prepare('INSERT INTO memory_journal(scope_key,source_id,revision,operation,queued_at) VALUES(?,?,?,?,?)').run(key,source.id,source.revision,operation,new Date().toISOString());
      const affected=this.db.prepare('SELECT id FROM memory_dependencies WHERE scope_key=? AND source_id=?').all(key,source.id);
      for(const {id} of affected){
        const row=this.db.prepare('SELECT record FROM memory_records WHERE scope_key=? AND id=?').get(key,id),prior=row&&JSON.parse(row.record);
        // A withdrawn milestone leaves an uncertainty barrier, never its body.
        // Otherwise removing a cancellation could resurrect an older acceptance.
        if(prior?.recordType==='relationship_event')this.db.prepare('INSERT OR REPLACE INTO memory_gaps VALUES(?,?,?)').run(key,id,JSON.stringify({id,activityDigest:hash(prior.activityKey),orderAt:prior.occurredAt||prior.lastEvidenceAt,reason:'support_changed_or_withdrawn'}));
        this.db.prepare('DELETE FROM memory_records WHERE scope_key=? AND id=?').run(key,id);this.db.prepare('DELETE FROM memory_dependencies WHERE scope_key=? AND id=?').run(key,id);
      }
      for(const row of this.db.prepare('SELECT id,record FROM memory_pending_proposals WHERE scope_key=?').all(key))if(JSON.parse(row.record).sourceIds.includes(source.id))this.db.prepare('DELETE FROM memory_pending_proposals WHERE scope_key=? AND id=?').run(key,row.id);
      this.db.prepare('UPDATE memory_meta SET version=version+1,error=NULL WHERE scope_key=?').run(key);
    };
    for(const previous of old) {
      const source=byId.get(previous.source_id);
      if(source&&source.revision!==previous.revision)write(source,'upsert',JSON.parse(previous.record).use==='draft'&&source.use!=='draft'?'forget':'correct');
      else if(source&&JSON.stringify(source)!==previous.record)this.db.prepare('UPDATE memory_sources SET record=? WHERE scope_key=? AND source_id=?').run(JSON.stringify(source),key,source.id);
      if(!source&&!previous.deleted)write({id:previous.source_id,type:JSON.parse(previous.record).type,deleted:true,text:'',at:new Date().toISOString(),revision:hash({previous:previous.revision,deleted:true})},'remove',JSON.parse(previous.record).kind==='feedback'?'correct':'forget');
    }
    for(const source of live)if(!oldIds.has(source.id))write(source,'upsert');
    return {live,changed};
  }
  memorySources(scope) {
    return this._atomic(()=>this._syncMemory(scope));
  }
  readOriginalEvidence(scope,options={}) {
    const raw=this.memorySources(scope),byId=new Map(raw.map(source=>[source.id,source]));
    const roots=sourceClosure(byId,options.sourceIds||[]).map(source=>source.id);
    return readOriginalEvidence(byId,scope,{...options,sourceIds:roots});
  }
  ensureKnowledgeMigration(scope) {
    return this._atomic(()=>{
      const key=scopeKey(scope),existing=this.db.prepare('SELECT record FROM memory_migrations WHERE scope_key=? AND version=2').get(key);
      if(existing)return {...JSON.parse(existing.record),changed:false};
      let changed=0;
      for(const row of this.db.prepare('SELECT id,record FROM memory_records WHERE scope_key=?').all(key)){
        const record=JSON.parse(row.record);if(record.knowledgeSchemaVersion===2)continue;
        const next={...record,knowledgeSchemaVersion:2,legacyReviewComplete:record.reviewComplete,reviewComplete:false,
          evidenceValidity:'needs_review',semanticReview:{status:'legacy_unreviewed',structuralMigration:true},
          ...(record.recordType==='relationship_event'?{occurrenceTimeStatus:'legacy_unverified'}:{})};
        this.db.prepare('UPDATE memory_records SET record=? WHERE scope_key=? AND id=?').run(JSON.stringify(next),key,row.id);changed++;
      }
      const receipt={version:2,changed:changed>0,records:changed,semanticReverified:0,at:new Date().toISOString()};
      this.db.prepare('INSERT INTO memory_migrations VALUES(?,?,?)').run(key,2,JSON.stringify(receipt));
      if(changed)this.db.prepare('UPDATE memory_meta SET version=version+1 WHERE scope_key=?').run(key);
      return receipt;
    });
  }
  queueUnderstandingProposal(scope,patch,options={}) {
    return this._atomic(()=>{
      const key=scopeKey(scope),record=this._getCompanion(scope);if(options.baseRevision!==record.revision)return {applied:false,reason:'stale_revision'};
      const normalized=require('./relationship-schema.cjs').normalizeRelationshipPatch(patch),raw=new Map(this.memorySources(scope).map(source=>[source.id,source]));
      const ids=[...new Set(['claims','events','retire'].flatMap(field=>normalized[field].flatMap(item=>item.sourceIds)))];
      if(ids.some(id=>!options.sourceIds?.includes(id)||raw.get(id)?.revision!==options.sourceRevisions?.[id]))return {applied:false,reason:'stale_or_undelivered_proposal_source'};
      const id=hash({requestId:options.requestId,patch:normalized}),sourceRevisions=Object.fromEntries(ids.map(id=>[id,raw.get(id).revision]));
      const proposal={id,patch:normalized,sourceIds:ids,sourceRevisions,status:'pending_original_review',origin:'foreground_navigation_not_knowledge',createdAt:new Date().toISOString()};
      this.db.prepare('INSERT OR IGNORE INTO memory_pending_proposals VALUES(?,?,?)').run(key,id,JSON.stringify(proposal));
      return {applied:false,queued:true,id,reason:'pending_original_review'};
    });
  }
  personUnderstanding(scope,options={}) {this.ensureKnowledgeMigration(scope);return require('./relationship-store.cjs').personUnderstanding(this,scope,options);}
  memoryStatus(scope) {
    this.memorySources(scope);const key=scopeKey(scope);
    const journal=this.db.prepare('SELECT status,count(*) AS n FROM memory_journal WHERE scope_key=? GROUP BY status').all(key);
    const counts=Object.fromEntries(journal.map(x=>[x.status,x.n]));
    const records=this.db.prepare('SELECT kind,count(*) AS n FROM memory_records WHERE scope_key=? GROUP BY kind').all(key);
    const sourceCount=this.db.prepare('SELECT count(*) AS n FROM memory_sources WHERE scope_key=? AND deleted=0').get(key).n;
    const meta=this.db.prepare('SELECT version,error,processor_version FROM memory_meta WHERE scope_key=?').get(key);
    const latest=this.db.prepare('SELECT record FROM memory_receipts WHERE scope_key=? ORDER BY rowid DESC LIMIT 1').get(key);
    const semanticPending=this._memoryRecords(scope).filter(record=>record.recordType!=='episode'&&(!record.lifecycle||record.lifecycle==='active')&&(!record.status||record.status==='active')&&(record.reviewComplete===false||record.semanticReview?.status==='legacy_unreviewed')).length;
    const pendingProposals=this.db.prepare('SELECT count(*) n FROM memory_pending_proposals WHERE scope_key=?').get(key).n;
    return {pending:counts.pending||0,processed:counts.reviewed||0,superseded:counts.superseded||0,semanticPending,pendingProposals,version:meta?.version||0,counts:{sources:sourceCount,items:records.find(x=>x.kind==='item')?.n||0,episodes:records.find(x=>x.kind==='episode')?.n||0,claims:records.find(x=>x.kind==='claim')?.n||0,events:records.find(x=>x.kind==='relationship_event')?.n||0},errors:meta?.error?[JSON.parse(meta.error)]:[],lastReview:latest?JSON.parse(latest.record):null};
  }
  _memoryRecords(scope) {
    return this.db.prepare('SELECT kind,record FROM memory_records WHERE scope_key=?').all(scopeKey(scope)).map(r=>({...JSON.parse(r.record),recordType:r.kind}));
  }
  knowledgeDirectory(scope) {
    // Navigation over existing derived rows. Admission still checks their
    // revision-bound sources; this read does not scan or rank raw history.
    return this._memoryRecords(scope);
  }
  searchMemory(scope, query='', options={}) {
    textValue(query,'memory query',100000,true);
    const all=this.memorySources(scope),derived=this._memoryRecords(scope),limit=Math.max(1,Math.min(200,Number(options.limit)||12));
    let sources=rank(all,query,{...options,limit});
    const retrievalScores=new Map(sources.map(source=>[source.id,source.retrievalScore]));
    const items=rank(derived.filter(r=>r.recordType==='item'),query,{...options,limit});
    const episodes=rank(derived.filter(r=>r.recordType==='episode'),query,{...options,limit:Math.min(8,limit)});
    // Restore provenance and subsequent evidence for retrieved topics. A later
    // cancellation must accompany an earlier matching invitation when indexed.
    const ids=new Set(sources.map(s=>s.id));
    for(const r of [...items,...episodes])for(const id of r.sourceIds){ids.add(id);retrievalScores.set(id,Math.max(retrievalScores.get(id)||0,r.retrievalScore||0));}
    const topics=[...new Set([...items,...episodes].flatMap(r=>r.topicKeys||[]))];
    const followups=topics.length?rank(all,topics.join(' '),{limit:Math.min(12,limit)}):[];
    for(const s of followups){ids.add(s.id);retrievalScores.set(s.id,Math.max(retrievalScores.get(s.id)||0,s.retrievalScore||0));}
    sources=all.filter(s=>ids.has(s.id)).map(source=>({...source,retrievalScore:retrievalScores.get(source.id)||0})).sort((a,b)=>Date.parse(a.at)-Date.parse(b.at));
    const status=this.memoryStatus(scope);
    return {sources,items,episodes,coverage:{complete:status.pending===0,sourceCount:all.length,retrievedCount:sources.length,pending:status.pending,processed:status.processed,history:this.coverage(scope),retrieval:'lexical-han-bigram-bm25',semanticCertainty:false}};
  }
  memoryBatch(scope,{maxBytes=24000,limit=32}={}) {
    this.maintainLocal(scope);const key=scopeKey(scope),record=this._getCompanion(scope);
    const size=Math.max(4000,Math.min(200000,Number(maxBytes)||24000)),count=Math.max(1,Math.min(64,Number(limit)||32));
    const pending=this.db.prepare("SELECT j.*,s.record FROM memory_journal j JOIN memory_sources s ON s.scope_key=j.scope_key AND s.source_id=j.source_id AND s.revision=j.revision WHERE j.scope_key=? AND j.status='pending' ORDER BY j.seq LIMIT ?").all(key,count);
    if(!pending.length)return null;
    const meta=this.db.prepare('SELECT version FROM memory_meta WHERE scope_key=?').get(key);
    const core={scopeKey:key,baseRevision:record.revision,baseMemoryVersion:meta.version,baseState:{version:record.state.version,focus:record.state.focus.slice(0,500)},sources:[],events:[],priorMemory:{items:[],episodes:[],claims:[],events:[]},contextSources:[],reviewedSourceIds:[],evidenceCoverage:{version:'original-evidence-v1',rule:'journal_progress_is_not_semantic_review'}};
    const bytes=()=>Buffer.byteLength(JSON.stringify(core),'utf8')+150;
    for(const row of pending) {
      const original=JSON.parse(row.record),source={...original,scope:{...scope}},offset=row.cursor||0;
      const event={seq:row.seq,id:row.source_id,revision:row.revision,operation:row.operation,offset};
      core.sources.push(source);core.events.push(event);core.reviewedSourceIds.push(source.id);
      if(offset)source.text=original.text.slice(offset);
      if(bytes()>size) {
        if(core.sources.length>1){core.sources.pop();core.events.pop();core.reviewedSourceIds.pop();break;}
        // The one oversized source is reviewed in durable contiguous text
        // segments. Only the final segment completes its journal entry.
        let low=0,high=source.text.length;
        while(low<high){const mid=Math.ceil((low+high)/2);source.text=original.text.slice(offset,offset+mid);source.segment={offset,end:offset+mid,total:original.text.length};event.end=offset+mid;if(bytes()<=size)low=mid;else high=mid-1;}
        if(low>0&&/[\uD800-\uDBFF]/.test(original.text[offset+low-1]))low--;
        source.text=original.text.slice(offset,offset+low);source.segment={offset,end:offset+low,total:original.text.length};event.end=offset+low;
        if(!low)throw new Error('Memory batch budget cannot fit source metadata');
        break;
      }
      event.end=original.text.length;
      if(offset)source.segment={offset,end:original.text.length,total:original.text.length};
    }
    const prior=this._memoryRecords(scope),query=core.sources.map(s=>s.text.slice(0,300)).join(' ');
    const pinned=prior.filter(r=>r.kind==='commitment'||r.recordType==='episode'||r.reviewComplete===false||r.recordType==='relationship_event'||r.recordType==='claim'&&r.aspect==='boundary').sort((a,b)=>Date.parse(b.lastEvidenceAt)-Date.parse(a.lastEvidenceAt)).slice(0,8);
    const candidates=[...new Map([...pinned,...rank(prior,query,{limit:12})].map(r=>[r.id,r])).values()];
    const originals=new Map(this._rawMemorySources(scope).map(source=>[source.id,source]));
    for(const item of candidates) {
      const target=core.priorMemory[{item:'items',episode:'episodes',claim:'claims',relationship_event:'events'}[item.recordType]];if(!target)continue;
      const roots=sourceClosure(originals,item.sourceIds),needed=roots.filter(source=>!core.sources.some(delivered=>delivered.id===source.id&&!delivered.segment)&&!core.contextSources.some(delivered=>delivered.id===source.id));
      const previousLength=core.contextSources.length;
      core.contextSources.push(...needed.map(source=>({...source,scope:{...scope}})));target.push(item);
      if(bytes()>size){target.pop();core.contextSources.length=previousLength;}
    }
    // A bare 'cancel it' needs the preceding exchange, not lexical topic overlap.
    // Read a bounded window of already-reviewed sources without moving its cursor.
    const anchor=core.sources.filter(s=>!s.deleted).map(s=>s.at).sort()[0];
    if(anchor) {
      const reviewed=new Set(this.db.prepare("SELECT source_id FROM memory_journal WHERE scope_key=? AND status='reviewed'").all(key).map(r=>r.source_id));
      const neighbors=this._rawMemorySources(scope).filter(s=>reviewed.has(s.id)&&s.at<=anchor&&!core.reviewedSourceIds.includes(s.id)).sort((a,b)=>b.at.localeCompare(a.at)).slice(0,6);
      for(const source of neighbors){if(core.contextSources.some(delivered=>delivered.id===source.id))continue;core.contextSources.push({...source,scope:{...scope}});if(bytes()>size)core.contextSources.pop();}
      core.contextSources.sort((a,b)=>a.at.localeCompare(b.at));
    }
    const deliveredIds=new Set([...core.sources,...core.contextSources].filter(source=>!source.deleted).map(source=>source.id));
    for(const row of this.db.prepare('SELECT record FROM memory_pending_proposals WHERE scope_key=? ORDER BY rowid LIMIT 4').all(key)){
      const proposal=JSON.parse(row.record);
      if(!proposal.sourceIds.every(id=>deliveredIds.has(id)))continue;
      core.pendingProposals ||= [];core.pendingProposals.push(proposal);
      if(bytes()>size)core.pendingProposals.pop();
    }
    return {id:hash(core),...core,maxBytes:size,inputBytes:bytes()-150};
  }
  recordMemoryError(scope,error) {
    this.db.prepare('INSERT INTO memory_meta(scope_key,error) VALUES(?,?) ON CONFLICT(scope_key) DO UPDATE SET error=excluded.error').run(scopeKey(scope),JSON.stringify({code:String(error.code||'maintenance_error').slice(0,100),message:String(error.message||'Memory maintenance failed').slice(0,1000),at:new Date().toISOString(),...(error.sourceId?{sourceId:error.sourceId}:{}),...(error.requiredBytes?{requiredBytes:error.requiredBytes}:{})}));
  }
  applyMemoryBatch(scope,batch,result) {
    const reject=(reason,detail)=>({applied:false,reason,...(detail?{detail}:{})});
    try {return this._atomic(()=>{
      const key=scopeKey(scope);this._syncMemory(scope);
      if(!plain(batch)||batch.scopeKey!==key)return reject('wrong_scope');
      const {id,maxBytes,inputBytes,...core}=batch;if(hash(core)!==id)return reject('changed_batch');
      if(this.db.prepare('SELECT 1 FROM memory_receipts WHERE scope_key=? AND batch_id=?').get(key,id))return reject('already_reviewed');
      if(this.db.prepare('SELECT version FROM memory_meta WHERE scope_key=?').get(key)?.version!==batch.baseMemoryVersion)return reject('stale_memory_version');
      if(!plain(result)||Object.keys(result).some(k=>!['reviewedSourceIds','items','episodes','retire','relationshipPatch','originalDelivery'].includes(k)))return reject('unauthorized_result_fields');
      if(!Array.isArray(result.reviewedSourceIds)||new Set(result.reviewedSourceIds).size!==result.reviewedSourceIds.length||result.reviewedSourceIds.length!==batch.reviewedSourceIds.length||result.reviewedSourceIds.some(x=>!batch.reviewedSourceIds.includes(x)))return reject('incomplete_review_receipt');
      const pending=this.db.prepare("SELECT seq,source_id,revision,cursor FROM memory_journal WHERE scope_key=? AND status='pending' ORDER BY seq LIMIT ?").all(key,batch.events.length);
      if(pending.length!==batch.events.length||pending.some((r,i)=>r.seq!==batch.events[i].seq||r.source_id!==batch.events[i].id||r.revision!==batch.events[i].revision||r.cursor!==batch.events[i].offset))return reject('stale_or_noncontiguous_batch');
      const raw=new Map(this._rawMemorySources(scope).map(s=>[s.id,s]));
      const actualDelivery=result.originalDelivery||[...batch.sources,...(batch.contextSources||[])].filter(source=>!source.deleted);
      coverageFor(raw,actualDelivery,scope);
      const allowed=new Set(batch.sources.filter(s=>!s.deleted).map(s=>s.id));
      for(const source of batch.contextSources||[]) {if(raw.get(source.id)?.revision!==source.revision)return reject('stale_context_source');allowed.add(source.id);}
      const previous=new Map([...batch.priorMemory.items,...batch.priorMemory.episodes,...(batch.priorMemory.claims||[]),...(batch.priorMemory.events||[])].map(item=>[item.id,item]));
      for(const item of previous.values())for(const sid of item.sourceIds){if(raw.get(sid)?.revision!==item.sourceRevisions[sid])throw new Error('Stale prior memory source');}
      for(const source of batch.sources)if(!source.deleted&&raw.get(source.id)?.revision!==source.revision)return reject('stale_source');
      const checked=[];const statuses=['active','resolved','cancelled','superseded'];
      const build=(value,type)=>{
        const keys=['id','kind','text','sourceIds','topicKeys','status','certainty','explicitPreference'];
        if(!plain(value)||Object.keys(value).some(k=>!keys.includes(k)))throw new Error('Unauthorized memory fields');
        const sourceIds=sourceList(value.sourceIds);
        if(!sourceIds.length||sourceIds.length>64||sourceIds.some(sid=>!allowed.has(sid)||!raw.has(sid)))throw new Error('Unavailable or undelivered memory evidence');
        if(value.id!==undefined&&!previous.has(value.id))throw new Error('Replacement memory was not delivered');
        if(value.id!==undefined&&previous.get(value.id).recordType!==type)throw new Error('Memory update cannot change record type');
        if(!sourceIds.some(sid=>batch.reviewedSourceIds.includes(sid)))throw new Error('An update needs evidence from this reviewed batch');
        const kind=type==='episode'?'episode':value.kind;
        if(type==='item'&&!['fact','preference','commitment','uncertainty'].includes(kind))throw new Error('Invalid memory kind');
        if(kind==='preference'){if(value.explicitPreference!==true)throw new Error('Stable preferences require explicit recurring intent, not local feedback');assertPreferenceAuthority(raw,sourceIds);}
        const topicKeys=value.topicKeys||[];
        if(!Array.isArray(topicKeys)||topicKeys.length>8||topicKeys.some(t=>typeof t!=='string'||!t.trim()||t.length>80))throw new Error('Invalid memory topic keys');
        const sourceRevisions=Object.fromEntries(sourceIds.map(sid=>[sid,raw.get(sid).revision]));
        const dates=sourceIds.map(sid=>raw.get(sid).at).sort();const status=value.status||'active',certainty=value.certainty||(kind==='uncertainty'?'tentative':'stated');
        if(!statuses.includes(status)||!['stated','tentative'].includes(certainty))throw new Error('Invalid memory status or certainty');
        const older=value.id?previous.get(value.id):null;
        const roots=sourceClosure(raw,[...new Set([...sourceIds,...(older?.sourceIds||[])])]).map(source=>source.id);
        const coverage=requireOriginals(raw,actualDelivery,scope,roots,{complete:!!older});
        const reviewComplete=type==='episode'&&roots.every(id=>coverage.completeSourceIds.includes(id));
        if(older&&dates.at(-1)<older.lastEvidenceAt)throw new Error('Older backfill cannot replace later evidence');
        // Equivalent topic/state keys must not revive a resolved commitment just
        // because its original invitation arrived in a later history page.
        if(kind==='commitment'&&status==='active')for(const p of this._memoryRecords(scope))if(p.kind==='commitment'&&p.status!=='active'&&(p.topicKeys||[]).some(t=>topicKeys.includes(t))&&p.lastEvidenceAt>dates.at(-1))throw new Error('Older backfill cannot revive a later closed commitment');
        return {id:value.id||randomUUID(),kind,text:textValue(value.text,'memory text',type==='episode'?2000:1000),sourceIds,sourceRevisions,topicKeys,status,certainty,reviewComplete,knowledgeSchemaVersion:2,semanticReview:{status:type==='episode'?'navigation_only':'legacy_unreviewed',coverage},firstEvidenceAt:dates[0],lastEvidenceAt:dates.at(-1),at:dates.at(-1),version:(older?.version||0)+1,createdAt:older?.createdAt||new Date().toISOString(),updatedAt:new Date().toISOString(),recordType:type};
      };
      for(const [field,type] of [['items','item'],['episodes','episode']]) {
        if(result[field]!==undefined&&(!Array.isArray(result[field])||result[field].length>(type==='item'?24:6)))throw new Error(`Invalid ${field} count`);
        for(const item of result[field]||[])checked.push(build(item,type));
      }
      if(result.retire!==undefined&&(!Array.isArray(result.retire)||result.retire.length>24))throw new Error('Invalid retire count');
      for(const retirement of result.retire||[]) {
        if(!plain(retirement)||Object.keys(retirement).some(k=>!['id','sourceIds','status'].includes(k))||!previous.has(retirement.id)||!['resolved','cancelled','superseded'].includes(retirement.status))throw new Error('Invalid retirement');
        const old=previous.get(retirement.id);if(!['item','episode'].includes(old.recordType))throw new Error('Typed records require relationshipPatch retirement');checked.push(build({id:old.id,kind:old.kind,text:old.text,sourceIds:[...new Set([...old.sourceIds,...sourceList(retirement.sourceIds)])],topicKeys:old.topicKeys,status:retirement.status,certainty:old.certainty,...(old.kind==='preference'?{explicitPreference:true}:{})},old.recordType));
      }
      if(new Set(checked.map(c=>c.id)).size!==checked.length)throw new Error('Duplicate memory update');
      const relationships=result.relationshipPatch?prepareRelationshipPatch(this,scope,result.relationshipPatch,{sourceIds:[...allowed],sourceRevisions:Object.fromEntries([...raw].map(([id,s])=>[id,s.revision])),previousIds:new Set(previous.keys()),reviewedSourceIds:batch.reviewedSourceIds,deliveredSources:actualDelivery}):[];
      if(relationships.some(record=>checked.some(legacy=>legacy.id===record.id)))throw new Error('One memory record cannot receive competing legacy and typed transition writes');
      for(const item of checked) {
        this.db.prepare('INSERT INTO memory_records VALUES(?,?,?,?) ON CONFLICT(scope_key,id) DO UPDATE SET kind=excluded.kind,record=excluded.record').run(key,item.id,item.recordType,JSON.stringify(item));
        this.db.prepare('DELETE FROM memory_dependencies WHERE scope_key=? AND id=?').run(key,item.id);
        for(const sid of item.sourceIds)this.db.prepare('INSERT INTO memory_dependencies VALUES(?,?,?,?)').run(key,item.id,sid,item.sourceRevisions[sid]);
      }
      const relationshipChanges=writeRelationshipRecords(this,scope,relationships);
      for(const proposal of batch.pendingProposals||[])this.db.prepare('DELETE FROM memory_pending_proposals WHERE scope_key=? AND id=?').run(key,proposal.id);
      for(const event of batch.events) {
        const length=raw.get(event.id)?.text.length||0;
        this.db.prepare("UPDATE memory_journal SET status=?,cursor=? WHERE seq=? AND scope_key=? AND status='pending'").run(event.end>=length?'reviewed':'pending',event.end,event.seq,key);
      }
      const receipt={batchId:id,reviewedSourceIds:batch.reviewedSourceIds,sourceRevisions:Object.fromEntries(batch.events.map(e=>[e.id,e.revision])),seqFrom:batch.events[0].seq,seqTo:batch.events.at(-1).seq,segments:batch.events.map(e=>({sourceId:e.id,offset:e.offset,end:e.end})),originalCoverage:coverageFor(raw,actualDelivery,scope,{requiredSourceIds:actualDelivery.map(source=>source.id)}),reviewedAt:new Date().toISOString(),outcome:checked.length||relationshipChanges?'updated':'reviewed_no_change',updates:checked.length+relationshipChanges};
      this.db.prepare('INSERT INTO memory_receipts VALUES(?,?,?)').run(key,id,JSON.stringify(receipt));
      this.db.prepare('UPDATE memory_meta SET version=version+1,error=NULL WHERE scope_key=?').run(key);
      return {applied:true,receipt};
    });}catch(error){return reject('invalid_memory_result',error.message);}
  }
  updateTurn(scope,id,text) {
    return this._atomic(()=>{
      identifier(id,'turn id');textValue(text,'turn text');const record=this._getCompanion(scope),turn=record.turns.find(t=>t.id===id&&t.role==='user');
      if(!turn)return false;if(turn.text===text)return turn;
      turn.text=text;turn.version=(turn.version||1)+1;turn.updatedAt=new Date().toISOString();changedSource(record,true);this._writeCompanion(scope,record);return turn;
    });
  }
  ignoredSources(scope) {return this.db.prepare('SELECT source_id FROM memory_exclusions WHERE scope_key=?').all(scopeKey(scope)).map(r=>r.source_id);}
  forgetSource(scope,id) {
    sourceList([id]);
    if(id.startsWith('note:'))return this.deleteNote(scope,id.slice(5));
    if(id.startsWith('private:feedback-')) {
      return this._atomic(()=>{const record=this._getCompanion(scope);if(!record.feedback.some(f=>`private:feedback-${f.id}`===id))return false;this.experiences.invalidateSources(scope,[id],{mode:'forget'});record.turns=record.turns.filter(t=>!(t.feedbackId&&`private:feedback-${t.feedbackId}`===id)&&this.experiences.canonicalSource(scope,`private:${t.id}`)!==id);changedSource(record,true);this._writeCompanion(scope,record);return true;});
    }
    if(id.startsWith('private:'))return this.deleteTurn(scope,id.slice(8));
    if(!this._rawMemorySources(scope).some(s=>s.id===id))return false;
    return this._atomic(()=>{this.db.prepare('INSERT OR IGNORE INTO memory_exclusions VALUES(?,?)').run(scopeKey(scope),id);const record=this._getCompanion(scope);changedSource(record,true);this._writeCompanion(scope,record);return true;});
  }
  markTurnControl(scope,id) {
    return this._atomic(()=>{
      const record=this._getCompanion(scope),turn=record.turns.find(t=>t.id===id&&t.role==='user');if(!turn)return false;
      turn.memoryExcluded=true;changedSource(record,true);this._writeCompanion(scope,record);return true;
    });
  }
  setPendingActions(scope,items) {
    return this._atomic(()=>{
      if(!Array.isArray(items)||items.length>20||items.some(x=>!plain(x)))throw new Error('Invalid pending actions');
      const record=this._getCompanion(scope);record.pendingActions=JSON.parse(JSON.stringify(items));this._writeCompanion(scope,record);return record.pendingActions;
    });
  }
  savePendingAction(scope,action) {
    return this._atomic(()=>{
      if(!plain(action))throw new Error('Invalid pending action');const record=this._getCompanion(scope),saved={...JSON.parse(JSON.stringify(action)),id:action.id||randomUUID()};identifier(saved.id);
      record.pendingActions=[...record.pendingActions.filter(a=>a.id!==saved.id),saved].slice(-20);this._writeCompanion(scope,record);return saved;
    });
  }
  resolvePendingAction(scope,id) {
    return this._atomic(()=>{
      const record=this._getCompanion(scope),before=record.pendingActions.length;record.pendingActions=record.pendingActions.filter(a=>a.id!==id);this._writeCompanion(scope,record);return before!==record.pendingActions.length;
    });
  }
  recordActionReceipt(scope,receipt) {
    return this._atomic(()=>{
      if(!plain(receipt))throw new Error('Invalid action receipt');const record=this._getCompanion(scope),saved={...JSON.parse(JSON.stringify(receipt)),id:receipt.id||randomUUID(),at:new Date().toISOString()};
      record.actionReceipts=[...record.actionReceipts.filter(r=>r.id!==saved.id),saved].slice(-100);this._writeCompanion(scope,record);return saved;
    });
  }
  messages(scope) {
    if (!scope) return [];
    return this.db.prepare('SELECT record FROM messages WHERE account_uid=? AND peer_uid=?')
      .all(scope.accountUid, scope.peerUid).map(row => JSON.parse(row.record))
      .filter(record => sameScope(record, scope)).sort(compare);
  }
  historyPage(scope, { before, limit = 100 } = {}) {
    const records = this.messages(scope);
    const count = Math.max(1, Math.min(200, Number(limit) || 100));
    const end = before ? records.findIndex(m=>m.messageId===before) : records.length;
    if(end<0) throw new Error('消息游标不属于当前会话，请重新加载');
    const start = Math.max(0,end-count);
    return {scope,messages:records.slice(start,end).map(publicRecord),total:records.length,hasOlder:start>0};
  }
  setCoverage(scope, coverage) {
    this.db.prepare('INSERT INTO coverage VALUES(?,?,?) ON CONFLICT(account_uid,peer_uid) DO UPDATE SET record=excluded.record')
      .run(scope.accountUid, scope.peerUid, JSON.stringify(coverage));
  }
  coverage(scope) {
    return JSON.parse(this.db.prepare('SELECT record FROM coverage WHERE account_uid=? AND peer_uid=?')
      .get(scope.accountUid, scope.peerUid)?.record || '{"status":"not_loaded","pages":0}');
  }
  export(scope, format) {
    if (!scope) throw new Error('No selected conversation');
    const messages = this.messages(scope);
    const coverage = this.coverage(scope);
    const exportedAt = new Date().toISOString();
    if (format === 'json') return { mime: 'application/json; charset=utf-8', extension: 'json',
      data: JSON.stringify({ schemaVersion: 1, scope, exportedAt, coverage, messages:messages.map(publicRecord) }, null, 2) };
    if (format !== 'txt') throw new Error('Unsupported export format');
    return { mime: 'text/plain; charset=utf-8', extension: 'txt', data: [
      `QQ ${scope.accountUin} ↔ ${scope.peerUin}`, `导出时间：${exportedAt}`,
      `范围：${coverage.status}，${messages.length} 条，${coverage.pages || 0} 页；不保证包含 QQ 服务器全部历史。`, '',
      ...messages.map(m => `[${new Date(m.timestamp).toISOString()}] ${m.direction === 'outgoing' ? '我' : '对方'} (ID ${m.messageId})\n${m.text}`)
    ].join('\n\n') };
  }
  close() { this.db.close(); }
}
module.exports = { Store, normalizeResponseRecovery, normalizeMetadataReviewPending, sourceRevision };
