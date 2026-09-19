const $=id=>document.getElementById(id);
const paths={box:'M3 5l5-3 5 3v6l-5 3-5-3z M3 5l5 3 5-3 M8 8v6',grid:'M2 2h5v5H2z M9 2h5v5H9z M2 9h5v5H2z M9 9h5v5H9z',clock:'M8 4v4l3 2 M14 8a6 6 0 1 1-12 0 6 6 0 0 1 12 0',x:'M4 4l8 8 M12 4l-8 8',settings:'M3 3h10v10H3z M8 5v6 M5 8h6',users:'M7 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6 M2 14v-2c0-4 10-4 10 0v2 M13 4v5 M11 6.5h4',mail:'M2 3h12v10H2z M2 3l6 6 6-6',flag:'M3 14V2 M3 2h10v7H3',arrow:'M3 13L13 3 M8 3h5v5 M3 3l3 3 M10 10l3 3',clipboard:'M5 3H3v11h10V3h-2 M5 2h6v3H5z'};
let state,busy=false;
function message(text){$('feedback').textContent=text;}
function render(next){
 state=next;document.documentElement.classList.toggle('dark',next.dark);
 $('connection').textContent=next.bridge.connected?next.bridge.profile:'Disconnected';$('connection').classList.toggle('connected',next.bridge.connected);
 $('pin').setAttribute('aria-pressed',String(next.alwaysOnTop));
 const select=$('context');const options=[new Option(next.bridge.connected?'Choose a tab and practice…':'Connect Chrome in Settings','')];
 for(const c of next.bridge.contexts)options.push(new Option(`${next.bridge.profile} · ${c.label}`,c.id));
 select.replaceChildren(...options);select.value=next.selected?.id||'';
 const context=next.bridge.contexts.find(c=>c.id===next.selected?.id && c.revision===next.selected?.revision);
 if(!$('actions').children.length)for(const a of next.actions){
  const button=document.createElement('button');button.dataset.action=a.id;button.title=a.label;button.setAttribute('aria-label',a.label);
  button.innerHTML=`<svg viewBox="0 0 16 16" aria-hidden="true"><path d="${paths[a.icon]||paths.box}"/></svg>`;
  button.addEventListener('click',async()=>{busy=true;render(state);message(`Opening ${a.label}…`);try{await window.desktop.action(a.id);message('Sent to the selected Chrome tab.');}catch(error){message(error.message);}finally{busy=false;render(state);}});$('actions').append(button);
 }
 for(const a of next.actions){const allowed=context && (!a.requires || (a.requires==='scope' && context.scope) || /^[A-Z]\d{5}$/.test(context.scope));document.querySelector(`[data-action="${a.id}"]`).disabled=busy||!allowed;}
 if(!next.bridge.connected)message(next.bridgeError||next.bridge.status);
 else if(!context)message('Open Navigator in Chrome, select a practice, then choose that tab here.');
}
$('context').addEventListener('change',async()=>{const c=state.bridge.contexts.find(c=>c.id===$('context').value);try{render(await window.desktop.select(c?{id:c.id,revision:c.revision}:null));}catch(e){message(e.message);}});
for(const action of ['hide','settings','pin'])$(action).addEventListener('click',()=>window.desktop.window(action).catch(e=>message(e.message)));
$('move').addEventListener('keydown',event=>{const actions={ArrowLeft:'move:left',ArrowRight:'move:right',ArrowUp:'move:up',ArrowDown:'move:down',Home:'reset'};if(actions[event.key]){event.preventDefault();window.desktop.window(actions[event.key]).catch(e=>message(e.message));}});
window.desktop.onState(render);window.desktop.state().then(render).catch(e=>message(e.message));
