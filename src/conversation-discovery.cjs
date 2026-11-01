'use strict';
// A bounded navigation directory for broad requests. This selects where to
// inspect, never what a person feels or what may be disclosed in a draft.
const {terms,focusSourceOffset}=require('./memory-search.cjs');
const {redact}=require('./model.cjs');
const VERSION='conversation-discovery-2026-10-30.1';
const usable=source=>source&&!source.deleted&&!source.excluded&&source.use!=='disabled';
function discoverConversationEvidence({sources=[],records=[],query='',goal='',asOf=new Date().toISOString(),limit=8,mode='broad'}={}){
 const byId=new Map(sources.filter(usable).map(source=>[source.id,source]));
 const wanted=new Set(terms(mode==='anchored'?query:`${query}\n${goal}`).filter(term=>term.length>1));
 const now=Date.parse(asOf),candidates=[];
 const overlap=text=>[...new Set(terms(text))].reduce((n,term)=>n+(wanted.has(term)?1:0),0);
 const short=text=>[...redact(String(text||''))].slice(0,110).join('');
 for(const record of records){
  if(record.deleted)continue;
  const ids=[...new Set(record.sourceIds||[])];
  if(!ids.length||ids.some(id=>!byId.has(id)||record.sourceRevisions?.[id]&&record.sourceRevisions[id]!==byId.get(id).revision))continue;
  const at=record.lastEvidenceAt||record.validFrom||record.at||record.createdAt||byId.get(ids[0]).at;
  const age=Math.max(0,(now-Date.parse(at))/86400000),expired=record.validUntil&&Date.parse(record.validUntil)<now;
  const kind=record.recordType||record.kind||record.type||'knowledge',aspect=record.aspect||record.kind||kind;
  const relevance=overlap(`${record.text||''} ${record.activityKey||''} ${(record.topicKeys||[]).join(' ')}`);
  if(mode==='anchored'&&!relevance)continue;
  const score=relevance*8+
    (aspect==='interest'?12:kind==='relationship_event'||aspect==='commitment'?7:3)+Math.max(0,5-Math.log2(age+1))-(expired?8:0);
  candidates.push({id:record.id||ids.join('|'),sourceIds:ids,subject:record.subject||'unknown',kind,aspect,at,score,
    activityKey:record.activityKey||null,lifecycle:record.lifecycle||record.status||'unspecified',text:short(record.text),epistemicStatus:record.epistemicStatus||record.certainty||'unspecified',assertionKind:record.assertionKind||'unspecified',temporalStatus:expired?'expired':record.validUntil?'bounded_by_evidence':'date_and_continuation_need_review',
    authority:'derived_navigation_requires_original_evidence'});
 }
 // Raw fallback also works while the background memory queue is incomplete.
 // It uses actor/time/lexical cues, not a psychological classifier or a grant.
 const indexedSources=new Set(candidates.flatMap(item=>item.sourceIds));
 for(const source of byId.values()){
  if(indexedSources.has(source.id))continue;
  if(!source.text||!['qq','private','note'].includes(source.type))continue;
  if(source.kind==='feedback_continue'||source.kind==='user_control')continue;
  if(mode==='anchored'&&!overlap(source.text))continue;
  const age=Math.max(0,(now-Date.parse(source.at||source.createdAt||asOf))/86400000);
  // Speaker identity is derived, never defaulted: a QQ source without a
   // usable direction stays undetermined instead of silently becoming self.
   const sourceSpeaker=source.type==='qq'
     ?(source.direction==='incoming'?'contact':source.direction==='outgoing'?'self':'undetermined')
     :source.role==='user'?'private_user':'undetermined';
  candidates.push({id:`raw:${source.id}`,sourceIds:[source.id],subject:'undetermined',sourceSpeaker,kind:'raw_source',aspect:source.type,at:source.at||source.createdAt,
    score:overlap(source.text)*8+Math.max(0,4-Math.log2(age+1))+(source.type==='note'&&source.use==='draft'?3:0),text:short(redact(source.text).slice(focusSourceOffset(redact(source.text),query))),
    temporalStatus:'source_time_not_current_state',authority:'raw_preview_navigation_not_disclosure_permission'});
 }
 candidates.sort((a,b)=>b.score-a.score||Date.parse(b.at||0)-Date.parse(a.at||0)||a.id.localeCompare(b.id));
 const chosen=[],seen=new Set(),cohorts=new Map();
 const add=item=>{const key=item.id;if(seen.has(key))return false;seen.add(key);chosen.push(item);const group=`${item.subject}:${item.aspect}`;cohorts.set(group,(cohorts.get(group)||0)+1);return true;};
 // Prevent one high-volume actor/aspect from hiding every other usable lead.
 for(const item of candidates){if(chosen.length>=limit)break;if((cohorts.get(`${item.subject}:${item.aspect}`)||0)<2){add(item);if(item.activityKey&&chosen.length<limit){const later=candidates.find(other=>other.id!==item.id&&other.activityKey===item.activityKey&&['cancelled','resolved','superseded','withdrawn'].includes(other.lifecycle)&&Date.parse(other.at||0)>=Date.parse(item.at||0));if(later)add(later);}}}
 for(const item of candidates){if(chosen.length>=limit)break;add(item);}
 const sourceIds=[...new Set(chosen.flatMap(item=>item.sourceIds))];
 return {version:VERSION,mode,directory:chosen.map(({score,...item})=>{const all=item.sourceIds,sourceIds=all.slice(0,4);return {...item,sourceIds,omittedSupportCount:all.length-sourceIds.length,sourceRefs:sourceIds.map(id=>({sourceId:id,revision:byId.get(id).revision})),requiresOriginalRead:true};}),sourceIds,
  sources:sourceIds.map(id=>{const source=byId.get(id),offset=focusSourceOffset(redact(source.text),query);return {...source,offset,maxChars:4000};}),rule:'目录用于发现可核对的旧事、自述和共同背景；先核对原文、后续变化和已表达内容，不能把预览当当前事实、未聊过证明或分享授权。'};
}
module.exports={discoverConversationEvidence,CONVERSATION_DISCOVERY_VERSION:VERSION};
