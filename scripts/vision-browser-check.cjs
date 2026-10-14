'use strict';
// Source-shaped synthetic pointer-browser checks. No QQ image or provider traffic.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {Store}=require('../src/store.cjs'),{Controller}=require('../src/controller.cjs'),{createServer}=require('../src/server.cjs');
const {scope,raw}=require('../tests/fixtures/native.cjs'),{CDP}=require('./cdp.cjs'),{actions}=require('./browser-actions.cjs');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,label){for(let n=0;n<120;n++){if(await check())return;await sleep(100);}throw Error(`Timed out: ${label}`);}

(async()=>{
 const root=path.resolve(__dirname,'..'),temporary=fs.mkdtempSync(path.join(os.tmpdir(),'qq-vision-ui-'));
 const profile=path.join(temporary,'chrome'),evidence=fs.mkdtempSync(path.join(os.tmpdir(),'qq-vision-ui-evidence-'));
 const store=new Store(':memory:'),checks=[],requests=[];
 const privateInput='先商量怎样自然接住这次分享。',unsentDraft='这份未发送草稿要保留。',unsavedGoal='这个尚未保存的关系目标要保留。';
 const pictureId='72057594037927937',otherUin='2222222222';
 const fictionalQQ=[raw(pictureId,false,{elements:[{elementType:2,picElement:{sourcePath:'/synthetic/qq/picture.png',fileName:'synthetic.png'}}]}),raw('72057594037927938',true)];
 const settings={anonymous:true,baseUrl:'http://fixture.invalid/v1',model:'synthetic-vision',auto:false,realChatConsent:{...scope,baseUrl:'http://fixture.invalid/v1',model:'synthetic-vision'}};
 const vision={autoImages:false,modelVisionEnabled:true,imageConsent:false,automaticImageConsent:false,imageCount:0,omitted:[]};
 const controller=new Controller({store,settings,read:async(command,args)=>{
  if(command==='bind')return args.uin===scope.peerUin?scope:{...scope,peerUid:'synthetic-other',peerUin:args.uin};
  return {messages:command==='latest'&&args.scope.peerUin===scope.peerUin?fictionalQQ:[],source:'synthetic-native-fixture'};
 },assistantModel:async()=>{throw Error('UI-only regression must not invoke a model');},memoryModel:null});
 // Derive each fixture from the real controller snapshot; override only the
 // new vision wire fields while the UI contract is checked independently.
 const snapshot=controller.snapshot.bind(controller);
 controller.snapshot=()=>{const value=snapshot(),same=value.scope?.peerUin===scope.peerUin,ready=same&&vision.modelVisionEnabled&&vision.imageConsent&&vision.automaticImageConsent&&vision.autoImages;
  const manual=same&&controller.selectedImages.length>0;
  return {...value,autoImages:vision.autoImages,modelVisionEnabled:vision.modelVisionEnabled,imageConsent:same&&vision.imageConsent,automaticImageConsent:same&&vision.automaticImageConsent,
   imageContext:{mode:manual?'manual':vision.autoImages?'automatic':'off',ready:manual?same&&vision.modelVisionEnabled&&vision.imageConsent:ready,reason:!vision.modelVisionEnabled?'此模型尚未确认支持图片输入':!same||!vision.imageConsent||!vision.automaticImageConsent?'尚未允许当前好友的近期图片提供给此模型':vision.autoImages?'已准备当前好友的近期相关图片':'自动图片参考已关闭',imageCount:manual?controller.selectedImages.length:ready?vision.imageCount:0,omitted:ready?vision.omitted:[],automaticEnabled:ready}};};
 controller.updateStatus({phase:'ready',account:{uid:scope.accountUid,uin:scope.accountUin}});
 const server=createServer({controller,token:'synthetic-vision-ui',uiDir:path.join(root,'ui'),saveSettings(){},modelFetch:async()=>({ok:true,json:async()=>({data:[{id:'synthetic-vision'}]})})});
 const handler=server.listeners('request')[0];server.removeAllListeners('request');
 server.on('request',(request,response)=>{
  if(request.method==='GET'&&request.url.startsWith('/api/media?')){
   requests.push({path:'/api/media',args:Object.fromEntries(new URL(request.url,'http://synthetic.invalid').searchParams)});
   response.writeHead(200,{'Content-Type':'image/png'});response.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64'));return;
  }
  if(request.method==='POST'&&['/api/options','/api/consent'].includes(request.url)){
   const chunks=[];request.on('data',chunk=>chunks.push(chunk));request.on('end',()=>{try{
    const args=JSON.parse(Buffer.concat(chunks).toString());requests.push({path:request.url,args});
    assert.deepEqual(Object.fromEntries(Object.keys(scope).map(key=>[key,args[key]])),controller.scope,'vision controls send all four captured scope IDs');
    if(request.url==='/api/options'){
     if(typeof args.autoImages==='boolean')vision.autoImages=args.autoImages;
     controller.configure({instruction:args.instruction,auto:args.auto,images:args.images,replyMessageIds:args.replyMessageIds});
    }else {
     assert.equal(args.model,settings.model);assert.equal(args.baseUrl,settings.baseUrl);
     settings.realChatConsent={...args};vision.imageConsent=args.allowImages===true;vision.automaticImageConsent=args.allowAutomaticImages===true;
    }
    response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify(controller.snapshot()));
   }catch(error){response.writeHead(400,{'Content-Type':'application/json'});response.end(JSON.stringify({error:error.message}));}});return;
  }
  handler(request,response);
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const chrome=spawn('/usr/bin/google-chrome',['--headless','--no-sandbox','--disable-gpu','--disable-background-networking','--no-first-run',`--user-data-dir=${profile}`,'--remote-debugging-port=0',`http://127.0.0.1:${server.address().port}/#synthetic-vision-ui`],{stdio:'ignore'});
 let cdp;
 try{
  await until(()=>fs.existsSync(path.join(profile,'DevToolsActivePort')),'Chrome');
  const port=Number(fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').split('\n')[0]);
  const tabs=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();cdp=await CDP.connect(tabs.find(tab=>tab.type==='page').webSocketDebuggerUrl);
  await cdp.call('Runtime.enable');await cdp.call('Page.enable');
  const ui=actions(cdp);await cdp.call('Emulation.setDeviceMetricsOverride',{width:390,height:650,deviceScaleFactor:1,mobile:false});
  await until(()=>cdp.evaluate("!!document.querySelector('#contact-button')"),'helper');
  await ui.click('#contact-button');await ui.fill('#qq-number',scope.peerUin);await ui.click('#contact-form button[type=submit]');
  await until(()=>cdp.evaluate("!!state?.scope&&!loadingHistory"),'bound helper');
  const actualQQ=structuredClone(store.messages(scope));
  await ui.click('#draft-button');await ui.fill('#draft',unsentDraft);await ui.click('#draft-close');
  await ui.workspace('background');await ui.openDetails('#goal-editor');await ui.fill('#goal-input',unsavedGoal);await ui.workspace('discussion');
  await ui.openDetails('#assistant-tools');await ui.click('#assistant-review');await ui.fill('#assistant-input',privateInput);
  const preserved=async()=>{
   assert.equal(await cdp.evaluate("document.querySelector('#assistant-input').value"),privateInput);
   assert.equal(await cdp.evaluate("document.querySelector('#draft').value"),unsentDraft);
   assert.equal(await cdp.evaluate("document.querySelector('#goal-input').value"),unsavedGoal);
   assert.equal(await cdp.evaluate('nextPurpose'),'review');assert.deepEqual(store.messages(scope),actualQQ);
  };
  await ui.composer('collapsed vision control');await ui.openDetails('#vision-context');
  assert.equal(await cdp.evaluate("document.querySelector('#allow-automatic-images').checkVisibility()"),true,'automatic image permission is reachable with existing text permission');
  await ui.click('#auto-images');await until(()=>cdp.evaluate('state?.autoImages===true'),'automatic preference');
  assert.equal(vision.automaticImageConsent,false,'a preference switch cannot silently grant image transmission');
  await ui.click('#allow-automatic-images');await until(()=>cdp.evaluate('state?.automaticImageConsent===true&&state?.imageConsent===true'),'scoped automatic image permission');
  const consent=requests.find(item=>item.path==='/api/consent');assert.equal(consent.args.allowAutomaticImages,true);assert.equal(consent.args.allowImages,true);await preserved();
  checks.push('Primary discussion exposes automatic opt-in; preference alone is not consent; scoped grant names all four IDs and model destination and preserves existing inputs');

  vision.imageCount=2;vision.omitted=[{sourceId:'qq:72057594037927939',index:0,reason:'cache_unavailable'}];controller.changed();
  await until(()=>cdp.evaluate("document.querySelector('#vision-status').textContent.includes('2 张')"),'image count');
  assert.match(await cdp.evaluate("document.querySelector('#vision-omissions').textContent"),/1 张.*缓存/);await ui.closeDetails('#vision-context');await ui.composer('ready vision count');await preserved();
  const image=await cdp.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(evidence,'vision-count.png'),Buffer.from(image.data,'base64'));
  checks.push('Collapsed primary control displays exact upcoming attachment count and expanded cache omission explains the unread picture without blocking the composer');

  await ui.workspace('history');await ui.click(`.message[data-message-id="${pictureId}"] .media-row input[type=checkbox]`);
  await until(()=>cdp.evaluate('state?.imageSelection.length===1'),'manual image selection');await ui.workspace('discussion');
  await until(()=>cdp.evaluate("document.querySelector('#vision-status').textContent.includes('手动')"),'manual mode');await ui.openDetails('#vision-context');await ui.click('#clear-image-selection');
  await until(()=>cdp.evaluate('state?.imageSelection.length===0'),'clear manual override');assert.equal(vision.autoImages,true,'clearing manual selection restores enabled automatic preference');await ui.closeDetails('#vision-context');await preserved();
  checks.push('Manual image selection visibly overrides automatic mode and can be cleared from the main discussion to restore automatic selection');

  vision.modelVisionEnabled=false;controller.changed();await until(()=>cdp.evaluate('state?.modelVisionEnabled===false'),'unknown model capability');await ui.openDetails('#vision-context');
  assert.equal(await cdp.evaluate("document.querySelector('#allow-automatic-images').checkVisibility()"),false,'unknown model does not offer automatic grant as a capability fix');
  assert.equal(await cdp.evaluate("document.querySelector('#vision-settings').checkVisibility()"),true);await ui.closeDetails('#vision-context');assert.equal(vision.modelVisionEnabled,false);await preserved();
  checks.push('Unknown image capability is shown distinctly and is never silently enabled by consent or preference controls');

  vision.modelVisionEnabled=true;controller.changed();await ui.workspace('history');
  // Hold the actual response.blob() continuation after the request has captured
  // its scope, then switch contact before the preview becomes a blob URL.
  await cdp.evaluate(`(()=>{const originalFetch=window.fetch.bind(window),create=URL.createObjectURL.bind(URL),revoke=URL.revokeObjectURL.bind(URL);window.syntheticPreview={started:false,created:[],revoked:[]};URL.createObjectURL=blob=>{const url=create(blob);syntheticPreview.created.push(url);return url};URL.revokeObjectURL=url=>{syntheticPreview.revoked.push(url);revoke(url)};window.fetch=async(...args)=>{const response=await originalFetch(...args);if(String(args[0]).startsWith('/api/media?')){const blob=response.blob.bind(response);response.blob=async()=>{syntheticPreview.started=true;await new Promise(resolve=>{syntheticPreview.release=resolve});return blob()}}return response};})()`);
  await ui.click(`.message[data-message-id="${pictureId}"] .media-row button`);await until(()=>cdp.evaluate('syntheticPreview.started'),'delayed preview blob');
  const preview=requests.find(item=>item.path==='/api/media');assert.deepEqual(Object.fromEntries(Object.keys(scope).map(key=>[key,preview.args[key]])),scope,'preview captures full current scope');
  await ui.click('#contact-button');await ui.fill('#qq-number',otherUin);await ui.click('#contact-form button[type=submit]');
  await until(()=>cdp.evaluate(`state?.scope?.peerUin===${JSON.stringify(otherUin)}&&!loadingHistory`),'new contact');await cdp.evaluate('syntheticPreview.release()');
  await until(()=>cdp.evaluate('syntheticPreview.created.length===1&&syntheticPreview.revoked.length===1'),'discarded late preview');
  assert.equal(await cdp.evaluate('imageBlobs.size'),0);assert.equal(await cdp.evaluate("document.querySelectorAll('#history img:not([hidden])').length"),0);
  assert.equal(await cdp.evaluate('state?.automaticImageConsent'),false);assert.deepEqual(store.messages(scope),actualQQ);assert.equal(requests.filter(item=>item.path==='/api/consent').length,1);
  checks.push('A late preview is ignored and its blob URL revoked after a contact change; new contact has no inherited image grant and no previous actual QQ record is changed');
  fs.writeFileSync(path.join(evidence,'report.json'),JSON.stringify({result:'PASS',evidence:'synthetic-pointer-browser',nativeQQIntegration:false,realModelCalls:0,checks},null,2));
  console.log(JSON.stringify({result:'PASS',checks:checks.length,realModelCalls:0,nativeQQIntegration:false,report:path.join(evidence,'report.json')}));
 }catch(error){if(cdp)try{const image=await cdp.call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(evidence,'failure.png'),Buffer.from(image.data,'base64'));console.error(`Screenshot: ${path.join(evidence,'failure.png')}`);}catch{}throw error;}
 finally{cdp?.close();chrome.kill('SIGTERM');if(chrome.exitCode===null&&chrome.signalCode===null)await new Promise(resolve=>{const timer=setTimeout(resolve,2000);chrome.once('close',()=>{clearTimeout(timer);resolve()})});controller.close();await new Promise(resolve=>server.close(resolve));store.close();fs.rmSync(temporary,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
})().catch(error=>{console.error(error.stack);process.exitCode=1});
