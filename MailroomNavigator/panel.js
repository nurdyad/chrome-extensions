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

function extractAllNumericIds(value) {
    const matches = String(value || '').match(/\d+/g) || [];
    return [...new Set(matches.map(id => id.trim()).filter(Boolean))];
}

function getDocumentActionUrl(action, id) {
    if (!id) return '';
    if (action === 'jobs') return `https://app.betterletter.ai/admin_panel/bots/dashboard?document_id=${id}`;
    if (action === 'oban') return `https://app.betterletter.ai/oban/jobs?args=document_id%2B%2B${id}&state=available`;
    if (action === 'log') return `https://app.betterletter.ai/admin_panel/event_log/${id}`;
    if (action === 'admin') return `https://app.betterletter.ai/admin_panel/letter/${id}`;
    return '';
}

function getJobStatusUrl(jobId) {
    return jobId ? `https://app.betterletter.ai/admin_panel/bots/jobs/${jobId}` : '';
}

async function openUrlsWithLoading(urls, actionButtons = []) {
    const cleanUrls = urls.filter(Boolean);
    if (cleanUrls.length === 0) return;

    actionButtons.forEach(btn => { if (btn) btn.disabled = true; });
    try {
        for (const url of cleanUrls) {
            await chrome.tabs.create({ url });
            await new Promise(resolve => setTimeout(resolve, 60));
        }
    } finally {
        actionButtons.forEach(btn => { if (btn) btn.disabled = false; });
    }
}

function copyUrlsToClipboard(urls, label = 'URLs') {
    const cleanUrls = urls.filter(Boolean);
    if (cleanUrls.length === 0) {
        showToast(`No valid ${label}.`);
        return;
    }

    navigator.clipboard.writeText(cleanUrls.join('\n'))
        .then(() => showToast(`${cleanUrls.length} ${label} copied.`))
        .catch(() => showToast('Copy failed.'));
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
    const bulkIdsInput = document.getElementById('bulkIdsInput');
    const bulkActionType = document.getElementById('bulkActionType');

    const manualDocValidation = document.getElementById('manualDocValidation');
    const jobStatusValidation = document.getElementById('jobStatusValidation');
    const bulkIdsValidation = document.getElementById('bulkIdsValidation');

    const recentDocIdsChips = document.getElementById('recentDocIdsChips');
    const recentJobIdsChips = document.getElementById('recentJobIdsChips');

    const btnJobs = document.getElementById('btnJobs');
    const btnOban = document.getElementById('btnOban');
    const btnLog = document.getElementById('btnLog');
    const btnAdmin = document.getElementById('btnAdmin');
    const openJobStatusBtn = document.getElementById('openJobStatusBtn');
    const clearJobStatusInputBtn = document.getElementById('clearJobStatusInputBtn');

    const copyJobsUrlBtn = document.getElementById('copyJobsUrlBtn');
    const copyObanUrlBtn = document.getElementById('copyObanUrlBtn');
    const copyLogUrlBtn = document.getElementById('copyLogUrlBtn');
    const copyAdminUrlBtn = document.getElementById('copyAdminUrlBtn');
    const copyJobStatusUrlBtn = document.getElementById('copyJobStatusUrlBtn');
    const copyJobStatusLinkBtn = document.getElementById('copyJobStatusLinkBtn');

    const openBulkActionBtn = document.getElementById('openBulkActionBtn');
    const copyBulkActionBtn = document.getElementById('copyBulkActionBtn');

    const runUuidPickerToolBtn = document.getElementById('runUuidPickerToolBtn');
    const runListDocmanGroupsToolBtn = document.getElementById('runListDocmanGroupsToolBtn');

    const workflowNamesInput = document.getElementById('workflowNamesInput');
    const workflowSkipDuplicates = document.getElementById('workflowSkipDuplicates');
    const workflowTitleCase = document.getElementById('workflowTitleCase');
    const workflowStatus = document.getElementById('workflowStatus');
    const workflowProgressTrack = document.getElementById('workflowProgressTrack');
    const workflowProgressBar = document.getElementById('workflowProgressBar');
    const runWorkflowBulkBtn = document.getElementById('runWorkflowBulkBtn');
    const testWorkflowParseBtn = document.getElementById('testWorkflowParseBtn');

    let recentDocIds = [];
    let recentJobIds = [];

    const setValidationBadge = (el, isValid, neutralText, validText, invalidText) => {
        if (!el) return;
        el.classList.remove('neutral', 'valid', 'invalid');
        if (isValid === null) {
            el.classList.add('neutral');
            el.textContent = neutralText;
        } else if (isValid) {
            el.classList.add('valid');
            el.textContent = validText;
        } else {
            el.classList.add('invalid');
            el.textContent = invalidText;
        }
    };

    const saveRecentIds = async () => {
        await chrome.storage.local.set({ recentDocIds, recentJobIds });
    };

    const pushRecentId = async (type, id) => {
        if (!id) return;
        if (type === 'doc') {
            recentDocIds = [id, ...recentDocIds.filter(x => x !== id)].slice(0, 5);
        } else {
            recentJobIds = [id, ...recentJobIds.filter(x => x !== id)].slice(0, 5);
        }
        await saveRecentIds();
        renderRecentIdChips();
    };

    const createChip = (id, type) => {
        const chip = document.createElement('button');
        chip.className = 'id-chip';
        chip.textContent = id;
        chip.title = type === 'doc' ? 'Open Jobs dashboard for this ID' : 'Open Job status for this ID';
        chip.addEventListener('click', async () => {
            if (type === 'doc') {
                if (manualDocIdInput) manualDocIdInput.value = id;
                updateDocValidation();
                await openUrlsWithLoading([getDocumentActionUrl('jobs', id)], [btnJobs]);
            } else {
                if (jobStatusInput) jobStatusInput.value = id;
                updateJobValidation();
                await openUrlsWithLoading([getJobStatusUrl(id)], [openJobStatusBtn]);
            }
        });
        return chip;
    };

    const renderRecentIdChips = () => {
        if (recentDocIdsChips) {
            recentDocIdsChips.innerHTML = '';
            recentDocIds.forEach(id => recentDocIdsChips.appendChild(createChip(id, 'doc')));
        }
        if (recentJobIdsChips) {
            recentJobIdsChips.innerHTML = '';
            recentJobIds.forEach(id => recentJobIdsChips.appendChild(createChip(id, 'job')));
        }
    };

    const updateDocValidation = () => {
        const id = extractNumericId(manualDocIdInput?.value);
        setValidationBadge(
            manualDocValidation,
            manualDocIdInput?.value ? Boolean(id) : null,
            'Enter a numeric Document ID.',
            `✓ Valid Document ID: ${id}`,
            '✕ Invalid Document ID.'
        );
        return id;
    };

    const updateJobValidation = () => {
        const id = extractNumericId(jobStatusInput?.value);
        setValidationBadge(
            jobStatusValidation,
            jobStatusInput?.value ? Boolean(id) : null,
            'Enter a numeric Job ID.',
            `✓ Valid Job ID: ${id}`,
            '✕ Invalid Job ID.'
        );
        return id;
    };

    const updateBulkValidation = () => {
        const ids = extractAllNumericIds(bulkIdsInput?.value);
        setValidationBadge(
            bulkIdsValidation,
            ids.length > 0 ? true : (bulkIdsInput?.value ? false : null),
            'No IDs detected yet.',
            `✓ ${ids.length} IDs ready`,
            '✕ No valid numeric IDs found.'
        );
        return ids;
    };

    const handleDocAction = async (action, actionButton) => {
        const id = updateDocValidation();
        if (!id) return showToast('No valid Document ID.');
        await pushRecentId('doc', id);
        await openUrlsWithLoading([getDocumentActionUrl(action, id)], [actionButton]);
    };

    const handleCopyDocAction = (action) => {
        const id = updateDocValidation();
        if (!id) return showToast('No valid Document ID.');
        copyUrlsToClipboard([getDocumentActionUrl(action, id)], 'URL');
    };

    const getBestBetterLetterTab = async () => {
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (activeTab?.url?.startsWith('https://app.betterletter.ai/')) {
            return activeTab;
        }

        const betterLetterTabs = await chrome.tabs.query({ url: 'https://app.betterletter.ai/*' });
        if (!betterLetterTabs.length) return null;

        return betterLetterTabs
            .slice()
            .sort((a, b) => {
                const activeDiff = Number(Boolean(b.active)) - Number(Boolean(a.active));
                if (activeDiff !== 0) return activeDiff;

                const lastAccessedDiff = Number(b.lastAccessed || 0) - Number(a.lastAccessed || 0);
                if (lastAccessedDiff !== 0) return lastAccessedDiff;

                return Number(b.id || 0) - Number(a.id || 0);
            })[0] || null;
    };

    const tryAutoSelectPracticeFromActiveTab = async () => {
        try {
            const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
            const url = activeTab?.url || '';
            if (!url.startsWith('https://app.betterletter.ai/')) return;

            const odsFromPracticePath = url.match(/\/admin_panel\/practices\/([A-Za-z]\d{5})/);
            const odsFromQuery = url.match(/[?&]practice_ids=([A-Za-z]\d{5})/) || url.match(/[?&]practice=([A-Za-z]\d{5})/);
            const candidate = (odsFromPracticePath?.[1] || odsFromQuery?.[1] || '').toUpperCase();
            if (!/^[A-Z]\d{5}$/.test(candidate)) return;

            Navigator.setSelectedPractice(candidate, { updateInput: true, triggerStatus: false });
        } catch (error) {
            console.warn('[Panel] Could not auto-select practice from active tab.');
        }
    };

    const runBookmarkletTool = async (toolName) => {
        try {
            const tab = await getBestBetterLetterTab();
            if (!tab?.id) {
                showToast('Open a BetterLetter tab first.');
                return;
            }

            await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                files: ['bookmarklet_tools.js']
            });

            await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                func: (name) => {
                    if (!window.mailroomBookmarkletTools) {
                        alert('Bookmarklet tools failed to load.');
                        return;
                    }
                    window.mailroomBookmarkletTools.run(name);
                },
                args: [toolName]
            });

            showToast('Tool executed.');
        } catch (err) {
            console.error('Bookmarklet tool failed:', err);
            showToast('Tool failed to run.');
        }
    };

    const parseWorkflowNames = (rawValue) => String(rawValue || '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
            if (line.includes('\t')) return line.split('\t')[0].trim();
            const commaCount = (line.match(/,/g) || []).length;
            if (commaCount >= 2) return line.split(',')[0].trim();
            return line;
        })
        .filter(Boolean);

    const formatEta = (ms) => {
        if (!Number.isFinite(ms) || ms <= 0) return '—';
        const seconds = Math.ceil(ms / 1000);
        if (seconds < 60) return `${seconds}s`;
        const mins = Math.floor(seconds / 60);
        const remaining = seconds % 60;
        return `${mins}m ${remaining}s`;
    };

    let workflowRunState = {
        running: false,
        startedAt: 0,
        total: 0
    };

    const updateWorkflowStatus = (message, tone = null) => {
        if (!workflowStatus) return;
        workflowStatus.classList.remove('neutral', 'valid', 'invalid');
        if (tone === 'valid') workflowStatus.classList.add('valid');
        else if (tone === 'invalid') workflowStatus.classList.add('invalid');
        else workflowStatus.classList.add('neutral');
        workflowStatus.textContent = message;
    };

    const updateWorkflowProgress = (current, total) => {
        if (!workflowProgressTrack || !workflowProgressBar) return;
        workflowProgressTrack.style.display = 'block';
        const boundedTotal = Math.max(total || 0, 1);
        const ratio = Math.min(Math.max(current, 0), boundedTotal) / boundedTotal;
        workflowProgressBar.style.width = `${Math.round(ratio * 100)}%`;

        if (!workflowRunState.running) return;

        const elapsed = Date.now() - workflowRunState.startedAt;
        const avgPerItem = elapsed / Math.max(current, 1);
        const remaining = Math.round(avgPerItem * (workflowRunState.total - current));
        updateWorkflowStatus(`Creating ${current} / ${workflowRunState.total}… · ETA ${formatEta(remaining)}`);
    };

    chrome.runtime.onMessage.addListener((message) => {
        if (!workflowRunState.running) return;
        if (message?.type === 'BL_WORKFLOW_PROGRESS') {
            updateWorkflowProgress(message.current, message.total);
        }
    });

    const runBulkWorkflowCreation = async () => {
        const names = parseWorkflowNames(workflowNamesInput?.value);
        if (!names.length) {
            updateWorkflowStatus('Paste at least one workflow group name first.', 'invalid');
            return;
        }

        if (names.length > 30) {
            const ok = window.confirm(`You are about to create ${names.length} workflow groups. Continue?`);
            if (!ok) return;
        }

        try {
            if (runWorkflowBulkBtn) {
                runWorkflowBulkBtn.disabled = true;
                runWorkflowBulkBtn.textContent = 'Running…';
            }
            workflowRunState = { running: true, startedAt: Date.now(), total: names.length };
            updateWorkflowStatus(`Starting… (0 / ${names.length})`);
            updateWorkflowProgress(0, names.length);

            chrome.storage.sync.set({
                workflowSkipDuplicates: workflowSkipDuplicates?.checked ?? true,
                workflowTitleCase: workflowTitleCase?.checked ?? false
            });

            const tab = await getBestBetterLetterTab();
            if (!tab?.id) {
                updateWorkflowStatus('Open a BetterLetter tab first.', 'invalid');
                return;
            }

            await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                files: ['bulk_workflow_groups.js']
            });

            const result = await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                func: (payload) => {
                    if (typeof window.__BL_BULK_WORKFLOW_RUN__ !== 'function') {
                        return { ok: false, error: 'Bulk workflow runner failed to load.' };
                    }
                    return window.__BL_BULK_WORKFLOW_RUN__(payload);
                },
                args: [{
                    names,
                    options: {
                        skipDuplicates: workflowSkipDuplicates?.checked ?? true,
                        titleCase: workflowTitleCase?.checked ?? false
                    }
                }]
            });

            const res = result?.[0]?.result;
            if (res?.ok) {
                updateWorkflowStatus(`Done ✅
Created: ${res.created}
Skipped: ${res.skipped}
Errors: ${res.errors.length}`, res.errors.length ? 'neutral' : 'valid');
                updateWorkflowProgress(names.length, names.length);
                if (res.errors.length) {
                    console.warn('[Workflow bulk] Errors:', res.errors);
                } else if (workflowNamesInput) {
                    workflowNamesInput.value = '';
                }
            } else {
                updateWorkflowStatus(`Failed ❌
${res?.error || 'Unknown error'}`, 'invalid');
            }
        } catch (error) {
            console.error('Bulk workflow creation failed:', error);
            updateWorkflowStatus(`Error ❌
${error?.message || String(error)}`, 'invalid');
        } finally {
            workflowRunState.running = false;
            if (runWorkflowBulkBtn) {
                runWorkflowBulkBtn.disabled = false;
                runWorkflowBulkBtn.textContent = 'Run Bulk Create';
            }
        }
    };

    const loadRecentIds = async () => {
        const { recentDocIds: d = [], recentJobIds: j = [] } = await chrome.storage.local.get(['recentDocIds', 'recentJobIds']);
        recentDocIds = Array.isArray(d) ? d.slice(0, 5) : [];
        recentJobIds = Array.isArray(j) ? j.slice(0, 5) : [];
        renderRecentIdChips();
    };

    chrome.storage.sync.get({ workflowSkipDuplicates: true, workflowTitleCase: false }, (saved) => {
        if (workflowSkipDuplicates) workflowSkipDuplicates.checked = Boolean(saved.workflowSkipDuplicates);
        if (workflowTitleCase) workflowTitleCase.checked = Boolean(saved.workflowTitleCase);
    });

    workflowNamesInput?.addEventListener('input', () => {
        const parsed = parseWorkflowNames(workflowNamesInput.value);
        updateWorkflowStatus(parsed.length ? `${parsed.length} workflow names parsed.` : 'Ready.');
    });

    testWorkflowParseBtn?.addEventListener('click', () => {
        const parsed = parseWorkflowNames(workflowNamesInput?.value);
        if (!parsed.length) {
            updateWorkflowStatus('No workflow names parsed.', 'invalid');
            return;
        }
        updateWorkflowStatus(`Parsed ${parsed.length} names\n- ${parsed.slice(0, 12).join('\n- ')}${parsed.length > 12 ? '\n...' : ''}`);
    });

    runWorkflowBulkBtn?.addEventListener('click', runBulkWorkflowCreation);

    manualDocIdInput?.addEventListener('input', updateDocValidation);
    jobStatusInput?.addEventListener('input', updateJobValidation);
    bulkIdsInput?.addEventListener('input', updateBulkValidation);

    btnJobs?.addEventListener('click', () => handleDocAction('jobs', btnJobs));
    btnOban?.addEventListener('click', () => handleDocAction('oban', btnOban));
    btnLog?.addEventListener('click', () => handleDocAction('log', btnLog));
    btnAdmin?.addEventListener('click', () => handleDocAction('admin', btnAdmin));

    copyJobsUrlBtn?.addEventListener('click', () => handleCopyDocAction('jobs'));
    copyObanUrlBtn?.addEventListener('click', () => handleCopyDocAction('oban'));
    copyLogUrlBtn?.addEventListener('click', () => handleCopyDocAction('log'));
    copyAdminUrlBtn?.addEventListener('click', () => handleCopyDocAction('admin'));

    openJobStatusBtn?.addEventListener('click', async () => {
        const jobId = updateJobValidation();
        if (!jobId) return showToast('No valid Job ID.');
        await pushRecentId('job', jobId);
        await openUrlsWithLoading([getJobStatusUrl(jobId)], [openJobStatusBtn]);
    });

    copyJobStatusUrlBtn?.addEventListener('click', () => {
        const jobId = updateJobValidation();
        if (!jobId) return showToast('No valid Job ID.');
        copyUrlsToClipboard([jobId], 'Job ID');
    });

    copyJobStatusLinkBtn?.addEventListener('click', () => {
        const jobId = updateJobValidation();
        if (!jobId) return showToast('No valid Job ID.');
        copyUrlsToClipboard([getJobStatusUrl(jobId)], 'Job URL');
    });

    clearJobStatusInputBtn?.addEventListener('click', () => {
        if (jobStatusInput) {
            jobStatusInput.value = '';
            jobStatusInput.focus();
        }
        updateJobValidation();
    });

    openBulkActionBtn?.addEventListener('click', async () => {
        const ids = updateBulkValidation();
        if (!ids.length) return showToast('No valid IDs found.');

        const action = bulkActionType?.value || 'jobs';
        const urls = ids.map(id => getDocumentActionUrl(action, id));
        await Promise.all(ids.map(id => pushRecentId('doc', id)));
        await openUrlsWithLoading(urls, [openBulkActionBtn]);
        showToast(`${ids.length} links opened.`);
    });

    copyBulkActionBtn?.addEventListener('click', () => {
        const ids = updateBulkValidation();
        if (!ids.length) return showToast('No valid IDs found.');

        const action = bulkActionType?.value || 'jobs';
        const urls = ids.map(id => getDocumentActionUrl(action, id));
        copyUrlsToClipboard(urls, 'URLs');
    });

    runUuidPickerToolBtn?.addEventListener('click', () => runBookmarkletTool('uuidPicker'));
    runListDocmanGroupsToolBtn?.addEventListener('click', () => runBookmarkletTool('listDocmanGroups'));

    updateDocValidation();
    updateJobValidation();
    updateBulkValidation();
    loadRecentIds();

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

    await tryAutoSelectPracticeFromActiveTab();

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
        await tryAutoSelectPracticeFromActiveTab();
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

const PANEL_WIDTH = 360;

function resizeToFitContent(extraHeight = 40) {
  const contentHeight = document.documentElement.scrollHeight;
  const targetHeight = Math.max(750, contentHeight + extraHeight);
  window.resizeTo(PANEL_WIDTH, targetHeight);
}

window.addEventListener('DOMContentLoaded', () => {
  resizeToFitContent(40, 750); // You can tweak the 700px value
});
