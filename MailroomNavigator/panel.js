// Main panel controller for all three views (Navigator, Job Panel, Others).
// This file wires DOM events to feature modules and background actions.
import { state, setCachedPractices } from './state.js';
import { showToast, showStatus, openTabWithTimeout } from './utils.js';
import * as Navigator from './navigator.js';
import * as Jobs from './jobs.js';
import * as Email from './email.js';

let practiceCacheLoadPromise = null;
let isCdbHydrationTriggered = false;

async function syncPracticeCache({ forceRefresh = false, allowScrape = true } = {}) {
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
                if (!forceRefresh || !allowScrape) return response.practiceCache;
            }

            if (!allowScrape) return state.cachedPractices;

            // Refresh path: explicit refresh or empty cache fallback
            await chrome.runtime.sendMessage({ action: 'requestActiveScrape' });
            response = await chrome.runtime.sendMessage({ action: 'getPracticeCache' });
            if (response && response.practiceCache && Object.keys(response.practiceCache).length > 0) {
                setCachedPractices(response.practiceCache);
                Navigator.buildCdbIndex();
                return response.practiceCache;
            }
            return state.cachedPractices;
        } catch (e) {
            return state.cachedPractices;
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
        await chrome.runtime.sendMessage({ action: 'hydratePracticeCdb', limit: 200 });
        await syncPracticeCache({ forceRefresh: true, allowScrape: false });
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

function extractJobId(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';

    const urlMatch = raw.match(/\/admin_panel\/bots\/jobs\/([^/?#\s]+)/i);
    if (urlMatch?.[1]) {
        try {
            return decodeURIComponent(urlMatch[1]).trim();
        } catch (e) {
            return urlMatch[1].trim();
        }
    }

    const uuidMatch = raw.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i);
    if (uuidMatch) return uuidMatch[0];

    const numericMatch = raw.match(/\b\d+\b/);
    if (numericMatch) return numericMatch[0];

    // Allow direct opaque IDs (for non-numeric/non-UUID job keys) when pasted as a single token.
    if (/^[A-Za-z0-9_-]{8,}$/.test(raw)) return raw;
    return '';
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
    const normalized = String(jobId || '').trim();
    return normalized ? `https://app.betterletter.ai/admin_panel/bots/jobs/${encodeURIComponent(normalized)}` : '';
}

function getProblemReviewUrl(jobId) {
    const normalized = String(jobId || '').trim();
    return normalized
        ? `https://app.betterletter.ai/admin_panel/error_fixer/problem_linked_to_problem_review/${encodeURIComponent(normalized)}`
        : '';
}

function getTabUrl(tab) {
    if (typeof tab?.url === 'string') return tab.url;
    if (typeof tab?.pendingUrl === 'string') return tab.pendingUrl;
    return '';
}

function isBotsDashboardUrl(url) {
    const normalized = String(url || '');
    return normalized.startsWith('https://app.betterletter.ai/admin_panel/bots/dashboard');
}

function collapseText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function truncateText(value, max = 90) {
    const clean = collapseText(value);
    if (clean.length <= max) return clean;
    return `${clean.slice(0, Math.max(0, max - 1))}…`;
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
    } catch (error) {
        const message = String(error?.message || error || '').toLowerCase();
        if (message.includes('extension context invalidated')) {
            showToast('Extension reloaded. Refresh this page and reopen the panel.');
            return;
        }
        showToast('Failed to open one or more pages.');
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
        const ids = [
            'suggestions',
            'cdbSuggestions',
            'autocompleteResults',
            'practiceAutocompleteResultsContainer',
            'docIdAutocompleteResultsContainer',
            'jobIdAutocompleteResultsContainer'
        ];
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
    let practiceFocusFromDirectInputPointer = false;
    let isPracticeWarmupRunning = false;
    const warmPracticeCache = (showOnEmptyAfterLoad = false) => {
        if (isPracticeWarmupRunning) return;
        if (Object.keys(state.cachedPractices || {}).length > 0) return;
        isPracticeWarmupRunning = true;
        syncPracticeCache()
            .then(() => {
                Navigator.handleNavigatorInput({ showOnEmpty: showOnEmptyAfterLoad });
            })
            .catch(() => undefined)
            .finally(() => { isPracticeWarmupRunning = false; });
    };

    const refreshPracticeSuggestions = () => {
        Navigator.handleNavigatorInput();
        warmPracticeCache();
    };

    if (pInput) {
        pInput.addEventListener('mousedown', () => {
            // Distinguish direct input clicks from label-driven focus.
            practiceFocusFromDirectInputPointer = true;
        });
        pInput.addEventListener('input', refreshPracticeSuggestions);
        pInput.addEventListener('focus', () => {
            const hasTypedQuery = Boolean(pInput.value && pInput.value.trim());
            const showOnEmpty = practiceFocusFromDirectInputPointer || hasTypedQuery;

            if (showOnEmpty) {
                Navigator.handleNavigatorInput({ showOnEmpty: true });
            } else {
                Navigator.hidePracticeSuggestions();
            }

            warmPracticeCache(showOnEmpty);
            practiceFocusFromDirectInputPointer = false;
        });
        pInput.addEventListener('blur', () => {
            practiceFocusFromDirectInputPointer = false;
        });
    }

    const cdbInput = document.getElementById('cdbSearchInput');
    const refreshCdbSuggestions = () => {
        Navigator.handleCdbInput();
        syncPracticeCache()
            .then(async () => {
                await triggerCdbHydration();
                Navigator.handleCdbInput();
            })
            .catch(() => undefined);
    };

    if (cdbInput) {
        cdbInput.addEventListener('input', refreshCdbSuggestions);
        cdbInput.addEventListener('focus', refreshCdbSuggestions);
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
    const resetSettingsBtn = document.getElementById('resetSettingsBtn');
    resetSettingsBtn?.addEventListener('mousedown', (e) => {
        // Keep input focus stable when clicking the reset icon button.
        e.preventDefault();
    });
    resetSettingsBtn?.addEventListener('click', () => {
        if (pInput) {
            pInput.value = '';
            pInput.focus();
        }
        Navigator.clearSelectedPractice();
        showStatus('Settings reset.', 'success');
    });
    
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

    // Job Dashboard Filters (checkbox multi-select)
    const docmanJobChecklistNav = document.getElementById('docmanJobChecklistNav');
    const emisJobChecklistNav = document.getElementById('emisJobChecklistNav');
    const openDocmanJobsNavBtn = document.getElementById('openDocmanJobsNavBtn');
    const openEmisJobsNavBtn = document.getElementById('openEmisJobsNavBtn');

    const getSelectedJobTypes = (checklistEl) => {
        if (!checklistEl) return [];
        return Array.from(checklistEl.querySelectorAll('input[type="checkbox"]:checked'))
            .map(input => String(input?.value || '').trim())
            .filter(Boolean);
    };

    const buildJobsDashboardUrl = (jobTypes, odsCode = '') => {
        const encodedTypes = jobTypes.map(jobType => encodeURIComponent(jobType)).join('+');
        const encodedOds = odsCode ? `&practice_ids=${encodeURIComponent(odsCode)}` : '';
        return `https://app.betterletter.ai/admin_panel/bots/dashboard?job_types=${encodedTypes}${encodedOds}&status=paused`;
    };

    const openMultiJobDashboard = (checklistEl, groupLabel) => {
        const selectedJobTypes = getSelectedJobTypes(checklistEl);
        if (selectedJobTypes.length === 0) {
            showToast(`Select at least one ${groupLabel} job.`);
            return;
        }

        const selectedPracticeCode = String(state.currentSelectedOdsCode || '').trim().toUpperCase();
        const hasPracticeFilter = /^[A-Z]\d{5}$/.test(selectedPracticeCode);
        const isAllPractices = selectedPracticeCode === 'ALL';

        if (!hasPracticeFilter && !isAllPractices) {
            showToast('Select a practice or choose All practices from Practice input.');
            return;
        }

        const url = buildJobsDashboardUrl(selectedJobTypes, hasPracticeFilter ? selectedPracticeCode : '');
        openTabWithTimeout(url);
    };

    openDocmanJobsNavBtn?.addEventListener('click', () => openMultiJobDashboard(docmanJobChecklistNav, 'Docman'));
    openEmisJobsNavBtn?.addEventListener('click', () => openMultiJobDashboard(emisJobChecklistNav, 'EMIS'));

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

    const docIdAutocompleteResultsContainer = document.getElementById('docIdAutocompleteResultsContainer');
    const jobIdAutocompleteResultsContainer = document.getElementById('jobIdAutocompleteResultsContainer');

    const recentDocIdsChips = document.getElementById('recentDocIdsChips');
    const recentJobIdsChips = document.getElementById('recentJobIdsChips');
    const recentDocMetaList = document.getElementById('recentDocMetaList');
    const recentJobMetaList = document.getElementById('recentJobMetaList');

    const btnJobs = document.getElementById('btnJobs');
    const btnOban = document.getElementById('btnOban');
    const btnLog = document.getElementById('btnLog');
    const btnAdmin = document.getElementById('btnAdmin');
    const openJobStatusBtn = document.getElementById('openJobStatusBtn');
    const openProblemReviewBtn = document.getElementById('openProblemReviewBtn');
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
    const bookmarkletToolModal = document.getElementById('bookmarkletToolModal');
    const bookmarkletToolModalTitle = document.getElementById('bookmarkletToolModalTitle');
    const bookmarkletToolModalActions = document.getElementById('bookmarkletToolModalActions');
    const bookmarkletToolModalBody = document.getElementById('bookmarkletToolModalBody');
    const bookmarkletToolModalCloseBtn = document.getElementById('bookmarkletToolModalCloseBtn');

    const workflowNamesInput = document.getElementById('workflowNamesInput');
    const workflowSkipDuplicates = document.getElementById('workflowSkipDuplicates');
    const workflowTitleCase = document.getElementById('workflowTitleCase');
    const workflowStatus = document.getElementById('workflowStatus');
    const workflowProgressTrack = document.getElementById('workflowProgressTrack');
    const workflowProgressBar = document.getElementById('workflowProgressBar');
    const runWorkflowBulkBtn = document.getElementById('runWorkflowBulkBtn');
    const testWorkflowParseBtn = document.getElementById('testWorkflowParseBtn');

    const linearIssueSourceInput = document.getElementById('linearIssueSourceInput');
    const generateLinearIssueDraftBtn = document.getElementById('generateLinearIssueDraftBtn');
    const linearIssueTitleInput = document.getElementById('linearIssueTitleInput');
    const linearIssueDescriptionInput = document.getElementById('linearIssueDescriptionInput');
    const linearIssuePriorityInput = document.getElementById('linearIssuePriorityInput');
    const linearSlackNotifyEnabledInput = document.getElementById('linearSlackNotifyEnabledInput');
    const syncLinearSlackWorkspaceBtn = document.getElementById('syncLinearSlackWorkspaceBtn');
    const linearSlackTargetTypeInput = document.getElementById('linearSlackTargetTypeInput');
    const linearSlackTargetInput = document.getElementById('linearSlackTargetInput');
    const linearSlackTargetSuggestions = document.getElementById('linearSlackTargetSuggestions');
    const linearSlackTargetHint = document.getElementById('linearSlackTargetHint');
    const linearSlackStatus = document.getElementById('linearSlackStatus');
    const createLinearSlackIssueBtn = document.getElementById('createLinearSlackIssueBtn');
    const triggerLinearBotJobsBtn = document.getElementById('triggerLinearBotJobsBtn');
    const reconcileLinearBotIssuesBtn = document.getElementById('reconcileLinearBotIssuesBtn');
    const triggerLinearDryRunInput = document.getElementById('triggerLinearDryRunInput');
    const reconcileLinearDryRunInput = document.getElementById('reconcileLinearDryRunInput');
    const linearTriggerStatus = document.getElementById('linearTriggerStatus');

    let recentDocIds = [];
    let recentJobIds = [];
    let recentDocSuggestionMeta = {};
    let recentJobSuggestionMeta = {};
    let dashboardRows = [];
    let dashboardRowsByDocId = new Map();
    let dashboardRowsByJobId = new Map();
    let dashboardRowsLoadPromise = null;
    let dashboardRowsLoadedAt = 0;
    let dashboardRowsSourceTabId = null;
    const DASHBOARD_SUGGESTION_STALE_MS = 45000;
    const LINEAR_SLACK_PREFS_STORAGE_KEY = 'linearSlackPrefsV1';
    const LINEAR_SLACK_TARGET_CACHE_STORAGE_KEY = 'linearSlackTargetsCacheV1';
    const LINEAR_TRIGGER_STATUS_POLL_INTERVAL_MS = 3500;
    const LINEAR_TRIGGER_STATUS_POLL_WINDOW_MS = 4 * 60 * 1000;
    let linearTriggerStatusPollTimer = null;
    let linearTriggerStatusPollDeadlineMs = 0;
    let linearIssueContext = null;
    let linearSlackTargetsCache = { channels: [], users: [], syncedAt: '' };

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

    const closeBookmarkletToolModal = () => {
        if (!bookmarkletToolModal) return;
        bookmarkletToolModal.classList.remove('is-open');
        bookmarkletToolModal.setAttribute('aria-hidden', 'true');
        if (bookmarkletToolModalActions) bookmarkletToolModalActions.innerHTML = '';
        if (bookmarkletToolModalBody) bookmarkletToolModalBody.innerHTML = '';
    };

    const openBookmarkletToolModal = (title) => {
        if (!bookmarkletToolModal) return false;
        if (bookmarkletToolModalTitle) bookmarkletToolModalTitle.textContent = title || 'Tool';
        if (bookmarkletToolModalActions) bookmarkletToolModalActions.innerHTML = '';
        if (bookmarkletToolModalBody) bookmarkletToolModalBody.innerHTML = '';
        bookmarkletToolModal.classList.add('is-open');
        bookmarkletToolModal.setAttribute('aria-hidden', 'false');
        return true;
    };

    bookmarkletToolModalCloseBtn?.addEventListener('click', closeBookmarkletToolModal);
    bookmarkletToolModal?.addEventListener('mousedown', (event) => {
        if (event.target === bookmarkletToolModal) closeBookmarkletToolModal();
    });
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && bookmarkletToolModal?.classList.contains('is-open')) {
            closeBookmarkletToolModal();
        }
    });

    const normalizeSuggestionMetaMap = (rawMap = {}) => {
        if (!rawMap || typeof rawMap !== 'object') return {};
        const normalized = {};
        Object.entries(rawMap).forEach(([id, meta]) => {
            if (!id || !meta || typeof meta !== 'object') return;
            normalized[String(id).trim()] = {
                documentId: String(meta.documentId || '').trim(),
                jobType: String(meta.jobType || '').trim(),
                practiceName: String(meta.practiceName || '').trim(),
                jobId: String(meta.jobId || '').trim(),
                latestError: String(meta.latestError || '').trim(),
                attemptCount: Number.isFinite(Number(meta.attemptCount)) ? Number(meta.attemptCount) : null
            };
        });
        return normalized;
    };

    const saveRecentIds = async () => {
        await chrome.storage.local.set({
            recentDocIds,
            recentJobIds,
            recentDocSuggestionMeta,
            recentJobSuggestionMeta
        });
    };

    const pushRecentId = async (type, id) => {
        const normalized = String(id || '').trim();
        if (!normalized) return;
        if (type === 'doc') {
            recentDocIds = [normalized, ...recentDocIds.filter(x => x !== normalized)].slice(0, 5);
        } else {
            recentJobIds = [normalized, ...recentJobIds.filter(x => x !== normalized)].slice(0, 5);
        }
        await saveRecentIds();
        renderRecentIdChips();
    };

    const recordSuggestionSelection = async (type, row) => {
        if (!row) return;
        const id = type === 'doc' ? String(row.documentId || '').trim() : String(row.jobId || '').trim();
        if (!id) return;

        const metaEntry = {
            documentId: String(row.documentId || '').trim(),
            jobType: String(row.jobType || '').trim(),
            practiceName: String(row.practiceName || row.practice || '').trim(),
            jobId: String(row.jobId || '').trim(),
            latestError: String(row.latestError || row.status || '').trim(),
            attemptCount: Number.isFinite(Number(row.attemptCount)) ? Number(row.attemptCount) : null
        };

        if (type === 'doc') {
            recentDocSuggestionMeta = { ...recentDocSuggestionMeta, [id]: metaEntry };
        } else {
            recentJobSuggestionMeta = { ...recentJobSuggestionMeta, [id]: metaEntry };
        }

        await saveRecentIds();
        renderRecentIdChips();
    };

    const normalizeDashboardRow = (row) => {
        const documentId = extractNumericId(row?.documentId || row?.document || '');
        const jobId = extractJobId(row?.jobId || '');
        const parsedAttemptCount = Number.parseInt(row?.attemptCount, 10);
        const statusText = collapseText(row?.status || '');
        const latestError = collapseText(row?.latestError || '') || statusText;
        return {
            documentId,
            jobType: collapseText(row?.jobType || ''),
            practiceName: collapseText(row?.practiceName || row?.practice || ''),
            practice: collapseText(row?.practice || ''),
            odsCode: collapseText(row?.odsCode || ''),
            jobId,
            status: statusText,
            latestError,
            attemptCount: Number.isFinite(parsedAttemptCount) ? parsedAttemptCount : null,
            added: collapseText(row?.added || '')
        };
    };

    const indexDashboardRows = (rows) => {
        dashboardRows = Array.isArray(rows)
            ? rows.map(normalizeDashboardRow).filter((row) => row.documentId || row.jobId)
            : [];

        dashboardRowsByDocId = new Map();
        dashboardRowsByJobId = new Map();

        dashboardRows.forEach((row) => {
            if (row.documentId && !dashboardRowsByDocId.has(row.documentId)) {
                dashboardRowsByDocId.set(row.documentId, row);
            }
            if (row.jobId && !dashboardRowsByJobId.has(row.jobId)) {
                dashboardRowsByJobId.set(row.jobId, row);
            }
        });
    };

    const getRowForDocId = (id) => dashboardRowsByDocId.get(String(id || '').trim()) || null;
    const getRowForJobId = (id) => dashboardRowsByJobId.get(String(id || '').trim()) || null;

    const createChip = (id, type) => {
        const chip = document.createElement('button');
        chip.className = 'id-chip';
        chip.textContent = id;
        chip.title = type === 'doc' ? 'Open Jobs dashboard for this ID' : 'Open Job status for this ID';
        chip.addEventListener('click', async () => {
            if (type === 'doc') {
                if (manualDocIdInput) manualDocIdInput.value = id;
                updateDocValidation();
                syncJobStatusFromManualDocId();
                hideDashboardAutocomplete(docIdAutocompleteResultsContainer);
                await openUrlsWithLoading([getDocumentActionUrl('jobs', id)], [btnJobs]);
            } else {
                if (jobStatusInput) jobStatusInput.value = id;
                updateJobValidation();
                hideDashboardAutocomplete(jobIdAutocompleteResultsContainer);
                await openUrlsWithLoading([getJobStatusUrl(id)], [openJobStatusBtn]);
            }
        });
        return chip;
    };

    const renderRecentMetaList = (container, ids, type) => {
        if (!container) return;
        container.innerHTML = '';
        container.style.display = 'none';
        const metaMap = type === 'doc' ? recentDocSuggestionMeta : recentJobSuggestionMeta;

        const createLine = (label, value) => {
            const line = document.createElement('div');
            line.textContent = `${label}: ${value || '—'}`;
            return line;
        };

        ids.forEach((id) => {
            const row = metaMap[String(id || '').trim()];
            if (!row || typeof row !== 'object') return;

            const card = document.createElement('div');
            card.className = 'recent-id-meta-card';

            const title = document.createElement('div');
            title.className = 'recent-id-meta-title';
            title.textContent = type === 'doc'
                ? `Document ${row.documentId || id}`
                : `Job ${row.jobId || row.documentId || id}`;

            card.appendChild(title);
            card.appendChild(createLine('Job type', row.jobType || 'N/A'));
            card.appendChild(createLine('Practice', row.practiceName || 'N/A'));
            card.appendChild(createLine('Job ID', row.jobId || 'N/A'));
            card.appendChild(createLine('Latest error', truncateText(row.latestError || row.status || 'N/A', 140)));
            card.appendChild(createLine('Attempts', row.attemptCount ?? 'N/A'));
            container.appendChild(card);
        });

        if (container.children.length > 0) {
            container.style.display = 'flex';
        }
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
        renderRecentMetaList(recentDocMetaList, recentDocIds, 'doc');
        renderRecentMetaList(recentJobMetaList, recentJobIds, 'job');
    };

    const updateDocValidation = () => {
        const id = extractNumericId(manualDocIdInput?.value);
        const row = id ? getRowForDocId(id) : null;
        const metaText = row
            ? ` · ${row.jobType || 'job'} · ${truncateText(row.practiceName || row.practice, 40)}`
            : '';

        setValidationBadge(
            manualDocValidation,
            manualDocIdInput?.value ? Boolean(id) : null,
            'Enter a numeric Document ID.',
            `✓ Valid Document ID: ${id}${metaText}`,
            '✕ Invalid Document ID.'
        );
        return id;
    };

    const syncJobStatusFromManualDocId = ({ clearWhenNoMatch = false } = {}) => {
        if (!jobStatusInput) return null;
        const documentId = extractNumericId(manualDocIdInput?.value);
        const row = documentId ? getRowForDocId(documentId) : null;
        const nextJobId = row?.jobId || '';

        if (nextJobId) {
            if (jobStatusInput.value !== nextJobId) {
                jobStatusInput.value = nextJobId;
            }
            updateJobValidation();
            return nextJobId;
        }

        if (clearWhenNoMatch && jobStatusInput.value) {
            jobStatusInput.value = '';
            updateJobValidation();
        }

        return null;
    };

    const updateJobValidation = () => {
        const id = extractJobId(jobStatusInput?.value);
        const row = id ? getRowForJobId(id) : null;
        const statusText = row ? truncateText(row.latestError || row.status || 'Status available', 70) : '';
        const attemptsText = Number.isFinite(row?.attemptCount) ? ` · ${row.attemptCount} attempts` : '';

        setValidationBadge(
            jobStatusValidation,
            jobStatusInput?.value ? Boolean(id) : null,
            'Enter a Job ID (UUID or numeric).',
            `✓ Valid Job ID: ${id}${statusText ? ` · ${statusText}` : ''}${attemptsText}`,
            '✕ Invalid Job ID (UUID or numeric).'
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

    const hideDashboardAutocomplete = (container) => {
        if (!container) return;
        container.style.display = 'none';
        container.innerHTML = '';
    };

    const renderDashboardAutocomplete = ({ container, rows, mode, onSelect }) => {
        if (!container) return;
        container.innerHTML = '';
        if (!rows.length) {
            container.style.display = 'none';
            return;
        }

        const countHeader = document.createElement('div');
        countHeader.className = 'suggestion-count';
        countHeader.textContent = `${rows.length} dashboard suggestion${rows.length === 1 ? '' : 's'}`;
        container.appendChild(countHeader);

        rows.forEach((row) => {
            const item = document.createElement('div');
            item.className = 'autocomplete-item dashboard-autocomplete-item';

            const main = document.createElement('div');
            main.className = 'suggestion-main';
            main.textContent = mode === 'doc'
                ? `Doc ${row.documentId || '—'} · ${row.jobType || 'Unknown job type'}`
                : `Job ${row.jobId || '—'} · Doc ${row.documentId || '—'}`;

            const meta = document.createElement('div');
            meta.className = 'suggestion-meta';
            meta.textContent = `${row.practiceName || row.practice || 'Unknown practice'}${row.odsCode ? ` (${row.odsCode})` : ''}${Number.isFinite(row.attemptCount) ? ` · ${row.attemptCount} attempts` : ''}`;

            const status = document.createElement('div');
            status.className = 'suggestion-status';
            status.textContent = truncateText(row.latestError || row.status || 'No status message found.', 130);

            item.append(main, meta, status);
            item.addEventListener('mousedown', (event) => {
                event.preventDefault();
                event.stopPropagation();
                onSelect(row);
            });

            container.appendChild(item);
        });

        container.style.display = 'block';
    };

    const getDashboardMatches = (query, mode) => {
        const normalizedQuery = collapseText(query).toLowerCase();
        const source = dashboardRows.filter((row) => mode === 'doc' ? Boolean(row.documentId) : Boolean(row.jobId));

        const filtered = normalizedQuery
            ? source.filter((row) => {
                const haystack = [
                    row.documentId,
                    row.jobId,
                    row.jobType,
                    row.practiceName,
                    row.practice,
                    row.latestError,
                    row.status
                ].map(value => String(value || '').toLowerCase());
                return haystack.some(value => value.includes(normalizedQuery));
            })
            : source;

        const keyFor = (row) => mode === 'doc' ? row.documentId : row.jobId;
        const seen = new Set();
        const uniqueRows = [];
        for (const row of filtered) {
            const key = keyFor(row);
            if (!key || seen.has(key)) continue;
            seen.add(key);
            uniqueRows.push(row);
            if (uniqueRows.length >= 50) break;
        }
        return uniqueRows;
    };

    const showDocIdSuggestions = () => {
        const matches = getDashboardMatches(manualDocIdInput?.value, 'doc');
        renderDashboardAutocomplete({
            container: docIdAutocompleteResultsContainer,
            rows: matches,
            mode: 'doc',
            onSelect: (row) => {
                if (!manualDocIdInput) return;
                manualDocIdInput.value = row.documentId || '';
                recordSuggestionSelection('doc', row).catch(() => undefined);
                updateDocValidation();
                syncJobStatusFromManualDocId();
                hideDashboardAutocomplete(docIdAutocompleteResultsContainer);
            }
        });
    };

    const showJobIdSuggestions = () => {
        const matches = getDashboardMatches(jobStatusInput?.value, 'job');
        renderDashboardAutocomplete({
            container: jobIdAutocompleteResultsContainer,
            rows: matches,
            mode: 'job',
            onSelect: (row) => {
                if (!jobStatusInput) return;
                jobStatusInput.value = row.jobId || '';
                recordSuggestionSelection('job', row).catch(() => undefined);
                updateJobValidation();
                hideDashboardAutocomplete(jobIdAutocompleteResultsContainer);
            }
        });
    };

    const handleDocAction = async (action, actionButton) => {
        const id = updateDocValidation();
        if (!id) return showToast('No valid Document ID.');
        hideDashboardAutocomplete(docIdAutocompleteResultsContainer);
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
        if (getTabUrl(activeTab).startsWith('https://app.betterletter.ai/')) {
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

    const getBestDashboardTab = async () => {
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (isBotsDashboardUrl(getTabUrl(activeTab))) return activeTab;

        const { targetTabId } = await chrome.storage.local.get(['targetTabId']);
        if (typeof targetTabId === 'number') {
            try {
                const targetTab = await chrome.tabs.get(targetTabId);
                if (isBotsDashboardUrl(getTabUrl(targetTab))) return targetTab;
            } catch (e) {
                // Ignore closed/missing target tabs.
            }
        }

        const dashboardTabs = await chrome.tabs.query({ url: 'https://app.betterletter.ai/admin_panel/bots/dashboard*' });
        if (!dashboardTabs.length) return null;

        return dashboardTabs
            .slice()
            .sort((a, b) => {
                const activeDiff = Number(Boolean(b.active)) - Number(Boolean(a.active));
                if (activeDiff !== 0) return activeDiff;
                const lastAccessedDiff = Number(b.lastAccessed || 0) - Number(a.lastAccessed || 0);
                if (lastAccessedDiff !== 0) return lastAccessedDiff;
                return Number(b.id || 0) - Number(a.id || 0);
            })[0] || null;
    };

    const scrapeDashboardRowsFromTab = async (tabId) => {
        const [{ result }] = await chrome.scripting.executeScript({
            target: { tabId },
            func: () => {
                const collapse = (value) => String(value || '').replace(/\s+/g, ' ').trim();
                const normalizeHeader = (value) => collapse(value).toLowerCase().replace(/[^a-z0-9]/g, '');

                const parseDocumentId = (value) => {
                    const match = collapse(value).match(/\d+/);
                    return match ? match[0] : '';
                };

                const parseJobId = (value) => {
                    const raw = collapse(value);
                    if (!raw) return '';
                    const urlMatch = raw.match(/\/admin_panel\/bots\/jobs\/([^/?#\s]+)/i);
                    if (urlMatch?.[1]) return urlMatch[1];

                    const uuidMatch = raw.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i);
                    if (uuidMatch) return uuidMatch[0];

                    const numericMatch = raw.match(/\b\d+\b/);
                    if (numericMatch) return numericMatch[0];

                    if (/^[A-Za-z0-9_-]{8,}$/.test(raw)) return raw;
                    return '';
                };

                const parseAttemptCount = (value) => {
                    const matches = [...collapse(value).matchAll(/(\d+)\s*attempts?/gi)]
                        .map(match => Number.parseInt(match[1], 10))
                        .filter(Number.isFinite);
                    if (!matches.length) return null;
                    return Math.max(...matches);
                };

                const parseLatestError = (value) => {
                    const statusText = collapse(value).replace(/copy status/ig, '').trim();
                    if (!statusText) return '';
                    const withoutTrailingAttempt = statusText.replace(/\b\d+\s*attempts?\b\s*$/i, '').trim();
                    return withoutTrailingAttempt || statusText;
                };

                const resolveHeaderMap = (table) => {
                    if (!table) return null;
                    const headerCells = Array.from(table.querySelectorAll('thead th'));
                    if (!headerCells.length) return null;

                    const map = {};
                    headerCells.forEach((th, index) => {
                        const normalized = normalizeHeader(th.textContent);
                        if (!normalized) return;
                        if (normalized.includes('document') && normalized.includes('id')) {
                            map.document = index;
                            return;
                        }
                        if (normalized.includes('jobtype')) {
                            map.jobType = index;
                            return;
                        }
                        if (normalized === 'jobid' || (normalized.includes('job') && normalized.includes('id'))) {
                            if (typeof map.jobId !== 'number') map.jobId = index;
                            return;
                        }
                        if (normalized.includes('practice')) {
                            map.practice = index;
                            return;
                        }
                        if (normalized.includes('added')) {
                            map.added = index;
                            return;
                        }
                        if (normalized.includes('status')) {
                            map.status = index;
                        }
                    });

                    if (typeof map.document !== 'number' || typeof map.jobId !== 'number') return null;
                    return map;
                };

                const tables = Array.from(document.querySelectorAll('table'));
                let targetTable = null;
                let headerMap = null;
                for (const table of tables) {
                    const map = resolveHeaderMap(table);
                    if (map) {
                        targetTable = table;
                        headerMap = map;
                        break;
                    }
                }

                if (!targetTable || !headerMap) {
                    return { rows: [], sourceUrl: window.location.href };
                }

                const rows = [];
                const bodyRows = Array.from(targetTable.querySelectorAll('tbody tr'));
                bodyRows.forEach((rowEl) => {
                    const cells = Array.from(rowEl.querySelectorAll('td'));
                    if (!cells.length) return;

                    const getCell = (key) => {
                        const idx = headerMap[key];
                        return typeof idx === 'number' ? cells[idx] : null;
                    };
                    const getText = (key) => collapse(getCell(key)?.innerText || getCell(key)?.textContent || '');

                    const documentCell = getCell('document');
                    const documentLink = documentCell?.querySelector('a');
                    const documentId = parseDocumentId(documentLink?.textContent || getText('document'));
                    if (!documentId) return;

                    const jobCell = getCell('jobId');
                    const jobLink = jobCell?.querySelector('a[href*="/admin_panel/bots/jobs/"]');
                    let jobId = '';
                    const href = jobLink?.getAttribute('href') || '';
                    const hrefMatch = href.match(/\/admin_panel\/bots\/jobs\/([^/?#]+)/i);
                    if (hrefMatch?.[1]) {
                        try {
                            jobId = decodeURIComponent(hrefMatch[1]);
                        } catch (e) {
                            jobId = hrefMatch[1];
                        }
                    }
                    if (!jobId) {
                        jobId = parseJobId(jobLink?.textContent || getText('jobId'));
                    }

                    const practiceText = getText('practice');
                    const odsCode = practiceText.match(/\b[A-Z]\d{5}\b/)?.[0] || '';
                    const practiceName = collapse(practiceText.replace(odsCode, '')) || practiceText;
                    const statusText = getText('status');

                    rows.push({
                        documentId,
                        jobType: getText('jobType'),
                        practice: practiceText,
                        practiceName,
                        odsCode,
                        jobId,
                        added: getText('added'),
                        status: statusText,
                        latestError: parseLatestError(statusText),
                        attemptCount: parseAttemptCount(statusText)
                    });
                });

                return { rows, sourceUrl: window.location.href };
            }
        });

        return Array.isArray(result?.rows) ? result.rows : [];
    };

    const syncDashboardSuggestionRows = async ({ force = false, silent = true } = {}) => {
        if (dashboardRowsLoadPromise) return dashboardRowsLoadPromise;

        dashboardRowsLoadPromise = (async () => {
            const dashboardTab = await getBestDashboardTab();
            if (!dashboardTab?.id) {
                if (!silent && dashboardRows.length === 0) {
                    showToast('Open a Bots Dashboard tab to load ID suggestions.');
                }
                return dashboardRows;
            }

            const isFreshForSameTab = (
                !force &&
                dashboardRows.length > 0 &&
                dashboardRowsSourceTabId === dashboardTab.id &&
                (Date.now() - dashboardRowsLoadedAt < DASHBOARD_SUGGESTION_STALE_MS)
            );
            if (isFreshForSameTab) {
                return dashboardRows;
            }

            try {
                const rows = await scrapeDashboardRowsFromTab(dashboardTab.id);
                indexDashboardRows(rows);
                dashboardRowsLoadedAt = Date.now();
                dashboardRowsSourceTabId = dashboardTab.id;
                renderRecentIdChips();
                updateDocValidation();
                syncJobStatusFromManualDocId();
                updateJobValidation();
                return dashboardRows;
            } catch (error) {
                if (!silent && dashboardRows.length === 0) {
                    showToast('Could not read dashboard rows.');
                }
                return dashboardRows;
            }
        })();

        try {
            return await dashboardRowsLoadPromise;
        } finally {
            dashboardRowsLoadPromise = null;
        }
    };

    document.getElementById('jobManagerGlobalToggleBtn')?.addEventListener('click', () => {
        syncDashboardSuggestionRows({ silent: true })
            .then(() => {
                if (document.activeElement === manualDocIdInput) showDocIdSuggestions();
                if (document.activeElement === jobStatusInput) showJobIdSuggestions();
            })
            .catch(() => undefined);
    });

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

    const getActiveBetterLetterTabForTool = async () => {
        const tab = await getBestBetterLetterTab();
        if (!tab?.id) {
            showToast('Open a BetterLetter tab first.');
            return null;
        }
        return tab;
    };

    const fetchUuidPickerRows = async (tabId) => {
        const [{ result }] = await chrome.scripting.executeScript({
            target: { tabId },
            func: () => {
                const normalize = (value) => String(value || '').trim();
                const regex = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
                const allHtml = document.body?.innerHTML || '';
                const uniqueUuids = [...new Set((allHtml.match(regex) || []).map(item => item.toLowerCase()))];

                const getRowData = (uuid) => {
                    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
                    const normalizedUuid = String(uuid || '').toLowerCase();
                    let node;
                    while ((node = walker.nextNode())) {
                        const textContent = String(node.textContent || '');
                        if (!textContent.toLowerCase().includes(normalizedUuid)) continue;

                        const parentRow = node.parentElement?.closest('tr');
                        let dateStr = 'N/A';
                        if (parentRow) {
                            const cells = parentRow.querySelectorAll('td');
                            if (cells.length >= 8) dateStr = normalize(cells[7]?.textContent);
                        }
                        return { raw: normalize(textContent), date: dateStr || 'N/A' };
                    }
                    return { raw: uuid, date: 'N/A' };
                };

                return uniqueUuids.map((id) => {
                    const row = getRowData(id);
                    return {
                        id,
                        raw: row.raw || id,
                        date: row.date || 'N/A'
                    };
                });
            }
        });
        return Array.isArray(result) ? result : [];
    };

    const openUuidPickerModal = async () => {
        try {
            const tab = await getActiveBetterLetterTabForTool();
            if (!tab) return;

            const rows = await fetchUuidPickerRows(tab.id);
            if (!rows.length) {
                showToast('No UUIDs found on the active page.');
                return;
            }

            if (!openBookmarkletToolModal('UUID Picker')) return;

            let mode = 'SQL';
            const getDisplayValue = (item) => {
                if (mode === 'RAW') return item.raw || item.id;
                if (mode === 'UUID') return item.id;
                return `'${item.id}'`;
            };

            const searchInput = document.createElement('input');
            searchInput.className = 'bookmarklet-tool-input';
            searchInput.placeholder = 'Search UUID or row text...';

            const dateInput = document.createElement('input');
            dateInput.className = 'bookmarklet-tool-input';
            dateInput.placeholder = 'Filter date...';

            const sqlBtn = document.createElement('button');
            sqlBtn.type = 'button';
            sqlBtn.className = 'bookmarklet-tool-btn active';
            sqlBtn.textContent = 'SQL';

            const rawBtn = document.createElement('button');
            rawBtn.type = 'button';
            rawBtn.className = 'bookmarklet-tool-btn';
            rawBtn.textContent = 'RAW';

            const uuidBtn = document.createElement('button');
            uuidBtn.type = 'button';
            uuidBtn.className = 'bookmarklet-tool-btn';
            uuidBtn.textContent = 'UUID';

            const copyAllBtn = document.createElement('button');
            copyAllBtn.type = 'button';
            copyAllBtn.className = 'bookmarklet-tool-btn';
            copyAllBtn.textContent = 'Copy Visible';

            const exportBtn = document.createElement('button');
            exportBtn.type = 'button';
            exportBtn.className = 'bookmarklet-tool-btn';
            exportBtn.textContent = 'Export';

            bookmarkletToolModalActions?.append(sqlBtn, rawBtn, uuidBtn, copyAllBtn, exportBtn, searchInput, dateInput);

            const summaryChip = document.createElement('div');
            summaryChip.className = 'bookmarklet-tool-chip';
            summaryChip.style.marginBottom = '8px';

            const list = document.createElement('div');
            list.className = 'bookmarklet-tool-list';

            bookmarkletToolModalBody?.append(summaryChip, list);

            const getVisibleRows = () => {
                const query = searchInput.value.trim().toLowerCase();
                const dateQuery = dateInput.value.trim().toLowerCase();
                return rows.filter((item) => {
                    const hay = `${item.id} ${item.raw}`.toLowerCase();
                    const dateVal = String(item.date || '').toLowerCase();
                    const matchesQuery = !query || hay.includes(query);
                    const matchesDate = !dateQuery || dateVal.includes(dateQuery);
                    return matchesQuery && matchesDate;
                });
            };

            const setMode = (newMode) => {
                mode = newMode;
                [sqlBtn, rawBtn, uuidBtn].forEach((btn) => btn.classList.remove('active'));
                if (newMode === 'SQL') sqlBtn.classList.add('active');
                if (newMode === 'RAW') rawBtn.classList.add('active');
                if (newMode === 'UUID') uuidBtn.classList.add('active');
                render();
            };

            const render = () => {
                const visibleRows = getVisibleRows();
                summaryChip.textContent = `Showing ${visibleRows.length} of ${rows.length} UUIDs`;
                list.innerHTML = '';
                visibleRows.forEach((item) => {
                    const rowEl = document.createElement('div');
                    rowEl.className = 'bookmarklet-tool-item';

                    const main = document.createElement('div');
                    main.className = 'bookmarklet-tool-item-main';
                    main.textContent = getDisplayValue(item);

                    const meta = document.createElement('div');
                    meta.className = 'bookmarklet-tool-item-meta';
                    meta.textContent = `Date: ${item.date || 'N/A'}`;

                    rowEl.append(main, meta);
                    rowEl.addEventListener('click', async () => {
                        try {
                            await navigator.clipboard.writeText(getDisplayValue(item));
                            showToast('Copied.');
                        } catch (e) {
                            showToast('Copy failed.');
                        }
                    });
                    list.appendChild(rowEl);
                });
            };

            searchInput.addEventListener('input', render);
            dateInput.addEventListener('input', render);
            sqlBtn.addEventListener('click', () => setMode('SQL'));
            rawBtn.addEventListener('click', () => setMode('RAW'));
            uuidBtn.addEventListener('click', () => setMode('UUID'));

            copyAllBtn.addEventListener('click', async () => {
                const visibleRows = getVisibleRows();
                if (!visibleRows.length) return showToast('No visible rows.');
                try {
                    await navigator.clipboard.writeText(visibleRows.map(getDisplayValue).join(', '));
                    showToast(`Copied ${visibleRows.length} UUIDs.`);
                } catch (e) {
                    showToast('Copy failed.');
                }
            });

            exportBtn.addEventListener('click', () => {
                const visibleRows = getVisibleRows();
                if (!visibleRows.length) return showToast('No visible rows.');
                const lines = visibleRows.map(item => `${item.id}\t${item.raw}\t${item.date || 'N/A'}`).join('\n');
                const blob = new Blob([`UUID\tRAW\tDATE\n${lines}`], { type: 'text/plain' });
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = `uuid_export_${Date.now()}.txt`;
                a.click();
            });

            render();
            searchInput.focus();
        } catch (error) {
            console.error('UUID picker failed:', error);
            showToast('UUID Picker failed.');
        }
    };

    const fetchDocmanGroups = async (tabId) => {
        const [{ result }] = await chrome.scripting.executeScript({
            target: { tabId },
            func: () => {
                const normalize = (value) => String(value || '').trim();
                const allInputs = Array.from(document.querySelectorAll('input'));
                const filledVisible = allInputs.filter((input) => input.offsetParent !== null && normalize(input.value).length > 0);
                const groups = [];

                // Existing page pattern stores docman group inputs in alternating fields.
                for (let i = 0; i < filledVisible.length; i += 2) {
                    const value = normalize(filledVisible[i]?.value);
                    if (value) groups.push(value);
                }

                return [...new Set(groups)];
            }
        });
        return Array.isArray(result) ? result : [];
    };

    const openDocmanGroupsModal = async () => {
        try {
            const tab = await getActiveBetterLetterTabForTool();
            if (!tab) return;

            const groups = await fetchDocmanGroups(tab.id);
            if (!groups.length) {
                showToast('No Docman Groups found on the active page.');
                return;
            }

            if (!openBookmarkletToolModal('Docman Group Names')) return;

            const countChip = document.createElement('div');
            countChip.className = 'bookmarklet-tool-chip';
            countChip.textContent = `${groups.length} unique group names`;

            const copyBtn = document.createElement('button');
            copyBtn.type = 'button';
            copyBtn.className = 'bookmarklet-tool-btn';
            copyBtn.textContent = 'Copy All';

            bookmarkletToolModalActions?.append(countChip, copyBtn);

            const textarea = document.createElement('textarea');
            textarea.value = groups.join('\n');
            textarea.readOnly = true;
            textarea.style.width = '100%';
            textarea.style.minHeight = '300px';
            textarea.style.resize = 'vertical';
            textarea.style.margin = '0';
            textarea.style.fontFamily = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';
            textarea.style.fontSize = '12px';

            bookmarkletToolModalBody?.appendChild(textarea);

            copyBtn.addEventListener('click', async () => {
                try {
                    await navigator.clipboard.writeText(textarea.value);
                    showToast(`Copied ${groups.length} group names.`);
                } catch (e) {
                    showToast('Copy failed.');
                }
            });

            textarea.focus();
            textarea.select();
        } catch (error) {
            console.error('Docman groups failed:', error);
            showToast('Docman groups tool failed.');
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

    // --- Linear Issue Helpers ---
    // Keep panel-side sanitization lightweight, then validate again in background/local server.
    const trimField = (value, maxLength = 4096) => String(value || '').trim().slice(0, maxLength);
    const trimMultilineField = (value, maxLength = 12000) => String(value || '')
        .replace(/\r\n/g, '\n')
        .replace(/\u0000/g, '')
        .trim()
        .slice(0, maxLength);

    const extractDocumentIdFromText = (value) => {
        const raw = String(value || '');
        const directMatch = raw.match(/\b(?:letter|document)\s*id\s*:\s*(\d+)\b/i);
        if (directMatch?.[1]) return directMatch[1];

        const linkMatch = raw.match(/\/admin_panel\/letter\/(\d+)\b/i);
        if (linkMatch?.[1]) return linkMatch[1];

        const trimmed = raw.trim();
        if (/^\d+$/.test(trimmed)) return trimmed;

        const numericTokens = raw.match(/\b\d+\b/g) || [];
        if (numericTokens.length === 1) return numericTokens[0];
        const firstLikelyDocumentId = numericTokens.find((token) => token.length >= 6);
        return firstLikelyDocumentId || '';
    };

    const normalizeSlackTargetType = (value) => (
        String(value || '').trim().toLowerCase() === 'user' ? 'user' : 'channel'
    );

    const sanitizeSlackTargetValue = (value) => trimField(value, 180);

    const extractSlackEntityId = (value) => {
        const match = String(value || '').toUpperCase().match(/\b([A-Z][A-Z0-9]{8,})\b/);
        return match?.[1] || '';
    };

    const isLikelySlackChannelName = (value) => /^[a-z0-9._-]{2,80}$/i.test(String(value || '').trim().replace(/^#/, ''));

    const normalizeSlackTargetEntry = (entry, fallbackType = 'channel') => {
        if (!entry || typeof entry !== 'object') return null;
        const id = sanitizeSlackTargetValue(entry.id);
        if (!id) return null;
        const type = normalizeSlackTargetType(entry.type || fallbackType);
        const name = trimField(entry.name, 120);
        const label = trimField(entry.label, 180)
            || (type === 'user'
                ? (name ? `${name} (${id})` : id)
                : (name ? `#${name} (${id})` : id));
        return { id, name, label, type };
    };

    const normalizeSlackTargetList = (list, type) => {
        const source = Array.isArray(list) ? list : [];
        const map = new Map();
        source.forEach((item) => {
            const normalized = normalizeSlackTargetEntry(item, type);
            if (!normalized || map.has(normalized.id)) return;
            map.set(normalized.id, normalized);
        });
        return [...map.values()];
    };

    const normalizeSlackTargetCache = (rawCache = {}) => ({
        channels: normalizeSlackTargetList(rawCache?.channels, 'channel'),
        users: normalizeSlackTargetList(rawCache?.users, 'user'),
        syncedAt: trimField(rawCache?.syncedAt, 80)
    });

    const getSlackSyncSummaryText = () => {
        const channelCount = linearSlackTargetsCache.channels.length;
        const userCount = linearSlackTargetsCache.users.length;
        const syncedAtRaw = trimField(linearSlackTargetsCache.syncedAt, 80);
        const syncedAtDate = syncedAtRaw ? new Date(syncedAtRaw) : null;
        const syncedAtText = syncedAtDate && !Number.isNaN(syncedAtDate.getTime())
            ? syncedAtDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            : '';
        if (!channelCount && !userCount) return 'Not synced yet.';
        return `Synced ${channelCount} channels / ${userCount} users${syncedAtText ? ` at ${syncedAtText}` : ''}.`;
    };

    const getSlackTargetSuggestionsForType = (targetType) => (
        normalizeSlackTargetType(targetType) === 'user'
            ? linearSlackTargetsCache.users
            : linearSlackTargetsCache.channels
    );

    const resolveSlackTargetIdFromInput = (value, targetType) => {
        const directId = extractSlackEntityId(value);
        if (directId) return directId;

        const list = getSlackTargetSuggestionsForType(targetType);
        const lookup = collapseText(value).toLowerCase().replace(/^[@#]/, '');
        if (!lookup) return '';

        const byName = list.find((item) => collapseText(item.name).toLowerCase() === lookup);
        if (byName?.id) return byName.id;

        const byLabelPrefix = list.find((item) => collapseText(item.label).toLowerCase().startsWith(lookup));
        if (byLabelPrefix?.id) return byLabelPrefix.id;

        return '';
    };

    const formatSlackTargetDisplayValue = (targetId, targetType) => {
        const normalizedId = extractSlackEntityId(targetId);
        if (!normalizedId) return '';
        const list = getSlackTargetSuggestionsForType(targetType);
        const entry = list.find((item) => item.id.toUpperCase() === normalizedId);
        return entry?.label || normalizedId;
    };

    const renderSlackTargetSuggestions = () => {
        if (!linearSlackTargetSuggestions) return;
        linearSlackTargetSuggestions.innerHTML = '';
        const targetType = normalizeSlackTargetType(linearSlackTargetTypeInput?.value);
        const list = getSlackTargetSuggestionsForType(targetType);
        list.forEach((item) => {
            const option = document.createElement('option');
            option.value = item.label || item.id;
            linearSlackTargetSuggestions.appendChild(option);
        });
    };

    const saveSlackTargetCache = async () => {
        await chrome.storage.local.set({
            [LINEAR_SLACK_TARGET_CACHE_STORAGE_KEY]: linearSlackTargetsCache
        });
    };

    const loadSlackTargetCache = async () => {
        const { [LINEAR_SLACK_TARGET_CACHE_STORAGE_KEY]: rawCache } = await chrome.storage.local.get([
            LINEAR_SLACK_TARGET_CACHE_STORAGE_KEY
        ]);
        linearSlackTargetsCache = normalizeSlackTargetCache(rawCache || {});
        renderSlackTargetSuggestions();
    };

    const getLinearSlackPrefsFromForm = () => {
        const targetType = normalizeSlackTargetType(linearSlackTargetTypeInput?.value);
        const rawTarget = sanitizeSlackTargetValue(linearSlackTargetInput?.value);
        const resolvedTarget = resolveSlackTargetIdFromInput(rawTarget, targetType);
        const target = resolvedTarget || rawTarget.replace(/^[@#]/, '');
        return {
            enabled: Boolean(linearSlackNotifyEnabledInput?.checked),
            targetType,
            target
        };
    };

    const setLinearSlackTargetHint = (message, tone = null) => {
        if (!linearSlackTargetHint) return;
        linearSlackTargetHint.classList.remove('neutral', 'valid', 'invalid');
        if (tone === 'valid') linearSlackTargetHint.classList.add('valid');
        else if (tone === 'invalid') linearSlackTargetHint.classList.add('invalid');
        else linearSlackTargetHint.classList.add('neutral');
        linearSlackTargetHint.textContent = message;
    };

    const updateLinearSlackTargetUi = () => {
        const prefs = getLinearSlackPrefsFromForm();
        const isUserTarget = prefs.targetType === 'user';
        const suggestionCount = getSlackTargetSuggestionsForType(prefs.targetType).length;
        const syncSummary = getSlackSyncSummaryText();
        const rawTargetInput = sanitizeSlackTargetValue(linearSlackTargetInput?.value);
        const resolvedTargetId = resolveSlackTargetIdFromInput(rawTargetInput, prefs.targetType);
        const selectedTargetDisplay = formatSlackTargetDisplayValue(resolvedTargetId, prefs.targetType) || resolvedTargetId;

        if (linearSlackTargetTypeInput) linearSlackTargetTypeInput.value = prefs.targetType;
        if (linearSlackTargetInput) {
            linearSlackTargetInput.placeholder = isUserTarget ? 'e.g. U0123ABCD' : 'e.g. C0123ABCD';
            linearSlackTargetInput.disabled = !prefs.enabled;
        }
        if (linearSlackTargetTypeInput) {
            linearSlackTargetTypeInput.disabled = !prefs.enabled;
        }
        renderSlackTargetSuggestions();

        if (!prefs.enabled) {
            setLinearSlackTargetHint(`Slack sync disabled. ${syncSummary}`);
            return;
        }

        if (!rawTargetInput) {
            setLinearSlackTargetHint(
                isUserTarget
                    ? `Enter Slack user ID (U...) for DM notifications.${suggestionCount ? ` ${suggestionCount} suggestions ready.` : ' Click Sync Slack to load suggestions.'}`
                    : `Enter Slack channel ID (C... or G...).${suggestionCount ? ` ${suggestionCount} suggestions ready.` : ' Click Sync Slack to load suggestions.'}`,
                'invalid'
            );
            return;
        }

        if (!resolvedTargetId) {
            if (!isUserTarget && isLikelySlackChannelName(rawTargetInput)) {
                setLinearSlackTargetHint(
                    `Will resolve channel name "${rawTargetInput.replace(/^#/, '')}" on submit. ${syncSummary}`,
                    'neutral'
                );
                return;
            }
            setLinearSlackTargetHint(
                isUserTarget
                    ? 'Select a synced user suggestion or paste a valid Slack user ID.'
                    : 'Select a synced channel suggestion or paste a valid Slack channel ID.',
                'invalid'
            );
            return;
        }

        setLinearSlackTargetHint(
            isUserTarget
                ? `Slack DM target: ${selectedTargetDisplay} · ${syncSummary}`
                : `Slack channel target: ${selectedTargetDisplay} · ${syncSummary}`,
            'valid'
        );
    };

    const syncSlackWorkspaceTargets = async () => {
        if (syncLinearSlackWorkspaceBtn) {
            syncLinearSlackWorkspaceBtn.disabled = true;
            syncLinearSlackWorkspaceBtn.textContent = 'Syncing…';
        }

        try {
            setLinearSlackTargetHint('Syncing Slack workspace targets…', 'neutral');
            const response = await chrome.runtime.sendMessage({
                action: 'syncLinearSlackWorkspaceTargets'
            });

            if (!response?.success || !response?.targets) {
                throw new Error(trimField(response?.error, 260) || 'Could not sync Slack workspace.');
            }

            linearSlackTargetsCache = normalizeSlackTargetCache(response.targets);
            await saveSlackTargetCache();
            const targetType = normalizeSlackTargetType(linearSlackTargetTypeInput?.value);
            const resolvedTargetId = resolveSlackTargetIdFromInput(linearSlackTargetInput?.value, targetType);
            if (resolvedTargetId && linearSlackTargetInput) {
                linearSlackTargetInput.value = formatSlackTargetDisplayValue(resolvedTargetId, targetType) || resolvedTargetId;
            }
            updateLinearSlackTargetUi();
            showToast('Slack workspace synced.');
        } catch (error) {
            const reason = trimField(error?.message, 260) || 'Could not sync Slack workspace.';
            setLinearSlackTargetHint(reason, 'invalid');
            showToast(reason);
        } finally {
            if (syncLinearSlackWorkspaceBtn) {
                syncLinearSlackWorkspaceBtn.disabled = false;
                syncLinearSlackWorkspaceBtn.textContent = 'Sync Slack';
            }
        }
    };

    const saveLinearSlackPrefs = async () => {
        const prefs = getLinearSlackPrefsFromForm();
        await chrome.storage.local.set({
            [LINEAR_SLACK_PREFS_STORAGE_KEY]: prefs
        });
    };

    const loadLinearSlackPrefs = async () => {
        const { [LINEAR_SLACK_PREFS_STORAGE_KEY]: rawPrefs } = await chrome.storage.local.get([
            LINEAR_SLACK_PREFS_STORAGE_KEY
        ]);

        const prefs = rawPrefs && typeof rawPrefs === 'object'
            ? {
                enabled: Boolean(rawPrefs.enabled),
                targetType: normalizeSlackTargetType(rawPrefs.targetType),
                target: sanitizeSlackTargetValue(rawPrefs.target)
            }
            : {
                enabled: false,
                targetType: 'channel',
                target: ''
            };

        if (linearSlackNotifyEnabledInput) linearSlackNotifyEnabledInput.checked = prefs.enabled;
        if (linearSlackTargetTypeInput) linearSlackTargetTypeInput.value = prefs.targetType;
        if (linearSlackTargetInput) {
            const targetId = extractSlackEntityId(prefs.target);
            linearSlackTargetInput.value = targetId
                ? (formatSlackTargetDisplayValue(targetId, prefs.targetType) || targetId)
                : prefs.target;
        }
        updateLinearSlackTargetUi();
    };

    const setLinearSlackStatus = (message, tone = null) => {
        if (!linearSlackStatus) return;
        linearSlackStatus.classList.remove('neutral', 'valid', 'invalid');
        if (tone === 'valid') linearSlackStatus.classList.add('valid');
        else if (tone === 'invalid') linearSlackStatus.classList.add('invalid');
        else linearSlackStatus.classList.add('neutral');
        linearSlackStatus.textContent = message;
    };

    const setLinearTriggerStatus = (message, tone = null) => {
        if (!linearTriggerStatus) return;
        linearTriggerStatus.classList.remove('neutral', 'valid', 'invalid');
        if (tone === 'valid') linearTriggerStatus.classList.add('valid');
        else if (tone === 'invalid') linearTriggerStatus.classList.add('invalid');
        else linearTriggerStatus.classList.add('neutral');
        linearTriggerStatus.textContent = message;
    };

    const setLinearTriggerButtonState = (state, runType = 'trigger') => {
        const normalized = String(state || 'idle').toLowerCase();
        const normalizedRunType = String(runType || '').toLowerCase() === 'reconcile' ? 'reconcile' : 'trigger';

        if (triggerLinearBotJobsBtn) {
            triggerLinearBotJobsBtn.disabled = false;
            triggerLinearBotJobsBtn.textContent = 'Trigger Linear';
        }
        if (reconcileLinearBotIssuesBtn) {
            reconcileLinearBotIssuesBtn.disabled = false;
            reconcileLinearBotIssuesBtn.textContent = 'Reconcile Linear';
        }

        if (normalized === 'pending') {
            if (triggerLinearBotJobsBtn) triggerLinearBotJobsBtn.disabled = true;
            if (reconcileLinearBotIssuesBtn) reconcileLinearBotIssuesBtn.disabled = true;
            if (normalizedRunType === 'reconcile') {
                if (reconcileLinearBotIssuesBtn) reconcileLinearBotIssuesBtn.textContent = 'Reconciling…';
            } else if (triggerLinearBotJobsBtn) {
                triggerLinearBotJobsBtn.textContent = 'Triggering…';
            }
            return;
        }

        if (normalized === 'running') {
            if (triggerLinearBotJobsBtn) triggerLinearBotJobsBtn.disabled = true;
            if (reconcileLinearBotIssuesBtn) reconcileLinearBotIssuesBtn.disabled = true;
            if (normalizedRunType === 'reconcile') {
                if (reconcileLinearBotIssuesBtn) reconcileLinearBotIssuesBtn.textContent = 'Running…';
            } else if (triggerLinearBotJobsBtn) {
                triggerLinearBotJobsBtn.textContent = 'Running…';
            }
            return;
        }
    };

    const formatLinearTriggerTime = (value) => {
        if (!value) return '';
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return '';
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    };

    const formatLinearTriggerRunSummary = (run, isActive = false) => {
        if (!run || typeof run !== 'object') return '';
        const runId = trimField(run.runId, 64) || 'unknown';
        const started = formatLinearTriggerTime(run.startedAt);
        const ended = formatLinearTriggerTime(run.endedAt);
        const runType = String(run.runType || '').toLowerCase() === 'reconcile' ? 'reconcile' : 'trigger';
        const runLabel = runType === 'reconcile' ? 'Reconcile' : 'Trigger';
        const dryRun = run.dryRun ? ' (dry run)' : '';
        const summaryLines = Array.isArray(run.summaryLines)
            ? run.summaryLines.map((line) => trimField(line, 240)).filter(Boolean).slice(0, 10)
            : [];
        if (isActive || String(run.status || '').toLowerCase() === 'running') {
            return `${runLabel} run ${runId} is running${dryRun}${started ? ` since ${started}` : ''}.`;
        }
        let headline = '';
        if (String(run.status || '').toLowerCase() === 'success') {
            headline = `${runLabel} run ${runId} finished successfully${dryRun}${ended ? ` at ${ended}` : ''}.`;
        } else {
            const reason = trimField(run.error, 180) || `exit code ${String(run.exitCode ?? 'unknown')}`;
            headline = `${runLabel} run ${runId} failed${dryRun}${ended ? ` at ${ended}` : ''}: ${reason}`;
        }
        return summaryLines.length ? [headline, ...summaryLines].join('\n') : headline;
    };

    const stopLinearTriggerStatusPolling = () => {
        if (!linearTriggerStatusPollTimer) return;
        clearInterval(linearTriggerStatusPollTimer);
        linearTriggerStatusPollTimer = null;
        linearTriggerStatusPollDeadlineMs = 0;
    };

    const applyLinearTriggerHealthStatus = (health) => {
        if (!health || typeof health !== 'object') {
            setLinearTriggerStatus('Local trigger status unavailable.', 'invalid');
            setLinearTriggerButtonState('idle');
            return false;
        }

        const isRunning = Boolean(health.running);
        const activeRun = health.activeRun && typeof health.activeRun === 'object' ? health.activeRun : null;
        const lastRun = health.lastRun && typeof health.lastRun === 'object' ? health.lastRun : null;

        if (isRunning && activeRun) {
            setLinearTriggerButtonState('running', activeRun.runType);
            setLinearTriggerStatus(formatLinearTriggerRunSummary(activeRun, true), 'neutral');
            return true;
        }

        setLinearTriggerButtonState('idle');
        if (lastRun) {
            const tone = String(lastRun.status || '').toLowerCase() === 'success' ? 'valid' : 'invalid';
            setLinearTriggerStatus(formatLinearTriggerRunSummary(lastRun, false), tone);
            return false;
        }

        setLinearTriggerStatus('Local trigger idle.', 'neutral');
        return false;
    };

    const fetchLinearTriggerHealthStatus = async () => {
        const response = await chrome.runtime.sendMessage({
            action: 'getLinearBotJobsTriggerStatus'
        });
        if (!response?.success || !response?.status) {
            const reason = trimField(response?.error, 240) || 'Could not read local trigger status.';
            throw new Error(reason);
        }
        return response.status;
    };

    const pollLinearTriggerStatus = async ({ silent = false } = {}) => {
        try {
            const health = await fetchLinearTriggerHealthStatus();
            return applyLinearTriggerHealthStatus(health);
        } catch (error) {
            setLinearTriggerButtonState('idle');
            if (!silent) {
                const reason = trimField(error?.message, 240) || 'Could not read local trigger status.';
                setLinearTriggerStatus(reason, 'invalid');
            }
            return false;
        }
    };

    const startLinearTriggerStatusPolling = () => {
        stopLinearTriggerStatusPolling();
        linearTriggerStatusPollDeadlineMs = Date.now() + LINEAR_TRIGGER_STATUS_POLL_WINDOW_MS;

        pollLinearTriggerStatus({ silent: false }).catch(() => undefined);

        linearTriggerStatusPollTimer = setInterval(() => {
            if (Date.now() > linearTriggerStatusPollDeadlineMs) {
                stopLinearTriggerStatusPolling();
                setLinearTriggerButtonState('idle');
                return;
            }
            pollLinearTriggerStatus({ silent: false })
                .then((isRunning) => {
                    if (!isRunning) stopLinearTriggerStatusPolling();
                })
                .catch(() => undefined);
        }, LINEAR_TRIGGER_STATUS_POLL_INTERVAL_MS);
    };

    const triggerLinearBotJobsRun = async () => {
        try {
            const isDryRun = Boolean(triggerLinearDryRunInput?.checked);
            setLinearTriggerButtonState('pending', 'trigger');
            setLinearTriggerStatus(
                isDryRun ? 'Triggering bot-jobs-linear dry run…' : 'Triggering bot-jobs-linear run…',
                'neutral'
            );

            const response = await chrome.runtime.sendMessage({
                action: 'triggerLinearBotJobsRun',
                payload: { dryRun: isDryRun }
            });

            if (response?.success && response?.run) {
                const summary = formatLinearTriggerRunSummary(response.run, true) || 'Run started.';
                setLinearTriggerStatus(summary, 'valid');
                showToast(isDryRun ? 'bot-jobs-linear dry run triggered.' : 'bot-jobs-linear run triggered.');
                setLinearTriggerButtonState('running', response?.run?.runType || 'trigger');
                startLinearTriggerStatusPolling();
                return;
            }

            if (response?.running && response?.run) {
                const summary = formatLinearTriggerRunSummary(response.run, true) || 'A run is already in progress.';
                setLinearTriggerStatus(summary, 'neutral');
                showToast('A Linear run is already in progress.');
                setLinearTriggerButtonState('running', response?.run?.runType || 'trigger');
                startLinearTriggerStatusPolling();
                return;
            }

            throw new Error(trimField(response?.error, 260) || 'Could not trigger bot-jobs-linear run.');
        } catch (error) {
            const message = trimField(error?.message, 260) || 'Could not trigger bot-jobs-linear run.';
            setLinearTriggerStatus(message, 'invalid');
            setLinearTriggerButtonState('idle');
            showToast(message);
        }
    };

    const triggerLinearReconcileRun = async () => {
        try {
            const isDryRun = Boolean(reconcileLinearDryRunInput?.checked);
            setLinearTriggerButtonState('pending', 'reconcile');
            setLinearTriggerStatus(
                isDryRun ? 'Triggering Linear reconcile dry run…' : 'Triggering Linear reconcile run…',
                'neutral'
            );

            const response = await chrome.runtime.sendMessage({
                action: 'triggerLinearReconcileRun',
                payload: { dryRun: isDryRun }
            });

            if (response?.success && response?.run) {
                const summary = formatLinearTriggerRunSummary(response.run, true) || 'Reconcile run started.';
                setLinearTriggerStatus(summary, 'valid');
                showToast(isDryRun ? 'Linear reconcile dry run triggered.' : 'Linear reconcile run triggered.');
                setLinearTriggerButtonState('running', response?.run?.runType || 'reconcile');
                startLinearTriggerStatusPolling();
                return;
            }

            if (response?.running && response?.run) {
                const summary = formatLinearTriggerRunSummary(response.run, true) || 'A run is already in progress.';
                setLinearTriggerStatus(summary, 'neutral');
                showToast('A Linear run is already in progress.');
                setLinearTriggerButtonState('running', response?.run?.runType || 'trigger');
                startLinearTriggerStatusPolling();
                return;
            }

            throw new Error(trimField(response?.error, 260) || 'Could not trigger Linear reconcile run.');
        } catch (error) {
            const message = trimField(error?.message, 260) || 'Could not trigger Linear reconcile run.';
            setLinearTriggerStatus(message, 'invalid');
            setLinearTriggerButtonState('idle');
            showToast(message);
        }
    };

    const getStructuredField = (text, label) => {
        const pattern = new RegExp(`\\b${label}\\s*:\\s*([^\\n]+)`, 'i');
        const match = String(text || '').match(pattern);
        return trimField(match?.[1] || '', 1000);
    };

    const getStructuredLink = (text, label) => {
        const pattern = new RegExp(`\\b${label}\\s*:\\s*(https?:\\/\\/\\S+)`, 'i');
        const match = String(text || '').match(pattern);
        return trimField(match?.[1] || '', 1200);
    };

    const buildLinearIssueDraft = (rawInput) => {
        const sourceText = trimMultilineField(rawInput, 6000);
        const documentId = extractDocumentIdFromText(sourceText);
        const dashboardRow = documentId ? getRowForDocId(documentId) : null;

        const failedJobIdFromText = extractJobId(getStructuredField(sourceText, 'Failed\\s*job\\s*ID'));
        const failedJobId = failedJobIdFromText || trimField(dashboardRow?.jobId, 120);

        const practiceFromText = getStructuredField(sourceText, 'Practice');
        const practiceName = practiceFromText
            || trimField(dashboardRow?.practiceName || dashboardRow?.practice, 240);

        const fileSizeBytes = getStructuredField(sourceText, 'File\\s*size');
        const parsedLetterLink = getStructuredLink(sourceText, 'Letter\\s*admin\\s*link');
        const parsedFailedJobLink = getStructuredLink(sourceText, 'Failed\\s*job\\s*link');

        const letterAdminLink = parsedLetterLink
            || (documentId ? `https://app.betterletter.ai/admin_panel/letter/${documentId}` : 'https://app.betterletter.ai/admin_panel/letter/');
        const failedJobLink = parsedFailedJobLink
            || (failedJobId
                ? `https://app.betterletter.ai/admin_panel/bots/jobs/${encodeURIComponent(failedJobId)}`
                : 'https://app.betterletter.ai/admin_panel/bots/jobs/');

        const title = practiceName
            ? `Stuck letter: ${documentId} (${practiceName})`
            : `Stuck letter: ${documentId}`;

        const description = [
            `Letter ID: ${documentId || 'N/A'}`,
            `Failed job ID: ${failedJobId || 'N/A'}`,
            `File size: ${fileSizeBytes || 'N/A'}`,
            `Practice: ${practiceName || 'N/A'}`,
            '',
            'Letter admin link:',
            letterAdminLink,
            '',
            'Failed job link:',
            failedJobLink
        ].join('\n');

        return {
            documentId,
            failedJobId,
            fileSizeBytes,
            practiceName,
            letterAdminLink,
            failedJobLink,
            title,
            description
        };
    };

    const generateLinearIssueDraft = ({ silent = false } = {}) => {
        const sourceInput = trimMultilineField(linearIssueSourceInput?.value, 6000);
        const fallbackDocId = extractNumericId(manualDocIdInput?.value);
        const draft = buildLinearIssueDraft(sourceInput || fallbackDocId);

        if (!draft.documentId) {
            if (!silent) {
                setLinearSlackStatus('Provide a valid Document ID (or details block containing Letter ID).', 'invalid');
                showToast('Provide a valid Document ID.');
            }
            return null;
        }

        if (linearIssueTitleInput && !trimField(linearIssueTitleInput.value, 240)) {
            linearIssueTitleInput.value = draft.title;
        }
        if (linearIssueDescriptionInput && !trimMultilineField(linearIssueDescriptionInput.value, 12000)) {
            linearIssueDescriptionInput.value = draft.description;
        }

        linearIssueContext = {
            documentId: draft.documentId,
            failedJobId: draft.failedJobId,
            fileSizeBytes: draft.fileSizeBytes,
            practiceName: draft.practiceName,
            letterAdminLink: draft.letterAdminLink,
            failedJobLink: draft.failedJobLink
        };

        if (!silent) {
            const row = draft.documentId ? getRowForDocId(draft.documentId) : null;
            const metadataHint = row ? ` · ${row.jobType || 'job'} · ${truncateText(row.latestError || row.status, 80)}` : '';
            setLinearSlackStatus(`Generated issue details for Document ${draft.documentId}${metadataHint}`, 'valid');
            showToast(`Generated details for ${draft.documentId}.`);
        }

        return draft;
    };

    const getLinearIssuePayloadFromForm = () => {
        const priorityRaw = Number.parseInt(String(linearIssuePriorityInput?.value || '0'), 10);
        const priority = [0, 1, 2, 3, 4].includes(priorityRaw) ? priorityRaw : 0;

        return {
            documentId: trimField(linearIssueContext?.documentId, 32),
            failedJobId: trimField(linearIssueContext?.failedJobId, 120),
            fileSizeBytes: trimField(linearIssueContext?.fileSizeBytes, 120),
            practiceName: trimField(linearIssueContext?.practiceName, 240),
            letterAdminLink: trimField(linearIssueContext?.letterAdminLink, 1200),
            failedJobLink: trimField(linearIssueContext?.failedJobLink, 1200),
            title: trimField(linearIssueTitleInput?.value, 240),
            description: trimMultilineField(linearIssueDescriptionInput?.value, 12000),
            priority,
            slack: getLinearSlackPrefsFromForm()
        };
    };

    const validateLinearIssuePayload = (payload) => {
        if (!payload.documentId) return 'Generate details first so Document ID is included.';
        if (!payload.title) return 'Issue title is required.';
        if (!payload.description) return 'Issue description is required.';
        if (payload?.slack?.enabled && !payload?.slack?.target) {
            return payload?.slack?.targetType === 'user'
                ? 'Slack user ID is required when Slack sync is enabled.'
                : 'Slack channel ID is required when Slack sync is enabled.';
        }
        if (payload?.slack?.enabled && payload?.slack?.targetType === 'user') {
            const userId = extractSlackEntityId(payload?.slack?.target);
            if (!/^U[A-Z0-9]{8,}$/i.test(userId)) {
                return 'Select a synced user suggestion or paste a valid Slack user ID (U...).';
            }
        }
        return '';
    };

    const createLinearIssue = async () => {
        if (!linearIssueContext || !linearIssueContext.documentId) {
            generateLinearIssueDraft({ silent: true });
        }

        const payload = getLinearIssuePayloadFromForm();
        const validationError = validateLinearIssuePayload(payload);
        if (validationError) {
            setLinearSlackStatus(validationError, 'invalid');
            showToast(validationError);
            return;
        }
        await saveLinearSlackPrefs().catch(() => undefined);

        try {
            if (createLinearSlackIssueBtn) {
                createLinearSlackIssueBtn.disabled = true;
                createLinearSlackIssueBtn.textContent = 'Submitting…';
            }

            setLinearSlackStatus('Creating issue in Linear…', 'neutral');
            const response = await chrome.runtime.sendMessage({
                action: 'createLinearIssueFromEnv',
                payload
            });

            if (!response?.success || !response?.issue?.identifier) {
                throw new Error(trimField(response?.error, 260) || 'Failed to create issue.');
            }

            const issueId = trimField(response.issue.identifier, 64);
            const issueUrl = trimField(response.issue.url, 1000);
            const slack = response?.slack && typeof response.slack === 'object' ? response.slack : null;
            const slackAttempted = Boolean(slack?.attempted);
            const slackSuccess = Boolean(slack?.success);

            if (slackAttempted && !slackSuccess) {
                const slackError = trimField(slack?.error, 220) || 'Slack notification failed.';
                setLinearSlackStatus(`Created ${issueId}\n${issueUrl}\nSlack failed: ${slackError}`, 'invalid');
                showToast(`Issue created: ${issueId} (Slack failed)`);
                return;
            }

            if (slackAttempted && slackSuccess) {
                const slackTarget = trimField(slack?.target, 80);
                const targetLabel = trimField(slack?.targetType, 12) === 'user'
                    ? `DM ${slackTarget || 'user'}`
                    : `channel ${slackTarget || 'target'}`;
                setLinearSlackStatus(`Created ${issueId}\n${issueUrl}\nSlack sent to ${targetLabel}.`, 'valid');
                showToast(`Issue created + Slack sent: ${issueId}`);
                return;
            }

            setLinearSlackStatus(`Created ${issueId}\n${issueUrl}`, 'valid');
            showToast(`Issue created: ${issueId}`);
        } catch (error) {
            const message = trimField(error?.message, 260) || 'Linear request failed.';
            setLinearSlackStatus(message, 'invalid');
            showToast(message);
        } finally {
            if (createLinearSlackIssueBtn) {
                createLinearSlackIssueBtn.disabled = false;
                createLinearSlackIssueBtn.textContent = 'Create Linear Issue';
            }
        }
    };

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
        const {
            recentDocIds: d = [],
            recentJobIds: j = [],
            recentDocSuggestionMeta: docMeta = {},
            recentJobSuggestionMeta: jobMeta = {}
        } = await chrome.storage.local.get([
            'recentDocIds',
            'recentJobIds',
            'recentDocSuggestionMeta',
            'recentJobSuggestionMeta'
        ]);
        recentDocIds = Array.isArray(d) ? d.map(value => String(value || '').trim()).filter(Boolean).slice(0, 5) : [];
        recentJobIds = Array.isArray(j) ? j.map(value => String(value || '').trim()).filter(Boolean).slice(0, 5) : [];
        recentDocSuggestionMeta = normalizeSuggestionMetaMap(docMeta);
        recentJobSuggestionMeta = normalizeSuggestionMetaMap(jobMeta);
        renderRecentIdChips();
    };

    chrome.storage.sync.get({ workflowSkipDuplicates: true, workflowTitleCase: false }, (saved) => {
        if (workflowSkipDuplicates) workflowSkipDuplicates.checked = Boolean(saved.workflowSkipDuplicates);
        if (workflowTitleCase) workflowTitleCase.checked = Boolean(saved.workflowTitleCase);
    });
    await loadSlackTargetCache();
    await loadLinearSlackPrefs();

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

    generateLinearIssueDraftBtn?.addEventListener('click', () => {
        if (linearIssueSourceInput && !trimMultilineField(linearIssueSourceInput.value, 6000)) {
            const fallbackDocId = extractNumericId(manualDocIdInput?.value);
            if (fallbackDocId) linearIssueSourceInput.value = fallbackDocId;
        }
        const draft = generateLinearIssueDraft();
        if (!draft) return;
        if (linearIssueTitleInput) linearIssueTitleInput.value = draft.title;
        if (linearIssueDescriptionInput) linearIssueDescriptionInput.value = draft.description;
    });

    linearIssueSourceInput?.addEventListener('input', () => {
        linearIssueContext = null;
    });

    syncLinearSlackWorkspaceBtn?.addEventListener('click', () => {
        syncSlackWorkspaceTargets().catch(() => undefined);
    });
    linearSlackNotifyEnabledInput?.addEventListener('change', () => {
        updateLinearSlackTargetUi();
        saveLinearSlackPrefs().catch(() => undefined);
    });
    linearSlackTargetTypeInput?.addEventListener('change', () => {
        const targetType = normalizeSlackTargetType(linearSlackTargetTypeInput?.value);
        const resolvedTargetId = resolveSlackTargetIdFromInput(linearSlackTargetInput?.value, targetType);
        if (resolvedTargetId && linearSlackTargetInput) {
            linearSlackTargetInput.value = formatSlackTargetDisplayValue(resolvedTargetId, targetType) || resolvedTargetId;
        }
        updateLinearSlackTargetUi();
        saveLinearSlackPrefs().catch(() => undefined);
    });
    linearSlackTargetInput?.addEventListener('input', () => {
        updateLinearSlackTargetUi();
    });
    linearSlackTargetInput?.addEventListener('change', () => {
        const targetType = normalizeSlackTargetType(linearSlackTargetTypeInput?.value);
        const resolvedTargetId = resolveSlackTargetIdFromInput(linearSlackTargetInput?.value, targetType);
        if (resolvedTargetId && linearSlackTargetInput) {
            linearSlackTargetInput.value = formatSlackTargetDisplayValue(resolvedTargetId, targetType) || resolvedTargetId;
        } else if (linearSlackTargetInput) {
            linearSlackTargetInput.value = sanitizeSlackTargetValue(linearSlackTargetInput.value);
        }
        updateLinearSlackTargetUi();
        saveLinearSlackPrefs().catch(() => undefined);
    });

    createLinearSlackIssueBtn?.addEventListener('click', () => {
        createLinearIssue().catch(() => {
            setLinearSlackStatus('Linear issue action failed.', 'invalid');
            showToast('Linear issue action failed.');
        });
    });
    triggerLinearBotJobsBtn?.addEventListener('click', () => {
        triggerLinearBotJobsRun().catch(() => {
            setLinearTriggerStatus('Could not trigger bot-jobs-linear run.', 'invalid');
            setLinearTriggerButtonState('idle');
            showToast('Could not trigger bot-jobs-linear run.');
        });
    });
    reconcileLinearBotIssuesBtn?.addEventListener('click', () => {
        triggerLinearReconcileRun().catch(() => {
            setLinearTriggerStatus('Could not trigger Linear reconcile run.', 'invalid');
            setLinearTriggerButtonState('idle');
            showToast('Could not trigger Linear reconcile run.');
        });
    });
    const isLinearRunActiveOnLoad = await pollLinearTriggerStatus({ silent: true });
    if (isLinearRunActiveOnLoad) {
        startLinearTriggerStatusPolling();
    }

    const refreshDocSuggestions = async ({ force = false } = {}) => {
        await syncDashboardSuggestionRows({ force, silent: true });
        showDocIdSuggestions();
    };

    const refreshJobSuggestions = async ({ force = false } = {}) => {
        await syncDashboardSuggestionRows({ force, silent: true });
        showJobIdSuggestions();
    };

    manualDocIdInput?.addEventListener('input', () => {
        updateDocValidation();
        syncJobStatusFromManualDocId();
        showDocIdSuggestions();
    });
    manualDocIdInput?.addEventListener('focus', async () => {
        hideDashboardAutocomplete(jobIdAutocompleteResultsContainer);
        await refreshDocSuggestions();
    });
    manualDocIdInput?.addEventListener('blur', () => {
        setTimeout(() => hideDashboardAutocomplete(docIdAutocompleteResultsContainer), 120);
    });
    manualDocIdInput?.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') hideDashboardAutocomplete(docIdAutocompleteResultsContainer);
    });

    jobStatusInput?.addEventListener('input', () => {
        updateJobValidation();
        showJobIdSuggestions();
    });
    jobStatusInput?.addEventListener('focus', async () => {
        hideDashboardAutocomplete(docIdAutocompleteResultsContainer);
        await refreshJobSuggestions();
    });
    jobStatusInput?.addEventListener('blur', () => {
        setTimeout(() => hideDashboardAutocomplete(jobIdAutocompleteResultsContainer), 120);
    });
    jobStatusInput?.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') hideDashboardAutocomplete(jobIdAutocompleteResultsContainer);
    });

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
        hideDashboardAutocomplete(jobIdAutocompleteResultsContainer);
        await pushRecentId('job', jobId);
        await openUrlsWithLoading([getJobStatusUrl(jobId)], [openJobStatusBtn]);
    });

    openProblemReviewBtn?.addEventListener('click', async () => {
        const jobId = updateJobValidation();
        if (!jobId) return showToast('No valid Job ID.');
        hideDashboardAutocomplete(jobIdAutocompleteResultsContainer);
        await pushRecentId('job', jobId);
        await openUrlsWithLoading([getProblemReviewUrl(jobId)], [openProblemReviewBtn]);
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
        hideDashboardAutocomplete(jobIdAutocompleteResultsContainer);
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

    runUuidPickerToolBtn?.addEventListener('click', openUuidPickerModal);
    runListDocmanGroupsToolBtn?.addEventListener('click', openDocmanGroupsModal);

    updateDocValidation();
    updateJobValidation();
    updateBulkValidation();
    await loadRecentIds();
    await syncDashboardSuggestionRows({ silent: true });

    // J. Global UI Listeners
    document.addEventListener("mousedown", (e) => {
        // List of all inputs that should NOT hide the dropdown when clicked
        const safeInputs = [
            'practiceInput', 
            'cdbSearchInput',
            'manualDocId',
            'jobStatusInput'
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

      await Navigator.displayPracticeStatus({ keepExisting: true, preferCached: true, silent: true });
    } catch (e) {
      console.warn("[Panel] Scan skipped.");
    } finally {
      setTimeout(() => { isPanelScrapingBusy = false; }, 5000);
    }
  }
}, 5000);

const PANEL_WIDTH = 360;
const PANEL_HEIGHT = 750;

function resizeToFitContent() {
  // Only popup windows can be resized; ignore when embedded in a sidebar iframe.
  if (window.top !== window) return;
  try {
    window.resizeTo(PANEL_WIDTH, PANEL_HEIGHT);
  } catch (e) {
    // Ignore resize errors in contexts that disallow script-driven resize.
  }
}
