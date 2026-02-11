// panel.js (Main Controller) - Full Replacement
import { state, setCachedPractices } from './state.js';
import { showToast, showStatus, openTabWithTimeout } from './utils.js';
import * as Navigator from './navigator.js';
import * as Jobs from './jobs.js';
import * as Email from './email.js';

let practiceCacheLoadPromise = null;
let isCdbHydrationTriggered = false;

async function syncPracticeCache({ forceRefresh = false } = {}) {
    if (practiceCacheLoadPromise) return practiceCacheLoadPromise;

    const hasCache = Object.keys(state.cachedPractices || {}).length > 0;
    if (hasCache && !forceRefresh) return state.cachedPractices;

    practiceCacheLoadPromise = (async () => {
        try {
            // Fast path: load currently available cache first (usually from storage/background memory)
            let response = await chrome.runtime.sendMessage({ action: 'getPracticeCache' });
            if (response && response.practiceCache && Object.keys(response.practiceCache).length > 0) {
                setCachedPractices(response.practiceCache);
                Navigator.buildCdbIndex();
                if (!forceRefresh) return response.practiceCache;
            }

            // Refresh path: explicit refresh or empty cache fallback
            await chrome.runtime.sendMessage({ action: 'requestActiveScrape' });
            response = await chrome.runtime.sendMessage({ action: 'getPracticeCache' });
            if (response && response.practiceCache) {
                setCachedPractices(response.practiceCache);
                Navigator.buildCdbIndex();
                return response.practiceCache;
            }
            return {};
        } finally {
            practiceCacheLoadPromise = null;
        }
    })();

    return practiceCacheLoadPromise;
}


async function triggerCdbHydration() {
    if (isCdbHydrationTriggered) return;
    isCdbHydrationTriggered = true;
    try {
        await chrome.runtime.sendMessage({ action: 'hydratePracticeCdb', limit: 30 });
        await syncPracticeCache();
    } catch (e) {
        console.warn('[Panel] CDB hydration skipped.');
    }
}

// --- 1. Global View Switcher ---
function showView(viewId) {
    ['practiceNavigatorView', 'jobManagerView', 'emailFormatterView'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = (id === viewId) ? 'block' : 'none';
    });
    
    const navIds = {
        'practiceNavigatorView': 'navigatorGlobalToggleBtn',
        'jobManagerView': 'jobManagerGlobalToggleBtn',
        'emailFormatterView': 'emailFormatterGlobalToggleBtn'
    };
    
    Object.values(navIds).forEach(btnId => {
        const btn = document.getElementById(btnId);
        if (btn) btn.classList.remove('active-tab');
    });
    const activeBtn = document.getElementById(navIds[viewId]);
    if (activeBtn) activeBtn.classList.add('active-tab');

    if (viewId === 'jobManagerView') {
        Jobs.fetchAndPopulateData();
    }
}


function extractNumericId(value) {
    const raw = (value || '').trim();
    const match = raw.match(/\d+/);
    return match ? match[0] : '';
}

function openUrlForId(baseUrl, id, label = 'ID') {
    if (!id) {
        showToast(`No valid ${label}.`);
        return;
    }

    const url = `${baseUrl}${id}`;
    openTabWithTimeout(url);
}

// --- 2. Global Hide Suggestions ---
function hideSuggestions() {
    setTimeout(() => {
        const ids = ['suggestions', 'cdbSuggestions', 'autocompleteResults', 'practiceAutocompleteResultsContainer', 'jobIdAutocompleteResultsContainer'];
        ids.forEach(id => {
            const el = document.getElementById(id);
            if (el) el.style.display = 'none';
        });
    }, 200); 
}

// --- 3. Main Initialization ---
document.addEventListener('DOMContentLoaded', async () => {
    // A. Visual Cleanup
    Navigator.cleanDuplicateButtons();

    resizeToFitContent();
    
    // C. Setup Navigation Tabs
    document.getElementById("navigatorGlobalToggleBtn")?.addEventListener("click", () => showView('practiceNavigatorView'));
    document.getElementById("jobManagerGlobalToggleBtn")?.addEventListener("click", () => showView('jobManagerView'));
    document.getElementById("emailFormatterGlobalToggleBtn")?.addEventListener("click", () => showView('emailFormatterView'));

    // D. PRACTICE NAVIGATOR LOGIC
    const pInput = document.getElementById('practiceInput');
    if (pInput) {
        pInput.addEventListener('input', async () => {
            await syncPracticeCache();
            Navigator.handleNavigatorInput();
        });
        pInput.addEventListener('focus', async () => {
            await syncPracticeCache();
            Navigator.handleNavigatorInput();
        });
    }

    const cdbInput = document.getElementById('cdbSearchInput');
    if (cdbInput) {
        cdbInput.addEventListener('input', async () => {
            await syncPracticeCache();
            triggerCdbHydration();
            Navigator.handleCdbInput();
        });
        cdbInput.addEventListener('focus', async () => {
            await syncPracticeCache();
            triggerCdbHydration();
            Navigator.handleCdbInput();
        });
    }

    const handleCdbSearchClick = async () => {
        await syncPracticeCache();
        triggerCdbHydration();
        Navigator.handleCdbInput();
    };
    document.getElementById('searchCdbBtn')?.addEventListener('click', handleCdbSearchClick);
    
    // --- Create New Practice Button---
    document.getElementById('createPracticeAdminBtn')?.addEventListener('click', () => {
        openTabWithTimeout('https://app.betterletter.ai/admin_panel/practices/new');
    });

    // --- Show Practices Page ---
    document.getElementById('practicesBtn')?.addEventListener('click', () => {
        openTabWithTimeout('https://app.betterletter.ai/admin_panel/practices');
    });
    
    // 1. Reset Button
    document.getElementById('resetSettingsBtn')?.addEventListener('click', () => {
        if (pInput) pInput.value = '';
        Navigator.clearSelectedPractice();
        showStatus('Settings reset.', 'success');
    });
    
    // 2. Manual Refresh Button
    const liveRefreshBtn = document.getElementById('resetSettingsBtn')?.nextElementSibling;
    if (liveRefreshBtn) {
        liveRefreshBtn.addEventListener('click', async () => {
            showStatus('Refreshing live data...', 'loading');
            try {
                await syncPracticeCache();
                if (state.currentSelectedOdsCode) {
                    await Navigator.displayPracticeStatus();
                }
                showStatus('Data updated!', 'success');
            } catch (e) {
                showStatus('Refresh failed.', 'error');
            }
        });
    }

    // E. Global URL Opening Helper
    const openUrl = (suffix) => {
        try {
            const ods = Navigator.requireSelectedOdsCode();
            let url = `https://app.betterletter.ai/`;
            if (suffix === 'dashboard') url = `https://app.betterletter.ai/admin_panel/bots/dashboard?job_types=docman_import+emis_prepare&practice_ids=${ods}&status=paused`;
            else if (suffix === 'preparing') url = `https://app.betterletter.ai/mailroom/preparing?only_action_items=true&practice=${ods}&service=self&sort=upload_date&sort_dir=asc&urgent=false`;
            else if (suffix === 'rejected') url = `https://app.betterletter.ai/mailroom/rejected?practice=${ods}&service=full&show_processed=false&sort=inserted_at&sort_dir=asc`;
            else if (suffix === 'users') url = `https://app.betterletter.ai/mailroom/practices/${ods}/users`;
            chrome.tabs.create({ url });
        } catch (e) { showToast(e.message); }
    };

    document.getElementById('collectionBtn')?.addEventListener('click', () => openUrl('dashboard'));
    document.getElementById('usersBtn')?.addEventListener('click', () => openUrl('users'));
    document.getElementById('preparingBtn')?.addEventListener('click', () => openUrl('preparing'));
    document.getElementById('rejectedBtn')?.addEventListener('click', () => openUrl('rejected'));

    // F. EHR & Task Settings
    document.getElementById('taskRecipientsBtn')?.addEventListener('click', async () => {
        try {
            const ods = Navigator.requireSelectedOdsCode();
            await chrome.runtime.sendMessage({ action: 'openPractice', input: ods, settingType: 'task_recipients' });
        } catch (err) { showToast(err.message); }
    });

    document.getElementById('openEhrSettingsBtn')?.addEventListener('click', async () => {
        try {
            const ods = Navigator.requireSelectedOdsCode();
            await chrome.runtime.sendMessage({ action: 'openPractice', input: ods, settingType: 'ehr_settings' });
        } catch (e) { showToast(e.message); }
    });

    // Job Dropdowns
    const openJobDashboard = (jobType) => {
        if (!jobType) return;
        try {
            const ods = Navigator.requireSelectedOdsCode();
            const url = `https://app.betterletter.ai/admin_panel/bots/dashboard?job_types=${encodeURIComponent(jobType)}&practice_ids=${encodeURIComponent(ods)}&status=paused`;
            openTabWithTimeout(url);
        } catch (e) { showToast(e.message); }
    };

    document.getElementById('docmanJobSelectNav')?.addEventListener('change', (e) => { openJobDashboard(e.target.value); e.target.value = ''; });
    document.getElementById('emisJobSelectNav')?.addEventListener('change', (e) => { openJobDashboard(e.target.value); e.target.value = ''; });

    // I. EMAIL FORMATTER LOGIC
    document.getElementById("convertEmailBtn")?.addEventListener("click", Email.convertEmails);
    document.getElementById("nameOnlyBtn")?.addEventListener("click", Email.convertEmailsToNamesOnly);
    document.getElementById("copyEmailBtn")?.addEventListener("click", Email.copyEmails);


    // K. JOB PANEL QUICK ACTIONS
    const manualDocIdInput = document.getElementById('manualDocId');
    const jobStatusInput = document.getElementById('jobStatusInput');

    document.getElementById('btnJobs')?.addEventListener('click', () => {
        const id = extractNumericId(manualDocIdInput?.value);
        openUrlForId('https://app.betterletter.ai/admin_panel/bots/dashboard?document_id=', id, 'Document ID');
    });

    document.getElementById('btnOban')?.addEventListener('click', () => {
        const id = extractNumericId(manualDocIdInput?.value);
        if (!id) {
            showToast('No valid Document ID.');
            return;
        }
        openTabWithTimeout(`https://app.betterletter.ai/oban/jobs?args=document_id%2B%2B${id}&state=available`);
    });

    document.getElementById('btnLog')?.addEventListener('click', () => {
        const id = extractNumericId(manualDocIdInput?.value);
        openUrlForId('https://app.betterletter.ai/admin_panel/event_log/', id, 'Document ID');
    });

    document.getElementById('btnAdmin')?.addEventListener('click', () => {
        const id = extractNumericId(manualDocIdInput?.value);
        openUrlForId('https://app.betterletter.ai/admin_panel/letter/', id, 'Document ID');
    });

    document.getElementById('openJobStatusBtn')?.addEventListener('click', () => {
        const jobId = extractNumericId(jobStatusInput?.value);
        openUrlForId('https://app.betterletter.ai/admin_panel/bots/jobs/', jobId, 'Job ID');
    });

    document.getElementById('clearJobStatusInputBtn')?.addEventListener('click', () => {
        if (jobStatusInput) {
            jobStatusInput.value = '';
            jobStatusInput.focus();
        }
    });

    // J. Global UI Listeners
    document.addEventListener("mousedown", (e) => {
        // List of all inputs that should NOT hide the dropdown when clicked
        const safeInputs = [
            'practiceInput', 
            'cdbSearchInput' 
        ];

        const isInput = safeInputs.includes(e.target.id);
        const isList = e.target.closest('ul') || e.target.closest('.custom-autocomplete-results');

        // ONLY hide if the click was NOT on an input and NOT on the list itself
        if (!isInput && !isList) {
            hideSuggestions();
        }
    });

    showView('practiceNavigatorView');

    // B. Initial Data Load (non-blocking so top navigation responds immediately)
    try {
        const cache = await syncPracticeCache();
        const cacheSize = Object.keys(cache || {}).length;

        if (cacheSize === 0) {
            // Compatibility fallback when background returns cache without scrape refresh
            const response = await chrome.runtime.sendMessage({ action: 'getPracticeCache' });
            if (response && response.practiceCache) {
                setCachedPractices(response.practiceCache);
                Navigator.buildCdbIndex();
                console.log('Cache loaded:', Object.keys(response.practiceCache).length);
                return;
            }
        }

        console.log('Cache loaded:', cacheSize);
    } catch (e) { console.error("Cache load error:", e); }
});

// --- G. SILENT AUTO-SCAN LOGIC ---
let isPanelScrapingBusy = false;
let lastBackgroundRefreshAt = 0;

setInterval(async () => {
  const navView = document.getElementById('practiceNavigatorView');
  const isVisible = navView && navView.style.display !== 'none';
  
  // 🛡️ NEW SAFETY: Don't scan if the user is currently typing in the search box
  const isTyping = document.activeElement === document.getElementById('practiceInput');
  
  if (isVisible && !isPanelScrapingBusy && state.currentSelectedOdsCode && !isTyping) {
    isPanelScrapingBusy = true;

    try {
      const now = Date.now();
      // Force one background refresh at most once per minute to avoid cache churn/timeouts
      if (now - lastBackgroundRefreshAt > 60000) {
        await syncPracticeCache({ forceRefresh: true });
        lastBackgroundRefreshAt = now;
      } else {
        await syncPracticeCache();
      }

      await Navigator.displayPracticeStatus();
    } catch (e) {
      console.warn("[Panel] Scan skipped.");
    } finally {
      setTimeout(() => { isPanelScrapingBusy = false; }, 5000);
    }
  }
}, 5000);

function resizeToFitContent(extraHeight = 40) {
  const width = document.documentElement.scrollWidth;
  const height = document.documentElement.scrollHeight;
  window.resizeTo(width + 20, height + extraHeight);
}

window.addEventListener('DOMContentLoaded', () => {
  resizeToFitContent(40, 750); // You can tweak the 700px value
});
