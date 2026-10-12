'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { QQTransport, createReadAdapter, READ_ROUTES } = require('../plugin/ipc-transport.cjs');
// Transport fixture derives from actual, redacted desktop execution headers:
// RM_IPCFROM_RENDERER3, request/ntApi -> RM_IPCFROM_MAIN3, response/full.
test('QQ native transport preserves original messages and allows only read routes', async () => {
  const ipc = new EventEmitter(), transport = new QQTransport(ipc);
  const originalCalls = [];
  const wc = { isDestroyed: () => false, send(...args) { originalCalls.push(args); } };
  transport.observe({ webContents: wc });
  ipc.on('RM_IPCFROM_RENDERER3', (_, header, payload) => {
    if (header.callbackId.startsWith('qq-chat-assistant-')) wc.send('RM_IPCFROM_MAIN3', {
      type: 'response', callbackId: header.callbackId, promiseStatue: 'full' }, { result: 0, msgList: [] });
  });
  ipc.emit('RM_IPCFROM_RENDERER3', { sender: wc }, { type: 'request', eventName: 'ntApi', peerId: 3, callbackId: 'original' },
    { cmdName: 'onSessionInitComplete', cmdType: 'invoke', payload: [] });
  const result = await transport.call('nodeIKernelMsgService/getMsgs', [{ peer: { chatType: 1, peerUid: 'u_friend' } }]);
  assert.equal(result.result, 0); assert.equal(originalCalls.length, 1);
  for (const route of ['nodeIKernelMsgService/sendMsg', 'send_private_msg', 'nodeIKernelMsgService/recallMsg'])
    await assert.rejects(transport.call(route, []), /Read-only/);
  assert.equal(READ_ROUTES.some(r => /sendMsg|recall|forward/.test(r)), false);
});
test('transport propagates native failures and carries both real event callbacks', async () => {
  const ipc = new EventEmitter(), transport = new QQTransport(ipc);
  const wc = { isDestroyed: () => false, send() {} }; transport.observe({ webContents: wc });
  ipc.on('RM_IPCFROM_RENDERER3', (_, header) => {
    if (header.callbackId.startsWith('qq-chat-assistant-')) wc.send('RM_IPCFROM_MAIN3', {
      type: 'response', callbackId: header.callbackId, promiseStatue: 'rejected' }, { errMsg: 'native-error-91' });
  });
  ipc.emit('RM_IPCFROM_RENDERER3', { sender: wc }, { type: 'request', eventName: 'ntApi', callbackId: 'original' }, {});
  await assert.rejects(transport.call('nodeIKernelMsgService/getMsgs', []), /native-error-91/);
  const adapter = createReadAdapter(transport), calls = [];
  adapter.getMsgService().addKernelMsgListener({ onRecvMsg: value => calls.push(value), onMsgInfoListUpdate: value => calls.push(value) });
  wc.send('RM_IPCFROM_MAIN3', { type: 'request', eventName: 'ntApi-emit' }, { cmdName: 'nodeIKernelMsgListener/onRecvMsg', payload: ['incoming'] });
  wc.send('RM_IPCFROM_MAIN3', { type: 'request', eventName: 'ntApi-emit' }, { cmdName: 'nodeIKernelMsgListener/onMsgInfoListUpdate', payload: ['actually-sent'] });
  assert.deepEqual(calls, [['incoming'], ['actually-sent']]);
});
test('current QQ active-msg payload and older-page direction match executed native contracts',async()=>{
 const ipc=new EventEmitter(),transport=new QQTransport(ipc),adapter=createReadAdapter(transport);let received;
 adapter.getMsgService().addKernelMsgListener({onMsgInfoListUpdate:value=>{received=value}});
 transport.response({type:'request',eventName:'ntApi-emit'},{cmdName:'nodeIKernelMsgListener/onRecvActiveMsg',payload:{msgList:[{msgId:'72057594037927937'}]}});
 assert.equal(received[0].msgId,'72057594037927937');
 let params;transport.call=async(route,payload)=>{params=payload[0];return {msgList:params.cnt===10&&params.queryOrder===true?[{msgId:'older'}]:[]}};
 const result=await adapter.getMsgService().getMsgsIncludeSelf({chatType:1,peerUid:'u_friend'},'cursor',10,false);
 assert.equal(result.msgList.length,1);assert.equal(params.count,undefined);
});
test('login identity cache follows authenticated account and ignores duplicate session initialization',()=>{
 const transport=new QQTransport(new EventEmitter());let ready=0;transport.on('account-ready',()=>ready++);
 const emit=(cmdName,payload)=>transport.response({type:'request',eventName:'ntApi-emit'},{cmdName,payload});
 emit('nodeIKernelLoginListener/onQRCodeLoginSucceed',{result:{uid:'u_owner',uin:'1111111111'}});
 emit('nodeIKernelSessionListener/onSessionInitComplete',{uid:'u_owner',result:0});
 emit('nodeIKernelSessionListener/onSessionInitComplete',{uid:'u_owner',result:0});assert.equal(ready,1);
 emit('nodeIKernelMsgListener/onKickedOffLine',{});assert.equal(transport.identities.size,0);assert.equal(transport.account,null);
});

test('native events from a previous account window cannot enter the new account',()=>{
 const transport=new QQTransport(new EventEmitter());const first={send(){},isDestroyed:()=>false};const second={send(){},isDestroyed:()=>false};
 const emit=(wc,cmdName,payload)=>transport.response({type:'request',eventName:'ntApi-emit'},{cmdName,payload},wc);
 transport.observe({webContents:first});emit(first,'nodeIKernelLoginListener/onQRCodeLoginSucceed',{result:{uid:'u_first',uin:'1111111111'}});
 emit(first,'nodeIKernelSessionListener/onSessionInitComplete',{uid:'u_first',result:0});
 transport.observe({webContents:second});emit(second,'nodeIKernelLoginListener/onQRCodeLoginSucceed',{result:{uid:'u_second',uin:'2222222222'}});
 emit(second,'nodeIKernelSessionListener/onSessionInitComplete',{uid:'u_second',result:0});
 let received=0;transport.on('native-event',()=>received++);
 emit(first,'nodeIKernelMsgListener/onRecvActiveMsg',{msgList:['old-account']});assert.equal(received,0);
 emit(second,'nodeIKernelMsgListener/onRecvActiveMsg',{msgList:['new-account']});assert.equal(received,1);
});

test('old-account renderer requests cannot replace a current-account native read context',async()=>{
 const ipc=new EventEmitter(),transport=new QQTransport(ipc);
 const wc=()=>({send(){},isDestroyed:()=>false});const first=wc(),second=wc();
 const native=(window,cmdName,payload)=>transport.response({type:'request',eventName:'ntApi-emit'},{cmdName,payload},window);
 transport.observe({webContents:first});native(first,'nodeIKernelLoginListener/onQRCodeLoginSucceed',{result:{uid:'u_first',uin:'1111111111'}});native(first,'nodeIKernelSessionListener/onSessionInitComplete',{uid:'u_first',result:0});
 transport.observe({webContents:second});native(second,'nodeIKernelLoginListener/onQRCodeLoginSucceed',{result:{uid:'u_second',uin:'2222222222'}});native(second,'nodeIKernelSessionListener/onSessionInitComplete',{uid:'u_second',result:0});
 const request=(sender,id)=>ipc.emit('RM_IPCFROM_RENDERER3',{sender},{type:'request',eventName:'ntApi',callbackId:id},{cmdName:'onSessionInitComplete',payload:[]});
 request(second,'new');request(first,'old');assert.equal(transport.context.event.sender,second);
 ipc.on('RM_IPCFROM_RENDERER3',(event,header)=>{if(header.callbackId?.startsWith('qq-chat-assistant-'))event.sender.send('RM_IPCFROM_MAIN3',{type:'response',callbackId:header.callbackId,promiseStatue:'full'},{msgList:[]})});
 transport.context={event:{sender:first},channel:'RM_IPCFROM_RENDERER3',header:{type:'request',eventName:'ntApi'}};
 await assert.rejects(transport.call('nodeIKernelMsgService/getMsgs',[]),/different account/);
});
