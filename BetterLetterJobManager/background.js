// BetterLetterJobManager/background.js (FINAL VERSION - Annotation Button Injector Removed)

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

// Removed chrome.runtime.onMessage.addListener for 'open_annotation_url'
// as the annotation_button.js content script is no longer used.
