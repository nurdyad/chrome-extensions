import './desktop/shared/protocol.js';
const P=globalThis.MailroomDesktopProtocol;
export function startDesktopPanel({tabId,getScope}) {
    let port=null,timer=null,disposed=false;const seen=new Set();
    const publish=()=>{try{port?.postMessage({type:'context',tabId,scope:P.scope(getScope())});}catch{}};
    async function connect(){
        if(disposed||port)return;
        const prefs=(await chrome.storage.local.get('mailroomDesktopCompanionV1')).mailroomDesktopCompanionV1;
        if(disposed||port||!prefs?.enabled)return;
        const current=chrome.runtime.connect({name:'mailroom-desktop-panel'});port=current;
        current.onMessage.addListener(message=>{
            if(port!==current || disposed)return;
            if(message?.type!=='command'||seen.has(message.requestId))return;
            seen.add(message.requestId);if(seen.size>200)seen.delete(seen.values().next().value);
            const action=P.actions.find(a=>a.id===message.action),scope=P.scope(getScope());
            const button=action && document.getElementById(action.button);
            let error='';
            if(message.scope!==scope||!P.permitted(message.action,scope)||!button||button.disabled)error='Practice changed or shortcut unavailable; select the target again';
            else button.click();
            // Existing handlers own navigation and report their own service errors.
            try{current.postMessage({type:'result',requestId:message.requestId,ok:!error,error});}catch{}
        });
        current.onDisconnect.addListener(()=>{void chrome.runtime.lastError;if(port!==current)return;port=null;if(!disposed)timer=setTimeout(()=>connect().catch(()=>{}),3000);});
        publish();
    }
    const changed=(changes,area)=>{
        if(area!=='local'||!changes.mailroomDesktopCompanionV1)return;
        if(!changes.mailroomDesktopCompanionV1.newValue?.enabled){port?.disconnect();port=null;clearTimeout(timer);}
        else connect().catch(()=>{});
    };
    chrome.storage.onChanged.addListener(changed);window.addEventListener('mailroom-practice-change',publish);
    const cleanup=()=>{disposed=true;clearTimeout(timer);port?.disconnect();chrome.storage.onChanged.removeListener(changed);window.removeEventListener('mailroom-practice-change',publish);};
    window.addEventListener('pagehide',cleanup,{once:true});connect().catch(()=>{});return cleanup;
}
