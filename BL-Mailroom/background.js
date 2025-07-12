/**
 * background.js
 *
 * This is the service worker script for the BetterLetter Practice Navigator extension.
 * It runs in the background and handles all core logic, including:
 * - Caching and periodically refreshing the practice list from BetterLetter AI.
 * - Opening and managing the floating UI window.
 * - Processing requests from the UI (popup.js) to navigate to practice settings or mailroom.
 * - Scraping practice details (name, ODS, EHR Type, Collection Quota, Collected Today) from the website.
 * - Robustly clicking specific tabs on the BetterLetter AI practice settings page.
 * - Preventing multiple instances of the floating window.
 */

// Global in-memory cache for practice data. Updated periodically and on-demand.
let practiceCache = {};

// Constants for cache management and periodic refresh intervals.
const CACHE_EXPIRY = 24 * 60 * 60 * 1000; // 24 hours in milliseconds for local storage cache expiry.
const REALTIME_REFRESH_INTERVAL = 5 * 60 * 1000; // 5 minutes in milliseconds for periodic background refresh.
const cdbCache = {}; // ODS => CDB value (This in-memory cache will store scraped CDBs)

// Global variable to store the ID of the floating window, to prevent multiple instances.
let floatingWindowId = null;


// --- HELPER FUNCTIONS (DEFINED AT TOP-LEVEL SCOPE FOR ACCESSIBILITY) ---

/**
 * Ensures the in-memory `practiceCache` is loaded from `chrome.storage.local`
 * if it's currently empty or if the stored cache has expired.
 * This function is crucial for re-hydrating the cache when the service worker
 * wakes up after being inactive.
 */
async function ensureCacheLoaded() {
    // Only attempt to load from storage if the in-memory cache is empty.
    // If it's already populated (e.g., from a recent scrape or previous re-hydration), skip.
    if (Object.keys(practiceCache).length === 0) {
        console.log('%c[BL Nav - BG] Checking chrome.storage.local for cached practices...', 'color: blue;');
        const result = await chrome.storage.local.get(['practiceCache', 'cacheTimestamp']);

        // Check if a valid, non-expired cache exists in storage.
        if (
            result.practiceCache &&
            result.cacheTimestamp &&
            Date.now() - result.cacheTimestamp < CACHE_EXPIRY
        ) {
            practiceCache = result.practiceCache;
            // Also re-hydrate the in-memory cdbCache from the loaded practiceCache entries that have CDB
            for (const key in practiceCache) {
                if (practiceCache[key].cdb && practiceCache[key].cdb !== 'N/A' && practiceCache[key].cdb !== 'Error') {
                    cdbCache[practiceCache[key].ods] = practiceCache[key].cdb;
                }
            }
            console.log(`%c[BL Nav - BG] In-memory practice cache re-hydrated from storage. Size: ${Object.keys(practiceCache).length}`, 'color: green;');
        } else {
            // If no valid cache, trigger a fresh fetch and store it.
            console.log('%c[BL Nav - BG] Stored cache expired or not found. Triggering fresh fetch.', 'color: orange;');
            await fetchAndCachePracticeList('re-hydration').catch(e => console.error("[BL Nav - BG] Cache re-hydration fetch failed:", e));
        }
    } else {
        console.log('%c[BL Nav - BG] In-memory practice cache is already populated.', 'color: gray;');
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
    console.log(`%c[BL Nav - BG] Waiting for element: ${selector} on tab ${tabId}`, 'color: gray;');

    const pollForElement = () => {
      chrome.scripting.executeScript({
        target: { tabId: tabId },
        func: (sel) => {
          return document.querySelector(sel) !== null; // Returns true if element exists.
        },
        args: [selector]
      }).then(results => {
        const elementFound = results[0]?.result; // Get the result from the injected script.
        if (elementFound) {
          console.log(`%c[BL Nav - BG] Element found: ${selector} on tab ${tabId}`, 'color: green;');
          resolve(true); // Element found, resolve the promise with true.
        } else if (Date.now() - start > timeout) {
          // Timeout occurred.
          console.warn(`%c[BL Nav - BG] Element NOT found: ${selector} on tab ${tabId} after ${timeout}ms.`, 'color: orange;');
          resolve(false); // Timeout, resolve with false.
        } else {
          setTimeout(pollForElement, interval);
        }
      }).catch(err => {
        // Handle errors during script execution (e.g., tab not ready, permission issues).
        console.warn(`%c[BL Nav - BG] Error during element polling for ${selector} on tab ${tabId}: ${err.message}`, 'color: orange;');
        if (Date.now() - start > timeout) {
          console.error(`%c[BL Nav - BG] Polling for "${selector}" on tab ${tabId} failed after ${timeout}ms due to script error: ${err.message}`, 'color: red;');
          resolve(false); // Resolve with false on error after timeout.
        } else {
          setTimeout(pollForElement, interval); // Keep trying to poll.
        }
      });
    };

    // Start polling immediately.
    pollForElement();
  });
}

/**
 * Injects a script into the specified tab to click a specific setting tab.
 * Uses a robust polling mechanism with aggressive event simulation.
 * @param {number} tabId - The ID of the tab where the action should occur.
 * @param {string} settingType - The type of setting tab to click (e.g., 'basic').
 * @throws {Error} If the element is not found within the timeout or script execution fails.
 */
async function clickSettingsTab(tabId, settingType) {
  console.log(`%c[BL Nav - BG] Attempting to click tab: ${settingType} on tab ${tabId}`, 'color: #3498db;');

  const selectorMap = {
    basic: "[data-test-id='tab-basic']",
    service: "[data-test-id='tab-service']",
    workflows: "[data-test-id='tab-workflows']",
    ehr_settings: "[data-test-id='tab-ehr_settings']"
  };

  const selector = selectorMap[settingType];
  if (!selector) {
    console.warn(`%c[BL Nav - BG] No selector found for setting type: ${settingType}`, 'color: orange;');
    throw new Error(`Invalid setting type: ${settingType}`);
  }

  // Helper injected function to try and click the tab
  const injectedClickFunction = async (selectorToClick) => {
    const el = document.querySelector(selectorToClick);
    if (el) {
      el.focus();
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      el.click();
      console.log(`[BL Nav - Injected] Clicked tab: ${selectorToClick}`);
      return true;
    } else {
      return false;
    }
  };

  // Attempt to click the tab up to 3 times
  for (let attempt = 1; attempt <= 3; attempt++) {
    console.log(`%c[BL Nav - BG] Tab click attempt ${attempt}...`, 'color: gray;');

    try {
      const [result] = await chrome.scripting.executeScript({
        target: { tabId },
        func: injectedClickFunction,
        args: [selector]
      });

      if (result?.result === true) {
        console.log(`%c[BL Nav - BG] Tab clicked successfully on attempt ${attempt}`, 'color: green;');
        return true;
      }
    } catch (error) {
      console.warn(`%c[BL Nav - BG] Tab click error on attempt ${attempt}: ${error.message}`, 'color: orange;');
    }

    // Wait longer between each retry (e.g., 500ms, 800ms, 1200ms)
    const delay = 300 + attempt * 200;
    await new Promise(resolve => setTimeout(resolve, delay));
  }

  console.error(`%c[BL Nav - BG] Failed to click tab ${settingType} after 3 attempts.`, 'color: red;');
  return false;
}

/**
 * Fetches and caches the practice list from the BetterLetter AI admin panel.
 * This function handles opening a temporary tab, executing a script to scrape data,
 * and then updating both the in-memory cache and chrome.storage.local.
 *
 * @param {string} purpose - A string indicating the reason for the fetch (e.g., 'background refresh', 'on-demand lookup', 'initial startup'). Used for logging.
 * @returns {Promise<Array<Object>>} A promise that resolves with an array of scraped practice objects.
 * @throws {Error} If the fetching or scraping process fails.
 */
async function fetchAndCachePracticeList(purpose = 'background refresh') {
 console.log(`%c[BL Nav - Background] Initiating fetch for practice list (${purpose})...`, 'color: #1E90FF;');
 let tabIdToClose = null;
 // Determine if the scraping tab should be active/visible (e.g., for initial user-triggered load).
 let activeTabForScrape = (purpose === 'active foreground scrape');

 try {
   // Create a new tab to navigate to the practices list page.
   const tab = await chrome.tabs.create({
     url: 'https://app.betterletter.ai/admin_panel/practices',
     active: activeTabForScrape, // Make it active if specifically requested by the UI.
   });
   tabIdToClose = tab.id; // Store tab ID to ensure it's closed later.

   // Wait for the practices list page to load a specific element (first practice link).
   // This is more robust than just waiting for 'status: complete' for dynamic pages.
   await waitForSpecificElementOnTabLoad(tab.id, 'table tbody tr:first-child a[href*="/admin_panel/practices/"]', 20000); // 20 sec timeout for scrape load.

   // Execute a script in the newly created tab to extract practice data from the table.
   const result = await chrome.scripting.executeScript({
     target: { tabId: tab.id },
     func: () => {
       const rows = Array.from(document.querySelectorAll('table tbody tr'));
       return rows.map(row => {
         // Find the <a> tag which contains the practice name and ODS in this row.
         const links = row.querySelectorAll('a[href*="/admin_panel/practices/"]');
         if (links.length === 0) return null; // Skip rows that don't contain a valid practice link.

         const link = links[0];
         // Extract and clean practice name (e.g., "Practice Name (ODS)")
         const practiceName = (link.textContent || '').trim().normalize('NFC').replace(/\s+/g, ' ').trim();
         const url = new URL(link.href);
         const ods = url.pathname.split('/').pop(); // Extract ODS from the URL.

         // Using nth-child selectors for robustness. 1-indexed.
         // td:nth-child(1) is the icon column
         // td:nth-child(2) is ODS
         // td:nth-child(3) is Practice Name
         // td:nth-child(4) is EHR Type
         // td:nth-child(5) is Collection Quota
         // td:nth-child(6) is Collected Today
         // td:nth-child(7) is Service Level

         let ehrType = 'N/A';
         let collectionQuota = 'N/A';
         let collectedToday = 'N/A';
         let serviceLevel = 'N/A';

         const ehrTypeCell = row.querySelector('td:nth-child(4)'); // EHR Type is at index 4 (from 1-indexed count)
         if (ehrTypeCell) {
             ehrType = (ehrTypeCell.textContent || '').trim();
         }

         const collectionQuotaCell = row.querySelector('td:nth-child(5)'); // Collection Quota is at index 5
         if (collectionQuotaCell) {
             collectionQuota = (collectionQuotaCell.textContent || '').trim();
         }

         const collectedTodayCell = row.querySelector('td:nth-child(6)'); // Collected Today is at index 6
         if (collectedTodayCell) {
             collectedToday = (collectedTodayCell.textContent || '').trim();
         }
         
         const serviceLevelCell = row.querySelector('td:nth-child(7)'); // Service Level is at index 7
         if (serviceLevelCell) {
             serviceLevel = (serviceLevelCell.textContent || '').trim();
         }

         // --- Debugging Logs during Scrape (Visible in the temporary tab's console) ---
         const allCells = Array.from(row.querySelectorAll('td'));
         const allCellTexts = allCells.map(cell => (cell.textContent || '').trim());
         console.log(`%c[BL Nav - Scrape] Raw Nth-Child data: Icon:"${(allCells[0]?.textContent || '').trim()}", ODS:"${(allCells[1]?.textContent || '').trim()}", Name:"${(allCells[2]?.textContent || '').trim()}", EHR:"${(allCells[3]?.textContent || '').trim()}", Quota:"${(allCells[4]?.textContent || '').trim()}", Collected:"${(allCells[5]?.textContent || '').trim()}", ServiceLevel:"${(allCells[6]?.textContent || '').trim()}"`, 'color: #8A2BE2;'); 
         console.log(`%c[BL Nav - Scrape] Extracted: Name="${practiceName}", ODS="${ods}", EHR="${ehrType}", Quota="${collectionQuota}", Collected="${collectedToday}", ServiceLevel="${serviceLevel}"`, 'color: #32CD32;');
         // --- End Debugging Logs ---

         // Basic validation for extracted data.
         if (!practiceName || !ods || !/^[A-Z]\d{5}$/.test(ods)) {
           console.warn(`%c[BL Nav - Scrape] Skipping malformed practice row: ${row.outerHTML}`, 'color: orange;');
           return null;
         }
         
         // Return an object containing all relevant practice data.
         // Note: CDB is *not* scraped here as it requires navigating to a sub-tab.
         return { id: ods, name: practiceName, ehrType, collectionQuota, collectedToday, serviceLevel };
       }).filter(p => p !== null); // Filter out any null entries (invalid rows).
     },
   });

   // Ensure results are valid and filter out any incomplete objects.
   const practicesArray = result[0]?.result?.filter(p => p && p.name && p.id) || [];
   console.log(`%c[BL Nav - Background] Fetched ${practicesArray.length} practices. (Including all new data)`, 'color: #1E90FF;');

   // Warn if an empty list is fetched, unless it's the initial startup.
   if (practicesArray.length === 0 && purpose !== 'initial startup') {
        console.warn(`%c[BL Nav - Background] Fetched empty practice list for ${purpose}. This might indicate a problem.`, 'color: orange;');
   }

   // Convert the array of practice objects into a map for faster lookup (keyed by "Name (ODS)").
   const cacheMap = {};
   practicesArray.forEach((p) => {
     // Retrieve existing CDB from old cache if available, to persist it across refreshes
     const existingPractice = Object.values(practiceCache).find(ep => ep.ods === p.id);
     const cdbToKeep = existingPractice ? existingPractice.cdb : undefined; // Keep existing CDB if any

     cacheMap[`${p.name} (${p.id})`] = { 
       ods: p.id, 
       timestamp: Date.now(), 
       name: p.name,
       ehrType: p.ehrType,           // Store EHR Type.
       collectionQuota: p.collectionQuota, // Store Collection Quota.
       collectedToday: p.collectedToday,    // Store Collected Today.
       serviceLevel: p.serviceLevel,         // Store Service Level.
       cdb: cdbToKeep // Carry over existing CDB if present
     };
   });
   practiceCache = cacheMap; // Update the global in-memory cache.

   // Store the updated cache and timestamp in Chrome's local storage.
   chrome.storage.local.set({
     practiceCache: cacheMap,
     cacheTimestamp: Date.now(),
   });

   return practicesArray; // Return the fetched array, useful for on-demand lookups.
 } catch (error) {
   // Log and propagate any errors during the fetch process.
   console.error(`%c[BL Nav - Background] ERROR: Failed to fetch and cache practice list for ${purpose}: ${error.message}`, 'color: red; font-weight: bold;', error);
   practiceCache = {}; // Clear cache if fetch fails to prevent stale/bad data.
   throw error; // Re-throw the error so calling functions (like UI) can handle it.
 } finally {
   // Ensure the temporary tab is closed, unless it was meant to stay active (foreground scrape).
   if (tabIdToClose !== null && !activeTabForScrape) {
     try {
       await chrome.tabs.remove(tabIdToClose);
     } catch (e) {
       console.warn(`[BL Nav - Background] Could not close tab ${tabIdToClose}: ${e.message}`);
     }
   }
 }
}

/**
 * Event listener for when the extension is installed or updated.
 * Handles initial cache loading from storage or triggers a fresh fetch.
 * Also sets up periodic cache refreshing.
 */
chrome.runtime.onInstalled.addListener(async () => {
  console.log('[BL Nav - Background] Extension installed/updated. Ensuring cache is loaded.');
  // On install/update, try to load from storage or fetch new data.
  // This function handles the logic for setting practiceCache and chrome.storage.local
  await ensureCacheLoaded(); 

  // Set up a periodic refresh interval for the practice list.
  // Using `globalThis` to prevent multiple intervals if the service worker restarts.
  // This ensures `REALTIME_REFRESH_INTERVAL` is defined before `setInterval` is called.
  if (!globalThis.refreshIntervalId) { 
    globalThis.refreshIntervalId = setInterval(() => {
      console.log('[BL Nav - Background] Performing periodic practice list refresh...');
      fetchAndCachePracticeList('periodic refresh').catch(e => console.error("[BL Nav - Background] Periodic refresh failed:", e));
    }, REALTIME_REFRESH_INTERVAL);
  }
});

/**
 * Event listener for when a Chrome window is closed by the user.
 * Clears the stored `floatingWindowId` if it matches the closed window.
 */
chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId === floatingWindowId) {
    console.log('[BL Nav - Background] Floating window was closed.');
    floatingWindowId = null; // Reset the ID when our window is closed.
  }
});

/**
 * Event listener for when the extension's toolbar icon is clicked.
 * Handles opening or focusing the single instance of the floating UI window.
 */
chrome.action.onClicked.addListener(async () => {
  if (floatingWindowId) {
    try {
      const existing = await chrome.windows.get(floatingWindowId);
      if (existing) {
        await chrome.windows.update(floatingWindowId, { focused: true });
        return;
      }
    } catch {
      floatingWindowId = null; // Reset if not found
    }
  }

  const currentWindow = await chrome.windows.getCurrent();
  const popup = await chrome.windows.create({
    url: 'floating_window.html',
    type: 'popup',
    width: 350,
    height: 550,
    focused: true,
    top: currentWindow.top + 50,
    left: currentWindow.left + 50
  });

  floatingWindowId = popup.id;
});


/**
 * Main listener for messages sent from popup.js (the UI).
 * Dispatches actions based on the message content.
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Wrap message handling in an async function to allow awaiting promises
  // and ensure sendResponse is called, even if an error occurs or the port closes.
  const handleMessage = async () => {
    // --- IMPORTANT FIX: Ensure cache is loaded before processing any action ---
    // This addresses the issue of the in-memory cache being reset when the
    // service worker becomes inactive and then wakes up.
    await ensureCacheLoaded(); 
    // --- END IMPORTANT FIX ---

    if (message.action === 'openPractice') {
      // Handles request to open a practice settings page and navigate to a specific tab.
      try {
        await handleOpenPractice(message.input, message.settingType);
        return { success: true };
      } catch (error) {
        console.error(`%c[BL Nav - Background] Error in openPractice: ${error.message}`, 'color: red; font-weight: bold;', error);
        return { error: error.message };
      }
    } else if (message.action === 'getPracticeCache') {
      // Handles request to get the current in-memory practice cache for auto-suggestions.
      console.log(`%c[BL Nav - Background] getPracticeCache requested. Current cache size: ${Object.keys(practiceCache).length}`, 'color: cyan;');
      return { practiceCache: practiceCache };
    } else if (message.action === 'getOdsCodeFromName') {
      // Handles request to get an ODS code from a practice name (used for Mailroom buttons).
      try {
        const odsCode = await getOdsCodeFromName(message.practiceName);
        return { odsCode: odsCode };
      } catch (error) {
        console.error(`%c[BL Nav - Background] Error in getOdsCodeFromName: ${error.message}`, 'color: red; font-weight: bold;', error);
        return { error: error.message };
      }
    } else if (message.action === 'requestActiveScrape') {
        // Handles explicit request from popup.js to perform a visible, foreground scrape.
        try {
            const fetchedPractices = await fetchAndCachePracticeList('active foreground scrape');
            return { success: true, practicesCount: fetchedPractices.length };
        } catch (error) {
            console.error(`%c[BL Nav - Background] Error in active scrape request: ${error.message}`, 'color: red; font-weight: bold;', error);
            return { error: `Failed to load practices: ${error.message}` };
        }
    } else if (message.action === 'getPracticeStatus') { 
        // Handles request to get EHR Type, Quota, and Collected Today for a specific practice.
        try {
            const practiceOds = message.odsCode;
            if (!practiceOds) {
                return { error: "ODS code is required for status lookup." };
            }

            // Attempt to find the practice entry in the current cache.
            // Find the *exact* cache entry for the ODS.
            let practiceEntry = Object.values(practiceCache).find(p => p.ods === practiceOds);
            
            let practiceCDB = 'N/A';
            
            // Prioritize cached CDB from in-memory cdbCache first for speed
            if (cdbCache[practiceOds]) {
                practiceCDB = cdbCache[practiceOds];
                console.log(`%c[BL Nav - Background] CDB found in in-memory cdbCache for ${practiceOds}: ${practiceCDB}`, 'color: green;');
            } else if (practiceEntry && practiceEntry.cdb && practiceEntry.cdb !== 'N/A' && practiceEntry.cdb !== 'Error') {
                // If not in `cdbCache`, check the main `practiceCache` entry (which might have been loaded from storage)
                practiceCDB = practiceEntry.cdb;
                cdbCache[practiceOds] = practiceCDB; // Populate `cdbCache` for future quick access
                console.log(`%c[BL Nav - Background] CDB found in main practiceCache for ${practiceOds}: ${practiceCDB}`, 'color: green;');
            } else {
                // If CDB is missing or marked as error in cache, then scrape it for this specific practice
                try {
                    console.log(`%c[BL Nav - Background] CDB missing for ${practiceOds}. Triggering specific scrape.`, 'color: orange;');
                    practiceCDB = await scrapePracticeCDB(practiceOds);
                    // Update main practiceCache entry with the newly scraped CDB
                    if (practiceEntry) { // Ensure practiceEntry exists before updating its cdb property
                        practiceEntry.cdb = practiceCDB;
                        // Persist updated practiceCache to storage to save the new CDB value
                        await chrome.storage.local.set({ practiceCache: practiceCache }); 
                    }
                } catch (cdbError) {
                    console.warn(`%c[BL Nav - Background] Failed to scrape CDB for ${practiceOds}: ${cdbError.message}`, 'color: orange;');
                    practiceCDB = 'Error'; // Indicate failure in UI
                    if (practiceEntry) {
                        practiceEntry.cdb = 'Error'; // Mark as error in cache
                        await chrome.storage.local.set({ practiceCache: practiceCache });
                    }
                }
            }

            // After attempting to get CDB (either from cache or scrape), retrieve other status details.
            // It's possible the main practiceEntry might be stale or missing some primary details
            // if it wasn't recently scraped via fetchAndCachePracticeList.
            // We ensure we have the most up-to-date details here.
            if (!practiceEntry || practiceEntry.ehrType === undefined || practiceEntry.collectionQuota === undefined || practiceEntry.collectedToday === undefined || practiceEntry.serviceLevel === undefined) {
                console.warn(`%c[BL Nav - Background] Full status data (other than CDB) not found/complete for ODS: ${practiceOds}. Attempting fresh main scrape...`, 'color: orange;');
                // This call updates the main `practiceCache` in the background worker.
                const freshlyScrapedPractices = await fetchAndCachePracticeList('status lookup (full refresh)');
                practiceEntry = Object.values(practiceCache).find(p => p.ods === practiceOds); // Use practiceCache directly after refresh
            }

            // Return status data if the practice entry is now complete.
            if (practiceEntry && practiceEntry.ehrType !== undefined && practiceEntry.collectionQuota !== undefined && practiceEntry.collectedToday !== undefined && practiceEntry.serviceLevel !== undefined) {
                console.log(`%c[BL Nav - Background] Found complete status data for ODS ${practiceOds}:`, 'color: green;', practiceEntry);
                return { 
                    success: true,
                    status: {
                        odsCode: practiceEntry.ods, 
                        ehrType: practiceEntry.ehrType, 
                        collectionQuota: practiceEntry.collectionQuota,
                        collectedToday: practiceEntry.collectedToday,
                        serviceLevel: practiceEntry.serviceLevel,
                        practiceCDB: practiceCDB // Use the resolved CDB
                    }
                };
            } else {
                return { error: `Complete status data not found for practice ${practiceOds} even after trying to refresh.` };
            }
        } catch (error) {
            console.error(`%c[BL Nav - Background] Error in getPracticeStatus: ${error.message}`, 'color: red; font-weight: bold;', error);
            return { error: `Failed to get status: ${error.message}` };
        }
    } else if (message.action === 'searchCDB') { // Handle CDB search request
        try {
            const searchedCDB = message.cdb;
            if (!searchedCDB) {
                return { success: false, error: "CDB code is required for search." };
            }
            console.log(`%c[BL Nav - Background] Initiating CDB search for: "${searchedCDB}"`, 'color: #DA70D6;');

            let foundPractice = null;
            const allPractices = Object.values(practiceCache);

            // First, try to find in already cached CDBs to avoid opening tabs.
            for (const p of allPractices) {
                // Ensure p.cdb exists and is not 'N/A' or 'Error' before comparing
                if (p.cdb && p.cdb !== 'N/A' && p.cdb !== 'Error' && p.cdb === searchedCDB) {
                    foundPractice = { name: p.name, ods: p.ods, cdb: p.cdb };
                    console.log(`%c[BL Nav - Background] Match found in CACHE for CDB "${searchedCDB}": ${p.name} (${p.ods})`, 'color: #32CD32; font-weight: bold;');
                    break;
                }
            }

            // If not found in cached CDBs, then iterate and scrape as needed.
            // This loop *is* the one that would cause "too many pages"
            if (!foundPractice) {
                console.log(`%c[BL Nav - Background] CDB not in cache. Will attempt to scrape practices for match.`, 'color: orange;');
                for (const p of allPractices) {
                    // Only scrape if CDB is not already cached for this specific practice or is 'N/A'/'Error'
                    if (p.ods && (p.cdb === undefined || p.cdb === 'N/A' || p.cdb === 'Error')) {
                        try {
                            const scrapedCDB = await scrapePracticeCDB(p.ods);
                            // Update cache for this practice
                            p.cdb = scrapedCDB;
                            // Persist updated cache immediately after each scrape for robustness
                            await chrome.storage.local.set({ practiceCache: practiceCache }); 
                            // Ensure in-memory cdbCache is updated
                            cdbCache[p.ods] = scrapedCDB;

                            if (scrapedCDB === searchedCDB) {
                                foundPractice = { name: p.name, ods: p.ods, cdb: scrapedCDB };
                                console.log(`%c[BL Nav - Background] Match found by SCRAPE for CDB "${searchedCDB}": ${p.name} (${p.ods})`, 'color: #32CD32; font-weight: bold;');
                                break; // Found a match, no need to check further
                            }
                        } catch (scrapeError) {
                            console.warn(`%c[BL Nav - Background] Could not scrape CDB for ${p.name} (${p.ods}) during search: ${scrapeError.message}`, 'color: orange;');
                            // Mark as error in cache to avoid re-scraping immediately for this practice
                            if (p.cdb === undefined || p.cdb === 'N/A') { // Only mark if not already a valid CDB
                                p.cdb = 'Error';
                                await chrome.storage.local.set({ practiceCache: practiceCache });
                            }
                            // Continue to next practice if one fails
                        }
                    } else if (p.ods && p.cdb === searchedCDB) {
                        // This case handles if it was found in a previous scrape within this loop but not in the initial cache check.
                        foundPractice = { name: p.name, ods: p.ods, cdb: p.cdb };
                        console.log(`%c[BL Nav - Background] Match found (already scraped) for CDB "${searchedCDB}": ${p.name} (${p.ods})`, 'color: #32CD32; font-weight: bold;');
                        break;
                    }
                }
            }

            if (foundPractice) {
                return { success: true, practice: foundPractice };
            } else {
                return { success: false, error: `No practice found for CDB: "${searchedCDB}". Please ensure the CDB is correct.` };
            }

        } catch (error) {
            console.error(`%c[BL Nav - Background] Error during CDB search: ${error.message}`, 'color: red; font-weight: bold;', error);
            return { success: false, error: `Internal error during CDB search: ${error.message}` };
        }
    }
    // If action is not recognized.
    return { error: "Unknown action" };
  };

  // Execute the message handling function and send the response.
  handleMessage().then(response => {
    try {
      sendResponse(response);
    } catch (e) {
      // Catch potential "message port closed" errors if the popup closes before response is sent.
      console.warn('[BL Nav - Background] Failed to send response (message port might be closed):', e.message, 'Response:', response);
    }
  });

  // Indicate that sendResponse will be called asynchronously.
  return true;
});

/**
 * Handles the logic for opening practice settings.
 * Resolves the practice ID and then calls openPracticePage.
 * @param {string} input - The practice name or ODS code.
 * @param {string} settingType - The type of setting to open (e.g., 'basic', 'service').
 */
async function handleOpenPractice(input, settingType) {
  const practiceId = await getOdsCodeFromName(input);
  await openPracticePage(practiceId, settingType);
}

/**
 * Retrieves the ODS code for a given practice input (name or ODS).
 * Prioritizes in-memory cache, but performs an on-demand scrape if not found.
 * @param {string} input - The practice name or ODS code from the UI input field.
 * @returns {Promise<string>} A promise that resolves with the ODS code.
 * @throws {Error} If the practice is not found even after an on-demand scrape.
 */
async function getOdsCodeFromName(input) {
  // If input is already a valid ODS code, return it directly.
  if (/^[A-Z]\d{5}$/.test(input)) return input;

  console.log(`%c[BL Nav - Background] Looking up ODS for: "${input}" (on-demand scrape if needed)`, 'color: blue;');

  const inputLower = input.toLowerCase().trim(); // Normalize input for comparison.

  // Attempt to find in the current in-memory cache first (for speed).
  for (const [key, data] of Object.entries(practiceCache)) {
    // Perform defensive and normalized comparisons against practice name, ODS, and full cached key.
    const dataNameLower = data && data.name ? data.name.toLowerCase().trim() : '';
    const dataOdsLower = data && data.ods ? data.ods.toLowerCase().trim() : '';
    const keyLower = key ? key.toLowerCase().trim() : '';

    if (
      dataNameLower === inputLower || 
      dataOdsLower === inputLower || 
      keyLower === inputLower ||
      (dataNameLower.includes(inputLower) && inputLower.length >= 3) || // Only partial match if significant input
      (dataOdsLower.includes(inputLower) && inputLower.length >= 3)    // Only partial match if significant input
    ) {
        console.log(`%c[BL Nav - Background] Found ODS in memory cache for: "${input}" -> ${data.ods}`, 'color: green;');
        return data.ods;
    }
  }

  // If not found in memory cache, perform an on-demand scrape from BetterLetter AI.
  console.log(`%c[BL Nav - Background] ODS not in memory cache. Performing on-demand scrape for: "${input}"`, 'color: orange;');
  
  // This will fetch a fresh list and update the global practiceCache.
  const freshPracticesArray = await fetchAndCachePracticeList('on-demand lookup'); 
  
  // Try to find the practice in the newly scraped list.
  const matched = freshPracticesArray.find(p => 
      p && (p.name.toLowerCase().trim() === inputLower || p.id.toLowerCase().trim() === inputLower || (p.name.toLowerCase().trim().includes(inputLower) && inputLower.length >= 3))
  );

  if (!matched) {
    // If still not found, throw an error with better suggestions.
    const relevantSuggestions = freshPracticesArray
        .filter(p => p && p.name && p.name.toLowerCase().trim().includes(inputLower))
        .slice(0, 5) // Limit suggestions to a reasonable number
        .map((p) => `"${p.name} (${p.id})"`).join(', ');

    const suggestionText = relevantSuggestions ? `Did you mean: ${relevantSuggestions}?` : 'No close matches found.';
    throw new Error(`Practice "${input}" not found in fresh list. ${suggestionText}`);
  }

  console.log(`%c[BL Nav - Background] ODS found after on-demand scrape for: "${input}" -> ${matched.id}`, 'color: green;');
  return matched.id;
}

/**
 * Opens (or focuses) a practice settings page and then attempts to click a specific tab.
 * @param {string} practiceId - The ODS code of the practice.
 * @param {string} settingType - The type of setting tab to open (e.g., 'basic', 'workflows').
 */
async function openPracticePage(practiceId, settingType) {
  const practiceUrl = `https://app.betterletter.ai/admin_panel/practices/${practiceId}`;
  const existingTabs = await chrome.tabs.query({ url: `${practiceUrl}*` });
  let practiceTab = existingTabs[0];

  const selectorMap = { // Define selectorMap locally for use within this function.
    basic: "[data-test-id='tab-basic']",
    service: "[data-test-id='tab-service']",
    workflows: "[data-test-id='tab-workflows']",
    ehr_settings: "[data-test-id='tab-ehr_settings']"
  };
  const targetTabSelector = selectorMap[settingType];

  if (!targetTabSelector) {
    console.error(`%c[BL Nav - BG] Invalid setting type provided: ${settingType}`, 'color: red;');
    throw new Error(`Invalid setting type: ${settingType}`);
  }

  let newTabCreated = false; // Flag to track if a new tab was created

  if (!practiceTab) {
    console.log(`%c[BL Nav - BG] Creating new tab for practice settings: ${practiceUrl}`, 'color: blue;');
    practiceTab = await chrome.tabs.create({ url: practiceUrl, active: true });
    newTabCreated = true; // Set flag
    // Wait for the *basic* tab to load, indicating the page framework is up.
    await waitForSpecificElementOnTabLoad(practiceTab.id, "[data-test-id='tab-basic']", 15000);
  } else {
    console.log(`%c[BL Nav - BG] Existing tab found for practice settings: ${practiceTab.url}. Focusing tab.`, 'color: blue;');
    await chrome.tabs.update(practiceTab.id, { active: true });
    // Give a moment after focusing, especially if it was a background tab.
    await new Promise(resolve => setTimeout(resolve, 300));
  }

  // Wait for the specific target tab selector to be present BEFORE attempting to click it.
  console.log(`%c[BL Nav - BG] Waiting for target tab element: ${targetTabSelector} to be ready on tab ${practiceTab.id}`, 'color: gray;');
  const targetTabReady = await waitForSpecificElementOnTabLoad(practiceTab.id, targetTabSelector, 10000); // Timeout for specific tab existence.

  if (!targetTabReady) {
    console.error(`%c[BL Nav - BG] Target tab element "${targetTabSelector}" not found on tab ${practiceTab.id} after waiting. Cannot click.`, 'color: red;');
    throw new Error(`Failed to load target setting tab (${settingType}).`);
  }

  // --- RE-INTRODUCING: Small delay only if a new tab was just created,
  //     AFTER the target element is found, but BEFORE clicking.
  //     This gives the SPA a moment to make the element truly interactive.
  if (newTabCreated) {
      console.log(`%c[BL Nav - BG] New tab was created, adding small post-load delay before click for tab interactivity.`, 'color: purple;');
      await new Promise(resolve => setTimeout(resolve, 200)); // 200ms delay
  }
  // --- END RE-INTRODUCING ---

  // Now that we've waited for the specific element, attempt to click it.
  await clickSettingsTab(practiceTab.id, settingType);
}

/**
 * NEW FUNCTION: Scrapes the Practice CDB from a specific practice's EHR Settings page.
 * @param {string} odsCode - The ODS code of the practice to scrape the CDB from.
 * @returns {Promise<string>} The scraped Practice CDB code.
 * @throws {Error} If the CDB cannot be found or the scraping process fails.
 */
async function scrapePracticeCDB(odsCode) {
  // Check in-memory cache first to avoid re-scraping
  if (cdbCache[odsCode]) {
    console.log(`[BL Nav - Background] Returning cached CDB for ${odsCode}: ${cdbCache[odsCode]}`);
    return cdbCache[odsCode];
  }  
    console.log(`%c[BL Nav - Background] Attempting to scrape CDB for ODS: ${odsCode}`, 'color: #FF8C00;');
    let tempTabId = null;
    try {
        const practiceUrl = `https://app.betterletter.ai/admin_panel/practices/${odsCode}`;
        
        // Create a temporary, hidden tab to go to the practice's settings page.
        const tab = await chrome.tabs.create({ url: practiceUrl, active: false }); 
        tempTabId = tab.id;

        // Add a small initial delay immediately after creating the tab to ensure it's truly backgrounded
        await new Promise(resolve => setTimeout(resolve, 100));

        // Wait for the tab to load the Basic Settings tab.
        await waitForSpecificElementOnTabLoad(tab.id, "[data-test-id='tab-basic']", 15000);

        // Click the EHR Settings tab.
        const ehrTabClicked = await chrome.scripting.executeScript({
            target: { tabId: tempTabId },
            func: () => {
                const ehrTab = document.querySelector("[data-test-id='tab-ehr_settings']");
                if (ehrTab) {
                    // Use standard click sequence; ensure all events are dispatched
                    ehrTab.focus(); // Added focus back as it can help with interactivity
                    ehrTab.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
                    ehrTab.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
                    ehrTab.click();
                    console.log('%c[BL Nav - Injected] Clicked EHR Settings tab.', 'color: green;');
                    return true;
                }
                console.error('%c[BL Nav - Injected] EHR Settings tab not found for CDB scrape.', 'color: red;');
                return false;
            }
        });
        
        // Ensure the click was registered before proceeding
        if (!ehrTabClicked[0]?.result) { // Check the result of the executeScript
            console.error(`%c[BL Nav - Background] EHR Settings tab click failed or tab not found for CDB scrape.`, 'color: red;');
            return 'N/A'; // Indicate failure
        }

        // Wait for the CDB input field to appear after clicking EHR Settings.
        const cdbInputSelector = 'input[name="ehr_settings[practice_cdb]"]';
        // INCREASED TIMEOUT and adjusted INTERVAL for robustness in hidden tabs
        const cdbInputReady = await waitForSpecificElementOnTabLoad(tempTabId, cdbInputSelector, 30000, 750); // 30s timeout, 750ms interval

        if (!cdbInputReady) {
            console.error(`%c[BL Nav - Background] CDB input field not found after navigating to EHR Settings tab. EHR content might not have loaded.`, 'color: red;');
            return 'N/A'; // Indicate failure
        }

        // Scrape the value from the CDB input field.
        const result = await chrome.scripting.executeScript({
            target: { tabId: tempTabId },
            func: (selector) => {
                const cdbInput = document.querySelector(selector);
                return cdbInput ? cdbInput.value : null;
            },
            args: [cdbInputSelector]
        });

        const cdbValue = result[0]?.result || 'N/A';
        // Store in in-memory cdbCache immediately for rapid future access within session
        cdbCache[odsCode] = cdbValue;
        console.log(`%c[BL Nav - Background] Scraped CDB for ${odsCode}: "${cdbValue}"`, 'color: #FF8C00;');
        return cdbValue;

    } catch (error) {
        console.error(`%c[BL Nav - Background] ERROR: Failed to scrape CDB for ${odsCode}: ${error.message}`, 'color: red; font-weight: bold;', error);
        throw error;
    } finally {
        if (tempTabId !== null) {
            try {
                await chrome.tabs.remove(tempTabId);
            } catch (e) {
                console.warn(`[BL Nav - Background] Could not close temporary CDB scrape tab ${tempTabId}: ${e.message}`);
            }
        }
    }
}