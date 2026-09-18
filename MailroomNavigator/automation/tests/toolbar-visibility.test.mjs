import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../../background.js',import.meta.url),'utf8');
const start=source.indexOf('async function installGlobalToolbarVisibility(');
const queueStart=source.indexOf('let toolbarVisibilityQueue =',start);
const end=source.indexOf('async function ensureSidebarPanelMounted',queueStart);
const key='mailroomToolbarHiddenGlobalV1';
function storage(initial=false){
 const listeners=new Set();let value=initial;
 return {onChanged:{addListener:fn=>listeners.add(fn),removeListener:fn=>listeners.delete(fn)},
 local:{get:async()=>({[key]:value}),set:async data=>{value=data[key];for(const fn of listeners)fn({[key]:{newValue:value}},'local');}},listeners};
}
function page(shared,{mounted=true,focused=false}={}){
 const style=new Map();let restored=0,bodyFocused=0;
 const document={};
 const active={isConnected:true,getClientRects:()=>[{}],focus:()=>{restored++;document.activeElement=active;}};
 const dock={dataset:{},contains:el=>el===active,style:{setProperty:(k,v)=>style.set(k,v),removeProperty:k=>style.delete(k)}};
 document.body={getAttribute:()=>null,setAttribute(){},removeAttribute(){},focus:()=>{bodyFocused++;document.activeElement=document.body;}};
 document.activeElement=focused?active:document.body;
 document.getElementById=()=>mounted?dock:null;
 const window={};
 const install=new Function('document','window','chrome',source.slice(start,queueStart)+'return installGlobalToolbarVisibility;')(document,window,{storage:shared});
 return {install,style,dock,window,mount(){mounted=true;window.__blGlobalToolbarVisibilityV1.apply(dock);},focus:()=>({restored,bodyFocused})};
}
test('shared hide/show is idempotent across tabs and preserves focus/panel state',async()=>{
 const shared=storage(),a=page(shared,{focused:true}),b=page(shared);
 await Promise.all([a.install(),b.install()]);
 await shared.local.set({[key]:true});await shared.local.set({[key]:true});
 assert.equal(a.style.get('display'),'none');assert.equal(b.style.get('display'),'none');assert.equal(a.focus().bodyFocused,1);
 await shared.local.set({[key]:false});await shared.local.set({[key]:false});
 assert.equal(a.style.has('display'),false);assert.equal(b.style.has('display'),false);assert.equal(a.focus().restored,1);
});
test('new/reloaded pages inherit hidden preference before attaching a dock',async()=>{
 const shared=storage(true),p=page(shared,{mounted:false});await p.install();p.mount();
 assert.equal(p.style.get('display'),'none');
 const reloaded=page(shared);await reloaded.install();assert.equal(reloaded.style.get('display'),'none');
});
test('repeated installation registers one storage listener',async()=>{
 const shared=storage(),p=page(shared);await Promise.all([p.install(),p.install()]);await p.install();assert.equal(shared.listeners.size,1);
});
test('a stale initial read cannot undo a newer visibility event',async()=>{
 const shared=storage();let resolveRead;shared.local.get=()=>new Promise(resolve=>resolveRead=resolve);
 const p=page(shared);const pending=p.install();await shared.local.set({[key]:true});resolveRead({[key]:false});await pending;
 assert.equal(p.style.get('display'),'none');
});
test('failed initialization can retry without leaking a listener',async()=>{
 const shared=storage(),get=shared.local.get;shared.local.get=async()=>{throw Error('storage unavailable');};
 const p=page(shared);await assert.rejects(p.install(),/storage unavailable/);assert.equal(shared.listeners.size,0);
 shared.local.get=get;await p.install();assert.equal(shared.listeners.size,1);
});
function coordinator(shared,pages,mounts=[]){
 const chrome={storage:shared,tabs:{query:async query=>{assert.deepEqual(query,{});return [{id:1,windowId:1},{id:2,windowId:2},{id:3,windowId:2}];}},
 scripting:{executeScript:async({target})=>{if(target.tabId===3)throw Error('restricted page');return [{result:await pages[target.tabId-1].install()}];}}};
 return new Function('chrome','installGlobalToolbarVisibility','ensureSidebarPanelMounted',source.slice(queueStart,end)+'return setGlobalMailroomToolbarsHidden;')(chrome,()=>{},async id=>{mounts.push(id);pages[id-1].mount();});
}
test('global commands reach all windows, tolerate restricted tabs and serialize rapid hide/show',async()=>{
 const shared=storage(),pages=[page(shared),page(shared)],set=coordinator(shared,pages);
 const results=await Promise.all([set(true),set(false),set(true)]);
 assert.ok(results.every(r=>r.success && r.skippedTabs===1));
 assert.ok(pages.every(p=>p.style.get('display')==='none'));
 await set(false);assert.ok(pages.every(p=>!p.style.has('display')));
});
test('failed storage write rejects its command but does not poison the queue',async()=>{
 const shared=storage(),save=shared.local.set;let first=true;shared.local.set=async data=>{if(first){first=false;throw Error('quota');}await save(data);};
 const pages=[page(shared),page(shared)],set=coordinator(shared,pages);
 const results=await Promise.allSettled([set(true),set(false)]);
 assert.equal(results[0].status,'rejected');assert.equal(results[1].status,'fulfilled');
});
test('manifest provides separate configurable hide and show commands',()=>{
 const manifest=JSON.parse(readFileSync(new URL('../../manifest.json',import.meta.url)));
 assert.equal(manifest.commands.toggle_mailroom_toolbars.suggested_key.mac,'Alt+Shift+H');
 assert.equal(manifest.commands.show_mailroom_toolbars.suggested_key.mac,'Alt+Shift+J');
 assert.match(manifest.commands.toggle_mailroom_toolbars.description,/Hide.*all tabs/);
});

test('show rebuilds missing docks after reload without changing already mounted pages',async()=>{
 const shared=storage(true),pages=[page(shared,{mounted:false}),page(shared)],mounts=[];
 const set=coordinator(shared,pages,mounts);
 await set(true);assert.deepEqual(mounts,[]);
 const result=await set(false);assert.equal(result.success,true);assert.deepEqual(mounts,[1]);
 assert.equal(pages[0].dock.dataset.allToolbarsHidden,'false');
 await set(false);assert.deepEqual(mounts,[1]);
});
test('show does not claim toolbars were restored when no page is available',async()=>{
 const shared=storage();
 const chrome={storage:shared,tabs:{query:async()=>[]},scripting:{executeScript:async()=>{throw Error('must not inject');}}};
 const set=new Function('chrome','installGlobalToolbarVisibility','ensureSidebarPanelMounted',source.slice(queueStart,end)+'return setGlobalMailroomToolbarsHidden;')(chrome,()=>{},()=>{});
 const result=await set(false);assert.equal(result.success,false);assert.match(result.error,/Open or refresh a normal webpage/);
 assert.equal((await shared.local.get())[key],false);
});
