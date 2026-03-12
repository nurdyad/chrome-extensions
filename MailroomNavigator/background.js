/**
 * MailroomNavigator background service worker.
 *
 * Primary responsibilities:
 * - Cross-tab/background orchestration for panel actions
 * - Practice cache management + hydration
 * - Dashboard summary scraping / notification flow
 * - Linear issue pipeline requests (via local trigger service)
 * - Cross-window tab reuse/open helpers
 */

try {
    importScripts('deployment_defaults.js');
} catch (error) {
    // Deployment defaults are optional. Local development can run without them.
}

// --- 1. Global State ---
let practiceCache = {}; 
const CACHE_EXPIRY = 24 * 60 * 60 * 1000; 
let isScrapingActive = false; 
let practiceCacheRefreshPromise = null;
const BETTERLETTER_ORIGIN = 'https://app.betterletter.ai';
const BETTERLETTER_TAB_PATTERN = `${BETTERLETTER_ORIGIN}/*`;
const LIVE_COUNTS_CACHE_TTL_MS = 45 * 1000;
const LIVE_COUNTS_TEMP_TAB_COOLDOWN_MS = 30 * 1000;
const LIVE_COUNTS_TEMP_TAB_RESULT_WAIT_MS = 6500;
const LIVE_COUNTS_TEMP_TAB_HYDRATE_WINDOW_MS = 5200;
const LINEAR_TRIGGER_SERVER_BASE_URL = 'http://127.0.0.1:4817';
const LINEAR_TRIGGER_SERVER_TIMEOUT_MS = 12000;
const EXTENSION_ACCESS_RESOLVE_TIMEOUT_MS = 1800;
const EXTENSION_ACCESS_CACHE_TTL_MS = 2 * 60 * 1000;
const EXTENSION_USER_MANAGEMENT_STORAGE_KEY = 'extensionUserManagementV1';
const EXTENSION_USER_IDENTITY_OVERRIDE_STORAGE_KEY = 'extensionUserIdentityOverrideV1';
const BETTERLETTER_IDENTITY_SNAPSHOT_STORAGE_KEY = 'betterletterIdentitySnapshotV1';
const EXTENSION_ACCESS_SNAPSHOT_STORAGE_KEY = 'extensionAccessStateSnapshotV1';
const ACCESS_CONTROL_SERVICE_CONFIG_STORAGE_KEY = 'accessControlServiceConfigV1';
const LINEAR_SLACK_PREFS_STORAGE_KEY = 'linearSlackPrefsV1';
const ACCESS_CONTROL_REMOTE_TIMEOUT_MS = 6000;
const ACCESS_CONTROL_SHARED_KEY_HEADER = 'X-MailroomNavigator-Access-Key';
const DEPLOYMENT_DEFAULTS = globalThis.MAILROOMNAV_DEPLOYMENT_DEFAULTS || {};
const liveCountsCacheByOds = new Map();
const liveCountsTempFetchInFlightByOds = new Map();
const liveCountsLastTempFetchAtByOds = new Map();
const liveCountsResolveInFlightByOds = new Map();
const LEGACY_MAILROOM_API_STORAGE_KEYS = ['mailroomApiConfigV1', 'MAILROOM_API_URL', 'MAILROOM_API_KEY'];
const MORNING_DASHBOARD_ALERT_STATE_KEY = 'morningDashboardAlertStateV2';
const MORNING_DASHBOARD_ALERT_RETRY_COOLDOWN_MS = 2 * 60 * 1000;
const MORNING_DASHBOARD_ALERT_MIN_INTERVAL_MS = 10 * 60 * 1000;
const MORNING_DASHBOARD_ALERT_FETCH_TIMEOUT_MS = 14000;
const MORNING_DASHBOARD_ALERT_WINDOW_START_HOUR = 7;
const MORNING_DASHBOARD_ALERT_WINDOW_END_HOUR = 17;
const MORNING_DASHBOARD_BROWSER_ALERT_ENABLED = false;
const HOTKEY_SHOW_LIVE_SUMMARY_COMMAND = 'show_live_dashboard_summary';
const HOTKEY_TOOLTIP_AUTO_HIDE_MS = 8500;
const MORNING_DASHBOARD_ALERT_REQUESTS = [
    {
        key: 'filing',
        label: 'Filing (Docman pipeline)',
        path: '/admin_panel/bots/dashboard?job_types=generate_output+docman_upload+docman_file+merge_tasks_for_same_recipient+docman_review+docman_delete_original+docman_validate&status=paused'
    },
    {
        key: 'docman',
        label: 'Docman Import',
        path: '/admin_panel/bots/dashboard?job_types=docman_import&status=paused'
    },
    {
        key: 'coding',
        label: 'Coding',
        path: '/admin_panel/bots/dashboard?job_types=emis_coding+emis_api_consultation&status=paused'
    },
    {
        key: 'import',
        label: 'Import Jobs',
        path: '/admin_panel/bots/dashboard?job_types=import_jobs+emis_prepare&status=paused'
    }
];
const CACHE_REQUIRED_ACTIONS = new Set([
    'requestActiveScrape',
    'getPracticeStatus',
    'hydratePracticeCdb'
]);
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
const EXTENSION_FEATURE_KEY_SET = new Set(EXTENSION_FEATURE_KEYS);
const OTHER_VIEW_FEATURE_KEYS = [
    'email_formatter',
    'linear_create_issue',
    'linear_trigger',
    'linear_reconcile',
    'slack_sync',
    'workflow_groups',
    'bookmarklet_tools'
];
const EXTENSION_ACTION_FEATURE_REQUIREMENTS = {
    getPracticeCache: ['practice_navigator'],
    requestActiveScrape: ['practice_navigator'],
    getPracticeLiveCounts: ['practice_navigator'],
    getPracticeStatus: ['practice_navigator'],
    hydratePracticeCdb: ['practice_navigator'],
    openPractice: ['practice_navigator'],
    openUrlInNewTab: ['dashboard_hover_tools'],
    createLinearIssueFromEnv: ['linear_create_issue'],
    createLinearIssueAndNotifySlack: ['linear_create_issue'],
    syncLinearSlackWorkspaceTargets: ['slack_sync'],
    triggerLinearBotJobsRun: ['linear_trigger'],
    triggerLinearReconcileRun: ['linear_reconcile'],
    getLinearBotJobsTriggerStatus: ['linear_create_issue', 'linear_trigger', 'linear_reconcile', 'slack_sync']
};
const PROTECTED_EXTENSION_ACTIONS = new Set(Object.keys(EXTENSION_ACTION_FEATURE_REQUIREMENTS));

let extensionAccessStateCache = null;
const extensionAccessResolveInFlightByKey = new Map();

async function clearLegacyMailroomApiStorage() {
    try {
        await chrome.storage.local.remove(LEGACY_MAILROOM_API_STORAGE_KEYS);
    } catch (e) {
        // Ignore storage cleanup failures; they do not affect runtime behavior.
    }
}
clearLegacyMailroomApiStorage();

// --- 2. TAB RE-USE & LIVEVIEW CLICKING ---

/**
 * 🛡️ THE FIX: Searches ALL open windows and monitors for a matching practice tab.
 */
async function findAndFocusPracticeTab(odsCode) {
    const targetUrl = `https://app.betterletter.ai/admin_panel/practices/${odsCode}`;
    // Query ALL windows across ALL monitors
    const tabs = await chrome.tabs.query({ url: `${targetUrl}*` });
    
    if (tabs.length > 0) {
        const existingTab = tabs[0];
        // Focus the correct window first (crucial for multi-monitor setups)
        await chrome.windows.update(existingTab.windowId, { focused: true });
        // Activate the specific tab
        await chrome.tabs.update(existingTab.id, { active: true });
        return existingTab.id;
    }
    return null;
}

/**
 * 🛡️ THE FIX: Polling Clicker for Phoenix LiveView.
 * Waits for the 'phx-click' attribute to be ready before firing.
 */
async function clickLiveViewTab(tabId, settingType) {
    const selectorMap = {
        ehr_settings: "[data-test-id='tab-ehr_settings']",
        task_recipients: "[data-test-id='tab-task_recipients']"
    };
    const selector = selectorMap[settingType];
    if (!selector) return;

    const injectedClick = async (sel) => {
        return new Promise((resolve) => {
            let attempts = 0;
            const interval = setInterval(() => {
                const el = document.querySelector(sel);
                // Check if element exists AND has LiveView attributes ready
                if (el && el.getAttribute('phx-click')) {
                    // Dispatch sequence for robust Phoenix interaction
                    el.focus();
                    ['mousedown', 'mouseup', 'click'].forEach(type => 
                        el.dispatchEvent(new MouseEvent(type, { bubbles: true }))
                    );
                    clearInterval(interval);
                    resolve(true);
                }
                if (attempts++ > 30) { // 15 second total timeout
                    clearInterval(interval);
                    resolve(false);
                }
            }, 500);
        });
    };

    await chrome.scripting.executeScript({
        target: { tabId },
        func: injectedClick,
        args: [selector]
    });
}

async function handleOpenPractice(input, settingType = "ehr_settings") {
    const odsMatch = input.match(/\(([^)]+)\)$/);
    const odsCode = odsMatch ? odsMatch[1] : input.trim();
    
    // 1. Scan all monitors for an existing tab
    let tabId = await findAndFocusPracticeTab(odsCode);
    
    if (!tabId) {
        // 2. Open new tab if none found
        const url = `https://app.betterletter.ai/admin_panel/practices/${odsCode}`;
        const newTab = await chrome.tabs.create({ url, active: true });
        tabId = newTab.id;
    }

    // 3. Trigger the click once LiveView is interactive
    await clickLiveViewTab(tabId, settingType);
    return { success: true };
}

// --- 3. SYSTEM UTILITIES ---

async function setupOffscreen() {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (contexts.length > 0) return;
    await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['DOM_SCRAPING'],
        justification: 'Silent data sync.'
    });
}

function isBetterLetterUrl(url) {
    return typeof url === 'string' && url.startsWith(`${BETTERLETTER_ORIGIN}/`);
}

function isBetterLetterSignInUrl(url) {
    return typeof url === 'string' && /^https:\/\/app\.betterletter\.ai\/sign-in(?:[/?#]|$)/i.test(url);
}

function isScriptableUrl(url) {
    return typeof url === 'string' && /^https?:\/\//i.test(url);
}

// --- Linear Issue Integration ---
// Security note:
// - We sanitize and validate all incoming fields before using them.
// - We never store tokens in background global state.
// - We never include secrets in response payloads back to the UI.
function sanitizeSingleLine(value, maxLength = 1024) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function sanitizeMultiline(value, maxLength = 12000) {
    return String(value || '')
        .replace(/\r\n/g, '\n')
        .replace(/\u0000/g, '')
        .trim()
        .slice(0, maxLength);
}

function normalizeEmail(value) {
    const normalized = sanitizeSingleLine(value, 240).toLowerCase();
    return /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(normalized) ? normalized : '';
}

function clampLinearPriority(value) {
    const parsed = Number.parseInt(String(value ?? '0'), 10);
    return [0, 1, 2, 3, 4].includes(parsed) ? parsed : 0;
}

function normalizeSlackTargetType(value) {
    return String(value || '').trim().toLowerCase() === 'user' ? 'user' : 'channel';
}

function sanitizeServiceBaseUrl(value) {
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

function getDeploymentDefaultAccessServiceBaseUrl() {
    return sanitizeServiceBaseUrl(DEPLOYMENT_DEFAULTS?.sharedAccessServiceBaseUrl);
}

function sanitizeAccessControlServiceConfig(rawConfig = null) {
    const baseUrl = sanitizeServiceBaseUrl(rawConfig?.baseUrl);
    const sharedKey = sanitizeSingleLine(rawConfig?.sharedKey, 240);
    const useLocalOverride = Boolean(rawConfig?.useLocalOverride);
    const defaultBaseUrl = getDeploymentDefaultAccessServiceBaseUrl();
    const effectiveBaseUrl = useLocalOverride ? '' : (baseUrl || defaultBaseUrl);
    return {
        enabled: Boolean(effectiveBaseUrl),
        baseUrl: effectiveBaseUrl,
        sharedKey: useLocalOverride ? '' : sharedKey,
        useLocalOverride,
        isDefault: Boolean(!useLocalOverride && !baseUrl && defaultBaseUrl),
        defaultBaseUrl
    };
}

async function getStoredAccessControlServiceConfig() {
    try {
        const result = await chrome.storage.local.get([ACCESS_CONTROL_SERVICE_CONFIG_STORAGE_KEY]);
        return sanitizeAccessControlServiceConfig(result?.[ACCESS_CONTROL_SERVICE_CONFIG_STORAGE_KEY]);
    } catch {
        return sanitizeAccessControlServiceConfig(null);
    }
}

async function saveStoredAccessControlServiceConfig(rawConfig = null) {
    const useLocalOverride = Boolean(rawConfig?.useLocalOverride);
    const config = sanitizeAccessControlServiceConfig(rawConfig);
    await chrome.storage.local.set({
        [ACCESS_CONTROL_SERVICE_CONFIG_STORAGE_KEY]: {
            baseUrl: useLocalOverride ? '' : sanitizeServiceBaseUrl(rawConfig?.baseUrl),
            sharedKey: useLocalOverride ? '' : sanitizeSingleLine(rawConfig?.sharedKey, 240),
            useLocalOverride
        }
    });
    clearExtensionAccessCache();
    return config;
}

function sanitizeLinearSlackPayload(rawSlack = null) {
    if (!rawSlack || typeof rawSlack !== 'object') return null;
    return {
        enabled: Boolean(rawSlack.enabled),
        targetType: normalizeSlackTargetType(rawSlack.targetType),
        target: sanitizeSingleLine(rawSlack.target, 80).replace(/^[@#]/, '')
    };
}

async function getStoredLinearSlackPrefs() {
    try {
        const result = await chrome.storage.local.get([LINEAR_SLACK_PREFS_STORAGE_KEY]);
        return sanitizeLinearSlackPayload(result?.[LINEAR_SLACK_PREFS_STORAGE_KEY]);
    } catch {
        return null;
    }
}

function sanitizeLinearSlackResult(rawSlack = null) {
    if (!rawSlack || typeof rawSlack !== 'object') return null;
    return {
        attempted: Boolean(rawSlack.attempted),
        success: Boolean(rawSlack.success),
        targetType: normalizeSlackTargetType(rawSlack.targetType),
        target: sanitizeSingleLine(rawSlack.target, 80),
        channel: sanitizeSingleLine(rawSlack.channel, 80),
        ts: sanitizeSingleLine(rawSlack.ts, 64),
        error: sanitizeSingleLine(rawSlack.error, 260)
    };
}

function sanitizeSlackTargetEntry(rawEntry = null, targetType = 'channel') {
    if (!rawEntry || typeof rawEntry !== 'object') return null;
    const type = normalizeSlackTargetType(rawEntry.type || targetType);
    const id = sanitizeSingleLine(rawEntry.id, 80).replace(/^[@#]/, '');
    if (!id) return null;
    const name = sanitizeSingleLine(rawEntry.name, 120);
    const label = sanitizeSingleLine(rawEntry.label, 200)
        || (type === 'user'
            ? (name ? `${name} (${id})` : id)
            : (name ? `#${name} (${id})` : id));
    return { id, name, label, type };
}

function sanitizeSlackTargetList(rawList = [], targetType = 'channel') {
    const source = Array.isArray(rawList) ? rawList : [];
    const map = new Map();
    source.forEach((entry) => {
        const normalized = sanitizeSlackTargetEntry(entry, targetType);
        if (!normalized || map.has(normalized.id)) return;
        map.set(normalized.id, normalized);
    });
    return [...map.values()];
}

function sanitizeSlackTargetsPayload(rawTargets = null) {
    if (!rawTargets || typeof rawTargets !== 'object') {
        return {
            channels: [],
            users: [],
            syncedAt: ''
        };
    }
    return {
        channels: sanitizeSlackTargetList(rawTargets.channels, 'channel'),
        users: sanitizeSlackTargetList(rawTargets.users, 'user'),
        syncedAt: sanitizeSingleLine(rawTargets.syncedAt, 80)
    };
}

function sanitizeLinearIssuePayload(rawPayload = {}) {
    return {
        documentId: sanitizeSingleLine(rawPayload.documentId, 32),
        failedJobId: sanitizeSingleLine(rawPayload.failedJobId, 120),
        fileSizeBytes: sanitizeSingleLine(rawPayload.fileSizeBytes, 120),
        practiceName: sanitizeSingleLine(rawPayload.practiceName, 240),
        letterAdminLink: sanitizeSingleLine(rawPayload.letterAdminLink, 1200),
        failedJobLink: sanitizeSingleLine(rawPayload.failedJobLink, 1200),
        title: sanitizeSingleLine(rawPayload.title, 240),
        description: sanitizeMultiline(rawPayload.description, 12000),
        priority: clampLinearPriority(rawPayload.priority),
        slack: sanitizeLinearSlackPayload(rawPayload?.slack)
    };
}

function validateLinearIssuePayload(payload) {
    if (!/^\d+$/.test(payload.documentId)) {
        throw new Error('Invalid or missing Document ID.');
    }
    if (!payload.title) {
        throw new Error('Issue title is required.');
    }
    if (!payload.description) {
        throw new Error('Issue description is required.');
    }
}

async function handleCreateLinearIssueFromEnv(rawPayload, sender = null) {
    try {
        const payload = sanitizeLinearIssuePayload(rawPayload);
        if (!payload.slack) {
            const accessResult = await handleGetExtensionAccessState({}, sender);
            if (accessResult?.success && hasAccessToAnyRequiredFeature(accessResult.access, ['slack_sync'])) {
                const storedSlackPrefs = await getStoredLinearSlackPrefs();
                if (storedSlackPrefs?.enabled) {
                    payload.slack = storedSlackPrefs;
                }
            }
        }
        validateLinearIssuePayload(payload);

        const { response, payload: serverPayload } = await callLinearTriggerServer('/linear/create-issue', {
            method: 'POST',
            body: payload
        });

        if (!response.ok || !serverPayload?.ok) {
            const serverError = sanitizeSingleLine(serverPayload?.error, 260);
            if (response.status === 404 || serverError.toLowerCase() === 'not found.') {
                return {
                    success: false,
                    error: 'Local trigger service is running an older version. Restart install-linear-trigger-launchagent.sh (or restart node linear-trigger-server.mjs).'
                };
            }
            return {
                success: false,
                error: serverError || `Trigger service failed with status ${response.status}.`
            };
        }

        return {
            success: true,
            issue: {
                identifier: sanitizeSingleLine(serverPayload?.issue?.identifier, 64),
                title: sanitizeSingleLine(serverPayload?.issue?.title, 240),
                url: sanitizeSingleLine(serverPayload?.issue?.url, 1000)
            },
            team: {
                key: sanitizeSingleLine(serverPayload?.team?.key, 32),
                name: sanitizeSingleLine(serverPayload?.team?.name, 120)
            },
            slack: sanitizeLinearSlackResult(serverPayload?.slack)
        };
    } catch (error) {
        return {
            success: false,
            error: normalizeLinearTriggerError(error)
        };
    }
}

async function handleSyncLinearSlackWorkspaceTargets(rawOptions = null) {
    try {
        const force = Boolean(rawOptions && typeof rawOptions === 'object' && rawOptions.force);
        const path = force ? '/slack/targets?force=1' : '/slack/targets';
        const { response, payload } = await callLinearTriggerServer(path, { method: 'GET' });
        if (!response.ok || !payload?.ok) {
            return {
                success: false,
                error: sanitizeSingleLine(payload?.error, 260) || `Trigger service failed with status ${response.status}.`
            };
        }

        return {
            success: true,
            targets: sanitizeSlackTargetsPayload(payload.targets)
        };
    } catch (error) {
        return {
            success: false,
            error: normalizeLinearTriggerError(error)
        };
    }
}

function sanitizeLinearTriggerRunPayload(rawPayload = {}) {
    return {
        dryRun: Boolean(rawPayload?.dryRun),
        slack: sanitizeLinearSlackPayload(rawPayload?.slack)
    };
}

function normalizeLinearTriggerRunType(rawType) {
    return sanitizeSingleLine(rawType, 32).toLowerCase() === 'reconcile'
        ? 'reconcile'
        : 'trigger';
}

function sanitizeLinearTriggerRunLines(rawLines = [], maxItems = 10, maxLength = 240) {
    if (!Array.isArray(rawLines)) return [];
    return rawLines
        .map((line) => sanitizeSingleLine(line, maxLength))
        .filter(Boolean)
        .slice(0, maxItems);
}

function sanitizeLinearTriggerRun(rawRun = null) {
    if (!rawRun || typeof rawRun !== 'object') return null;
    const status = sanitizeSingleLine(rawRun.status, 32).toLowerCase();
    const exitCode = typeof rawRun.exitCode === 'number' && Number.isFinite(rawRun.exitCode)
        ? rawRun.exitCode
        : null;
    return {
        runId: sanitizeSingleLine(rawRun.runId, 80),
        startedAt: sanitizeSingleLine(rawRun.startedAt, 80),
        endedAt: sanitizeSingleLine(rawRun.endedAt, 80),
        status: ['running', 'success', 'failed'].includes(status) ? status : '',
        runType: normalizeLinearTriggerRunType(rawRun.runType),
        dryRun: Boolean(rawRun.dryRun),
        exitCode,
        signal: sanitizeSingleLine(rawRun.signal, 32),
        error: sanitizeSingleLine(rawRun.error, 260),
        summaryLines: sanitizeLinearTriggerRunLines(rawRun.summaryLines, 10, 240),
        reportErrors: sanitizeLinearTriggerRunLines(rawRun.reportErrors, 4, 240),
        createdIssuesTotal: Number.isFinite(Number(rawRun.createdIssuesTotal)) ? Number(rawRun.createdIssuesTotal) : 0,
        previewIssuesTotal: Number.isFinite(Number(rawRun.previewIssuesTotal)) ? Number(rawRun.previewIssuesTotal) : 0,
        skippedDuplicatesTotal: Number.isFinite(Number(rawRun.skippedDuplicatesTotal)) ? Number(rawRun.skippedDuplicatesTotal) : 0,
        actionableFoundTotal: Number.isFinite(Number(rawRun.actionableFoundTotal)) ? Number(rawRun.actionableFoundTotal) : 0,
        issueCandidatesTotal: Number.isFinite(Number(rawRun.issueCandidatesTotal)) ? Number(rawRun.issueCandidatesTotal) : 0,
        floodMode: Boolean(rawRun.floodMode),
        slackNotification: sanitizeLinearSlackResult(rawRun.slackNotification)
    };
}

function sanitizeExtensionAccessState(rawAccess = null) {
    if (!rawAccess || typeof rawAccess !== 'object') {
        return {
            enabled: true,
            initialized: true,
            allowed: false,
            isOwner: false,
            canManageUsers: false,
            role: '',
            email: '',
            matchedRule: '',
            reason: '',
            detectionSource: '',
            requestStatus: '',
            requestRequestedAt: '',
            requestUpdatedAt: '',
            requestRequestedFeatures: [],
            features: Object.fromEntries(EXTENSION_FEATURE_KEYS.map((key) => [key, false])),
            featureCatalog: EXTENSION_FEATURE_CATALOG.map((feature) => ({ ...feature }))
        };
    }

    const features = Object.fromEntries(EXTENSION_FEATURE_KEYS.map((key) => [
        key,
        Boolean(rawAccess?.features?.[key])
    ]));

    return {
        enabled: true,
        initialized: Boolean(rawAccess.initialized),
        allowed: Boolean(rawAccess.allowed),
        isOwner: Boolean(rawAccess.isOwner),
        canManageUsers: Boolean(rawAccess.canManageUsers),
        role: sanitizeSingleLine(rawAccess.role, 40),
        email: normalizeEmail(rawAccess.email),
        matchedRule: sanitizeSingleLine(rawAccess.matchedRule, 120),
        reason: sanitizeSingleLine(rawAccess.reason, 260),
        detectionSource: sanitizeSingleLine(rawAccess.detectionSource, 120),
        requestStatus: sanitizeSingleLine(rawAccess.requestStatus, 40),
        requestRequestedAt: sanitizeSingleLine(rawAccess.requestRequestedAt, 80),
        requestUpdatedAt: sanitizeSingleLine(rawAccess.requestUpdatedAt, 80),
        requestRequestedFeatures: Array.isArray(rawAccess?.requestRequestedFeatures)
            ? rawAccess.requestRequestedFeatures
                .map((featureKey) => sanitizeSingleLine(featureKey, 64))
                .filter((featureKey) => EXTENSION_FEATURE_KEYS.includes(featureKey))
            : [],
        features,
        featureCatalog: EXTENSION_FEATURE_CATALOG.map((feature) => ({ ...feature }))
    };
}

function buildUnavailableExtensionAccessState(identity = null, reason = '') {
    return sanitizeExtensionAccessState({
        initialized: Boolean(normalizeEmail(identity?.email)),
        allowed: false,
        isOwner: false,
        canManageUsers: false,
        role: '',
        email: normalizeEmail(identity?.email),
        reason,
        detectionSource: sanitizeSingleLine(identity?.source, 120),
        features: buildExtensionFeatureAccessMap([], false)
    });
}

function sanitizeStoredExtensionAccessSnapshot(rawSnapshot = null) {
    if (!rawSnapshot || typeof rawSnapshot !== 'object') {
        return {
            email: '',
            checkedAt: 0,
            access: sanitizeExtensionAccessState(null)
        };
    }

    return {
        email: normalizeEmail(rawSnapshot.email),
        checkedAt: Number.isFinite(Number(rawSnapshot.checkedAt)) ? Number(rawSnapshot.checkedAt) : 0,
        access: sanitizeExtensionAccessState(rawSnapshot.access)
    };
}

function clearExtensionAccessCache() {
    extensionAccessStateCache = {
        userIdentity: extensionAccessStateCache?.userIdentity || null,
        userIdentityCheckedAt: extensionAccessStateCache?.userIdentityCheckedAt || 0
    };
}

function sanitizeBetterLetterIdentitySnapshot(rawSnapshot = null) {
    if (!rawSnapshot || typeof rawSnapshot !== 'object') {
        return {
            email: '',
            source: '',
            tabId: null,
            capturedAt: ''
        };
    }
    const tabId = typeof rawSnapshot.tabId === 'number' && Number.isFinite(rawSnapshot.tabId)
        ? rawSnapshot.tabId
        : null;
    return {
        email: normalizeEmail(rawSnapshot.email),
        source: sanitizeSingleLine(rawSnapshot.source, 120),
        tabId,
        capturedAt: sanitizeSingleLine(rawSnapshot.capturedAt, 80)
    };
}

async function saveBetterLetterIdentitySnapshot(rawSnapshot = null) {
    const snapshot = sanitizeBetterLetterIdentitySnapshot(rawSnapshot);
    if (!snapshot.email) return snapshot;
    try {
        await chrome.storage.local.set({ [BETTERLETTER_IDENTITY_SNAPSHOT_STORAGE_KEY]: snapshot });
    } catch (error) {
        // Ignore persistence failures; runtime cache still helps for this session.
    }
    extensionAccessStateCache = {
        ...(extensionAccessStateCache || {}),
        betterLetterIdentitySnapshot: snapshot
    };
    clearExtensionAccessCache();
    return snapshot;
}

async function getStoredBetterLetterIdentitySnapshot() {
    if (extensionAccessStateCache?.betterLetterIdentitySnapshot?.email) {
        return sanitizeBetterLetterIdentitySnapshot(extensionAccessStateCache.betterLetterIdentitySnapshot);
    }
    try {
        const result = await chrome.storage.local.get([BETTERLETTER_IDENTITY_SNAPSHOT_STORAGE_KEY]);
        const snapshot = sanitizeBetterLetterIdentitySnapshot(result?.[BETTERLETTER_IDENTITY_SNAPSHOT_STORAGE_KEY]);
        extensionAccessStateCache = {
            ...(extensionAccessStateCache || {}),
            betterLetterIdentitySnapshot: snapshot
        };
        return snapshot;
    } catch (error) {
        return sanitizeBetterLetterIdentitySnapshot(null);
    }
}

async function getStoredExtensionAccessSnapshot() {
    if (extensionAccessStateCache?.storedAccessSnapshot?.email) {
        return sanitizeStoredExtensionAccessSnapshot(extensionAccessStateCache.storedAccessSnapshot);
    }
    try {
        const result = await chrome.storage.local.get([EXTENSION_ACCESS_SNAPSHOT_STORAGE_KEY]);
        const snapshot = sanitizeStoredExtensionAccessSnapshot(result?.[EXTENSION_ACCESS_SNAPSHOT_STORAGE_KEY]);
        extensionAccessStateCache = {
            ...(extensionAccessStateCache || {}),
            storedAccessSnapshot: snapshot
        };
        return snapshot;
    } catch (error) {
        return sanitizeStoredExtensionAccessSnapshot(null);
    }
}

async function saveStoredExtensionAccessSnapshot(access, checkedAt = Date.now()) {
    const sanitizedAccess = sanitizeExtensionAccessState(access);
    const snapshot = sanitizeStoredExtensionAccessSnapshot({
        email: sanitizedAccess.email,
        checkedAt,
        access: sanitizedAccess
    });
    if (!snapshot.email) return snapshot;
    try {
        await chrome.storage.local.set({ [EXTENSION_ACCESS_SNAPSHOT_STORAGE_KEY]: snapshot });
    } catch (error) {
        // Ignore persistence failures; runtime cache still helps for this session.
    }
    extensionAccessStateCache = {
        ...(extensionAccessStateCache || {}),
        storedAccessSnapshot: snapshot
    };
    return snapshot;
}

function normalizeManagedUserRole(rawRole) {
    return String(rawRole || '').trim().toLowerCase() === 'super_admin' ? 'super_admin' : 'user';
}

function normalizeManagedFeatureList(rawFeatures = []) {
    if (!Array.isArray(rawFeatures)) return [];
    const unique = new Set();
    rawFeatures.forEach((featureKey) => {
        const normalized = sanitizeSingleLine(featureKey, 64);
        if (!EXTENSION_FEATURE_KEY_SET.has(normalized)) return;
        unique.add(normalized);
    });
    return [...unique];
}

function buildExtensionFeatureAccessMap(rawFeatures = [], forceAll = false) {
    const granted = forceAll ? EXTENSION_FEATURE_KEYS : normalizeManagedFeatureList(rawFeatures);
    const grantedSet = new Set(granted);
    return Object.fromEntries(EXTENSION_FEATURE_KEYS.map((featureKey) => [featureKey, grantedSet.has(featureKey)]));
}

function sanitizeManagedUserRecord(rawUser = null, fallbackEmail = '') {
    const email = normalizeEmail(rawUser?.email || fallbackEmail);
    if (!email) return null;

    const role = normalizeManagedUserRole(rawUser?.role);
    const features = role === 'super_admin'
        ? [...EXTENSION_FEATURE_KEYS]
        : normalizeManagedFeatureList(rawUser?.features);

    return {
        email,
        role,
        features,
        createdAt: sanitizeSingleLine(rawUser?.createdAt, 80),
        updatedAt: sanitizeSingleLine(rawUser?.updatedAt, 80),
        createdBy: normalizeEmail(rawUser?.createdBy),
        updatedBy: normalizeEmail(rawUser?.updatedBy)
    };
}

function sanitizeExtensionUserManagement(rawState = null) {
    const users = {};
    const sourceUsers = rawState?.users && typeof rawState.users === 'object' ? rawState.users : {};

    Object.entries(sourceUsers).forEach(([emailKey, rawUser]) => {
        const normalizedUser = sanitizeManagedUserRecord(rawUser, emailKey);
        if (!normalizedUser) return;
        users[normalizedUser.email] = normalizedUser;
    });

    return {
        version: 1,
        initializedAt: sanitizeSingleLine(rawState?.initializedAt, 80),
        updatedAt: sanitizeSingleLine(rawState?.updatedAt, 80),
        users
    };
}

async function getStoredExtensionUserManagement() {
    try {
        const result = await chrome.storage.local.get([EXTENSION_USER_MANAGEMENT_STORAGE_KEY]);
        return sanitizeExtensionUserManagement(result?.[EXTENSION_USER_MANAGEMENT_STORAGE_KEY]);
    } catch (error) {
        return sanitizeExtensionUserManagement(null);
    }
}

async function getStoredExtensionIdentityOverride() {
    try {
        const result = await chrome.storage.local.get([EXTENSION_USER_IDENTITY_OVERRIDE_STORAGE_KEY]);
        return normalizeEmail(result?.[EXTENSION_USER_IDENTITY_OVERRIDE_STORAGE_KEY]);
    } catch (error) {
        return '';
    }
}

async function setStoredExtensionIdentityOverride(email) {
    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail) {
        await chrome.storage.local.remove([EXTENSION_USER_IDENTITY_OVERRIDE_STORAGE_KEY]);
        clearExtensionAccessCache();
        return '';
    }
    await chrome.storage.local.set({ [EXTENSION_USER_IDENTITY_OVERRIDE_STORAGE_KEY]: normalizedEmail });
    clearExtensionAccessCache();
    return normalizedEmail;
}

async function saveStoredExtensionUserManagement(rawState) {
    const sanitizedState = sanitizeExtensionUserManagement(rawState);
    await chrome.storage.local.set({ [EXTENSION_USER_MANAGEMENT_STORAGE_KEY]: sanitizedState });
    clearExtensionAccessCache();
    return sanitizedState;
}

function getManagedUserFeatureAccess(userRecord = null) {
    if (!userRecord) return buildExtensionFeatureAccessMap([], false);
    return buildExtensionFeatureAccessMap(userRecord.features, userRecord.role === 'super_admin');
}

function listManagedUsers(managementState) {
    return Object.values(managementState?.users || {})
        .map((user) => sanitizeManagedUserRecord(user))
        .filter(Boolean)
        .sort((a, b) => {
            if (a.role !== b.role) {
                return a.role === 'super_admin' ? -1 : 1;
            }
            return a.email.localeCompare(b.email);
        });
}

function countManagedSuperAdmins(managementState) {
    return listManagedUsers(managementState).filter((user) => user.role === 'super_admin').length;
}

function buildResolvedExtensionAccessState(identity, managementState) {
    const email = normalizeEmail(identity?.email);
    const detectionSource = sanitizeSingleLine(identity?.source, 120);
    const users = managementState?.users || {};
    const initialized = Object.keys(users).length > 0;

    if (!email) {
        return sanitizeExtensionAccessState({
            initialized,
            allowed: false,
            canBootstrap: !initialized,
            isSuperAdmin: false,
            role: '',
            email: '',
            reason: initialized
                ? 'Could not detect the current BetterLetter user email. Enter it manually in the panel, then refresh access.'
                : 'Could not detect the current BetterLetter user email. Enter it manually in the panel to bootstrap user management.',
            detectionSource,
            features: buildExtensionFeatureAccessMap([], false)
        });
    }

    if (!initialized) {
        return sanitizeExtensionAccessState({
            initialized: false,
            allowed: false,
            canBootstrap: true,
            isSuperAdmin: false,
            role: '',
            email,
            reason: 'No MailroomNavigator super admin is configured yet. Bootstrap yourself first, then manage users from the panel.',
            detectionSource,
            features: buildExtensionFeatureAccessMap([], false)
        });
    }

    const userRecord = sanitizeManagedUserRecord(users[email], email);
    if (!userRecord) {
        return sanitizeExtensionAccessState({
            initialized: true,
            allowed: false,
            canBootstrap: false,
            isSuperAdmin: false,
            role: '',
            email,
            reason: 'You do not have access to MailroomNavigator. Ask a super admin to grant your BetterLetter email access.',
            detectionSource,
            features: buildExtensionFeatureAccessMap([], false)
        });
    }

    const features = getManagedUserFeatureAccess(userRecord);
    const hasAnyFeature = Object.values(features).some(Boolean);
    const isSuperAdmin = userRecord.role === 'super_admin';

    return sanitizeExtensionAccessState({
        initialized: true,
        allowed: isSuperAdmin || hasAnyFeature,
        canBootstrap: false,
        isSuperAdmin,
        role: userRecord.role,
        email,
        reason: isSuperAdmin || hasAnyFeature
            ? ''
            : 'Your account exists but no features are enabled yet. Ask a super admin to grant at least one feature.',
        detectionSource,
        features
    });
}

async function resolveExtensionAccessContext(rawPayload = {}, sender = null) {
    const preferredTabId = typeof sender?.tab?.id === 'number' ? sender.tab.id : null;
    const forceRefresh = Boolean(rawPayload?.forceRefresh);
    const identity = await resolveCurrentBetterLetterUserIdentity({ preferredTabId, forceRefresh });
    const management = await getStoredExtensionUserManagement();
    const access = buildResolvedExtensionAccessState(identity, management);
    const cacheKey = `${access.email || 'unknown'}|${preferredTabId || 'any'}|${Object.keys(management.users || {}).length}`;
    extensionAccessStateCache = {
        ...(extensionAccessStateCache || {}),
        cacheKey,
        access,
        checkedAt: Date.now()
    };
    return { identity, management, access };
}

function getRequiredFeaturesForAction(action) {
    const requirement = EXTENSION_ACTION_FEATURE_REQUIREMENTS[String(action || '').trim()];
    if (!requirement) return [];
    return Array.isArray(requirement) ? requirement : [requirement];
}

function hasAccessToAnyRequiredFeature(access, requiredFeatures = []) {
    if (!Array.isArray(requiredFeatures) || requiredFeatures.length === 0) return true;
    if (access?.isOwner) return true;
    return requiredFeatures.some((featureKey) => Boolean(access?.features?.[featureKey]));
}

function serializeManagedUserForUi(userRecord = null) {
    const sanitizedUser = sanitizeManagedUserRecord(userRecord);
    if (!sanitizedUser) return null;
    return {
        email: sanitizedUser.email,
        role: sanitizedUser.role,
        features: sanitizedUser.role === 'super_admin' ? [...EXTENSION_FEATURE_KEYS] : [...sanitizedUser.features],
        createdAt: sanitizedUser.createdAt,
        updatedAt: sanitizedUser.updatedAt,
        createdBy: sanitizedUser.createdBy,
        updatedBy: sanitizedUser.updatedBy
    };
}

async function callJsonService(baseUrl, path, {
    method = 'GET',
    body = null,
    timeoutMs = LINEAR_TRIGGER_SERVER_TIMEOUT_MS,
    extraHeaders = {}
} = {}) {
    const normalizedPath = String(path || '').trim().startsWith('/') ? String(path).trim() : `/${String(path || '').trim()}`;
    const targetUrl = `${String(baseUrl || '').replace(/\/+$/, '')}${normalizedPath}`;

    const controller = new AbortController();
    const resolvedTimeoutMs = Math.max(250, Number(timeoutMs) || LINEAR_TRIGGER_SERVER_TIMEOUT_MS);
    const timeout = setTimeout(() => controller.abort(), resolvedTimeoutMs);

    try {
        const headers = { 'Accept': 'application/json', ...extraHeaders };
        const init = { method, headers, signal: controller.signal };
        if (body !== null) {
            headers['Content-Type'] = 'application/json';
            init.body = JSON.stringify(body);
        }

        const response = await fetch(targetUrl, init);
        let payload = null;
        try {
            payload = await response.json();
        } catch (e) {
            payload = null;
        }

        return { response, payload };
    } finally {
        clearTimeout(timeout);
    }
}

async function callLinearTriggerServer(path, options = {}) {
    return callJsonService(LINEAR_TRIGGER_SERVER_BASE_URL, path, options);
}

async function callAccessControlService(path, options = {}) {
    const config = await getStoredAccessControlServiceConfig();
    const hasConfiguredRemote = Boolean(config.enabled && config.baseUrl);
    const canFallbackToDefaultRemote = Boolean(
        config.useLocalOverride
        && config.defaultBaseUrl
        && config.defaultBaseUrl !== LINEAR_TRIGGER_SERVER_BASE_URL
    );

    const requestService = async (baseUrl, {
        usingRemoteConfig = false,
        sharedKey = ''
    } = {}) => {
        const extraHeaders = { ...(options.extraHeaders || {}) };
        if (usingRemoteConfig && sharedKey) {
            extraHeaders[ACCESS_CONTROL_SHARED_KEY_HEADER] = sharedKey;
        }
        const request = await callJsonService(baseUrl, path, {
            ...options,
            timeoutMs: usingRemoteConfig
                ? Math.max(250, Number(options.timeoutMs) || ACCESS_CONTROL_REMOTE_TIMEOUT_MS)
                : options.timeoutMs,
            extraHeaders
        });
        return {
            ...request,
            usingRemoteConfig,
            baseUrl
        };
    };

    if (hasConfiguredRemote) {
        return await requestService(config.baseUrl, {
            usingRemoteConfig: true,
            sharedKey: config.sharedKey
        });
    }

    try {
        return await requestService(LINEAR_TRIGGER_SERVER_BASE_URL, {
            usingRemoteConfig: false
        });
    } catch (error) {
        if (!canFallbackToDefaultRemote) throw error;
        return await requestService(config.defaultBaseUrl, {
            usingRemoteConfig: true,
            sharedKey: config.sharedKey
        });
    }
}

function normalizeLinearTriggerError(error) {
    const errorName = sanitizeSingleLine(error?.name, 80).toLowerCase();
    if (errorName === 'aborterror') {
        return 'Local trigger service timed out.';
    }

    const message = sanitizeSingleLine(error?.message, 220);
    if (!message) {
        return 'Local trigger service is unavailable.';
    }

    if (message.toLowerCase().includes('failed to fetch')) {
        return 'Local trigger service is unavailable. Run install-linear-trigger-launchagent.sh.';
    }

    return message;
}

function normalizeAccessControlServiceError(error, { usingRemoteConfig = false } = {}) {
    const errorName = sanitizeSingleLine(error?.name, 80).toLowerCase();
    if (errorName === 'aborterror') {
        return usingRemoteConfig
            ? 'Shared access service timed out.'
            : 'Local trigger service timed out.';
    }

    const message = sanitizeSingleLine(error?.message, 220);
    if (!message) {
        return usingRemoteConfig
            ? 'Shared access service is unavailable.'
            : 'Local trigger service is unavailable.';
    }

    if (message.toLowerCase().includes('failed to fetch')) {
        return usingRemoteConfig
            ? 'Shared access service is unavailable.'
            : 'Local trigger service is unavailable. Run install-linear-trigger-launchagent.sh.';
    }

    return message;
}

async function handleTriggerLinearRun(rawPayload, triggerPath = '/trigger-linear') {
    try {
        const payload = sanitizeLinearTriggerRunPayload(rawPayload);
        const { response, payload: serverPayload } = await callLinearTriggerServer(triggerPath, {
            method: 'POST',
            body: payload
        });

        const run = sanitizeLinearTriggerRun(serverPayload?.run);
        if (response.status === 409) {
            return {
                success: false,
                running: true,
                run,
                error: sanitizeSingleLine(serverPayload?.error, 220) || 'A bot-jobs run is already in progress.'
            };
        }

        if (!response.ok || !serverPayload?.ok) {
            const serverError = sanitizeSingleLine(serverPayload?.error, 240);
            if (response.status === 404 || serverError.toLowerCase() === 'not found.') {
                return {
                    success: false,
                    error: 'Local trigger service is running an older version. Restart install-linear-trigger-launchagent.sh (or restart node linear-trigger-server.mjs).'
                };
            }
            return {
                success: false,
                error: serverError || `Trigger service failed with status ${response.status}.`
            };
        }

        return {
            success: true,
            run
        };
    } catch (error) {
        return {
            success: false,
            error: normalizeLinearTriggerError(error)
        };
    }
}

async function handleTriggerLinearBotJobsRun(rawPayload) {
    return handleTriggerLinearRun(rawPayload, '/trigger-linear');
}

async function handleTriggerLinearReconcileRun(rawPayload) {
    return handleTriggerLinearRun(rawPayload, '/trigger-linear-reconcile');
}

async function handleGetLinearBotJobsTriggerStatus() {
    try {
        const { response, payload } = await callLinearTriggerServer('/health', { method: 'GET' });
        if (!response.ok || !payload?.ok) {
            return {
                success: false,
                error: sanitizeSingleLine(payload?.error, 240) || `Trigger service health failed with status ${response.status}.`
            };
        }

        return {
            success: true,
            status: {
                running: Boolean(payload.running),
                activeRun: sanitizeLinearTriggerRun(payload.activeRun),
                lastRun: sanitizeLinearTriggerRun(payload.lastRun),
                serverTime: sanitizeSingleLine(payload.serverTime, 80)
            }
        };
    } catch (error) {
        return {
            success: false,
            error: normalizeLinearTriggerError(error)
        };
    }
}

function getTabUrl(tab) {
    if (typeof tab?.url === 'string') return tab.url;
    if (typeof tab?.pendingUrl === 'string') return tab.pendingUrl;
    return '';
}

function isWithinLocalAlertWindow(timestampMs = Date.now()) {
    const hour = new Date(timestampMs).getHours();
    const startHour = Number(MORNING_DASHBOARD_ALERT_WINDOW_START_HOUR);
    const endHour = Number(MORNING_DASHBOARD_ALERT_WINDOW_END_HOUR);
    if (!Number.isInteger(startHour) || !Number.isInteger(endHour)) return true;
    if (startHour === endHour) return true;
    if (startHour < endHour) return hour >= startHour && hour < endHour;
    return hour >= startHour || hour < endHour;
}

function formatMorningCount(value) {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    return Number.isFinite(parsed) && parsed >= 0 ? String(parsed) : 'N/A';
}

function buildMorningDashboardSummaryMessage(summary) {
    const generatedAt = new Date(summary?.generatedAt || Date.now());
    const dateLabel = generatedAt.toLocaleDateString(undefined, {
        weekday: 'short',
        year: 'numeric',
        month: 'short',
        day: 'numeric'
    });
    const timeLabel = generatedAt.toLocaleTimeString(undefined, {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    });

    const lines = [
        `BetterLetter Morning Summary (${dateLabel} ${timeLabel})`,
        ''
    ];

    const categories = Array.isArray(summary?.categories) ? summary.categories : [];
    categories.forEach((item) => {
        const label = String(item?.label || item?.key || 'Category').trim();
        const requireAttention = formatMorningCount(item?.requireAttentionCount);
        lines.push(`${label}: Require Attention ${requireAttention}`);
    });

    if (categories.length > 0) {
        lines.push('');
        lines.push('Source: Bots Dashboard paused filters');
    }

    return lines.join('\n');
}

function buildHotkeySummaryTooltipData(summary, errorMessage = '') {
    if (errorMessage) {
        return {
            title: 'MailroomNavigator',
            lines: [String(errorMessage || 'Unable to load summary.')],
            isError: true
        };
    }

    const generatedAt = new Date(summary?.generatedAt || Date.now());
    const updatedAt = generatedAt.toLocaleTimeString(undefined, {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    });

    const categories = Array.isArray(summary?.categories) ? summary.categories : [];
    const lines = categories.map((item) => {
        const label = String(item?.label || item?.key || 'Category').trim();
        const requireAttention = formatMorningCount(item?.requireAttentionCount);
        return `${label}: ${requireAttention} require attention`;
    });
    lines.push(`Updated: ${updatedAt}`);

    return {
        title: 'Live BetterLetter Summary',
        lines,
        isError: false
    };
}

async function showHotkeySummaryTooltipInTab(tabId, tooltipData) {
    if (typeof tabId !== 'number') return false;
    if (!tooltipData || typeof tooltipData !== 'object') return false;

    const title = sanitizeSingleLine(tooltipData.title, 80) || 'MailroomNavigator';
    const lines = Array.isArray(tooltipData.lines)
        ? tooltipData.lines.map((line) => sanitizeSingleLine(line, 220)).filter(Boolean).slice(0, 8)
        : [];
    const isError = Boolean(tooltipData.isError);
    if (!lines.length) return false;

    try {
        await chrome.scripting.executeScript({
            target: { tabId },
            func: (payload, hideMs) => {
                try {
                    const TOOLTIP_ID = '__mailroomnavigator_hotkey_summary_tooltip';
                    const POINTER_STATE_KEY = '__mailroomnavigator_pointer_state';
                    const fallbackX = Math.max(24, window.innerWidth - 28);
                    const fallbackY = 72;

                    if (!window[POINTER_STATE_KEY]) {
                        window[POINTER_STATE_KEY] = { x: fallbackX, y: fallbackY };
                        const capturePointer = (event) => {
                            window[POINTER_STATE_KEY] = {
                                x: Number(event?.clientX || fallbackX),
                                y: Number(event?.clientY || fallbackY)
                            };
                        };
                        document.addEventListener('mousemove', capturePointer, { passive: true });
                        document.addEventListener('pointermove', capturePointer, { passive: true });
                    }

                    const existing = document.getElementById(TOOLTIP_ID);
                    if (existing) {
                        const timerId = Number(existing.dataset.hideTimer || 0);
                        if (Number.isFinite(timerId) && timerId > 0) window.clearTimeout(timerId);
                        existing.remove();
                    }

                    const tooltipEl = document.createElement('div');
                    tooltipEl.id = TOOLTIP_ID;
                    tooltipEl.style.position = 'fixed';
                    tooltipEl.style.zIndex = '2147483647';
                    tooltipEl.style.maxWidth = '420px';
                    tooltipEl.style.minWidth = '260px';
                    tooltipEl.style.padding = '10px 12px';
                    tooltipEl.style.borderRadius = '10px';
                    tooltipEl.style.boxShadow = '0 10px 25px rgba(0,0,0,0.3)';
                    tooltipEl.style.border = payload?.isError ? '1px solid rgba(220, 38, 38, 0.85)' : '1px solid rgba(30, 64, 175, 0.85)';
                    tooltipEl.style.background = payload?.isError ? 'rgba(127, 29, 29, 0.95)' : 'rgba(15, 23, 42, 0.95)';
                    tooltipEl.style.color = '#ffffff';
                    tooltipEl.style.font = '13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
                    tooltipEl.style.whiteSpace = 'pre-wrap';
                    tooltipEl.style.pointerEvents = 'none';
                    tooltipEl.style.opacity = '0';
                    tooltipEl.style.transition = 'opacity 140ms ease';

                    const titleEl = document.createElement('div');
                    titleEl.textContent = String(payload?.title || 'MailroomNavigator');
                    titleEl.style.fontWeight = '700';
                    titleEl.style.marginBottom = '6px';
                    titleEl.style.color = payload?.isError ? '#fecaca' : '#bfdbfe';
                    tooltipEl.appendChild(titleEl);

                    const bodyEl = document.createElement('div');
                    bodyEl.textContent = Array.isArray(payload?.lines) ? payload.lines.join('\n') : '';
                    tooltipEl.appendChild(bodyEl);

                    (document.body || document.documentElement).appendChild(tooltipEl);

                    const pointer = window[POINTER_STATE_KEY] || { x: fallbackX, y: fallbackY };
                    let left = Number(pointer.x || fallbackX) + 16;
                    let top = Number(pointer.y || fallbackY) + 18;
                    const rect = tooltipEl.getBoundingClientRect();
                    if (left + rect.width > window.innerWidth - 12) {
                        left = Math.max(12, Number(pointer.x || fallbackX) - rect.width - 16);
                    }
                    if (top + rect.height > window.innerHeight - 12) {
                        top = Math.max(12, window.innerHeight - rect.height - 12);
                    }
                    tooltipEl.style.left = `${Math.round(left)}px`;
                    tooltipEl.style.top = `${Math.round(top)}px`;

                    requestAnimationFrame(() => {
                        tooltipEl.style.opacity = '1';
                    });

                    const closeTimer = window.setTimeout(() => {
                        tooltipEl.style.opacity = '0';
                        window.setTimeout(() => tooltipEl.remove(), 180);
                    }, Math.max(1500, Number(hideMs || 8000)));
                    tooltipEl.dataset.hideTimer = String(closeTimer);
                } catch (e) {
                    // Ignore tooltip rendering failures in page context.
                }
            },
            args: [{ title, lines, isError }, HOTKEY_TOOLTIP_AUTO_HIDE_MS]
        });
        return true;
    } catch (e) {
        return false;
    }
}

async function showLiveSummaryViaHotkey() {
    let activeTab = null;
    try {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        activeTab = tabs?.[0] || null;
    } catch (e) {
        activeTab = null;
    }

    const activeTabId = activeTab?.id;
    const activeTabUrl = getTabUrl(activeTab);
    if (typeof activeTabId !== 'number' || !isScriptableUrl(activeTabUrl)) return;

    try {
        const summary = await withTimeout(
            fetchMorningDashboardSummaryFromSession(),
            MORNING_DASHBOARD_ALERT_FETCH_TIMEOUT_MS
        );
        if (!summary || typeof summary !== 'object') {
            await showHotkeySummaryTooltipInTab(
                activeTabId,
                buildHotkeySummaryTooltipData(null, 'Unable to load BetterLetter summary right now.')
            );
            return;
        }
        if (summary.unauthorized) {
            await showHotkeySummaryTooltipInTab(
                activeTabId,
                buildHotkeySummaryTooltipData(null, 'BetterLetter session is not authorized. Please sign in.')
            );
            return;
        }
        if (!Array.isArray(summary.categories) || summary.categories.length === 0) {
            await showHotkeySummaryTooltipInTab(
                activeTabId,
                buildHotkeySummaryTooltipData(null, 'No dashboard summary data found.')
            );
            return;
        }
        await showHotkeySummaryTooltipInTab(activeTabId, buildHotkeySummaryTooltipData(summary));
    } catch (e) {
        await showHotkeySummaryTooltipInTab(
            activeTabId,
            buildHotkeySummaryTooltipData(null, 'Summary fetch failed. Try again in a few seconds.')
        );
    }
}

let morningDashboardAlertInFlight = false;

async function fetchMorningDashboardSummaryFromSession() {
    const result = await runInExistingBetterLetterTab(async (requestConfigs) => {
        const collapse = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        const normalizeHeader = (value) => collapse(value).toLowerCase().replace(/[^a-z0-9]/g, '');
        const buildLooseLabelPattern = (label) => {
            const tokens = collapse(label).toLowerCase().split(/\s+/).filter(Boolean);
            if (!tokens.length) return '';
            return tokens.join('\\s*');
        };

        const parseCountByLabel = (text, label) => {
            const source = collapse(text);
            const looseLabelPattern = buildLooseLabelPattern(label);
            if (!source || !looseLabelPattern) return null;

            const patterns = [
                new RegExp(`${looseLabelPattern}[^0-9]{0,20}\\((\\d+)\\)`, 'gi'),
                new RegExp(`${looseLabelPattern}[^0-9]{0,20}[:\\-]?\\s*(\\d+)\\b`, 'gi')
            ];

            const values = [];
            patterns.forEach((regex) => {
                for (const match of source.matchAll(regex)) {
                    const parsed = Number.parseInt(String(match?.[1] || ''), 10);
                    if (Number.isFinite(parsed) && parsed >= 0) values.push(parsed);
                }
            });

            if (!values.length) return null;
            return Math.max(...values);
        };

        const parseDocumentId = (value) => {
            const match = collapse(value).match(/\d+/);
            return match ? match[0] : '';
        };

        const parseStatusText = (cell) => collapse(cell?.innerText || cell?.textContent || '');
        const isFailedStatus = (statusText) => /fail|error|attention|still\s*erroring/i.test(String(statusText || ''));

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
                if (normalized.includes('status')) {
                    map.status = index;
                }
            });

            if (typeof map.document !== 'number') return null;
            return map;
        };

        const parseRowsFromDashboardHtml = (html) => {
            const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
            const sourceText = collapse(doc?.body?.innerText || '');
            const unauthorized = /log in|sign in|password/i.test(sourceText) &&
                Boolean(doc.querySelector('form[action*="sign"], input[type="password"]'));

            const tables = Array.from(doc.querySelectorAll('table'));
            let headerMap = null;
            let targetTable = null;
            for (const table of tables) {
                const map = resolveHeaderMap(table);
                if (!map) continue;
                targetTable = table;
                headerMap = map;
                break;
            }

            let rowCount = 0;
            let failedRows = 0;
            if (targetTable && headerMap) {
                const bodyRows = Array.from(targetTable.querySelectorAll('tbody tr'));
                bodyRows.forEach((rowEl) => {
                    const cells = Array.from(rowEl.querySelectorAll('td'));
                    if (!cells.length) return;
                    const documentCell = cells[headerMap.document];
                    const documentId = parseDocumentId(documentCell?.innerText || documentCell?.textContent || '');
                    if (!documentId) return;
                    rowCount += 1;

                    if (typeof headerMap.status === 'number') {
                        const statusCell = cells[headerMap.status];
                        const statusText = parseStatusText(statusCell);
                        if (isFailedStatus(statusText)) failedRows += 1;
                    }
                });
            }

            const requireAttentionCount = parseCountByLabel(sourceText, 'Require Attention');
            const effectiveRequireAttentionCount = Number.isFinite(requireAttentionCount)
                ? requireAttentionCount
                : failedRows;

            return {
                unauthorized,
                rowCount,
                failedRows,
                requireAttentionCount: Number.isFinite(effectiveRequireAttentionCount)
                    ? effectiveRequireAttentionCount
                    : null
            };
        };

        const fetchOneCategory = async (item) => {
            try {
                const response = await fetch(String(item?.path || ''), {
                    credentials: 'include',
                    cache: 'no-store'
                });
                if (!response.ok) {
                    return {
                        key: String(item?.key || ''),
                        label: String(item?.label || item?.key || ''),
                        unauthorized: false,
                        requireAttentionCount: null,
                        rowCount: 0
                    };
                }

                const html = await response.text();
                const parsed = parseRowsFromDashboardHtml(html);
                return {
                    key: String(item?.key || ''),
                    label: String(item?.label || item?.key || ''),
                    unauthorized: parsed.unauthorized,
                    requireAttentionCount: parsed.requireAttentionCount,
                    rowCount: parsed.rowCount
                };
            } catch (e) {
                return {
                    key: String(item?.key || ''),
                    label: String(item?.label || item?.key || ''),
                    unauthorized: false,
                    requireAttentionCount: null,
                    rowCount: 0
                };
            }
        };

        const categories = await Promise.all((Array.isArray(requestConfigs) ? requestConfigs : []).map(fetchOneCategory));
        const unauthorized = categories.some(item => item?.unauthorized);

        return {
            unauthorized,
            generatedAt: Date.now(),
            categories
        };
    }, [MORNING_DASHBOARD_ALERT_REQUESTS]);

    return result && typeof result === 'object' ? result : null;
}

async function showMorningDashboardAlertInTab(tabId, summary) {
    return false;
}

async function maybeTriggerMorningDashboardAlert(tabId, tabUrl, reason = '') {
    if (!MORNING_DASHBOARD_BROWSER_ALERT_ENABLED) return;
    if (morningDashboardAlertInFlight) return;
    if (typeof tabId !== 'number') return;
    if (!isBetterLetterUrl(tabUrl)) return;

    const now = Date.now();
    const isManualTrigger = String(reason || '') === 'action_click';
    if (!isManualTrigger && !isWithinLocalAlertWindow(now)) return;
    let state = {};
    try {
        const stored = await chrome.storage.local.get([MORNING_DASHBOARD_ALERT_STATE_KEY]);
        state = stored?.[MORNING_DASHBOARD_ALERT_STATE_KEY] && typeof stored[MORNING_DASHBOARD_ALERT_STATE_KEY] === 'object'
            ? stored[MORNING_DASHBOARD_ALERT_STATE_KEY]
            : {};
    } catch (e) {
        state = {};
    }

    const lastAttemptAt = Number(state?.lastAttemptAt);
    if (Number.isFinite(lastAttemptAt) && now - lastAttemptAt < MORNING_DASHBOARD_ALERT_RETRY_COOLDOWN_MS) {
        return;
    }

    const lastAlertAt = Number(state?.alertedAt);
    if (!isManualTrigger && Number.isFinite(lastAlertAt) && now - lastAlertAt < MORNING_DASHBOARD_ALERT_MIN_INTERVAL_MS) {
        return;
    }

    morningDashboardAlertInFlight = true;
    try {
        const nextState = {
            lastAttemptAt: now,
            lastReason: String(reason || '')
        };
        await chrome.storage.local.set({ [MORNING_DASHBOARD_ALERT_STATE_KEY]: nextState });

        const summary = await withTimeout(
            fetchMorningDashboardSummaryFromSession(),
            MORNING_DASHBOARD_ALERT_FETCH_TIMEOUT_MS
        );
        if (!summary || typeof summary !== 'object') return;
        if (summary.unauthorized) return;
        if (!Array.isArray(summary.categories) || summary.categories.length === 0) return;

        const alerted = await showMorningDashboardAlertInTab(tabId, summary);
        if (!alerted) return;

        await chrome.storage.local.set({
            [MORNING_DASHBOARD_ALERT_STATE_KEY]: {
                ...nextState,
                alertedAt: Date.now(),
                generatedAt: summary.generatedAt || Date.now()
            }
        });
    } catch (e) {
        // Ignore morning alert failures; core extension workflows should continue.
    } finally {
        morningDashboardAlertInFlight = false;
    }
}

async function setTargetTabId(tabId) {
    if (typeof tabId !== 'number') return;
    try {
        const tab = await chrome.tabs.get(tabId);
        if (!isBetterLetterUrl(getTabUrl(tab))) return;
        await chrome.storage.local.set({ targetTabId: tabId });
    } catch (e) {
        // Ignore missing/closed tabs.
    }
}

async function findAnyBetterLetterTab() {
    const activeCurrentWindow = await chrome.tabs.query({
        active: true,
        currentWindow: true,
        url: BETTERLETTER_TAB_PATTERN
    });
    if (activeCurrentWindow.length > 0) return activeCurrentWindow[0];

    const allBetterLetterTabs = await chrome.tabs.query({ url: BETTERLETTER_TAB_PATTERN });
    return allBetterLetterTabs[0] || null;
}

async function getOrderedBetterLetterTabCandidates(preferredTabId = null) {
    const candidates = [];
    const seen = new Set();
    const pushTab = (tab) => {
        if (!tab || typeof tab.id !== 'number') return;
        if (!isBetterLetterUrl(getTabUrl(tab))) return;
        if (seen.has(tab.id)) return;
        seen.add(tab.id);
        candidates.push(tab);
    };

    if (typeof preferredTabId === 'number') {
        try {
            const preferredTab = await chrome.tabs.get(preferredTabId);
            pushTab(preferredTab);
        } catch (e) {
            // Preferred tab can be stale or not scriptable; ignore and continue.
        }
    }

    try {
        const { targetTabId } = await chrome.storage.local.get(['targetTabId']);
        if (typeof targetTabId === 'number') {
            try {
                const targetTab = await chrome.tabs.get(targetTabId);
                pushTab(targetTab);
            } catch (e) {
                // Stored target tab can be stale; ignore and continue.
            }
        }
    } catch (e) {
        // Ignore storage errors and continue with query-based candidates.
    }

    try {
        const activeCurrentWindow = await chrome.tabs.query({
            active: true,
            currentWindow: true,
            url: BETTERLETTER_TAB_PATTERN
        });
        activeCurrentWindow.forEach(pushTab);
    } catch (e) {
        // Ignore query errors and continue.
    }

    try {
        const allBetterLetterTabs = await chrome.tabs.query({ url: BETTERLETTER_TAB_PATTERN });
        const scoredTabs = [...allBetterLetterTabs].sort((a, b) => {
            const score = (tab) => {
                let value = 0;
                if (tab?.active) value += 200;
                if (tab?.status === 'complete') value += 100;
                if (!tab?.discarded) value += 80;
                if (!tab?.pinned) value += 10;
                if (!isBetterLetterSignInUrl(getTabUrl(tab))) value += 120;
                const lastAccessed = Number(tab?.lastAccessed || 0);
                value += Math.floor(lastAccessed / 1000000);
                return value;
            };
            return score(b) - score(a);
        });
        scoredTabs.forEach(pushTab);
    } catch (e) {
        // Ignore query errors and continue.
    }

    return candidates;
}

async function runInExistingBetterLetterTab(func, args = [], preferredTabId = null) {
    return runInExistingBetterLetterTabWithOptions(func, args, preferredTabId);
}

async function runInExistingBetterLetterTabWithOptions(func, args = [], preferredTabId = null, options = {}) {
    const candidates = await getOrderedBetterLetterTabCandidates(preferredTabId);
    if (!Array.isArray(candidates) || candidates.length === 0) return null;

    for (const tab of candidates) {
        if (!tab?.id || tab.discarded) continue;

        try {
            const [{ result }] = await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                func,
                args,
                ...(options?.world ? { world: options.world } : {})
            });
            if (options?.requireEmailInObject && !normalizeEmail(result?.email)) {
                continue;
            }
            if (options?.requireNonEmptyString && !sanitizeSingleLine(result, 400)) {
                continue;
            }
            await setTargetTabId(tab.id);
            return result;
        } catch (e) {
            // Try the next BetterLetter tab if this one is not scriptable.
        }
    }

    return null;
}

async function resolveCurrentBetterLetterUserIdentity({ preferredTabId = null, forceRefresh = false } = {}) {
    const now = Date.now();
    if (
        !forceRefresh &&
        extensionAccessStateCache?.userIdentity &&
        (now - Number(extensionAccessStateCache.userIdentityCheckedAt || 0) < EXTENSION_ACCESS_CACHE_TTL_MS)
    ) {
        return extensionAccessStateCache.userIdentity;
    }

    const storedSnapshot = await getStoredBetterLetterIdentitySnapshot();
    if (storedSnapshot?.email) {
        const snapshotMatchesPreferredTab = typeof preferredTabId !== 'number' || storedSnapshot.tabId === preferredTabId;
        if (snapshotMatchesPreferredTab) {
            const snapshotIdentity = {
                email: storedSnapshot.email,
                source: storedSnapshot.source || 'content_script_snapshot'
            };
            extensionAccessStateCache = {
                ...(extensionAccessStateCache || {}),
                userIdentity: snapshotIdentity,
                userIdentityCheckedAt: now
            };
            return snapshotIdentity;
        }
    }

    const mainWorldResult = await runInExistingBetterLetterTabWithOptions(async () => {
        const EMAIL_REGEX = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig;
        const candidates = [];
        const seen = new Set();
        const MAX_NODES = 1800;
        const MAX_DEPTH = 5;

        const normalizeLocalEmail = (value) => {
            const normalized = String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
            return /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(normalized) ? normalized : '';
        };

        const pushCandidate = (rawEmail, source, score = 0) => {
            const normalized = normalizeLocalEmail(rawEmail);
            if (!normalized || seen.has(normalized)) return;
            seen.add(normalized);
            candidates.push({
                email: normalized,
                source: String(source || '').trim(),
                score: Number(score) || 0
            });
        };

        const scanText = (text, source, score = 0) => {
            const raw = String(text || '');
            if (!raw) return;
            const matches = raw.match(EMAIL_REGEX) || [];
            matches.forEach((email) => pushCandidate(email, source, score));
        };

        [
            ['currentUser', 'email'],
            ['current_user', 'email'],
            ['viewer', 'email'],
            ['user', 'email'],
            ['account', 'email'],
            ['profile', 'email'],
            ['session', 'user', 'email'],
            ['session', 'email'],
            ['auth', 'user', 'email'],
            ['auth', 'email'],
            ['bootstrap', 'currentUser', 'email'],
            ['app', 'currentUser', 'email'],
            ['store', 'currentUser', 'email'],
            ['liveSocket', 'params', 'user', 'email'],
            ['liveSocket', 'params', 'email']
        ].forEach((pathParts) => {
            try {
                let cursor = window;
                for (const part of pathParts) {
                    if (!cursor || typeof cursor !== 'object') {
                        cursor = null;
                        break;
                    }
                    cursor = cursor[part];
                }
                if (typeof cursor === 'string') {
                    pushCandidate(cursor, `window.${pathParts.join('.')}`, 240);
                }
            } catch (e) {
                // Ignore page object access failures.
            }
        });

        const queue = [];
        const visited = new WeakSet();
        const enqueue = (value, path, depth, score) => {
            if (!value || typeof value !== 'object') return;
            if (visited.has(value)) return;
            visited.add(value);
            queue.push({ value, path, depth, score });
        };

        const interestingGlobalKeys = Reflect.ownKeys(window).map((key) => String(key)).filter((key) =>
            /user|account|session|auth|profile|viewer|current|store|state|bootstrap|initial|app/i.test(key)
        );
        interestingGlobalKeys.forEach((key) => {
            try {
                enqueue(window[key], `window.${key}`, 0, /user|session|auth|profile|viewer|current/i.test(key) ? 180 : 130);
            } catch (e) {
                // Ignore accessor failures.
            }
        });
        enqueue(window.__NEXT_DATA__, 'window.__NEXT_DATA__', 0, 150);
        enqueue(window.__INITIAL_STATE__, 'window.__INITIAL_STATE__', 0, 150);
        enqueue(window.__APOLLO_STATE__, 'window.__APOLLO_STATE__', 0, 140);

        let scannedNodes = 0;
        while (queue.length > 0 && scannedNodes < MAX_NODES) {
            const entry = queue.shift();
            if (!entry) break;
            scannedNodes += 1;
            const { value, path, depth, score } = entry;
            if (depth > MAX_DEPTH) continue;

            let keys = [];
            try {
                keys = Reflect.ownKeys(value).map((key) => String(key));
            } catch (e) {
                keys = [];
            }
            for (const key of keys.slice(0, 120)) {
                let child;
                try {
                    child = value[key];
                } catch (e) {
                    continue;
                }

                const childPath = `${path}.${key}`;
                const childScore = score + (/email|username|login|viewer|user|profile|account/i.test(key) ? 70 : 0);
                if (typeof child === 'string') {
                    if (/email|username|login/i.test(key)) {
                        pushCandidate(child, childPath, childScore + 60);
                    }
                    scanText(child, childPath, childScore);
                    continue;
                }
                if (typeof child === 'number' || typeof child === 'boolean' || child == null) {
                    continue;
                }
                if (Array.isArray(child)) {
                    child.slice(0, 20).forEach((item, index) => {
                        if (typeof item === 'string') {
                            scanText(item, `${childPath}[${index}]`, childScore);
                            return;
                        }
                        enqueue(item, `${childPath}[${index}]`, depth + 1, childScore - 10);
                    });
                    continue;
                }
                enqueue(child, childPath, depth + 1, childScore - 5);
            }
        }

        [document.documentElement, document.body].forEach((node, index) => {
            if (!node?.dataset) return;
            Object.entries(node.dataset).forEach(([key, value]) => {
                scanText(value, `dataset:${index}:${key}`, /email|user|account|profile/i.test(key) ? 160 : 100);
            });
        });

        document.querySelectorAll('meta').forEach((meta) => {
            const name = `${meta.getAttribute('name') || ''}${meta.getAttribute('property') || ''}`.toLowerCase();
            const content = meta.getAttribute('content') || '';
            scanText(content, `meta:${name || 'content'}`, /email|user|account|profile/i.test(name) ? 170 : 90);
        });

        candidates.sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            return a.email.localeCompare(b.email);
        });

        return {
            email: String(candidates[0]?.email || '').trim(),
            source: String(candidates[0]?.source || '').trim()
        };
    }, [], preferredTabId, { world: 'MAIN', requireEmailInObject: true });

    const mainWorldIdentity = {
        email: normalizeEmail(mainWorldResult?.email),
        source: sanitizeSingleLine(mainWorldResult?.source ? `main_world:${mainWorldResult.source}` : '', 120)
    };
    if (mainWorldIdentity.email) {
        await saveBetterLetterIdentitySnapshot({
            ...mainWorldIdentity,
            tabId: preferredTabId,
            capturedAt: new Date().toISOString()
        });
        extensionAccessStateCache = {
            ...(extensionAccessStateCache || {}),
            userIdentity: mainWorldIdentity,
            userIdentityCheckedAt: now
        };
        return mainWorldIdentity;
    }

    const result = await runInExistingBetterLetterTab(async () => {
        const EMAIL_REGEX = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig;
        const candidates = [];
        const seen = new Set();

        const pushEmail = (rawEmail, source, score = 0) => {
            const normalized = String(rawEmail || '').trim().toLowerCase();
            if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(normalized)) return;
            if (seen.has(normalized)) return;
            seen.add(normalized);
            candidates.push({
                email: normalized,
                source: String(source || '').trim(),
                score: Number(score) || 0
            });
        };

        const scanText = (text, source, score = 0) => {
            const raw = String(text || '');
            if (!raw) return;
            const matches = raw.match(EMAIL_REGEX) || [];
            matches.forEach((email) => pushEmail(email, source, score));
        };

        const scanStorage = (storage, storageName) => {
            try {
                if (!storage) return;
                for (let i = 0; i < storage.length; i += 1) {
                    const key = String(storage.key(i) || '');
                    if (!key) continue;
                    const value = String(storage.getItem(key) || '');
                    const normalizedKey = key.toLowerCase();
                    const score = /email|user|auth|account|profile|session/.test(normalizedKey) ? 120 : 70;
                    scanText(value, `${storageName}:${key}`, score);
                }
            } catch (e) {
                // Ignore storage access failures.
            }
        };

        scanStorage(window.localStorage, 'localStorage');
        scanStorage(window.sessionStorage, 'sessionStorage');

        const domSelectors = [
            'header',
            'nav',
            '[role="banner"]',
            '[data-test-id*="user"]',
            '[data-test-id*="account"]',
            '[class*="user"]',
            '[class*="account"]',
            '[id*="user"]',
            '[id*="account"]',
            'a[href^="mailto:"]',
            'button[aria-haspopup="menu"]'
        ];
        domSelectors.forEach((selector) => {
            document.querySelectorAll(selector).forEach((node) => {
                scanText(node?.textContent || '', `dom:${selector}`, 90);
                if (selector === 'a[href^="mailto:"]') {
                    const href = String(node?.getAttribute?.('href') || '').replace(/^mailto:/i, '');
                    scanText(href, `dom:${selector}:href`, 140);
                }
            });
        });

        try {
            const response = await fetch(window.location.pathname + window.location.search, {
                credentials: 'include',
                cache: 'no-store'
            });
            if (response.ok) {
                const html = await response.text();
                const doc = new DOMParser().parseFromString(html, 'text/html');
                [
                    'header',
                    'nav',
                    '[role="banner"]',
                    '[data-test-id*="user"]',
                    '[data-test-id*="account"]',
                    '[class*="user"]',
                    '[class*="account"]',
                    '[id*="user"]',
                    '[id*="account"]'
                ].forEach((selector) => {
                    doc.querySelectorAll(selector).forEach((node) => {
                        scanText(node?.textContent || '', `fetch:${selector}`, 100);
                    });
                });
            }
        } catch (e) {
            // Ignore fetch failures and rely on other sources.
        }

        candidates.sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            return a.email.localeCompare(b.email);
        });

        return {
            email: String(candidates[0]?.email || '').trim(),
            source: String(candidates[0]?.source || '').trim()
        };
    }, [], preferredTabId, { requireEmailInObject: true });

    const routeProbeResult = await runInExistingBetterLetterTab(async () => {
        const EMAIL_REGEX = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig;
        const normalizeLocalEmail = (value) => {
            const normalized = String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
            return /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(normalized) ? normalized : '';
        };
        const routeCandidates = [
            '/users/settings',
            '/settings',
            '/account',
            '/profile',
            '/whoami',
            '/me',
            '/api/me',
            '/api/user',
            '/api/current_user',
            '/api/session',
            '/admin_panel/settings',
            '/admin_panel/account'
        ];

        const deepFindEmail = (input, path = 'root', seen = new WeakSet()) => {
            if (input == null) return { email: '', source: '' };
            if (typeof input === 'string') {
                const direct = normalizeLocalEmail(input);
                if (direct) return { email: direct, source: path };
                const matched = input.match(EMAIL_REGEX);
                return { email: normalizeLocalEmail(matched?.[0] || ''), source: matched?.[0] ? path : '' };
            }
            if (typeof input !== 'object') return { email: '', source: '' };
            if (seen.has(input)) return { email: '', source: '' };
            seen.add(input);

            for (const [key, value] of Object.entries(input)) {
                const childPath = `${path}.${key}`;
                if (/email|user|account|profile|login|username/i.test(key)) {
                    const direct = deepFindEmail(value, childPath, seen);
                    if (direct.email) return direct;
                }
            }
            for (const [key, value] of Object.entries(input)) {
                const childPath = `${path}.${key}`;
                const nested = deepFindEmail(value, childPath, seen);
                if (nested.email) return nested;
            }
            return { email: '', source: '' };
        };

        for (const route of routeCandidates) {
            try {
                const response = await fetch(route, {
                    credentials: 'include',
                    cache: 'no-store',
                    redirect: 'follow',
                    headers: {
                        'accept': 'text/html,application/json;q=0.9,*/*;q=0.8'
                    }
                });
                if (!response.ok) continue;
                if (/\/sign-in(?:[/?#]|$)/i.test(response.url || '')) continue;

                const contentType = String(response.headers.get('content-type') || '').toLowerCase();
                if (contentType.includes('application/json')) {
                    const json = await response.json().catch(() => null);
                    const extracted = deepFindEmail(json, `json:${route}`);
                    if (extracted.email) {
                        return { email: extracted.email, source: `route:${route}:${extracted.source}` };
                    }
                    continue;
                }

                const html = await response.text();
                if (!html) continue;
                const doc = new DOMParser().parseFromString(html, 'text/html');
                const inputCandidates = [
                    'input[type="email"]',
                    'input[name="email"]',
                    'input[name*="email" i]',
                    'input[id*="email" i]',
                    'a[href^="mailto:"]'
                ];
                for (const selector of inputCandidates) {
                    const node = doc.querySelector(selector);
                    if (!node) continue;
                    const value = selector.startsWith('a[')
                        ? String(node.getAttribute('href') || '').replace(/^mailto:/i, '')
                        : String(node.getAttribute('value') || node.value || node.textContent || '');
                    const email = normalizeLocalEmail(value);
                    if (email) {
                        return { email, source: `route:${route}:${selector}` };
                    }
                }

                const match = html.match(EMAIL_REGEX);
                const matchedEmail = normalizeLocalEmail(match?.[0] || '');
                if (matchedEmail) {
                    return { email: matchedEmail, source: `route:${route}:html` };
                }
            } catch (error) {
                // Ignore route probe failures and continue with the next candidate.
            }
        }

        return { email: '', source: '' };
    }, [], preferredTabId, { requireEmailInObject: true });

    const routeProbeIdentity = {
        email: normalizeEmail(routeProbeResult?.email),
        source: sanitizeSingleLine(routeProbeResult?.source, 120)
    };
    if (routeProbeIdentity.email) {
        await saveBetterLetterIdentitySnapshot({
            ...routeProbeIdentity,
            tabId: preferredTabId,
            capturedAt: new Date().toISOString()
        });
        extensionAccessStateCache = {
            ...(extensionAccessStateCache || {}),
            userIdentity: routeProbeIdentity,
            userIdentityCheckedAt: now
        };
        return routeProbeIdentity;
    }

    const identity = {
        email: normalizeEmail(result?.email),
        source: sanitizeSingleLine(result?.source, 120)
    };
    extensionAccessStateCache = {
        ...(extensionAccessStateCache || {}),
        userIdentity: identity,
        userIdentityCheckedAt: now
    };
    return identity;
}

async function handleGetExtensionAccessState(rawPayload = {}, sender = null) {
    try {
        const preferredTabId = typeof rawPayload?.preferredTabId === 'number' && Number.isFinite(rawPayload.preferredTabId)
            ? rawPayload.preferredTabId
            : (typeof sender?.tab?.id === 'number' ? sender.tab.id : null);
        const forceRefresh = Boolean(rawPayload?.forceRefresh);
        const allowStale = Boolean(rawPayload?.allowStale);
        const identity = await resolveCurrentBetterLetterUserIdentity({ preferredTabId, forceRefresh });
        const cacheKey = `${identity.email || 'unknown'}|${preferredTabId || 'any'}`;
        const now = Date.now();
        if (
            !forceRefresh &&
            extensionAccessStateCache?.cacheKey === cacheKey &&
            extensionAccessStateCache?.access &&
            (now - Number(extensionAccessStateCache.checkedAt || 0) < EXTENSION_ACCESS_CACHE_TTL_MS)
        ) {
            return {
                success: true,
                access: extensionAccessStateCache.access
            };
        }
        const storedAccessSnapshot = await getStoredExtensionAccessSnapshot();
        const matchingStoredAccess = storedAccessSnapshot?.email && storedAccessSnapshot.email === identity.email
            ? sanitizeExtensionAccessState({
                ...storedAccessSnapshot.access,
                email: identity.email || storedAccessSnapshot.access?.email || '',
                detectionSource: identity.source || storedAccessSnapshot.access?.detectionSource || ''
            })
            : null;
        const storedAccessAgeMs = Math.max(0, now - Number(storedAccessSnapshot?.checkedAt || 0));
        const canUseStoredAccess = Boolean(matchingStoredAccess) && (allowStale || storedAccessAgeMs < EXTENSION_ACCESS_CACHE_TTL_MS);

        if (!forceRefresh && canUseStoredAccess) {
            extensionAccessStateCache = {
                ...(extensionAccessStateCache || {}),
                cacheKey,
                access: matchingStoredAccess,
                checkedAt: storedAccessSnapshot.checkedAt || now
            };
            return {
                success: true,
                access: matchingStoredAccess,
                stale: true
            };
        }

        if (extensionAccessResolveInFlightByKey.has(cacheKey)) {
            return await extensionAccessResolveInFlightByKey.get(cacheKey);
        }

        const resolvePromise = (async () => {
            let usingRemoteConfig = false;
            try {
                const serviceResponse = await callAccessControlService('/access/resolve', {
                    method: 'POST',
                    body: { email: identity.email },
                    timeoutMs: allowStale ? EXTENSION_ACCESS_RESOLVE_TIMEOUT_MS : LINEAR_TRIGGER_SERVER_TIMEOUT_MS
                });
                const { response, payload } = serviceResponse;
                usingRemoteConfig = Boolean(serviceResponse?.usingRemoteConfig);
                if (!response.ok || !payload?.ok) {
                    if (matchingStoredAccess) {
                        return {
                            success: true,
                            access: matchingStoredAccess,
                            stale: true
                        };
                    }
                    return {
                        success: true,
                        access: buildUnavailableExtensionAccessState(
                            identity,
                            sanitizeSingleLine(payload?.error, 240)
                                || `Access check failed with status ${response.status}.`
                        ),
                        stale: false
                    };
                }

                const access = sanitizeExtensionAccessState({
                    ...(payload?.access || {}),
                    email: identity.email || payload?.access?.email || '',
                    detectionSource: identity.source || ''
                });
                extensionAccessStateCache = {
                    ...(extensionAccessStateCache || {}),
                    cacheKey,
                    access,
                    checkedAt: Date.now()
                };
                await saveStoredExtensionAccessSnapshot(access, Date.now());
                return { success: true, access, stale: false };
            } catch (error) {
                if (matchingStoredAccess) {
                    return {
                        success: true,
                        access: matchingStoredAccess,
                        stale: true
                    };
                }
                return {
                    success: true,
                    access: buildUnavailableExtensionAccessState(
                        identity,
                        normalizeAccessControlServiceError(error, { usingRemoteConfig })
                    ),
                    stale: false
                };
            }
        })();

        extensionAccessResolveInFlightByKey.set(cacheKey, resolvePromise);
        try {
            return await resolvePromise;
        } finally {
            extensionAccessResolveInFlightByKey.delete(cacheKey);
        }
    } catch (error) {
        return {
            success: true,
            access: buildUnavailableExtensionAccessState(null, normalizeAccessControlServiceError(error))
        };
    }
}

async function ensureProtectedExtensionAccess(actionName, sender = null) {
    const result = await handleGetExtensionAccessState({}, sender);
    if (!result?.success || !result?.access) {
        return {
            success: false,
            error: sanitizeSingleLine(result?.error, 240) || `Access check failed for ${actionName}.`,
            access: sanitizeExtensionAccessState(null)
        };
    }
    const requiredFeatures = getRequiredFeaturesForAction(actionName);
    if (!result.access.allowed || !hasAccessToAnyRequiredFeature(result.access, requiredFeatures)) {
        const featureLabels = requiredFeatures
            .map((featureKey) => EXTENSION_FEATURE_CATALOG.find((feature) => feature.key === featureKey)?.label || featureKey)
            .filter(Boolean);
        return {
            success: false,
            error: result.access.reason || `You do not have access to ${featureLabels.join(' / ') || actionName}.`,
            access: result.access
        };
    }
    return {
        success: true,
        access: result.access
    };
}

async function handleGetExtensionUserManagement(rawPayload = {}, sender = null) {
    try {
        const accessResult = await handleGetExtensionAccessState(rawPayload, sender);
        if (!accessResult?.success || !accessResult?.access) {
            return accessResult;
        }
        const { response, payload } = await callAccessControlService('/access/management', {
            method: 'POST',
            body: { actorEmail: accessResult.access.email }
        });
        if (!response.ok || !payload?.ok || !payload?.management) {
            return {
                success: false,
                error: sanitizeSingleLine(payload?.error, 240) || `User management request failed with status ${response.status}.`,
                access: accessResult.access
            };
        }
        return {
            success: true,
            access: sanitizeExtensionAccessState(payload?.access || accessResult.access),
            management: payload.management
        };
    } catch (error) {
        return {
            success: false,
            error: normalizeAccessControlServiceError(error)
        };
    }
}

async function handleExportExtensionAccessPolicy(rawPayload = {}, sender = null) {
    try {
        const accessResult = await handleGetExtensionAccessState(rawPayload, sender);
        if (!accessResult?.success || !accessResult?.access) {
            return accessResult;
        }
        const { response, payload } = await callAccessControlService('/access/export-policy', {
            method: 'POST',
            body: {
                actorEmail: accessResult.access.email
            }
        });
        if (!response.ok || !payload?.ok || !payload?.exported) {
            return {
                success: false,
                error: sanitizeSingleLine(payload?.error, 240) || `Access policy export failed with status ${response.status}.`
            };
        }
        return {
            success: true,
            exported: payload.exported
        };
    } catch (error) {
        return {
            success: false,
            error: normalizeAccessControlServiceError(error)
        };
    }
}

async function handleImportExtensionAccessPolicy(rawPayload = {}, sender = null) {
    try {
        const accessResult = await handleGetExtensionAccessState(rawPayload, sender);
        if (!accessResult?.success || !accessResult?.access) {
            return accessResult;
        }
        const { response, payload } = await callAccessControlService('/access/import-policy', {
            method: 'POST',
            body: {
                actorEmail: accessResult.access.email,
                policy: rawPayload?.policy,
                mode: sanitizeSingleLine(rawPayload?.mode, 20)
            }
        });
        if (!response.ok || !payload?.ok || !payload?.management) {
            return {
                success: false,
                error: sanitizeSingleLine(payload?.error, 240) || `Access policy import failed with status ${response.status}.`
            };
        }
        return {
            success: true,
            management: payload.management,
            importedAt: sanitizeSingleLine(payload?.importedAt, 80),
            importMode: sanitizeSingleLine(payload?.importMode, 20)
        };
    } catch (error) {
        return {
            success: false,
            error: normalizeAccessControlServiceError(error)
        };
    }
}

async function handleSaveExtensionManagedUser(rawPayload = {}, sender = null) {
    try {
        const accessResult = await handleGetExtensionAccessState({}, sender);
        if (!accessResult?.success || !accessResult?.access) {
            return accessResult;
        }
        const { response, payload } = await callAccessControlService('/access/save-user', {
            method: 'POST',
            body: {
                actorEmail: accessResult.access.email,
                email: normalizeEmail(rawPayload?.email),
                role: sanitizeSingleLine(rawPayload?.role, 40),
                features: Array.isArray(rawPayload?.features) ? rawPayload.features : []
            }
        });
        if (!response.ok || !payload?.ok || !payload?.management) {
            return {
                success: false,
                error: sanitizeSingleLine(payload?.error, 240) || `Could not save user (status ${response.status}).`
            };
        }
        return {
            success: true,
            management: payload.management,
            alert: payload.management?.alert || payload.alert || null
        };
    } catch (error) {
        return {
            success: false,
            error: normalizeAccessControlServiceError(error)
        };
    }
}

async function handleDeleteExtensionManagedUser(rawPayload = {}, sender = null) {
    try {
        const accessResult = await handleGetExtensionAccessState({}, sender);
        if (!accessResult?.success || !accessResult?.access) {
            return accessResult;
        }
        const { response, payload } = await callAccessControlService('/access/delete-user', {
            method: 'POST',
            body: {
                actorEmail: accessResult.access.email,
                email: normalizeEmail(rawPayload?.email)
            }
        });
        if (!response.ok || !payload?.ok || !payload?.management) {
            return {
                success: false,
                error: sanitizeSingleLine(payload?.error, 240) || `Could not delete user (status ${response.status}).`
            };
        }
        return {
            success: true,
            management: payload.management,
            alert: payload.management?.alert || payload.alert || null
        };
    } catch (error) {
        return {
            success: false,
            error: normalizeAccessControlServiceError(error)
        };
    }
}

async function handleSubmitExtensionAccessRequest(rawPayload = {}, sender = null) {
    try {
        const accessResult = await handleGetExtensionAccessState({
            preferredTabId: rawPayload?.preferredTabId,
            allowStale: true
        }, sender);
        const requesterEmail = normalizeEmail(accessResult?.access?.email);
        if (!requesterEmail) {
            return {
                success: false,
                error: 'Open a signed-in BetterLetter page first so MailroomNavigator can detect your email.'
            };
        }

        const { response, payload } = await callAccessControlService('/access/request', {
            method: 'POST',
            body: {
                email: requesterEmail,
                note: sanitizeMultiline(rawPayload?.note, 1200),
                requestedFeatures: Array.isArray(rawPayload?.requestedFeatures) ? rawPayload.requestedFeatures : []
            }
        });
        if (!response.ok || !payload?.ok) {
            return {
                success: false,
                error: sanitizeSingleLine(payload?.error, 240) || `Could not submit access request (status ${response.status}).`
            };
        }

        const access = sanitizeExtensionAccessState({
            ...(payload?.access || {}),
            email: requesterEmail || payload?.access?.email || accessResult?.access?.email || '',
            detectionSource: accessResult?.access?.detectionSource || ''
        });
        await saveStoredExtensionAccessSnapshot(access, Date.now());
        return {
            success: true,
            access,
            request: payload?.request || null,
            alert: payload?.alert || null
        };
    } catch (error) {
        return {
            success: false,
            error: normalizeAccessControlServiceError(error)
        };
    }
}

async function handleReviewExtensionAccessRequest(rawPayload = {}, sender = null) {
    try {
        const accessResult = await handleGetExtensionAccessState({}, sender);
        if (!accessResult?.success || !accessResult?.access) {
            return accessResult;
        }
        const { response, payload } = await callAccessControlService('/access/review-request', {
            method: 'POST',
            body: {
                actorEmail: accessResult.access.email,
                email: normalizeEmail(rawPayload?.email),
                action: sanitizeSingleLine(rawPayload?.action, 40),
                reviewNote: sanitizeMultiline(rawPayload?.reviewNote, 600)
            }
        });
        if (!response.ok || !payload?.ok || !payload?.management) {
            return {
                success: false,
                error: sanitizeSingleLine(payload?.error, 240) || `Could not review request (status ${response.status}).`
            };
        }
        return {
            success: true,
            management: payload.management
        };
    } catch (error) {
        return {
            success: false,
            error: normalizeAccessControlServiceError(error)
        };
    }
}

async function handleGetExtensionIdentityDiagnostics(rawPayload = {}, sender = null) {
    try {
        const preferredTabId = typeof rawPayload?.preferredTabId === 'number' && Number.isFinite(rawPayload.preferredTabId)
            ? rawPayload.preferredTabId
            : (typeof sender?.tab?.id === 'number' ? sender.tab.id : null);
        const storedSnapshot = await getStoredBetterLetterIdentitySnapshot();
        const candidates = await getOrderedBetterLetterTabCandidates(preferredTabId);
        const tabs = [];

        for (const tab of candidates.slice(0, 6)) {
            const tabSummary = {
                tabId: typeof tab?.id === 'number' ? tab.id : null,
                url: sanitizeSingleLine(getTabUrl(tab), 400),
                title: sanitizeSingleLine(tab?.title, 160),
                active: Boolean(tab?.active),
                status: sanitizeSingleLine(tab?.status, 40),
                discarded: Boolean(tab?.discarded),
                isSignIn: isBetterLetterSignInUrl(getTabUrl(tab)),
                datasetEmail: '',
                datasetSource: '',
                mainWorld: { email: '', source: '' },
                isolatedWorld: { email: '', source: '' },
                error: ''
            };

            try {
                const [{ result: datasetResult }] = await chrome.scripting.executeScript({
                    target: { tabId: tab.id },
                    func: () => ({
                        datasetEmail: String(document.documentElement?.getAttribute('data-mailroomnavigator-email') || '').trim(),
                        datasetSource: String(document.documentElement?.getAttribute('data-mailroomnavigator-email-source') || '').trim()
                    })
                });
                tabSummary.datasetEmail = normalizeEmail(datasetResult?.datasetEmail);
                tabSummary.datasetSource = sanitizeSingleLine(datasetResult?.datasetSource, 120);
            } catch (error) {
                tabSummary.error = sanitizeSingleLine(error?.message, 180) || 'dataset read failed';
            }

            try {
                const [{ result: mainResult }] = await chrome.scripting.executeScript({
                    target: { tabId: tab.id },
                    world: 'MAIN',
                    func: () => {
                        const EMAIL_REGEX = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig;
                        const normalizeLocalEmail = (value) => {
                            const normalized = String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
                            return /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(normalized) ? normalized : '';
                        };
                        const directCandidates = [];
                        const pushCandidate = (value, source) => {
                            const email = normalizeLocalEmail(value);
                            if (!email) return;
                            directCandidates.push({ email, source: String(source || '').trim() });
                        };
                        [
                            ['currentUser', 'email'],
                            ['current_user', 'email'],
                            ['viewer', 'email'],
                            ['user', 'email'],
                            ['account', 'email'],
                            ['profile', 'email'],
                            ['session', 'user', 'email'],
                            ['session', 'email'],
                            ['auth', 'user', 'email'],
                            ['auth', 'email'],
                            ['bootstrap', 'currentUser', 'email'],
                            ['app', 'currentUser', 'email'],
                            ['store', 'currentUser', 'email'],
                            ['liveSocket', 'params', 'user', 'email'],
                            ['liveSocket', 'params', 'email']
                        ].forEach((pathParts) => {
                            try {
                                let cursor = window;
                                for (const part of pathParts) {
                                    if (!cursor || typeof cursor !== 'object') {
                                        cursor = null;
                                        break;
                                    }
                                    cursor = cursor[part];
                                }
                                if (typeof cursor === 'string') pushCandidate(cursor, `window.${pathParts.join('.')}`);
                            } catch (error) {
                                // Ignore page access failures.
                            }
                        });
                        if (directCandidates.length > 0) return directCandidates[0];
                        const htmlMatch = String(document.documentElement?.outerHTML || '').match(EMAIL_REGEX);
                        return {
                            email: normalizeLocalEmail(htmlMatch?.[0] || ''),
                            source: htmlMatch?.[0] ? 'html' : ''
                        };
                    }
                });
                tabSummary.mainWorld = {
                    email: normalizeEmail(mainResult?.email),
                    source: sanitizeSingleLine(mainResult?.source, 120)
                };
            } catch (error) {
                tabSummary.error = [tabSummary.error, sanitizeSingleLine(error?.message, 180) || 'main world read failed']
                    .filter(Boolean)
                    .join(' | ');
            }

            try {
                const [{ result: isolatedResult }] = await chrome.scripting.executeScript({
                    target: { tabId: tab.id },
                    func: () => {
                        const EMAIL_REGEX = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig;
                        const normalizeLocalEmail = (value) => {
                            const normalized = String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
                            return /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(normalized) ? normalized : '';
                        };
                        for (let i = 0; i < localStorage.length; i += 1) {
                            const key = localStorage.key(i);
                            const value = String(localStorage.getItem(key) || '');
                            const match = value.match(EMAIL_REGEX);
                            if (match?.[0]) return { email: normalizeLocalEmail(match[0]), source: `localStorage:${key}` };
                        }
                        for (let i = 0; i < sessionStorage.length; i += 1) {
                            const key = sessionStorage.key(i);
                            const value = String(sessionStorage.getItem(key) || '');
                            const match = value.match(EMAIL_REGEX);
                            if (match?.[0]) return { email: normalizeLocalEmail(match[0]), source: `sessionStorage:${key}` };
                        }
                        return { email: '', source: '' };
                    }
                });
                tabSummary.isolatedWorld = {
                    email: normalizeEmail(isolatedResult?.email),
                    source: sanitizeSingleLine(isolatedResult?.source, 120)
                };
            } catch (error) {
                tabSummary.error = [tabSummary.error, sanitizeSingleLine(error?.message, 180) || 'isolated world read failed']
                    .filter(Boolean)
                    .join(' | ');
            }

            try {
                const [{ result: routeProbeResult }] = await chrome.scripting.executeScript({
                    target: { tabId: tab.id },
                    func: async () => {
                        const EMAIL_REGEX = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig;
                        const normalizeLocalEmail = (value) => {
                            const normalized = String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
                            return /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(normalized) ? normalized : '';
                        };
                        const routeCandidates = [
                            '/users/settings',
                            '/settings',
                            '/account',
                            '/profile',
                            '/whoami',
                            '/me',
                            '/api/me',
                            '/api/user',
                            '/api/current_user',
                            '/api/session',
                            '/admin_panel/settings',
                            '/admin_panel/account'
                        ];
                        for (const route of routeCandidates) {
                            try {
                                const response = await fetch(route, {
                                    credentials: 'include',
                                    cache: 'no-store',
                                    redirect: 'follow',
                                    headers: {
                                        accept: 'text/html,application/json;q=0.9,*/*;q=0.8'
                                    }
                                });
                                if (!response.ok) continue;
                                if (/\/sign-in(?:[/?#]|$)/i.test(response.url || '')) continue;
                                const contentType = String(response.headers.get('content-type') || '').toLowerCase();
                                if (contentType.includes('application/json')) {
                                    const bodyText = JSON.stringify(await response.json().catch(() => null));
                                    const matched = bodyText.match(EMAIL_REGEX);
                                    const email = normalizeLocalEmail(matched?.[0] || '');
                                    if (email) return { email, source: `route:${route}:json` };
                                    continue;
                                }
                                const html = await response.text();
                                const matched = html.match(EMAIL_REGEX);
                                const email = normalizeLocalEmail(matched?.[0] || '');
                                if (email) return { email, source: `route:${route}:html` };
                            } catch (error) {
                                // Ignore per-route failures.
                            }
                        }
                        return { email: '', source: '' };
                    }
                });
                tabSummary.routeProbe = {
                    email: normalizeEmail(routeProbeResult?.email),
                    source: sanitizeSingleLine(routeProbeResult?.source, 120)
                };
            } catch (error) {
                tabSummary.error = [tabSummary.error, sanitizeSingleLine(error?.message, 180) || 'route probe failed']
                    .filter(Boolean)
                    .join(' | ');
            }

            tabs.push(tabSummary);
        }

        return {
            success: true,
            diagnostics: {
                preferredTabId,
                storedSnapshot,
                tabs
            }
        };
    } catch (error) {
        return {
            success: false,
            error: sanitizeSingleLine(error?.message, 240) || 'Could not inspect BetterLetter identity diagnostics.'
        };
    }
}

async function handleGetAccessControlServiceConfig() {
    try {
        return {
            success: true,
            config: await getStoredAccessControlServiceConfig()
        };
    } catch (error) {
        return {
            success: false,
            error: sanitizeSingleLine(error?.message, 240) || 'Could not load access service config.'
        };
    }
}

async function handleSaveAccessControlServiceConfig(rawPayload = null) {
    try {
        const config = await saveStoredAccessControlServiceConfig(rawPayload);
        return {
            success: true,
            config
        };
    } catch (error) {
        return {
            success: false,
            error: sanitizeSingleLine(error?.message, 240) || 'Could not save access service config.'
        };
    }
}

async function handleGetAccessControlServiceHealth() {
    let usingRemoteConfig = false;
    try {
        const serviceResponse = await callAccessControlService('/health', {
            method: 'GET',
            timeoutMs: ACCESS_CONTROL_REMOTE_TIMEOUT_MS
        });
        const { response, payload, baseUrl } = serviceResponse;
        usingRemoteConfig = Boolean(serviceResponse?.usingRemoteConfig);
        if (!response.ok || !payload?.ok) {
            return {
                success: false,
                error: sanitizeSingleLine(payload?.error, 240) || `Access service health failed with status ${response.status}.`
            };
        }
        return {
            success: true,
            health: {
                usingRemoteConfig,
                baseUrl: sanitizeServiceBaseUrl(baseUrl),
                access: payload?.access && typeof payload.access === 'object'
                    ? {
                        enabled: Boolean(payload.access.enabled),
                        ownerEmail: normalizeEmail(payload.access.ownerEmail),
                        storage: sanitizeSingleLine(payload.access.storage, 32),
                        storePath: sanitizeSingleLine(payload.access.storePath, 240),
                        managedUsers: Math.max(0, Number.parseInt(String(payload.access.managedUsers ?? '0'), 10) || 0),
                        pendingRequests: Math.max(0, Number.parseInt(String(payload.access.pendingRequests ?? '0'), 10) || 0),
                        policyUpdatedAt: sanitizeSingleLine(payload.access.policyUpdatedAt, 80)
                    }
                    : null
            }
        };
    } catch (error) {
        return {
            success: false,
            error: normalizeAccessControlServiceError(error, { usingRemoteConfig })
        };
    }
}

async function fetchPracticeCdbByOds(odsCode) {
    const normalizedOds = String(odsCode || '').trim();
    if (!normalizedOds) return '';

    const cdbFromSessionFetch = await runInExistingBetterLetterTab(async (targetOds) => {
        try {
            const response = await fetch(`/admin_panel/practices/${encodeURIComponent(targetOds)}`, {
                credentials: 'include',
                cache: 'no-store'
            });
            if (!response.ok) return '';

            const html = await response.text();
            const doc = new DOMParser().parseFromString(html, 'text/html');
            const cdbInput = doc.getElementById('ehr_settings[practice_cdb]') ||
                doc.querySelector("input[name='ehr_settings[practice_cdb]']");

            return (cdbInput?.value || '').trim();
        } catch (e) {
            return '';
        }
    }, [normalizedOds]);

    if (typeof cdbFromSessionFetch === 'string' && cdbFromSessionFetch.trim()) {
        return cdbFromSessionFetch.trim();
    }

    return '';
}

function normalizeLetterCountValue(rawValue) {
    const parsed = Number.parseInt(String(rawValue ?? '').trim(), 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function createEmptyLiveCounts() {
    return {
        preparing: null,
        edit: null,
        review: null,
        coding: null,
        rejected: null
    };
}

function mergeLiveCounts(base, incoming) {
    const merged = { ...base };
    ['preparing', 'edit', 'review', 'coding', 'rejected'].forEach((key) => {
        const existing = Number.isFinite(base?.[key]) ? base[key] : null;
        const next = Number.isFinite(incoming?.[key]) ? incoming[key] : null;
        if (existing === null) merged[key] = next;
        else if (next === null) merged[key] = existing;
        else merged[key] = Math.max(existing, next);
    });
    return merged;
}

function hasAnyLiveCounts(counts) {
    return ['preparing', 'edit', 'review', 'coding', 'rejected']
        .some((key) => Number.isFinite(counts?.[key]));
}

function hasCompleteLiveCounts(counts) {
    return ['preparing', 'edit', 'review', 'coding', 'rejected']
        .every((key) => Number.isFinite(counts?.[key]));
}

function allLiveCountsZeroOrNull(counts) {
    return ['preparing', 'edit', 'review', 'coding', 'rejected']
        .every((key) => !Number.isFinite(counts?.[key]) || Number(counts?.[key]) === 0);
}

function getCachedLiveCounts(odsCode, maxAgeMs = LIVE_COUNTS_CACHE_TTL_MS) {
    const key = String(odsCode || '').trim().toUpperCase();
    const cached = liveCountsCacheByOds.get(key);
    if (!cached || typeof cached !== 'object') return null;
    if (!Number.isFinite(cached.timestamp)) return null;
    if (Date.now() - cached.timestamp > maxAgeMs) return null;
    return cached.counts && typeof cached.counts === 'object' ? cached.counts : null;
}

function setCachedLiveCounts(odsCode, counts, source = 'unknown') {
    const key = String(odsCode || '').trim().toUpperCase();
    if (!key || !counts || typeof counts !== 'object') return;
    if (!hasAnyLiveCounts(counts)) return;
    const normalizedCounts = { ...createEmptyLiveCounts(), ...counts };
    // Avoid persisting low-confidence "all zero" snapshots from transient pages.
    // Fresh non-zero values remain cached and are reused immediately.
    if (allLiveCountsZeroOrNull(normalizedCounts)) return;
    liveCountsCacheByOds.set(key, {
        counts: normalizedCounts,
        source: String(source || 'unknown'),
        timestamp: Date.now()
    });
}

function shouldAttemptTempTabFetch(odsCode) {
    const key = String(odsCode || '').trim().toUpperCase();
    const now = Date.now();
    const last = Number(liveCountsLastTempFetchAtByOds.get(key) || 0);
    if (now - last < LIVE_COUNTS_TEMP_TAB_COOLDOWN_MS) return false;
    liveCountsLastTempFetchAtByOds.set(key, now);
    return true;
}

function withTimeout(promise, timeoutMs) {
    return new Promise((resolve) => {
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            resolve(null);
        }, timeoutMs);

        Promise.resolve(promise)
            .then((value) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(value);
            })
            .catch(() => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(null);
            });
    });
}

async function waitForTabComplete(tabId, timeoutMs = 12000) {
    if (typeof tabId !== 'number') throw new Error('Invalid tab ID.');

    const currentTab = await chrome.tabs.get(tabId);
    if (currentTab?.status === 'complete') return;

    await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            chrome.tabs.onUpdated.removeListener(onUpdated);
            reject(new Error('Timed out waiting for tab load.'));
        }, timeoutMs);

        const onUpdated = (updatedTabId, changeInfo) => {
            if (updatedTabId !== tabId) return;
            if (changeInfo?.status !== 'complete') return;
            clearTimeout(timeout);
            chrome.tabs.onUpdated.removeListener(onUpdated);
            resolve();
        };

        chrome.tabs.onUpdated.addListener(onUpdated);
    });
}

async function fetchLiveMailroomCountsViaTempTab(odsCode) {
    const normalizedOds = String(odsCode || '').trim().toUpperCase();
    if (!/^[A-Z]\d{5}$/.test(normalizedOds)) return createEmptyLiveCounts();

    const editQuery = new URLSearchParams({
        assigned_to_me: 'false',
        practice: normalizedOds,
        sort: 'expected_return_date',
        sort_dir: 'asc',
        urgent: 'false'
    });
    const targetUrl = `${BETTERLETTER_ORIGIN}/mailroom/edit?${editQuery.toString()}`;

    let tabId = null;
    try {
        const created = await chrome.tabs.create({ url: targetUrl, active: false });
        tabId = created?.id;
        if (typeof tabId !== 'number') return createEmptyLiveCounts();

        await waitForTabComplete(tabId, 12000);
        const [{ result }] = await chrome.scripting.executeScript({
            target: { tabId },
            func: async (hydrateWindowMs) => {
                const parseCountToken = (token) => {
                    const raw = String(token || '').trim();
                    if (!raw) return null;
                    if (raw.includes('/')) {
                        const parts = raw.split('/')
                            .map(part => Number.parseInt(String(part).trim(), 10))
                            .filter(Number.isFinite);
                        if (!parts.length) return null;
                        return parts[parts.length - 1];
                    }
                    const match = raw.match(/\d+/);
                    if (!match) return null;
                    const parsed = Number.parseInt(match[0], 10);
                    return Number.isFinite(parsed) ? parsed : null;
                };

                const parseTabCount = (sourceText, label) => {
                    const regex = new RegExp(`\\b${label}\\b\\s*\\(([^)]+)\\)`, 'gi');
                    const matches = [...String(sourceText || '').matchAll(regex)];
                    if (!matches.length) return null;
                    const parsed = matches
                        .map(match => parseCountToken(match?.[1] || ''))
                        .filter(Number.isFinite);
                    if (!parsed.length) return null;
                    return Math.max(...parsed);
                };

                const readCounts = () => {
                    const sourceText = String(document?.body?.innerText || '')
                        .replace(/\s+/g, ' ')
                        .trim();
                    return {
                        preparing: parseTabCount(sourceText, 'PREPARING'),
                        edit: parseTabCount(sourceText, 'EDIT'),
                        review: parseTabCount(sourceText, 'REVIEW'),
                        coding: parseTabCount(sourceText, 'CODING'),
                        rejected: parseTabCount(sourceText, 'REJECTED')
                    };
                };

                const keys = ['preparing', 'edit', 'review', 'coding', 'rejected'];
                // Give LiveView additional time to hydrate counters after load.
                let best = readCounts();
                const deadline = Date.now() + Math.max(1500, Number(hydrateWindowMs) || 2500);
                let lastSignature = '';
                let stableCompleteReads = 0;
                while (Date.now() < deadline) {
                    const signature = keys
                        .map((key) => Number.isFinite(best?.[key]) ? String(best[key]) : 'x')
                        .join('|');
                    const isComplete = keys.every((key) => Number.isFinite(best?.[key]));
                    const hasPositive = keys.some((key) => Number.isFinite(best?.[key]) && best[key] > 0);

                    if (isComplete && hasPositive) {
                        return best;
                    }

                    if (isComplete) {
                        if (signature === lastSignature) stableCompleteReads += 1;
                        else stableCompleteReads = 1;
                        lastSignature = signature;
                        // For true-zero practices, accept stable complete values after a few passes.
                        if (stableCompleteReads >= 3) return best;
                    } else {
                        stableCompleteReads = 0;
                        lastSignature = signature;
                    }

                    await new Promise(resolve => setTimeout(resolve, 220));
                    const next = readCounts();
                    keys.forEach((key) => {
                        const current = Number.isFinite(best?.[key]) ? best[key] : null;
                        const incoming = Number.isFinite(next?.[key]) ? next[key] : null;
                        if (current === null) best[key] = incoming;
                        else if (incoming !== null) best[key] = Math.max(current, incoming);
                    });
                }
                return best;
            },
            args: [LIVE_COUNTS_TEMP_TAB_HYDRATE_WINDOW_MS]
        });

        return result && typeof result === 'object' ? result : createEmptyLiveCounts();
    } catch (error) {
        return createEmptyLiveCounts();
    } finally {
        if (typeof tabId === 'number') {
            chrome.tabs.remove(tabId).catch(() => undefined);
        }
    }
}

async function fetchLiveMailroomCountsViaHiddenFrame(odsCode) {
    const normalizedOds = String(odsCode || '').trim().toUpperCase();
    if (!/^[A-Z]\d{5}$/.test(normalizedOds)) return createEmptyLiveCounts();

    const result = await runInExistingBetterLetterTab(async (targetOds, hydrateWindowMs) => {
        const emptyCounts = {
            preparing: null,
            edit: null,
            review: null,
            coding: null,
            rejected: null
        };

        const parseCountToken = (token) => {
            const raw = String(token || '').trim();
            if (!raw) return null;
            if (raw.includes('/')) {
                const parts = raw.split('/')
                    .map(part => Number.parseInt(String(part).trim(), 10))
                    .filter(Number.isFinite);
                if (!parts.length) return null;
                return parts[parts.length - 1];
            }
            const match = raw.match(/\d+/);
            if (!match) return null;
            const parsed = Number.parseInt(match[0], 10);
            return Number.isFinite(parsed) ? parsed : null;
        };

        const parseTabCount = (sourceText, label) => {
            const regex = new RegExp(`\\b${label}\\b\\s*\\(([^)]+)\\)`, 'gi');
            const matches = [...String(sourceText || '').matchAll(regex)];
            if (!matches.length) return null;
            const parsed = matches
                .map(match => parseCountToken(match?.[1] || ''))
                .filter(Number.isFinite);
            if (!parsed.length) return null;
            return Math.max(...parsed);
        };

        const readCountsFromDoc = (doc) => {
            const sourceText = String(doc?.body?.innerText || '')
                .replace(/\s+/g, ' ')
                .trim();
            if (!sourceText) return { ...emptyCounts };
            return {
                preparing: parseTabCount(sourceText, 'PREPARING'),
                edit: parseTabCount(sourceText, 'EDIT'),
                review: parseTabCount(sourceText, 'REVIEW'),
                coding: parseTabCount(sourceText, 'CODING'),
                rejected: parseTabCount(sourceText, 'REJECTED')
            };
        };

        const mergeCounts = (base, incoming) => {
            const merged = { ...base };
            ['preparing', 'edit', 'review', 'coding', 'rejected'].forEach((key) => {
                const existing = Number.isFinite(base?.[key]) ? base[key] : null;
                const next = Number.isFinite(incoming?.[key]) ? incoming[key] : null;
                if (existing === null) merged[key] = next;
                else if (next === null) merged[key] = existing;
                else merged[key] = Math.max(existing, next);
            });
            return merged;
        };

        const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

        const editQuery = new URLSearchParams({
            assigned_to_me: 'false',
            practice: targetOds,
            sort: 'expected_return_date',
            sort_dir: 'asc',
            urgent: 'false'
        });
        const frameUrl = `${window.location.origin}/mailroom/edit?${editQuery.toString()}`;

        const frame = document.createElement('iframe');
        frame.setAttribute('aria-hidden', 'true');
        frame.tabIndex = -1;
        frame.style.position = 'fixed';
        frame.style.left = '-99999px';
        frame.style.top = '-99999px';
        frame.style.width = '1px';
        frame.style.height = '1px';
        frame.style.opacity = '0';
        frame.style.pointerEvents = 'none';
        frame.style.border = '0';
        frame.style.zIndex = '-1';

        const cleanup = () => {
            try { frame.remove(); } catch (e) { /* ignore */ }
        };

        try {
            const loaded = await new Promise((resolve) => {
                let settled = false;
                const finish = (value) => {
                    if (settled) return;
                    settled = true;
                    resolve(value);
                };

                const timeout = setTimeout(() => finish(false), 13000);
                frame.addEventListener('load', () => {
                    clearTimeout(timeout);
                    finish(true);
                }, { once: true });

                (document.body || document.documentElement).appendChild(frame);
                frame.src = frameUrl;
            });

            if (!loaded) {
                return emptyCounts;
            }

            const keys = ['preparing', 'edit', 'review', 'coding', 'rejected'];
            const deadline = Date.now() + Math.max(1800, Number(hydrateWindowMs) || 5200);
            let best = readCountsFromDoc(frame.contentDocument);
            let lastSignature = '';
            let stableCompleteReads = 0;

            while (Date.now() < deadline) {
                const signature = keys
                    .map((key) => Number.isFinite(best?.[key]) ? String(best[key]) : 'x')
                    .join('|');
                const isComplete = keys.every((key) => Number.isFinite(best?.[key]));
                const hasPositive = keys.some((key) => Number.isFinite(best?.[key]) && best[key] > 0);

                if (isComplete && hasPositive) return best;
                if (isComplete) {
                    if (signature === lastSignature) stableCompleteReads += 1;
                    else stableCompleteReads = 1;
                    lastSignature = signature;
                    if (stableCompleteReads >= 3) return best;
                } else {
                    stableCompleteReads = 0;
                    lastSignature = signature;
                }

                await wait(240);
                const next = readCountsFromDoc(frame.contentDocument);
                best = mergeCounts(best, next);
            }

            return best;
        } catch (e) {
            return emptyCounts;
        } finally {
            cleanup();
        }
    }, [normalizedOds, LIVE_COUNTS_TEMP_TAB_HYDRATE_WINDOW_MS]);

    return result && typeof result === 'object' ? result : createEmptyLiveCounts();
}

async function refreshLiveMailroomCountsViaTempTab(odsCode) {
    const key = String(odsCode || '').trim().toUpperCase();
    if (!/^[A-Z]\d{5}$/.test(key)) return createEmptyLiveCounts();

    if (liveCountsTempFetchInFlightByOds.has(key)) {
        return liveCountsTempFetchInFlightByOds.get(key);
    }
    if (!shouldAttemptTempTabFetch(key)) {
        return getCachedLiveCounts(key, LIVE_COUNTS_CACHE_TTL_MS * 4) || createEmptyLiveCounts();
    }

    const promise = (async () => {
        const counts = await fetchLiveMailroomCountsViaTempTab(key);
        if (hasAnyLiveCounts(counts)) {
            setCachedLiveCounts(key, counts, 'temp_tab_dom');
        }
        return counts;
    })().finally(() => {
        liveCountsTempFetchInFlightByOds.delete(key);
    });

    liveCountsTempFetchInFlightByOds.set(key, promise);
    return promise;
}

async function fetchLiveMailroomCountsFromOpenTabs(odsCode) {
    const normalizedOds = String(odsCode || '').trim().toUpperCase();
    const tabs = await chrome.tabs.query({ url: `${BETTERLETTER_ORIGIN}/mailroom/*` });
    if (!Array.isArray(tabs) || !tabs.length) return createEmptyLiveCounts();

    let aggregated = createEmptyLiveCounts();
    for (const tab of tabs) {
        const url = getTabUrl(tab);
        if (!url) continue;

        let parsedUrl;
        try {
            parsedUrl = new URL(url);
        } catch (e) {
            continue;
        }

        const practiceParam = String(
            parsedUrl.searchParams.get('practice') ||
            parsedUrl.searchParams.get('practice_ids') ||
            ''
        ).trim().toUpperCase();

        // Strict practice scoping: do not use tabs without explicit practice query,
        // and never use "practice=all" when resolving single-practice counts.
        if (!practiceParam || practiceParam === 'ALL' || practiceParam !== normalizedOds) continue;
        if (!/^\/mailroom\/(preparing|rejected|edit|review|coding)/i.test(parsedUrl.pathname)) continue;

        try {
            const [{ result }] = await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                func: () => {
                    const parseCountToken = (token) => {
                        const raw = String(token || '').trim();
                        if (!raw) return null;

                        if (raw.includes('/')) {
                            const parts = raw.split('/')
                                .map(part => Number.parseInt(String(part).trim(), 10))
                                .filter(Number.isFinite);
                            if (!parts.length) return null;
                            return parts[parts.length - 1];
                        }

                        const match = raw.match(/\d+/);
                        if (!match) return null;
                        const parsed = Number.parseInt(match[0], 10);
                        return Number.isFinite(parsed) ? parsed : null;
                    };

                    const parseTabCount = (sourceText, label) => {
                        const regex = new RegExp(`\\b${label}\\b\\s*\\(([^)]+)\\)`, 'gi');
                        const matches = [...String(sourceText || '').matchAll(regex)];
                        if (!matches.length) return null;

                        const parsed = matches
                            .map(match => parseCountToken(match?.[1] || ''))
                            .filter(Number.isFinite);
                        if (!parsed.length) return null;
                        return Math.max(...parsed);
                    };

                    const sourceText = String(document?.body?.innerText || '')
                        .replace(/\s+/g, ' ')
                        .trim();

                    return {
                        preparing: parseTabCount(sourceText, 'PREPARING'),
                        edit: parseTabCount(sourceText, 'EDIT'),
                        review: parseTabCount(sourceText, 'REVIEW'),
                        coding: parseTabCount(sourceText, 'CODING'),
                        rejected: parseTabCount(sourceText, 'REJECTED')
                    };
                }
            });

            const fromTab = result && typeof result === 'object' ? result : createEmptyLiveCounts();
            aggregated = mergeLiveCounts(aggregated, fromTab);
            if (hasCompleteLiveCounts(aggregated)) break;
        } catch (e) {
            // Ignore tabs that cannot be scripted at this moment.
        }
    }

    return aggregated;
}

async function fetchLiveMailroomCountsByOds(odsCode, options = {}) {
    const allowTempTab = options?.allowTempTab === true;
    const normalizedOds = String(odsCode || '').trim().toUpperCase();
    if (!/^[A-Z]\d{5}$/.test(normalizedOds)) {
        return {
            preparing: null,
            edit: null,
            review: null,
            coding: null,
            rejected: null,
            fetchedAt: Date.now()
        };
    }

    const cachedCounts = getCachedLiveCounts(normalizedOds);
    let aggregatedCounts = createEmptyLiveCounts();

    // First preference: parse hydrated values directly from already open mailroom tabs.
    // This captures LiveView-updated counters that can differ from static server HTML.
    const countsFromOpenTabs = await fetchLiveMailroomCountsFromOpenTabs(normalizedOds);
    aggregatedCounts = mergeLiveCounts(aggregatedCounts, countsFromOpenTabs);
    let hasConfidentCounts = hasCompleteLiveCounts(aggregatedCounts);
    if (hasAnyLiveCounts(countsFromOpenTabs)) {
        setCachedLiveCounts(normalizedOds, countsFromOpenTabs, 'open_tab_dom');
    }

    // Fast path: if an open mailroom tab already has full hydrated counters, avoid extra fetches.
    if (hasCompleteLiveCounts(aggregatedCounts)) {
        const safeCounts = aggregatedCounts;
        return {
            preparing: normalizeLetterCountValue(safeCounts.preparing),
            edit: normalizeLetterCountValue(safeCounts.edit),
            review: normalizeLetterCountValue(safeCounts.review),
            coding: normalizeLetterCountValue(safeCounts.coding),
            rejected: normalizeLetterCountValue(safeCounts.rejected),
            fetchedAt: Date.now()
        };
    }

    const countsFromFetch = await runInExistingBetterLetterTab(async (targetOds) => {
        // Fetch and parse server-rendered mailroom page text to read tab counters.
        // Practice-specific tab counters are read from the edit page for the selected ODS.
        const emptyCounts = {
            preparing: null,
            edit: null,
            review: null,
            coding: null,
            rejected: null
        };

        const parseCountToken = (token) => {
            const raw = String(token || '').trim();
            if (!raw) return null;

            // Values like "0/62" appear in Edit/Review tabs. We take the total (62).
            if (raw.includes('/')) {
                const parts = raw.split('/')
                    .map(part => Number.parseInt(String(part).trim(), 10))
                    .filter(Number.isFinite);
                if (!parts.length) return null;
                return parts[parts.length - 1];
            }

            const match = raw.match(/\d+/);
            if (!match) return null;
            const parsed = Number.parseInt(match[0], 10);
            return Number.isFinite(parsed) ? parsed : null;
        };

        const parseTabCount = (sourceText, label) => {
            // Some pages include duplicated tab bars (desktop/mobile/hidden states).
            // Parse all matches and keep the largest non-null number to avoid false zeros.
            const regex = new RegExp(`\\b${label}\\b\\s*\\(([^)]+)\\)`, 'gi');
            const matches = [...String(sourceText || '').matchAll(regex)];
            if (!matches.length) return null;

            const parsed = matches
                .map(match => parseCountToken(match?.[1] || ''))
                .filter(Number.isFinite);
            if (!parsed.length) return null;
            return Math.max(...parsed);
        };

        const mergeCounts = (base, incoming) => {
            const merged = { ...base };
            ['preparing', 'edit', 'review', 'coding', 'rejected'].forEach((key) => {
                const existing = Number.isFinite(base?.[key]) ? base[key] : null;
                const next = Number.isFinite(incoming?.[key]) ? incoming[key] : null;
                if (existing === null) merged[key] = next;
                else if (next === null) merged[key] = existing;
                else merged[key] = Math.max(existing, next);
            });
            return merged;
        };

        const parseCountsFromHtml = (html) => {
            const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
            const sourceText = String(doc?.body?.innerText || html || '').replace(/\s+/g, ' ').trim();
            if (!sourceText) return { ...emptyCounts };

            return {
                preparing: parseTabCount(sourceText, 'PREPARING'),
                edit: parseTabCount(sourceText, 'EDIT'),
                review: parseTabCount(sourceText, 'REVIEW'),
                coding: parseTabCount(sourceText, 'CODING'),
                rejected: parseTabCount(sourceText, 'REJECTED')
            };
        };

            const readPracticeFromUrl = (urlValue) => {
                const practiceParam = String(
                    urlValue.searchParams.get('practice') ||
                    urlValue.searchParams.get('practice_ids') ||
                    urlValue.searchParams.get('ods_code') ||
                    ''
                ).trim().toUpperCase();
                return practiceParam;
            };

            const responseMatchesPractice = (responseUrl, targetPractice, requestRelativeUrl = '') => {
                const target = String(targetPractice || '').trim().toUpperCase();
                if (!target) return false;

                try {
                    const finalUrl = new URL(responseUrl);
                    const resolvedPractice = readPracticeFromUrl(finalUrl);
                    if (resolvedPractice === 'ALL') return false;
                    if (resolvedPractice) return resolvedPractice === target;

                    if (requestRelativeUrl) {
                        const requestedUrl = new URL(requestRelativeUrl, window.location.origin);
                        const requestedPractice = readPracticeFromUrl(requestedUrl);
                        if (requestedPractice && requestedPractice !== 'ALL') {
                            return requestedPractice === target;
                        }
                    }
                    return false;
                } catch (e) {
                    return false;
                }
            };

        try {
            const editQuery = new URLSearchParams({
                assigned_to_me: 'false',
                practice: targetOds,
                sort: 'expected_return_date',
                sort_dir: 'asc',
                urgent: 'false'
            });
            const preparingSelfQuery = new URLSearchParams({
                only_action_items: 'true',
                practice: targetOds,
                service: 'self',
                sort: 'upload_date',
                sort_dir: 'asc',
                urgent: 'false'
            });
            const preparingFullQuery = new URLSearchParams({
                only_action_items: 'true',
                practice: targetOds,
                service: 'full',
                sort: 'upload_date',
                sort_dir: 'asc',
                urgent: 'false'
            });
            const codingSelfQuery = new URLSearchParams({
                assigned_to_me: 'false',
                practice: targetOds,
                service: 'self',
                sort: 'expected_return_date',
                sort_dir: 'asc',
                urgent: 'false'
            });
            const codingFullQuery = new URLSearchParams({
                assigned_to_me: 'false',
                practice: targetOds,
                service: 'full',
                sort: 'expected_return_date',
                sort_dir: 'asc',
                urgent: 'false'
            });
            const codingFallbackQuery = new URLSearchParams({
                assigned_to_me: 'false',
                practice: targetOds,
                sort: 'expected_return_date',
                sort_dir: 'asc',
                urgent: 'false'
            });
            const rejectedFullQuery = new URLSearchParams({
                practice: targetOds,
                service: 'full',
                show_processed: 'false',
                sort: 'inserted_at',
                sort_dir: 'asc'
            });
            const reviewSelfQuery = new URLSearchParams({
                assigned_to_me: 'false',
                practice: targetOds,
                service: 'self',
                sort: 'expected_return_date',
                sort_dir: 'asc',
                urgent: 'false'
            });
            const reviewFullQuery = new URLSearchParams({
                assigned_to_me: 'false',
                practice: targetOds,
                service: 'full',
                sort: 'expected_return_date',
                sort_dir: 'asc',
                urgent: 'false'
            });

            // Invisible, in-session fetches from an existing BetterLetter tab.
            // Include review endpoints for both self/full service views.
            const requestPaths = [
                `/mailroom/preparing?${preparingSelfQuery.toString()}`,
                `/mailroom/preparing?${preparingFullQuery.toString()}`,
                `/mailroom/edit?${editQuery.toString()}`,
                `/mailroom/coding?${codingSelfQuery.toString()}`,
                `/mailroom/coding?${codingFullQuery.toString()}`,
                `/mailroom/coding?${codingFallbackQuery.toString()}`,
                `/mailroom/review?${reviewSelfQuery.toString()}`,
                `/mailroom/review?${reviewFullQuery.toString()}`,
                `/mailroom/rejected?${rejectedFullQuery.toString()}`
            ];

            const parsedList = await Promise.all(requestPaths.map(async (relativeUrl) => {
                try {
                    const response = await fetch(relativeUrl, {
                        credentials: 'include',
                        cache: 'no-store'
                    });
                    if (!response.ok) return null;
                    if (!responseMatchesPractice(response.url, targetOds, relativeUrl)) return null;

                    const html = await response.text();
                    return parseCountsFromHtml(html);
                } catch (e) {
                    return null;
                }
            }));

            return parsedList.reduce((acc, parsed) => {
                if (!parsed || typeof parsed !== 'object') return acc;
                return mergeCounts(acc, parsed);
            }, { ...emptyCounts });
        } catch (error) {
            return emptyCounts;
        }
    }, [normalizedOds]);

    const safeFetchedCounts = countsFromFetch && typeof countsFromFetch === 'object'
        ? countsFromFetch
        : createEmptyLiveCounts();

    aggregatedCounts = hasAnyLiveCounts(aggregatedCounts)
        ? mergeLiveCounts(aggregatedCounts, safeFetchedCounts)
        : safeFetchedCounts;

    // Hidden iframe fallback:
    // Load an off-screen mailroom page inside an existing BetterLetter tab and
    // read hydrated counters without opening any visible tab/window.
    const needsWorkflowCounts = ['preparing', 'edit', 'review', 'coding']
        .some((key) => !Number.isFinite(aggregatedCounts?.[key]));
    if (needsWorkflowCounts) {
        const countsFromHiddenFrame = await withTimeout(
            fetchLiveMailroomCountsViaHiddenFrame(normalizedOds),
            LIVE_COUNTS_TEMP_TAB_RESULT_WAIT_MS
        );
        if (countsFromHiddenFrame && hasAnyLiveCounts(countsFromHiddenFrame)) {
            aggregatedCounts = mergeLiveCounts(aggregatedCounts, countsFromHiddenFrame);
            setCachedLiveCounts(normalizedOds, countsFromHiddenFrame, 'hidden_iframe_dom');
            if (hasCompleteLiveCounts(aggregatedCounts)) {
                hasConfidentCounts = true;
            }
        }
    }

    // If low-confidence data is all zero/null, use recent cache immediately and refresh via temp tab.
    if (allLiveCountsZeroOrNull(aggregatedCounts)) {
        if (cachedCounts && hasAnyLiveCounts(cachedCounts)) {
            if (allowTempTab) {
                refreshLiveMailroomCountsViaTempTab(normalizedOds).catch(() => undefined);
            }
            const safeCounts = cachedCounts;
            return {
                preparing: normalizeLetterCountValue(safeCounts.preparing),
                edit: normalizeLetterCountValue(safeCounts.edit),
                review: normalizeLetterCountValue(safeCounts.review),
                coding: normalizeLetterCountValue(safeCounts.coding),
                rejected: normalizeLetterCountValue(safeCounts.rejected),
                fetchedAt: Date.now()
            };
        }

        // No useful cache yet: wait briefly for a temp-tab refresh, then continue.
        if (allowTempTab) {
            const tempTabCounts = await withTimeout(
                refreshLiveMailroomCountsViaTempTab(normalizedOds),
                LIVE_COUNTS_TEMP_TAB_RESULT_WAIT_MS
            );
            if (tempTabCounts && hasAnyLiveCounts(tempTabCounts)) {
                aggregatedCounts = tempTabCounts;
                if (hasCompleteLiveCounts(tempTabCounts)) {
                    hasConfidentCounts = true;
                }
            }
        }
    }

    const safeCounts = aggregatedCounts && typeof aggregatedCounts === 'object'
        ? aggregatedCounts
        : createEmptyLiveCounts();

    if (hasCompleteLiveCounts(safeCounts) && !allLiveCountsZeroOrNull(safeCounts)) {
        hasConfidentCounts = true;
    }

    // Do not present likely placeholder zeros as real values.
    if (allLiveCountsZeroOrNull(safeCounts) && !hasConfidentCounts) {
        return {
            preparing: null,
            edit: null,
            review: null,
            coding: null,
            rejected: null,
            fetchedAt: Date.now()
        };
    }

    if (hasAnyLiveCounts(safeCounts)) {
        setCachedLiveCounts(normalizedOds, safeCounts, 'resolved');
    }

    return {
        preparing: normalizeLetterCountValue(safeCounts.preparing),
        edit: normalizeLetterCountValue(safeCounts.edit),
        review: normalizeLetterCountValue(safeCounts.review),
        coding: normalizeLetterCountValue(safeCounts.coding),
        rejected: normalizeLetterCountValue(safeCounts.rejected),
        fetchedAt: Date.now()
    };
}

async function resolveLiveMailroomCountsByOds(odsCode, options = {}) {
    const normalizedOds = String(odsCode || '').trim().toUpperCase();
    if (!/^[A-Z]\d{5}$/.test(normalizedOds)) {
        return {
            preparing: null,
            edit: null,
            review: null,
            coding: null,
            rejected: null,
            fetchedAt: Date.now()
        };
    }

    if (liveCountsResolveInFlightByOds.has(normalizedOds)) {
        return liveCountsResolveInFlightByOds.get(normalizedOds);
    }

    const promise = fetchLiveMailroomCountsByOds(normalizedOds, options)
        .catch(() => ({
            preparing: null,
            edit: null,
            review: null,
            coding: null,
            rejected: null,
            fetchedAt: Date.now()
        }))
        .finally(() => {
            liveCountsResolveInFlightByOds.delete(normalizedOds);
        });

    liveCountsResolveInFlightByOds.set(normalizedOds, promise);
    return promise;
}

async function hydrateMissingCdbs(limit = 25) {
    await ensureCacheLoaded();

    const entries = Object.entries(practiceCache || {});
    const targets = entries
        .filter(([, p]) => {
            const cdb = (p?.cdb || '').trim();
            const name = (p?.name || '').trim().toLowerCase();
            return !cdb || cdb.toLowerCase() === name;
        })
        .slice(0, limit);

    let updated = 0;
    for (const [key, practice] of targets) {
        const cdb = await fetchPracticeCdbByOds(practice.ods);
        if (cdb) {
            practiceCache[key] = { ...practice, cdb, practiceCDB: cdb, timestamp: Date.now() };
            updated += 1;
        }
    }

    if (updated > 0) {
        await chrome.storage.local.set({ practiceCache, cacheTimestamp: Date.now() });
    }

    return updated;
}

async function scrapePracticeListViaTab() {
    // Disabled by design to avoid opening hidden/background tabs in any Chrome window.
    return [];
}

async function scrapePracticeListViaSessionTab() {
    const result = await runInExistingBetterLetterTab(async () => {
        try {
            const response = await fetch('/admin_panel/practices', {
                credentials: 'include',
                cache: 'no-store'
            });

            if (!response.ok) return [];

            const html = await response.text();
            const doc = new DOMParser().parseFromString(html, 'text/html');
            const headerCells = Array.from(doc.querySelectorAll('table thead th'));
            const headers = headerCells.map((th, idx) => ({
                idx,
                text: (th.textContent || '').trim().toLowerCase()
            }));

            const findHeaderIndex = (...keywords) => {
                const hit = headers.find(h => keywords.every(k => h.text.includes(k)));
                return hit ? hit.idx : -1;
            };

            const fallbackByPosition = {
                ods: 1,
                ehr: 3,
                quota: 4,
                collected: 5,
                service: 6
            };

            const odsIdx = findHeaderIndex('ods') >= 0 ? findHeaderIndex('ods') : fallbackByPosition.ods;
            const cdbIdx = findHeaderIndex('cdb');
            const ehrIdx = findHeaderIndex('ehr') >= 0 ? findHeaderIndex('ehr') : fallbackByPosition.ehr;
            const quotaIdx = findHeaderIndex('quota') >= 0 ? findHeaderIndex('quota') : fallbackByPosition.quota;
            const collectedIdx = findHeaderIndex('collected') >= 0 ? findHeaderIndex('collected') : fallbackByPosition.collected;
            const serviceIdx = findHeaderIndex('service') >= 0 ? findHeaderIndex('service') : fallbackByPosition.service;

            const rows = Array.from(doc.querySelectorAll('table tbody tr'));
            return rows.map(row => {
                const cells = Array.from(row.querySelectorAll('td'));
                const link = row.querySelector('a[href*="/admin_panel/practices/"]');
                if (!link) return null;

                const normalize = (value) => (value || '').trim().replace(/\s+/g, ' ');
                const fromIdx = (idx) => (idx >= 0 ? normalize(cells[idx]?.textContent || '') : '');

                const hrefId = (link.getAttribute('href') || '').split('/').pop() || '';
                const extractedOds = fromIdx(odsIdx).match(/[A-Z]\d{5}/)?.[0] || '';
                const id = hrefId || extractedOds;

                return {
                    id,
                    ods: id,
                    name: normalize(link.textContent).normalize('NFC'),
                    cdb: fromIdx(cdbIdx),
                    ehrType: fromIdx(ehrIdx),
                    collectionQuota: fromIdx(quotaIdx),
                    collectedToday: fromIdx(collectedIdx),
                    serviceLevel: fromIdx(serviceIdx)
                };
            }).filter(p => p && p.id);
        } catch (e) {
            return [];
        }
    });

    return Array.isArray(result) ? result : [];
}

async function loadCacheFromStorage() {
    const result = await chrome.storage.local.get(['practiceCache', 'cacheTimestamp']);
    if (result.practiceCache && Object.keys(result.practiceCache).length > 0) {
        practiceCache = result.practiceCache;
        return result;
    }

    return result;
}

async function fetchAndCachePracticeList(purpose = 'background refresh') {
    if (practiceCacheRefreshPromise) {
        try {
            return await practiceCacheRefreshPromise;
        } catch (error) {
            return Object.values(practiceCache || {});
        }
    }

    practiceCacheRefreshPromise = (async () => {
        isScrapingActive = true;
        try {
            let practicesArray = await scrapePracticeListViaSessionTab();

            if (!Array.isArray(practicesArray) || practicesArray.length === 0) {
                try {
                    await setupOffscreen();
                    const offscreenResult = await chrome.runtime.sendMessage({
                        target: 'offscreen',
                        action: 'scrapePracticeList',
                        data: { url: `${BETTERLETTER_ORIGIN}/admin_panel/practices` }
                    });
                    if (Array.isArray(offscreenResult)) {
                        practicesArray = offscreenResult;
                    }
                } catch (e) {
                    // Offscreen context can fail in some Chromium builds; continue fallback chain.
                }
            }

            if (!Array.isArray(practicesArray) || practicesArray.length === 0) {
                await loadCacheFromStorage();
                return Object.values(practiceCache || {});
            }
            
            const previousCache = practiceCache;
            const previousByOds = new Map(
                Object.values(previousCache || {})
                    .filter(practice => practice && practice.ods)
                    .map(practice => [practice.ods, practice])
            );

            practiceCache = {};
            practicesArray.forEach(p => {
                const previous = previousByOds.get(p.id) || {};
                const mergedPractice = {
                    ods: p.id,
                    timestamp: Date.now(),
                    ...previous,
                    ...p,
                    cdb: p.cdb || previous.cdb || '',
                    collectionQuota: p.collectionQuota || previous.collectionQuota || '',
                    collectedToday: p.collectedToday || previous.collectedToday || '',
                    serviceLevel: p.serviceLevel || previous.serviceLevel || '',
                    ehrType: p.ehrType || previous.ehrType || ''
                };
                practiceCache[`${mergedPractice.name} (${mergedPractice.ods})`] = mergedPractice;
            });
            await chrome.storage.local.set({ practiceCache, cacheTimestamp: Date.now() });

            // Hydrate missing CDB values in the background without blocking UI responsiveness
            hydrateMissingCdbs(15).catch(() => undefined);

            return practicesArray;
        } catch (e) {
            await loadCacheFromStorage();
            return Object.values(practiceCache || {});
        } finally {
            isScrapingActive = false;
        }
    })();

    try {
        return await practiceCacheRefreshPromise;
    } finally {
        practiceCacheRefreshPromise = null;
    }
}

async function ensureCacheLoaded() {
    if (Object.keys(practiceCache).length > 0) return;

    const result = await loadCacheFromStorage();
    if (result.practiceCache && Object.keys(result.practiceCache).length > 0) {
        practiceCache = result.practiceCache;

        // Do not block UI on cold start if cache is stale; refresh in background.
        if (!result.cacheTimestamp || (Date.now() - result.cacheTimestamp >= CACHE_EXPIRY)) {
            fetchAndCachePracticeList('stale-cache-refresh').catch(() => undefined);
        }
        return;
    }

    // Truly no cache available, fetch now.
    await fetchAndCachePracticeList('initial-load');
}

function openPanelPopup(hostTabId = null) {
    const url = new URL(chrome.runtime.getURL('panel.html'));
    if (typeof hostTabId === 'number' && Number.isFinite(hostTabId)) {
        url.searchParams.set('hostTabId', String(hostTabId));
    }
    chrome.windows.create({
        url: url.toString(),
        type: 'popup',
        width: 330,
        height: 750,
        focused: true
    });
}

async function ensureSidebarPanelMounted(tabId) {
    await chrome.scripting.executeScript({
        target: { tabId },
        func: (panelUrl, hostTabId) => {
            const ROOT_ID = 'bl-allinone-sidebar-panel';
            const STYLE_ID = 'bl-allinone-sidebar-style';
            const PANEL_WIDTH = 360;
            const HANDLE_WIDTH = 24;
            const PENDING_KEY = '__BL_SIDEBAR_MOUNT_PENDING__';

            const mountSidebar = () => {
                if (!document.documentElement) return;

                const existingPanel = document.getElementById(ROOT_ID);
                if (existingPanel) {
                    const toggleButton = existingPanel.querySelector('[data-role="toggle"]');
                    const existingIframe = existingPanel.querySelector('iframe');
                    if (existingIframe) {
                        const expectedSrc = `${panelUrl}${panelUrl.includes('?') ? '&' : '?'}hostTabId=${encodeURIComponent(String(hostTabId || ''))}`;
                        if (existingIframe.src !== expectedSrc) {
                            existingIframe.src = expectedSrc;
                        }
                    }
                    if (toggleButton) {
                        const isCollapsed = existingPanel.classList.contains('collapsed');
                        toggleButton.textContent = isCollapsed ? '◀' : '▶';
                        toggleButton.setAttribute('aria-label', isCollapsed ? 'Expand panel' : 'Collapse panel');
                    }
                    return;
                }

                if (!document.getElementById(STYLE_ID)) {
                    const styleEl = document.createElement('style');
                    styleEl.id = STYLE_ID;
                    styleEl.textContent = `
                        #${ROOT_ID} {
                            position: fixed;
                            top: 0;
                            right: 0;
                            width: ${PANEL_WIDTH}px;
                            height: 100vh;
                            z-index: 2147483647;
                            background: #f7f8fb;
                            border-left: 1px solid rgba(15, 23, 42, 0.16);
                            box-shadow: -10px 0 28px rgba(15, 23, 42, 0.18);
                            transform: translateX(0);
                            transition: transform 0.22s ease;
                        }

                        #${ROOT_ID}.collapsed {
                            transform: translateX(100%);
                        }

                        #${ROOT_ID} .bl-sidebar-toggle {
                            position: absolute;
                            left: -${HANDLE_WIDTH}px;
                            top: 50%;
                            transform: translateY(-50%);
                            width: ${HANDLE_WIDTH}px;
                            height: 56px;
                            border: 1px solid rgba(15, 23, 42, 0.16);
                            border-right: none;
                            border-radius: 8px 0 0 8px;
                            background: #ffffff;
                            color: #1f2937;
                            cursor: pointer;
                            font-size: 15px;
                            font-weight: 700;
                            line-height: 1;
                            padding: 0;
                        }

                        #${ROOT_ID} .bl-sidebar-toggle:hover {
                            background: #f3f4f6;
                        }

                        #${ROOT_ID} iframe {
                            width: 100%;
                            height: 100%;
                            border: 0;
                            display: block;
                            background: #f7f8fb;
                        }
                    `;
                    document.documentElement.appendChild(styleEl);
                }

                const panelEl = document.createElement('div');
                panelEl.id = ROOT_ID;
                panelEl.classList.add('collapsed');

                const toggleButton = document.createElement('button');
                toggleButton.type = 'button';
                toggleButton.className = 'bl-sidebar-toggle';
                toggleButton.dataset.role = 'toggle';
                toggleButton.textContent = '◀';
                toggleButton.setAttribute('aria-label', 'Expand panel');

                const iframe = document.createElement('iframe');
                iframe.src = `${panelUrl}${panelUrl.includes('?') ? '&' : '?'}hostTabId=${encodeURIComponent(String(hostTabId || ''))}`;
                iframe.title = 'BetterLetter Panel';

                toggleButton.addEventListener('click', (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    const isCollapsed = panelEl.classList.toggle('collapsed');
                    toggleButton.textContent = isCollapsed ? '◀' : '▶';
                    toggleButton.setAttribute('aria-label', isCollapsed ? 'Expand panel' : 'Collapse panel');
                });

                panelEl.append(toggleButton, iframe);
                (document.body || document.documentElement).appendChild(panelEl);
            };

            if (!document.body && document.readyState === 'loading') {
                if (window[PENDING_KEY]) return;
                window[PENDING_KEY] = true;
                document.addEventListener('DOMContentLoaded', () => {
                    window[PENDING_KEY] = false;
                    mountSidebar();
                }, { once: true });
                return;
            }

            mountSidebar();
        },
        args: [chrome.runtime.getURL('panel.html'), tabId]
    });
}

async function ensureSidebarHandleForTab(tabId) {
    if (typeof tabId !== 'number') return;
    try {
        const tab = await chrome.tabs.get(tabId);
        if (!isScriptableUrl(getTabUrl(tab))) return;
        await ensureSidebarPanelMounted(tabId);
    } catch (e) {
        // Ignore tabs that are gone/restricted or not scriptable yet.
    }
}

// --- 4. LISTENERS ---

chrome.action.onClicked.addListener(async (tab) => {
    await setTargetTabId(tab?.id);
    await ensureSidebarHandleForTab(tab?.id);
    maybeTriggerMorningDashboardAlert(tab?.id, getTabUrl(tab), 'action_click').catch(() => undefined);
    openPanelPopup(tab?.id);
});

chrome.tabs.onActivated.addListener((activeInfo) => {
    const tabId = activeInfo?.tabId;
    setTargetTabId(tabId).catch(() => undefined);
    ensureSidebarHandleForTab(tabId).catch(() => undefined);
    chrome.tabs.get(tabId)
        .then((tab) => maybeTriggerMorningDashboardAlert(tabId, getTabUrl(tab), 'tab_activated'))
        .catch(() => undefined);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (!changeInfo?.url && changeInfo?.status !== 'complete') return;
    const maybeUrl = typeof changeInfo?.url === 'string' ? changeInfo.url : getTabUrl(tab);
    if (!isScriptableUrl(maybeUrl)) return;
    if (isBetterLetterUrl(maybeUrl)) {
        chrome.storage.local.set({ targetTabId: tabId }).catch(() => undefined);
    }
    ensureSidebarHandleForTab(tabId).catch(() => undefined);
    if (changeInfo?.status === 'complete') {
        maybeTriggerMorningDashboardAlert(tabId, maybeUrl, 'tab_updated').catch(() => undefined);
    }
});

if (chrome.idle?.setDetectionInterval && chrome.idle?.onStateChanged) {
    // Detect OS lock/unlock or idle transitions while Chrome is running.
    // When the user becomes active, fetch a fresh summary from the current session.
    chrome.idle.setDetectionInterval(60);
    chrome.idle.onStateChanged.addListener((newState) => {
        if (newState !== 'active') return;
        findAnyBetterLetterTab()
            .then((tab) => {
                const tabId = tab?.id;
                const tabUrl = getTabUrl(tab);
                if (typeof tabId !== 'number' || !isBetterLetterUrl(tabUrl)) return;
                maybeTriggerMorningDashboardAlert(tabId, tabUrl, 'idle_active').catch(() => undefined);
            })
            .catch(() => undefined);
    });
}

if (chrome.commands?.onCommand) {
    chrome.commands.onCommand.addListener((command) => {
        if (String(command || '') !== HOTKEY_SHOW_LIVE_SUMMARY_COMMAND) return;
        showLiveSummaryViaHotkey().catch(() => undefined);
    });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.target === 'offscreen') return false;

    const handle = async () => {
        if (message?.type === 'betterletter_identity_snapshot' && message?.data) {
            const snapshot = await saveBetterLetterIdentitySnapshot({
                ...message.data,
                tabId: typeof sender?.tab?.id === 'number' ? sender.tab.id : null
            });
            return { success: Boolean(snapshot?.email) };
        }

        if (message?.type === 'mailroom_doc_clicked' && message?.data) {
            const payload = { clickedMailroomDocData: message.data };
            const senderTabId = sender?.tab?.id;
            if (typeof senderTabId === 'number' && isBetterLetterUrl(sender?.tab?.url || '')) {
                payload.targetTabId = senderTabId;
            }
            await chrome.storage.local.set(payload);
            return { success: true };
        }

        if (message.action === 'getExtensionAccessState') {
            return await handleGetExtensionAccessState(message.payload, sender);
        }
        if (message.action === 'getExtensionUserManagement') {
            return await handleGetExtensionUserManagement(message.payload, sender);
        }
        if (message.action === 'exportExtensionAccessPolicy') {
            return await handleExportExtensionAccessPolicy(message.payload, sender);
        }
        if (message.action === 'importExtensionAccessPolicy') {
            return await handleImportExtensionAccessPolicy(message.payload, sender);
        }
        if (message.action === 'getExtensionIdentityDiagnostics') {
            return await handleGetExtensionIdentityDiagnostics(message.payload, sender);
        }
        if (message.action === 'getAccessControlServiceConfig') {
            return await handleGetAccessControlServiceConfig();
        }
        if (message.action === 'saveAccessControlServiceConfig') {
            return await handleSaveAccessControlServiceConfig(message.payload);
        }
        if (message.action === 'getAccessControlServiceHealth') {
            return await handleGetAccessControlServiceHealth();
        }
        if (message.action === 'saveExtensionManagedUser') {
            return await handleSaveExtensionManagedUser(message.payload, sender);
        }
        if (message.action === 'deleteExtensionManagedUser') {
            return await handleDeleteExtensionManagedUser(message.payload, sender);
        }
        if (message.action === 'submitExtensionAccessRequest') {
            return await handleSubmitExtensionAccessRequest(message.payload, sender);
        }
        if (message.action === 'reviewExtensionAccessRequest') {
            return await handleReviewExtensionAccessRequest(message.payload, sender);
        }

        if (PROTECTED_EXTENSION_ACTIONS.has(message?.action)) {
            const accessCheck = await ensureProtectedExtensionAccess(String(message.action || 'this feature'), sender);
            if (!accessCheck.success) {
                return {
                    success: false,
                    error: accessCheck.error,
                    access: accessCheck.access
                };
            }
        }

        if (CACHE_REQUIRED_ACTIONS.has(message?.action)) {
            await ensureCacheLoaded();
        }

        if (message.action === 'getPracticeCache') {
            if (Object.keys(practiceCache).length === 0) {
                await loadCacheFromStorage();
            }
            return { practiceCache };
        }
        if (message.action === 'openUrlInNewTab') {
            const targetUrl = String(message.url || '').trim();
            if (!isBetterLetterUrl(targetUrl)) {
                return { success: false, error: 'Invalid URL for tab open.' };
            }
            const tabOptions = { url: targetUrl, active: true };
            if (typeof sender?.tab?.windowId === 'number') {
                tabOptions.windowId = sender.tab.windowId;
            }
            await chrome.tabs.create(tabOptions);
            return { success: true };
        }
        if (message.action === 'openPractice') return await handleOpenPractice(message.input, message.settingType);
        if (message.action === 'createLinearIssueFromEnv' || message.action === 'createLinearIssueAndNotifySlack') {
            return await handleCreateLinearIssueFromEnv(message.payload, sender);
        }
        if (message.action === 'syncLinearSlackWorkspaceTargets') {
            return await handleSyncLinearSlackWorkspaceTargets(message);
        }
        if (message.action === 'triggerLinearBotJobsRun') {
            return await handleTriggerLinearBotJobsRun(message.payload);
        }
        if (message.action === 'triggerLinearReconcileRun') {
            return await handleTriggerLinearReconcileRun(message.payload);
        }
        if (message.action === 'getLinearBotJobsTriggerStatus') {
            return await handleGetLinearBotJobsTriggerStatus();
        }
        if (message.action === 'requestActiveScrape') {
            const data = await fetchAndCachePracticeList('manual-refresh');
            return { success: true, practicesCount: (data || []).length };
        }
        if (message.action === 'getPracticeLiveCounts') {
            // Never open extra tabs for live counts; use invisible in-session fetch only.
            const liveMailroomCounts = await resolveLiveMailroomCountsByOds(message.odsCode, { allowTempTab: false });
            return { success: true, liveMailroomCounts };
        }
        if (message.action === 'getPracticeStatus') {
            const normalizedOds = String(message.odsCode || '').trim().toUpperCase();
            let p = Object.values(practiceCache).find(x => x.ods === normalizedOds);

            // Return fast using cached live counts, and refresh counts in background.
            let liveMailroomCounts = getCachedLiveCounts(normalizedOds, LIVE_COUNTS_CACHE_TTL_MS * 4) || createEmptyLiveCounts();
            if (/^[A-Z]\d{5}$/.test(normalizedOds)) {
                const liveCountsPromise = resolveLiveMailroomCountsByOds(normalizedOds, { allowTempTab: false });
                const quickCounts = await withTimeout(liveCountsPromise, 800);
                if (quickCounts && hasAnyLiveCounts(quickCounts)) {
                    liveMailroomCounts = mergeLiveCounts(liveMailroomCounts, quickCounts);
                }
            }

            const looksInvalidCdb = !p?.cdb || p.cdb.trim().toLowerCase() === (p?.name || '').trim().toLowerCase();
            if (p && looksInvalidCdb && /^[A-Z]\d{5}$/.test(normalizedOds)) {
                fetchPracticeCdbByOds(normalizedOds)
                    .then(async (cdb) => {
                        if (!cdb) return;
                        const refreshed = { ...p, cdb, practiceCDB: cdb, timestamp: Date.now() };
                        const cacheKey = `${refreshed.name} (${refreshed.ods})`;
                        practiceCache[cacheKey] = refreshed;
                        await chrome.storage.local.set({ practiceCache, cacheTimestamp: Date.now() });
                    })
                    .catch(() => undefined);
            }

            return {
                success: true,
                status: {
                    ...p,
                    odsCode: p?.ods || normalizedOds || '',
                    practiceCDB: p?.cdb || 'N/A',
                    liveMailroomCounts
                }
            };
        }
        if (message.action === 'hydratePracticeCdb') {
            const updated = await hydrateMissingCdbs(message.limit || 25);
            return { success: true, updated };
        }
        return { error: "Unknown action" };
    };
    handle().then(sendResponse);
    return true; 
});
