import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {Readable} from 'node:stream';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const s=readFileSync(new URL('../linear-trigger-server.mjs',import.meta.url),'utf8');
const section=(a,b)=>s.slice(s.indexOf(a),s.indexOf(b,s.indexOf(a)));
const code=section('async function parseJsonBody','function sendJson')+
 section('function normalizeLinearAssignmentMode','async function readLinearAssignmentPolicy')+
 section('    if (method === "PUT" && path === "/linear/assignment-policy")','    if (method === "GET" && path === "/practice/lookup")');
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
async function request(t,body,admin=true){
 const dir=await mkdtemp(join(tmpdir(),'policy-request-'));t.after(()=>rm(dir,{recursive:true,force:true}));const file=join(dir,'policy.json');
 const original='{"mode":"weighted","ownerWeight":25,"otherEmails":["other@test.invalid"]}';await writeFile(file,original);
 let response,writes=0;
 const deps={method:'PUT',path:'/linear/assignment-policy',req:Readable.from([Buffer.from(body)]),res:{},origin:'chrome-extension://test',
 resolveLinearViewer:async()=>({email:admin?'admin@test.invalid':'someone@test.invalid'}),LINEAR_ASSIGNMENT_ADMIN_EMAIL:'admin@test.invalid',
 sendJson:(_,status,__,payload)=>{response={status,payload};},sanitizeSingleLine:v=>String(v??'').trim(),
 listLinearAssignmentMembers:async()=>[{email:'other@test.invalid'}],writeLinearAssignmentPolicy:async policy=>{writes++;await writeFile(file,JSON.stringify(policy));}};
 await new AsyncFunction(...Object.keys(deps),code)(...Object.values(deps));
 return {...response,writes,original,saved:await readFile(file,'utf8')};
}
for(const body of ['{bad','{"mode":','null','[]','true','"creator"','{}','','   ','{"mode":"typo"}'])
 test(`invalid policy ${JSON.stringify(body)} cannot reset saved settings`,async t=>{const r=await request(t,body);assert.equal(r.status,400);assert.equal(r.writes,0);assert.equal(r.saved,r.original);});
test('oversized body returns 413 without writing',async t=>{const r=await request(t,'x'.repeat(65537));assert.equal(r.status,413);assert.equal(r.writes,0);assert.equal(r.saved,r.original);});
test('unauthorized malformed request still returns 403 without writing',async t=>{const r=await request(t,'{broken',false);assert.equal(r.status,403);assert.equal(r.writes,0);});
for(const mode of ['creator','weighted','unassigned']) test(`valid ${mode} policy saves once`,async t=>{const r=await request(t,JSON.stringify({mode,ownerWeight:100,otherEmails:[]}));assert.equal(r.status,200);assert.equal(r.writes,1);assert.equal(JSON.parse(r.saved).mode,mode);});

test('saving a policy excludes the creator from colleague shares',async t=>{
 const r=await request(t,JSON.stringify({mode:'weighted',ownerWeight:25,otherEmails:['ADMIN@test.invalid','other@test.invalid']}));
 assert.equal(r.status,200);assert.deepEqual(JSON.parse(r.saved).otherEmails,['other@test.invalid']);
});
