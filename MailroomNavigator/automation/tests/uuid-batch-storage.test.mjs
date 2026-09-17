import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const s=readFileSync(new URL('../../bot_dashboard_navigator.js',import.meta.url),'utf8');
const a=s.indexOf('    let uuidBatchPersistenceQueue ='),b=s.indexOf('    function makeUuidBatchCheckAction',a);
function harness(set, lookup){
 const messages=[],writes=[];
 const chrome={storage:{local:{set:payload=>{writes.push(structuredClone(payload));return set?.(payload,writes.length);}}}};
 const run=new Function('chrome','setBotDashboardBulkStatus','sendRuntimeMessage','collapseText','window',
 'let uuidBatchCheckRequestSeq=0; const UUID_BATCH_RESULTS_STORAGE_KEY="batch";'+s.slice(a,b)+'return runUuidBatchCheck;')(
 chrome,msg=>messages.push(msg),lookup || (async({payload})=>({success:true,result:{uuid:payload.uuid,found:true,status:'paused'}})),v=>String(v??''),{setTimeout(){}});
 return {run,messages,writes};
}
for(const synchronous of [true,false]) test(`storage ${synchronous?'throw':'rejection'} reports failure without results-ready success`,async()=>{
 const h=harness(()=>{if(synchronous)throw Error('quota');return Promise.reject(Error('quota'));});
 await h.run(['00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002']);assert.match(h.messages.at(-1),/Could not save UUID results/);
 assert.ok(!h.messages.some(m=>m.includes('see the sidebar')));
});
test('successful completion is announced only after the final write resolves',async()=>{
 let release;const gate=new Promise(r=>release=r);const h=harness((_,n)=>n===3?gate:Promise.resolve());
 const running=h.run(['00000000-0000-0000-0000-000000000001']);
 while(h.writes.length<3)await new Promise(r=>setImmediate(r));
 assert.ok(!h.messages.some(m=>m.includes('see the sidebar')));release();await running;
 assert.match(h.messages.at(-1),/see the sidebar/);assert.equal(h.writes.at(-1).batch.items[0].result.status,'paused');
});
test('a transient rejected write can recover on final persistence',async()=>{
 const h=harness((_,n)=>n===2?Promise.reject(Error('temporary')):Promise.resolve());await h.run(['00000000-0000-0000-0000-000000000001']);
 assert.match(h.messages.at(-1),/see the sidebar/);assert.equal(h.writes.at(-1).batch.items[0].result.found,true);
});
test('a new batch waits for older writes and becomes the final saved result',async()=>{
 let release;const gate=new Promise(r=>release=r);let saved;
 const h=harness(async(payload,n)=>{if(n===1)await gate;saved=structuredClone(payload);});
 const first=h.run(['00000000-0000-0000-0000-000000000003']);while(!h.writes.length)await new Promise(r=>setImmediate(r));
 const second=h.run(['00000000-0000-0000-0000-000000000004']);release();await Promise.all([first,second]);
 assert.deepEqual(saved.batch.items.map(x=>x.uuid),['00000000-0000-0000-0000-000000000004']);assert.equal(saved.batch.items[0].result.found,true);
});

test('mixed outcomes report separate totals including thrown and returned failures',async()=>{
 let call=0;
 const h=harness(undefined,async()=>{
  call++; if(call===1)return {success:true,result:{found:true}};
  if(call===2)return {success:true,result:{found:false}};
  if(call===3)return {success:false,error:'offline'};
  throw Error('timeout');
 });
 await h.run(['00000000-0000-0000-0000-000000000005','00000000-0000-0000-0000-000000000006','00000000-0000-0000-0000-000000000007','00000000-0000-0000-0000-000000000008']);
 assert.match(h.messages.at(-1),/Checked 4 UUIDs: 1 found · 1 not found · 2 failed/);
});

test('entry boundary skips invalid values and case-insensitive duplicates',async()=>{
 const h=harness();
 await h.run([' ABCDEF00-0000-0000-0000-000000000001 ', 'abcdef00-0000-0000-0000-000000000001',null,{},'garbage']);
 assert.deepEqual(h.writes.at(-1).batch.items.map(x=>x.uuid),['abcdef00-0000-0000-0000-000000000001']);
 assert.match(h.messages.at(-1),/4 invalid or duplicate inputs skipped/);
});
test('empty or non-array input performs no writes or lookups',async()=>{
 const h=harness(undefined,()=>{throw Error('must not call');});
 for(const input of [[],null,'uuid',[null,'bad']])await h.run(input);
 assert.equal(h.writes.length,0);assert.match(h.messages.at(-1),/No valid UUIDs/);
});
