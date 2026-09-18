import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../../background.js',import.meta.url),'utf8');
const code=source.slice(source.indexOf('            function makeToolbarDraggable'),source.indexOf('            const ensurePageToolbarMounted'));
function harness({saved=null,blocked=false}={}){
 const stored=new Map(saved?[['__BL_TOOLBAR_POSITION_V1__',JSON.stringify(saved)]]:[]),listeners=new Map();
 let resizeCallback,width=200;
 const element=()=>{const events=new Map();return {events,style:{removeProperty(k){delete this[k];}},classList:{add(){},remove(){}},setAttribute(){},addEventListener(k,fn){events.set(k,fn);},closest(){return this;}};};
 const grip=element(),toolbar=element();let capture=null;
 Object.assign(toolbar,{isConnected:true,prepend(){},getBoundingClientRect:()=>({left:parseFloat(toolbar.style.left)||400,top:parseFloat(toolbar.style.top)||8,width,height:44}),setPointerCapture:id=>capture=id,hasPointerCapture:id=>capture===id,releasePointerCapture:()=>capture=null});
 const window={innerWidth:1000,innerHeight:700,localStorage:{getItem:k=>{if(blocked)throw Error();return stored.get(k)||null;},setItem:(k,v)=>{if(blocked)throw Error();stored.set(k,v);},removeItem:k=>{if(blocked)throw Error();stored.delete(k);}},addEventListener:(k,f)=>listeners.set(k,f),removeEventListener:k=>listeners.delete(k)};
 const document={createElement:()=>grip};
 class ResizeObserver{constructor(fn){resizeCallback=fn;}observe(){}disconnect(){}}
 const install=new Function('window','document','ResizeObserver',code+'return makeToolbarDraggable;')(window,document,ResizeObserver);install(toolbar);
 const fire=(el,type,extra={})=>el.events.get(type)?.({button:0,pointerId:1,clientX:410,clientY:15,target:grip,preventDefault(){},...extra});
 return {toolbar,grip,stored,window,fire,resize:()=>resizeCallback(),setWidth:v=>width=v};
}
test('drag moves and persists the toolbar; shortcut buttons never start a drag',()=>{
 const h=harness();h.fire(h.toolbar,'pointerdown');h.fire(h.toolbar,'pointermove',{clientX:510,clientY:115});h.fire(h.toolbar,'pointerup');
 assert.equal(h.toolbar.style.left,'500px');assert.equal(h.toolbar.style.top,'108px');
 assert.deepEqual(JSON.parse([...h.stored.values()][0]),{x:500,y:108});
 h.fire(h.toolbar,'pointerdown',{target:{closest:()=>({})}});h.fire(h.toolbar,'pointermove',{clientX:800});assert.equal(h.toolbar.style.left,'500px');
});
test('saved coordinates clamp on load, resize and width expansion',()=>{
 const h=harness({saved:{x:9999,y:-100}});assert.equal(h.toolbar.style.left,'792px');assert.equal(h.toolbar.style.top,'8px');
 h.window.innerWidth=600;h.resize();assert.equal(h.toolbar.style.left,'392px');
 h.setWidth(300);h.resize();assert.equal(h.toolbar.style.left,'292px');
});
test('cancelled drag restores its starting position without saving',()=>{
 const h=harness();h.fire(h.toolbar,'pointerdown');h.fire(h.toolbar,'pointermove',{clientX:900});h.fire(h.toolbar,'pointercancel');
 assert.equal(h.toolbar.style.left,undefined);assert.equal(h.stored.size,0);
});
test('keyboard movement and reset work even if storage is blocked',()=>{
 const h=harness({blocked:true});h.fire(h.grip,'keydown',{key:'ArrowDown'});assert.equal(h.toolbar.style.top,'18px');
 h.fire(h.grip,'keydown',{key:'ArrowRight',shiftKey:true});assert.equal(h.toolbar.style.left,'401px');
 h.fire(h.grip,'keydown',{key:'Home'});assert.equal(h.toolbar.style.left,undefined);assert.equal(h.toolbar.style.top,undefined);
});
test('hidden toolbar retains saved position until visible; double-click resets it',()=>{
 const h=harness({saved:{x:300,y:100}});h.setWidth(0);h.resize();assert.equal(h.toolbar.style.left,'300px');
 h.setWidth(200);h.resize();h.fire(h.grip,'dblclick');assert.equal(h.stored.size,0);assert.equal(h.toolbar.style.transform,undefined);
});
