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

let cdbIndexProgress = {
  total: 0,
  completed: 0,
  running: false
};


// --- HELPER FUNCTIONS (DEFINED AT TOP-LEVEL SCOPE) ---

/**
 * Ensures the in-memory practiceCache is loaded from chrome.storage.local
 * if it's currently empty or if the stored cache has expired.
 * This function is crucial for re-hydrating the cache when the service worker
 * wakes up after being inactive.
 */

async function getOrCreateScrapingTab(url) { 
    if (scrapingTabId) {
        try {
            // Attempt to update the existing scraping tab if it's still valid
            await chrome.tabs.update(scrapingTabId, { url, active: false });
            console.log(`%c[Merged BG] Reusing existing scraping tab ${scrapingTabId} for URL: ${url}`, 'color: gray;');
            return scrapingTabId;
        } catch (e) {
            console.warn(`%c[Merged BG] Failed to update existing scraping tab ${scrapingTabId}: ${e.message}. Creating new tab.`, 'color: orange;');
            scrapingTabId = null; // Reset if the tab is no longer valid
        }
    }
    // Create a new hidden tab
    const tab = await chrome.tabs.create({ url, active: false });
    scrapingTabId = tab.id;
    console.log(`%c[Merged BG] Created new scraping tab: ${scrapingTabId} for URL: ${url}`, 'color: blue;');
    return scrapingTabId;
}

async function ensureCacheLoaded() {
    if (Object.keys(practiceCache).length === 0) {
        console.log('%c[Merged BG] Checking chrome.storage.local for cached practices...', 'color: blue;');
        const result = await chrome.storage.local.get(['practiceCache', 'cacheTimestamp']);

        if (
            result.practiceCache &&
            result.cacheTimestamp &&
            Date.now() - result.cacheTimestamp < CACHE_EXPIRY
        ) {
            practiceCache = result.practiceCache;
            // Also re-hydrate cdbCache from practiceCache if available
            for (const key in practiceCache) {
                if (practiceCache[key].cdb && practiceCache[key].cdb !== 'N/A' && practiceCache[key].cdb !== 'Error') {
                    cdbCache[practiceCache[key].ods] = practiceCache[key].cdb;
                }
            }
            console.log(`%c[Merged BG] In-memory practice cache re-hydrated from storage. Size: ${Object.keys(practiceCache).length}`, 'color: green;');
        } else {
            console.log('%c[Merged BG] Stored cache expired or not found. Triggering fresh fetch.', 'color: orange;');
            // Force background scrape for re-hydration
            await fetchAndCachePracticeList('re-hydration').catch(e => console.error("[Merged BG] Cache re-hydration fetch failed:", e));
        }
    } else {
        console.log('%c[Merged BG] In-memory practice cache is already populated.', 'color: gray;');
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
function waitForSpecificElementOnTabLoad(tabId, selector, timeout = 15000, interval = 500) {
  return new Promise((resolve) => {
    const start = Date.now();
    console.log(`%c[Merged BG] Waiting for element: ${selector} on tab ${tabId}`, 'color: gray;');

    const pollForElement = () => {
      chrome.scripting.executeScript({
        target: { tabId: tabId },
        func: (sel) => {
          return document.querySelector(sel) !== null;
        },
        args: [selector]
      }).then(results => {
        const elementFound = results[0]?.result;
        if (elementFound) {
          console.log(`%c[Merged BG] Element found: ${selector} on tab ${tabId}`, 'color: green;');
          resolve(true);
        } else if (Date.now() - start > timeout) {
          console.warn(`%c[Merged BG] Element NOT found: ${selector} on tab ${tabId} after ${timeout}ms.`, 'color: orange;');
          resolve(false);
        } else {
          setTimeout(pollForElement, interval);
        }
      }).catch(err => {
          console.warn(`%c[Merged BG] Error during element polling for ${selector} on tab ${tabId}: ${err.message}`, 'color: orange;');

          if (Date.now() - start > timeout) {
            // 🔕 Silenced the red console spam
            if (selector.includes('ehr_settings')) {
              console.warn(`[Merged BG] EHR Settings tab not found after ${timeout}ms — skipping click and continuing.`);
              resolve(true); // continue gracefully
            } else {
              console.error(`%c[Merged BG] Polling for "${selector}" on tab ${tabId} failed after ${timeout}ms.`, 'color: red;');
              resolve(false);
            }
          } else {
            // Retry slower to let LiveView render fully
            setTimeout(pollForElement, interval * 2);
          }
        });

    };
    pollForElement();
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
 console.log(`%c[Merged BG] Initiating fetch for practice list (${purpose})...`, 'color: #1E90FF;');
 let tabToCloseExplicitly = null; // Use a distinct variable for the tab created in this function

 try {
   const tabId = await getOrCreateScrapingTab('https://app.betterletter.ai/admin_panel/practices');
   tabToCloseExplicitly = tabId; // Store the tabId to close it later in finally block

   await waitForSpecificElementOnTabLoad(tabId, 'table tbody tr:first-child a[href*="/admin_panel/practices/"]', 20000);

   const result = await chrome.scripting.executeScript({
     target: { tabId: tabId },
     func: () => {
       const rows = Array.from(document.querySelectorAll('table tbody tr'));
       return rows.map(row => {
         const links = row.querySelectorAll('a[href*="/admin_panel/practices/"]');
         if (links.length === 0) return null;

         const link = links[0];
         const practiceName = (link.textContent || '').trim().normalize('NFC').replace(/\s+/g, ' ').trim();
         const url = new URL(link.href);
         const ods = url.pathname.split('/').pop();

         let ehrType = 'N/A';
         let collectionQuota = 'N/A';
         let collectedToday = 'N/A';
         let serviceLevel = 'N/A';

         const ehrTypeCell = row.querySelector('td:nth-child(4)');
         if (ehrTypeCell) {
             ehrType = (ehrTypeCell.textContent || '').trim();
         }

         const collectionQuotaCell = row.querySelector('td:nth-child(5)');
         if (collectionQuotaCell) {
             collectionQuota = (collectionQuotaCell.textContent || '').trim();
         }

         const collectedTodayCell = row.querySelector('td:nth-child(6)');
         if (collectedTodayCell) {
             collectedToday = (collectedTodayCell.textContent || '').trim();
         }
         
         const serviceLevelCell = row.querySelector('td:nth-child(7)');
         if (serviceLevelCell) {
             serviceLevel = (serviceLevelCell.textContent || '').trim();
         }

         const allCells = Array.from(row.querySelectorAll('td'));
         const allCellTexts = allCells.map(cell => (cell.textContent || '').trim());
         console.log(`%c[Merged BG - Scrape] Raw Nth-Child data: Icon:"${(allCells[0]?.textContent || '').trim()}", ODS:"${(allCells[1]?.textContent || '').trim()}", Name:"${(allCells[2]?.textContent || '').trim()}", EHR:"${(allCells[3]?.textContent || '').trim()}", Quota:"${(allCells[4]?.textContent || '').trim()}", Collected:"${(allCells[5]?.textContent || '').trim()}", ServiceLevel:"${(allCells[6]?.textContent || '').trim()}"`, 'color: #8A2BE2;');
         console.log(`%c[Merged BG - Scrape] Extracted: Name="${practiceName}", ODS="${ods}", EHR="${ehrType}", Quota="${collectionQuota}", Collected="${collectedToday}", ServiceLevel="${serviceLevel}"`, 'color: #32CD32;');

         if (!practiceName || !ods || !/^[A-Z]\d{5}$/.test(ods)) {
           console.warn(`%c[Merged BG - Scrape] Skipping malformed practice row: ${row.outerHTML}`, 'color: orange;');
           return null;
         }
         
         return { id: ods, name: practiceName, ehrType, collectionQuota, collectedToday, serviceLevel };
       }).filter(p => p !== null);
     },
   });

   const practicesArray = result[0]?.result?.filter(p => p && p.name && p.id) || [];
   console.log(`%c[Merged BG] Fetched ${practicesArray.length} practices. (Including all new data)`, 'color: #1E90FF;');

   if (practicesArray.length === 0 && purpose !== 'initial startup') {
        console.warn(`%c[Merged BG] Fetched empty practice list for ${purpose}. This might indicate a problem.`, 'color: orange;');
   }

   const cacheMap = {};
   practicesArray.forEach((p) => {
     const existingPractice = Object.values(practiceCache).find(ep => ep.ods === p.id);
     const cdbToKeep = existingPractice ? existingPractice.cdb : undefined;

     cacheMap[`${p.name} (${p.id})`] = {
       ods: p.id,
       timestamp: Date.now(),
       name: p.name,
       ehrType: p.ehrType,
       collectionQuota: p.collectionQuota,
       collectedToday: p.collectedToday,
       serviceLevel: p.serviceLevel,
       cdb: cdbToKeep
     };
   });
   practiceCache = cacheMap;

   chrome.storage.local.set({
     practiceCache: cacheMap,
     cacheTimestamp: Date.now(),
   });

   console.log('%c[Merged BG] Initiating background scrape for missing CDBs...', 'color: #9932CC;');
   for (const key in cacheMap) {
       const p = cacheMap[key];
       // Only scrape CDB if it's not already cached and valid
       if (p.cdb === undefined || p.cdb === 'N/A' || p.cdb === 'Error') {
           scrapePracticeCDB(p.ods)
               .then(scrapedCDB => {
                   if (scrapedCDB && scrapedCDB !== 'N/A' && scrapedCDB !== 'Error') {
                       if (practiceCache[key]) {
                           practiceCache[key].cdb = scrapedCDB;
                           chrome.storage.local.set({ practiceCache: practiceCache });
                           cdbCache[p.ods] = scrapedCDB;
                           console.log(`%c[Merged BG] Successfully scraped and cached CDB for ${p.ods}: ${scrapedCDB}`, 'color: #32CD32;');
                       }
                   }
               })
               .catch(error => {
                   console.warn(`%c[Merged BG] Failed background CDB scrape for ${p.ods}: ${error.message}`, 'color: orange;');
                   if (practiceCache[key]) {
                       practiceCache[key].cdb = 'Error';
                       chrome.storage.local.set({ practiceCache: practiceCache });
                   }
               });
           await new Promise(resolve => setTimeout(resolve, 1500)); // Small delay between CDB scrapes
       }
   }
   console.log('%c[Merged BG] Background CDB scraping initiated for missing entries.', 'color: #9932CC;');

   return practicesArray;
 } catch (error) {
   console.error(`%c[Merged BG] ERROR: Failed to fetch and cache practice list for ${purpose}: ${error.message}`, 'color: red; font-weight: bold;', error);
   practiceCache = {}; // Clear cache on major failure
   throw error;
 } finally {
   if (tabToCloseExplicitly !== null && tabToCloseExplicitly === scrapingTabId) { // Only close if it's the dedicated scraping tab
     try {
       await chrome.tabs.remove(tabToCloseExplicitly);
       scrapingTabId = null; // Reset scrapingTabId after closing
       console.log(`%c[Merged BG] Closed scraping tab: ${tabToCloseExplicitly}`, 'color: gray;');
     } catch (e) {
       console.warn(`%c[Merged BG] Could not close temporary scrape tab ${tabToCloseExplicitly}: ${e.message}`, 'color: orange;');
     }
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
  if (cdbCache[odsCode]) {
    console.log(
      `%c[Merged BG] Returning cached CDB for ${odsCode}: ${cdbCache[odsCode]}`,
      'color: green;'
    );
    return cdbCache[odsCode];
  }

  console.log(
    `%c[Merged BG] Attempting to scrape CDB for ODS: ${odsCode}`,
    'color: #FF8C00;'
  );

  let tempTabId = null;

  try {
    const practiceUrl = `https://app.betterletter.ai/admin_panel/practices/${odsCode}`;

    tempTabId = await getOrCreateScrapingTab(practiceUrl);

    // 🔒 Gracefully abort if tab vanished (expected in MV3)
    if (!(await tabExists(tempTabId))) {
      console.warn(
        `[Merged BG] CDB scrape aborted — tab no longer exists for ${odsCode}`
      );
      return 'N/A';
    }

    await new Promise(resolve => setTimeout(resolve, 100));

    // Wait for LiveView base tab (readiness signal)
    await waitForSpecificElementOnTabLoad(
      tempTabId,
      "[data-test-id='tab-basic']",
      15000
    );

    // Click EHR Settings tab
    const ehrTabClicked = await chrome.scripting.executeScript({
      target: { tabId: tempTabId },
      func: () => {
        const ehrTab = document.querySelector(
          "[data-test-id='tab-ehr_settings']"
        );
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
      console.warn(
        `[Merged BG] EHR Settings tab not clickable for ${odsCode}`
      );
      return 'N/A';
    }

    const cdbInputSelector =
      'input[name="ehr_settings[practice_cdb]"]';

    const cdbInputReady = await waitForSpecificElementOnTabLoad(
      tempTabId,
      cdbInputSelector,
      30000,
      750
    );

    if (!cdbInputReady) {
      console.warn(
        `[Merged BG] CDB input not found for ${odsCode}`
      );
      return 'N/A';
    }

    const result = await chrome.scripting.executeScript({
      target: { tabId: tempTabId },
      func: selector => {
        const input = document.querySelector(selector);
        return input ? input.value : null;
      },
      args: [cdbInputSelector]
    });

    const cdbValue = result[0]?.result || 'N/A';

    cdbCache[odsCode] = cdbValue;

    console.log(
      `%c[Merged BG] Scraped CDB for ${odsCode}: "${cdbValue}"`,
      'color: #FF8C00;'
    );

    return cdbValue;
  } catch (error) {
    if (error.message?.includes('No tab with id')) {
      console.warn(
        `[Merged BG] CDB scrape skipped — tab disappeared for ${odsCode}`
      );
      return 'N/A';
    }

    console.error(
      `%c[Merged BG] ERROR: Failed to scrape CDB for ${odsCode}: ${error.message}`,
      'color: red; font-weight: bold;',
      error
    );
    return 'Error';
  } finally {
    // Only close if this function owns the tab
    if (tempTabId !== null && tempTabId === scrapingTabId) {
      try {
        await chrome.tabs.remove(tempTabId);
        scrapingTabId = null;
        console.log(
          `%c[Merged BG] Closed temporary CDB scrape tab: ${tempTabId}`,
          'color: gray;'
        );
      } catch (e) {
        console.warn(
          `%c[Merged BG] Could not close temporary CDB scrape tab ${tempTabId}: ${e.message}`,
          'color: orange;'
        );
      }
    }
  }
}

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
chrome.action.onClicked.addListener(async (tab) => {
    const panelUrl = chrome.runtime.getURL("panel.html");
    
    // Set targetTabId to the ID of the tab where the action icon was clicked.
    // The panel.js will then determine if it needs data from this tab for Job Panel functionality.
    await chrome.storage.local.set({ targetTabId: tab.id });

    // Manage the unified floating popup window
    if (floatingWindowId) {
        try {
            const existing = await chrome.windows.get(floatingWindowId);
            if (existing) {
                await chrome.windows.update(floatingWindowId, { focused: true });
                return;
            }
        } catch (e) {
            console.warn(`%c[Merged BG] Existing floating window ${floatingWindowId} not found, likely closed: ${e.message}`, 'color: orange;');
            floatingWindowId = null; // Reset if not found (window might have been closed by user)
        }
    }

    // Get current window details to position the new popup
    const currentWindow = await chrome.windows.getCurrent();
    const popup = await chrome.windows.create({
        url: panelUrl, // Use the new merged panel.html
        type: 'popup',
        width: 320, // Default width from original BL-Mailroom popup
        height: 720, // Adjusted height for combined features
        focused: true,
        // Position relative to the top-left of the current browser window
        top: currentWindow.top + 50,
        left: currentWindow.left + 50
    });
    floatingWindowId = popup.id;
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
    // Ensure cache is loaded before processing any action from popup.js
    if (message.action) { // Only apply this for actions originating from popup.js (UI)
        await ensureCacheLoaded();
    }

    // --- BetterLetterJobManager messages (from mailroom_page_integrator.js) ---
    if (message.type === 'mailroom_doc_clicked' && message.data) {
        console.log("Background: Processing mailroom_doc_clicked message. Data received:", message.data);
        await chrome.storage.local.set({ clickedMailroomDocData: message.data });
        return { status: 'Data received and stored in background' };
    }

    // --- BL-Mailroom (Practice Navigator) messages (from popup.js/panel.js) ---
    if (message.action === 'openPractice') {
      try {
        await handleOpenPractice(message.input, message.settingType);
        return { success: true };
      } catch (error) {
        console.error(`%c[Merged BG] Error in openPractice: ${error.message}`, 'color: red; font-weight: bold;', error);
        return { error: error.message };
      }
    } else if (message.action === 'getPracticeCache') {
      console.log(`%c[Merged BG] getPracticeCache requested. Current cache size: ${Object.keys(practiceCache).length}`, 'color: cyan;');
      return { practiceCache: practiceCache };
    } else if (message.action === 'getOdsCodeFromName') {
      try {
        const odsCode = await getOdsCodeFromName(message.practiceName);
        return { odsCode: odsCode };
      } catch (error) {
        console.error(`%c[Merged BG] Error in getOdsCodeFromName: ${error.message}`, 'color: red; font-weight: bold;', error);
        return { error: error.message };
      }
    } else if (message.action === 'requestActiveScrape') {
        try {
            // Force background scrape even for 'active' request
            const fetchedPractices = await fetchAndCachePracticeList('active foreground scrape (now background)');
            return { success: true, practicesCount: fetchedPractices.length };
        } catch (error) {
            console.error(`%c[Merged BG] Error in active scrape request: ${error.message}`, 'color: red; font-weight: bold;', error);
            return { error: `Failed to load practices: ${error.message}` };
        }
    } else if (message.action === 'getPracticeStatus') {
        try {
            const practiceOds = message.odsCode;
            if (!practiceOds) {
                return { error: "ODS code is required for status lookup." };
            }

            let practiceEntry = Object.values(practiceCache).find(p => p.ods === practiceOds);
            
            let practiceCDB = 'N/A';
            
            if (cdbCache[practiceOds]) {
                practiceCDB = cdbCache[practiceOds];
                console.log(`%c[Merged BG] CDB found in in-memory cdbCache for ${practiceOds}: ${practiceCDB}`, 'color: green;');
            } else if (practiceEntry && practiceEntry.cdb && practiceEntry.cdb !== 'N/A' && practiceEntry.cdb !== 'Error') {
                practiceCDB = practiceEntry.cdb;
                cdbCache[practiceOds] = practiceCDB;
                console.log(`%c[Merged BG] CDB found in main practiceCache for ${practiceOds}: ${practiceCDB}`, 'color: green;');
            } else {
                try {
                    console.log(`%c[Merged BG] CDB missing for ${practiceOds}. Triggering specific scrape.`, 'color: orange;');
                    practiceCDB = await scrapePracticeCDB(practiceOds);
                    if (practiceEntry) { // Update the practiceCache with the newly scraped CDB
                        practiceEntry.cdb = practiceCDB;
                        await chrome.storage.local.set({ practiceCache: practiceCache });
                    }
                } catch (cdbError) {
                    console.warn(`%c[Merged BG] Failed to scrape CDB for ${practiceOds}: ${cdbError.message}`, 'color: orange;');
                    if (practiceEntry) {
                        practiceEntry.cdb = 'Error'; // Mark as error so we don't try again until full refresh
                        await chrome.storage.local.set({ practiceCache: practiceCache });
                    }
                }
            }

            // After potentially scraping CDB, check for full practice entry data
            if (!practiceEntry || practiceEntry.ehrType === undefined || practiceEntry.collectionQuota === undefined || practiceEntry.collectedToday === undefined || practiceEntry.serviceLevel === undefined) {
                console.warn(`%c[Merged BG] Full status data (other than CDB) not found/complete for ODS: ${practiceOds}. Attempting fresh main scrape...`, 'color: orange;');
                // Force background scrape
                const freshlyScrapedPractices = await fetchAndCachePracticeList('status lookup (full refresh, now background)'); // This updates practiceCache
                practiceEntry = Object.values(practiceCache).find(p => p.ods === practiceOds); // Re-fetch the entry after refresh
            }

            if (practiceEntry && practiceEntry.ehrType !== undefined && practiceEntry.collectionQuota !== undefined && practiceEntry.collectedToday !== undefined && practiceEntry.serviceLevel !== undefined) {
                console.log(`%c[Merged BG] Found complete status data for ODS ${practiceOds}:`, 'color: green;', practiceEntry);
                return {
                    success: true,
                    status: {
                        odsCode: practiceEntry.ods,
                        ehrType: practiceEntry.ehrType,
                        collectionQuota: practiceEntry.collectionQuota,
                        collectedToday: practiceEntry.collectedToday,
                        serviceLevel: practiceEntry.serviceLevel,
                        practiceCDB: practiceCDB // Use the most up-to-date CDB
                    }
                };
            } else {
                return { error: `Complete status data not found for practice ${practiceOds} even after trying to refresh.` };
            }
        } catch (error) {
            console.error(`%c[Merged BG] Error in getPracticeStatus: ${error.message}`, 'color: red; font-weight: bold;', error);
            return { error: `Failed to get status: ${error.message}` };
        }
    } else if (message.action === 'searchCDB') {
        try {
            const searchedCDB = message.cdb;
            if (!searchedCDB) {
                return { success: false, error: "CDB code is required for search." };
            }
            console.log(`%c[Merged BG] Initiating CDB search for: "${searchedCDB}"`, 'color: #DA70D6;');

            let foundPractice = null;
            const allPractices = Object.values(practiceCache); // Get current state of practiceCache

            // First, check in-memory cdbCache and practiceCache
            return {
              success: false,
              error: `No practice found for CDB: "${searchedCDB}". It may not be indexed yet.`
            };

            // If not found, iterate through practices and scrape missing CDBs
            if (!foundPractice) {
              return {
                success: false,
                error: `No practice found for CDB: "${searchedCDB}". It may not be indexed yet.`
              };
            }

            if (foundPractice) {
                return { success: true, practice: foundPractice };
            } else {
                return { success: false, error: `No practice found for CDB: "${searchedCDB}". Please ensure the CDB is correct.` };
            }

        } catch (error) {
            console.error(`%c[Merged BG] Error during CDB search: ${error.message}`, 'color: red; font-weight: bold;', error);
            return { success: false, error: `Internal error during CDB search: ${error.message}` };
        }
    }
    return { error: "Unknown action" };
  };

  handleMessage().then(response => {
    try {
      sendResponse(response);
    } catch (e) {
      console.warn('[Merged BG] Failed to send response (message port might be closed):', e.message, 'Response:', response);
    }
  });

  return true;
});