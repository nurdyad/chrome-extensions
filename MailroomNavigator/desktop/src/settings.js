const $=id=>document.getElementById(id);let initialized=false;
function status(text){$('status').textContent=text;}
function render(state){document.documentElement.classList.toggle('dark',state.dark);if(!initialized){for(const key of ['extensionId','theme','shortcut'])$(key).value=state[key];for(const key of ['alwaysOnTop','launchAtLogin'])$(key).checked=state[key];initialized=true;}status(state.shortcutError||state.bridgeError||state.bridge.status);}
$('settingsForm').addEventListener('submit',async event=>{event.preventDefault();try{const data={};for(const key of ['extensionId','theme','shortcut'])data[key]=$(key).value.trim();for(const key of ['alwaysOnTop','launchAtLogin'])data[key]=$(key).checked;const result=await window.desktop.save(data);render(result);status(result.shortcutError||'Saved. Copy the pairing key into the extension to connect.');}catch(e){status(e.message);}});
$('copyKey').addEventListener('click',()=>window.desktop.copyKey().then(()=>status('Pairing key copied. Paste it into the extension; do not share it.')).catch(e=>status(e.message)));
$('rotateKey').addEventListener('click',()=>{if(confirm('Disconnect Chrome and replace its pairing key?'))window.desktop.rotateKey().then(()=>status('Key replaced. Copy the new key and pair Chrome again.')).catch(e=>status(e.message));});
for(const id of ['reset','quit'])$(id).addEventListener('click',()=>window.desktop.window(id).catch(e=>status(e.message)));
window.desktop.onState(render);window.desktop.state().then(render).catch(e=>status(e.message));
