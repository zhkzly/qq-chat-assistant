'use strict';
const { randomUUID } = require('node:crypto');

const types = new Set(['set_goal', 'save_note', 'update_note', 'set_preference', 'correct_source', 'forget']);
const fields = new Set(['type', 'evidenceQuote', 'text', 'noteId', 'sourceId', 'targetQuote', 'use']);
const labels = { set_goal: '更新关系目标', save_note: '记下背景', update_note: '更新背景', set_preference: '记下表达偏好', correct_source: '更正自己的背景说明', forget: '忘记这条本机参考' };
function string(value, name, max = 10000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`Invalid action ${name}`);
  return value;
}
function source(store, scope, id, record = store.getCompanion(scope)) {
  if (typeof id !== 'string') return null;
  if (store.ignoredSources?.(scope).includes(id)) return null;
  if (id.startsWith('note:')) return record.notes.find(n => n.id === id.slice(5));
  if (id.startsWith('private:')) return record.turns.find(t => t.role === 'user' && !t.memoryExcluded && t.id === id.slice(8));
  if (id.startsWith('qq:')) return store.messages(scope).find(m => !m.recalled && m.messageId === id.slice(3));
  return null;
}
function fingerprint(item) { return item ? JSON.stringify([item.id || item.messageId, item.version || null, item.text, item.use || null]) : null; }
function normalizeAction(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(k => !fields.has(k)) || !types.has(raw.type)) throw new Error('Invalid action type or fields');
  const action = { ...raw, evidenceQuote: string(raw.evidenceQuote, 'evidenceQuote', 12000) };
  if (raw.type !== 'forget') {
    if (raw.text !== undefined) action.text = string(raw.text, 'text');
    if (['set_goal', 'save_note', 'set_preference', 'correct_source'].includes(raw.type) && action.text === undefined) throw new Error('Action text is required');
  }
  if (raw.noteId !== undefined) string(raw.noteId, 'noteId', 256);
  if (raw.sourceId !== undefined && !/^(private|note|qq):.{1,256}$/.test(string(raw.sourceId, 'sourceId', 300))) throw new Error('Invalid action sourceId');
  if (raw.type === 'update_note' && !raw.noteId) throw new Error('Update action needs an exact noteId');
  if (raw.type === 'forget' && !raw.sourceId) throw new Error('Forget action needs an exact sourceId');
  if (raw.type === 'correct_source' && !raw.sourceId?.startsWith('private:')) throw new Error('Corrections can only edit your private user source; actual QQ remains original evidence');
  if (raw.targetQuote !== undefined) string(raw.targetQuote, 'targetQuote');
  if (raw.use !== undefined && !['discussion', 'draft', 'disabled'].includes(raw.use)) throw new Error('Invalid action use');
  if (raw.type === 'set_preference' && raw.use && raw.use !== 'discussion') throw new Error('Expression preferences remain private');
  return action;
}
// These patterns recognize unambiguous literal commands, not arbitrary meaning.
// Any model-proposed interpretation outside this subset remains a visible proposal.
function isLiteralCommand(action, userText) {
  const quote = action.evidenceQuote;
  // A substring is evidence, not a permission bypass: include its surrounding
  // clause so the model cannot strip a leading negation or quoted attribution.
  const start = userText.indexOf(quote), preceding = userText.slice(0, start).split(/[。！？!?\n]/).at(-1).trim();
  if (preceding && !/^(?:请|请你|帮我|麻烦|麻烦你|助手)[，,\s]*$/.test(preceding)) return false;
  if (/(?:只是|仅仅|只是在).{0,8}(?:转述|举例|引用)|(?:不用|不要|别|不必).{0,8}(?:保存|记住|记下|修改|更新|删除)|\b(?:do not|don't)\s+(?:save|remember|change|delete)\b/i.test(userText.slice(start + quote.length))) return false;
  const marker = {
    set_goal: /(?:我的(?:长期)?目标(?:是|改为|改成)|(?:把|将)(?:我的|这段关系的)?(?:长期)?目标(?:改为|改成|设为)|(?:请|帮我)?(?:记住|保存|记下).{0,20}(?:目标|我希望))|\b(?:set|save|change|remember)\b.{0,40}\bgoal\b/i,
    save_note: /(?:记住|记下|保存|帮我记|请记)|\b(?:remember|save|note down)\b/i,
    set_preference: /(?:记住|记下|保存(?:我的)?(?:表达)?偏好|以后|今后|一直)|\b(?:always|from now on|remember my preference)\b/i,
    update_note: /(?:更正|纠正|更新|改成|改为|记错|实际是|其实是|这条.{0,20}(?:可以|允许).{0,20}(?:写给|告诉|分享))|\b(?:correct|update|change|replace)\b/i,
    correct_source: /(?:更正|纠正|记错|改成|改为|实际是|其实是)|\b(?:correct|update|change|replace)\b/i,
    forget: /(?:忘记|删掉|删除|别再用|不要再用)|\b(?:forget|delete|remove)\b/i
  }[action.type];
  const matched = marker.exec(quote);
  if (!matched) return false;
  let attribution = quote.slice(0, matched.index);
  const uncertainty = /[?？]|(?:如果|假如|要不要|是否|能不能|也许|可能|假设|例如|比如|不想|不用|不必|不要|别)|\b(?:if|maybe|example|should I|could I|don't|do not)\b/i;
  if(uncertainty.test(attribution)||action.type==='set_goal'&&/[?？]/.test(quote))return false;
  if (action.targetQuote && attribution.includes(action.targetQuote)) attribution = attribution.replace(action.targetQuote, '').replace(/[“”「」『』"']/g, '');
  if (/(?:[“「『"']|她说|他说|对方说|原话|引用|收到|发来|假装|以下内容|\b(?:said|says|quote|example)\b)/i.test(attribution)) return false;
  // Exact output extraction prevents a model from appending an inferred wish or fact.
  if (action.text !== undefined && !userText.includes(action.text)) return false;
  return true;
}
function sharingAuthorized(action) {
  if(/(?:不想|不愿意|不允许|不能|不要|别).{0,16}(?:告诉她|跟她说|对她说|写给她|分享|用于)|\b(?:don't|do not|cannot|not allowed)\b.{0,30}\b(?:share|draft)\b/i.test(action.evidenceQuote))return false;
  return /(?:可以|允许|愿意|想|要|帮我).{0,25}(?:告诉她|跟她说|对她说|写给她|分享给她|用于(?:草稿|表达))|\b(?:share (?:this|it) with her|use (?:this|it) in (?:a |the )?draft)\b/i.test(action.evidenceQuote);
}
function inspect(store, scope, action, turn, record) {
  const current = record.turns.find(t => t.id === turn?.id && t.role === 'user' && !t.memoryExcluded);
  if (!current || current.text !== turn.text || !current.text.includes(action.evidenceQuote)) throw new Error('Action evidence must quote the current scoped user turn exactly');
  const targetId = action.type === 'update_note' ? `note:${action.noteId}` : ['forget', 'correct_source'].includes(action.type) ? action.sourceId : null;
  const target = targetId ? source(store, scope, targetId, record) : null;
  if (targetId && !target) throw new Error('Action target is unavailable in this conversation');
  if (action.targetQuote !== undefined && target && !target.text.includes(action.targetQuote)) throw new Error('Action target quote does not match the selected source');
  let direct = isLiteralCommand(action, current.text), reason = '请核对助手对你这次指令的理解。';
  if (target && !(action.targetQuote && action.targetQuote === target.text && current.text.includes(action.targetQuote))) {
    direct = false; reason = '请确认指的是这一条内容。';
  }
  const previousUse = target?.use || 'discussion';
  if (action.use === 'draft' && previousUse !== 'draft') {
    if (!sharingAuthorized(action)) { direct = false; reason = '这会允许所示内容用于写给她的参考表达。'; }
    // Existing restricted material always requires a specific identified target.
    if (target && !(action.targetQuote === target.text && current.text.includes(target.text))) { direct = false; reason = '请确认允许这条原本私下的内容用于参考表达。'; }
  }
  return { direct, reason, targetId, target, current };
}
function execute(store, scope, action, authorization, target) {
  const before = store.getCompanion(scope), evidenceSourceIds = [`private:${authorization.id}`];
  let saved, undo = null, sourceId = null;
  if (action.type === 'set_goal') {
    saved = store.setGoal(scope, action.text, { evidenceSourceIds });
    undo = { kind: 'goal', expectedVersion: saved.version, previous: before.goal };
  } else if (['save_note', 'set_preference', 'update_note'].includes(action.type)) {
    const old = action.type === 'update_note' ? target : null;
    // Model-derived revision: never inherit trusted user authorship; a model
    // rewrite of a user note produces model-attributed text (undo restores
    // the previous saved object with its original authorship).
    const { authoredBy, ...previous } = old || {};
    saved = store.saveNote(scope, { ...previous, ...(old ? { id: old.id } : {}), text: action.text ?? old.text,
      use: action.type === 'set_preference' ? 'discussion' : action.use || old?.use || 'discussion',
      kind: action.type === 'set_preference' ? 'preference' : old?.kind || 'material', evidenceSourceIds });
    sourceId = `note:${saved.id}`;
    undo = { kind: 'note', id: saved.id, expectedVersion: saved.version, previous: old || null };
  } else if (action.type === 'correct_source') {
    if (action.sourceId === evidenceSourceIds[0]) throw new Error('Cannot rewrite the authorizing command itself');
    saved = store.updateTurn(scope, target.id, action.text); sourceId = action.sourceId;
    undo = { kind: 'turn', id: target.id, expectedFingerprint: fingerprint(saved), previous: target };
  } else {
    if (action.sourceId === evidenceSourceIds[0]) throw new Error('Cannot forget the authorizing command itself; select its source separately');
    store.forgetSource(scope, action.sourceId); sourceId = action.sourceId;
    // Forget does not retain a hidden backup of information the user asked to remove.
  }
  const receipt = { id: randomUUID(), type: action.type, status: 'applied', label: labels[action.type],
    evidenceSourceId: evidenceSourceIds[0], ...(action.type === 'forget' ? {} : { evidenceQuote: action.evidenceQuote }), sourceId,
    text: action.type === 'forget' ? '已从助手参考中移除；不会删除 QQ 原消息。' : saved.text,
    createdAt: new Date().toISOString(), ...(undo ? { undo } : {}) };
  return store.recordActionReceipt ? store.recordActionReceipt(scope, receipt) : receipt;
}
function applyUserActions(store, scope, actions, options = {}) {
  return typeof store._atomic === 'function' ? store._atomic(() => applyActions(store, scope, actions, options)) : applyActions(store, scope, actions, options);
}
function applyActions(store, scope, actions, { turn, baseRevision } = {}) {
  const initial = store.getCompanion(scope), receipts = [], pendingActions = [];
  if (!Number.isSafeInteger(baseRevision) || baseRevision !== initial.revision) return { receipts: [], pendingActions: [], revision: initial.revision, reason: 'stale_revision' };
  if (!Array.isArray(actions) || actions.length > 8) return { receipts: [], pendingActions: [], revision: initial.revision, reason: 'invalid_actions' };
  for (const raw of actions) {
    try {
      const action = normalizeAction(raw), record = store.getCompanion(scope), info = inspect(store, scope, action, turn, record);
      if (info.direct) receipts.push(execute(store, scope, action, info.current, info.target));
      else {
        const pending = { id: randomUUID(), action, label: labels[action.type], reason: info.reason,
          authorizingTurnId: info.current.id, authorizingText: info.current.text,
          targetId: info.targetId, targetFingerprint: fingerprint(info.target),
          goalVersion: action.type === 'set_goal' ? record.goal.version : undefined,
          preview: action.type === 'forget' ? info.target.text : action.text ?? info.target?.text,
          previousUse: info.target?.use, createdAt: new Date().toISOString() };
        pendingActions.push(store.savePendingAction ? store.savePendingAction(scope, pending) : pending);
      }
    } catch (error) {
      const receipt={ id: randomUUID(), type: typeof raw?.type==='string'?raw.type:'unknown', status: 'rejected', reason: error.message };
      receipts.push(store.recordActionReceipt?store.recordActionReceipt(scope,receipt):receipt);
    }
  }
  return { receipts, pendingActions, revision: store.getCompanion(scope).revision };
}
function confirmUserAction(store, scope, pending, decision) {
  return typeof store._atomic==='function'?store._atomic(()=>confirmAction(store,scope,pending,decision)):confirmAction(store,scope,pending,decision);
}
function confirmAction(store, scope, pending, decision) {
  if (!pending || !['confirm', 'dismiss'].includes(decision)) throw new Error('Invalid pending action decision');
  const saved=store.getCompanion(scope).pendingActions.find(item=>item.id===(typeof pending==='string'?pending:pending.id));
  if(!saved)throw new Error('这条待确认内容已经变化或处理，请重新说明当前想法。');
  pending=saved;
  if (decision === 'dismiss') { store.resolvePendingAction(scope, pending.id); return { status: 'dismissed', id: pending.id }; }
  const record = store.getCompanion(scope), current = record.turns.find(t => t.role === 'user' && t.id === pending.authorizingTurnId);
  if (!current || current.text !== pending.authorizingText || pending.goalVersion !== undefined && record.goal.version !== pending.goalVersion || fingerprint(pending.targetId ? source(store, scope, pending.targetId, record) : null) !== pending.targetFingerprint) {
    store.resolvePendingAction(scope, pending.id); throw new Error('这条待确认内容已经变化，请重新说明当前想法。');
  }
  const action = normalizeAction(pending.action), info = inspect(store, scope, action, current, record);
  const receipt = execute(store, scope, action, info.current, info.target);
  store.resolvePendingAction(scope, pending.id); return receipt;
}
function undoUserAction(store, scope, receipt) {
  return typeof store._atomic==='function'?store._atomic(()=>undoAction(store,scope,receipt)):undoAction(store,scope,receipt);
}
function undoAction(store, scope, receipt) {
  if (!receipt?.undo || receipt.status !== 'applied') throw new Error('This action has no reversible change');
  const record = store.getCompanion(scope), undo = receipt.undo;
  if (!source(store, scope, receipt.evidenceSourceId, record)) throw new Error('原来的修改依据已删除，不能恢复旧内容。');
  if ((undo.previous?.evidenceSourceIds || []).some(id => !source(store, scope, id, record))) throw new Error('旧内容的来源已删除，不能重新恢复。');
  const saved=record.actionReceipts.find(item=>item.id===receipt.id);
  if(!saved||saved.status!=='applied'||JSON.stringify(saved.undo)!==JSON.stringify(undo))throw new Error('这条内容后来已修改或处理，不能撤销。');
  if (undo.kind === 'goal') {
    if (record.goal.version !== undo.expectedVersion) throw new Error('目标后来已修改，请直接说明要怎样调整。');
    store.setGoal(scope, undo.previous.text, { evidenceSourceIds: undo.previous.evidenceSourceIds || [] });
  } else if (undo.kind === 'note') {
    const current = record.notes.find(n => n.id === undo.id);
    if (!current || current.version !== undo.expectedVersion) throw new Error('这条背景后来已修改，请直接说明要怎样调整。');
    if (undo.previous) store.saveNote(scope, undo.previous); else store.deleteNote(scope, undo.id);
  } else if (undo.kind === 'turn') {
    const current = record.turns.find(t => t.role === 'user' && t.id === undo.id);
    if (!current || fingerprint(current) !== undo.expectedFingerprint) throw new Error('这段说明后来已修改，请直接说明要怎样调整。');
    store.updateTurn(scope, undo.id, undo.previous.text);
  } else throw new Error('Invalid undo descriptor');
  const updated = { ...receipt, status: 'undone' }; delete updated.undo;
  if (store.recordActionReceipt) store.recordActionReceipt(scope, updated);
  return updated;
}
module.exports = { applyUserActions, confirmUserAction, undoUserAction };
