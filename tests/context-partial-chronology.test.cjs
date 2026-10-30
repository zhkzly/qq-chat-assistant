'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {Store}=require('../src/store.cjs');
const {buildContext}=require('../src/assistant-context.cjs');
const {resolveDraftMaterial}=require('../src/context/draft-material.cjs');
const {boundedSourceView}=require('../src/context/source-delivery.cjs');
const {normalize}=require('../src/messages.cjs');
const {scope,raw}=require('./fixtures/native.cjs');

// Fictional persisted inputs exercise the actual compiler-to-material-resolver
// boundary. The withdrawal is intentionally outside the delivered prefix.
test('a later partial private read cannot make an old full permission appear current',t=>{
 const store=new Store(':memory:');t.after(()=>store.close());
 const grant=store.appendTurn(scope,{role:'user',kind:'discussion',text:'My ceramic cup is ready. I want to tell this friend about my ceramic cup.'});
 const later=store.appendTurn(scope,{role:'user',kind:'discussion',text:'Other background. '+'x'.repeat(20000)+' I withdraw the permission: do not tell this friend about my ceramic cup.'});
 const current=store.appendTurn(scope,{role:'user',kind:'discussion',text:'Help me choose what to share.'});
 const sources=store.memorySources(scope),grantId=`private:${grant.id}`,laterId=`private:${later.id}`,span=boundedSourceView(sources.find(source=>source.id===laterId),{offset:0,maxChars:100,maxBytes:3000});
 const options={scope,records:[],companion:store.getCompanion(scope),turn:current,purpose:'discussion',requestId:'fictional-partial-private',byteBudget:48000,
  settings:{model:'synthetic',assistantRequestBytes:64000},availableSources:sources,retrievedSources:[{id:grantId},span]};
 const context=buildContext(options),permission=context.payload.sources.find(source=>source.id===grantId),partial=context.payload.sources.find(source=>source.id===laterId);
 assert.equal(permission.text,grant.text);assert.equal(permission.delivery,undefined);assert.equal(partial.delivery.status,'partial');assert.equal(partial.text,later.text.slice(0,100));
 assert.equal(JSON.stringify(context.payload).includes('I withdraw the permission'),false,'the tail is not delivered through another view');
 assert.equal(partial.historicalOnly,undefined,'own partial coverage is a body omission, not a missing later event');
 const currentSource=context.payload.sources.find(source=>source.id===`private:${current.id}`);assert.equal(currentSource.text,current.text);assert.equal(currentSource.delivery,undefined);
 const quote={sourceId:grantId,text:'My ceramic cup is ready.',authorization:{permission:{sourceId:grantId,text:'I want to tell this friend about my ceramic cup.'},referent:{sourceId:grantId,text:'My ceramic cup is ready.'}}};
 assert.throws(()=>resolveDraftMaterial(context.payload,{quotes:[quote]}),/后续私下来源未完整提供/);
 assert.equal(permission.historicalOnly,true,'a selected source ID does not prove that its complete later body was read');
 // A new, full current user instruction is a separate authority. This test
 // does not ask the resolver to interpret withdrawal language or waive a gap.
 const fresh=store.appendTurn(scope,{role:'user',kind:'discussion',text:'I now explicitly want to tell this friend about my ceramic cup.'}),freshId=`private:${fresh.id}`;
 const renewed=buildContext({...options,turn:fresh,companion:store.getCompanion(scope),availableSources:store.memorySources(scope)});
 const authorized={...quote,authorization:{...quote.authorization,permission:{sourceId:freshId,text:fresh.text}}};
 assert.equal(renewed.payload.sources.find(source=>source.id===freshId).text,fresh.text);assert.equal(renewed.payload.sources.find(source=>source.id===freshId).delivery,undefined);
 assert.equal(resolveDraftMaterial(renewed.payload,{quotes:[authorized]}).bindings[0].permission.sourceId,freshId);
});

test('a later partial QQ read makes earlier QQ evidence historical without date-mislabeling the partial message',t=>{
 const store=new Store(':memory:');t.after(()=>store.close());
 const stamp=Math.floor(Date.now()/1000)-10;
 const message=(id,text,index)=>normalize(raw(id,index===0,{msgTime:String(stamp+index),elements:[{textElement:{content:text}}]}),scope);
 const old=message('900719925474099899','We planned a ceramic workshop together.',0),later=message('900719925474099900','Other actual updates. '+'q'.repeat(20000)+' The workshop plan is cancelled.',1);
 store.add(scope,[old,later]);const current=store.appendTurn(scope,{role:'user',kind:'discussion',text:'Help me understand the current exchange.'}),sources=store.memorySources(scope),laterId=`qq:${later.messageId}`;
 const span=boundedSourceView(sources.find(source=>source.id===laterId),{offset:0,maxChars:100,maxBytes:3000});
 const context=buildContext({scope,records:store.messages(scope),companion:store.getCompanion(scope),turn:current,purpose:'discussion',requestId:'fictional-partial-qq',byteBudget:48000,
  settings:{model:'synthetic',assistantRequestBytes:64000},availableSources:sources,retrievedSources:[{id:`qq:${old.messageId}`},span]});
 const earlier=context.payload.sources.find(source=>source.id===`qq:${old.messageId}`),partial=context.payload.sources.find(source=>source.id===laterId);
 assert.equal(partial.delivery.status,'partial');assert.equal(partial.text,later.text.slice(0,100));assert.equal(JSON.stringify(context.payload).includes('workshop plan is cancelled'),false);
 assert.equal(earlier.historicalOnly,true);assert.equal(partial.historicalOnly,undefined);assert.equal(partial.continuationCoverage,'source_body_partial');
 assert.equal(earlier.messageId,old.messageId);assert.equal(partial.messageId,later.messageId);
 assert.equal(context.payload.taskContext.recentExchange.find(item=>item.sourceId===earlier.id).historicalOnly,true);
});
