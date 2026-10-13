'use strict';
const {compare,qqSourceMetadata}=require('./messages.cjs');
const {redact}=require('./model.cjs');
const TASK_VERSION='relationship-task-2026-10-13.1';
function orderedActual(records){return records.filter(m=>m.kind==='actual'&&!m.recalled&&m.text!=='[已撤回]').sort(compare);}
function recentExchange(records){
 const actual=orderedActual(records);let start=actual.length;
 for(let n=0;n<2&&start>0;n++){const direction=actual[start-1].direction;do{start--;}while(start>0&&actual[start-1].direction===direction);}
 return actual.slice(start);
}
function quoteTarget(message,records,available){
 const reply=message.replyTo;if(!reply||reply.targetUnavailable)return null;
  const eligible=orderedActual(records).filter(m=>available.has(`qq:${m.messageId}`)&&
  (!reply.direction||m.direction===reply.direction)&&(!reply.senderUin||m.senderUin===reply.senderUin)&&
  (!reply.senderUid||reply.senderUid===(m.senderUid||(m.direction==='outgoing'?m.accountUid:m.peerUid))));
 if(reply.messageId){const found=eligible.find(m=>m.messageId===reply.messageId);return found&&(!reply.sequence||found.sequence===reply.sequence)?found:null;}
 if(!reply.sequence)return null;
 const matches=eligible.filter(m=>m.sequence===reply.sequence);
 return matches.length===1&&(reply.direction||reply.senderUin||reply.senderUid)?matches[0]:null;
}
function requiredQuoteSources(records,available,selectedIds=[]){const explicit=new Set(selectedIds);return [...new Set([...recentExchange(records),...records.filter(m=>explicit.has(m.messageId))].map(m=>quoteTarget(m,records,available)).filter(Boolean).map(m=>`qq:${m.messageId}`))];}
function retrievalQuery({text,records,companion,transient=false}){
 const recent=recentExchange(records),incoming=recent.filter(m=>m.direction==='incoming'),outgoing=recent.filter(m=>m.direction==='outgoing');
 const previous=(companion.turns||[]).filter(t=>t.role==='user'&&!t.memoryExcluded&&t.text!==text).slice(-2);
 const topic=(companion.topics?.items||[]).find(t=>t.id===companion.topics.activeId&&t.lifecycle==='active');
 const parts=[...(!transient?[text]:[]),...incoming.map(m=>m.text),...outgoing.map(m=>m.text),...previous.map(t=>t.text),topic?.objective,topic?.direction];
 // The query is a retrieval hint, not quoted evidence. Its cap never slices
 // the actual current request or the protected latest exchange in the model.
 return [...new Set(parts.filter(p=>typeof p==='string'&&p.trim()).map(redact))].join('\n').slice(0,4000)||redact(text);
}
function taskContext({records,sources,scope,coverage,generationOrigin,currentSourceId,responsePreference}){
 const byId=new Map(sources.map(s=>[s.id,s]));
 const available=orderedActual(records).filter(m=>byId.has(`qq:${m.messageId}`));
 const recent=recentExchange(available),latest=available.at(-1)||null;
 const view=m=>{const source=byId.get(`qq:${m.messageId}`),meta=qqSourceMetadata(m),result={sourceId:source.id,text:source.text,speaker:source.speaker|| (m.direction==='outgoing'?'我':'对方'),direction:m.direction,at:source.at,...(meta.sequence?{sequence:meta.sequence}:{})};
  if(source.historicalOnly)result.historicalOnly=true;
  if(m.replyTo){const target=quoteTarget(m,available,byId),s=target&&byId.get(`qq:${target.messageId}`);result.quote=s?{sourceId:s.id,availability:'available',speaker:s.speaker,text:s.text,at:s.at,...(s.historicalOnly?{historicalOnly:true}:{})}:{availability:'unavailable'};}
  return result;
 };
 const lastIncoming=available.findLastIndex(m=>m.direction==='incoming'),lastOutgoing=available.findLastIndex(m=>m.direction==='outgoing');
 return {version:TASK_VERSION,requestOrigin:generationOrigin,currentRequestSourceId:currentSourceId,
  ...(typeof responsePreference==='string'&&responsePreference.trim()?{responsePreference:redact(responsePreference)}:{}),
  latestActual:latest?{sourceId:`qq:${latest.messageId}`,direction:latest.direction,speaker:latest.direction==='outgoing'?'我':'对方',at:new Date(latest.timestamp).toISOString(),sequence:latest.sequence}:null,
  recentExchange:recent.map(view),selfMessagesAfterLastContact:available.slice(lastIncoming+1).filter(m=>m.direction==='outgoing').map(m=>`qq:${m.messageId}`),
  contactMessagesAfterLastSelf:available.slice(lastOutgoing+1).filter(m=>m.direction==='incoming').map(m=>`qq:${m.messageId}`),
  observationCoverage:{status:coverage?.status||'unknown',checkedAt:coverage?.checkedAt||null},
  selfEvidenceSourceIds:sources.filter(s=>s.type==='qq'&&s.direction==='outgoing'||s.type==='private'&&s.role==='user'||s.type==='note'&&s.kind!=='preference').map(s=>s.id),
  auxiliaryPolicy:'best_effort',factsRule:'这里只是当前可用的本人原话与实际交流，不是完整个人资料或披露许可。未提供的住址、距离、动机、收入、感受和打算保持未知；引用目标缺失不能猜内容。最后发言者是事实，不是必须等待或必须补话的规则。'};
}
module.exports={TASK_VERSION,recentExchange,requiredQuoteSources,quoteTarget,retrievalQuery,taskContext};
