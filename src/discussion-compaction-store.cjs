'use strict';
const {createHash}=require('node:crypto');
const {sourceClosure}=require('./provenance.cjs');

const DISCUSSION_COMPACTION_VERSION='discussion-compaction-2026-10-17.1';
const LIMITS=Object.freeze({summaryBytes:8000,quoteBytes:6000,quotes:12,turns:128,turnDependencies:384,sources:1024,retained:3});
const plain=value=>!!value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const canonical=value=>Array.isArray(value)?value.map(canonical):plain(value)?Object.fromEntries(Object.keys(value).sort().filter(key=>value[key]!==undefined).map(key=>[key,canonical(value[key])])):value;
const hash=value=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const clone=value=>JSON.parse(JSON.stringify(value));
function text(value,name,max=256){if(typeof value!=='string'||!value.trim()||value.length>max)throw new Error(`Invalid discussion compaction ${name}`);return value;}
function integer(value,name){if(!Number.isSafeInteger(value)||value<0)throw new Error(`Invalid discussion compaction ${name}`);return value;}
function fingerprint(value,name){if(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))throw new Error(`Invalid discussion compaction ${name}`);return value;}
function sameRef(a,b){return plain(a)&&plain(b)&&a.artifactId===b.artifactId&&a.version===b.version;}
// Readability and compression eligibility are different authorities. A user
// may reference an automatic artifact without making it ordinary dialogue.
function readableDiscussionTurns(companion) {
  let allowed=true;const turns=[];
  for(const turn of companion.turns||[]){
    if(turn.role==='user')allowed=!turn.memoryExcluded&&!['feedback','feedback_ref'].includes(turn.kind);
    if(allowed&&['user','assistant'].includes(turn.role)&&!turn.memoryExcluded)turns.push(turn);
  }
  return turns;
}
function automaticDiscussionTurnIds(companion,{store,scope}={}) {
  const result=new Set((companion.turns||[]).filter(turn=>turn.role==='assistant'&&turn.origin==='automatic').map(turn=>turn.id));
  const scopeFields=['accountUid','accountUin','peerUid','peerUin'];
  if(!scope||!scopeFields.every(field=>typeof scope[field]==='string'&&scope[field].trim()))return result;
  const requests=new Set();
  if(store){
    const key=store.scopeKey(scope);
    if(store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='assistant_tasks'").get())
      for(const task of store.db.prepare("SELECT id FROM assistant_tasks WHERE scope_key=? AND origin='automatic'").all(key))requests.add(task.id);
  }
  // Retained runs supplement the durable ledger only when their captured scope
  // proves the exact account/contact binding. Neither prose nor a replyId is
  // enough to infer an old turn's origin.
  for(const run of companion.runs||[]){
    if(typeof run.id!=='string'||!run.id.trim()||!scopeFields.every(field=>run.manifest?.scope?.[field]===scope[field]))continue;
    if(run.manifest?.invocation?.origin==='automatic'||run.payload?.taskContext?.invocation?.origin==='automatic')requests.add(run.id);
  }
  for(const turn of companion.turns||[])if(turn.role==='assistant'&&requests.has(turn.requestId))result.add(turn.id);
  return result;
}
function eligibleDiscussionTurns(companion,options={}) {
  const automatic=automaticDiscussionTurnIds(companion,options);
  return readableDiscussionTurns(companion).filter(turn=>!automatic.has(turn.id));
}
function discussionTurnFingerprint(turn) {
  if(!plain(turn)||!['user','assistant'].includes(turn.role)||typeof turn.text!=='string')throw new Error('Invalid original discussion turn');
  return hash(turn);
}
function validateDiscussionTurnFingerprints(companion,references,{newTurnId}={}) {
  if(!plain(references)||Object.keys(references).length>LIMITS.turnDependencies)throw new Error('Invalid discussion turn fingerprint dependencies');
  const byId=new Map(readableDiscussionTurns(companion).map(turn=>[turn.id,turn]));
  for(const [id,revision]of Object.entries(references)){
    if(id===newTurnId||!byId.has(id)||discussionTurnFingerprint(byId.get(id))!==fingerprint(revision,'turn fingerprint'))throw new Error('Original discussion turn dependency changed or disappeared');
  }
  return clone(references);
}
function discussionTopicBinding(companion) {
  const topics=companion.topics||companion;
  const active=topics.active||(topics.items||[]).find(topic=>topic.id===topics.activeId&&topic.lifecycle==='active');
  if(!active||active.lifecycle!=='active')return hash({activeId:null});
  // A new operational stage changes its intent binding, not the user's purpose.
  const purposeBindings=Object.fromEntries(['objective','direction','constraints'].filter(field=>active.purposeBindings?.[field]).map(field=>[field,active.purposeBindings[field]]));
  return hash({activeId:active.id,lifecycle:active.lifecycle,objective:active.objective,direction:active.direction,constraints:active.constraints,purposeBindings});
}
function discussionModelBinding(baseUrl,model) {return hash({baseUrl:String(baseUrl||''),model:String(model||'')});}
function coveredTurns(companion,ids,options={}) {
  if(!Array.isArray(ids)||!ids.length||ids.length>LIMITS.turns||ids.some(id=>typeof id!=='string'||!id||id.length>256)||new Set(ids).size!==ids.length)throw new Error('Invalid original discussion turn coverage');
  const eligible=eligibleDiscussionTurns(companion,options),start=eligible.findIndex(turn=>turn.id===ids[0]);
  if(start<0||ids.some((id,index)=>eligible[start+index]?.id!==id))throw new Error('Discussion coverage must be a contiguous ordered slice of live original turns');
  return eligible.slice(start,start+ids.length);
}
function discussionCompactionEvidence(store,scope,sourceTurnIds,companion=store.getCompanion(scope)) {
  store.scopeKey(scope);
  const turns=coveredTurns(companion,sourceTurnIds,{store,scope}),sources=new Map(store._rawMemorySources(scope,companion).map(source=>[source.id,source])),ids=new Set();
  for(const turn of turns){
    if(turn.role==='user')ids.add(`private:${turn.id}`);
    for(const id of turn.sourceIds||[])ids.add(id);
    for(const option of turn.expressionOptions||[])for(const quote of option.quotes||[])if(quote.sourceId)ids.add(quote.sourceId);
    if(turn.role==='assistant'&&turn.artifactRef){
      const artifact=store.experiences.artifact(scope,turn.artifactRef);
      if(!artifact||artifact.availability!=='active')throw new Error('Original discussion artifact is no longer live');
      for(const ref of artifact.sourceRefs||[]){if(sources.get(ref.sourceId)?.revision!==ref.revision)throw new Error('Original discussion artifact source changed');ids.add(ref.sourceId);}
      for(const id of artifact.sourceIds||[])ids.add(id);
    }
  }
  const closure=sourceClosure(sources,[...ids]);
  if(closure.length>LIMITS.sources)throw new Error('Discussion compaction source dependency bound exceeded');
  return {turnFingerprints:Object.fromEntries(turns.map(turn=>[turn.id,discussionTurnFingerprint(turn)])),sourceRevisions:Object.fromEntries(closure.map(source=>[source.id,source.revision])),
    coverage:{firstTurnId:sourceTurnIds[0],lastTurnId:sourceTurnIds.at(-1),turnCount:sourceTurnIds.length}};
}
function binding(input) {
  if(!plain(input))throw new Error('Invalid discussion compaction binding');
  return {goalVersion:integer(input.goalVersion,'goal version'),topicBinding:fingerprint(input.topicBinding,'topic binding'),model:text(input.model,'model',500),modelBinding:fingerprint(input.modelBinding,'model binding'),
    promptVersion:text(input.promptVersion,'prompt version'),protocolVersion:text(input.protocolVersion||DISCUSSION_COMPACTION_VERSION,'protocol version')};
}
function bindingMatches(record,expected){return Object.entries(expected).every(([key,value])=>record[key]===value);}
function checkedQuotes(input,turns,sourceRevisions) {
  if(input===undefined)return [];
  if(!Array.isArray(input)||input.length>LIMITS.quotes||Buffer.byteLength(JSON.stringify(input),'utf8')>LIMITS.quoteBytes)throw new Error('Discussion compaction quote reference bound exceeded');
  const byId=new Map(turns.map(turn=>[turn.id,turn]));
  return input.map(quote=>{
    if(!plain(quote)||Object.keys(quote).some(key=>!['turnId','role','field','index','quoteIndex','text','artifactRef','sourceIds'].includes(key)))throw new Error('Unauthorized discussion quote reference fields');
    const turn=byId.get(text(quote.turnId,'quote turn id'));
    if(!turn||quote.role!==turn.role)throw new Error('Discussion quote role or original turn is unavailable');
    const field=quote.field||'text';let body,artifactRef=turn.artifactRef,permittedSources=turn.role==='user'?[`private:${turn.id}`]:turn.sourceIds||[];
    if(field==='text'||field==='discussionExplanation'){
      if(quote.index!==undefined||quote.quoteIndex!==undefined)throw new Error('Plain discussion quotes cannot choose an index');
      if(field==='discussionExplanation'&&turn.role!=='assistant')throw new Error('Only an assistant has a generated discussion explanation');
      body=field==='text'?turn.text:turn.discussionExplanation?.text;
    }else if(['suggestions','expressionOptions'].includes(field)){
      if(!Number.isSafeInteger(quote.index)||quote.index<0)throw new Error('Structured discussion quote requires an original index');
      const item=turn[field]?.[quote.index];if(!item||turn.role!=='assistant')throw new Error('Original structured discussion candidate is unavailable');
      artifactRef=item.artifactRef;
      if(field==='suggestions'){
        if(quote.quoteIndex!==undefined)throw new Error('Suggestion quotes cannot choose an option quote');body=item.text;
      }else if(quote.quoteIndex===undefined)body=item.label;
      else {
        if(!Number.isSafeInteger(quote.quoteIndex)||quote.quoteIndex<0)throw new Error('Invalid original option quote index');
        const original=item.quotes?.[quote.quoteIndex];body=original?.text;permittedSources=original?.sourceId?[original.sourceId]:[];
      }
    }else throw new Error('Unknown original discussion quote field');
    text(quote.text,'literal quote',6000);
    if(typeof body!=='string'||!body.includes(quote.text))throw new Error('Discussion quote must be a literal excerpt of its original field');
    if(quote.artifactRef!==undefined&&!sameRef(quote.artifactRef,artifactRef))throw new Error('Discussion quote artifact version changed');
    if(quote.sourceIds!==undefined&&(!Array.isArray(quote.sourceIds)||quote.sourceIds.length>64||quote.sourceIds.some(id=>!permittedSources.includes(id)||!sourceRevisions[id])))throw new Error('Discussion quote source references are unavailable');
    return {turnId:turn.id,role:turn.role,field,...(quote.index!==undefined?{index:quote.index}:{}),...(quote.quoteIndex!==undefined?{quoteIndex:quote.quoteIndex}:{}),text:quote.text,
      ...(artifactRef?{artifactRef:clone(artifactRef)}:{}),sourceIds:quote.sourceIds?[...new Set(quote.sourceIds)]:[...new Set(permittedSources.filter(id=>sourceRevisions[id]))],authority:turn.role==='assistant'?'generated_discussion_not_outbound_authorization':'private_user_statement_not_outbound_authorization'};
  });
}
class DiscussionCompactionStore {
  constructor(store) {
    this.store=store;this.db=store.db;
    this.db.exec('CREATE TABLE IF NOT EXISTS discussion_compactions(scope_key TEXT NOT NULL,id TEXT NOT NULL,record TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(scope_key,id))');
  }
  _rows(scope){return this.db.prepare('SELECT id,record FROM discussion_compactions WHERE scope_key=? ORDER BY rowid DESC').all(this.store.scopeKey(scope));}
  _valid(scope,record,companion) {
    try{
      if(record.scopeKey!==this.store.scopeKey(scope)||record.goalVersion!==companion.goal.version||record.topicBinding!==discussionTopicBinding(companion)||record.protocolVersion!==DISCUSSION_COMPACTION_VERSION)return false;
      const evidence=discussionCompactionEvidence(this.store,scope,record.sourceTurnIds,companion);
      if(JSON.stringify(canonical(record.coverage))!==JSON.stringify(canonical(evidence.coverage)))return false;
      if(JSON.stringify(canonical(record.turnFingerprints))!==JSON.stringify(canonical(evidence.turnFingerprints)))return false;
      if(!plain(record.sourceRevisions)||Object.entries(evidence.sourceRevisions).some(([id,revision])=>record.sourceRevisions[id]!==revision))return false;
      const live=new Map(this.store._rawMemorySources(scope,companion).map(source=>[source.id,source]));
      return Object.entries(record.sourceRevisions).every(([id,revision])=>live.get(id)?.revision===revision);
    }catch{return false;}
  }
  prune(scope,companion=this.store.getCompanion(scope)) {
    let removed=0;
    for(const row of this._rows(scope)){
      let valid=false;try{valid=this._valid(scope,JSON.parse(row.record),companion);}catch{}
      if(!valid){this.db.prepare('DELETE FROM discussion_compactions WHERE scope_key=? AND id=?').run(this.store.scopeKey(scope),row.id);removed++;}
    }
    return removed;
  }
  get(scope,query={}) {
    return this.store._atomic(()=>{
      const expected=binding(query),companion=this.store.getCompanion(scope);this.prune(scope,companion);
      for(const row of this._rows(scope)){
        const record=JSON.parse(row.record);
        if(bindingMatches(record,expected)&&(!query.currentTurnId||!record.sourceTurnIds.includes(query.currentTurnId)))return record;
      }
      return null;
    });
  }
  save(scope,input,expected={}) {
    try{return this.store._atomic(()=>{
      const key=this.store.scopeKey(scope),companion=this.store.getCompanion(scope),requirements=binding(expected);
      if(!plain(input)||Object.keys(input).some(field=>!['id','scope','scopeKey','summary','sourceTurnIds','turnFingerprints','sourceRevisions','coverage','quoteRefs','goalVersion','topicVersion','topicBinding','model','modelBinding','promptVersion','protocolVersion','requestId'].includes(field)))throw new Error('Unauthorized discussion compaction record fields');
      if(expected.baseRevision!==companion.revision)return {applied:false,reason:'stale_revision'};
      text(expected.currentTurnId,'current turn id');
      const current=companion.turns.find(turn=>turn.id===expected.currentTurnId&&turn.role==='user'&&!turn.memoryExcluded);
      if(expected.transient!==true&&!current||input.sourceTurnIds?.includes(expected.currentTurnId))throw new Error('Current private request cannot be covered by compaction');
      if(input.scopeKey!==undefined&&input.scopeKey!==key||input.scope!==undefined&&this.store.scopeKey(input.scope)!==key)throw new Error('Discussion compaction scope changed');
      const meta=binding(input);
      if(meta.protocolVersion!==DISCUSSION_COMPACTION_VERSION||!bindingMatches(meta,requirements)||meta.goalVersion!==companion.goal.version||meta.topicBinding!==discussionTopicBinding(companion))return {applied:false,reason:'stale_binding'};
      const evidence=discussionCompactionEvidence(this.store,scope,input.sourceTurnIds,companion);
      if(!plain(input.turnFingerprints)||JSON.stringify(canonical(input.turnFingerprints))!==JSON.stringify(canonical(evidence.turnFingerprints)))return {applied:false,reason:'stale_turns'};
      if(!plain(input.coverage)||JSON.stringify(canonical(input.coverage))!==JSON.stringify(canonical(evidence.coverage)))throw new Error('Discussion compaction coverage boundary changed');
      if(!plain(input.sourceRevisions)||Object.keys(input.sourceRevisions).length>LIMITS.sources||Object.entries(evidence.sourceRevisions).some(([id,revision])=>input.sourceRevisions[id]!==revision))return {applied:false,reason:'stale_sources'};
      const live=new Map(this.store._rawMemorySources(scope,companion).map(source=>[source.id,source]));
      if(Object.entries(input.sourceRevisions).some(([id,revision])=>live.get(id)?.revision!==revision))return {applied:false,reason:'stale_sources'};
      text(input.summary,'summary',LIMITS.summaryBytes);
      if(Buffer.byteLength(input.summary,'utf8')>LIMITS.summaryBytes)throw new Error('Discussion compaction summary exceeds 8000 UTF-8 bytes');
      const quoteRefs=checkedQuotes(input.quoteRefs,coveredTurns(companion,input.sourceTurnIds,{store:this.store,scope}),input.sourceRevisions);
      const body={...meta,topicVersion:integer(input.topicVersion,'topic version'),summary:input.summary,sourceTurnIds:[...input.sourceTurnIds],...evidence,sourceRevisions:clone(input.sourceRevisions),quoteRefs,authority:'derived_discussion_checkpoint_not_factual_evidence'};
      const id=hash({scopeKey:key,...body}),old=this.db.prepare('SELECT record FROM discussion_compactions WHERE scope_key=? AND id=?').get(key,id);
      if(old)return {applied:true,id,record:JSON.parse(old.record),alreadyStored:true};
      if(input.requestId!==undefined)body.requestId=text(input.requestId,'request id');
      const record={id,scopeKey:key,scope:{...scope},...body,createdAt:new Date().toISOString()};
      this.db.prepare('INSERT INTO discussion_compactions VALUES(?,?,?,?)').run(key,id,JSON.stringify(record),record.createdAt);
      this.db.prepare('DELETE FROM discussion_compactions WHERE scope_key=? AND id NOT IN (SELECT id FROM discussion_compactions WHERE scope_key=? ORDER BY rowid DESC LIMIT ?)').run(key,key,LIMITS.retained);
      return {applied:true,id,record:clone(record)};
    });}catch(error){return {applied:false,reason:'invalid_discussion_compaction',detail:error.message};}
  }
}
module.exports={DiscussionCompactionStore,DISCUSSION_COMPACTION_VERSION,DISCUSSION_COMPACTION_LIMITS:LIMITS,discussionTurnFingerprint,discussionTopicBinding,discussionModelBinding,readableDiscussionTurns,automaticDiscussionTurnIds,eligibleDiscussionTurns,discussionCompactionEvidence,validateDiscussionTurnFingerprints};
