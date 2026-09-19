const test=require('node:test');const assert=require('node:assert/strict');const {once}=require('node:events');const {createHmac}=require('node:crypto');const {WebSocket}=require('ws');
const {DesktopBridge}=require('../src/bridge.cjs');const P=require('../shared/protocol.js');
const token='a'.repeat(64),extensionId='b'.repeat(32);
async function setup(t){const bridge=new DesktopBridge({token,extensionId,port:0,commandTimeout:80});await bridge.start();t.after(()=>bridge.close());return bridge;}
async function client(bridge,{origin=`chrome-extension://${extensionId}`,key=token,protocol=1,id='profile-1'}={}){
 const ws=new WebSocket(`ws://127.0.0.1:${bridge.port}/bridge`,{origin});const messages=[];ws.on('message',raw=>messages.push(JSON.parse(raw)));ws.on('error',()=>{});
 const [raw]=await once(ws,'message');const challenge=JSON.parse(raw).challenge;const nonce='c'.repeat(64);
 ws.send(JSON.stringify({type:'hello',protocol,clientId:id,profile:'Test profile',nonce,proof:createHmac('sha256',key).update(`${challenge}:${nonce}:${protocol}:${id}`).digest('hex')}));
 return {ws,messages,challenge,nonce};
}
async function ready(client){const [raw]=await once(client.ws,'message');return JSON.parse(raw);}
const context={id:'ctx',revision:1,tabId:42,windowId:2,scope:'A12345'};
async function contexts(bridge,ws,values=[context]){const changed=once(bridge,'state');ws.send(JSON.stringify({type:'contexts',contexts:values}));await changed;}
test('authenticated bridge verifies both sides, strips context extras and routes exact target',async t=>{
 const bridge=await setup(t),c=await client(bridge);t.after(()=>c.ws.terminate());const response=await ready(c);
 assert.equal(response.proof,createHmac('sha256',token).update(`desktop:${c.challenge}:${c.nonce}`).digest('hex'));
 await contexts(bridge,c.ws,[{...context,password:'must not forward'}]);assert.equal(bridge.contexts[0].password,undefined);
 const message=once(c.ws,'message'),operation=bridge.run('collection',{id:'ctx',revision:1});const command=JSON.parse((await message)[0]);
 assert.equal(command.contextId,'ctx');assert.equal(command.scope,'A12345');assert.equal(command.protocol,1);
 c.ws.send(JSON.stringify({type:'result',requestId:command.requestId,ok:true}));await operation;
});
test('bad credentials and incompatible protocols are rejected before context exchange',async t=>{
 const bridge=await setup(t);
 for(const options of [{key:'d'.repeat(64)},{protocol:2}]){const c=await client(bridge,options);const [code]=await once(c.ws,'close');assert.equal(code,1008);assert.equal(bridge.peer,null);}
});
test('web origins cannot upgrade the bridge connection',async t=>{
 const bridge=await setup(t);const ws=new WebSocket(`ws://127.0.0.1:${bridge.port}/bridge`,{origin:'https://evil.invalid'});
 ws.on('error',()=>{});const [response]=await once(ws,'unexpected-response').then(args=>[args[1]]);assert.equal(response.statusCode,403);response.resume();ws.terminate();
});
test('stale context, wrong scope and unknown commands cannot execute',async t=>{
 const bridge=await setup(t),c=await client(bridge);await ready(c);await contexts(bridge,c.ws);
 await assert.rejects(bridge.run('collection',{id:'ctx',revision:2}),/Choose a current/);
 await assert.rejects(bridge.run('delete-everything',{id:'ctx',revision:1}),/Choose a current/);
 await contexts(bridge,c.ws,[{...context,scope:'ALL'}]);await assert.rejects(bridge.run('settings',{id:'ctx',revision:1}),/Choose a current/);
});
test('disconnect fails pending work and does not replay it after reconnect',async t=>{
 const bridge=await setup(t),c=await client(bridge);await ready(c);await contexts(bridge,c.ws);
 const operation=bridge.run('letters',{id:'ctx',revision:1});const rejected=assert.rejects(operation,/disconnected/);c.ws.close();await rejected;assert.equal(bridge.pending.size,0);assert.equal(bridge.contexts.length,0);
 const next=await client(bridge);await ready(next);assert.equal(bridge.pending.size,0);
});
test('silent Chrome requests time out, without retrying',async t=>{
 const bridge=await setup(t),c=await client(bridge);await ready(c);await contexts(bridge,c.ws);
 await assert.rejects(bridge.run('letters',{id:'ctx',revision:1}),/did not confirm/);assert.equal(bridge.pending.size,0);
});
test('a second Chrome profile cannot replace the chosen profile',async t=>{
 const bridge=await setup(t),a=await client(bridge);await ready(a);const b=await client(bridge,{id:'profile-2'});
 assert.equal((await once(b.ws,'close'))[0],1008);assert.equal(bridge.peer.profile,'Test profile');
});
test('malformed payloads close the connection without crashing the service',async t=>{
 const bridge=await setup(t),c=await client(bridge);await ready(c);c.ws.send('null');assert.equal((await once(c.ws,'close'))[0],1008);
 const next=await client(bridge);await ready(next);assert.equal(bridge.snapshot().connected,true);
});
