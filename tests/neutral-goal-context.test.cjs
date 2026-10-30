'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {Store}=require('../src/store.cjs'),{buildContext}=require('../src/assistant-context.cjs'),{prepareAssistantRequest}=require('./fixtures/assistant-protocol.cjs');
const {scope}=require('./fixtures/native.cjs');
const {responseEnvelope}=require('../src/model-response-format.cjs');
for(const [purpose,goal,text]of [['discussion','与同事明确工作交接，减少遗漏。','帮我说明交接清单的安排。'],['review','作为普通朋友交流观展经历。','回顾之前提过的展览和未确认事项。']])test(`actual ${purpose} payload follows the user purpose without an imposed romantic method`,t=>{
 const store=new Store(':memory:');t.after(()=>store.close());store.setGoal(scope,goal);
 const turn=store.appendTurn(scope,{role:'user',kind:'discussion',text});const context=buildContext({scope,records:[],companion:store.getCompanion(scope),turn,purpose,availableSources:store.memorySources(scope),settings:{model:'synthetic'}});
 const packet=prepareAssistantRequest({model:'synthetic'},context.payload),p=packet.payload;
 assert.equal(p.goal,goal);assert.equal(p.workingState.ownership,'evidence_only_task_controls_in_topicContext');
 for(const key of ['focus','openThreads','unknowns'])assert.equal(p.workingState[key],undefined);
 const schema=responseEnvelope({modelResponseMode:'result_tool'},purpose,p).tools[0].function.parameters.properties.statePatch;assert.deepEqual(Object.keys(schema.properties),['items']);assert.ok(!/恋爱发展|浪漫方向/.test(p.method));assert.ok(!p.methodCards.some(card=>card.id==='express_interest'));
 assert.ok(!packet.request.messages[0].content.startsWith('你是用户私下商量真实恋爱关系发展的助手'));
 if(purpose==='review')assert.ok(!/恋爱|浪漫/.test(p.methodCards.find(card=>card.id==='review').instruction));
 assert.equal(p.sources.find(source=>source.id===p.userRequest.sourceId).text,text);
});
