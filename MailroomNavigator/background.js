/**
 * Merged background.js
 *
 * This is the unified service worker script for the BetterLetter All-in-One extension.
 * It combines functionalities from both BetterLetterJobManager and BL-Mailroom, including:
 * - Caching and periodically refreshing the practice list.
 * - Opening and managing the floating UI window (now a unified panel).
 * - Processing requests from the UI (panel.js) for practice navigation, Mailroom links,
 * job data extraction, practice status, and CDB lookup.
 * - Scraping practice details (name, ODS, EHR Type, Collection Quota, Collected Today, CDB).
 * - Robustly clicking specific tabs on the BetterLetter AI practice settings page.
 * - Handling messages from content scripts for Mailroom page integration.
 */

// --- Global In-Memory Caches and Constants ---
let practiceCache = {}; // Global in-memory cache for practice data.
const CACHE_EXPIRY = 24 * 60 * 60 * 1000; // 24 hours in milliseconds for local storage cache expiry.
// const REALTIME_REFRESH_INTERVAL = 10 * 1000; // Moved into alarm creation
const cdbCache = {}; // ODS => CDB value (This in-memory cache will store scraped CDBs)

let floatingWindowId = null; // Stores the ID of the unified popup window
let scrapingTabId = null; // Single hidden tab for scraping (used by BL-Mailroom's background logic)
let scrapingWindowId = null; // Window ID for the hidden scraping tab
let isScrapingActive = false; // Flag to prevent concurrent scrapes

let cdbIndexProgress = {
  total: 0,
  completed: 0,
  running: false
};


// --- HELPER FUNCTIONS (DEFINED AT TOP-LEVEL SCOPE) ---

/**
 * Creates or reuses a minimized "Hidden Window" for background scraping.
 * This prevents tabs from flickering in the user's main window.
 */
async function getOrCreateScrapingTab(url) { 
    if (scrapingWindowId && scrapingTabId) {
        try {
            await chrome.tabs.update(scrapingTabId, { url, active: false });
            return scrapingTabId;
        } catch (e) {
            scrapingWindowId = null;
            scrapingTabId = null;
        }
    }

    // Create a new window that is minimized AND positioned off-screen
    const window = await chrome.windows.create({ 
        url, 
        type: 'popup', 
        focused: false, 
        width: 1,       // Tiny size makes it invisible
        height: 1,
        left: -2000,    // Moves it far off-screen
        top: -2000
    });
    
    scrapingWindowId = window.id;
    scrapingTabId = window.tabs[0].id;

    // Pin it so it doesn't get swept by tab discarders
    await chrome.tabs.update(scrapingTabId, { pinned: true }); 
    
    return scrapingTabId;
}

async function ensureCacheLoaded() {
    // 1. Check if in-memory cache is already full
    if (Object.keys(practiceCache).length > 0) return;

    // 2. Try to get from local storage
    const result = await chrome.storage.local.get(['practiceCache', 'cacheTimestamp']);
    
    // 3. Only trigger a new scrape if storage is empty OR data is older than 24 hours
    const isExpired = !result.cacheTimestamp || (Date.now() - result.cacheTimestamp > CACHE_EXPIRY);
    
    if (result.practiceCache && !isExpired) {
        practiceCache = result.practiceCache;
        console.log('[Merged BG] Cache loaded from storage. No tab needed.');
    } else {
        // Only open the tab if we absolutely have to
        console.log('[Merged BG] Cache missing or expired. Opening background tab once.');
        await fetchAndCachePracticeList('initial-load');
    }
}

/**
 * Waits for a specific HTML element to be present in a tab's DOM.
 * This is more reliable for dynamic Single Page Applications (SPAs).
 * It polls the tab until the element is found or a timeout occurs.
 * @param {number} tabId - The ID of the tab to monitor.
 * @param {string} selector - The CSS selector of the element to wait for.
 * @param {number} timeout - Maximum time to wait for the element in milliseconds (default: 15000ms).
 * @param {number} interval - Interval between polls in milliseconds (default: 500ms).
 * @returns {Promise<boolean>} A promise that resolves to true when the element is found, or false on timeout.
 */

// Safely wait for a specific element to appear in a tab
async function waitForSpecificElementOnTabLoad(tabId, selector, timeoutMs = 15000, intervalMs = 500) {
  const start = Date.now();
  return new Promise((resolve) => {
    async function poll() {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (!tab) return resolve(false);
      } catch (e) { return resolve(false); }

      if (Date.now() - start > timeoutMs) return resolve(false);

      chrome.scripting.executeScript({
        target: { tabId },
        func: (sel) => !!document.querySelector(sel),
        args: [selector]
      }).then(results => {
        if (results[0]?.result) resolve(true);
        else setTimeout(poll, intervalMs);
      }).catch(() => resolve(false));
    }
    poll();
  });
}

async function tabExists(tabId) {
  try {
    await chrome.tabs.get(tabId);
    return true;
  } catch {
    return false;
  }
}

/**
 * Injects a script into the specified tab to click a specific setting tab.
 * Uses a robust polling mechanism with aggressive event simulation.
 * @param {number} tabId - The ID of the tab where the action should occur.
 * @param {string} settingType - The type of setting tab to click (e.g., 'ehr setting').
 * @throws {Error} If the element is not found within the timeout or script execution fails.
 */
async function clickSettingsTab(tabId, settingType) {
  console.log(`%c[Merged BG] Attempting to click tab: ${settingType} on tab ${tabId}`, 'color: #3498db;');

  const selectorMap = {
    ehr_settings: "[data-test-id='tab-ehr_settings']",
    task_recipients: "[data-test-id='tab-task_recipients']"
  };

  const selector = selectorMap[settingType];
  if (!selector) {
    console.warn(`%c[Merged BG] No selector found for setting type: ${settingType}`, 'color: orange;');
    throw new Error(`Invalid setting type: ${settingType}`);
  }

  const injectedClickFunction = async (selectorToClick) => {
    const el = document.querySelector(selectorToClick);
    if (el) {
      el.focus();
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      el.click();
      console.log(`[Merged BG - Injected] Clicked tab: ${selectorToClick}`);
      return true;
    } else {
      return false;
    }
  };

  for (let attempt = 1; attempt <= 3; attempt++) {
    console.log(`%c[Merged BG] Tab click attempt ${attempt}...`, 'color: gray;');
    try {
      const [result] = await chrome.scripting.executeScript({
        target: { tabId },
        func: injectedClickFunction,
        args: [selector]
      });
      if (result?.result === true) {
        console.log(`%c[Merged BG] Tab clicked successfully on attempt ${attempt}`, 'color: green;');
        return true;
      }
    } catch (error) {
      console.warn(`%c[Merged BG] Tab click error on attempt ${attempt}: ${error.message}`, 'color: orange;');
    }
    const delay = 300 + attempt * 200;
    await new Promise(resolve => setTimeout(resolve, delay));
  }
  if (settingType === "ehr_settings") {
    console.warn(`[Merged BG] EHR Settings tab not clickable after 3 attempts — continuing anyway.`);
    return true; // ✅ continue gracefully
  } else {
    console.error(`%c[Merged BG] Failed to click tab ${settingType} after 3 attempts.`, 'color: red;');
    return false;
  }
}

/**
 * Fetches and caches the practice list from the BetterLetter AI admin panel.
 * IMPORTANT: This function will now always open tabs in the background.
 * @param {string} purpose - A string indicating the reason for the fetch.
 * @returns {Promise<Array<Object>>} A promise that resolves with an array of scraped practice objects.
 * @throws {Error} If the fetching or scraping process fails.
 */
async function fetchAndCachePracticeList(purpose = 'background refresh') {
  if (isScrapingActive) return []; // Return empty array to prevent .length errors

  isScrapingActive = true;
  let tabId = null;

  try {
    tabId = await getOrCreateScrapingTab('https://app.betterletter.ai/admin_panel/practices');
    const loaded = await waitForSpecificElementOnTabLoad(tabId, 'table tbody tr:first-child a[href*="/admin_panel/practices/"]', 20000);

    if (!loaded) throw new Error("Practice table failed to load");

    const result = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const rows = Array.from(document.querySelectorAll('table tbody tr'));
        return rows.map(row => {
          const link = row.querySelector('a[href*="/admin_panel/practices/"]');
          if (!link) return null;
          return { 
            id: link.href.split('/').pop(), 
            name: link.textContent.trim().normalize('NFC').replace(/\s+/g, ' '),
            ehrType: (row.querySelector('td:nth-child(4)')?.textContent || '').trim(),
            collectionQuota: (row.querySelector('td:nth-child(5)')?.textContent || '').trim(),
            collectedToday: (row.querySelector('td:nth-child(6)')?.textContent || '').trim(),
            serviceLevel: (row.querySelector('td:nth-child(7)')?.textContent || '').trim()
          };
        }).filter(p => p !== null);
      },
    });

    const practicesArray = result[0]?.result || [];
    const cacheMap = {};
    
    practicesArray.forEach((p) => {
      const existing = Object.values(practiceCache).find(ep => ep.ods === p.id);
      cacheMap[`${p.name} (${p.id})`] = { ods: p.id, timestamp: Date.now(), ...p, cdb: existing ? existing.cdb : undefined };
    });
    
    practiceCache = cacheMap;
    await chrome.storage.local.set({ practiceCache: cacheMap, cacheTimestamp: Date.now() });

    // --- Critical Fix: Await CDB scraping BEFORE closing the tab ---
    for (const key in cacheMap) {
      const p = cacheMap[key];
      const isEmis = p.ehrType?.toLowerCase().includes('emis');
      
      // Only attempt scrape if it's EMIS and we don't have a CDB yet
      if (isEmis && (!p.cdb || p.cdb === 'N/A' || p.cdb === 'Error')) {
        try {
          const cdb = await scrapePracticeCDB(p.ods); 
          if (cdb && cdb !== 'N/A') {
            practiceCache[key].cdb = cdb;
            await chrome.storage.local.set({ practiceCache: practiceCache });
          }
        } catch (e) { console.warn("CDB Scrape skipped for " + p.ods); }
        await new Promise(r => setTimeout(r, 1000)); // Rate limiting
      }
    }

    return practicesArray;

  } catch (error) {
    console.error(`[Merged BG] Scrape Error: ${error.message}`);
    return []; // Fix: Prevents "Cannot read properties of undefined (reading 'length')"
  } finally {
    isScrapingActive = false;
    // Close the entire hidden window when finished
    if (scrapingWindowId) {
      await chrome.windows.remove(scrapingWindowId).catch(() => {});
      scrapingWindowId = null;
      scrapingTabId = null;
    }
  }
}

// Separate helper to handle CDB scraping without blocking the main list
async function processCdbScrapeQueue(cacheMap) {
    for (const key in cacheMap) {
        const p = cacheMap[key];
        if (!p.cdb || p.cdb === 'N/A' || p.cdb === 'Error') {
            try {
                const scrapedCDB = await scrapePracticeCDB(p.ods);
                if (scrapedCDB && scrapedCDB !== 'N/A') {
                    practiceCache[key].cdb = scrapedCDB;
                    chrome.storage.local.set({ practiceCache: practiceCache });
                }
            } catch (e) { /* silent error for background tasks */ }
            // Wait 2 seconds between practices to prevent Chrome from flagging the extension
            await new Promise(r => setTimeout(r, 2000));
        }
    }
}

/**
 * NEW FUNCTION: Scrapes the Practice CDB from a specific practice's EHR Settings page.
 * @param {string} odsCode - The ODS code of the practice to scrape the CDB from.
 * @returns {Promise<string>} The scraped Practice CDB code.
 * @throws {Error} If the CDB cannot be found or the scraping process fails.
 */

async function scrapePracticeCDB(odsCode) {
  // --- SAFETY CHECK ---
  const cachedData = Object.values(practiceCache).find(p => p.ods === odsCode);
  if (cachedData && !cachedData.ehrType?.toLowerCase().includes('emis')) {
    console.log(`[Merged BG] Skipping CDB scrape: ${odsCode} is not an EMIS practice.`);
    return 'N/A';
  }
  if (cdbCache[odsCode]) {
    console.log(`%c[Merged BG] Returning cached CDB for ${odsCode}: ${cdbCache[odsCode]}`, 'color: green;');
    return cdbCache[odsCode];
  }
  
  console.log(`%c[Merged BG] Attempting to scrape CDB for ODS: ${odsCode}`, 'color: #FF8C00;');
  let tempTabId = null; 
  
  try {
    const practiceUrl = `https://app.betterletter.ai/admin_panel/practices/${odsCode}`;
    
    // Reuse the globally managed scraping tab
    tempTabId = await getOrCreateScrapingTab(practiceUrl); 

    await new Promise(resolve => setTimeout(resolve, 100)); 

    await waitForSpecificElementOnTabLoad(tempTabId, "[data-test-id='tab-basic']", 15000);

    const ehrTabClicked = await chrome.scripting.executeScript({
      target: { tabId: tempTabId },
      func: () => {
        const ehrTab = document.querySelector("[data-test-id='tab-ehr_settings']");
        if (ehrTab) {
          ehrTab.focus();
          ehrTab.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
          ehrTab.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
          ehrTab.click();
          return true;
        }
        return false;
      }
    });
    
    if (!ehrTabClicked[0]?.result) {
      console.error(`%c[Merged BG] EHR Settings tab click failed for ${odsCode}`, 'color: red;');
      return 'N/A';
    }

    const cdbInputSelector = 'input[name="ehr_settings[practice_cdb]"]';
    const cdbInputReady = await waitForSpecificElementOnTabLoad(tempTabId, cdbInputSelector, 30000, 750);

    if (!cdbInputReady) {
      console.error(`%c[Merged BG] CDB input field not found for ${odsCode}`, 'color: red;');
      return 'N/A';
    }

    const result = await chrome.scripting.executeScript({
      target: { tabId: tempTabId },
      func: (selector) => {
        const cdbInput = document.querySelector(selector);
        return cdbInput ? cdbInput.value : null;
      },
      args: [cdbInputSelector]
    });

    const cdbValue = result[0]?.result || 'N/A';
    cdbCache[odsCode] = cdbValue;
    console.log(`%c[Merged BG] Scraped CDB for ${odsCode}: "${cdbValue}"`, 'color: #FF8C00;');
    return cdbValue;

  } catch (error) {
    console.error(`%c[Merged BG] ERROR: Failed to scrape CDB for ${odsCode}: ${error.message}`, 'color: red; font-weight: bold;');
    return 'Error';
  }
}

/**
 * NEW FUNCTION: Scrapes the Practice CDB from a specific practice's EHR Settings page.
 * @param {string} odsCode - The ODS code of the practice to scrape the CDB from.
 * @returns {Promise<string>} The scraped Practice CDB code.
 * @throws {Error} If the CDB cannot be found or the scraping process fails.
 */

/**
 * Retrieves the ODS code for a given practice input (name or ODS).
 * Prioritizes in-memory cache, but performs an on-demand scrape if not found.
 * @param {string} input - The practice name or ODS code from the UI input field.
 * @returns {Promise<string>} A promise that resolves with the ODS code.
 * @throws {Error} If the practice is not found even after an on-demand scrape.
 */
async function getOdsCodeFromName(input) {
  if (/^[A-Z]\d{5}$/.test(input)) return input;

  console.log(`%c[Merged BG] Looking up ODS for: "${input}" (on-demand scrape if needed)`, 'color: blue;');

  const inputLower = input.toLowerCase().trim();

  for (const [key, data] of Object.entries(practiceCache)) {
    const dataNameLower = data && data.name ? data.name.toLowerCase().trim() : '';
    const dataOdsLower = data && data.ods ? data.ods.toLowerCase().trim() : '';
    const keyLower = key ? key.toLowerCase().trim() : '';

    if (
      dataNameLower === inputLower ||
      dataOdsLower === inputLower ||
      keyLower === inputLower ||
      (dataNameLower.includes(inputLower) && inputLower.length >= 3) ||
      (dataOdsLower.includes(inputLower) && inputLower.length >= 3)
    ) {
        console.log(`%c[Merged BG] Found ODS in memory cache for: "${input}" -> ${data.ods}`, 'color: green;');
        return data.ods;
    }
  }

  console.log(`%c[Merged BG] ODS not in memory cache. Performing on-demand scrape for: "${input}"`, 'color: orange;');
  
  // Force background scrape for on-demand lookup
  const freshPracticesArray = await fetchAndCachePracticeList('on-demand lookup'); // This will also update practiceCache
  
  const matched = freshPracticesArray.find(p =>
      p && (p.name.toLowerCase().trim() === inputLower || p.id.toLowerCase().trim() === inputLower || (p.name.toLowerCase().trim().includes(inputLower) && inputLower.length >= 3))
  );

  if (!matched) {
    const relevantSuggestions = freshPracticesArray
        .filter(p => p && p.name && p.name.toLowerCase().trim().includes(inputLower))
        .slice(0, 5)
        .map((p) => `${p.name} (${p.id})`).join(', ');

    const suggestionText = relevantSuggestions ? `Did you mean: ${relevantSuggestions}?` : 'No close matches found.';
    throw new Error(`Practice "${input}" not found in fresh list. ${suggestionText}`);
  }

  console.log(`%c[Merged BG] ODS found after on-demand scrape for: "${input}" -> ${matched.id}`, 'color: green;');
  return matched.id;
}

/**
 * Handles the logic for opening practice settings.
 * Resolves the practice ID and then calls openPracticePage.
 * @param {string} input - The practice name or ODS code.
 * @param {string} settingType - The type of setting to open (e.g., 'ehr setting', 'workflows').
 */
let lastOpenTimestamp = 0;
let lastOpenedTabId = null;
let lastOpenedPracticeTabId = null;

async function findExistingPracticeTab(odsCode) {
  const urlPrefix = `https://app.betterletter.ai/admin_panel/practices/${odsCode}`;

  const tabs = await chrome.tabs.query({
    url: `${urlPrefix}*`
  });

  return tabs.length > 0 ? tabs[0] : null;
}

async function handleOpenPractice(input, settingType = "ehr_settings") {
  try {
    const odsMatch = input.match(/\(([^)]+)\)$/);
    const odsCode = odsMatch ? odsMatch[1] : input.trim();
    const url = `https://app.betterletter.ai/admin_panel/practices/${odsCode}`;

    // 🔍 STEP 1: Reuse existing tab if already open (any window)
    const existingTab = await findExistingPracticeTab(odsCode);

    if (existingTab) {
      console.log("[BetterLetter] Reusing existing practice tab:", existingTab.id);

      lastOpenedPracticeTabId = existingTab.id;

      // Bring the window to the foreground
      await chrome.windows.update(existingTab.windowId, {
        focused: true
      });

      // Activate the tab
      await chrome.tabs.update(existingTab.id, {
        active: true
      });

       // Replaces the old hard-coded EHR click
      await clickSettingsTab(existingTab.id, settingType);

      return { success: true, reused: true };
    }

    // 🆕 STEP 2: No existing tab → create new one (your existing logic)
    const createdTab = await chrome.tabs.create({
      url,
      active: false
    });

    lastOpenedPracticeTabId = createdTab.id;

    // Activate as soon as Chrome paints the page
    chrome.tabs.onUpdated.addListener(function activateOnLoad(tabId, info) {
      if (
        tabId === createdTab.id &&
        info.status === "complete" &&
        tabId === lastOpenedPracticeTabId
      ) {
        chrome.tabs.update(tabId, { active: true });
        chrome.tabs.onUpdated.removeListener(activateOnLoad);
      }
    });

    // Wait for basic load (not LiveView-ready)
    await waitForTabToLoad(createdTab.id, 15000);

    // Click the requested settings tab (EHR / Task Recipients / etc.)
    await clickSettingsTab(createdTab.id, settingType);

    return { success: true };
  } catch (err) {
    console.error("[BetterLetter] handleOpenPractice failed:", err);
    return { error: err.message };
  }
}

/**
 * Wait for a tab to fully load using chrome.tabs.onUpdated listener.
 */
async function waitForTabToLoad(tabId, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const start = Date.now();

    function handleUpdated(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(handleUpdated);
        console.log(`[Merged BG] Tab ${tabId} finished loading.`);
        resolve(true);
      }
    }

    chrome.tabs.onUpdated.addListener(handleUpdated);

    const interval = setInterval(() => {
      if (Date.now() - start > timeoutMs) {
        chrome.tabs.onUpdated.removeListener(handleUpdated);
        clearInterval(interval);
        console.warn(`[Merged BG] Tab ${tabId} load timeout after ${timeoutMs}ms.`);
        resolve(false);
      }
    }, 500);
  });
}

/**
 * Opens (or focuses) a practice settings page and then attempts to click a specific tab.
 * @param {string} practiceId - The ODS code of the practice.
 * @param {string} settingType - The type of setting tab to open (e.g., 'ehr setting', 'workflows').
 */
async function openPracticePage(practiceId, settingType) {
  const practiceUrl = `https://app.betterletter.ai/admin_panel/practices/${practiceId}`;
  const existingTabs = await chrome.tabs.query({ url: `${practiceUrl}*` });
  let practiceTab = existingTabs[0];

  const selectorMap = {
    ehr_settings: "[data-test-id='tab-ehr_settings']",
    task_recipients: "[data-test-id='tab-task_recipients']",
  };
  const targetTabSelector = selectorMap[settingType];

  if (!targetTabSelector) {
    console.error(`%c[Merged BG] Invalid setting type provided: ${settingType}`, 'color: red;');
    throw new Error(`Invalid setting type: ${settingType}`);
  }

  // If tab exists, update it to be active. Otherwise, create a new active tab.
  if (!practiceTab) {
    console.log(`%c[Merged BG] Creating new tab for practice settings: ${practiceUrl}`, 'color: blue;');
    practiceTab = await chrome.tabs.create({ url: practiceUrl, active: true });
    await waitForSpecificElementOnTabLoad(practiceTab.id, "[data-test-id='tab-basic']", 15000);
  } else {
    console.log(`%c[Merged BG] Existing tab found for practice settings: ${practiceTab.url}. Focusing tab.`, 'color: blue;');
    await chrome.tabs.update(practiceTab.id, { active: true });
    await new Promise(resolve => setTimeout(resolve, 300)); // Small delay for tab to become active
  }

  console.log(`%c[Merged BG] Waiting for target tab element: ${targetTabSelector} to be ready on tab ${practiceTab.id}`, 'color: gray;');
  const targetTabReady = await waitForSpecificElementOnTabLoad(practiceTab.id, targetTabSelector, 10000);

  if (!targetTabReady) {
    console.error(`%c[Merged BG] Target tab element "${targetTabSelector}" not found on tab ${practiceTab.id} after waiting. Cannot click.`, 'color: red;');
    throw new Error(`Failed to load target setting tab (${settingType}).`);
  }

  console.log(`%c[Merged BG] Adding a small pre-click delay for UI interactivity.`, 'color: purple;');
  await new Promise(resolve => setTimeout(resolve, 500)); // Delay to ensure UI is ready for click

  await clickSettingsTab(practiceTab.id, settingType);
}


// --- Event Listeners and Core Logic ---

// Unified onInstalled listener
chrome.runtime.onInstalled.addListener(async () => {
  console.log('[Merged BG] Extension installed/updated. Ensuring cache is loaded.');
  await ensureCacheLoaded();
  // Set alarm for periodic refresh to a much longer interval (e.g., once every 24 hours)
  // 1440 minutes = 24 hours
  chrome.alarms.create('practiceCacheRefresh', { periodInMinutes: 1440 });
});

// Unified alarms listener for periodic refresh
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'practiceCacheRefresh') {
    console.log('[Merged BG] Alarm triggered: Refreshing practice cache...');
    // Force background scrape for periodic refresh
    await fetchAndCachePracticeList('periodic refresh').catch(e => console.error("[Merged BG] Periodic refresh failed:", e));
  }
});

// Listener for when a Chrome window is closed by the user.
chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId === floatingWindowId) {
    console.log('[Merged BG] Unified floating panel was closed.');
    floatingWindowId = null; // Reset the ID when our window is closed.
  }
});

// Unified action button listener (icon click) - Now ONLY opens/focuses the panel
let popupWindowId = null;

chrome.action.onClicked.addListener(() => {
  if (popupWindowId !== null) {
    chrome.windows.update(popupWindowId, { focused: true });
    return;
  }

  chrome.windows.create({
    url: chrome.runtime.getURL("panel.html"),
    type: "popup",
    width: 300,  // smaller default width
    height: 750, // smaller default height
    focused: true
  }, (win) => {
    popupWindowId = win.id;

    chrome.windows.onRemoved.addListener(function listener(closedId) {
      if (closedId === popupWindowId) {
        popupWindowId = null;
        chrome.windows.onRemoved.removeListener(listener);
      }
    });
  });
});

// Tab activation and update listeners for BetterLetterJobManager context
// These listeners are kept as they are useful for updating targetTabId
// when a user switches tabs or a page loads, so the panel can fetch relevant data.
chrome.tabs.onActivated.addListener(async (activeInfo) => {
    try {
        const tab = await chrome.tabs.get(activeInfo.tabId);
        // Only update targetTabId if it's a BetterLetter.ai domain page
        if (tab.url && tab.url.startsWith("https://app.betterletter.ai/")) {
            await chrome.storage.local.set({ targetTabId: activeInfo.tabId });
        }
    } catch (e) {
        console.warn("Could not get activated tab info:", e);
    }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (changeInfo.url && tab.url.startsWith("https://app.betterletter.ai/")) {
        await chrome.storage.local.set({ targetTabId: tabId });
    }
});

// Unified message listener for popup (panel.js) and content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handleMessage = async () => {
    // 1. Safety: Ensure cache is hydrated before any UI action
    if (message.action) { 
        await ensureCacheLoaded();
    }

    // --- Content Script Messages ---
    if (message.type === 'mailroom_doc_clicked' && message.data) {
        await chrome.storage.local.set({ clickedMailroomDocData: message.data });
        return { status: 'Data received' };
    }

    // --- UI (panel.js) Messages ---
    if (message.action === 'openPractice') {
      try {
        await handleOpenPractice(message.input, message.settingType);
        return { success: true };
      } catch (error) { return { error: error.message }; }
    } 
    
    else if (message.action === 'getPracticeCache') {
      return { practiceCache: practiceCache };
    } 
    
    else if (message.action === 'getOdsCodeFromName') {
      try {
        const odsCode = await getOdsCodeFromName(message.practiceName);
        return { odsCode: odsCode };
      } catch (error) { return { error: error.message }; }
    } 

    // --- 🛡️ FIXED: requestActiveScrape (No more .length crashes) ---
    else if (message.action === 'requestActiveScrape') {
        try {
            const fetchedPractices = await fetchAndCachePracticeList('active foreground scrape');
            // Safety: If fetchedPractices is undefined, default to an empty array []
            const count = (fetchedPractices || []).length; 
            return { success: true, practicesCount: count };
        } catch (error) {
            return { error: `Failed to load practices: ${error.message}` };
        }
    } 

    else if (message.action === 'getPracticeStatus') {
        try {
            const practiceOds = message.odsCode;
            if (!practiceOds) return { error: "ODS code required" };

            let practiceEntry = Object.values(practiceCache).find(p => p.ods === practiceOds);
            let practiceCDB = cdbCache[practiceOds] || (practiceEntry ? practiceEntry.cdb : 'N/A');
            
            const isEmis = practiceEntry?.ehrType?.toLowerCase().includes('emis');
            if (isEmis && (practiceCDB === 'N/A' || !practiceCDB)) {
                practiceCDB = await scrapePracticeCDB(practiceOds);
                if (practiceEntry) {
                    practiceEntry.cdb = practiceCDB;
                    await chrome.storage.local.set({ practiceCache: practiceCache });
                }
            } else if (!isEmis) {
                practiceCDB = 'N/A (System1)'; // Set a clear value for non-EMIS
            }

            if (practiceEntry) {
                return {
                    success: true,
                    status: { ...practiceEntry, odsCode: practiceEntry.ods, practiceCDB }
                };
            }
            return { error: "Practice details not found" };
        } catch (error) { return { error: error.message }; }
    } 

    else if (message.action === 'searchCDB') {
        try {
            const searchedCDB = message.cdb;
            if (!searchedCDB) return { success: false, error: "CDB required" };
            
            // Search local cache first
            const found = Object.values(practiceCache).find(p => p.cdb === searchedCDB);
            if (found) return { success: true, practice: found };
            
            return { success: false, error: `CDB "${searchedCDB}" not found in current index.` };
        } catch (error) { return { success: false, error: error.message }; }
    }

    return { error: "Unknown action" };
  };

  handleMessage().then(response => {
    try {
      sendResponse(response);
    } catch (e) { console.warn('[Merged BG] Port closed before response.'); }
  });

  return true; // Keep message channel open for async response
});