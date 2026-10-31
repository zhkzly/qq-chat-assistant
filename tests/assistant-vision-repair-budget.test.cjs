'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Store } = require('../src/store.cjs');
const { SourceHandleOwner } = require('../src/source-handles.cjs');
const { normalize } = require('../src/messages.cjs');
const { buildContext } = require('../src/assistant-context.cjs');
const { assistModel } = require('./fixtures/assistant-protocol.cjs');
const { scope, raw } = require('./fixtures/native.cjs');
const { withCurrentDraftControls } = require('./fixtures/draft-controls.cjs');

function visionFixture(t,explicitOwner){
  const store = new Store(':memory:'); t.after(() => store.close());
  const settings = { model: 'synthetic', anonymous: true, baseUrl: 'http://fixture.invalid/v1', assistantRequestBytes: 64000 };
  const message = (id, own, text, timestamp, image = false) => normalize(raw(String(id), own, { msgTime: String(timestamp),
    elements: image ? [{ picElement: { sourcePath: '/synthetic/never-read.png' } }] : [{ textElement: { content: text } }] }), scope);
  const old = Array.from({ length: 24 }, (_, i) => message(20000 + i, i % 2 === 0, '旧'.repeat(800), 1700000000 + i));
  const recent = Array.from({ length: 17 }, (_, i) => message(30000 + i, i % 2 === 0, '新'.repeat(170), 1701000000 + i, i === 2));
  store.add(scope, [...old, ...recent]);
  const turn = store.appendTurn(scope, { role: 'user', kind: 'discussion', text: 'Synthetic image repair.' });
  const images = [{ messageId: '30002', index: 0, bytes: 24, url: 'data:image/png;base64,synthetic' }];
  const relationshipContext = { version: 1, claims: old.map((m, i) => ({ id: `claim-${i}`, text: `past fact ${i}`,
    sourceIds: [`qq:${m.messageId}`], subject: 'contact', assertionKind: 'reported', reviewComplete: true })), events: [], activities: [], coverage: {} };
  if(explicitOwner)settings.sourceHandleOwner=new SourceHandleOwner({scope,taskId:'synthetic-vision-repair'});
  const context = buildContext({ scope, records: store.messages(scope), companion: store.getCompanion(scope), turn, settings,
    requestId: 'synthetic-vision-repair', purpose: 'reply', coverage: { status: 'partial' }, images, mediaContext: { mode: 'automatic', omitted: [] }, relationshipContext });
  return {store,settings,context};
}

// Native/persisted consumer shapes, entirely fictional text and image bytes.
// The fake HTTP response deliberately requires a source-bound planning repair.
test('vision planning repair rebudgets the full wrapper without attaching pixels to the null envelope probe', async t => {
  const {settings,context}=visionFixture(t,true);
  const beforeSourceCount = context.payload.sources.length, calls = [];
  // Preserve real wrapper pressure without relying on unrelated history to
  // fill every available byte of the ordinary request.
  settings.assistantRequestBytes=context.manifest.serializedTextRequestBytes+200;
  assert.ok(context.manifest.serializedTextRequestBytes<=settings.assistantRequestBytes);
  const result = await assistModel(settings, context, undefined, async (_url, request) => {
    const wire = JSON.parse(request.body), content = wire.messages[1].content;
    const input = JSON.parse(Array.isArray(content) ? content[0].text : content);
    calls.push({ wire, input });
    const response = calls.length === 1
      ? { kind: 'discussion', text: '虚构修复载荷'.repeat(340), draftPlan: { intent: 'reply', quotes: [] } }
      : { kind: 'discussion', text: 'Synthetic repaired plan.', draftPlan: withCurrentDraftControls({ intent: 'reply', quotes: [] }, input.originalInput),answer:{suggestions:[{text:'Synthetic complete image response.'}]} };
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(response) } }] }) };
  });
  assert.equal(calls.length, 2);
  assert.equal(result.draftPlan.intent, 'reply');
  assert.ok(context.resultContext, 'the actual repaired context must be retained for the next stage');
  assert.ok(context.resultContext.payload.sources.length < beforeSourceCount, 'the full repair wrapper must cause real bounded source repacking');
  for(const id of context.essentialSourceIds)assert.equal(context.resultContext.payload.sources.find(source=>source.id===id)?.text,context.payload.sources.find(source=>source.id===id)?.text,'evict optional rows without shrinking an essential original');
  for (const call of calls) {
    assert.equal(call.wire.messages[1].content.length, 2, 'one actual image remains attached');
    const sourceInput = call.input.originalInput || call.input;
    const imageSource=sourceInput.sources.find(source=>source.messageId==='30002');assert.ok(imageSource);
    assert.deepEqual(call.input.imageContext.attached.map(image=>image.sourceId),[imageSource.id]);
    const textOnly = { ...call.wire, messages: [call.wire.messages[0], { role: 'user', content: JSON.stringify(call.input) }] };
    assert.ok(Buffer.byteLength(JSON.stringify(textOnly)) <= settings.assistantRequestBytes);
  }
});

// A standalone context captures an owned settings snapshot. Mutating a separate
// caller settings object afterwards does not rewrite that captured budget.
// The actual dispatch ceiling must still fail closed, never send over-cap.
test('standalone post-capture lower cap rejects an irreducible rebuilt wrapper before another HTTP dispatch',async t=>{
 const {settings,context}=visionFixture(t,false),calls=[];
 settings.assistantRequestBytes=context.manifest.serializedTextRequestBytes+200;
 await assert.rejects(assistModel(settings,context,undefined,async(_url,request)=>{
  const wire=JSON.parse(request.body),content=wire.messages[1].content,input=JSON.parse(content[0].text);calls.push({wire,input});
  return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({kind:'discussion',text:'虚构修复载荷'.repeat(340),draftPlan:{intent:'reply',quotes:[]}})}}]})};
 }),/必要修复输入超过预算/);
 assert.equal(calls.length,1,'the lower actual call limit cannot dispatch an over-budget repair');
 const first=calls[0],textOnly={...first.wire,messages:[first.wire.messages[0],{role:'user',content:JSON.stringify(first.input)}]};
 assert.ok(Buffer.byteLength(JSON.stringify(textOnly))<=settings.assistantRequestBytes);
 assert.equal(context.extraRequests,undefined,'no repair was dispatched or presented as a completed review');
});
