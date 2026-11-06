'use strict';
const {factualReview}=require('./fixtures/factual-assessment.cjs');
// Fictional production-parser/controller/body-projection checks only. These do
// not judge whether a model's explanation is semantically nonduplicative.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{createHash}=require('node:crypto');
const {parseAssistant}=require('../src/assistant-model.cjs');
const {blockerRenderingWitness}=require('../src/request-delivery.cjs');
const {projectVisibleTurn}=require('../scripts/eval-qq-adapter.cjs');
const {Controller}=require('./fixtures/whole-answer-fidelity.cjs'),{Store}=require('../src/store.cjs');
const {scope,raw}=require('./fixtures/native.cjs');
const CURRENT='private:clarifier-current',HUMAN='请先核对真正缺少的信息，再帮我组织表达。';
const QUESTION='你这次愿意向她分享哪件具体的小事？',WHY='需要先确认这次希望分享的具体事情。';
const OLD='LEGACY_UNTYPED_PARAPHRASE：所以你到底想告诉她哪一件？';
const sha=value=>createHash('sha256').update(value).digest('hex');
const uiSource=fs.readFileSync(path.resolve(__dirname,'../ui/app.js'),'utf8');
const uiBodySource=uiSource.match(/function assistantVisibleBody\(turn\)\{[^\n]*\}/)?.[0];
assert.ok(uiBodySource,'execute the actual UI body projection rather than an adapter-only substitute');
const uiBody=vm.runInNewContext(`(${uiBodySource})`);
function payload(restricted=false){return restricted?{purpose:'draft',requestDeliveryObligation:{mode:'editable_message'},sources:[],outboundQuotes:[]}:
 {purpose:'discussion',requestDeliveryPolicy:{version:1},intentAuthority:{sourceId:CURRENT},userRequest:{sourceId:CURRENT,text:HUMAN},sources:[{id:CURRENT,type:'private',role:'user',text:HUMAN,revision:'clarifier-r1'}]};}
function response(restricted=false,{explanation,text=OLD}={}){
 const blocker={kind:'missing_fact',missing:'本次希望分享的具体小事',question:QUESTION,...(explanation===undefined?{}:{explanation})};
 return {kind:'question',text,...(restricted?{deliveryBlocker:blocker}:{requestDelivery:{mode:'editable_message',sourceId:CURRENT,quote:HUMAN,blocker}})};
}
function visible(turn,expected){assert.equal(uiBody(turn),expected);assert.equal(projectVisibleTurn(turn).text,expected);}

for(const restricted of [false,true])test(`${restricted?'restricted':'primary'} blocker owns its question and keeps old untyped paraphrase only in audit evidence`,()=>{
 const rawText=JSON.stringify(response(restricted)),diagnostics={},result=parseAssistant(rawText,restricted?'draft':'discussion',payload(restricted),diagnostics);
 assert.equal(result.kind,'question');assert.equal(result.text,QUESTION);assert.equal(result.discussionExplanation,undefined);assert.equal(result.suggestions,undefined);
 visible(result,QUESTION);assert.equal(JSON.stringify(result).includes(OLD),false);
 assert.equal(diagnostics.blockerRendering.rawResponse,rawText);assert.equal(diagnostics.blockerRendering.originalText,OLD);
 assert.deepEqual(blockerRenderingWitness(diagnostics.blockerRendering),{question:QUESTION,rawResponseSha256:sha(rawText)});
});

for(const restricted of [false,true])for(const text of [OLD,QUESTION])test(`${restricted?'restricted':'primary'} explicitly typed why is retained once with the single structured question (${text===OLD?'legacy body':'question body'})`,()=>{
 const rawValue=response(restricted,{explanation:WHY,text}),before=structuredClone(rawValue),result=parseAssistant(rawValue,restricted?'draft':'discussion',payload(restricted),{}),expected=WHY+'\n\n'+QUESTION;
 assert.equal(result.text,expected);assert.equal(result.discussionExplanation,undefined);visible(result,expected);
 assert.equal(result.text.split(WHY).length-1,1);assert.equal(result.text.split(QUESTION).length-1,1);assert.equal(result.text.includes(OLD),false);assert.deepEqual(rawValue,before);
});

test('ordinary private explanations and why-followups remain readable without forced wording',()=>{
 for(const text of ['这里先说明为什么需要核对素材范围。','因为她问的是功能，不足以证明她已经用过。']){
  const result=parseAssistant({kind:'discussion',text,requestDelivery:{mode:'private_help',sourceId:CURRENT,quote:HUMAN}},'discussion',payload());
  assert.equal(result.kind,'discussion');assert.equal(result.text,text);assert.equal(result.draftPlan,undefined);assert.equal(result.suggestions,undefined);visible(result,text);
 }
});

test('a malformed explicitly typed explanation remains invalid rather than being silently promoted',()=>{
 for(const explanation of [{text:WHY},[WHY],7,'x'.repeat(1001)])assert.throws(()=>parseAssistant(response(false,{explanation}),'discussion',payload(),{}));
});

test('a semantic rejection does not replace the actual candidate with an automatic blocker',async t=>{
 const store=new Store(':memory:'),calls=[],planning='PLANNING_ONLY_PARAPHRASE：再问一遍用户要分享什么？';
 const controller=new Controller({store,compactionModel:null,settings:{anonymous:true,auto:false,baseUrl:'http://fixture.invalid/v1',model:'synthetic-clarifier-owner',assistantRequestLimit:4,discussionCompactionEnabled:false,
  realChatConsent:{...scope,baseUrl:'http://fixture.invalid/v1',model:'synthetic-clarifier-owner'}},read:async command=>command==='bind'?scope:{messages:[]},
  assistantModel:async(_settings,context)=>{calls.push(context);if(context.payload.purpose==='fidelity_check')return context.payload.candidate.suggestions.length?{checkRef:context.payload.checkRef,factual:factualReview(context.payload,{'suggestions[0].text':[{quote:context.payload.candidate.suggestions[0].text,kind:'assertion',support:'unsupported',basis:'no_support_in_supplied_evidence'}]}),verdict:'reject',issues:[{path:'suggestions[0].text',code:'unsupported_fact',quote:context.payload.candidate.suggestions[0].text,basis:'no_support_in_supplied_evidence',reason:'Scripted missing-source rejection exercises the blocker regeneration lifecycle.'}]}:{checkRef:context.payload.checkRef,auditProtocol:'sparse-defects-v1',issues:[]};if(context.fidelityRepair)return {operation:'clarify',blocker:{kind:'missing_fact',missing:'本次希望分享的具体小事',question:QUESTION,explanation:WHY}};
   const id=context.payload.intentAuthority.sourceId,current=context.payload.sources.find(source=>source.id===id),control=text=>({text,sourceIds:[id]});
   return {kind:'discussion',text:planning,answer:{privateExplanation:planning,suggestions:[{text:'昨天我完成了一个未提供来源的小项目。'}]},requestDelivery:{mode:'editable_message',sourceId:id,quote:current.text},draftPlan:{intent:'reply',quotes:[],guidance:{objective:control('回应她的实际问题'),allowedApproach:control('仅用已经核对的素材'),avoidances:[]}}};}});
 t.after(()=>{controller.close();store.close();});controller.updateStatus({phase:'ready',account:{uid:scope.accountUid,uin:scope.accountUin}});await controller.bind(scope.peerUin);
 controller.live({scope,messages:[raw('72057594049927937141',false,{elements:[{textElement:{content:'最近有什么新鲜的小事？'}}]})]});
 const answer=await controller.assist({text:HUMAN,taskId:'clarification-body-owner',purpose:'discussion'}),saved=store.getCompanion(scope).turns.find(turn=>turn.id===answer.id);
 assert.equal(calls.length,1,'primary candidate plus its fallible semantic review, no automatic blocker rewrite');assert.equal(answer.kind,'draft');assert.equal(answer.suggestions[0].text,'昨天我完成了一个未提供来源的小项目。');assert.equal(answer.semanticReview,undefined);assert.equal(calls.some(input=>input.payload.purpose==='fidelity_check'),false);assert.ok(saved);
 assert.equal(answer.suggestions[0].text.includes(QUESTION),false);assert.equal(store.messages(scope).some(message=>message.direction==='outgoing'),false);
});
