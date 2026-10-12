'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const {publicRecord}=require('./media.cjs');
const { compare, sameScope } = require('./messages.cjs');
class Store {
  constructor(filename) {
    if (filename !== ':memory:') fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    if (filename !== ':memory:') fs.chmodSync(filename, 0o600);
    this.db.exec(`CREATE TABLE IF NOT EXISTS messages(
      account_uid TEXT NOT NULL, peer_uid TEXT NOT NULL, message_id TEXT NOT NULL, record TEXT NOT NULL,
      PRIMARY KEY(account_uid,peer_uid,message_id));
      CREATE TABLE IF NOT EXISTS coverage(account_uid TEXT NOT NULL,peer_uid TEXT NOT NULL,record TEXT NOT NULL,
      PRIMARY KEY(account_uid,peer_uid));`);
    this.insert = this.db.prepare(`INSERT INTO messages VALUES(?,?,?,?)
      ON CONFLICT(account_uid,peer_uid,message_id) DO UPDATE SET record=excluded.record`);
  }
  add(scope, records) {
    let changes = 0;
    this.db.exec('BEGIN');
    try {
      for (const message of records) {
        if (!sameScope(message, scope) || message.kind !== 'actual') throw new Error('Message scope or provenance rejected');
        const data = JSON.stringify(message);
        const old = this.db.prepare('SELECT record FROM messages WHERE account_uid=? AND peer_uid=? AND message_id=?')
          .get(scope.accountUid, scope.peerUid, message.messageId);
        if (old?.record === data) continue;
        this.insert.run(scope.accountUid, scope.peerUid, message.messageId, data);
        changes++;
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return changes;
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
