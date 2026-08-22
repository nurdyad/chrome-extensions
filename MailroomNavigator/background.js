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
const PRACTICE_EHR_SETTINGS_CACHE_TTL_MS = 2 * 60 * 1000;
const LIVE_COUNTS_TEMP_TAB_COOLDOWN_MS = 30 * 1000;
const LIVE_COUNTS_TEMP_TAB_RESULT_WAIT_MS = 4500;
const LIVE_COUNTS_TEMP_TAB_HYDRATE_WINDOW_MS = 3200;
const LINEAR_TRIGGER_SERVER_BASE_URL = 'http://127.0.0.1:4817';
const LINEAR_TRIGGER_SERVER_TIMEOUT_MS = 12000;
const UUID_LOOKUP_TRIGGER_SERVER_TIMEOUT_MS = 26000;
const LINEAR_SLACK_PREFS_STORAGE_KEY = 'linearSlackPrefsV1';
const PRACTICE_SECRET_OVERRIDES_STORAGE_KEY = 'practiceSecretOverridesV1';
const PRACTICE_SECRET_HISTORY_STORAGE_KEY = 'practiceSecretHistoryV1';
const DEPLOYMENT_DEFAULTS = globalThis.MAILROOMNAV_DEPLOYMENT_DEFAULTS || {};
const liveCountsCacheByOds = new Map();
const practiceEhrSettingsCacheByOds = new Map();
const practiceEhrSettingsResolveInFlightByOds = new Map();
const liveCountsTempFetchInFlightByOds = new Map();
const liveCountsLastTempFetchAtByOds = new Map();
const liveCountsResolveInFlightByOds = new Map();
const LEGACY_MAILROOM_API_STORAGE_KEYS = ['mailroomApiConfigV1', 'MAILROOM_API_URL', 'MAILROOM_API_KEY'];
const PRACTICE_SECRET_FIELDS = new Set(['emisApiPassword', 'emisWebPassword', 'docmanPassword']);
const PRACTICE_SECRET_ADMIN_FIELD_NAMES = {
    emisApiPassword: 'ehr_settings[emis_api][password]',
    emisWebPassword: 'ehr_settings[emis_web][password]',
    docmanPassword: 'ehr_settings[docman][password]'
};
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
    'getPracticeCache',
    'requestActiveScrape',
    'getPracticeStatus',
    'hydratePracticeCdb'
]);
async function clearLegacyMailroomApiStorage() {
    try {
        await chrome.storage.local.remove(LEGACY_MAILROOM_API_STORAGE_KEYS);
    } catch (e) {
        // Ignore storage cleanup failures; they do not affect runtime behavior.
    }
}
clearLegacyMailroomApiStorage();

// --- 2. TAB RE-USE & LIVEVIEW CLICKING ---

function buildPracticeAdminUrl(odsCode) {
    const normalizedOds = String(odsCode || '').trim().toUpperCase();
    return `${BETTERLETTER_ORIGIN}/admin_panel/practices/${encodeURIComponent(normalizedOds)}`;
}

function isPracticeAdminRootUrl(url, odsCode) {
    try {
        const normalizedOds = String(odsCode || '').trim().toUpperCase();
        const parsed = new URL(String(url || ''));
        const normalizedPath = parsed.pathname.replace(/\/+$/, '');
        return parsed.origin === BETTERLETTER_ORIGIN
            && normalizedPath === `/admin_panel/practices/${encodeURIComponent(normalizedOds)}`;
    } catch (error) {
        return false;
    }
}

async function findAndFocusPracticeTab(odsCode) {
    const targetUrl = buildPracticeAdminUrl(odsCode);
    const tabs = await chrome.tabs.query({ url: `${targetUrl}*` });
    const exactPracticeTab = tabs.find((tab) => isPracticeAdminRootUrl(getTabUrl(tab), odsCode));

    if (!exactPracticeTab) return null;

    await chrome.windows.update(exactPracticeTab.windowId, { focused: true });
    await chrome.tabs.update(exactPracticeTab.id, { active: true });
    return exactPracticeTab.id;
}

async function clickLiveViewTab(tabId, settingType) {
    const settingConfigMap = {
        ehr_settings: {
            selectors: [
                "[data-test-id='tab-ehr_settings']",
                "#tab-ehr_settings",
                "[aria-controls='ehr_settings']",
                "[aria-controls='tab-panel-ehr_settings']",
                "a[href$='#ehr_settings']"
            ],
            labelText: 'ehr'
        },
        task_recipients: {
            selectors: [
                "[data-test-id='tab-task_recipients']",
                "#tab-task_recipients",
                "[aria-controls='task_recipients']",
                "[aria-controls='tab-panel-task_recipients']",
                "a[href$='#task_recipients']"
            ],
            labelText: 'task recipients'
        }
    };
    const settingConfig = settingConfigMap[settingType];
    if (!settingConfig) return;

    const injectedClick = async ({ selectors, labelText }) => {
        return new Promise((resolve) => {
            const normalizeText = (value) => String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
            const normalizedLabel = normalizeText(labelText);

            const isUsableTab = (element) => {
                if (!(element instanceof HTMLElement)) return false;
                if (element.hasAttribute('disabled')) return false;
                if (String(element.getAttribute('aria-disabled') || '').toLowerCase() === 'true') return false;

                const style = window.getComputedStyle(element);
                if (style.display === 'none' || style.visibility === 'hidden' || style.pointerEvents === 'none') {
                    return false;
                }

                const rect = element.getBoundingClientRect();
                return rect.width > 0 || rect.height > 0;
            };

            const findCandidate = () => {
                for (const selector of Array.isArray(selectors) ? selectors : []) {
                    const directMatch = document.querySelector(selector);
                    if (isUsableTab(directMatch)) return directMatch;
                }

                if (!normalizedLabel) return null;

                return Array.from(document.querySelectorAll("button, a, [role='tab'], [data-test-id], [phx-click]"))
                    .find((element) => isUsableTab(element) && normalizeText(element.textContent).includes(normalizedLabel)) || null;
            };

            const activate = (element) => {
                element.scrollIntoView({ block: 'center', inline: 'center' });
                element.focus();

                try {
                    element.click();
                } catch (error) {
                    // Fall through to synthetic events below.
                }

                ['mousedown', 'mouseup', 'click'].forEach((type) => {
                    element.dispatchEvent(new MouseEvent(type, {
                        bubbles: true,
                        cancelable: true,
                        view: window
                    }));
                });
            };

            let attempts = 0;
            const interval = setInterval(() => {
                const element = findCandidate();
                if (element) {
                    if (element.getAttribute('aria-selected') === 'true') {
                        clearInterval(interval);
                        resolve(true);
                        return;
                    }

                    activate(element);
                    clearInterval(interval);
                    resolve(true);
                    return;
                }

                if (attempts++ >= 30) {
                    clearInterval(interval);
                    resolve(false);
                }
            }, 500);
        });
    };

    const [executionResult] = await chrome.scripting.executeScript({
        target: { tabId },
        func: injectedClick,
        args: [settingConfig]
    });

    if (!executionResult?.result) {
        throw new Error(`Could not find the ${settingType.replace(/_/g, ' ')} tab on the practice page.`);
    }
}

async function handleOpenPractice(input, settingType = "ehr_settings") {
    const normalizedInput = String(input || '').trim();
    const odsMatch = normalizedInput.match(/\(([^)]+)\)$/);
    const odsCode = String(odsMatch ? odsMatch[1] : normalizedInput).trim().toUpperCase();
    if (!/^[A-Z]\d{5}$/.test(odsCode)) {
        throw new Error('Invalid practice code.');
    }

    const targetUrl = buildPracticeAdminUrl(odsCode);
    let tabId = await findAndFocusPracticeTab(odsCode);

    if (!tabId) {
        const newTab = await chrome.tabs.create({ url: targetUrl, active: true });
        tabId = newTab.id;
    }

    await waitForTabComplete(tabId, 15000).catch(() => undefined);
    await clickLiveViewTab(tabId, settingType);
    return { success: true };
}

async function getPracticeAdminTabForEhrSettings(odsCode) {
    const normalizedOds = String(odsCode || '').trim().toUpperCase();
    if (!/^[A-Z]\d{5}$/.test(normalizedOds)) {
        throw new Error('Invalid practice code.');
    }

    const targetUrl = buildPracticeAdminUrl(normalizedOds);
    let tabId = await findAndFocusPracticeTab(normalizedOds);
    if (!tabId) {
        const newTab = await chrome.tabs.create({ url: targetUrl, active: true });
        tabId = newTab.id;
    }

    await waitForTabComplete(tabId, 15000).catch(() => undefined);
    await clickLiveViewTab(tabId, 'ehr_settings');
    return tabId;
}

async function savePracticeSecretViaAdminPage({ odsCode, field, value }) {
    const normalizedOds = sanitizeSingleLine(odsCode, 16).toUpperCase();
    const normalizedField = sanitizeSingleLine(field, 80);
    const normalizedValue = normalizePracticeSecretOverrideValue(value);
    const fieldName = PRACTICE_SECRET_ADMIN_FIELD_NAMES[normalizedField] || '';

    if (!/^[A-Z]\d{5}$/.test(normalizedOds)) {
        throw new Error('Valid ODS code is required.');
    }
    if (!fieldName || !PRACTICE_SECRET_FIELDS.has(normalizedField)) {
        throw new Error('Unsupported password field.');
    }
    if (normalizedValue.length < 8) {
        throw new Error('Password is too short to save.');
    }

    const tabId = await getPracticeAdminTabForEhrSettings(normalizedOds);
    const [executionResult] = await chrome.scripting.executeScript({
        target: { tabId },
        func: async ({ fieldName: targetFieldName, passwordValue }) => {
            const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
            const normalizeText = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
            const findPasswordInput = () => {
                const byName = document.getElementsByName(targetFieldName)?.[0];
                if (byName instanceof HTMLInputElement) return byName;

                const byId = document.getElementById(targetFieldName);
                if (byId instanceof HTMLInputElement) return byId;

                return Array.from(document.querySelectorAll('input[type="password"], input[name*="[password]"]'))
                    .find((input) => input.getAttribute('name') === targetFieldName || input.id === targetFieldName) || null;
            };

            const isVisible = (element) => {
                if (!(element instanceof HTMLElement)) return false;
                const style = window.getComputedStyle(element);
                if (style.display === 'none' || style.visibility === 'hidden') return false;
                const rect = element.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0;
            };

            const findSaveButton = (root) => {
                const candidates = Array.from((root || document).querySelectorAll('button[type="submit"], input[type="submit"], button'));
                return candidates.find((candidate) => {
                    if (!(candidate instanceof HTMLElement) || !isVisible(candidate)) return false;
                    const text = normalizeText(candidate.textContent || candidate.value || candidate.getAttribute('aria-label'));
                    return text === 'save' || text.includes('save');
                }) || null;
            };

            let input = null;
            const inputDeadline = Date.now() + 8000;
            while (Date.now() < inputDeadline) {
                input = findPasswordInput();
                if (input && isVisible(input)) break;
                await wait(200);
            }
            if (!input || !isVisible(input)) {
                return {
                    ok: false,
                    error: `Could not find ${targetFieldName} on the EHR settings page.`
                };
            }

            input.scrollIntoView({ block: 'center', inline: 'center' });
            input.focus();
            const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
            if (valueSetter) valueSetter.call(input, passwordValue);
            else input.value = passwordValue;

            input.dispatchEvent(new InputEvent('input', {
                bubbles: true,
                cancelable: true,
                data: passwordValue,
                inputType: 'insertReplacementText'
            }));
            input.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
            input.dispatchEvent(new Event('blur', { bubbles: true, cancelable: true }));

            const form = input.closest('form') || document.querySelector('form');
            let saveButton = null;
            const saveDeadline = Date.now() + 6000;
            while (Date.now() < saveDeadline) {
                saveButton = findSaveButton(form || document);
                if (saveButton && !saveButton.disabled && saveButton.getAttribute('aria-disabled') !== 'true') break;
                await wait(200);
            }

            if (!saveButton) {
                return {
                    ok: false,
                    error: 'Could not find the EHR settings Save button.'
                };
            }

            if (saveButton.disabled || saveButton.getAttribute('aria-disabled') === 'true') {
                return {
                    ok: false,
                    error: 'The EHR settings Save button stayed disabled after changing the password.'
                };
            }

            saveButton.scrollIntoView({ block: 'center', inline: 'center' });
            saveButton.focus();
            try {
                saveButton.click();
            } catch (error) {
                ['mousedown', 'mouseup', 'click'].forEach((type) => {
                    saveButton.dispatchEvent(new MouseEvent(type, {
                        bubbles: true,
                        cancelable: true,
                        view: window
                    }));
                });
            }

            await wait(650);
            return { ok: true };
        },
        args: [{ fieldName, passwordValue: normalizedValue }]
    });

    const result = executionResult?.result || {};
    if (!result.ok) {
        throw new Error(sanitizeSingleLine(result.error, 240) || 'Could not save password in BetterLetter admin panel.');
    }

    return {
        field: normalizedField,
        value: normalizedValue,
        tabId
    };
}

// --- 3. SYSTEM UTILITIES ---

async function setupOffscreen() {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (contexts.length > 0) return;
    await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['DOM_SCRAPING', 'CLIPBOARD'],
        justification: 'Silent data sync and extension-owned clipboard copy fallback.'
    });
}

function isBetterLetterUrl(url) {
    return typeof url === 'string' && url.startsWith(`${BETTERLETTER_ORIGIN}/`);
}

function isAllowedExtensionTabUrl(url) {
    try {
        const parsed = new URL(String(url || ''));
        if (parsed.protocol !== 'https:') return false;
        if (parsed.origin === BETTERLETTER_ORIGIN) return true;
        if (parsed.hostname === 'linear.app' || parsed.hostname.endsWith('.linear.app')) return true;
        return false;
    } catch (error) {
        return false;
    }
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
function stringifySingleLineValue(value) {
    if (value == null) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (value instanceof Error) return value.message || String(value);
    if (typeof value === 'object') {
        const directMessage = value.message || value.error || value.reason || value.detail;
        if (directMessage && directMessage !== value) return stringifySingleLineValue(directMessage);
        try {
            return JSON.stringify(value);
        } catch {
            return String(value);
        }
    }
    return String(value);
}

function sanitizeSingleLine(value, maxLength = 1024) {
    return stringifySingleLineValue(value).replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function sanitizeMultiline(value, maxLength = 12000) {
    return String(value || '')
        .replace(/\r\n/g, '\n')
        .replace(/\u0000/g, '')
        .trim()
        .slice(0, maxLength);
}

function normalizeUuidLookupInput(value) {
    const raw = sanitizeSingleLine(value, 240).replace(/(?:…|\.\.\.)$/u, '').trim();
    if (!raw) return '';

    const fullUuidMatch = raw.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i);
    if (fullUuidMatch) return fullUuidMatch[0].toLowerCase();

    const partialMatch = raw.match(/[0-9a-f-]{6,80}/i);
    const partial = sanitizeSingleLine(partialMatch?.[0] || '', 80)
        .replace(/^-+|-+$/g, '')
        .toLowerCase();
    return /^[0-9a-f-]{6,80}$/.test(partial) ? partial : '';
}

function extractUuid(value) {
    return normalizeUuidLookupInput(value);
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

function isServerlessLiteModeEnabled() {
    const rawValue = DEPLOYMENT_DEFAULTS?.serverlessLiteMode ?? DEPLOYMENT_DEFAULTS?.serverlessMode;
    if (typeof rawValue === 'string') {
        return ['1', 'true', 'yes', 'lite'].includes(rawValue.trim().toLowerCase());
    }
    return Boolean(rawValue);
}

function sanitizeLinearSlackPayload(rawSlack = null) {
    if (!rawSlack || typeof rawSlack !== 'object') return null;
    return {
        enabled: Boolean(rawSlack.enabled),
        targetType: normalizeSlackTargetType(rawSlack.targetType),
        target: sanitizeSingleLine(rawSlack.target, 80).replace(/^[@#]/, '')
    };
}

function sanitizeLinearIssueLabelList(rawLabels = []) {
    if (!Array.isArray(rawLabels)) return [];
    const unique = new Set();
    rawLabels.forEach((label) => {
        const normalized = sanitizeSingleLine(label, 120);
        if (!normalized) return;
        unique.add(normalized);
    });
    return [...unique].slice(0, 20);
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
        labels: sanitizeLinearIssueLabelList(rawPayload.labels),
        stateName: sanitizeSingleLine(rawPayload.stateName, 120),
        dedupeKey: sanitizeSingleLine(rawPayload.dedupeKey, 160),
        jobType: sanitizeSingleLine(rawPayload.jobType, 120),
        slack: sanitizeLinearSlackPayload(rawPayload?.slack)
    };
}

function isDocumentOptionalLinearIssuePayload(payload) {
    const normalizedTitle = sanitizeSingleLine(payload?.title, 240);
    const failedJobId = sanitizeSingleLine(payload?.failedJobId, 120);
    return Boolean(
        /^Bot Job Error:/i.test(normalizedTitle)
        || /^Bot Job Spike:/i.test(normalizedTitle)
        || /^Preparing stuck letters:/i.test(normalizedTitle)
        || /^Practice Support Ticket:/i.test(normalizedTitle)
        || failedJobId
    );
}

function validateLinearIssuePayload(payload) {
    if (!/^\d+$/.test(payload.documentId) && !isDocumentOptionalLinearIssuePayload(payload)) {
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
    if (isServerlessLiteModeEnabled()) {
        return buildServerlessLiteUnsupportedResponse(
            'Create Linear Issue',
            'Serverless Lite keeps local draft generation only. Copy the generated title and description into Linear manually.'
        );
    }
    try {
        const payload = sanitizeLinearIssuePayload(rawPayload);
        if (!payload.slack) {
            const storedSlackPrefs = await getStoredLinearSlackPrefs();
            if (storedSlackPrefs?.enabled) {
                payload.slack = storedSlackPrefs;
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
            duplicate: Boolean(serverPayload?.duplicate),
            reopened: Boolean(serverPayload?.reopened),
            reopenStateName: sanitizeSingleLine(serverPayload?.reopenStateName, 120),
            reopenError: sanitizeSingleLine(serverPayload?.reopenError, 260),
            reopenSkipped: sanitizeSingleLine(serverPayload?.reopenSkipped, 120),
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
    if (isServerlessLiteModeEnabled()) {
        return buildServerlessLiteUnsupportedResponse(
            'Slack Sync',
            'Serverless Lite mode does not expose Slack workspace syncing because it would require shipping your Slack bot token in the extension.'
        );
    }
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

function normalizeDocmanToolAction(rawAction) {
    const normalized = sanitizeSingleLine(rawAction, 40).toLowerCase();
    if (normalized === 'login') return 'login';
    if (normalized === 'verify') return 'verify';
    if (['create-group', 'create_group', 'creategroup', 'group'].includes(normalized)) return 'create-group';
    if (['clean-processing', 'clean_processing', 'processing'].includes(normalized)) return 'clean-processing';
    if (['clean-filing', 'clean_filing', 'filing'].includes(normalized)) return 'clean-filing';
    if (normalized === 'onboarding') return 'onboarding';
    return '';
}

function sanitizeDocmanToolUsernames(rawUsernames = []) {
    if (!Array.isArray(rawUsernames)) return [];
    const seen = new Set();
    const usernames = [];
    rawUsernames.forEach((value) => {
        const username = sanitizeSingleLine(value, 120);
        if (!username) return;
        const key = username.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        usernames.push(username);
    });
    return usernames.slice(0, 500);
}

function sanitizeDocmanToolRunPayload(rawPayload = {}) {
    return {
        action: normalizeDocmanToolAction(rawPayload?.action),
        practiceName: sanitizeSingleLine(rawPayload?.practiceName, 240),
        odsCode: sanitizeSingleLine(rawPayload?.odsCode, 16).toUpperCase(),
        groupName: sanitizeSingleLine(rawPayload?.groupName, 240),
        usernames: sanitizeDocmanToolUsernames(rawPayload?.usernames),
        onboardingInputFolderName: sanitizeSingleLine(rawPayload?.onboardingInputFolderName, 240),
        docmanUsername: sanitizeSingleLine(rawPayload?.docmanUsername, 240),
        docmanPassword: String(rawPayload?.docmanPassword ?? '').trim().slice(0, 240)
    };
}

function sanitizeDocmanToolRun(rawRun = null) {
    if (!rawRun || typeof rawRun !== 'object') return null;
    const status = sanitizeSingleLine(rawRun.status, 32).toLowerCase();
    const exitCode = typeof rawRun.exitCode === 'number' && Number.isFinite(rawRun.exitCode)
        ? rawRun.exitCode
        : null;
    const rawResultData = rawRun.resultData && typeof rawRun.resultData === 'object' ? rawRun.resultData : null;
    const resultType = normalizeDocmanToolAction(rawResultData?.type);
    return {
        runId: sanitizeSingleLine(rawRun.runId, 80),
        startedAt: sanitizeSingleLine(rawRun.startedAt, 80),
        endedAt: sanitizeSingleLine(rawRun.endedAt, 80),
        status: ['running', 'success', 'failed'].includes(status) ? status : '',
        action: normalizeDocmanToolAction(rawRun.action),
        practiceName: sanitizeSingleLine(rawRun.practiceName, 240),
        odsCode: sanitizeSingleLine(rawRun.odsCode, 16).toUpperCase(),
        groupName: sanitizeSingleLine(rawRun.groupName, 240),
        usernamesCount: Number.isFinite(Number(rawRun.usernamesCount)) ? Number(rawRun.usernamesCount) : 0,
        onboardingInputFolderName: sanitizeSingleLine(rawRun.onboardingInputFolderName, 240),
        exitCode,
        signal: sanitizeSingleLine(rawRun.signal, 32),
        error: sanitizeSingleLine(rawRun.error, 260),
        summaryLines: sanitizeLinearTriggerRunLines(rawRun.summaryLines, 10, 240),
        logLines: sanitizeLinearTriggerRunLines(rawRun.logLines, 120, 240),
        resultData: rawResultData ? {
            type: resultType,
            checked: Number.isFinite(Number(rawResultData.checked)) ? Number(rawResultData.checked) : 0,
            matched: Number.isFinite(Number(rawResultData.matched)) ? Number(rawResultData.matched) : 0,
            missing: Number.isFinite(Number(rawResultData.missing)) ? Number(rawResultData.missing) : 0,
            clipboardCopied: Boolean(rawResultData.clipboardCopied),
            exactMatches: sanitizeDocmanToolUsernames(rawResultData.exactMatches),
            results: Array.isArray(rawResultData.results)
                ? rawResultData.results.map((entry, index) => ({
                    index: Number.isFinite(Number(entry?.index)) ? Number(entry.index) : index,
                    requestedUsername: sanitizeSingleLine(entry?.requestedUsername, 120),
                    docmanUsername: sanitizeSingleLine(entry?.docmanUsername, 120),
                    exists: Boolean(entry?.exists),
                    detail: sanitizeSingleLine(entry?.detail, 180)
                })).slice(0, 500)
                : [],
            groupName: sanitizeSingleLine(rawResultData.groupName, 240),
            members: sanitizeDocmanToolUsernames(rawResultData.members),
            membersCount: Number.isFinite(Number(rawResultData.membersCount)) ? Number(rawResultData.membersCount) : 0,
            inputFolderName: sanitizeSingleLine(rawResultData.inputFolderName, 240),
            folderCount: Number.isFinite(Number(rawResultData.folderCount)) ? Number(rawResultData.folderCount) : 0,
            existingCount: Number.isFinite(Number(rawResultData.existingCount)) ? Number(rawResultData.existingCount) : 0,
            cleanType: sanitizeSingleLine(rawResultData.cleanType, 80)
        } : null
    };
}

function sanitizeUuidLookupResult(rawLookup = null) {
    if (!rawLookup || typeof rawLookup !== 'object') {
        return {
            uuid: '',
            found: false,
            source: '',
            status: '',
            detail: '',
            checkedAt: '',
            matchedStatusPath: ''
        };
    }

    return {
        uuid: extractUuid(rawLookup.uuid),
        found: Boolean(rawLookup.found),
        source: sanitizeSingleLine(rawLookup.source, 80),
        status: sanitizeSingleLine(rawLookup.status, 240),
        detail: sanitizeSingleLine(rawLookup.detail, 320),
        documentId: sanitizeSingleLine(rawLookup.documentId, 80),
        documentLink: sanitizeSingleLine(rawLookup.documentLink, 1200),
        rejectionReason: sanitizeSingleLine(rawLookup.rejectionReason, 320),
        matchedUuid: sanitizeSingleLine(rawLookup.matchedUuid, 160),
        inputFileName: sanitizeSingleLine(rawLookup.inputFileName, 260),
        rejectionId: sanitizeSingleLine(rawLookup.rejectionId, 80),
        rejectionMarkedBy: sanitizeSingleLine(rawLookup.rejectionMarkedBy, 180),
        rejectionProcessingStatus: sanitizeSingleLine(rawLookup.rejectionProcessingStatus, 120),
        matchType: sanitizeSingleLine(rawLookup.matchType, 80),
        checkedAt: sanitizeSingleLine(rawLookup.checkedAt, 80),
        matchedStatusPath: sanitizeSingleLine(rawLookup.matchedStatusPath, 160)
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

function sanitizeSqlPracticeDetails(rawPractice = null) {
    if (!rawPractice || typeof rawPractice !== 'object') return null;
    const odsCode = sanitizeSingleLine(rawPractice.odsCode || rawPractice.ods || rawPractice.id, 16).toUpperCase();
    if (!/^[A-Z]\d{5}$/.test(odsCode)) return null;

    return {
        id: odsCode,
        ods: odsCode,
        odsCode,
        name: sanitizeSingleLine(rawPractice.name || rawPractice.displayName, 240),
        displayName: sanitizeSingleLine(rawPractice.displayName || rawPractice.name, 240),
        cdb: sanitizeSingleLine(rawPractice.cdb || rawPractice.practiceCDB, 80),
        practiceCDB: sanitizeSingleLine(rawPractice.practiceCDB || rawPractice.cdb, 80),
        ehrType: sanitizeSingleLine(rawPractice.ehrType, 80),
        serviceLevel: sanitizeSingleLine(rawPractice.serviceLevel, 80),
        collectionQuota: sanitizeSingleLine(rawPractice.collectionQuota, 40),
        collectedToday: sanitizeSingleLine(rawPractice.collectedToday, 40),
        fullServiceQuota: sanitizeSingleLine(rawPractice.fullServiceQuota, 40),
        fullServiceQuotaUsed: sanitizeSingleLine(rawPractice.fullServiceQuotaUsed, 40),
        active: Boolean(rawPractice.active),
        codingEnabled: Boolean(rawPractice.codingEnabled),
        selfService: Boolean(rawPractice.selfService),
        source: sanitizeSingleLine(rawPractice.source, 80) || 'cloud-sql',
        practiceCdb: sanitizeSingleLine(rawPractice.practiceCDB || rawPractice.cdb, 80),
        emisApiUsername: sanitizeSingleLine(rawPractice.emisApiUsername, 240),
        emisApiPassword: '',
        emisApiPasswordPresent: Boolean(rawPractice.emisApiPasswordPresent),
        emisWebUsername: sanitizeSingleLine(rawPractice.emisWebUsername, 240),
        emisWebPassword: '',
        emisWebPasswordPresent: Boolean(rawPractice.emisWebPasswordPresent),
        emisWebDummyNhsNumber: sanitizeSingleLine(rawPractice.emisWebDummyNhsNumber, 80),
        docmanUsername: sanitizeSingleLine(rawPractice.docmanUsername, 240),
        docmanPassword: '',
        docmanPasswordPresent: Boolean(rawPractice.docmanPasswordPresent),
        docmanDummyNhsNumber: sanitizeSingleLine(rawPractice.docmanDummyNhsNumber, 80),
        docmanInputFolder: sanitizeSingleLine(rawPractice.docmanInputFolder, 240),
        docmanProcessingFolder: sanitizeSingleLine(rawPractice.docmanProcessingFolder, 240),
        docmanFilingFolder: sanitizeSingleLine(rawPractice.docmanFilingFolder, 240),
        docmanRejectedFolder: sanitizeSingleLine(rawPractice.docmanRejectedFolder, 240)
    };
}

async function fetchPracticeDetailsFromSql(query, { timeoutMs = 2200 } = {}) {
    const normalizedQuery = sanitizeSingleLine(query, 120);
    if (!normalizedQuery) return null;

    try {
        const { response, payload } = await callLinearTriggerServer(`/practice/lookup?query=${encodeURIComponent(normalizedQuery)}&limit=1`, {
            method: 'GET',
            timeoutMs
        });
        if (!response.ok || !payload?.ok) return null;
        return sanitizeSqlPracticeDetails(payload.practice);
    } catch (error) {
        return null;
    }
}

function sanitizeSqlLiveCounts(rawCounts = null) {
    if (!rawCounts || typeof rawCounts !== 'object') return null;
    return {
        preparing: normalizeLetterCountValue(rawCounts.preparing),
        edit: normalizeLetterCountValue(rawCounts.edit),
        review: normalizeLetterCountValue(rawCounts.review),
        coding: normalizeLetterCountValue(rawCounts.coding),
        rejected: normalizeLetterCountValue(rawCounts.rejected),
        source: sanitizeSingleLine(rawCounts.source, 80) || 'cloud-sql',
        fetchedAt: Date.now()
    };
}

async function fetchPracticeLiveCountsFromSql(odsCode, { timeoutMs = 2400 } = {}) {
    const normalizedOds = sanitizeSingleLine(odsCode, 16).toUpperCase();
    if (!/^[A-Z]\d{5}$/.test(normalizedOds)) return null;

    try {
        const { response, payload } = await callLinearTriggerServer(`/practice/live-counts?ods=${encodeURIComponent(normalizedOds)}`, {
            method: 'GET',
            timeoutMs
        });
        if (!response.ok || !payload?.ok) return null;
        return sanitizeSqlLiveCounts(payload.counts);
    } catch (error) {
        return null;
    }
}

async function fetchPracticeSecretFromSql(odsCode, field, { timeoutMs = 2400 } = {}) {
    const normalizedOds = sanitizeSingleLine(odsCode, 16).toUpperCase();
    const normalizedField = sanitizeSingleLine(field, 80);
    if (!/^[A-Z]\d{5}$/.test(normalizedOds)) return null;
    if (!PRACTICE_SECRET_FIELDS.has(normalizedField)) return null;

    try {
        const { response, payload } = await callLinearTriggerServer(`/practice/secret?ods=${encodeURIComponent(normalizedOds)}&field=${encodeURIComponent(normalizedField)}`, {
            method: 'GET',
            timeoutMs
        });
        if (!response.ok || !payload?.ok) return null;
        return {
            field: sanitizeSingleLine(payload.field, 80),
            value: String(payload.value || '').trim().slice(0, 1024),
            present: Boolean(payload.present)
        };
    } catch (error) {
        return null;
    }
}

function normalizePracticeSecretOverrideValue(value) {
    return String(value || '').replace(/\u0000/g, '').trim().slice(0, 1024);
}

async function getPracticeSecretOverrides() {
    const result = await chrome.storage.local.get([PRACTICE_SECRET_OVERRIDES_STORAGE_KEY]);
    const rawOverrides = result?.[PRACTICE_SECRET_OVERRIDES_STORAGE_KEY];
    return rawOverrides && typeof rawOverrides === 'object' && !Array.isArray(rawOverrides)
        ? rawOverrides
        : {};
}

async function getPracticeSecretOverride(odsCode, field) {
    const normalizedOds = sanitizeSingleLine(odsCode, 16).toUpperCase();
    const normalizedField = sanitizeSingleLine(field, 80);
    if (!/^[A-Z]\d{5}$/.test(normalizedOds)) return '';
    if (!PRACTICE_SECRET_FIELDS.has(normalizedField)) return '';
    const overrides = await getPracticeSecretOverrides();
    return normalizePracticeSecretOverrideValue(overrides?.[normalizedOds]?.[normalizedField]);
}

function normalizePracticeSecretHistoryEntries(entries) {
    if (!Array.isArray(entries)) return [];
    const seenValues = new Set();
    const normalizedEntries = [];

    for (const entry of entries) {
        const value = normalizePracticeSecretOverrideValue(
            entry && typeof entry === 'object' ? entry.value : entry
        );
        if (!value || seenValues.has(value)) continue;
        seenValues.add(value);
        normalizedEntries.push({
            value,
            savedAt: sanitizeSingleLine(entry?.savedAt, 40) || new Date().toISOString(),
            source: sanitizeSingleLine(entry?.source, 40) || 'unknown'
        });
        if (normalizedEntries.length >= 3) break;
    }

    return normalizedEntries;
}

async function getPracticeSecretHistoryStore() {
    const result = await chrome.storage.local.get([PRACTICE_SECRET_HISTORY_STORAGE_KEY]);
    const rawHistory = result?.[PRACTICE_SECRET_HISTORY_STORAGE_KEY];
    return rawHistory && typeof rawHistory === 'object' && !Array.isArray(rawHistory)
        ? rawHistory
        : {};
}

async function getPracticeSecretHistory(odsCode, field) {
    const normalizedOds = sanitizeSingleLine(odsCode, 16).toUpperCase();
    const normalizedField = sanitizeSingleLine(field, 80);
    if (!/^[A-Z]\d{5}$/.test(normalizedOds)) return [];
    if (!PRACTICE_SECRET_FIELDS.has(normalizedField)) return [];

    const history = await getPracticeSecretHistoryStore();
    return normalizePracticeSecretHistoryEntries(history?.[normalizedOds]?.[normalizedField]);
}

async function savePracticeSecretHistory(odsCode, field, entries) {
    const normalizedOds = sanitizeSingleLine(odsCode, 16).toUpperCase();
    const normalizedField = sanitizeSingleLine(field, 80);
    if (!/^[A-Z]\d{5}$/.test(normalizedOds)) {
        throw new Error('Valid ODS code is required.');
    }
    if (!PRACTICE_SECRET_FIELDS.has(normalizedField)) {
        throw new Error('Unsupported password field.');
    }

    const normalizedEntries = normalizePracticeSecretHistoryEntries(entries);
    const history = await getPracticeSecretHistoryStore();
    const nextForPractice = {
        ...(history[normalizedOds] && typeof history[normalizedOds] === 'object' ? history[normalizedOds] : {}),
        [normalizedField]: normalizedEntries
    };
    const nextHistory = {
        ...history,
        [normalizedOds]: nextForPractice
    };
    await chrome.storage.local.set({ [PRACTICE_SECRET_HISTORY_STORAGE_KEY]: nextHistory });
    return normalizedEntries;
}

async function rememberPracticeSecretHistoryEntry(odsCode, field, value, { source = 'unknown', excludeValue = '' } = {}) {
    const previousValue = normalizePracticeSecretOverrideValue(value);
    const normalizedExcludeValue = normalizePracticeSecretOverrideValue(excludeValue);
    if (!previousValue || previousValue === normalizedExcludeValue) {
        return getPracticeSecretHistory(odsCode, field);
    }

    const currentHistory = await getPracticeSecretHistory(odsCode, field);
    const nextHistory = [
        {
            value: previousValue,
            savedAt: new Date().toISOString(),
            source
        },
        ...currentHistory.filter((entry) => normalizePracticeSecretOverrideValue(entry.value) !== previousValue)
    ];
    return savePracticeSecretHistory(odsCode, field, nextHistory);
}

async function savePracticeSecretOverride(odsCode, field, value) {
    const normalizedOds = sanitizeSingleLine(odsCode, 16).toUpperCase();
    const normalizedField = sanitizeSingleLine(field, 80);
    const normalizedValue = normalizePracticeSecretOverrideValue(value);
    if (!/^[A-Z]\d{5}$/.test(normalizedOds)) {
        throw new Error('Valid ODS code is required.');
    }
    if (!PRACTICE_SECRET_FIELDS.has(normalizedField)) {
        throw new Error('Unsupported password field.');
    }
    if (normalizedValue.length < 8) {
        throw new Error('Password is too short to save.');
    }

    const overrides = await getPracticeSecretOverrides();
    const nextForPractice = {
        ...(overrides[normalizedOds] && typeof overrides[normalizedOds] === 'object' ? overrides[normalizedOds] : {}),
        [normalizedField]: normalizedValue
    };
    const nextOverrides = {
        ...overrides,
        [normalizedOds]: nextForPractice
    };
    await chrome.storage.local.set({ [PRACTICE_SECRET_OVERRIDES_STORAGE_KEY]: nextOverrides });
    return {
        field: normalizedField,
        value: normalizedValue
    };
}

async function getPracticeSecretValue(odsCode, field) {
    const overrideValue = await getPracticeSecretOverride(odsCode, field);
    if (overrideValue) {
        return {
            field: sanitizeSingleLine(field, 80),
            value: overrideValue,
            source: 'browser'
        };
    }

    const sqlSecret = await fetchPracticeSecretFromSql(odsCode, field);
    if (!sqlSecret?.value) return sqlSecret;
    return {
        ...sqlSecret,
        source: 'cloud-sql'
    };
}

async function applyPracticeSecretOverrides(odsCode, ehrSettings) {
    const normalizedOds = sanitizeSingleLine(odsCode, 16).toUpperCase();
    if (!/^[A-Z]\d{5}$/.test(normalizedOds)) return ehrSettings;

    const overrides = await getPracticeSecretOverrides();
    const practiceOverrides = overrides?.[normalizedOds];
    if (!practiceOverrides || typeof practiceOverrides !== 'object') return ehrSettings;

    const next = { ...ehrSettings };
    for (const field of PRACTICE_SECRET_FIELDS) {
        const value = normalizePracticeSecretOverrideValue(practiceOverrides[field]);
        if (!value) continue;
        next[field] = value;
        next[`${field}Present`] = true;
    }
    return next;
}

function normalizeLinearTriggerError(error) {
    const errorName = sanitizeSingleLine(error?.name, 80).toLowerCase();
    if (errorName === 'aborterror') {
        return 'Local trigger service timed out.';
    }

    const message = sanitizeSingleLine(
        error?.message
            || error?.error
            || error?.reason
            || error?.detail
            || error,
        320
    );
    if (!message) {
        return 'Local trigger service is unavailable.';
    }

    if (message.toLowerCase().includes('failed to fetch')) {
        return 'Local trigger service is unavailable. Run install-linear-trigger-launchagent.sh.';
    }

    return message;
}

function buildServerlessLiteUnsupportedResponse(featureLabel, guidance = '') {
    const message = [
        `${String(featureLabel || 'This feature').trim()} is disabled in Serverless Lite mode.`,
        guidance || 'Use the browser-only tools, or move this feature to a shared hosted service if you need it everywhere.'
    ].filter(Boolean).join(' ');
    return {
        success: false,
        error: message
    };
}

async function handleTriggerLinearRun(rawPayload, triggerPath = '/trigger-linear') {
    if (isServerlessLiteModeEnabled()) {
        const label = triggerPath === '/trigger-linear-reconcile' ? 'Reconcile Linear' : 'Trigger Linear';
        return buildServerlessLiteUnsupportedResponse(
            label,
            'These actions run external bot-jobs scripts, which Chrome extensions cannot execute without a service.'
        );
    }
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

async function handleRestartLinearTriggerServer() {
    if (isServerlessLiteModeEnabled()) {
        return buildServerlessLiteUnsupportedResponse(
            'Restart Trigger Service',
            'Serverless Lite mode does not run the local trigger service.'
        );
    }
    try {
        const { response, payload } = await callLinearTriggerServer('/service/restart', {
            method: 'POST'
        });

        if (response.status === 409) {
            return {
                success: false,
                running: Boolean(payload?.running),
                error: sanitizeSingleLine(payload?.error, 240) || 'A Linear run is already in progress.'
            };
        }

        if (!response.ok || !payload?.ok) {
            const serverError = sanitizeSingleLine(payload?.error, 260);
            if (response.status === 404 || serverError.toLowerCase() === 'not found.') {
                return {
                    success: false,
                    error: 'Local trigger service is running an older version. Restart it manually once so the new in-extension restart button is available.'
                };
            }
            return {
                success: false,
                error: serverError || `Trigger service restart failed with status ${response.status}.`
            };
        }

        return {
            success: true,
            message: sanitizeSingleLine(payload?.message, 240) || 'Restart requested.'
        };
    } catch (error) {
        const normalizedError = normalizeLinearTriggerError(error);
        const fallbackMessage = 'Local trigger service is unavailable. This button can restart the installed service after it is already running, but it cannot cold-start it from the extension.';
        return {
            success: false,
            error: normalizedError.toLowerCase().includes('unavailable')
                ? fallbackMessage
                : normalizedError
        };
    }
}

async function handleGetLinearBotJobsTriggerStatus() {
    if (isServerlessLiteModeEnabled()) {
        return buildServerlessLiteUnsupportedResponse(
            'Linear run status',
            'Serverless Lite mode does not run Trigger Linear or Reconcile Linear.'
        );
    }
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

async function handleRunDocmanToolAction(rawPayload) {
    if (isServerlessLiteModeEnabled()) {
        return buildServerlessLiteUnsupportedResponse(
            'Docman Tools',
            'These actions run the local docman-tool on your machine, so they still need the optional local trigger service.'
        );
    }

    const startDocmanRun = async (runPayload) => {
        const { response, payload: serverPayload } = await callLinearTriggerServer('/docman/run', {
            method: 'POST',
            body: runPayload
        });
        const run = sanitizeDocmanToolRun(serverPayload?.run);

        if (response.status === 409) {
            return {
                success: false,
                running: true,
                run,
                error: sanitizeSingleLine(serverPayload?.error, 220) || 'A Docman tool run is already in progress.'
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
                statusCode: response.status,
                error: serverError || `Trigger service failed with status ${response.status}.`
            };
        }

        return {
            success: true,
            run
        };
    };

    try {
        const payload = sanitizeDocmanToolRunPayload(rawPayload);
        const sqlFirstResult = await startDocmanRun(payload);
        if (sqlFirstResult.success || sqlFirstResult.running) {
            return sqlFirstResult;
        }

        const shouldFallbackToScrape = (
            sqlFirstResult.statusCode === 400
            && /docman username\/password|username\/password|credentials|missing/i.test(sqlFirstResult.error || '')
        );
        if (!shouldFallbackToScrape) {
            return {
                success: false,
                error: sqlFirstResult.error || 'Could not start Docman tool.'
            };
        }

        const ehrSettings = /^[A-Z]\d{5}$/.test(payload.odsCode)
            ? await fetchPracticeEhrSettingsByOds(payload.odsCode)
            : createEmptyPracticeEhrSettings();
        const directDocmanPayload = sanitizeDocmanToolRunPayload({
            ...payload,
            docmanUsername: ehrSettings.docmanUsername || payload.docmanUsername,
            docmanPassword: ehrSettings.docmanPassword || payload.docmanPassword
        });

        if (!directDocmanPayload.docmanUsername || !directDocmanPayload.docmanPassword) {
            return {
                success: false,
                error: 'Could not read Docman username/password from Cloud SQL or BetterLetter settings. Check Cloud SQL proxy/service config, or keep a signed-in BetterLetter tab open for this practice and retry.'
            };
        }

        const fallbackResult = await startDocmanRun(directDocmanPayload);
        return fallbackResult.success || fallbackResult.running
            ? fallbackResult
            : {
                success: false,
                error: fallbackResult.error || 'Could not start Docman tool.'
            };
    } catch (error) {
        return {
            success: false,
            error: normalizeLinearTriggerError(error)
        };
    }
}

async function handleGetDocmanToolRunStatus() {
    if (isServerlessLiteModeEnabled()) {
        return buildServerlessLiteUnsupportedResponse(
            'Docman tool status',
            'Serverless Lite mode does not run the local docman-tool trigger service.'
        );
    }
    try {
        const { response, payload } = await callLinearTriggerServer('/docman/status', { method: 'GET' });
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
                activeRun: sanitizeDocmanToolRun(payload.activeRun),
                lastRun: sanitizeDocmanToolRun(payload.lastRun),
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

async function handleLookupUuidStatus(rawPayload = null) {
    if (isServerlessLiteModeEnabled()) {
        return buildServerlessLiteUnsupportedResponse(
            'UUID Lookup',
            'UUID lookup needs the local trigger service and Cloud SQL config.'
        );
    }
    try {
        const uuid = extractUuid(rawPayload?.uuid || rawPayload);
        if (!uuid) {
            throw new Error('Invalid or missing UUID.');
        }

        const { response, payload } = await callLinearTriggerServer(`/uuid-status?uuid=${encodeURIComponent(uuid)}`, {
            method: 'GET',
            timeoutMs: UUID_LOOKUP_TRIGGER_SERVER_TIMEOUT_MS
        });

        if (!response.ok || !payload?.ok) {
            const serverError = sanitizeSingleLine(payload?.error, 240);
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
            result: sanitizeUuidLookupResult(payload.lookup)
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

function createEmptyPracticeEhrSettings() {
    return {
        practiceCdb: '',
        emisApiUsername: '',
        emisApiPassword: '',
        emisApiPasswordPresent: false,
        emisWebUsername: '',
        emisWebPassword: '',
        emisWebPasswordPresent: false,
        emisWebDummyNhsNumber: '',
        docmanUsername: '',
        docmanPassword: '',
        docmanPasswordPresent: false,
        docmanDummyNhsNumber: '',
        docmanInputFolder: '',
        docmanProcessingFolder: '',
        docmanFilingFolder: '',
        docmanRejectedFolder: ''
    };
}

function getCachedPracticeEhrSettings(odsCode, maxAgeMs = PRACTICE_EHR_SETTINGS_CACHE_TTL_MS) {
    const key = String(odsCode || '').trim().toUpperCase();
    const cached = practiceEhrSettingsCacheByOds.get(key);
    if (!cached || typeof cached !== 'object') return null;
    if (!Number.isFinite(cached.timestamp)) return null;
    if (Date.now() - cached.timestamp > maxAgeMs) return null;
    return cached.details && typeof cached.details === 'object'
        ? { ...createEmptyPracticeEhrSettings(), ...cached.details }
        : null;
}

function setCachedPracticeEhrSettings(odsCode, details, source = 'unknown') {
    const key = String(odsCode || '').trim().toUpperCase();
    if (!key || !details || typeof details !== 'object') return;
    practiceEhrSettingsCacheByOds.set(key, {
        details: { ...createEmptyPracticeEhrSettings(), ...details },
        source: String(source || 'unknown'),
        timestamp: Date.now()
    });
}

async function fetchPracticeEhrSettingsByOds(odsCode, preferredTabId = null) {
    const normalizedOds = String(odsCode || '').trim().toUpperCase();
    if (!normalizedOds) return createEmptyPracticeEhrSettings();

    const cached = getCachedPracticeEhrSettings(normalizedOds);
    if (cached) return cached;
    if (practiceEhrSettingsResolveInFlightByOds.has(normalizedOds)) {
        return practiceEhrSettingsResolveInFlightByOds.get(normalizedOds);
    }

    const promise = runInExistingBetterLetterTab(async (targetOds) => {
        const createEmptyDetails = () => ({
            practiceCdb: '',
            emisApiUsername: '',
            emisApiPassword: '',
            emisWebUsername: '',
            emisWebPassword: '',
            emisWebDummyNhsNumber: '',
            docmanUsername: '',
            docmanPassword: '',
            docmanDummyNhsNumber: '',
            docmanInputFolder: '',
            docmanProcessingFolder: '',
            docmanFilingFolder: '',
            docmanRejectedFolder: ''
        });

        const normalizeText = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
        const SECTION_TITLES = ['EMIS API Settings', 'EMIS Web Settings', 'Docman Settings'];
        const SECTION_TITLE_SET = new Set(SECTION_TITLES.map((title) => normalizeText(title).toLowerCase()));

        const getOwnText = (element) => {
            if (!(element instanceof Element)) return '';
            return Array.from(element.childNodes || [])
                .filter((node) => node.nodeType === Node.TEXT_NODE)
                .map((node) => node.textContent || '')
                .join(' ');
        };

        const getHeadingText = (element) => {
            if (!(element instanceof Element)) return '';
            const preferredText = normalizeText(getOwnText(element));
            if (preferredText) return preferredText;
            const ariaText = normalizeText(element.getAttribute('aria-label') || '');
            if (ariaText) return ariaText;
            return normalizeText(element.textContent || '');
        };

        const getControlForLabel = (label) => {
            if (!(label instanceof Element)) return null;
            const ownerDoc = label.ownerDocument || document;

            if (label.control) return label.control;

            if (label.htmlFor) {
                const byId = ownerDoc.getElementById(label.htmlFor);
                if (byId) return byId;
            }

            const nested = label.querySelector('input, select, textarea');
            if (nested) return nested;

            let sibling = label.nextElementSibling;
            while (sibling) {
                if (sibling.matches?.('input, select, textarea')) return sibling;
                const insideSibling = sibling.querySelector?.('input, select, textarea');
                if (insideSibling) return insideSibling;
                sibling = sibling.nextElementSibling;
            }

            const parent = label.parentElement;
            if (parent) {
                const controls = parent.querySelectorAll('input, select, textarea');
                if (controls.length === 1) return controls[0];
            }

            return null;
        };

        const findFieldByLabel = (pattern, root = document, options = {}) => {
            const labels = Array.from(root.querySelectorAll('label'));
            const requiredType = String(options.type || '').trim().toLowerCase();

            for (const label of labels) {
                const labelText = normalizeText(label.textContent).toLowerCase();
                if (!pattern.test(labelText)) continue;

                const control = getControlForLabel(label);
                if (!control) continue;

                const controlType = normalizeText(control.getAttribute?.('type') || control.type).toLowerCase();
                if (requiredType && controlType !== requiredType) continue;

                return control;
            }

            return null;
        };

        const findInputByHints = (hints, root = document, options = {}) => {
            const inputs = Array.from(root.querySelectorAll('input, select, textarea'));
            const preferPassword = Boolean(options.preferPassword);
            const normalizedHints = hints.map((hint) => normalizeText(hint).toLowerCase());

            const candidates = inputs.filter((input) => {
                const type = normalizeText(input.getAttribute?.('type') || input.type).toLowerCase();
                if (type === 'hidden') return false;
                if (preferPassword && type === 'password') return true;

                const haystack = normalizeText([
                    input.getAttribute?.('aria-label') || '',
                    input.getAttribute?.('placeholder') || '',
                    input.getAttribute?.('name') || '',
                    input.getAttribute?.('id') || ''
                ].join(' ')).toLowerCase();

                return normalizedHints.every((hint) => haystack.includes(hint));
            });

            return candidates[0] || null;
        };

        const findSectionHeading = (sectionTitle, root = document) => {
            const normalizedTitle = normalizeText(sectionTitle).toLowerCase();
            const candidates = Array.from(root.querySelectorAll('h1, h2, h3, h4, h5, h6, legend, strong, [role="heading"], div, span, p'))
                .map((element) => ({
                    element,
                    text: getHeadingText(element).toLowerCase()
                }))
                .filter(({ text }) => text === normalizedTitle)
                .sort((a, b) => a.text.length - b.text.length || a.element.textContent.length - b.element.textContent.length);

            return candidates[0]?.element || null;
        };

        const getContainedSectionTitles = (root) => {
            return new Set(
                Array.from(root.querySelectorAll('h1, h2, h3, h4, h5, h6, legend, strong, [role="heading"], div, span, p'))
                    .map((element) => getHeadingText(element).toLowerCase())
                    .filter((text) => SECTION_TITLE_SET.has(text))
            );
        };

        const findSectionContainer = (sectionTitle, root = document) => {
            const normalizedTitle = normalizeText(sectionTitle).toLowerCase();
            const heading = findSectionHeading(sectionTitle, root);
            if (!heading) return null;

            let fallback = null;
            let current = heading;
            for (let depth = 0; depth < 8 && current; depth += 1) {
                const parent = current.parentElement;
                if (!parent) break;
                const inputCount = parent.querySelectorAll('input, select, textarea').length;
                if (!fallback && inputCount >= 2) {
                    fallback = parent;
                }

                const containedSectionTitles = getContainedSectionTitles(parent);
                if (inputCount >= 2 && containedSectionTitles.size === 1 && containedSectionTitles.has(normalizedTitle)) {
                    return parent;
                }

                current = parent;
            }

            return fallback;
        };

        const getFieldValue = (field) => {
            if (!(field instanceof Element)) return '';
            const propertyValue = typeof field.value === 'string' ? field.value : '';
            const attributeValue = typeof field.getAttribute === 'function' ? field.getAttribute('value') || '' : '';
            return normalizeText(propertyValue || attributeValue || '');
        };

        const findFirstInputByType = (root, allowedTypes) => {
            if (!(root instanceof Element || root instanceof Document)) return null;
            const normalizedTypes = new Set(allowedTypes.map((type) => normalizeText(type).toLowerCase()));
            return Array.from(root.querySelectorAll('input')).find((input) => {
                const inputType = normalizeText(input.getAttribute('type') || input.type || 'text').toLowerCase();
                return normalizedTypes.has(inputType);
            }) || null;
        };

        const findFieldByConfig = (section, config = {}) => {
            const labelPatterns = Array.isArray(config.labelPatterns) ? config.labelPatterns : [];
            for (const pattern of labelPatterns) {
                const field = findFieldByLabel(pattern, section, { type: config.type });
                if (field) return field;
            }

            const hintSets = Array.isArray(config.hints) ? config.hints : [];
            for (const hints of hintSets) {
                const field = findInputByHints(hints, section, { preferPassword: config.preferPassword });
                if (field) return field;
            }

            const allowedTypes = Array.isArray(config.allowedTypes) ? config.allowedTypes : [];
            if (allowedTypes.length > 0) {
                return findFirstInputByType(section, allowedTypes);
            }

            return null;
        };

        const readSectionFields = (doc, sectionTitle, fieldConfigs) => {
            const section = findSectionContainer(sectionTitle, doc);
            if (!section) {
                return Object.fromEntries(fieldConfigs.map((config) => [config.key, '']));
            }

            return Object.fromEntries(fieldConfigs.map((config) => {
                const field = findFieldByConfig(section, config);
                return [config.key, getFieldValue(field)];
            }));
        };

        try {
            const response = await fetch(`/admin_panel/practices/${encodeURIComponent(targetOds)}`, {
                credentials: 'include',
                cache: 'no-store'
            });
            if (!response.ok) return createEmptyDetails();

            const html = await response.text();
            const doc = new DOMParser().parseFromString(html, 'text/html');
            const cdbInput = doc.getElementById('ehr_settings[practice_cdb]') ||
                doc.querySelector("input[name='ehr_settings[practice_cdb]']");
            const emisApi = readSectionFields(doc, 'EMIS API Settings', [
                {
                    key: 'username',
                    labelPatterns: [/username/i],
                    hints: [['username'], ['user', 'name']],
                    allowedTypes: ['text', 'email']
                },
                {
                    key: 'password',
                    labelPatterns: [/password/i],
                    hints: [['password']],
                    type: 'password',
                    preferPassword: true,
                    allowedTypes: ['password']
                }
            ]);
            const emisWeb = readSectionFields(doc, 'EMIS Web Settings', [
                {
                    key: 'username',
                    labelPatterns: [/username/i],
                    hints: [['username'], ['user', 'name']],
                    allowedTypes: ['text', 'email']
                },
                {
                    key: 'password',
                    labelPatterns: [/password/i],
                    hints: [['password']],
                    type: 'password',
                    preferPassword: true,
                    allowedTypes: ['password']
                },
                {
                    key: 'dummyNhsNumber',
                    labelPatterns: [/dummy\s*nhs\s*number/i],
                    hints: [['dummy', 'nhs'], ['nhs', 'number']],
                    allowedTypes: ['text', 'number']
                }
            ]);
            const docman = readSectionFields(doc, 'Docman Settings', [
                {
                    key: 'username',
                    labelPatterns: [/username/i],
                    hints: [['username'], ['user', 'name']],
                    allowedTypes: ['text', 'email']
                },
                {
                    key: 'password',
                    labelPatterns: [/password/i],
                    hints: [['password']],
                    type: 'password',
                    preferPassword: true,
                    allowedTypes: ['password']
                },
                {
                    key: 'dummyNhsNumber',
                    labelPatterns: [/dummy\s*nhs\s*number/i],
                    hints: [['dummy', 'nhs'], ['nhs', 'number']],
                    allowedTypes: ['text', 'number']
                },
                {
                    key: 'inputFolder',
                    labelPatterns: [/input\s*folder/i],
                    hints: [['input', 'folder']],
                    allowedTypes: ['text']
                },
                {
                    key: 'processingFolder',
                    labelPatterns: [/processing\s*folder/i],
                    hints: [['processing', 'folder']],
                    allowedTypes: ['text']
                },
                {
                    key: 'filingFolder',
                    labelPatterns: [/filing\s*folder/i],
                    hints: [['filing', 'folder']],
                    allowedTypes: ['text']
                },
                {
                    key: 'rejectedFolder',
                    labelPatterns: [/rejected\s*folder/i],
                    hints: [['rejected', 'folder']],
                    allowedTypes: ['text']
                }
            ]);

            return {
                practiceCdb: getFieldValue(cdbInput),
                emisApiUsername: emisApi.username,
                emisApiPassword: emisApi.password,
                emisApiPasswordPresent: Boolean(emisApi.password),
                emisWebUsername: emisWeb.username,
                emisWebPassword: emisWeb.password,
                emisWebPasswordPresent: Boolean(emisWeb.password),
                emisWebDummyNhsNumber: emisWeb.dummyNhsNumber,
                docmanUsername: docman.username,
                docmanPassword: docman.password,
                docmanPasswordPresent: Boolean(docman.password),
                docmanDummyNhsNumber: docman.dummyNhsNumber,
                docmanInputFolder: docman.inputFolder,
                docmanProcessingFolder: docman.processingFolder,
                docmanFilingFolder: docman.filingFolder,
                docmanRejectedFolder: docman.rejectedFolder
            };
        } catch (e) {
            return createEmptyDetails();
        }
    }, [normalizedOds], preferredTabId)
        .then((detailsFromSessionFetch) => {
            const details = detailsFromSessionFetch && typeof detailsFromSessionFetch === 'object'
                ? { ...createEmptyPracticeEhrSettings(), ...detailsFromSessionFetch }
                : createEmptyPracticeEhrSettings();
            setCachedPracticeEhrSettings(normalizedOds, details, 'session-fetch');
            return details;
        })
        .catch(() => createEmptyPracticeEhrSettings())
        .finally(() => {
            practiceEhrSettingsResolveInFlightByOds.delete(normalizedOds);
        });

    practiceEhrSettingsResolveInFlightByOds.set(normalizedOds, promise);
    return promise;
}

async function fetchPracticeCdbByOds(odsCode, preferredTabId = null) {
    const details = await fetchPracticeEhrSettingsByOds(odsCode, preferredTabId);
    return String(details?.practiceCdb || '').trim();
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

                await wait(150);
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

    const countsFromSql = await fetchPracticeLiveCountsFromSql(normalizedOds);
    if (countsFromSql && hasCompleteLiveCounts(countsFromSql)) {
        setCachedLiveCounts(normalizedOds, countsFromSql, 'cloud-sql');
        return {
            preparing: normalizeLetterCountValue(countsFromSql.preparing),
            edit: normalizeLetterCountValue(countsFromSql.edit),
            review: normalizeLetterCountValue(countsFromSql.review),
            coding: normalizeLetterCountValue(countsFromSql.coding),
            rejected: normalizeLetterCountValue(countsFromSql.rejected),
            fetchedAt: Date.now()
        };
    }

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

async function hydrateMissingCdbs(limit = 25, preferredTabId = null) {
    await ensureCacheLoaded(preferredTabId);

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
        const cdb = await fetchPracticeCdbByOds(practice.ods, preferredTabId);
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

async function scrapePracticeListViaSessionTab(preferredTabId = null) {
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
    }, [], preferredTabId);

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

async function fetchAndCachePracticeList(purpose = 'background refresh', preferredTabId = null) {
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
            let practicesArray = await scrapePracticeListViaSessionTab(preferredTabId);

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
            hydrateMissingCdbs(15, preferredTabId).catch(() => undefined);

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

async function ensureCacheLoaded(preferredTabId = null) {
    if (Object.keys(practiceCache).length > 0) return;

    const result = await loadCacheFromStorage();
    if (result.practiceCache && Object.keys(result.practiceCache).length > 0) {
        practiceCache = result.practiceCache;

        // Do not block UI on cold start if cache is stale; refresh in background.
        if (!result.cacheTimestamp || (Date.now() - result.cacheTimestamp >= CACHE_EXPIRY)) {
            fetchAndCachePracticeList('stale-cache-refresh', preferredTabId).catch(() => undefined);
        }
        return;
    }

    // Truly no cache available, fetch now.
    await fetchAndCachePracticeList('initial-load', preferredTabId);
}

async function findExistingPanelPopupWindow() {
    const panelUrlPrefix = chrome.runtime.getURL('panel.html');
    const windows = await chrome.windows.getAll({ populate: true, windowTypes: ['popup'] });
    for (const win of windows) {
        const hasPanelTab = win.tabs?.some((tab) => tab.url && tab.url.startsWith(panelUrlPrefix));
        if (hasPanelTab) return win;
    }
    return null;
}

async function openPanelPopup(hostTabId = null) {
    const existing = await findExistingPanelPopupWindow();
    if (existing) {
        await chrome.windows.update(existing.id, { focused: true, drawAttention: true });
        // Reusing an existing window just refocuses it (no reload), so it
        // won't re-check the saved compact-mode preference on its own; tell
        // it to sync explicitly so clicking the icon always reflects that
        // preference, not just whatever state this window was left in.
        const panelUrlPrefix = chrome.runtime.getURL('panel.html');
        const panelTab = existing.tabs?.find((tab) => tab.url && tab.url.startsWith(panelUrlPrefix));
        if (panelTab?.id) {
            chrome.tabs.sendMessage(panelTab.id, { type: 'BL_SYNC_COMPACT_MODE' }).catch(() => undefined);
        }
        return;
    }

    const url = new URL(chrome.runtime.getURL('panel.html'));
    if (typeof hostTabId === 'number' && Number.isFinite(hostTabId)) {
        url.searchParams.set('hostTabId', String(hostTabId));
    }
    await chrome.windows.create({
        url: url.toString(),
        type: 'popup',
        width: 330,
        height: 750,
        focused: true
    });
}

async function ensureSidebarPanelMounted(tabId, { forceCollapsed = true } = {}) {
    const isDarkModeEnabled = await getStoredDarkModePreference();
    await chrome.scripting.executeScript({
        target: { tabId },
        func: (panelUrl, hostTabId, shouldForceCollapsed, storedIsDark) => {
            // storedIsDark is null when the user hasn't explicitly chosen a
            // mode yet - fall back to the OS/Chrome theme so a fresh install
            // (or a browser already running in dark mode) starts out dark
            // without requiring a manual toggle first.
            const isDark = typeof storedIsDark === 'boolean'
                ? storedIsDark
                : Boolean(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
            // Independent docked panels, one per view, each with its own
            // toggle handle stacked along the right edge. Opening one
            // doesn't require opening a shared container first, and
            // expanding one auto-collapses the others so their (identically
            // positioned, full-height) content areas never end up stacked
            // on top of each other.
            const VIEWS = [
                { key: 'navigator', view: 'practiceNavigatorView', label: 'Navigator', color: '#3b82f6' },
                { key: 'jobmanager', view: 'jobManagerView', label: 'Job Panel', color: '#10b981' },
                { key: 'others', view: 'emailFormatterView', label: 'Others', color: '#9b59b6' },
                // UUID Picker is used often enough on its own to warrant a
                // dedicated handle that opens straight to it (?tool= tells
                // panel.js to trigger that tool's modal immediately instead
                // of showing the launch grid). Custom Workflow/Docman
                // Groups/Email Formatter share one handle and its launch
                // grid instead, since splitting all four out separately
                // wasn't worth 4 handles for tools used less often.
                { key: 'uuidpicker', view: 'bookmarkletToolsView', tool: 'uuidPicker', label: 'UUID Picker', color: '#d97706' },
                { key: 'bookmarklettools', view: 'bookmarkletToolsView', label: 'Bookmarklet Tools', color: '#708238' }
            ];
            const STYLE_ID = 'bl-allinone-sidebar-style';
            const DOCK_ID = 'bl-allinone-sidebar-dock';
            const RAIL_ID = 'bl-allinone-sidebar-handle-rail';
            const PANEL_WIDTH = 360;
            const HANDLE_WIDTH = 28;
            const PENDING_KEY = '__BL_SIDEBAR_MOUNT_PENDING__';
            const ORDER_STORAGE_KEY = '__BL_MAILROOM_NAVIGATOR_SIDEBAR_ORDER__';
            // Bump this whenever this injected UI's DOM/CSS structure
            // changes. mountOne/ensureRailMounted/ensureStyleInjected all
            // skip rebuilding anything that already has the expected id, so
            // a host tab left open (not hard-refreshed) across an extension
            // code change would otherwise keep running whatever markup an
            // older version of this script left behind - e.g. old handles
            // positioned relative to their own panel next to a new panel
            // that assumes an independent rail, producing a stray gap
            // between them. Bumping this forces a clean rebuild instead.
            const UI_VERSION = '19';
            const VERSION_ATTR = 'data-bl-sidebar-ui-version';

            const rootIdFor = (key) => `bl-allinone-sidebar-panel-${key}`;
            const getViewByKey = (key) => VIEWS.find((viewConfig) => viewConfig.key === key) || null;
            const getOrderedViews = () => {
                let storedKeys = [];
                try {
                    const parsed = JSON.parse(window.localStorage.getItem(ORDER_STORAGE_KEY) || '[]');
                    if (Array.isArray(parsed)) storedKeys = parsed.map((key) => String(key || '').trim()).filter(Boolean);
                } catch {
                    storedKeys = [];
                }
                const knownKeys = new Set(VIEWS.map(({ key }) => key));
                const orderedKeys = [
                    ...storedKeys.filter((key, index, list) => knownKeys.has(key) && list.indexOf(key) === index),
                    ...VIEWS.map(({ key }) => key).filter((key) => !storedKeys.includes(key))
                ];
                return orderedKeys.map(getViewByKey).filter(Boolean);
            };
            const persistRailOrder = (rail) => {
                if (!rail) return;
                const keys = Array.from(rail.querySelectorAll('.bl-sidebar-toggle'))
                    .map((button) => button.dataset.key)
                    .filter(Boolean);
                try {
                    window.localStorage.setItem(ORDER_STORAGE_KEY, JSON.stringify(keys));
                } catch {
                    // Drag order is UI polish; ignore storage failures.
                }
            };
            const buildExpectedSrc = (view, tool) => {
                const url = new URL(panelUrl);
                url.searchParams.set('hostTabId', String(hostTabId || ''));
                url.searchParams.set('view', view);
                url.searchParams.set('sidebarUiVersion', UI_VERSION);
                if (tool) url.searchParams.set('tool', tool);
                return url.toString();
            };
            const ensureIframeLoaded = (iframeEl, view, tool) => {
                if (!iframeEl) return;
                const expectedSrc = buildExpectedSrc(view, tool);
                if (iframeEl.dataset.loadedSrc === expectedSrc && iframeEl.src === expectedSrc) return;
                iframeEl.src = expectedSrc;
                iframeEl.dataset.loadedSrc = expectedSrc;
            };
            const collapseAllExcept = (keepKey) => {
                getOrderedViews().forEach(({ key }) => {
                    if (key === keepKey) return;
                    const otherPanel = document.getElementById(rootIdFor(key));
                    if (otherPanel) otherPanel.classList.add('collapsed');
                });
            };
            const syncRailState = () => {
                const rail = document.getElementById(RAIL_ID);
                if (!rail) return;
                getOrderedViews().forEach(({ key }) => {
                    const panelEl = document.getElementById(rootIdFor(key));
                    const isOpen = Boolean(panelEl && !panelEl.classList.contains('collapsed'));
                    const button = rail.querySelector(`[data-key="${key}"]`);
                    if (button) button.classList.toggle('is-open', isOpen);
                });
            };
            const collapseAllPanels = () => {
                getOrderedViews().forEach(({ key }) => {
                    const panelEl = document.getElementById(rootIdFor(key));
                    if (panelEl) panelEl.classList.add('collapsed');
                });
                syncRailState();
            };
            const spawnRipple = (button, event) => {
                const rect = button.getBoundingClientRect();
                const size = Math.max(rect.width, rect.height) * 2.4;
                const ripple = document.createElement('span');
                ripple.className = 'bl-sidebar-toggle-ripple';
                ripple.style.width = `${size}px`;
                ripple.style.height = `${size}px`;
                const originX = (typeof event?.clientX === 'number' ? event.clientX : rect.left + rect.width / 2) - rect.left - size / 2;
                const originY = (typeof event?.clientY === 'number' ? event.clientY : rect.top + rect.height / 2) - rect.top - size / 2;
                ripple.style.left = `${originX}px`;
                ripple.style.top = `${originY}px`;
                button.appendChild(ripple);
                ripple.addEventListener('animationend', () => ripple.remove(), { once: true });
            };

            const ensureStyleInjected = () => {
                const EASE = 'cubic-bezier(0.4, 0.0, 0.2, 1)';
                const SPRING = 'cubic-bezier(0.34, 1.56, 0.64, 1)';
                const css = `
                        /* The rail and every panel are flex children of one
                           shared, position: fixed dock pinned to the
                           viewport's right edge (no explicit width, so it
                           shrink-wraps its content). This is deliberate:
                           earlier versions positioned the rail with a
                           manually computed "right" offset assuming each
                           panel was exactly PANEL_WIDTH wide, which could
                           drift out of sync with the panel's real rendered
                           position and leave a gap with host-page content
                           showing through it. Flexbox lays the rail out
                           immediately adjacent to whatever the panels'
                           real total width actually is, with zero
                           arithmetic and no way for the two to disagree. */
                        #${DOCK_ID} {
                            position: fixed;
                            top: 0;
                            right: 0;
                            height: 100vh;
                            z-index: 2147483647;
                            display: flex !important;
                            flex-direction: row;
                            align-items: stretch;
                            pointer-events: none;
                            visibility: visible !important;
                            opacity: 1 !important;
                        }

                        .bl-allinone-sidebar-root {
                            position: relative;
                            flex: 0 0 auto;
                            width: 0;
                            height: 100%;
                            overflow: hidden;
                            background: #f7f8fb;
                            border-left: 0 solid rgba(15, 23, 42, 0.16);
                            box-shadow: none;
                            transition: width 0.28s ${EASE}, border-left-width 0.28s ${EASE}, box-shadow 0.28s ${EASE};
                            pointer-events: auto;
                            z-index: 1;
                        }

                        .bl-allinone-sidebar-root:not(.collapsed) {
                            width: ${PANEL_WIDTH}px;
                            border-left-width: 1px;
                            box-shadow: -2px 0 4px rgba(15, 23, 42, 0.12), -12px 0 32px rgba(15, 23, 42, 0.2);
                        }

                        .bl-allinone-sidebar-root iframe {
                            /* Fixed at the full panel width regardless of the
                               wrapper's current (possibly mid-transition)
                               width, so the iframe document never reflows
                               during the slide - the wrapper's overflow:
                               hidden simply reveals more or less of it. */
                            width: ${PANEL_WIDTH}px;
                            height: 100%;
                            border: 0;
                            display: block;
                            background: #f7f8fb;
                        }

                        .bl-allinone-handle-rail {
                            position: relative;
                            flex: 0 0 auto;
                            height: 100%;
                            display: flex;
                            flex-direction: column;
                            gap: 8px;
                            padding-top: 24px;
                            pointer-events: none;
                            z-index: 2;
                        }

                        .bl-sidebar-toggle {
                            position: relative;
                            overflow: hidden;
                            pointer-events: auto;
                            width: ${HANDLE_WIDTH}px;
                            min-height: 64px;
                            box-sizing: border-box;
                            border: 1px solid rgba(15, 23, 42, 0.16);
                            border-right: none;
                            border-radius: 10px 0 0 10px;
                            background: #ffffff;
                            color: var(--tab-color, #1f2937);
                            cursor: pointer;
                            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
                            font-size: 11px;
                            font-weight: 700;
                            letter-spacing: 0.03em;
                            line-height: 1;
                            padding: 10px 0;
                            display: flex;
                            align-items: center;
                            justify-content: center;
                            box-shadow: 0 1px 2px rgba(15, 23, 42, 0.1);
                            transition: background-color 0.2s ${EASE}, color 0.2s ${EASE},
                                        border-color 0.2s ${EASE}, box-shadow 0.2s ${EASE},
                                        transform 0.2s ${EASE};
                        }

                        .bl-sidebar-toggle::after {
                            content: '';
                            position: absolute;
                            top: -1px;
                            bottom: -1px;
                            right: 0;
                            width: 0;
                            background: transparent;
                            pointer-events: none;
                        }

                        .bl-sidebar-collapse-toggle {
                            min-height: 40px;
                            color: #475569;
                            margin-bottom: 8px;
                        }

                        .bl-sidebar-toggle.is-dragging {
                            opacity: 0.42;
                            transform: translateX(4px) scale(0.98);
                        }

                        .bl-sidebar-toggle.is-drag-over {
                            outline: 2px solid color-mix(in srgb, var(--tab-color, #1f2937) 65%, white);
                            outline-offset: 2px;
                        }

                        /* Rotating just the label (not the whole button) so
                           the button's own box - rounded corners, borders,
                           ripple - stays unaffected. vertical-rl + a 180deg
                           flip reads the opposite way of plain vertical-rl
                           (bottom-to-top instead of top-to-bottom) without
                           relying on sideways-lr, which has patchier
                           support. */
                        .bl-sidebar-toggle-label {
                            writing-mode: vertical-rl;
                            text-orientation: mixed;
                            transform: rotate(180deg);
                        }

                        .bl-sidebar-toggle:hover:not(.is-open) {
                            background: color-mix(in srgb, var(--tab-color, #1f2937) 12%, white);
                            transform: translateX(2px);
                            box-shadow: 0 2px 8px rgba(15, 23, 42, 0.16);
                        }

                        .bl-sidebar-toggle:active {
                            transform: translateX(1px) scale(0.97);
                        }

                        .bl-sidebar-toggle.is-open {
                            background: var(--tab-color, #1f2937) !important;
                            border-color: var(--tab-color, #1f2937) !important;
                            color: #ffffff !important;
                            border-right: none !important;
                            border-radius: 10px 0 0 10px !important;
                            width: ${HANDLE_WIDTH}px !important;
                            margin-right: 0 !important;
                            box-shadow: 0 2px 8px rgba(15, 23, 42, 0.18) !important;
                            transform: none !important;
                            overflow: hidden !important;
                            z-index: 3;
                            animation: none !important;
                        }

                        .bl-sidebar-toggle.is-open::after {
                            width: 0;
                            background: transparent;
                        }

                        .bl-sidebar-toggle.is-open:hover {
                            background: var(--tab-color, #1f2937);
                        }

                        @keyframes bl-sidebar-tab-pop {
                            0% { transform: translateX(0) scale(1); }
                            55% { transform: translateX(0) scale(1.03); }
                            100% { transform: translateX(0) scale(1); }
                        }

                        .bl-sidebar-toggle-ripple {
                            position: absolute;
                            border-radius: 50%;
                            background: rgba(15, 23, 42, 0.18);
                            transform: scale(0);
                            animation: bl-sidebar-ripple 0.5s ${EASE};
                            pointer-events: none;
                        }

                        .bl-sidebar-toggle.is-open .bl-sidebar-toggle-ripple {
                            background: rgba(255, 255, 255, 0.45);
                        }

                        @keyframes bl-sidebar-ripple {
                            to { transform: scale(1); opacity: 0; }
                        }

                        /* Dark mode: this rail lives in the host page's own
                           document, entirely separate from panel.html's
                           <body> (a different document inside each panel's
                           iframe), so panel.html's dark-mode filter can't
                           reach it - it needs its own explicit dark
                           styling, toggled via the .bl-dark class on the
                           dock (see ensureDockMounted/handleSetDarkModePreference).
                           The .is-open state already uses a solid
                           var(--tab-color) fill regardless of theme, so
                           only the plain white resting state needs a dark
                           variant. */
                        #${DOCK_ID}.bl-dark .bl-sidebar-toggle {
                            background: #1f2937;
                            border-color: rgba(255, 255, 255, 0.16);
                            box-shadow: 0 1px 2px rgba(0, 0, 0, 0.4);
                        }

                        #${DOCK_ID}.bl-dark .bl-sidebar-toggle:hover:not(.is-open) {
                            background: color-mix(in srgb, var(--tab-color, #1f2937) 28%, #1f2937);
                        }

                        #${DOCK_ID}.bl-dark .bl-sidebar-toggle .bl-sidebar-toggle-ripple {
                            background: rgba(255, 255, 255, 0.22);
                        }
                    `;
                // Always refresh the stylesheet's content, even if the tag
                // already exists from an earlier injection - a host tab
                // left open across a code change would otherwise keep
                // running whatever CSS an older version of this script
                // last wrote here. Rewriting a <style> tag's text is cheap
                // and has no listeners/state to lose, unlike the DOM
                // elements below which are genuinely only built once.
                let styleEl = document.getElementById(STYLE_ID);
                if (!styleEl) {
                    styleEl = document.createElement('style');
                    styleEl.id = STYLE_ID;
                    document.documentElement.appendChild(styleEl);
                }
                styleEl.textContent = css;
            };

            const ensureDockMounted = () => {
                let dock = document.getElementById(DOCK_ID);
                if (!dock) {
                    dock = document.createElement('div');
                    dock.id = DOCK_ID;
                    (document.body || document.documentElement).appendChild(dock);
                }
                dock.classList.toggle('bl-dark', Boolean(isDark));
                return dock;
            };

            const mountOne = ({ key, view, tool, label }) => {
                const rootId = rootIdFor(key);
                const existingPanel = document.getElementById(rootId);
                if (existingPanel) {
                    const existingIframe = existingPanel.querySelector('iframe');
                    if (shouldForceCollapsed) {
                        existingPanel.classList.add('collapsed');
                    } else {
                        existingPanel.classList.remove('collapsed');
                        ensureIframeLoaded(existingIframe, view, tool);
                    }
                    return;
                }

                const panelEl = document.createElement('div');
                panelEl.id = rootId;
                panelEl.className = 'bl-allinone-sidebar-root';
                if (shouldForceCollapsed) {
                    panelEl.classList.add('collapsed');
                }

                const iframe = document.createElement('iframe');
                iframe.title = `BetterLetter Panel - ${label}`;
                iframe.allow = 'clipboard-write';
                iframe.dataset.pendingSrc = buildExpectedSrc(view, tool);
                if (!shouldForceCollapsed) {
                    ensureIframeLoaded(iframe, view, tool);
                }

                panelEl.append(iframe);
                ensureDockMounted().appendChild(panelEl);
            };

            const ensureRailMounted = () => {
                if (document.getElementById(RAIL_ID)) return;

                const rail = document.createElement('div');
                rail.id = RAIL_ID;
                rail.className = 'bl-allinone-handle-rail';
                let draggedKey = '';
                let suppressNextClick = false;

                const collapseButton = document.createElement('button');
                collapseButton.type = 'button';
                collapseButton.className = 'bl-sidebar-toggle bl-sidebar-collapse-toggle';
                collapseButton.dataset.role = 'collapse';
                collapseButton.style.setProperty('--tab-color', '#64748b');
                collapseButton.title = 'Collapse panel';
                collapseButton.setAttribute('aria-label', 'Collapse panel');
                collapseButton.innerHTML = '<span class="bl-sidebar-toggle-label">Close</span>';
                collapseButton.addEventListener('click', (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    spawnRipple(collapseButton, event);
                    collapseAllPanels();
                });
                rail.appendChild(collapseButton);

                getOrderedViews().forEach(({ key, view, tool, label, color }) => {
                    const toggleButton = document.createElement('button');
                    toggleButton.type = 'button';
                    toggleButton.className = 'bl-sidebar-toggle';
                    toggleButton.draggable = true;
                    toggleButton.dataset.role = 'toggle';
                    toggleButton.dataset.key = key;
                    toggleButton.style.setProperty('--tab-color', color);
                    toggleButton.title = label;
                    toggleButton.setAttribute('aria-label', label);

                    const labelSpan = document.createElement('span');
                    labelSpan.className = 'bl-sidebar-toggle-label';
                    labelSpan.textContent = label;
                    toggleButton.appendChild(labelSpan);

                    toggleButton.addEventListener('click', (event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        if (suppressNextClick) {
                            suppressNextClick = false;
                            return;
                        }
                        spawnRipple(toggleButton, event);
                        const panelEl = document.getElementById(rootIdFor(key));
                        if (!panelEl) return;
                        const willExpand = panelEl.classList.contains('collapsed');
                        panelEl.classList.toggle('collapsed');
                        if (willExpand) {
                            ensureIframeLoaded(panelEl.querySelector('iframe'), view, tool);
                            collapseAllExcept(key);
                        }
                        syncRailState();
                    });

                    toggleButton.addEventListener('dragstart', (event) => {
                        draggedKey = key;
                        toggleButton.classList.add('is-dragging');
                        event.dataTransfer.effectAllowed = 'move';
                        event.dataTransfer.setData('text/plain', key);
                    });

                    toggleButton.addEventListener('dragover', (event) => {
                        if (!draggedKey || draggedKey === key) return;
                        event.preventDefault();
                        suppressNextClick = true;
                        event.dataTransfer.dropEffect = 'move';
                        const draggedButton = rail.querySelector(`[data-key="${draggedKey}"]`);
                        if (!draggedButton) return;
                        const rect = toggleButton.getBoundingClientRect();
                        const insertAfter = event.clientY > rect.top + rect.height / 2;
                        rail.insertBefore(draggedButton, insertAfter ? toggleButton.nextSibling : toggleButton);
                        toggleButton.classList.add('is-drag-over');
                    });

                    toggleButton.addEventListener('dragleave', () => {
                        toggleButton.classList.remove('is-drag-over');
                    });

                    toggleButton.addEventListener('drop', (event) => {
                        if (!draggedKey) return;
                        event.preventDefault();
                        suppressNextClick = true;
                        persistRailOrder(rail);
                        syncRailState();
                    });

                    toggleButton.addEventListener('dragend', () => {
                        draggedKey = '';
                        rail.querySelectorAll('.bl-sidebar-toggle').forEach((button) => {
                            button.classList.remove('is-dragging', 'is-drag-over');
                        });
                        persistRailOrder(rail);
                        syncRailState();
                        if (suppressNextClick) {
                            window.setTimeout(() => {
                                suppressNextClick = false;
                            }, 250);
                        }
                    });

                    rail.appendChild(toggleButton);
                });

                ensureDockMounted().appendChild(rail);
            };

            const cleanupStaleUi = () => {
                if (!document.documentElement) return;
                if (document.documentElement.getAttribute(VERSION_ATTR) === UI_VERSION) return;
                document.getElementById(STYLE_ID)?.remove();
                // Removing the dock takes the rail and every panel with it
                // (they're all its children); the individual lookups below
                // exist only to catch stray leftovers from older versions
                // that appended those elements directly to <body> instead.
                document.getElementById(DOCK_ID)?.remove();
                document.getElementById(RAIL_ID)?.remove();
                VIEWS.forEach(({ key }) => document.getElementById(rootIdFor(key))?.remove());
                document.getElementById('bl-allinone-sidebar-panel')?.remove();
                document.documentElement.setAttribute(VERSION_ATTR, UI_VERSION);
            };

            const mountSidebar = () => {
                if (!document.documentElement) return;
                cleanupStaleUi();
                ensureStyleInjected();
                ensureRailMounted();
                getOrderedViews().forEach(mountOne);
                syncRailState();
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
        args: [chrome.runtime.getURL('panel.html'), tabId, Boolean(forceCollapsed), isDarkModeEnabled]
    });
}

async function ensureSidebarHandleForTab(tabId, { forceCollapsed = true } = {}) {
    if (typeof tabId !== 'number') return;
    try {
        const tab = await chrome.tabs.get(tabId);
        if (!isScriptableUrl(getTabUrl(tab))) return;
        await ensureSidebarPanelMounted(tabId, { forceCollapsed });
    } catch (e) {
        // Ignore tabs that are gone/restricted or not scriptable yet.
    }
}

// Kept in sync with DARK_MODE_STORAGE_KEY in panel.js - both sides read/
// write the same chrome.storage.local key so the popup window and every
// docked handle's rail agree on the current preference.
const DARK_MODE_STORAGE_KEY = 'mailroomNavigatorDarkMode';

// Returns true/false only once the user has explicitly chosen a mode via the
// toggle; null means no explicit choice has been made yet, in which case
// callers should fall back to the OS/Chrome theme (window.matchMedia
// '(prefers-color-scheme: dark)') instead of defaulting to light.
async function getStoredDarkModePreference() {
    try {
        const result = await chrome.storage.local.get(DARK_MODE_STORAGE_KEY);
        return typeof result?.[DARK_MODE_STORAGE_KEY] === 'boolean' ? result[DARK_MODE_STORAGE_KEY] : null;
    } catch (error) {
        return null;
    }
}

async function applyDarkModeToHostRail(tabId, isDark) {
    if (typeof tabId !== 'number') return;
    try {
        await chrome.scripting.executeScript({
            target: { tabId },
            func: (dark) => {
                document.getElementById('bl-allinone-sidebar-dock')?.classList.toggle('bl-dark', Boolean(dark));
            },
            args: [Boolean(isDark)]
        });
    } catch (error) {
        // Tab may be gone/restricted, or the rail may not be mounted there
        // at all - safe to ignore either way, since this runs against every
        // open tab (see handleSetDarkModePreference) rather than one known
        // host tab.
    }
}

async function handleSetDarkModePreference(payload = {}) {
    const isDark = Boolean(payload?.isDark);
    // A system-theme-driven change (persist === false) restyles every open
    // panel/rail immediately without locking in an explicit preference, so
    // the extension keeps following the OS/Chrome theme until the user
    // actually clicks the toggle themselves.
    if (payload?.persist !== false) {
        try {
            await chrome.storage.local.set({ [DARK_MODE_STORAGE_KEY]: isDark });
        } catch (error) {
            // Ignore storage errors; the toggle already reflects the new state
            // in the panel that triggered it.
        }
    }
    // Dark mode is a single global preference, not per-tab, so restyle the
    // docked rail on every open tab - not just whichever one triggered this -
    // the same way every other panel.html instance already syncs itself via
    // its own runtime.onMessage listener.
    try {
        const tabs = await chrome.tabs.query({});
        await Promise.all(tabs.map((tab) => applyDarkModeToHostRail(tab.id, isDark)));
    } catch (error) {
        // Ignore; chrome.tabs.query failing here just means the rails will
        // pick up the new preference next time each tab is activated.
    }
    return { success: true };
}

// --- 4. LISTENERS ---

chrome.action.onClicked.addListener(async (tab) => {
    await setTargetTabId(tab?.id);
    await openPanelPopup(tab?.id);
    maybeTriggerMorningDashboardAlert(tab?.id, getTabUrl(tab), 'action_click').catch(() => undefined);
});

chrome.tabs.onActivated.addListener((activeInfo) => {
    const tabId = activeInfo?.tabId;
    setTargetTabId(tabId).catch(() => undefined);
    chrome.tabs.get(tabId)
        .then((tab) => {
            const tabUrl = getTabUrl(tab);
            if (isScriptableUrl(tabUrl)) {
                ensureSidebarHandleForTab(tabId, { forceCollapsed: true }).catch(() => undefined);
            }
            return maybeTriggerMorningDashboardAlert(tabId, tabUrl, 'tab_activated');
        })
        .catch(() => undefined);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (!changeInfo?.url && changeInfo?.status !== 'complete') return;
    const maybeUrl = typeof changeInfo?.url === 'string' ? changeInfo.url : getTabUrl(tab);
    if (!isScriptableUrl(maybeUrl)) return;
    if (isBetterLetterUrl(maybeUrl)) {
        chrome.storage.local.set({ targetTabId: tabId }).catch(() => undefined);
    }
    if (changeInfo?.status === 'complete') {
        ensureSidebarHandleForTab(tabId, { forceCollapsed: true }).catch(() => undefined);
    }
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
        if (message.action === 'setDarkModePreference') {
            return await handleSetDarkModePreference(message.payload);
        }

        if (CACHE_REQUIRED_ACTIONS.has(message?.action)) {
            await ensureCacheLoaded(
                typeof message?.preferredTabId === 'number' ? message.preferredTabId : null
            );
        }

        if (message.action === 'getPracticeCache') {
            if (Object.keys(practiceCache).length === 0) {
                await loadCacheFromStorage();
            }
            return { practiceCache };
        }
        if (message.action === 'openUrlInNewTab') {
            const targetUrl = String(message.url || '').trim();
            if (!isAllowedExtensionTabUrl(targetUrl)) {
                return { success: false, error: 'Invalid URL for tab open.' };
            }
            const tabOptions = { url: targetUrl, active: true };
            if (typeof sender?.tab?.windowId === 'number') {
                tabOptions.windowId = sender.tab.windowId;
            }
            await chrome.tabs.create(tabOptions);
            return { success: true };
        }
        if (message.action === 'copyTextToClipboard') {
            const value = String(message.value ?? '');
            if (!value) return { success: false, error: 'Nothing to copy.' };
            await setupOffscreen();
            const result = await chrome.runtime.sendMessage({
                target: 'offscreen',
                action: 'copyTextToClipboard',
                value
            });
            return {
                success: Boolean(result?.success),
                error: result?.error || ''
            };
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
        if (message.action === 'restartLinearTriggerServer') {
            return await handleRestartLinearTriggerServer();
        }
        if (message.action === 'getLinearBotJobsTriggerStatus') {
            return await handleGetLinearBotJobsTriggerStatus();
        }
        if (message.action === 'getServerlessLiteMode') {
            return { success: true, serverlessLiteMode: isServerlessLiteModeEnabled() };
        }
        if (message.action === 'runDocmanToolAction') {
            return await handleRunDocmanToolAction(message.payload);
        }
        if (message.action === 'getDocmanToolRunStatus') {
            return await handleGetDocmanToolRunStatus();
        }
        if (message.action === 'lookupUuidStatus') {
            return await handleLookupUuidStatus(message.payload);
        }
        if (message.action === 'requestActiveScrape') {
            const data = await fetchAndCachePracticeList(
                'manual-refresh',
                typeof message?.preferredTabId === 'number' ? message.preferredTabId : null
            );
            return { success: true, practicesCount: (data || []).length };
        }
        if (message.action === 'getPracticeLiveCounts') {
            // Prefer Cloud SQL for live counts, then fall back to in-session page reads.
            const liveMailroomCounts = await resolveLiveMailroomCountsByOds(message.odsCode, { allowTempTab: false });
            return { success: true, liveMailroomCounts };
        }
        if (message.action === 'getPracticeSecret') {
            const secret = await getPracticeSecretValue(message.odsCode, message.field);
            if (!secret?.value) {
                return {
                    success: false,
                    error: secret?.present
                        ? 'Password is configured but could not be loaded.'
                        : 'Password is not configured.'
                };
            }
            return {
                success: true,
                field: secret.field,
                value: secret.value,
                source: secret.source || 'cloud-sql'
            };
        }
        if (message.action === 'getPracticeSecretHistory') {
            const history = await getPracticeSecretHistory(message.odsCode, message.field);
            return {
                success: true,
                field: sanitizeSingleLine(message.field, 80),
                count: history.length
            };
        }
        if (message.action === 'savePracticeSecretOverride') {
            try {
                const saved = await savePracticeSecretOverride(message.odsCode, message.field, message.value);
                return {
                    success: true,
                    field: saved.field,
                    value: saved.value,
                    source: 'browser'
                };
            } catch (error) {
                return {
                    success: false,
                    error: sanitizeSingleLine(error?.message, 240) || 'Password could not be saved.'
                };
            }
        }
        if (message.action === 'savePracticeSecretToAdminPanel') {
            try {
                const requestedValue = normalizePracticeSecretOverrideValue(message.value);
                const previousSecret = await getPracticeSecretValue(message.odsCode, message.field);
                if (previousSecret?.value && previousSecret.value === requestedValue) {
                    const history = await getPracticeSecretHistory(message.odsCode, message.field);
                    return {
                        success: true,
                        field: sanitizeSingleLine(message.field, 80),
                        value: requestedValue,
                        source: 'unchanged',
                        historyCount: history.length
                    };
                }

                const saved = await savePracticeSecretViaAdminPage({
                    odsCode: message.odsCode,
                    field: message.field,
                    value: requestedValue
                });
                const history = await rememberPracticeSecretHistoryEntry(
                    message.odsCode,
                    message.field,
                    previousSecret?.value,
                    {
                        source: previousSecret?.source || 'unknown',
                        excludeValue: saved.value
                    }
                );
                await savePracticeSecretOverride(message.odsCode, message.field, saved.value);
                return {
                    success: true,
                    field: saved.field,
                    value: saved.value,
                    source: 'admin-panel',
                    historyCount: history.length,
                    tabId: saved.tabId
                };
            } catch (error) {
                return {
                    success: false,
                    error: sanitizeSingleLine(error?.message, 240) || 'Password could not be saved in BetterLetter.'
                };
            }
        }
        if (message.action === 'undoPracticeSecretSave') {
            try {
                const history = await getPracticeSecretHistory(message.odsCode, message.field);
                const restoreEntry = history[0];
                const restoreValue = normalizePracticeSecretOverrideValue(restoreEntry?.value);
                if (!restoreValue) {
                    return {
                        success: false,
                        error: 'No saved password history for this field.'
                    };
                }

                const currentSecret = await getPracticeSecretValue(message.odsCode, message.field);
                let tabId = null;
                if (currentSecret?.value !== restoreValue) {
                    const restored = await savePracticeSecretViaAdminPage({
                        odsCode: message.odsCode,
                        field: message.field,
                        value: restoreValue
                    });
                    tabId = restored.tabId;
                }
                await savePracticeSecretOverride(message.odsCode, message.field, restoreValue);
                const remainingHistory = await savePracticeSecretHistory(
                    message.odsCode,
                    message.field,
                    history.slice(1)
                );
                return {
                    success: true,
                    field: sanitizeSingleLine(message.field, 80),
                    value: restoreValue,
                    source: 'history',
                    historyCount: remainingHistory.length,
                    tabId
                };
            } catch (error) {
                return {
                    success: false,
                    error: sanitizeSingleLine(error?.message, 240) || 'Password could not be restored.'
                };
            }
        }
        if (message.action === 'getPracticeStatus') {
            const normalizedOds = String(message.odsCode || '').trim().toUpperCase();
            let p = Object.values(practiceCache).find(x => x.ods === normalizedOds);
            const preferredTabId = typeof message?.preferredTabId === 'number' ? message.preferredTabId : null;
            const sqlPractice = /^[A-Z]\d{5}$/.test(normalizedOds)
                ? await fetchPracticeDetailsFromSql(normalizedOds)
                : null;
            if (sqlPractice) {
                p = {
                    ...(p || {}),
                    ...sqlPractice,
                    ods: sqlPractice.odsCode,
                    cdb: sqlPractice.practiceCDB || sqlPractice.cdb || '',
                    practiceCDB: sqlPractice.practiceCDB || sqlPractice.cdb || '',
                    timestamp: Date.now()
                };
                const cacheKey = `${p.name || p.displayName || p.ods} (${p.ods})`;
                practiceCache[cacheKey] = p;
                await chrome.storage.local.set({ practiceCache, cacheTimestamp: Date.now() });
            }

            // Live counts and EHR settings are independent lookups, so fetch them
            // concurrently instead of one after another (previously ehrSettings
            // only started once the live-counts wait had fully finished).
            const isConcreteOds = /^[A-Z]\d{5}$/.test(normalizedOds);
            const liveCountsPromise = isConcreteOds
                ? withTimeout(resolveLiveMailroomCountsByOds(normalizedOds, { allowTempTab: false }), 800)
                : Promise.resolve(null);
            const ehrSettingsPromise = sqlPractice
                ? Promise.resolve({ ...createEmptyPracticeEhrSettings(), ...sqlPractice, practiceCdb: sqlPractice.practiceCDB || sqlPractice.cdb || '' })
                : isConcreteOds
                ? fetchPracticeEhrSettingsByOds(normalizedOds, preferredTabId)
                : Promise.resolve(createEmptyPracticeEhrSettings());

            let liveMailroomCounts = getCachedLiveCounts(normalizedOds, LIVE_COUNTS_CACHE_TTL_MS * 4) || createEmptyLiveCounts();
            const [quickCounts, ehrSettingsResolved] = await Promise.all([liveCountsPromise, ehrSettingsPromise]);
            if (quickCounts && hasAnyLiveCounts(quickCounts)) {
                liveMailroomCounts = mergeLiveCounts(liveMailroomCounts, quickCounts);
            }

            const looksInvalidCdb = !p?.cdb || p.cdb.trim().toLowerCase() === (p?.name || '').trim().toLowerCase();
            let ehrSettings = await applyPracticeSecretOverrides(normalizedOds, ehrSettingsResolved);

            const resolvedPracticeCdb = String(ehrSettings.practiceCdb || p?.cdb || '').trim();
            if (p && looksInvalidCdb && resolvedPracticeCdb) {
                const refreshed = { ...p, cdb: resolvedPracticeCdb, practiceCDB: resolvedPracticeCdb, timestamp: Date.now() };
                const cacheKey = `${refreshed.name} (${refreshed.ods})`;
                practiceCache[cacheKey] = refreshed;
                p = refreshed;
                await chrome.storage.local.set({ practiceCache, cacheTimestamp: Date.now() });
            }

            return {
                success: true,
                status: {
                    ...p,
                    odsCode: p?.ods || normalizedOds || '',
                    practiceCDB: resolvedPracticeCdb || p?.cdb || '',
                    emisApiUsername: ehrSettings.emisApiUsername || '',
                    emisApiPassword: ehrSettings.emisApiPassword || '',
                    emisApiPasswordPresent: Boolean(ehrSettings.emisApiPasswordPresent || ehrSettings.emisApiPassword),
                    emisWebUsername: ehrSettings.emisWebUsername || '',
                    emisWebPassword: ehrSettings.emisWebPassword || '',
                    emisWebPasswordPresent: Boolean(ehrSettings.emisWebPasswordPresent || ehrSettings.emisWebPassword),
                    emisWebDummyNhsNumber: ehrSettings.emisWebDummyNhsNumber || '',
                    docmanUsername: ehrSettings.docmanUsername || '',
                    docmanPassword: ehrSettings.docmanPassword || '',
                    docmanPasswordPresent: Boolean(ehrSettings.docmanPasswordPresent || ehrSettings.docmanPassword),
                    docmanDummyNhsNumber: ehrSettings.docmanDummyNhsNumber || '',
                    docmanInputFolder: ehrSettings.docmanInputFolder || '',
                    docmanProcessingFolder: ehrSettings.docmanProcessingFolder || '',
                    docmanFilingFolder: ehrSettings.docmanFilingFolder || '',
                    docmanRejectedFolder: ehrSettings.docmanRejectedFolder || '',
                    liveMailroomCounts
                }
            };
        }
        if (message.action === 'hydratePracticeCdb') {
            const updated = await hydrateMissingCdbs(
                message.limit || 25,
                typeof message?.preferredTabId === 'number' ? message.preferredTabId : null
            );
            return { success: true, updated };
        }
        return { error: "Unknown action" };
    };
    handle().then(sendResponse);
    return true; 
});
