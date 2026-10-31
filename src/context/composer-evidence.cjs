'use strict';

const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const speaker=source=>typeof source?.role==='string'?source.role:'unknown';
const recordedAt=source=>typeof source?.recordedAt==='string'?source.recordedAt:null;

// The input is already admitted canonical material. This is a conversational
// view only: the caller retains the full provenance and dependency witnesses.
function projectQuote(quote){
 if(!object(quote)||!object(quote.provenance)||!object(quote.provenance.source))return quote;
 const {provenance,...view}=quote,source=provenance.source;
 if(source.type!=='note')return {...view,origin:{speaker:speaker(source),recordedAt:recordedAt(source)}};
 const roots=Array.isArray(provenance.roots)?provenance.roots:[];
 const status=provenance.metadataCompleteness==='roots_unknown'?'unknown'
  :provenance.metadataCompleteness==='roots_summarized'?'partial'
  :roots.length?'complete':'not_applicable';
 return {...view,origin:{speaker:speaker(source),noteEditedAt:recordedAt(source),
  originalRecords:roots.map(root=>root.type==='note'||root.timeMeaning==='note_edited'
   ?{speaker:speaker(root),noteEditedAt:recordedAt(root)}
   :{speaker:speaker(root),recordedAt:recordedAt(root)}),originalRecordsStatus:status}};
}

function projectComposerEvidence(payload){
 if(!object(payload))return payload;
 const view=structuredClone(payload);
 const project=input=>{
  if(input?.purpose==='draft'&&Array.isArray(input.outboundQuotes))input.outboundQuotes=input.outboundQuotes.map(projectQuote);
 };
 project(view);
 // Repair diagnostics and arbitrary nested text are intentionally untouched.
 if(object(view.originalInput))project(view.originalInput);
 return view;
}

module.exports={projectComposerEvidence};
