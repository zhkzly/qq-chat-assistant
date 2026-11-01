'use strict';
const { EventEmitter } = require('node:events');
const { normalize, sameScope, compare } = require('./messages.cjs');
const {publicRecord}=require('./media.cjs');
const {selectVisionContext}=require('./vision-context.cjs');
const { generate, replyFocusFor, redact } = require('./model.cjs');
const {boundedSourceView}=require('./context/source-delivery.cjs');
const {discoverConversationEvidence}=require('./conversation-discovery.cjs');
const {focusSourceOffset}=require('./memory-search.cjs');
const { randomUUID, createHash } = require('node:crypto');
const {TaskLedger}=require('./request-budget.cjs');
const {maintenanceDecision}=require('./memory-scheduler.cjs');
const {envelope:userTextEnvelope}=require('./wire/user-text-envelope.cjs');
const fingerprint=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const FORGOTTEN_REQUEST='所选来源已从助手参考中移除。仅使用仍可用的信息继续本次帮助，不复述已移除内容。';
const {SourceHandleOwner}=require('./source-handles.cjs');
const {primaryOperationFor}=require('./primary-operation.cjs');
const {createPublicationSeal}=require('./publication-seal.cjs');
const {assertDraftSourcesCurrent}=require('./context/draft-material.cjs');
const {editable,validateTerminalDelivery,blockerRenderingWitness,deliveryStatus,clarificationBody}=require('./request-delivery.cjs');
function inFlightMessageRequirement(owner,scope){
  if(!owner||!sameScope(owner.scope,scope))return undefined;
  const existing=owner.args?.requestDeliveryObligation;
  if(editable(existing))return {mode:existing.mode,...(typeof existing.sourceId==='string'?{sourceId:existing.sourceId}:{}),...(typeof existing.sourceRevision==='string'?{sourceRevision:existing.sourceRevision}:{})};
  const input=owner.inflightInput,policy=input?.payload?.requestDeliveryPolicy;
  if(!editable(policy?.obligation)||policy.version!==1||input.manifest?.requestId!==owner.taskId||!sameScope(input.manifest?.scope,scope))return undefined;
  const sourceId=input.payload.intentAuthority?.sourceId,source=input.payload.sources?.find(item=>item.id===sourceId),revision=input.manifest.sourceRevisions?.[sourceId];
  if(typeof revision!=='string'||source?.revision!==revision||source.role!=='user'||!['private','request','feedback'].includes(source.type)||source.deleted||source.excluded||source.use==='disabled')return undefined;
  return {mode:policy.obligation.mode,sourceId,sourceRevision:revision};
}
const { assistModel, parseAssistant, withoutInapplicableTopic, imageContextFor } = require('./assistant-model.cjs');
const { buildContext, buildDraftContext, expressionOptionsFor, PROMPT_VERSION } = require('./assistant-context.cjs');
const {buildAnswerAdmission,buildOptionAdmission}=require('./context/wording-view.cjs');
const { planDiscussionCompaction, assistDiscussionCompaction } = require('./discussion-compaction.cjs');
const { discussionTopicBinding, discussionModelBinding, DISCUSSION_COMPACTION_VERSION,automaticDiscussionTurnIds } = require('./discussion-compaction-store.cjs');
const { normalizeResponseRecovery } = require('./store.cjs');
const {retrievalQuery,recentExchange}=require('./context-task.cjs');
const { maintainMemory: runMemoryMaintenance } = require('./memory-engine.cjs');
const { applyUserActions, confirmUserAction, undoUserAction } = require('./assistant-actions.cjs');
const { methodFor } = require('./help-methods.cjs');
const {CandidateSession}=require('./candidate-session.cjs');
class Controller extends EventEmitter {
  constructor({ store, read, settings, model = generate, assistantModel = assistModel, memoryModel = null, compactionModel = assistDiscussionCompaction,
    now = Date.now, viewerTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone }) {
    super(); Object.assign(this, { store, read, settings, model, assistantModel, memoryModel, compactionModel, now, viewerTimeZone });
    this.candidateSession=new CandidateSession({now:()=>this.candidateNow(),sourceValidity:candidate=>!candidate.artifactRef||
      this.store.experiences.artifactStates(candidate.scope,[candidate.artifactRef,...(candidate.suggestions||[]).map(item=>item.artifactRef)]).every(item=>item.availability==='active')});
    this.status = { phase: 'waiting_qq', account: null };
    this.selectedImages=[];this.replyMessageIds=[];this.visionCache=null;this.features={qqDraftFill:false};
    this.scope = null; this.epoch = 0; this.revision = 0; this.advice = null;
    this.busy = false; this.historyBusy = false; this.error = ''; this.instruction = settings.instruction || '自然一点，贴近我的说话方式';
    this.visible = true; this.autoImages = settings.autoImages === true; this.auto = settings.auto === true; this.modelReady = !!(settings.apiKey || settings.anonymous); this.abort = null; this.timer = null;
    this.assistantAbort = null; this.assistantBusy = false; this.assistantError = '';
    this.memoryAbort = null; this.memoryTimer = null; this.memoryBusy = false; this.memoryRetryAfter = 0; this.memoryFailures=0;
    this.activeAssist=null;this.pendingAssist=null;this.assistantRetryTimer=null;
    this.usage=new TaskLedger(store);this.memoryLastActivityAt=0;this.memoryDraining=false;
    this.feedbackContinuations=new Map();
    this.discussionCompaction=null;
  }
  // Compatibility for existing local API consumers; CandidateSession owns all
  // current output, validity, input sequencing and automatic reuse state.
  get advice(){return this.candidateSession.candidate;}
  set advice(value){if(value!==null)throw new Error('Publish candidates through CandidateSession');this.candidateSession.invalidate();}
  get lastAutomaticFingerprint(){return this.candidateSession.lastAutomaticFingerprint;}
  set lastAutomaticFingerprint(value){this.candidateSession.lastAutomaticFingerprint=value;}
  get candidateReason(){return this.candidateSession.reason;}
  set candidateReason(value){this.candidateSession.reason=value;}
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
  hasModelConsent() { const c=this.settings.realChatConsent;return !!(this.scope && c && c.accountUid===this.scope.accountUid && c.peerUin===this.scope.peerUin && c.baseUrl===this.settings.baseUrl && c.model===this.settings.model && ['accountUin','peerUid'].every(field=>!Object.hasOwn(c,field)||c[field]===this.scope[field])); }
  hasImageConsent({automatic=false}={}) {
    const consent=this.settings.realChatConsent;
    if(!this.hasModelConsent()||!consent?.allowImages)return false;
    // Legacy permission remains manual-only. New grants bind all QQ identities.
    if(['accountUin','peerUid'].some(field=>Object.hasOwn(consent,field)&&consent[field]!==this.scope[field]))return false;
    return !automatic || consent.allowAutomaticImages===true&&['accountUid','accountUin','peerUid','peerUin'].every(field=>consent[field]===this.scope[field]);
  }
  visionContext({refresh=false}={}) {
    const manual=this.selectedImages.length>0,automatic=this.autoImages&&this.settings.visionEnabled&&this.hasImageConsent({automatic:true});
    const permitted=this.scope&&this.settings.visionEnabled&&this.hasImageConsent()&&(manual||automatic);
    if(!permitted)return {mode:'off',images:[],omitted:[]};
    const key=fingerprint({scope:this.scope,revision:this.revision,generation:this.store.contextGeneration?.(this.scope),selection:this.selectedImages,focus:this.replyMessageIds,automatic});
    if(!refresh&&this.visionCache?.key===key&&Date.now()-this.visionCache.at<10000)return this.visionCache.value;
    const value=selectVisionContext({records:this.store.messages(this.scope),availableSources:this.store.memorySources(this.scope),selectedImages:this.selectedImages,replyMessageIds:this.replyMessageIds,automatic});
    this.visionCache={key,at:Date.now(),value};return value;
  }
  visionStatus() {
    let context;
    try{context=this.visionContext();}catch{return {mode:'manual',ready:false,reason:'所选图片不可读取或已不再用于助手，请重新选择',imageCount:0,omitted:[],automaticEnabled:false};}
    const reason=!this.settings.visionEnabled?'当前模型尚未确认支持图片':!this.hasImageConsent()?'尚未允许当前好友图片进入当前模型':this.selectedImages.length?'手动选择的图片优先于自动参考':!this.autoImages?'自动图片参考已关闭':!this.hasImageConsent({automatic:true})?'尚未允许自动参考当前好友的近期图片':context.images.length?'本次会附上近期相关图片':'近期没有可附上的图片';
    return {mode:context.mode,ready:context.mode!=='off',reason,imageCount:context.images.length,omitted:context.omitted,automaticEnabled:this.autoImages&&this.settings.visionEnabled&&this.hasImageConsent({automatic:true})};
  }
  snapshot() {
    const messages = this.store.messages(this.scope);
    const companion=this.scope?this.store.getCompanion(this.scope):null;
    const automaticTurns=companion?automaticDiscussionTurnIds(companion,{store:this.store,scope:this.scope}):new Set();
    return { status: this.status, scope: this.scope, revision: this.revision,
      messages: messages.slice(-100).map(publicRecord), total: messages.length,
      coverage: this.scope ? this.store.coverage(this.scope) : null,
      advice: this.currentAdvice(), candidateStatus:this.candidateStatus(), busy: this.busy, historyBusy: this.historyBusy, error: this.error,
      companion: companion?{...companion,turns:companion.turns.filter(turn=>!automaticTurns.has(turn.id))}:null,
      assistantBusy: this.assistantBusy, assistantOrigin:(this.activeAssist||this.pendingAssist)?.args?.origin||null, assistantError: this.assistantError,
      memoryStatus: this.scope && this.store.memoryStatus ? { ...this.store.memoryStatus(this.scope), busy: this.memoryBusy } : null,
      relationship:this.scope&&this.store.relationshipView?this.store.relationshipView(this.scope,{limit:24}):null,
      experience:this.scope&&this.store.experiences?this.store.experiences.list(this.scope,{limit:8}):null,
      topicContext:this.scope&&this.store.topicView?this.store.topicView(this.scope):null,
      discussionCompaction:this.scope&&sameScope(this.discussionCompaction?.scope,this.scope)?this.discussionCompaction:null,
      requestUsage:this.scope?this.usage.recent(this.scope,8):[],maintenanceSchedule:this.scope?this.memorySchedule():null,
      activeModelProfileId: this.settings.activeModelProfileId, replyFocus: replyFocusFor(messages, this.replyMessageIds),
      instruction: this.instruction, instructionTruncated: this.instructionTruncated === true, auto: this.auto, autoImages:this.autoImages,imageContext:this.visionStatus(),automaticImageConsent:this.hasImageConsent({automatic:true}), model: this.settings.model, modelReady: this.modelReady, modelConsent:this.hasModelConsent(), modelBaseUrl:this.settings.baseUrl || '',imageSelection:this.selectedImages,modelVisionEnabled:!!this.settings.visionEnabled,imageConsent:this.hasImageConsent(),qqDraftFillAvailable:!!this.features.qqDraftFill };
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
      const pending=this.activeAssist||this.pendingAssist,automatic=pending?.args?.origin==='automatic';
      const requirement=inFlightMessageRequirement(pending,this.scope);
      if(requirement)pending.args={...pending.args,requestDeliveryObligation:requirement};
      const resume=pending&&(!automatic||this.auto&&this.automaticEligible());
      this.memoryLastActivityAt=Date.now();this.invalidateAssistant({preserveTask:!!resume});if(automatic&&!resume)this.busy=false;this.advice=null;this.candidateReason=this.automaticEligible()?'qq_changed':'answered';clearTimeout(this.timer);this.revision++; this.changed(); this.scheduleMemory(15000);
      if(resume&&pending.resumes<2&&sameScope(pending.scope,this.scope)){
        this.pendingAssist=pending;
        this.assistantRetryTimer=setTimeout(()=>{
          const retry=this.pendingAssist;this.pendingAssist=null;
          if(retry&&sameScope(retry.scope,this.scope)&&this.visible&&(retry.args.origin!=='automatic'||this.auto&&this.automaticEligible()))this.assist({...retry.args,taskId:retry.taskId,resumeTurnId:retry.turnId,resumes:retry.resumes+1}).catch(()=>{});
        },1800);this.assistantRetryTimer.unref?.();
      } else if(resume) {
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
    const previousReadError = this.store.coverage(scope).error;
    const task = this.historyTask = Symbol('latest');
    this.historyEpoch = epoch; this.historyBusy = true;
    this.store.setCoverage(scope, {...this.store.coverage(scope),status:'loading'}); this.changed();
    try {
      const result = await this.read('latest', { scope });
      if (epoch !== this.epoch || !sameScope(scope, this.scope)) return;
      this.ingest(scope, result.messages);
      const messages = result.messages.map(m => normalize(m, scope)).filter(Boolean).sort(compare);
      // B10: reconcile the delivered visible window against stored
      // observations so locally deleted QQ messages get monotonic tombstones.
      this.store.reconcileVisibleMessages(scope, messages);
      const cached = this.store.messages(scope);
      this.store.setCoverage(scope, { status: messages.length ? 'partial' : cached.length ? 'cached_only' : 'empty',
        pages: 1, cursor: messages[0]?.messageId || null, oldestAt: cached[0]?.timestamp || null,
        checkedAt: new Date().toISOString(), source: result.source });
      if (previousReadError && this.error === previousReadError) this.error = '';
      this.changed();
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
        const previousReadError = coverage.error;
        coverage = { ...coverage }; delete coverage.error;
        if (previousReadError && this.error === previousReadError) this.error = '';
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
  configure({ instruction, auto, autoImages, images, replyMessageIds }) {
    if (replyMessageIds !== undefined) {
      const selected = replyFocusFor(this.store.messages(this.scope), replyMessageIds);
      const nextIds = selected.mode === 'selected' ? selected.messageIds : [];
      if (JSON.stringify(nextIds) !== JSON.stringify(this.replyMessageIds)) {
        this.invalidateAssistant();
        this.replyMessageIds = nextIds; this.abort?.abort(); this.advice = null; clearTimeout(this.timer);
      }
    }
    // B7 no-silent-loss envelope: the standing instruction is stored whole
    // and delivered bounded with an explicit truncation marker; the state
    // exposes instructionTruncated so the UI can warn instead of discovering
    // an invisible 2000-character clamp later. Re-submitting the identical
    // delivered text stays idempotent (no invalidation), as before.
    if (typeof instruction === 'string') {
      const roundTrip = this.instructionTruncated === true && instruction === this.instruction;
      const wrapped = userTextEnvelope(instruction, { limit: 2000 });
      if (wrapped.mode !== 'rejected') {
        const delivered = roundTrip ? instruction : wrapped.delivered;
        if (delivered !== this.instruction) {
          this.invalidateAssistant();
          this.instructionSource = roundTrip ? this.instructionSource : instruction;
          this.instruction = delivered;
          this.instructionTruncated = roundTrip || wrapped.mode === 'truncated';
          this.settings.instruction = this.instruction;
          if (!roundTrip) this.settings.instructionFull = instruction;
          this.abort?.abort(); this.advice = null;
        }
      }
    }
    if(Array.isArray(images)) {
      const selected=images.slice(0,3).filter(i=>typeof i.messageId==='string'&&/^\d+$/.test(i.messageId)&&Number.isInteger(i.index));
      if(JSON.stringify(selected)!==JSON.stringify(this.selectedImages)){this.invalidateAssistant();this.selectedImages=selected;this.abort?.abort();this.advice=null;}
    }
    if(typeof autoImages==='boolean'&&autoImages!==this.autoImages){this.invalidateAssistant();this.autoImages=autoImages;this.settings.autoImages=autoImages;this.visionCache=null;this.abort?.abort();this.advice=null;}
    const enabling=auto===true&&!this.auto;
    if (typeof auto === 'boolean') {this.auto = auto;this.settings.auto=auto;}
    if (!this.auto) {clearTimeout(this.timer);this.cancelAutomaticAssist();}
    if(enabling)this.schedule();
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
  automaticEligible() { const last=this.store.messages(this.scope).filter(message=>message.kind==='actual'&&!message.recalled).at(-1);return !!this.scope&&last?.direction==='incoming'; }
  cancelAutomaticAssist() { const task=this.activeAssist||this.pendingAssist;if(task?.args?.origin==='automatic'){this.invalidateAssistant();this.busy=false;} }
  candidateNow() { return typeof this.now==='function'?this.now():Date.now(); }
  currentAdvice() { return this.candidateSession.current({scope:this.scope,revision:this.revision}); }
  currentCandidateReference(){
    const candidate=this.currentAdvice();if(!candidate?.turnId)return undefined;const primary=candidate.suggestions?.[0];
    return {turnId:candidate.turnId,...(primary?{suggestionIndex:0}:{}),artifactRef:primary?.artifactRef||candidate.artifactRef,origin:candidate.origin};
  }
  candidateStatus() {
    const messageIds=replyFocusFor(this.store.messages(this.scope),this.replyMessageIds).messageIds;
    return this.candidateSession.status({scope:this.scope,revision:this.revision,auto:this.auto,messageIds});
  }
  schedule() { if(!this.auto||!this.visible||this.assistantBusy||this.pendingAssist||!this.automaticEligible())return;if(!this.hasModelConsent())return; clearTimeout(this.timer); this.timer = setTimeout(() => {if(this.auto&&this.visible&&this.automaticEligible())this.suggest({automatic:true}).catch(() => {});}, 1800); this.timer.unref?.(); }
  automaticFingerprint(){return fingerprint({promptVersion:PROMPT_VERSION,scope:this.scope,revision:this.revision,privateInputSeq:this.candidateSession.privateInputSeq,model:this.settings.model,baseUrl:this.settings.baseUrl,instruction:this.instruction,images:this.selectedImages,autoImages:this.autoImages,automaticImageConsent:this.hasImageConsent({automatic:true}),focus:this.replyMessageIds});}
  async suggest({automatic=false,alternative=false}={}) {
    const scope = this.requireScope(), epoch = this.epoch;
    if(automatic&&this.candidateSession.canReuseAutomatic(this.automaticFingerprint(),{scope,revision:this.revision}))return this.advice;
    const currentCandidateRef=!automatic&&alternative===true&&this.currentAdvice()?.suggestions?.length?this.currentCandidateReference():undefined;
    const candidateAlternative=!!currentCandidateRef;
    this.busy = true; this.changed();
    try {
      const reply = await this.assist({ text: automatic ? '根据真实 QQ 更新当前交流的帮助；结合此刻时间和已有方向，判断现在有什么值得回应或处理。'
        : candidateAlternative?'我想换一个与当前候选有实质区别的具体切口或交流方向，不只是换词或换语气。参考提供的那一条生成候选，结合实际QQ、可用真实素材和仍适用的商量，给另一种可展开的内容及完整参考表达。不要重复原候选的核心话题动作，也不要为了求不同编造经历或忽略她刚提出的问题；若眼下没有更合适的新切口，诚实说明，不把原句改几个词当作新方向。'
        : '我现在想和她聊。结合此刻时间、实际QQ和仍有效的商量，找一个具体、自然、可展开的切口，并给完整参考表达。没有新来信或我没有新鲜近况时，也可从她分享过的生活、共同话题或值得了解的一点开始；核对已经问过、说过的内容。',responsePreference:this.instruction,
        purpose: 'reply', transient: true, origin:automatic?'automatic':'user',currentCandidateRef,candidateAlternative });
      if (!reply || epoch !== this.epoch || !sameScope(scope,this.scope)) return;
    } catch (error) { if(epoch===this.epoch){this.assistantError=error.message;this.changed();} throw error; }
    finally { if(epoch===this.epoch){this.busy=false;this.changed();} }
  }
  requireScope() { if (!this.scope) throw new Error('请先选择一个 QQ 私聊'); return this.scope; }
  invalidateAssistant({preserveTask=false}={}) {
    this.visionCache=null;
    this.discussionCompaction=null;
    const old=this.activeAssist||this.pendingAssist;if(old?.args?.origin==='automatic')this.busy=false;if(!preserveTask&&old?.taskId){try{this.usage.finish(old.scope,old.taskId,'cancelled')}catch{}}
    clearTimeout(this.assistantRetryTimer);this.activeAssist=null;this.pendingAssist=null;
    this.memoryAbort?.abort(); this.memoryAbort = null; this.memoryBusy = false; clearTimeout(this.memoryTimer);
    this.assistantAbort?.abort(); this.assistantAbort = null;
    this.candidateSession.cancel();
    this.assistantBusy = false; this.assistantError = '';
  }
  changedContext() {
    this.memoryLastActivityAt=Date.now();this.invalidateAssistant(); this.abort?.abort(); this.advice = null; clearTimeout(this.timer); this.changed(); this.scheduleMemory();
  }
  setGoal(text) { const result = this.store.setGoal(this.requireScope(), text); this.changedContext(); return result; }
  topicAction(args) {
    const result=this.store.topicAction(this.requireScope(),args),oldAssistantError=this.assistantError;
    this.changedContext();
    if(this.error===oldAssistantError)this.error='';
    this.changed();return result;
  }
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
    this.store.setMemoryReviewBudget?.(this.scope,{requestBytes:this.settings.memoryInputBytes,model:this.settings.model,responseMode:this.settings.modelResponseMode});
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
    this.store.setMemoryReviewBudget?.(scope,{requestBytes:this.settings.memoryInputBytes,model:this.settings.model,responseMode:this.settings.modelResponseMode});
    if(force){this.memoryFailures=0;this.memoryRetryAfter=0;}
    if(!this.memoryModel)return {status:'not_configured',...this.store.memoryStatus(scope)};
    if(!this.hasModelConsent())throw new Error('当前会话未允许这个模型整理记忆');
    if(this.assistantBusy||this.memoryBusy||(!force&&!this.visible))return {status:'deferred',...this.store.memoryStatus(scope)};
    this.store.maintainLocal?.(scope);
    const work=this.store.memoryStatus(scope);
    if(!work.pending&&!work.recoveryReady)return {status:work.semanticPending?'unfinished':'complete',...work};
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
      const work=this.store.memoryStatus(scope);if(!work.pending&&!work.recoveryReady)this.memoryDraining=false;
      if(this.memoryAbort===abort){this.memoryBusy=false;this.memoryAbort=null;this.changed();if(work.pending||work.recoveryReady)this.scheduleMemory(2500);}
    }
  }
  async assist({ text, purpose = 'discussion', materialIds = [], sourceTurnIds = [], selectedOption, transient = false, resumeTurnId, resumes=0, taskId, origin='user',feedbackIntentId,privateKind,responsePreference=this.instruction,candidateInputSeq,currentCandidateRef,candidateAlternative=false,requestDeliveryObligation:resumeDeliveryObligation,sourceHandleOwner:resumeSourceHandleOwner } = {}) {
    const scope = this.requireScope();
    // Freeze one observation across lookups, compaction and format repair.
    // Reconstruct this controller and its CandidateSession together on service refresh.
    const asOf = new Date(typeof this.now === 'function' ? this.now() : Date.now()).toISOString();
    const viewerTimeZone = this.viewerTimeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    const invocation = { origin: origin === 'automatic' ? 'automatic' : 'user',
      trigger: feedbackIntentId ? 'feedback_followup' : transient ? origin === 'automatic' ? 'automatic_observation' : 'manual_suggestion' : 'private_request',
      requestedPurpose: purpose };
    if (!this.hasModelConsent()) throw new Error('请先允许当前会话使用配置的模型；私下资料与聊天记录目前仅在本机');
    if (typeof text !== 'string' || !text.trim() || text.length > 16000) throw new Error('请输入这次想商量或表达的内容（最多 16000 字）');
    if (!['discussion', 'draft', 'review','reply'].includes(purpose)) throw new Error('未知的帮助用途');
    if(!Array.isArray(sourceTurnIds)||sourceTurnIds.length>8||sourceTurnIds.some(id=>typeof id!=='string'))throw new Error('参考的私下讨论不合法');
    if(selectedOption&&(!Number.isInteger(selectedOption.index)||typeof selectedOption.turnId!=='string'))throw new Error('表达方向不合法');
    if(this.selectedImages.length&&(!this.settings.visionEnabled||!this.hasImageConsent()))throw new Error('所选图片需要启用视觉模型并明确允许图片发送');
    const budget=resumes>0&&taskId?this.usage.resume(scope,taskId):this.usage.create(scope,{id:taskId,
      inputDigest:fingerprint({text,purpose,materialIds,sourceTurnIds,selectedOption,feedbackIntentId,scope,model:this.settings.model,baseUrl:this.settings.baseUrl}),origin,limit:Number(this.settings.assistantRequestLimit)||4});
    if(budget.reused&&!resumes){
      const previous=this.usage.get(scope,budget.id);
      if(previous.status==='complete')return this.store.getCompanion(scope).turns.find(turn=>turn.role==='assistant'&&turn.requestId===budget.id)||null;
      const error=new Error(previous.status==='running'?'这次请求仍在进行，请等待结果。':'这次请求已经结束；如需重新尝试，请重新提交。');error.code='task_already_exists';throw error;
    }
    if(resumes>0&&(!(resumeSourceHandleOwner instanceof SourceHandleOwner)||!resumeSourceHandleOwner.matches(scope,budget.id))){this.usage.finish(scope,budget.id,'failed','source_handle_owner_mismatch');throw new Error('本次来源引用任务已变化，原输入已保留，请重新提交');}
    const sourceHandleOwner=resumes>0?resumeSourceHandleOwner:new SourceHandleOwner({scope,taskId:budget.id});
    // The user's new words can refer to the visible current wording even as
    // the new-intent fence withdraws it. This is one generated reference, not
    // an explicit historical selection or permission to reload its sources.
    if(sourceTurnIds.length||selectedOption)currentCandidateRef=undefined;
    else if(!currentCandidateRef&&invocation.origin==='user'&&!transient&&resumes===0)currentCandidateRef=this.currentCandidateReference();
    if(this.error===this.assistantError)this.error='';
    this.invalidateAssistant({preserveTask:resumes>0});
    const candidateTicket=this.candidateSession.begin({scope,revision:this.revision,requestId:budget.id,origin:invocation.origin,
      advancePrivateInput:invocation.origin==='user'&&resumes===0,expectedPrivateInputSeq:resumes>0?candidateInputSeq:undefined});
    if(!candidateTicket){this.usage.finish(scope,budget.id,'cancelled','private_input_changed');return;}
    this.memoryLastActivityAt=Date.now();this.store.maintainLocal?.(scope);
    const abort = this.assistantAbort = new AbortController(), requestId = budget.id;
    clearTimeout(this.timer);
    const storedPrior=resumeTurnId&&this.store.getCompanion(scope).turns.find(t=>t.id===resumeTurnId&&t.role==='user');
    const prior=storedPrior&&(storedPrior.text===text?storedPrior:storedPrior.memoryExcluded&&text===FORGOTTEN_REQUEST?{...storedPrior,text:FORGOTTEN_REQUEST}:null);
    if(resumeTurnId&&!prior&&!transient)throw new Error('原来的问题已变化，请使用当前问题');
    let turn = transient ? {id:requestId,role:'user',kind:purpose,text,transient:true} : prior||this.store.appendTurn(scope, { role: 'user', kind: privateKind||purpose, text, requestId });
    this.activeAssist={scope,turnId:turn.id,taskId:budget.id,resumes,args:{text,purpose,materialIds,sourceTurnIds,selectedOption,transient,origin,feedbackIntentId,privateKind,responsePreference,candidateInputSeq:candidateTicket.privateInputSeq,currentCandidateRef,candidateAlternative,sourceHandleOwner,...(resumes>0&&resumeDeliveryObligation?{requestDeliveryObligation:resumeDeliveryObligation}:{})}};
    let companion = this.store.getCompanion(scope), baseRevision = companion.revision,baseGeneration=this.store.contextGeneration?.(scope);
    const epoch = this.epoch, revision = this.revision, settings = { ...this.settings,sourceHandleOwner };
    const binding = `${settings.baseUrl}\n${settings.model}\n${settings.activeModelProfileId || ''}`;
    const current = () => this.assistantAbort === abort && !abort.signal.aborted && epoch === this.epoch && revision === this.revision &&
      sameScope(scope, this.scope) && this.hasModelConsent() &&this.candidateSession.isCurrent(candidateTicket,{scope:this.scope,revision:this.revision})&&
      binding === `${this.settings.baseUrl}\n${this.settings.model}\n${this.settings.activeModelProfileId || ''}` &&
      this.store.getCompanion(scope).revision === baseRevision && (!this.store.contextGeneration||this.store.contextGeneration(scope)===baseGeneration);
    this.assistantBusy = true; this.assistantError = ''; this.changed();
    let context, receipts=[], actionsHandled=false, lookups=0, lookupHistory=[], retrievedSources=[], methodLookupIds=[], discoveryRequested=false, query=text, reviewRange;
    const capturedRequests=[],relationshipProposals=[],experienceProposals=[],topicProposals=[];let stagedReview=null;
    let activeCompaction=null,compactionAttempted=false,sourceLookupIds=[],retrievedDiscussion=[],requestDeliveryObligation=resumes>0?resumeDeliveryObligation:undefined,requestDelivery;
    try {
      const records = this.store.messages(scope), coverage = this.store.coverage(scope);
      query=retrievalQuery({text,records,companion,transient,asOf,settings});
      const vision=this.visionContext({refresh:true}),images=vision.images;
      const assemblyOptions=()=>{
        companion=this.store.getCompanion(scope);
        const availableSources=this.store.memorySources(scope);
        const liveImages=images.filter(image=>availableSources.some(source=>source.id===`qq:${image.messageId}`));
        const liveMediaContext={mode:vision.mode,omitted:vision.omitted.filter(item=>availableSources.some(source=>source.id===item.sourceId))};
        const memoryResult=this.store.searchMemory(scope,query,{limit:16,...reviewRange});
        const index=this.store.searchMemory(scope,query,{limit:8});
        const explicitFeedbackIds=sourceTurnIds.map(id=>companion.turns.find(t=>t.id===id)?.feedbackId).filter(Boolean);
        const experienceContext=this.store.experiences?.context(scope,{query,limit:4});
        if(experienceContext&&explicitFeedbackIds.length){const chosen=explicitFeedbackIds.map(id=>this.store.experiences.hydrateFeedback(scope,id)).filter(Boolean);experienceContext.evaluationTargets=[...new Map([...chosen,...experienceContext.evaluationTargets].map(target=>[target.feedback.id,target])).values()].slice(0,4);}
        const topicContext=this.store.topicView?.(scope);
        const discoveryRecords=this.store.knowledgeDirectory?.(scope)||[...(memoryResult.items||[]),...(memoryResult.episodes||[])];
        const liveIds=new Set(availableSources.map(source=>source.id));
        const anchorRecords=(this.replyMessageIds.length?records.filter(record=>this.replyMessageIds.includes(record.messageId)):recentExchange(records))
          .filter(record=>liveIds.has(`qq:${record.messageId}`));
        const recentAnchor=anchorRecords.some(record=>Date.parse(asOf)-record.timestamp<=Math.max(1,Number(settings.assistantRecentHours)||72)*3600000);
        const mode=discoveryRequested||!transient&&purpose!=='reply'&&!materialIds.length&&!sourceTurnIds.length&&!selectedOption&&!recentAnchor?'broad':'anchored';
        const discoveryQuery=mode==='broad'?query:[text,...anchorRecords.map(record=>record.text)].join('\n');
        const memoryDiscovery=discoverConversationEvidence({sources:availableSources,records:discoveryRecords,query:discoveryQuery,goal:companion.goal.text,asOf,mode});
        const intentSourceId=feedbackIntentId?`private:feedback-${feedbackIntentId}`:undefined;
        if(intentSourceId&&!explicitFeedbackIds.includes(feedbackIntentId))throw new Error('本次反馈意图未绑定选中的反馈对象');
        return { scope, records, companion, turn, purpose: purpose === 'draft' ? 'draft_prepare' : purpose, asOf, viewerTimeZone, invocation,
          materialIds, coverage, requestId, settings, images:liveImages,mediaContext:liveMediaContext, byteBudget: settings.assistantContextBytes || 48000,availableSources,memoryResult,
          memoryIndex:[...index.items,...index.episodes],memoryDiscovery,retrievedSources,methodLookupIds,sourceTurnIds,selectedOption,currentCandidateRef,candidateAlternative:candidateAlternative===true&&invocation.origin==='user',replyMessageIds:[...this.replyMessageIds],imageMessageIds:liveImages.map(image=>image.messageId),
          actionReceipts:receipts,lookupHistory,reviewRange,
          relationshipContext:this.store.relationshipView?.(scope,{query,limit:16}),
          experienceContext,allowExperienceProposals:purpose==='review'||explicitFeedbackIds.length>0,topicContext,intentSourceId,
          generationOrigin:feedbackIntentId?'user_feedback':transient?'qq_observation':'private_discussion',responsePreference,
          discussionCompaction:activeCompaction,sourceLookupIds,retrievedDiscussion,requestDeliveryObligation,lookupExhausted:lookups>=2,store:this.store,promptVersion:PROMPT_VERSION };
      };
      const attachImages=input=>{
        const availableSources=this.store.memorySources(scope);
        input.images=images.filter(image=>availableSources.some(s=>s.id===`qq:${image.messageId}`));
        const delivered=new Set(input.payload.sources.map(source=>source.id));
        input.mediaContext={mode:vision.mode,omitted:vision.omitted.filter(item=>availableSources.some(source=>source.id===item.sourceId)&&delivered.has(item.sourceId))};
        input.payload.imageContext=imageContextFor(input.payload,input.images,input.mediaContext);
        input.manifest.images=input.images.map(({url,...metadata})=>metadata);input.manifest.imageCount=input.images.length;input.manifest.imageContext=input.payload.imageContext;return input;
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
        // Compaction is an optional quality ladder step, never a feasibility
        // gate: without request headroom (or when the compaction call itself
        // fails), the answer proceeds on the degraded deterministic context.
        const needed=purpose==='draft'||purpose==='reply'?3:2;
        const proceedWithoutCompaction=detail=>{
          this.discussionCompaction={scope,phase:'skipped',coveredTurns:plan.sourceTurnIds.length,detail};this.changed();
          if(capacityError)throw capacityError;
          if(activeCompaction){this.discussionCompaction={scope,phase:'reused',coveredTurns:activeCompaction.sourceTurnIds.length};this.changed();}
          return attachImages(input);
        };
        if(budget.snapshot().remaining<needed)return proceedWithoutCompaction('request_budget_reserved_for_answer');
        compactionAttempted=true;
        this.discussionCompaction={scope,phase:'compacting',coveredTurns:plan.sourceTurnIds.length,bytesBefore:plan.inputBytes};this.changed();
        const configured={...settings,requestBudget:budget.forStage('discussion_compaction')};
        let compressed;
        try{compressed=await this.compactionModel(configured,plan,abort.signal);}catch(error){
          if(!current())return null;
          return proceedWithoutCompaction('compaction_call_failed');
        }
        if(!current())return null;
        const manifest=compressed.manifest||{purpose:'discussion_compaction',promptVersion:PROMPT_VERSION};
        capturedRequests.push({purpose:'discussion_compaction',manifest,payload:{coverage:plan.coverage,sourceTurnIds:plan.sourceTurnIds,authority:'derived_private_discussion_needs_sources'}});
        if(compressed.extraRequests)capturedRequests.push(...compressed.extraRequests);
        const record={...identity,summary:compressed.summary,quoteRefs:compressed.quoteRefs||[],sourceTurnIds:plan.sourceTurnIds,
          turnFingerprints:plan.turnFingerprints,sourceRevisions:plan.sourceRevisions,coverage:plan.coverage,requestId};
        delete record.currentTurnId;
        const receipt=this.store.saveDiscussionCompaction(scope,record,{...identity,baseRevision,currentTurnId:turn.id,transient:!!turn.transient});
        if(!receipt.applied)return proceedWithoutCompaction(`discussion_compaction_rejected:${receipt.detail||receipt.reason}`);
        activeCompaction=receipt.record;
        this.discussionCompaction={scope,phase:'applied',coveredTurns:activeCompaction.sourceTurnIds.length,bytesBefore:plan.inputBytes,
          bytesAfter:Buffer.byteLength(JSON.stringify({summary:activeCompaction.summary,quoteRefs:activeCompaction.quoteRefs}),'utf8')};this.changed();
        try{input=buildContext({...assemblyOptions(),discussionCompaction:activeCompaction});}
        catch(error){
          // Even a post-compaction assembly failure must not block the answer:
          // keep the already feasible pre-compaction context instead.
          if(!/超过.*预算|超出.*预算/.test(error.message))throw error;
        }
        return attachImages(input);
      };
      const assertArtifactInputs=(input)=>{
        const references=new Map();
        for(const item of [...capturedRequests.flatMap(request=>request.manifest?.inputArtifactRefs||[]),...(input?.manifest?.inputArtifactRefs||[])]){
          const key=item.artifactRef.artifactId+'@'+item.artifactRef.version,previous=references.get(key);
          if(previous&&fingerprint(previous)!==fingerprint(item))throw new Error('Editing reference artifact changed between generation stages');
          references.set(key,item);
        }
        return this.store.experiences.assertInputArtifactsCurrent(scope,[...references.values()]);
      };
      const invoke=async(input)=>{
        if(this.activeAssist?.taskId===budget.id)Object.defineProperty(this.activeAssist,'inflightInput',{value:input,writable:true,configurable:true});
        if(input.payload.requestDeliveryPolicy){
          const sourceId=input.payload.intentAuthority?.sourceId,sourceRevision=input.manifest.sourceRevisions[sourceId];
          if(requestDeliveryObligation?.sourceId&&(requestDeliveryObligation.sourceId!==sourceId||requestDeliveryObligation.sourceRevision!==sourceRevision)){
            requestDeliveryObligation=undefined;requestDelivery=undefined;delete input.payload.requestDeliveryPolicy.obligation;
          }
          if(editable(requestDeliveryObligation))requestDeliveryObligation={mode:requestDeliveryObligation.mode,sourceId,sourceRevision};
          if(current()&&this.activeAssist?.taskId===budget.id)this.activeAssist.args.requestDeliveryObligation=requestDeliveryObligation;
        }
        assertArtifactInputs(input);
        const stage=budget.forStage(input.requestStage||input.payload.purpose);settings.requestBudget=stage;input.manifest.stageId=stage.stageId;
        input.manifest.candidateSession={qqRevision:revision,privateInputSeq:candidateTicket.privateInputSeq};
        this.store.saveRun(scope,{id:requestId,baseRevision,purpose:input.payload.purpose,status:'pending',payload:input.payload,manifest:input.manifest});
        try{
          const output=await this.assistantModel(settings,input,abort.signal),resultInput=input.resultContext||input;
          assertArtifactInputs(input);assertArtifactInputs(resultInput);
          const recoveryValue=resultInput.manifest?.responseRecovery||input.manifest?.responseRecovery,recovery=recoveryValue&&normalizeResponseRecovery(recoveryValue);
          if(recovery?.kind==='private_help'&&!['discussion','review','reply'].includes(resultInput.payload.purpose)||recovery?.kind==='restricted_draft'&&resultInput.payload.purpose!=='draft')throw new Error('Response recovery is unavailable for this assistance phase');
          const diagnostics={};
          let result=parseAssistant(output,resultInput.payload.purpose,resultInput,diagnostics);
          if(diagnostics.blockerRendering)input.manifest.blockerRendering=blockerRenderingWitness(diagnostics.blockerRendering);
          if(result.kind==='question'&&(result.requestDelivery?.blocker||result.deliveryBlocker)){
            // Typed explanation and question already share result.text. Never
            // promote an adapter's untyped legacy prose into a second body.
            delete result.discussionExplanation;
            result.replyDisposition='clarify';
          }
          if(result.requestDelivery){
            requestDelivery=result.requestDelivery;
            if(editable(requestDelivery))requestDeliveryObligation={mode:requestDelivery.mode,sourceId:requestDelivery.sourceId,sourceRevision:resultInput.manifest.sourceRevisions[requestDelivery.sourceId]};
            if(current()&&this.activeAssist?.taskId===budget.id)this.activeAssist.args.requestDeliveryObligation=requestDeliveryObligation;
          }
          if(requestDelivery)input.manifest.requestDelivery={interpretation:requestDelivery,status:deliveryStatus(requestDelivery,result,{restricted:resultInput.payload.purpose==='draft',committed:false}),...(result.deliveryBlocker?{blocker:result.deliveryBlocker}:{})};
          const auxiliaryErrors=[...(input.manifest.auxiliaryErrors||[]),...(resultInput.manifest.auxiliaryErrors||[]),...(diagnostics.auxiliaryErrors||[])];
          if(auxiliaryErrors.length){input.manifest.auxiliaryErrors=[...new Map(auxiliaryErrors.map(e=>[JSON.stringify(e),e])).values()];
            const fields=new Set(auxiliaryErrors.map(e=>e.field));
            if(fields.has('topicPatch'))topicProposals.length=0;
            if(fields.has('relationshipPatch'))relationshipProposals.length=0;
            if(fields.has('experienceProposals'))experienceProposals.length=0;
            if(fields.has('statePatch'))stagedReview=null;
          }
          if(recovery?.kind==='private_help'){
            // A private text fallback cannot commit an earlier queued proposal.
            // Already applied user actions and their real receipts remain intact.
            relationshipProposals.length=0;experienceProposals.length=0;topicProposals.length=0;stagedReview=null;
            result={kind:['discussion','review','question'].includes(result.kind)?result.kind:'discussion',text:result.text,
              ...(input.payload.purpose==='reply'?{replyDisposition:'unavailable'}:result.replyDisposition?{replyDisposition:result.replyDisposition}:{})};
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
          capturedRequests.push({purpose:input.requestStage||input.payload.purpose,manifest:input.manifest,payload:input.payload});
          for(const extra of input.extraRequests||[]){
            const payload=extra.payload?Object.fromEntries(['purpose','originalInput','formatError','validationIssues'].filter(key=>extra.payload[key]!==undefined).map(key=>[key,extra.payload[key]])):undefined;
            capturedRequests.push({purpose:extra.purpose||extra.manifest?.purpose,manifest:extra.manifest,...(payload?{payload}:{}),...(extra.inputBytes!==undefined?{inputBytes:extra.inputBytes}:{})});
          }
          if(input.resultContext&&input.resultContext!==input)context=input.resultContext;
        }
      };
      const topicOptions=proposal=>{
        const manifest=proposal.context.manifest,view=proposal.context.payload.topicContext;
        const actual=records.filter(record=>record.kind==='actual'&&!record.recalled&&manifest.sourceIds.includes(`qq:${record.messageId}`)).at(-1);
        return {baseRevision,baseTopicVersion:view?.version??0,activeId:view?.activeId??null,sourceIds:manifest.sourceIds,sourceRevisions:manifest.sourceRevisions,
          currentSourceId:feedbackIntentId?`private:feedback-${feedbackIntentId}`:transient?actual&&`qq:${actual.messageId}`:`private:${turn.id}`,
          currentFeedbackId:feedbackIntentId,origin:feedbackIntentId?'user_feedback':transient?'qq_observation':'private_discussion',requestId};
      };
      let result;
      for(let pass=0;pass<5;pass++) {
        context=await assemble();if(!context||!current())return;baseGeneration=this.store.contextGeneration?.(scope);result=await invoke(context);if(!current())return;
        if(result.lookup){
          // Reading can change the meaning of an earlier snapshot even when
          // its source revisions remain current. Require terminal reproposal.
          const deferred=[...(relationshipProposals.length?['relationshipPatch']:[]),...(topicProposals.length?['topicPatch']:[]),...(experienceProposals.length?['experienceProposals']:[]),
            ...(result.statePatch?['statePatch']:[]),...(result.stateReview?['stateReview']:[])];
          if(deferred.length)context.manifest.deferredProposals={fields:[...new Set(deferred)],reason:'lookup_requires_terminal_reproposal'};
          relationshipProposals.length=0;topicProposals.length=0;experienceProposals.length=0;stagedReview=null;
        }
        // Validate the complete prepared branch before any independently
        // authorized action can mutate its source context.
        if(primaryOperationFor(result)?.contractVersion==='primary-operation-v2'&&primaryOperationFor(result).operation==='prepare_message'){
          buildAnswerAdmission(context,result,{scope,requestId,companion,coverage,settings,store:this.store});
        }else if(result.draftPlan&&!result.draftPlan.clarification){
          if(!primaryOperationFor(result)?.answer)throw new Error('主调用必须同时提供完整answer和来源绑定计划；输入已保留');
          buildDraftContext(context,result.draftPlan,{scope,requestId,companion,coverage,settings,store:this.store});
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
            turn={...turn,memoryExcluded:true,text:FORGOTTEN_REQUEST};
            requestDeliveryObligation=editable(requestDeliveryObligation)?{mode:requestDeliveryObligation.mode}:undefined;requestDelivery=undefined;context=null;
            query=turn.text;retrievedSources=[];retrievedDiscussion=[];sourceLookupIds=[];lookupHistory=[];methodLookupIds=[];reviewRange=undefined;
            feedbackIntentId=undefined;sourceTurnIds=[];selectedOption=undefined;currentCandidateRef=undefined;
            if(this.activeAssist?.taskId===budget.id)this.activeAssist.args={...this.activeAssist.args,text:FORGOTTEN_REQUEST,feedbackIntentId:undefined,sourceTurnIds:[],selectedOption:undefined,currentCandidateRef:undefined,requestDeliveryObligation};
            if(this.activeAssist?.taskId===budget.id)this.activeAssist.inflightInput=null;
            capturedRequests.length=0;relationshipProposals.length=0;experienceProposals.length=0;topicProposals.length=0;this.usage.redactInputs(scope);
            receipts=forgotten.map(({undo,...r})=>({...r,evidenceQuote:'用户明确要求不再使用此来源'}));
          }
          baseRevision=this.store.getCompanion(scope).revision;baseGeneration=this.store.contextGeneration?.(scope);
          continue;
        }
        if(result.lookup){
          if(lookups>=2){result={kind:'question',text:'已经查过相关历史，但仍缺少能确认这件事的依据。你可以指出具体那次交流，或者我们先根据目前确定的信息讨论。'};break;}
          const requestedTurns=result.lookup.discussionTurnIds||[];
          if(requestedTurns.length){
            const ids=new Set(requestedTurns),originals=this.store.getCompanion(scope).turns.filter(item=>ids.has(item.id)&&!item.memoryExcluded);
            if(originals.length!==ids.size)throw new Error('要取回的原讨论已经变化；输入已保留，请重新核对。');
            retrievedDiscussion=[...new Map([...retrievedDiscussion,...originals.map(item=>({...item,requestedOffset:result.lookup.offset||0,requestedMaxChars:result.lookup.maxChars||4000}))].map(item=>[item.id,item])).values()];
            sourceLookupIds=[...new Set([...sourceLookupIds,...originals.filter(item=>item.role==='user').map(item=>`private:${item.id}`)])];
          }
          const found=result.lookup.query?this.store.searchMemory(scope,result.lookup.query,{limit:24,before:result.lookup.before,after:result.lookup.after,types:result.lookup.types}):{sources:[],coverage:{retrieval:'exact-private-discussion-ids',complete:false}};
          const liveSources=new Map(this.store.memorySources(scope).map(source=>[source.id,source]));
          // B9 batched continuation reads: one lookup round trip may request
          // several bounded ranges (wire contract reads form). Reads of the
          // same source merge into one envelope entry so downstream consumers
          // keep their one-entry-per-source expectation.
          const readList=result.lookup.reads?.length
            ?result.lookup.reads
            :[{sourceIds:result.lookup.sourceIds||[],offset:result.lookup.offset||0,maxChars:result.lookup.maxChars||4000}];
          const readRanges=new Map();
          for(const read of readList)for(const id of read.sourceIds||[]){
            const range=readRanges.get(id)||{offset:read.offset||0,end:(read.offset||0)+(read.maxChars||4000)};
            range.offset=Math.min(range.offset,read.offset||0);
            range.end=Math.max(range.end,(read.offset||0)+(read.maxChars||4000));
            readRanges.set(id,range);
          }
          const exactIds=[...new Set([...readRanges.keys(),...requestedTurns.filter(id=>liveSources.has(`private:${id}`)).map(id=>`private:${id}`)])];
          const direct=exactIds.map(id=>{
            const original=liveSources.get(id);
            if(!original||original.deleted||original.excluded||original.use==='disabled')throw new Error('要读取的来源已变化或不在当前会话中，请重新核对。');
            const range=readRanges.get(id),requested=range?{offset:range.offset,maxChars:Math.max(1,range.end-range.offset)}:{offset:0,maxChars:4000};
            const projected=boundedSourceView({...original,text:redact(original.text)},{offset:requested.offset,maxChars:requested.maxChars,maxBytes:Number(settings.assistantContextBytes)||48000});
            if(!projected)throw new Error('来源片段超出本次可读范围，请选择有效位置。');
            return {...projected,requestedRange:requested,...(result.lookup.reads?.length?{requestedReads:result.lookup.reads.length}:{})};
          });
          const queryReads=found.sources.map(source=>({...source,focusOffset:focusSourceOffset(redact(source.text),result.lookup.query)}));
          retrievedSources=[...new Map([...retrievedSources,...queryReads,...direct].map(source=>[source.id,source])).values()];
          if(result.lookup.methodIds?.length)methodLookupIds=[...result.lookup.methodIds];
          if(result.lookup.discover)discoveryRequested=true;
          lookupHistory.push({query:result.lookup.query,found:found.sources.length+direct.length,discussionTurns:requestedTurns.length,sourceIds:direct.map(source=>source.id),...(result.lookup.reads?.length?{batchedReads:result.lookup.reads.length}:direct.length?{requestedRange:{offset:result.lookup.offset||0,maxChars:result.lookup.maxChars||4000}}:{}),methodIds:result.lookup.methodIds||[],coverage:found.coverage,delivery:'check_sourceDelivery_not_found_count'});if(result.lookup.query)query=result.lookup.query;
          reviewRange={before:result.lookup.before,after:result.lookup.after,types:result.lookup.types};lookups++;continue;
        }
        break;
      }
      if(!result||result.lookup)throw new Error('本次信息整理未能完成，请重试；原始输入已保存');
      let reviewed,discussionExplanation,expressionOptions,optionAdmission,publication;
      {
        const proposal=topicProposals.at(-1);
        if(proposal?.context===context&&this.store.previewTopicPatch){
          const preview=this.store.previewTopicPatch(scope,proposal.patch,topicOptions(proposal));
          if(!current())return;
          if(!preview.valid){
            if(preview.reason!=='inapplicable_optional_proposal'){const error=new Error(preview.detail||preview.reason);error.code='topic_patch_rejected';error.field='topicPatch';throw error;}
            result=withoutInapplicableTopic(result,context);topicProposals.length=0;
            context.manifest.auxiliaryErrors=[...(context.manifest.auxiliaryErrors||[]),{field:'topicPatch',code:preview.reason,message:preview.detail}];
          }
        }
        const primaryContext=context,primaryResult=result,state=primaryOperationFor(result);
        reviewed=context;stagedReview={context,result};
        expressionOptions=[];
        try{optionAdmission=buildOptionAdmission(primaryContext,result.expressionOptions||[],{scope,store:this.store});expressionOptions=optionAdmission.options;}
        catch(error){if(state?.contractVersion==='primary-operation-v2')throw error;receipts.push({status:'rejected',reason:error.message});optionAdmission={options:[],groups:[],sourceRevisions:{}};}
        let admitted;
        if(state?.contractVersion==='primary-operation-v2'&&['prepare_message','advise'].includes(state.operation)){
          admitted=buildAnswerAdmission(primaryContext,result,{scope,requestId,companion,coverage,settings,store:this.store});
          context=admitted;
        }else if(result.draftPlan?.clarification){
          const blocker=result.requestDelivery?.blocker||result.deliveryBlocker;
          result={...result,kind:'question',text:blocker?clarificationBody(blocker):result.draftPlan.clarification};
        }else if(result.draftPlan){
          if(!state?.answer)throw new Error('本次完整候选缺少主调用生成的answer；输入已保留');
          admitted=buildDraftContext(context,result.draftPlan,{scope,requestId,companion,coverage,settings,store:this.store});
          context=admitted;result={...state.answer,...(result.methodIds?{methodIds:result.methodIds}:{})};reviewed=null;
          context.manifest.preparedResponse={owner:'primary_candidate',message:'provided',privateExplanation:result.discussionExplanation?'provided':'absent'};
        }else if(state?.admittedMaterials){admitted={payload:{outboundQuotes:state.admittedMaterials},manifest:primaryContext.manifest};}
        discussionExplanation=result.requestDelivery?.blocker||result.deliveryBlocker?undefined:result.discussionExplanation;
        validateTerminalDelivery(result,requestDeliveryObligation);
        publication=createPublicationSeal({result,expressionOptions,contexts:[...capturedRequests,primaryContext,admitted],optionAdmission,scope,requestId});
        publication.assert(result,expressionOptions);
        assertDraftSourcesCurrent(publication.context,Object.keys(publication.context.manifest.sourceRevisions),{scope,store:this.store});
        assertArtifactInputs(publication.context);
        context.manifest.publicationSeal=publication.receipt;
      }

      const methodIds=(result.methodIds||[]).filter(id=>methodFor(id));
      const generationStages=capturedRequests.filter(request=>request.manifest).map(request=>({stageId:request.manifest.stageId,purpose:request.purpose,
        deliveredMethodRefs:[...new Map([...(request.manifest.methodTrace?.catalog||[]).map(method=>({...method,guidanceLevel:'catalog'})),...(request.manifest.methodTrace?.delivered||[]).map(method=>({...method,guidanceLevel:'full_card'}))].map(method=>[method.id,method])).values()].map(method=>({methodId:method.id,version:method.version,guidanceLevel:method.guidanceLevel})),reportedUsedMethodRefs:request.manifest.methodTrace?.reported?.map(id=>({methodId:id,version:methodFor(id)?.version}))??null}));
      let patchReceipt=null,relationshipReceipt=null,topicReceipt=null;
      const recoveryValue=context.manifest?.responseRecovery,responseRecovery=recoveryValue&&normalizeResponseRecovery(recoveryValue);
      if(requestDelivery)context.manifest.requestDelivery={interpretation:requestDelivery,status:deliveryStatus(requestDelivery,result,{restricted:context.payload.purpose==='draft',committed:false}),...(result.deliveryBlocker||result.requestDelivery?.blocker?{blocker:result.deliveryBlocker||result.requestDelivery.blocker}:{})};
      const validatedPlanDigest=fingerprint({purpose:context.payload.purpose,outboundQuotes:context.payload.outboundQuotes,
        editingReference:context.payload.editingReference,inputArtifactRefs:context.manifest.inputArtifactRefs,
        draftingGuidance:context.payload.draftingGuidance,wordingControls:context.payload.wordingControls,replyFocus:context.payload.replyFocus,
        sourceRevisions:context.manifest.sourceRevisions,replyDisposition:result.replyDisposition});
      if(!this.candidateSession.bindPlan(candidateTicket,validatedPlanDigest))return;
      context.manifest.candidateSession={qqRevision:revision,privateInputSeq:candidateTicket.privateInputSeq,validatedPlanDigest};
      const reply=this.store._atomic(()=>{
        if(!current())return null;
        publication.assert(result,expressionOptions);
        assertDraftSourcesCurrent(publication.context,Object.keys(publication.context.manifest.sourceRevisions),{scope,store:this.store});
        assertArtifactInputs(publication.context);
        const rejectedAux=capturedRequests.flatMap(r=>r.manifest?.auxiliaryErrors||[]);
        const recordRejection=(field,receipt)=>{if(receipt&&receipt.applied===false)rejectedAux.push({field,code:'rejected_auxiliary_metadata',message:String(receipt.detail||receipt.reason||'metadata rejected').slice(0,500)});};
        const topic=topicProposals.at(-1);
        if(topic&&this.store.applyTopicPatch){
          topicReceipt=this.store.applyTopicPatch(scope,topic.patch,topicOptions(topic));
          if(!topicReceipt.applied){const error=new Error(`这次交流方向未能安全更新：${topicReceipt.detail||topicReceipt.reason}；你的输入已保留。`);error.code='topic_patch_rejected';error.field='topicPatch';error.topicReceipt=topicReceipt;throw error;}
        }
        if(relationshipProposals.length&&this.store.applyRelationshipPatch){
          const patch={claims:[],events:[],retire:[]},refs=new Map();
          for(const proposal of relationshipProposals){for(const key of ['claims','events','retire'])patch[key].push(...(proposal.patch[key]||[]));for(const [id,version]of Object.entries(proposal.manifest.sourceRevisions||{}))if(/^(qq|private|note):/.test(id))refs.set(id,version);}
          for(const key of ['claims','events','retire'])patch[key]=[...new Map(patch[key].map(item=>[JSON.stringify(item),item])).values()];
          relationshipReceipt=this.store.queueUnderstandingProposal(scope,patch,{baseRevision,sourceIds:[...refs.keys()],sourceRevisions:Object.fromEntries(refs),requestId});
          if(!relationshipReceipt.queued)recordRejection('relationshipPatch',relationshipReceipt);
        }
        const review=stagedReview;
        if(review&&review.result.kind!=='question'&&(review.result.statePatch||review.result.stateReview==='no_change')){
          patchReceipt=this.store.applyState(scope,review.result.statePatch||{},{baseRevision,baseStateVersion:companion.state.version,baseTopicVersion:topicReceipt?.applied?topicReceipt.topicVersion:companion.topics?.version,
            sourceIds:review.context.manifest.sourceIds,coverage:{complete:review.context.manifest.completeReview,sourceIds:review.context.manifest.sourceIds}});
          recordRejection('statePatch',patchReceipt);
        }
        for(const candidate of experienceProposals){
          const experience=candidate.payload.experienceContext||candidate.payload.experiences||{};
          const allowedSourceIds=candidate.manifest.sourceIds||[];
          const allowedCaseIds=(experience.cases||[]).map(item=>item.id);
          const trace=candidate.manifest.methodTrace||{},operational=new Set(trace.operationalDelivery?.ids||trace.delivered?.map(method=>method.id)||[]);
          const provided=[...(trace.delivered||[]),...(trace.catalog||[])].filter(method=>operational.has(method.id));
          try{this.store.experiences.proposeFromModel(scope,candidate.proposal,{allowedSourceIds,allowedCaseIds,deliveredMethods:[...new Map(provided.map(m=>[m.id,m])).values()]});}
          catch(error){receipts.push({status:'rejected',reason:`经验候选未保存：${error.message}`});rejectedAux.push({field:'experienceProposals',code:'rejected_auxiliary_metadata',message:String(error.message).slice(0,500)});}
        }
        const reviewedSourceIds=new Set();
        if(patchReceipt?.applied)for(const id of stagedReview?.context.manifest.sourceIds||[])reviewedSourceIds.add(id);
        if(topicReceipt?.applied)for(const id of [...(topic?.patch.purposeSourceIds||[]),...(topic?.patch.observationSourceIds||[])])reviewedSourceIds.add(id);
        const live=new Map(this.store._rawMemorySources(scope).map(source=>[source.id,source]));
        const privateReviewed=[...reviewedSourceIds].filter(id=>{const source=live.get(id);return source?.role==='user'&&(source.type==='private'&&source.kind!=='feedback_continue'||source.type==='feedback'&&source.kind==='local'&&!!source.canonicalFeedbackId)}).slice(-64);
        const intentId=feedbackIntentId?`private:feedback-${feedbackIntentId}`:!transient?`private:${turn.id}`:undefined;
        const intent=live.get(intentId);
        const metadataReviewPending=rejectedAux.length&&intent?.role==='user'&&intentId?.startsWith('private:')
          ?{reasonCode:'auxiliary_metadata_rejected',sourceIds:[intentId],sourceRevisions:{[intentId]:intent.revision}}:undefined;
        const privateReviewReceipt=!metadataReviewPending&&responseRecovery?.kind!=='private_help'&&privateReviewed.length?{applied:true,sourceIds:privateReviewed}:undefined;
        publication.assert(result,expressionOptions);
        assertDraftSourcesCurrent(publication.context,Object.keys(publication.context.manifest.sourceRevisions),{scope,store:this.store});
        assertArtifactInputs(publication.context);
        const saved=this.store.appendTurn(scope,{role:'assistant',kind:result.kind,text:result.text,discussionExplanation,requestId,suggestions:result.suggestions,origin:invocation.origin,replyDisposition:result.replyDisposition||(purpose==='reply'&&!result.suggestions?.length?'unavailable':undefined),
          sourceIds:publication.context.manifest.sourceIds,expressionOptions,methodIds,actionReceipts:receipts,generationStages,responseRecovery,privateReviewReceipt,metadataReviewPending,
          artifactMetadata:{generationStages,goalVersion:companion.goal.version,inputArtifactRefs:assertArtifactInputs(publication.context),inputEvidenceLossRefs:[...new Map([...capturedRequests.flatMap(request=>request.manifest?.inputEvidenceLossRefs||[]),...(publication.context.manifest.inputEvidenceLossRefs||[])].map(ref=>[`${ref.lossRef}:${ref.fingerprint}`,ref])).values()],inputSourceRefs:
            Object.entries(publication.context.manifest.sourceRevisions).filter(([sourceId])=>/^(qq|private|note):/.test(sourceId)).map(([sourceId,revision])=>({sourceId,revision})),
            discussionTurnFingerprints:Object.assign({},...capturedRequests.map(request=>({...request.manifest?.discussionCompaction?.turnFingerprints,...Object.fromEntries((request.manifest?.discussionReads||[]).filter(read=>['delivered','partial'].includes(read.delivery?.status)&&read.turnFingerprint).map(read=>[read.turnId,read.turnFingerprint]))}))),model:settings.model,promptVersion:context.payload.promptVersion}});
        if(requestDelivery)context.manifest.requestDelivery.status=deliveryStatus(requestDelivery,result,{restricted:context.payload.purpose==='draft'});
        this.store.saveRun(scope,{id:requestId,baseRevision,purpose:context.payload.purpose,status:'complete',payload:context.payload,manifest:context.manifest,
          requests:capturedRequests,replyId:saved.id,patchReceipt,relationshipReceipt,topicReceipt,actionReceipts:receipts,privateReviewReceipt:saved.privateReviewReceipt,
          auxiliaryErrors:rejectedAux,maintenance:metadataReviewPending?'partial_rejected':patchReceipt?.applied?(stagedReview?.result.statePatch?'applied':'reviewed_no_change'):patchReceipt?'rejected':'deferred'});
        this.usage.finish(scope,budget.id,'complete');return saved;
      });
      if(!reply)return;
      if(purpose==='reply'||reply.kind==='draft'&&reply.suggestions?.length)this.candidateSession.publish(candidateTicket,{scope:this.scope,revision:this.revision,
        reply,planDigest:validatedPlanDigest,messageIds:replyFocusFor(this.store.messages(scope),this.replyMessageIds).messageIds,automaticFingerprint:this.automaticFingerprint()});
      else this.candidateSession.finish(candidateTicket,'private_consultation');
      return reply;
    } catch(error) {
      if(!current()){
        const continuing=this.pendingAssist?.taskId===budget.id||this.activeAssist?.taskId===budget.id&&this.activeAssist.resumes>resumes;
        const task=this.usage.get(scope,budget.id);
        if(!continuing&&task.status==='running')this.usage.finish(scope,budget.id,'cancelled');
        return;
      }
      this.usage.finish(scope,budget.id,'failed',error.code||'assistant_failed');
      this.candidateSession.finish(candidateTicket,'generation_failed');
      this.assistantError=error.message;
      if(context?.manifest?.requestDelivery?.status==='delivered')context.manifest.requestDelivery.status='prepared';
      // A later producer failure does not undo an independently applied user
      // action. An unavailable post-forget context must not revive old inputs.
      this.store.saveRun(scope,{id:requestId,baseRevision,purpose:context?.payload.purpose||purpose,status:'failed',payload:context?.payload||{purpose},manifest:context?.manifest||{scope,requestId,purpose},requests:capturedRequests,
        actionReceipts:receipts.filter(receipt=>receipt.status==='applied'),error:error.message,errorDetails:require('./validation-issues.cjs').failureWitness(error),maintenance:'failed'});
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
