/**
 * Merged background.js - Final Stable Version
 * Fixes: Multi-monitor tab reuse and Phoenix LiveView tab clicking.
 */

// --- 1. Global State ---
let practiceCache = {}; 
const CACHE_EXPIRY = 24 * 60 * 60 * 1000; 
let popupWindowId = null; 
let isScrapingActive = false; 

// --- 2. TAB RE-USE & LIVEVIEW CLICKING ---

/**
 * 🛡️ THE FIX: Searches ALL open windows and monitors for a matching practice tab.
 */
async function findAndFocusPracticeTab(odsCode) {
    const targetUrl = `https://app.betterletter.ai/admin_panel/practices/${odsCode}`;
    // Query ALL windows across ALL monitors
    const tabs = await chrome.tabs.query({ url: `${targetUrl}*` });
    
    if (tabs.length > 0) {
        const existingTab = tabs[0];
        // Focus the correct window first (crucial for multi-monitor setups)
        await chrome.windows.update(existingTab.windowId, { focused: true });
        // Activate the specific tab
        await chrome.tabs.update(existingTab.id, { active: true });
        return existingTab.id;
    }
    return null;
}

/**
 * 🛡️ THE FIX: Polling Clicker for Phoenix LiveView.
 * Waits for the 'phx-click' attribute to be ready before firing.
 */
async function clickLiveViewTab(tabId, settingType) {
    const selectorMap = {
        ehr_settings: "[data-test-id='tab-ehr_settings']",
        task_recipients: "[data-test-id='tab-task_recipients']"
    };
    const selector = selectorMap[settingType];
    if (!selector) return;

    const injectedClick = async (sel) => {
        return new Promise((resolve) => {
            let attempts = 0;
            const interval = setInterval(() => {
                const el = document.querySelector(sel);
                // Check if element exists AND has LiveView attributes ready
                if (el && el.getAttribute('phx-click')) {
                    // Dispatch sequence for robust Phoenix interaction
                    el.focus();
                    ['mousedown', 'mouseup', 'click'].forEach(type => 
                        el.dispatchEvent(new MouseEvent(type, { bubbles: true }))
                    );
                    clearInterval(interval);
                    resolve(true);
                }
                if (attempts++ > 30) { // 15 second total timeout
                    clearInterval(interval);
                    resolve(false);
                }
            }, 500);
        });
    };

    await chrome.scripting.executeScript({
        target: { tabId },
        func: injectedClick,
        args: [selector]
    });
}

async function handleOpenPractice(input, settingType = "ehr_settings") {
    const odsMatch = input.match(/\(([^)]+)\)$/);
    const odsCode = odsMatch ? odsMatch[1] : input.trim();
    
    // 1. Scan all monitors for an existing tab
    let tabId = await findAndFocusPracticeTab(odsCode);
    
    if (!tabId) {
        // 2. Open new tab if none found
        const url = `https://app.betterletter.ai/admin_panel/practices/${odsCode}`;
        const newTab = await chrome.tabs.create({ url, active: true });
        tabId = newTab.id;
    }

    // 3. Trigger the click once LiveView is interactive
    await clickLiveViewTab(tabId, settingType);
    return { success: true };
}

// --- 3. SYSTEM UTILITIES ---

async function setupOffscreen() {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (contexts.length > 0) return;
    await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['DOM_SCRAPING'],
        justification: 'Silent data sync.'
    });
}

async function scrapePracticeListViaTab() {
    const url = 'https://app.betterletter.ai/admin_panel/practices';
    const tab = await chrome.tabs.create({ url, active: false });

    try {
        await new Promise((resolve) => {
            const timeout = setTimeout(() => {
                chrome.tabs.onUpdated.removeListener(listener);
                resolve();
            }, 30000);

            const listener = (tabId, info) => {
                if (tabId === tab.id && info.status === 'complete') {
                    clearTimeout(timeout);
                    chrome.tabs.onUpdated.removeListener(listener);
                    resolve();
                }
            };

            chrome.tabs.onUpdated.addListener(listener);
        });

        const [{ result }] = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: async () => {
                const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
                await delay(2000);

                const headerCells = Array.from(document.querySelectorAll('table thead th'));
                const headers = headerCells.map((th, idx) => ({
                    idx,
                    text: (th.textContent || '').trim().toLowerCase()
                }));

                const findHeaderIndex = (...keywords) => {
                    const hit = headers.find(h => keywords.every(k => h.text.includes(k)));
                    return hit ? hit.idx : -1;
                };

                const fallbackByPosition = {
                    ods: 1,
                    cdb: 2,
                    ehr: 3,
                    quota: 4,
                    collected: 5,
                    service: 6
                };

                const odsIdx = findHeaderIndex('ods') >= 0 ? findHeaderIndex('ods') : fallbackByPosition.ods;
                const cdbIdx = findHeaderIndex('cdb') >= 0 ? findHeaderIndex('cdb') : fallbackByPosition.cdb;
                const ehrIdx = findHeaderIndex('ehr') >= 0 ? findHeaderIndex('ehr') : fallbackByPosition.ehr;
                const quotaIdx = findHeaderIndex('quota') >= 0 ? findHeaderIndex('quota') : fallbackByPosition.quota;
                const collectedIdx = findHeaderIndex('collected') >= 0 ? findHeaderIndex('collected') : fallbackByPosition.collected;
                const serviceIdx = findHeaderIndex('service') >= 0 ? findHeaderIndex('service') : fallbackByPosition.service;

                const rows = Array.from(document.querySelectorAll('table tbody tr'));
                return rows.map(row => {
                    const cells = Array.from(row.querySelectorAll('td'));
                    const link = row.querySelector('a[href*="/admin_panel/practices/"]');
                    if (!link) return null;

                    const normalize = (value) => (value || '').trim().replace(/\s+/g, ' ');
                    const fromIdx = (idx) => (idx >= 0 ? normalize(cells[idx]?.textContent || '') : '');

                    const hrefId = (link.getAttribute('href') || '').split('/').pop() || '';
                    const extractedOds = fromIdx(odsIdx).match(/[A-Z]\d{5}/)?.[0] || '';
                    const id = hrefId || extractedOds;

                    return {
                        id,
                        ods: id,
                        name: normalize(link.textContent).normalize('NFC'),
                        cdb: fromIdx(cdbIdx),
                        ehrType: fromIdx(ehrIdx),
                        collectionQuota: fromIdx(quotaIdx),
                        collectedToday: fromIdx(collectedIdx),
                        serviceLevel: fromIdx(serviceIdx)
                    };
                }).filter(p => p && p.id);
            }
        });

        return Array.isArray(result) ? result : [];
    } finally {
        if (typeof tab?.id === 'number') {
            await chrome.tabs.remove(tab.id).catch(() => undefined);
        }
    }
}

async function loadCacheFromStorage() {
    const result = await chrome.storage.local.get(['practiceCache', 'cacheTimestamp']);
    if (result.practiceCache && Object.keys(result.practiceCache).length > 0) {
        practiceCache = result.practiceCache;
        return result;
    }

    return result;
}

async function fetchAndCachePracticeList(purpose = 'background refresh') {
    if (isScrapingActive) return [];
    isScrapingActive = true;
    try {
        let practicesArray = [];

        try {
            await setupOffscreen();
            practicesArray = await chrome.runtime.sendMessage({
                target: 'offscreen',
                action: 'scrapePracticeList',
                data: { url: 'https://app.betterletter.ai/admin_panel/practices' }
            });
        } catch (offscreenErr) {
            console.warn('[Ghost] Offscreen scrape failed, using tab fallback.', offscreenErr?.message || offscreenErr);
        }

        if (!Array.isArray(practicesArray) || practicesArray.length === 0 || practicesArray.error) {
            practicesArray = await scrapePracticeListViaTab();
        }

        if (!practicesArray || practicesArray.error) throw new Error("Scrape failed");
        if (!Array.isArray(practicesArray) || practicesArray.length === 0) throw new Error('No practices found');
        
        practiceCache = {}; 
        practicesArray.forEach(p => {
            practiceCache[`${p.name} (${p.id})`] = { ods: p.id, timestamp: Date.now(), ...p };
        });
        await chrome.storage.local.set({ practiceCache, cacheTimestamp: Date.now() });
        return practicesArray;
    } catch (e) {
        console.error("[Ghost] Error:", e.message); // cite: Screenshot 2026-01-28 at 14.12.35.png
        await loadCacheFromStorage();
        return [];
    } finally {
        isScrapingActive = false;
    }
}

async function ensureCacheLoaded() {
    if (Object.keys(practiceCache).length > 0) return;

    const result = await loadCacheFromStorage();
    if (result.practiceCache && Object.keys(result.practiceCache).length > 0) {
        practiceCache = result.practiceCache;

        // Do not block UI on cold start if cache is stale; refresh in background.
        if (!result.cacheTimestamp || (Date.now() - result.cacheTimestamp >= CACHE_EXPIRY)) {
            fetchAndCachePracticeList('stale-cache-refresh').catch(() => undefined);
        }
        return;
    }

    // Truly no cache available, fetch now.
    await fetchAndCachePracticeList('initial-load');
}

// --- 4. LISTENERS ---

chrome.action.onClicked.addListener(async () => {
    if (popupWindowId !== null) {
        try { await chrome.windows.update(popupWindowId, { focused: true }); return; } catch (e) { popupWindowId = null; }
    }
    chrome.windows.create({
        url: chrome.runtime.getURL("panel.html"),
        type: "popup",
        width: 330, height: 750, focused: true
    }, (win) => { popupWindowId = win.id; });
});

chrome.windows.onRemoved.addListener((windowId) => {
    if (windowId === popupWindowId) popupWindowId = null;
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.target === 'offscreen') return false;

    const handle = async () => {
        await ensureCacheLoaded();
        if (message.action === 'getPracticeCache') return { practiceCache };
        if (message.action === 'openPractice') return await handleOpenPractice(message.input, message.settingType);
        if (message.action === 'requestActiveScrape') {
            const data = await fetchAndCachePracticeList('manual-refresh');
            return { success: true, practicesCount: (data || []).length };
        }
        if (message.action === 'getPracticeStatus') {
            let p = Object.values(practiceCache).find(x => x.ods === message.odsCode);
            return { success: true, status: { ...p, odsCode: p?.ods, practiceCDB: p?.cdb || 'N/A' } };
        }
        return { error: "Unknown action" };
    };
    handle().then(sendResponse);
    return true; 
});
