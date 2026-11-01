'use strict';
const {bytes}=require('./shared.cjs');
// Deterministic, structure-aware digest of one oversized original source.
// This is the context-budget ladder's third tier: no model call, no invention.
// Every digest line is a verbatim leading sentence plus exact UTF-16 ranges
// and a per-entry lookup handle, so the model can still fetch the original.
const DIGEST_VERSION='evidence-digest-v1';
const ENTRY_MARKERS=[/^\s*第[0-9０-９一二三四五六七八九十百千两]+[项条章节步点]/u,
  /^\s*[-*•·]\s+/u,/^\s*\d+[0-9０-９]*[.、)．]\s*/u,/^\s*[（(][0-9一二三四五六七八九十]+[)）]\s*/u];
const SENTENCE_END=/[。！？!?；;]/u;
const ENTRY_BYTE_BUDGET=3000, MAX_ENTRIES=24, SENTENCE_CHARS=90;

function firstSentence(text){
  const body=text.trim();
  if(!body)return '';
  let end=-1;
  for(let index=0;index<body.length;index++){
    if(SENTENCE_END.test(body[index])){end=index+1;break;}
  }
  const sentence=end>0?body.slice(0,end):body;
  return [...sentence].length<=SENTENCE_CHARS?sentence:[...sentence].slice(0,SENTENCE_CHARS).join('')+'…';
}
// Split by structural entry markers (numbered/第N项/bullet lines). Runs of
// unmarked lines attach to the previous entry so paragraph bodies stay whole.
function splitEntries(text){
  const entries=[];let offset=0,attachTo=null;
  for(const line of text.split('\n')){
    const lineStart=offset;offset+=line.length+1;
    if(!line.trim())continue;
    const marked=ENTRY_MARKERS.some(pattern=>pattern.test(line));
    if(marked||!attachTo){
      attachTo={start:lineStart,lines:[line]};
      entries.push(attachTo);
    }else attachTo.lines.push(line);
  }
  return entries.map(entry=>{
    const end=Math.min(text.length,entry.start+entry.lines.reduce((total,line)=>total+line.length+1,-1));
    return {start:entry.start,end,body:text.slice(entry.start,end).trim()};
  }).filter(entry=>entry.body);
}
function digestSource(source,{maxEntries=MAX_ENTRIES,byteBudget=ENTRY_BYTE_BUDGET}={}){
  if(!source||typeof source.text!=='string'||!source.text.trim())return null;
  const text=source.text,entries=splitEntries(text);
  if(!entries.length)return null;
  const view={id:source.id,type:source.type,role:source.role,at:source.at,use:source.use,
    ...(source.kind?{kind:source.kind}:{}),...(source.direction?{direction:source.direction}:{}),
    revision:source.revision,digest:{version:DIGEST_VERSION,authority:'derived_digest_needs_lookup',
      rule:'逐字首句与精确范围；续读某条原文时把该条目的lookup整条照抄进顶层lookup字段（{sourceIds,offset,maxChars}），不要自行组装ID',
      originalCharLength:text.length,entryCount:entries.length,entries:[]},
    delivery:{version:'source-delivery-v1',status:'digest',start:0,end:0,originalCharLength:text.length,offsetUnit:'utf16_redacted_source',lookup:{sourceId:source.id,revision:source.revision,offset:0}}};
  const list=view.digest.entries;let used=0,omitted=0;
  for(const entry of entries){
    const sentence=firstSentence(entry.body);
    // Copy-ready lookup handle: this object is a valid fragment of the model's
    // top-level lookup field, so a continuation read never requires the model
    // to assemble or guess source identifiers.
    const line={sentence,revision:source.revision,start:entry.start,end:entry.end,
      lookup:{sourceIds:[source.id],offset:entry.start,maxChars:Math.max(1,entry.end-entry.start)}};
    const cost=bytes(line);
    if(list.length>=maxEntries||used+cost>byteBudget){omitted++;continue;}
    list.push(line);used+=cost;
  }
  if(omitted)view.digest.omittedEntryCount=omitted;
  if(!list.length)return null;
  view.digest.coveredCharRange={start:list[0].start,end:list.at(-1).end,
    sourceId:source.id,note:'digest entries cover this source; per-entry lookup handles are copy-ready'};
  return view;
}
function isDigestSource(source){return source?.digest?.version===DIGEST_VERSION;}
module.exports={DIGEST_VERSION,digestSource,isDigestSource,splitEntries,firstSentence};
