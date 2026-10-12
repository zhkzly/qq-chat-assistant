'use strict';
const {normalizeResultPadding}=require('./model-response-format.cjs');
// Parse transport framing only. Callers must still validate their own schema,
// source authority and disclosure rules; prose outside JSON is never executed.
function jsonError(message = '响应没有单个完整 JSON 对象') {
  const error = new SyntaxError(message); error.code = 'model_invalid_json'; return error;
}
function objectValue(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw jsonError('响应必须是 JSON 对象');
  return value;
}
function parseModelJson(value) {
  if (typeof value !== 'string') return objectValue(value);
  const original = value.replace(/^\uFEFF/, '').trim();
  if (!original) throw jsonError('模型返回了空文字');
  const exactFence = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i.exec(original);
  const direct = exactFence ? exactFence[1].trim() : original;
  // A document starting with JSON must be valid in full. Do not recover an
  // inner object from a truncated or malformed parent document.
  if (/^[{["\d-]|^(?:null|true|false)\b/.test(direct)) {
    try { return objectValue(JSON.parse(direct)); } catch { throw jsonError(); }
  }
  const fences = [...original.matchAll(/```(?:json)?\s*\n([\s\S]*?)\n```/gi)];
  if (fences.length > 1) throw jsonError('响应含多个 JSON 候选，不能猜测采用哪一个');
  const candidates = [];
  for (let start = 0; start < original.length; start++) {
    if (original[start] !== '{') continue;
    let depth = 0, quoted = false, escaped = false, end = -1;
    for (let index = start; index < original.length; index++) {
      const char = original[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === '{') depth++;
      else if (char === '}' && --depth === 0) { end = index + 1; break; }
    }
    if (end < 0) throw jsonError();
    try { candidates.push(objectValue(JSON.parse(original.slice(start, end)))); } catch {}
    start = end - 1;
  }
  if (candidates.length !== 1) throw jsonError(candidates.length > 1 ? '响应含多个 JSON 候选，不能猜测采用哪一个' : undefined);
  return candidates[0];
}
function readModelOutput(response) {
  const choice = response?.choices?.[0], content = choice?.message?.content;
  let text, shape;
  const calls=choice?.message?.tool_calls;
  if(Array.isArray(calls)&&calls.length){
    if(calls.length!==1||!['assistant_result','draft_result','discussion_compaction_result','memory_result'].includes(calls[0]?.function?.name))throw jsonError('模型返回了不明确或非结果格式的调用；未执行任何调用');
    const args=calls[0].function.arguments;
    if(typeof args==='string'){
      text=args;try{text=JSON.stringify(normalizeResultPadding(JSON.parse(args),calls[0].function.name));}catch{}
    }
    else if(args&&typeof args==='object'&&!Array.isArray(args))text=JSON.stringify(normalizeResultPadding(args,calls[0].function.name));
    else throw jsonError('模型结果参数不是 JSON 对象');
    shape='result_tool';
  } else if (typeof content === 'string') { text = content; shape = 'string'; }
  else if (Array.isArray(content)) {
    text = content.filter(item => ['text','output_text'].includes(item?.type) && typeof item.text === 'string').map(item => item.text).join('\n');
    shape = 'text_blocks';
  } else throw jsonError('模型未返回可用的文字内容');
  if (!text.trim()) {
    const error = jsonError(choice?.finish_reason === 'length' ? '模型输出达到上限但没有完整文字' : '模型返回了空文字');
    error.code = choice?.finish_reason === 'length' ? 'model_output_truncated' : 'model_empty_output'; throw error;
  }
  return { text, metadata: { finishReason: choice?.finish_reason || null, contentShape: shape, contentCharacters: text.length } };
}
module.exports = { parseModelJson, readModelOutput };
