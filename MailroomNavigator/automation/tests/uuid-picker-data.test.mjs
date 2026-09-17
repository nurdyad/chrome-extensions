import test from 'node:test';
import assert from 'node:assert/strict';
import { lookupOutcome, filterPickerRows } from '../../uuid-picker-data.mjs';
const rows = [
 {id:'a',raw:'alpha',date:'2026-09-17',batchItem:{result:{found:true,documentId:'123',status:'rejected',rejectionReason:'Patient inactive'}}},
 {id:'b',batchItem:{result:{found:false}}},
 {id:'c',batchItem:{error:'Service timeout'}},
 {id:'d',batchItem:{result:null}},
 {id:'e'}
];
test('failures are distinct from not-found, pending and unchecked rows',()=>{
 assert.deepEqual(rows.map(lookupOutcome),['found','not-found','failed','pending','unchecked']);
 assert.deepEqual(filterPickerRows(rows,{outcome:'failed'}).map(r=>r.id),['c']);
 assert.deepEqual(filterPickerRows(rows,{outcome:'not-found'}).map(r=>r.id),['b']);
});
test('outcome filter intersects text and date filters without changing source data',()=>{
 assert.equal(filterPickerRows(rows,{outcome:'failed',query:'alpha'}).length,0);
 assert.equal(filterPickerRows(rows,{query:'ALPHA',date:'09-17'}).length,1);
 assert.equal(filterPickerRows(rows).length,5);assert.equal(rows.length,5);
});
