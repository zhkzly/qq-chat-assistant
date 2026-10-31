'use strict';
const {createHash}=require('node:crypto');
const VERSION='foreground-source-handles-v1';
const SYSTEM='Typed source references use only this request’s s# handles. Copy offered handles exactly; never reconstruct IDs. A catalog handle is navigation, not delivered evidence or sharing permission. Record, turn, artifact and case IDs and all quoted text keep their separate meanings.';
const SINGLE=new Set(['sourceId','currentObservationSourceId','currentRequestSourceId','intentSourceId','anchorSourceId','afterSourceId','beforeSourceId','targetSourceId','meaningFromSource','textFromSource']);
const ARRAYS=new Set(['sourceIds','evidenceSourceIds','purposeSourceIds','observationSourceIds','lifecycleSourceIds','foldedSourceIds','protectedSourceIds','selfMessagesAfterLastContact','contactMessagesAfterLastSelf','selfEvidenceSourceIds','allowedMaterialIds','selectedMaterialIds','feedbackSourceIds','reviewSourceIds','omittedSourceIds','partialSourceIds','unavailableRootSourceIds']);
const MAPS=new Set(['sourceRevisions','evidenceRevisions','intentSourceRevisions']);
const canonical=new WeakMap();
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const scopeIdentity=scope=>scope?Object.fromEntries(['accountUid','accountUin','peerUid','peerUin'].map(key=>[key,scope[key]??null])):null;
const clone=value=>value===undefined?undefined:structuredClone(value);
const freeze=value=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};
function fail(path,value){const e=new Error(`Unknown or not-offered source handle at ${path}: ${String(value)}; use only this call's offered s# handles`);e.code='unknown_source_handle';e.field=path;return e;}
function walk(value,convert,{output=false}={},path='$',parentKey=''){
 if(Array.isArray(value))return value.map((item,index)=>walk(item,convert,{output},`${path}[${index}]`,parentKey));
 if(!value||typeof value!=='object')return value;
 const result=Object.create(null);
 for(const [key,item]of Object.entries(value)){
  const at=`${path}.${key}`;
  if((SINGLE.has(key)||key==='id'&&['sources','contextSources'].includes(parentKey))&&typeof item==='string')result[key]=convert(item,at);
  else if(ARRAYS.has(key)&&Array.isArray(item))result[key]=item.map((id,index)=>typeof id==='string'?convert(id,`${at}[${index}]`):clone(id));
  else if(MAPS.has(key)&&item&&typeof item==='object'&&!Array.isArray(item))result[key]=Object.fromEntries(Object.entries(item).map(([id,revision])=>[convert(id,`${at}.${id}`),clone(revision)]));
  else if(['text','summary','style','invalidResponse','formatError','task','guidanceText'].includes(key)||key==='quote'&&typeof item==='string')result[key]=clone(item);
  else result[key]=walk(item,convert,{output},at,key);
 }
 return Object.setPrototypeOf(result,Object.prototype);
}
class SourceHandleOwner {
 #scope;#taskId;#entries=new Map();#aliases=new Map();#generation=0;#currentRevisions=new Map();
 constructor({scope=null,taskId='standalone'}={}){this.#scope=scopeIdentity(scope);this.#taskId=taskId;}
 matches(scope,taskId){return digest(scopeIdentity(scope))===digest(this.#scope)&&taskId===this.#taskId;}
 get size(){return this.#entries.size;}
 get taskBinding(){return Object.freeze({scope:clone(this.#scope),taskId:this.#taskId});}
 preview(payload,{sources=[],sourceRevisions={}}={}){
  const revisions=new Map(this.#currentRevisions);
  for(const [id,revision]of Object.entries(sourceRevisions))revisions.set(id,revision);
  for(const source of [...sources,...(payload?.originalInput?.sources||payload?.sources||[])])if(source?.id&&source.revision!==undefined)revisions.set(source.id,source.revision);
  const entries=new Map(this.#entries),aliases=new Map(this.#aliases),offered=new Map(),generation=this.#generation;
  const encode=(id,path)=>{
   if(id==='responsePreference')return id;
   const revision=revisions.get(id)??null,key=JSON.stringify([id,revision]);
   let entry=entries.get(key);
   if(!entry){entry=Object.freeze({handle:`s${entries.size+1}`,sourceId:id,revision});entries.set(key,entry);aliases.set(entry.handle,entry);}
   offered.set(entry.handle,entry);return entry.handle;
  };
  const wirePayload=walk(payload,encode);
  if(wirePayload&&typeof wirePayload==='object')wirePayload.sourceReferenceProtocol={version:VERSION};
  freeze(wirePayload);
  const bindingId=digest({scope:this.#scope,taskId:this.#taskId,offered:[...offered.values()]});let committed=false;
  const receipt=Object.freeze({version:VERSION,bindingId,bindings:Object.freeze([...offered.values()])});
  const snapshot={wirePayload,receipt,
   commit:()=>{if(committed)return;if(this.#generation!==generation)throw new Error('Source handle offer changed before dispatch; rebuild the request');this.#entries=entries;this.#aliases=aliases;this.#currentRevisions=revisions;this.#generation++;committed=true;},
   decode:(value,{isolateFields=[],onRejected}={})=>{
    const previous=value&&typeof value==='object'&&canonical.get(value);
    if(previous){if(previous!==snapshot)throw new Error('Canonical source result belongs to a different HTTP offer');return value;}
    if(!committed)throw new Error('Source handle snapshot was not dispatched');
    const convert=(id,path)=>{const entry=offered.get(id);if(!entry)throw fail(path,id);return entry.sourceId;};
    if(!isolateFields.length||!value||typeof value!=='object'||Array.isArray(value))return walk(value,convert,{output:true});
    const core=Object.fromEntries(Object.entries(value).filter(([key])=>!isolateFields.includes(key))),decoded=walk(core,convert,{output:true});
    for(const field of isolateFields)if(value[field]!==undefined){
      try{decoded[field]=walk({[field]:value[field]},convert,{output:true})[field];}
      catch(error){if(error.code!=='unknown_source_handle'||!onRejected)throw error;onRejected(field,error);}
    }
    return decoded;
   },
   markCanonical:value=>{if(value&&typeof value==='object'){const old=canonical.get(value);if(old&&old!==snapshot)throw new Error('Canonical source result cannot be rebound to another HTTP offer');canonical.set(value,snapshot);}return value;},
   isCanonical:value=>!!value&&typeof value==='object'&&canonical.get(value)===snapshot,
   project:value=>walk(value,(id,path)=>{if(id==='responsePreference')return id;const entry=[...offered.values()].find(item=>item.sourceId===id);if(!entry)throw fail(path,id);return entry.handle;})
  };
  return Object.freeze(snapshot);
 }
}
module.exports={SourceHandleOwner,VERSION,SYSTEM,mapSourceReferences:walk};
