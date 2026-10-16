'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {buildMaterialView}=require('../src/conversation-materials.cjs');
const at='2026-10-16T12:00:00.000Z';
const incoming={id:'qq:100',type:'qq',direction:'incoming',text:'今天给小书架装好了最后一层',at};
const outgoing={id:'qq:101',type:'qq',direction:'outgoing',text:'终于装好啦',at};
const taskContext={latestActual:{sourceId:outgoing.id},recentExchange:[incoming,outgoing].map(s=>({sourceId:s.id,direction:s.direction}))};
test('materials distinguish current exchange, already expressed user content and authorized self material',()=>{
 const note={id:'note:n',type:'note',use:'draft',text:'周末自己做了个木头杯垫',at};
 const privateReason={id:'private:x',type:'private',role:'user',text:'PRIVATE_REASON_想借机亲近',at};
 const control={id:'note:style',type:'note',kind:'preference',text:'以后用短句',at};
 const view=buildMaterialView({sources:[incoming,outgoing,note,privateReason,control],taskContext,allowedMaterialIds:[note.id],asOf:at});
 assert.ok(view.items.some(x=>x.kind==='current_exchange'&&x.sourceIds.includes(incoming.id)));
 assert.ok(view.items.some(x=>x.kind==='already_expressed'&&x.sourceIds.includes(outgoing.id)));
 assert.ok(view.items.some(x=>x.kind==='authorized_self_material'&&x.sourceIds.includes(note.id)));
 assert.equal(JSON.stringify(view).includes('PRIVATE_REASON_'),false);
 assert.equal(view.items.some(x=>x.sourceIds.includes(privateReason.id)||x.sourceIds.includes(control.id)),false);
 assert.ok(view.items.every(x=>x.novelty==='not_determined'),'only the planner judges repetition from actual evidence');
});
test('an old grounded statement remains a dated anchor rather than a current job or intent',()=>{
 const old={...incoming,id:'qq:old',at:'2026-08-01T12:00:00.000Z',text:'我当时在合成书店帮忙',historicalOnly:true};
 const view=buildMaterialView({sources:[incoming,old],taskContext,asOf:at,coreMemory:{items:[{id:'fact:old',text:old.text,sourceIds:[old.id],at:old.at}]}});
 const item=view.items.find(x=>x.kind==='historical_anchor');assert.ok(item);
 assert.equal(item.currentStatus,'unknown');assert.equal(item.at,old.at);assert.equal(item.availableAs,'historical_reference');
 assert.equal(view.items.some(x=>x.sourceIds.includes(old.id)&&x.kind==='current_exchange'),false);
 assert.equal(JSON.stringify(view).includes('supported_romantic_interest'),false);
});
test('material references stay inside selected usable sources and are bounded without rewriting messages',()=>{
 const sources=Array.from({length:70},(_,i)=>({...incoming,id:`qq:${i}`,text:`近期真实分享${i}`}));
 const before=JSON.stringify(sources);const view=buildMaterialView({sources:[...sources,{...incoming,id:'qq:withdrawn',excluded:true}],taskContext:{recentExchange:[]},asOf:at,maxItems:8});
 assert.ok(view.items.length<=8);assert.ok(view.items.every(x=>x.sourceIds.every(id=>sources.some(s=>s.id===id))));
 assert.equal(JSON.stringify(sources),before);assert.equal(view.items.some(x=>x.sourceIds.includes('qq:withdrawn')),false);
});
test('the current work controls focus navigation without exposing private intent as a talking fact',()=>{
 const request={id:'private:request',type:'private',role:'user',text:'PRIVATE_INTENT_先不要那么直接',at};
 const view=buildMaterialView({sources:[incoming,request],taskContext:{...taskContext,consultationTask:{focusOrigin:'explicit_selection'}},
  work:{request:{sourceId:request.id,trigger:'private_request'},focus:{sourceIds:[incoming.id]}},asOf:at});
 assert.equal(view.currentIntent.sourceId,request.id);
 assert.ok(view.items.some(item=>item.kind==='selected_focus'&&item.sourceIds.includes(incoming.id)));
 assert.equal(view.items.some(item=>item.sourceIds.includes(request.id)),false);
 assert.equal(JSON.stringify(view).includes('PRIVATE_INTENT_'),false);
});
