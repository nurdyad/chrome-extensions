const {app,BrowserWindow,ipcMain,Tray,Menu,nativeImage,nativeTheme,globalShortcut,screen,clipboard,safeStorage,dialog,session}=require('electron');
const {readFileSync,writeFileSync,renameSync,mkdirSync}=require('node:fs');
const {join}=require('node:path');
const {pathToFileURL}=require('node:url');
const {randomBytes}=require('node:crypto');
const {DesktopBridge}=require('./bridge.cjs');
const {clampBounds}=require('./bounds.cjs');
const P=require('../shared/protocol.js');
let toolbar,settingsWindow,tray,bridge,config={},token,selected=null,quitting=false,shortcut='',shortcutError='',bridgeError='',saveTimer;
const settingsPath=()=>join(app.getPath('userData'),'settings.json');
const file=name=>join(__dirname,name);
function persist(){
    mkdirSync(app.getPath('userData'),{recursive:true});
    const temp=settingsPath()+'.tmp';
    writeFileSync(temp,JSON.stringify(config,null,2),{mode:0o600});renameSync(temp,settingsPath());
}
function load(){
    try{config=JSON.parse(readFileSync(settingsPath(),'utf8'));}catch(error){if(error.code!=='ENOENT')throw Error('Desktop settings cannot be read. Restore your settings backup before retrying.');}
    if(!safeStorage.isEncryptionAvailable())throw Error('The operating system credential store is unavailable. Unlock your session and try again.');
    if(config.encryptedToken){try{token=safeStorage.decryptString(Buffer.from(config.encryptedToken,'base64'));}catch{throw Error('Pairing key cannot be unlocked. Restore access to the operating system credential store.');}}
    if(!P.validToken(token))rotateToken();
    config.alwaysOnTop=config.alwaysOnTop!==false;config.theme=['system','light','dark'].includes(config.theme)?config.theme:'system';
    config.shortcut=typeof config.shortcut==='string'?config.shortcut:'Alt+Shift+Space';
    config.extensionId=P.validExtensionId(config.extensionId)?config.extensionId:'';
    config.launchAtLogin=config.launchAtLogin===true;persist();
}
function rotateToken(){token=randomBytes(32).toString('hex');config.encryptedToken=safeStorage.encryptString(token).toString('base64');}
function snapshot(){
    return {version:app.getVersion(),protocol:P.version,actions:P.actions,bridge:bridge?.snapshot()||{connected:false,contexts:[],status:bridgeError||'Starting'},
        selected,theme:config.theme,dark:nativeTheme.shouldUseDarkColors,alwaysOnTop:config.alwaysOnTop,shortcut:config.shortcut,shortcutError,bridgeError,
        extensionId:config.extensionId,launchAtLogin:config.launchAtLogin};
}
function broadcast(){for(const win of [toolbar,settingsWindow])if(win && !win.isDestroyed())win.webContents.send('desktop:state',snapshot());}
function harden(win){
    win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    win.webContents.on('will-navigate',event=>event.preventDefault());
    win.webContents.on('will-attach-webview',event=>event.preventDefault());
}
function recoverPosition(reset=false){
    if(!toolbar)return;
    toolbar.setBounds(clampBounds(reset?null:toolbar.getBounds(),[screen.getPrimaryDisplay(),...screen.getAllDisplays().filter(d=>d.id!==screen.getPrimaryDisplay().id)]));
    config.bounds=toolbar.getBounds();persist();
}
function show(){recoverPosition();toolbar.show();}
function toggle(){toolbar.isVisible()?toolbar.hide():show();}
function configureShortcut(){
    if(shortcut)globalShortcut.unregister(shortcut);shortcut='';shortcutError='';
    if(!config.shortcut)return;
    try{if(globalShortcut.register(config.shortcut,toggle))shortcut=config.shortcut;else shortcutError='Shortcut is already in use. Choose another or use the tray/menu-bar icon.';}
    catch{shortcutError='Shortcut could not be registered. Choose another in Settings.';}
}
function openSettings(){
    if(settingsWindow&&!settingsWindow.isDestroyed()){settingsWindow.show();settingsWindow.focus();return;}
    settingsWindow=new BrowserWindow({width:540,height:660,minWidth:440,minHeight:560,title:'MailroomNavigator Desktop settings',autoHideMenuBar:true,
        webPreferences:{preload:file('preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true}});
    harden(settingsWindow);settingsWindow.loadFile(file('settings.html'));settingsWindow.on('closed',()=>settingsWindow=null);
}
function trayMenu(){
    tray.setContextMenu(Menu.buildFromTemplate([
        {label:'Show toolbar',click:show},{label:'Hide toolbar',click:()=>toolbar.hide()},
        {label:'Always on top',type:'checkbox',checked:config.alwaysOnTop,click:item=>{config.alwaysOnTop=item.checked;toolbar.setAlwaysOnTop(item.checked);persist();broadcast();trayMenu();}},
        {label:'Reset position',click:()=>{recoverPosition(true);show();}},
        {label:'Settings and pairing',click:openSettings},{type:'separator'},
        {label:'Disconnect Chrome',click:()=>bridge?.disconnect()},
        {label:'Quit',click:()=>{quitting=true;app.quit();}}
    ]));
}
function authorize(event,settingsOnly=false){
    const win=BrowserWindow.fromWebContents(event.sender);
    if(!win || (win!==toolbar && win!==settingsWindow) || (settingsOnly && win!==settingsWindow)
        || event.senderFrame!==win.webContents.mainFrame)throw Error('Untrusted desktop request');
    const expected=pathToFileURL(file(win===toolbar?'toolbar.html':'settings.html')).href;
    if(event.senderFrame.url!==expected)throw Error('Unexpected desktop page');
}
function installIPC(){
    ipcMain.handle('desktop:state',event=>{authorize(event);return snapshot();});
    ipcMain.handle('desktop:select',(event,value)=>{
        authorize(event);
        const context=bridge?.contexts.find(c=>c.id===value?.id && c.revision===value?.revision);
        selected=context?{id:context.id,revision:context.revision}:null;broadcast();return snapshot();
    });
    ipcMain.handle('desktop:action',async(event,action)=>{authorize(event);if(typeof action!=='string')throw Error('Invalid action');await bridge.run(action,selected);return {ok:true};});
    ipcMain.handle('desktop:window',(event,action)=>{
        authorize(event);
        if(action==='hide')toolbar.hide();
        else if(action==='settings')openSettings();
        else if(action==='reset'){recoverPosition(true);show();}
        else if(action==='pin'){config.alwaysOnTop=!config.alwaysOnTop;toolbar.setAlwaysOnTop(config.alwaysOnTop);persist();trayMenu();broadcast();}
        else if(action==='quit'){quitting=true;app.quit();}
        else if(/^move:(left|right|up|down)$/.test(action)){
            const bounds=toolbar.getBounds(),d={left:[-10,0],right:[10,0],up:[0,-10],down:[0,10]}[action.split(':')[1]];
            toolbar.setBounds(clampBounds({...bounds,x:bounds.x+d[0],y:bounds.y+d[1]},screen.getAllDisplays()));
        }else throw Error('Unknown window action');
    });
    ipcMain.handle('desktop:copy-key',event=>{authorize(event,true);if(!config.extensionId)throw Error('Save your extension ID first');clipboard.writeText(token);return {ok:true};});
    ipcMain.handle('desktop:rotate-key',event=>{authorize(event,true);rotateToken();persist();bridge.token=token;bridge.disconnect();selected=null;broadcast();return {ok:true};});
    ipcMain.handle('desktop:settings',(event,value)=>{
        authorize(event,true);
        if(!value || !P.validExtensionId(value.extensionId) || !['system','light','dark'].includes(value.theme)
            || typeof value.alwaysOnTop!=='boolean' || typeof value.launchAtLogin!=='boolean'
            || (value.shortcut!=='' && !/^(?:(?:Alt|Shift|Control|Command|CommandOrControl)\+){1,3}(?:[A-Z0-9]|Space|F(?:[1-9]|1[0-2]))$/.test(value.shortcut)))throw Error('Check the extension ID, theme and shortcut fields');
        const changed=config.extensionId!==value.extensionId;
        Object.assign(config,{extensionId:value.extensionId,theme:value.theme,alwaysOnTop:value.alwaysOnTop,launchAtLogin:value.launchAtLogin,shortcut:value.shortcut});
        if(changed){rotateToken();bridge.token=token;bridge.extensionId=config.extensionId;bridge.disconnect();selected=null;}
        nativeTheme.themeSource=config.theme;toolbar.setAlwaysOnTop(config.alwaysOnTop);
        if(app.isPackaged)app.setLoginItemSettings({openAtLogin:config.launchAtLogin});
        configureShortcut();persist();trayMenu();broadcast();return snapshot();
    });
}
if(!app.requestSingleInstanceLock()){app.quit();}else{
    app.on('second-instance',()=>toolbar&&show());
    app.whenReady().then(async()=>{
        load();nativeTheme.themeSource=config.theme;
        session.defaultSession.setPermissionRequestHandler((webContents,permission,callback)=>callback(false));
        const bounds=clampBounds(config.bounds,[screen.getPrimaryDisplay(),...screen.getAllDisplays().filter(d=>d.id!==screen.getPrimaryDisplay().id)]);
        toolbar=new BrowserWindow({...bounds,frame:false,transparent:true,resizable:false,maximizable:false,fullscreenable:false,
            show:false,alwaysOnTop:config.alwaysOnTop,skipTaskbar:false,title:'MailroomNavigator Desktop',hasShadow:true,
            webPreferences:{preload:file('preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true}});
        harden(toolbar);installIPC();toolbar.loadFile(file('toolbar.html'));
        toolbar.once('ready-to-show',()=>{toolbar.show();if(!config.extensionId)openSettings();});
        toolbar.on('close',event=>{if(!quitting){event.preventDefault();toolbar.hide();}});
        toolbar.on('move',()=>{clearTimeout(saveTimer);saveTimer=setTimeout(()=>{config.bounds=toolbar.getBounds();persist();},350);});
        bridge=new DesktopBridge({token,extensionId:config.extensionId});
        bridge.on('state',state=>{if(selected && !state.contexts.some(c=>c.id===selected.id && c.revision===selected.revision))selected=null;broadcast();});
        try{await bridge.start();}catch(error){bridgeError=error.code==='EADDRINUSE'?'Port 4818 is in use. Quit the other desktop companion and restart.':'Desktop bridge could not start';}
        tray=new Tray(nativeImage.createFromPath(file('icon.png')).resize({width:18,height:18}));tray.setToolTip('MailroomNavigator Desktop');tray.on('double-click',show);trayMenu();
        configureShortcut();nativeTheme.on('updated',broadcast);
        for(const event of ['display-added','display-removed','display-metrics-changed'])screen.on(event,()=>recoverPosition());
        broadcast();
    }).catch(error=>{dialog.showErrorBox('MailroomNavigator Desktop',error.message);quitting=true;app.quit();});
}
app.on('activate',()=>toolbar&&show());
app.on('window-all-closed',()=>{});
app.on('before-quit',()=>{quitting=true;clearTimeout(saveTimer);globalShortcut.unregisterAll();bridge?.close().catch(()=>{});});
