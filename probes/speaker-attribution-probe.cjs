'use strict';
// Deterministic probe: rebuild the reported user scenario and dump every
// attribution-bearing field along ingestion -> source snapshot -> model wire
// -> memory wire. Read-only; asserts nothing about model output quality.
const {Store}=require('../src/store.cjs');
const {normalize}=require('../src/messages.cjs');
const {buildContext}=require('../src/assistant-context.cjs');
const {prepareAssistantRequest}=require('../src/assistant-model.cjs');
const {prepareMemoryRequest}=require('../src/memory-engine.cjs');
const {scope,raw}=require('../tests/fixtures/native.cjs');

const herBusy=normalize(raw('9001',false,{msgTime:'1791726000',msgSeq:'9001',elements:[{elementType:1,textElement:{content:'这周一直在赶项目，事情特别多'}}]}),scope);
const userRest=normalize(raw('9002',true,{msgTime:'1791726060',msgSeq:'9002',elements:[{elementType:1,textElement:{content:'注意休息，别太累了'}}]}),scope);
const store=new Store(':memory:');
store.setGoal(scope,'PRIVATE_GOAL_发展双方愿意的恋爱关系');
store.add(scope,[herBusy,userRest]);
// The reported scenario: the USER tells the assistant about the user's OWN stress.
const turn=store.appendTurn(scope,{role:'user',kind:'discussion',text:'我最近压力很大，想找机会跟她聊聊我的近况，怎么开口比较好'});
const context=buildContext({scope,records:store.messages(scope),companion:store.getCompanion(scope),turn,purpose:'discussion',coverage:{status:'partial'},availableSources:store.memorySources(scope),asOf:'2026-10-16T08:00:00Z',viewerTimeZone:'Asia/ShangShai'.replace('Shai','hai'),invocation:{origin:'user',trigger:'private_request',requestedPurpose:'discussion'}});
const p=context.payload;
console.log('=== payload.sources (context layer) ===');
for(const s of p.sources)console.log(JSON.stringify({id:s.id,type:s.type,role:s.role,direction:s.direction,speaker:s.speaker,kind:s.kind,text:s.text.slice(0,40)}));
console.log('userRequest.sourceId=',p.userRequest.sourceId);
console.log('taskContext.selfEvidenceSourceIds=',JSON.stringify(p.taskContext?.selfEvidenceSourceIds||p.sources.filter(s=>s.type==='private').map(s=>s.id)));

console.log('\n=== model wire (composer view the LLM sees) ===');
const settings={model:'synthetic-probe',baseUrl:'http://fixture.invalid/v1',anonymous:true};
const prepared=prepareAssistantRequest(settings,p);
const wire=JSON.parse(prepared.request.messages[1].content);
const wireSources=(wire.originalInput||wire).sources||[];
for(const s of wireSources)console.log(JSON.stringify({handle:s.id,type:s.type,role:s.role,direction:s.direction,speaker:s.speaker,author:s.author,kind:s.kind,text:(s.text||'').slice(0,40)}));
const wireTask=(wire.originalInput||wire).taskContext;
if(wireTask)console.log('wire taskContext.selfEvidenceSourceIds=',JSON.stringify(wireTask.selfEvidenceSourceIds));

console.log('\n=== memory wire ===');
const batch=store.memoryBatch(scope);
const memReq=prepareMemoryRequest(settings,batch);
const mem=JSON.parse(memReq.serialized?memReq.serialized.body??memReq.serialized:JSON.stringify(memReq));
const memPayload=JSON.parse(mem.messages[1].content);
for(const s of memPayload.sources)console.log(JSON.stringify({handle:s.id,type:s.type,role:s.role,direction:s.direction,speaker:s.speaker,author:s.author,kind:s.kind,text:(s.text||'').slice(0,40)}));
store.close();
