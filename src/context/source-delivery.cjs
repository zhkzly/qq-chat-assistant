'use strict';
const {bytes}=require('./shared.cjs');
// Offsets address the redacted canonical source body, in JavaScript UTF-16 code
// units. The source revision always identifies the complete local source.
const DELIVERY_VERSION='source-delivery-v1';
function deliveryRange(source){
 const body=String(source?.text||''),delivery=source?.delivery;
 if(!delivery)return {start:0,end:body.length,originalCharLength:body.length,status:'delivered'};
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
function deliveredQuote(source,text){
 if(!source||typeof text!=='string'||!text||!String(source.text||'').includes(text))return null;
 const range=deliveryRange(source),local=source.text.indexOf(text);
 if(typeof source.id!=='string'||typeof source.revision!=='string'||!Number.isSafeInteger(range.start)||range.start<0||!Number.isSafeInteger(range.end)||range.end<range.start||!Number.isSafeInteger(range.originalCharLength)||range.end-range.start!==source.text.length||range.end>range.originalCharLength)return null;
 return {sourceId:source.id,revision:source.revision,start:range.start+local,end:range.start+local+text.length};
}
function sourceDeliveryManifest(all,sources,explicitRequests=[]){
 const delivered=new Map(sources.map(source=>[source.id,source])),originals=new Map(all.map(source=>[source.id,source]));
 const entry=id=>{const source=delivered.get(id),original=originals.get(id);return {sourceId:id,revision:source?.revision||original?.revision,
  status:source?(source.delivery?.status||'delivered'):'omitted',...(source?deliveryRange(source):{}),...(source?.delivery?{lookup:source.delivery.lookup}:{} )};};
 const requests=new Map(explicitRequests.map(request=>typeof request==='string'?[request,{sourceId:request}]:[request.sourceId||request.id,request]));
 const explicitLookups=[...requests].map(([id,request])=>{
  const result=entry(id),original=originals.get(id),range=delivered.has(id)?deliveryRange(delivered.get(id)):null;
  const start=request.requestedRange?.start??request.requestedRange?.offset??request.offset??request.delivery?.start??0;
  const length=request.requestedRange?.end!==undefined?request.requestedRange.end-start:request.requestedRange?.maxChars??request.maxChars??(request.delivery?request.delivery.end-request.delivery.start:Infinity);
  const end=Math.max(start,Math.min(original?.text.length??start,start+length));
  const overlap=range?Math.max(0,Math.min(end,range.end)-Math.max(start,range.start)):0;
  result.requestedRange={start,end};
  result.requestStatus=range&&range.start<=start&&range.end>=end?'delivered':overlap?'partial':'omitted';
  if(result.requestStatus==='omitted')result.status='omitted';
  return result;
 });
 return {version:DELIVERY_VERSION,offsetUnit:'utf16_redacted_source',partialSourceCount:sources.filter(source=>source.delivery?.status==='partial').length,
  omittedSourceCount:all.filter(source=>!delivered.has(source.id)).length,explicitLookups,sources:sources.map(source=>entry(source.id))};
}
const boundedSourceView=(source,{offset=0,...options}={})=>boundedSource(source,{...options,start:offset});
module.exports={DELIVERY_VERSION,deliveryRange,boundedSource,boundedSourceView,deliveredQuote,sourceDeliveryManifest};
