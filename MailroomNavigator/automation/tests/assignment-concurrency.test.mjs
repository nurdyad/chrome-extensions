import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {mkdtemp,readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
const s=readFileSync(new URL('../linear-trigger-server.mjs',import.meta.url),'utf8');
const code=s.slice(s.indexOf('let linearAssignmentQueue ='),s.indexOf('function isDocumentOptionalLinearIssuePayload'));
async function harness(t, overrides={}){
 const dir=await mkdtemp(join(tmpdir(),'assignment-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 let failWrite=false,reads=0;
 const deps={readLinearAssignmentPolicy:async()=>({mode:'weighted',ownerWeight:50,otherEmails:['other@test.invalid']}),
 resolveLinearViewer:async()=>({id:'owner',email:'owner@test.invalid'}),
 listLinearAssignmentMembers:async()=>[{id:'other',email:'other@test.invalid'}],
 readFile:async(...args)=>{reads++;await new Promise(r=>setTimeout(r,2));return readFile(...args);},
 writeFile:async(...args)=>{if(failWrite){failWrite=false;throw new Error('simulated disk failure');}return writeFile(...args);},mkdir,dirname,
 LINEAR_ASSIGNMENT_STATE_PATH:join(dir,'state.json'), ...overrides};
 const allocate=new Function(...Object.keys(deps),code+'return resolveLinearIssueAssignee;')(...Object.values(deps));
 return {allocate,failNextWrite:()=>{failWrite=true;},reads:()=>reads,state:()=>readFile(deps.LINEAR_ASSIGNMENT_STATE_PATH,'utf8')};
}
test('40 simultaneous requests preserve sequential round-robin state',async t=>{
 const h=await harness(t);const results=await Promise.all(Array.from({length:40},()=>h.allocate()));
 assert.deepEqual(results.map(x=>x.id),Array.from({length:40},(_,i)=>i%2?'other':'owner'));
 assert.deepEqual(JSON.parse(await h.state()).current,{owner:0,other:0});assert.equal(h.reads(),40);
});
test('a failed allocation rejects its caller but does not poison queued requests',async t=>{
 const h=await harness(t);h.failNextWrite();
 const results=await Promise.allSettled([h.allocate(),h.allocate(),h.allocate()]);
 assert.equal(results[0].status,'rejected');assert.match(results[0].reason.message,/disk failure/);
 assert.deepEqual(results.slice(1).map(x=>x.value.id),['owner','other']);
});

test('creator listed as a colleague retains exactly the configured owner share',async t=>{
 const h=await harness(t,{
 readLinearAssignmentPolicy:async()=>({mode:'weighted',ownerWeight:25,otherEmails:['owner@test.invalid','other@test.invalid']}),
 listLinearAssignmentMembers:async()=>[{id:'owner',email:'owner@test.invalid'},{id:'other',email:'other@test.invalid'}]
 });
 const values=await Promise.all(Array.from({length:100},()=>h.allocate()));
 assert.equal(values.filter(x=>x.id==='owner').length,25);
 assert.equal(values.filter(x=>x.id==='other').length,75);
});
