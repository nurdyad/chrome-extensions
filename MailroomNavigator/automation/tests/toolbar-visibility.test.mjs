import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const source = readFileSync(new URL('../../background.js', import.meta.url), 'utf8');
const start = source.indexOf('function setMailroomToolbarsVisibility(');
const end = source.indexOf('async function toggleMailroomToolbars(', start);
function page({ blocked = false, focused = false } = {}) {
    const storage = new Map();
    const style = new Map();
    let restored = 0, bodyFocused = 0;
    const active = {isConnected:true,getClientRects:()=>[{}],focus:()=>restored++};
    const dock = {dataset:{},contains:()=>focused,style:{setProperty:(k,v)=>style.set(k,v),removeProperty:k=>style.delete(k)}};
    const window = {sessionStorage:{getItem:k=>{if(blocked)throw Error();return storage.get(k);},setItem:(k,v)=>{if(blocked)throw Error();storage.set(k,v);}}};
    const document = {activeElement:active,getElementById:()=>dock,body:{getAttribute:()=>null,setAttribute(){},removeAttribute(){},focus:()=>bodyFocused++}};
    const toggle = new Function('document','window',source.slice(start,end)+'return setMailroomToolbarsVisibility;')(document,window);
    return {toggle,style,storage,dock,focus:()=>({restored,bodyFocused})};
}
test('toggle hides the entire dock then restores it without changing panel classes',()=>{
    const p=page();assert.equal(p.toggle().hidden,true);assert.equal(p.style.get('display'),'none');
    assert.equal(p.toggle().hidden,false);assert.equal(p.style.has('display'),false);
});
test('show provides idempotent mouse recovery and restore reuses saved visibility',()=>{
    const p=page();p.toggle();assert.equal(p.toggle('restore').hidden,true);
    assert.equal(p.toggle('show').hidden,false);assert.equal(p.toggle('show').hidden,false);
});
test('tab state is independent and storage failures permit in-memory toggling',()=>{
    const a=page(),b=page();a.toggle();assert.equal(b.toggle('restore').hidden,false);
    const c=page({blocked:true});assert.equal(c.toggle().hidden,true);assert.equal(c.toggle().hidden,false);
});
test('focus exits hidden dock and returns when shown',()=>{
    const p=page({focused:true});p.toggle();assert.equal(p.focus().bodyFocused,1);
    p.toggle();assert.equal(p.focus().restored,1);
});
test('manifest includes a configurable shortcut distinct from live summary',()=>{
    const manifest=JSON.parse(readFileSync(new URL('../../manifest.json',import.meta.url)));
    assert.equal(manifest.commands.toggle_mailroom_toolbars.suggested_key.default,'Alt+Shift+H');
    assert.notEqual(manifest.commands.show_live_dashboard_summary.suggested_key.default,'Alt+Shift+H');
});
