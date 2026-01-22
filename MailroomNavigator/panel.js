// panel.js (Main Controller) - Full Replacement
import { state, setCachedPractices } from './state.js';
import { showToast, showStatus, openTabWithTimeout } from './utils.js';
import * as Navigator from './navigator.js';
import * as Jobs from './jobs.js';
import * as Email from './email.js';

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

    // B. Initial Data Load
    try {
        const response = await chrome.runtime.sendMessage({ action: 'getPracticeCache' });
        if (response && response.practiceCache) {
            setCachedPractices(response.practiceCache);
            Navigator.buildCdbIndex();
            console.log('Cache loaded:', Object.keys(response.practiceCache).length);
        }
    } catch (e) { console.error("Cache load error:", e); }
    
    // C. Setup Navigation Tabs
    document.getElementById("navigatorGlobalToggleBtn")?.addEventListener("click", () => showView('practiceNavigatorView'));
    document.getElementById("jobManagerGlobalToggleBtn")?.addEventListener("click", () => showView('jobManagerView'));
    document.getElementById("emailFormatterGlobalToggleBtn")?.addEventListener("click", () => showView('emailFormatterView'));

    // D. PRACTICE NAVIGATOR LOGIC
    const pInput = document.getElementById('practiceInput');
    if (pInput) {
        pInput.addEventListener('input', Navigator.handleNavigatorInput);
        pInput.addEventListener('focus', Navigator.handleNavigatorInput);
    }

    const cdbInput = document.getElementById('cdbSearchInput');
    if (cdbInput) {
        cdbInput.addEventListener('input', Navigator.handleCdbInput);
        cdbInput.addEventListener('focus', Navigator.handleCdbInput);
    }
    
    // --- FIX: Added handlers for missing buttons ---
    document.getElementById('createPracticeAdminBtn')?.addEventListener('click', () => {
        openTabWithTimeout('https://app.betterletter.ai/admin_panel/practices/new');
    });

    document.getElementById('practicesBtn')?.addEventListener('click', () => {
        openTabWithTimeout('https://app.betterletter.ai/admin_panel/practices');
    });

    document.getElementById('searchCdbBtn')?.addEventListener('click', () => {
        Navigator.handleCdbInput();
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
                await chrome.runtime.sendMessage({ action: 'requestActiveScrape' });
                const response = await chrome.runtime.sendMessage({ action: 'getPracticeCache' });
                if (response && response.practiceCache) {
                    setCachedPractices(response.practiceCache);
                    Navigator.buildCdbIndex();
                }
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

    // G. Job Dropdowns
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

    // H. JOB MANAGER LOGIC
    document.getElementById("documentDropdown")?.addEventListener("input", (e) => {
        const val = e.target.value.trim();
        const actions = document.getElementById('documentActionsSection');
        if (actions) actions.style.display = /^\d+$/.test(val) ? 'block' : 'none';
        Jobs.filterAndDisplaySuggestions();
    });
    
    document.getElementById("documentDropdown")?.addEventListener("focus", Jobs.filterAndDisplaySuggestions);

    const docAction = (type) => {
        const val = document.getElementById("documentDropdown").value.trim();
        const id = val.match(/^\d+$/) ? val : null;
        if (!id) return showToast("Invalid Doc ID");
        let url = "";
        if (type === 'status') url = `https://app.betterletter.ai/admin_panel/bots/dashboard?document_id=${id}`;
        if (type === 'oban') url = `https://app.betterletter.ai/oban/jobs?args=document_id%2B%2B${id}&state=available`;
        if (type === 'anno') url = `https://app.betterletter.ai/mailroom/annotations/${id}`;
        if (type === 'log') url = `https://app.betterletter.ai/admin_panel/event_log/${id}`;
        if (type === 'admin') url = `https://app.betterletter.ai/admin_panel/letter/${id}`;
        navigator.clipboard.writeText(url);
        showToast("URL Copied!");
        openTabWithTimeout(url);
    };

    document.getElementById("openDocumentStatus")?.addEventListener("click", () => docAction('status'));
    document.getElementById("openObanJob")?.addEventListener("click", () => docAction('oban'));
    document.getElementById("openAnnotation")?.addEventListener("click", () => docAction('anno'));
    document.getElementById("openEventLog")?.addEventListener("click", () => docAction('log'));
    document.getElementById("openLetterAdmin")?.addEventListener("click", () => docAction('admin'));
    
    document.getElementById("clearDocId")?.addEventListener("click", () => {
        const di = document.getElementById("documentDropdown");
        if (di) di.value = "";
        const das = document.getElementById('documentActionsSection');
        if (das) das.style.display = 'none';
    });

    // I. EMAIL FORMATTER LOGIC
    document.getElementById("convertEmailBtn")?.addEventListener("click", Email.convertEmails);
    document.getElementById("nameOnlyBtn")?.addEventListener("click", Email.convertEmailsToNamesOnly);
    document.getElementById("copyEmailBtn")?.addEventListener("click", Email.copyEmails);

    // J. Global UI Listeners
    document.addEventListener("mousedown", (e) => {
        // List of all inputs that should NOT hide the dropdown when clicked
        const safeInputs = [
            'practiceInput', 
            'documentDropdown', 
            'job-id', 
            'practiceDropdown', 
            'cdbSearchInput' // We added this to the "safe" list
        ];

        const isInput = safeInputs.includes(e.target.id);
        const isList = e.target.closest('ul') || e.target.closest('.custom-autocomplete-results');

        // ONLY hide if the click was NOT on an input and NOT on the list itself
        if (!isInput && !isList) {
            hideSuggestions();
        }
    });

    showView('practiceNavigatorView');
});

// --- G. SILENT AUTO-SCAN LOGIC ---
let isPanelScrapingBusy = false;

setInterval(async () => {
  const navView = document.getElementById('practiceNavigatorView');
  const isVisible = navView && navView.style.display !== 'none';
  
  // 🛡️ NEW SAFETY: Don't scan if the user is currently typing in the search box
  const isTyping = document.activeElement === document.getElementById('practiceInput');
  
  if (isVisible && !isPanelScrapingBusy && state.currentSelectedOdsCode && !isTyping) {
    isPanelScrapingBusy = true; 
    
    try {
      await chrome.runtime.sendMessage({ action: 'requestActiveScrape' });
      const response = await chrome.runtime.sendMessage({ action: 'getPracticeCache' });
      if (response && response.practiceCache) {
        setCachedPractices(response.practiceCache);
        Navigator.buildCdbIndex();
      }
      // Only refresh the status display if the user isn't busy looking at suggestions
      await Navigator.displayPracticeStatus();
    } catch (e) {
      console.warn("[Panel] Scan skipped.");
    } finally {
      setTimeout(() => { isPanelScrapingBusy = false; }, 10000);
    }
  }
}, 5000);

window.addEventListener('DOMContentLoaded', () => {
  // Auto-resize the popup window to tightly fit the content
  const width = document.documentElement.scrollWidth;
  const height = document.documentElement.scrollHeight;

  window.resizeTo(width + 20, height + 40); // Padding for scrollbar & borders
});