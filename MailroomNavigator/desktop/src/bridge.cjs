const {createServer}=require('node:http');
const {randomUUID,randomBytes,createHmac,timingSafeEqual}=require('node:crypto');
const {EventEmitter}=require('node:events');
const {WebSocketServer}=require('ws');
const P=require('../shared/protocol.js');
class DesktopBridge extends EventEmitter {
    constructor({token,extensionId,port=P.port,commandTimeout=10000}) {
        super();this.token=token;this.extensionId=extensionId;this.port=port;this.commandTimeout=commandTimeout;
        this.peer=null;this.contexts=[];this.pending=new Map();this.status='Waiting for Chrome';
    }
    snapshot(){return {connected:Boolean(this.peer?.authenticated),profile:this.peer?.profile||'',contexts:this.contexts,status:this.status};}
    publish(){this.emit('state',this.snapshot());}
    async start(){
        this.server=createServer((req,res)=>{res.writeHead(404,{'Cache-Control':'no-store'});res.end();});
        this.wss=new WebSocketServer({noServer:true,maxPayload:16384,perMessageDeflate:false});
        this.server.on('upgrade',(req,socket,head)=>{
            const valid=P.validExtensionId(this.extensionId) && req.headers.origin===`chrome-extension://${this.extensionId}`
                && req.headers.host===`127.0.0.1:${this.port}` && req.url==='/bridge';
            if(!valid || this.wss.clients.size>=4){socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return;}
            this.wss.handleUpgrade(req,socket,head,ws=>this.accept(ws));
        });
        await new Promise((resolve,reject)=>{this.server.once('error',reject);this.server.listen(this.port,'127.0.0.1',()=>{this.port=this.server.address().port;resolve();});});
        this.server.on('error',()=>{this.status='Desktop bridge unavailable';this.publish();});
        return this.port;
    }
    accept(ws){
        ws.on('error',()=>{});
        const challenge=randomBytes(32).toString('hex');
        ws.send(JSON.stringify({type:'challenge',protocol:P.version,challenge}));
        const authTimer=setTimeout(()=>ws.close(1008,'Pairing required'),3000);authTimer.unref();
        let lastSeen=Date.now();
        const heartbeat=setInterval(()=>{if(Date.now()-lastSeen>45000)ws.terminate();},15000);heartbeat.unref();
        ws.on('message',raw=>{
            lastSeen=Date.now();let message;
            try{message=JSON.parse(raw.toString());}catch{return ws.close(1008,'Invalid message');}
            if(!message || typeof message!=='object' || Array.isArray(message))return ws.close(1008,'Invalid message');
            if(!ws.authenticated){
                const valid=message.type==='hello' && message.protocol===P.version && P.validToken(message.proof) && P.validToken(message.nonce)
                    && /^[a-zA-Z0-9-]{1,80}$/.test(message.clientId||'')
                    && timingSafeEqual(Buffer.from(message.proof),Buffer.from(createHmac('sha256',this.token).update(`${challenge}:${message.nonce}:${P.version}:${message.clientId}`).digest('hex')));
                if(!valid)return ws.close(1008,'Pairing or protocol mismatch');
                if(this.peer && this.peer!==ws)return ws.close(1008,'Another Chrome profile is connected; disconnect it first');
                clearTimeout(authTimer);ws.authenticated=true;ws.profile=String(message.profile||'Chrome').replace(/[\x00-\x1f]/g,'').slice(0,40);
                this.peer=ws;this.status='Chrome connected';ws.send(JSON.stringify({type:'ready',protocol:P.version,proof:createHmac('sha256',this.token).update(`desktop:${challenge}:${message.nonce}`).digest('hex')}));this.publish();return;
            }
            if(message.type==='ping'){ws.send(JSON.stringify({type:'pong'}));return;}
            if(message.type==='contexts'){
                if(!Array.isArray(message.contexts)||message.contexts.length>30)return ws.close(1008,'Invalid contexts');
                const contexts=message.contexts.map(P.context);if(contexts.some(x=>!x)||new Set(contexts.map(x=>x.id)).size!==contexts.length)return ws.close(1008,'Invalid context');
                this.contexts=contexts;this.publish();return;
            }
            if(message.type==='result'){
                const pending=this.pending.get(message.requestId);if(!pending)return;
                clearTimeout(pending.timer);this.pending.delete(message.requestId);
                message.ok===true?pending.resolve():pending.reject(Error(String(message.error||'Chrome action failed').slice(0,160)));return;
            }
            ws.close(1008,'Unknown message');
        });
        ws.on('close',()=>{
            clearTimeout(authTimer);clearInterval(heartbeat);
            if(this.peer!==ws)return;
            this.peer=null;this.contexts=[];this.status='Chrome disconnected — reconnect in extension settings';
            for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(Error('Chrome disconnected; action was not retried'));}
            this.pending.clear();this.publish();
        });
    }
    run(action,selected){
        if(!this.peer?.authenticated || this.peer.readyState!==1)return Promise.reject(Error('Connect Chrome first'));
        const context=this.contexts.find(c=>c.id===selected?.id && c.revision===selected?.revision);
        if(!context || !P.permitted(action,context.scope))return Promise.reject(Error('Choose a current tab and practice first'));
        if(this.pending.size)return Promise.reject(Error('Wait for the current action'));
        const requestId=randomUUID();
        return new Promise((resolve,reject)=>{
            const timer=setTimeout(()=>{this.pending.delete(requestId);reject(Error('Chrome did not confirm; check the browser before trying again'));},this.commandTimeout);
            this.pending.set(requestId,{resolve,reject,timer});
            this.peer.send(JSON.stringify({type:'command',protocol:P.version,requestId,action,contextId:context.id,revision:context.revision,scope:context.scope}));
        });
    }
    disconnect(){for(const ws of this.wss?.clients||[])ws.close(1008,'Disconnected by desktop user');}
    async close(){this.disconnect();for(const ws of this.wss?.clients||[])ws.terminate();if(this.server)await new Promise(resolve=>this.server.close(resolve));this.wss?.close();}
}
module.exports={DesktopBridge};
