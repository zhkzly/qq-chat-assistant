'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {parseModelJson,readModelOutput} = require('../src/model-json.cjs');
test('plain, fenced and a single wrapped JSON object preserve exact content', () => {
  const expected={kind:'discussion',text:'保留“暂不邀约”，也保留 {括号} 与转义 "引号"。'};
  const body=JSON.stringify(expected);
  for(const input of [body,`\uFEFF${body}`,`\`\`\`json\n${body}\n\`\`\``,`先说明，这只是未验证的提案。\n\`\`\`json\n${body}\n\`\`\``])
    assert.deepEqual(parseModelJson(input),expected);
});
test('ambiguous documents, malformed parents, arrays and truncated text are not guessed or repaired locally', () => {
  for(const input of ['{"kind":"discussion"', '{"inner":{"kind":"discussion"},', '解释\n{"text":"a"}\n{"text":"b"}',
    '解释\n```json\n{"text":"a"}\n```\n```json\n{"text":"b"}\n```','[{"text":"a"}]','"{\\"text\\":\\"a\\"}"','解释\n{"text":"a\nb"}'])
    assert.throws(()=>parseModelJson(input),SyntaxError);
});
test('provider text blocks are joined without exposing thinking blocks', () => {
  const result=readModelOutput({choices:[{finish_reason:'stop',message:{content:[{type:'thinking',thinking:'private reason'},
    {type:'text',text:'```json'},{type:'text',text:'{"kind":"discussion","text":"可继续"}'},{type:'text',text:'```'}]}}]});
  assert.equal(result.metadata.contentShape,'text_blocks');assert.equal(result.metadata.finishReason,'stop');
  assert.equal(result.text.includes('private reason'),false);assert.equal(parseModelJson(result.text).text,'可继续');
});
test('empty and exhausted provider outputs expose safe actionable error codes', () => {
  assert.throws(()=>readModelOutput({choices:[{finish_reason:'length',message:{content:''}}]}),e=>e.code==='model_output_truncated');
  assert.throws(()=>readModelOutput({choices:[{finish_reason:'stop',message:{content:null}}]}),SyntaxError);
});
