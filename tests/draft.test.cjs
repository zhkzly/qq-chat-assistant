'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const vm=require('node:vm');
const {fillQQDraft}=require('../plugin/draft.cjs');const {scope}=require('./fixtures/native.cjs');
function setup(existing=''){
 const editor={innerText:existing,getClientRects:()=>[{}],focus(){}};let sends=0;
 const component={props:{chatInfo:{chatType:1,peerUid:scope.peerUid}},setupState:{}};const toolbar={__VUE__:[component],parentElement:null};
 const context={document:{querySelector:()=>toolbar,querySelectorAll:()=>[editor],createRange:()=>({selectNodeContents(){}}),execCommand(command,flag,text){assert.equal(command,'insertText');editor.innerText=text;return true}},getSelection:()=>({removeAllRanges(){},addRange(){}})};
 const window={isVisible:()=>true,show(){},focus(){},webContents:{id:7,getURL:()=> 'app://./renderer/index.html',executeJavaScript:script=>{assert.equal(/sendMsg|KeyboardEvent|keydown|Enter/.test(script),false);return vm.runInNewContext(script,{...context,Map})},send(){sends++}}};
 return {component,editor,window,bindings:new Map([[7,{accountUid:scope.accountUid,uin:scope.peerUin}]]),account:{uid:scope.accountUid,uin:scope.accountUin},get sends(){return sends}};
}
test('QQ draft fill writes only the bound private composer and never sends',async()=>{const a=setup();const result=await fillQQDraft({...a,windows:[a.window],scope,text:'Synthetic draft 🙂'});assert.equal(a.editor.innerText,'Synthetic draft 🙂');assert.equal(result.sent,false);assert.equal(a.sends,0)});
test('existing QQ draft requires explicit replacement and wrong contact cannot be touched',async()=>{const a=setup('Existing unsent text');const result=await fillQQDraft({...a,windows:[a.window],scope,text:'New draft'});assert.equal(result.requiresReplace,true);assert.equal(a.editor.innerText,'Existing unsent text');a.component.props.chatInfo.peerUid='u_other';await assert.rejects(fillQQDraft({...a,windows:[a.window],scope,text:'Wrong'}),/对应/);assert.equal(a.editor.innerText,'Existing unsent text')});

test('different QQ account cannot authorize a composer write',async()=>{const a=setup();await assert.rejects(fillQQDraft({...a,account:{uid:'u_other',uin:scope.accountUin},windows:[a.window],scope,text:'Wrong owner'}),/账号/);assert.equal(a.editor.innerText,'')});

test('live composer identity works without an old peer cache but never accepts an old account window',async()=>{const a=setup();a.bindings.clear();const windowAccounts=new WeakMap([[a.window.webContents,scope.accountUid]]);await fillQQDraft({...a,windows:[a.window],windowAccounts,scope,text:'Synthetic draft'});assert.equal(a.editor.innerText,'Synthetic draft');windowAccounts.set(a.window.webContents,'u_old');await assert.rejects(fillQQDraft({...a,windows:[a.window],windowAccounts,scope,text:'Wrong account'}),/对应/);assert.equal(a.editor.innerText,'Synthetic draft')});
test('a contact switch between inspection and insertion cannot redirect a draft',async()=>{const a=setup();await assert.rejects(fillQQDraft({...a,windows:[a.window],scope,text:'Wrong',assertScope(){a.component.props.chatInfo.peerUid='u_other'}}),/会话已改变/);assert.equal(a.editor.innerText,'')});

test('QQ zero-width empty-editor sentinel is writable while rich native drafts remain protected',async()=>{const a=setup('\u200B');const flag={isEditorEmpty:true};a.component.setupState.qq_container__vue={container:{_bindingDictionary:{_map:new Map([['editor',[{cache:flag}]]])}}};await fillQQDraft({...a,windows:[a.window],scope,text:'Visible draft'});assert.equal(a.editor.innerText,'Visible draft');a.editor.innerText='';flag.isEditorEmpty=false;const held=await fillQQDraft({...a,windows:[a.window],scope,text:'Do not replace an attached image'});assert.equal(held.requiresReplace,true);assert.equal(a.editor.innerText,'')});
