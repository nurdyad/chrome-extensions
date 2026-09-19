const test=require('node:test');const assert=require('node:assert/strict');const {clampBounds}=require('../src/bounds.cjs');const P=require('../shared/protocol.js');
const displays=[{x:0,y:24,width:1440,height:876},{x:-1920,y:0,width:1920,height:1080}];
test('negative monitor coordinates are preserved',()=>assert.deepEqual(clampBounds({x:-1200,y:300},displays),{x:-1200,y:300,width:540,height:132}));
test('disconnected displays recover to primary work area',()=>{const b=clampBounds({x:4000,y:4000},displays);assert.equal(b.x,450);assert.equal(b.y,40);});
test('edge and scaling changes keep the whole toolbar on the work area',()=>{const b=clampBounds({x:1300,y:850},displays);assert.equal(b.x,900);assert.equal(b.y,768);});
test('invalid coordinates and smaller displays are handled',()=>{const b=clampBounds({x:NaN,y:Infinity},[{x:0,y:0,width:400,height:100}]);assert.deepEqual(b,{x:0,y:0,width:400,height:100});});
test('scope allowlist distinguishes all-practice from practice-only navigation',()=>{assert.equal(P.permitted('settings','ALL'),false);assert.equal(P.permitted('collection','ALL'),true);assert.equal(P.permitted('letters',''),true);assert.equal(P.permitted('settings','A12345'),true);assert.equal(P.permitted('unknown','A12345'),false);});
