'use strict';
// B13 regression: a draft disposition must never reach the visible layer with
// an empty main text. The wire contract forbids an outer prepare_message
// text, so the composer positionally promotes suggestions[0].text into the
// reply main text regardless of the suggestion count; the remaining leaves
// stay adoptable alternates. Only an answer whose suggestions are all empty
// or whitespace — truly no body anywhere — is rejected into the bounded
// repair round with an executable instruction.
const test=require('node:test'),assert=require('node:assert/strict');
const {prepareAssistantRequest,parseAssistant,assistModel}=require('../src/assistant-model.cjs');
const {SourceHandleOwner}=require('../src/source-handles.cjs');
const {scope}=require('./fixtures/native.cjs');
const BODY='终于考完了，可以好好放松一下了。想看轻松点的，还是挑部一直想看的？';
const ALTERNATE='再挑一部想重刷的老片子？';
const REPAIRED='考完先挑一部一直想看的片子，轻松一点。';
const WHY='先接住她考完后的放松分享，不催她马上决定。';

function fixture(){
  const current={id:'private:promotion-current',type:'private',role:'user',kind:'discussion',revision:'promotion-r1',at:'2026-10-01T10:00:00.000Z',text:'考试结束啦，我终于有空了。给我一条可以改着发的话。'};
  const payload={purpose:'discussion',generationOrigin:'private_discussion',intentAuthority:{sourceId:current.id},userRequest:{sourceId:current.id,text:current.text},sources:[current]};
  const settings={model:'synthetic-draft-promotion',modelResponseMode:'result_tool',baseUrl:'http://fixture.invalid/v1',anonymous:true,sourceHandleOwner:new SourceHandleOwner({scope,taskId:'draft-promotion'})};
  return {payload,settings,current};
}
function active(){
  const original=fixture(),prepared=prepareAssistantRequest(original.settings,original.payload,[]);
  prepared.sourceWire.commit();prepared.primaryFrame.commit();
  const context={payload:original.payload,manifest:{scope,requestId:'draft-promotion',sourceRevisions:Object.fromEntries(original.payload.sources.map(source=>[source.id,source.revision]))},sourceWireSnapshot:prepared.sourceWire,primaryFrameSnapshot:prepared.primaryFrame};
  return {...original,prepared,context,wire:prepared.wirePayload};
}
function response(value,name='assistant_result'){return new Response(JSON.stringify({choices:[{message:{tool_calls:[{id:'draft-promotion-call',type:'function',function:{name,arguments:JSON.stringify(value)}}]}}]}),{status:200});}

test('(a) draft with empty text and one nonempty suggestion promotes that leaf into the main text with a recorded completion marker',()=>{
  const app=active();
  const result=parseAssistant({operation:'prepare_message',answer:{suggestions:[{style:'自然',text:BODY}],privateExplanation:WHY}},'discussion',app.context);
  assert.equal(result.kind,'draft');
  assert.equal(result.text,BODY,'the promoted main text replaces the empty draft body');
  assert.equal(result.suggestions[0].text,BODY);
  assert.equal(result.text,result.suggestions[0].text,'the promoted text is the exact leaf alias owned by the withdrawal projection');
  assert.equal(result.discussionExplanation.text,WHY,'the private explanation stays an independently authored parent field');
  assert.ok(app.context.manifest.wireCompletions?.some(entry=>entry.rule==='draft-text-promotion'&&Array.isArray(entry.fields)&&entry.fields.includes('text')),'the promotion is recorded like other parse-time wire completions');
});

test('(b) draft with empty text and several suggestions promotes the first leaf while the rest stay adoptable alternates without a repair round',async()=>{
  const app=active();
  const result=parseAssistant({operation:'prepare_message',answer:{suggestions:[{style:'自然',text:BODY},{style:'另一种',text:ALTERNATE}],privateExplanation:WHY}},'discussion',app.context);
  assert.equal(result.kind,'draft');
  assert.equal(result.text,BODY,'the positional main draft is always the first suggestion leaf');
  assert.equal(result.suggestions.length,2,'the model channel keeps producing multiple leaves');
  assert.equal(result.suggestions[0].text,BODY);assert.equal(result.suggestions[1].text,ALTERNATE,'the remaining suggestion is preserved as an alternate');
  assert.equal(result.text,result.suggestions[0].text,'the promoted text clears only with its own withdrawn leaf');
  assert.ok(app.context.manifest.wireCompletions?.some(entry=>entry.rule==='draft-text-promotion'),'a multi-suggestion promotion is also marked');
  const context={payload:app.payload,manifest:{scope,requestId:'draft-promotion-multi',sourceRevisions:Object.fromEntries(app.payload.sources.map(source=>[source.id,source.revision]))}},calls=[];
  const emitted=await assistModel(app.settings,context,undefined,async(_url,args)=>{
    calls.push(JSON.parse(args.body));
    return response({operation:'prepare_message',answer:{suggestions:[{text:BODY},{text:ALTERNATE}]}});
  });
  assert.equal(emitted.text,BODY);assert.equal(emitted.suggestions.length,2);assert.equal(emitted.suggestions[1].text,ALTERNATE);
  assert.equal(calls.length,1,'a complete multi-suggestion answer needs no repair round');
  assert.ok(context.manifest.wireCompletions?.some(entry=>entry.rule==='draft-text-promotion'),'the end-to-end emission is marked as promoted');
});

test('(c) an existing draft main text is left unchanged by the promotion path',()=>{
  const {payload}=fixture();
  const draft=parseAssistant({kind:'draft',text:BODY,suggestions:[{style:'自然',text:BODY}]},'draft',{payload:{purpose:'draft',sources:payload.sources}});
  assert.equal(draft.text,BODY,'a restricted draft with model-authored text keeps it verbatim');
  assert.deepEqual(draft.suggestions,[{style:'自然',text:BODY}]);
  const app=active();
  const discussion=parseAssistant({operation:'advise',text:WHY},'discussion',app.context);
  assert.equal(discussion.kind,'discussion');assert.equal(discussion.text,WHY,'discussion text is not touched by draft promotion');
});

test('(d) draft with empty text and an all-empty suggestion list is rejected into the bounded repair round and a written body is promoted',async()=>{
  const app=active();
  assert.throws(()=>parseAssistant({operation:'prepare_message',answer:{suggestions:[]}},'discussion',app.context),
    error=>error.code==='whole_answer_primary_text_missing'&&/把要发送的正文写入 output\.text/.test(error.message),'an empty suggestion list has no body anywhere');
  assert.throws(()=>parseAssistant({operation:'prepare_message',answer:{suggestions:[{text:'  '},{text:''}]}},'discussion',app.context),
    error=>error.code==='whole_answer_primary_text_missing'&&/output\.text/.test(error.message),'whitespace-only suggestions are equally body-less');
  const context={payload:app.payload,manifest:{scope,requestId:'draft-promotion-repair',sourceRevisions:Object.fromEntries(app.payload.sources.map(source=>[source.id,source.revision]))}},calls=[];
  const result=await assistModel(app.settings,context,undefined,async(_url,args)=>{
    const request=JSON.parse(args.body),wrapper=JSON.parse(request.messages[1].content);calls.push({request,wrapper});
    return response(calls.length===1
      ?{operation:'prepare_message',answer:{suggestions:[]}}
      :{operation:'prepare_message',answer:{suggestions:[{text:REPAIRED}]}});
  });
  assert.equal(result.text,REPAIRED,'the repaired first suggestion becomes the reply main text');
  assert.equal(result.suggestions[0].text,REPAIRED);
  assert.equal(calls.length,2,'exactly one bounded repair round was spent');
  assert.ok(calls[1].wrapper.formatError,'the repair wrapper carries the parse failure');
  assert.equal(calls[1].wrapper.originalInput.operationProtocol.requiredArtifact,'message');
  assert.ok(calls[1].wrapper.validationIssues?.some(entry=>entry.code==='whole_answer_primary_text_missing'&&/把要发送的正文写入 output\.text/.test(entry.message)),'the repair feedback names the executable fix');
  assert.equal(context.manifest.formatRepair.attempts,1);
  assert.ok(context.manifest.wireCompletions?.some(entry=>entry.rule==='draft-text-promotion'),'the repaired emission is also marked as promoted');
});

test('(d2) a repair round that still offers no body fails without emitting an empty-body draft',async()=>{
  const app=active();
  const context={payload:app.payload,manifest:{scope,requestId:'draft-promotion-exhausted',sourceRevisions:Object.fromEntries(app.payload.sources.map(source=>[source.id,source.revision]))}},calls=[];
  await assert.rejects(assistModel(app.settings,context,undefined,async(_url,args)=>{
    const request=JSON.parse(args.body);calls.push(request);
    return response({operation:'prepare_message',answer:{suggestions:[{text:'  '}]}});
  }),error=>error.code==='whole_answer_primary_text_missing'&&/模型未能返回可用的结构化结果/.test(error.message));
  assert.equal(calls.length,2,'no third attempt after the bounded repair');
  assert.equal(context.manifest.formatRepair.attempts,1);
  assert.equal(context.manifest.wireCompletions?.some(entry=>entry.rule==='draft-text-promotion'),undefined,'no promoted emission was recorded for a rejected response');
});
