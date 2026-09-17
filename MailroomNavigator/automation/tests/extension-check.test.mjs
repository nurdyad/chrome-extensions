import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const checker=fileURLToPath(new URL('../check-extension.mjs',import.meta.url));
test('check command rejects syntax errors, invalid versions and missing assets',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'extension-check-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const manifest={manifest_version:3,name:'fixture',version:'1.2.3',background:{service_worker:'worker.js'}};
 const writeManifest=()=>writeFile(join(dir,'manifest.json'),JSON.stringify(manifest));
 const check=()=>spawnSync(process.execPath,[checker,dir],{encoding:'utf8'});
 await writeManifest();await writeFile(join(dir,'worker.js'),'const valid = true;');assert.equal(check().status,0);
 await writeFile(join(dir,'worker.js'),'const broken = ;');let result=check();assert.notEqual(result.status,0);assert.match(result.stderr,/worker.js/);
 await writeFile(join(dir,'worker.js'),'export const valid = true;');manifest.version='1.02.3';await writeManifest();assert.match(check().stderr,/invalid Chrome extension version/);
 manifest.version='1.2.3';manifest.background.service_worker='absent.js';await writeManifest();assert.notEqual(check().status,0);
});
