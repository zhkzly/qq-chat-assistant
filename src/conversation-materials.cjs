'use strict';

// A read view over already scoped, selected evidence. This does not infer
// interest, novelty, permission, or a new permanent topic from a message.
const VERSION='conversation-materials-2026-10-16.1';
function buildMaterialView({sources=[],taskContext={},coreMemory={},relationshipContext={},allowedMaterialIds=[],work={},asOf,maxItems=10,recentHours=72}={}){
 const usable=sources.filter(source=>source&&!source.deleted&&!source.excluded&&source.use!=='disabled');
 const byId=new Map(usable.map(source=>[source.id,source])),items=[],seen=new Set();
 const limit=Math.max(1,Math.min(16,Number.isSafeInteger(maxItems)?maxItems:10));
 const hours=Number.isFinite(Number(recentHours))&&Number(recentHours)>0?Math.min(720,Number(recentHours)):72;
 const now=Date.parse(asOf),recentAfter=Number.isFinite(now)?now-hours*3600000:-Infinity;
 const add=(kind,ids,metadata={})=>{
  const sourceIds=[...new Set(ids)].filter(id=>byId.has(id));
  if(!sourceIds.length||items.length>=limit)return;
  const key=`${kind}:${sourceIds.join(',')}`;if(seen.has(key))return;seen.add(key);
  items.push({kind,sourceIds,novelty:'not_determined',...metadata});
 };
 const shortDetail=source=>typeof source.text==='string'&&source.text.length<=96?{detail:source.text}:{textLocation:'sources'};
 const windows=taskContext.recentContext?.windows||[];
 const immediate=windows.filter(window=>window.reasons?.includes('latest')).flatMap(window=>window.sourceIds||[]);
 const currentIds=(immediate.length?immediate:(taskContext.recentExchange||[]).map(message=>message.sourceId))
  .filter(id=>byId.get(id)?.type==='qq'&&!byId.get(id).historicalOnly);
 if(!currentIds.length&&byId.get(taskContext.latestActual?.sourceId)?.type==='qq'&&!byId.get(taskContext.latestActual.sourceId).historicalOnly)
  currentIds.push(taskContext.latestActual.sourceId);
 const parties=new Set(currentIds.map(id=>byId.get(id).direction==='outgoing'?'self':'contact'));
 add('current_exchange',currentIds,{owner:parties.size>1?'both':[...parties][0],availableAs:'actual_conversation',interpretation:'read_actual_order_and_speakers'});
 if(taskContext.consultationTask?.focusOrigin==='explicit_selection')
  add('selected_focus',work.focus?.sourceIds||[],{owner:'unknown',availableAs:'user_selected_evidence_verify_later_messages'});
 const alreadySaid=currentIds.filter(id=>byId.get(id).direction==='outgoing');
 add('already_expressed',alreadySaid,{owner:'self',availableAs:'actual_sent_not_a_fresh_draft'});
 const allowed=new Set(allowedMaterialIds);
 for(const source of usable)if(source.type==='note'&&source.kind!=='preference'&&source.use==='draft'&&allowed.has(source.id))
  add('authorized_self_material',[source.id],{owner:'self',availableAs:'authorized_note',at:source.at,...shortDetail(source)});
 // A dated memory is a route back to its evidence, not proof of today's job,
 // availability, feelings, or an opportunity that has never been discussed.
 for(const memory of coreMemory.items||[]){
  const ids=memory.sourceIds||memory.sourceRefs?.map(ref=>ref.sourceId)||[];
  if(!ids.length||!ids.every(id=>byId.has(id)))continue;
  const first=byId.get(ids[0]);
  add('historical_anchor',ids,{owner:memory.subject||'unknown',availableAs:'historical_reference',currentStatus:'unknown',
   ...(memory.at||memory.lastEvidenceAt||first.at?{at:memory.at||memory.lastEvidenceAt||first.at}:{})});
 }
 for(const event of relationshipContext.events||[]){
  if(event.evidenceValidity==='invalid'||event.lifecycle==='withdrawn'||event.lifecycle==='superseded')continue;
  const ids=event.sourceIds||[];if(!ids.length||!ids.every(id=>byId.has(id)))continue;
  add('arrangement_evidence',ids,{owner:event.actor||'unknown',availableAs:'verify_event_and_later_changes',eventKind:event.eventKind,
   ...(event.occurredAt?{at:event.occurredAt}:{})});
 }
 const current=new Set(currentIds);
 const prior=usable.filter(source=>source.type==='qq'&&!current.has(source.id))
  .sort((a,b)=>Date.parse(b.at||0)-Date.parse(a.at||0));
 for(const source of prior){
  const historical=source.historicalOnly||Number.isFinite(now)&&Date.parse(source.at)<recentAfter;
  add(historical?'historical_anchor':source.direction==='outgoing'?'previous_self_expression':'recent_contact_detail',[source.id],{
   owner:source.direction==='outgoing'?'self':'contact',at:source.at,
   availableAs:historical?'historical_reference':source.direction==='outgoing'?'actual_sent_not_a_fresh_draft':'actual_statement',
   ...(historical?{currentStatus:'unknown'}:{}),...shortDetail(source)});
 }
 const intent=byId.get(work.request?.sourceId);
 return {version:VERSION,items,...(intent?{currentIntent:{sourceId:intent.id,trigger:work.request.trigger,authority:'user_meaning_not_shareable_material'}}:{}),authority:'evidence_navigation_not_a_script',
  instruction:'从这些实际内容里选择这次可聊的一点。核对已表达内容、主体、日期、后续变更和本轮控制；未知不是必须逐项提问的槽位。原文以sources为准，材料类别不代表她的心理、从未聊过或新增分享许可。'};
}
module.exports={VERSION,buildMaterialView};
