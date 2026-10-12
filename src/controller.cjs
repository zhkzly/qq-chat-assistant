'use strict';
const { EventEmitter } = require('node:events');
const { normalize, sameScope, compare } = require('./messages.cjs');
const {readImage,publicRecord}=require('./media.cjs');
const { generate, replyFocusFor } = require('./model.cjs');
const { randomUUID } = require('node:crypto');
const { assistModel, parseAssistant } = require('./assistant-model.cjs');
const { buildContext, buildDraftContext, expressionOptionsFor } = require('./assistant-context.cjs');
const { maintainMemory: runMemoryMaintenance } = require('./memory-engine.cjs');
const { applyUserActions, confirmUserAction, undoUserAction } = require('./assistant-actions.cjs');
const { methodFor } = require('./help-methods.cjs');
class Controller extends EventEmitter {
  constructor({ store, read, settings, model = generate, assistantModel = assistModel, memoryModel = null }) {
    super(); Object.assign(this, { store, read, settings, model, assistantModel, memoryModel });
    this.status = { phase: 'waiting_qq', account: null };
    this.selectedImages=[];this.replyMessageIds=[];this.features={qqDraftFill:false};
    this.scope = null; this.epoch = 0; this.revision = 0; this.advice = null;
    this.busy = false; this.historyBusy = false; this.error = ''; this.instruction = settings.instruction || '自然一点，贴近我的说话方式';
    this.visible = true; this.auto = settings.auto === true; this.modelReady = !!(settings.apiKey || settings.anonymous); this.abort = null; this.timer = null;
    this.assistantAbort = null; this.assistantBusy = false; this.assistantError = '';
    this.memoryAbort = null; this.memoryTimer = null; this.memoryBusy = false; this.memoryRetryAfter = 0; this.memoryFailures=0;
    this.activeAssist=null;this.pendingAssist=null;this.assistantRetryTimer=null;
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
      memoryStatus: this.scope && this.store.memoryStatus ? { ...this.store.memoryStatus(this.scope), busy: this.memoryBusy } : null,
      activeModelProfileId: this.settings.activeModelProfileId, replyFocus: replyFocusFor(messages, this.replyMessageIds),
      instruction: this.instruction, auto: this.auto, model: this.settings.model, modelReady: this.modelReady, modelConsent:this.hasModelConsent(), modelBaseUrl:this.settings.baseUrl || '',imageSelection:this.selectedImages,modelVisionEnabled:!!this.settings.visionEnabled,imageConsent:!!(this.hasModelConsent()&&this.settings.realChatConsent?.allowImages),qqDraftFillAvailable:!!this.features.qqDraftFill };
  }
  async bind(uin) {
    this.invalidateAssistant();
    this.memoryFailures=0;this.memoryRetryAfter=0;
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
      this.scheduleMemory();
    }
  }
  ingest(scope, raw) {
    if (!sameScope(scope, this.scope)) return 0;
    const normalized = raw.map(m => normalize(m, scope)).filter(Boolean);
    const count = this.store.add(scope, normalized);
    if (count) {
      const pending=this.activeAssist||this.pendingAssist;
      this.invalidateAssistant(); this.revision++; this.changed(); this.scheduleMemory(15000);
      if(pending&&pending.resumes<2&&sameScope(pending.scope,this.scope)){
        this.pendingAssist=pending;
        this.assistantRetryTimer=setTimeout(()=>{
          const retry=this.pendingAssist;this.pendingAssist=null;
          if(retry&&sameScope(retry.scope,this.scope)&&this.visible)this.assist({...retry.args,resumeTurnId:retry.turnId,resumes:retry.resumes+1}).catch(()=>{});
        },1800);this.assistantRetryTimer.unref?.();
      }
    }
    return count;
  }
  live(event) {
    if (this.ingest(event.scope, event.messages) && this.auto && !this.pendingAssist && this.store.messages(this.scope).at(-1)?.direction==='incoming') this.schedule();
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
        if (this.auto && epoch === this.epoch) this.schedule(); this.scheduleMemory(); }
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
      if(JSON.stringify(selected)!==JSON.stringify(this.selectedImages)){this.invalidateAssistant();this.selectedImages=selected;this.abort?.abort();this.advice=null;}
    }
    if (typeof auto === 'boolean') {this.auto = auto;this.settings.auto=auto;}
    if (!this.auto) clearTimeout(this.timer);
    this.changed();
  }
  modelChanged() {
    this.invalidateAssistant();
    this.memoryFailures=0;this.memoryRetryAfter=0;
    this.abort?.abort(); this.abort = null; clearTimeout(this.timer);
    this.advice = null; this.busy = false; this.error = ''; this.selectedImages = [];
    this.modelReady = !!(this.settings.baseUrl && this.settings.model && (this.settings.apiKey || this.settings.anonymous));
    this.changed();
  }
  setVisible(visible) { this.visible=visible;if(!visible){this.invalidateAssistant();clearTimeout(this.timer);this.abort?.abort();}else { if(this.auto && this.scope)this.schedule(); this.scheduleMemory(); } }
  schedule() { if(!this.visible)return;if(!this.hasModelConsent())return; clearTimeout(this.timer); this.timer = setTimeout(() => this.suggest().catch(() => {}), 1800); this.timer.unref?.(); }
  async suggest() {
    const scope = this.requireScope(), epoch = this.epoch;
    this.busy = true; this.error = ''; this.changed();
    try {
      const reply = await this.assist({ text: this.instruction, purpose: 'reply', transient: true });
      if (!reply || epoch !== this.epoch || !sameScope(scope,this.scope)) return;
      this.advice = { analysis: reply.text, suggestions: reply.suggestions || [], scope,
        revision: this.revision, createdAt: new Date().toISOString(), requestId: reply.requestId };
    } catch (error) { if(epoch===this.epoch){this.error=error.message;this.changed();} throw error; }
    finally { if(epoch===this.epoch){this.busy=false;this.changed();} }
  }
  requireScope() { if (!this.scope) throw new Error('请先选择一个 QQ 私聊'); return this.scope; }
  invalidateAssistant() {
    clearTimeout(this.assistantRetryTimer);this.activeAssist=null;this.pendingAssist=null;
    this.memoryAbort?.abort(); this.memoryAbort = null; this.memoryBusy = false; clearTimeout(this.memoryTimer);
    this.assistantAbort?.abort(); this.assistantAbort = null;
    this.assistantBusy = false; this.assistantError = '';
  }
  changedContext() {
    this.invalidateAssistant(); this.abort?.abort(); this.advice = null; clearTimeout(this.timer); this.changed(); this.scheduleMemory();
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
  confirmAction(id, decision) {
    const scope=this.requireScope(), pending=this.store.getCompanion(scope).pendingActions.find(a=>a.id===id);
    if(!pending)throw new Error('待确认事项已不存在');
    const receipt=confirmUserAction(this.store,scope,pending,decision);
    if(receipt?.type==='forget'&&receipt.status==='applied') {
      const commandId=receipt.evidenceSourceId?.replace(/^private:/,'');
      if(commandId)this.store.markTurnControl(scope,commandId);
      this.store.recordActionReceipt(scope,{...receipt,evidenceQuote:'用户明确要求不再使用此来源'});
    }
    this.changedContext();return receipt;
  }
  undoAction(id) {
    const scope=this.requireScope(), receipt=this.store.getCompanion(scope).actionReceipts.find(a=>a.id===id);
    if(!receipt)throw new Error('修改记录已不存在');
    const result=undoUserAction(this.store,scope,receipt);this.changedContext();return result;
  }
  searchMemory(query,options={}) { return this.store.searchMemory(this.requireScope(),query,options); }
  scheduleMemory(delay=1800) {
    clearTimeout(this.memoryTimer);
    if(!this.memoryModel||!this.scope||!this.visible||!this.hasModelConsent()||this.historyBusy||this.assistantBusy||this.memoryBusy||this.memoryFailures>=3)return;
    this.memoryTimer=setTimeout(()=>this.maintainMemory({maxBatches:2}).catch(()=>{}),Math.max(delay,this.memoryRetryAfter-Date.now()));this.memoryTimer.unref?.();
  }
  async maintainMemory({maxBatches=2,force=false}={}) {
    const scope=this.requireScope();
    if(force){this.memoryFailures=0;this.memoryRetryAfter=0;}
    if(!this.memoryModel)return {status:'not_configured',...this.store.memoryStatus(scope)};
    if(!this.hasModelConsent())throw new Error('当前会话未允许这个模型整理记忆');
    if(this.assistantBusy||this.memoryBusy||(!force&&!this.visible))return {status:'deferred',...this.store.memoryStatus(scope)};
    const epoch=this.epoch, settings={...this.settings}, abort=this.memoryAbort=new AbortController();
    this.memoryBusy=true;this.changed();
    const active=()=>this.memoryAbort===abort&&!abort.signal.aborted&&this.epoch===epoch&&sameScope(scope,this.scope)&&this.hasModelConsent()&&this.settings.baseUrl===settings.baseUrl&&this.settings.model===settings.model;
    try {
      const result=await runMemoryMaintenance({store:this.store,scope,settings,model:this.memoryModel,signal:abort.signal,maxBatches,
        shouldContinue:active,onProgress:()=>{if(active())this.changed();}});
      if(result.batches){this.memoryFailures=0;this.memoryRetryAfter=0;}
      if(['error','rejected','blocked'].includes(result.status)){this.memoryFailures++;this.memoryRetryAfter=Date.now()+Math.min(300000,60000*this.memoryFailures);}
      return result;
    } finally {
      if(this.memoryAbort===abort){this.memoryBusy=false;this.memoryAbort=null;this.changed();if(this.store.memoryStatus(scope).pending)this.scheduleMemory(2500);}
    }
  }
  async assist({ text, purpose = 'discussion', materialIds = [], sourceTurnIds = [], selectedOption, transient = false, resumeTurnId, resumes=0 } = {}) {
    const scope = this.requireScope();
    if (!this.hasModelConsent()) throw new Error('请先允许当前会话使用配置的模型；私下资料与聊天记录目前仅在本机');
    if (typeof text !== 'string' || !text.trim() || text.length > 16000) throw new Error('请输入这次想商量或表达的内容（最多 16000 字）');
    if (!['discussion', 'draft', 'review','reply'].includes(purpose)) throw new Error('未知的帮助用途');
    if(!Array.isArray(sourceTurnIds)||sourceTurnIds.length>8||sourceTurnIds.some(id=>typeof id!=='string'))throw new Error('参考的私下讨论不合法');
    if(selectedOption&&(!Number.isInteger(selectedOption.index)||typeof selectedOption.turnId!=='string'))throw new Error('表达方向不合法');
    if(this.selectedImages.length&&(!this.settings.visionEnabled||!this.settings.realChatConsent?.allowImages))throw new Error('所选图片需要启用视觉模型并明确允许图片发送');
    this.invalidateAssistant();
    const abort = this.assistantAbort = new AbortController(), requestId = randomUUID();
    const prior=resumeTurnId&&this.store.getCompanion(scope).turns.find(t=>t.id===resumeTurnId&&t.role==='user'&&t.text===text);
    if(resumeTurnId&&!prior&&!transient)throw new Error('原来的问题已变化，请使用当前问题');
    let turn = transient ? {id:requestId,role:'user',kind:purpose,text,transient:true} : prior||this.store.appendTurn(scope, { role: 'user', kind: purpose, text, requestId });
    this.activeAssist={scope,turnId:turn.id,resumes,args:{text,purpose,materialIds,sourceTurnIds,selectedOption,transient}};
    let companion = this.store.getCompanion(scope), baseRevision = companion.revision;
    const epoch = this.epoch, revision = this.revision, settings = { ...this.settings };
    const binding = `${settings.baseUrl}\n${settings.model}\n${settings.activeModelProfileId || ''}`;
    const current = () => this.assistantAbort === abort && !abort.signal.aborted && epoch === this.epoch && revision === this.revision &&
      sameScope(scope, this.scope) && this.hasModelConsent() &&
      binding === `${this.settings.baseUrl}\n${this.settings.model}\n${this.settings.activeModelProfileId || ''}` &&
      this.store.getCompanion(scope).revision === baseRevision;
    this.assistantBusy = true; this.assistantError = ''; this.changed();
    let context, receipts=[], actionsHandled=false, lookups=0, lookupHistory=[], retrievedSources=[], query=text, reviewRange;
    const capturedRequests=[];
    try {
      const records = this.store.messages(scope), coverage = this.store.coverage(scope);
      const images=this.selectedImages.map(item=>{
        if(!this.store.memorySources(scope).some(s=>s.id===`qq:${item.messageId}`))throw new Error('所选图片来源已撤回或不再用于助手，请重新选择');
        const record=records.find(m=>m.messageId===item.messageId);const image=readImage(record,item.index);
        return {url:`data:${image.type};base64,${image.data.toString('base64')}`,messageId:record.messageId,index:item.index,bytes:image.data.length};
      });
      const assemble=()=>{
        companion=this.store.getCompanion(scope);
        const availableSources=this.store.memorySources(scope);
        const memoryResult=this.store.searchMemory(scope,query,{limit:16,...reviewRange});
        const index=this.store.searchMemory(scope,'',{limit:24});
        const input=buildContext({ scope, records, companion, turn, purpose: purpose === 'draft' ? 'draft_prepare' : purpose,
          materialIds, coverage, requestId, byteBudget: settings.assistantContextBytes || 48000,availableSources,memoryResult,
          memoryIndex:[...index.items,...index.episodes],retrievedSources,sourceTurnIds,selectedOption,replyMessageIds:[...this.replyMessageIds],
          actionReceipts:receipts,lookupHistory,reviewRange });
        input.images=images.filter(image=>availableSources.some(s=>s.id===`qq:${image.messageId}`));input.manifest.images=input.images.map(({url,...metadata})=>metadata);return input;
      };
      const invoke=async(input)=>{
        this.store.saveRun(scope,{id:requestId,baseRevision,purpose:input.payload.purpose,status:'pending',payload:input.payload,manifest:input.manifest});
        const result=parseAssistant(await this.assistantModel(settings,input,abort.signal),input.payload.purpose);
        capturedRequests.push({purpose:input.payload.purpose,manifest:input.manifest,payload:input.payload});
        if(input.extraRequests)capturedRequests.push(...input.extraRequests);
        return result;
      };
      let result;
      for(let pass=0;pass<5;pass++) {
        context=assemble();result=await invoke(context);if(!current())return;
        if(result.lookup){
          if(lookups>=2){result={kind:'question',text:'已经查过相关历史，但仍缺少能确认这件事的依据。你可以指出具体那次交流，或者我们先根据目前确定的信息讨论。'};break;}
          const found=this.store.searchMemory(scope,result.lookup.query,{limit:24,before:result.lookup.before,after:result.lookup.after,types:result.lookup.types});
          retrievedSources=[...new Map([...retrievedSources,...found.sources].map(source=>[source.id,source])).values()];
          lookupHistory.push({query:result.lookup.query,found:found.sources.length,coverage:found.coverage});query=result.lookup.query;
          reviewRange={before:result.lookup.before,after:result.lookup.after,types:result.lookup.types};lookups++;continue;
        }
        if(result.actions?.length&&!actionsHandled&&!transient){
          const applied=applyUserActions(this.store,scope,result.actions,{turn,baseRevision});
          receipts=[...applied.receipts,...applied.pendingActions.map(p=>({status:'pending',id:p.id,type:p.action.type,preview:p.preview,reason:p.reason}))];actionsHandled=true;
          const forgotten=receipts.filter(r=>r.status==='applied'&&r.type==='forget');
          if(forgotten.length){
            this.store.markTurnControl(scope,turn.id);
            for(const receipt of forgotten)this.store.recordActionReceipt(scope,{...receipt,evidenceQuote:'用户明确要求不再使用此来源'});
            turn={...turn,memoryExcluded:true,text:'所选来源已从助手参考中移除。请简短确认，不复述已移除内容。'};
            capturedRequests.length=0;
            receipts=forgotten.map(({undo,...r})=>({...r,evidenceQuote:'用户明确要求不再使用此来源'}));
          }
          baseRevision=this.store.getCompanion(scope).revision;
          continue;
        }
        break;
      }
      if(!result||result.lookup)throw new Error('本次信息整理未能完成，请重试；原始输入已保存');
      let reviewed=context;
      if(result.draftPlan?.clarification) result={...result,kind:'question',text:result.draftPlan.clarification};
      else if(result.draftPlan){
        const allowedImages=context.images;
        context=buildDraftContext(context,result.draftPlan,{scope,requestId,companion,coverage});context.images=allowedImages;
        result=await invoke(context);if(!current())return;reviewed=null;
      } else if(purpose==='draft')throw new Error('模型尚未明确拟表达内容，请继续说明或选择一个方向');
      let patchReceipt=null;
      if(reviewed&&result.kind!=='question'&&(result.statePatch||result.stateReview==='no_change')) {
        patchReceipt=this.store.applyState(scope,result.statePatch||{},{baseRevision,baseStateVersion:companion.state.version,
          sourceIds:reviewed.manifest.sourceIds,coverage:{complete:reviewed.manifest.completeReview,sourceIds:reviewed.manifest.sourceIds}});
      }
      if(!current())return;
      let expressionOptions=[];
      try{expressionOptions=expressionOptionsFor(context,result.expressionOptions||[]);}catch(error){receipts.push({status:'rejected',reason:error.message});}
      const methodIds=(result.methodIds||[]).filter(id=>methodFor(id));
      const reply=this.store.appendTurn(scope,{role:'assistant',kind:result.kind,text:result.text,requestId,suggestions:result.suggestions,
        sourceIds:context.manifest.sourceIds,expressionOptions,methodIds,actionReceipts:receipts});
      if(purpose==='reply')this.advice={analysis:reply.text,suggestions:reply.suggestions||[],scope,revision:this.revision,createdAt:new Date().toISOString(),requestId};
      this.store.saveRun(scope,{id:requestId,baseRevision,purpose:context.payload.purpose,status:'complete',payload:context.payload,manifest:context.manifest,
        requests:capturedRequests,replyId:reply.id,patchReceipt,actionReceipts:receipts,
        maintenance:patchReceipt?.applied?(result.statePatch?'applied':'reviewed_no_change'):patchReceipt?'rejected':'deferred'});
      return reply;
    } catch(error) {
      if(current()){
        this.assistantError=error.message;
        if(context)this.store.saveRun(scope,{id:requestId,baseRevision,purpose:context.payload.purpose,status:'failed',payload:context.payload,manifest:context.manifest,error:error.message,maintenance:'failed'});
        throw error;
      }
    } finally {
      if(this.assistantAbort===abort){this.activeAssist=null;this.assistantBusy=false;this.assistantAbort=null;this.changed();this.scheduleMemory();}
    }
  }
  close() { this.invalidateAssistant(); clearTimeout(this.timer); clearTimeout(this.memoryTimer); this.abort?.abort(); }
}
module.exports = { Controller };
