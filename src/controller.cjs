'use strict';
const { EventEmitter } = require('node:events');
const { normalize, sameScope, compare } = require('./messages.cjs');
const {readImage,publicRecord}=require('./media.cjs');
const { generate, replyFocusFor } = require('./model.cjs');
const { randomUUID } = require('node:crypto');
const { assistModel, parseAssistant } = require('./assistant-model.cjs');
const { buildContext, buildDraftContext } = require('./assistant-context.cjs');
class Controller extends EventEmitter {
  constructor({ store, read, settings, model = generate, assistantModel = assistModel }) {
    super(); Object.assign(this, { store, read, settings, model, assistantModel });
    this.status = { phase: 'waiting_qq', account: null };
    this.selectedImages=[];this.replyMessageIds=[];this.features={qqDraftFill:false};
    this.scope = null; this.epoch = 0; this.revision = 0; this.advice = null;
    this.busy = false; this.historyBusy = false; this.error = ''; this.instruction = settings.instruction || '自然一点，贴近我的说话方式';
    this.visible = true; this.auto = settings.auto === true; this.modelReady = !!(settings.apiKey || settings.anonymous); this.abort = null; this.timer = null;
    this.assistantAbort = null; this.assistantBusy = false; this.assistantError = '';
  }
  updateStatus(status) {
    if (status.account?.uid !== this.status.account?.uid || status.phase !== 'ready') {
      this.invalidateAssistant();
      this.epoch++; this.selectedImages=[]; this.replyMessageIds=[]; this.scope = null; this.advice = null; this.busy = false;
      this.abort?.abort(); clearTimeout(this.timer);
    }
    this.status = status; this.changed();
  }
  changed() { this.emit('change', this.snapshot()); }
  hasModelConsent() { const c=this.settings.realChatConsent;return !!(this.scope && c && c.accountUid===this.scope.accountUid && c.peerUin===this.scope.peerUin && c.baseUrl===this.settings.baseUrl && c.model===this.settings.model); }
  snapshot() {
    const messages = this.store.messages(this.scope);
    return { status: this.status, scope: this.scope, revision: this.revision,
      messages: messages.slice(-100).map(publicRecord), total: messages.length,
      coverage: this.scope ? this.store.coverage(this.scope) : null,
      advice: this.advice, busy: this.busy, historyBusy: this.historyBusy, error: this.error,
      companion: this.scope ? this.store.getCompanion(this.scope) : null,
      assistantBusy: this.assistantBusy, assistantError: this.assistantError,
      activeModelProfileId: this.settings.activeModelProfileId, replyFocus: replyFocusFor(messages, this.replyMessageIds),
      instruction: this.instruction, auto: this.auto, model: this.settings.model, modelReady: this.modelReady, modelConsent:this.hasModelConsent(), modelBaseUrl:this.settings.baseUrl || '',imageSelection:this.selectedImages,modelVisionEnabled:!!this.settings.visionEnabled,imageConsent:!!(this.hasModelConsent()&&this.settings.realChatConsent?.allowImages),qqDraftFillAvailable:!!this.features.qqDraftFill };
  }
  async bind(uin) {
    this.invalidateAssistant();
    const epoch = ++this.epoch;
    this.selectedImages=[];this.replyMessageIds=[];this.scope = null; this.advice = null; this.error = ''; this.busy = false;
    this.abort?.abort(); clearTimeout(this.timer); this.changed();
    const result = await this.read('bind', { accountUid: this.status.account?.uid, uin: String(uin) });
    if (epoch !== this.epoch) return;
    this.scope = result; this.revision++; this.changed();
    await this.loadLatest(epoch);
    if (epoch === this.epoch) {
      if(this.store.coverage(this.scope).cursor)this.loadOlder(20).catch(error => { if (epoch === this.epoch) { this.error = error.message; this.changed(); } });
      if (this.auto) this.schedule();
    }
  }
  ingest(scope, raw) {
    if (!sameScope(scope, this.scope)) return 0;
    const normalized = raw.map(m => normalize(m, scope)).filter(Boolean);
    const count = this.store.add(scope, normalized);
    if (count) { this.invalidateAssistant(); this.revision++; this.changed(); }
    return count;
  }
  live(event) {
    if (this.ingest(event.scope, event.messages) && this.auto) this.schedule();
  }
  async loadLatest(epoch = this.epoch) {
    const scope = this.scope;
    const task = this.historyTask = Symbol('latest');
    this.historyEpoch = epoch; this.historyBusy = true;
    this.store.setCoverage(scope, {...this.store.coverage(scope),status:'loading'}); this.changed();
    try {
      const result = await this.read('latest', { scope });
      if (epoch !== this.epoch || !sameScope(scope, this.scope)) return;
      this.ingest(scope, result.messages);
      const messages = result.messages.map(m => normalize(m, scope)).filter(Boolean).sort(compare);
      const cached = this.store.messages(scope);
      this.store.setCoverage(scope, { status: messages.length ? 'partial' : cached.length ? 'cached_only' : 'empty',
        pages: 1, cursor: messages[0]?.messageId || null, oldestAt: cached[0]?.timestamp || null,
        checkedAt: new Date().toISOString(), source: result.source });
      this.error = ''; this.changed();
    } catch (error) {
      if(epoch===this.epoch && sameScope(scope,this.scope)) {
        this.error=error.message;
        this.store.setCoverage(scope,{...this.store.coverage(scope),status:'read_error',error:error.message});this.changed();
      }
      throw error;
    } finally {
      if(this.historyTask===task){this.historyBusy=false;this.changed();}
    }
  }
  async loadOlder(limit = 100) {
    if (!this.scope || (this.historyBusy && this.historyEpoch === this.epoch)) return;
    const scope = this.scope, epoch = this.epoch;
    const historyTask = this.historyTask = Symbol('history'); this.historyEpoch = epoch;
    this.historyBusy = true; this.changed();
    try {
      let coverage = this.store.coverage(scope);
      for (let page = 0; page < limit && coverage.cursor; page++) {
        const result = await this.read('older', { scope, cursor: coverage.cursor });
        if (epoch !== this.epoch || !sameScope(scope, this.scope)) return;
        const valid = result.messages.map(m => normalize(m, scope)).filter(Boolean).sort(compare);
        const older = valid.filter(m => BigInt(m.messageId) < BigInt(coverage.cursor));
        this.ingest(scope, result.messages);
        if (!older.length) { coverage = { ...coverage, status: 'accessible_end', checkedAt: new Date().toISOString() };
          this.store.setCoverage(scope, coverage); break; }
        coverage = { ...coverage, status: 'partial', cursor: older[0].messageId,
          oldestAt: older[0].timestamp, pages: coverage.pages + 1, checkedAt: new Date().toISOString() };
        this.store.setCoverage(scope, coverage); this.changed();
      }
    } catch (error) {
      if (epoch === this.epoch) { this.store.setCoverage(scope, { ...this.store.coverage(scope), status: 'read_error', error: error.message });
        this.error = error.message; }
    } finally {
      if (this.historyTask === historyTask) { this.historyBusy = false; this.changed();
        if (this.auto && epoch === this.epoch) this.schedule(); }
    }
  }
  configure({ instruction, auto, images, replyMessageIds }) {
    if (replyMessageIds !== undefined) {
      const selected = replyFocusFor(this.store.messages(this.scope), replyMessageIds);
      const nextIds = selected.mode === 'selected' ? selected.messageIds : [];
      if (JSON.stringify(nextIds) !== JSON.stringify(this.replyMessageIds)) {
        this.invalidateAssistant();
        this.replyMessageIds = nextIds; this.abort?.abort(); this.advice = null; clearTimeout(this.timer);
      }
    }
    if (typeof instruction === 'string' && instruction.slice(0,2000)!==this.instruction) { this.invalidateAssistant(); this.instruction = instruction.slice(0, 2000); this.abort?.abort(); this.advice = null; }
    this.settings.instruction = this.instruction;
    if(Array.isArray(images)) {
      const selected=images.slice(0,3).filter(i=>typeof i.messageId==='string'&&/^\d+$/.test(i.messageId)&&Number.isInteger(i.index));
      if(JSON.stringify(selected)!==JSON.stringify(this.selectedImages)){this.selectedImages=selected;this.abort?.abort();this.advice=null;}
    }
    if (typeof auto === 'boolean') {this.auto = auto;this.settings.auto=auto;}
    if (!this.auto) clearTimeout(this.timer);
    this.changed();
  }
  modelChanged() {
    this.invalidateAssistant();
    this.abort?.abort(); this.abort = null; clearTimeout(this.timer);
    this.advice = null; this.busy = false; this.error = ''; this.selectedImages = [];
    this.modelReady = !!(this.settings.baseUrl && this.settings.model && (this.settings.apiKey || this.settings.anonymous));
    this.changed();
  }
  setVisible(visible) { this.visible=visible;if(!visible){this.invalidateAssistant();clearTimeout(this.timer);this.abort?.abort();}else if(this.auto && this.scope)this.schedule(); }
  schedule() { if(!this.visible)return;if(!this.hasModelConsent())return; clearTimeout(this.timer); this.timer = setTimeout(() => this.suggest().catch(() => {}), 1800); this.timer.unref?.(); }
  async suggest() {
    if (!this.scope) throw new Error('请先选择一个 QQ 私聊');
    if(!this.hasModelConsent()) { this.error='需要先允许当前会话使用配置的模型；聊天记录目前只保存在本机';this.changed();throw new Error(this.error); }
    if(this.selectedImages.length && (!this.settings.visionEnabled || !this.settings.realChatConsent?.allowImages))throw new Error('所选图片需要启用视觉模型并明确允许图片发送');
    const scope = this.scope, epoch = this.epoch, revision = this.revision, instruction = this.instruction;
    this.abort?.abort(); const abort = this.abort = new AbortController();
    const records = this.store.messages(scope);
    if (!records.length) return this.assist({ text: this.instruction, purpose: 'discussion' });
    this.busy = true; this.error = ''; this.changed();
    try {
      const images=this.selectedImages.map(item=>{const record=records.find(m=>m.messageId===item.messageId);const image=readImage(record,item.index);return {url:`data:${image.type};base64,${image.data.toString('base64')}`,at:new Date(record.timestamp).toISOString(),speaker:record.direction==='outgoing'?'我':'对方',messageId:record.messageId}});
      const result = await this.model({...this.settings}, records, instruction, abort.signal, undefined, {images,replyMessageIds:[...this.replyMessageIds]});
      if (epoch !== this.epoch || revision !== this.revision || instruction !== this.instruction || abort.signal.aborted ||
          !sameScope(scope, this.scope)) return;
      this.advice = { ...result, scope, revision, createdAt: new Date().toISOString() };
    } catch (error) { if (!abort.signal.aborted && epoch === this.epoch) this.error = error.message; }
    finally { if (this.abort === abort) { this.busy = false; this.changed(); } }
  }
  requireScope() { if (!this.scope) throw new Error('请先选择一个 QQ 私聊'); return this.scope; }
  invalidateAssistant() {
    this.assistantAbort?.abort(); this.assistantAbort = null;
    this.assistantBusy = false; this.assistantError = '';
  }
  changedContext() {
    this.invalidateAssistant(); this.abort?.abort(); this.advice = null; clearTimeout(this.timer); this.changed();
  }
  setGoal(text) { const result = this.store.setGoal(this.requireScope(), text); this.changedContext(); return result; }
  saveNote(args) { const result = this.store.saveNote(this.requireScope(), args); this.changedContext(); return result; }
  deleteNote(id) { const result = this.store.deleteNote(this.requireScope(), id); this.changedContext(); return result; }
  deleteTurn(id) { const result = this.store.deleteTurn(this.requireScope(), id); this.changedContext(); return result; }
  addFeedback(args) {
    const scope = this.requireScope();
    const feedback = this.store.addFeedback(scope, args);
    this.store.appendTurn(scope, { role: 'user', kind: 'feedback', text: `对助手建议的反馈：${feedback.text}`, requestId: feedback.requestId });
    this.changedContext(); return feedback;
  }
  assistantContext() {
    const scope = this.requireScope(), companion = this.store.getCompanion(scope);
    return { scope, run: companion.runs.at(-1) || null };
  }
  async assist({ text, purpose = 'discussion', materialIds = [] } = {}) {
    const scope = this.requireScope();
    if (!this.hasModelConsent()) throw new Error('请先允许当前会话使用配置的模型；私下资料与聊天记录目前仅在本机');
    if (typeof text !== 'string' || !text.trim() || text.length > 16000) throw new Error('请输入这次想商量或表达的内容（最多 16000 字）');
    if (!['discussion', 'draft', 'review'].includes(purpose)) throw new Error('未知的帮助用途');
    this.invalidateAssistant();
    const abort = this.assistantAbort = new AbortController(), requestId = randomUUID();
    const turn = this.store.appendTurn(scope, { role: 'user', kind: purpose, text, requestId });
    const companion = this.store.getCompanion(scope), epoch = this.epoch, revision = this.revision;
    const settings = { ...this.settings }, baseRevision = companion.revision;
    const binding = `${settings.baseUrl}\n${settings.model}\n${settings.activeModelProfileId || ''}`;
    const current = () => this.assistantAbort === abort && !abort.signal.aborted && epoch === this.epoch && revision === this.revision &&
      sameScope(scope, this.scope) && this.hasModelConsent() &&
      binding === `${this.settings.baseUrl}\n${this.settings.model}\n${this.settings.activeModelProfileId || ''}` &&
      this.store.getCompanion(scope).revision === baseRevision;
    this.assistantBusy = true; this.assistantError = ''; this.changed();
    let context;
    try {
      const records = this.store.messages(scope), coverage = this.store.coverage(scope);
      context = buildContext({ scope, records, companion, turn, purpose: purpose === 'draft' ? 'draft_prepare' : purpose,
        materialIds, coverage, requestId, byteBudget: settings.assistantContextBytes || 48000 });
      this.store.saveRun(scope, { id: requestId, baseRevision, purpose: context.payload.purpose,
        status: 'pending', payload: context.payload, manifest: context.manifest });
      let result = parseAssistant(await this.assistantModel(settings, context, abort.signal), context.payload.purpose);
      if (!current()) return;
      let reviewed = context;
      if (result.draftPlan?.clarification) {
        result = { kind: 'question', text: result.draftPlan.clarification };
      } else if (result.draftPlan) {
        context = buildDraftContext(context, result.draftPlan, { scope, requestId, companion, coverage });
        this.store.saveRun(scope, { id: requestId, baseRevision, purpose: 'draft', status: 'pending', payload: context.payload, manifest: context.manifest });
        result = parseAssistant(await this.assistantModel(settings, context, abort.signal), 'draft');
        if (!current()) return;
        reviewed = null; // A restricted draft is not a review of the private state.
      } else if (purpose === 'draft') throw new Error('模型未明确拟表达内容，请具体说明想告诉她哪件事');
      let patchReceipt = null;
      if (reviewed && result.kind !== 'question') {
        patchReceipt = this.store.applyState(scope, result.statePatch || {}, { baseRevision,
          baseStateVersion: companion.state.version, sourceIds: reviewed.manifest.sourceIds,
          coverage: { complete: reviewed.manifest.completeReview, sourceIds: reviewed.manifest.sourceIds } });
      }
      if (!current()) return;
      const reply = this.store.appendTurn(scope, { role: 'assistant', kind: result.kind, text: result.text,
        requestId, suggestions: result.suggestions, sourceIds: context.manifest.sourceIds });
      this.store.saveRun(scope, { id: requestId, baseRevision, purpose: context.payload.purpose, status: 'complete',
        payload: context.payload, manifest: context.manifest, replyId: reply.id,
        patchReceipt, maintenance: reviewed ? (patchReceipt?.applied ? (result.statePatch ? 'applied' : 'reviewed_no_change') : 'rejected') : 'deferred' });
      return reply;
    } catch (error) {
      if (current()) {
        this.assistantError = error.message;
        if (context) this.store.saveRun(scope, { id: requestId, baseRevision, purpose: context.payload.purpose,
          status: 'failed', payload: context.payload, manifest: context.manifest, error: error.message, maintenance: 'failed' });
        throw error;
      }
    } finally {
      if (this.assistantAbort === abort) { this.assistantBusy = false; this.assistantAbort = null; this.changed(); }
    }
  }
  close() { this.invalidateAssistant(); clearTimeout(this.timer); this.abort?.abort(); }
}
module.exports = { Controller };
