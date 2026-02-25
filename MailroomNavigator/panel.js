// panel.js (Main Controller) - Full Replacement
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

    const linearApiKeyInput = document.getElementById('linearApiKeyInput');
    const linearTeamKeyInput = document.getElementById('linearTeamKeyInput');
    const linearIssueTitleInput = document.getElementById('linearIssueTitleInput');
    const linearIssueDescriptionInput = document.getElementById('linearIssueDescriptionInput');
    const linearIssuePriorityInput = document.getElementById('linearIssuePriorityInput');
    const slackDeliveryModeInput = document.getElementById('slackDeliveryModeInput');
    const slackBotModeFields = document.getElementById('slackBotModeFields');
    const slackWebhookModeFields = document.getElementById('slackWebhookModeFields');
    const slackBotTokenInput = document.getElementById('slackBotTokenInput');
    const slackChannelIdInput = document.getElementById('slackChannelIdInput');
    const slackWebhookUrlInput = document.getElementById('slackWebhookUrlInput');
    const linearSlackStatus = document.getElementById('linearSlackStatus');
    const createLinearSlackIssueBtn = document.getElementById('createLinearSlackIssueBtn');
    const saveLinearSlackConfigBtn = document.getElementById('saveLinearSlackConfigBtn');
    const clearLinearSlackConfigBtn = document.getElementById('clearLinearSlackConfigBtn');
    const triggerLinearBotJobsBtn = document.getElementById('triggerLinearBotJobsBtn');
    const triggerLinearDryRunInput = document.getElementById('triggerLinearDryRunInput');
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
    const LINEAR_SLACK_CONFIG_KEY = 'linearSlackConfigV1';
    const LINEAR_TRIGGER_STATUS_POLL_INTERVAL_MS = 3500;
    const LINEAR_TRIGGER_STATUS_POLL_WINDOW_MS = 4 * 60 * 1000;
    let linearTriggerStatusPollTimer = null;
    let linearTriggerStatusPollDeadlineMs = 0;

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

    // --- Linear + Slack Issue Helpers ---
    // We keep string sanitation on the panel side to reduce accidental bad payloads,
    // then repeat strict validation in the background worker before any network call.
    const trimField = (value, maxLength = 4096) => String(value || '').trim().slice(0, maxLength);
    const trimMultilineField = (value, maxLength = 12000) => String(value || '')
        .replace(/\r\n/g, '\n')
        .replace(/\u0000/g, '')
        .trim()
        .slice(0, maxLength);

    const isLikelySlackBotToken = (value) => /^xox[a-z]-[A-Za-z0-9-]+$/i.test(String(value || '').trim());
    const isLikelySlackChannelId = (value) => /^[CGD][A-Z0-9]{8,}$/i.test(String(value || '').trim());
    const isLikelySlackWebhookUrl = (value) => /^https:\/\/hooks\.slack(?:-gov)?\.com\/services\/[A-Za-z0-9/_-]+$/i.test(String(value || '').trim());

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

    const setLinearTriggerButtonState = (state) => {
        if (!triggerLinearBotJobsBtn) return;
        const normalized = String(state || 'idle').toLowerCase();
        if (normalized === 'pending') {
            triggerLinearBotJobsBtn.disabled = true;
            triggerLinearBotJobsBtn.textContent = 'Triggering…';
            return;
        }
        if (normalized === 'running') {
            triggerLinearBotJobsBtn.disabled = true;
            triggerLinearBotJobsBtn.textContent = 'Running…';
            return;
        }
        triggerLinearBotJobsBtn.disabled = false;
        triggerLinearBotJobsBtn.textContent = 'Trigger Linear';
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
        const dryRun = run.dryRun ? ' (dry run)' : '';
        if (isActive || String(run.status || '').toLowerCase() === 'running') {
            return `Run ${runId} is running${dryRun}${started ? ` since ${started}` : ''}.`;
        }
        if (String(run.status || '').toLowerCase() === 'success') {
            return `Run ${runId} finished successfully${dryRun}${ended ? ` at ${ended}` : ''}.`;
        }
        const reason = trimField(run.error, 180) || `exit code ${String(run.exitCode ?? 'unknown')}`;
        return `Run ${runId} failed${dryRun}${ended ? ` at ${ended}` : ''}: ${reason}`;
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
            setLinearTriggerButtonState('running');
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
            setLinearTriggerButtonState('pending');
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
                setLinearTriggerButtonState('running');
                startLinearTriggerStatusPolling();
                return;
            }

            if (response?.running && response?.run) {
                const summary = formatLinearTriggerRunSummary(response.run, true) || 'A run is already in progress.';
                setLinearTriggerStatus(summary, 'neutral');
                showToast('A Linear run is already in progress.');
                setLinearTriggerButtonState('running');
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

    // Show only the relevant Slack credential block based on selected delivery mode.
    const updateSlackModeVisibility = () => {
        const mode = String(slackDeliveryModeInput?.value || 'bot').toLowerCase() === 'webhook' ? 'webhook' : 'bot';
        if (slackBotModeFields) slackBotModeFields.style.display = mode === 'bot' ? 'block' : 'none';
        if (slackWebhookModeFields) slackWebhookModeFields.style.display = mode === 'webhook' ? 'block' : 'none';
    };

    const getLinearSlackPayloadFromForm = () => {
        const priorityRaw = Number.parseInt(String(linearIssuePriorityInput?.value || '0'), 10);
        const priority = [0, 1, 2, 3, 4].includes(priorityRaw) ? priorityRaw : 0;
        const slackMode = String(slackDeliveryModeInput?.value || 'bot').toLowerCase() === 'webhook' ? 'webhook' : 'bot';

        return {
            linearApiKey: trimField(linearApiKeyInput?.value, 300),
            linearTeamKey: trimField(linearTeamKeyInput?.value, 32),
            title: trimField(linearIssueTitleInput?.value, 240),
            description: trimMultilineField(linearIssueDescriptionInput?.value, 12000),
            priority,
            slack: {
                mode: slackMode,
                botToken: trimField(slackBotTokenInput?.value, 300),
                channelId: trimField(slackChannelIdInput?.value, 64),
                webhookUrl: trimField(slackWebhookUrlInput?.value, 600)
            }
        };
    };

    const validateLinearSlackPayload = (payload) => {
        if (!payload.linearApiKey) return 'Linear API key is required.';
        if (!payload.linearTeamKey) return 'Linear Team key is required.';
        if (!payload.title) return 'Issue title is required.';

        if (payload.slack?.mode === 'webhook') {
            if (!payload.slack.webhookUrl) return 'Slack webhook URL is required.';
            if (!isLikelySlackWebhookUrl(payload.slack.webhookUrl)) return 'Slack webhook URL format looks invalid.';
            return '';
        }

        if (!payload.slack?.botToken) return 'Slack bot token is required.';
        if (!isLikelySlackBotToken(payload.slack.botToken)) return 'Slack bot token format looks invalid.';
        if (!payload.slack.channelId) return 'Slack channel ID is required.';
        if (!isLikelySlackChannelId(payload.slack.channelId)) return 'Slack channel ID format looks invalid.';
        return '';
    };

    // Config is saved only when the user explicitly clicks "Save Config".
    // We keep it in chrome.storage.local (not sync) to avoid cross-device propagation.
    const saveLinearSlackConfig = async () => {
        const payload = getLinearSlackPayloadFromForm();

        if (!payload.linearApiKey || !payload.linearTeamKey) {
            setLinearSlackStatus('Linear API key and Team key are required to save config.', 'invalid');
            return;
        }

        if (payload.slack.mode === 'webhook') {
            if (!payload.slack.webhookUrl || !isLikelySlackWebhookUrl(payload.slack.webhookUrl)) {
                setLinearSlackStatus('Provide a valid Slack webhook URL before saving.', 'invalid');
                return;
            }
        } else {
            if (!payload.slack.botToken || !isLikelySlackBotToken(payload.slack.botToken)) {
                setLinearSlackStatus('Provide a valid Slack bot token before saving.', 'invalid');
                return;
            }
            if (!payload.slack.channelId || !isLikelySlackChannelId(payload.slack.channelId)) {
                setLinearSlackStatus('Provide a valid Slack channel ID before saving.', 'invalid');
                return;
            }
        }

        const config = {
            linearApiKey: payload.linearApiKey,
            linearTeamKey: payload.linearTeamKey,
            priority: payload.priority,
            slack: {
                mode: payload.slack.mode,
                botToken: payload.slack.botToken,
                channelId: payload.slack.channelId,
                webhookUrl: payload.slack.webhookUrl
            }
        };

        await chrome.storage.local.set({ [LINEAR_SLACK_CONFIG_KEY]: config });
        setLinearSlackStatus('Config saved locally on this browser profile.', 'valid');
        showToast('Linear/Slack config saved.');
    };

    const loadLinearSlackConfig = async () => {
        const result = await chrome.storage.local.get([LINEAR_SLACK_CONFIG_KEY]);
        const config = result?.[LINEAR_SLACK_CONFIG_KEY];
        if (!config || typeof config !== 'object') {
            updateSlackModeVisibility();
            return;
        }

        if (linearApiKeyInput) linearApiKeyInput.value = trimField(config.linearApiKey, 300);
        if (linearTeamKeyInput) linearTeamKeyInput.value = trimField(config.linearTeamKey, 32);
        if (linearIssuePriorityInput) {
            const savedPriority = Number.parseInt(String(config.priority ?? 0), 10);
            linearIssuePriorityInput.value = String([0, 1, 2, 3, 4].includes(savedPriority) ? savedPriority : 0);
        }

        const slackConfig = config.slack && typeof config.slack === 'object' ? config.slack : {};
        if (slackDeliveryModeInput) {
            slackDeliveryModeInput.value = String(slackConfig.mode || 'bot').toLowerCase() === 'webhook' ? 'webhook' : 'bot';
        }
        if (slackBotTokenInput) slackBotTokenInput.value = trimField(slackConfig.botToken, 300);
        if (slackChannelIdInput) slackChannelIdInput.value = trimField(slackConfig.channelId, 64);
        if (slackWebhookUrlInput) slackWebhookUrlInput.value = trimField(slackConfig.webhookUrl, 600);

        updateSlackModeVisibility();
        setLinearSlackStatus('Saved config loaded. Issue title/description are not auto-saved.', 'neutral');
    };

    const clearLinearSlackConfig = async () => {
        await chrome.storage.local.remove([LINEAR_SLACK_CONFIG_KEY]);

        if (linearApiKeyInput) linearApiKeyInput.value = '';
        if (linearTeamKeyInput) linearTeamKeyInput.value = '';
        if (linearIssuePriorityInput) linearIssuePriorityInput.value = '0';
        if (slackBotTokenInput) slackBotTokenInput.value = '';
        if (slackChannelIdInput) slackChannelIdInput.value = '';
        if (slackWebhookUrlInput) slackWebhookUrlInput.value = '';
        if (slackDeliveryModeInput) slackDeliveryModeInput.value = 'bot';

        updateSlackModeVisibility();
        setLinearSlackStatus('Saved config cleared.', 'neutral');
        showToast('Saved config cleared.');
    };

    const createLinearIssueAndNotifySlack = async () => {
        const payload = getLinearSlackPayloadFromForm();
        const validationError = validateLinearSlackPayload(payload);
        if (validationError) {
            setLinearSlackStatus(validationError, 'invalid');
            showToast(validationError);
            return;
        }

        try {
            if (createLinearSlackIssueBtn) {
                createLinearSlackIssueBtn.disabled = true;
                createLinearSlackIssueBtn.textContent = 'Submitting…';
            }

            setLinearSlackStatus('Creating issue in Linear and sending Slack notification…', 'neutral');
            const response = await chrome.runtime.sendMessage({
                action: 'createLinearIssueAndNotifySlack',
                payload
            });

            if (response?.success && response?.issue?.identifier) {
                const issueId = trimField(response.issue.identifier, 64);
                const issueUrl = trimField(response.issue.url, 1000);
                setLinearSlackStatus(`Created ${issueId}\nSlack message sent successfully.`, 'valid');
                if (issueUrl) showToast(`Issue created: ${issueId}`);
                return;
            }

            if (response?.partial && response?.issue?.identifier) {
                const issueId = trimField(response.issue.identifier, 64);
                const reason = trimField(response.error, 220) || 'Slack notification failed.';
                setLinearSlackStatus(`Issue ${issueId} created.\nSlack failed: ${reason}`, 'invalid');
                showToast('Issue created, but Slack failed.');
                return;
            }

            const err = trimField(response?.error, 260) || 'Failed to create issue.';
            throw new Error(err);
        } catch (error) {
            const message = trimField(error?.message, 260) || 'Linear/Slack request failed.';
            setLinearSlackStatus(message, 'invalid');
            showToast(message);
        } finally {
            if (createLinearSlackIssueBtn) {
                createLinearSlackIssueBtn.disabled = false;
                createLinearSlackIssueBtn.textContent = 'Create + Post';
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
    slackDeliveryModeInput?.addEventListener('change', updateSlackModeVisibility);
    saveLinearSlackConfigBtn?.addEventListener('click', () => {
        saveLinearSlackConfig().catch(() => {
            setLinearSlackStatus('Could not save config.', 'invalid');
            showToast('Could not save config.');
        });
    });
    clearLinearSlackConfigBtn?.addEventListener('click', () => {
        clearLinearSlackConfig().catch(() => {
            setLinearSlackStatus('Could not clear saved config.', 'invalid');
            showToast('Could not clear saved config.');
        });
    });
    createLinearSlackIssueBtn?.addEventListener('click', () => {
        createLinearIssueAndNotifySlack().catch(() => {
            setLinearSlackStatus('Linear/Slack action failed.', 'invalid');
            showToast('Linear/Slack action failed.');
        });
    });
    triggerLinearBotJobsBtn?.addEventListener('click', () => {
        triggerLinearBotJobsRun().catch(() => {
            setLinearTriggerStatus('Could not trigger bot-jobs-linear run.', 'invalid');
            setLinearTriggerButtonState('idle');
            showToast('Could not trigger bot-jobs-linear run.');
        });
    });
    updateSlackModeVisibility();
    await loadLinearSlackConfig();
    await pollLinearTriggerStatus({ silent: true });

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
