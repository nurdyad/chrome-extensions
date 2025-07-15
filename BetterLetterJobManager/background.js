
// Listener for when the extension icon is clicked
chrome.action.onClicked.addListener(async (tab) => {
    const dashboardUrl = "https://app.betterletter.ai/admin_panel/bots/dashboard";
    let targetTabForData = tab.id;

    if (!tab.url || !tab.url.startsWith(dashboardUrl)) {
        const dashboardTabs = await chrome.tabs.query({ url: `${dashboardUrl}*` }); 

        if (dashboardTabs.length > 0) {
            targetTabForData = dashboardTabs[0].id;
            if (targetTabForData !== tab.id) {
                await chrome.tabs.update(targetTabForData, { active: true });
            }
        } else {
            const newDashboardTab = await chrome.tabs.create({ url: dashboardUrl, active: true });
            targetTabForData = newDashboardTab.id;
        }
    }
    await chrome.storage.local.set({ targetTabId: targetTabForData });

    const panelUrl = chrome.runtime.getURL("panel.html");
    const windows = await chrome.windows.getAll({ populate: true });
    let existingPanelWindow = null;

    for (const win of windows) {
        if (win.type === "popup" && win.tabs && win.tabs.some(t => t.url === panelUrl)) {
            existingPanelWindow = win;
            break;
        }
    }

    if (existingPanelWindow) {
        chrome.windows.update(existingPanelWindow.id, { focused: true });
    } else {
        chrome.windows.create({
            url: panelUrl,
            type: "popup",
            width: 360,
            height: 700,
            focused: true
        });
    }
});

chrome.tabs.onActivated.addListener(async (activeInfo) => {
    try {
        const tab = await chrome.tabs.get(activeInfo.tabId);
        await chrome.storage.local.set({ targetTabId: activeInfo.tabId });
    } catch (e) {
        console.warn("Could not get activated tab info:", e);
    }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (changeInfo.url) {
        await chrome.storage.local.set({ targetTabId: tabId });
    }
});

// NEW: Listener for messages from mailroom_page_integrator.js
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Listener for data from mailroom_page_integrator.js
    if (message.type === 'mailroom_doc_clicked' && message.data) {
        // Store the received data in storage so panel.js can access it
        chrome.storage.local.set({ clickedMailroomDocData: message.data }).then(() => {
            console.log("Received mailroom_doc_clicked data:", message.data);
        }).catch(err => {
            console.error("Error storing mailroom_doc_clicked data:", err);
        });
        return true; // Indicate asynchronous response
    }
    // If there were other message types, they would be handled by 'else if' or separate listeners here.
});
