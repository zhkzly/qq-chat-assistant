'use strict';
const {redact}=require('../model.cjs');
const {sanitize,pick,bytes}=require('./shared.cjs');
const {supportedByAvailable}=require('./source-snapshot.cjs');
function modelTopic(record) {
  const projected = sanitize(record);
  // Revisions have already been checked against full sources. Keep source IDs
  // and field authority in the model view; the manifest owns the exact hashes.
  for (const key of ['sourceRevisions','purposeSourceRevisions','observationSourceRevisions','lifecycleSourceRevisions']) delete projected[key];
  for (const key of ['purposeBindings','observationBindings']) if (projected[key]) projected[key] = Object.fromEntries(
    Object.entries(projected[key]).map(([field, binding]) => {
      const copy = { ...binding }; delete copy.sourceRevisions; return [field, copy];
    }));
  return projected;
}
function relevantTo(text, item) {
  const ignored = new Set(['今天','最近','什么','怎么','这个','那个','我们','你们','她的','我的','帮我','一下','觉得','想要','可以','现在','已经']);
  const terms = [...new Set([...(String(text).toLowerCase().match(/[a-z0-9_]{3,}/g) || []),
    ...(String(text).match(/[\p{Script=Han}]{2}/gu) || []).filter(term => !ignored.has(term))])];
  const haystack = `${item.text || ''} ${(item.topicKeys || []).join(' ')}`.toLowerCase();
  return terms.some(term => haystack.includes(term));
}
function projectActualActions(actions, byId, scope) {
  return (actions || []).flatMap(action => {
    if (action.kind === 'user_reported_activity') {
      if (!action.sourceRevisions || !action.sourceIds?.every(id => action.sourceRevisions[id]) || !supportedByAvailable(action, byId, scope)) return [];
      return [{ ...pick(action, ['kind','activityId','eventAt','sourceIds','sourceRevisions']), authority: 'reported_not_directly_observed' }];
    }
    const id = `qq:${action.messageId}`;
    if (byId.get(id)?.type !== 'qq') return [];
    return [{ ...pick(action, ['kind','messageId','eventAt','availability']), sourceId: id }];
  });
}
function projectObservations(observations, byId, scope) {
  return (observations || []).flatMap(observation => {
    if (observation.kind === 'activity_event') {
      if (!observation.sourceRevisions || !observation.sourceIds?.every(id => observation.sourceRevisions[id]) || !supportedByAvailable(observation, byId, scope)) return [];
      return [{ ...pick(observation, ['kind','relationshipEventId','eventKind','text','sourceIds','sourceRevisions','eventAt','lifecycle']),
        authority: observation.sourceIds.every(id => byId.get(id)?.type === 'qq') ? 'derived_from_qq_statements' : 'derived_from_user_report' }];
    }
    const id = observation.sourceId || `qq:${observation.messageId}`;
    if (byId.get(id)?.type !== 'qq') return [];
    return [{ ...pick(observation, ['kind','messageId','eventAt','relevance','authority']), sourceId: id }];
  });
}
const actionSources = items => items.flatMap(item => item.sourceIds || [item.sourceId]).filter(Boolean);

function coreCatalog(inventory,byId,scope){
  const result=[],coreSeen=new Set();let coreBytes=0;
  for(const item of inventory){
    if(result.length>=6)break;
    const typed=!!item.subject;
    const stable=typed?item.lifecycle==='active'&&item.assertionKind==='stated'&&item.epistemicStatus==='supported':
      ['fact','preference'].includes(item.kind)&&item.status==='active'&&['stated','supported'].includes(item.certainty||'stated');
    if(!stable||item.reviewComplete===false||!supportedByAvailable(item,byId,scope)||coreSeen.has(item.id))continue;
    const summary=sanitize(pick(item,['id','version','kind','subject','aspect','text','assertionKind','epistemicStatus','sourceIds','firstEvidenceAt','lastEvidenceAt','validFrom','validUntil','applicability','currentApplicability']));
    summary.authority='validated_historical_summary_originals_available_by_lookup';
    summary.currentStatus=summary.currentApplicability||summary.applicability||'not_established_by_old_evidence';
    if(coreBytes+bytes(summary)>4000)continue;
    result.push(summary);coreSeen.add(item.id);coreBytes+=bytes(summary);
  }
  return result;
}
function currentCandidateAnchor(companion,reference){
  if(!reference||typeof reference.turnId!=='string')return null;
  const turn=(companion.turns||[]).find(item=>item.id===reference.turnId&&item.role==='assistant'&&!item.memoryExcluded);
  if(!turn)return null;
  const hasIndex=reference.suggestionIndex!==undefined;
  if(hasIndex&&(!Number.isInteger(reference.suggestionIndex)||reference.suggestionIndex<0))return null;
  const item=hasIndex?turn.suggestions?.[reference.suggestionIndex]:turn;
  const expected=item?.artifactRef,actual=reference.artifactRef;
  if(!expected||!actual||expected.artifactId!==actual.artifactId||expected.version!==actual.version||typeof item.text!=='string'||!item.text.trim())return null;
  // The program captured this one generated discussion target. This is neither
  // explicit source selection nor permission to expose its former inputs.
  return {turnId:turn.id,field:hasIndex?'suggestions':'text',...(hasIndex?{index:reference.suggestionIndex}:{}),
    text:redact(item.text),artifactRef:structuredClone(expected),origin:turn.origin||reference.origin||'unknown',availability:'full',
    selection:'implicit_discussion_anchor',authority:'generated_current_candidate_not_outbound_authorization'};
}
module.exports={modelTopic,relevantTo,projectActualActions,projectObservations,actionSources,coreCatalog,currentCandidateAnchor};
