/* Optional service-worker bridge. No connection is made until the user pairs. */
(function() {
    const P=globalThis.MailroomDesktopProtocol;
    const KEY='mailroomDesktopCompanionV1',STATUS='mailroomDesktopCompanionStatusV1',ALARM='mailroomDesktopReconnect';
    const panels=new Map(),pending=new Map(),seen=new Set();
    let authenticatedSocket=null;
    let socket=null,reconnect=null,heartbeat=null,connecting=false,generation=0;
    const hmac=async(token,text)=>{const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(token),{name:'HMAC',hash:'SHA-256'},false,['sign']);return [...new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(text)))].map(b=>b.toString(16).padStart(2,'0')).join('');};
    const setStatus=status=>chrome.storage.local.set({[STATUS]:status}).catch(()=>{});
    const send=message=>{if(socket && socket===authenticatedSocket && socket.readyState===WebSocket.OPEN)socket.send(JSON.stringify(message));};
    const contexts=()=>[...panels.values()].filter(p=>p.valid).slice(0,30).map(p=>({id:p.id,revision:p.revision,tabId:p.tabId,windowId:p.windowId,scope:p.scope}));
    const publish=()=>send({type:'contexts',contexts:contexts()});
    const panelError=(requestId,error)=>{const task=pending.get(requestId);if(!task)return;clearTimeout(task.timer);pending.delete(requestId);send({type:'result',requestId,ok:false,error});};
    async function validatePanel(panel){
        try{
            const tab=await chrome.tabs.get(panel.tabId);
            panel.valid=Boolean(tab && !tab.incognito && /^https:\/\/app\.betterletter\.ai\//.test(tab.url||'') && (!panel.url || panel.url===tab.url));
            panel.url=tab.url;panel.windowId=tab.windowId;
        }catch{panel.valid=false;}
    }
    chrome.runtime.onConnect.addListener(port=>{
        if(port.name!=='mailroom-desktop-panel' || port.sender?.id!==chrome.runtime.id
            || !port.sender.url?.startsWith(chrome.runtime.getURL('panel.html')))return;
        const id=crypto.randomUUID();const panel={id,port,revision:1,scope:'',tabId:-1,windowId:-1,valid:false};panels.set(id,panel);
        port.onMessage.addListener(async message=>{
            if(message?.type==='context'){
                const tabId=port.sender.tab?.id ?? message.tabId;
                if(!Number.isInteger(tabId)||tabId<0)return;
                const scope=P.scope(message.scope);if(scope!==panel.scope || tabId!==panel.tabId){panel.revision++;panel.scope=scope;panel.tabId=tabId;}
                await validatePanel(panel);publish();
            }else if(message?.type==='result'){
                const task=pending.get(message.requestId);if(!task || task.panel!==panel)return;
                clearTimeout(task.timer);pending.delete(message.requestId);
                send({type:'result',requestId:message.requestId,ok:message.ok===true,error:message.ok===true?'':String(message.error||'Panel action failed').slice(0,160)});
            }
        });
        port.onDisconnect.addListener(()=>{panels.delete(id);for(const [requestId,task] of pending)if(task.panel===panel)panelError(requestId,'Navigator closed; action was not retried');publish();});
    });
    chrome.tabs.onUpdated.addListener((id,change)=>{
        if(!change.url && change.status!=='loading')return;
        for(const panel of panels.values())if(panel.tabId===id){panel.valid=false;panel.revision++;for(const [requestId,task] of pending)if(task.panel===panel)panelError(requestId,'Target tab navigated; choose it again');}
        publish();
    });
    chrome.tabs.onRemoved.addListener(id=>{for(const p of panels.values())if(p.tabId===id){p.valid=false;p.revision++;}publish();});
    async function command(message,source){
        if(message.protocol!==P.version || typeof message.requestId!=='string' || message.requestId.length>80 || seen.has(message.requestId))return;
        seen.add(message.requestId);if(seen.size>200)seen.delete(seen.values().next().value);
        const panel=panels.get(message.contextId);
        if(panel)await validatePanel(panel);
        if(source!==socket || source!==authenticatedSocket)return;
        if(!panel?.valid || message.revision!==panel.revision || message.scope!==panel.scope || !P.permitted(message.action,panel.scope)){
            send({type:'result',requestId:message.requestId,ok:false,error:'Tab or practice changed; select the target again'});publish();return;
        }
        if(pending.size){send({type:'result',requestId:message.requestId,ok:false,error:'Another action is pending'});return;}
        const timer=setTimeout(()=>panelError(message.requestId,'Navigator did not confirm; check Chrome before retrying'),8000);
        pending.set(message.requestId,{panel,timer});
        try{panel.port.postMessage({type:'command',requestId:message.requestId,action:message.action,scope:panel.scope});}
        catch{panelError(message.requestId,'Navigator disconnected');}
    }
    function stop(){
        generation++;connecting=false;clearTimeout(reconnect);clearInterval(heartbeat);reconnect=null;heartbeat=null;
        const old=socket;socket=null;authenticatedSocket=null;old?.close();
        for(const task of pending.values())clearTimeout(task.timer);pending.clear();seen.clear();
    }
    async function connect(){
        if(connecting||socket)return;connecting=true;const current=generation;
        try{
            const prefs=(await chrome.storage.local.get(KEY))[KEY];
            if(current!==generation)return;
            if(!prefs?.enabled || !P.validToken(prefs.token)){await chrome.alarms.clear(ALARM);setStatus('Desktop companion disabled');return;}
            await chrome.alarms.create(ALARM,{periodInMinutes:1});
            const ws=new WebSocket(`ws://127.0.0.1:${P.port}/bridge`);socket=ws;
            const authTimeout=setTimeout(()=>ws.close(),5000);
            let authenticated=false,challenge='',nonce='';
            ws.onopen=()=>{if(current!==generation)ws.close();};
            ws.onmessage=async event=>{
                if(ws!==socket)return;
                let message;try{if(event.data.length>16384)throw Error();message=JSON.parse(event.data);}catch{return ws.close();}
                if(!message || typeof message!=='object')return ws.close();
                if(message.type==='challenge' && !challenge){
                    if(message.protocol!==P.version || !P.validToken(message.challenge))return ws.close();
                    challenge=message.challenge;nonce=[...crypto.getRandomValues(new Uint8Array(32))].map(b=>b.toString(16).padStart(2,'0')).join('');
                    const proof=await hmac(prefs.token,`${challenge}:${nonce}:${P.version}:${prefs.clientId}`);
                    if(ws!==socket||ws.readyState!==WebSocket.OPEN)return;
                    ws.send(JSON.stringify({type:'hello',protocol:P.version,nonce,proof,clientId:prefs.clientId,profile:prefs.profile||'Chrome'}));return;
                }
                if(message.type==='ready' && challenge){
                    if(message.proof!==await hmac(prefs.token,`desktop:${challenge}:${nonce}`)){setStatus('Desktop authentication failed');ws.close();return;}
                    if(ws!==socket)return;
                    authenticated=true;authenticatedSocket=ws;
                    if(message.protocol!==P.version){setStatus('Desktop protocol mismatch; update both components');ws.close();return;}
                    clearTimeout(authTimeout);setStatus('Connected to desktop companion');publish();
                    clearInterval(heartbeat);heartbeat=setInterval(()=>send({type:'ping'}),20000);
                }else if(message.type==='command' && authenticated)command(message,ws).catch(()=>send({type:'result',requestId:message.requestId,ok:false,error:'Desktop action failed'}));
            };
            ws.onerror=()=>setStatus('Desktop app unavailable — open it and check pairing settings');
            ws.onclose=event=>{
                clearTimeout(authTimeout);if(ws!==socket)return;socket=null;authenticatedSocket=null;clearInterval(heartbeat);
                for(const task of pending.values())clearTimeout(task.timer);pending.clear();
                setStatus(event.code===1008?'Pairing rejected or another profile is connected. Check the desktop app.':'Desktop disconnected — reconnecting');
                reconnect=setTimeout(()=>connect(),5000);
            };
        }catch{setStatus('Could not connect desktop companion');}
        finally{if(current===generation)connecting=false;}
    }
    chrome.storage.onChanged.addListener((changes,area)=>{if(area==='local'&&changes[KEY]){stop();connect();}});
    chrome.alarms.onAlarm.addListener(alarm=>{if(alarm.name===ALARM)connect();});
    chrome.runtime.onStartup.addListener(connect);
    chrome.runtime.onMessage.addListener((message,sender,reply)=>{
        if(message?.action!=='desktopCompanionSettings')return false;
        if(sender.id!==chrome.runtime.id || sender.url!==chrome.runtime.getURL('desktop-settings.html')){reply({success:false,error:'Open desktop settings in the extension'});return false;}
        (async()=>{
            if(message.disable){await chrome.storage.local.remove(KEY);return {success:true};}
            if(!P.validToken(message.token)||typeof message.profile!=='string'||!message.profile.trim())throw Error('Paste the 64-character pairing key and enter a profile label');
            const old=(await chrome.storage.local.get(KEY))[KEY];
            await chrome.storage.local.set({[KEY]:{enabled:true,token:message.token,profile:message.profile.trim().slice(0,40),clientId:old?.clientId||crypto.randomUUID()}});
            return {success:true};
        })().then(reply,error=>reply({success:false,error:error.message}));return true;
    });
    connect();
})();
