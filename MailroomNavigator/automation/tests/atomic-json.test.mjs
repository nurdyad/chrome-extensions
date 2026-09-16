import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {writeJsonAtomic} from '../atomic-json.mjs';
async function fixture(t){const dir=await fs.mkdtemp(join(tmpdir(),'policy-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const path=join(dir,'policy.json');await fs.writeFile(path,JSON.stringify({mode:'creator'}));return {dir,path};}
test('replaces existing JSON and leaves no temporary files',async t=>{
 const {dir,path}=await fixture(t);await writeJsonAtomic(path,{mode:'weighted'});
 assert.deepEqual(JSON.parse(await fs.readFile(path,'utf8')),{mode:'weighted'});assert.deepEqual(await fs.readdir(dir),['policy.json']);
});
test('failed publication preserves old policy and removes temporary file',async t=>{
 const {dir,path}=await fixture(t);await assert.rejects(writeJsonAtomic(path,{mode:'weighted'},{...fs,rename:async()=>{throw Error('rename failed');}}),/rename failed/);
 assert.equal(JSON.parse(await fs.readFile(path,'utf8')).mode,'creator');assert.deepEqual(await fs.readdir(dir),['policy.json']);
});
test('partial staged write cannot corrupt the published policy',async t=>{
 const {dir,path}=await fixture(t);
 await assert.rejects(writeJsonAtomic(path,{mode:'weighted'},{...fs,open:async(...args)=>{
  const h=await fs.open(...args);return {writeFile:async()=>{await h.writeFile('{');throw Error('disk full');},sync:()=>h.sync(),close:()=>h.close()};
 }}),/disk full/);
 assert.equal(JSON.parse(await fs.readFile(path,'utf8')).mode,'creator');assert.deepEqual(await fs.readdir(dir),['policy.json']);
});
test('readers see valid old or new JSON during replacement',async t=>{
 const {path}=await fixture(t);let finished=false;const observed=[];
 const reader=(async()=>{while(!finished) observed.push(JSON.parse(await fs.readFile(path,'utf8')).mode);})();
 try{for(let i=0;i<20;i++)await writeJsonAtomic(path,{mode:i%2?'creator':'weighted',padding:'x'.repeat(10000)});}finally{finished=true;await reader;}
 assert.ok(observed.length>0);assert.ok(observed.every(mode=>['creator','weighted'].includes(mode)));
});
test('process exit before rename preserves old policy and next write recovers',async t=>{
 const {path}=await fixture(t);const moduleUrl=new URL('../atomic-json.mjs',import.meta.url).href;
 const child=spawnSync(process.execPath,['--input-type=module','-e',`import * as fs from 'node:fs/promises';import {writeJsonAtomic} from ${JSON.stringify(moduleUrl)};await writeJsonAtomic(${JSON.stringify(path)},{mode:'weighted'},{...fs,rename:async()=>process.exit(23)});`]);
 assert.equal(child.status,23);assert.equal(JSON.parse(await fs.readFile(path,'utf8')).mode,'creator');
 await writeJsonAtomic(path,{mode:'unassigned'});assert.equal(JSON.parse(await fs.readFile(path,'utf8')).mode,'unassigned');
});
