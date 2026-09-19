const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('desktop',Object.freeze({
    state:()=>ipcRenderer.invoke('desktop:state'),
    select:value=>ipcRenderer.invoke('desktop:select',value),
    action:id=>ipcRenderer.invoke('desktop:action',id),
    window:action=>ipcRenderer.invoke('desktop:window',action),
    save:value=>ipcRenderer.invoke('desktop:settings',value),
    copyKey:()=>ipcRenderer.invoke('desktop:copy-key'),
    rotateKey:()=>ipcRenderer.invoke('desktop:rotate-key'),
    onState:callback=>{const handler=(_,state)=>callback(state);ipcRenderer.on('desktop:state',handler);return ()=>ipcRenderer.removeListener('desktop:state',handler);}
}));
