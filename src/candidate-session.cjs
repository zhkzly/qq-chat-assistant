'use strict';
const {sameScope}=require('./messages.cjs');
const {visibleResponseText}=require('./experience-store.cjs');
const CANDIDATE_TTL_MS=5*60*1000;

// Owns the current projection only. Original outputs and user edits remain in
// the existing artifact/draft stores; withdrawing a candidate never edits them.
class CandidateSession {
 constructor({now=Date.now,ttlMs=CANDIDATE_TTL_MS,sourceValidity=()=>true}={}){
  this.now=now;this.ttlMs=ttlMs;this.sourceValidity=sourceValidity;this.privateInputSeq=0;this.ticketSeq=0;
  this.candidate=null;this.active=null;this.reason='';this.lastAutomaticFingerprint='';this.lastAutomaticAt=0;this.version=0;
 }
 invalidate(reason='context_changed'){this.candidate=null;this.cancel();this.reason=reason;this.version++;}
 cancel(){if(this.active){this.active=null;this.version++;}}
 begin({scope,revision,requestId,origin='user',advancePrivateInput=false,expectedPrivateInputSeq}){
  if(expectedPrivateInputSeq!==undefined&&expectedPrivateInputSeq!==this.privateInputSeq)return null;
  if(advancePrivateInput)this.privateInputSeq++;
  this.invalidate(advancePrivateInput?'private_input_changed':'updating');
  const ticket={ticketId:++this.ticketSeq,scope:{...scope},revision,requestId,origin,privateInputSeq:this.privateInputSeq};
  this.active={...ticket,planDigest:null};this.version++;return ticket;
 }
 isCurrent(ticket,{scope=ticket?.scope,revision=ticket?.revision}={}){
  return !!ticket&&this.active?.ticketId===ticket.ticketId&&ticket.privateInputSeq===this.privateInputSeq&&sameScope(ticket.scope,scope)&&ticket.revision===revision;
 }
 bindPlan(ticket,planDigest){
  if(!this.isCurrent(ticket)||typeof planDigest!=='string'||!planDigest)return false;
  this.active.planDigest=planDigest;return true;
 }
 publish(ticket,{scope,revision,reply,planDigest,messageIds=[],automaticFingerprint}){
  if(!this.isCurrent(ticket,{scope,revision})||!planDigest||this.active.planDigest!==planDigest||!reply)return null;
  const at=this.now();
  this.candidate={analysis:visibleResponseText(reply),suggestions:reply.suggestions||[],scope:{...scope},revision,
   createdAt:new Date(at).toISOString(),expiresAt:new Date(at+this.ttlMs).toISOString(),requestId:reply.requestId||ticket.requestId,
   origin:ticket.origin,binding:{scope:{...scope},revision,messageIds:[...messageIds],privateInputSeq:ticket.privateInputSeq,planDigest},
   replyDisposition:reply.suggestions?.length?undefined:reply.replyDisposition,artifactRef:reply.artifactRef,turnId:reply.id};
  if(ticket.origin==='automatic'){this.lastAutomaticFingerprint=automaticFingerprint||'';this.lastAutomaticAt=at;}
  this.active=null;this.reason='';this.version++;return this.candidate;
 }
 finish(ticket,reason='private_consultation'){
  if(!this.isCurrent(ticket))return;this.active=null;this.reason=reason;this.version++;
 }
 current({scope,revision}){
  const candidate=this.candidate;
  if(!candidate||!sameScope(candidate.scope,scope)||candidate.revision!==revision||candidate.binding.privateInputSeq!==this.privateInputSeq||Date.parse(candidate.expiresAt)<=this.now()||!this.sourceValidity(candidate))return null;
  return candidate;
 }
 canReuseAutomatic(fingerprint,binding){return this.lastAutomaticFingerprint===fingerprint&&this.now()-this.lastAutomaticAt<this.ttlMs&&!!this.current(binding);}
 status({scope,revision,auto=false,messageIds=[]}){
  const current=this.current({scope,revision}),project=value=>({...value,version:this.version,privateInputSeq:this.privateInputSeq});
  if(current)return project({phase:current.suggestions.length?'ready':'waiting',reason:current.replyDisposition||'candidate',messageIds:current.binding.messageIds});
  if(this.candidate&&Date.parse(this.candidate.expiresAt)<=this.now())return project({phase:'expired',reason:'ttl',messageIds});
  if(this.candidate&&!this.sourceValidity(this.candidate))return project({phase:'waiting',reason:'source_changed',messageIds});
  if(this.active)return project({phase:'thinking',reason:this.active.origin==='automatic'?'updating':'private_input_changed',messageIds});
  return project({phase:!scope?'idle':!auto?'paused':'idle',reason:this.reason||'no_candidate',messageIds});
 }
}
module.exports={CandidateSession,CANDIDATE_TTL_MS};
