'use strict';
const {compare,qqSourceMetadata,sameScope}=require('../messages.cjs');
const {redact}=require('../model.cjs');
const TASK_VERSION='relationship-task-2026-10-16.2';
const RECENT_CONTEXT_LIMITS=Object.freeze({maxMessages:24,maxGapMs:30*60*1000,maxSpanMs:2*60*60*1000,maxAdditionalBytes:12000});
function recentHistoryPolicy(asOf,settings={}){
 const configured=Number(settings.assistantRecentHours),hours=Number.isFinite(configured)&&configured>0?Math.min(720,configured):72;
 return {version:1,recentHours:hours,since:new Date(Date.parse(asOf)-hours*3600000).toISOString(),asOf,
  currentEpisode:{maxGapMs:RECENT_CONTEXT_LIMITS.maxGapMs,maxSpanMs:RECENT_CONTEXT_LIMITS.maxSpanMs},
  loading:'complete_source_segments_within_request_budget',older:'core_summaries_and_explicit_or_ranked_lookup',optimality:'user_configured_window_not_quality_evidence'};
}
function recentHistorySegments(records,policy){
 const since=Date.parse(policy.since),until=Date.parse(policy.asOf),groups=[];let group=[];
 for(const message of orderedActual(records).filter(m=>m.timestamp>=since&&m.timestamp<=until)){
  if(group.length&&(message.timestamp-group.at(-1).timestamp>policy.currentEpisode.maxGapMs||message.timestamp-group[0].timestamp>policy.currentEpisode.maxSpanMs)){groups.push(group);group=[];}
  group.push(message);
 }
 if(group.length)groups.push(group);
 return groups;
}
function orderedActual(records){return records.filter(m=>m.kind==='actual'&&!m.recalled&&m.text!=='[已撤回]').sort(compare);}
function recentExchange(records){
 const actual=orderedActual(records);let start=actual.length,bursts=0,lastDirection=null;
 const newest=actual.at(-1);
 while(start>0){
  const message=actual[start-1],following=actual[start];
  if(following&&(following.timestamp-message.timestamp>RECENT_CONTEXT_LIMITS.maxGapMs||newest.timestamp-message.timestamp>RECENT_CONTEXT_LIMITS.maxSpanMs))break;
  if(message.direction!==lastDirection){if(bursts===2)break;bursts++;lastDirection=message.direction;}
  start--;
 }
 return actual.slice(start);
}
function planRecentContext(records,{replyMessageIds=[],imageMessageIds=[],byteBudget=48000}={}){
 const actual=orderedActual(records),indices=new Map(actual.map((m,i)=>[m.messageId,i])),anchors=new Map();
 const anchor=(id,reason)=>{if(!indices.has(id))return;const entry=anchors.get(id)||{messageId:id,reasons:[],index:indices.get(id)};if(!entry.reasons.includes(reason))entry.reasons.push(reason);anchors.set(id,entry);};
 if(actual.length)anchor(actual.at(-1).messageId,'latest');
 for(const id of replyMessageIds)anchor(id,'reply_focus');
 for(const id of imageMessageIds)anchor(id,'image');
 const limits={...RECENT_CONTEXT_LIMITS,maxAdditionalBytes:Math.min(RECENT_CONTEXT_LIMITS.maxAdditionalBytes,Math.floor(byteBudget/4))};
 const windows=[...anchors.values()].map(a=>({...a,indices:new Set([a.index]),left:a.index,right:a.index,boundaryBefore:null,boundaryAfter:null}));
 const candidates=[...anchors.keys()],seen=new Set(candidates);
 // Round-robin expansion leaves room for both the live exchange and explicit
 // focus/image neighborhoods. No text classifier decides where a topic ends.
 let changed=true;
 while(changed&&seen.size<limits.maxMessages){
  changed=false;
  for(const window of windows){
   for(const side of ['before','after']){
    const key=side==='before'?'boundaryBefore':'boundaryAfter';if(window[key])continue;
    const edge=side==='before'?window.left:window.right,next=edge+(side==='before'?-1:1);
    if(next<0||next>=actual.length){window[key]='accessible_end';continue;}
    if(Math.abs(actual[next].timestamp-actual[edge].timestamp)>limits.maxGapMs){window[key]='time_gap';continue;}
    if(Math.abs(actual[next].timestamp-actual[window.index].timestamp)>limits.maxSpanMs){window[key]='time_span';continue;}
    if(!seen.has(actual[next].messageId)&&seen.size>=limits.maxMessages){window[key]='count_limit';continue;}
    window.indices.add(next);if(side==='before')window.left=next;else window.right=next;changed=true;
    if(!seen.has(actual[next].messageId)){seen.add(actual[next].messageId);candidates.push(actual[next].messageId);}
   }
  }
 }
 return {limits,candidateMessageIds:candidates,windows:windows.map(window=>({anchorSourceId:`qq:${window.messageId}`,reasons:window.reasons,
  sourceIds:[...window.indices].sort((a,b)=>a-b).map(i=>`qq:${actual[i].messageId}`),boundaryBefore:window.boundaryBefore||'count_limit',boundaryAfter:window.boundaryAfter||'count_limit'}))};
}
function recentContextView(plan,records,available){
 const actual=orderedActual(records),indices=new Map(actual.map((m,i)=>[`qq:${m.messageId}`,i]));
 const windows=plan.windows.map(window=>({...window,sourceIds:window.sourceIds.filter(id=>available.has(id)),
  omittedMessageCount:window.sourceIds.filter(id=>!available.has(id)).length}));
 const candidateIds=new Set(plan.candidateMessageIds.map(id=>`qq:${id}`)),gaps=[];
 const included=actual.filter(m=>candidateIds.has(`qq:${m.messageId}`)&&available.has(`qq:${m.messageId}`));
 for(let i=1;i<included.length;i++){
  const previous=included[i-1],current=included[i],omittedAccessibleMessageCount=indices.get(`qq:${current.messageId}`)-indices.get(`qq:${previous.messageId}`)-1,gapMs=current.timestamp-previous.timestamp;
  if(omittedAccessibleMessageCount||gapMs>plan.limits.maxGapMs)gaps.push({afterSourceId:`qq:${previous.messageId}`,beforeSourceId:`qq:${current.messageId}`,gapMs,omittedAccessibleMessageCount});
 }
 for(const window of windows){
  const original=plan.windows.find(item=>item.anchorSourceId===window.anchorSourceId),first=window.sourceIds[0],last=window.sourceIds.at(-1);
  if(!first)continue;
  const leading=original.sourceIds.indexOf(first),trailing=original.sourceIds.length-1-original.sourceIds.indexOf(last);
  if(leading)gaps.push({beforeSourceId:first,omittedAccessibleMessageCount:leading});
  if(trailing)gaps.push({afterSourceId:last,omittedAccessibleMessageCount:trailing});
 }
 return {selection:'bounded_actual_neighborhoods',limits:plan.limits,windows,gaps,coverage:'accessible_messages_only_not_complete_history'};
}
function projectRecentContext(view,available){
 const result=structuredClone(view);
 result.gaps=result.gaps.filter(gap=>(!gap.afterSourceId||available.has(gap.afterSourceId))&&(!gap.beforeSourceId||available.has(gap.beforeSourceId)));
 for(const window of result.windows){
  const previous=[...window.sourceIds];window.sourceIds=previous.filter(id=>available.has(id));window.omittedMessageCount+=previous.length-window.sourceIds.length;
  for(let i=1;i<window.sourceIds.length;i++){
   const afterSourceId=window.sourceIds[i-1],beforeSourceId=window.sourceIds[i],omittedAccessibleMessageCount=previous.indexOf(beforeSourceId)-previous.indexOf(afterSourceId)-1;
   if(omittedAccessibleMessageCount)result.gaps.push({afterSourceId,beforeSourceId,omittedAccessibleMessageCount,gapMs:Date.parse(available.get(beforeSourceId).at)-Date.parse(available.get(afterSourceId).at)});
  }
 }
 return result;
}
function quoteTarget(message,records,available){
 const reply=message.replyTo;if(!reply||reply.targetUnavailable)return null;
 // Resolve identity against the whole scoped actual cohort, including recalled
 // or excluded rows. Availability cannot make an ambiguous key look unique.
 const eligible=records.filter(m=>m.kind==='actual'&&sameScope(m,message)&&
  (!reply.direction||m.direction===reply.direction)&&(!reply.senderUin||m.senderUin===reply.senderUin)&&
  (!reply.senderUid||reply.senderUid===(m.senderUid||(m.direction==='outgoing'?m.accountUid:m.peerUid)))&&
  (reply.timestamp===undefined||reply.timestamp===m.timestamp));
 const usable=m=>m&&!m.recalled&&m.text!=='[已撤回]'&&available.has(`qq:${m.messageId}`);
 if(reply.messageId){const found=eligible.find(m=>m.messageId===reply.messageId);return usable(found)&&(!reply.sequence||found.sequence===reply.sequence)?found:null;}
 if(!reply.sequence)return null;
 const matches=eligible.filter(m=>m.sequence===reply.sequence);
 return matches.length===1&&(reply.direction||reply.senderUin||reply.senderUid)&&usable(matches[0])?matches[0]:null;
}
function requiredQuoteSources(records,available,selectedIds=[]){const explicit=new Set(selectedIds);return [...new Set([...recentExchange(records),...records.filter(m=>explicit.has(m.messageId))].map(m=>quoteTarget(m,records,available)).filter(Boolean).map(m=>`qq:${m.messageId}`))];}
function retrievalQuery({text,records,companion,transient=false,asOf=new Date().toISOString(),settings={}}){
 const recent=recentExchange(records),incoming=recent.filter(m=>m.direction==='incoming'),outgoing=recent.filter(m=>m.direction==='outgoing');
 const policy=recentHistoryPolicy(asOf,settings);
 const previous=(companion.turns||[]).filter(t=>t.role==='user'&&!t.memoryExcluded&&t.text!==text&&Date.parse(t.createdAt)>=Date.parse(policy.since)&&Date.parse(t.createdAt)<=Date.parse(asOf)).slice(-2);
 const topic=(companion.topics?.items||[]).find(t=>t.id===companion.topics.activeId&&t.lifecycle==='active');
 const parts=[...(!transient?[text]:[]),...incoming.map(m=>m.text),...outgoing.map(m=>m.text),...previous.map(t=>t.text),topic?.objective,topic?.direction];
 // The query is a retrieval hint, not quoted evidence. Its cap never slices
 // the actual current request or the protected latest exchange in the model.
 return [...new Set(parts.filter(p=>typeof p==='string'&&p.trim()).map(redact))].join('\n').slice(0,4000)||redact(text);
}

module.exports={TASK_VERSION,RECENT_CONTEXT_LIMITS,recentHistoryPolicy,recentHistorySegments,orderedActual,recentExchange,planRecentContext,recentContextView,projectRecentContext,quoteTarget,requiredQuoteSources,retrievalQuery};
