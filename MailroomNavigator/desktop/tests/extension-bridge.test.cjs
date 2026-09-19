const test=require('node:test');const assert=require('node:assert/strict');const {readFileSync}=require('node:fs');const vm=require('node:vm');const {webcrypto,randomUUID}=require('node:crypto');const {WebSocket}=require('ws');
const {DesktopBridge}=require('../src/bridge.cjs');const P=require('../shared/protocol.js');
function event(){const listeners=new Set();return {addListener:fn=>listeners.add(fn),removeListener:fn=>listeners.delete(fn),emit:async(...args)=>{for(const fn of [...listeners])await fn(...args);}};}
const wait=async fn=>{for(let i=0;i<100;i++){if(fn())return;await new Promise(r=>setTimeout(r,10));}throw Error('State did not settle');};
async function harness(t){
 const token='a'.repeat(64),id='b'.repeat(32);const bridge=new DesktopBridge({token,extensionId:id,port:0,commandTimeout:1000});await bridge.start();
 const changed=event(),ports=event(),updated=event(),removed=event();const values={mailroomDesktopCompanionV1:{enabled:true,token,profile:'Work',clientId:'profile-1'}};
 let tab={id:42,windowId:2,url:'https://app.betterletter.ai/admin_panel/bots/dashboard',incognito:false};
 const chrome={storage:{local:{get:async key=>({[key]:values[key]}),set:async data=>Object.assign(values,data),remove:async key=>{delete values[key];await changed.emit({[key]:{newValue:undefined}},'local');}},onChanged:changed},
 runtime:{id,getURL:path=>`chrome-extension://${id}/${path}`,getManifest:()=>({version:'1.127.0'}),onConnect:ports,onStartup:event(),onMessage:event()},
 tabs:{get:async tabId=>{assert.equal(tabId,42);return tab;},onUpdated:updated,onRemoved:removed},alarms:{create:async()=>{},clear:async()=>{},onAlarm:event()}};
 class BrowserSocket extends WebSocket{constructor(url){super(url,{origin:`chrome-extension://${id}`});}}
 const context=vm.createContext({chrome,MailroomDesktopProtocol:{...P,port:bridge.port},crypto:{subtle:webcrypto.subtle,getRandomValues:v=>webcrypto.getRandomValues(v),randomUUID},TextEncoder,WebSocket:BrowserSocket,setTimeout,clearTimeout,setInterval,clearInterval,console});
 vm.runInContext(readFileSync(require.resolve('../../desktop-bridge.js'),'utf8'),context);
 t.after(async()=>{await chrome.storage.local.remove('mailroomDesktopCompanionV1');await bridge.close();});
 await wait(()=>bridge.snapshot().connected);
 const messages=[],port={name:'mailroom-desktop-panel',sender:{id,url:`chrome-extension://${id}/panel.html?hostTabId=42`,tab:{id:42}},onMessage:event(),onDisconnect:event(),postMessage:message=>messages.push(message)};
 await ports.emit(port);await port.onMessage.emit({type:'context',scope:'A12345',tabId:42});await wait(()=>bridge.contexts.length===1);
 return {bridge,chrome,port,messages,values,setTab:value=>{tab={...tab,...value};},updated};
}
test('actual service-worker bridge authenticates, publishes safe context and completes a targeted action',async t=>{
 const h=await harness(t),target=h.bridge.contexts[0];assert.equal(target.scope,'A12345');
 const operation=h.bridge.run('letters',target);await wait(()=>h.messages.length===1);assert.equal(h.messages[0].action,'letters');
 await h.port.onMessage.emit({type:'result',requestId:h.messages[0].requestId,ok:true});await operation;
});
test('practice changes invalidate a previously selected revision',async t=>{
 const h=await harness(t),target=h.bridge.contexts[0];await h.port.onMessage.emit({type:'context',scope:'B54321',tabId:42});await wait(()=>h.bridge.contexts[0].scope==='B54321');
 await assert.rejects(h.bridge.run('collection',target),/Choose a current/);assert.equal(h.messages.length,0);
});
test('navigation or incognito state cannot execute against the old target',async t=>{
 const h=await harness(t),target=h.bridge.contexts[0];h.setTab({url:'https://unrelated.invalid/'});
 await assert.rejects(h.bridge.run('letters',target),/Tab or practice changed/);assert.equal(h.messages.length,0);
});
test('untrusted runtime senders cannot change pairing credentials',async t=>{
 const h=await harness(t);let reply;
 await h.chrome.runtime.onMessage.emit({action:'desktopCompanionSettings',disable:true},{id:'other',url:'https://evil.invalid'},value=>reply=value);
 assert.equal(reply.success,false);assert.equal(h.values.mailroomDesktopCompanionV1.enabled,true);
});
test('context updates never leave the extension before the desktop proves its identity',async t=>{
 const id='b'.repeat(32),ports=event(),changed=event(),sent=[];
 const values={mailroomDesktopCompanionV1:{enabled:true,token:'a'.repeat(64),clientId:'profile-1'}};
 const chrome={storage:{local:{get:async key=>({[key]:values[key]}),set:async()=>{},remove:async key=>{delete values[key];await changed.emit({[key]:{}},'local');}},onChanged:changed},
 runtime:{id,getURL:path=>`chrome-extension://${id}/${path}`,onConnect:ports,onStartup:event(),onMessage:event()},
 tabs:{get:async()=>({id:42,windowId:2,url:'https://app.betterletter.ai/',incognito:false}),onUpdated:event(),onRemoved:event()},alarms:{create:async()=>{},clear:async()=>{},onAlarm:event()}};
 let connection;
 class UnauthenticatedSocket{static OPEN=1;constructor(){this.readyState=1;connection=this;}send(message){sent.push(JSON.parse(message));}close(){this.readyState=3;this.onclose?.({code:1000});}}
 const context=vm.createContext({chrome,MailroomDesktopProtocol:P,crypto:{subtle:webcrypto.subtle,getRandomValues:v=>webcrypto.getRandomValues(v),randomUUID},TextEncoder,WebSocket:UnauthenticatedSocket,setTimeout,clearTimeout,setInterval,clearInterval,console});
 vm.runInContext(readFileSync(require.resolve('../../desktop-bridge.js'),'utf8'),context);
 t.after(()=>chrome.storage.local.remove('mailroomDesktopCompanionV1'));
 await wait(()=>connection);
 const port={name:'mailroom-desktop-panel',sender:{id,url:`chrome-extension://${id}/panel.html`,tab:{id:42}},onMessage:event(),onDisconnect:event(),postMessage:()=>{}};
 await ports.emit(port);await port.onMessage.emit({type:'context',scope:'A12345',tabId:42});
 assert.deepEqual(sent,[]);
});
