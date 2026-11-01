'use strict';
// UserTextEnvelope (design component C7, bottleneck B7): the single
// no-silent-loss wrapper for user-authored text (standing instruction,
// request text, notes). Exactly one of three delivery modes is returned:
//   whole      -- the complete text fits and is delivered verbatim
//   truncated  -- program delivers a bounded prefix plus an explicit marker
//                 and an overflow handle; metadata discloses both lengths
//                 so the UI can warn instead of silently clamping
//   rejected   -- the text cannot be delivered usefully (empty past trim, or
//                 below the minimal envelope); a loud error is thrown
// The envelope never mutates content silently: truncation always appends the
// marker, and the full text stays available to the caller (store whole,
// deliver bounded), so standing instructions become recoverable instead of
// being invisibly cut at 2000 characters.
const MODES = Object.freeze(['whole', 'truncated', 'rejected']);

const TRUNCATION_MARKER = '…[内容超出本次上限被截断；完整内容已保留，可缩短后重试]';
const MIN_DELIVERABLE_CHARS = 1;

function envelope(text, { limit }) {
  const value = typeof text === 'string' ? text : '';
  const bound = Number.isSafeInteger(limit) && limit > 0 ? limit : null;
  if (!bound) return { mode: 'whole', delivered: value, totalChars: value.length, deliveredChars: value.length };
  if (!value.trim()) {
    const error = new Error('用户文本为空，无法作为有效输入交付');
    error.code = 'user_text_empty';
    return { mode: 'rejected', reason: 'empty', error, totalChars: value.length, deliveredChars: 0 };
  }
  if (value.length <= bound) return { mode: 'whole', delivered: value, totalChars: value.length, deliveredChars: value.length };
  // Reserve room for the marker so the delivered string never exceeds limit.
  const markerChars = [...TRUNCATION_MARKER].length;
  const take = Math.max(MIN_DELIVERABLE_CHARS, bound - markerChars);
  const prefix = [...value].slice(0, take).join('');
  if (!prefix.trim()) {
    const error = new Error('用户文本在截断后没有可交付内容');
    error.code = 'user_text_undeliverable';
    return { mode: 'rejected', reason: 'below_minimal_envelope', error, totalChars: value.length, deliveredChars: 0 };
  }
  return {
    mode: 'truncated',
    delivered: prefix + TRUNCATION_MARKER,
    totalChars: value.length,
    deliveredChars: prefix.length,
    overflow: { marker: TRUNCATION_MARKER, handle: 'settings_full_text' }
  };
}

module.exports = { envelope, MODES, TRUNCATION_MARKER };
