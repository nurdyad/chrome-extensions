// panel.js (Main Controller)
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
        document.getElementById(btnId).classList.remove('active-tab');
    });
    document.getElementById(navIds[viewId]).classList.add('active-tab');

    if (viewId === 'jobManagerView') {
        Jobs.fetchAndPopulateData();
    }
}

// --- 2. Global Hide Suggestions ---
function hideSuggestions() {
    setTimeout(() => {
        const ids = ['autocompleteResults', 'practiceAutocompleteResultsContainer', 'suggestions', 'cdbSuggestions', 'jobIdAutocompleteResultsContainer'];
        ids.forEach(id => {
            const el = document.getElementById(id);
            if (el) el.style.display = 'none';
        });
    }, 150);
}

// --- 3. Main Initialization ---
document.addEventListener('DOMContentLoaded', async () => {
    
    // --- A. Setup Navigation Tabs ---
    document.getElementById("navigatorGlobalToggleBtn").addEventListener("click", () => showView('practiceNavigatorView'));
    document.getElementById("jobManagerGlobalToggleBtn").addEventListener("click", () => showView('jobManagerView'));
    document.getElementById("emailFormatterGlobalToggleBtn").addEventListener("click", () => showView('emailFormatterView'));

    // --- B. Load Cache from Background ---
    try {
        const response = await chrome.runtime.sendMessage({ action: 'getPracticeCache' });
        if (response && response.practiceCache) {
            setCachedPractices(response.practiceCache);
            Navigator.buildCdbIndex();
            console.log('Cache loaded:', Object.keys(response.practiceCache).length);
        }
    } catch (e) { console.error("Cache load error:", e); }

    // --- C. PRACTICE NAVIGATOR LOGIC ---
    
    const pInput = document.getElementById('practiceInput');
    pInput.addEventListener('input', Navigator.handleNavigatorInput);
    pInput.addEventListener('focus', Navigator.handleNavigatorInput);

    const cdbInput = document.getElementById('cdbSearchInput');
    cdbInput.addEventListener('input', Navigator.handleCdbInput);
    cdbInput.addEventListener('focus', Navigator.handleCdbInput);
    
    // --- 1. The RESET Button (Clears the search box) ---
    document.getElementById('resetSettingsBtn').addEventListener('click', () => {
        pInput.value = '';
        Navigator.clearSelectedPractice();
        showStatus('Settings reset.', 'success');
    });
    
    // --- 2. The LIVE REFRESH Button (Force a new scan) ---
    // We target the blue refresh button next to the reset button
    const liveRefreshBtn = document.getElementById('resetSettingsBtn').nextElementSibling;
    if (liveRefreshBtn) {
        liveRefreshBtn.addEventListener('click', async () => {
            showStatus('Refreshing live data...', 'loading');
            try {
                // Tells background to scrape the page again
                await chrome.runtime.sendMessage({ action: 'requestActiveScrape' });
                
                // Get the updated cache
                const response = await chrome.runtime.sendMessage({ action: 'getPracticeCache' });
                if (response && response.practiceCache) {
                    setCachedPractices(response.practiceCache);
                    Navigator.buildCdbIndex();
                }
                
                // Refresh the display for the current practice
                if (state.currentSelectedOdsCode) {
                    await Navigator.displayPracticeStatus();
                }
                showStatus('Data updated!', 'success');
            } catch (e) {
                showStatus('Refresh failed: ' + e.message, 'error');
            }
        });
    }

    // Helper for URL opening logic
    const openUrl = (suffix) => {
        try {
            const ods = Navigator.requireSelectedOdsCode();
            let url = `https://app.betterletter.ai/`;
            
            // Map specific suffixes to their full URLs based on your original code
            if (suffix === 'dashboard') {
                url = `https://app.betterletter.ai/admin_panel/bots/dashboard?job_types=docman_import+emis_prepare&practice_ids=${ods}&status=paused`;
            } else if (suffix === 'preparing') {
                url = `https://app.betterletter.ai/mailroom/preparing?only_action_items=true&practice=${ods}&service=self&sort=upload_date&sort_dir=asc&urgent=false`;
            } else if (suffix === 'rejected') {
                url = `https://app.betterletter.ai/mailroom/rejected?practice=${ods}&service=full&show_processed=false&sort=inserted_at&sort_dir=asc`;
            } else if (suffix === 'users') {
                 url = `https://app.betterletter.ai/mailroom/practices/${ods}/users`;
            }
            
            chrome.tabs.create({ url });
        } catch (e) {
            showToast(e.message);
        }
    };

    document.getElementById('collectionBtn').addEventListener('click', () => openUrl('dashboard'));
    document.getElementById('usersBtn').addEventListener('click', () => openUrl('users'));
    document.getElementById('preparingBtn').addEventListener('click', () => openUrl('preparing'));
    document.getElementById('rejectedBtn').addEventListener('click', () => openUrl('rejected'));

    // Task Recipients (from your uploaded panel.js)
    const taskRecipientsBtn = document.getElementById('taskRecipientsBtn');
    if (taskRecipientsBtn) {
        taskRecipientsBtn.addEventListener('click', async () => {
            try {
                const ods = Navigator.requireSelectedOdsCode();
                await chrome.runtime.sendMessage({
                    action: 'openPractice',
                    input: ods,
                    settingType: 'task_recipients'
                });
            } catch (err) {
                showToast(err.message);
            }
        });
    }

    document.getElementById('practicesBtn').addEventListener('click', () => chrome.tabs.create({ url: 'https://app.betterletter.ai/admin_panel/practices' }));
    document.getElementById('createPracticeAdminBtn').addEventListener('click', () => chrome.tabs.create({ url: 'https://app.betterletter.ai/admin_panel/practices/new' }));

    // EHR Settings Button
    const ehrBtn = document.getElementById('openEhrSettingsBtn');
    if (ehrBtn) {
        ehrBtn.addEventListener('click', async () => {
            try {
                const ods = Navigator.requireSelectedOdsCode();
                await chrome.runtime.sendMessage({ action: 'openPractice', input: ods, settingType: 'ehr_settings' });
            } catch (e) { showToast(e.message); }
        });
    }

    // Dropdowns (Docman/EMIS)
    const openJobDashboard = (jobType) => {
        if (!jobType) return;
        try {
            const ods = Navigator.requireSelectedOdsCode();
            const url = `https://app.betterletter.ai/admin_panel/bots/dashboard?job_types=${encodeURIComponent(jobType)}&practice_ids=${encodeURIComponent(ods)}&status=paused`;
            openTabWithTimeout(url);
        } catch (e) { showToast(e.message); }
    };

    const dSelect = document.getElementById('docmanJobSelectNav');
    if (dSelect) dSelect.addEventListener('change', (e) => { openJobDashboard(e.target.value); e.target.value = ''; });

    const eSelect = document.getElementById('emisJobSelectNav');
    if (eSelect) eSelect.addEventListener('change', (e) => { openJobDashboard(e.target.value); e.target.value = ''; });


    // --- D. JOB MANAGER LOGIC ---
    
    document.getElementById("documentDropdown").addEventListener("input", (e) => {
        const val = e.target.value.trim();
        const actions = document.getElementById('documentActionsSection');
        if (actions) actions.style.display = /^\d+$/.test(val) ? 'block' : 'none';
        Jobs.filterAndDisplaySuggestions();
    });
    
    document.getElementById("documentDropdown").addEventListener("focus", Jobs.filterAndDisplaySuggestions);

    // Buttons - Document Actions
    const getDocId = () => {
        const val = document.getElementById("documentDropdown").value.trim();
        const match = val.match(/^\d+$/);
        return match ? match[0] : null;
    };
    
    const docAction = (type) => {
        const id = getDocId();
        if (!id) return showToast("Invalid Doc ID");
        let url = "";
        if (type === 'status') url = `https://app.betterletter.ai/admin_panel/bots/dashboard?document_id=${id}`;
        if (type === 'oban') url = `https://app.betterletter.ai/oban/jobs?args=document_id%2B%2B${id}&state=available`;
        if (type === 'anno') url = `https://app.betterletter.ai/mailroom/annotations/${id}`;
        if (type === 'log') url = `https://app.betterletter.ai/admin_panel/event_log/${id}`;
        if (type === 'admin') url = `https://app.betterletter.ai/admin_panel/letter/${id}`;
        
        navigator.clipboard.writeText(url);
        showToast("URL Copied & Opening...");
        openTabWithTimeout(url);
    };

    document.getElementById("openDocumentStatus").addEventListener("click", () => docAction('status'));
    document.getElementById("openObanJob").addEventListener("click", () => docAction('oban'));
    document.getElementById("openAnnotation").addEventListener("click", () => docAction('anno'));
    document.getElementById("openEventLog").addEventListener("click", () => docAction('log'));
    document.getElementById("openLetterAdmin").addEventListener("click", () => docAction('admin'));
    
    document.getElementById("clearDocId").addEventListener("click", () => {
        document.getElementById("documentDropdown").value = "";
        document.getElementById('documentActionsSection').style.display = 'none';
    });

    // --- E. EMAIL FORMATTER LOGIC ---
    document.getElementById("convertEmailBtn").addEventListener("click", Email.convertEmails);
    const nameOnlyBtn = document.getElementById("nameOnlyBtn");
    if(nameOnlyBtn) nameOnlyBtn.addEventListener("click", Email.convertEmailsToNamesOnly);
    document.getElementById("copyEmailBtn").addEventListener("click", Email.copyEmails);

    // --- F. Global Listeners ---
    document.addEventListener("mousedown", (e) => {
        const isInput = ['practiceInput', 'documentDropdown', 'job-id', 'practiceDropdown'].includes(e.target.id);
        const isList = e.target.closest('ul') || e.target.closest('.custom-autocomplete-results');
        if (!isInput && !isList) hideSuggestions();
    });

    // Start on Navigator
    showView('practiceNavigatorView');
});