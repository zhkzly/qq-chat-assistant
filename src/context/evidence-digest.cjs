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
// Declared arrangements (availability/willingness tied to a near-time
// expression) are decision-critical for invitation-type answers, yet they can
// sit mid-document inside an entry body whose first sentence hides them. The
// digest surfaces them as verbatim sentence lines of their own with exact
// ranges and lookup handles. Lexical markers only: sentences stay verbatim
// and unmatched text simply stays inside its entry, never invented.
const DECLARATION_TIME=/周[一二三四五六日末天]|这?周末|[今明后]天|下?周|上午|中午|下午|傍晚|晚上|夜里|凌晨|[0-9０-９一二三四五六七八九十两]+点半?|\d{1,2}[:：]\d{2}/u;
const DECLARATION_AVAILABILITY=/有空|没空|没时间|有时间|不方便|方便|愿意|想去|想看|想一起|能一起|可以一起|不行|去不了|能去|可以去|想参加|想试/u;
const DECLARATION_CHARS=160, MAX_DECLARATIONS=6, DECLARATION_BYTE_BUDGET=1500;

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
// Verbatim arrangement/availability sentences with exact UTF-16 ranges. A
// qualifying sentence carries both a near-time expression and an
// availability/willingness marker; anything else stays in its entry body.
function declarationSentences(text){
  const found=[];let index=0;
  while(index<text.length&&found.length<MAX_DECLARATIONS){
    while(index<text.length&&/\s/u.test(text[index]))index++;
    if(index>=text.length)break;
    let end=index;
    while(end<text.length&&!SENTENCE_END.test(text[end]))end++;
    if(end<text.length)end++;
    const length=end-index;
    if(length>0&&length<=DECLARATION_CHARS){
      const sentence=text.slice(index,end);
      if(DECLARATION_TIME.test(sentence)&&DECLARATION_AVAILABILITY.test(sentence))
        found.push({sentence,start:index,end});
    }
    index=end;
  }
  return found;
}
function digestSource(source,{maxEntries=MAX_ENTRIES,byteBudget=ENTRY_BYTE_BUDGET}={}){
  if(!source||typeof source.text!=='string'||!source.text.trim())return null;
  const text=source.text,entries=splitEntries(text);
  if(!entries.length)return null;
  const view={id:source.id,type:source.type,role:source.role,at:source.at,use:source.use,
    ...(source.kind?{kind:source.kind}:{}),...(source.direction?{direction:source.direction}:{}),
    revision:source.revision,digest:{version:DIGEST_VERSION,authority:'derived_digest_needs_lookup',
      rule:'verbatim first sentences with exact ranges; the complete original stays retrievable per entry',
      originalCharLength:text.length,entryCount:entries.length,entries:[]},
    delivery:{version:'source-delivery-v1',status:'digest',start:0,end:0,originalCharLength:text.length,offsetUnit:'utf16_redacted_source',lookup:{sourceId:source.id,revision:source.revision,offset:0}}};
  const list=view.digest.entries;let used=0,omitted=0;
  for(const entry of entries){
    const sentence=firstSentence(entry.body);
    const line={sentence,start:entry.start,end:entry.end,
      lookup:{sourceId:source.id,revision:source.revision,offset:entry.start,maxChars:Math.max(1,entry.end-entry.start)}};
    const cost=bytes(line);
    if(list.length>=maxEntries||used+cost>byteBudget){omitted++;continue;}
    list.push(line);used+=cost;
  }
  if(omitted)view.digest.omittedEntryCount=omitted;
  if(!list.length)return null;
  view.digest.coveredCharRange={start:list[0].start,end:list.at(-1).end};
  // Declared arrangements ride along even when their entry was omitted or
  // its first sentence hides them: verbatim sentence, exact range, lookup.
  const declared=declarationSentences(text).filter(item=>!list.some(line=>line.sentence===item.sentence));
  let declarationBytes=0,declarationOmitted=0;
  const declarations=declared.flatMap(item=>{
    const line={sentence:item.sentence,start:item.start,end:item.end,
      lookup:{sourceId:source.id,revision:source.revision,offset:item.start,maxChars:Math.max(1,item.end-item.start)}};
    const cost=bytes(line);
    if(declarationBytes+cost>DECLARATION_BYTE_BUDGET){declarationOmitted++;return[];}
    declarationBytes+=cost;return[line];
  });
  if(declarations.length){
    view.digest.declarations=declarations;
    view.digest.declarationRule='已声明安排/可用性为逐字原句加精确范围，仅导航非许可；与来信邀约一致时直接采用并给可发送的接受与时间，不把已声明意愿变成核对问句；未声明、过期或冲突才澄清；外发引用前按lookup取回完整原文';
    if(declarationOmitted)view.digest.omittedDeclarationCount=declarationOmitted;
  }
  return view;
}
function isDigestSource(source){return source?.digest?.version===DIGEST_VERSION;}
module.exports={DIGEST_VERSION,digestSource,isDigestSource,splitEntries,firstSentence,declarationSentences};
