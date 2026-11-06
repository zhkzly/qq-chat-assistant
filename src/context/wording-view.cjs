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
const {buildMaterialProvenance}=require('./material-provenance.cjs');
const {buildCurrentHumanControl,currentFactQuotes}=require('./current-human-control.cjs');
const {boundedSource,deliveredEvidenceMap}=require('./source-delivery.cjs');
const {validationError}=require('../validation-issues.cjs');
const {buildSelectedDirectionControl}=require('./selected-direction-control.cjs');
function buildDraftContext(prepared, plan, info) {
  if (!sameScopeIfPresent({ scope: prepared.manifest.scope }, info.scope)) throw new Error('当前联系人已变化，请重新组织草稿');
  const settings={...(info.settings||{model:prepared.manifest.requestModel,assistantRequestBytes:prepared.manifest.requestByteBudget}),sourceHandleOwner:info.settings?.sourceHandleOwner||prepared.sourceHandleOwner};
  const sourceReferenceRevisions=prepared.sourceReferenceRevisions||prepared.manifest.sourceRevisions;
  const budget=contextBudget(settings,prepared.manifest.byteBudget,info.requestMeasure,{sourceRevisions:sourceReferenceRevisions});
  const controlRefs=plan?.taskUse!=='different'&&plan?.taskUse!=='uncertain'?prepared.payload.topicContext?.controlRefs||[]:[];
  const byId = new Map([...controlRefs.map(ref=>({id:ref.sourceId,revision:ref.revision})),...prepared.payload.sources].map(s => [s.id, s]));
  const material=resolveDraftMaterial(prepared.payload,plan,{restrictions:prepared.restrictions||prepared.payload.privateRestrictions||[],evidence:deliveredEvidenceMap(prepared,info)});
  const human=buildCurrentHumanControl(prepared,info);
  const selectedDirection=buildSelectedDirectionControl(prepared,info);
  const provenance=buildMaterialProvenance(prepared,material.quotes,info),quotes=provenance.quotes;
  const dependencyRevisions=Object.fromEntries([...provenance.dependencies,...human.dependencies].map(ref=>[ref.sourceId,ref.revision]));
  const editing=resolveEditingReference(prepared,plan,info);
  assertDraftSourcesCurrent({...prepared,manifest:{...prepared.manifest,sourceRevisions:{...prepared.manifest.sourceRevisions,...dependencyRevisions}}},[...new Set([...material.sourceIds,...Object.keys(dependencyRevisions)])],info);
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
    ...(human.control?{currentHumanControl:human.control}:{}),
    ...(selectedDirection.control?{selectedDirectionControl:selectedDirection.control}:{}),
    ...((safeWordingControls.items.length||safeWordingControls.scoped?.length)?{wordingControls:safeWordingControls}:{}),
    replyFocus: prepared.payload.replyFocus || [],
    presentation: { language: typeof plan.language==='string'&&/^[a-z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/.test(plan.language) ? plan.language : 'zh',
      ...projectedControls.presentation } };
  let draftTaskTextReferences=prepared.payload.taskContext?.sourceTextLocation==='sources';
  let draftRecentMetadata='full';
  const degradation=[...(prepared.manifest.degradation||[])];
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
    authority: 'GENERATED_PROPOSAL',
    instruction: '这是规划模型的派生提议，不证明用户选择、事实或问题前提。根据实际QQ与获准素材校正不受支持的动作或问题；功能、可能性和意愿不能冒充已参与、已约定或已发生。以currentHumanControl整段原话理解本轮动作、力度、条件和否定，保持用户实际明确的问题或邀请。CONTROL_ONLY通道本身不新增外发事实或许可；同一事实若另在outboundQuotes中独立获准仍可用，未获准的私下事实/理由不可转入话语。只选相关获准事实，同一意思表达一次，不逐段复述提议与素材。' };
  const controlIds = guidance ? [...new Set([guidance.objective,guidance.allowedApproach,...(guidance.avoidances || []),guidance.currentStep].filter(Boolean).flatMap(item => item.sourceIds))] : [];
  const essentialIds=new Set([...(prepared.essentialSourceIds||qq.map(source=>source.id)),...quotes.map(q=>q.sourceId),...controlIds,...payload.replyFocus.map(id=>`qq:${id}`),...(payload.imageContext?.attached||[]).map(image=>image.sourceId)]);
  const recentPriorityIds=new Set(prepared.manifest.recentQQContext?.admittedPrioritySourceIds||[]);
  let proposalOmitted=false;
  for (;;) {
    const kept=new Set(payload.sources.map(source=>source.id));let laterComplete=true;
    for(const source of [...qq].reverse()){
      if(!kept.has(source.id)){laterComplete=false;continue;}
      if(!laterComplete)payload.sources=payload.sources.map(item=>item.id===source.id?{...item,historicalOnly:true,continuationCoverage:'later_messages_omitted'}:item);
    }
    refreshDraftTask();
    refreshDraftImages();
    if(budget.fits(payload))break;
    if(payload.draftingGuidance){delete payload.draftingGuidance;proposalOmitted=true;continue;}
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
    if(removable<0){
      // Draft-floor sources degrade to explicit marked ranges (never silent
      // slices) before any rejection; approved outbound quotes stay verbatim.
      const shrinkable=payload.sources.find(source=>Buffer.byteLength(JSON.stringify(source),'utf8')>400);
      if(shrinkable){
        const original=(prepared.fullAvailableSources||[]).find(source=>source.id===shrinkable.id)||shrinkable;
        const cap=Math.max(200,Math.floor(Buffer.byteLength(JSON.stringify(shrinkable),'utf8')*0.5));
        const projected=boundedSource(original,{start:0,maxBytes:cap});
        if(projected&&Buffer.byteLength(JSON.stringify(projected),'utf8')<Buffer.byteLength(JSON.stringify(shrinkable),'utf8')){
          payload.sources=payload.sources.map(item=>item.id===shrinkable.id?projected:item);
          degradation.push({step:'ranged_excerpt',appliedTo:shrinkable.id,
            recoveredBytes:Buffer.byteLength(JSON.stringify(shrinkable),'utf8')-Buffer.byteLength(JSON.stringify(projected),'utf8'),
            remainingNeed:0,lookupHandle:projected.delivery?.lookup});
          continue;
        }
      }
      throw new Error('当前拟表达内容或最新完整来信超过上下文预算，请分段处理；没有静默截断');
    }
    payload.sources.splice(removable,1);
  }
  // Only the bound current-human control lane may carry current private text.
  // Historical private bodies, goals and excluded-source negatives stay out.
  const referencedSources=[...new Set([...material.sourceIds, ...controlIds])].map(id=>({id,revision:byId.get(id)?.revision}))
    .concat(projectedControls.sourceRefs.map(ref=>({id:ref.sourceId,revision:ref.revision})));
  const uniqueSources = entries => [...new Map(entries.map(source => [source.id, source])).values()];
  const safeSources=uniqueSources([...payload.sources,...referencedSources]),allSafeSources=uniqueSources([...qq,...referencedSources]);
  const context=finish(payload,safeSources,info,allSafeSources,prepared.manifest.byteBudget,budget);
  if(degradation.length)context.manifest.degradation=degradation;
  // Root metadata does not deliver root bodies. Keep full dependencies only
  // in canonical private revision fences/artifact input references.
  Object.assign(context.manifest.sourceRevisions,dependencyRevisions);
  context.manifest.materialProvenance={version:1,dependencyCount:provenance.dependencies.length,rootMetadataLimit:8};
  if(human.control)context.manifest.currentHumanControl={version:1,authority:'CONTROL_ONLY',sourceId:human.control.sourceId,revision:dependencyRevisions[human.control.sourceId],localOriginalComplete:human.control.localOriginalComplete,producerDelivery:human.control.producerDelivery};
  context.manifest.compositionProposal={authority:'GENERATED_PROPOSAL',status:proposalOmitted?'omitted_for_budget':payload.draftingGuidance?'provided':'absent'};
  if(editing||selectedDirection.dependency)context.manifest.inputArtifactRefs=[...(editing?[editing.dependency]:[]),...(selectedDirection.dependency?[selectedDirection.dependency]:[])];
  if(selectedDirection.control)context.manifest.selectedDirectionControl=structuredClone(prepared.manifest.selectedDirectionControl);
  if(material.ignoredAuthorizations?.length)context.manifest.ignoredMaterialAuthorizations=structuredClone(material.ignoredAuthorizations);
  context.manifest.disclosureBindings=material.bindings.map(binding=>({...binding,scope:{...info.scope}}));
  context.manifest.taskBinding={use:plan.taskUse||'continue',topicId:prepared.payload.topicContext?.active?.id||null,topicVersion:prepared.payload.topicContext?.active?.version||null,controlRefs:controlRefs.filter(ref=>controlIds.includes(ref.sourceId))};
  context.manifest.wordingControlEvidence={sourceRefs:projectedControls.sourceRefs,preferenceRefs:projectedControls.preferenceRefs};
  if(prepared.images)context.images=structuredClone(prepared.images);
  if(prepared.mediaContext||prepared.payload.imageContext)context.mediaContext={mode:payload.imageContext.mode,omitted:structuredClone(payload.imageContext.omitted)};
  Object.defineProperty(context,'sourceReferenceRevisions',{value:sourceReferenceRevisions});
  Object.defineProperty(context,'sourceHandleOwner',{value:prepared.sourceHandleOwner||settings.sourceHandleOwner,writable:true,configurable:true});
  context.essentialSourceIds=[...essentialIds];
  Object.defineProperty(context,'rebuildForRequest',{value:measure=>buildDraftContext(prepared,plan,{...info,requestMeasure:measure})});
  return context;
}
function buildOptionAdmission(context,options=[],info={}) {
  if(!Array.isArray(options)||options.length>3)throw validationError('expressionOptions','option_shape_invalid','At most three concrete expression directions may be offered');
  const revisions={},groups=[];
  const captured=new Map((context.fullAvailableSources||context.payload.sources||[]).map(source=>[source.id,source]));
  const result=options.map((option,index)=>{
    const field=`expressionOptions[${index}]`;
    if(!option||typeof option!=='object'||Array.isArray(option)||Object.keys(option).some(key=>!['label','style','quotes','currentFacts'].includes(key))||typeof option.label!=='string'||!option.label.trim()||option.label.length>300)
      throw validationError(field,'option_shape_invalid','A direction needs a bounded label and only its own optional fact declarations');
    const quotes=option.quotes===undefined?[]:option.quotes;
    if(!Array.isArray(quotes)||quotes.length>8)throw validationError(field+'.quotes','answer_material_limit','Each option allows at most eight currentFacts and historical quotes combined');
    let material;
    if(context.primaryFrameSnapshot||option.currentFacts!==undefined){
      try{material=resolveAnswerMaterial(context,{currentFacts:option.currentFacts,materials:quotes},info);}
      catch(error){
        const path=value=>value.replace(/^materials(?=\[|$)/,'quotes').replaceAll('currentFacts and materials','option currentFacts and quotes');
        if(error.field)error.field=field+'.'+path(error.field);
        if(error.issues)error.issues=error.issues.map(issue=>({...issue,path:field+'.'+path(issue.path),message:path(issue.message)}));
        error.message=field+': '+path(error.message);throw error;
      }
    }else{
      // Direct legacy readers still accept their already-canonical tuples.
      for(const quote of quotes){
        const source=captured.get(quote?.sourceId);
        if(!source||!['private','note','qq'].includes(source.type)||typeof quote.text!=='string'||!quote.text.trim()||!source.text.includes(quote.text)||source.type==='note'&&source.use!=='draft')
          throw validationError(field+'.quotes','answer_material_invalid','The legacy direction quote must still match its live permitted source');
        if((context.restrictions||context.payload.privateRestrictions||[]).some(r=>r.text?.length>2&&(quote.text.includes(r.text)||r.text.includes(quote.text))))throw validationError(field+'.quotes','answer_material_invalid','The direction contains private-only material');
      }
      material={quotes,sourceIds:quotes.map(quote=>quote.sourceId)};
    }
    const provenance=buildMaterialProvenance(context,material.quotes,{scope:info.scope||context.manifest.scope});
    for(const id of material.sourceIds||[]){const source=captured.get(id);if(!source)throw validationError(field,'answer_material_invalid','Option evidence is unavailable');revisions[id]=source.revision;}
    for(const dependency of provenance.dependencies)revisions[dependency.sourceId]=dependency.revision;
    const tuples=material.quotes.map(quote=>({sourceId:quote.sourceId,text:quote.text,revision:captured.get(quote.sourceId).revision}));
    groups.push({index,fragments:tuples});
    return {label:option.label,quotes:tuples,style:['short','casual'].includes(option.style)?option.style:'natural'};
  });
  if(Object.keys(revisions).length)assertDraftSourcesCurrent({manifest:{sourceRevisions:revisions}},Object.keys(revisions),{...info,scope:info.scope||context.manifest.scope});
  return {options:result,groups,sourceRevisions:revisions};
}
function expressionOptionsFor(context,options=[],info={}) {return buildOptionAdmission(context,options,info).options;}

function resolveAnswerMaterial(prepared,declaration={},info={}){
 const payload=prepared.payload||prepared;
 const materials=declaration.materials===undefined?[]:declaration.materials;
 if(!Array.isArray(materials)||materials.length>8)throw validationError('materials','answer_material_invalid','materials must be at most eight actually used private fact fragments');
 const currentId=payload.intentAuthority?.sourceId,byId=new Map((payload.sources||[]).map(source=>[source.id,source]));
 for(const [index,quote]of materials.entries())if(quote?.sourceId===currentId||byId.get(quote?.sourceId)?.type==='qq')throw validationError(`materials[${index}]`,'answer_material_scope_invalid','Public QQ needs no material selector; current human facts use exact currentFacts spans, not the instruction as outward material');
 const privateEvidenceOnly=declaration.requestDelivery?.mode==='private_help'&&!declaration.suggestions?.length&&!declaration.draftPlan;
 const current=currentFactQuotes(prepared,declaration.currentFacts,{...info,privateEvidenceOnly});
 if(materials.length+current.length>8)throw validationError('materials','answer_material_limit','currentFacts and materials together allow at most eight actually used private fact fragments');
 try{return resolveDraftMaterial(payload,{quotes:[...materials,...current],intent:'reply'},{explicitCurrentPermission:true,reportedOnly:true,allowEmpty:true,restrictions:prepared.restrictions||payload.privateRestrictions||[],evidence:deliveredEvidenceMap(prepared,info),privateEvidenceOnly});}
 catch(error){
  const path=value=>value.replace(/draftPlan\.quotes\[(\d+)\]/g,(_match,index)=>Number(index)<materials.length?`materials[${index}]`:`currentFacts[${Number(index)-materials.length}]`).replaceAll('draftPlan.quotes','materials');
  if(error.field)error.field=path(error.field);if(error.issues)error.issues=error.issues.map(issue=>({...issue,path:path(issue.path),message:path(issue.message)}));error.message=path(error.message);throw error;
 }
}
function buildAnswerAdmission(prepared,declaration={},info={}){
 const scope=info.scope||prepared.manifest.scope;
 if(!sameScopeIfPresent({scope:prepared.manifest.scope},scope))throw new Error('Answer admission scope changed');
 const material=resolveAnswerMaterial(prepared,declaration,{...info,scope}),human=buildCurrentHumanControl(prepared,{...info,scope}),selected=buildSelectedDirectionControl(prepared,{...info,scope});
 const provenance=buildMaterialProvenance(prepared,material.quotes,{scope}),editing=resolveEditingReference(prepared,{editingReference:declaration.editingReference,editingReferenceBinding:declaration.editingReferenceBinding},{...info,scope});
 const controls=wordingControlsForContext(prepared,{...info,scope});
 const dependencies=Object.fromEntries([...provenance.dependencies,...human.dependencies,...controls.sourceRefs].map(ref=>[ref.sourceId,ref.revision]));
 const revisions={...prepared.manifest.sourceRevisions,...dependencies};
 assertDraftSourcesCurrent({manifest:{sourceRevisions:revisions}},Object.keys(revisions),{...info,scope});
 return {payload:{purpose:'answer_admission',promptVersion:PROMPT_VERSION,asOf:prepared.payload.asOf,
   sources:prepared.payload.sources.filter(source=>source.type==='qq'),outboundQuotes:material.privateEvidenceOnly?[]:provenance.quotes,
   ...(material.privateEvidenceOnly?{privateEvidence:provenance.quotes}:{}),
   ...(human.control?{currentHumanControl:human.control}:{}),...(selected.control?{selectedDirectionControl:selected.control}:{}),
   ...(editing?{editingReference:editing.reference}:{}),...((controls.controls.items.length||controls.controls.scoped?.length)?{wordingControls:controls.controls}:{})},
  manifest:{requestId:info.requestId||prepared.manifest.requestId,scope:{...scope},purpose:'answer_admission',promptVersion:PROMPT_VERSION,
   sourceIds:Object.keys(revisions).filter(id=>!id.startsWith('request:')),sourceRevisions:revisions,contextRevision:prepared.manifest.contextRevision,
   inputArtifactRefs:[...(editing?[editing.dependency]:[]),...(selected.dependency?[selected.dependency]:[])],
   currentHumanControl:human.control?{version:1,authority:'CONTROL_ONLY',sourceId:human.control.sourceId,revision:revisions[human.control.sourceId],localOriginalComplete:human.control.localOriginalComplete,producerDelivery:human.control.producerDelivery}:undefined,
   disclosureBindings:material.bindings,materialProvenance:{version:1,dependencyCount:provenance.dependencies.length},
   wordingControlEvidence:{sourceRefs:controls.sourceRefs,preferenceRefs:controls.preferenceRefs},
   preparedResponse:{owner:'primary_answer',message:declaration.suggestions?.length?'provided':'absent',privateExplanation:declaration.discussionExplanation?'provided':'absent',
    privateBodyOwner:declaration.kind==='draft'?'answer.privateExplanation':'text'}}};
}
module.exports={buildDraftContext,expressionOptionsFor,buildOptionAdmission,resolveAnswerMaterial,buildAnswerAdmission};
