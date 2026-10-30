'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const root=process.env.ASSISTANT_TEST_ROOT||path.resolve(__dirname,'..');
const {parseAssistant,parseDraftGuidance}=require(path.join(root,'src/assistant-model.cjs'));
const {resolveDraftMaterial}=require(path.join(root,'src/context/draft-material.cjs'));
const {selectMethods}=require(path.join(root,'src/help-methods.cjs'));
function input(){return {purpose:'discussion',userRequest:{sourceId:'private:current',text:'这次接她的新话题。'},intentAuthority:{sourceId:'private:current'},draftMaterialPolicy:{version:1},sources:[{id:'private:current',type:'private',role:'user',text:'这次接她的新话题。',revision:'current-revision'},{id:'qq:actual',type:'qq',text:'今天拼图拼好了',revision:'qq-revision'}],topicContext:{active:{id:'task-old',version:1,lifecycle:'active',objective:'了解她的兴趣',direction:'接她的分享',constraints:['暂时不邀请'],applicability:'requires_current_request_match'},controlRefs:[{sourceId:'private:old',revision:'old-revision',fields:['objective','direction','constraints']}]},memoryIndex:[{sourceIds:['private:long']}],methodSelection:{candidates:['respond','compose','correction'],maxApplied:2}};}
const plan=(taskUse,guidance)=>({kind:'discussion',text:'给你一条参考。',draftPlan:{intent:'reply',quotes:[],...(taskUse?{taskUse}:{}),...(guidance?{guidance}:{})}});
test('source handles support bounded exact reads without a lexical query',()=>{
 const p=input(),r=parseAssistant({kind:'discussion',text:'核对这段原文。',lookup:{sourceIds:['private:long'],offset:250,maxChars:800}},'discussion',p);
 assert.deepEqual(r.lookup.sourceIds,['private:long']);assert.equal(r.lookup.offset,250);assert.equal(r.lookup.maxChars,800);
 for(const lookup of [{sourceIds:['private:unknown']},{sourceIds:['private:long'],offset:-1},{sourceIds:['private:long'],maxChars:8001},{offset:2}])assert.throws(()=>parseAssistant({lookup},'discussion',p));
});
test('a method lookup only requests cards declared in the supplied directory',()=>{
 const r=parseAssistant({lookup:{methodIds:['correction']}},'discussion',input());assert.deepEqual(r.lookup.methodIds,['correction']);
 assert.throws(()=>parseAssistant({lookup:{methodIds:['invented']}},'discussion',input()));
});
test('a retained task is not implicitly applied to a different current request',()=>{
 const p=input();assert.throws(()=>parseAssistant(plan(),p.purpose,p),/taskUse/);
 const r=parseAssistant(plan('different'),p.purpose,p);assert.equal(r.draftPlan.taskUse,'different');
});
test('grounded task controls can be referenced without loading their old raw body',()=>{
 const p=input(),control=text=>({text,sourceIds:['private:old']}),guidance={objective:control('了解兴趣'),allowedApproach:control('先接当前分享'),avoidances:[control('暂不邀请')]};
 const result=parseAssistant(plan('continue',guidance),'discussion',p);assert.deepEqual(result.draftPlan.guidance.avoidances[0].sourceIds,['private:old']);
 assert.throws(()=>parseDraftGuidance(guidance,p,{taskUse:'different'}));
 assert.throws(()=>parseAssistant({...plan('continue',guidance),draftPlan:{...plan('continue',guidance).draftPlan,quotes:[{sourceId:'private:old',text:'not delivered as material'}]}},'discussion',p),/对应|来源/);
});
test('a partial permission excerpt cannot establish complete disclosure context',()=>{
 const p=input();p.sources.push({id:'private:material',type:'private',role:'user',revision:'mat-revision',text:'今天做了个陶杯。愿意告诉她。',delivery:{status:'partial',start:0,end:15,originalCharLength:100}});
 const quote={sourceId:'private:material',text:'今天做了个陶杯',authorization:{permission:{sourceId:'private:material',text:'愿意告诉她'},referent:{sourceId:'private:material',text:'今天做了个陶杯'}}};
 assert.throws(()=>resolveDraftMaterial(p,{intent:'reply',quotes:[quote]}),/部分原文|完整许可/);
});
test('requested full method cards are loaded once while the directory remains metadata',()=>{
 const chosen=selectMethods({purpose:'discussion',methodIds:['correction']});assert.deepEqual(chosen.methods.map(m=>m.id),['correction']);
 assert.equal(chosen.operationalInstructionsLocation,'methodCards');assert.ok(chosen.catalog.every(m=>!Object.hasOwn(m,'instruction')));assert.equal(chosen.instruction,'');
});

test('broad discovery is an explicit optional read when no concrete query is known',()=>{
 const r=parseAssistant({lookup:{discover:true}},'discussion',input());assert.equal(r.lookup.discover,true);
 assert.throws(()=>parseAssistant({lookup:{discover:'yes'}},'discussion',input()));
});
test('invocation hints and local task-control commands are not user disclosure grants',()=>{
 const p=input(),old={id:'private:private-note',type:'private',role:'user',text:'仅在私下商量的事实',revision:'old'};p.sources.push(old);
 for(const permission of [{id:'request:automatic',type:'request',role:'user',text:'根据QQ提供当轮帮助',revision:'r'},{id:'private:ui-control',type:'private',role:'user',kind:'user_control',text:'结束这个本地任务',revision:'c'}]){
  p.sources.push(permission);
  const quote={sourceId:old.id,text:old.text,authorization:{permission:{sourceId:permission.id,text:permission.text},referent:{sourceId:old.id,text:old.text}}};
  assert.throws(()=>resolveDraftMaterial(p,{intent:'reply',quotes:[quote]}),/披露依据|invocation|control/);
 }
});
