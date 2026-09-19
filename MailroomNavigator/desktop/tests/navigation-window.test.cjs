const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const {readFileSync}=require('node:fs');
const source=readFileSync(require.resolve('../../background.js'),'utf8');
const find=source.slice(source.indexOf('async function findAndFocusPracticeTab('),source.indexOf('async function clickLiveViewTab('));
const open=source.slice(source.indexOf('async function handleOpenPractice('),source.indexOf('async function getPracticeAdminTabForEhrSettings('));
function harness(tabs){
 const updates=[],created=[];
 const context=vm.createContext({chrome:{tabs:{query:async()=>tabs,update:async id=>updates.push(id),create:async options=>{created.push(options);return {id:99};}},windows:{update:async()=>{}}},
 buildPracticeAdminUrl:ods=>`https://app.betterletter.ai/admin_panel/practices/${ods}`,getTabUrl:tab=>tab.url,
 isPracticeAdminRootUrl:(url,ods)=>url.endsWith('/'+ods),waitForTabComplete:async()=>{},clickLiveViewTab:async()=>{}});
 vm.runInContext(find+open,context);return {context,updates,created};
}
test('practice shortcuts reuse only an exact practice tab in the intended window',async()=>{
 const h=harness([{id:1,windowId:10,url:'https://app.betterletter.ai/admin_panel/practices/A12345'}, {id:2,windowId:20,url:'https://app.betterletter.ai/admin_panel/practices/A12345'}]);
 await h.context.handleOpenPractice('A12345','ehr_settings',20);assert.deepEqual(h.updates,[2]);assert.equal(h.created.length,0);
});
test('practice shortcut opens in the intended window when only another window has a match',async()=>{
 const h=harness([{id:1,windowId:10,url:'https://app.betterletter.ai/admin_panel/practices/A12345'}]);
 await h.context.handleOpenPractice('A12345','task_recipients',20);assert.deepEqual(h.updates,[]);assert.equal(h.created[0].windowId,20);
});
