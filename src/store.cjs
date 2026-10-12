'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const {publicRecord}=require('./media.cjs');
const { compare, sameScope } = require('./messages.cjs');
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
function emptyState(version = 0) {
  return { version, focus: '', items: [], openThreads: [], unknowns: [], possiblyStale: true, coverage: { complete: false, sourceIds: [] } };
}
function emptyCompanion() { return { revision: 0, goal: { text: '', version: 0 }, notes: [], turns: [], state: emptyState(), runs: [], feedback: [] }; }
function changedSource(record, invalidate = false) {
  record.revision++;
  if (invalidate) {
    // Deletion/correction must also remove verbatim private copies in generated payloads.
    record.state = emptyState(record.state.version + 1);
    record.runs = [];
    record.turns = record.turns.filter(turn => turn.role === 'user');
    record.feedback = [];
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
    this.db.exec(`PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS messages(
      account_uid TEXT NOT NULL, peer_uid TEXT NOT NULL, message_id TEXT NOT NULL, record TEXT NOT NULL,
      PRIMARY KEY(account_uid,peer_uid,message_id));
      CREATE TABLE IF NOT EXISTS coverage(account_uid TEXT NOT NULL,peer_uid TEXT NOT NULL,record TEXT NOT NULL,
      PRIMARY KEY(account_uid,peer_uid));
      CREATE TABLE IF NOT EXISTS companion(scope_key TEXT PRIMARY KEY,record TEXT NOT NULL);`);
    this.insert = this.db.prepare(`INSERT INTO messages VALUES(?,?,?,?)
      ON CONFLICT(account_uid,peer_uid,message_id) DO UPDATE SET record=excluded.record`);
  }
  add(scope, records) {
    scopeKey(scope);
    let changes = 0;
    let invalidates = false;
    this.db.exec('BEGIN');
    try {
      for (const message of records) {
        if (!sameScope(message, scope) || message.kind !== 'actual') throw new Error('Message scope or provenance rejected');
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
        if (old) invalidates = true;
        this.insert.run(scope.accountUid, scope.peerUid, message.messageId, data);
        changes++;
      }
      if (changes) {
        const companion = this.getCompanion(scope);
        changedSource(companion, invalidates);
        this._writeCompanion(scope, companion);
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return changes;
  }
  getCompanion(scope) {
    const row = this.db.prepare('SELECT record FROM companion WHERE scope_key=?').get(scopeKey(scope));
    return row ? JSON.parse(row.record) : emptyCompanion();
  }
  _writeCompanion(scope, record) {
    this.db.prepare('INSERT INTO companion VALUES(?,?) ON CONFLICT(scope_key) DO UPDATE SET record=excluded.record')
      .run(scopeKey(scope), JSON.stringify(record));
  }
  _sourceIds(scope, record = this.getCompanion(scope)) {
    return new Set([
      ...this.messages(scope).filter(message => message.kind === 'actual' && !message.recalled).map(message => `qq:${message.messageId}`),
      ...record.turns.filter(turn => turn.role === 'user').map(turn => `private:${turn.id}`),
      ...record.notes.filter(note => note.use !== 'disabled').map(note => `note:${note.id}`)
    ]);
  }
  setGoal(scope, text) {
    textValue(text, 'goal', 10000, true);
    const record = this.getCompanion(scope);
    if (record.goal.text !== text) {
      record.goal = { text, version: record.goal.version + 1 };
      changedSource(record, true); this._writeCompanion(scope, record);
    }
    return record.goal;
  }
  saveNote(scope, note) {
    if (!plain(note)) throw new Error('Invalid note');
    textValue(note.text, 'note text');
    if (!['discussion', 'draft', 'disabled'].includes(note.use)) throw new Error('Invalid note use');
    const record = this.getCompanion(scope);
    const id = note.id === undefined ? randomUUID() : identifier(note.id, 'note id');
    const index = record.notes.findIndex(item => item.id === id), old = record.notes[index];
    if (old && old.text === note.text && old.use === note.use) return old;
    const now = new Date().toISOString();
    const saved = { id, text: note.text, use: note.use, version: (old?.version || 0) + 1, createdAt: old?.createdAt || now, updatedAt: now };
    if (index < 0) record.notes.push(saved); else record.notes[index] = saved;
    changedSource(record, !!old); this._writeCompanion(scope, record);
    return saved;
  }
  deleteNote(scope, id) {
    identifier(id, 'note id'); const record = this.getCompanion(scope);
    const index = record.notes.findIndex(note => note.id === id);
    if (index < 0) return false;
    record.notes.splice(index, 1); changedSource(record, true); this._writeCompanion(scope, record); return true;
  }
  appendTurn(scope, turn) {
    if (!plain(turn) || !['user', 'assistant'].includes(turn.role)) throw new Error('Invalid private turn role');
    textValue(turn.text, 'turn text', 100000, turn.role === 'assistant');
    textValue(turn.kind, 'turn kind', 100);
    const record = this.getCompanion(scope);
    const id = turn.id === undefined ? randomUUID() : identifier(turn.id, 'turn id');
    if (record.turns.some(item => item.id === id)) throw new Error('Private turn id already exists');
    const saved = { id, role: turn.role, kind: turn.kind, text: turn.text, createdAt: new Date().toISOString() };
    if (turn.requestId !== undefined) saved.requestId = identifier(turn.requestId, 'request id');
    if (turn.sourceIds !== undefined) {
      saved.sourceIds = sourceList(turn.sourceIds);
      const live = this._sourceIds(scope, record);
      if (saved.sourceIds.some(source => !live.has(source))) throw new Error('Invalid private turn source');
    }
    if (turn.suggestions !== undefined) {
      if (!Array.isArray(turn.suggestions)) throw new Error('Invalid suggestions');
      saved.suggestions = JSON.parse(JSON.stringify(turn.suggestions));
    }
    record.turns.push(saved);
    if (turn.role === 'user') changedSource(record);
    this._writeCompanion(scope, record); return saved;
  }
  deleteTurn(scope, id) {
    identifier(id, 'turn id'); const record = this.getCompanion(scope);
    const index = record.turns.findIndex(turn => turn.id === id);
    if (index < 0) return false;
    const [turn] = record.turns.splice(index, 1);
    // Even an assistant turn can have been copied into a subsequent generated run.
    if (turn.role === 'user') changedSource(record, true);
    else { record.runs = []; record.feedback = []; }
    this._writeCompanion(scope, record); return true;
  }
  saveRun(scope, run) {
    if (!plain(run)) throw new Error('Invalid run');
    const record = this.getCompanion(scope), saved = JSON.parse(JSON.stringify(run));
    saved.id = saved.id === undefined ? randomUUID() : identifier(saved.id, 'run id');
    if (saved.requestId !== undefined) identifier(saved.requestId, 'request id');
    if (saved.baseRevision !== undefined && saved.baseRevision !== record.revision) throw new Error('Stale run revision');
    const previous = record.runs.find(item => item.id === saved.id), now = new Date().toISOString();
    saved.createdAt = previous?.createdAt || now; saved.updatedAt = now;
    record.runs = [...record.runs.filter(item => item.id !== saved.id), saved].slice(-12);
    this._writeCompanion(scope, record); return saved;
  }
  addFeedback(scope, feedback) {
    if (!plain(feedback)) throw new Error('Invalid feedback');
    const saved = { id: randomUUID(), requestId: identifier(feedback.requestId, 'request id'), text: textValue(feedback.text, 'feedback text'), kind: textValue(feedback.kind || 'local', 'feedback kind', 100), createdAt: new Date().toISOString() };
    const record = this.getCompanion(scope);
    const bound = record.runs.some(run => run.requestId === saved.requestId || run.id === saved.requestId) || record.turns.some(turn => turn.role === 'assistant' && turn.requestId === saved.requestId);
    if (!bound) throw new Error('Invalid feedback request: no matching run or assistant response in this conversation');
    record.feedback.push(saved); changedSource(record); this._writeCompanion(scope, record); return saved;
  }
  applyState(scope, patch, options = {}) {
    const record = this.getCompanion(scope);
    const rejected = (reason, detail) => ({ applied: false, reason, ...(detail ? { detail } : {}), revision: record.revision, stateVersion: record.state.version });
    if (!Number.isSafeInteger(options.baseRevision) || options.baseRevision !== record.revision) return rejected('stale_revision');
    if (options.baseStateVersion !== undefined && options.baseStateVersion !== record.state.version) return rejected('stale_state_version');
    try {
      if (!plain(patch) || Object.keys(patch).some(key => !['focus', 'items', 'openThreads', 'unknowns'].includes(key))) throw new Error('State patch has unauthorized fields');
      const allowed = sourceList(options.sourceIds || []), live = this._sourceIds(scope, record), allowedSet = new Set(allowed);
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
          const checked = { text: textValue(item.text, `state ${key} text`, 1000), sourceIds: ids };
          if (item.status !== undefined) checked.status = textValue(item.status, 'open thread status', 100);
          return checked;
        });
      }
      if (patch.unknowns !== undefined) {
        if (!Array.isArray(patch.unknowns) || patch.unknowns.length > 12) throw new Error('Invalid state unknowns: expected an array with at most 12 entries');
        next.unknowns = patch.unknowns.map(value => textValue(value, 'state unknown', 1000));
      }
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
          AND json_extract(companion.record,'$.state.version')=?`)
        .run(scopeKey(scope), JSON.stringify(record), record.revision, next.version - 1);
      if (!committed.changes) {
        const current = this.getCompanion(scope);
        return { applied: false, reason: current.revision === record.revision ? 'stale_state_version' : 'stale_revision', revision: current.revision, stateVersion: current.state.version };
      }
      return { applied: true, revision: record.revision, stateVersion: next.version };
    } catch (error) { return rejected('invalid_patch', error.message); }
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
module.exports = { Store };
