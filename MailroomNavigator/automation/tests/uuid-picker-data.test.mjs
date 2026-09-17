import test from 'node:test';
import assert from 'node:assert/strict';
import { lookupOutcome, filterPickerRows, pickerStatusOptions, sortPickerRows } from '../../uuid-picker-data.mjs';
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

test('status choices include observed statuses and explicit pending/unchecked states',()=>{
 assert.deepEqual(pickerStatusOptions(rows).map(x=>x.value),['failed','not-found','pending','status:rejected','unchecked']);
 assert.deepEqual(filterPickerRows(rows,{status:'status:rejected'}).map(r=>r.id),['a']);
 assert.deepEqual(filterPickerRows(rows,{status:'pending'}).map(r=>r.id),['d']);
 assert.equal(filterPickerRows(rows,{status:'status:released'}).length,0);
 assert.equal(filterPickerRows(rows,{status:'pending',outcome:'failed'}).length,0);
});

test('batch-only rows can be found by document ID, status, reason or lookup error',()=>{
 for(const query of ['123','REJECTED','patient inactive'])assert.deepEqual(filterPickerRows(rows,{query}).map(r=>r.id),['a']);
 assert.deepEqual(filterPickerRows(rows,{query:'timeout'}).map(r=>r.id),['c']);
 const batchOnly=[{id:'uuid',batchItem:{result:{found:true,documentId:4860193,rejectionReason:'duplicate_letter',secret:'should-not-be-indexed'}}}];
 assert.equal(filterPickerRows(batchOnly,{query:'4860193'}).length,1);
 assert.equal(filterPickerRows(batchOnly,{query:'duplicate letter'}).length,1);
 assert.equal(filterPickerRows(batchOnly,{query:'should-not-be-indexed'}).length,0);
});

test('document sort is numeric and stable, missing values last; source order is recoverable',()=>{
 const fixtures=[{id:'missing'},{id:'ten',batchItem:{result:{found:true,documentId:'10',status:'released'}}},
 {id:'two',batchItem:{result:{found:true,documentId:'2',status:'rejected'}}},
 {id:'tie',batchItem:{result:{found:true,documentId:'2',status:'rejected'}}}];
 assert.deepEqual(sortPickerRows(fixtures,'document').map(r=>r.id),['two','tie','ten','missing']);
 assert.deepEqual(sortPickerRows(fixtures,'status').map(r=>r.id),['two','tie','ten','missing']);
 assert.deepEqual(sortPickerRows(fixtures).map(r=>r.id),['missing','ten','two','tie']);
 assert.equal(sortPickerRows(fixtures,'document')[0],fixtures[2]);
});
