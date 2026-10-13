'use strict';
const { EventEmitter } = require('node:events');
const { normalize, sameScope, compare } = require('./messages.cjs');
const {readImage,publicRecord}=require('./media.cjs');
const { generate, replyFocusFor } = require('./model.cjs');
const { randomUUID, createHash } = require('node:crypto');
const {TaskLedger}=require('./request-budget.cjs');
const {maintenanceDecision}=require('./memory-scheduler.cjs');
const fingerprint=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const { assistModel, parseAssistant } = require('./assistant-model.cjs');
const { buildContext, buildDraftContext, expressionOptionsFor, PROMPT_VERSION } = require('./assistant-context.cjs');
const { planDiscussionCompaction, assistDiscussionCompaction } = require('./discussion-compaction.cjs');
const { discussionTopicBinding, discussionModelBinding, DISCUSSION_COMPACTION_VERSION } = require('./discussion-compaction-store.cjs');
const { normalizeResponseRecovery } = require('./store.cjs');
const { maintainMemory: runMemoryMaintenance } = require('./memory-engine.cjs');
const { applyUserActions, confirmUserAction, undoUserAction } = require('./assistant-actions.cjs');
const { methodFor } = require('./help-methods.cjs');
class Controller extends EventEmitter {
  constructor({ store, read, settings, model = generate, assistantModel = assistModel, memoryModel = null, compactionModel = assistDiscussionCompaction }) {
    super(); Object.assign(this, { store, read, settings, model, assistantModel, memoryModel, compactionModel });
    this.status = { phase: 'waiting_qq', account: null };
    this.selectedImages=[];this.replyMessageIds=[];this.features={qqDraftFill:false};
    this.scope = null; this.epoch = 0; this.revision = 0; this.advice = null;
    this.busy = false; this.historyBusy = false; this.error = ''; this.instruction = settings.instruction || '自然一点，贴近我的说话方式';
    this.visible = true; this.auto = settings.auto === true; this.modelReady = !!(settings.apiKey || settings.anonymous); this.abort = null; this.timer = null;
    this.assistantAbort = null; this.assistantBusy = false; this.assistantError = '';
    this.memoryAbort = null; this.memoryTimer = null; this.memoryBusy = false; this.memoryRetryAfter = 0; this.memoryFailures=0;
    this.activeAssist=null;this.pendingAssist=null;this.assistantRetryTimer=null;
    this.usage=new TaskLedger(store);this.memoryLastActivityAt=0;this.memoryDraining=false;this.lastAutomaticFingerprint='';
    this.feedbackContinuations=new Map();
    this.discussionCompaction=null;
  }
  updateStatus(status) {
    if (status.account?.uid !== this.status.account?.uid || status.phase !== 'ready') {
      this.invalidateAssistant();
      this.epoch++; this.selectedImages=[]; this.replyMessageIds=[]; this.scope = null; this.advice = null; this.busy = false;
      this.discussionCompaction=null;
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
      relationship:this.scope&&this.store.relationshipView?this.store.relationshipView(this.scope,{limit:24}):null,
      experience:this.scope&&this.store.experiences?this.store.experiences.list(this.scope,{limit:8}):null,
      topicContext:this.scope&&this.store.topicView?this.store.topicView(this.scope):null,
      discussionCompaction:this.scope&&sameScope(this.discussionCompaction?.scope,this.scope)?this.discussionCompaction:null,
      requestUsage:this.scope?this.usage.recent(this.scope,8):[],maintenanceSchedule:this.scope?this.memorySchedule():null,
      activeModelProfileId: this.settings.activeModelProfileId, replyFocus: replyFocusFor(messages, this.replyMessageIds),
      instruction: this.instruction, auto: this.auto, model: this.settings.model, modelReady: this.modelReady, modelConsent:this.hasModelConsent(), modelBaseUrl:this.settings.baseUrl || '',imageSelection:this.selectedImages,modelVisionEnabled:!!this.settings.visionEnabled,imageConsent:!!(this.hasModelConsent()&&this.settings.realChatConsent?.allowImages),qqDraftFillAvailable:!!this.features.qqDraftFill };
  }
  async bind(uin) {
    this.invalidateAssistant();
    this.discussionCompaction=null;
    this.memoryFailures=0;this.memoryRetryAfter=0;this.memoryDraining=false;this.memoryLastActivityAt=0;
    const epoch = ++this.epoch;
    this.selectedImages=[];this.replyMessageIds=[];this.scope = null; this.advice = null; this.error = ''; this.busy = false;
    this.abort?.abort(); clearTimeout(this.timer); this.changed();
    const result = await this.read('bind', { accountUid: this.status.account?.uid, uin: String(uin) });
    if (epoch !== this.epoch) return;
    this.scope = result;this.store.maintainLocal?.(this.scope); this.revision++; this.changed();
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
      this.memoryLastActivityAt=Date.now();this.invalidateAssistant({preserveTask:!!pending}); this.revision++; this.changed(); this.scheduleMemory(15000);
      if(pending&&pending.resumes<2&&sameScope(pending.scope,this.scope)){
        this.pendingAssist=pending;
        this.assistantRetryTimer=setTimeout(()=>{
          const retry=this.pendingAssist;this.pendingAssist=null;
          if(retry&&sameScope(retry.scope,this.scope)&&this.visible)this.assist({...retry.args,taskId:retry.taskId,resumeTurnId:retry.turnId,resumes:retry.resumes+1}).catch(()=>{});
        },1800);this.assistantRetryTimer.unref?.();
      } else if(pending) {
        this.assistantError='新消息持续到达，这次思考已停止。你的问题已保留，可等对话稳定后继续。';
        this.usage.finish(scope,pending.taskId,'failed','conversation_keeps_changing');this.changed();
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
  schedule() { if(!this.visible||this.assistantBusy||this.pendingAssist)return;if(!this.hasModelConsent())return; clearTimeout(this.timer); this.timer = setTimeout(() => this.suggest({automatic:true}).catch(() => {}), 1800); this.timer.unref?.(); }
  automaticFingerprint(){return fingerprint({scope:this.scope,revision:this.revision,generation:this.store.contextGeneration?.(this.scope),model:this.settings.model,baseUrl:this.settings.baseUrl,instruction:this.instruction,images:this.selectedImages,focus:this.replyMessageIds});}
  async suggest({automatic=false}={}) {
    const scope = this.requireScope(), epoch = this.epoch;
    if(automatic&&this.lastAutomaticFingerprint===this.automaticFingerprint())return this.advice;
    this.busy = true; this.error = ''; this.changed();
    try {
      const reply = await this.assist({ text: this.instruction, purpose: 'reply', transient: true, origin:automatic?'automatic':'user' });
      if (!reply || epoch !== this.epoch || !sameScope(scope,this.scope)) return;
      this.advice = { analysis: reply.text, suggestions: reply.suggestions || [], scope,
        revision: this.revision, createdAt: new Date().toISOString(), requestId: reply.requestId };
      if(automatic)this.lastAutomaticFingerprint=this.automaticFingerprint();
    } catch (error) { if(epoch===this.epoch){this.error=error.message;this.changed();} throw error; }
    finally { if(epoch===this.epoch){this.busy=false;this.changed();} }
  }
  requireScope() { if (!this.scope) throw new Error('请先选择一个 QQ 私聊'); return this.scope; }
  invalidateAssistant({preserveTask=false}={}) {
    this.discussionCompaction=null;
    const old=this.activeAssist||this.pendingAssist;if(!preserveTask&&old?.taskId){try{this.usage.finish(old.scope,old.taskId,'cancelled')}catch{}}
    clearTimeout(this.assistantRetryTimer);this.activeAssist=null;this.pendingAssist=null;
    this.memoryAbort?.abort(); this.memoryAbort = null; this.memoryBusy = false; clearTimeout(this.memoryTimer);
    this.assistantAbort?.abort(); this.assistantAbort = null;
    this.assistantBusy = false; this.assistantError = '';
  }
  changedContext() {
    this.memoryLastActivityAt=Date.now();this.invalidateAssistant(); this.abort?.abort(); this.advice = null; clearTimeout(this.timer); this.changed(); this.scheduleMemory();
  }
  setGoal(text) { const result = this.store.setGoal(this.requireScope(), text); this.changedContext(); return result; }
  saveNote(args) { const result = this.store.saveNote(this.requireScope(), args); this.changedContext(); return result; }
  deleteNote(id) { const scope=this.requireScope(),result = this.store.deleteNote(scope, id);this.usage.redactInputs(scope); this.changedContext(); return result; }
  deleteTurn(id) { const scope=this.requireScope(),result = this.store.deleteTurn(scope, id);this.usage.redactInputs(scope); this.changedContext(); return result; }
  addFeedback(args) {
    const scope = this.requireScope();
    const feedback = this.store.addFeedback(scope, args);
    this.changedContext(); return feedback;
  }
  async continueFeedback(args) {
    const scope={...this.requireScope()};
    if(typeof args.taskId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(args.taskId)||typeof args.clientEventId!=='string'||!args.clientEventId)
      throw new Error('请使用当前反馈的请求标识继续商量');
    const key=`${this.store.scopeKey(scope)}:${args.taskId}`;
    const signature=fingerprint({scope,text:args.text,requestId:args.requestId,targetRef:args.targetRef,clientEventId:args.clientEventId});
    const inFlight=this.feedbackContinuations.get(key);
    if(inFlight){if(inFlight.signature!==signature)throw new Error('同一继续请求包含不同反馈内容');return inFlight.promise;}
    const run=async()=>{
      const oldTask=this.usage.db.prepare('SELECT scope_key FROM assistant_tasks WHERE id=?').get(args.taskId);
      if(oldTask&&oldTask.scope_key!==this.store.scopeKey(scope))throw new Error('继续请求不属于当前会话');
      const feedback=this.store.addFeedback(scope,args);
      if(!this.store.memorySources(scope).some(source=>source.id===feedback.sourceId))throw new Error('这条反馈的来源已删除，请基于当前内容重新反馈');
      const reference=this.store.getCompanion(scope).turns.find(turn=>turn.kind==='feedback_ref'&&turn.feedbackId===feedback.id);
      if(!reference)throw new Error('反馈已保存，但缺少可继续参考的对象');
      // An HTTP retry must not cancel the original request or turn the same
      // local feedback into another independent factual source.
      let existing=null;try{existing=this.usage.get(scope,args.taskId)}catch(error){if(error.code!=='task_scope_mismatch')throw error;}
      if(!existing)this.changedContext();
      const continuation={scope,feedbackId:feedback.id,turnId:reference.id,taskId:args.taskId,status:'in_progress'};
      try {
        const result=await this.assist({text:'结合我选中的这条反馈，继续商量并给出相应帮助。',purpose:'discussion',
          sourceTurnIds:[reference.id],taskId:args.taskId,origin:'feedback',feedbackIntentId:feedback.id,privateKind:'feedback_continue'});
        const task=this.usage.get(scope,args.taskId);
        continuation.status=task.status==='complete'?'complete':task.status==='running'?'in_progress':'failed';
        if(continuation.status==='failed')continuation.error=this.assistantError||'本次结果已失效，反馈仍保存在当前会话。';
      }catch(error){
        continuation.status=error.code==='task_already_exists'&&this.usage.get(scope,args.taskId).status==='running'?'in_progress':'failed';
        continuation.error=error.message;
      }
      return {...this.snapshot(),feedbackContinuation:continuation};
    };
    const entry={signature,promise:null};this.feedbackContinuations.set(key,entry);
    entry.promise=run().finally(()=>{if(this.feedbackContinuations.get(key)===entry)this.feedbackContinuations.delete(key)});
    return entry.promise;
  }
  experienceAction(operation,args) {
    const scope=this.requireScope(),engine=this.store.experiences;
    if(!engine)throw new Error('经验记录尚未就绪');
    const methods={interaction:'recordInteraction',link:'confirmLink',review:'review',adaptation:'adapt'};
    if(!methods[operation])throw new Error('未知的经历操作');
    const result=engine[methods[operation]](scope,args);
    if(operation==='interaction')this.changed();else this.changedContext();
    return {scope,...result};
  }
  claimAction(args){
    const result=this.store.correctRelationshipClaim(this.requireScope(),args);
    if(!result.applied){const error=new Error(`这条理解未修改，请核对当前内容后重试：${result.detail||result.reason||'claim_unavailable'}`);error.code=result.reason||'claim_unavailable';throw error;}
    this.changedContext();return result;
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
  memorySchedule() {
    if(!this.scope)return {reason:'no_contact',pending:0,ready:false,nextAt:null};
    const status=this.store.memorySchedulingStatus?this.store.memorySchedulingStatus(this.scope):this.store.memoryStatus(this.scope);
    // Unprocessed private sources have timestamps even before scheduler metadata is migrated.
    if(!status.lastEventAt&&!status.oldestPendingAt){const sources=this.store.memorySources(this.scope);status.lastEventAt=sources.map(source=>source.at).filter(Boolean).sort().at(-1);}
    return maintenanceDecision(status,this.settings,{lastActivityAt:this.memoryLastActivityAt,draining:this.memoryDraining,...this.usage.maintenanceWindow(this.scope)});
  }
  scheduleMemory(delay=1800) {
    clearTimeout(this.memoryTimer);
    if(!this.memoryModel||!this.scope||!this.visible||!this.hasModelConsent()||this.historyBusy||this.assistantBusy||this.memoryBusy||this.memoryFailures>=3)return;
    const decision=this.memorySchedule();if(!decision.pending)return;
    const wait=Math.max(delay,this.memoryRetryAfter-Date.now(),(decision.nextAt||Date.now())-Date.now());
    this.memoryTimer=setTimeout(()=>{
      const next=this.memorySchedule();
      if(!next.ready){this.scheduleMemory();return;}
      this.memoryDraining=true;this.maintainMemory({maxBatches:1}).catch(()=>{});
    },Math.max(1,wait));this.memoryTimer.unref?.();
  }
  async maintainMemory({maxBatches=1,force=false}={}) {
    const scope=this.requireScope();
    if(force){this.memoryFailures=0;this.memoryRetryAfter=0;}
    if(!this.memoryModel)return {status:'not_configured',...this.store.memoryStatus(scope)};
    if(!this.hasModelConsent())throw new Error('当前会话未允许这个模型整理记忆');
    if(this.assistantBusy||this.memoryBusy||(!force&&!this.visible))return {status:'deferred',...this.store.memoryStatus(scope)};
    this.store.maintainLocal?.(scope);
    if(!this.store.memoryStatus(scope).pending)return {status:'complete',...this.store.memoryStatus(scope)};
    const schedule=this.memorySchedule(),remaining=schedule.windowLimit-schedule.requestsInWindow;
    if(!force&&remaining<=0)return {status:'deferred',...this.store.memoryStatus(scope)};
    const budget=this.usage.create(scope,{inputDigest:fingerprint({origin:'maintenance',at:Date.now(),scope}),origin:'maintenance',limit:Math.min(Math.max(2,Math.min(6,maxBatches*2)),force?6:remaining)});
    const epoch=this.epoch, settings={...this.settings,requestBudget:budget.forStage('memory_maintenance')}, abort=this.memoryAbort=new AbortController();
    this.memoryBusy=true;this.changed();
    const active=()=>this.memoryAbort===abort&&!abort.signal.aborted&&this.epoch===epoch&&sameScope(scope,this.scope)&&this.hasModelConsent()&&this.settings.baseUrl===settings.baseUrl&&this.settings.model===settings.model;
    try {
      const result=await runMemoryMaintenance({store:this.store,scope,settings,model:this.memoryModel,signal:abort.signal,maxBatches,
        shouldContinue:active,onProgress:()=>{if(active())this.changed();}});
      if(result.batches){this.memoryFailures=0;this.memoryRetryAfter=0;}
      if(['error','rejected','blocked'].includes(result.status)){this.memoryFailures++;this.memoryRetryAfter=Date.now()+Math.min(300000,60000*this.memoryFailures);}
      this.usage.finish(scope,budget.id,result.status==='stopped'?'cancelled':['error','rejected','blocked'].includes(result.status)?'failed':'complete');
      return result;
    } catch(error) {
      this.usage.finish(scope,budget.id,abort.signal.aborted?'cancelled':'failed',error.code||'maintenance_failed');
      throw error;
    } finally {
      if(!this.store.memoryStatus(scope).pending)this.memoryDraining=false;
      if(this.memoryAbort===abort){this.memoryBusy=false;this.memoryAbort=null;this.changed();if(this.store.memoryStatus(scope).pending)this.scheduleMemory(2500);}
    }
  }
  async assist({ text, purpose = 'discussion', materialIds = [], sourceTurnIds = [], selectedOption, transient = false, resumeTurnId, resumes=0, taskId, origin='user',feedbackIntentId,privateKind } = {}) {
    const scope = this.requireScope();
    if (!this.hasModelConsent()) throw new Error('请先允许当前会话使用配置的模型；私下资料与聊天记录目前仅在本机');
    if (typeof text !== 'string' || !text.trim() || text.length > 16000) throw new Error('请输入这次想商量或表达的内容（最多 16000 字）');
    if (!['discussion', 'draft', 'review','reply'].includes(purpose)) throw new Error('未知的帮助用途');
    if(!Array.isArray(sourceTurnIds)||sourceTurnIds.length>8||sourceTurnIds.some(id=>typeof id!=='string'))throw new Error('参考的私下讨论不合法');
    if(selectedOption&&(!Number.isInteger(selectedOption.index)||typeof selectedOption.turnId!=='string'))throw new Error('表达方向不合法');
    if(this.selectedImages.length&&(!this.settings.visionEnabled||!this.settings.realChatConsent?.allowImages))throw new Error('所选图片需要启用视觉模型并明确允许图片发送');
    const budget=resumes>0&&taskId?this.usage.resume(scope,taskId):this.usage.create(scope,{id:taskId,
      inputDigest:fingerprint({text,purpose,materialIds,sourceTurnIds,selectedOption,feedbackIntentId,scope,model:this.settings.model,baseUrl:this.settings.baseUrl}),origin,limit:Number(this.settings.assistantRequestLimit)||4});
    if(budget.reused&&!resumes){
      const previous=this.usage.get(scope,budget.id);
      if(previous.status==='complete')return this.store.getCompanion(scope).turns.find(turn=>turn.role==='assistant'&&turn.requestId===budget.id)||null;
      const error=new Error(previous.status==='running'?'这次请求仍在进行，请等待结果。':'这次请求已经结束；如需重新尝试，请重新提交。');error.code='task_already_exists';throw error;
    }
    this.invalidateAssistant({preserveTask:resumes>0});
    this.memoryLastActivityAt=Date.now();this.store.maintainLocal?.(scope);
    const abort = this.assistantAbort = new AbortController(), requestId = budget.id;
    clearTimeout(this.timer);
    const prior=resumeTurnId&&this.store.getCompanion(scope).turns.find(t=>t.id===resumeTurnId&&t.role==='user'&&t.text===text);
    if(resumeTurnId&&!prior&&!transient)throw new Error('原来的问题已变化，请使用当前问题');
    let turn = transient ? {id:requestId,role:'user',kind:purpose,text,transient:true} : prior||this.store.appendTurn(scope, { role: 'user', kind: privateKind||purpose, text, requestId });
    this.activeAssist={scope,turnId:turn.id,taskId:budget.id,resumes,args:{text,purpose,materialIds,sourceTurnIds,selectedOption,transient,origin,feedbackIntentId,privateKind}};
    let companion = this.store.getCompanion(scope), baseRevision = companion.revision,baseGeneration=this.store.contextGeneration?.(scope);
    const epoch = this.epoch, revision = this.revision, settings = { ...this.settings };
    const binding = `${settings.baseUrl}\n${settings.model}\n${settings.activeModelProfileId || ''}`;
    const current = () => this.assistantAbort === abort && !abort.signal.aborted && epoch === this.epoch && revision === this.revision &&
      sameScope(scope, this.scope) && this.hasModelConsent() &&
      binding === `${this.settings.baseUrl}\n${this.settings.model}\n${this.settings.activeModelProfileId || ''}` &&
      this.store.getCompanion(scope).revision === baseRevision && (!this.store.contextGeneration||this.store.contextGeneration(scope)===baseGeneration);
    this.assistantBusy = true; this.assistantError = ''; this.changed();
    let context, receipts=[], actionsHandled=false, lookups=0, lookupHistory=[], retrievedSources=[], query=text, reviewRange;
    const capturedRequests=[],relationshipProposals=[],experienceProposals=[],topicProposals=[];let stagedReview=null;
    let activeCompaction=null,compactionAttempted=false,sourceLookupIds=[],retrievedDiscussion=[];
    try {
      const records = this.store.messages(scope), coverage = this.store.coverage(scope);
      const images=this.selectedImages.map(item=>{
        if(!this.store.memorySources(scope).some(s=>s.id===`qq:${item.messageId}`))throw new Error('所选图片来源已撤回或不再用于助手，请重新选择');
        const record=records.find(m=>m.messageId===item.messageId);const image=readImage(record,item.index);
        return {url:`data:${image.type};base64,${image.data.toString('base64')}`,messageId:record.messageId,index:item.index,bytes:image.data.length};
      });
      const assemblyOptions=()=>{
        companion=this.store.getCompanion(scope);
        const availableSources=this.store.memorySources(scope);
        const memoryResult=this.store.searchMemory(scope,query,{limit:16,...reviewRange});
        const index=this.store.searchMemory(scope,query,{limit:8});
        const explicitFeedbackIds=sourceTurnIds.map(id=>companion.turns.find(t=>t.id===id)?.feedbackId).filter(Boolean);
        const experienceContext=this.store.experiences?.context(scope,{query,limit:4});
        if(experienceContext&&explicitFeedbackIds.length){const chosen=explicitFeedbackIds.map(id=>this.store.experiences.hydrateFeedback(scope,id)).filter(Boolean);experienceContext.evaluationTargets=[...new Map([...chosen,...experienceContext.evaluationTargets].map(target=>[target.feedback.id,target])).values()].slice(0,4);}
        const topicContext=this.store.topicView?.(scope);
        const intentSourceId=feedbackIntentId?`private:feedback-${feedbackIntentId}`:undefined;
        if(intentSourceId&&!explicitFeedbackIds.includes(feedbackIntentId))throw new Error('本次反馈意图未绑定选中的反馈对象');
        return { scope, records, companion, turn, purpose: purpose === 'draft' ? 'draft_prepare' : purpose,
          materialIds, coverage, requestId, settings, byteBudget: settings.assistantContextBytes || 48000,availableSources,memoryResult,
          memoryIndex:[...index.items,...index.episodes],retrievedSources,sourceTurnIds,selectedOption,replyMessageIds:[...this.replyMessageIds],imageMessageIds:images.map(image=>image.messageId),
          actionReceipts:receipts,lookupHistory,reviewRange,
          relationshipContext:this.store.relationshipView?.(scope,{query,limit:16}),
          experienceContext,allowExperienceProposals:purpose==='review'||explicitFeedbackIds.length>0,topicContext,intentSourceId,
          generationOrigin:feedbackIntentId?'user_feedback':transient?'qq_observation':'private_discussion',
          discussionCompaction:activeCompaction,sourceLookupIds,retrievedDiscussion,store:this.store,promptVersion:PROMPT_VERSION };
      };
      const attachImages=input=>{
        const availableSources=this.store.memorySources(scope);
        input.images=images.filter(image=>availableSources.some(s=>s.id===`qq:${image.messageId}`));input.manifest.images=input.images.map(({url,...metadata})=>metadata);return input;
      };
      const assemble=async()=>{
        let options=assemblyOptions();
        const identity={goalVersion:companion.goal.version,topicVersion:companion.topics?.version||0,topicBinding:discussionTopicBinding(companion),
          model:settings.model,modelBinding:discussionModelBinding(settings.baseUrl,settings.model),promptVersion:PROMPT_VERSION,protocolVersion:DISCUSSION_COMPACTION_VERSION,currentTurnId:turn.id};
        activeCompaction=this.store.getDiscussionCompaction?.(scope,identity)||null;
        options={...options,discussionCompaction:activeCompaction};
        let input,capacityError;
        try{input=buildContext(options);}catch(error){if(!/超过.*预算|超出.*预算/.test(error.message))throw error;capacityError=error;}
        const plan=!compactionAttempted&&this.compactionModel&&settings.discussionCompactionEnabled!==false
          ?planDiscussionCompaction({...options,context:input,overflow:!!capacityError}):null;
        if(!plan){
          if(capacityError)throw capacityError;
          if(activeCompaction){this.discussionCompaction={scope,phase:'reused',coveredTurns:activeCompaction.sourceTurnIds.length};this.changed();}
          return attachImages(input);
        }
        // Reserve room for at least one subsequent assistance call and, for
        // explicit expression/reply, its restricted final drafting call.
        const needed=purpose==='draft'||purpose==='reply'?3:2;
        if(budget.snapshot().remaining<needed){const error=new Error('本次剩余调用预算不足以整理历史并完成帮助；原始输入已保留。请重新提交，已有有效整理可以复用。');error.code='compaction_budget_insufficient';throw error;}
        compactionAttempted=true;
        this.discussionCompaction={scope,phase:'compacting',coveredTurns:plan.sourceTurnIds.length,bytesBefore:plan.inputBytes};this.changed();
        const configured={...settings,requestBudget:budget.forStage('discussion_compaction')};
        let compressed;
        try{compressed=await this.compactionModel(configured,plan,abort.signal);}catch(error){
          this.discussionCompaction={scope,phase:'failed',coveredTurns:plan.sourceTurnIds.length};this.changed();throw error;
        }
        if(!current())return null;
        const manifest=compressed.manifest||{purpose:'discussion_compaction',promptVersion:PROMPT_VERSION};
        capturedRequests.push({purpose:'discussion_compaction',manifest,payload:{coverage:plan.coverage,sourceTurnIds:plan.sourceTurnIds,authority:'derived_private_discussion_needs_sources'}});
        if(compressed.extraRequests)capturedRequests.push(...compressed.extraRequests);
        const record={...identity,summary:compressed.summary,quoteRefs:compressed.quoteRefs||[],sourceTurnIds:plan.sourceTurnIds,
          turnFingerprints:plan.turnFingerprints,sourceRevisions:plan.sourceRevisions,coverage:plan.coverage,requestId};
        delete record.currentTurnId;
        const receipt=this.store.saveDiscussionCompaction(scope,record,{...identity,baseRevision,currentTurnId:turn.id,transient:!!turn.transient});
        if(!receipt.applied){const error=new Error(`讨论整理未采用：${receipt.detail||receipt.reason}；原始输入仍在。`);error.code='discussion_compaction_rejected';throw error;}
        activeCompaction=receipt.record;
        this.discussionCompaction={scope,phase:'applied',coveredTurns:activeCompaction.sourceTurnIds.length,bytesBefore:plan.inputBytes,
          bytesAfter:Buffer.byteLength(JSON.stringify({summary:activeCompaction.summary,quoteRefs:activeCompaction.quoteRefs}),'utf8')};this.changed();
        input=buildContext({...assemblyOptions(),discussionCompaction:activeCompaction});
        return attachImages(input);
      };
      const invoke=async(input)=>{
        const stage=budget.forStage(input.payload.purpose);settings.requestBudget=stage;input.manifest.stageId=stage.stageId;
        this.store.saveRun(scope,{id:requestId,baseRevision,purpose:input.payload.purpose,status:'pending',payload:input.payload,manifest:input.manifest});
        try{
          const output=await this.assistantModel(settings,input,abort.signal),resultInput=input.resultContext||input;
          const recoveryValue=resultInput.manifest?.responseRecovery||input.manifest?.responseRecovery,recovery=recoveryValue&&normalizeResponseRecovery(recoveryValue);
          if(recovery?.kind==='private_help'&&!['discussion','review','reply'].includes(resultInput.payload.purpose)||recovery?.kind==='restricted_draft'&&resultInput.payload.purpose!=='draft')throw new Error('Response recovery is unavailable for this assistance phase');
          let result=parseAssistant(output,resultInput.payload.purpose,resultInput.payload);
          if(recovery?.kind==='private_help'){
            // A private text fallback cannot commit an earlier queued proposal.
            // Already applied user actions and their real receipts remain intact.
            relationshipProposals.length=0;experienceProposals.length=0;topicProposals.length=0;stagedReview=null;
            result={kind:['discussion','review','question'].includes(result.kind)?result.kind:'discussion',text:result.text};
          }
          input.manifest.methodTrace ||= {delivered:(input.payload.methodCards||[]).map(method=>({id:method.id,version:method.version})),reported:null};
          if(!input.extraRequests?.length)input.manifest.methodTrace.reported=Object.hasOwn(result,'methodIds')?[...result.methodIds]:null;
          if(!recovery&&resultInput.payload.purpose!=='draft'&&result.relationshipPatch)relationshipProposals.push({patch:result.relationshipPatch,manifest:resultInput.manifest});
          if(!recovery&&resultInput.payload.purpose!=='draft'&&result.topicPatch)topicProposals.push({patch:result.topicPatch,context:resultInput});
          if(!recovery)for(const proposal of result.experienceProposals||[])experienceProposals.push({proposal,payload:resultInput.payload,manifest:resultInput.manifest});
          return result;
        }finally{
          // Failed transport/repair attempts still have useful diagnostics. Keep
          // the normal input and stage manifest, never an invalid raw response.
          capturedRequests.push({purpose:input.payload.purpose,manifest:input.manifest,payload:input.payload});
          for(const extra of input.extraRequests||[]){
            const payload=extra.payload?Object.fromEntries(['purpose','originalInput','formatError'].filter(key=>extra.payload[key]!==undefined).map(key=>[key,extra.payload[key]])):undefined;
            capturedRequests.push({purpose:extra.purpose||extra.manifest?.purpose,manifest:extra.manifest,...(payload?{payload}:{}),...(extra.inputBytes!==undefined?{inputBytes:extra.inputBytes}:{})});
          }
          if(input.resultContext&&input.resultContext!==input)context=input.resultContext;
        }
      };
      let result;
      for(let pass=0;pass<5;pass++) {
        context=await assemble();if(!context||!current())return;baseGeneration=this.store.contextGeneration?.(scope);result=await invoke(context);if(!current())return;
        if(result.lookup){
          if(lookups>=2){result={kind:'question',text:'已经查过相关历史，但仍缺少能确认这件事的依据。你可以指出具体那次交流，或者我们先根据目前确定的信息讨论。'};break;}
          const requestedTurns=result.lookup.discussionTurnIds||[];
          if(requestedTurns.length){
            const ids=new Set(requestedTurns),originals=this.store.getCompanion(scope).turns.filter(item=>ids.has(item.id)&&!item.memoryExcluded);
            if(originals.length!==ids.size)throw new Error('要取回的原讨论已经变化；输入已保留，请重新核对。');
            retrievedDiscussion=[...new Map([...retrievedDiscussion,...originals].map(item=>[item.id,item])).values()];
            sourceLookupIds=[...new Set([...sourceLookupIds,...originals.filter(item=>item.role==='user').map(item=>`private:${item.id}`)])];
          }
          const found=result.lookup.query?this.store.searchMemory(scope,result.lookup.query,{limit:24,before:result.lookup.before,after:result.lookup.after,types:result.lookup.types}):{sources:[],coverage:{retrieval:'exact-private-discussion-ids',complete:false}};
          retrievedSources=[...new Map([...retrievedSources,...found.sources].map(source=>[source.id,source])).values()];
          lookupHistory.push({query:result.lookup.query,found:found.sources.length,discussionTurns:requestedTurns.length,coverage:found.coverage});if(result.lookup.query)query=result.lookup.query;
          reviewRange={before:result.lookup.before,after:result.lookup.after,types:result.lookup.types};lookups++;continue;
        }
        if(result.actions?.length&&!actionsHandled&&!transient){
          const applied=applyUserActions(this.store,scope,result.actions,{turn,baseRevision});
          receipts=[...applied.receipts,...applied.pendingActions.map(p=>({status:'pending',id:p.id,type:p.action.type,preview:p.preview,reason:p.reason}))];actionsHandled=true;
          // Proposals describe the exact evidence seen before the action. A
          // correction must never upgrade their provenance to its new revision.
          if(receipts.some(receipt=>receipt.status==='applied')){
            relationshipProposals.length=0;experienceProposals.length=0;topicProposals.length=0;
            // Old private request bodies and compacted-turn fingerprints cannot
            // become dependencies of a response produced after source mutation.
            // HTTP accounting remains in the independent task ledger.
            capturedRequests.length=0;activeCompaction=null;this.discussionCompaction=null;
            // An applied control creates a different source/goal binding. One
            // new pass may be needed; actionsHandled and the task's HTTP cap
            // bound this exception without reusing an obsolete checkpoint.
            compactionAttempted=false;
          }
          const forgotten=receipts.filter(r=>r.status==='applied'&&r.type==='forget');
          if(forgotten.length){
            this.store.markTurnControl(scope,turn.id);
            for(const receipt of forgotten)this.store.recordActionReceipt(scope,{...receipt,evidenceQuote:'用户明确要求不再使用此来源'});
            turn={...turn,memoryExcluded:true,text:'所选来源已从助手参考中移除。请简短确认，不复述已移除内容。'};
            capturedRequests.length=0;relationshipProposals.length=0;experienceProposals.length=0;topicProposals.length=0;this.usage.redactInputs(scope);
            receipts=forgotten.map(({undo,...r})=>({...r,evidenceQuote:'用户明确要求不再使用此来源'}));
          }
          baseRevision=this.store.getCompanion(scope).revision;baseGeneration=this.store.contextGeneration?.(scope);
          continue;
        }
        break;
      }
      if(!result||result.lookup)throw new Error('本次信息整理未能完成，请重试；原始输入已保存');
      let reviewed=context;stagedReview={context,result};
      if(result.draftPlan?.clarification) result={...result,kind:'question',text:result.draftPlan.clarification};
      else if(result.draftPlan){
        const allowedImages=context.images;
        context=buildDraftContext(context,result.draftPlan,{scope,requestId,companion,coverage,settings});context.images=allowedImages;
        result=await invoke(context);if(!current())return;reviewed=null;
      } else if(purpose==='draft')throw new Error('模型尚未明确拟表达内容，请继续说明或选择一个方向');
      if(!current())return;
      let expressionOptions=[];
      try{expressionOptions=expressionOptionsFor(context,result.expressionOptions||[]);}catch(error){receipts.push({status:'rejected',reason:error.message});}
      const methodIds=(result.methodIds||[]).filter(id=>methodFor(id));
      const generationStages=capturedRequests.filter(request=>request.manifest).map(request=>({stageId:request.manifest.stageId,purpose:request.purpose,
        deliveredMethodRefs:(request.manifest.methodTrace?.delivered||[]).map(method=>({methodId:method.id,version:method.version})),reportedUsedMethodRefs:request.manifest.methodTrace?.reported?.map(id=>({methodId:id,version:methodFor(id)?.version}))??null}));
      let patchReceipt=null,relationshipReceipt=null,topicReceipt=null;
      const recoveryValue=context.manifest?.responseRecovery,responseRecovery=recoveryValue&&normalizeResponseRecovery(recoveryValue);
      const reply=this.store._atomic(()=>{
        if(!current())return null;
        const topic=topicProposals.at(-1);
        if(topic&&this.store.applyTopicPatch){
          const manifest=topic.context.manifest,view=topic.context.payload.topicContext;
          const actualSource=records.filter(record=>record.kind==='actual'&&!record.recalled&&manifest.sourceIds.includes(`qq:${record.messageId}`)).at(-1);
          topicReceipt=this.store.applyTopicPatch(scope,topic.patch,{baseRevision,baseTopicVersion:view?.version??0,
            activeId:view?.activeId??null,sourceIds:manifest.sourceIds,sourceRevisions:manifest.sourceRevisions,
            currentSourceId:feedbackIntentId?`private:feedback-${feedbackIntentId}`:transient?actualSource&&`qq:${actualSource.messageId}`:`private:${turn.id}`,
            currentFeedbackId:feedbackIntentId,origin:feedbackIntentId?'user_feedback':transient?'qq_observation':'private_discussion',requestId});
          if(!topicReceipt.applied){const error=new Error(`这次交流方向未能安全更新：${topicReceipt.detail||topicReceipt.reason}；你的输入已保留。`);error.code='topic_patch_rejected';throw error;}
        }
        if(relationshipProposals.length&&this.store.applyRelationshipPatch){
          const patch={claims:[],events:[],retire:[]},refs=new Map();
          for(const proposal of relationshipProposals){for(const key of ['claims','events','retire'])patch[key].push(...(proposal.patch[key]||[]));for(const [id,version]of Object.entries(proposal.manifest.sourceRevisions||{}))if(/^(qq|private|note):/.test(id))refs.set(id,version);}
          for(const key of ['claims','events','retire'])patch[key]=[...new Map(patch[key].map(item=>[JSON.stringify(item),item])).values()];
          relationshipReceipt=this.store.applyRelationshipPatch(scope,patch,{baseRevision,sourceIds:[...refs.keys()],sourceRevisions:Object.fromEntries(refs),requestId});
        }
        const review=stagedReview;
        if(review&&review.result.kind!=='question'&&(review.result.statePatch||review.result.stateReview==='no_change')){
          patchReceipt=this.store.applyState(scope,review.result.statePatch||{},{baseRevision,baseStateVersion:companion.state.version,
            sourceIds:review.context.manifest.sourceIds,coverage:{complete:review.context.manifest.completeReview,sourceIds:review.context.manifest.sourceIds}});
        }
        for(const candidate of experienceProposals){
          const experience=candidate.payload.experienceContext||candidate.payload.experiences||{};
          const allowedSourceIds=candidate.manifest.sourceIds||[];
          const allowedCaseIds=(experience.cases||[]).map(item=>item.id);
          try{this.store.experiences.proposeFromModel(scope,candidate.proposal,{allowedSourceIds,allowedCaseIds,deliveredMethods:candidate.manifest.methodTrace?.delivered||[]});}
          catch(error){receipts.push({status:'rejected',reason:`经验候选未保存：${error.message}`});}
        }
        const reviewedSourceIds=new Set();
        if(patchReceipt?.applied)for(const id of stagedReview?.context.manifest.sourceIds||[])reviewedSourceIds.add(id);
        if(topicReceipt?.applied)for(const id of [...(topic?.patch.purposeSourceIds||[]),...(topic?.patch.observationSourceIds||[])])reviewedSourceIds.add(id);
        const live=new Map(this.store._rawMemorySources(scope).map(source=>[source.id,source]));
        const privateReviewed=[...reviewedSourceIds].filter(id=>{const source=live.get(id);return source?.role==='user'&&(source.type==='private'&&source.kind!=='feedback_continue'||source.type==='feedback'&&source.kind==='local'&&!!source.canonicalFeedbackId)}).slice(-64);
        const privateReviewReceipt=responseRecovery?.kind!=='private_help'&&privateReviewed.length?{applied:true,sourceIds:privateReviewed}:undefined;
        const saved=this.store.appendTurn(scope,{role:'assistant',kind:result.kind,text:result.text,requestId,suggestions:result.suggestions,
          sourceIds:context.manifest.sourceIds,expressionOptions,methodIds,actionReceipts:receipts,generationStages,responseRecovery,privateReviewReceipt,
          artifactMetadata:{generationStages,goalVersion:companion.goal.version,inputSourceRefs:
            [...new Map(capturedRequests.flatMap(request=>Object.entries({...request.manifest?.discussionCompaction?.sourceRevisions,...request.manifest?.sourceRevisions}))).entries()].filter(([sourceId])=>/^(qq|private|note):/.test(sourceId)).map(([sourceId,revision])=>({sourceId,revision})),
            discussionTurnFingerprints:Object.assign({},...capturedRequests.map(request=>request.manifest?.discussionCompaction?.turnFingerprints||{})),model:settings.model,promptVersion:context.payload.promptVersion}});
        this.store.saveRun(scope,{id:requestId,baseRevision,purpose:context.payload.purpose,status:'complete',payload:context.payload,manifest:context.manifest,
          requests:capturedRequests,replyId:saved.id,patchReceipt,relationshipReceipt,topicReceipt,actionReceipts:receipts,privateReviewReceipt:saved.privateReviewReceipt,
          maintenance:patchReceipt?.applied?(stagedReview?.result.statePatch?'applied':'reviewed_no_change'):patchReceipt?'rejected':'deferred'});
        this.usage.finish(scope,budget.id,'complete');return saved;
      });
      if(!reply)return;
      if(purpose==='reply')this.advice={analysis:reply.text,suggestions:reply.suggestions||[],scope,revision:this.revision,createdAt:new Date().toISOString(),requestId};
      return reply;
    } catch(error) {
      if(!current()){
        const continuing=this.pendingAssist?.taskId===budget.id||this.activeAssist?.taskId===budget.id&&this.activeAssist.resumes>resumes;
        const task=this.usage.get(scope,budget.id);
        if(!continuing&&task.status==='running')this.usage.finish(scope,budget.id,'cancelled');
        return;
      }
      this.usage.finish(scope,budget.id,'failed',error.code||'assistant_failed');
      this.assistantError=error.message;
      if(context)this.store.saveRun(scope,{id:requestId,baseRevision,purpose:context.payload.purpose,status:'failed',payload:context.payload,manifest:context.manifest,requests:capturedRequests,error:error.message,maintenance:'failed'});
      throw error;
    } finally {
      if(this.assistantAbort===abort){
        if(this.usage.get(scope,budget.id).status==='running'&&this.pendingAssist?.taskId!==budget.id){
          this.usage.finish(scope,budget.id,'cancelled','context_changed');
          this.assistantError='相关资料已更新，本次旧结果未采用；问题已保留，可以根据当前资料重试。';
        }
        this.activeAssist=null;this.assistantBusy=false;this.assistantAbort=null;this.changed();this.scheduleMemory();
      }
    }
  }
  close() { this.invalidateAssistant(); clearTimeout(this.timer); clearTimeout(this.memoryTimer); this.abort?.abort(); }
}
module.exports = { Controller };
