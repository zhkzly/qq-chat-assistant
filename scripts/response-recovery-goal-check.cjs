'use strict';
// All dialogue and storage are synthetic. Mixed probes deliberately inject a
// source-shaped bad carrier before checking one real recovery response.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {Store}=require('../src/store.cjs'),{Controller}=require('../src/controller.cjs'),{assistModel}=require('../src/assistant-model.cjs');
const {scope,raw}=require('../tests/fixtures/native.cjs');
const args=process.argv.slice(2),arg=name=>args[args.indexOf(name)+1],live=args.includes('--live');
const output=path.resolve(args.includes('--out')?arg('--out'):path.join(os.tmpdir(),'qq-response-recovery-goal.json'));
let provider={model:'synthetic',baseUrl:'http://fixture.invalid/v1',anonymous:true};
if(live){if(!args.includes('--settings'))throw Error('Live mode needs explicit selected settings');const settings=JSON.parse(fs.readFileSync(path.resolve(arg('--settings'))));const selected=settings.modelProfiles?.find(p=>p.id===settings.activeModelProfileId)||settings;provider={model:args.includes('--model')?arg('--model'):selected.model,baseUrl:selected.baseUrl,apiKey:selected.apiKey,anonymous:selected.anonymous===true};}
const maximum=Number(args.includes('--max-http')?arg('--max-http'):8);if(!Number.isSafeInteger(maximum)||maximum<1||maximum>12)throw Error('Invalid HTTP bound');
const root=path.resolve(__dirname,'..'),loaded=Object.keys(require.cache).filter(p=>p.startsWith(path.join(root,'src')+path.sep));
const hashes=()=>Object.fromEntries(loaded.map(p=>[path.relative(root,p),crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')]));
const report={evidence:live?'mixed_injected_fault_and_live_model_synthetic_real_controller':'synthetic_recovery_real_controller',model:provider.model,endpoint:provider.baseUrl,startedAt:new Date().toISOString(),codeAtStart:hashes(),realChatRead:false,qqMessagesSent:0,relationshipOutcomeVerified:false,requests:[],steps:[]};
let phase='',count=0,real=0,errors=0,store,controller;
function save(){fs.writeFileSync(output,JSON.stringify({...report,transportAttempts:count,realHttpAttempts:real},(_k,v)=>typeof v==='string'&&provider.apiKey?v.split(provider.apiKey).join('[REDACTED]'):v,2),{mode:0o600});}
function injected(payload){
 if(phase==='private-fault'&&!payload.purpose.startsWith('plain_'))return {kind:'discussion',text:'This first response must not be delivered.',topicPatch:{operation:'update',version:1}};
 if(phase==='draft-fault'&&payload.purpose==='draft_prepare'){
  const id=payload.intentAuthority?.sourceId||payload.userRequest.sourceId,control=text=>({text,sourceIds:[id]});
  return {draftPlan:{quotes:[],intent:'reply',askFollowup:false,guidance:{objective:control('接住她的游戏分享'),allowedApproach:control('用与人较量到解关卡的轻松反差，不评价她'),avoidances:[control('不问名字、不邀约、不假装玩过')]}}};
 }
 if(phase==='draft-fault'&&payload.purpose==='draft')return '{broken synthetic draft JSON';
 return null;
}
function mock(payload){if(payload.purpose==='plain_draft_recovery')return '哈哈，这是从跟人斗智斗勇，换成跟关卡斗智斗勇了。';if(payload.purpose==='plain_help_recovery')return '先接住她换游戏的分享，用人与关卡的反差轻松聊一句，这次不问名字、不邀约。';return {kind:'review',text:'这次先轻松接游戏的变化，不问名字、不邀约；参考话语仍未实际发送。'};}
async function transport(url,options){
 if(count>=maximum||errors>=2)throw Error('Verification transport bound reached');
 const request=JSON.parse(options.body),content=Array.isArray(request.messages[1].content)?request.messages[1].content[0].text:request.messages[1].content,payload=JSON.parse(content),fault=injected(payload);
 const useReal=live&&fault===null,entry={sequence:++count,phase,purpose:payload.purpose,carrier:useReal?'real_model':'injected_or_synthetic',request};report.requests.push(entry);if(useReal)real++;save();
 const response=useReal?await fetch(url,options):new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:typeof(fault??mock(payload))==='string'?(fault??mock(payload)):JSON.stringify(fault??mock(payload))}}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}),{status:200,headers:{'Content-Type':'application/json'}});
 entry.httpStatus=response.status;if(response.status>=500||response.status===408)errors++;else errors=0;
 if(response.ok)entry.response=await response.clone().json();save();return response;
}
async function step(name,text,purpose,checks){phase=name;const item={id:name,status:'running',checks:[]};report.steps.push(item);const before=count,beforeReal=real;
 try{const reply=await controller.assist({text,purpose,taskId:'synthetic-'+name});item.answer=reply;for(const [label,check]of checks){check(reply);item.checks.push(label);}item.status='structural_checks_passed_semantic_review_required';}
 catch(error){item.status='failed';item.error=error.message;}
 item.transportAttempts=count-before;item.realHttpAttempts=real-beforeReal;save();
}
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-response-recovery-'));store=new Store(path.join(dir,'synthetic.sqlite'));const settings={...provider,auto:false};settings.realChatConsent={accountUid:scope.accountUid,peerUin:scope.peerUin,model:provider.model,baseUrl:provider.baseUrl};
 controller=new Controller({store,settings,read:async name=>name==='bind'?scope:{messages:[]},assistantModel:(s,c,signal)=>assistModel(s,c,signal,transport)});
 controller.updateStatus({phase:'ready',account:{uid:scope.accountUid,uin:scope.accountUin}});await controller.bind(scope.peerUin);
 store.setGoal(scope,'与网上认识、有好感的女生互相了解，发展双方愿意的恋爱关系。');store.saveNote(scope,{text:'PRIVATE_MOTIVE_SENTINEL 私下担心，不能写给她。',use:'discussion'});
 const source=store.appendTurn(scope,{role:'user',kind:'discussion',requestId:'synthetic-seed',text:'这次先轻松接她换游戏的分享，用人与关卡的反差，不问名字、不邀约。'}),refs=store.memorySources(scope),sid='private:'+source.id;
 assert.equal(store.applyTopicPatch(scope,{operation:'create',objective:'接住游戏分享',direction:'人与关卡的轻松反差',constraints:['这次不问名字','这次不邀约'],purposeSourceIds:[sid],intentQuote:source.text,interpretationStatus:'user_stated'},{baseRevision:store.getCompanion(scope).revision,baseTopicVersion:0,currentSourceId:sid,requestId:'synthetic-seed',origin:'private_discussion',sourceIds:refs.map(s=>s.id),sourceRevisions:Object.fromEntries(refs.map(s=>[s.id,s.revision]))}).applied,true);
 controller.live({scope,messages:[raw('90071992547409999001',false,{elements:[{textElement:{content:'我最近不打对战了，改玩解谜闯关。'}}]})]});
 const originalTopic=JSON.stringify(store.topicView(scope).active);
 await step('private-fault','怎么继续','discussion',[
  ['delivered private help is program-marked and has no draft controls',r=>{assert.equal(r.responseRecovery?.kind,'private_help');assert.equal((r.suggestions||[]).length,0);assert.ok(r.text.trim());}],
  ['bad topic output did not change the active direction',()=>assert.equal(JSON.stringify(store.topicView(scope).active),originalTopic)],
  ['both primary and recovery stages are recorded',()=>{const run=store.getCompanion(scope).runs.at(-1);assert.equal(run.requests.length,2);assert.equal(run.maintenance,'deferred');}]
 ]);
 if(report.steps.at(-1).status!=='failed')await step('draft-fault','用与人较量改成解关卡的温和反差接她的话，给一句完整的，不问名字、不邀约。','draft',[
  ['verified preparation permits only a restricted full editable expression',r=>{assert.equal(r.kind,'draft');assert.equal(r.responseRecovery?.kind,'restricted_draft');assert.equal(r.suggestions.length,1);}],
  ['final recovery has no raw private goal, history or sentinel',()=>{const entry=report.requests.find(r=>r.purpose==='plain_draft_recovery'),p=JSON.parse(entry.request.messages[1].content).originalInput;for(const key of ['goal','privateConversation','topicContext','workingState','pendingPrivateReview'])assert.equal(p[key],undefined);assert.equal(JSON.stringify(entry.request).includes('PRIVATE_MOTIVE_SENTINEL'),false);}]
 ]);
 if(report.steps.at(-1).status!=='failed')await step('fully-real-review','我们刚才商量的方向和这次的限制是什么？先不写新的句子。','review',[
  ['readable review stays private and retains originals',r=>{assert.ok(r.text);assert.equal((r.suggestions||[]).length,0);assert.equal(store.getCompanion(scope).turns.find(t=>t.id===source.id).text,source.text);}]
 ]);
 report.taskUsage=controller.usage.recent(scope,10).map(t=>({status:t.status,attempts:t.attempts,limit:t.limit}));report.noBudgetExceeded=report.taskUsage.every(t=>t.attempts<=t.limit);
 controller.close();store.close();report.codeAtEnd=hashes();report.runtimeCodeUnchanged=JSON.stringify(report.codeAtStart)===JSON.stringify(report.codeAtEnd);report.finishedAt=new Date().toISOString();save();
 console.log(JSON.stringify({report:output,realHttpAttempts:real,transportAttempts:count,noBudgetExceeded:report.noBudgetExceeded,steps:report.steps.map(s=>({id:s.id,status:s.status,realHttpAttempts:s.realHttpAttempts}))}));if(report.steps.some(s=>s.status==='failed'))process.exitCode=1;
})().catch(e=>{report.error=e.message;controller?.close();store?.close();save();console.error(e.name+': '+e.message);process.exitCode=1;});
