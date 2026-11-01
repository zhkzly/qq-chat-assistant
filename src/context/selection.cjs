'use strict';
const {redact}=require('../model.cjs');
const {imageContextFor}=require('../assistant-model.cjs');
const {runtimeCard}=require('../help-methods.cjs');
const {bytes,sanitize,pick,digest}=require('./shared.cjs');
const {supportedByAvailable,sameScopeIfPresent}=require('./source-snapshot.cjs');
const {modelTopic,relevantTo,projectActualActions,projectObservations,actionSources,coreCatalog}=require('./catalog.cjs');
const {quoteTarget}=require('./policy.cjs');
const {boundedSource,sourceDeliveryManifest,rangedDelivery,completeBody}=require('./source-delivery.cjs');
const {taskContext}=require('./timeline-view.cjs');
const {trimEmptyNavigation}=require('./budget-manifest.cjs');
const {digestSource}=require('./evidence-digest.cjs');
const {LOSS_RULE}=require('../activity-evidence.cjs');
const {holderBasis}=require('../speaker-identity.cjs');

function selectPlanningContext({options,snapshot,candidates,view,budget,coreInventory,projectPlanningViews,reconcilePlanningViews,compactPlanningViews}){
  const {scope,records,companion,turn,purpose='discussion',coverage,memoryResult,memoryIndex=[],retrievedSources=[],
    sourceTurnIds=[],replyMessageIds=[],images,mediaContext,relationshipContext=null,experienceContext=null,
    generationOrigin='private_discussion',viewerTimeZone,invocation,sourceLookupIds=[],feedbackTargets=[],
    allowExperienceProposals=purpose==='review',responsePreference}=options;
  const {all,byId,current,actualById}=snapshot;
  const {payload,state,methodSelection,restrictions}=view;
  const fits=budget.fits;
  const asOf=payload.asOf;
  const {selected,automaticTurn,eligibleTurns,explicitTurnIds,inRecentWindow,validQQ,foldedPrivateIds,essentialIds,recentPlan,timeSegments,timeCandidateIds,timePriorityIds,recentPrivateIds,reviewing,privateRequest,relevantRecord,queryText,protectedPendingIds,selectedProposal,proposals,intentSource,topicView,compacted,coveredTurnIds,candidatePool,preferredCandidateTurnIds}=candidates;
  let recentContextPlan=null;const recentPriorityIds=new Set(),recentAdmissions=[],privatePriorityIds=new Set(),requiredPrivateTurnIds=new Set();
  // Explainable degradation ledger: every ladder step applied to this request
  // is recorded with what it touched, what it recovered, the remaining need
  // and the lookup handle that still reaches the complete original.
  const degradation=[];const recordDegradation=(step,appliedTo,recoveredBytes,lookup)=>{
    degradation.push({step,appliedTo,recoveredBytes,remainingNeed:Math.max(0,bytes(payload)-(options.byteBudget||48000)),...(lookup?{lookupHandle:lookup}:{})});
  };
  let taskTextReferences=true,compactedPlanningViews=false,humanContextView=true;const priorDirectionIds=new Set();
  const explicitLookupRequests=[...retrievedSources,...sourceLookupIds.map(id=>({id:id.startsWith('private:')?id:`private:${id}`})).filter(source=>!retrievedSources.some(item=>item.id===source.id))];
  const explicitLookupIds=[...new Set(explicitLookupRequests.map(source=>source.id))];
  const discoveryPriorityIds=new Set(),sourceOrder=new Map(all.map((source,index)=>[source.id,index]));
  const refresh = () => {
    // Eligibility is part of the measured offer, not a late discount after a
    // source has already lost its admission trial to an inflated menu.
    let laterQQ=true;
    for(const message of [...validQQ].reverse()){
      const id=`qq:${message.messageId}`,source=selected.get(id);
      if(!source){laterQQ=false;continue;}
      const {historicalOnly,continuationCoverage,...body}=source;
      selected.set(id,laterQQ?{...body,...(rangedDelivery(source)?{continuationCoverage:'source_body_partial'}:{})}:{...body,historicalOnly:true,continuationCoverage:'later_messages_omitted'});
      if(rangedDelivery(source))laterQQ=false;
    }
    let laterPrivate=true;
    for(const original of all.filter(source=>source.type==='private'||source.type==='feedback').reverse()){
      if(original.kind==='feedback_continue'&&intentSource.type==='feedback'&&selected.get(intentSource.id)?.revision===intentSource.revision&&selected.get(intentSource.id)?.delivery?.status!=='partial')continue;
      const source=selected.get(original.id);if(!source){laterPrivate=false;continue;}
      const {historicalOnly,continuationCoverage,...body}=source;
      selected.set(original.id,laterPrivate?{...body,...(rangedDelivery(source)?{continuationCoverage:'source_body_partial'}:{})}:{...body,historicalOnly:true,continuationCoverage:'later_private_sources_omitted'});
      if(rangedDelivery(source))laterPrivate=false;
    }
    payload.sources = [...selected.values()].sort((a,b)=>(sourceOrder.get(a.id)??Number.MAX_SAFE_INTEGER)-(sourceOrder.get(b.id)??Number.MAX_SAFE_INTEGER)); payload.allowedMaterialIds=payload.sources.filter(s=>s.type==='note'&&s.use==='draft').map(s=>s.id);
    // The current request lane mirrors its delivered source view. When the
    // request body itself is range-delivered, the payload never carries a
    // second, silently-whole copy: the range and its continuation handle are
    // disclosed on both views and the undelivered remainder stays unknown.
    if(payload.userRequest){
      const requestSource=selected.get(payload.userRequest.sourceId);
      if(requestSource)payload.userRequest={sourceId:requestSource.id,text:requestSource.text,
        ...(requestSource.digest?{digest:requestSource.digest}:{}),
        ...(requestSource.delivery?{delivery:requestSource.delivery,requestDeliveryRule:'range_delivered_request_body; undelivered parts are unknown, continue via delivery.lookup, never fabricate them'}:{})};
    }
    if(payload.consultationSupport){payload.consultationSupport.sourceIds=payload.consultationSupport.sourceIds.filter(id=>selected.has(id));if(!payload.consultationSupport.sourceIds.length)delete payload.consultationSupport;}
    if(explicitLookupIds.length)payload.evidenceDelivery={version:'source-delivery-v1',explicitLookups:sourceDeliveryManifest(all,payload.sources,explicitLookupRequests).explicitLookups};
    for(const entry of payload.retrievedDiscussion||[])if(entry.role==='user'){const source=selected.get(entry.sourceId);entry.availability=source?source.delivery?.status||'delivered':'needs_lookup';if(source)entry.revision=source.revision;}
    if(payload.memoryDiscovery){
      const directory=options.memoryDiscovery?.directory,originals=Array.isArray(directory)?directory:directory?.items||directory?.entries||[];
      for(const entry of payload.memoryDiscovery.directory){
        const original=originals.find(item=>item.id===entry.id),text=original?.text;
        const duplicate=text&&(entry.sourceIds||[]).find(id=>selected.get(id)?.text===text||entry.kind==='raw_source'&&selected.get(id)?.text.startsWith(text));
        if(duplicate){delete entry.text;entry.textFromSource=duplicate;}else{delete entry.textFromSource;if(text)entry.text=redact(text);}
      }
      const ids=[...new Set([...discoveryPriorityIds,...(options.memoryDiscovery?.sources||[]).map(source=>source.id)])];
      payload.memoryDiscovery.candidateSourceCount=ids.length;
      payload.memoryDiscovery.delivery=ids.slice(0,8).map(sourceId=>({sourceId,status:selected.has(sourceId)?selected.get(sourceId).delivery?.status||'delivered':'omitted'}));
      if(ids.length>8)payload.memoryDiscovery.omittedDeliveryEntryCount=ids.length-8;
    }
    reconcilePlanningViews(payload);
    payload.deferredContext.qqSourceCount=all.filter(s=>s.type==='qq'&&!selected.has(s.id)).length;
    payload.deferredContext.privateTurnCount=eligibleTurns.filter(t=>t.id!==turn.id&&!payload.privateConversation.some(entry=>entry.id===t.id)).length;
    payload.deferredContext.relationshipClaimCount=(relationshipContext?.claims||[]).length-(payload.relationshipContext?.claims||[]).length;
    const omittedRecentQQ=[...timeCandidateIds].filter(id=>!selected.has(id)).length,omittedRecentPrivate=[...recentPrivateIds].filter(id=>!selected.has(id)&&!foldedPrivateIds.has(id)).length;
    if(omittedRecentQQ)payload.deferredContext.recentQQSourceCount=omittedRecentQQ;else delete payload.deferredContext.recentQQSourceCount;
    if(omittedRecentPrivate)payload.deferredContext.recentPrivateSourceCount=omittedRecentPrivate;else delete payload.deferredContext.recentPrivateSourceCount;
    if(mediaContext || images?.length)payload.imageContext=imageContextFor(payload,images||[],mediaContext);
    payload.methodSelection.candidates=[...new Set([...(payload.methodCatalog||[]).map(m=>m.id),...payload.methodCards.map(m=>m.id)])];
    if(options.methodLookupIds?.length)payload.methodSelection.lookupDelivery=options.methodLookupIds.map(id=>({id,status:payload.methodCards.some(card=>card.id===id)?'delivered':'omitted_for_budget'}));
    if(payload.topicContext.active)payload.topicContext.active.sourceAvailability=!payload.topicContext.active.omittedSourceRefCount&&payload.topicContext.active.sourceIds.every(id=>completeBody(selected.get(id)))?'delivered':'lookup_required';
    payload.replyFocus=replyMessageIds.filter(id=>selected.has(`qq:${id}`));
    payload.taskContext=taskContext({records,sources:payload.sources,scope,coverage,generationOrigin,currentSourceId:current.id,responsePreference,recentContextPlan,asOf:payload.asOf,viewerTimeZone,invocation,purpose,replyMessageIds});
    const recentHumanContext=humanContextView?eligibleTurns.filter(entry=>entry.role==='user'&&entry.id!==turn.id).slice(-3).flatMap(entry=>{
      const source=selected.get(`private:${entry.id}`);return source&&completeBody(source)?[{sourceId:source.id,at:source.at,role:'user',bodyLocation:'sources',...(priorDirectionIds.has(source.id)?{status:'needs_current_interpretation'}:{})}]:[];
    }):[];
    if(recentHumanContext.length)payload.taskContext.recentHumanContext=recentHumanContext;
    const recentHumanIds=new Set(recentHumanContext.map(reference=>reference.sourceId));
    const priorHumanDirections=[...priorDirectionIds].filter(id=>!recentHumanIds.has(id)).flatMap(id=>{
      const source=selected.get(id);return source&&completeBody(source)?[{sourceId:id,at:source.at,role:'user',bodyLocation:'sources',status:'needs_current_interpretation'}]:[];
    });
    if(priorHumanDirections.length)payload.taskContext.priorHumanDirections=priorHumanDirections;
    payload.taskContext.draftControlPolicy={version:1,required:true,requiredFields:['objective','allowedApproach','avoidances'],intentSourceId:intentSource.id};
    if(taskTextReferences){
      payload.taskContext.sourceTextLocation='sources';
      for(const item of payload.taskContext.recentExchange){delete item.text;if(item.quote)delete item.quote.text;}
    }
    const feedbackSourceIds = (payload.feedbackTargets || []).filter(item => !item.missing && selected.get(item.feedback.sourceId)?.type === 'feedback').map(item => item.feedback.sourceId);
    payload.experienceProposalPolicy = { enabled: allowExperienceProposals === true && feedbackSourceIds.length > 0, maxItems: 2,
      feedbackSourceIds: allowExperienceProposals ? feedbackSourceIds : [], caseIds: allowExperienceProposals ? (payload.experienceContext?.cases || []).map(item => item.id) : [] };
    if (payload.pendingPrivateReview) for (const ref of payload.pendingPrivateReview.refs) {
      ref.availability = selected.has(ref.sourceId) ? rangedDelivery(selected.get(ref.sourceId))?'partial':'full' : 'needs_lookup';
      if (ref.type === 'feedback') {
        const evaluated = payload.feedbackTargets?.find(item => item.feedback.sourceId === ref.sourceId);
        ref.targetAvailability = evaluated && !evaluated.missing && evaluated.target.body ? 'full' : 'needs_lookup';
      }
    }
    if(compactedPlanningViews)trimEmptyNavigation(payload);
  };
  refresh();
  // A large derived state cannot make a small explicit request unusable. Drop
  // complete low-priority entries, recording the omission, never cutting text.
  for (const key of ['items']) state[key] = [...(state[key] || [])];
  const trimStateNavigation = () => {
    // Keep each original body intact in sources. Under pressure, chronology
    // points to that body instead of serializing the same QQ text twice.
    if(!fits(payload)&&!taskTextReferences){taskTextReferences=true;refresh();}
    if(!fits(payload)&&humanContextView){humanContextView=false;refresh();}
    for (const key of ['items']) while (!fits(payload) && state[key].length) { state[key].pop(); payload.omittedStateEntries++; }
    // Move the canonical operations to the measured system channel under
    // payload pressure; this is relocation, never a title-only help request.
    if(!fits(payload)&&payload.methodCatalog.some(method=>method.instruction)){
      payload.methodCatalog=payload.methodCatalog.map(({id})=>({id}));
      payload.methodSelection.operationalInstructionsLocation='system';
      delete payload.methodSelection.selectionRule;delete payload.methodSelection.feedbackRule;refresh();
    }
    // Directory metadata yields before direct evidence. Full method cards are
    // separately retrievable, so omitting complete descriptive fields cannot
    // turn a partial directory entry into an operational method instruction.
    if(!fits(payload)&&payload.methodCatalog.some(method=>method.applicability)){
      payload.methodCatalog=payload.methodCatalog.map(({applicability,...method})=>method);
      payload.methodSelection.catalogProjection='names_and_ids';refresh();
    }
    if(!fits(payload)&&payload.methodCatalog.some(method=>method.name)){
      payload.methodCatalog=payload.methodCatalog.map(({name,...method})=>method);
      payload.methodSelection.catalogProjection='lookup_ids';refresh();
    }
    // A catalog shares its canonical version with methodSelection. Do not send
    // that identical version string once per card under payload pressure.
    if(!fits(payload)&&payload.methodCatalog.some(method=>method.version)){
      payload.methodCatalog=payload.methodCatalog.map(({version,...method})=>method);refresh();
    }
  };
  trimStateNavigation();
  // Optional prior context cannot make the exact current request unusable.
  for(const entry of payload.retrievedDiscussion||[])if(!fits(payload)&&entry.role==='assistant'&&entry.text){
    delete entry.text;entry.availability='needs_lookup';entry.delivery.status='omitted';entry.delivery.lookup.offset=entry.delivery.requestedRange.offset;entry.deliveredFields=[];refresh();
  }
  for(const id of [...selected.keys()])if(!fits(payload)&&!essentialIds.has(id)){selected.delete(id);refresh();}
  // The request is exact; oversized direct evidence receives explicitly marked
  // ranges. Reprojection only uses the canonical originals, never a prior excerpt.
  // Reference labels have a real serialized cost. Keep shrinking only marked
  // evidence ranges until the measured request fits; the current intent is
  // never excerpted to make room for navigation or choices.
  for(const maxBytes of [3000,1600,800,400]){
    if(fits(payload))break;
    for(const [id,source] of selected)if(id!==current.id&&id!==intentSource.id){
      if(maxBytes<1600&&source.type!=='qq')continue;
      const original=byId.get(id);if(!original||bytes(source)<=maxBytes)continue;
      const projected=boundedSource(original,{start:source.delivery?.start||0,maxBytes});
      if(projected)selected.set(id,projected);
    }
    refresh();trimStateNavigation();
  }
  // Deterministic digest tier: background evidence that cannot hold even a
  // bounded range still contributes its verbatim structure and per-entry
  // lookup handles, so the request can proceed on explicitly derived views
  // instead of dying at the floor. No model call, no invented wording.
  if(!fits(payload))for(const [id,source] of [...selected]){
    if(fits(payload))break;
    if(id===current.id||id===intentSource.id||source.type==='request')continue;
    const original=byId.get(id);if(!original||original.type==='request')continue;
    const digested=digestSource(original);
    if(digested&&bytes(digested)<bytes(source)){
      const before=bytes(payload);selected.set(id,digested);refresh();trimStateNavigation();
      recordDegradation('deterministic_digest',id,before-bytes(payload),{sourceId:id,revision:original.revision,offset:0});
    }
  }
  // The current interaction is the never-degraded floor, but a floor member
  // too large for the measured request still degrades to an explicit marked
  // range with a continuation handle — bound intent first, request last —
  // before any rejection. The question itself is never dropped or digested.
  const floorMembers=[...new Set([intentSource,current])].filter(member=>member&&selected.has(member.id));
  for(const member of floorMembers){
    for(const maxBytes of [12000,6000,3000,1600,800,400,200]){
      if(fits(payload))break;
      const original=byId.get(member.id);
      const view=selected.get(member.id);
      if(!original||!view||bytes(view)<=maxBytes)continue;
      const projected=boundedSource(original,{start:0,maxBytes});
      if(projected){
        const before=bytes(payload);selected.set(member.id,projected);refresh();trimStateNavigation();
        if(bytes(payload)<before)recordDegradation('ranged_excerpt',member.id,before-bytes(payload),projected.delivery?.lookup);
      }
    }
  }
  // A configured budget below the serialized envelope cannot deliver any
  // request at all; report that configuration honestly instead of blaming
  // the current question.
  if (!fits(payload) && budget.measure(null) > budget.requestByteBudget)
    throw new Error('配置的请求预算低于最小请求信封，任何问题都无法完整交付；请提高本次预算；没有静默截断');
  // The single surviving hard rejection: the current request text itself
  // cannot be delivered even as a minimal explicit range (for example a
  // configured budget below the request envelope). Everything else degrades.
  if (!fits(payload)) throw new Error('即使按最小显式范围交付当前问题并降级其余内容，本次上下文预算仍不足以组成有效请求；请提高本次预算或缩短当前问题；没有静默截断');
  // The current multi-turn interaction is considered before optional historical
  // summaries and their evidence closures. This allowance never enlarges the
  // mandatory floor or makes an otherwise feasible request fail.
  const admitExplicit=source=>{
    const original=byId.get(source.id);if(!original||source.id===current.id||source.id===intentSource.id)return;
    const prior=selected.get(source.id);
    const parameters={start:source.offset??source.delivery?.start??0,maxChars:source.maxChars??(source.delivery?source.delivery.end-source.delivery.start:Infinity)};
    // An explicit read may borrow unused capacity. Do not shorten a feasible
    // complete source merely to satisfy a soft per-layer allocation.
    let candidate=boundedSource(original,{...parameters,maxBytes:Math.max(1000,options.byteBudget||48000)});
    if(!candidate)return;
    selected.set(source.id,candidate);foldedPrivateIds.delete(source.id);refresh();
    if(!fits(payload)){
      const focused={...parameters,start:source.offset??source.delivery?.start??source.focusOffset??0};
      candidate=boundedSource(original,{...focused,maxBytes:Math.max(1000,Math.min(14000,Math.floor(options.byteBudget||48000)/2))});
      if(candidate){selected.set(source.id,candidate);refresh();}
      if(!fits(payload))candidate=boundedSource(original,{...focused,maxBytes:4000});
      if(candidate)selected.set(source.id,candidate);else selected.delete(source.id);refresh();
      if(!fits(payload)){if(prior)selected.set(source.id,prior);else selected.delete(source.id);refresh();}
    }
    if(selected.has(source.id))essentialIds.add(source.id);
  };
  for(const source of retrievedSources)admitExplicit(source);
  // Reuse only actual previously admitted original fragments, never every
  // input reference or generated wording. Consultation support outlives the
  // editable candidate's TTL without becoming a persistent sharing grant.
  const priorSupport=[];
  for(const entry of eligibleTurns.filter(entry=>entry.role==='assistant'&&entry.origin!=='automatic').slice(-2)){
    const run=(companion.runs||[]).find(run=>run.status==='complete'&&(run.replyId===entry.id||run.id===entry.requestId));
    if(!run)continue;
    for(const quote of (run.payload?.outboundQuotes||[]).slice(0,8)){
      const source=byId.get(quote.sourceId),revision=run.manifest?.sourceRevisions?.[quote.sourceId];
      if(!source||source.revision!==revision||typeof quote.text!=='string'||!source.text.includes(quote.text))continue;
      const binding=(run.manifest?.disclosureBindings||[]).find(binding=>binding.material.sourceId===quote.sourceId&&binding.material.text===quote.text);
      const ids=[...new Set([quote.sourceId,...(binding?[binding.permission.sourceId,binding.referent.sourceId]:[])])];
      if(ids.some(id=>!byId.has(id)||run.manifest?.sourceRevisions?.[id]!==byId.get(id).revision))continue;
      for(const id of ids)admitExplicit(byId.get(id));
      if(ids.every(id=>completeBody(selected.get(id)))){
        priorSupport.push({sourceId:quote.sourceId,text:quote.text});for(const id of ids)privatePriorityIds.add(id);
      }
    }
  }
  if(priorSupport.length)payload.consultationSupport={sourceIds:[...new Set(priorSupport.map(fragment=>fragment.sourceId))],authority:'previously_admitted_original_support_not_new_sharing_permission',bodyLocation:'sources'};
  const discovery=options.memoryDiscovery;
  const directory=Array.isArray(discovery?.directory)?discovery.directory:discovery?.directory?.items||discovery?.directory?.entries||[];
  if(directory.length||discovery?.sources?.length){
    payload.memoryDiscovery={version:discovery.version,directory:[],authority:'fallible_navigation_requires_original_lookup',rule:discovery.rule,omittedEntryCount:0};
    let directoryBytes=0;
    for(const entry of directory){
      const sourceIds=entry.sourceIds||entry.sourceRefs?.map(ref=>ref.sourceId)||[];
      if(!sourceIds.length||sourceIds.some(id=>!byId.has(id))||(entry.sourceRefs||[]).some(ref=>ref.revision&&byId.get(ref.sourceId)?.revision!==ref.revision)){payload.memoryDiscovery.omittedEntryCount++;continue;}
      const candidate=sanitize({...pick(entry,['id','kind','subject','sourceSpeaker','aspect','text','title','summary','topicKeys','firstEvidenceAt','lastEvidenceAt','at','asOf','temporalStatus','epistemicStatus','assertionKind','lifecycle','activityKey','omittedSupportCount','applicability','requiresOriginalRead','sourceRefs']),sourceIds,authority:'navigation_only_needs_source_lookup'});
      if(directoryBytes+bytes(candidate)>3500){payload.memoryDiscovery.omittedEntryCount++;continue;}
      payload.memoryDiscovery.directory.push(candidate);refresh();
      if(!fits(payload)){payload.memoryDiscovery.directory.pop();payload.memoryDiscovery.omittedEntryCount++;refresh();continue;}
      directoryBytes+=bytes(candidate);
    }
  }
  let discoveryBytes=0;
  for(const entry of discovery?.sources||[]){
    if(discoveryPriorityIds.size>=3)break;
    const original=byId.get(entry.id);if(!original||selected.has(original.id)||foldedPrivateIds.has(original.id))continue;
    const source=boundedSource(original,{start:entry.offset??entry.delivery?.start??0,maxChars:entry.maxChars??Infinity,maxBytes:Math.min(4000,6000-discoveryBytes)});if(!source)continue;
    selected.set(source.id,source);refresh();
    if(!fits(payload)){selected.delete(source.id);refresh();continue;}
    discoveryPriorityIds.add(source.id);discoveryBytes+=bytes(source);
  }
  if(payload.memoryDiscovery&&!payload.memoryDiscovery.directory.length&&!discoveryPriorityIds.size){delete payload.memoryDiscovery;refresh();}
  if(options.methodLookupIds?.length)for(const method of methodSelection.methods.filter(method=>options.methodLookupIds.includes(method.id))){
    payload.methodCards.push(runtimeCard(method));refresh();
    if(!fits(payload)){payload.methodCards.pop();refresh();}
  }
  const recentBaseBytes=bytes(payload);
  recentContextPlan=recentPlan;refresh();
  if(!fits(payload)||bytes(payload)-recentBaseBytes>recentPlan.limits.maxAdditionalBytes){recentContextPlan=null;refresh();}
  if(recentContextPlan)for(const id of recentPlan.candidateMessageIds){
    const source=byId.get(`qq:${id}`);if(!source||selected.has(source.id))continue;
    const record=actualById.get(source.id),target=record&&quoteTarget(record,records,byId);
    const sourceIds=[source.id,...(target?[`qq:${target.messageId}`]:[])],added=sourceIds.filter(sourceId=>!selected.has(sourceId));
    for(const sourceId of added)selected.set(sourceId,byId.get(sourceId));
    refresh();
    if(!fits(payload)||bytes(payload)-recentBaseBytes>recentPlan.limits.maxAdditionalBytes){
      for(const sourceId of added)selected.delete(sourceId);refresh();continue;
    }
    recentAdmissions.push(added);for(const sourceId of added)recentPriorityIds.add(sourceId);
  }
  const recentInitialAdditionalBytes=Math.max(0,bytes(payload)-recentBaseBytes);
  const reclaimOptionalRecent=(requiredSourceIds=new Set())=>{
    while(!fits(payload)&&recentAdmissions.length){
      const ids=recentAdmissions.pop();
      for(const id of ids)if(!essentialIds.has(id)&&!requiredSourceIds.has(id)){selected.delete(id);recentPriorityIds.delete(id);}
      refresh();
    }
    if(!fits(payload)&&recentContextPlan){recentContextPlan=null;refresh();}
  };
  const trySource = source => {
    if (!source || selected.has(source.id) || foldedPrivateIds.has(source.id)) return;
    selected.set(source.id, source); refresh();
    if (!fits(payload)) { selected.delete(source.id); refresh(); }
  };
  const includeGrounded = (record, target, fields, priority = false, allowFolded = false) => {
    if (!supportedByAvailable(record, byId, scope)) return false;
    if (!allowFolded && record.sourceIds.some(id => foldedPrivateIds.has(id))) return false;
    const before = new Map(selected);
    // Grounding evidence degrades to bounded ranges rather than entering whole;
    // the revision still witnesses the complete original for later lookup.
    for (const id of record.sourceIds) if (!foldedPrivateIds.has(id)) {
      const original=byId.get(id);
      selected.set(id, original&&bytes(original)>6000?boundedSource(original,{start:0,maxBytes:6000})||original:original);
    }
    const clean = sanitize(pick(record, fields));
    if (allowFolded && record.sourceIds.some(id => foldedPrivateIds.has(id))) clean.foldedSourceIds = record.sourceIds.filter(id => foldedPrivateIds.has(id));
    clean.authority ||= record.reviewComplete === false ? 'needs_review' : 'source_backed_summary_not_independent_evidence';
    target.push(clean); refresh();
    if (priority) {trimStateNavigation();reclaimOptionalRecent(new Set(record.sourceIds));}
    if (fits(payload)) return true;
    target.pop(); selected.clear(); for (const [id, source] of before) selected.set(id, source); refresh(); return false;
  };
  // Stable expression preferences precede optional raw history. Their raw user
  // reasons stay in private planning; restricted wording gets safe controls.
  for (const n of companion.notes.filter(n => n.kind === 'preference' && n.use !== 'disabled').slice(-12).reverse()) {
    const id=`note:${n.id}`;
    includeGrounded({sourceId:id,text:redact(n.text),sourceIds:[id],authority:'user_owned_behavior_instruction',scopeRule:'interpret_whole_original_in_current_context'},payload.preferences,['sourceId','text','sourceIds','authority','scopeRule'],true);
  }
  // A legacy preference classification is only a lookup hint. Read its human
  // original on demand without promoting the old summary into a stable control.
  let directionBytes=0;
  for(const record of coreInventory.filter(record=>record.recordType==='item'&&record.kind==='preference'&&record.status==='active'&&record.reviewComplete===false&&supportedByAvailable(record,byId,scope)).slice(0,3)){
    for(const id of record.sourceIds||[]){
      const source=byId.get(id);if(!source||source.role!=='user'||!['private','feedback'].includes(source.type)||directionBytes+bytes(source)>6000)continue;
      admitExplicit(source);
      if(selected.has(id)&&completeBody(selected.get(id))){priorDirectionIds.add(id);directionBytes+=bytes(source);}
    }
    refresh();
  }
  // This inventory is local and already maintained by the existing memory
  // engine. A dated summary is not proof that an old circumstance still holds.
  const coreItems=[];
  for(const summary of coreCatalog(coreInventory,byId,scope,{queryText,asOf})){
    payload.coreMemory={items:[...coreItems,summary],authority:'dated_summaries_not_outbound_permission_or_current_status'};
    if(!fits(payload)){if(coreItems.length)payload.coreMemory.items=coreItems;else delete payload.coreMemory;continue;}
    coreItems.push(summary);
  }
  if(payload.topicContext.active)for(const id of payload.topicContext.active.sourceIds||[]){
    const source=byId.get(id);if(source&&relevantRecord(source)&&bytes(source)<=6000)trySource(source);
  }
  const evaluationTargets = [...feedbackTargets, ...(experienceContext?.evaluationTargets || [])];
  const requiredFeedbackSources = new Set(feedbackTargets.map(item => item.feedback?.sourceId).filter(Boolean));
  for (const id of protectedPendingIds) if (byId.get(id)?.type === 'feedback') requiredFeedbackSources.add(id);
  if (intentSource.type === 'feedback') requiredFeedbackSources.add(intentSource.id);
  for (const id of sourceTurnIds) {
    const turn = companion.turns.find(item => item.id === id);
    if (turn?.feedbackId) requiredFeedbackSources.add(companion.feedback?.find(item => item.id === turn.feedbackId)?.sourceId || `private:feedback-${turn.feedbackId}`);
  }
  if (evaluationTargets.length) payload.feedbackTargets = [];
  const seenFeedback = new Set();
  const includeEvaluationTargets = (items, required = false) => {
    for (const item of items) {
      if (seenFeedback.size >= 8) break;
      const id = item.feedback?.sourceId;
      if (!id || seenFeedback.has(id) || !byId.has(id)) continue;
      const record = { ...item, sourceIds: [...new Set([id, ...(item.sourceIds || [])])] };
      const target = pick(item.target, ['artifactRef','body','kind','messageId','availability','authority','deliveredMethodRefs','reportedUsedMethodRefs','generationStages']);
      if (item.missing || ['purged','deleted','redacted','unavailable'].includes(target.availability)) delete target.body;
      if (item.feedback.targetRef?.kind === 'experience' && item.target) {
        const actualActions = projectActualActions(item.target.actualActions, byId, scope);
        const observations = projectObservations(item.target.observations, byId, scope);
        const reviews = (item.target.reviews || []).filter(review => byId.has(review.sourceId)).map(review => pick(review, ['id','sourceId','targetRef']));
        Object.assign(target, pick(item.target, ['id','status','attribution']), { actualActions, observations, reviews, authority: 'experience_evaluation_target_not_independent_evidence' });
        record.sourceIds = [...new Set([...record.sourceIds, ...actionSources(actualActions), ...actionSources(observations), ...reviews.map(review=>review.sourceId)])];
      }
      else target.authority = item.target?.kind === 'actual_message' ? 'actual_qq_evaluation_target' : 'generated_evaluation_target_not_factual_evidence';
      const projected = { ...record, feedback: pick(item.feedback, ['id','sourceId','kind','targetRef']), target,
        correctionContext: (item.correctionContext || []).filter(item => byId.has(item.sourceId)).map(item => ({ sourceId: item.sourceId })) };
      if (includeGrounded(projected, payload.feedbackTargets, ['feedback','target','missing','sourceIds','correctionContext'], required, true)) {
        seenFeedback.add(id);
        if (required) for (const sourceId of record.sourceIds) essentialIds.add(sourceId);
      } else if (required) {
        // A required feedback target that cannot fit degrades to an explicit
        // missing marker: the answer proceeds and asks for the specific object
        // instead of hard-blocking the whole request on the context budget.
        if (includeGrounded({ feedback: projected.feedback, target: pick(target, ['artifactRef','kind','authority']), missing: true,
          reason: '所选反馈的完整对象或必要证据未能放入本次上下文，不能推断反馈针对哪句话；请先指出具体评价对象。', sourceIds: [id] }, payload.feedbackTargets,
          ['feedback','target','missing','reason','sourceIds'])) { seenFeedback.add(id); recordDegradation('feedback_target_missing_marker', id, 0); }
      }
      else if (includeGrounded({ feedback: projected.feedback, target: pick(target, ['artifactRef','kind','authority']), missing: true,
        reason: '完整评价对象或其必要证据未能放入本次上下文，不能推断反馈针对哪句话。', sourceIds: [id] }, payload.feedbackTargets,
        ['feedback','target','missing','reason','sourceIds'])) seenFeedback.add(id);
    }
  };
  includeEvaluationTargets(evaluationTargets.filter(item => requiredFeedbackSources.has(item.feedback?.sourceId)), true);
  // Current private meaning and the correction/acknowledgment exchange precede
  // optional summaries, methods and unrelated history. Preserve whole turns.
  const groups = []; let activeGroup = null;
  for (const t of companion.turns) {
    if (t.role === 'user') {
      activeGroup = null;
      if (t.id === turn.id || t.memoryExcluded || !byId.has(`private:${t.id}`) || foldedPrivateIds.has(`private:${t.id}`)) continue;
      activeGroup = []; groups.push(activeGroup);
    }
    if (activeGroup&&!automaticTurn(t)) activeGroup.push(t);
  }
  const oldRelevantGroups=new Set(groups.filter(group=>!inRecentWindow(group[0].createdAt)&&relevantRecord({text:group[0].text,sourceIds:[`private:${group[0].id}`]})).slice(-3));
  const recentGroups = groups.filter((group,index)=>inRecentWindow(group[0].createdAt)||reviewing||group.some(t=>explicitTurnIds.has(t.id))||
    privateRequest&&index===groups.length-1||oldRelevantGroups.has(group)).reverse();
  let privateLayerBytes=0;const privateLayerLimit=Math.min(14000,Math.floor((options.byteBudget||48000)*0.5));
  for (const [index, group] of recentGroups.entries()) {
    const beforePrivateBytes=bytes(payload);
    const previous = new Map(selected), previousTurns = payload.privateConversation;
    const keepAssistantBodies=privateRequest&&index===0||reviewing||group.some(t=>explicitTurnIds.has(t.id))||
      privateRequest&&group.reduce((n,t)=>n+bytes(t.text||''),0)<=1600;
    const deliveredGroup=keepAssistantBodies?group:group.filter(t=>t.role==='user');
    payload.privateConversation = deliveredGroup.map(t => {
      if(t.role==='user')return {id:t.id,role:t.role,kind:t.kind,sourceId:`private:${t.id}`,sourceTextLocation:'sources',at:t.createdAt,requestId:t.requestId||null};
      const read=payload.retrievedDiscussion?.find(item=>item.role==='assistant'&&item.originalTurnId===t.id&&item.text&&item.delivery?.status!=='omitted');
      if(read)return {id:t.id,role:t.role,kind:t.kind,at:t.createdAt,requestId:t.requestId||null,bodyLocation:'retrievedDiscussion',
        generatedReadRef:{turnId:read.originalTurnId,turnFingerprint:read.turnFingerprint,bodyView:read.bodyView},availability:read.delivery.status,
        authority:'assistant_discussion_not_factual_evidence'};
      if(coveredTurnIds.has(t.id)&&!sourceTurnIds.includes(t.id)&&!sourceLookupIds.includes(t.id))return {id:t.id,role:t.role,kind:t.kind,compacted:true,authority:'derived_private_discussion_needs_sources'};
      return {id:t.id,role:t.role,kind:t.kind,...(t.artifactAvailability?{artifactAvailability:t.artifactAvailability}:{}),text:redact(t.text),...(t.discussionExplanation?{discussionExplanation:{kind:t.discussionExplanation.kind,text:redact(t.discussionExplanation.text)}}:{}),
        at:t.createdAt,requestId:t.requestId||null,authority:'assistant_discussion_not_factual_evidence'};
    }).concat(previousTurns);
    for (const t of group) if (t.role === 'user' && !foldedPrivateIds.has(`private:${t.id}`)&&!(explicitLookupIds.includes(`private:${t.id}`)&&selected.has(`private:${t.id}`))) selected.set(`private:${t.id}`, byId.get(`private:${t.id}`));
    refresh();
    trimStateNavigation();
    if(index===0&&privateRequest)reclaimOptionalRecent();
    const privateExtraBytes=Math.max(0,bytes(payload)-beforePrivateBytes),priorityGroup=index===0&&privateRequest||group.some(t=>explicitTurnIds.has(t.id));
    // The layer limit is a reservation for optional history, not a hard cap on
    // the coherent exchange currently being continued. A complete latest or
    // explicitly requested group may borrow unused measured request capacity.
    if (!fits(payload)||!priorityGroup&&privateLayerBytes+privateExtraBytes>privateLayerLimit) {
      if(index===0&&privateRequest){
        // A large historical group remains a complete retrievable unit; it is
        // never made mandatory merely by being the last stored consultation.
        selected.clear();for(const [id,source] of previous)selected.set(id,source);
        payload.privateConversation=previousTurns;
        payload.deferredDiscussion={turnIds:group.map(item=>item.id),availability:'needs_lookup',reason:'complete_group_exceeds_remaining_layer_budget'};
        refresh();continue;
      }
      selected.clear(); for (const [id, source] of previous) selected.set(id, source);
      payload.privateConversation = previousTurns; refresh(); continue;
    }
    privateLayerBytes+=privateExtraBytes;
    for (const t of group) if (t.role === 'user') privatePriorityIds.add(`private:${t.id}`);
    if (index === 0&&privateRequest||group.some(t=>explicitTurnIds.has(t.id))) for (const t of group) {
      requiredPrivateTurnIds.add(t.id);
      if (t.role === 'user') essentialIds.add(`private:${t.id}`);
    }
  }
  // Candidate originals are available even without compaction. A whole choice
  // either fits or remains an explicit original-turn lookup reference.
  if (candidatePool.length) payload.privateCandidates = [];
  const orderedCandidates=[...candidatePool].sort((a,b)=>Number(preferredCandidateTurnIds.has(b.turnId))-Number(preferredCandidateTurnIds.has(a.turnId)));
  for (const candidate of orderedCandidates) {
    payload.privateCandidates.push(candidate); trimStateNavigation();
    // Exact current choices precede older optional discussion groups. Keep whole
    // latest turns and move older evidence back to explicit lookup, not snippets.
    if(preferredCandidateTurnIds.has(candidate.turnId))while(!fits(payload)){
      const index=payload.privateConversation.findIndex(entry=>entry.role==='user'&&!requiredPrivateTurnIds.has(entry.id));
      if(index<0)break;
      let end=index+1;while(end<payload.privateConversation.length&&payload.privateConversation[end].role==='assistant')end++;
      const removed=payload.privateConversation.splice(index,end-index);
      for(const entry of removed)if(entry.role==='user'&&!essentialIds.has(entry.sourceId))selected.delete(entry.sourceId);
      refresh();
    }
    if (!fits(payload)) {
      const reference = { ...candidate, availability: 'needs_lookup' }; delete reference.text; delete reference.quotes;
      payload.privateCandidates[payload.privateCandidates.length - 1] = reference;
      // An original-turn lookup handle is more useful than an older duplicate
      // discussion body when the full candidate cannot fit. Latest turns stay.
      while(!fits(payload)){
        const index=payload.privateConversation.findIndex(entry=>entry.role==='user'&&!requiredPrivateTurnIds.has(entry.id));
        if(index<0)break;
        let end=index+1;while(end<payload.privateConversation.length&&payload.privateConversation[end].role==='assistant')end++;
        const removed=payload.privateConversation.splice(index,end-index);
        for(const entry of removed)if(entry.role==='user'&&!essentialIds.has(entry.sourceId))selected.delete(entry.sourceId);
        refresh();
      }
      if (!fits(payload)) { payload.privateCandidates.pop(); break; }
    }
  }
  // Incidental evaluations cannot consume the room reserved for the current
  // meaning and its complete latest acknowledgment. Selected targets stay exact.
  includeEvaluationTargets(evaluationTargets.filter(item => !requiredFeedbackSources.has(item.feedback?.sourceId)&&relevantRecord({...item,text:byId.get(item.feedback?.sourceId)?.text||''})));
  if (sameScopeIfPresent(topicView, scope)) for (const topic of (topicView.retained || topicView.items || []).filter(item => item.lifecycle !== 'active'&&relevantRecord(item)).slice(-3).reverse()) {
    const included = includeGrounded({ ...topic, authority: 'closed_topic_navigation_not_active_control' }, payload.topicContext.retained,
      ['id','version','lifecycle','objective','direction','constraints','stage','progress','unknowns','interpretationStatus','observationAuthorities','sourceIds','authority']);
    if (included) payload.topicContext.retained[payload.topicContext.retained.length - 1] = modelTopic(payload.topicContext.retained.at(-1));
  }
  if (relationshipContext && sameScopeIfPresent(relationshipContext, scope)) {
    payload.relationshipContext = { version: relationshipContext.version, asOf: relationshipContext.asOf,
      claims: [], events: [], activities: [],activityUncertainties:sanitize(relationshipContext.activityUncertainties||[]),activityEvidenceRule:`Historical evidence gaps do not negate a separately supported current-state report. Preserve currentReportedState source/asOf/authority; it is not an event occurrence clock. ${LOSS_RULE}`, coverage: sanitize(relationshipContext.coverage || {}) };
    const common = ['id','version','text','sourceIds','sourceRevisions','evidenceValidity','applicability','currentApplicability','reviewComplete','topicKeys','firstEvidenceAt','lastEvidenceAt','reportedAt','reviewedAt','applicabilityKind','attribution','condition','readCategory'];
    const categories=new Map();
    for(const subject of ['self','contact','dyad'])for(const category of ['knownFacts','recentCircumstances','uncertainties','boundaries'])for(const claim of relationshipContext.understanding?.[subject]?.[category]||[])categories.set(claim.id,category);
    const claims=(relationshipContext.claims||[]).filter(claim=>relevantRecord(claim)||claim.aspect==='boundary'&&claim.lifecycle!=='withdrawn'&&claim.lifecycle!=='superseded');
    let relationshipEvidenceBytes=0;
    const admitRelationship=record=>{const extra=(record.sourceIds||[]).filter(id=>!selected.has(id)).reduce((n,id)=>n+bytes(byId.get(id)||{}),bytes(record));if(!reviewing&&relationshipEvidenceBytes+extra>7000)return false;relationshipEvidenceBytes+=extra;return true;};
    // Entailment rendering (target architecture M3): each derived fragment
    // carries a mechanically derived holder basis. A claim without contact
    // speech in its evidence closure can never render as her words.
    const entailment=record=>({speakerBasis:holderBasis(record,byId)});
    for (const claim of claims.slice(0,reviewing?24:6)) if(admitRelationship(claim))
      includeGrounded({...claim,...entailment(claim),...(categories.has(claim.id)?{readCategory:categories.get(claim.id)}:{})}, payload.relationshipContext.claims, [...common,'speakerBasis','subject','aspect','assertionKind','epistemicStatus','lifecycle','validFrom','validUntil','context','activityId','currentActivityState']);
    const eventKeys=new Set((relationshipContext.events||[]).filter(relevantRecord).map(event=>event.activityId||event.activityKey));
    for (const event of (relationshipContext.events || []).filter(event=>reviewing||eventKeys.has(event.activityId||event.activityKey)).slice(-24).reverse()) if(admitRelationship(event))
      includeGrounded({...event,...entailment(event)}, payload.relationshipContext.events, [...common,'speakerBasis','activityId','activityKey','identityStatus','activityEvidenceStatus','eventKind','actor','occurredAt','plannedFor','occurrenceTimeStatus','lifecycle','assertionKind','epistemicStatus','origin']);
    payload.relationshipContext.events.sort((a,b)=>String(a.occurredAt||a.lastEvidenceAt||'').localeCompare(String(b.occurredAt||b.lastEvidenceAt||'')));
    const eventIds = new Set(payload.relationshipContext.events.map(event => event.id));
    const relatedActivities=new Set([...payload.relationshipContext.events,...payload.relationshipContext.claims].map(record=>record.activityId).filter(Boolean));
    const relevantActivities=(relationshipContext.activities||[]).filter(activity=>reviewing||relatedActivities.has(activity.activityId)||(activity.definitionEvidence?.sourceIds||[]).some(id=>selected.has(id))||activity.activityKey&&relevantRecord({text:activity.activityKey,sourceIds:activity.sourceIds})||activity.historicalEvidenceGap&&inRecentWindow(activity.knowledgeChangedAt));
    for (const activity of relevantActivities.slice(0, 8)) {
      const ids = activity.eventIds || activity.events?.map(event => typeof event === 'string' ? event : event.id) || [];
      if (!activity.activityId&&(!ids.length || ids.some(id => !eventIds.has(id)))) continue;
      const compact = sanitize({ ...pick(activity, ['activityId','activityKey','status','authority','identityStatus','definitionAvailable','definitionEvidence','historicalEvidenceGap','currentReportedState','priorCurrentReportedState','latestEventId','knowledgeChangedAt','affectedWorldAt','occurredAt','plannedFor','qualified']),evidenceLosses:(activity.evidenceLosses||[]).slice(0,4),omittedEvidenceLossCount:Math.max(0,(activity.evidenceLosses||[]).length-4), eventIds: ids.filter(id=>eventIds.has(id)) });
      payload.relationshipContext.activities.push(compact);
      reconcilePlanningViews(payload);
      while(!fits(payload)&&compact.evidenceLosses.length){compact.evidenceLosses.pop();compact.omittedEvidenceLossCount++;}
      if (!fits(payload)) payload.relationshipContext.activities.pop();
    }
  }
  if (experienceContext && sameScopeIfPresent(experienceContext, scope)) {
    payload.experienceContext = { cases: [], adaptations: [], constraints: ['仅为局部经验；不是她的心理或方法因果效果证据。', '候选适用性尚未确定，核对applicability与当前任务后再使用；本轮明确意思优先，不相关或相反的指导不采用。'] };
    for (const item of (experienceContext.cases || []).filter(relevantRecord).slice(0,reviewing?4:2)) {
      const actualActions = projectActualActions(item.actualActions, byId, scope);
      const observations = projectObservations(item.observations, byId, scope);
      const reviewSourceIds = (item.reviews || []).map(review => review.sourceId).filter(id => byId.has(id));
      const sourceIds = [...new Set([...(item.sourceIds || []), ...actionSources(actualActions), ...actionSources(observations), ...reviewSourceIds])];
      const links = (item.links || []).slice(0, 8).map(link => ({ ...pick(link, ['id','status','reason','artifactRefs','actualMessageIds','confirmation']),
        artifacts: (link.artifacts || []).map(artifact => ({ ...pick(artifact, ['ref','availability']),
          ...(artifact.availability === 'redacted' ? {} : { text: artifact.text }), authority: 'generated_proposal_not_actual_communication' })) }));
      includeGrounded({ ...item, actualActions, observations, links, sourceIds, reviewSourceIds }, payload.experienceContext.cases,
        ['id','status','goalVersion','actualActions','observations','linkStatus','attribution','links','reviewSourceIds','sourceIds']);
    }
    for (const item of (experienceContext.adaptations || []).slice(0, 4)) {
      if (item.status !== 'active' || item.authority !== 'user_approved_assistance_guidance' || !relevantRecord(item)) continue;
      includeGrounded(item, payload.experienceContext.adaptations, ['id','version','text','applicability','applicabilityStatus','matchBasis','methodRef','status','scope','authority','sourceIds']);
    }
  }
  // The recent-days layer is separate from the short current episode. Admit
  // complete chronological segments by recency, without a message-count quota.
  // A segment which cannot fit stays local and explicitly discoverable.
  let recentWindowBytes=recentInitialAdditionalBytes;
  for(const segment of [...timeSegments].reverse()){
    const beforeWindowBytes=bytes(payload),added=new Set();
    for(const message of segment){
      const ids=[`qq:${message.messageId}`],target=quoteTarget(message,records,byId);if(target)ids.push(`qq:${target.messageId}`);
      for(const id of ids)if(!selected.has(id)&&byId.has(id)){selected.set(id,byId.get(id));added.add(id);}
    }
    refresh();
    const extra=bytes(payload)-beforeWindowBytes;
    if(!fits(payload)||recentWindowBytes+extra>recentPlan.limits.maxAdditionalBytes){for(const id of added)selected.delete(id);refresh();continue;}
    recentWindowBytes+=Math.max(0,extra);for(const id of added)timePriorityIds.add(id);
  }
  // Complete evidence and evaluated artifacts precede optional method cards.
  // Missing cards never require asking the user a ritual question.
  for (const method of methodSelection.methods) {
    if(payload.methodCards.some(card=>card.id===method.id))continue;
    payload.methodCards.push(runtimeCard(method));
    if (!fits(payload)) payload.methodCards.pop();
  }
  refresh();
  if(!selectedProposal&&privateRequest)for(const option of proposals.reverse()) {
    payload.expressionOptions.unshift(option);
    if(!fits(payload)){payload.expressionOptions.shift();break;}
  }
  // Explicit lookups retain their own evidence path. Automatic raw retrieval
  // and recent-note fallback share one bound, preserving relevance before time.
  // Explicit reads were admitted before the optional recent/history layers.
  const optionalRawIds=new Set(),optionalRawLimit=reviewing?8:4;
  let optionalRawBytes=0;
  const tryOptionalRaw=(source,retrievalScore=0)=>{
    if(!source||selected.has(source.id))return;
    if(optionalRawIds.size>=optionalRawLimit)return;
    if(!reviewing&&!(retrievalScore>0)&&!relevantRecord(source))return;
    if(!reviewing&&optionalRawBytes+bytes(source)>6000)return;
    trySource(source);if(selected.has(source.id)){optionalRawIds.add(source.id);optionalRawBytes+=bytes(source);}
  };
  const optionalRetrieved=[...new Map((memoryResult?.sources||[]).map(source=>[source.id,source])).values()]
    .sort((a,b)=>(b.retrievalScore||0)-(a.retrievalScore||0)||Date.parse(b.at||0)-Date.parse(a.at||0));
  for(const source of optionalRetrieved)tryOptionalRaw(byId.get(source.id),source.retrievalScore);
  for (const id of sourceTurnIds) {
    const t = companion.turns.find(t => t.id === id);
    if (!t) continue;
    if (t.role === 'user') trySource(byId.get(`private:${id}`));
    else for (const sid of t.sourceIds || []) trySource(byId.get(sid));
  }
  const summarized = new Set();
  for (const kind of ['items', 'episodes']) for (const item of memoryResult?.[kind] || []) {
    if (!Array.isArray(item.sourceIds) || item.sourceIds.some(id => !byId.has(id))) continue;
    const signature = digest([item.text, [...item.sourceIds].sort()]);
    if (summarized.has(signature)) continue;
    if(!(item.retrievalScore>0)&&!relevantRecord(item))continue;
    if(!reviewing&&payload.retrievedMemory[kind].length>=4)break;
    const clean = { ...item, text: redact(item.text), authority: item.reviewComplete===false || item.sourceIds.some(id=>!selected.has(id)) ? 'needs_review' : 'source_backed_summary' };
    const verbatim = item.sourceIds.find(id => selected.get(id)?.text === clean.text);
    if (verbatim) { delete clean.text; clean.textFromSource = verbatim; }
    payload.retrievedMemory[kind].push(clean);
    if (!fits(payload)) { payload.retrievedMemory[kind].pop(); break; }
    summarized.add(signature);
  }
  const includedMemories = new Set([...payload.retrievedMemory.items, ...payload.retrievedMemory.episodes].map(item => item.id));
  for (const item of memoryIndex.filter(item => !includedMemories.has(item.id) && relevantTo(current.text, item)).slice(0, 8)) {
    if (!Array.isArray(item.sourceIds) || !item.sourceIds.length || item.sourceIds.some(id => !byId.has(id))) continue;
    payload.memoryIndex.push({ id: item.id, kind: item.kind, text: redact(item.text), topicKeys: item.topicKeys, status: item.status,
      authority:'navigation_only_needs_source_lookup',reviewComplete:item.reviewComplete,sourceIds:item.sourceIds,lastEvidenceAt:item.lastEvidenceAt });
    if (!fits(payload)) { payload.memoryIndex.pop(); break; }
  }
  // Bounded titles expose vocabulary such as an old job/activity without
  // preloading its full claim or evidence. These are retrieval handles only;
  // original sources must be looked up before they can establish facts.
  const navigation=[...(relationshipContext?.claims||[]).filter(item=>!payload.relationshipContext?.claims.some(claim=>claim.id===item.id)),
    ...['items'].flatMap(key=>(companion.state[key]||[]).filter(item=>!state[key].includes(item)).map((item,index)=>({...item,id:`state:${key}:${index}`,kind:'state'})))];
  const navigationKinds=new Set();
  const rankedNavigation=[...navigation].sort((a,b)=>Number(relevantRecord(b))-Number(relevantRecord(a))||(Date.parse(b.lastEvidenceAt||0)||0)-(Date.parse(a.lastEvidenceAt||0)||0));
  for(const item of rankedNavigation){
    if(payload.memoryIndex.length>=6)break;
    if(!item.sourceIds?.length||item.sourceIds.some(id=>!byId.has(id))||payload.memoryIndex.some(entry=>entry.id===item.id))continue;
    const category=`${item.subject||''}:${item.aspect||item.kind||'memory'}`;
    if(navigationKinds.has(category))continue;
    const title=String(item.text||'').split(/[。\n]/u)[0].slice(0,100);
    if(!title)continue;
    const entry={id:item.id,kind:item.aspect||item.kind||'claim',text:title,previewOnly:true,sourceIds:item.sourceIds,
      topicKeys:item.topicKeys||[],authority:'navigation_only_needs_source_lookup'};
    payload.memoryIndex.push(entry);
    if(!fits(payload)){payload.memoryIndex.pop();break;}
    navigationKinds.add(category);
  }
  // Even a stale state may identify useful original evidence. Re-read it rather
  // than trusting its old interpretation, so cross-day topics are not lost.
  for (const item of state.items)
    for (const id of item.sourceIds || []) trySource(byId.get(id));
  // Relevant notes arrive through search. Keep a small recent fallback for open
  // requests such as "what could we talk about", never fill the budget with all notes.
  for (const n of companion.notes.filter(n=>n.use!=='disabled').slice(-3).reverse()) tryOptionalRaw(byId.get(`note:${n.id}`));
  for (const r of restrictions) {
    if(!selected.has(r.sourceId)&&!r.evidenceSourceIds.some(id=>selected.has(id)))continue;
    const compact={sourceId:r.sourceId,evidenceSourceIds:r.evidenceSourceIds};
    payload.privateRestrictions.push(compact);
    if(!fits(payload)){payload.privateRestrictions.pop();break;}
  }
  // Accessible history is a lookup corpus, not spare material to fill a request.
  const words = [...new Set(current.text.match(/[\p{L}\p{N}]{2,}/gu) || [])];
  const matches = source => words.some(w => source.text.includes(w)) ||
    (current.text.match(/[\p{Script=Han}]{2}/gu) || []).some(w => source.text.includes(w));
  const historical = validQQ.filter(m => !recentPlan.candidateMessageIds.includes(m.messageId)&&matches(byId.get(`qq:${m.messageId}`))).slice(-(reviewing?8:3));
  for (const m of historical) {
    const index = validQQ.indexOf(m);
    for (const adjacent of validQQ.slice(Math.max(0, index - 1), index + 3)) trySource(byId.get(`qq:${adjacent.messageId}`));
  }
  // Missing later evidence is made explicit below. Reading one old reference
  // never silently expands into the entire intervening conversation.
  const settleSelection=()=>{
  for (;;) {
    let allLaterIncluded = true;
    for (let i = validQQ.length - 1; i >= 0; i--) {
      const id = `qq:${validQQ[i].messageId}`, source = selected.get(id);
      if (!source) { allLaterIncluded = false; continue; }
      if (!allLaterIncluded) selected.set(id, { ...source, historicalOnly: true, continuationCoverage: 'later_messages_omitted' });
      // Presence of one range is not coverage of the complete later message.
      // Break continuity only for earlier records, not for this source itself.
      if(rangedDelivery(source))allLaterIncluded=false;
    }
    let laterPrivateIncluded=true;
    for(const source of all.filter(s=>s.type==='private'||s.type==='feedback').reverse()) {
      if(source.kind==='feedback_continue'&&intentSource.type==='feedback'&&selected.get(intentSource.id)?.revision===intentSource.revision&&selected.get(intentSource.id)?.delivery?.status!=='partial')continue;
      if(!selected.has(source.id)){laterPrivateIncluded=false;continue;}
      if(!laterPrivateIncluded)selected.set(source.id,{...selected.get(source.id),historicalOnly:true,continuationCoverage:'later_private_sources_omitted'});
      if(rangedDelivery(selected.get(source.id)))laterPrivateIncluded=false;
    }
    refresh();
    if (fits(payload)) break;
    const lossDetail=payload.relationshipContext?.activities.findLast(activity=>activity.evidenceLosses?.length);
    if(lossDetail){lossDetail.evidenceLosses.pop();lossDetail.omittedEvidenceLossCount=(lossDetail.omittedEvidenceLossCount||0)+1;continue;}
    const optionalCandidate = payload.privateCandidates?.findLastIndex(item => item.availability === 'full' && !preferredCandidateTurnIds.has(item.turnId)) ?? -1;
    if (optionalCandidate >= 0) {
      const reference = { ...payload.privateCandidates[optionalCandidate], availability: 'needs_lookup' }; delete reference.text; delete reference.quotes;
      payload.privateCandidates[optionalCandidate] = reference; continue;
    }
    if(payload.memoryDiscovery?.directory.length){payload.memoryDiscovery.directory.pop();payload.memoryDiscovery.omittedEntryCount++;continue;}
    const optional = [...selected.keys()].filter(id => !essentialIds.has(id));
    const removable = optional.find(id => !discoveryPriorityIds.has(id)&&!privatePriorityIds.has(id)&&!recentPriorityIds.has(id)&&!timePriorityIds.has(id))||optional.find(id=>!discoveryPriorityIds.has(id)&&!privatePriorityIds.has(id))||optional.find(id=>!discoveryPriorityIds.has(id));
    if (removable) { selected.delete(removable); refresh(); }
    else if (payload.methodCards.length) {
      payload.methodCards.pop();
    }
    else if (optional.length) { selected.delete(optional[0]); refresh(); }
    else if (payload.privateConversation.length) {
      const index = payload.privateConversation.findIndex(entry => entry.role === 'user' && !requiredPrivateTurnIds.has(entry.id));
      if (index < 0) {if(!compactedPlanningViews&&compactPlanningViews(payload)){compactedPlanningViews=true;continue;}if(payload.work||payload.materialView){delete payload.work;delete payload.materialView;continue;}break;}
      let end = index + 1; while (end < payload.privateConversation.length && payload.privateConversation[end].role === 'assistant') end++;
      payload.privateConversation.splice(index, end - index);
    }
    else if(!compactedPlanningViews&&compactPlanningViews(payload)){compactedPlanningViews=true;continue;}
    else if(payload.work||payload.materialView){delete payload.work;delete payload.materialView;continue;}
    else break;
  }
  // Late budget eviction and chronology checks must also change the authority
  // of every derived view. A source appearing earlier is not proof of current state.
  const groundFinal = record => record.sourceIds?.every(id => completeBody(selected.get(id)));
  payload.topicContext.retained = payload.topicContext.retained.filter(groundFinal);
  if(payload.topicContext.active?.sourceIds.some(id=>selected.get(id)?.historicalOnly))Object.assign(payload.topicContext.active,{reviewPending:true,authority:'needs_review'});
  for (const key of ['claims', 'events']) if (payload.relationshipContext) {
    payload.relationshipContext[key] = payload.relationshipContext[key].filter(groundFinal).map(item => ({ ...item,
      authority: item.sourceIds.some(id => selected.get(id).historicalOnly) || item.reviewComplete === false
        ? 'needs_review' : item.authority }));
  }
  if (payload.relationshipContext) {
    const keptEvents = new Set(payload.relationshipContext.events.map(item => item.id));
    payload.relationshipContext.activities = payload.relationshipContext.activities.filter(item => item.activityId||item.eventIds.every(id => keptEvents.has(id)));
  }
  reconcilePlanningViews(payload);
  for (const key of ['cases', 'adaptations']) if (payload.experienceContext) payload.experienceContext[key] = payload.experienceContext[key].filter(groundFinal);
  if (payload.feedbackTargets) payload.feedbackTargets = payload.feedbackTargets.filter(item => item.sourceIds?.every(id => selected.has(id) || item.foldedSourceIds?.includes(id) && compacted?.sourceRevisions[id] === byId.get(id)?.revision));
  const privateGroups = []; let currentGroup = null;
  for (const entry of payload.privateConversation) {
    if (entry.role === 'user') { currentGroup = selected.has(entry.sourceId) ? [] : null; if (currentGroup) privateGroups.push(currentGroup); }
    if (currentGroup) currentGroup.push(entry);
  }
  payload.privateConversation = privateGroups.flat();
  for (const kind of ['items', 'episodes']) for (const item of payload.retrievedMemory[kind]) {
    if (item.sourceIds.some(id => !selected.has(id) || selected.get(id).historicalOnly || rangedDelivery(selected.get(id)))) item.authority = 'needs_review';
    if (item.textFromSource && !selected.has(item.textFromSource)) { item.text = redact(memoryResult[kind].find(original => original.id === item.id)?.text || ''); delete item.textFromSource; }
  }
  refresh();
  // New evidence is serialized chronologically, even when selected by recency/relevance.
  const order = new Map(all.map((s, i) => [s.id, i]));
  payload.sources.sort((a, b) => order.get(a.id) - order.get(b.id));
  };
  settleSelection();
  // Final eligibility/catalog settlement may free envelope space. Retry the
  // same ranked optional queue under the same layer and request ceilings.
  for(const source of optionalRetrieved)tryOptionalRaw(byId.get(source.id),source.retrievalScore);
  settleSelection();
  // End with the current factual position and exact current request. Neither
  // derived summaries nor old assistant prose becomes the active instruction.
  // Grounding can release space after optional source eviction. Reconsider
  // supporting cards instead of preserving an earlier empty-card decision.
  for(const method of methodSelection.methods){
    if(payload.methodCards.some(card=>card.id===method.id))continue;
    payload.methodCards.push(runtimeCard(method));
    if(!fits(payload))payload.methodCards.pop();
  }
  refresh();
  projectPlanningViews(payload,budget);
  trimStateNavigation();
  settleSelection();
  // A small native quote target must not stay clipped merely because optional
  // navigation/cards occupied its space earlier. Restore whole direct evidence
  // when the real envelope permits it; explicit range reads keep their bounds.
  const quotedIds=[...new Set((payload.taskContext?.recentExchange||[]).map(item=>item.quote?.sourceId).filter(Boolean))];
  for(const id of quotedIds){
    const prior=selected.get(id),original=byId.get(id);
    if(!original||!rangedDelivery(prior)||explicitLookupIds.includes(id))continue;
    const saved={cards:payload.methodCards,selection:structuredClone(payload.methodSelection),material:payload.materialView,work:payload.work};
    selected.set(id,original);refresh();
    if(!fits(payload)){payload.methodCards=[];delete payload.methodSelection.selectionRule;delete payload.methodSelection.feedbackRule;refresh();}
    if(!fits(payload)){delete payload.materialView;refresh();}
    if(!fits(payload)){delete payload.work;refresh();}
    if(!fits(payload)){
      selected.set(id,prior);payload.methodCards=saved.cards;payload.methodSelection=saved.selection;
      if(saved.material)payload.materialView=saved.material;if(saved.work)payload.work=saved.work;refresh();
    }
  }
  settleSelection();
  const delivery=sourceDeliveryManifest(all,payload.sources,explicitLookupRequests);
  if(delivery.explicitLookups.length)payload.evidenceDelivery={version:delivery.version,explicitLookups:delivery.explicitLookups};
  if(!fits(payload)){reclaimOptionalRecent(new Set(explicitLookupIds));settleSelection();}
  return {payload,coreItems,optionalRawLimit,optionalRawIds,optionalRetrieved,recentContextPlan,recentPriorityIds,recentInitialAdditionalBytes,degradation,consultationSupport:priorSupport.filter(fragment=>selected.has(fragment.sourceId)).map(fragment=>({...fragment,revision:byId.get(fragment.sourceId).revision}))};
}
module.exports={selectPlanningContext};
