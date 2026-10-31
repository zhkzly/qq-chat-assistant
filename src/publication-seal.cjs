'use strict';
// A local integrity seal, not a semantic judge or a correctness certificate.
const {createHash}=require('node:crypto');
const {candidateFields}=require('./candidate-field-paths.cjs');
const VERSION='primary-publication-seal-v1';
const clone=value=>structuredClone(value),hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const freeze=value=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};
const scopeKey=scope=>['accountUid','accountUin','peerUid','peerUin'].map(key=>scope?.[key]??null);
function fail(message,code='publication_binding_invalid'){const error=new Error(message);error.code=code;return error;}
function createPublicationSeal({result,expressionOptions=[],contexts=[],optionAdmission,scope,requestId}={}){
 const inputs=contexts.filter(Boolean),capturedScope=hash(scopeKey(scope)),revisions={},artifacts=new Map();
 for(const input of inputs){
  const manifest=input.manifest||{};
  if(manifest.scope&&hash(scopeKey(manifest.scope))!==capturedScope)throw fail('Publication input belongs to another account or contact');
  for(const [id,revision]of Object.entries({...manifest.discussionCompaction?.sourceRevisions,...manifest.sourceRevisions})){
   if(typeof revision!=='string'||!revision)throw fail('A publication source lacks its captured revision');
   if(revisions[id]!==undefined&&revisions[id]!==revision)throw fail('A source revision changed between producer stages','publication_source_conflict');
   revisions[id]=revision;
  }
  for(const dependency of manifest.inputArtifactRefs||[]){
   const key=JSON.stringify(dependency.artifactRef),previous=artifacts.get(key);
   if(previous&&hash(previous)!==hash(dependency))throw fail('An input artifact changed between producer stages');
   artifacts.set(key,clone(dependency));
  }
 }
 for(const [id,revision]of Object.entries(optionAdmission?.sourceRevisions||{})){
  if(typeof revision!=='string'||!revision||revisions[id]!==undefined&&revisions[id]!==revision)throw fail('An option source revision changed before publication','publication_source_conflict');
  revisions[id]=revision;
 }
 const controls=inputs.flatMap(input=>[input.payload?.intentAuthority?.sourceId,...(input.payload?.topicContext?.controlRefs||[]).map(ref=>ref.sourceId),input.payload?.currentHumanControl?.sourceId,input.payload?.selectedDirectionControl?.sourceId].filter(Boolean));
 if(controls.some(id=>revisions[id]===undefined))throw fail('A current human control lacks its captured source revision');
 const refs=()=>[result,result.suggestions,...(result.suggestions||[]),result.discussionExplanation,result.requestDelivery,result.requestDelivery?.blocker,result.deliveryBlocker,
  expressionOptions,...expressionOptions,optionAdmission,optionAdmission?.options,optionAdmission?.groups,optionAdmission?.sourceRevisions,...inputs.flatMap(input=>[input,input.payload,input.manifest,input.manifest?.sourceRevisions,input.manifest?.inputArtifactRefs,input.images,...(input.images||[])])];
 const visible=()=>candidateFields({...result,expressionOptions});
 const binding=()=>({scope:scopeKey(scope),requestId,fields:visible(),kind:result.kind,replyDisposition:result.replyDisposition,
  requestDelivery:result.requestDelivery,deliveryBlocker:result.deliveryBlocker,
  discussionKind:result.discussionExplanation?.kind,
  inputs:inputs.map(input=>({scope:scopeKey(input.manifest?.scope||scope),payload:input.payload,images:input.images,
   responseRecovery:input.manifest?.responseRecovery,sourceRevisions:input.manifest?.sourceRevisions,compactedRevisions:input.manifest?.discussionCompaction?.sourceRevisions,inputArtifactRefs:input.manifest?.inputArtifactRefs})),
  options:optionAdmission,transferOptions:expressionOptions});
 const identities=refs(),digest=hash(binding()),candidateHash=hash(visible());
 const context=freeze({manifest:{scope:clone(scope),requestId,sourceRevisions:clone(revisions),sourceIds:Object.keys(revisions).filter(id=>!id.startsWith('request:')),inputArtifactRefs:[...artifacts.values()]}});
 const receipt=freeze({version:VERSION,digest,candidateHash,sourceCount:Object.keys(revisions).length,inputArtifactCount:artifacts.size,semanticCheck:false});
 return Object.freeze({context,receipt,assert(candidate,options){
  const currentRefs=refs();
  if(candidate!==result||options!==expressionOptions||currentRefs.length!==identities.length||currentRefs.some((value,index)=>value!==identities[index])||hash(binding())!==digest)throw fail('The completed candidate or its producer/input binding changed before publication');
  return receipt;
 }});
}
module.exports={VERSION,createPublicationSeal};
