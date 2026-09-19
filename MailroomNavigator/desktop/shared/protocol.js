/* Shared, dependency-free contract for the Chrome and desktop processes. */
(function(root) {
    const actions = [
        ['collection','Collection','compactCollectionLinkBtn','scope','box'],
        ['dashboard','Job dashboard','compactBotDashboardLinkBtn','','grid'],
        ['preparing','Preparing','compactPreparingLinkBtn','scope','clock'],
        ['rejected','Rejected','compactRejectedLinkBtn','scope','x'],
        ['settings','EHR settings','compactEhrSettingsLinkBtn','practice','settings'],
        ['recipients','Task recipients','compactTaskRecipientsLinkBtn','practice','users'],
        ['letters','Letters','compactLettersLinkBtn','','mail'],
        ['flags','Feature flags','compactFeatureFlagsLinkBtn','','flag'],
        ['flow','BetterFlow','compactBetterFlowLinkBtn','','arrow'],
        ['sweep','BetterSweep','compactBetterSweepLinkBtn','','clipboard']
    ].map(([id,label,button,requires,icon])=>Object.freeze({id,label,button,requires,icon}));
    const scope = value => /^(ALL|[A-Z]\d{5})$/.test(value) ? value : '';
    const permitted = (id, selected) => {
        const action = actions.find(item=>item.id===id);
        return Boolean(action && (!action.requires || (action.requires==='scope' && scope(selected)) || /^[A-Z]\d{5}$/.test(selected)));
    };
    const context = value => {
        if (!value || !/^[a-zA-Z0-9-]{1,80}$/.test(value.id) || !Number.isSafeInteger(value.revision) || value.revision<1
            || !Number.isSafeInteger(value.tabId) || value.tabId<0 || !Number.isSafeInteger(value.windowId) || value.windowId<0) return null;
        return {id:value.id,revision:value.revision,tabId:value.tabId,windowId:value.windowId,scope:scope(value.scope),
            label:`Window ${value.windowId} · Tab ${value.tabId} · ${scope(value.scope)||'Select a practice'}`};
    };
    const api=Object.freeze({version:1,port:4818,actions:Object.freeze(actions),scope,permitted,context,
        validExtensionId: value=>typeof value==='string' && /^[a-p]{32}$/.test(value),
        validToken: value=>typeof value==='string' && /^[a-f0-9]{64}$/.test(value)});
    if (typeof module !== 'undefined' && module.exports) module.exports=api;
    else root.MailroomDesktopProtocol=api;
})(globalThis);
