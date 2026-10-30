'use strict';
const {imageContextFor,parseDraftGuidance,requireDraftControlGuidance}=require('../assistant-model.cjs');
const {selectMethods,runtimeCard}=require('../help-methods.cjs');
const {PROMPT_VERSION,METHODS}=require('./shared.cjs');
const {sameScopeIfPresent}=require('./source-snapshot.cjs');
const {contextBudget,finish}=require('./budget-manifest.cjs');
const {projectRecentContext}=require('./policy.cjs');
const {wordingControlsForContext}=require('./wording-controls.cjs');
const {resolveDraftMaterial,assertDraftSourcesCurrent}=require('./draft-material.cjs');
const {resolveEditingReference}=require('./editing-reference.cjs');
function buildDraftContext(prepared, plan, info) {
  if (!sameScopeIfPresent({ scope: prepared.manifest.scope }, info.scope)) throw new Error('当前联系人已变化，请重新组织草稿');
  const settings=info.settings||{model:prepared.manifest.requestModel,assistantRequestBytes:prepared.manifest.requestByteBudget};
  const budget=contextBudget(settings,prepared.manifest.byteBudget,info.requestMeasure);
  const controlRefs=plan?.taskUse!=='different'&&plan?.taskUse!=='uncertain'?prepared.payload.topicContext?.controlRefs||[]:[];
  const byId = new Map([...controlRefs.map(ref=>({id:ref.sourceId,revision:ref.revision})),...prepared.payload.sources].map(s => [s.id, s]));
  const material=resolveDraftMaterial(prepared.payload,plan,{restrictions:prepared.restrictions||prepared.payload.privateRestrictions||[]});
  const quotes=material.quotes;
  const editing=resolveEditingReference(prepared,plan,info);
  assertDraftSourcesCurrent(prepared,material.sourceIds,info);
  const originalOrder=new Map((prepared.fullAvailableSources||prepared.payload.sources).map((source,index)=>[source.id,index]));
  const qq = prepared.payload.sources.filter(s => s.type === 'qq').sort((a,b)=>Date.parse(a.at)-Date.parse(b.at)||(originalOrder.get(a.id)??0)-(originalOrder.get(b.id)??0));
  const selection = selectMethods({ purpose: 'draft' });
  const guidance = parseDraftGuidance(plan.guidance, prepared.payload,{taskUse:plan.taskUse||'continue'});
  requireDraftControlGuidance(guidance,prepared.payload);
  const projectedControls=wordingControlsForContext(prepared,{...info,expressionPlan:plan}),safeWordingControls=projectedControls.controls;
  const style=['natural','short','casual'].includes(projectedControls.style)?projectedControls.style:'natural';
  const payload = { promptVersion: PROMPT_VERSION, purpose: 'draft',
    ...(prepared.payload.requestDeliveryPolicy?{requestDeliveryObligation:{version:1,mode:'editable_message'}}:{}), method: METHODS.draft, methodCards: selection.methods.map(runtimeCard),
    methodSelection: { version: selection.version, candidates: ['compose'], maxApplied: 1 }, style, asOf: prepared.payload.asOf,
    viewerTimeZone:prepared.payload.viewerTimeZone||Intl.DateTimeFormat().resolvedOptions().timeZone,
    ...(editing?{editingReference:editing.reference}:{}),
    outboundQuotes: quotes, sources: [...qq], coverage: prepared.payload.coverage,
    ...(safeWordingControls.items.length?{wordingControls:safeWordingControls}:{}),
    replyFocus: prepared.payload.replyFocus || [],
    presentation: { language: typeof plan.language==='string'&&/^[a-z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/.test(plan.language) ? plan.language : 'zh',
      ...projectedControls.presentation } };
  let draftTaskTextReferences=prepared.payload.taskContext?.sourceTextLocation==='sources';
  let draftRecentMetadata='full';
  const refreshDraftTask=()=>{if(!prepared.payload.taskContext)return;const task=prepared.payload.taskContext,ids=new Map(payload.sources.map(s=>[s.id,s]));
    const recent=task.recentExchange.filter(m=>ids.has(m.sourceId)).map(m=>({...m,...(ids.get(m.sourceId).historicalOnly?{historicalOnly:true}:{}),...(m.quote?{quote:m.quote.sourceId&&!ids.has(m.quote.sourceId)?{availability:'unavailable'}:{...m.quote,...(ids.get(m.quote.sourceId)?.historicalOnly?{historicalOnly:true}:{})}}:{})}));
    const deliveredQQ=payload.sources.filter(source=>source.type==='qq');
    const safeConsultation=task.consultationTask?{focusOrigin:task.consultationTask.focusOrigin,focus:task.consultationTask.focus.filter(item=>ids.has(item.sourceId)).map(item=>({...item,laterAvailableMessageCount:deliveredQQ.length-deliveredQQ.findIndex(source=>source.id===item.sourceId)-1}))}:undefined;
    payload.taskContext={version:task.version,requestOrigin:'restricted_draft',...(task.invocation?{invocation:structuredClone(task.invocation)}:{}),...(task.timeContext?{timeContext:structuredClone(task.timeContext)}:{}),...(safeConsultation?{consultationTask:safeConsultation}:{}),latestActual:task.latestActual&&ids.has(task.latestActual.sourceId)?task.latestActual:null,
      recentExchange:recent,selfMessagesAfterLastContact:task.selfMessagesAfterLastContact.filter(id=>ids.has(id)),contactMessagesAfterLastSelf:task.contactMessagesAfterLastSelf.filter(id=>ids.has(id)),observationCoverage:task.observationCoverage,factsRule:task.factsRule};
    if(task.recentContext&&draftRecentMetadata==='full')payload.taskContext.recentContext=projectRecentContext(task.recentContext,ids);
    else if(task.recentContext&&draftRecentMetadata==='compact')payload.taskContext.recentContext={selection:'bounded_actual_neighborhoods',coverage:'partial_context_window_metadata_omitted_for_budget'};
    if(draftTaskTextReferences){payload.taskContext.sourceTextLocation='sources';for(const item of recent){delete item.text;if(item.quote)delete item.quote.text;}}
  };
  const refreshDraftImages=()=>{if(prepared.payload.imageContext||prepared.mediaContext||prepared.images?.length)
    payload.imageContext=imageContextFor(payload,prepared.images,prepared.mediaContext||prepared.payload.imageContext);};
  refreshDraftTask();
  refreshDraftImages();
  if (guidance && Object.keys(guidance).length) payload.draftingGuidance = { ...guidance,
    authority: 'expression_control_not_message_content',
    instruction: '这些短控制只约束表达任务与用法，不是可发送原文。不要写出控制说明、私下理由或来源标识；保持outboundQuotes授权的意思，askFollowup:false不排除本来要表达的问题。' };
  const controlIds = guidance ? [...new Set([guidance.objective,guidance.allowedApproach,...(guidance.avoidances || []),guidance.currentStep].filter(Boolean).flatMap(item => item.sourceIds))] : [];
  const essentialIds=new Set([...(prepared.essentialSourceIds||qq.map(source=>source.id)),...quotes.map(q=>q.sourceId),...controlIds,...payload.replyFocus.map(id=>`qq:${id}`),...(payload.imageContext?.attached||[]).map(image=>image.sourceId)]);
  const recentPriorityIds=new Set(prepared.manifest.recentQQContext?.admittedPrioritySourceIds||[]);
  for (;;) {
    const kept=new Set(payload.sources.map(source=>source.id));let laterComplete=true;
    for(const source of [...qq].reverse()){
      if(!kept.has(source.id)){laterComplete=false;continue;}
      if(!laterComplete)payload.sources=payload.sources.map(item=>item.id===source.id?{...item,historicalOnly:true,continuationCoverage:'later_messages_omitted'}:item);
    }
    refreshDraftTask();
    refreshDraftImages();
    if(budget.fits(payload))break;
    if(payload.methodCards.length){
      payload.methodCatalog=selection.catalog.map(({id,version})=>({id,version}));
      payload.methodSelection.operationalInstructionsLocation='system';payload.methodCards=[];
      delete payload.methodSelection.selectionRule;delete payload.methodSelection.feedbackRule;continue;
    }
    if(payload.taskContext&&!draftTaskTextReferences){draftTaskTextReferences=true;continue;}
    if(payload.taskContext?.recentContext&&draftRecentMetadata==='full'){draftRecentMetadata='compact';continue;}
    let removable=payload.sources.findIndex(source=>!essentialIds.has(source.id)&&!recentPriorityIds.has(source.id));
    if(removable<0)removable=payload.sources.findIndex(source=>!essentialIds.has(source.id));
    if(removable<0&&draftRecentMetadata==='compact'){draftRecentMetadata='omitted';continue;}
    if(removable<0)throw new Error('当前拟表达内容或最新完整来信超过上下文预算，请分段处理；没有静默截断');
    payload.sources.splice(removable,1);
  }
  // Do not serialize the private request, goal, assistant summary or excluded-source negatives.
  const referencedSources=[...new Set([...material.sourceIds, ...controlIds])].map(id=>({id,revision:byId.get(id)?.revision}))
    .concat(projectedControls.sourceRefs.map(ref=>({id:ref.sourceId,revision:ref.revision})));
  const uniqueSources = entries => [...new Map(entries.map(source => [source.id, source])).values()];
  const safeSources=uniqueSources([...payload.sources,...referencedSources]),allSafeSources=uniqueSources([...qq,...referencedSources]);
  const context=finish(payload,safeSources,info,allSafeSources,prepared.manifest.byteBudget,budget);
  if(editing)context.manifest.inputArtifactRefs=[editing.dependency];
  context.manifest.disclosureBindings=material.bindings.map(binding=>({...binding,scope:{...info.scope}}));
  context.manifest.taskBinding={use:plan.taskUse||'continue',topicId:prepared.payload.topicContext?.active?.id||null,topicVersion:prepared.payload.topicContext?.active?.version||null,controlRefs:controlRefs.filter(ref=>controlIds.includes(ref.sourceId))};
  context.manifest.wordingControlEvidence={sourceRefs:projectedControls.sourceRefs,preferenceRefs:projectedControls.preferenceRefs};
  if(prepared.images)context.images=structuredClone(prepared.images);
  if(prepared.mediaContext||prepared.payload.imageContext)context.mediaContext={mode:payload.imageContext.mode,omitted:structuredClone(payload.imageContext.omitted)};
  context.essentialSourceIds=[...essentialIds];
  Object.defineProperty(context,'rebuildForRequest',{value:measure=>buildDraftContext(prepared,plan,{...info,requestMeasure:measure})});
  return context;
}
function expressionOptionsFor(context, options = []) {
  if (!Array.isArray(options) || options.length > 3) throw new Error('表达方向最多三项');
  return options.map(option => {
    if (!option || typeof option.label !== 'string' || !option.label.trim() || option.label.length > 300 || !Array.isArray(option.quotes) || !option.quotes.length || option.quotes.length > 8)
      throw new Error('表达方向必须带有可核对的原话');
    const quotes = option.quotes.map(q => {
      const source = context.payload.sources.find(s => s.id === q.sourceId);
      if (!source || !['private','note','qq'].includes(source.type) || typeof q.text !== 'string' || !q.text.trim() || !source.text.includes(q.text)) throw new Error('表达方向引用的来源无效');
      if (source.type === 'note' && source.use !== 'draft') throw new Error('私下素材不能作为可直接分享的方向');
      if ((context.restrictions || context.payload.privateRestrictions || []).some(r => r.text?.length > 2 && q.text.length > 2 && (r.text.includes(q.text) || q.text.includes(r.text)))) throw new Error('表达方向包含仅供私下的内容');
      // A generated direction retains its original tuple, never an enduring
      // permission decision. A later model selection must rebind evidence.
      return { sourceId: q.sourceId, text: q.text, revision: source.revision };
    });
    return { label: option.label, quotes, style: ['short','casual'].includes(option.style) ? option.style : 'natural' };
  });
}
module.exports={buildDraftContext,expressionOptionsFor};
