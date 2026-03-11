// Main panel controller for all three views (Navigator, Job Panel, Others).
// This file wires DOM events to feature modules and background actions.
import { state, setCachedPractices } from './state.js';
import { showToast, showStatus, openTabWithTimeout, extractNameFromEmail, copyTextToClipboard } from './utils.js';
import * as Navigator from './navigator.js';
import * as Jobs from './jobs.js';
import { AuthManagement } from './auth_management.js';

let practiceCacheLoadPromise = null;
let isCdbHydrationTriggered = false;
let extensionAccessState = null;
let extensionUserManagementState = { users: [], featureCatalog: [] };
let accessNoticeHideTimer = null;
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

const EXTENSION_FEATURE_CATALOG = [
    { key: 'practice_navigator', label: 'Navigator', description: 'Practice Navigator, practice links, live counts, and related admin pages.' },
    { key: 'job_panel', label: 'Job Panel', description: 'Quick document search, job status checks, and bulk job/admin links.' },
    { key: 'email_formatter', label: 'Email Formatter', description: 'Use the Email Formatter tool from Bookmarklet Tools.' },
    { key: 'linear_create_issue', label: 'Create Linear Issue', description: 'Manual Linear issue creation from the panel or document hover actions.' },
    { key: 'linear_trigger', label: 'Trigger Linear', description: 'Run automated bot-jobs issue creation.' },
    { key: 'linear_reconcile', label: 'Reconcile Linear', description: 'Mark resolved bot-job issues done in Linear.' },
    { key: 'slack_sync', label: 'Slack Sync', description: 'Sync Slack workspace targets and send Slack notifications from the Linear panel.' },
    { key: 'workflow_groups', label: 'Workflow Groups', description: 'Use the Custom Workflow Groups tool from Bookmarklet Tools.' },
    { key: 'bookmarklet_tools', label: 'Bookmarklet Tools', description: 'Use UUID picker, Docman group discovery, and related modal tools.' },
    { key: 'dashboard_hover_tools', label: 'Dashboard Hover Tools', description: 'Use Jobs/Admin/Issue hover actions on BetterLetter dashboards.' }
];
const EXTENSION_FEATURE_KEYS = EXTENSION_FEATURE_CATALOG.map((feature) => feature.key);
const NAVIGATOR_VIEW_FEATURE_KEYS = [
    'practice_navigator',
    'email_formatter',
    'workflow_groups',
    'bookmarklet_tools'
];
const LINEAR_VIEW_FEATURE_KEYS = [
    'linear_create_issue',
    'linear_trigger',
    'linear_reconcile',
    'slack_sync'
];
const VIEW_FEATURE_REQUIREMENTS = {
    practiceNavigatorView: NAVIGATOR_VIEW_FEATURE_KEYS,
    jobManagerView: ['job_panel'],
    emailFormatterView: LINEAR_VIEW_FEATURE_KEYS
};

function buildDefaultFeatureAccess() {
    return Object.fromEntries(EXTENSION_FEATURE_KEYS.map((featureKey) => [featureKey, false]));
}

function normalizePanelAccessState(rawAccess = null) {
    const featureCatalog = Array.isArray(rawAccess?.featureCatalog) && rawAccess.featureCatalog.length > 0
        ? rawAccess.featureCatalog
        : EXTENSION_FEATURE_CATALOG;
    const features = buildDefaultFeatureAccess();
    EXTENSION_FEATURE_KEYS.forEach((featureKey) => {
        features[featureKey] = Boolean(rawAccess?.features?.[featureKey]);
    });
    return {
        enabled: true,
        initialized: Boolean(rawAccess?.initialized),
        allowed: Boolean(rawAccess?.allowed),
        isOwner: Boolean(rawAccess?.isOwner),
        canManageUsers: Boolean(rawAccess?.canManageUsers),
        role: String(rawAccess?.role || '').trim().slice(0, 40),
        email: String(rawAccess?.email || '').trim().slice(0, 240),
        reason: String(rawAccess?.reason || '').trim().slice(0, 260),
        detectionSource: String(rawAccess?.detectionSource || '').trim().slice(0, 120),
        requestStatus: String(rawAccess?.requestStatus || '').trim().slice(0, 40),
        requestRequestedAt: String(rawAccess?.requestRequestedAt || '').trim().slice(0, 80),
        requestUpdatedAt: String(rawAccess?.requestUpdatedAt || '').trim().slice(0, 80),
        requestRequestedFeatures: Array.isArray(rawAccess?.requestRequestedFeatures)
            ? rawAccess.requestRequestedFeatures
                .map((featureKey) => String(featureKey || '').trim())
                .filter((featureKey) => EXTENSION_FEATURE_KEYS.includes(featureKey))
            : [],
        features,
        featureCatalog
    };
}

function hasExtensionFeature(featureKey) {
    if (!extensionAccessState) return false;
    if (extensionAccessState.isOwner) return true;
    return Boolean(extensionAccessState.features?.[featureKey]);
}

function hasAnyExtensionFeature(featureKeys = []) {
    if (!Array.isArray(featureKeys) || featureKeys.length === 0) return false;
    return featureKeys.some((featureKey) => hasExtensionFeature(featureKey));
}

function canAccessView(viewId) {
    const requiredFeatures = VIEW_FEATURE_REQUIREMENTS[viewId] || [];
    return hasAnyExtensionFeature(requiredFeatures);
}

function getAvailableViewIds() {
    return Object.keys(VIEW_FEATURE_REQUIREMENTS).filter((viewId) => canAccessView(viewId));
}

function getInitialAccessibleViewId() {
    return getAvailableViewIds()[0] || '';
}

async function syncPracticeCache({ forceRefresh = false, allowScrape = true } = {}) {
    if (practiceCacheLoadPromise) return practiceCacheLoadPromise;

    const hasCache = Object.keys(state.cachedPractices || {}).length > 0;
    if (hasCache && !forceRefresh) return state.cachedPractices;

    practiceCacheLoadPromise = (async () => {
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
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
            for (let attempt = 0; attempt < 6; attempt += 1) {
                response = await chrome.runtime.sendMessage({ action: 'getPracticeCache' });
                if (response && response.practiceCache && Object.keys(response.practiceCache).length > 0) {
                    setCachedPractices(response.practiceCache);
                    Navigator.buildCdbIndex();
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


async function triggerCdbHydration({ limit = 60 } = {}) {
    if (isCdbHydrationTriggered) return;
    isCdbHydrationTriggered = true;
    try {
        await chrome.runtime.sendMessage({ action: 'hydratePracticeCdb', limit: Math.max(10, Number(limit) || 60) });
        await syncPracticeCache({ forceRefresh: true, allowScrape: false });
    } catch (e) {
        console.warn('[Panel] CDB hydration skipped.');
    }
}

// --- 1. Global View Switcher ---
function showView(viewId) {
    const fallbackViewId = getInitialAccessibleViewId();
    const resolvedViewId = canAccessView(viewId) ? viewId : fallbackViewId;
    ['practiceNavigatorView', 'jobManagerView', 'emailFormatterView'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = (resolvedViewId && id === resolvedViewId) ? 'block' : 'none';
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
    const activeBtn = document.getElementById(navIds[resolvedViewId]);
    if (activeBtn) activeBtn.classList.add('active-tab');

    if (resolvedViewId === 'jobManagerView') {
        Jobs.fetchAndPopulateData();
    }
}

async function fetchExtensionAccessState({ forceRefresh = false, allowStale = false } = {}) {
    const response = await chrome.runtime.sendMessage({
        action: 'getExtensionAccessState',
        payload: {
            forceRefresh,
            allowStale,
            preferredTabId: PANEL_HOST_TAB_ID
        }
    });
    if (!response?.success || !response?.access) {
        throw new Error(String(response?.error || '').trim().slice(0, 240) || 'Could not resolve MailroomNavigator access.');
    }
    return response.access;
}

async function fetchExtensionUserManagement({ forceRefresh = false } = {}) {
    const response = await chrome.runtime.sendMessage({
        action: 'getExtensionUserManagement',
        payload: {
            forceRefresh,
            preferredTabId: PANEL_HOST_TAB_ID
        }
    });
    if (!response?.success || !response?.management) {
        throw new Error(String(response?.error || '').trim().slice(0, 240) || 'Could not load MailroomNavigator user management.');
    }
    return response.management;
}

async function fetchExtensionIdentityDiagnostics({ forceRefresh = false } = {}) {
    const response = await chrome.runtime.sendMessage({
        action: 'getExtensionIdentityDiagnostics',
        payload: {
            forceRefresh,
            preferredTabId: PANEL_HOST_TAB_ID
        }
    });
    if (!response?.success || !response?.diagnostics) {
        throw new Error(String(response?.error || '').trim().slice(0, 240) || 'Could not load BetterLetter identity diagnostics.');
    }
    return response.diagnostics;
}

async function submitExtensionAccessRequest({ note = '', requestedFeatures = [] } = {}) {
    const response = await chrome.runtime.sendMessage({
        action: 'submitExtensionAccessRequest',
        payload: {
            preferredTabId: PANEL_HOST_TAB_ID,
            note,
            requestedFeatures
        }
    });
    if (!response?.success) {
        throw new Error(String(response?.error || '').trim().slice(0, 240) || 'Could not submit access request.');
    }
    return response;
}

function sanitizeAccessServiceUrl(value) {
    try {
        const raw = String(value || '').trim();
        if (!raw) return '';
        const url = new URL(raw);
        if (!/^https?:$/i.test(url.protocol)) return '';
        url.hash = '';
        return url.toString().replace(/\/+$/, '');
    } catch {
        return '';
    }
}

async function fetchAccessControlServiceConfig() {
    const response = await chrome.runtime.sendMessage({
        action: 'getAccessControlServiceConfig'
    });
    if (!response?.success || !response?.config) {
        throw new Error(String(response?.error || '').trim().slice(0, 240) || 'Could not load access service config.');
    }
    return response.config;
}

async function saveAccessControlServiceConfig(config) {
    const response = await chrome.runtime.sendMessage({
        action: 'saveAccessControlServiceConfig',
        payload: config
    });
    if (!response?.success || !response?.config) {
        throw new Error(String(response?.error || '').trim().slice(0, 240) || 'Could not save access service config.');
    }
    return response.config;
}

async function fetchAccessControlServiceHealth() {
    const response = await chrome.runtime.sendMessage({
        action: 'getAccessControlServiceHealth'
    });
    if (!response?.success || !response?.health) {
        throw new Error(String(response?.error || '').trim().slice(0, 240) || 'Could not reach access service.');
    }
    return response.health;
}

function renderExtensionAccessState(access) {
    const notice = document.getElementById('accessControlNotice');
    const identityPanel = document.getElementById('identityDetectionPanel');
    const identityStatus = document.getElementById('identityDetectionStatus');
    const identityDiagnostics = document.getElementById('identityDetectionDiagnostics');
    const navButtonsRow = document.querySelector('.global-nav-buttons-row');
    const views = [
        document.getElementById('practiceNavigatorView'),
        document.getElementById('jobManagerView'),
        document.getElementById('emailFormatterView')
    ];

    extensionAccessState = normalizePanelAccessState(access);

    if (!notice) return;

    const emailLine = extensionAccessState.email
        ? `Current BetterLetter user: ${extensionAccessState.email}`
        : 'Current BetterLetter user: not detected';
    const sourceLine = extensionAccessState.detectionSource
        ? `Detection source: ${extensionAccessState.detectionSource}`
        : '';

    if (accessNoticeHideTimer) {
        clearTimeout(accessNoticeHideTimer);
        accessNoticeHideTimer = null;
    }

    notice.style.display = 'block';
    if (identityStatus) {
        identityStatus.textContent = [emailLine, extensionAccessState.reason || 'Open a signed-in BetterLetter tab and refresh the panel.', sourceLine]
            .filter(Boolean)
            .join('\n');
    }

    if (extensionAccessState.allowed) {
        notice.classList.remove('invalid');
        notice.classList.add('valid');
        notice.style.display = 'block';
        notice.textContent = [emailLine, extensionAccessState.isOwner ? 'Owner access granted.' : 'Access granted to assigned MailroomNavigator features.', sourceLine]
            .filter(Boolean)
            .join('\n');
        if (identityPanel) identityPanel.style.display = 'none';
        if (identityDiagnostics) {
            identityDiagnostics.style.display = 'none';
            identityDiagnostics.textContent = '';
        }
        if (navButtonsRow) navButtonsRow.style.display = '';
        accessNoticeHideTimer = setTimeout(() => {
            notice.style.display = 'none';
        }, 10000);
        return;
    }

    notice.classList.remove('valid');
    notice.classList.add('invalid');
    notice.style.display = 'block';
    notice.textContent = [emailLine, extensionAccessState.reason || 'Access denied.', sourceLine]
        .filter(Boolean)
        .join('\n');
    if (navButtonsRow) navButtonsRow.style.display = 'none';
    if (identityPanel) identityPanel.style.display = !extensionAccessState.email ? 'block' : 'none';
    if (identityDiagnostics) {
        identityDiagnostics.style.display = 'none';
        identityDiagnostics.textContent = '';
    }
    views.forEach((view) => {
        if (!view) return;
        view.style.display = 'none';
    });
}

function renderIdentityDiagnostics(diagnostics = null) {
    const identityDiagnostics = document.getElementById('identityDetectionDiagnostics');
    if (!identityDiagnostics) return;
    if (!diagnostics || typeof diagnostics !== 'object') {
        identityDiagnostics.style.display = 'none';
        identityDiagnostics.textContent = '';
        return;
    }

    const lines = [];
    lines.push(`Panel hostTabId: ${PANEL_HOST_TAB_ID ?? 'none'}`);
    lines.push(`Preferred tabId: ${diagnostics.preferredTabId ?? 'none'}`);
    if (diagnostics?.storedSnapshot?.email) {
        lines.push(`Stored snapshot: ${diagnostics.storedSnapshot.email} (${diagnostics.storedSnapshot.source || 'unknown'})`);
    } else {
        lines.push('Stored snapshot: none');
    }
    lines.push(`Candidate tabs: ${Array.isArray(diagnostics?.tabs) ? diagnostics.tabs.length : 0}`);

    (Array.isArray(diagnostics?.tabs) ? diagnostics.tabs : []).slice(0, 6).forEach((tab, index) => {
        lines.push('');
        lines.push(`[${index + 1}] tabId=${tab.tabId} active=${tab.active ? 'yes' : 'no'} status=${tab.status || 'unknown'} signIn=${tab.isSignIn ? 'yes' : 'no'}`);
        if (tab.url) lines.push(`url: ${tab.url}`);
        if (tab.title) lines.push(`title: ${tab.title}`);
        if (tab.datasetEmail || tab.datasetSource) {
            lines.push(`dataset: ${tab.datasetEmail || 'none'} ${tab.datasetSource ? `(${tab.datasetSource})` : ''}`.trim());
        }
        if (tab.mainWorld?.email || tab.mainWorld?.source) {
            lines.push(`main: ${tab.mainWorld.email || 'none'} ${tab.mainWorld.source ? `(${tab.mainWorld.source})` : ''}`.trim());
        } else {
            lines.push('main: none');
        }
        if (tab.isolatedWorld?.email || tab.isolatedWorld?.source) {
            lines.push(`isolated: ${tab.isolatedWorld.email || 'none'} ${tab.isolatedWorld.source ? `(${tab.isolatedWorld.source})` : ''}`.trim());
        } else {
            lines.push('isolated: none');
        }
        if (tab.routeProbe?.email || tab.routeProbe?.source) {
            lines.push(`route: ${tab.routeProbe.email || 'none'} ${tab.routeProbe.source ? `(${tab.routeProbe.source})` : ''}`.trim());
        } else {
            lines.push('route: none');
        }
        if (tab.error) lines.push(`error: ${tab.error}`);
    });

    identityDiagnostics.textContent = lines.join('\n');
    identityDiagnostics.style.display = 'block';
}

function setElementVisible(elementOrId, shouldShow, displayValue = '') {
    const element = typeof elementOrId === 'string' ? document.getElementById(elementOrId) : elementOrId;
    if (!element) return;
    element.style.display = shouldShow ? displayValue : 'none';
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

function applyExtensionFeatureAccessToUi() {
    const navRow = document.querySelector('.global-nav-buttons-row');
    const accessAllowed = Boolean(extensionAccessState?.allowed);
    const availableViewIds = getAvailableViewIds();

    const navButtonMap = {
        practiceNavigatorView: document.getElementById('navigatorGlobalToggleBtn'),
        jobManagerView: document.getElementById('jobManagerGlobalToggleBtn'),
        emailFormatterView: document.getElementById('emailFormatterGlobalToggleBtn')
    };

    Object.entries(navButtonMap).forEach(([viewId, button]) => {
        if (!button) return;
        const showButton = accessAllowed && canAccessView(viewId);
        button.style.display = showButton ? '' : 'none';
    });

    if (navRow) {
        navRow.style.display = accessAllowed && availableViewIds.length > 0 ? '' : 'none';
    }

    setElementVisible('practiceNavigatorCoreSection', hasExtensionFeature('practice_navigator'));
    setElementVisible('bookmarkletToolsSection', hasAnyExtensionFeature(['bookmarklet_tools', 'email_formatter', 'workflow_groups']));
    setElementVisible('runUuidPickerToolBtn', hasExtensionFeature('bookmarklet_tools'));
    setElementVisible('runListDocmanGroupsToolBtn', hasExtensionFeature('bookmarklet_tools'));
    setElementVisible('runEmailFormatterToolBtn', hasExtensionFeature('email_formatter'));
    setElementVisible('runWorkflowGroupsToolBtn', hasExtensionFeature('workflow_groups'));
    setElementVisible('linearIssueSection', hasAnyExtensionFeature(['linear_create_issue', 'linear_trigger', 'linear_reconcile', 'slack_sync']));
    setElementVisible('linearCreateIssueControls', hasExtensionFeature('linear_create_issue'));
    setElementVisible('linearSlackControls', hasExtensionFeature('slack_sync'));
    setElementVisible('createLinearSlackIssueBtn', hasExtensionFeature('linear_create_issue'), '');
    setElementVisible('triggerLinearBotJobsBtn', hasExtensionFeature('linear_trigger'), '');
    setElementVisible('triggerLinearDryRunLabel', hasExtensionFeature('linear_trigger'), 'flex');
    setElementVisible('reconcileLinearControls', hasExtensionFeature('linear_reconcile'));
    setElementVisible('reconcileLinearDryRunLabel', hasExtensionFeature('linear_reconcile'), 'flex');
    setElementVisible(
        'linearTriggerStatus',
        hasAnyExtensionFeature(['linear_create_issue', 'linear_trigger', 'linear_reconcile', 'slack_sync'])
            && Boolean(String(document.getElementById('linearTriggerStatus')?.textContent || '').trim())
    );
    setElementVisible('extensionUserManagementSection', Boolean(extensionAccessState?.isOwner));

    const actionRow = document.getElementById('linearActionButtonsRow');
    const canCreateIssue = hasExtensionFeature('linear_create_issue');
    const canTriggerLinear = hasExtensionFeature('linear_trigger');
    if (actionRow) {
        actionRow.style.display = (canCreateIssue || canTriggerLinear) ? 'grid' : 'none';
        actionRow.style.gridTemplateColumns = canCreateIssue && canTriggerLinear ? '1fr 1fr' : '1fr';
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

    const linearIssueSection = document.getElementById('linearIssueSection');
    const linearIssueSectionBody = document.getElementById('linearIssueSectionBody');
    const linearIssueSectionToggle = document.getElementById('linearIssueSectionToggle');
    const extensionUserManagementSection = document.getElementById('extensionUserManagementSection');
    const extensionUserManagementSectionBody = document.getElementById('extensionUserManagementSectionBody');
    const extensionUserManagementSectionToggle = document.getElementById('extensionUserManagementSectionToggle');

    const identityDetectionStatus = document.getElementById('identityDetectionStatus');
    const accessRequestSection = document.getElementById('accessRequestSection');
    const accessRequestStatus = document.getElementById('accessRequestStatus');
    const accessRequestNoteInput = document.getElementById('accessRequestNoteInput');
    const accessRequestFeaturesGrid = document.getElementById('accessRequestFeaturesGrid');
    const submitAccessRequestBtn = document.getElementById('submitAccessRequestBtn');
    const refreshAccessRequestBtn = document.getElementById('refreshAccessRequestBtn');
    const accessServiceConfigSection = document.getElementById('accessServiceConfigSection');
    const accessServiceUrlInput = document.getElementById('accessServiceUrlInput');
    const accessServiceKeyInput = document.getElementById('accessServiceKeyInput');
    const saveAccessServiceConfigBtn = document.getElementById('saveAccessServiceConfigBtn');
    const clearAccessServiceConfigBtn = document.getElementById('clearAccessServiceConfigBtn');
    const accessServiceConfigStatus = document.getElementById('accessServiceConfigStatus');
    const extensionUserManagementSummary = document.getElementById('extensionUserManagementSummary');
    const managedUserEmailInput = document.getElementById('managedUserEmailInput');
    const managedUserRoleInput = document.getElementById('managedUserRoleInput');
    const managedUserFeaturesGrid = document.getElementById('managedUserFeaturesGrid');
    const clearManagedUserFormBtn = document.getElementById('clearManagedUserFormBtn');
    const saveManagedUserBtn = document.getElementById('saveManagedUserBtn');
    const refreshManagedUsersBtn = document.getElementById('refreshManagedUsersBtn');
    const extensionManagedUsersList = document.getElementById('extensionManagedUsersList');
    let managedUserEditingEmail = '';
    let accessServiceConfig = { enabled: false, baseUrl: '', sharedKey: '', isDefault: false, defaultBaseUrl: '', useLocalOverride: false };
    let enhancedAuthManagementReady = false;
    let collapsibleSectionState = await loadPanelCollapsibleSectionState();

    const setCollapsibleSectionCollapsed = (sectionKey, collapsed, { persist = true } = {}) => {
        collapsibleSectionState = {
            ...collapsibleSectionState,
            [sectionKey]: Boolean(collapsed)
        };
        if (sectionKey === 'linearIssueSection') {
            applyCollapsibleSectionUi(linearIssueSection, linearIssueSectionBody, linearIssueSectionToggle, collapsed);
        }
        if (sectionKey === 'extensionUserManagementSection') {
            applyCollapsibleSectionUi(extensionUserManagementSection, extensionUserManagementSectionBody, extensionUserManagementSectionToggle, collapsed);
        }
        if (persist) savePanelCollapsibleSectionState(collapsibleSectionState).catch(() => undefined);
    };

    linearIssueSectionToggle?.addEventListener('click', () => {
        setCollapsibleSectionCollapsed(
            'linearIssueSection',
            !Boolean(collapsibleSectionState?.linearIssueSection)
        );
    });
    extensionUserManagementSectionToggle?.addEventListener('click', () => {
        setCollapsibleSectionCollapsed(
            'extensionUserManagementSection',
            !Boolean(collapsibleSectionState?.extensionUserManagementSection)
        );
    });

    setCollapsibleSectionCollapsed('linearIssueSection', Boolean(collapsibleSectionState?.linearIssueSection), { persist: false });
    setCollapsibleSectionCollapsed('extensionUserManagementSection', Boolean(collapsibleSectionState?.extensionUserManagementSection), { persist: false });

    const getFeatureCatalogForUi = () => Array.isArray(extensionAccessState?.featureCatalog) && extensionAccessState.featureCatalog.length > 0
        ? extensionAccessState.featureCatalog
        : EXTENSION_FEATURE_CATALOG;

    const setAccessRequestStatus = (message, tone = null) => {
        if (!accessRequestStatus) return;
        accessRequestStatus.classList.remove('neutral', 'valid', 'invalid');
        if (tone === 'valid') accessRequestStatus.classList.add('valid');
        else if (tone === 'invalid') accessRequestStatus.classList.add('invalid');
        else accessRequestStatus.classList.add('neutral');
        accessRequestStatus.textContent = String(message || '').trim();
    };

    const renderAccessRequestFeatureCheckboxes = (selectedFeatures = []) => {
        if (!accessRequestFeaturesGrid) return;
        const selectedFeatureSet = new Set(Array.isArray(selectedFeatures) ? selectedFeatures : []);
        accessRequestFeaturesGrid.innerHTML = '';
        getFeatureCatalogForUi().forEach((feature) => {
            const row = document.createElement('label');
            row.className = 'job-check-item';
            row.style.display = 'flex';
            row.style.gap = '8px';
            row.style.alignItems = 'flex-start';

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.value = feature.key;
            checkbox.checked = selectedFeatureSet.has(feature.key);

            const copy = document.createElement('span');
            const title = document.createElement('strong');
            title.textContent = feature.label;
            const description = document.createElement('div');
            description.textContent = feature.description;
            description.style.fontSize = '11px';
            description.style.color = '#6b7280';
            copy.append(title, description);

            row.append(checkbox, copy);
            accessRequestFeaturesGrid.appendChild(row);
        });
    };

    const getRequestedAccessFeatures = () => {
        if (!accessRequestFeaturesGrid) return [];
        return [...accessRequestFeaturesGrid.querySelectorAll('input[type="checkbox"]:checked')]
            .map((input) => String(input.value || '').trim())
            .filter(Boolean);
    };

    const renderAccessRequestSection = () => {
        // This panel only submits a review request. The shared access service still
        // decides whether the current BetterLetter email is granted any features.
        const canRequestAccess = Boolean(extensionAccessState?.email)
            && !extensionAccessState?.allowed
            && !extensionAccessState?.isOwner;
        setElementVisible(accessRequestSection, canRequestAccess, '');
        if (!canRequestAccess) return;

        const selectedFeatures = (getRequestedAccessFeatures().length > 0)
            ? getRequestedAccessFeatures()
            : extensionAccessState?.requestRequestedFeatures || [];
        renderAccessRequestFeatureCheckboxes(selectedFeatures);

        if (submitAccessRequestBtn) {
            submitAccessRequestBtn.textContent = extensionAccessState?.requestRequestedAt ? 'Update Request' : 'Request Access';
        }

        if (extensionAccessState?.requestStatus === 'pending' && extensionAccessState?.requestRequestedAt) {
            setAccessRequestStatus(
                `Request pending review since ${extensionAccessState.requestRequestedAt}. You can update the note or requested features and submit again.`,
                'valid'
            );
        } else if (extensionAccessState?.requestStatus === 'rejected') {
            setAccessRequestStatus(
                'A previous access request was rejected. Update the note if needed and submit again to reopen it.',
                'invalid'
            );
        } else {
            setAccessRequestStatus(
                `Detected BetterLetter user: ${extensionAccessState.email}. Submit a request so the owner can review this email and machine.`,
                'neutral'
            );
        }
    };

    // The advanced auth module is owner-only UI. The existing background/service
    // actions remain the single source of truth for access policy enforcement.
    const syncEnhancedAuthManagement = async (management = null) => {
        if (!extensionAccessState?.isOwner) return;
        const effectiveManagement = management || extensionUserManagementState;
        const sharedCallbacks = {
            fetchManagement: fetchExtensionUserManagement,
            getAccessServiceHealth: fetchAccessControlServiceHealth,
            getIdentityDiagnostics: fetchExtensionIdentityDiagnostics
        };

        if (!enhancedAuthManagementReady) {
            await AuthManagement.init({
                accessState: extensionAccessState,
                management: effectiveManagement,
                featureCatalog: getFeatureCatalogForUi(),
                callbacks: sharedCallbacks
            });
            enhancedAuthManagementReady = true;
            return;
        }

        await AuthManagement.updateContext({
            accessState: extensionAccessState,
            management: effectiveManagement,
            featureCatalog: getFeatureCatalogForUi(),
            callbacks: sharedCallbacks
        });
    };

    const setAccessServiceConfigStatus = (message, tone = null) => {
        if (!accessServiceConfigStatus) return;
        accessServiceConfigStatus.classList.remove('neutral', 'valid', 'invalid');
        if (tone === 'valid') accessServiceConfigStatus.classList.add('valid');
        else if (tone === 'invalid') accessServiceConfigStatus.classList.add('invalid');
        else accessServiceConfigStatus.classList.add('neutral');
        accessServiceConfigStatus.textContent = String(message || '').trim();
    };

    const renderAccessServiceConfig = () => {
        if (accessServiceUrlInput) accessServiceUrlInput.value = accessServiceConfig.baseUrl || '';
        if (accessServiceKeyInput) accessServiceKeyInput.value = accessServiceConfig.sharedKey || '';
        setElementVisible(
            accessServiceConfigSection,
            !extensionAccessState?.allowed || Boolean(accessServiceConfig?.enabled),
            ''
        );
        if (accessServiceConfig?.enabled && accessServiceConfig.baseUrl) {
            const prefix = accessServiceConfig?.isDefault ? 'Using default shared access service' : 'Using shared access service';
            setAccessServiceConfigStatus(`${prefix}: ${accessServiceConfig.baseUrl}`, 'valid');
        } else {
            setAccessServiceConfigStatus('Using local access service.', 'neutral');
        }
    };

    const refreshAccessServiceHealth = async () => {
        try {
            const health = await fetchAccessControlServiceHealth();
            const serviceLabel = health?.usingRemoteConfig && health?.baseUrl
                ? `shared access service ${health.baseUrl}`
                : 'local access service';
            const ownerLabel = health?.access?.ownerEmail
                ? ` Owner: ${health.access.ownerEmail}.`
                : '';
            setAccessServiceConfigStatus(`Connected to ${serviceLabel}.${ownerLabel}`.trim(), 'valid');
        } catch (error) {
            const fallbackMessage = accessServiceConfig?.enabled
                ? `Shared access service unavailable. ${String(error?.message || '').trim()}`
                : String(error?.message || '').trim();
            setAccessServiceConfigStatus(
                fallbackMessage || 'Could not reach the configured access service.',
                'invalid'
            );
        }
    };

    const normalizeManagedUserEmail = (value) => String(value || '').trim().toLowerCase().slice(0, 240);

    const getManagedUserSelectedFeatures = () => {
        if (!managedUserFeaturesGrid) return [];
        return [...managedUserFeaturesGrid.querySelectorAll('input[type="checkbox"]:checked')]
            .map((input) => String(input.value || '').trim())
            .filter(Boolean);
    };

    const renderManagedUserFeatureCheckboxes = (selectedFeatures = []) => {
        if (enhancedAuthManagementReady) return;
        if (!managedUserFeaturesGrid) return;
        const role = String(managedUserRoleInput?.value || 'user').trim().toLowerCase();
        const selectedFeatureSet = new Set(Array.isArray(selectedFeatures) ? selectedFeatures : []);
        managedUserFeaturesGrid.innerHTML = '';

        getFeatureCatalogForUi().forEach((feature) => {
            const row = document.createElement('label');
            row.className = 'job-check-item';
            row.style.alignItems = 'flex-start';
            row.style.display = 'flex';
            row.style.gap = '8px';

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.value = feature.key;
            checkbox.checked = role === 'admin' ? selectedFeatureSet.has(feature.key) : selectedFeatureSet.has(feature.key);
            checkbox.disabled = false;

            const copy = document.createElement('span');
            const title = document.createElement('strong');
            title.textContent = feature.label;
            const description = document.createElement('div');
            description.textContent = feature.description;
            description.style.fontSize = '11px';
            description.style.color = '#6b7280';
            copy.append(title, description);

            row.append(checkbox, copy);
            managedUserFeaturesGrid.appendChild(row);
        });
    };

    const resetManagedUserForm = () => {
        if (enhancedAuthManagementReady) return;
        managedUserEditingEmail = '';
        if (managedUserEmailInput) managedUserEmailInput.value = '';
        if (managedUserRoleInput) managedUserRoleInput.value = 'user';
        renderManagedUserFeatureCheckboxes([]);
        if (saveManagedUserBtn) saveManagedUserBtn.textContent = 'Save User';
    };

    const populateManagedUserForm = (user) => {
        if (enhancedAuthManagementReady) return;
        managedUserEditingEmail = normalizeManagedUserEmail(user?.email);
        if (managedUserEmailInput) managedUserEmailInput.value = managedUserEditingEmail;
        if (managedUserRoleInput) managedUserRoleInput.value = String(user?.role || 'user');
        renderManagedUserFeatureCheckboxes(Array.isArray(user?.features) ? user.features : []);
        if (saveManagedUserBtn) saveManagedUserBtn.textContent = managedUserEditingEmail ? 'Update User' : 'Save User';
    };

    const renderManagedUsersList = () => {
        if (enhancedAuthManagementReady) return;
        if (!extensionManagedUsersList) return;
        extensionManagedUsersList.innerHTML = '';

        const users = Array.isArray(extensionUserManagementState?.users) ? extensionUserManagementState.users : [];
        if (users.length === 0) {
            extensionManagedUsersList.textContent = 'No managed users yet.';
            extensionManagedUsersList.style.color = '#6b7280';
            return;
        }

        extensionManagedUsersList.style.color = '';
        users.forEach((user) => {
            const row = document.createElement('div');
            row.style.border = '1px solid #d1d5db';
            row.style.borderRadius = '8px';
            row.style.padding = '10px';
            row.style.marginTop = '8px';
            row.style.background = '#f8fafc';

            const header = document.createElement('div');
            header.style.display = 'flex';
            header.style.justifyContent = 'space-between';
            header.style.alignItems = 'center';
            header.style.gap = '8px';

            const title = document.createElement('div');
            title.innerHTML = `<strong>${user.email}</strong><br><span style="font-size:11px; color:#6b7280;">${user.role === 'admin' ? 'Admin' : 'User'}</span>`;

            const actions = document.createElement('div');
            actions.style.display = 'flex';
            actions.style.gap = '6px';

            const editBtn = document.createElement('button');
            editBtn.type = 'button';
            editBtn.className = 'btn btn-sm btn-ghost';
            editBtn.textContent = 'Edit';
            editBtn.addEventListener('click', () => populateManagedUserForm(user));

            const deleteBtn = document.createElement('button');
            deleteBtn.type = 'button';
            deleteBtn.className = 'btn btn-sm';
            deleteBtn.style.background = '#dc2626';
            deleteBtn.textContent = 'Delete';
            deleteBtn.addEventListener('click', async () => {
                if (!window.confirm(`Delete ${user.email} from MailroomNavigator access?`)) return;
                try {
                    deleteBtn.disabled = true;
                    const response = await chrome.runtime.sendMessage({
                        action: 'deleteExtensionManagedUser',
                        payload: { email: user.email }
                    });
                    if (!response?.success) {
                        throw new Error(String(response?.error || '').trim().slice(0, 240) || 'Could not delete user.');
                    }
                    extensionUserManagementState = response.management || extensionUserManagementState;
                    renderManagedUsersList();
                    resetManagedUserForm();
                    if (extensionUserManagementSummary) {
                        extensionUserManagementSummary.className = 'validation-badge valid';
                        const alert = response?.alert;
                        const alertSuffix = alert?.attempted
                            ? (alert.success ? ' Slack alert sent.' : ` Slack alert failed: ${String(alert.error || 'unknown error').trim().slice(0, 120)}`)
                            : '';
                        extensionUserManagementSummary.textContent = `Removed ${user.email}.${alertSuffix}`;
                    }
                    const refreshedAccess = await fetchExtensionAccessState({ forceRefresh: true });
                    renderExtensionAccessState(refreshedAccess);
                    renderAccessServiceConfig();
                    applyExtensionFeatureAccessToUi();
                    const nextViewId = getInitialAccessibleViewId();
                    showView(nextViewId);
                } catch (error) {
                    if (extensionUserManagementSummary) {
                        extensionUserManagementSummary.className = 'validation-badge invalid';
                        extensionUserManagementSummary.textContent = String(error?.message || 'Could not delete user.').trim().slice(0, 260);
                    }
                } finally {
                    deleteBtn.disabled = false;
                }
            });

            actions.append(editBtn, deleteBtn);
            header.append(title, actions);

            const featureList = document.createElement('div');
            featureList.style.marginTop = '8px';
            featureList.style.fontSize = '12px';
            featureList.style.color = '#374151';
            featureList.textContent = `Features: ${(Array.isArray(user.features) && user.features.length > 0) ? user.features.join(', ') : 'none'}`;

            row.append(header, featureList);
            extensionManagedUsersList.appendChild(row);
        });
    };

    const refreshExtensionUserManagementUi = async ({ forceRefresh = false } = {}) => {
        if (!extensionAccessState?.isOwner) {
            extensionUserManagementState = { users: [], featureCatalog: getFeatureCatalogForUi() };
            renderManagedUserFeatureCheckboxes([]);
            renderManagedUsersList();
            return extensionUserManagementState;
        }
        const management = await fetchExtensionUserManagement({ forceRefresh });
        extensionUserManagementState = management;
        if (!enhancedAuthManagementReady) {
            renderManagedUserFeatureCheckboxes(getManagedUserSelectedFeatures());
            renderManagedUsersList();
        }
        if (!enhancedAuthManagementReady && extensionUserManagementSummary) {
            extensionUserManagementSummary.className = 'validation-badge neutral';
            extensionUserManagementSummary.textContent = `Owner: ${extensionAccessState.email}\nSynced users: ${Array.isArray(management?.users) ? management.users.length : 0}`;
        }
        await syncEnhancedAuthManagement(management);
        return management;
    };

    try {
        accessServiceConfig = await fetchAccessControlServiceConfig();
    } catch (error) {
        setAccessServiceConfigStatus(String(error?.message || 'Could not load access service config.').trim(), 'invalid');
    }
    renderAccessServiceConfig();
    refreshAccessServiceHealth().catch(() => undefined);

    try {
        const access = await fetchExtensionAccessState({ allowStale: true });
        renderExtensionAccessState(access);
        renderAccessRequestSection();
        renderAccessServiceConfig();
        applyExtensionFeatureAccessToUi();
        if (!access?.email) {
            try {
                const diagnostics = await fetchExtensionIdentityDiagnostics({ forceRefresh: true });
                renderIdentityDiagnostics(diagnostics);
            } catch (diagnosticError) {
                renderIdentityDiagnostics({
                    preferredTabId: PANEL_HOST_TAB_ID,
                    tabs: [],
                    storedSnapshot: null,
                    error: String(diagnosticError?.message || 'Could not load diagnostics.').trim()
                });
            }
        } else {
            renderIdentityDiagnostics(null);
        }

        fetchExtensionAccessState({ forceRefresh: true, allowStale: true })
            .then((freshAccess) => {
                renderExtensionAccessState(freshAccess);
                renderAccessRequestSection();
                renderAccessServiceConfig();
                applyExtensionFeatureAccessToUi();
                if (!freshAccess?.email) return;
                renderIdentityDiagnostics(null);
            })
            .catch(() => undefined);
    } catch (error) {
        renderExtensionAccessState({
            initialized: false,
            allowed: false,
            email: '',
            reason: String(error?.message || 'Could not resolve MailroomNavigator access.').trim().slice(0, 260),
            detectionSource: ''
        });
        renderAccessRequestSection();
        renderAccessServiceConfig();
        applyExtensionFeatureAccessToUi();
        try {
            const diagnostics = await fetchExtensionIdentityDiagnostics({ forceRefresh: true });
            renderIdentityDiagnostics(diagnostics);
        } catch (diagnosticError) {
            renderIdentityDiagnostics({
                preferredTabId: PANEL_HOST_TAB_ID,
                tabs: [],
                storedSnapshot: null,
                error: String(diagnosticError?.message || 'Could not load diagnostics.').trim()
            });
        }
    }

    saveAccessServiceConfigBtn?.addEventListener('click', async () => {
        try {
            const baseUrl = sanitizeAccessServiceUrl(accessServiceUrlInput?.value);
            const sharedKey = String(accessServiceKeyInput?.value || '').trim();
            if (!baseUrl) {
                throw new Error('Enter a valid shared access service URL.');
            }

            saveAccessServiceConfigBtn.disabled = true;
            accessServiceConfig = await saveAccessControlServiceConfig({ baseUrl, sharedKey, useLocalOverride: false });
            renderAccessServiceConfig();
            await refreshAccessServiceHealth();

            const refreshedAccess = await fetchExtensionAccessState({ forceRefresh: true, allowStale: true });
            renderExtensionAccessState(refreshedAccess);
            renderAccessRequestSection();
            renderAccessServiceConfig();
            applyExtensionFeatureAccessToUi();
            if (extensionAccessState?.isOwner) {
                await syncEnhancedAuthManagement(extensionUserManagementState);
            }
            if (refreshedAccess?.email) renderIdentityDiagnostics(null);
            showView(getInitialAccessibleViewId());
        } catch (error) {
            setAccessServiceConfigStatus(String(error?.message || 'Could not save access service config.').trim(), 'invalid');
        } finally {
            saveAccessServiceConfigBtn.disabled = false;
        }
    });

    clearAccessServiceConfigBtn?.addEventListener('click', async () => {
        try {
            clearAccessServiceConfigBtn.disabled = true;
            accessServiceConfig = await saveAccessControlServiceConfig({ baseUrl: '', sharedKey: '', useLocalOverride: true });
            renderAccessServiceConfig();
            refreshAccessServiceHealth().catch(() => undefined);
            if (extensionAccessState?.isOwner) {
                await syncEnhancedAuthManagement(extensionUserManagementState);
            }
        } catch (error) {
            setAccessServiceConfigStatus(String(error?.message || 'Could not reset access service config.').trim(), 'invalid');
        } finally {
            clearAccessServiceConfigBtn.disabled = false;
        }
    });

    submitAccessRequestBtn?.addEventListener('click', async () => {
        try {
            submitAccessRequestBtn.disabled = true;
            const response = await submitExtensionAccessRequest({
                note: String(accessRequestNoteInput?.value || '').trim(),
                requestedFeatures: getRequestedAccessFeatures()
            });
            if (response?.access) {
                renderExtensionAccessState(response.access);
                renderAccessRequestSection();
                renderAccessServiceConfig();
                applyExtensionFeatureAccessToUi();
            }
            setAccessRequestStatus('Access request submitted. The owner can now review your email, requested features, and recent machine IP.', 'valid');
        } catch (error) {
            setAccessRequestStatus(String(error?.message || 'Could not submit access request.').trim(), 'invalid');
        } finally {
            submitAccessRequestBtn.disabled = false;
        }
    });

    refreshAccessRequestBtn?.addEventListener('click', async () => {
        try {
            refreshAccessRequestBtn.disabled = true;
            const refreshedAccess = await fetchExtensionAccessState({ forceRefresh: true, allowStale: true });
            renderExtensionAccessState(refreshedAccess);
            renderAccessRequestSection();
            renderAccessServiceConfig();
            applyExtensionFeatureAccessToUi();
        } catch (error) {
            setAccessRequestStatus(String(error?.message || 'Could not refresh access state.').trim(), 'invalid');
        } finally {
            refreshAccessRequestBtn.disabled = false;
        }
    });
    
    // C. Setup Navigation Tabs
    document.getElementById("navigatorGlobalToggleBtn")?.addEventListener("click", () => showView('practiceNavigatorView'));
    document.getElementById("jobManagerGlobalToggleBtn")?.addEventListener("click", () => showView('jobManagerView'));
    document.getElementById("emailFormatterGlobalToggleBtn")?.addEventListener("click", () => showView('emailFormatterView'));

    managedUserRoleInput?.addEventListener('change', () => {
        renderManagedUserFeatureCheckboxes(getManagedUserSelectedFeatures());
    });

    clearManagedUserFormBtn?.addEventListener('click', () => {
        resetManagedUserForm();
        if (extensionUserManagementSummary) {
            extensionUserManagementSummary.className = 'validation-badge neutral';
            extensionUserManagementSummary.textContent = 'Ready.';
        }
    });

    refreshManagedUsersBtn?.addEventListener('click', () => {
        refreshExtensionUserManagementUi({ forceRefresh: true })
            .then(() => {
                if (extensionUserManagementSummary) {
                    extensionUserManagementSummary.className = 'validation-badge valid';
                    extensionUserManagementSummary.textContent = 'User list refreshed.';
                }
            })
            .catch((error) => {
                if (extensionUserManagementSummary) {
                    extensionUserManagementSummary.className = 'validation-badge invalid';
                    extensionUserManagementSummary.textContent = String(error?.message || 'Could not refresh users.').trim().slice(0, 260);
                }
            });
    });

    saveManagedUserBtn?.addEventListener('click', async () => {
        try {
            const email = normalizeManagedUserEmail(managedUserEmailInput?.value);
            const role = String(managedUserRoleInput?.value || 'user').trim().toLowerCase();
            const features = getManagedUserSelectedFeatures();

            if (!email) {
                throw new Error('Enter a BetterLetter user email.');
            }

            saveManagedUserBtn.disabled = true;
            if (extensionUserManagementSummary) {
                extensionUserManagementSummary.className = 'validation-badge neutral';
                extensionUserManagementSummary.textContent = managedUserEditingEmail
                    ? `Updating ${managedUserEditingEmail}…`
                    : `Saving ${email}…`;
            }

            const response = await chrome.runtime.sendMessage({
                action: 'saveExtensionManagedUser',
                payload: { email, role, features }
            });
            if (!response?.success) {
                throw new Error(String(response?.error || '').trim().slice(0, 240) || 'Could not save user.');
            }
            extensionUserManagementState = response.management || extensionUserManagementState;
            renderManagedUsersList();
            populateManagedUserForm({ email, role, features });
            if (extensionUserManagementSummary) {
                extensionUserManagementSummary.className = 'validation-badge valid';
                const alert = response?.alert;
                const alertSuffix = alert?.attempted
                    ? (alert.success ? ' Slack alert sent.' : ` Slack alert failed: ${String(alert.error || 'unknown error').trim().slice(0, 120)}`)
                    : '';
                extensionUserManagementSummary.textContent = `Saved ${email}.${alertSuffix}`;
            }
            const refreshedAccess = await fetchExtensionAccessState({ forceRefresh: true });
            renderExtensionAccessState(refreshedAccess);
            renderAccessRequestSection();
            renderAccessServiceConfig();
            applyExtensionFeatureAccessToUi();
        } catch (error) {
            if (extensionUserManagementSummary) {
                extensionUserManagementSummary.className = 'validation-badge invalid';
                extensionUserManagementSummary.textContent = String(error?.message || 'Could not save user.').trim().slice(0, 260);
            }
        } finally {
            saveManagedUserBtn.disabled = false;
        }
    });

    if (!extensionAccessState?.email && identityDetectionStatus) {
        identityDetectionStatus.className = 'validation-badge neutral';
        identityDetectionStatus.textContent = 'Open a signed-in BetterLetter page, then refresh the panel. Manual email override is disabled.';
    }

    if (extensionAccessState?.isOwner) {
        refreshExtensionUserManagementUi({ forceRefresh: true })
            .catch((error) => {
                if (extensionUserManagementSummary) {
                    extensionUserManagementSummary.className = 'validation-badge invalid';
                    extensionUserManagementSummary.textContent = String(error?.message || 'Could not load user management.').trim().slice(0, 260);
                }
            });
    } else {
        renderManagedUserFeatureCheckboxes([]);
        renderManagedUsersList();
    }

    document.addEventListener('authMgmt:userSaved', async () => {
        try {
            const freshAccess = await fetchExtensionAccessState({ forceRefresh: true, allowStale: true });
            renderExtensionAccessState(freshAccess);
            renderAccessRequestSection();
            renderAccessServiceConfig();
            applyExtensionFeatureAccessToUi();
            await refreshExtensionUserManagementUi({ forceRefresh: true });
            showView(getInitialAccessibleViewId());
        } catch {
            // The advanced UI already surfaced the save error locally.
        }
    });

    document.addEventListener('authMgmt:userDeleted', async () => {
        try {
            const freshAccess = await fetchExtensionAccessState({ forceRefresh: true, allowStale: true });
            renderExtensionAccessState(freshAccess);
            renderAccessRequestSection();
            renderAccessServiceConfig();
            applyExtensionFeatureAccessToUi();
            await refreshExtensionUserManagementUi({ forceRefresh: true });
            showView(getInitialAccessibleViewId());
        } catch {
            // The advanced UI already surfaced the delete error locally.
        }
    });

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
    let isCdbHydrationQueued = false;
    const refreshCdbSuggestions = () => {
        Navigator.handleCdbInput();
        const hasPracticeCache = Object.keys(state.cachedPractices || {}).length > 0;
        syncPracticeCache({ forceRefresh: false, allowScrape: !hasPracticeCache })
            .then(() => {
                Navigator.handleCdbInput();
                if (document.activeElement !== cdbInput || isCdbHydrationQueued || !hasPracticeCache) return;
                isCdbHydrationQueued = true;
                triggerCdbHydration({ limit: 80 })
                    .then(() => {
                        Navigator.handleCdbInput();
                    })
                    .catch(() => undefined)
                    .finally(() => { isCdbHydrationQueued = false; });
            })
            .catch(() => undefined);
    };

    if (cdbInput) {
        cdbInput.addEventListener('input', refreshCdbSuggestions);
        cdbInput.addEventListener('focus', refreshCdbSuggestions);
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
        if (pInput) {
            pInput.value = '';
            pInput.focus();
        }
        Navigator.clearSelectedPractice();
        showStatus('Settings reset.', 'success');
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
    const runEmailFormatterToolBtn = document.getElementById('runEmailFormatterToolBtn');
    const runWorkflowGroupsToolBtn = document.getElementById('runWorkflowGroupsToolBtn');
    const bookmarkletToolModal = document.getElementById('bookmarkletToolModal');
    const bookmarkletToolModalTitle = document.getElementById('bookmarkletToolModalTitle');
    const bookmarkletToolModalActions = document.getElementById('bookmarkletToolModalActions');
    const bookmarkletToolModalBody = document.getElementById('bookmarkletToolModalBody');
    const bookmarkletToolModalCloseBtn = document.getElementById('bookmarkletToolModalCloseBtn');

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
    // Keep Slack target suggestions warm without blocking panel startup.
    const LINEAR_SLACK_TARGET_CACHE_STALE_MS = 30 * 60 * 1000;
    // Poll faster so the terminal state appears quickly enough for the 2-second
    // confirmation window before the trigger server posts the Slack summary.
    const LINEAR_TRIGGER_STATUS_POLL_INTERVAL_MS = 1000;
    const LINEAR_TRIGGER_STATUS_POLL_WINDOW_MS = 4 * 60 * 1000;
    // Keep this aligned with the trigger-server Slack delay so the operator sees the
    // terminal run state in-panel before the summary is pushed to Slack.
    const LINEAR_TRIGGER_STATUS_AUTO_CLEAR_MS = 2000;
    let linearTriggerStatusPollTimer = null;
    let linearTriggerStatusPollDeadlineMs = 0;
    let linearTriggerStatusClearTimer = null;
    let dismissedLinearTriggerRunId = '';
    let linearIssueContext = null;
    let linearSlackTargetsCache = { channels: [], users: [], syncedAt: '' };
    let linearSlackTargetSyncPromise = null;

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

    const openEmailFormatterModal = () => {
        if (!openBookmarkletToolModal('Email Formatter')) return;

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

        bookmarkletToolModalActions?.append(convertBtn, nameOnlyBtn, copyBtn, countChip);

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
        bookmarkletToolModalBody?.appendChild(layout);

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
        inputTextarea.focus();
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

    const hasSlackTargetSuggestionsForType = (targetType) => (
        getSlackTargetSuggestionsForType(targetType).length > 0
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
        setElementVisible(
            linearTriggerStatus,
            Boolean(normalizedMessage) && hasAnyExtensionFeature(['linear_create_issue', 'linear_trigger', 'linear_reconcile', 'slack_sync'])
        );
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
        if (!payload.documentId) return 'Generate details first so Document ID is included.';
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

    chrome.runtime.onMessage.addListener((message) => {
        if (!workflowRunState.running) return;
        if (message?.type === 'BL_WORKFLOW_PROGRESS') {
            updateWorkflowProgress(workflowRunState.uiContext, message.current, message.total);
        }
    });

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

    const openWorkflowGroupsModal = async () => {
        if (!openBookmarkletToolModal('Custom Workflow Groups')) return;

        const runBtn = document.createElement('button');
        runBtn.type = 'button';
        runBtn.className = 'bookmarklet-tool-btn active';
        runBtn.textContent = 'Run Bulk Create';

        const testParseBtn = document.createElement('button');
        testParseBtn.type = 'button';
        testParseBtn.className = 'bookmarklet-tool-btn';
        testParseBtn.textContent = 'Test Parse';

        bookmarkletToolModalActions?.append(runBtn, testParseBtn);

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
        bookmarkletToolModalBody?.appendChild(layout);

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

        namesInput.focus();
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

    await loadSlackTargetCache();
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
    if (hasAnyExtensionFeature(['linear_create_issue', 'linear_trigger', 'linear_reconcile', 'slack_sync'])) {
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
    runEmailFormatterToolBtn?.addEventListener('click', openEmailFormatterModal);
    runWorkflowGroupsToolBtn?.addEventListener('click', () => {
        openWorkflowGroupsModal().catch((error) => {
            console.error('Failed to open workflow groups modal:', error);
            showToast('Workflow Groups failed to open.');
        });
    });

    updateDocValidation();
    updateJobValidation();
    updateBulkValidation();
    if (hasAnyExtensionFeature(['job_panel', 'linear_create_issue'])) {
        await loadRecentIds();
        await syncDashboardSuggestionRows({ silent: true });
    }

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

    if (hasExtensionFeature('practice_navigator')) {
        await tryAutoSelectPracticeFromActiveTab();
    }

    showView(getInitialAccessibleViewId());

    // B. Initial Data Load (non-blocking so top navigation responds immediately)
    if (hasExtensionFeature('practice_navigator')) {
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
    }
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
