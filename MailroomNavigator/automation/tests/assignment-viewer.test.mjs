import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../linear-trigger-server.mjs',import.meta.url),'utf8');
const code=source.slice(source.indexOf('async function resolveLinearViewer()'),source.indexOf('async function listLinearAssignmentMembers()'));
function resolve(viewer) {
 return new Function('runLinearGraphqlRequest','sanitizeSingleLine',code+'return resolveLinearViewer();')(
  async()=>({viewer}),v=>String(v??'').trim());
}
for(const active of [false,undefined,null])test(`viewer active=${active} cannot be selected`,async()=>{
 await assert.rejects(resolve({id:'owner',active}),/active account's API key/);
});
test('active viewer is normalized and returned',async()=>{
 assert.deepEqual(await resolve({id:'owner',name:' Owner ',email:'OWNER@test.invalid',active:true}),
 {id:'owner',name:'Owner',email:'owner@test.invalid',active:true});
});
test('missing viewer is an identification error',async()=>{
 await assert.rejects(resolve(null),/identify the current Linear user/);
});
