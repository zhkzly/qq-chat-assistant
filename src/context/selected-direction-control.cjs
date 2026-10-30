'use strict';
const {digest}=require('./shared.cjs');

const AUTHORITY='CONTROL_ONLY_UI_SELECTION';
const captures=new WeakMap();
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value);
const clone=value=>value===undefined?undefined:structuredClone(value);
const freeze=value=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};
const fail=()=>{throw new Error('Selected direction control changed or is unavailable in this conversation');};
const sameRef=(left,right)=>left?.artifactId===right?.artifactId&&left?.version===right?.version;
const scopeKey=scope=>plain(scope)?Object.fromEntries(['accountUid','accountUin','peerUid','peerUin'].map(key=>[key,scope[key]??null])):null;
function selectionFor(payload){
 const value=payload?.selectedOption;
 if(value===undefined||value===null)return undefined;
 if(!plain(value)||Object.keys(value).some(key=>!['turnId','index'].includes(key))||typeof value.turnId!=='string'||!value.turnId||!Number.isSafeInteger(value.index)||value.index<0)fail();
 return {turnId:value.turnId,index:value.index};
}
function optionFor(payload,selection){
 if(!Array.isArray(payload?.expressionOptions))fail();
 const rows=(payload.expressionOptions||[]).filter(item=>item?.turnId===selection.turnId&&item.index===selection.index);
 if(rows.length!==1)fail();
 const option=rows[0];
 if(typeof option.label!=='string'||!option.label.trim()||option.style!==undefined&&typeof option.style!=='string'||
  !plain(option.artifactRef)||Object.keys(option.artifactRef).some(key=>!['artifactId','version'].includes(key))||typeof option.artifactRef.artifactId!=='string'||!option.artifactRef.artifactId||!Number.isSafeInteger(option.artifactRef.version)||option.artifactRef.version<1||
  !Array.isArray(option.quotes)||option.quotes.some(quote=>!plain(quote)||typeof quote.sourceId!=='string'||typeof quote.text!=='string'||typeof quote.revision!=='string'))fail();
 return option;
}
const tupleDigest=option=>digest(option.quotes.map(({sourceId,text,revision})=>({sourceId,text,revision})));
const rowWitness=option=>({label:option.label,...(option.style!==undefined?{style:option.style}:{}),artifactRef:{artifactId:option.artifactRef.artifactId,version:option.artifactRef.version},tupleDigest:tupleDigest(option)});
const contextBinding=(context,selection,witness)=>digest({scope:scopeKey(context.manifest?.scope),requestId:context.manifest?.requestId??null,asOf:context.payload?.asOf??null,selection,witness});
function liveSelection(store,scope,selection,option){
 if(!store?.experiences?.resolveActionOption)fail();
 const live=store.experiences.resolveActionOption(scope,{turnId:selection.turnId,optionIndex:selection.index,artifactRef:option.artifactRef});
 if(!plain(live)||live.label!==option.label||live.style!==option.style||live.dependency?.kind!=='action_option'||
  live.dependency.turnId!==selection.turnId||live.dependency.optionIndex!==selection.index||
  !sameRef(live.dependency.artifactRef,option.artifactRef)||live.dependency.tupleDigest!==tupleDigest(option))fail();
 return live;
}
function manifestControl(state){
 return {version:1,authority:AUTHORITY,selection:clone(state.selection),artifactRef:clone(state.dependency.artifactRef),tupleDigest:state.dependency.tupleDigest};
}
function bindSelectedDirectionControl(context,{store,scope=context.manifest?.scope}={}){
 const selection=selectionFor(context.payload),old=captures.get(context);
 if(!selection){if(old)fail();return;}
 if(!scopeKey(scope)||digest(scopeKey(scope))!==digest(scopeKey(context.manifest?.scope)))fail();
 const option=optionFor(context.payload,selection),witness=rowWitness(option),live=liveSelection(store,scope,selection,option);
 const bindingId=contextBinding(context,selection,witness);
 if(old){
  if(old.bindingId!==bindingId||digest(old.dependency)!==digest(live.dependency))fail();
  return old;
 }
 // Only the selected visible label is retained here. No historical private
 // source body or quote text is copied into the control binding.
 const state=freeze({scope:scopeKey(scope),requestId:context.manifest.requestId??null,selection:clone(selection),label:option.label,
  ...(option.style!==undefined?{style:option.style}:{}),dependency:clone(live.dependency),bindingId});
 const dependencies=context.manifest.inputArtifactRefs||[];
 if(!Array.isArray(dependencies))fail();
 const same=dependencies.find(item=>digest([item.kind,item.artifactRef,item.turnId,item.optionIndex??item.suggestionIndex])===digest([state.dependency.kind,state.dependency.artifactRef,state.dependency.turnId,state.dependency.optionIndex]));
 if(same&&digest(same)!==digest(state.dependency))fail();
 captures.set(context,state);
 Object.defineProperty(context,'selectedDirectionBinding',{value:state});
 context.manifest.inputArtifactRefs=same?dependencies:[...dependencies,clone(state.dependency)];
 context.manifest.selectedDirectionControl=manifestControl(state);
 return state;
}
function buildSelectedDirectionControl(prepared,info={}){
 const selection=selectionFor(prepared?.payload),state=prepared&&captures.get(prepared);
 if(!selection){if(state||prepared?.selectedDirectionBinding)fail();return {};}
 if(!state||prepared.selectedDirectionBinding!==state||digest(selection)!==digest(state.selection))fail();
 const scope=info.scope||prepared.manifest?.scope;
 if(digest(scopeKey(scope))!==digest(state.scope)||digest(scopeKey(prepared.manifest?.scope))!==digest(state.scope)||
  (prepared.manifest?.requestId??null)!==state.requestId)fail();
 const option=optionFor(prepared.payload,selection),witness=rowWitness(option);
 if(contextBinding(prepared,selection,witness)!==state.bindingId)fail();
 const live=liveSelection(info.store,scope,selection,option);
 if(digest(live.dependency)!==digest(state.dependency))fail();
 info.store.experiences.assertInputArtifactsCurrent(scope,[state.dependency]);
 return {control:{version:1,authority:AUTHORITY,selection:clone(selection),label:state.label,...(state.style!==undefined?{style:state.style}:{})},dependency:clone(state.dependency)};
}
module.exports={bindSelectedDirectionControl,buildSelectedDirectionControl};
