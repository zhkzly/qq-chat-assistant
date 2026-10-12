'use strict';
// Real controller/cache; all dialogue is synthetic, including in live mode.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {Store}=require('../src/store.cjs'),{Controller}=require('../src/controller.cjs'),{assistModel}=require('../src/assistant-model.cjs');
const {assistDiscussionCompaction}=require('../src/discussion-compaction.cjs');
const {scope,raw}=require('../tests/fixtures/native.cjs');
const argv=process.argv.slice(2),opt=name=>{const i=argv.indexOf(name);return i<0?null:argv[i+1]},live=argv.includes('--live');
const file=path.resolve(opt('--out')||path.join(os.tmpdir(),`qq-compaction-goal-${live?'live':'synthetic'}.json`)),maximum=Number(opt('--max-http')||12);
if(!Number.isSafeInteger(maximum)||maximum<1||maximum>20)throw Error('Invalid HTTP cap');
let connection={baseUrl:'http://synthetic.invalid/v1',model:'synthetic',anonymous:true};
if(live){if(!opt('--settings'))throw Error('Live mode requires explicitly selected settings');const s=JSON.parse(fs.readFileSync(path.resolve(opt('--settings')),'utf8')),p=s.modelProfiles?.find(p=>p.id===s.activeModelProfileId)||s;
 connection={baseUrl:p.baseUrl,model:opt('--model')||p.model,apiKey:p.apiKey,anonymous:p.anonymous===true};}
const FIRST='现在玩的解谜是哪款呀？',SECOND='这是从跟人斗智斗勇，改成跟关卡斗智斗勇了哈哈。',PRIVATE='PRIVATE_MOTIVE_SENTINEL';
const root=path.resolve(__dirname,'..'),loaded=Object.keys(require.cache).filter(p=>p.startsWith(path.join(root,'src')+path.sep));
const hashes=()=>Object.fromEntries(loaded.map(p=>[path.relative(root,p),crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')]));
const report={evidence:live?'live_model_synthetic_private_compaction_real_controller':'synthetic_compaction_real_controller',model:connection.model,startedAt:new Date().toISOString(),codeAtStart:hashes(),maximumHttpAttempts:maximum,realChatRead:false,qqMessagesSent:0,romanticOutcomeVerified:false,requests:[],steps:[]};
let attempts=0,stage='',oldUser,oldAssistant,app,providerFailures=0;
function save(){const clean=JSON.parse(JSON.stringify({...report,httpAttempts:attempts,realHttpAttempts:live?attempts:0},(_k,v)=>typeof v==='string'&&connection.apiKey?v.split(connection.apiKey).join('[REDACTED_KEY]'):v));fs.writeFileSync(file,JSON.stringify(clean,null,2),{mode:0o600});}
function mock(p){
 if(p.purpose==='discussion_compaction'){const original=p.turns?p:p.originalInput;return {summary:'用户想先含蓄接她的游戏分享，暂不直接问名字和邀约；助手提出两种候选，第二种调侃更贴合当前方向。尚未实际发送。',reviewedTurnIds:original.turns.map(t=>t.id),quoteRefs:[{turnId:oldAssistant.id,role:'assistant',field:'text',text:FIRST},{turnId:oldAssistant.id,role:'assistant',field:'text',text:SECOND}]};}
 if(p.purpose==='draft')return {kind:'draft',text:'按当前方向给一句完整表达',suggestions:[{style:'自然',text:SECOND}]};
 if(stage==='reuse')return {kind:'review',text:'目前选的是先轻松接话，不直接问名字或邀约。候选和整理都不表示已发送。'};
 const id=p.userRequest.sourceId;return {draftPlan:{quotes:[],intent:'reply',style:'natural',askFollowup:false,guidance:{objective:{text:'自然回应她的游戏分享',sourceIds:[id]},allowedApproach:{text:'采用第二个轻松调侃方向，暂不直接追问',sourceIds:[id]},avoidances:[{text:'不问游戏名称、不直接邀约、不假装玩过',sourceIds:[id]}]}}};
}
async function transport(url,args){
 if(attempts>=maximum||providerFailures>=2)throw Error('Verification HTTP/provider cap reached');
 const request=JSON.parse(args.body),payload=JSON.parse(request.messages[1].content),entry={sequence:++attempts,stage,request};report.requests.push(entry);save();
 const response=live?await fetch(url,args):new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(mock(payload))}}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}),{status:200,headers:{'Content-Type':'application/json'}});
 entry.httpStatus=response.status;if(response.status>=500||response.status===408)providerFailures++;else providerFailures=0;
 if(response.ok)entry.response=await response.clone().json();save();return response;
}
async function step(id,fn){stage=id;const start=attempts,item={id,status:'running'};report.steps.push(item);try{await fn(item);item.status='structural_checks_passed_semantic_review_required';}catch(e){item.status='failed';item.error=e.message;}item.httpAttempts=attempts-start;save();}
async function main(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-compaction-goal-'));const store=new Store(path.join(dir,'synthetic.sqlite')),settings={...connection,auto:false};
 settings.realChatConsent={accountUid:scope.accountUid,peerUin:scope.peerUin,model:settings.model,baseUrl:settings.baseUrl};
 const controller=new Controller({store,settings,read:async c=>c==='bind'?scope:{messages:[]},assistantModel:(s,c,signal)=>assistModel(s,c,signal,transport),compactionModel:(s,p,signal)=>assistDiscussionCompaction(s,p,signal,transport)});app={store,controller};
 controller.updateStatus({phase:'ready',account:{uid:scope.accountUid,uin:scope.accountUin}});await controller.bind(scope.peerUin);
 store.setGoal(scope,'与网上认识、有好感的女生互相了解，发展双方愿意的恋爱关系。');store.saveNote(scope,{text:PRIVATE,use:'discussion'});
 oldUser=store.appendTurn(scope,{role:'user',kind:'discussion',text:`${PRIVATE}只是私下担心，不写给她。这次想含蓄接她的游戏分享，不直接问名字，不邀约。`,requestId:'synthetic-initial-purpose'});
 const sources=store.memorySources(scope),record=store.getCompanion(scope);
 const receipt=store.applyTopicPatch(scope,{operation:'create',objective:'自然回应她的游戏分享',direction:'先轻松调侃接话，再看她是否展开',constraints:['这次不直接问游戏名字','这次不直接邀约'],purposeSourceIds:[`private:${oldUser.id}`],intentQuote:oldUser.text,interpretationStatus:'user_stated'},
 {baseRevision:record.revision,baseTopicVersion:record.topics.version,currentSourceId:`private:${oldUser.id}`,requestId:oldUser.requestId,origin:'private_discussion',sourceIds:sources.map(s=>s.id),sourceRevisions:Object.fromEntries(sources.map(s=>[s.id,s.revision]))});assert.equal(receipt.applied,true,receipt.detail||receipt.reason);
 oldAssistant=store.appendTurn(scope,{role:'assistant',kind:'discussion',text:'这是一段关于表达分寸的重复解释，不是实际交流。'.repeat(220)+`\n第一种候选：${FIRST}\n第二种候选：${SECOND}`,sourceIds:[`private:${oldUser.id}`]});
 assert.ok(oldAssistant.text.length<=6000);
 controller.live({scope,messages:[raw('90071992547409932101',false,{elements:[{textElement:{content:'最近不打对战了，改玩解谜闯关。'}}]})]});
 await step('compact-and-draft',async item=>{
  const answer=await controller.assist({text:'按刚才第二个方向给一条完整表达。这次不直接问游戏名字、不邀约，也不要分析。',purpose:'draft',taskId:'live-compact-draft'});
  assert.ok(answer?.suggestions?.length);const compactions=report.requests.filter(r=>JSON.parse(r.request.messages[1].content).purpose==='discussion_compaction');assert.ok(compactions.length>=1);
  const draftRequests=report.requests.filter(r=>JSON.parse(r.request.messages[1].content).purpose==='draft');assert.ok(draftRequests.length);
  for(const r of draftRequests){assert.equal(r.request.messages[1].content.includes(PRIVATE),false);const p=JSON.parse(r.request.messages[1].content);assert.equal(p.discussionCompaction,undefined);assert.equal(p.privateConversation,undefined);}
  assert.equal(store.getCompanion(scope).turns.find(t=>t.id===oldAssistant.id).text,oldAssistant.text);
  item.answer=answer;item.topic=store.topicView(scope).active;item.compaction=controller.snapshot().discussionCompaction;
 });
 if(report.steps[0].status!=='failed')await step('reuse',async item=>{
  const previous=report.requests.filter(r=>JSON.parse(r.request.messages[1].content).purpose==='discussion_compaction').length;
  item.answer=await controller.assist({text:'我们刚才选的方向和这次的限制是什么？先不要写新的句子。',purpose:'review',taskId:'live-compact-reuse'});
  assert.ok(item.answer);assert.equal(report.requests.filter(r=>JSON.parse(r.request.messages[1].content).purpose==='discussion_compaction').length,previous,'the next short follow-up must reuse the cache');
  item.compaction=controller.snapshot().discussionCompaction;
 });
 report.taskUsage=controller.snapshot().requestUsage;report.noBudgetExceeded=report.taskUsage.every(t=>t.attempts<=t.limit);
 controller.close();store.close();report.codeAtEnd=hashes();report.runtimeCodeUnchanged=JSON.stringify(report.codeAtStart)===JSON.stringify(report.codeAtEnd);report.finishedAt=new Date().toISOString();save();
 console.log(JSON.stringify({report:file,realHttpAttempts:live?attempts:0,steps:report.steps.map(s=>({id:s.id,status:s.status,httpAttempts:s.httpAttempts})),noBudgetExceeded:report.noBudgetExceeded}));
 if(report.steps.some(s=>s.status==='failed'))process.exitCode=1;
}
main().catch(error=>{report.error=error.message;app?.controller.close();app?.store.close();save();console.error(error.name+': '+error.message);process.exitCode=1});
