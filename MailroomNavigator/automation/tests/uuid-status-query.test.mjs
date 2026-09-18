import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../linear-trigger-server.mjs',import.meta.url),'utf8');
const code=source.slice(source.indexOf('function sanitizeUuidLookupRow('),source.indexOf('function isLikelySlackId('));
const uuid='11111111-2222-3333-4444-555555555555';
function harness(query){
 const saved=[],calls=[],inFlight=new Map();
 const deps={isSqlLookupConfigured:()=>true,extractUuid:v=>v,getCachedUuidLookup:()=>null,uuidLookupInFlight:inFlight,
 rememberUuidLookup:(...args)=>saved.push(args),SQL_UUID_LOOKUP_TIMEOUT_MS:20000,nowIso:()=>new Date().toISOString(),
 sanitizeSingleLine:v=>String(v??''),sanitizeHttpUrl:v=>String(v??''),runSqlQueryWithConnectionRetry:async(...args)=>{calls.push(args);return query(...args);}};
 const run=new Function(...Object.keys(deps),code+'return runUuidStatusLookup;')(...Object.values(deps));return {run,saved,calls,inFlight};
}
test('document filename lookup preserves result and rejection metadata after exact bot miss',async()=>{
 let count=0;const h=harness(async(sql,values)=>{
 assert.deepEqual(values,[uuid]);count++;
 return {rows:count===1?[]:[{document_id:123,input_file_name:uuid+'.pdf',matched_uuid:uuid,document_status:'rejected',rejection_reason:'test reason',match_type:'Exact document UUID match'}]};
 });
 const result=await h.run(uuid);assert.equal(result.found,true);assert.equal(result.documentId,'123');assert.equal(result.rejectionReason,'test reason');
 assert.equal(h.calls.length,2);assert.equal(h.saved.length,1);assert.equal(h.inFlight.size,0);
});
test('exact bot match avoids the filename scan',async()=>{
 const h=harness(async()=>({rows:[{bot_job_id:uuid,bot_job_status:'paused'}]}));
 assert.equal((await h.run(uuid)).status,'paused');assert.equal(h.calls.length,1);
});
test('only completed misses become cached not-found results',async()=>{
 const h=harness(async()=>({rows:[]}));assert.equal((await h.run(uuid)).found,false);assert.equal(h.calls.length,2);assert.equal(h.saved.length,1);
});
test('database timeout stays a retryable error, never cached as not-found',async()=>{
 let count=0;const h=harness(async()=>{if(++count===2)throw Object.assign(Error('statement timeout'),{code:'57014'});return {rows:[]};});
 await assert.rejects(h.run(uuid),/statement timeout/);assert.equal(h.saved.length,0);assert.equal(h.inFlight.size,0);
 assert.equal((await h.run(uuid)).found,false);assert.equal(h.saved.length,1);
});
