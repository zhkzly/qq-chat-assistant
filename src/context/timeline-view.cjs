'use strict';
const {qqSourceMetadata,sameScope}=require('../messages.cjs');
const {redact}=require('../model.cjs');
const {TASK_VERSION,orderedActual,recentExchange,quoteTarget,recentContextView}=require('./policy.cjs');
function invocationFor(value,purpose){
 const result={};
 if(['user','automatic'].includes(value?.origin))result.origin=value.origin;
 if(['automatic_observation','manual_suggestion','feedback_followup','private_request'].includes(value?.trigger))result.trigger=value.trigger;
 result.requestedPurpose=['discussion','reply','review','draft','draft_prepare'].includes(value?.requestedPurpose)?value.requestedPurpose:purpose;
 return result;
}
function taskContext({records,sources,scope,coverage,generationOrigin,currentSourceId,responsePreference,recentContextPlan,asOf,viewerTimeZone,invocation,purpose,replyMessageIds=[]}){
 const byId=new Map(sources.map(s=>[s.id,s]));
 const scoped=records.filter(m=>sameScope(m,scope)),available=orderedActual(scoped).filter(m=>byId.has(`qq:${m.messageId}`));
 const recentIds=recentContextPlan&&new Set([...recentContextPlan.candidateMessageIds,...recentExchange(scoped).map(m=>m.messageId)]);
 const recent=recentIds?available.filter(m=>recentIds.has(m.messageId)):recentExchange(available),latest=available.at(-1)||null,explicitFocus=new Set(replyMessageIds);
 const formatter=new Intl.DateTimeFormat('en-CA',{timeZone:viewerTimeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
 const localAt=at=>{const timestamp=typeof at==='number'?at:Date.parse(at);if(!Number.isFinite(timestamp))return null;const parts=Object.fromEntries(formatter.formatToParts(new Date(timestamp)).map(item=>[item.type,item.value]));return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;};
 const elapsed=at=>{const timestamp=Date.parse(at),delta=Date.parse(asOf)-timestamp;return Number.isFinite(delta)?{elapsedMinutes:Math.trunc(delta/60000),...(delta<0?{clockAnomaly:'future_timestamp'}:{})}:{};};
 // Local display times are useful at the actual latest/selected anchors. The
 // other rows retain canonical UTC times without duplicating every timestamp.
 const view=m=>{const source=byId.get(`qq:${m.messageId}`),meta=qqSourceMetadata(m),result={sourceId:source.id,text:source.text,speaker:source.speaker|| (m.direction==='outgoing'?'我':'对方'),direction:m.direction,at:source.at,...(m===latest||explicitFocus.has(m.messageId)?{localAt:localAt(source.at)}:{}),...(meta.sequence?{sequence:meta.sequence}:{})};
  if(source.historicalOnly)result.historicalOnly=true;
  if(m.replyTo){const target=quoteTarget(m,records,byId),s=target&&byId.get(`qq:${target.messageId}`);result.quote=s?{sourceId:s.id,availability:'available',speaker:s.speaker,text:s.text,at:s.at,localAt:localAt(s.at),...(s.historicalOnly?{historicalOnly:true}:{})}:{availability:'unavailable'};}
  return result;
 };
 const lastIncoming=available.findLastIndex(m=>m.direction==='incoming'),lastOutgoing=available.findLastIndex(m=>m.direction==='outgoing');
 const call=invocationFor(invocation,purpose);
 const focused=replyMessageIds.length?available.filter(m=>explicitFocus.has(m.messageId)):latest?[latest]:[];
 return {version:TASK_VERSION,requestOrigin:generationOrigin,currentRequestSourceId:currentSourceId,
  // The canonical UTC clock and viewer zone already live at the payload root.
  ...(invocation?{invocation:call}:{}),timeContext:{localNow:localAt(asOf)},
  consultationTask:{purpose:call.requestedPurpose,focusOrigin:replyMessageIds.length?'explicit_selection':latest?'latest_available':'none',
   // An implicit latest focus uses latestActual's clock instead of duplicating it.
   focus:focused.map(m=>({sourceId:`qq:${m.messageId}`,...(replyMessageIds.length?{localAt:localAt(m.timestamp),...elapsed(new Date(m.timestamp).toISOString())}:{}),laterAvailableMessageCount:available.length-available.indexOf(m)-1}))},
  ...(typeof responsePreference==='string'&&responsePreference.trim()?{responsePreference:redact(responsePreference)}:{}),
  latestActual:latest?{sourceId:`qq:${latest.messageId}`,direction:latest.direction,speaker:latest.direction==='outgoing'?'我':'对方',at:new Date(latest.timestamp).toISOString(),sequence:latest.sequence,
   localAt:localAt(latest.timestamp),...elapsed(new Date(latest.timestamp).toISOString()),
   ...(Number.isFinite(Date.parse(asOf))?{ageMs:Date.parse(asOf)-latest.timestamp}:{})}:null,
  recentExchange:recent.map(view),selfMessagesAfterLastContact:available.slice(lastIncoming+1).filter(m=>m.direction==='outgoing').map(m=>`qq:${m.messageId}`),
  ...(recentContextPlan?{recentContext:recentContextView(recentContextPlan,scoped,byId)}:{}),
  contactMessagesAfterLastSelf:available.slice(lastOutgoing+1).filter(m=>m.direction==='incoming').map(m=>`qq:${m.messageId}`),
  observationCoverage:{status:coverage?.status||'unknown',checkedAt:coverage?.checkedAt||null},
  selfEvidenceSourceIds:sources.filter(s=>s.type==='qq'&&s.direction==='outgoing'||s.type==='private'&&s.role==='user'||s.type==='note'&&s.kind!=='preference').map(s=>s.id),
  auxiliaryPolicy:'best_effort',factsRule:'仅限已提供原话，不补未知事实或分享授权。'};
}
module.exports={taskContext};
