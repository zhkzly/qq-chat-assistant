'use strict';
// B16 follow-up (blind-review round dsh-ev1, replay-incoming-then-human-send
// s3): the replay adapter's human-send step must reach the same controller
// ingest path the live product uses for outgoing actual messages, so the
// src/response-projection.cjs supersede rule applies on the visible replay
// channel. The routing already exists and needs no product change:
//
//   adapter.observe(events) -> session.deliver(events) -> fictional native
//   boundary -> controller.live({scope,messages}) -> controller.ingest()
//   -> store.add + supersedePendingClarifications(outgoing actual)
//   -> projectAssistantTurn strips superseded re-asks from later turns.
//
// These checks pin that routing end to end through the full adapter protocol
// with a scripted synthetic transport (the only way to make the default
// synthetic boundary produce clarification content). Evidence kind:
// synthetic-boundary product integration only. No real QQ process, no live
// model call, no real chat records, and nothing is ever sent, forwarded or
// auto-replied; the scripted human send is an observed external event.
const test=require('node:test'),assert=require('node:assert/strict');
const path=require('node:path');
const {createAdapterFactory}=require('../scripts/eval-qq-adapter.cjs');
const {makeSyntheticTransport}=require('../scripts/eval-runtime-session.cjs');
const sourceRoot=path.resolve(__dirname,'..');

const QUESTION='你平时更喜欢桂花还是红枣口味的饮品？';
// Substring visibility assertions use the particle-free core: a re-ask may
// add a tail before its question mark (e.g. 呢), which normalization must
// still match but exact-substring checks must not depend on.
const QUESTION_CORE='你平时更喜欢桂花还是红枣口味的饮品';
const REASK='刚才没确认完：你平时更喜欢桂花还是红枣口味的饮品呢？定了我再补完整表达。';
const MANUAL_EXPLANATION='先按你的口味整理一下。'+REASK;
const SUGGESTION='我下次给你带桂花糕试试呀。';
const NEUTRAL_SUGGESTION='先接住她刚才的分享，别急着追问新话题。';
const HUMAN_SEND='听起来这次点单成功了，我下次路过也想试试。';
const FLAVOR_ASK='你平时更喜欢桂花还是红枣这种味道？';
const MANUAL_REQUEST='她问我口味。我自己更喜欢桂花，不怎么喜欢红枣味。现在想手动和你商量一句怎么回。';

const PREFIX_EVENTS=[
 {id:'q1',at:'2026-10-29T19:50:00+08:00',speaker:'contact',text:'图书馆旁边那家小店出了桂花味热饮。'},
 {id:'q2',at:'2026-10-29T19:52:00+08:00',speaker:'self',text:'天气凉了，拿杯热的挺舒服。'}];

// Scripted model boundary. The first automatic observation clarifies the
// user's flavor preference; every later automatic observation answers with an
// ordinary draft (it does not re-ask), so the manual request is the next
// visible re-ask and the strip must come from the recorded supersede state.
// Memory batches and other auxiliary purposes keep the standard offline
// synthetic responses.
function scriptedTransport(){
 const offline=makeSyntheticTransport();
 const respond=(request,body)=>new Response(JSON.stringify({model:request.model,
  choices:[{finish_reason:'stop',message:{content:JSON.stringify(body)}}],
  usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}),{status:200});
 return async(url,args)=>{
  const request=JSON.parse(args.body);let payload={};
  try{const wrapper=JSON.parse(request.messages[1].content);payload=wrapper.originalInput||wrapper;}catch{}
  if(payload.purpose==='reply'){
   if(JSON.stringify(payload).includes(FLAVOR_ASK))
    return respond(request,{operation:'prepare_message',answer:{suggestions:[{style:'自然',text:NEUTRAL_SUGGESTION}]}});
   return respond(request,{operation:'clarify',blocker:{kind:'missing_fact',missing:'你偏好的口味',question:QUESTION}});
  }
  if(payload.purpose==='discussion')
   return respond(request,{operation:'prepare_message',answer:{privateExplanation:MANUAL_EXPLANATION,suggestions:[{style:'自然',text:SUGGESTION}]}});
  return offline(url,args);
 };
}

// Mirrors the runner's step order for replay-incoming-then-human-send:
// advanceTo -> observe per event, automatic drains between, user controls,
// then the manual request. The human-send step is optional for the control.
async function episode({humanSend}){
 const factory=createAdapterFactory({sourceRoot,maxHttp:24,transport:scriptedTransport()});
 const adapter=await factory.create();
 try{
  await adapter.open({as_of:'2026-10-29T20:00:00+08:00',qq_events:PREFIX_EVENTS,private_events:[]},{goal:'和她自然聊下去，互相了解日常喜好。'});
  await adapter.configure({automatic:true});
  await adapter.advanceTo('2026-10-29T20:01:00+08:00');await adapter.drainOutputs();
  await adapter.observe([{id:'q3',at:'2026-10-29T20:01:00+08:00',speaker:'contact',text:'我刚买了一杯，甜度居然刚好，还想下周再来。'}]);
  await adapter.advanceTo('2026-10-29T20:02:00+08:00');
  const automaticClarification=await adapter.drainOutputs();
  let humanStep=null;
  await adapter.advanceTo('2026-10-29T20:04:00+08:00');await adapter.drainOutputs();
  if(humanSend){
   await adapter.observe([{id:'q4',at:'2026-10-29T20:04:00+08:00',speaker:'self',text:HUMAN_SEND}]);
   humanStep={current:await adapter.currentOutput(),drained:await adapter.drainOutputs()};
  }
  await adapter.advanceTo('2026-10-29T20:09:00+08:00');await adapter.drainOutputs();
  await adapter.observe([{id:'q5',at:'2026-10-29T20:09:00+08:00',speaker:'contact',text:FLAVOR_ASK}]);
  await adapter.advanceTo('2026-10-29T20:11:00+08:00');
  const afterFlavorAsk=await adapter.drainOutputs();
  await adapter.configure({automatic:false});
  const manual=await adapter.respond({id:'r3',at:'2026-10-29T20:11:00+08:00',text:MANUAL_REQUEST});
  const {snapshot,trace}=await adapter.diagnostics();
  return {factory,automaticClarification,humanStep,afterFlavorAsk,manual,snapshot,trace};
 }finally{await adapter.close();}
}

test('scripted transport override is a synthetic-only adapter condition',()=>{
 const factory=createAdapterFactory({sourceRoot,maxHttp:4});
 assert.equal(factory.identity.transport,undefined,'the default synthetic identity records no override');
 assert.throws(()=>createAdapterFactory({sourceRoot,live:true,transport:makeSyntheticTransport()}),/scripted transport override/);
 assert.throws(()=>createAdapterFactory({sourceRoot,transport:'not-a-transport'}),/scripted transport override/);
});

test('human send reaches controller ingest: the superseded clarification leaves the visible channel while the draft is preserved',async()=>{
 const {factory,automaticClarification,humanStep,afterFlavorAsk,manual,snapshot,trace}=await episode({humanSend:true});
 assert.equal(factory.identity.transport,'scripted_synthetic_test_override');
 // Precondition: the automatic phase really surfaced the clarification first.
 assert.equal(automaticClarification.length,1);
 assert.equal(automaticClarification[0].disposition,'clarification');
 assert.ok(automaticClarification[0].text.includes(QUESTION));
 // The human-send step itself shows nothing: no current candidate and no new
 // automatic output (output:null design preserved for observed human sends).
 assert.equal(humanStep.current,null);
 assert.deepEqual(humanStep.drained,[]);
 // Routing evidence: the observed send was ingested by the controller as an
 // outgoing actual QQ message, with its QQ message id preserved as a string.
 const ingest=trace.filter(row=>row.component==='controller'&&row.method==='ingest'&&row.event==='call')
  .find(row=>(row.args?.[1]||[]).some(message=>message.elements?.[0]?.textElement?.content===HUMAN_SEND));
 assert.ok(ingest,'the human send entered through controller.ingest');
 const sent=snapshot.messages.find(message=>message.text===HUMAN_SEND);
 assert.ok(sent,'the observed human send is stored as an actual message');
 assert.equal(sent.direction,'outgoing');assert.equal(sent.kind,'actual');
 assert.equal(typeof sent.messageId,'string');assert.match(sent.messageId,/^\d+$/);
 for(const message of snapshot.messages)assert.equal(typeof message.messageId,'string','QQ message ids stay strings');
 // The next automatic phase answers the flavor ask without re-asking the
 // superseded preference question.
 assert.ok(afterFlavorAsk.length>=1);
 assert.ok(afterFlavorAsk.every(output=>!output.text.includes(QUESTION)));
 // The manual request keeps the draft and loses the superseded clarification,
 // sentence-granular: the non-question remainder stays readable.
 assert.equal(manual.disposition,'draft');
 assert.ok(manual.text.includes(SUGGESTION),'the draft body is preserved');
 assert.equal(manual.suggestions[0]?.text,SUGGESTION);
 assert.equal(manual.text.includes(QUESTION_CORE),false,'the superseded clarification no longer surfaces');
 assert.ok(manual.text.includes('定了我再补完整表达。'),'only the clarification sentence is stripped');
});

test('control: without the observed human send the same manual re-ask keeps its clarification visible',async()=>{
 const {automaticClarification,manual}=await episode({humanSend:false});
 assert.equal(automaticClarification.length,1);
 assert.ok(automaticClarification[0].text.includes(QUESTION));
 assert.equal(manual.disposition,'draft');
 assert.ok(manual.text.includes(SUGGESTION),'the draft is present in the control too');
 assert.ok(manual.text.includes(QUESTION_CORE),'no human send means the pending clarification stays visible');
});
