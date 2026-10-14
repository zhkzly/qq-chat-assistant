'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const {Store}=require('../src/store.cjs');const {Controller}=require('../src/controller.cjs');const {normalize}=require('../src/messages.cjs');
const {replyFocusFor}=require('../src/model.cjs');const {assistModel}=require('../src/assistant-model.cjs');const {scope,raw}=require('./fixtures/native.cjs');
const {withCurrentDraftControls}=require('./fixtures/draft-controls.cjs');
const records=Array.from({length:80},(_,i)=>normalize(raw(String(72057594037927000n+BigInt(i)),i===76),scope));
const settings=()=>({apiKey:'fixture',model:'fixture',baseUrl:'http://fixture.invalid/v1',realChatConsent:{...scope,model:'fixture',baseUrl:'http://fixture.invalid/v1'}});
const plan={draftPlan:{quotes:[],intent:'reply',style:'natural'}};
const draft={kind:'draft',text:'接住她的分享',suggestions:[{style:'自然',text:'听起来今天挺忙，终于可以歇一歇啦。'}]};
function app(t,assistantModel,overrides={}) {
 const store=new Store(':memory:');store.add(scope,records);
 const controller=new Controller({store,settings:settings(),read:async command=>command==='bind'?{...scope,peerUid:'u_other'}:{messages:[],source:'fixture'},assistantModel,...overrides});controller.scope=scope;controller.auto=false;
 t.after(()=>{controller.close();store.close();});return {store,controller};
}

test('recent incoming burst is grouped and selected old targets remain in the unified bounded context',async t=>{
 assert.deepEqual(replyFocusFor(records,[]).messageIds,records.slice(-3).map(r=>r.messageId));
 let context;const {controller}=app(t,async(_,input)=>{context=input;return {kind:'discussion',text:'先接住之前提到的两个话题。'};});
 const ids=[records[0].messageId,records[1].messageId];controller.configure({instruction:'自然一点',replyMessageIds:ids});
 await controller.suggest();assert.equal(context.payload.purpose,'reply');assert.deepEqual(context.payload.replyFocus,ids);
 assert.ok(ids.every(id=>context.payload.sources.some(s=>s.id===`qq:${id}`)));assert.ok(context.manifest.inputBytes<=context.manifest.byteBudget);
 assert.throws(()=>controller.configure({replyMessageIds:['99999999999']}),/当前会话/);
});

test('changing reply focus discards a pending answer and contact binding clears focus',async t=>{
 let finish;const {controller}=app(t,()=>new Promise(r=>{finish=r;}));
 const pending=controller.suggest();await new Promise(resolve=>setImmediate(resolve));assert.equal(typeof finish,'function');controller.configure({replyMessageIds:[records[0].messageId]});finish({kind:'discussion',text:'stale'});await pending;
 assert.equal(controller.advice,null);assert.deepEqual(controller.snapshot().replyFocus.messageIds,[records[0].messageId]);
 await controller.bind(scope.peerUin);assert.deepEqual(controller.snapshot().replyFocus.messageIds,[]);
});

test('both unified model stages preserve exact selected targets as quoted data without QQ commands',async t=>{
 const inputs=[];const network=async(_,args)=>{
  const body=JSON.parse(args.body),input=JSON.parse(body.messages[1].content);inputs.push(input);
  return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify(input.purpose==='draft'?draft:{...plan,draftPlan:withCurrentDraftControls(plan.draftPlan,input)})}}]})};
 };
 const {store,controller}=app(t,(model,context,signal)=>assistModel(model,context,signal,network));
 const ids=[records[0].messageId];controller.configure({replyMessageIds:ids});const actualCount=store.messages(scope).length;
 await controller.suggest();assert.deepEqual(inputs.map(p=>p.purpose),['reply','draft']);
 for(const input of inputs){assert.deepEqual(input.replyFocus,ids);assert.ok(input.sources.some(s=>s.id===`qq:${ids[0]}`));assert.equal(input.send,undefined);assert.equal(input.command,undefined);}
 assert.equal(controller.advice.suggestions.length,1);assert.equal(store.messages(scope).length,actualCount);
 assert.equal(inputs[1].privateConversation,undefined);assert.equal(inputs[1].goal,undefined);
});

test('changing selected images invalidates a pending unified request even before another request starts',async t=>{
 let finish;const {controller}=app(t,()=>new Promise(r=>{finish=r;}));
 const pending=controller.suggest();await new Promise(resolve=>setImmediate(resolve));assert.equal(typeof finish,'function');controller.configure({images:[{messageId:records[0].messageId,index:0}]});
 finish({kind:'discussion',text:'answer from an obsolete image selection'});await pending;assert.equal(controller.advice,null);
});

function cachedImage(t) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-unified-media-')),file=path.join(dir,'one.png');
 fs.writeFileSync(file,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lP8AAAAASUVORK5CYII=','base64'));
 // Synthetic cached-image capability: replace only the QQ cache root mapping.
 // readImage still resolves and reads a real file and checks image bytes.
 const qqRoot=path.join(process.env.HOME,'.config/QQ'),realpath=fs.realpathSync,exists=fs.existsSync;
 t.mock.method(fs,'existsSync',p=>p===qqRoot?true:exists(p));
 t.mock.method(fs,'realpathSync',(p,...args)=>p===qqRoot?dir:realpath(p,...args));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return file;
}

test('authorized current-scope cached images reach both unified stages; foreign and ignored selections do not',async t=>{
 const file=cachedImage(t),calls=[];const {store,controller}=app(t,async(_,context)=>{calls.push(context);return context.payload.purpose==='draft'?draft:{...plan,draftPlan:withCurrentDraftControls(plan.draftPlan,context.payload)};});
 const id='72057594037927991',message=normalize(raw(id,false,{elements:[{picElement:{sourcePath:file,fileName:'one.png'}}]}),scope);store.add(scope,[message]);
 controller.settings.visionEnabled=true;controller.settings.realChatConsent.allowImages=true;controller.configure({images:[{messageId:id,index:0}]});
 await controller.suggest();assert.equal(calls.length,2);assert.ok(calls.every(c=>c.images.length===1&&c.images[0].messageId===id&&c.images[0].url.startsWith('data:image/png;base64,')));
 controller.configure({images:[{messageId:'72057594037927992',index:0}]});await assert.rejects(controller.suggest(),/来源已撤回或不再用于助手/);assert.equal(calls.length,2);
 controller.configure({images:[{messageId:id,index:0}]});store.forgetSource(scope,`qq:${id}`);
 await assert.rejects(controller.suggest(),/来源已撤回或不再用于助手/);assert.equal(calls.length,2);
});
