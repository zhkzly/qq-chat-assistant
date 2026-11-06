'use strict';
const {bytes}=require('./shared.cjs');
const {validationError}=require('../validation-issues.cjs');
// Offsets address the redacted canonical source body, in JavaScript UTF-16 code
// units. The source revision always identifies the complete local source.
const DELIVERY_VERSION='source-delivery-v1';
function deliveryRange(source){
 const body=String(source?.text||''),delivery=source?.delivery;
 if(!delivery)return {start:0,end:body.length,originalCharLength:body.length,status:'delivered'};
 // Legacy-complete convention (union decision D9): a delivery object without
 // any range markers is the pre-range "whole original" shape, not a zero-span
 // delivery. Explicit partial/digest/delivered statuses keep strict ranges.
 if(!delivery.status&&delivery.start===undefined&&delivery.end===undefined)return {start:0,end:body.length,originalCharLength:body.length,status:'delivered'};
 return {start:delivery.start,end:delivery.end,originalCharLength:delivery.originalCharLength,status:delivery.status};
}
function boundedSource(source,{maxBytes=6000,start=0,maxChars=Infinity}={}){
 if(!source)return null;
 const text=String(source.text||'');
 start=Number.isSafeInteger(start)&&start>=0?Math.min(start,text.length):0;
 if(start>0&&/[\uDC00-\uDFFF]/u.test(text[start]))start--;
 const room=Math.max(0,Math.min(text.length-start,Number.isFinite(maxChars)?Math.max(0,Math.trunc(maxChars)):text.length));
 if(start===0&&room===text.length&&bytes(source)<=maxBytes)return source;
 let low=0,high=room,best=null;
 while(low<=high){
  const length=Math.floor((low+high)/2);let end=start+length;
  if(end>start&&/[\uD800-\uDBFF]/u.test(text[end-1]))end--;
  const candidate={...source,text:text.slice(start,end),delivery:{version:DELIVERY_VERSION,status:'partial',start,end,originalCharLength:text.length,
   offsetUnit:'utf16_redacted_source',continuationAvailable:end<text.length,lookup:{sourceId:source.id,revision:source.revision,offset:end}},
   continuationCoverage:'source_body_partial'};
  if(bytes(candidate)<=maxBytes){best=candidate;low=length+1;}else high=length-1;
 }
 return best?.text?best:null;
}
// A ranged or digested view never counts as the delivered complete original:
// grounding, authority offers and continuity must all require completeBody.
const rangedDelivery = source => ['partial','digest'].includes(source?.delivery?.status);
const completeBody = source => !!source && !rangedDelivery(source);
function deliveredQuote(source,text){
 if(!source||typeof text!=='string'||!text||!String(source.text||'').includes(text))return null;
 const range=deliveryRange(source),local=source.text.indexOf(text);
 if(typeof source.id!=='string'||typeof source.revision!=='string'||!Number.isSafeInteger(range.start)||range.start<0||!Number.isSafeInteger(range.end)||range.end<range.start||!Number.isSafeInteger(range.originalCharLength)||range.end-range.start!==source.text.length||range.end>range.originalCharLength)return null;
 return {sourceId:source.id,revision:source.revision,start:range.start+local,end:range.start+local+text.length};
}
// Keep exact served ranges across continuation calls. Source bodies are never
// concatenated: every range still addresses the same complete source revision.
function mergeSourceReads(previous,incoming){
 const merged=new Map(previous.map(source=>[source.id,source]));
 for(const source of incoming){
  const prior=merged.get(source.id),ranges=prior?.revision===source.revision?[...(prior.readRanges||[])]:[];
  if(source.requestedRange){
   const range=deliveryRange(source);
   if(Number.isSafeInteger(range.start)&&Number.isSafeInteger(range.end)&&range.start>=0&&range.end>range.start&&range.end-range.start===String(source.text||'').length)
    ranges.push({start:range.start,end:range.end,revision:source.revision});
  }
  const unique=[...new Map(ranges.filter(range=>range.revision===source.revision).map(range=>[`${range.start}:${range.end}`,range])).values()];
  const {readRanges:discarded,...body}=source;
  merged.set(source.id,{...body,...(unique.length?{readRanges:unique}:{})});
 }
 return [...merged.values()];
}
function unitedRanges(ranges){
 const result=[];
 for(const range of ranges.filter(range=>Number.isSafeInteger(range.start)&&Number.isSafeInteger(range.end)&&range.start>=0&&range.end>range.start).sort((a,b)=>a.start-b.start||a.end-b.end)){
  const prior=result.at(-1);
  if(prior&&range.start<=prior.end)prior.end=Math.max(prior.end,range.end);else result.push({start:range.start,end:range.end});
 }
 return result;
}
function copyReadyDelivery(delivery,sourceId){
 if(!delivery)return undefined;
 if(delivery.continuationAvailable===false){const result=structuredClone(delivery);delete result.lookup;return result;}
 const next=delivery.lookup?.offset??delivery.end??0;
 return {...structuredClone(delivery),lookup:{sourceIds:[sourceId],offset:next,maxChars:Math.max(1,Math.min(8000,(delivery.originalCharLength??next+8000)-next))}};
}
// Additional current-request reads use their actual served ranges. Overlap
// with the main body is removed, and every remaining byte is budgeted as part
// of the ordinary payload. Unrendered ranges remain explicitly unknown.
function currentRequestView(view,original,reads=[],{maxReadBytes=Infinity}={}){
 const result={sourceId:view.id,sourceRevision:view.revision,text:view.text,...(view.digest?{digest:view.digest}:{}),
  ...(view.delivery?{delivery:structuredClone(view.delivery),requestDeliveryRule:'Only text and readRanges are delivered original spans; gaps are unknown. Current head/tail ranges keep the task boundary visible; no partial body grants unseen permission. Continue via delivery.lookup.'}:{})};
 if(!original||view.revision!==original.revision||typeof original.text!=='string')return result;
 const main=deliveryRange(view),tailStart=Math.max(main.end,original.text.length-1000);
 const requested=[...(view.delivery?.status==='partial'&&tailStart<original.text.length?[{start:tailStart,end:original.text.length,revision:original.revision,edge:true}]:[]),
  ...reads.filter(source=>source.id===view.id&&source.revision===original.revision).flatMap(source=>source.readRanges||
   (source.requestedRange?[{...deliveryRange(source),revision:source.revision}]:[])).filter(range=>range.revision===original.revision&&range.end<=original.text.length).reverse()];
 let remaining=maxReadBytes;
 for(const range of requested){
  let fragments=[{start:range.start,end:range.end}];
  for(const held of unitedRanges([{start:main.start,end:main.end},...(result.readRanges||[])]))fragments=fragments.flatMap(part=>[
   ...(part.start<held.start?[{start:part.start,end:Math.min(part.end,held.start)}]:[]),
   ...(part.end>held.end?[{start:Math.max(part.start,held.end),end:part.end}]:[])]).filter(part=>part.end>part.start);
  for(const part of fragments){
   const projected=boundedSource(original,{start:part.start,maxChars:part.end-part.start,maxBytes:Math.min(remaining,range.edge?4000:Infinity)});
   if(!projected?.text)continue;
   const delivered=deliveryRange(projected),entry={start:delivered.start,end:delivered.end,revision:original.revision,text:projected.text};
   if(bytes(entry)>remaining)continue;
   (result.readRanges||=[]).push(entry);remaining-=bytes(entry);
  }
 }
 if(result.readRanges)result.readRanges.sort((a,b)=>a.start-b.start);

 if(view.delivery){
  const coverage=unitedRanges([{start:main.start,end:main.end},...(result.readRanges||[])]),gaps=[];let offset=0;
  for(const range of coverage){if(range.start>offset)gaps.push({start:offset,end:range.start});offset=Math.max(offset,range.end);}
  if(offset<original.text.length)gaps.push({start:offset,end:original.text.length});
  result.delivery.unreadRanges=gaps;
  result.delivery.continuationAvailable=!!gaps.length;
  result.delivery.lookup={sourceId:view.id,revision:original.revision,offset:gaps[0]?.start??original.text.length};
 }
 return result;
}
function sourceDeliveryManifest(all,sources,explicitRequests=[],currentRequest){
 const delivered=new Map(sources.map(source=>[source.id,source])),originals=new Map(all.map(source=>[source.id,source]));
 const entry=id=>{const source=delivered.get(id),original=originals.get(id);return {sourceId:id,revision:source?.revision||original?.revision,
  status:source?(source.delivery?.status||'delivered'):'omitted',...(source?deliveryRange(source):{}),...(source?.delivery?{lookup:source.delivery.lookup}:{} )};};
 const requests=new Map(explicitRequests.map(request=>typeof request==='string'?[request,{sourceId:request}]:[request.sourceId||request.id,request]));
 const explicitLookups=[...requests].map(([id,request])=>{
  const result=entry(id),original=originals.get(id),range=delivered.has(id)?deliveryRange(delivered.get(id)):null;
  const start=request.requestedRange?.start??request.requestedRange?.offset??request.offset??request.delivery?.start??0;
  const length=request.requestedRange?.end!==undefined?request.requestedRange.end-start:request.requestedRange?.maxChars??request.maxChars??(request.delivery?request.delivery.end-request.delivery.start:Infinity);
  const end=Math.max(start,Math.min(original?.text.length??start,start+length));
  const deliveredRanges=unitedRanges([...(range?[range]:[]),...(currentRequest?.sourceId===id?currentRequest.readRanges||[]:[])]);
  const overlap=deliveredRanges.reduce((total,part)=>total+Math.max(0,Math.min(end,part.end)-Math.max(start,part.start)),0);
  result.requestedRange={start,end};
  result.requestStatus=deliveredRanges.some(part=>part.start<=start&&part.end>=end)?'delivered':overlap?'partial':'omitted';
  if(currentRequest?.sourceId===id&&currentRequest.readRanges?.length)result.deliveredRanges=deliveredRanges;
  if(result.requestStatus==='omitted')result.status='omitted';
  return result;
 });
 return {version:DELIVERY_VERSION,offsetUnit:'utf16_redacted_source',partialSourceCount:sources.filter(source=>source.delivery?.status==='partial').length,
  omittedSourceCount:all.filter(source=>!delivered.has(source.id)).length,explicitLookups,sources:sources.map(source=>entry(source.id))};
}
const boundedSourceView=(source,{offset=0,...options}={})=>boundedSource(source,{...options,start:offset});
// Join adjacent delivered spans only. A local complete original validates
// identity and offsets; it never supplies an unread body to this evidence view.
function sourceEvidence(prepared,sourceId,info={}){
 const payload=prepared?.payload||prepared||{},source=(payload.sources||[]).find(item=>item.id===sourceId);
 const captured=(prepared?.fullAvailableSources||info.availableSources||payload.sources||[]).find(item=>item.id===sourceId)||(source?.type==='request'?source:undefined);
 const bad=message=>validationError('sources','delivered_source_invalid',message);
 const usable=item=>item&&!item.deleted&&!item.excluded&&item.use!=='disabled';
 const scope=info.scope||prepared?.manifest?.scope;
 const withinScope=item=>!item?.scope||item.scope==='this_relationship'||scope&&typeof item.scope==='object'&&['accountUid','accountUin','peerUid','peerUin'].every(key=>item.scope[key]===scope[key]);
 if(!usable(source)||!usable(captured)||source.revision!==captured.revision||
  !withinScope(source)||!withinScope(captured)||prepared?.manifest?.sourceRevisions?.[sourceId]!==undefined&&prepared.manifest.sourceRevisions[sourceId]!==source.revision)
  throw bad('Delivered source is unavailable or has changed revision');
 const range=deliveryRange(source),capturedRange=deliveryRange(captured),originalLength=range.originalCharLength;
 const originalComplete=typeof captured.text==='string'&&capturedRange.start===0&&capturedRange.end===captured.text.length&&capturedRange.originalCharLength===captured.text.length&&!['digest','declarations','omitted'].includes(capturedRange.status);
 const spans=[];
 const add=(part,revision=source.revision)=>{
  if(typeof part.text!=='string'||!Number.isSafeInteger(part.start)||!Number.isSafeInteger(part.end)||part.start<0||part.end<part.start||part.end-part.start!==part.text.length||part.end>originalLength||revision!==source.revision)
   throw bad('A delivered range has invalid offsets, body or revision');
  if(originalComplete&&(captured.text.length!==originalLength||captured.text.slice(part.start,part.end)!==part.text))throw bad('A delivered range does not match its captured original');
  if(part.text)spans.push({start:part.start,end:part.end,text:part.text});
 };
 if(typeof source.text==='string'&&['delivered','partial'].includes(range.status))add({...range,text:source.text});
 const request=payload.userRequest;
 if(request?.sourceId===sourceId&&Array.isArray(request.readRanges)){
  if(!originalComplete||typeof source.revision!=='string'||request.sourceRevision!==undefined&&request.sourceRevision!==source.revision)
   throw bad('Continuation evidence requires its complete local original and exact revision binding');
  for(const part of request.readRanges){
   const revision=part.revision??request.sourceRevision??request.delivery?.lookup?.revision;
   add(part,revision);
  }
 }
 spans.sort((a,b)=>a.start-b.start||a.end-b.end);
 const joined=[];
 for(const part of spans){
  const prior=joined.at(-1);
  if(!prior||part.start>prior.end){joined.push({...part});continue;}
  const overlap=Math.min(prior.end,part.end)-part.start;
  if(overlap>0&&prior.text.slice(part.start-prior.start,part.start-prior.start+overlap)!==part.text.slice(0,overlap))throw bad('Overlapping delivered ranges disagree');
  if(part.end>prior.end){prior.text+=part.text.slice(prior.end-part.start);prior.end=part.end;}
 }
 const unread=[];let offset=0;
 for(const part of joined){if(part.start>offset)unread.push({start:offset,end:part.start});offset=Math.max(offset,part.end);}
 if(offset<originalLength)unread.push({start:offset,end:originalLength});
 const complete=originalComplete&&!unread.length&&joined.length===1&&joined[0].start===0&&joined[0].end===originalLength;
 const witness=text=>{
  if(typeof text!=='string'||!text)return null;
  for(const part of joined){const index=part.text.indexOf(text);if(index>=0)return {sourceId,revision:source.revision,start:part.start+index,end:part.start+index+text.length};}
  return null;
 };
 return {sourceId,revision:source.revision,source,originalComplete,complete,spans:joined,unreadRanges:unread,
  ...(complete?{completeText:joined[0].text}:{}),contains:text=>!!witness(text),witness,
  coverage:{sourceId,revision:source.revision,complete,ranges:joined.map(({start,end})=>({start,end})),unreadRanges:unread}};
}
function deliveredEvidenceMap(prepared,info={}){
 const payload=prepared?.payload||prepared||{};
 return new Map((payload.sources||[]).map(source=>[source.id,sourceEvidence(prepared,source.id,info)]));
}
module.exports={DELIVERY_VERSION,deliveryRange,boundedSource,boundedSourceView,deliveredQuote,sourceDeliveryManifest,rangedDelivery,completeBody,mergeSourceReads,currentRequestView,copyReadyDelivery,sourceEvidence,deliveredEvidenceMap};
