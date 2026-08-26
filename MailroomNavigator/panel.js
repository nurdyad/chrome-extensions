// Main panel controller for all three views (Navigator, Job Panel, Others).
// This file wires DOM events to feature modules and background actions.
import { state, setCachedPractices } from './state.js';
import { hideStatus, showToast, describeExtensionError, openTabWithTimeout, extractNameFromEmail, copyTextToClipboard } from './utils.js';
import * as Navigator from './navigator.js';

let practiceCacheLoadPromise = null;
const PANEL_COLLAPSIBLE_SECTION_STATE_STORAGE_KEY = 'mailroomNavPanelSectionCollapseV1';
const PANEL_HOST_TAB_ID = (() => {
    try {
        const rawValue = new URLSearchParams(window.location.search).get('hostTabId');
        const parsed = Number.parseInt(String(rawValue || ''), 10);
        return Number.isFinite(parsed) ? parsed : null;
    } catch (error) {
        return null;
    }
})();
// Set when this panel is loaded inside one of the docked per-view sidebars
// (each view gets its own independent host-page toggle handle, see
// ensureSidebarPanelMounted in background.js) rather than the standalone
// popup window. Locks this instance to a single view and hides the
// in-panel tab switcher, since switching views means using a different
// docked handle instead.
const PANEL_FORCED_VIEW_ID = (() => {
    try {
        const rawValue = String(new URLSearchParams(window.location.search).get('view') || '').trim();
        const validViewIds = ['practiceNavigatorView', 'jobManagerView', 'emailFormatterView', 'bookmarkletToolsView'];
        return validViewIds.includes(rawValue) ? rawValue : null;
    } catch (error) {
        return null;
    }
})();
// Set alongside PANEL_FORCED_VIEW_ID when this docked panel is UUID
// Picker's own dedicated handle (it's used often enough on its own to
// warrant opening straight to it, unlike Custom Workflow/Docman
// Groups/Email Formatter, which share the "Bookmarklet Tools" handle and
// its launch grid). Triggers that tool's modal immediately.
const PANEL_FORCED_TOOL_ID = (() => {
    try {
        const rawValue = String(new URLSearchParams(window.location.search).get('tool') || '').trim();
        const validToolIds = ['uuidPicker'];
        return validToolIds.includes(rawValue) ? rawValue : null;
    } catch (error) {
        return null;
    }
})();

const DEFAULT_TRIGGER_SERVER_BASE_URL = 'http://127.0.0.1:4817';
const TRIGGER_SERVER_BASE_URL_STORAGE_KEY = 'mailroomNavigatorTriggerServerBaseUrl';
// Kept in sync with background.js's own copy of this lookup - both read the
// same chrome.storage.local key. Cached here (rather than re-read on every
// UUID lookup) and refreshed on load and right after a successful save from
// the settings field, since this direct fetch to the trigger server bypasses
// background.js's message-passing layer entirely.
let triggerServerBaseUrl = DEFAULT_TRIGGER_SERVER_BASE_URL;

async function refreshTriggerServerBaseUrl() {
    try {
        const result = await chrome.storage.local.get(TRIGGER_SERVER_BASE_URL_STORAGE_KEY);
        const stored = String(result?.[TRIGGER_SERVER_BASE_URL_STORAGE_KEY] || '').trim();
        triggerServerBaseUrl = stored || DEFAULT_TRIGGER_SERVER_BASE_URL;
    } catch (error) {
        triggerServerBaseUrl = DEFAULT_TRIGGER_SERVER_BASE_URL;
    }
    return triggerServerBaseUrl;
}

const TRIGGER_SERVER_SECRET_STORAGE_KEY = 'mailroomNavigatorTriggerServerSecret';
const TRIGGER_SECRET_HEADER_NAME = 'X-MailroomNav-Trigger-Secret';
// Paired with the server-side shared-secret check - this direct fetch
// bypasses background.js's own header-attaching logic entirely, so it needs
// its own copy of the secret too.
let triggerServerSecret = '';

async function refreshTriggerServerSecret() {
    try {
        const result = await chrome.storage.local.get(TRIGGER_SERVER_SECRET_STORAGE_KEY);
        triggerServerSecret = String(result?.[TRIGGER_SERVER_SECRET_STORAGE_KEY] || '').trim();
    } catch (error) {
        triggerServerSecret = '';
    }
    return triggerServerSecret;
}

const UUID_LOOKUP_REQUEST_TIMEOUT_MS = 26000;
const UUID_LOOKUP_LOADING_DELAY_MS = 120;
const DOCKED_PANEL_TITLES = {
    practiceNavigatorView: 'Practice Navigator',
    jobManagerView: 'Job Panel',
    emailFormatterView: 'Others',
    bookmarkletToolsView: 'Bookmarklet Tools'
};
const DOCKED_TOOL_TITLES = {
    uuidPicker: 'UUID Picker'
};

function getProtectedActionPayload(extraPayload = {}) {
    return typeof PANEL_HOST_TAB_ID === 'number'
        ? { ...extraPayload, preferredTabId: PANEL_HOST_TAB_ID }
        : { ...extraPayload };
}

async function syncPracticeCache({ forceRefresh = false, allowScrape = true } = {}) {
    if (practiceCacheLoadPromise) return practiceCacheLoadPromise;

    const hasCache = Object.keys(state.cachedPractices || {}).length > 0;
    if (hasCache && !forceRefresh) return state.cachedPractices;

    practiceCacheLoadPromise = (async () => {
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        try {
            // Fast path: load currently available cache first (usually from storage/background memory)
            let response = await chrome.runtime.sendMessage({
                action: 'getPracticeCache',
                ...getProtectedActionPayload()
            });
            if (response && response.practiceCache && Object.keys(response.practiceCache).length > 0) {
                setCachedPractices(response.practiceCache);
                if (!forceRefresh || !allowScrape) return response.practiceCache;
            }

            if (!allowScrape) return state.cachedPractices;

            // Refresh path: explicit refresh or empty cache fallback
            await chrome.runtime.sendMessage({
                action: 'requestActiveScrape',
                ...getProtectedActionPayload()
            });
            for (let attempt = 0; attempt < 6; attempt += 1) {
                response = await chrome.runtime.sendMessage({
                    action: 'getPracticeCache',
                    ...getProtectedActionPayload()
                });
                if (response && response.practiceCache && Object.keys(response.practiceCache).length > 0) {
                    setCachedPractices(response.practiceCache);
                    return response.practiceCache;
                }
                if (attempt < 5) await wait(220);
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


// --- 1. Global View Switcher ---
function showView(viewId) {
    const resolvedViewId = viewId;
    ['practiceNavigatorView', 'jobManagerView', 'emailFormatterView', 'bookmarkletToolsView'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = (resolvedViewId && id === resolvedViewId) ? 'block' : 'none';
    });

    const navIds = {
        'practiceNavigatorView': 'navigatorGlobalToggleBtn',
        'jobManagerView': 'jobManagerGlobalToggleBtn',
        'emailFormatterView': 'emailFormatterGlobalToggleBtn',
        'bookmarkletToolsView': 'bookmarkletToolsGlobalToggleBtn'
    };
    
    Object.values(navIds).forEach(btnId => {
        const btn = document.getElementById(btnId);
        if (btn) btn.classList.remove('active-tab');
    });
    const activeBtn = document.getElementById(navIds[resolvedViewId]);
    if (activeBtn) activeBtn.classList.add('active-tab');
}

function setupDockedPanelHeader() {
    const header = document.getElementById('dockedPanelHeader');
    const titleEl = document.getElementById('dockedPanelTitle');
    if (!header || !PANEL_FORCED_VIEW_ID) return;

    const title = DOCKED_TOOL_TITLES[PANEL_FORCED_TOOL_ID] || DOCKED_PANEL_TITLES[PANEL_FORCED_VIEW_ID] || 'Mailroom Navigator';
    if (titleEl) titleEl.textContent = title;
    header.hidden = false;
}

function setElementVisible(elementOrId, shouldShow, displayValue = '') {
    const element = typeof elementOrId === 'string' ? document.getElementById(elementOrId) : elementOrId;
    if (!element) return;
    element.style.display = shouldShow ? displayValue : 'none';
}

async function fetchServerlessLiteMode() {
    try {
        const response = await chrome.runtime.sendMessage({ action: 'getServerlessLiteMode' });
        return Boolean(response?.success && response.serverlessLiteMode);
    } catch (error) {
        return false;
    }
}

// Serverless Lite mode has no local trigger server to actually fire Linear/
// Slack actions from, so those controls would just fail if shown - swap
// them for a generate-the-draft-and-copy-it-manually flow instead. This is
// a deployment-topology switch, not permission gating.
function applyServerlessLiteModeToUi(isServerlessLiteMode) {
    setElementVisible('linearServerlessLiteNotice', isServerlessLiteMode);
    setElementVisible('linearSlackControls', !isServerlessLiteMode);
    setElementVisible('createLinearSlackIssueBtn', !isServerlessLiteMode, '');
    setElementVisible('triggerLinearBotJobsBtn', !isServerlessLiteMode, '');
    setElementVisible('triggerLinearDryRunLabel', !isServerlessLiteMode, 'flex');
    setElementVisible('reconcileLinearControls', !isServerlessLiteMode);
    setElementVisible('reconcileLinearDryRunLabel', !isServerlessLiteMode, 'flex');
    setElementVisible('linearServiceControls', !isServerlessLiteMode);
    setElementVisible('linearActionButtonsRow', !isServerlessLiteMode, 'grid');
    setElementVisible('linearDraftCopyButtonsRow', isServerlessLiteMode);

    const linearIssueSectionSubtitle = document.getElementById('linearIssueSectionSubtitle');
    if (linearIssueSectionSubtitle) {
        linearIssueSectionSubtitle.textContent = isServerlessLiteMode
            ? 'Generate draft details and copy them into Linear manually.'
            : 'Create issues, trigger runs, and Slack updates.';
    }
    const linearSlackStatus = document.getElementById('linearSlackStatus');
    if (linearSlackStatus && linearSlackStatus.dataset.mode !== (isServerlessLiteMode ? 'serverless-lite' : 'full')) {
        linearSlackStatus.dataset.mode = isServerlessLiteMode ? 'serverless-lite' : 'full';
        linearSlackStatus.classList.remove('valid', 'invalid');
        linearSlackStatus.classList.add('neutral');
        linearSlackStatus.textContent = isServerlessLiteMode
            ? 'Paste a Document ID and click Generate Details. Then copy the title and description into Linear manually.'
            : 'Paste a Document ID and click Generate Details.';
    }
}

async function loadPanelCollapsibleSectionState() {
    try {
        const result = await chrome.storage.local.get([PANEL_COLLAPSIBLE_SECTION_STATE_STORAGE_KEY]);
        return result?.[PANEL_COLLAPSIBLE_SECTION_STATE_STORAGE_KEY] && typeof result[PANEL_COLLAPSIBLE_SECTION_STATE_STORAGE_KEY] === 'object'
            ? result[PANEL_COLLAPSIBLE_SECTION_STATE_STORAGE_KEY]
            : {};
    } catch {
        return {};
    }
}

async function savePanelCollapsibleSectionState(state) {
    try {
        await chrome.storage.local.set({
            [PANEL_COLLAPSIBLE_SECTION_STATE_STORAGE_KEY]: state && typeof state === 'object' ? state : {}
        });
    } catch {
        // Collapse state is only UI polish; ignore persistence failures.
    }
}

function applyCollapsibleSectionUi(section, body, toggleButton, collapsed) {
    if (!section || !body || !toggleButton) return;
    section.classList.toggle('is-collapsed', Boolean(collapsed));
    toggleButton.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    body.style.display = collapsed ? 'none' : '';
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

function extractUuid(value) {
    const raw = String(value || '')
        .trim()
        .replace(/(?:…|\.\.\.)$/u, '')
        .trim();
    if (!raw) return '';

    const fullUuidMatch = raw.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i);
    if (fullUuidMatch) return fullUuidMatch[0].toLowerCase();

    const partialMatch = raw.match(/[0-9a-f-]{6,80}/i);
    const partial = String(partialMatch?.[0] || '')
        .trim()
        .replace(/^-+|-+$/g, '')
        .toLowerCase();
    return /^[0-9a-f-]{6,80}$/.test(partial) ? partial : '';
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

function truncateMiddleText(value, lead = 12, tail = 10) {
    const clean = collapseText(value);
    if (!clean) return '';
    if (clean.length <= (lead + tail + 1)) return clean;
    return `${clean.slice(0, Math.max(0, lead))}…${clean.slice(Math.max(0, clean.length - tail))}`;
}

function formatLookupDisplayValue(value) {
    const clean = collapseText(value).replace(/[_-]+/g, ' ');
    if (!clean) return '';
    return clean.replace(/\b([a-z])/g, (match, char) => char.toUpperCase());
}

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
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
        showToast(describeExtensionError(error, 'Failed to open one or more pages.'));
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

    copyTextToClipboard(cleanUrls.join('\n'))
        .then((copied) => {
            if (copied) {
                showToast(`${cleanUrls.length} ${label} copied.`);
                return;
            }
            showToast('Copy failed.');
        })
        .catch(() => showToast('Copy failed.'));
}

// --- 2. Global Hide Suggestions ---
function hideSuggestions() {
    setTimeout(() => {
        const ids = [
            'suggestions',
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
let panelInitializationStarted = false;

async function initializePanel() {
    if (panelInitializationStarted) return;
    panelInitializationStarted = true;
    try {
    await refreshTriggerServerBaseUrl();
    await refreshTriggerServerSecret();
    if (PANEL_FORCED_VIEW_ID) {
        document.body.classList.add('bl-panel-single-view');
    }
    if (PANEL_FORCED_TOOL_ID) {
        document.body.classList.add('bl-panel-single-tool');
    }
    // The shared "Bookmarklet Tools" docked handle (no specific tool
    // forced) shows Custom Workflow/Docman Groups/Email Formatter inline
    // together instead of behind a launch-grid click - see the eager-load
    // trigger further down and bl-panel-bookmarklet-suite in panel.html.
    const isBookmarkletToolsSuite = PANEL_FORCED_VIEW_ID === 'bookmarkletToolsView' && !PANEL_FORCED_TOOL_ID;
    if (isBookmarkletToolsSuite) {
        document.body.classList.add('bl-panel-bookmarklet-suite');
    }
    setupDockedPanelHeader();

    // Serverless Lite is a deployment-mode switch (no local trigger server
    // available on this machine/network), not a permission concept - it's
    // unrelated to who's using the extension. Resolved once here and reused
    // below wherever Linear/Slack UI needs to pick "fire it from here" vs.
    // "generate and copy into Linear manually".
    const isServerlessLiteMode = await fetchServerlessLiteMode();
    applyServerlessLiteModeToUi(isServerlessLiteMode);

    // A. Visual Cleanup
    Navigator.cleanDuplicateButtons();
    await Navigator.initializeRecentPractices();

    setupCompactModeToggle();
    setupDarkModeToggle();
    if (window.top === window && await loadCompactModePreference()) {
        enterCompactMode();
    } else {
        resizeToFitContent();
    }

    const linearIssueSection = document.getElementById('linearIssueSection');
    const linearIssueSectionBody = document.getElementById('linearIssueSectionBody');
    const linearIssueSectionToggle = document.getElementById('linearIssueSectionToggle');
    const bulkIdActionsSection = document.getElementById('bulkIdActionsSection');
    const bulkIdActionsSectionBody = document.getElementById('bulkIdActionsSectionBody');
    const bulkIdActionsSectionToggle = document.getElementById('bulkIdActionsSectionToggle');
    const recentIdsSection = document.getElementById('recentIdsSection');
    const recentIdsSectionBody = document.getElementById('recentIdsSectionBody');
    const recentIdsSectionToggle = document.getElementById('recentIdsSectionToggle');

    let collapsibleSectionState = await loadPanelCollapsibleSectionState();

    const setCollapsibleSectionCollapsed = (sectionKey, collapsed, { persist = true } = {}) => {
        collapsibleSectionState = {
            ...collapsibleSectionState,
            [sectionKey]: Boolean(collapsed)
        };
        if (sectionKey === 'linearIssueSection') {
            applyCollapsibleSectionUi(linearIssueSection, linearIssueSectionBody, linearIssueSectionToggle, collapsed);
        }
        if (sectionKey === 'bulkIdActionsSection') {
            applyCollapsibleSectionUi(bulkIdActionsSection, bulkIdActionsSectionBody, bulkIdActionsSectionToggle, collapsed);
        }
        if (sectionKey === 'recentIdsSection') {
            applyCollapsibleSectionUi(recentIdsSection, recentIdsSectionBody, recentIdsSectionToggle, collapsed);
        }
        if (persist) savePanelCollapsibleSectionState(collapsibleSectionState).catch(() => undefined);
    };

    linearIssueSectionToggle?.addEventListener('click', () => {
        setCollapsibleSectionCollapsed(
            'linearIssueSection',
            !Boolean(collapsibleSectionState?.linearIssueSection)
        );
    });
    bulkIdActionsSectionToggle?.addEventListener('click', () => {
        setCollapsibleSectionCollapsed(
            'bulkIdActionsSection',
            !Boolean(collapsibleSectionState?.bulkIdActionsSection)
        );
    });
    recentIdsSectionToggle?.addEventListener('click', () => {
        setCollapsibleSectionCollapsed(
            'recentIdsSection',
            !Boolean(collapsibleSectionState?.recentIdsSection)
        );
    });

    setCollapsibleSectionCollapsed('linearIssueSection', Boolean(collapsibleSectionState?.linearIssueSection), { persist: false });
    setCollapsibleSectionCollapsed(
        'bulkIdActionsSection',
        collapsibleSectionState?.bulkIdActionsSection === undefined ? true : Boolean(collapsibleSectionState.bulkIdActionsSection),
        { persist: false }
    );
    setCollapsibleSectionCollapsed(
        'recentIdsSection',
        collapsibleSectionState?.recentIdsSection === undefined ? true : Boolean(collapsibleSectionState.recentIdsSection),
        { persist: false }
    );

    // C. Setup Navigation Tabs
    document.getElementById("navigatorGlobalToggleBtn")?.addEventListener("click", () => showView('practiceNavigatorView'));
    document.getElementById("jobManagerGlobalToggleBtn")?.addEventListener("click", () => showView('jobManagerView'));
    document.getElementById("emailFormatterGlobalToggleBtn")?.addEventListener("click", () => showView('emailFormatterView'));
    document.getElementById("bookmarkletToolsGlobalToggleBtn")?.addEventListener("click", () => showView('bookmarkletToolsView'));

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
                Navigator.initializeRecentPractices().catch(() => undefined);
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
        pInput.addEventListener('click', () => {
            // 'focus' only fires on an actual focus change, so a direct click
            // while the input is already focused (e.g. right after Reset,
            // which re-focuses the input) would never re-show suggestions
            // otherwise. Handle that case here, independent of focus timing.
            Navigator.handleNavigatorInput({ showOnEmpty: true });
            warmPracticeCache(true);
        });
    }

    warmPracticeCache(false);
    
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
        Navigator.clearSelectedPractice();
        hideStatus();
        showToast('Settings reset.');
        if (pInput) {
            pInput.value = '';
            // Only clear and refocus here; the suggestion list should stay
            // closed until the user deliberately clicks the input again
            // (handled by the input's own 'click' listener below).
            pInput.focus();
        }
    });
    
    // E. Global URL Opening Helper
    const getSelectedPracticeScope = () => {
        const selectedPracticeCode = String(state.currentSelectedOdsCode || '').trim().toUpperCase();
        return {
            selectedPracticeCode,
            hasPracticeFilter: /^[A-Z]\d{5}$/.test(selectedPracticeCode),
            isAllPractices: selectedPracticeCode === 'ALL'
        };
    };

    const openUrl = (suffix, { allowAllPractices = false } = {}) => {
        try {
            const { selectedPracticeCode, hasPracticeFilter, isAllPractices } = getSelectedPracticeScope();
            if (!hasPracticeFilter && !(allowAllPractices && isAllPractices)) {
                throw new Error('Select a practice or choose All practices first.');
            }

            let url = `https://app.betterletter.ai/`;
            if (suffix === 'dashboard') {
                url = `https://app.betterletter.ai/admin_panel/bots/dashboard?job_types=docman_import+emis_prepare&status=paused`;
                if (hasPracticeFilter) url += `&practice_ids=${encodeURIComponent(selectedPracticeCode)}`;
            } else if (suffix === 'preparing') {
                url = `https://app.betterletter.ai/mailroom/preparing?only_action_items=true&service=self&sort=upload_date&sort_dir=asc&urgent=false`;
                if (hasPracticeFilter) url += `&practice=${encodeURIComponent(selectedPracticeCode)}`;
            } else if (suffix === 'rejected') {
                url = `https://app.betterletter.ai/mailroom/rejected?service=full&show_processed=false&sort=inserted_at&sort_dir=asc`;
                if (hasPracticeFilter) url += `&practice=${encodeURIComponent(selectedPracticeCode)}`;
            } else if (suffix === 'users') {
                const ods = Navigator.requireSelectedOdsCode();
                url = `https://app.betterletter.ai/mailroom/practices/${ods}/users`;
            }
            openTabWithTimeout(url);
        } catch (e) { showToast(e.message); }
    };

    document.getElementById('collectionBtn')?.addEventListener('click', () => openUrl('dashboard', { allowAllPractices: true }));
    document.getElementById('usersBtn')?.addEventListener('click', () => openUrl('users'));
    document.getElementById('preparingBtn')?.addEventListener('click', () => openUrl('preparing', { allowAllPractices: true }));
    document.getElementById('rejectedBtn')?.addEventListener('click', () => openUrl('rejected', { allowAllPractices: true }));

    // Compact mode's utility-bar shortcuts - kept as separate always-enabled
    // buttons (rather than proxying a click to #preparingBtn/#collectionBtn)
    // since those get disabled until a practice or "All practices" is
    // selected, and a disabled button can't be clicked programmatically
    // either. Preparing still goes through openUrl for its practice-scoped
    // filtering and "select a practice first" guard; the dashboard shortcut
    // is deliberately the plain, unfiltered dashboard, not Collection's
    // docman_import+emis_prepare/paused filter, so it opens directly.
    document.getElementById('compactBotDashboardLinkBtn')?.addEventListener('click', () => {
        openTabWithTimeout('https://app.betterletter.ai/admin_panel/bots/dashboard');
    });
    document.getElementById('compactPreparingLinkBtn')?.addEventListener('click', () => openUrl('preparing', { allowAllPractices: true }));

    // F. EHR & Task Settings
    document.getElementById('taskRecipientsBtn')?.addEventListener('click', async () => {
        try {
            const ods = Navigator.requireSelectedOdsCode();
            await chrome.runtime.sendMessage({
                action: 'openPractice',
                input: ods,
                settingType: 'task_recipients',
                ...getProtectedActionPayload()
            });
        } catch (err) { showToast(describeExtensionError(err)); }
    });

    document.getElementById('openEhrSettingsBtn')?.addEventListener('click', async () => {
        try {
            const ods = Navigator.requireSelectedOdsCode();
            await chrome.runtime.sendMessage({
                action: 'openPractice',
                input: ods,
                settingType: 'ehr_settings',
                ...getProtectedActionPayload()
            });
        } catch (e) { showToast(e.message); }
    });

    // Job Dashboard Filters (checkbox multi-select)
    const botJobsChecklistNav = document.getElementById('botJobsChecklistNav');
    const clearBotJobsNavBtn = document.getElementById('clearBotJobsNavBtn');
    const openBotJobsNavBtn = document.getElementById('openBotJobsNavBtn');

    const getSelectedJobTypes = (checklistEl) => {
        if (!checklistEl) return [];
        return Array.from(checklistEl.querySelectorAll('input[type="checkbox"]:checked:not([data-select-all])'))
            .map(input => String(input?.value || '').trim())
            .filter(Boolean);
    };

    const buildJobsDashboardUrl = (jobTypes, odsCode = '') => {
        const encodedTypes = jobTypes.map(jobType => encodeURIComponent(jobType)).join('+');
        const encodedOds = odsCode ? `&practice_ids=${encodeURIComponent(odsCode)}` : '';
        return `https://app.betterletter.ai/admin_panel/bots/dashboard?job_types=${encodedTypes}${encodedOds}&status=paused`;
    };

    const openJobTypesDashboard = (jobTypes, groupLabel) => {
        const selectedJobTypes = Array.isArray(jobTypes) ? jobTypes.filter(Boolean) : [];
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

    const openMultiJobDashboard = (checklistEl, groupLabel) => {
        openJobTypesDashboard(getSelectedJobTypes(checklistEl), groupLabel);
    };

    const syncChecklistSelectionUi = (checklistEl, actionButton, groupLabel, selectionBadge = null, clearButton = null) => {
        if (!checklistEl) return;
        const selectAllInput = checklistEl.querySelector('input[data-select-all="true"]');
        const jobInputs = Array.from(checklistEl.querySelectorAll('input[type="checkbox"]:not([data-select-all])'));
        if (!jobInputs.length) return;

        const getAllJobTypes = () => jobInputs
            .map((input) => String(input?.value || '').trim())
            .filter(Boolean);

        const refresh = () => {
            const checkedCount = jobInputs.filter((input) => input.checked).length;
            if (selectAllInput) {
                selectAllInput.checked = checkedCount === jobInputs.length;
                selectAllInput.indeterminate = checkedCount > 0 && checkedCount < jobInputs.length;
            }

            checklistEl.querySelectorAll('.job-check-item').forEach((item) => {
                const input = item.querySelector('input[type="checkbox"]');
                const isSelectAllItem = input === selectAllInput;
                const isSelected = isSelectAllItem
                    ? Boolean(selectAllInput?.checked)
                    : Boolean(input?.checked);
                item.classList.toggle('is-selected', isSelected);
            });

            if (actionButton) {
                let buttonLabel = 'Open';
                let buttonTitle = `Open selected ${groupLabel} jobs`;
                const isSingleJobChecklist = jobInputs.length === 1;

                if (isSingleJobChecklist && checkedCount === 1) {
                    buttonLabel = 'Open';
                    buttonTitle = `Open ${groupLabel} job`;
                } else if (checkedCount === jobInputs.length) {
                    buttonLabel = 'Open all';
                    buttonTitle = `Open all ${groupLabel} jobs`;
                } else if (checkedCount > 0) {
                    buttonLabel = `Open ${checkedCount}`;
                    buttonTitle = `Open ${checkedCount} selected ${groupLabel} job${checkedCount === 1 ? '' : 's'}`;
                }

                actionButton.textContent = buttonLabel;
                actionButton.title = buttonTitle;
                actionButton.setAttribute('aria-label', buttonTitle);
            }

            if (clearButton) {
                const hasSelection = checkedCount > 0;
                clearButton.disabled = !hasSelection;
                clearButton.title = hasSelection ? `Clear ${checkedCount} selected ${groupLabel} job${checkedCount === 1 ? '' : 's'}` : `Clear selected ${groupLabel} jobs`;
                clearButton.setAttribute('aria-label', clearButton.title);
            }

            if (selectionBadge) {
                if (checkedCount > 0) {
                    selectionBadge.hidden = false;
                    selectionBadge.textContent = String(checkedCount);
                    selectionBadge.classList.add('has-selection');
                    selectionBadge.setAttribute('aria-label', `${checkedCount} ${groupLabel} jobs selected`);
                } else {
                    selectionBadge.hidden = true;
                    selectionBadge.textContent = '';
                    selectionBadge.classList.remove('has-selection');
                    selectionBadge.removeAttribute('aria-label');
                }
            }
        };

        const clearSelections = () => {
            jobInputs.forEach((input) => {
                input.checked = false;
            });
            if (selectAllInput) {
                selectAllInput.checked = false;
                selectAllInput.indeterminate = false;
            }
            refresh();
        };

        selectAllInput?.addEventListener('change', () => {
            jobInputs.forEach((input) => {
                input.checked = Boolean(selectAllInput.checked);
            });
            refresh();
        });

        jobInputs.forEach((input) => {
            input.addEventListener('change', refresh);
        });

        checklistEl.querySelectorAll('.job-check-item').forEach((item) => {
            const input = item.querySelector('input[type="checkbox"]');
            if (!input) return;

            let clickTimer = null;

            item.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();

                if (event.detail > 1) return;

                clickTimer = window.setTimeout(() => {
                    if (input === selectAllInput) {
                        const shouldCheckAll = !Boolean(selectAllInput?.checked);
                        jobInputs.forEach((jobInput) => {
                            jobInput.checked = shouldCheckAll;
                        });
                        if (selectAllInput) {
                            selectAllInput.checked = shouldCheckAll;
                            selectAllInput.indeterminate = false;
                        }
                    } else {
                        input.checked = !input.checked;
                    }
                    refresh();
                    clickTimer = null;
                }, 180);
            });

            item.addEventListener('dblclick', (event) => {
                event.preventDefault();
                event.stopPropagation();

                if (clickTimer) {
                    window.clearTimeout(clickTimer);
                    clickTimer = null;
                }

                const jobTypes = input === selectAllInput
                    ? getAllJobTypes()
                    : [String(input?.value || '').trim()].filter(Boolean);

                openJobTypesDashboard(jobTypes, groupLabel);
            });
        });

        clearButton?.addEventListener('click', () => {
            clearSelections();
        });

        refresh();
    };

    openBotJobsNavBtn?.addEventListener('click', () => openMultiJobDashboard(botJobsChecklistNav, 'Bot'));
    syncChecklistSelectionUi(botJobsChecklistNav, openBotJobsNavBtn, 'Bot', null, clearBotJobsNavBtn);

    // K. JOB PANEL QUICK ACTIONS
    const manualDocIdInput = document.getElementById('manualDocId');
    const jobStatusInput = document.getElementById('jobStatusInput');
    const uuidLookupInput = document.getElementById('uuidLookupInput');
    const bulkIdsInput = document.getElementById('bulkIdsInput');
    const bulkActionType = document.getElementById('bulkActionType');

    const manualDocValidation = document.getElementById('manualDocValidation');
    const jobStatusValidation = document.getElementById('jobStatusValidation');
    const uuidLookupStatus = document.getElementById('uuidLookupStatus');
    const uuidBatchResultsSection = document.getElementById('uuidBatchResultsSection');
    const uuidBatchResultsTitle = document.getElementById('uuidBatchResultsTitle');
    const uuidBatchResultsClearBtn = document.getElementById('uuidBatchResultsClearBtn');
    const uuidBatchResultsList = document.getElementById('uuidBatchResultsList');
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

    const docmanToolStatus = document.getElementById('docmanToolStatus');
    const runUuidPickerToolBtn = document.getElementById('runUuidPickerToolBtn');
    const runListDocmanGroupsToolBtn = document.getElementById('runListDocmanGroupsToolBtn');
    const runEmailFormatterToolBtn = document.getElementById('runEmailFormatterToolBtn');
    const runWorkflowGroupsToolBtn = document.getElementById('runWorkflowGroupsToolBtn');
    const bookmarkletToolModal = document.getElementById('bookmarkletToolModal');
    const bookmarkletToolModalTitle = document.getElementById('bookmarkletToolModalTitle');
    const bookmarkletToolModalActions = document.getElementById('bookmarkletToolModalActions');
    const bookmarkletToolModalBody = document.getElementById('bookmarkletToolModalBody');
    const bookmarkletToolModalCloseBtn = document.getElementById('bookmarkletToolModalCloseBtn');
    let bookmarkletToolModalReturnFocusEl = null;
    let bookmarkletToolModalCleanup = null;

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
    const restartLinearTriggerServerBtn = document.getElementById('restartLinearTriggerServerBtn');
    const triggerServerBaseUrlInput = document.getElementById('triggerServerBaseUrlInput');
    const saveTriggerServerBaseUrlBtn = document.getElementById('saveTriggerServerBaseUrlBtn');
    const triggerServerBaseUrlStatus = document.getElementById('triggerServerBaseUrlStatus');
    const triggerServerSecretRow = document.getElementById('triggerServerSecretRow');
    const triggerServerSecretInput = document.getElementById('triggerServerSecretInput');
    const saveTriggerServerSecretBtn = document.getElementById('saveTriggerServerSecretBtn');
    const clearTriggerServerSecretBtn = document.getElementById('clearTriggerServerSecretBtn');
    const triggerServerSecretStatus = document.getElementById('triggerServerSecretStatus');
    const triggerLinearDryRunInput = document.getElementById('triggerLinearDryRunInput');
    const reconcileLinearDryRunInput = document.getElementById('reconcileLinearDryRunInput');
    const linearTriggerStatus = document.getElementById('linearTriggerStatus');
    const linearDraftCopyButtonsRow = document.getElementById('linearDraftCopyButtonsRow');
    const copyLinearIssueTitleBtn = document.getElementById('copyLinearIssueTitleBtn');
    const copyLinearIssueDescriptionBtn = document.getElementById('copyLinearIssueDescriptionBtn');

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
    // Keep Slack target suggestions warm without blocking panel startup.
    const LINEAR_SLACK_TARGET_CACHE_STALE_MS = 30 * 60 * 1000;
    // Poll faster so the terminal state appears quickly enough for the 2-second
    // confirmation window before the trigger server posts the Slack summary.
    const LINEAR_TRIGGER_STATUS_POLL_INTERVAL_MS = 1000;
    const LINEAR_TRIGGER_STATUS_POLL_WINDOW_MS = 4 * 60 * 1000;
    const LINEAR_TRIGGER_RESTART_WAIT_INTERVAL_MS = 900;
    const LINEAR_TRIGGER_RESTART_WAIT_ATTEMPTS = 12;
    // Keep this aligned with the trigger-server Slack delay so the operator sees the
    // terminal run state in-panel before the summary is pushed to Slack.
    const LINEAR_TRIGGER_STATUS_AUTO_CLEAR_MS = 2000;
    const DOCMAN_TOOL_STATUS_POLL_INTERVAL_MS = 1500;
    const DOCMAN_TOOL_STATUS_POLL_WINDOW_MS = 45 * 60 * 1000;
    let docmanToolStatusPollTimer = null;
    let docmanToolStatusPollDeadlineMs = 0;
    let docmanToolRunIsBusy = false;
    let linearTriggerStatusPollTimer = null;
    let linearTriggerStatusPollDeadlineMs = 0;
    let linearTriggerStatusClearTimer = null;
    let dismissedLinearTriggerRunId = '';
    let linearIssueContext = null;
    let linearSlackTargetsCache = { channels: [], users: [], syncedAt: '' };
    let linearSlackTargetSyncPromise = null;
    const uuidLookupCache = new Map();
    const UUID_LOOKUP_CACHE_TTL_MS = 15 * 60 * 1000;

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

    const setUuidLookupStatusFor = (statusEl, message, tone = 'neutral') => {
        if (!statusEl) return;
        statusEl.classList.remove('neutral', 'valid', 'invalid');
        statusEl.classList.add(['neutral', 'valid', 'invalid'].includes(tone) ? tone : 'neutral');
        statusEl.classList.remove('uuid-lookup-status', 'uuid-lookup-card-host');
        statusEl.textContent = String(message || '').trim() || 'Paste a UUID or UUID fragment to check status.';
    };

    const setUuidLookupStatus = (message, tone = 'neutral') => {
        setUuidLookupStatusFor(uuidLookupStatus, message, tone);
    };

    const pruneUuidLookupCache = () => {
        const now = Date.now();
        uuidLookupCache.forEach((entry, key) => {
            if (!entry || (now - Number(entry.cachedAt || 0)) > UUID_LOOKUP_CACHE_TTL_MS) {
                uuidLookupCache.delete(key);
            }
        });
    };

    const getCachedUuidLookup = (uuid) => {
        pruneUuidLookupCache();
        const key = String(uuid || '').trim().toLowerCase();
        if (!key) return null;
        const entry = uuidLookupCache.get(key);
        if (!entry) return null;
        return entry.result || null;
    };

    const rememberUuidLookup = (uuid, result) => {
        const key = String(uuid || '').trim().toLowerCase();
        if (!key || !result || typeof result !== 'object') return;
        uuidLookupCache.set(key, {
            cachedAt: Date.now(),
            result
        });
    };

    const buildUuidLookupUrl = (uuid) => {
        return `${triggerServerBaseUrl}/uuid-status?uuid=${encodeURIComponent(uuid)}`;
    };

    const normalizeUuidLookupError = (message, status = 0) => {
        const normalized = collapseText(message);
        if (status === 404 || normalized.toLowerCase() === 'not found.') {
            return 'Local trigger service is running an older version. Restart install-linear-trigger-launchagent.sh (or restart node linear-trigger-server.mjs).';
        }
        if (normalized) return normalized;
        return status ? `Trigger service failed with status ${status}.` : 'UUID lookup failed.';
    };

    const fetchUuidLookupDirect = async (uuid, { signal } = {}) => {
        const headers = triggerServerSecret ? { [TRIGGER_SECRET_HEADER_NAME]: triggerServerSecret } : undefined;
        const response = await fetch(buildUuidLookupUrl(uuid), {
            method: 'GET',
            cache: 'no-store',
            headers,
            signal
        });
        const rawBody = await response.text();
        let payload = null;
        try {
            payload = rawBody ? JSON.parse(rawBody) : null;
        } catch (error) {
            payload = null;
        }

        if (!response.ok || !payload?.ok) {
            throw new Error(normalizeUuidLookupError(payload?.error || rawBody, response.status));
        }

        return payload.lookup || {};
    };

    const fetchUuidLookupViaBackground = async (uuid) => {
        const response = await chrome.runtime.sendMessage({
            action: 'lookupUuidStatus',
            payload: { uuid },
            ...getProtectedActionPayload()
        });

        if (!response?.success) {
            throw new Error(String(response?.error || 'UUID lookup failed.').trim());
        }

        return response.result || {};
    };

    const fetchUuidLookup = async (uuid, { signal } = {}) => {
        try {
            return await fetchUuidLookupDirect(uuid, { signal });
        } catch (error) {
            if (signal?.aborted || error?.name === 'AbortError') {
                throw error;
            }
            const message = collapseText(error?.message || '');
            if (!(error instanceof TypeError) && !/failed to fetch|networkerror|load failed/i.test(message)) {
                throw error;
            }
            return fetchUuidLookupViaBackground(uuid);
        }
    };

    let uuidLookupWarmPromise = null;
    const warmUuidLookupConnection = async () => {
        if (uuidLookupWarmPromise) return uuidLookupWarmPromise;
        uuidLookupWarmPromise = fetch(`${triggerServerBaseUrl}/health`, {
            method: 'GET',
            cache: 'no-store'
        }).catch(() => null).finally(() => {
            uuidLookupWarmPromise = null;
        });
        return uuidLookupWarmPromise;
    };

    const buildUuidLookupCardHtml = (result = {}, { loading = false, fallbackUuid = '' } = {}) => {
        const uuid = collapseText(result.uuid || fallbackUuid || '');
        const documentId = collapseText(result.documentId || '');
        const botJobId = collapseText(result.botJobId || '');
        const botJobType = collapseText(result.botJobType || '');
        const botJobStatus = collapseText(result.botJobStatus || '');
        const botJobStatusReason = collapseText(result.botJobStatusReason || '');
        const documentStatus = collapseText(result.status || botJobStatus || '');
        const documentLink = collapseText(result.documentLink || '');
        const rejectionReason = collapseText(result.rejectionReason || '');
        const displayTitle = documentId
            ? `Document ${documentId}`
            : botJobId
                ? `Bot job ${formatLookupDisplayValue(botJobType) || truncateMiddleText(botJobId, 10, 8)}`
                : (loading ? 'Looking up UUID' : 'Lookup status');
        const displaySubtitle = uuid ? truncateMiddleText(uuid, 14, 10) : 'UUID lookup';
        const normalizedStatus = documentStatus.toLowerCase();
        const prettyStatus = formatLookupDisplayValue(documentStatus) || 'Unknown';
        const reasonValue = rejectionReason || (!documentId ? botJobStatusReason : '');
        const prettyReason = formatLookupDisplayValue(reasonValue);
        const statusLabel = documentId ? 'Document Status' : botJobId ? 'Bot Job Status' : 'Lookup Status';
        const reasonLabel = rejectionReason ? 'Rejected Reason' : 'Status Reason';
        const statusToneClass = loading
            ? 'is-neutral'
            : normalizedStatus === 'rejected'
                ? 'is-danger'
                : normalizedStatus === 'released'
                    ? 'is-success'
                    : normalizedStatus
                        ? 'is-info'
                        : 'is-neutral';
        const showReason = Boolean(loading || (normalizedStatus === 'rejected' && rejectionReason) || (!documentId && botJobStatusReason));
        const reasonToneClass = rejectionReason ? 'is-warning' : 'is-neutral';
        const summaryGridClass = showReason
            ? 'uuid-status-summary-grid'
            : 'uuid-status-summary-grid has-single-card';

        const statusTagName = !loading && prettyStatus ? 'button' : 'div';
        const statusInteractiveAttrs = !loading && prettyStatus
            ? ` type="button" data-copy-value="${escapeHtml(prettyStatus)}" data-copy-label="Document status" title="Copy document status"`
            : '';
        const reasonTagName = !loading && prettyReason ? 'button' : 'div';
        const reasonInteractiveAttrs = !loading && prettyReason
            ? ` type="button" data-copy-value="${escapeHtml(prettyReason)}" data-copy-label="${escapeHtml(reasonLabel)}" title="Copy ${escapeHtml(reasonLabel.toLowerCase())}"`
            : '';

        return `
            <div class="uuid-status-card practice-status-card ${loading ? 'is-loading' : ''}">
                <div class="uuid-status-header">
                    <div class="practice-status-kicker">UUID Lookup</div>
                    ${documentLink && !loading ? `<button type="button" class="practice-status-chip practice-status-chip-button is-cdb uuid-status-open-button" data-uuid-open-link="${escapeHtml(documentLink)}">Open link</button>` : ''}
                </div>
                <div class="uuid-status-main">
                    <div class="practice-status-title">${escapeHtml(displayTitle)}</div>
                    ${uuid && !loading
                        ? `<button type="button" class="practice-status-subtitle uuid-status-subtitle practice-status-meta-item-button" data-copy-value="${escapeHtml(uuid)}" data-copy-label="UUID" title="Copy UUID">${escapeHtml(displaySubtitle)}</button>`
                        : `<div class="practice-status-subtitle uuid-status-subtitle" title="${escapeHtml(uuid || 'UUID lookup')}">${escapeHtml(displaySubtitle)}</div>`}
                </div>
                <div class="${summaryGridClass}">
                    <${statusTagName} class="practice-status-summary-card ${statusToneClass}${statusTagName === 'button' ? ' practice-status-meta-item-button' : ''}"${statusInteractiveAttrs}>
                        <span class="practice-status-summary-label">${escapeHtml(statusLabel)}</span>
                        <span class="practice-status-summary-value">${escapeHtml(loading ? 'Loading' : prettyStatus)}</span>
                    </${statusTagName}>
                    ${showReason ? `
                        <${reasonTagName} class="practice-status-summary-card ${reasonToneClass}${reasonTagName === 'button' ? ' practice-status-meta-item-button' : ''}"${reasonInteractiveAttrs}>
                            <span class="practice-status-summary-label">${escapeHtml(reasonLabel)}</span>
                            <span class="practice-status-summary-value">${escapeHtml(loading ? 'Checking' : (prettyReason || 'N/A'))}</span>
                        </${reasonTagName}>
                    ` : ''}
                </div>
            </div>
        `;
    };

    const UUID_BATCH_RESULTS_STORAGE_KEY = 'uuidBatchCheckLatest';
    const UUID_BATCH_RESULTS_MAX_AGE_MS = 15 * 60 * 1000;

    const getUuidBatchCheckedAt = (batch) => {
        const timestamp = Date.parse(batch?.checkedAt);
        return Number.isFinite(timestamp) ? timestamp : 0;
    };

    const isUuidBatchFresh = (batch) => {
        const checkedAt = getUuidBatchCheckedAt(batch);
        if (!checkedAt) return false;
        const ageMs = Date.now() - checkedAt;
        return ageMs >= 0 && ageMs <= UUID_BATCH_RESULTS_MAX_AGE_MS;
    };

    const hideUuidBatchResultsFor = ({ sectionEl, listEl } = {}) => {
        if (sectionEl) sectionEl.hidden = true;
        if (listEl) listEl.innerHTML = '';
    };

    const hideUuidBatchResults = () => {
        hideUuidBatchResultsFor({
            sectionEl: uuidBatchResultsSection,
            listEl: uuidBatchResultsList
        });
    };

    const clearUuidBatchResults = async () => {
        hideUuidBatchResults();
        try {
            await chrome.storage.local.remove(UUID_BATCH_RESULTS_STORAGE_KEY);
        } catch {
            // Ignore: hiding the stale panel data is the important part.
        }
    };

    // Mirrors the batch UUID checks run from the bot dashboard's on-page
    // panel (bot_dashboard_navigator.js), which writes to the same storage
    // key. Reuses buildUuidLookupCardHtml so each card matches the look of
    // the single-UUID lookup above it.
    const renderUuidBatchResultsFor = (batch, { sectionEl, titleEl, listEl } = {}) => {
        if (!sectionEl || !listEl) return;
        const items = Array.isArray(batch?.items) ? batch.items : [];
        if (!items.length || !isUuidBatchFresh(batch)) {
            hideUuidBatchResultsFor({ sectionEl, listEl });
            return;
        }

        if (titleEl) {
            const checkedAt = Number.isFinite(Date.parse(batch?.checkedAt)) ? new Date(batch.checkedAt) : null;
            const when = checkedAt ? checkedAt.toLocaleString() : '';
            titleEl.textContent = `Last batch check (${items.length} UUID${items.length === 1 ? '' : 's'})${when ? ` · ${when}` : ''}`;
        }

        listEl.innerHTML = items.map((item) => {
            if (item?.error) {
                const uuid = collapseText(item.uuid || '');
                const subtitle = uuid ? truncateMiddleText(uuid, 14, 10) : 'UUID lookup';
                return `
                    <div class="uuid-status-card practice-status-card">
                        <div class="uuid-status-header">
                            <div class="practice-status-kicker">UUID Lookup</div>
                        </div>
                        <div class="uuid-status-main">
                            <div class="practice-status-title">Lookup failed</div>
                            <div class="practice-status-subtitle uuid-status-subtitle" title="${escapeHtml(uuid)}">${escapeHtml(subtitle)}</div>
                        </div>
                        <div class="uuid-status-summary-grid has-single-card">
                            <div class="practice-status-summary-card is-danger">
                                <span class="practice-status-summary-label">Document Status</span>
                                <span class="practice-status-summary-value">${escapeHtml(collapseText(item.error))}</span>
                            </div>
                        </div>
                    </div>
                `;
            }
            return buildUuidLookupCardHtml({ ...(item?.result || {}), uuid: item?.result?.uuid || item?.uuid || '' }, { loading: false });
        }).join('');
        sectionEl.hidden = false;
    };

    const renderUuidBatchResults = (batch) => {
        renderUuidBatchResultsFor(batch, {
            sectionEl: uuidBatchResultsSection,
            titleEl: uuidBatchResultsTitle,
            listEl: uuidBatchResultsList
        });
    };

    const loadUuidBatchResults = async () => {
        try {
            const stored = await chrome.storage.local.get(UUID_BATCH_RESULTS_STORAGE_KEY);
            const batch = stored?.[UUID_BATCH_RESULTS_STORAGE_KEY] || null;
            if (batch && !isUuidBatchFresh(batch)) {
                await clearUuidBatchResults();
                return;
            }
            renderUuidBatchResults(batch);
        } catch (error) {
            // Ignore: this mirror view is a nice-to-have, not core panel function.
        }
    };

    const renderUuidLookupLoadingFor = (statusEl, uuid = '') => {
        if (!statusEl) return;
        statusEl.classList.remove('neutral', 'valid', 'invalid');
        statusEl.classList.add('neutral', 'uuid-lookup-status', 'uuid-lookup-card-host');
        statusEl.innerHTML = buildUuidLookupCardHtml({ uuid }, { loading: true, fallbackUuid: uuid });
    };

    const renderUuidLookupResultFor = (statusEl, result = {}, fallbackUuid = '') => {
        if (!statusEl) return;
        statusEl.classList.remove('neutral', 'valid', 'invalid');
        statusEl.classList.add('valid', 'uuid-lookup-status', 'uuid-lookup-card-host');
        statusEl.innerHTML = buildUuidLookupCardHtml(result, { loading: false, fallbackUuid });
    };

    const createUuidLookupController = ({ inputEl, statusEl, onInputStart } = {}) => {
        let requestSeq = 0;
        let abortController = null;
        let loadingTimer = null;
        let lastUuid = '';

        const clearLoadingTimer = () => {
            if (loadingTimer !== null) {
                window.clearTimeout(loadingTimer);
                loadingTimer = null;
            }
        };

        const cancel = () => {
            clearLoadingTimer();
            if (abortController) {
                abortController.abort();
                abortController = null;
            }
        };

        const reset = () => {
            requestSeq += 1;
            cancel();
            lastUuid = '';
            if (inputEl) inputEl.value = '';
            setUuidLookupStatusFor(statusEl, 'Paste a UUID or UUID fragment to check status.', 'neutral');
        };

        const run = async ({ force = false, value = null } = {}) => {
            const rawValue = String(value ?? inputEl?.value ?? '').trim();
            const uuid = extractUuid(rawValue);
            const currentSeq = ++requestSeq;

            if (!rawValue) {
                lastUuid = '';
                setUuidLookupStatusFor(statusEl, 'Paste a UUID or UUID fragment to check status.', 'neutral');
                return '';
            }

            if (!uuid) {
                lastUuid = '';
                setUuidLookupStatusFor(statusEl, 'Enter at least 6 UUID characters.', 'invalid');
                return '';
            }

            if (inputEl && inputEl.value !== uuid) {
                inputEl.value = uuid;
            }

            if (!force && uuid === lastUuid) {
                return uuid;
            }

            lastUuid = uuid;
            const cachedResult = force ? null : getCachedUuidLookup(uuid);
            if (cachedResult) {
                renderUuidLookupResultFor(statusEl, cachedResult, uuid);
                return uuid;
            }

            cancel();
            const controller = new AbortController();
            let requestTimedOut = false;
            abortController = controller;
            loadingTimer = window.setTimeout(() => {
                if (currentSeq === requestSeq && lastUuid === uuid) {
                    renderUuidLookupLoadingFor(statusEl, uuid);
                }
            }, UUID_LOOKUP_LOADING_DELAY_MS);
            const timeoutId = window.setTimeout(() => {
                requestTimedOut = true;
                controller.abort();
            }, UUID_LOOKUP_REQUEST_TIMEOUT_MS);

            try {
                const result = await fetchUuidLookup(uuid, { signal: controller.signal });
                if (currentSeq !== requestSeq) return uuid;
                rememberUuidLookup(uuid, result);
                if (!result.found || !result.status) {
                    setUuidLookupStatusFor(
                        statusEl,
                        String(result.detail || `No document found for ${uuid}.`).trim(),
                        'invalid'
                    );
                    return uuid;
                }

                renderUuidLookupResultFor(statusEl, result, uuid);
                return uuid;
            } catch (error) {
                if (currentSeq !== requestSeq) return uuid;
                if (error?.name === 'AbortError' && !requestTimedOut) return uuid;
                lastUuid = '';
                setUuidLookupStatusFor(
                    statusEl,
                    requestTimedOut
                        ? 'Local trigger service timed out.'
                        : String(error?.message || 'UUID lookup failed.').trim(),
                    'invalid'
                );
                return uuid;
            } finally {
                clearLoadingTimer();
                window.clearTimeout(timeoutId);
                if (abortController === controller) {
                    abortController = null;
                }
            }
        };

        const handleInput = () => {
            requestSeq += 1;
            cancel();
            if (typeof onInputStart === 'function') onInputStart();
            const rawValue = String(inputEl?.value || '').trim();
            if (!rawValue) {
                lastUuid = '';
                setUuidLookupStatusFor(statusEl, 'Paste a UUID or UUID fragment to check status.', 'neutral');
                return;
            }

            if (!extractUuid(rawValue)) {
                lastUuid = '';
                setUuidLookupStatusFor(statusEl, 'Enter at least 6 UUID characters.', 'invalid');
                return;
            }

            run().catch(() => undefined);
        };

        const handleKeydown = (event) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                run({ force: true }).catch(() => undefined);
            }
            if (event.key === 'Escape') {
                reset();
            }
        };

        return {
            run,
            reset,
            cancel,
            handleInput,
            handleKeydown,
            warm: () => warmUuidLookupConnection().catch(() => undefined)
        };
    };

    const jobPanelUuidLookupController = createUuidLookupController({
        inputEl: uuidLookupInput,
        statusEl: uuidLookupStatus,
        onInputStart: hideUuidBatchResults
    });

    const closeBookmarkletToolModal = () => {
        if (!bookmarkletToolModal) return;
        if (typeof bookmarkletToolModalCleanup === 'function') {
            bookmarkletToolModalCleanup();
            bookmarkletToolModalCleanup = null;
        }
        const activeElement = document.activeElement;
        if (activeElement && bookmarkletToolModal.contains(activeElement)) {
            activeElement.blur();
        }
        bookmarkletToolModal.classList.remove('is-open');
        bookmarkletToolModal.setAttribute('aria-hidden', 'true');
        if (bookmarkletToolModalActions) bookmarkletToolModalActions.innerHTML = '';
        if (bookmarkletToolModalBody) bookmarkletToolModalBody.innerHTML = '';
        if (bookmarkletToolModalReturnFocusEl && document.contains(bookmarkletToolModalReturnFocusEl)) {
            bookmarkletToolModalReturnFocusEl.focus({ preventScroll: true });
        }
        bookmarkletToolModalReturnFocusEl = null;
    };

    const openBookmarkletToolModal = (title) => {
        if (!bookmarkletToolModal) return false;
        if (typeof bookmarkletToolModalCleanup === 'function') {
            bookmarkletToolModalCleanup();
            bookmarkletToolModalCleanup = null;
        }
        bookmarkletToolModalReturnFocusEl = document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null;
        if (bookmarkletToolModalTitle) bookmarkletToolModalTitle.textContent = title || 'Tool';
        if (bookmarkletToolModalActions) bookmarkletToolModalActions.innerHTML = '';
        if (bookmarkletToolModalBody) bookmarkletToolModalBody.innerHTML = '';
        bookmarkletToolModal.classList.add('is-open');
        bookmarkletToolModal.setAttribute('aria-hidden', 'false');
        bookmarkletToolModalCloseBtn?.focus({ preventScroll: true });
        return true;
    };

    // The bookmarklet tool builders (openWorkflowGroupsModal etc.) each
    // render into a target {actionsEl, bodyEl} pair. By default that's the
    // shared floating modal (used by the standalone popup window's launch
    // grid); on the docked "Bookmarklet Tools" handle, all three tools
    // instead render inline at once into their own persistent cards (see
    // bl-panel-bookmarklet-suite in initializePanel), so a target is
    // passed explicitly there and no modal is opened at all.
    const resolveBookmarkletTarget = (target, modalTitle) => {
        if (target) {
            if (target.actionsEl) target.actionsEl.innerHTML = '';
            if (target.bodyEl) target.bodyEl.innerHTML = '';
            return target;
        }
        if (!openBookmarkletToolModal(modalTitle)) return null;
        return { actionsEl: bookmarkletToolModalActions, bodyEl: bookmarkletToolModalBody };
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

    const DOCMAN_ACTION_LABELS = {
        login: 'Login',
        verify: 'Verify',
        'create-group': 'Create Group',
        'clean-processing': 'Clean Processing',
        'clean-filing': 'Clean Filing',
        onboarding: 'Onboarding'
    };
    const DOCMAN_ONBOARDING_DEFAULT_INPUT_FOLDER_NAME = 'zz BL Input. Do not touch';
    const DOCMAN_ONBOARDING_NOT_IN_FOLDER_NAME = 'Not in a folder';
    const DOCMAN_TOOL_DEFAULT_STATUS_MESSAGES = new Set([
        'Select a practice to run Docman tools.',
        'Choose a Docman action for the selected practice.'
    ]);
    const trimDocmanField = (value, maxLength = 4096) => String(value || '').trim().slice(0, maxLength);
    const trimDocmanMultiline = (value, maxLength = 12000) => String(value || '')
        .replace(/\r\n/g, '\n')
        .replace(/\u0000/g, '')
        .trim()
        .slice(0, maxLength);
    const formatDocmanToolTime = (value) => {
        if (!value) return '';
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return trimDocmanField(value, 80);
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    };
    const getDocmanActionButtons = () => Array.from(
        document.querySelectorAll('#statusDisplay [data-docman-action]')
    );
    const getDocmanActionLabel = (action) => DOCMAN_ACTION_LABELS[action] || 'Docman Tool';
    const isDocmanToolDefaultStatusText = (value) => DOCMAN_TOOL_DEFAULT_STATUS_MESSAGES.has(trimDocmanField(value, 260));
    const getSelectedDocmanOdsCode = () => String(state.currentSelectedOdsCode || '').trim().toUpperCase();
    const isConcreteDocmanOdsCode = (value) => /^[A-Z]\d{5}$/.test(String(value || '').trim().toUpperCase());
    const isDocmanRunForSelectedPractice = (run) => {
        const selectedOds = getSelectedDocmanOdsCode();
        if (!isConcreteDocmanOdsCode(selectedOds)) return false;
        const runOds = trimDocmanField(run?.odsCode, 16).toUpperCase();
        return runOds === selectedOds;
    };
    const getDocmanToolDefaultStatusMessage = () => {
        const odsCode = getSelectedDocmanOdsCode();
        if (isConcreteDocmanOdsCode(odsCode)) {
            return 'Choose a Docman action for the selected practice.';
        }
        return 'Select a practice to run Docman tools.';
    };
    const setDocmanToolStatus = (message, tone = null) => {
        if (!docmanToolStatus) return;
        const normalizedMessage = trimDocmanField(message, 4000) || getDocmanToolDefaultStatusMessage();
        docmanToolStatus.classList.remove('neutral', 'valid', 'invalid', 'docman-tool-status-host');
        if (tone === 'valid') docmanToolStatus.classList.add('valid');
        else if (tone === 'invalid') docmanToolStatus.classList.add('invalid');
        else docmanToolStatus.classList.add('neutral');
        docmanToolStatus.classList.add('validation-badge', 'docman-tool-status-host');
        docmanToolStatus.textContent = normalizedMessage;
    };
    const isDocmanCleanAction = (action) => action === 'clean-processing' || action === 'clean-filing';
    const getDocmanRunStatusTone = (run, isActive = false) => {
        if (isActive || String(run?.status || '').toLowerCase() === 'running') return 'running';
        const action = trimDocmanField(run?.action, 40);
        const resultData = run?.resultData && typeof run.resultData === 'object' ? run.resultData : null;
        if (action === 'verify' && String(run?.status || '').toLowerCase() === 'success') {
            const checked = Number(resultData?.checked) || Number(run?.usernamesCount) || 0;
            const matched = Number(resultData?.matched) || 0;
            if (checked > 0 && matched <= 0) return 'warning';
            if (checked > 0 && matched < checked) return 'warning';
        }
        if (isDocmanCleanAction(action) && String(run?.status || '').toLowerCase() === 'success') {
            const outcome = trimDocmanField(resultData?.outcome, 40);
            if (outcome === 'cancelled') return 'warning';
            const matched = Number(resultData?.matchedDocuments) || 0;
            const moved = Number(resultData?.movedDocuments) || 0;
            if (matched > 0 && moved < matched) return 'warning';
        }
        return String(run?.status || '').toLowerCase() === 'success' ? 'success' : 'failed';
    };
    const getDocmanRunStatusLabel = (run, isActive = false) => {
        const tone = getDocmanRunStatusTone(run, isActive);
        if (tone === 'running') return 'Running';
        if (tone === 'warning') {
            const action = trimDocmanField(run?.action, 40);
            const resultData = run?.resultData && typeof run.resultData === 'object' ? run.resultData : null;
            if (action === 'verify') {
                const checked = Number(resultData?.checked) || Number(run?.usernamesCount) || 0;
                const matched = Number(resultData?.matched) || 0;
                if (checked > 0 && matched <= 0) return 'No Matches';
                return 'Partial';
            }
            if (isDocmanCleanAction(action)) {
                if (trimDocmanField(resultData?.outcome, 40) === 'cancelled') return 'Cancelled';
                return 'Partial';
            }
            return 'Attention';
        }
        if (tone === 'success') return 'Success';
        return 'Failed';
    };
    const getDocmanRunHeadline = (run, isActive = false) => {
        if (!run || typeof run !== 'object') return '';
        const actionLabel = getDocmanActionLabel(trimDocmanField(run.action, 40));
        const practiceLabel = trimDocmanField(run.practiceName, 120) || 'Selected practice';
        const endedAt = formatDocmanToolTime(run.endedAt);
        const startedAt = formatDocmanToolTime(run.startedAt);
        const tone = getDocmanRunStatusTone(run, isActive);
        const resultData = run.resultData && typeof run.resultData === 'object' ? run.resultData : null;
        if (isActive || String(run.status || '').toLowerCase() === 'running') {
            return `${actionLabel} is running for ${practiceLabel}${startedAt ? ` since ${startedAt}` : ''}.`;
        }
        if (trimDocmanField(run.action, 40) === 'verify' && tone === 'warning') {
            const checked = Number(resultData?.checked) || Number(run.usernamesCount) || 0;
            const matched = Number(resultData?.matched) || 0;
            const missing = Number.isFinite(Number(resultData?.missing)) ? Number(resultData.missing) : Math.max(0, checked - matched);
            if (matched <= 0 && checked > 0) {
                return `Verify finished for ${practiceLabel}${endedAt ? ` at ${endedAt}` : ''}, but no exact Docman matches were found.`;
            }
            return `Verify finished for ${practiceLabel}${endedAt ? ` at ${endedAt}` : ''} with partial matches (${matched} matched, ${missing} missing).`;
        }
        if (isDocmanCleanAction(trimDocmanField(run.action, 40))) {
            const outcome = trimDocmanField(resultData?.outcome, 40);
            const matched = Number(resultData?.matchedDocuments) || 0;
            const moved = Number(resultData?.movedDocuments) || 0;
            const failed = Number.isFinite(Number(resultData?.failedDocuments)) ? Number(resultData.failedDocuments) : Math.max(0, matched - moved);
            const destination = trimDocmanField(resultData?.destinationFolder, 80);
            const destinationSuffix = destination ? ` to "${destination}"` : '';
            if (outcome === 'cancelled') return `${actionLabel} cancelled for ${practiceLabel} — no documents were moved.`;
            if (outcome === 'nothing_to_move') return `${actionLabel} found no documents to move for ${practiceLabel}.`;
            if (tone === 'failed') {
                const reason = trimDocmanField(run.error, 140) || 'Run failed';
                return moved > 0
                    ? `Moved ${moved} of ${matched} documents${destinationSuffix} before failing. ${reason}`
                    : `${actionLabel} failed for ${practiceLabel}. ${reason}`;
            }
            if (failed > 0) return `Moved ${moved} of ${matched} documents${destinationSuffix} — ${failed} did not move.`;
            return `Moved ${moved} document${moved === 1 ? '' : 's'}${destinationSuffix}.`;
        }
        if (String(run.status || '').toLowerCase() === 'success') {
            return `${actionLabel} finished for ${practiceLabel}${endedAt ? ` at ${endedAt}` : ''}.`;
        }
        const reason = trimDocmanField(run.error, 180) || (run.exitCode != null ? `Exit code ${run.exitCode}` : 'Run failed');
        return `${actionLabel} failed for ${practiceLabel}${endedAt ? ` at ${endedAt}` : ''}. ${reason}`;
    };
    const buildDocmanSummaryCards = (run, isActive = false) => {
        if (!run || typeof run !== 'object') return [];
        const resultData = run.resultData && typeof run.resultData === 'object' ? run.resultData : null;
        const action = trimDocmanField(run.action, 40);
        if (action === 'verify') {
            const checked = Number(resultData?.checked) || Number(run.usernamesCount) || 0;
            const matched = Number(resultData?.matched) || 0;
            const missing = Number(resultData?.missing);
            return [
                { label: 'Checked', value: String(checked || 0), tone: 'is-primary' },
                { label: 'Matched', value: String(matched), tone: matched > 0 ? 'is-success' : 'is-info' },
                { label: 'Missing', value: String(Number.isFinite(missing) ? missing : Math.max(0, checked - matched)), tone: (Number.isFinite(missing) ? missing : Math.max(0, checked - matched)) > 0 ? 'is-warning' : 'is-neutral' }
            ];
        }
        if (action === 'create-group') {
            const membersCount = Number(resultData?.membersCount) || Number(run.usernamesCount) || 0;
            return [
                { label: 'Members', value: String(membersCount), tone: 'is-primary' },
                { label: 'Status', value: getDocmanRunStatusLabel(run, isActive), tone: getDocmanRunStatusTone(run, isActive) === 'success' ? 'is-success' : 'is-info' }
            ];
        }
        if (action === 'onboarding') {
            const folderCount = Number(resultData?.folderCount) || 0;
            const existingCount = Number(resultData?.existingCount) || 0;
            return [
                { label: 'Folder #4', value: trimDocmanField(resultData?.inputFolderName || run.onboardingInputFolderName, 48) || 'Default', tone: 'is-primary' },
                { label: 'Folders', value: String(folderCount || 0), tone: 'is-info' },
                { label: 'Already There', value: String(existingCount || 0), tone: existingCount > 0 ? 'is-warning' : 'is-neutral' }
            ];
        }
        if (isDocmanCleanAction(action)) {
            const total = Number(resultData?.totalDocuments) || 0;
            const matched = Number(resultData?.matchedDocuments) || 0;
            const moved = Number(resultData?.movedDocuments) || 0;
            const notMoved = Number.isFinite(Number(resultData?.failedDocuments)) ? Number(resultData.failedDocuments) : Math.max(0, matched - moved);
            return [
                { label: 'Found', value: String(matched || total || 0), tone: 'is-primary' },
                { label: 'Moved', value: String(moved), tone: moved > 0 ? 'is-success' : 'is-neutral' },
                { label: 'Not Moved', value: String(notMoved), tone: notMoved > 0 ? 'is-danger' : 'is-neutral' }
            ];
        }
        return [
            { label: 'Action', value: getDocmanActionLabel(action), tone: 'is-primary' },
            { label: 'Status', value: getDocmanRunStatusLabel(run, isActive), tone: getDocmanRunStatusTone(run, isActive) === 'success' ? 'is-success' : getDocmanRunStatusTone(run, isActive) === 'failed' ? 'is-danger' : 'is-info' }
        ];
    };
    const buildDocmanVerifyResultsHtml = (run) => {
        const resultData = run?.resultData && typeof run.resultData === 'object' ? run.resultData : null;
        const results = Array.isArray(resultData?.results) ? resultData.results.slice(0, 24) : [];
        if (!results.length) return '';
        return `
            <div class="docman-tool-verify-list">
                ${results.map((entry) => {
                    const requested = trimDocmanField(entry?.requestedUsername, 120) || 'Username';
                    const found = trimDocmanField(entry?.docmanUsername, 120);
                    const detail = trimDocmanField(entry?.detail, 180);
                    const partialMatches = Array.isArray(entry?.partialMatches)
                        ? entry.partialMatches.map((value) => trimDocmanField(value, 120)).filter(Boolean)
                        : [];
                    const isFound = Boolean(entry?.exists && found);
                    const hasPartial = !isFound && (partialMatches.length > 0 || Boolean(entry?.needsManualReview));
                    const tone = isFound ? 'is-found' : hasPartial ? 'is-partial' : 'is-missing';
                    const stateLabel = isFound ? 'Found' : hasPartial ? 'Review' : 'Missing';
                    const foundText = isFound
                        ? `Matched: ${found}`
                        : hasPartial
                            ? (partialMatches.length === 1
                                ? `Possible match: ${partialMatches[0]}`
                                : `${partialMatches.length} possible matches`)
                            : 'No exact Docman match';
                    return `
                        <div class="docman-tool-verify-item ${tone}">
                            <div class="docman-tool-verify-main">
                                <div class="docman-tool-verify-requested">${escapeHtml(requested)}</div>
                                <div class="docman-tool-verify-found">${escapeHtml(foundText)}</div>
                                ${detail ? `<div class="docman-tool-verify-detail">${escapeHtml(detail)}</div>` : ''}
                                ${hasPartial && partialMatches.length > 1 ? `
                                    <div class="docman-tool-meta-row">
                                        ${partialMatches.map((name) => `<span class="docman-tool-chip">${escapeHtml(name)}</span>`).join('')}
                                    </div>
                                ` : ''}
                            </div>
                            <div class="docman-tool-verify-state">${stateLabel}</div>
                        </div>
                    `;
                }).join('')}
            </div>
        `;
    };
    const renderDocmanToolRunStatus = (run, { isActive = false } = {}) => {
        if (!docmanToolStatus || !run || typeof run !== 'object') return;
        const tone = getDocmanRunStatusTone(run, isActive);
        const startedAt = formatDocmanToolTime(run.startedAt);
        const endedAt = formatDocmanToolTime(run.endedAt);
        const resultData = run.resultData && typeof run.resultData === 'object' ? run.resultData : null;
        const summaryCards = buildDocmanSummaryCards(run, isActive);
        const logLines = Array.isArray(run.logLines) ? run.logLines.map((line) => trimDocmanField(line, 240)).filter(Boolean).slice(-80) : [];
        const exactMatches = Array.isArray(resultData?.exactMatches) ? resultData.exactMatches.map((value) => trimDocmanField(value, 120)).filter(Boolean).slice(0, 40) : [];
        const chips = [];
        const odsCode = trimDocmanField(run.odsCode, 16);
        if (startedAt && !isActive && endedAt) chips.push(`Started ${startedAt} · Finished ${endedAt}`);
        else if (startedAt) chips.push(`Started ${startedAt}`);
        else if (!isActive && endedAt) chips.push(`Finished ${endedAt}`);
        if (trimDocmanField(run.groupName, 120)) chips.push(`Group ${trimDocmanField(run.groupName, 120)}`);
        if (trimDocmanField(run.onboardingInputFolderName, 120)) chips.push(`Folder #4 ${trimDocmanField(run.onboardingInputFolderName, 120)}`);
        const practiceSubtitle = `${trimDocmanField(run.practiceName, 160) || 'Selected practice'}${odsCode ? ` · ${odsCode}` : ''}`;

        docmanToolStatus.classList.remove('validation-badge', 'neutral', 'valid', 'invalid');
        docmanToolStatus.classList.add('docman-tool-status-host');
        if (trimDocmanField(run.action, 40) === 'login') {
            docmanToolStatus.innerHTML = `
                <div class="docman-tool-status-card docman-tool-status-card-compact is-${tone}" data-docman-run-ods="${escapeHtml(odsCode)}">
                    <div class="docman-tool-compact-header">
                        <div class="docman-tool-status-kicker">Docman Login</div>
                        <div class="docman-tool-status-pill is-${tone}">${escapeHtml(getDocmanRunStatusLabel(run, isActive))}</div>
                    </div>
                    <div class="docman-tool-compact-main">
                        <div class="docman-tool-compact-icon" aria-hidden="true">${tone === 'success' ? '✓' : tone === 'running' ? '…' : '!'}</div>
                        <div class="docman-tool-compact-copy">
                            <div class="docman-tool-status-title">${escapeHtml(getDocmanRunHeadline(run, isActive))}</div>
                            <div class="docman-tool-status-subtitle">${escapeHtml(practiceSubtitle)}</div>
                        </div>
                    </div>
                    ${chips.length ? `<div class="docman-tool-meta-row docman-tool-compact-meta">${chips.map((chip) => `<span class="docman-tool-chip">${escapeHtml(chip)}</span>`).join('')}</div>` : ''}
                    ${logLines.length ? `
                        <details class="docman-tool-log-details docman-tool-compact-log">
                            <summary>Activity (${logLines.length})</summary>
                            <pre class="docman-tool-log">${escapeHtml(logLines.join('\n'))}</pre>
                        </details>
                    ` : ''}
                </div>
            `;
            return;
        }
        docmanToolStatus.innerHTML = `
            <div class="docman-tool-status-card is-${tone}" data-docman-run-ods="${escapeHtml(odsCode)}">
                <div class="docman-tool-status-header">
                    <div class="docman-tool-status-kicker">Docman ${escapeHtml(getDocmanActionLabel(trimDocmanField(run.action, 40)))}</div>
                    <div class="docman-tool-status-pill is-${tone}">${escapeHtml(getDocmanRunStatusLabel(run, isActive))}</div>
                </div>
                <div class="docman-tool-status-title">${escapeHtml(getDocmanRunHeadline(run, isActive))}</div>
                <div class="docman-tool-status-subtitle">${escapeHtml(practiceSubtitle)}</div>
                ${summaryCards.length ? `
                    <div class="docman-tool-summary-grid" style="grid-template-columns: repeat(${Math.min(summaryCards.length, 4)}, minmax(0, 1fr));">
                        ${summaryCards.map((item) => `
                            <div class="docman-tool-summary-card ${escapeHtml(item.tone || 'is-primary')}">
                                <span class="docman-tool-summary-label">${escapeHtml(item.label || '')}</span>
                                <span class="docman-tool-summary-value">${escapeHtml(item.value || '')}</span>
                            </div>
                        `).join('')}
                    </div>
                ` : ''}
                <div class="docman-tool-content">
                    ${chips.length ? `<div class="docman-tool-meta-row">${chips.map((chip) => `<span class="docman-tool-chip">${escapeHtml(chip)}</span>`).join('')}</div>` : ''}
                    ${exactMatches.length ? `
                        <div>
                            <div class="docman-tool-section-caption">Exact matches</div>
                            <div class="docman-tool-meta-row">
                                ${exactMatches.map((match) => `<span class="docman-tool-chip">${escapeHtml(match)}</span>`).join('')}
                            </div>
                        </div>
                    ` : ''}
                    ${exactMatches.length ? `
                        <div class="docman-tool-actions">
                            <button type="button" class="docman-tool-action-btn" data-docman-copy-matches="${escapeHtml(exactMatches.join('\n'))}">Copy matches</button>
                            ${resultData?.clipboardCopied ? '<span class="docman-tool-chip">Copied to clipboard during run</span>' : ''}
                        </div>
                    ` : ''}
                    ${buildDocmanVerifyResultsHtml(run)}
                    ${logLines.length ? `
                        <details class="docman-tool-log-details">
                            <summary>Captured activity (${logLines.length} line${logLines.length === 1 ? '' : 's'})</summary>
                            <pre class="docman-tool-log">${escapeHtml(logLines.join('\n'))}</pre>
                        </details>
                    ` : ''}
                </div>
            </div>
        `;
    };
    const syncDocmanToolButtons = () => {
        const hasConcretePractice = /^[A-Z]\d{5}$/.test(String(state.currentSelectedOdsCode || '').trim().toUpperCase());
        getDocmanActionButtons().forEach((button) => {
            button.disabled = docmanToolRunIsBusy || !hasConcretePractice;
        });
    };
    const parseDocmanUsernames = (rawValue) => {
        const seen = new Set();
        return trimDocmanMultiline(rawValue, 12000)
            .split(/[\n,;]+/)
            .map((value) => trimDocmanField(value, 120))
            .filter(Boolean)
            .filter((value) => {
                const key = value.toLowerCase();
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            })
            .slice(0, 500);
    };
    const resolveSelectedPracticeDetails = () => {
        const odsCode = Navigator.requireSelectedOdsCode();
        const practiceMatch = Object.values(state.cachedPractices || {}).find((practice) => {
            return String(practice?.ods || '').trim().toUpperCase() === odsCode;
        });
        let practiceName = trimDocmanField(practiceMatch?.name, 240);

        if (!practiceName) {
            const inputValue = trimDocmanField(document.getElementById('practiceInput')?.value, 240);
            const strippedInput = trimDocmanField(inputValue.replace(/\(\s*[A-Z]\d{5}\s*\)\s*$/, ''), 240);
            if (strippedInput && !/^[A-Z]\d{5}$/.test(strippedInput)) {
                practiceName = strippedInput;
            }
        }

        if (!practiceName) {
            throw new Error('Select the practice from suggestions first so MailroomNavigator can resolve the practice name.');
        }

        return { odsCode, practiceName };
    };
    const buildDocmanToolPayload = (action, extraPayload = {}) => {
        const practice = resolveSelectedPracticeDetails();
        return {
            action,
            practiceName: practice.practiceName,
            odsCode: practice.odsCode,
            ...extraPayload
        };
    };
    const fetchSelectedPracticeStatus = async (odsCode) => {
        const normalizedOds = trimDocmanField(odsCode, 16).toUpperCase();
        if (!normalizedOds) {
            throw new Error('Select a practice first.');
        }

        const response = await chrome.runtime.sendMessage({
            action: 'getPracticeStatus',
            odsCode: normalizedOds,
            ...getProtectedActionPayload()
        });

        if (!response?.success || !response?.status) {
            throw new Error(trimDocmanField(response?.error, 240) || 'Could not load practice Docman settings.');
        }

        return response.status;
    };
    const buildDocmanOnboardingFolderOptions = (practiceStatus = null) => {
        const configuredInputFolderName = trimDocmanField(practiceStatus?.docmanInputFolder, 240);
        const primaryValue = configuredInputFolderName || DOCMAN_ONBOARDING_DEFAULT_INPUT_FOLDER_NAME;
        const rawOptions = [
            configuredInputFolderName
                ? {
                    value: configuredInputFolderName,
                    label: 'Configured practice input folder',
                    description: `BetterLetter setting: ${configuredInputFolderName}`
                }
                : {
                    value: DOCMAN_ONBOARDING_DEFAULT_INPUT_FOLDER_NAME,
                    label: 'Default input folder',
                    description: `Fallback: ${DOCMAN_ONBOARDING_DEFAULT_INPUT_FOLDER_NAME}`
                },
            {
                value: DOCMAN_ONBOARDING_DEFAULT_INPUT_FOLDER_NAME,
                label: DOCMAN_ONBOARDING_DEFAULT_INPUT_FOLDER_NAME,
                description: 'Use the standard BetterLetter Docman onboarding folder.'
            },
            {
                value: DOCMAN_ONBOARDING_NOT_IN_FOLDER_NAME,
                label: DOCMAN_ONBOARDING_NOT_IN_FOLDER_NAME,
                description: 'Use the practice-specific no-folder setup.'
            }
        ];

        const seen = new Set();
        const options = rawOptions.filter((option) => {
            const key = trimDocmanField(option?.value, 240).toLowerCase();
            if (!key || seen.has(key)) return false;
            seen.add(key);
            return true;
        });

        return {
            configuredInputFolderName,
            primaryValue,
            options
        };
    };
    const fetchDocmanToolRunStatus = async () => {
        const response = await chrome.runtime.sendMessage({
            action: 'getDocmanToolRunStatus',
            ...getProtectedActionPayload()
        });
        if (!response?.success || !response?.status) {
            throw new Error(trimDocmanField(response?.error, 240) || 'Could not read Docman tool status.');
        }
        return response.status;
    };
    const applyDocmanToolStatus = (status) => {
        if (!status || typeof status !== 'object') {
            docmanToolRunIsBusy = false;
            syncDocmanToolButtons();
            setDocmanToolStatus(getDocmanToolDefaultStatusMessage(), 'neutral');
            return false;
        }

        const activeRun = status.activeRun && typeof status.activeRun === 'object' ? status.activeRun : null;
        const lastRun = status.lastRun && typeof status.lastRun === 'object' ? status.lastRun : null;

        if (Boolean(status.running) && activeRun) {
            docmanToolRunIsBusy = true;
            syncDocmanToolButtons();
            if (isDocmanRunForSelectedPractice(activeRun)) {
                renderDocmanToolRunStatus(activeRun, { isActive: true });
            } else {
                const actionLabel = getDocmanActionLabel(trimDocmanField(activeRun.action, 40));
                const practiceLabel = trimDocmanField(activeRun.practiceName, 120) || 'another practice';
                const startedAt = formatDocmanToolTime(activeRun.startedAt);
                setDocmanToolStatus(
                    `${actionLabel} is running for ${practiceLabel}${startedAt ? ` since ${startedAt}` : ''}.`,
                    'neutral'
                );
            }
            return true;
        }

        docmanToolRunIsBusy = false;
        syncDocmanToolButtons();

        if (lastRun && isDocmanRunForSelectedPractice(lastRun)) {
            renderDocmanToolRunStatus(lastRun, { isActive: false });
            return false;
        }

        setDocmanToolStatus(getDocmanToolDefaultStatusMessage(), 'neutral');
        return false;
    };
    const stopDocmanToolStatusPolling = () => {
        if (!docmanToolStatusPollTimer) return;
        clearInterval(docmanToolStatusPollTimer);
        docmanToolStatusPollTimer = null;
        docmanToolStatusPollDeadlineMs = 0;
    };
    const pollDocmanToolStatus = async ({ silent = false } = {}) => {
        try {
            const status = await fetchDocmanToolRunStatus();
            return applyDocmanToolStatus(status);
        } catch (error) {
            docmanToolRunIsBusy = false;
            syncDocmanToolButtons();
            if (!silent) {
                const message = trimDocmanField(error?.message, 240) || 'Could not read Docman tool status.';
                setDocmanToolStatus(message, 'invalid');
            }
            return false;
        }
    };
    const startDocmanToolStatusPolling = () => {
        stopDocmanToolStatusPolling();
        docmanToolStatusPollDeadlineMs = Date.now() + DOCMAN_TOOL_STATUS_POLL_WINDOW_MS;

        pollDocmanToolStatus({ silent: false }).catch(() => undefined);

        docmanToolStatusPollTimer = window.setInterval(() => {
            if (Date.now() > docmanToolStatusPollDeadlineMs) {
                stopDocmanToolStatusPolling();
                docmanToolRunIsBusy = false;
                syncDocmanToolButtons();
                return;
            }

            pollDocmanToolStatus({ silent: false })
                .then((isRunning) => {
                    if (!isRunning) stopDocmanToolStatusPolling();
                })
                .catch(() => undefined);
        }, DOCMAN_TOOL_STATUS_POLL_INTERVAL_MS);
    };
    const triggerDocmanToolRun = async (payload) => {
        try {
            const actionLabel = getDocmanActionLabel(trimDocmanField(payload?.action, 40));
            docmanToolRunIsBusy = true;
            syncDocmanToolButtons();
            setDocmanToolStatus(`Starting ${actionLabel}…`, 'neutral');

            const response = await chrome.runtime.sendMessage({
                action: 'runDocmanToolAction',
                payload,
                ...getProtectedActionPayload()
            });

            if (response?.success && response?.run) {
                renderDocmanToolRunStatus(response.run, { isActive: true });
                showToast(`${actionLabel} started.`);
                startDocmanToolStatusPolling();
                return true;
            }

            if (response?.running && response?.run) {
                renderDocmanToolRunStatus(response.run, { isActive: true });
                showToast('A Docman tool run is already in progress.');
                startDocmanToolStatusPolling();
                return false;
            }

            throw new Error(trimDocmanField(response?.error, 260) || `Could not start ${actionLabel}.`);
        } catch (error) {
            docmanToolRunIsBusy = false;
            syncDocmanToolButtons();
            const message = trimDocmanField(error?.message, 260) || 'Could not start Docman tool.';
            setDocmanToolStatus(message, 'invalid');
            showToast(message);
            return false;
        }
    };
    const startPracticeScopedDocmanAction = async (action, extraPayload = {}) => {
        try {
            return await triggerDocmanToolRun(buildDocmanToolPayload(action, extraPayload));
        } catch (error) {
            const message = trimDocmanField(error?.message, 260) || 'Could not start Docman tool.';
            setDocmanToolStatus(message, 'invalid');
            showToast(message);
            return false;
        }
    };
    const openDocmanVerifyModal = () => {
        let practice = null;
        try {
            practice = resolveSelectedPracticeDetails();
        } catch (error) {
            showToast(error.message);
            return;
        }

        if (!openBookmarkletToolModal('Docman Verify')) return;

        const runBtn = document.createElement('button');
        runBtn.type = 'button';
        runBtn.className = 'bookmarklet-tool-btn active';
        runBtn.textContent = 'Run Verify';

        const countChip = document.createElement('div');
        countChip.className = 'bookmarklet-tool-chip';
        countChip.textContent = '0 usernames';

        bookmarkletToolModalActions?.append(runBtn, countChip);

        const layout = document.createElement('div');
        layout.className = 'bookmarklet-tool-stack';

        const practiceChip = document.createElement('div');
        practiceChip.className = 'bookmarklet-tool-chip';
        practiceChip.textContent = `Practice: ${practice.practiceName} (${practice.odsCode})`;

        const label = document.createElement('label');
        label.className = 'bookmarklet-tool-label';
        label.textContent = 'Paste Docman usernames';

        const textarea = document.createElement('textarea');
        textarea.className = 'bookmarklet-tool-textarea';
        textarea.placeholder = 'one username per line';

        layout.append(practiceChip, label, textarea);
        bookmarkletToolModalBody?.appendChild(layout);

        const updateCount = () => {
            const usernames = parseDocmanUsernames(textarea.value);
            countChip.textContent = `${usernames.length} username${usernames.length === 1 ? '' : 's'}`;
        };

        textarea.addEventListener('input', updateCount);
        updateCount();

        runBtn.addEventListener('click', async () => {
            const usernames = parseDocmanUsernames(textarea.value);
            if (!usernames.length) {
                showToast('Paste at least one Docman username.');
                return;
            }

            runBtn.disabled = true;
            runBtn.textContent = 'Starting…';

            const started = await startPracticeScopedDocmanAction('verify', { usernames });
            if (started) {
                closeBookmarkletToolModal();
                return;
            }

            runBtn.disabled = false;
            runBtn.textContent = 'Run Verify';
        });

        textarea.focus();
    };
    const openDocmanCreateGroupModal = () => {
        let practice = null;
        try {
            practice = resolveSelectedPracticeDetails();
        } catch (error) {
            showToast(error.message);
            return;
        }

        if (!openBookmarkletToolModal('Docman Create Group')) return;

        const runBtn = document.createElement('button');
        runBtn.type = 'button';
        runBtn.className = 'bookmarklet-tool-btn active';
        runBtn.textContent = 'Create Group';

        const countChip = document.createElement('div');
        countChip.className = 'bookmarklet-tool-chip';
        countChip.textContent = '0 usernames';

        bookmarkletToolModalActions?.append(runBtn, countChip);

        const layout = document.createElement('div');
        layout.className = 'bookmarklet-tool-stack';

        const practiceChip = document.createElement('div');
        practiceChip.className = 'bookmarklet-tool-chip';
        practiceChip.textContent = `Practice: ${practice.practiceName} (${practice.odsCode})`;

        const groupLabel = document.createElement('label');
        groupLabel.className = 'bookmarklet-tool-label';
        groupLabel.textContent = 'Group name';

        const groupInput = document.createElement('input');
        groupInput.className = 'bookmarklet-tool-input';
        groupInput.placeholder = 'e.g. All Doctors';

        const usersLabel = document.createElement('label');
        usersLabel.className = 'bookmarklet-tool-label';
        usersLabel.textContent = 'Paste Docman usernames';

        const textarea = document.createElement('textarea');
        textarea.className = 'bookmarklet-tool-textarea';
        textarea.placeholder = 'one username per line';

        layout.append(practiceChip, groupLabel, groupInput, usersLabel, textarea);
        bookmarkletToolModalBody?.appendChild(layout);

        const updateCount = () => {
            const usernames = parseDocmanUsernames(textarea.value);
            countChip.textContent = `${usernames.length} username${usernames.length === 1 ? '' : 's'}`;
        };

        textarea.addEventListener('input', updateCount);
        updateCount();

        runBtn.addEventListener('click', async () => {
            const groupName = trimDocmanField(groupInput.value, 240);
            const usernames = parseDocmanUsernames(textarea.value);

            if (!groupName) {
                showToast('Enter a Docman group name.');
                return;
            }
            if (!usernames.length) {
                showToast('Paste at least one Docman username.');
                return;
            }

            runBtn.disabled = true;
            runBtn.textContent = 'Starting…';

            const started = await startPracticeScopedDocmanAction('create-group', {
                groupName,
                usernames
            });
            if (started) {
                closeBookmarkletToolModal();
                return;
            }

            runBtn.disabled = false;
            runBtn.textContent = 'Create Group';
        });

        groupInput.focus();
    };
    const openDocmanOnboardingModal = async () => {
        let practice = null;
        try {
            practice = resolveSelectedPracticeDetails();
        } catch (error) {
            showToast(error.message);
            return;
        }

        let practiceStatus = null;
        let settingsLoadError = '';
        try {
            practiceStatus = await fetchSelectedPracticeStatus(practice.odsCode);
        } catch (error) {
            settingsLoadError = trimDocmanField(error?.message, 240);
            console.warn('Docman onboarding settings load failed:', error);
        }

        const {
            configuredInputFolderName,
            primaryValue,
            options
        } = buildDocmanOnboardingFolderOptions(practiceStatus);

        if (!openBookmarkletToolModal('Docman Onboarding')) return;

        const runBtn = document.createElement('button');
        runBtn.type = 'button';
        runBtn.className = 'bookmarklet-tool-btn active';
        runBtn.textContent = 'Start Onboarding';

        bookmarkletToolModalActions?.append(runBtn);

        const layout = document.createElement('div');
        layout.className = 'bookmarklet-tool-stack';

        const practiceChip = document.createElement('div');
        practiceChip.className = 'bookmarklet-tool-chip';
        practiceChip.textContent = `Practice: ${practice.practiceName} (${practice.odsCode})`;
        layout.appendChild(practiceChip);

        const selectedFolderChip = document.createElement('div');
        selectedFolderChip.className = 'bookmarklet-tool-chip';
        selectedFolderChip.textContent = configuredInputFolderName
            ? `Configured input folder: ${configuredInputFolderName}`
            : `Configured input folder not found. Using ${DOCMAN_ONBOARDING_DEFAULT_INPUT_FOLDER_NAME}.`;
        layout.appendChild(selectedFolderChip);

        const folderLabel = document.createElement('label');
        folderLabel.className = 'bookmarklet-tool-label';
        folderLabel.textContent = 'Folder #4 choice';
        layout.appendChild(folderLabel);

        const optionsList = document.createElement('div');
        optionsList.className = 'job-checklist';
        optionsList.style.maxHeight = 'none';

        const selectionHint = document.createElement('div');
        selectionHint.className = 'validation-badge neutral';
        selectionHint.style.whiteSpace = 'pre-wrap';

        const folderInputs = [];
        const updateSelectionHint = () => {
            const selectedInput = folderInputs.find((input) => input.checked) || folderInputs[0] || null;
            const selectedOption = options.find((option) => option.value === selectedInput?.value) || null;
            if (!selectedOption) {
                selectionHint.textContent = 'Choose the onboarding folder that should be created as Folder #4.';
                return;
            }

            const hintLines = [
                selectedOption.description || '',
                `Folder #4 will be: ${selectedOption.value}`
            ].filter(Boolean);
            selectionHint.textContent = hintLines.join('\n');
        };

        options.forEach((option, index) => {
            const item = document.createElement('label');
            item.className = 'job-check-item';
            item.title = option.description || option.value;

            const input = document.createElement('input');
            input.type = 'radio';
            input.name = 'docmanOnboardingFolderChoice';
            input.value = option.value;
            input.checked = trimDocmanField(option.value, 240) === trimDocmanField(primaryValue, 240);
            input.addEventListener('change', updateSelectionHint);
            folderInputs.push(input);

            const text = document.createElement('span');
            text.className = 'job-check-text';
            text.textContent = option.label;

            item.append(input, text);
            optionsList.appendChild(item);
        });

        layout.append(optionsList, selectionHint);

        if (settingsLoadError) {
            const fallbackNotice = document.createElement('div');
            fallbackNotice.className = 'validation-badge neutral';
            fallbackNotice.style.whiteSpace = 'pre-wrap';
            fallbackNotice.textContent = `${settingsLoadError}\nUsing default onboarding options instead.`;
            layout.appendChild(fallbackNotice);
        }

        bookmarkletToolModalBody?.appendChild(layout);
        updateSelectionHint();

        runBtn.addEventListener('click', async () => {
            const selectedInput = folderInputs.find((input) => input.checked) || folderInputs[0] || null;
            const onboardingInputFolderName = trimDocmanField(selectedInput?.value, 240) || DOCMAN_ONBOARDING_DEFAULT_INPUT_FOLDER_NAME;

            runBtn.disabled = true;
            runBtn.textContent = 'Starting…';

            const started = await startPracticeScopedDocmanAction('onboarding', {
                onboardingInputFolderName
            });
            if (started) {
                closeBookmarkletToolModal();
                return;
            }

            runBtn.disabled = false;
            runBtn.textContent = 'Start Onboarding';
        });
    };

    document.addEventListener('mailroomNavigator:statusDisplayRendered', () => {
        syncDocmanToolButtons();
        resizeCompactModeForPracticeDetails();
    });

    document.addEventListener('mailroomNavigator:practiceSelectionChanged', () => {
        syncDocmanToolButtons();
        resizeCompactModeForPracticeDetails();
        const displayedRunOds = trimDocmanField(
            docmanToolStatus?.querySelector('[data-docman-run-ods]')?.getAttribute('data-docman-run-ods'),
            16
        ).toUpperCase();
        const selectedOds = getSelectedDocmanOdsCode();
        const displayedRunIsForAnotherPractice = displayedRunOds
            && isConcreteDocmanOdsCode(selectedOds)
            && displayedRunOds !== selectedOds;
        if (
            !docmanToolRunIsBusy
            && (displayedRunIsForAnotherPractice || isDocmanToolDefaultStatusText(docmanToolStatus?.textContent))
        ) {
            setDocmanToolStatus(getDocmanToolDefaultStatusMessage(), 'neutral');
        }
    });

    syncDocmanToolButtons();
    if (isDocmanToolDefaultStatusText(docmanToolStatus?.textContent)) {
        setDocmanToolStatus(getDocmanToolDefaultStatusMessage(), 'neutral');
    }

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
                const seen = new Set();
                const rows = [];

                const isVisibleElement = (element) => {
                    if (!(element instanceof Element)) return false;
                    const style = window.getComputedStyle(element);
                    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
                    const rect = element.getBoundingClientRect();
                    return rect.width > 0 && rect.height > 0;
                };

                const addUuid = (uuid, sourceText, date = 'N/A') => {
                    const id = normalize(uuid).toLowerCase();
                    if (!id || seen.has(id)) return;
                    seen.add(id);
                    rows.push({
                        id,
                        raw: normalize(sourceText) || id,
                        date: normalize(date) || 'N/A'
                    });
                };

                Array.from(document.querySelectorAll('tr')).forEach((row) => {
                    if (!isVisibleElement(row)) return;
                    const rowText = normalize(row.innerText || row.textContent);
                    const matches = rowText.match(regex) || [];
                    if (!matches.length) return;
                    const cells = row.querySelectorAll('td');
                    const date = cells.length >= 8 ? normalize(cells[7]?.innerText || cells[7]?.textContent) : 'N/A';
                    matches.forEach((uuid) => addUuid(uuid, rowText, date));
                });

                if (rows.length) return rows;

                const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
                    acceptNode(node) {
                        const text = String(node.textContent || '');
                        if (!text.match(regex)) return NodeFilter.FILTER_SKIP;
                        return isVisibleElement(node.parentElement)
                            ? NodeFilter.FILTER_ACCEPT
                            : NodeFilter.FILTER_SKIP;
                    }
                });

                let node;
                while ((node = walker.nextNode())) {
                    const textContent = normalize(node.textContent);
                    const matches = textContent.match(regex) || [];
                    matches.forEach((uuid) => addUuid(uuid, textContent, 'N/A'));
                }

                return rows;
            }
        });
        return Array.isArray(result) ? result : [];
    };

    const openUuidPickerModal = async () => {
        try {
            const tab = await getActiveBetterLetterTabForTool();
            if (!tab) return;

            let rows = await fetchUuidPickerRows(tab.id);
            if (!rows.length) {
                showToast('No UUIDs found on the active page. Paste one to lookup status.');
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

            const toolbar = document.createElement('div');
            toolbar.className = 'bookmarklet-tool-toolbar';
            toolbar.append(sqlBtn, rawBtn, uuidBtn, copyAllBtn, exportBtn);

            const filters = document.createElement('div');
            filters.className = 'bookmarklet-tool-filter-grid';
            filters.append(searchInput, dateInput);

            const lookupPanel = document.createElement('div');
            lookupPanel.className = 'uuid-picker-lookup-panel';

            const lookupTitle = document.createElement('div');
            lookupTitle.className = 'uuid-picker-lookup-title';
            lookupTitle.textContent = 'Lookup status';

            const lookupControls = document.createElement('div');
            lookupControls.className = 'uuid-picker-lookup-controls';

            const lookupInput = document.createElement('input');
            lookupInput.className = 'bookmarklet-tool-input';
            lookupInput.placeholder = 'Paste UUID or fragment to check Cloud SQL...';
            lookupInput.autocomplete = 'off';

            const lookupBtn = document.createElement('button');
            lookupBtn.type = 'button';
            lookupBtn.className = 'bookmarklet-tool-btn';
            lookupBtn.textContent = 'Lookup';

            lookupControls.append(lookupInput, lookupBtn);

            const lookupStatus = document.createElement('div');
            lookupStatus.className = 'validation-badge neutral uuid-picker-lookup-status';
            lookupStatus.textContent = 'Paste a UUID or click Lookup on a row.';

            lookupPanel.append(lookupTitle, lookupControls, lookupStatus);

            const summaryChip = document.createElement('div');
            summaryChip.className = 'bookmarklet-tool-chip';
            summaryChip.style.marginBottom = '8px';

            const list = document.createElement('div');
            list.className = 'bookmarklet-tool-list';

            const batchSection = document.createElement('div');
            batchSection.className = 'uuid-batch-results-section uuid-picker-batch-results';
            batchSection.hidden = true;

            const batchHead = document.createElement('div');
            batchHead.className = 'uuid-batch-results-head';

            const batchTitle = document.createElement('span');
            batchTitle.textContent = 'Last batch check';

            const batchClearBtn = document.createElement('button');
            batchClearBtn.type = 'button';
            batchClearBtn.className = 'uuid-batch-results-clear-btn';
            batchClearBtn.textContent = 'Clear';

            batchHead.append(batchTitle, batchClearBtn);

            const batchList = document.createElement('div');
            batchList.className = 'uuid-picker-batch-list';

            batchSection.append(batchHead, batchList);

            bookmarkletToolModalBody?.append(toolbar, filters, lookupPanel, summaryChip, list, batchSection);

            let rowsSourceTabId = tab.id;
            let rowsSignature = '';
            let refreshInFlight = false;
            let refreshTimer = null;
            let emptyRefreshCount = 0;
            const buildRowsSignature = (items) => {
                return (Array.isArray(items) ? items : [])
                    .map((item) => `${item.id || ''}|${item.date || ''}|${item.raw || ''}`)
                    .join('\n');
            };
            rowsSignature = buildRowsSignature(rows);

            const pickerLookupController = createUuidLookupController({
                inputEl: lookupInput,
                statusEl: lookupStatus
            });

            const runPickerLookup = (uuid, { focus = true } = {}) => {
                if (lookupInput) lookupInput.value = uuid || '';
                if (focus) lookupInput.focus();
                return pickerLookupController.run({ force: true });
            };

            const loadPickerBatchResults = async () => {
                try {
                    const stored = await chrome.storage.local.get(UUID_BATCH_RESULTS_STORAGE_KEY);
                    const batch = stored?.[UUID_BATCH_RESULTS_STORAGE_KEY] || null;
                    if (batch && !isUuidBatchFresh(batch)) {
                        await clearUuidBatchResults();
                        hideUuidBatchResultsFor({ sectionEl: batchSection, listEl: batchList });
                        return;
                    }
                    renderUuidBatchResultsFor(batch, {
                        sectionEl: batchSection,
                        titleEl: batchTitle,
                        listEl: batchList
                    });
                } catch {
                    hideUuidBatchResultsFor({ sectionEl: batchSection, listEl: batchList });
                }
            };

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
                    rowEl.className = 'bookmarklet-tool-item uuid-picker-row';

                    const rowContent = document.createElement('div');
                    rowContent.className = 'uuid-picker-row-content';

                    const main = document.createElement('div');
                    main.className = 'bookmarklet-tool-item-main';
                    main.textContent = getDisplayValue(item);

                    const meta = document.createElement('div');
                    meta.className = 'bookmarklet-tool-item-meta';
                    meta.textContent = `Date: ${item.date || 'N/A'}`;

                    rowContent.append(main, meta);

                    const rowLookupBtn = document.createElement('button');
                    rowLookupBtn.type = 'button';
                    rowLookupBtn.className = 'bookmarklet-tool-btn uuid-picker-row-lookup-btn';
                    rowLookupBtn.textContent = 'Lookup';
                    rowLookupBtn.title = 'Check this UUID in Cloud SQL';

                    rowEl.append(rowContent, rowLookupBtn);
                    rowEl.addEventListener('click', async () => {
                        const copied = await copyTextToClipboard(getDisplayValue(item));
                        showToast(copied ? 'Copied.' : 'Copy failed.');
                    });
                    rowLookupBtn.addEventListener('click', (event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        runPickerLookup(item.id).catch(() => undefined);
                    });
                    list.appendChild(rowEl);
                });
            };

            const refreshRowsFromActiveTab = async () => {
                if (refreshInFlight || !bookmarkletToolModal?.classList.contains('is-open')) return;
                refreshInFlight = true;
                try {
                    const activeTab = await getBestBetterLetterTab();
                    if (!activeTab?.id) return;
                    const nextRows = await fetchUuidPickerRows(activeTab.id);
                    const nextSignature = buildRowsSignature(nextRows);
                    if (!nextRows.length && rows.length && activeTab.id === rowsSourceTabId) {
                        emptyRefreshCount += 1;
                        if (emptyRefreshCount < 2) return;
                    } else {
                        emptyRefreshCount = 0;
                    }
                    if (activeTab.id !== rowsSourceTabId || nextSignature !== rowsSignature) {
                        rows = nextRows;
                        rowsSourceTabId = activeTab.id;
                        rowsSignature = nextSignature;
                        render();
                    }
                } catch (error) {
                    // Ignore transient tab changes while the dashboard is still rendering.
                } finally {
                    refreshInFlight = false;
                }
            };

            const handleUuidPickerFocus = () => {
                refreshRowsFromActiveTab().catch(() => undefined);
            };

            searchInput.addEventListener('input', render);
            dateInput.addEventListener('input', render);
            lookupInput.addEventListener('input', pickerLookupController.handleInput);
            lookupInput.addEventListener('focus', pickerLookupController.warm);
            lookupInput.addEventListener('keydown', pickerLookupController.handleKeydown);
            lookupBtn.addEventListener('click', () => pickerLookupController.run({ force: true }).catch(() => undefined));
            lookupStatus.addEventListener('click', handleUuidCardClick);
            batchList.addEventListener('click', handleUuidCardClick);
            batchClearBtn.addEventListener('click', () => {
                clearUuidBatchResults().catch(() => undefined);
                hideUuidBatchResultsFor({ sectionEl: batchSection, listEl: batchList });
            });
            sqlBtn.addEventListener('click', () => setMode('SQL'));
            rawBtn.addEventListener('click', () => setMode('RAW'));
            uuidBtn.addEventListener('click', () => setMode('UUID'));

            copyAllBtn.addEventListener('click', async () => {
                const visibleRows = getVisibleRows();
                if (!visibleRows.length) return showToast('No visible rows.');
                const copied = await copyTextToClipboard(visibleRows.map(getDisplayValue).join(', '));
                showToast(copied ? `Copied ${visibleRows.length} UUIDs.` : 'Copy failed.');
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
            loadPickerBatchResults().catch(() => undefined);
            refreshTimer = window.setInterval(() => {
                refreshRowsFromActiveTab().catch(() => undefined);
            }, 2000);
            window.addEventListener('focus', handleUuidPickerFocus);
            document.addEventListener('visibilitychange', handleUuidPickerFocus);
            bookmarkletToolModalCleanup = () => {
                if (refreshTimer !== null) {
                    window.clearInterval(refreshTimer);
                    refreshTimer = null;
                }
                window.removeEventListener('focus', handleUuidPickerFocus);
                document.removeEventListener('visibilitychange', handleUuidPickerFocus);
            };
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

    const openDocmanGroupsModal = async (target) => {
        try {
            const tab = await getActiveBetterLetterTabForTool();
            if (!tab) return;

            const groups = await fetchDocmanGroups(tab.id);
            if (!groups.length) {
                showToast('No Docman Groups found on the active page.');
                return;
            }

            const resolved = resolveBookmarkletTarget(target, 'Docman Group Names');
            if (!resolved) return;
            const { actionsEl, bodyEl } = resolved;

            const countChip = document.createElement('div');
            countChip.className = 'bookmarklet-tool-chip';
            countChip.textContent = `${groups.length} unique group names`;

            const copyBtn = document.createElement('button');
            copyBtn.type = 'button';
            copyBtn.className = 'bookmarklet-tool-btn';
            copyBtn.textContent = 'Copy All';

            actionsEl?.append(countChip, copyBtn);

            const textarea = document.createElement('textarea');
            textarea.value = groups.join('\n');
            textarea.readOnly = true;
            textarea.style.width = '100%';
            textarea.style.minHeight = '300px';
            textarea.style.resize = 'vertical';
            textarea.style.margin = '0';
            textarea.style.fontFamily = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';
            textarea.style.fontSize = '12px';

            bodyEl?.appendChild(textarea);

            copyBtn.addEventListener('click', async () => {
                const copied = await copyTextToClipboard(textarea.value);
                showToast(copied ? `Copied ${groups.length} group names.` : 'Copy failed.');
            });

            if (!target) {
                textarea.focus();
                textarea.select();
            }
        } catch (error) {
            console.error('Docman groups failed:', error);
            showToast('Docman groups tool failed.');
        }
    };

    const formatEmailEntries = (rawValue, outputMode = 'formatted') => {
        const rawEntries = String(rawValue || '')
            .split(/[\n;,]+/)
            .map((entry) => entry.trim())
            .filter(Boolean);

        const values = rawEntries.map((entry) => {
            const match = entry.match(/<?([\w.-]+@[\w.-]+\.\w+)>?/);
            if (!match?.[1]) return entry;
            const email = match[1].trim();
            const name = extractNameFromEmail(email);
            return outputMode === 'name_only' ? name : `${name} <${email}>`;
        });

        return {
            values,
            output: outputMode === 'name_only' ? values.join(', ') : values.join(',\n')
        };
    };

    const openEmailFormatterModal = (target) => {
        const resolved = resolveBookmarkletTarget(target, 'Email Formatter');
        if (!resolved) return;
        const { actionsEl, bodyEl } = resolved;

        const convertBtn = document.createElement('button');
        convertBtn.type = 'button';
        convertBtn.className = 'bookmarklet-tool-btn active';
        convertBtn.textContent = 'Convert';

        const nameOnlyBtn = document.createElement('button');
        nameOnlyBtn.type = 'button';
        nameOnlyBtn.className = 'bookmarklet-tool-btn';
        nameOnlyBtn.textContent = 'Name Only';

        const copyBtn = document.createElement('button');
        copyBtn.type = 'button';
        copyBtn.className = 'bookmarklet-tool-btn';
        copyBtn.textContent = 'Copy Output';

        const countChip = document.createElement('div');
        countChip.className = 'bookmarklet-tool-chip';
        countChip.textContent = '0 entries';

        actionsEl?.append(convertBtn, nameOnlyBtn, copyBtn, countChip);

        const layout = document.createElement('div');
        layout.className = 'bookmarklet-tool-stack';

        const inputLabel = document.createElement('label');
        inputLabel.className = 'bookmarklet-tool-label';
        inputLabel.textContent = 'Input';

        const inputTextarea = document.createElement('textarea');
        inputTextarea.className = 'bookmarklet-tool-textarea';
        inputTextarea.placeholder = 'Paste email addresses here...';

        const outputLabel = document.createElement('label');
        outputLabel.className = 'bookmarklet-tool-label';
        outputLabel.textContent = 'Output';

        const outputTextarea = document.createElement('textarea');
        outputTextarea.className = 'bookmarklet-tool-textarea';
        outputTextarea.placeholder = 'Converted output will appear here...';
        outputTextarea.readOnly = true;

        layout.append(inputLabel, inputTextarea, outputLabel, outputTextarea);
        bodyEl?.appendChild(layout);

        let outputMode = 'formatted';

        const renderOutput = () => {
            const formatted = formatEmailEntries(inputTextarea.value, outputMode);
            outputTextarea.value = formatted.output;
            countChip.textContent = `${formatted.values.length} ${formatted.values.length === 1 ? 'entry' : 'entries'}`;
        };

        const setMode = (nextMode) => {
            outputMode = nextMode;
            convertBtn.classList.toggle('active', nextMode === 'formatted');
            nameOnlyBtn.classList.toggle('active', nextMode === 'name_only');
            renderOutput();
        };

        convertBtn.addEventListener('click', () => setMode('formatted'));
        nameOnlyBtn.addEventListener('click', () => setMode('name_only'));
        copyBtn.addEventListener('click', async () => {
            if (!outputTextarea.value.trim()) {
                showToast('No output to copy.');
                return;
            }
            try {
                const copied = await copyTextToClipboard(outputTextarea.value);
                showToast(copied ? 'Email list copied.' : 'Copy failed.');
            } catch (error) {
                showToast('Copy failed.');
            }
        });
        inputTextarea.addEventListener('input', renderOutput);

        renderOutput();
        if (!target) inputTextarea.focus();
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

    const isSlackTargetCacheFresh = () => {
        const syncedAtRaw = trimField(linearSlackTargetsCache.syncedAt, 80);
        if (!syncedAtRaw) return false;
        const syncedAtMs = new Date(syncedAtRaw).getTime();
        if (!Number.isFinite(syncedAtMs)) return false;
        return (Date.now() - syncedAtMs) <= LINEAR_SLACK_TARGET_CACHE_STALE_MS;
    };

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

    const syncSlackWorkspaceTargets = async ({ silent = false, force = false } = {}) => {
        if (linearSlackTargetSyncPromise) return linearSlackTargetSyncPromise;

        linearSlackTargetSyncPromise = (async () => {
            if (syncLinearSlackWorkspaceBtn) {
                syncLinearSlackWorkspaceBtn.disabled = true;
                syncLinearSlackWorkspaceBtn.textContent = 'Syncing…';
            }

            try {
                setLinearSlackTargetHint('Syncing Slack workspace targets…', 'neutral');
                const response = await chrome.runtime.sendMessage({
                    action: 'syncLinearSlackWorkspaceTargets',
                    force
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
                if (!silent) showToast('Slack workspace synced.');
            } catch (error) {
                const reason = trimField(error?.message, 260) || 'Could not sync Slack workspace.';
                setLinearSlackTargetHint(reason, 'invalid');
                if (!silent) showToast(reason);
            } finally {
                if (syncLinearSlackWorkspaceBtn) {
                    syncLinearSlackWorkspaceBtn.disabled = false;
                    syncLinearSlackWorkspaceBtn.textContent = 'Sync Slack';
                }
            }
        })();

        try {
            return await linearSlackTargetSyncPromise;
        } finally {
            linearSlackTargetSyncPromise = null;
        }
    };

    const maybeWarmSlackTargetSuggestions = async ({ force = false } = {}) => {
        if (!force && isSlackTargetCacheFresh()) {
            return;
        }

        // Suggestions come from the trigger server via the background bridge.
        // Keep automatic refresh silent so opening the field does not generate
        // extra toasts, while the explicit Sync Slack button still does.
        await syncSlackWorkspaceTargets({ silent: true, force });
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

    const copyLinearDraftField = async (value, emptyMessage, successMessage) => {
        const normalizedValue = trimMultilineField(value, 12000);
        if (!normalizedValue) {
            setLinearSlackStatus(emptyMessage, 'invalid');
            showToast(emptyMessage);
            return;
        }
        const copied = await copyTextToClipboard(normalizedValue);
        if (!copied) {
            setLinearSlackStatus('Copy failed. Try again.', 'invalid');
            showToast('Copy failed.');
            return;
        }
        setLinearSlackStatus(successMessage, 'valid');
        showToast(successMessage);
    };

    const setLinearTriggerStatus = (message, tone = null) => {
        if (!linearTriggerStatus) return;
        const normalizedMessage = String(message || '').trim();
        linearTriggerStatus.classList.remove('neutral', 'valid', 'invalid');
        if (normalizedMessage) {
            if (tone === 'valid') linearTriggerStatus.classList.add('valid');
            else if (tone === 'invalid') linearTriggerStatus.classList.add('invalid');
            else linearTriggerStatus.classList.add('neutral');
        }
        linearTriggerStatus.textContent = normalizedMessage;
        setElementVisible(linearTriggerStatus, Boolean(normalizedMessage));
    };

    const clearLinearTriggerStatusAutoClearTimer = () => {
        if (!linearTriggerStatusClearTimer) return;
        clearTimeout(linearTriggerStatusClearTimer);
        linearTriggerStatusClearTimer = null;
    };

    const scheduleLinearTriggerStatusAutoClear = (run = null) => {
        const runId = trimField(run?.runId, 80);
        if (!runId) return;
        clearLinearTriggerStatusAutoClearTimer();
        linearTriggerStatusClearTimer = window.setTimeout(() => {
            // The background health endpoint keeps the last completed run around, so we
            // remember the dismissed run ID here to avoid immediately repainting it.
            dismissedLinearTriggerRunId = runId;
            setLinearTriggerStatus('', null);
            linearTriggerStatusClearTimer = null;
        }, LINEAR_TRIGGER_STATUS_AUTO_CLEAR_MS);
    };

    const waitForMs = (ms) => new Promise((resolve) => {
        window.setTimeout(resolve, Math.max(0, Number(ms) || 0));
    });

    const setRestartLinearTriggerServerButtonState = (isBusy = false) => {
        if (!restartLinearTriggerServerBtn) return;
        restartLinearTriggerServerBtn.disabled = Boolean(isBusy);
        restartLinearTriggerServerBtn.textContent = isBusy ? 'Restarting…' : 'Restart Trigger Service';
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
        const slack = run?.slackNotification && typeof run.slackNotification === 'object'
            ? run.slackNotification
            : null;
        if (slack?.attempted && slack?.success) {
            const targetType = trimField(slack.targetType, 16) === 'user' ? 'DM' : 'channel';
            summaryLines.push(`Slack sent to ${targetType} ${trimField(slack.target, 80) || trimField(slack.channel, 80) || 'target'}.`);
        } else if (slack?.attempted && !slack?.success) {
            summaryLines.push(`Slack failed: ${trimField(slack.error, 180) || 'notification failed.'}`);
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
            clearLinearTriggerStatusAutoClearTimer();
            setLinearTriggerButtonState('running', activeRun.runType);
            setLinearTriggerStatus(formatLinearTriggerRunSummary(activeRun, true), 'neutral');
            return true;
        }

        setLinearTriggerButtonState('idle');
        if (lastRun) {
            const lastRunId = trimField(lastRun.runId, 80);
            if (lastRunId && dismissedLinearTriggerRunId === lastRunId) {
                setLinearTriggerStatus('', null);
                return false;
            }
            const tone = String(lastRun.status || '').toLowerCase() === 'success' ? 'valid' : 'invalid';
            setLinearTriggerStatus(formatLinearTriggerRunSummary(lastRun, false), tone);
            scheduleLinearTriggerStatusAutoClear(lastRun);
            return false;
        }

        clearLinearTriggerStatusAutoClearTimer();
        setLinearTriggerStatus('Local trigger ready.', 'neutral');
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

    const waitForLinearTriggerServiceReady = async () => {
        let lastError = null;
        for (let attempt = 0; attempt < LINEAR_TRIGGER_RESTART_WAIT_ATTEMPTS; attempt += 1) {
            try {
                await fetchLinearTriggerHealthStatus();
                return true;
            } catch (error) {
                lastError = error;
                await waitForMs(LINEAR_TRIGGER_RESTART_WAIT_INTERVAL_MS);
            }
        }
        throw lastError || new Error('Local trigger service did not come back online.');
    };

    const restartLinearTriggerService = async () => {
        try {
            dismissedLinearTriggerRunId = '';
            clearLinearTriggerStatusAutoClearTimer();
            setRestartLinearTriggerServerButtonState(true);
            setLinearTriggerButtonState('idle');
            setLinearTriggerStatus('Requesting local trigger service restart…', 'neutral');

            const response = await chrome.runtime.sendMessage({
                action: 'restartLinearTriggerServer'
            });

            if (!response?.success) {
                throw new Error(trimField(response?.error, 260) || 'Could not restart local trigger service.');
            }

            setLinearTriggerStatus(
                trimField(response?.message, 240) || 'Restart requested. Waiting for the local trigger service to come back…',
                'neutral'
            );

            await waitForMs(1200);
            await waitForLinearTriggerServiceReady();
            setLinearTriggerStatus('Local trigger service restarted.', 'valid');
            showToast('Trigger service restarted.');
        } catch (error) {
            const message = trimField(error?.message, 260) || 'Could not restart local trigger service.';
            setLinearTriggerStatus(message, 'invalid');
            showToast(message);
        } finally {
            setRestartLinearTriggerServerButtonState(false);
        }
    };

    const triggerLinearBotJobsRun = async () => {
        try {
            const isDryRun = Boolean(triggerLinearDryRunInput?.checked);
            const slack = getLinearSlackPrefsFromForm();
            const slackValidationError = validateLinearSlackPrefs(slack);
            if (slackValidationError) {
                setLinearSlackStatus(slackValidationError, 'invalid');
                throw new Error(slackValidationError);
            }
            dismissedLinearTriggerRunId = '';
            clearLinearTriggerStatusAutoClearTimer();
            await saveLinearSlackPrefs().catch(() => undefined);
            setLinearTriggerButtonState('pending', 'trigger');
            setLinearTriggerStatus(
                isDryRun ? 'Triggering bot-jobs-linear dry run…' : 'Triggering bot-jobs-linear run…',
                'neutral'
            );

            const response = await chrome.runtime.sendMessage({
                action: 'triggerLinearBotJobsRun',
                payload: { dryRun: isDryRun, slack }
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
            const slack = getLinearSlackPrefsFromForm();
            const slackValidationError = validateLinearSlackPrefs(slack);
            if (slackValidationError) {
                setLinearSlackStatus(slackValidationError, 'invalid');
                throw new Error(slackValidationError);
            }
            dismissedLinearTriggerRunId = '';
            clearLinearTriggerStatusAutoClearTimer();
            await saveLinearSlackPrefs().catch(() => undefined);
            setLinearTriggerButtonState('pending', 'reconcile');
            setLinearTriggerStatus(
                isDryRun ? 'Triggering Linear reconcile dry run…' : 'Triggering Linear reconcile run…',
                'neutral'
            );

            const response = await chrome.runtime.sendMessage({
                action: 'triggerLinearReconcileRun',
                payload: { dryRun: isDryRun, slack }
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

    const validateLinearSlackPrefs = (slackPrefs) => {
        if (!slackPrefs?.enabled) return '';
        if (!slackPrefs?.target) {
            return slackPrefs?.targetType === 'user'
                ? 'Slack user ID is required when Slack sync is enabled.'
                : 'Slack channel ID is required when Slack sync is enabled.';
        }
        if (slackPrefs?.targetType === 'user') {
            const userId = extractSlackEntityId(slackPrefs?.target);
            if (!/^U[A-Z0-9]{8,}$/i.test(userId)) {
                return 'Select a synced user suggestion or paste a valid Slack user ID (U...).';
            }
        }
        return '';
    };

    const validateLinearIssuePayload = (payload) => {
        const normalizedTitle = String(payload?.title || '').trim();
        const failedJobId = String(payload?.failedJobId || '').trim();
        const canSkipDocumentId = /^Bot Job Error:/i.test(normalizedTitle)
            || /^Practice Support Ticket:/i.test(normalizedTitle)
            || Boolean(failedJobId);
        if (!payload.documentId && !canSkipDocumentId) return 'Generate details first so Document ID is included.';
        if (!payload.title) return 'Issue title is required.';
        if (!payload.description) return 'Issue description is required.';
        const slackValidationError = validateLinearSlackPrefs(payload?.slack);
        if (slackValidationError) return slackValidationError;
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

    const createWorkflowUiContext = (elements = {}) => ({
        namesInput: elements.namesInput || null,
        skipDuplicatesInput: elements.skipDuplicatesInput || null,
        titleCaseInput: elements.titleCaseInput || null,
        statusEl: elements.statusEl || null,
        progressTrackEl: elements.progressTrackEl || null,
        progressBarEl: elements.progressBarEl || null,
        runButtonEl: elements.runButtonEl || null
    });

    let workflowRunState = {
        running: false,
        startedAt: 0,
        total: 0,
        uiContext: null
    };

    const updateWorkflowStatus = (uiContext, message, tone = null) => {
        const statusEl = uiContext?.statusEl;
        if (!statusEl) return;
        statusEl.classList.remove('neutral', 'valid', 'invalid');
        if (tone === 'valid') statusEl.classList.add('valid');
        else if (tone === 'invalid') statusEl.classList.add('invalid');
        else statusEl.classList.add('neutral');
        statusEl.textContent = message;
    };

    const updateWorkflowProgress = (uiContext, current, total) => {
        const progressTrackEl = uiContext?.progressTrackEl;
        const progressBarEl = uiContext?.progressBarEl;
        if (!progressTrackEl || !progressBarEl) return;
        progressTrackEl.style.display = 'block';
        const boundedTotal = Math.max(total || 0, 1);
        const ratio = Math.min(Math.max(current, 0), boundedTotal) / boundedTotal;
        progressBarEl.style.width = `${Math.round(ratio * 100)}%`;

        if (!workflowRunState.running) return;

        const elapsed = Date.now() - workflowRunState.startedAt;
        const avgPerItem = elapsed / Math.max(current, 1);
        const remaining = Math.round(avgPerItem * (workflowRunState.total - current));
        updateWorkflowStatus(uiContext, `Creating ${current} / ${workflowRunState.total}… · ETA ${formatEta(remaining)}`);
    };

    try {
        const runtimeOnMessage = chrome?.runtime?.onMessage;
        if (runtimeOnMessage?.addListener) {
            runtimeOnMessage.addListener((message) => {
                if (!workflowRunState.running) return;
                if (message?.type === 'BL_WORKFLOW_PROGRESS') {
                    updateWorkflowProgress(workflowRunState.uiContext, message.current, message.total);
                }
            });
        } else {
            console.warn('[Panel] chrome.runtime.onMessage unavailable; live workflow progress listener not attached.');
        }
    } catch (error) {
        console.warn('[Panel] Unable to attach workflow progress listener:', error);
    }

    const runBulkWorkflowCreation = async (uiContext) => {
        const names = parseWorkflowNames(uiContext?.namesInput?.value);
        if (!names.length) {
            updateWorkflowStatus(uiContext, 'Paste at least one workflow group name first.', 'invalid');
            return;
        }

        if (names.length > 30) {
            const ok = window.confirm(`You are about to create ${names.length} workflow groups. Continue?`);
            if (!ok) return;
        }

        try {
            if (uiContext?.runButtonEl) {
                uiContext.runButtonEl.disabled = true;
                uiContext.runButtonEl.textContent = 'Running…';
            }
            workflowRunState = { running: true, startedAt: Date.now(), total: names.length, uiContext };
            updateWorkflowStatus(uiContext, `Starting… (0 / ${names.length})`);
            updateWorkflowProgress(uiContext, 0, names.length);

            chrome.storage.sync.set({
                workflowSkipDuplicates: uiContext?.skipDuplicatesInput?.checked ?? true,
                workflowTitleCase: uiContext?.titleCaseInput?.checked ?? false
            });

            const tab = await getBestBetterLetterTab();
            if (!tab?.id) {
                updateWorkflowStatus(uiContext, 'Open a BetterLetter tab first.', 'invalid');
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
                        skipDuplicates: uiContext?.skipDuplicatesInput?.checked ?? true,
                        titleCase: uiContext?.titleCaseInput?.checked ?? false
                    }
                }]
            });

            const res = result?.[0]?.result;
            if (res?.ok) {
                updateWorkflowStatus(uiContext, `Done ✅
Created: ${res.created}
Skipped: ${res.skipped}
Errors: ${res.errors.length}`, res.errors.length ? 'neutral' : 'valid');
                updateWorkflowProgress(uiContext, names.length, names.length);
                if (res.errors.length) {
                    console.warn('[Workflow bulk] Errors:', res.errors);
                } else if (uiContext?.namesInput) {
                    uiContext.namesInput.value = '';
                }
            } else {
                updateWorkflowStatus(uiContext, `Failed ❌
${res?.error || 'Unknown error'}`, 'invalid');
            }
        } catch (error) {
            console.error('Bulk workflow creation failed:', error);
            updateWorkflowStatus(uiContext, `Error ❌
${error?.message || String(error)}`, 'invalid');
        } finally {
            workflowRunState.running = false;
            workflowRunState.uiContext = null;
            if (uiContext?.runButtonEl) {
                uiContext.runButtonEl.disabled = false;
                uiContext.runButtonEl.textContent = 'Run Bulk Create';
            }
        }
    };

    const openWorkflowGroupsModal = async (target) => {
        const resolved = resolveBookmarkletTarget(target, 'Custom Workflow Groups');
        if (!resolved) return;
        const { actionsEl, bodyEl } = resolved;

        const runBtn = document.createElement('button');
        runBtn.type = 'button';
        runBtn.className = 'bookmarklet-tool-btn active';
        runBtn.textContent = 'Run Bulk Create';

        const testParseBtn = document.createElement('button');
        testParseBtn.type = 'button';
        testParseBtn.className = 'bookmarklet-tool-btn';
        testParseBtn.textContent = 'Test Parse';

        actionsEl?.append(runBtn, testParseBtn);

        const layout = document.createElement('div');
        layout.className = 'bookmarklet-tool-stack';

        const namesLabel = document.createElement('label');
        namesLabel.className = 'bookmarklet-tool-label';
        namesLabel.textContent = 'Paste workflow names (one per line, or paste Airtable rows)';

        const namesInput = document.createElement('textarea');
        namesInput.className = 'bookmarklet-tool-textarea';
        namesInput.placeholder = 'e.g.\nJohn Smith\nMike Drinkwater';

        const optionsWrap = document.createElement('div');
        optionsWrap.className = 'bookmarklet-tool-checklist';

        const skipLabel = document.createElement('label');
        const skipInput = document.createElement('input');
        skipInput.type = 'checkbox';
        skipInput.checked = true;
        skipLabel.append(skipInput, document.createTextNode(' Skip existing workflow names'));

        const titleCaseLabel = document.createElement('label');
        const titleCaseInput = document.createElement('input');
        titleCaseInput.type = 'checkbox';
        titleCaseInput.checked = false;
        titleCaseLabel.append(titleCaseInput, document.createTextNode(' Convert names to Title Case'));

        optionsWrap.append(skipLabel, titleCaseLabel);

        const statusEl = document.createElement('div');
        statusEl.className = 'validation-badge neutral bookmarklet-tool-status';
        statusEl.textContent = 'Ready.';

        const progressTrackEl = document.createElement('div');
        progressTrackEl.className = 'bookmarklet-tool-progress';
        const progressBarEl = document.createElement('div');
        progressBarEl.className = 'bookmarklet-tool-progress-bar';
        progressTrackEl.appendChild(progressBarEl);

        layout.append(namesLabel, namesInput, optionsWrap, statusEl, progressTrackEl);
        bodyEl?.appendChild(layout);

        const uiContext = createWorkflowUiContext({
            namesInput,
            skipDuplicatesInput: skipInput,
            titleCaseInput: titleCaseInput,
            statusEl,
            progressTrackEl,
            progressBarEl,
            runButtonEl: runBtn
        });

        try {
            const saved = await chrome.storage.sync.get({ workflowSkipDuplicates: true, workflowTitleCase: false });
            skipInput.checked = Boolean(saved.workflowSkipDuplicates);
            titleCaseInput.checked = Boolean(saved.workflowTitleCase);
        } catch (error) {
            console.warn('Failed to load workflow settings:', error);
        }

        namesInput.addEventListener('input', () => {
            const parsed = parseWorkflowNames(namesInput.value);
            updateWorkflowStatus(uiContext, parsed.length ? `${parsed.length} workflow names parsed.` : 'Ready.');
        });

        testParseBtn.addEventListener('click', () => {
            const parsed = parseWorkflowNames(namesInput.value);
            if (!parsed.length) {
                updateWorkflowStatus(uiContext, 'No workflow names parsed.', 'invalid');
                return;
            }
            updateWorkflowStatus(uiContext, `Parsed ${parsed.length} names\n- ${parsed.slice(0, 12).join('\n- ')}${parsed.length > 12 ? '\n...' : ''}`);
        });

        runBtn.addEventListener('click', () => {
            runBulkWorkflowCreation(uiContext).catch((error) => {
                console.error('Workflow modal run failed:', error);
            });
        });

        if (!target) namesInput.focus();
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

    if (!isServerlessLiteMode) {
        await loadSlackTargetCache();
    }
    await loadLinearSlackPrefs();
    if (linearSlackNotifyEnabledInput?.checked) {
        maybeWarmSlackTargetSuggestions().catch(() => undefined);
    }

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

    copyLinearIssueTitleBtn?.addEventListener('click', () => {
        copyLinearDraftField(
            linearIssueTitleInput?.value,
            'Generate details first so there is a title to copy.',
            'Linear issue title copied.'
        ).catch(() => undefined);
    });

    copyLinearIssueDescriptionBtn?.addEventListener('click', () => {
        copyLinearDraftField(
            linearIssueDescriptionInput?.value,
            'Generate details first so there is a description to copy.',
            'Linear issue description copied.'
        ).catch(() => undefined);
    });

    linearIssueSourceInput?.addEventListener('input', () => {
        linearIssueContext = null;
    });

    syncLinearSlackWorkspaceBtn?.addEventListener('click', () => {
        syncSlackWorkspaceTargets({ force: true }).catch(() => undefined);
    });
    linearSlackNotifyEnabledInput?.addEventListener('change', () => {
        updateLinearSlackTargetUi();
        saveLinearSlackPrefs().catch(() => undefined);
        if (linearSlackNotifyEnabledInput.checked) {
            maybeWarmSlackTargetSuggestions().catch(() => undefined);
        }
    });
    linearSlackTargetTypeInput?.addEventListener('change', () => {
        const targetType = normalizeSlackTargetType(linearSlackTargetTypeInput?.value);
        const resolvedTargetId = resolveSlackTargetIdFromInput(linearSlackTargetInput?.value, targetType);
        if (resolvedTargetId && linearSlackTargetInput) {
            linearSlackTargetInput.value = formatSlackTargetDisplayValue(resolvedTargetId, targetType) || resolvedTargetId;
        }
        updateLinearSlackTargetUi();
        saveLinearSlackPrefs().catch(() => undefined);
        maybeWarmSlackTargetSuggestions().catch(() => undefined);
    });
    linearSlackTargetInput?.addEventListener('focus', () => {
        maybeWarmSlackTargetSuggestions().catch(() => undefined);
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
    restartLinearTriggerServerBtn?.addEventListener('click', () => {
        restartLinearTriggerService().catch(() => {
            setLinearTriggerStatus('Could not restart local trigger service.', 'invalid');
            showToast('Could not restart local trigger service.');
        });
    });
    const updateTriggerServerSecretRowVisibility = () => {
        if (!triggerServerSecretRow) return;
        triggerServerSecretRow.style.display = triggerServerBaseUrl === DEFAULT_TRIGGER_SERVER_BASE_URL ? 'none' : 'block';
    };
    const refreshTriggerServerSecretStatus = async () => {
        if (!triggerServerSecretStatus) return;
        try {
            const response = await chrome.runtime.sendMessage({ action: 'getTriggerServerHasSecret' });
            triggerServerSecretStatus.textContent = response?.hasSecret
                ? 'A secret is set for this server.'
                : "No secret set - only fine if that server's own secret isn't required either.";
        } catch (error) {
            triggerServerSecretStatus.textContent = 'No secret set.';
        }
    };
    if (triggerServerBaseUrlInput) {
        triggerServerBaseUrlInput.value = triggerServerBaseUrl === DEFAULT_TRIGGER_SERVER_BASE_URL ? '' : triggerServerBaseUrl;
        if (triggerServerBaseUrlStatus) {
            triggerServerBaseUrlStatus.textContent = triggerServerBaseUrl === DEFAULT_TRIGGER_SERVER_BASE_URL
                ? "Using this machine's own trigger server."
                : `Using trigger server at ${triggerServerBaseUrl}.`;
        }
        updateTriggerServerSecretRowVisibility();
        refreshTriggerServerSecretStatus().catch(() => undefined);
    }
    saveTriggerServerBaseUrlBtn?.addEventListener('click', async () => {
        const rawValue = String(triggerServerBaseUrlInput?.value || '').trim();
        saveTriggerServerBaseUrlBtn.disabled = true;
        try {
            const response = await chrome.runtime.sendMessage({
                action: 'setTriggerServerBaseUrl',
                payload: { baseUrl: rawValue }
            });
            if (!response?.success) {
                const message = response?.error || 'Could not save trigger server address.';
                if (triggerServerBaseUrlStatus) {
                    triggerServerBaseUrlStatus.textContent = message;
                    triggerServerBaseUrlStatus.className = 'validation-badge invalid';
                }
                showToast(message);
                return;
            }
            await refreshTriggerServerBaseUrl();
            if (triggerServerBaseUrlStatus) {
                triggerServerBaseUrlStatus.textContent = triggerServerBaseUrl === DEFAULT_TRIGGER_SERVER_BASE_URL
                    ? "Saved. Using this machine's own trigger server."
                    : `Saved. Using trigger server at ${triggerServerBaseUrl}.`;
                triggerServerBaseUrlStatus.className = 'validation-badge valid';
            }
            updateTriggerServerSecretRowVisibility();
            showToast('Trigger server address saved.');
        } catch (error) {
            if (triggerServerBaseUrlStatus) {
                triggerServerBaseUrlStatus.textContent = 'Could not save trigger server address.';
                triggerServerBaseUrlStatus.className = 'validation-badge invalid';
            }
            showToast('Could not save trigger server address.');
        } finally {
            saveTriggerServerBaseUrlBtn.disabled = false;
        }
    });
    saveTriggerServerSecretBtn?.addEventListener('click', async () => {
        // Never pre-filled with the current secret (so it's never re-displayed
        // in plain text on load), so an empty field here just means "leave it
        // unchanged" rather than "clear it" - use the Clear button for that.
        const rawValue = String(triggerServerSecretInput?.value || '').trim();
        if (!rawValue) {
            showToast('Type a secret first, or use Clear to remove it.');
            return;
        }
        saveTriggerServerSecretBtn.disabled = true;
        try {
            const response = await chrome.runtime.sendMessage({
                action: 'setTriggerServerSecret',
                payload: { secret: rawValue }
            });
            if (!response?.success) {
                const message = response?.error || 'Could not save trigger server secret.';
                showToast(message);
                return;
            }
            await refreshTriggerServerSecret();
            await refreshTriggerServerSecretStatus();
            triggerServerSecretInput.value = '';
            showToast('Trigger server secret saved.');
        } catch (error) {
            showToast('Could not save trigger server secret.');
        } finally {
            saveTriggerServerSecretBtn.disabled = false;
        }
    });
    clearTriggerServerSecretBtn?.addEventListener('click', async () => {
        clearTriggerServerSecretBtn.disabled = true;
        try {
            const response = await chrome.runtime.sendMessage({
                action: 'setTriggerServerSecret',
                payload: { secret: '' }
            });
            if (!response?.success) {
                showToast(response?.error || 'Could not clear trigger server secret.');
                return;
            }
            await refreshTriggerServerSecret();
            await refreshTriggerServerSecretStatus();
            if (triggerServerSecretInput) triggerServerSecretInput.value = '';
            showToast('Trigger server secret cleared.');
        } catch (error) {
            showToast('Could not clear trigger server secret.');
        } finally {
            clearTriggerServerSecretBtn.disabled = false;
        }
    });
    if (!isServerlessLiteMode) {
        const isLinearRunActiveOnLoad = await pollLinearTriggerStatus({ silent: true });
        if (isLinearRunActiveOnLoad) {
            startLinearTriggerStatusPolling();
        }
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

    uuidLookupInput?.addEventListener('input', jobPanelUuidLookupController.handleInput);
    uuidLookupInput?.addEventListener('focus', jobPanelUuidLookupController.warm);
    uuidLookupInput?.addEventListener('keydown', jobPanelUuidLookupController.handleKeydown);
    const handleUuidCardClick = async (event) => {
        if (!(event.target instanceof Element)) return;

        const openLinkTarget = event.target.closest('[data-uuid-open-link]');
        if (openLinkTarget) {
            event.preventDefault();
            const url = String(openLinkTarget.getAttribute('data-uuid-open-link') || '').trim();
            if (url) openTabWithTimeout(url);
            return;
        }

        const copyTarget = event.target.closest('[data-copy-value]');
        if (copyTarget) {
            event.preventDefault();
            const value = String(copyTarget.getAttribute('data-copy-value') || '').trim();
            const label = String(copyTarget.getAttribute('data-copy-label') || 'Value').trim();
            if (!value) return;
            const copied = await copyTextToClipboard(value);
            showToast(copied ? `${label} copied.` : `Could not copy ${label.toLowerCase()}.`);
        }
    };
    uuidLookupStatus?.addEventListener('click', handleUuidCardClick);
    uuidBatchResultsList?.addEventListener('click', handleUuidCardClick);
    uuidBatchResultsClearBtn?.addEventListener('click', () => {
        clearUuidBatchResults().catch(() => undefined);
    });
    loadUuidBatchResults().catch(() => undefined);
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes[UUID_BATCH_RESULTS_STORAGE_KEY]) {
            const batch = changes[UUID_BATCH_RESULTS_STORAGE_KEY].newValue || null;
            if (batch && !isUuidBatchFresh(batch)) {
                clearUuidBatchResults().catch(() => undefined);
                return;
            }
            renderUuidBatchResults(batch);
        }
    });
    docmanToolStatus?.addEventListener('click', async (event) => {
        const target = event.target instanceof Element
            ? event.target.closest('[data-docman-copy-matches]')
            : null;
        if (!target) return;
        event.preventDefault();
        const rawValue = String(target.getAttribute('data-docman-copy-matches') || '');
        const copied = await copyTextToClipboard(rawValue);
        showToast(copied ? 'Docman matches copied.' : 'Could not copy Docman matches.');
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

    Navigator.setDocmanActionHandler((action) => {
        switch (action) {
            case 'login':
                startPracticeScopedDocmanAction('login').catch(() => undefined);
                break;
            case 'verify':
                openDocmanVerifyModal();
                break;
            case 'create-group':
                openDocmanCreateGroupModal();
                break;
            case 'clean-processing':
                startPracticeScopedDocmanAction('clean-processing').catch(() => undefined);
                break;
            case 'clean-filing':
                startPracticeScopedDocmanAction('clean-filing').catch(() => undefined);
                break;
            case 'onboarding':
                openDocmanOnboardingModal().catch((error) => {
                    console.error('Docman onboarding modal failed:', error);
                    showToast('Docman onboarding failed to open.');
                });
                break;
            default:
                break;
        }
    });
    runUuidPickerToolBtn?.addEventListener('click', openUuidPickerModal);
    runListDocmanGroupsToolBtn?.addEventListener('click', () => openDocmanGroupsModal());
    runEmailFormatterToolBtn?.addEventListener('click', () => openEmailFormatterModal());
    runWorkflowGroupsToolBtn?.addEventListener('click', () => {
        openWorkflowGroupsModal().catch((error) => {
            console.error('Failed to open workflow groups modal:', error);
            showToast('Workflow Groups failed to open.');
        });
    });

    pollDocmanToolStatus({ silent: true }).catch(() => undefined);

    updateDocValidation();
    updateJobValidation();
    updateBulkValidation();
    await loadRecentIds();
    await syncDashboardSuggestionRows({ silent: true });

    // J. Global UI Listeners
    document.addEventListener("mousedown", (e) => {
        // List of all inputs that should NOT hide the dropdown when clicked
        const safeInputs = [
            'manualDocId',
            'jobStatusInput'
        ];

        const isInput = safeInputs.includes(e.target.id);
        const isList = e.target.closest('ul') || e.target.closest('.custom-autocomplete-results');
        // .search-container wraps just the practice input, its reset button,
        // and the suggestion list, not the label/icon row or recent-practice
        // chips above/below it, so clicks there still close the dropdown.
        const isWithinPracticeSearch = e.target.closest('.search-container');

        // ONLY hide if the click was NOT on an input and NOT on the list itself
        if (!isInput && !isList && !isWithinPracticeSearch) {
            hideSuggestions();
        }
    });

    await tryAutoSelectPracticeFromActiveTab();

    showView(PANEL_FORCED_VIEW_ID || 'practiceNavigatorView');

    if (PANEL_FORCED_TOOL_ID === 'uuidPicker') {
        openUuidPickerModal();
    }

    if (isBookmarkletToolsSuite) {
        openWorkflowGroupsModal({
            actionsEl: document.getElementById('inlineWorkflowGroupsActions'),
            bodyEl: document.getElementById('inlineWorkflowGroupsBody')
        }).catch((error) => {
            console.error('Failed to load Custom Workflow Groups:', error);
        });
    }
    if (isBookmarkletToolsSuite) {
        openDocmanGroupsModal({
            actionsEl: document.getElementById('inlineDocmanGroupsActions'),
            bodyEl: document.getElementById('inlineDocmanGroupsBody')
        });
    }
    if (isBookmarkletToolsSuite) {
        openEmailFormatterModal({
            actionsEl: document.getElementById('inlineEmailFormatterActions'),
            bodyEl: document.getElementById('inlineEmailFormatterBody')
        });
    }

    // B. Initial Data Load (non-blocking so top navigation responds immediately)
    try {
        const cache = await syncPracticeCache();
        await Navigator.initializeRecentPractices();
        const cacheSize = Object.keys(cache || {}).length;

        if (cacheSize === 0) {
            // Compatibility fallback when background returns cache without scrape refresh
            const response = await chrome.runtime.sendMessage({
                action: 'getPracticeCache',
                ...getProtectedActionPayload()
            });
            if (response && response.practiceCache) {
                setCachedPractices(response.practiceCache);
                return;
            }
        }

        await tryAutoSelectPracticeFromActiveTab();
    } catch (e) { console.error("Cache load error:", e); }
    } catch (error) {
        panelInitializationStarted = false;
        console.error('Panel initialization failed:', error);
        showToast('Extension runtime refreshed. Close and reopen the panel.');
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        initializePanel().catch((error) => {
            console.error('Panel startup failure:', error);
        });
    }, { once: true });
} else {
    initializePanel().catch((error) => {
        console.error('Panel startup failure:', error);
    });
}

// --- G. SILENT AUTO-SCAN LOGIC ---
let isPanelScrapingBusy = false;
let lastBackgroundRefreshAt = 0;

setInterval(async () => {
  const navView = document.getElementById('practiceNavigatorView');
  const isVisible = navView && navView.style.display !== 'none';
  
  // 🛡️ NEW SAFETY: Don't scan if the user is currently typing in the search box
  const isTyping = document.activeElement === document.getElementById('practiceInput');
  const isInteractingWithStatus = Navigator.shouldPauseStatusAutoRefresh();
  
  if (isVisible && !isPanelScrapingBusy && state.currentSelectedOdsCode && !isTyping && !isInteractingWithStatus) {
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

// Only the search input shows by default; Practice Tools and Quick Document
// Search are collapsed behind their own accordion toggles, each adding to the
// window height only while expanded.
let compactModeMovedElements = null;
let compactAccordionsBound = false;

function resizePanelWindow(height) {
  if (window.top !== window) return;
  try {
    window.resizeTo(PANEL_WIDTH, height);
  } catch (e) {
    // Ignore resize errors in contexts that disallow script-driven resize.
  }
}

// Measures the actually-rendered content instead of guessing fixed heights
// per accordion state, so nothing gets clipped regardless of platform
// title-bar height or small layout differences. Runs on the next frame so
// the browser has applied any hidden/appendChild change first.
function resizeToFitCompactContent() {
  if (window.top !== window) return;
  requestAnimationFrame(() => {
    const contentHeight = document.body.scrollHeight;
    const chromeHeight = Math.max(0, window.outerHeight - window.innerHeight);
    resizePanelWindow(contentHeight + chromeHeight + 20);
  });
}

function setCompactAccordionExpanded(toggleId, bodyId, expanded) {
  const toggleBtn = document.getElementById(toggleId);
  const body = document.getElementById(bodyId);
  if (!toggleBtn || !body) return;
  body.hidden = !expanded;
  toggleBtn.classList.toggle('is-expanded', expanded);
  resizeToFitCompactContent();
}

function setupCompactAccordions() {
  if (compactAccordionsBound) return;
  compactAccordionsBound = true;
  [
    ['compactPracticeToolsToggle', 'compactPracticeToolsBody'],
    ['compactQuickDocToggle', 'compactQuickDocBody'],
    ['compactUuidLookupToggle', 'compactUuidLookupBody']
  ].forEach(([toggleId, bodyId]) => {
    const toggleBtn = document.getElementById(toggleId);
    if (!toggleBtn) return;
    toggleBtn.addEventListener('click', () => {
      const body = document.getElementById(bodyId);
      setCompactAccordionExpanded(toggleId, bodyId, Boolean(body?.hidden));
    });
  });
}

const COMPACT_MODE_STORAGE_KEY = 'mailroomNavigatorCompactMode';

function saveCompactModePreference(isCompact) {
  try {
    chrome.storage.local.set({ [COMPACT_MODE_STORAGE_KEY]: isCompact });
  } catch (error) {
    // Ignore storage errors; compact mode just won't be remembered next time.
  }
}

async function loadCompactModePreference() {
  try {
    const result = await chrome.storage.local.get(COMPACT_MODE_STORAGE_KEY);
    return result?.[COMPACT_MODE_STORAGE_KEY] === true;
  } catch (error) {
    return false;
  }
}

const DARK_MODE_STORAGE_KEY = 'mailroomNavigatorDarkMode';
const darkModeMediaQuery = typeof window.matchMedia === 'function'
  ? window.matchMedia('(prefers-color-scheme: dark)')
  : null;

function systemPrefersDarkMode() {
  return Boolean(darkModeMediaQuery?.matches);
}

// This document's own dark-mode filter can't reach sibling docked-handle
// iframes (each is a separate document) or the host-page-level rail
// background.js injects into a completely separate document. Broadcasting
// through background.js restyles the rail immediately and reaches every
// other panel.html instance via its own runtime.onMessage listener below,
// instead of each one waiting for its next load to notice the change.
// persist=false (a system-theme change, not a manual click) restyles
// everything live without locking in an explicit preference, so the
// extension keeps following the OS/Chrome theme afterward.
function broadcastDarkModePreference(isDark, persist) {
  try {
    chrome.runtime.sendMessage({
      action: 'setDarkModePreference',
      payload: { isDark, persist }
    }).catch(() => undefined);
  } catch (error) {
    // Background script may not be reachable; the stored preference still
    // applies next time each panel loads.
  }
}

function saveDarkModePreference(isDark) {
  try {
    chrome.storage.local.set({ [DARK_MODE_STORAGE_KEY]: isDark });
  } catch (error) {
    // Ignore storage errors; dark mode just won't be remembered next time.
  }
  broadcastDarkModePreference(isDark, true);
}

// Returns true/false only once the user has explicitly chosen a mode via the
// toggle; null means no explicit choice has been made yet, in which case
// callers should fall back to the OS/Chrome theme instead of defaulting to
// light.
async function loadExplicitDarkModePreference() {
  try {
    const result = await chrome.storage.local.get(DARK_MODE_STORAGE_KEY);
    return typeof result?.[DARK_MODE_STORAGE_KEY] === 'boolean' ? result[DARK_MODE_STORAGE_KEY] : null;
  } catch (error) {
    return null;
  }
}

function applyDarkMode(isDark) {
  document.body.classList.toggle('bl-dark-mode', isDark);
  const toggleBtn = document.getElementById('darkModeToggleBtn');
  if (!toggleBtn) return;
  toggleBtn.classList.toggle('is-dark', isDark);
  const label = isDark ? 'Switch to light mode' : 'Switch to dark mode';
  toggleBtn.title = label;
  toggleBtn.setAttribute('aria-label', label);
}

function setupDarkModeToggle() {
  loadExplicitDarkModePreference()
    .then((explicit) => applyDarkMode(explicit === null ? systemPrefersDarkMode() : explicit))
    .catch(() => undefined);

  const toggleBtn = document.getElementById('darkModeToggleBtn');
  toggleBtn?.addEventListener('click', () => {
    const isDark = !document.body.classList.contains('bl-dark-mode');
    applyDarkMode(isDark);
    saveDarkModePreference(isDark);
  });

  // Follow the OS/Chrome theme live as long as the user hasn't explicitly
  // chosen a mode themselves - re-checking storage fresh each time in case
  // another panel set an explicit preference since this one loaded.
  darkModeMediaQuery?.addEventListener?.('change', (event) => {
    loadExplicitDarkModePreference().then((explicit) => {
      if (explicit !== null) return;
      applyDarkMode(event.matches);
      broadcastDarkModePreference(event.matches, false);
    }).catch(() => undefined);
  });
}

// Every panel.html instance (docked iframes on any tab, or the standalone
// popup window) listens for this so dark mode is a single global setting -
// toggling it anywhere applies everywhere immediately, not just wherever it
// was clicked.
try {
  chrome.runtime.onMessage?.addListener?.((message) => {
    if (message?.action !== 'setDarkModePreference') return;
    applyDarkMode(Boolean(message.payload?.isDark));
  });
} catch (error) {
  console.warn('[Panel] Unable to attach dark-mode sync listener:', error);
}

// Reopening the popup via the extension icon reuses an already-open window
// (just refocusing it) instead of reloading, so this window won't otherwise
// re-check the saved preference; background.js asks it to sync explicitly.
try {
  chrome.runtime.onMessage?.addListener?.((message) => {
    if (message?.type !== 'BL_SYNC_COMPACT_MODE' || window.top !== window) return;
    loadCompactModePreference().then((shouldBeCompact) => {
      const isCurrentlyCompact = Boolean(compactModeMovedElements);
      if (shouldBeCompact && !isCurrentlyCompact) {
        enterCompactMode();
      } else if (!shouldBeCompact && isCurrentlyCompact) {
        exitCompactMode();
      }
    }).catch(() => undefined);
  });
} catch (error) {
  console.warn('[Panel] Unable to attach compact-mode sync listener:', error);
}

// Relocates the existing practice-search block, its quick-link buttons, and
// the Quick Document Search card (with all their working autocomplete/lookup
// behavior intact, since moving a DOM node keeps its listeners) into a small
// standalone bar, instead of building a second copy of that search logic.
// Only the search input shows right away; the rest lives behind the two
// accordions above, collapsed until the user asks for them.
function enterCompactMode() {
  const bar = document.getElementById('compactSearchBar');
  const toggleBtn = document.getElementById('compactModeToggleBtn');
  const practiceSearchBlock = document.getElementById('practiceSearchBlock');
  const recentPracticesSection = document.getElementById('recentPracticesSection');
  const practiceQuickLinks = document.querySelector('.nav-action-grid');
  const practiceDetails = document.getElementById('statusDisplay');
  const quickDocumentSearchCard = document.querySelector('.quick-document-card');
  const uuidLookupSection = document.getElementById('uuidLookupSection');
  const practiceToolsAccordion = document.getElementById('compactPracticeToolsAccordion');
  const practiceToolsBody = document.getElementById('compactPracticeToolsBody');
  const practiceDetailsSlot = document.getElementById('compactPracticeDetailsSlot');
  const quickDocAccordion = document.getElementById('compactQuickDocAccordion');
  const quickDocBody = document.getElementById('compactQuickDocBody');
  const uuidLookupAccordion = document.getElementById('compactUuidLookupAccordion');
  const uuidLookupBody = document.getElementById('compactUuidLookupBody');
  if (!bar || !practiceSearchBlock || !quickDocumentSearchCard) return;

  setupCompactAccordions();

  const toMoveIntoPracticeTools = [recentPracticesSection, practiceQuickLinks].filter(Boolean);
  const toMoveIntoPracticeDetails = [practiceDetails].filter(Boolean);
  const toMoveIntoQuickDoc = [quickDocumentSearchCard].filter(Boolean);
  const toMoveIntoUuidLookup = [uuidLookupSection].filter(Boolean);
  const allMoved = [
    practiceSearchBlock,
    ...toMoveIntoPracticeTools,
    ...toMoveIntoPracticeDetails,
    ...toMoveIntoQuickDoc,
    ...toMoveIntoUuidLookup
  ];
  compactModeMovedElements = allMoved.map((el) => ({ el, parent: el.parentNode, nextSibling: el.nextSibling }));

  bar.insertBefore(practiceSearchBlock, bar.firstChild);
  toMoveIntoPracticeTools.forEach((el) => practiceToolsBody?.appendChild(el));
  toMoveIntoPracticeDetails.forEach((el) => practiceDetailsSlot?.appendChild(el));
  toMoveIntoQuickDoc.forEach((el) => quickDocBody?.appendChild(el));
  toMoveIntoUuidLookup.forEach((el) => uuidLookupBody?.appendChild(el));

  if (practiceToolsAccordion) practiceToolsAccordion.hidden = false;
  if (quickDocAccordion) quickDocAccordion.hidden = false;
  if (uuidLookupAccordion) uuidLookupAccordion.hidden = false;
  setCompactAccordionExpanded('compactPracticeToolsToggle', 'compactPracticeToolsBody', false);
  setCompactAccordionExpanded('compactQuickDocToggle', 'compactQuickDocBody', false);
  setCompactAccordionExpanded('compactUuidLookupToggle', 'compactUuidLookupBody', false);

  document.body.classList.add('bl-panel-compact');
  setElementVisible(bar, true, 'flex');
  if (toggleBtn) {
    toggleBtn.title = 'Show the full panel';
    toggleBtn.setAttribute('aria-label', 'Show the full panel');
    toggleBtn.classList.add('is-expanded');
  }
  saveCompactModePreference(true);
  resizeToFitCompactContent();
}

// #statusDisplay (Practice Details) shows/hides itself based on whether a
// practice is selected - no accordion to expand here, just keep the
// floating window sized to match as that content appears or disappears.
function resizeCompactModeForPracticeDetails() {
  if (!compactModeMovedElements) return;
  resizeToFitCompactContent();
}

function exitCompactMode() {
  if (!compactModeMovedElements) return;
  // Restore in reverse order: if two moved elements were originally adjacent
  // siblings, a later element's recorded nextSibling may point at an earlier
  // one still sitting in the compact bar. Restoring back-to-front guarantees
  // that reference is already back in its real parent by the time we need it.
  [...compactModeMovedElements].reverse().forEach(({ el, parent, nextSibling }) => {
    if (nextSibling && nextSibling.parentNode === parent) {
      parent.insertBefore(el, nextSibling);
    } else {
      parent.appendChild(el);
    }
  });
  compactModeMovedElements = null;

  const practiceToolsAccordion = document.getElementById('compactPracticeToolsAccordion');
  const quickDocAccordion = document.getElementById('compactQuickDocAccordion');
  if (practiceToolsAccordion) practiceToolsAccordion.hidden = true;
  if (quickDocAccordion) quickDocAccordion.hidden = true;

  document.body.classList.remove('bl-panel-compact');
  const bar = document.getElementById('compactSearchBar');
  setElementVisible(bar, false);
  const toggleBtn = document.getElementById('compactModeToggleBtn');
  if (toggleBtn) {
    toggleBtn.title = 'Shrink to a small search-only bar';
    toggleBtn.setAttribute('aria-label', 'Shrink to a small search-only bar');
    toggleBtn.classList.remove('is-expanded');
  }
  saveCompactModePreference(false);
  resizePanelWindow(PANEL_HEIGHT);
}

function setupCompactModeToggle() {
  const toggleBtn = document.getElementById('compactModeToggleBtn');
  if (!toggleBtn) return;

  // Compact mode resizes the OS window; that only applies to the standalone
  // popup, not the docked sidebar iframe (same check resizeToFitContent uses).
  if (window.top !== window) {
    setElementVisible(toggleBtn, false);
    return;
  }

  toggleBtn.addEventListener('click', () => {
    if (compactModeMovedElements) {
      exitCompactMode();
    } else {
      enterCompactMode();
    }
  });
}
