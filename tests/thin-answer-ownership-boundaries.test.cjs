'use strict';
// Fictional boundary probes derived from the existing ownership/lifecycle
// fixtures. Scripted checker decisions test contracts, never model quality.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {PrimaryReferenceOwner}=require('../src/primary-reference-registry.cjs');
const {compilePrimaryFrame}=require('../src/primary-frame.cjs');
const {buildFidelityContext,parseFidelityResult,approvalFor}=require('../src/whole-answer-fidelity.cjs');
const {Controller}=require('../src/controller.cjs'),{Store}=require('../src/store.cjs');
const {assistModel}=require('../src/assistant-model.cjs');
const {visibleResponseText}=require('../src/experience-store.cjs');
const {projectVisibleTurn}=require('../scripts/eval-qq-adapter.cjs');
const {scope,raw}=require('./fixtures/native.cjs');
const NOW='2026-10-01T10:00:00.000Z';
const FACT='我昨天第一次把读书笔记网页的查找功能做好了。';
const PRIVATE='家里的事只在这里讨论，不要告诉她。';
const CONTROL='这次先接住她分享的花盆近况，不发出邀请。';
const uiSource=fs.readFileSync(path.resolve(__dirname,'../ui/app.js'),'utf8'),uiFunction=uiSource.match(/function assistantVisibleBody\(turn\)\{[^\n]*\}/)?.[0];assert.ok(uiFunction);const uiBody=vm.runInNewContext(`(${uiFunction})`);
const source=(id,text,extra={})=>({id,text,type:'private',role:'user',kind:'discussion',use:'discussion',revision:'revision-'+id,at:NOW,...extra});
const typed=(error,code)=>error.code===code||error.issues?.some(issue=>issue.code===code);
function originals({human=CONTROL}={}){
 const qq=source('qq:91000000000000731','今天窗边的花盆多长了两片新叶。',{type:'qq',role:'contact'}),other=source('qq:91000000000000732','我准备给花盆换土。',{type:'qq',role:'contact'}),current=source('private:current',human),older=source('private:older','我还在等家里的安排，先不要把这件事告诉她。');
 const payload={purpose:'discussion',intentAuthority:{sourceId:current.id},userRequest:{sourceId:current.id,text:current.text},draftMaterialPolicy:{version:1},requestDeliveryPolicy:{version:1},sources:[qq,other,older,current]};
 return {payload,qq,other,current,older};
}
function snapshot(payload,owner=new PrimaryReferenceOwner({scope,taskId:'thin-ownership-boundary'})){const view=owner.preview(payload);view.commit();return view;}
const refFor=(view,id)=>view.receipt.materials.find(item=>item.sourceId===id).materialRef;
const programFor=(view,id)=>view.receipt.authorities.find(item=>item.kind==='PROGRAM_SOURCE_AUTHORITY'&&item.targetSourceId===id).authorityRef;
function checker({human=CONTROL,message='这两片新叶看着挺精神。',admitted=[]}={}){
 const app=originals({human}),manifest={scope,requestId:'thin-ownership-checker',sourceIds:app.payload.sources.map(item=>item.id),sourceRevisions:Object.fromEntries(app.payload.sources.map(item=>[item.id,item.revision]))},prepared={payload:app.payload,manifest,fullAvailableSources:app.payload.sources,essentialSourceIds:[app.current.id,app.qq.id]},result={kind:'draft',text:'',discussionExplanation:{kind:'discussion',text:'先回应她已经分享的近况。'},suggestions:[{style:'自然',text:message}]};
 const context=buildFidelityContext(prepared,result,{scope,requestId:manifest.requestId,admittedContext:{payload:{outboundQuotes:admitted,currentHumanControl:{sourceId:app.current.id,authority:'CONTROL_ONLY',text:human}},manifest},requestMeasure:value=>Buffer.byteLength(JSON.stringify(value))});
 return {...app,context,result,prepared};
}
const decide=(context,issues=[],extra={})=>parseFidelityResult({checkRef:context.payload.checkRef,verdict:issues.length?'reject':'allow',issues,...extra},context);
function primary(message='这两片新叶看着挺精神。',{why,currentFacts,materials,editingReference}={}){
 return {operation:'prepare_message',answer:{suggestions:[{text:message}],...(why?{privateExplanation:why}:{})},...(currentFacts?{currentFacts}:{}),...(materials?{materials}:{}),...(editingReference?{editingReference}:{})};
}
async function application(t,producer,{noteText,noteUse='discussion'}={}){
 t.mock.method(globalThis,'fetch',async()=>{throw Error('No unmocked network calls are permitted in these fictional tests');});
 const store=new Store(':memory:'),calls=[],contexts=[],model='synthetic-thin-answer-boundaries',baseUrl='http://fixture.invalid/v1';
 const controller=new Controller({store,compactionModel:null,settings:{anonymous:true,auto:false,model,baseUrl,modelResponseMode:'result_tool',assistantRequestLimit:4,discussionCompactionEnabled:false,realChatConsent:{...scope,model,baseUrl}},read:async(command,args)=>command==='bind'?(String(args?.uin)===scope.peerUin?scope:{...scope,peerUid:'another-contact',peerUin:String(args?.uin)}):{messages:[]},assistantModel:(settings,context,signal)=>{
  contexts.push(context);
  return assistModel(settings,context,signal,async(_url,args)=>{
   const request=JSON.parse(args.body),content=request.messages[1].content,wrapper=JSON.parse(typeof content==='string'?content:content.find(item=>item.type==='text').text),p=wrapper.originalInput||wrapper,entry={request,wrapper,p};calls.push(entry);
   const value=await producer(p,wrapper,calls.length-1,entry),name=request.tool_choice?.function.name;
   return new Response(JSON.stringify({choices:[{message:name?{tool_calls:[{id:'thin-answer-fixture',type:'function',function:{name,arguments:JSON.stringify(value)}}]}:{content:JSON.stringify(value)}}]}),{status:200});
  });
 }});
 t.after(()=>{controller.close();store.close();});controller.updateStatus({phase:'ready',account:{uid:scope.accountUid,uin:scope.accountUin}});await controller.bind(scope.peerUin);
 controller.live({scope,messages:[raw('91000000000000733',false,{msgTime:String(Math.floor(Date.now()/1000)-60),elements:[{textElement:{content:'今天窗边的花盆多长了两片新叶。'}}]})]});
 const note=noteText?store.saveNote(scope,{text:noteText,use:noteUse}):null;
 return {store,controller,calls,contexts,note,run:()=>store.getCompanion(scope).runs.at(-1),assist:(text=CONTROL,extra={})=>controller.assist({text,taskId:'thin-answer-boundaries',...extra})};
}

test('pure current control needs no outward material, dead draft plan or additional composer call',async t=>{
 const why='先接住她实际分享的小变化，私下说明到这里即可。',app=await application(t,p=>p.purpose==='fidelity_check'?{checkRef:p.checkRef,verdict:'allow',issues:[]}:primary(undefined,{why})),reply=await app.assist();
 assert.equal(reply.kind,'draft');assert.equal(reply.text,'');assert.equal(reply.suggestions[0].text,'这两片新叶看着挺精神。');assert.equal(reply.discussionExplanation.text,why);
 assert.equal(app.calls.length,2);assert.equal(app.calls[1].p.purpose,'fidelity_check');assert.deepEqual(app.calls[1].p.admittedFragments,[]);assert.equal(app.calls.some(call=>call.p.purpose==='draft'),false);
 const schema=app.calls[0].request.tools[0].function.parameters;
 assert.equal(schema.properties.draftPlan,undefined);assert.equal(schema.properties.guidance,undefined);assert.equal(schema.required.includes('draftPlan'),false);
 for(const item of app.calls[0].p.sources.filter(item=>item.type==='qq'||item.id===app.calls[0].p.intentAuthority.sourceId)){assert.equal(item.materialChoices,undefined);assert.equal(item.authorityChoices,undefined);}
 assert.ok(app.calls[1].p.evidence.some(item=>item.text===CONTROL));assert.equal(app.store.messages(scope).some(item=>item.direction==='outgoing'),false);
});

test('mixed current facts bind exact genuine spans while full original privacy and factual limits reach the checker',async t=>{
 const human=FACT+'这句可以告诉她。'+PRIVATE+'我没有自己装过书架；只有我之后明确说想一起做，才准备邀请，这次不邀请。',app=await application(t,p=>p.purpose==='fidelity_check'?{checkRef:p.checkRef,verdict:'allow',issues:[]}:primary(FACT,{currentFacts:[FACT],why:'只把本次愿意分享的网页近况写进消息。'})),reply=await app.assist(human),packet=app.calls[1].p;
 assert.equal(app.calls.length,2);assert.equal(reply.suggestions[0].text,FACT);assert.deepEqual(packet.admittedFragments.map(item=>item.text),[FACT]);
 const current=packet.evidence.find(item=>item.sourceId===packet.currentHumanControl.sourceId);assert.equal(current.text,human);assert.equal(packet.currentHumanControl.authority,'CONTROL_ONLY');
 assert.equal(packet.admittedFragments.some(item=>item.text.includes(PRIVATE)),false);assert.equal(packet.candidate.suggestions[0].text,FACT);
});

test('a short current fact remains usable in a supported long current original with its final privacy qualifier intact',async t=>{
 const human=FACT+'这句可以告诉她。'+('PRIVATE_CONTEXT_PADDING '.repeat(200))+PRIVATE,app=await application(t,p=>p.purpose==='fidelity_check'?{checkRef:p.checkRef,verdict:'allow',issues:[]}:primary(FACT,{currentFacts:[FACT]})),reply=await app.assist(human);
 assert.ok(human.length>4000&&human.length<16000);assert.equal(app.calls.length,2);assert.equal(reply.suggestions[0].text,FACT);
 const packet=app.calls[1].p,original=packet.evidence.find(item=>item.sourceId===packet.currentHumanControl.sourceId);assert.equal(original.text,human);assert.ok(original.text.endsWith(PRIVATE));assert.deepEqual(packet.admittedFragments.map(item=>item.text),[FACT]);
});

for(const [name,fact]of [['invented fact','我昨天自己装好了一个四层书架。'],['rewritten current fact','昨天我把读书笔记网页的查找功能第一次做好了。']])test(`${name} cannot pass exact current-original binding or reach a checker`,async t=>{
 const app=await application(t,p=>{assert.notEqual(p.purpose,'fidelity_check');return primary(fact,{currentFacts:[fact]});});
 await assert.rejects(app.assist(FACT+'这句可以告诉她。'),error=>typed(error,'current_fact_span_invalid'));assert.equal(app.calls.length,2,'the one structured repair cannot bypass exact binding');assert.equal(app.store.getCompanion(scope).turns.some(item=>item.role==='assistant'),false);
});

test('a real older private fact cannot masquerade as an exact current-original fact',async t=>{
 const app=await application(t,p=>{assert.notEqual(p.purpose,'fidelity_check');return primary(FACT,{currentFacts:[FACT]});});
 app.store.appendTurn(scope,{role:'user',kind:'discussion',text:FACT+'先只留在这里讨论。'});
 await assert.rejects(app.assist(CONTROL),error=>typed(error,'current_fact_span_invalid'));assert.equal(app.calls.length,2);assert.equal(app.store.getCompanion(scope).turns.some(item=>item.role==='assistant'),false);
});

test('exact current binding does not grant private disclosure, and one whole-candidate repair must pass the original again',async t=>{
 const privateReason='家里这周的安排让我很焦虑。',human=FACT+'这句可以告诉她。只在这里私下说：'+privateReason+'不要告诉她。',why='最后只分享已明确愿意对外说的网页近况。';let checks=0;
 const app=await application(t,(p,wrapper)=>{
  if(p.purpose==='fidelity_check'){
   checks++;const original=p.evidence.find(item=>item.sourceId===p.currentHumanControl.sourceId);assert.equal(original.text,human);
   if(checks===1){assert.deepEqual(p.admittedFragments.map(item=>item.text),[privateReason]);return {checkRef:p.checkRef,verdict:'reject',issues:[{path:'suggestions[0].text',code:'private_disclosure',quote:privateReason,evidence:[{sourceId:original.sourceId,quote:human}],reason:'The exact span is present, but its complete current original explicitly keeps it private.'}]};}
   assert.deepEqual(p.admittedFragments.map(item=>item.text),[FACT]);return {checkRef:p.checkRef,verdict:'allow',issues:[]};
  }
  return wrapper.originalInput?primary(FACT,{currentFacts:[FACT],why}):primary(privateReason,{currentFacts:[privateReason],why:'This rejected explanation must never be published.'});
 }),reply=await app.assist(human);
 assert.equal(app.calls.length,4);assert.equal(checks,2);assert.equal(reply.suggestions[0].text,FACT);assert.equal(reply.discussionExplanation.text,why);assert.equal(JSON.stringify(reply).includes(privateReason),false);
 const ledger=app.controller.usage.get(scope,'thin-answer-boundaries');assert.equal(ledger.requests.filter(item=>item.purpose==='delivery_repair').length,1);assert.equal(ledger.attempts,4);
 assert.equal(app.store.getCompanion(scope).turns.filter(item=>item.role==='assistant').length,1);
});

for(const [name,declare,message,human]of [
 ['a declared private reason',true,'家里这周的安排让我很焦虑。','只在这里私下说：家里这周的安排让我很焦虑。不要告诉她。'],
 ['an undeclared private reason',false,'家里这周的安排让我很焦虑。','只在这里私下说：家里这周的安排让我很焦虑。不要告诉她。'],
 ['negated sharing permission',true,FACT,FACT+'但这件事不要告诉她，只在这里说。'],
 ['an unmet sharing condition',true,FACT,'只有她先问我的网页，才可以说“'+FACT+'”；她现在还没问，这轮先不透露。']
])test(`${name} remains subject to the exact-candidate checker`,async t=>{
 const app=await application(t,p=>{
  if(p.purpose!=='fidelity_check')return primary(message,declare?{currentFacts:[message]}:{});
  const original=p.evidence.find(item=>item.sourceId===p.intentAuthority.sourceId);assert.equal(original.text,human);assert.equal(p.candidate.suggestions[0].text,message);
  return {checkRef:p.checkRef,verdict:'reject',issues:[{path:'suggestions[0].text',code:'private_disclosure',quote:message,evidence:[{sourceId:original.sourceId,quote:human}],reason:'An exact primary span is neither a completeness proof nor permission to disclose against original negation or conditions.'}]};
 });
 await assert.rejects(app.assist(human),error=>error.code==='request_delivery_repair_exhausted');assert.equal(app.calls.length,4);assert.equal(app.store.getCompanion(scope).turns.some(item=>item.role==='assistant'),false);
 assert.equal(app.controller.usage.get(scope,'thin-answer-boundaries').requests.filter(item=>item.purpose==='delivery_repair').length,1);
});

test('only the complete answer owns one visible private explanation and individually revocable message leaves',async t=>{
 const why='PRIVATE_FINAL_OWNER：先接住她分享的花盆近况。',first='这两片新叶看着挺精神。',second='窗边的光线看起来很适合它。',app=await application(t,p=>p.purpose==='fidelity_check'?{checkRef:p.checkRef,verdict:'allow',issues:[]}:{operation:'prepare_message',answer:{privateExplanation:why,suggestions:[{text:first},{text:second}]}}),reply=await app.assist();
 assert.equal(app.calls.length,2);assert.equal(reply.text,'');assert.equal(reply.discussionExplanation.text,why);assert.equal(visibleResponseText(reply),why);assert.equal(projectVisibleTurn(reply).text,why);assert.equal(uiBody(reply),why);
 assert.equal(app.store.experiences.artifact(scope,reply.artifactRef).body,why);assert.deepEqual(projectVisibleTurn(reply).suggestions.map(item=>item.text),[first,second]);
 const rawBefore=JSON.stringify(app.store._getCompanion(scope).turns);app.store.experiences.invalidateArtifacts(scope,[reply.suggestions[0].artifactRef]);
 const saved=app.store.getCompanion(scope).turns.at(-1);assert.equal(JSON.stringify(saved).includes(first),false);assert.equal(saved.suggestions[1].text,second);assert.equal(visibleResponseText(saved),why);assert.equal(projectVisibleTurn(saved).text,why);assert.equal(uiBody(saved),why);
 assert.equal(JSON.stringify(app.controller.snapshot()).includes(first),false);assert.equal(JSON.stringify(app.store._getCompanion(scope).turns),rawBefore,'raw preserved evidence is separate from readable revoked output');
 assert.equal(app.store.messages(scope).some(item=>item.direction==='outgoing'),false);
});

for(const boundary of ['account','contact','current original source'])test(`a delayed thin candidate checker cannot publish after the ${boundary} changes`,async t=>{
 let release,enter;const entered=new Promise(resolve=>{enter=resolve;}),app=await application(t,p=>p.purpose==='fidelity_check'?new Promise(resolve=>{release=()=>resolve({checkRef:p.checkRef,verdict:'allow',issues:[]});enter();}):primary(FACT,{currentFacts:[FACT]})),pending=app.assist(FACT+'这句可以告诉她。');
 pending.catch(()=>{});t.after(()=>release?.());await Promise.race([entered,pending.then(()=>{throw Error('The thin answer published before its controlled checker.');})]);
 assert.equal(app.store.getCompanion(scope).turns.some(item=>item.role==='assistant'),false);
 if(boundary==='account')app.controller.updateStatus({phase:'ready',account:{uid:'a-different-authenticated-account',uin:'999001'}});
 else if(boundary==='contact')await app.controller.bind('99887766');
 else app.store.forgetSource(scope,app.contexts.find(input=>input.payload.purpose==='fidelity_check').payload.currentHumanControl.sourceId);
 release();await pending.catch(()=>{});assert.equal(app.store.getCompanion(scope).turns.some(item=>item.role==='assistant'),false);assert.equal(app.store.messages(scope).some(item=>item.direction==='outgoing'),false);
});

test('public QQ omission derives authority only for its exact offered account, contact and revision',()=>{
 const app=originals(),owner=new PrimaryReferenceOwner({scope,taskId:'thin-ownership-boundary'}),first=snapshot(app.payload,owner),ref=refFor(first,app.qq.id),raw={materials:[{materialRef:ref}]};
 assert.deepEqual(compilePrimaryFrame(raw,first,app.payload).materials,[{sourceId:app.qq.id,text:app.qq.text}]);
 assert.deepEqual(raw,{materials:[{materialRef:ref}]},'program resolution must not modify provider input');
 for(const authorityRef of [programFor(first,app.other.id),'a999999'])assert.throws(()=>compilePrimaryFrame({materials:[{materialRef:ref,authorityRef}]},first,app.payload),error=>typed(error,authorityRef==='a999999'?'unknown_authority_reference':'authority_target_mismatch'));
 const canonical=first.markCanonical({materials:[{sourceId:app.qq.id,text:app.qq.text}]}),changed={...app.payload,sources:app.payload.sources.map(item=>item.id===app.qq.id?{...item,text:'现在花盆已经移到阳台了。',revision:'revised-public-source'}:item)},next=snapshot(changed,owner);
 assert.throws(()=>compilePrimaryFrame(raw,next,changed),error=>typed(error,'unknown_material_reference'));
 assert.throws(()=>compilePrimaryFrame(canonical,next,changed),error=>typed(error,'primary_reference_binding_invalid'));
 for(const key of ['accountUid','accountUin','peerUid','peerUin'])assert.throws(()=>snapshot({...app.payload,sources:app.payload.sources.map(item=>item.id===app.qq.id?{...item,scope:{...scope,[key]:'foreign-scope'}}:item)}),error=>typed(error,'primary_reference_scope_invalid'));
});

test('a previously offered private grant cannot survive a historical-only fence or withdrawn original',()=>{
 const app=originals(),material=source('private:fact',FACT),grant=source('private:grant','网页近况这句可以告诉她。'),payload={...app.payload,sources:[app.qq,material,grant,app.current]},owner=new PrimaryReferenceOwner({scope,taskId:'thin-ownership-boundary'}),first=snapshot(payload,owner),materialRef=refFor(first,material.id),authorityRef=first.receipt.authorities.find(item=>item.kind==='ORIGINALUSERSTATEMENTCANDIDATE'&&item.sourceId===grant.id).authorityRef;
 const raw={materials:[{materialRef,authorityRef}]},compiled=compilePrimaryFrame(raw,first,payload);assert.equal(compiled.materials[0].authorization.permission.sourceId,grant.id);
 const historical={...payload,sources:payload.sources.map(item=>item.id===grant.id?{...item,historicalOnly:true}:item)},next=snapshot(historical,owner);
 assert.equal(next.receipt.authorities.some(item=>item.kind==='ORIGINALUSERSTATEMENTCANDIDATE'&&item.sourceId===grant.id),false);
 assert.throws(()=>compilePrimaryFrame({materials:[{materialRef:refFor(next,material.id),authorityRef}]},next,historical),error=>typed(error,'unknown_authority_reference'));
 const withdrawn={...payload,sources:payload.sources.map(item=>item.id===grant.id?{...item,excluded:true,revision:'withdrawn-grant'}:item)},last=snapshot(withdrawn,owner);
 assert.throws(()=>compilePrimaryFrame({materials:[{materialRef:refFor(last,material.id),authorityRef}]},last,withdrawn),error=>typed(error,'unknown_authority_reference'));
 assert.equal(last.receipt.materials.some(item=>item.sourceId===grant.id),false);
});

test('an exact current fact span retains its complete original conditions, negations and private reason for read-only checking',()=>{
 const human=FACT+'这句可以告诉她。'+PRIVATE+'我没有自己装过书架；如果以后想一起做，我会另外告诉你，这次不邀请。',app=checker({human,message:FACT,admitted:[{sourceId:'private:current',text:FACT}]});
 assert.deepEqual(app.context.payload.admittedFragments,[{sourceId:app.current.id,text:FACT}]);
 assert.equal(app.context.payload.evidence.find(item=>item.sourceId===app.current.id).text,human);
 assert.equal(app.context.payload.currentHumanControl.authority,'CONTROL_ONLY');
 assert.equal(app.context.payload.candidate.suggestions[0].text,FACT);
 assert.equal(app.context.payload.admittedFragments.some(item=>item.text.includes(PRIVATE)),false);
 assert.equal(app.context.payload.evidence.find(item=>item.sourceId===app.older.id).text,app.older.text,'an available later/private limitation is not replaced by the outward fragment');
});

test('a neutral contact echo survives social-pragmatic concern while a grounded factual qualifier remains blocking',()=>{
 const app=checker(),quote=app.result.suggestions[0].text,verdict=decide(app.context,[],{verdict:'reject',concerns:[{path:'suggestions[0].text',code:'pragmatic_ambiguity',quote,reason:'A possible social interpretation of a neutral contact echo is advisory.'}]});
 assert.equal(verdict.verdict,'allow');assert.ok(approvalFor(verdict,app.context));assert.equal(verdict.concerns.length,1);
 assert.equal(app.result.suggestions[0].text,quote);assert.equal(app.result.warning,undefined);
 const qualified=checker({human:'我没有自己养过花，先不要写成我的经历。',message:'我昨天也给自己的花盆换了土。'}),issue={path:'suggestions[0].text',code:'omitted_qualifier',quote:qualified.result.suggestions[0].text,evidence:[{sourceId:qualified.current.id,quote:qualified.current.text}],reason:'The exact original negation is a factual witness, not a social guess.'},rejected=decide(qualified.context,[issue]);
 assert.equal(rejected.verdict,'reject');assert.equal(approvalFor(rejected,qualified.context),undefined);
});

for(const placement of ['issues','concerns'])test(`a social current-action concern remains advisory under ${placement} without deleting its exact evidence`,()=>{
 const human='如果她先说想一起去，再帮我邀请；她现在没说，所以这次不邀请。',app=checker({human,message:'这两片新叶看着挺精神。'}),concern={path:'suggestions[0].text',code:'current_boundary',quote:app.result.suggestions[0].text,sourceIds:[app.current.id],evidence:[{sourceId:app.current.id,quote:human}],reason:'A suggested social interpretation is advisory; the complete original stays available.'},verdict=decide(app.context,placement==='issues'?[concern]:[],{verdict:'reject',...(placement==='concerns'?{concerns:[concern]}:{})});
 assert.equal(verdict.verdict,'allow');assert.ok(approvalFor(verdict,app.context));assert.equal(verdict.issues.length,0);assert.deepEqual(verdict.concerns[0].evidence,concern.evidence);
 assert.equal(app.context.payload.evidence.find(item=>item.sourceId===app.current.id).text,human);
 const bad={...concern,evidence:[{sourceId:app.current.id,quote:'An absent original.'}]};assert.throws(()=>decide(app.context,[],{concerns:[bad]}),error=>typed(error,'fidelity_result_invalid'));
});

for(const [code,human,message] of [
 ['unsupported_fact',CONTROL,'我昨天也给自己的花盆换了土。'],
 ['private_disclosure',PRIVATE,'家里的安排让我这周很焦虑。']
])test(`an explicit ${code} witness is not downgraded into social concern`,()=>{
 const app=checker({human,message}),issue={path:'suggestions[0].text',code,quote:message,reason:'Scripted hard-boundary witness tests the checker contract only.',...(code==='unsupported_fact'?{basis:'no_support_in_supplied_evidence'}:{evidence:[{sourceId:app.current.id,quote:human}]})},verdict=decide(app.context,[issue]);
 assert.equal(verdict.verdict,'reject');assert.equal(approvalFor(verdict,app.context),undefined);assert.equal(verdict.issues[0].code,code);
});
