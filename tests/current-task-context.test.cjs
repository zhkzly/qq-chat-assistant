'use strict';
const {factualReview}=require('./fixtures/factual-assessment.cjs');
const {withCurrentDraftControls}=require('./fixtures/draft-controls.cjs');
const test=require('node:test'),assert=require('node:assert/strict');
const {Store}=require('../src/store.cjs'),{Controller}=require('./fixtures/whole-answer-fidelity.cjs');
const {buildContext,buildDraftContext,sourcesFor}=require('../src/assistant-context.cjs'),{normalize}=require('../src/messages.cjs');
const {scope,raw}=require('./fixtures/native.cjs');
function msg(id,own,text,extra={}){return normalize(raw(String(id),own,{elements:[{textElement:{content:text}}],...extra}),scope);}
function setup(t,{text='怎么接着聊？',records=[]}={}){
 const store=new Store(':memory:');t.after(()=>store.close());store.setGoal(scope,'希望和她发展双方愿意的恋爱关系');if(records.length)store.add(scope,records);
 const turn=store.appendTurn(scope,{role:'user',kind:'discussion',text});return {store,turn,args:{scope,records:store.messages(scope),companion:store.getCompanion(scope),turn,requestId:'synthetic-current-task',coverage:{status:'partial'}}};
}
test('QQ shortcut retrieves available self context for her current question rather than only a style phrase',async t=>{
 const store=new Store(':memory:'),inputs=[];const settings={auto:false,anonymous:true,model:'synthetic-current-task',baseUrl:'http://fixture.invalid/v1',realChatConsent:{accountUid:scope.accountUid,peerUin:scope.peerUin,model:'synthetic-current-task',baseUrl:'http://fixture.invalid/v1'}};
 const controller=new Controller({store,settings,read:async()=>{throw Error('no native reading in this fixture');},assistantModel:async(_settings,input)=>{if(input.payload.purpose==='fidelity_check')return {checkRef:input.payload.checkRef,auditProtocol:'sparse-defects-v1',issues:[]};inputs.push(input.payload);return {kind:'discussion',text:'合成检索夹具：本轮已处理，不生成候选。',replyDisposition:'wait'};}});t.after(()=>{controller.close();store.close();});
 controller.updateStatus({phase:'ready',account:{uid:scope.accountUid,uin:scope.accountUin}});controller.scope={...scope};store.setGoal(scope,'希望和她发展双方愿意的恋爱关系');
 store.add(scope,[msg(7001,true,'我在合成乙城找到工作。'),msg(7002,false,'工作地点离你常住地多远？',{msgTime:String(Number(raw().msgTime)+1)})]);
 const note=store.saveNote(scope,{text:'我常住在合成甲城，合成乙城的工作地点在两百公里外。',use:'discussion'});
 for(const text of ['整理了桌面','学了一段吉他','买了一本书','做了一道菜'])store.saveNote(scope,{text,use:'discussion'});
 await controller.suggest();const p=inputs.at(-1);assert.ok(p.sources.some(s=>s.id===`note:${note.id}`),'current question must contribute to initial retrieval');
 assert.equal(p.taskContext.responsePreference,'自然一点，贴近我的说话方式');assert.equal(p.taskContext.requestOrigin,'qq_observation');assert.match(p.userRequest.text,/当前|QQ|回应/);
});
test('current task carries actual exchange position without a mandatory wait policy',t=>{
 const f=setup(t,{text:'我还想分享刚学会做的那道菜',records:[msg(8001,false,'这款游戏太占空间了'),msg(8002,true,'我也有抽歪的时候'),msg(8003,true,'我找到工作了')]});const p=buildContext(f.args).payload;
 assert.equal(p.taskContext.latestActual.sourceId,'qq:8003');assert.equal(p.taskContext.latestActual.direction,'outgoing');assert.deepEqual(p.taskContext.selfMessagesAfterLastContact,['qq:8002','qq:8003']);
 assert.ok(p.taskContext.recentExchange.some(x=>x.sourceId==='qq:8001'&&p.sources.find(s=>s.id===x.sourceId)?.text==='这款游戏太占空间了'));assert.ok(p.taskContext.selfEvidenceSourceIds.includes('qq:8003'));assert.equal(p.taskContext.mustWait,undefined);assert.equal(Object.keys(p).at(-1),'userRequest');
});
test('recent private discussion references canonical user text with source, time and request association',t=>{
 const f=setup(t);const older=f.store.appendTurn(scope,{role:'user',kind:'discussion',text:'表达含蓄些，暂时不邀请',requestId:'synthetic-old-request'});const reply=f.store.appendTurn(scope,{role:'assistant',kind:'discussion',text:'先了解她分享的内容',requestId:'synthetic-old-request'});const current=f.store.appendTurn(scope,{role:'user',kind:'discussion',text:'就这个方向，给完整一句',requestId:'synthetic-new-request'});
 const p=buildContext({...f.args,turn:current,companion:f.store.getCompanion(scope)}).payload;const user=p.privateConversation.find(x=>x.id===older.id),assistant=p.privateConversation.find(x=>x.id===reply.id);
 assert.equal(user.text,undefined);assert.equal(p.sources.find(s=>s.id===user.sourceId).text,older.text);assert.equal(user.sourceId,`private:${older.id}`);assert.equal(user.at,older.createdAt);assert.equal(user.requestId,'synthetic-old-request');assert.equal(assistant.at,reply.createdAt);assert.equal(assistant.requestId,'synthetic-old-request');assert.match(assistant.authority,/assistant/);
});
test('same-second QQ source order follows actual sequence rather than lexical message ID',t=>{
 const f=setup(t,{records:[msg('72057594037927940',true,'较早那句',{msgSeq:'1'}),msg('72057594037927939',false,'较晚那句',{msgSeq:'2'})]});const p=buildContext(f.args).payload,qq=p.sources.filter(s=>s.type==='qq');
 assert.deepEqual(qq.map(s=>s.id),['qq:72057594037927940','qq:72057594037927939']);assert.deepEqual(qq.map(s=>s.sequence),['1','2']);assert.equal(p.taskContext.latestActual.sourceId,'qq:72057594037927939');
});
test('latest reply includes its available actual quote target with scoped metadata',t=>{
 const target=msg(9001,false,'我在考虑周末去逛展'),middle=Array.from({length:65},(_,i)=>msg(9002+i,i%2===0,'后来的普通消息'));
 const quoted=msg(9100,true,'听起来不错',{elements:[{replyElement:{replayMsgId:'9001',replayMsgSeq:'9001',senderUidStr:scope.peerUid,senderUin:scope.peerUin}},{textElement:{content:'听起来不错'}}]});
 const f=setup(t,{records:[target,...middle,quoted]}),p=buildContext(f.args).payload,last=p.taskContext.recentExchange.find(x=>x.sourceId==='qq:9100');
 assert.equal(last.quote.sourceId,'qq:9001');assert.equal(last.quote.availability,'available');assert.equal(last.quote.text,undefined);assert.equal(p.sources.find(s=>s.id===last.quote.sourceId).text,target.text);assert.ok(p.sources.some(s=>s.id==='qq:9001'));
});
test('quote targets excluded from evidence do not return through the current task view',t=>{
 const f=setup(t,{records:[msg(9201,false,'被移除的原文'),msg(9202,true,'接过这句',{elements:[{replyElement:{replayMsgId:'9201',replayMsgSeq:'9201',senderUidStr:scope.peerUid,senderUin:scope.peerUin}},{textElement:{content:'接过这句'}}]})]});
 const available=f.store.memorySources(scope).filter(s=>s.id!=='qq:9201');const p=buildContext({...f.args,availableSources:available}).payload;
 assert.equal(p.taskContext.recentExchange.at(-1).quote.availability,'unavailable');assert.equal(JSON.stringify(p).includes('被移除的原文'),false);
});
test('a known unavailable quote ID never resolves a different message with the same sequence and author',t=>{
 const original=msg(9301,false,'REMOVED_SYNTHETIC_TARGET',{msgSeq:'41'}),other=msg(9302,false,'Different available target',{msgSeq:'41',msgTime:String(Number(raw().msgTime)+1)});
 const reply=msg(9303,true,'Synthetic reaction',{msgSeq:'42',msgTime:String(Number(raw().msgTime)+2),elements:[{replyElement:{replayMsgId:'9301',replayMsgSeq:'41',senderUidStr:scope.peerUid,senderUin:scope.peerUin}},{textElement:{content:'Synthetic reaction'}}]});
 const f=setup(t,{records:[original,other,reply]});f.store.forgetSource(scope,'qq:9301');
 const p=buildContext({...f.args,companion:f.store.getCompanion(scope),availableSources:f.store.memorySources(scope)}).payload;
 const actualReply=p.taskContext.recentExchange.find(m=>m.sourceId==='qq:9303');
 assert.equal(actualReply.quote.availability,'unavailable');assert.equal(actualReply.quote.sourceId,undefined);assert.equal(actualReply.quote.text,undefined);
 assert.ok(p.sources.some(s=>s.id==='qq:9302'),'the other actual message is available, so the missing quote must not be replaced with it');
 assert.equal(JSON.stringify(p).includes('REMOVED_SYNTHETIC_TARGET'),false);
});
test('received native record aliases resolve by scoped sequence and time but cannot substitute a removed target',t=>{
 const at=Number(raw().msgTime),target=msg(9351,false,'Original actual quoted meaning',{msgSeq:'66',msgTime:String(at)});
 const other=msg(9352,false,'A different actual meaning',{msgSeq:'66',msgTime:String(at+1)});
 const reply=msg(9353,true,'Received native-shaped quote',{msgSeq:'67',msgTime:String(at+2),elements:[{replyElement:{replayMsgId:'0',sourceMsgIdInRecords:'72057594037929999999',replayMsgSeq:'66',senderUidStr:scope.peerUid,replyMsgTime:String(at)}},{textElement:{content:'Received native-shaped quote'}}]});
 const f=setup(t,{records:[target,other,reply]});
 const first=buildContext({...f.args,availableSources:f.store.memorySources(scope)}).payload;
 assert.equal(first.taskContext.recentExchange.find(m=>m.sourceId==='qq:9353').quote.sourceId,'qq:9351');
 assert.equal(reply.replyTo.timestamp,at*1000);assert.equal(reply.replyTo.messageId,undefined,'an embedded record alias is not a local QQ message ID');
 f.store.forgetSource(scope,'qq:9351');
 const after=buildContext({...f.args,companion:f.store.getCompanion(scope),availableSources:f.store.memorySources(scope)}).payload;
 assert.equal(after.taskContext.recentExchange.find(m=>m.sourceId==='qq:9353').quote.availability,'unavailable');
 assert.equal(JSON.stringify(after).includes(target.text),false,'a removed original cannot be reconstructed or replaced by another same-sequence message');
 f.store.add(scope,[msg(9354,false,'An available same-time collision',{msgSeq:'66',msgTime:String(at)})]);
 const collision=buildContext({...f.args,records:f.store.messages(scope),companion:f.store.getCompanion(scope),availableSources:f.store.memorySources(scope)}).payload;
 assert.equal(collision.taskContext.recentExchange.find(m=>m.sourceId==='qq:9353').quote.availability,'unavailable','excluded matching identities still participate in ambiguity detection');
 assert.equal(JSON.stringify(collision).includes(target.text),false);
});
test('an explicitly selected older quoted reply protects its available target beyond the recent window',t=>{
 const at=Number(raw().msgTime),target=msg(9401,false,'TARGET_ALPHA',{msgTime:String(at)});
 const reply=msg(9402,true,'Short reaction',{msgTime:String(at+1),elements:[{replyElement:{replayMsgId:'9401',replayMsgSeq:'9401',senderUidStr:scope.peerUid,senderUin:scope.peerUin}},{textElement:{content:'Short reaction'}}]});
 const later=Array.from({length:65},(_,i)=>msg(9500+i,i%2===0,'Later routine text',{msgTime:String(at+i+2)}));
 const f=setup(t,{text:'Please respond naturally.',records:[target,reply,...later]}),available=f.store.memorySources(scope);
 const context=buildContext({...f.args,purpose:'reply',replyMessageIds:['9402'],availableSources:available});
 assert.ok(available.some(s=>s.id==='qq:9401'));
 assert.ok(context.payload.sources.some(s=>s.id==='qq:9402'));
 assert.equal(context.payload.sources.find(s=>s.id==='qq:9401')?.text,target.text);
 assert.ok(context.essentialSourceIds.includes('qq:9401'),'an available selected quote target cannot be removed by optional budget eviction');
});
test('private turns and enabled notes have identical Store and fallback canonical source revisions',t=>{
 const f=setup(t,{text:'Synthetic request-linked private meaning'});
 const old=f.store.appendTurn(scope,{role:'user',kind:'discussion',text:'Older synthetic meaning',requestId:'synthetic-canonical-request'});
 f.store.updateTurn(scope,old.id,'Corrected synthetic meaning');
 const note=f.store.saveNote(scope,{text:'Synthetic shareable material',use:'draft',sourceIds:[`private:${old.id}`]});
 f.store.saveNote(scope,{id:note.id,text:'Corrected synthetic shareable material',use:'draft'});
 const privateNote=f.store.saveNote(scope,{text:'Synthetic private background',use:'discussion'});
 const disabled=f.store.saveNote(scope,{text:'Synthetic disabled source',use:'disabled'});
 const companion=f.store.getCompanion(scope),persisted=new Map(f.store.memorySources(scope).map(s=>[s.id,s])),fallback=new Map(sourcesFor(f.store.messages(scope),companion).map(s=>[s.id,s]));
 for(const id of [`private:${f.turn.id}`,`private:${old.id}`,`note:${note.id}`,`note:${privateNote.id}`]){
  assert.ok(persisted.has(id)&&fallback.has(id),id);assert.equal(fallback.get(id).revision,persisted.get(id).revision,id);
  assert.equal(fallback.get(id).version,persisted.get(id).version,id);assert.equal(fallback.get(id).kind,persisted.get(id).kind,id);
 }
 assert.equal(persisted.has(`note:${disabled.id}`),false);assert.equal(fallback.has(`note:${disabled.id}`),false);
});
test('budget pressure uses task text references while preserving complete quoted QQ evidence',t=>{
 const body=`${'完整合成原文。'.repeat(220)}SYNTHETIC_END`,target=msg(9701,false,body);
 const reply=msg(9702,true,'Synthetic reaction',{elements:[{replyElement:{replayMsgId:'9701',replayMsgSeq:'9701',senderUidStr:scope.peerUid,senderUin:scope.peerUin}},{textElement:{content:'Synthetic reaction'}}]});
 const f=setup(t,{records:[target,reply]}),context=buildContext({...f.args,byteBudget:10000,availableSources:f.store.memorySources(scope)}),p=context.payload;
 assert.equal(p.taskContext.sourceTextLocation,'sources');
 const byId=new Map(p.sources.map(s=>[s.id,s])),actual=p.taskContext.recentExchange.find(m=>m.sourceId==='qq:9702');
 assert.equal(byId.get('qq:9701').text,body,'the original quote body must remain complete');
 assert.equal(actual.text,undefined);assert.equal(actual.quote.text,undefined);assert.equal(actual.quote.sourceId,'qq:9701');assert.equal(actual.quote.availability,'available');
 for(const item of p.taskContext.recentExchange){assert.ok(byId.has(item.sourceId));if(item.quote?.sourceId)assert.ok(byId.has(item.quote.sourceId));}
 assert.ok(context.manifest.inputBytes<=10000);assert.equal(JSON.stringify(p).split(body).length,2,'the complete body is serialized exactly once');
});
test('restricted draft propagates late omitted-chronology authority to quoted task views without mutating preparation',t=>{
 const at=Number(raw().msgTime),target=msg(9800,false,'An old synthetic invitation.',{msgTime:String(at)});
 const between=Array.from({length:20},(_,i)=>msg(9801+i,i%2===0,'Ordinary intermediate synthetic text. '.repeat(2),{msgTime:String(at+i+1)}));
 const incoming=msg(9821,false,'The newest actual incoming.',{msgTime:String(at+21)});
 const reply=msg(9822,true,'Synthetic quoted reaction.',{msgTime:String(at+22),elements:[{replyElement:{replayMsgId:'9800',replayMsgSeq:'9800',senderUidStr:scope.peerUid,senderUin:scope.peerUin}},{textElement:{content:'Synthetic quoted reaction.'}}]});
 const f=setup(t,{text:'Synthetic current request',records:[target,...between,incoming,reply]}),prepared=buildContext({...f.args,availableSources:f.store.memorySources(scope)});
 assert.equal(prepared.payload.sources.find(s=>s.id==='qq:9800').historicalOnly,undefined,'preparation initially contains the subsequent chronology');
 const before=JSON.stringify(prepared.payload),requestMeasure=payload=>15000+Buffer.byteLength(JSON.stringify(payload),'utf8');
 const draft=buildDraftContext(prepared,withCurrentDraftControls({intent:'reply',quotes:[]},prepared.payload),{scope,companion:f.args.companion,requestId:'synthetic-narrowed-draft',settings:{model:'synthetic',assistantRequestBytes:20000},requestMeasure});
 assert.ok(draft.payload.sources.length<prepared.payload.sources.filter(s=>s.type==='qq').length,'the synthetic repair envelope must actually evict optional intermediate messages');
 const original=draft.payload.sources.find(s=>s.id==='qq:9800'),view=draft.payload.taskContext.recentExchange.find(m=>m.sourceId==='qq:9822');
 assert.equal(original.text,target.text);assert.equal(original.historicalOnly,true);assert.equal(view.quote.sourceId,original.id);assert.equal(view.quote.historicalOnly,true);assert.equal(view.quote.availability,'available');
 const delivered=new Set(draft.payload.sources.map(s=>s.id));
 for(const item of draft.payload.taskContext.recentExchange){assert.ok(delivered.has(item.sourceId));if(item.quote?.sourceId)assert.ok(delivered.has(item.quote.sourceId));}
 assert.equal(JSON.stringify(prepared.payload),before,'draft rebuilding must not strip or change the preparation evidence');
});
test('saved generation-stage and feedback lineage distinguish catalog methods from delivered full guidance',async t=>{
 const store=new Store(':memory:'),settings={anonymous:true,model:'synthetic-lineage',baseUrl:'http://fixture.invalid/v1',realChatConsent:{accountUid:scope.accountUid,peerUin:scope.peerUin,model:'synthetic-lineage',baseUrl:'http://fixture.invalid/v1'}};
 let delivered,catalog,selected;
 const controller=new Controller({store,settings,read:async()=>{throw Error('No native calls in this fixture');},assistantModel:async(_settings,input)=>{
  if(input.payload.purpose==='fidelity_check')return {checkRef:input.payload.checkRef,auditProtocol:'sparse-defects-v1',issues:[]};
  delivered=structuredClone(input.manifest.methodTrace.delivered);catalog=structuredClone(input.manifest.methodTrace.catalog);
  selected=catalog.find(m=>!delivered.some(full=>full.id===m.id));assert.ok(selected,'fixture must exercise a reported catalog-only method');
  return {kind:'discussion',text:'Synthetic current help',methodIds:[selected.id]};
 }});t.after(()=>{controller.close();store.close();});controller.updateStatus({phase:'ready',account:{uid:scope.accountUid,uin:scope.accountUin}});controller.scope={...scope};
 const answer=await controller.assist({text:'Synthetic current intent'}),artifact=store.experiences.artifact(scope,answer.artifactRef),stage=artifact.generationStages[0];
 const refs=new Map(stage.deliveredMethodRefs.map(m=>[m.methodId,m]));
 assert.equal(refs.size,stage.deliveredMethodRefs.length);assert.equal(refs.get(selected.id).guidanceLevel,'catalog');assert.equal(refs.get(selected.id).version,selected.version);
 for(const method of delivered){assert.equal(refs.get(method.id).guidanceLevel,'full_card');assert.equal(refs.get(method.id).version,method.version);}
 assert.ok(stage.reportedUsedMethodRefs.some(m=>m.methodId===selected.id&&m.version===selected.version));
 // F1: explicit artifact feedback pins its version by digest
  const feedback=store.addFeedback(scope,{text:'Synthetic local feedback',targetRef:{kind:'artifact',artifactRef:answer.artifactRef},expectedDigest:store.experiences.artifact(scope,answer.artifactRef).bodyDigest}),hydrated=store.experiences.hydrateFeedback(scope,feedback.id);
 const visible=hydrated.target.generationStages[0].deliveredMethodRefs;
 assert.equal(visible.find(m=>m.methodId===selected.id).guidanceLevel,'catalog');assert.ok(visible.every(m=>m.guidanceLevel==='catalog'),'ordinary consultation starts with neutral method navigation');
});
test('method catalog preserves all help families while only a small full guidance set is loaded',t=>{
 const f=setup(t);const context=buildContext(f.args),p=context.payload;
 assert.equal(p.methodCatalog.length,8);assert.ok(p.methodCards.length<=2);assert.ok(p.methodCatalog.some(x=>x.id==='express_interest'));assert.ok(p.methodCatalog.some(x=>x.id==='shared_activity'));
 assert.ok(context.manifest.methodTrace.catalog.length===8);assert.equal(context.manifest.methodTrace.delivered.length,p.methodCards.length);
});
test('old active topic inherits omitted private chronology without cancelling user purpose',t=>{
 // The 72-hour layer now admits all short recent turns. Use genuine raw-text
 // pressure to exercise omission instead of relying on a six-group quota.
 const f=setup(t);const old=f.store.appendTurn(scope,{role:'user',kind:'discussion',text:'想了解她的游戏，不直接邀约'});for(let i=0;i<30;i++)f.store.appendTurn(scope,{role:'user',kind:'discussion',text:`后来私下想法${i}。`.repeat(120)});const current=f.store.appendTurn(scope,{role:'user',kind:'discussion',text:'先看看现在怎么接话'});
 const topic={id:'synthetic-old-topic',version:1,lifecycle:'active',objective:'了解游戏',direction:'先接话',constraints:[],sourceIds:[`private:${old.id}`],purposeSourceIds:[`private:${old.id}`]};
 const p=buildContext({...f.args,turn:current,companion:f.store.getCompanion(scope),topicContext:{active:topic,version:1,retained:[]}}).payload;
 assert.equal(p.topicContext.active.lifecycle,'active');assert.equal(p.topicContext.active.reviewPending,true);assert.equal(p.topicContext.active.authority,'needs_review');
});
