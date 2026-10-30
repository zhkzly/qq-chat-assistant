'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {discoverConversationEvidence}=require('../src/conversation-discovery.cjs');
const at='2026-10-20T12:00:00Z',asOf='2026-10-30T12:00:00Z';
const source=(n,text)=>({id:`qq:${n}`,type:'qq',direction:'incoming',role:'contact',text,at,revision:`r-${n}`});
test('a broad request can surface a stored interest beyond inventory-first fallback',()=>{
 const sources=Array.from({length:9},(_,i)=>source(i,'这是原始消息'+i));
 const records=sources.map((s,i)=>({id:'k'+i,recordType:'claim',subject:'contact',aspect:i===8?'interest':'other',text:i===8?'她说喜欢观鸟':'日期记录'+i,sourceIds:[s.id],sourceRevisions:{[s.id]:s.revision},lastEvidenceAt:at,assertionKind:'stated',epistemicStatus:'supported'}));
 const found=discoverConversationEvidence({sources,records,query:'好久没聊了，找个话题',goal:'相互了解',asOf,limit:6});
 assert.ok(found.directory.some(item=>item.id==='k8'));assert.ok(found.sourceIds.includes('qq:8'));
 assert.ok(found.directory.every(item=>item.requiresOriginalRead));assert.ok(found.directory.find(item=>item.id==='k8').authority.includes('navigation'));
});
test('withdrawn, missing and revised sources cannot support discovery records',()=>{
 const original=source('one','旧原文'),record={id:'old',recordType:'claim',text:'用户旧理解',sourceIds:[original.id],sourceRevisions:{[original.id]:'old-version'}};
 for(const sources of [[],[{...original,deleted:true}],[original]])assert.ok(!discoverConversationEvidence({sources,records:[record],asOf}).directory.some(item=>item.id==='old'));
});
test('raw discovery remains available while derived maintenance is incomplete and grants no sharing permission',()=>{
 const original={id:'private:p',type:'private',role:'user',use:'discussion',text:'这件事只在这里商量',revision:'r',at};
 const found=discoverConversationEvidence({sources:[original],records:[],query:'怎么商量',asOf});
 assert.equal(found.directory.length,1);assert.equal(found.directory[0].requiresOriginalRead,true);assert.ok(found.directory[0].authority.includes('not_disclosure_permission'));
 assert.equal(Object.hasOwn(found,'allowedMaterialIds'),false);
});
test('dated and uncertain knowledge preserves limitations in navigation instead of becoming current fact',()=>{
 const s=source(1,'之前的安排'),r={id:'maybe',recordType:'claim',text:'可能想参加',epistemicStatus:'tentative',assertionKind:'inferred',validUntil:'2026-10-22T00:00:00Z',sourceIds:[s.id],sourceRevisions:{[s.id]:s.revision},at};
 const item=discoverConversationEvidence({sources:[s],records:[r],query:'之前的安排',asOf}).directory.find(item=>item.id==='maybe');
 assert.equal(item.epistemicStatus,'tentative');assert.equal(item.assertionKind,'inferred');assert.equal(item.temporalStatus,'expired');
});

test('a later cancellation is kept alongside its matching earlier plan',()=>{
 const a=source(1,'周六一起看展'),b={...source(2,'这次不去了'),at:'2026-10-29T12:00:00Z'};
 const records=[{id:'plan',recordType:'relationship_event',activityKey:'周六看展',eventKind:'invitation',text:'约了周六看展',sourceIds:[a.id],sourceRevisions:{[a.id]:a.revision},at:a.at,lifecycle:'active'},{id:'cancel',recordType:'relationship_event',activityKey:'周六看展',eventKind:'cancellation',text:'这次不去了',sourceIds:[b.id],sourceRevisions:{[b.id]:b.revision},at:b.at,lifecycle:'cancelled'}];
 const found=discoverConversationEvidence({sources:[a,b],records,query:'周六看展怎么接',asOf,limit:4});
 assert.ok(found.directory.some(item=>item.id==='plan'));assert.ok(found.directory.some(item=>item.id==='cancel'&&item.lifecycle==='cancelled'));
});

test('anchored replies do not inject unrelated raw opportunity fallback',()=>{
 const a=source(1,'这次交接清单已经列好了'),b=source(2,'FICTIONAL_UNRELATED_OLD_海边旅游');
 const found=discoverConversationEvidence({sources:[a,b],records:[],query:'交接清单怎么确认',goal:'认识旅行伙伴',asOf,mode:'anchored'});
 assert.ok(found.sourceIds.includes(a.id));assert.ok(!found.sourceIds.includes(b.id));assert.ok(!JSON.stringify(found.directory).includes('FICTIONAL_UNRELATED_OLD_'));
});
test('long lexical source navigation points near the query instead of always to the head',()=>{
 const {focusSourceOffset}=require('../src/memory-search.cjs');const text='旧背景。'.repeat(3000)+'后来我参加了录音准备，收好了麦克风旁的纸张。';const start=focusSourceOffset(text,'录音 麦克风',{windowChars:500});
 assert.ok(start>0);assert.ok(text.slice(start,start+500).includes('录音'));assert.equal(focusSourceOffset('短原文','不匹配'),0);
});
test('case and compatibility normalization locate the original UTF16 source span',()=>{
 const {focusSourceOffset}=require('../src/memory-search.cjs'),{boundedSource,deliveredQuote}=require('../src/context/source-delivery.cjs');
 for(const [needle,query]of [['PROJECTOR','projector'],['ＰＲＯＪＥＣＴＯＲ','projector'],['cafe\u0301','café']]){
  const text='🧩 filler '.repeat(1000)+needle,start=focusSourceOffset(text,query,{windowChars:100});assert.ok(start>0);assert.ok(text.slice(start,start+100).includes(needle));
  const source=boundedSource({id:'qq:case',revision:'r',text},{start,maxChars:100,maxBytes:2000}),range=deliveredQuote(source,needle);
  assert.equal(range.start,text.indexOf(needle));assert.equal(text.slice(range.start,range.end),needle);
 }
});
test('raw private retellings identify the speaker without inventing the event subject',()=>{
 const source={id:'private:retell',type:'private',role:'user',text:'她从超市回来，说包装变了。我不在现场。',revision:'r',at};
 const item=discoverConversationEvidence({sources:[source],asOf}).directory[0];assert.equal(item.sourceSpeaker,'private_user');assert.equal(item.subject,'undetermined');
 const helper={...source,id:'private:helper',kind:'feedback_continue',text:'结合选中的反馈继续帮助。'};assert.equal(discoverConversationEvidence({sources:[helper],asOf}).directory.length,0);
});
