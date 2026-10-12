'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const vm=require('node:vm');
const {activeContact}=require('../plugin/contact.cjs');
function contents(component, builtin=false){
 const parent={__VUE__:builtin?undefined:[component],__vueParentComponent:builtin?component:undefined,parentElement:null};
 const toolbar={parentElement:parent};
 return {executeJavaScript:script=>vm.runInNewContext(script,{Map,document:{querySelector:()=>toolbar,querySelectorAll:()=>[]}})};
}
test('current private peer is read from LiteLoader recorded Vue ancestors in production QQ',async()=>{
 const peer={chatType:1,peerUid:'u_selected'};
 const a=await activeContact(contents({props:{chatInfo:peer},setupState:{},parent:null}));
 assert.equal(a?.peerUid,peer.peerUid);
});
test('builtin Vue/ref shapes work, and groups or multiple current peers cannot authorize a private write',async()=>{
 const a=await activeContact(contents({props:{},setupState:{currentChat:{value:{chatType:1,peerUid:'u_current'}}}},true));assert.equal(a?.peerUid,'u_current');
 const group=await activeContact(contents({props:{chatInfo:{chatType:2,peerUid:'u_group'}},setupState:{}}));assert.equal(group,null);
 const conflict=await activeContact(contents({props:{chatInfo:{chatType:1,peerUid:'u_a'}},setupState:{currentChat:{chatType:1,peerUid:'u_b'}}}));assert.equal(conflict,null);
});

test('a current group composer cannot be authorized by an ancestor with a cached private peer',async()=>{const component={props:{chatInfo:{chatType:2,peerUid:'u_group'}},setupState:{currentChat:{chatType:1,peerUid:'u_cached'}}};assert.equal(await activeContact(contents(component)),null)});

test('actual QQ composer props use type with peerUid and chatUin instead of chatType',async()=>{const props={groupId:'0',chatUin:'2222222222',peerUid:'u_current',type:1};assert.equal((await activeContact(contents({props,setupState:{}})))?.peerUid,'u_current');assert.equal(await activeContact(contents({props:{...props,type:2},setupState:{}})),null)});

test('blank pooled props cannot hide the actual cached current peer, and inactive conversation maps are ignored',async()=>{const peer={reqKey:'fixture',guildId:'',channelId:'',tinyId:'',search:'',isInDirectMsg:false,peerUid:'u_current',uin:'2222222222',chatType:1};const map=new Map([['peer',[{cache:{peer}}]],['inactive',[{cache:{aioDataMap:new Map([['old',{chatType:1,peerUid:'u_other'}]])}}]]]);const c={props:{groupId:'',chatUin:'',peerUid:'',type:1},setupState:{qq_container__vue:{container:{_bindingDictionary:{_map:map}}}}};assert.equal((await activeContact(contents(c)))?.peerUid,'u_current');peer.chatType=2;assert.equal(await activeContact(contents(c)),null)});
