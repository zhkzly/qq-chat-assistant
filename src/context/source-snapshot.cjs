'use strict';
const {redact}=require('../model.cjs');
const {qqSourceMetadata,sameScope}=require('../messages.cjs');
const {sourceRevision}=require('../store.cjs');
const {digest}=require('./shared.cjs');
function sameScopeIfPresent(value, scope) {
  if (!value?.scope) return true;
  if (typeof value.scope !== 'object') return value.scope === 'this_relationship';
  return ['accountUid', 'accountUin', 'peerUid', 'peerUin'].every(key => value.scope[key] === scope[key]);
}
function supportedByAvailable(record, byId, scope) {
  return sameScopeIfPresent(record, scope) && record.evidenceValidity !== 'invalid' && record.evidenceValidity !== 'unavailable' &&
    Object.entries(record.sourceRevisions || {}).every(([id, revision]) => byId.get(id)?.revision === revision) &&
    (record.sourceRefs || []).every(ref => byId.get(ref.sourceId)?.revision === ref.revision) &&
    Array.isArray(record.sourceIds) && record.sourceIds.length > 0 && record.sourceIds.every(id => {
      const source = byId.get(id);
      return source && !source.deleted && !source.excluded && (!record.sourceRevisions?.[id] || record.sourceRevisions[id] === source.revision);
    });
}
function pendingPrivateReviews(companion, byId) {
  const pending = new Map();
  const directIntent = id => {
    const source = byId.get(id);
    return source?.role === 'user' && (source.type === 'feedback' || source.type === 'private' &&
      !['feedback', 'feedback_ref', 'feedback_continue'].includes(source.kind));
  };
  const runReceipts = new Map((companion.runs || []).filter(run => run.status === 'complete' && run.replyId && run.privateReviewReceipt?.applied === true)
    .map(run => [run.replyId, run.privateReviewReceipt]));
  // These fields are verified program receipts, never model-reported patches.
  // Apply them in turn order so an older review cannot erase a later correction.
  for (const turn of companion.turns) {
    if (turn.role !== 'assistant' || turn.memoryExcluded) continue;
    const receipt = turn.privateReviewReceipt || runReceipts.get(turn.id);
    if (receipt?.applied === true) for (const id of receipt.sourceIds || []) {
      const expected = receipt.sourceRevisions?.[id];
      if (directIntent(id) && typeof expected === 'string' && expected === byId.get(id).revision) pending.delete(id);
    }
    const recovery = turn.responseRecovery,pendingMarker=turn.metadataReviewPending;
    const ordinaryPending=pendingMarker?.reasonCode==='auxiliary_metadata_rejected';
    if (!ordinaryPending&&(recovery?.kind !== 'private_help' || recovery.metadataApplied !== false || recovery.reasonCode !== 'structured_output_invalid')) continue;
    for (const id of (ordinaryPending?pendingMarker.sourceIds:recovery.intentSourceIds)||[]) if (directIntent(id)) {
      const expected = (ordinaryPending?pendingMarker.sourceRevisions:recovery.intentSourceRevisions)?.[id], source = byId.get(id);
      if (expected !== undefined && (typeof expected !== 'string' || expected !== source.revision)) continue;
      // Older saved markers cannot prove which source body was interpreted.
      // Keep that uncertainty visible; an unbound receipt never resolves it.
      pending.delete(id); pending.set(id, { ...source,
        pendingBindingStatus: expected === undefined ? 'legacy_hash_missing_needs_review' : 'source_bound' });
    }
  }
  return [...pending.values()];
}
function eligibleQQ(message) { return message.kind === 'actual' && !message.recalled && message.text !== '[已撤回]'; }
function sourcesFor(records, companion) {
  return [
    ...records.filter(eligibleQQ).map(m => {const source={id:`qq:${m.messageId}`,type:'qq',text:m.text,at:new Date(m.timestamp).toISOString(),role:m.direction==='outgoing'?'user':'contact',direction:m.direction,use:'discussion',messageId:m.messageId,...qqSourceMetadata(m)};
      return {...source,text:redact(source.text),speaker:m.direction==='outgoing'?'我':'对方',revision:sourceRevision(source)};}),
    ...companion.turns.filter(t => t.role === 'user' && !t.memoryExcluded && !['feedback','feedback_ref'].includes(t.kind)).map(t => {const source={id:`private:${t.id}`,type:'private',text:t.text,at:t.createdAt,role:'user',use:'discussion',kind:t.kind,version:t.version||1};return {...source,text:redact(t.text),revision:sourceRevision(source)};}),
    ...companion.notes.filter(n => n.use !== 'disabled').map(n => {const source={id:`note:${n.id}`,type:'note',text:n.text,at:n.updatedAt||n.createdAt,use:n.use,kind:n.kind||'material',version:n.version,...(n.evidenceSourceIds?{evidenceSourceIds:n.evidenceSourceIds}:{}),...(n.evidenceRevisions?{evidenceRevisions:n.evidenceRevisions}:{})};return {...source,text:redact(n.text),revision:sourceRevision(source)};}),
    ...(companion.feedback || []).filter(item => !item.redacted).map(item => ({ id: item.sourceId || `private:feedback-${item.id}`,
      type: 'feedback', role: 'user', kind: 'local', text: redact(item.text), targetRef: item.targetRef, at: item.createdAt, revision: digest(item) }))
  ];
}

function sourceSnapshot({scope,records,companion,availableSources,turn}){
  const actualById = new Map(records.filter(record=>eligibleQQ(record)&&sameScope(record,scope)).map(record => [`qq:${record.messageId}`, record]));
  const all = (availableSources || sourcesFor(records, companion)).filter(source => !source.deleted && !source.excluded && source.use !== 'disabled' && sameScopeIfPresent(source, scope))
    .filter(source => source.type !== 'qq' || actualById.has(source.id)).map(source => {
      const actual = source.type === 'qq' && actualById.get(source.id);
      return { ...source, text: redact(source.text), ...(actual ? { direction: actual.direction, speaker: actual.direction === 'outgoing' ? '我' : '对方',...qqSourceMetadata(actual) } : {}) };
    });
  const actualOrder=new Map(records.map((m,i)=>[`qq:${m.messageId}`,i]));
  const privateOrder=new Map(),feedbackById=new Map((companion.feedback||[]).map(item=>[item.id,item]));
  for(const [index,item] of companion.turns.entries())if(item.role==='user'){
    privateOrder.set(`private:${item.id}`,index);
    // A canonical feedback source has a real position when its reference turn
    // exists. This is recorded chronology, not a guessed order between types.
    const feedback=item.feedbackId&&feedbackById.get(item.feedbackId);
    if(feedback)privateOrder.set(feedback.sourceId||`private:feedback-${feedback.id}`,index);
  }
  all.sort((a,b)=>Date.parse(a.at||0)-Date.parse(b.at||0)||(a.type==='qq'&&b.type==='qq'?actualOrder.get(a.id)-actualOrder.get(b.id)
    :privateOrder.has(a.id)&&privateOrder.has(b.id)?privateOrder.get(a.id)-privateOrder.get(b.id):a.id.localeCompare(b.id)));
  const byId = new Map(all.map(s => [s.id, s]));
  const currentId = `private:${turn.id}`;
  const current = byId.get(currentId) || (turn.transient || turn.memoryExcluded ? { id: `request:${turn.id}`, type: 'request', text: redact(turn.text), revision: digest(turn), role: 'user' } : null);
  if (!current) throw new Error('当前私下请求不存在');
  return {actualById,all,byId,current};
}
module.exports={sameScopeIfPresent,supportedByAvailable,pendingPrivateReviews,eligibleQQ,sourcesFor,sourceSnapshot};
