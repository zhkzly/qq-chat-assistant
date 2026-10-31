'use strict';
// Synthetic Controller producers use the real captured request frames. This
// changes representation only; each producer owns its complete primary answer,
// material/authority choices, and separately scripted checker result. This helper
// never supplies a missing answer, authorization, or checker allowance.
const {Controller:ProductController}=require('../../src/controller.cjs');
const {prepareAssistantRequest}=require('../../src/assistant-model.cjs');
const {withRequestDelivery}=require('../../scripts/synthetic-request-delivery.cjs');
const {wireSourceView}=require('./source-wire.cjs');
class Controller extends ProductController {
 get assistantModel(){return this.fixtureModel;}
 set assistantModel(producer){this.fixtureModel=producer&&(async(...args)=>{
  const [settings,input]=args,prepared=prepareAssistantRequest(settings,input.payload,input.images||[],{sourceRevisions:input.sourceReferenceRevisions||input.manifest?.sourceRevisions});
  Object.defineProperty(input,'sourceWireSnapshot',{value:prepared.sourceWire,writable:true,configurable:true});
  Object.defineProperty(input,'primaryFrameSnapshot',{value:prepared.primaryFrame,writable:true,configurable:true});
  prepared.sourceWire.commit();prepared.primaryFrame?.commit();
  input.manifest.sourceHandles=prepared.sourceWire.receipt;
  if(prepared.primaryFrame)input.manifest.primaryReferences=prepared.primaryFrame.receipt;
  const value=await producer(...args);
  // An opt-in actual transport may already have parsed and privately bound its
  // result. Preserve that exact object and its operation/answer receipt.
  if(input.primaryFrameSnapshot?.isCanonical(value))return value;
  if(input.payload.purpose==='fidelity_check')return wireSourceView(value,prepared.sourceWire.receipt,undefined,input.payload);
  const primary=value&&typeof value==='object'&&Object.hasOwn(value,'operation')?value:withRequestDelivery(value,input.payload);
  return wireSourceView(primary,prepared.sourceWire.receipt,prepared.primaryFrame?.receipt,input.payload);
 });}
}
module.exports={Controller};
