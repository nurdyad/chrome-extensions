/**
 * Merged background.js - Final Stable Version
 * Fixes: Multi-monitor tab reuse and Phoenix LiveView tab clicking.
 */

// --- 1. Global State ---
let practiceCache = {}; 
const CACHE_EXPIRY = 24 * 60 * 60 * 1000; 
let isScrapingActive = false; 
const BETTERLETTER_ORIGIN = 'https://app.betterletter.ai';
const BETTERLETTER_TAB_PATTERN = `${BETTERLETTER_ORIGIN}/*`;
const LIVE_COUNTS_CACHE_TTL_MS = 45 * 1000;
const LIVE_COUNTS_TEMP_TAB_COOLDOWN_MS = 30 * 1000;
const LIVE_COUNTS_TEMP_TAB_RESULT_WAIT_MS = 6500;
const LIVE_COUNTS_TEMP_TAB_HYDRATE_WINDOW_MS = 5200;
const LINEAR_GRAPHQL_ENDPOINT = 'https://api.linear.app/graphql';
const SLACK_CHAT_POST_MESSAGE_ENDPOINT = 'https://slack.com/api/chat.postMessage';
const LINEAR_TRIGGER_SERVER_BASE_URL = 'http://127.0.0.1:4817';
const LINEAR_TRIGGER_SERVER_TIMEOUT_MS = 12000;
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

function isScriptableUrl(url) {
    return typeof url === 'string' && /^https?:\/\//i.test(url);
}

// --- Linear + Slack Integrations ---
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

function clampLinearPriority(value) {
    const parsed = Number.parseInt(String(value ?? '0'), 10);
    return [0, 1, 2, 3, 4].includes(parsed) ? parsed : 0;
}

function isLikelyLinearApiKey(value) {
    // Linear personal keys are long secret tokens. We keep validation broad but non-empty.
    return /^[A-Za-z0-9_-]{20,}$/.test(String(value || '').trim());
}

function isLikelyLinearTeamKey(value) {
    return /^[A-Za-z0-9_-]{2,20}$/.test(String(value || '').trim());
}

function isLikelySlackBotToken(value) {
    return /^xox[a-z]-[A-Za-z0-9-]+$/i.test(String(value || '').trim());
}

function isLikelySlackChannelId(value) {
    return /^[CGD][A-Z0-9]{8,}$/i.test(String(value || '').trim());
}

function isLikelySlackWebhookUrl(value) {
    return /^https:\/\/hooks\.slack(?:-gov)?\.com\/services\/[A-Za-z0-9/_-]+$/i.test(String(value || '').trim());
}

function sanitizeLinearSlackPayload(rawPayload = {}) {
    const slackInput = rawPayload?.slack && typeof rawPayload.slack === 'object' ? rawPayload.slack : {};
    const slackMode = sanitizeSingleLine(slackInput.mode, 20).toLowerCase() === 'webhook' ? 'webhook' : 'bot';

    return {
        linearApiKey: sanitizeSingleLine(rawPayload.linearApiKey, 320),
        linearTeamKey: sanitizeSingleLine(rawPayload.linearTeamKey, 32),
        title: sanitizeSingleLine(rawPayload.title, 240),
        description: sanitizeMultiline(rawPayload.description, 12000),
        priority: clampLinearPriority(rawPayload.priority),
        slackMode,
        slackBotToken: sanitizeSingleLine(slackInput.botToken, 320),
        slackChannelId: sanitizeSingleLine(slackInput.channelId, 64),
        slackWebhookUrl: sanitizeSingleLine(slackInput.webhookUrl, 700)
    };
}

function validateLinearSlackPayload(payload) {
    if (!isLikelyLinearApiKey(payload.linearApiKey)) {
        throw new Error('Invalid or missing Linear API key.');
    }
    if (!isLikelyLinearTeamKey(payload.linearTeamKey)) {
        throw new Error('Invalid or missing Linear Team key.');
    }
    if (!payload.title) {
        throw new Error('Issue title is required.');
    }

    if (payload.slackMode === 'webhook') {
        if (!isLikelySlackWebhookUrl(payload.slackWebhookUrl)) {
            throw new Error('Invalid or missing Slack webhook URL.');
        }
        return;
    }

    if (!isLikelySlackBotToken(payload.slackBotToken)) {
        throw new Error('Invalid or missing Slack bot token.');
    }
    if (!isLikelySlackChannelId(payload.slackChannelId)) {
        throw new Error('Invalid or missing Slack channel ID.');
    }
}

async function runLinearGraphqlRequest(linearApiKey, query, variables = {}) {
    const response = await fetch(LINEAR_GRAPHQL_ENDPOINT, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            // Linear accepts API key in Authorization header.
            'Authorization': linearApiKey
        },
        body: JSON.stringify({ query, variables })
    });

    if (!response.ok) {
        throw new Error(`Linear request failed with status ${response.status}.`);
    }

    const payload = await response.json();
    if (Array.isArray(payload?.errors) && payload.errors.length > 0) {
        const message = payload.errors
            .map(err => sanitizeSingleLine(err?.message, 220))
            .filter(Boolean)
            .join('; ');
        throw new Error(message || 'Linear returned an unknown error.');
    }

    return payload?.data || {};
}

async function resolveLinearTeamByKey(linearApiKey, teamKey) {
    const query = `
        query ResolveTeamByKey($key: String!) {
            team(key: $key) {
                id
                key
                name
            }
        }
    `;

    const data = await runLinearGraphqlRequest(linearApiKey, query, { key: teamKey });
    const team = data?.team;
    if (!team?.id) {
        throw new Error(`Linear team "${teamKey}" was not found.`);
    }
    return team;
}

async function createLinearIssue(payload) {
    const team = await resolveLinearTeamByKey(payload.linearApiKey, payload.linearTeamKey);

    const issueInput = {
        teamId: team.id,
        title: payload.title
    };
    if (payload.description) issueInput.description = payload.description;
    if (payload.priority > 0) issueInput.priority = payload.priority;

    const mutation = `
        mutation CreateIssue($input: IssueCreateInput!) {
            issueCreate(input: $input) {
                success
                issue {
                    id
                    identifier
                    title
                    url
                    priority
                }
            }
        }
    `;

    const data = await runLinearGraphqlRequest(payload.linearApiKey, mutation, { input: issueInput });
    const issueCreate = data?.issueCreate;
    const issue = issueCreate?.issue;

    if (!issueCreate?.success || !issue?.id || !issue?.identifier || !issue?.url) {
        throw new Error('Linear issue creation failed.');
    }

    return {
        team,
        issue: {
            identifier: sanitizeSingleLine(issue.identifier, 64),
            title: sanitizeSingleLine(issue.title, 240),
            url: sanitizeSingleLine(issue.url, 1000)
        }
    };
}

async function postSlackNotification(payload, issue) {
    const message = `New Linear issue: <${issue.url}|${issue.identifier}> - ${issue.title}`;

    if (payload.slackMode === 'webhook') {
        const response = await fetch(payload.slackWebhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: message })
        });
        if (!response.ok) {
            throw new Error(`Slack webhook failed with status ${response.status}.`);
        }
        return;
    }

    const response = await fetch(SLACK_CHAT_POST_MESSAGE_ENDPOINT, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Authorization': `Bearer ${payload.slackBotToken}`
        },
        body: JSON.stringify({
            channel: payload.slackChannelId,
            text: message,
            unfurl_links: false,
            unfurl_media: false
        })
    });

    if (!response.ok) {
        throw new Error(`Slack API failed with status ${response.status}.`);
    }

    const slackPayload = await response.json();
    if (!slackPayload?.ok) {
        throw new Error(sanitizeSingleLine(slackPayload?.error, 220) || 'Slack API returned an error.');
    }
}

async function handleCreateLinearIssueAndNotifySlack(rawPayload) {
    try {
        const payload = sanitizeLinearSlackPayload(rawPayload);
        validateLinearSlackPayload(payload);

        const created = await createLinearIssue(payload);
        try {
            await postSlackNotification(payload, created.issue);
            return {
                success: true,
                issue: created.issue,
                team: {
                    key: sanitizeSingleLine(created.team?.key, 32),
                    name: sanitizeSingleLine(created.team?.name, 120)
                }
            };
        } catch (error) {
            // Important: keep Linear success details and return a partial failure.
            return {
                success: false,
                partial: true,
                issue: created.issue,
                error: `Linear issue created, but Slack failed: ${sanitizeSingleLine(error?.message, 260)}`
            };
        }
    } catch (error) {
        return {
            success: false,
            error: sanitizeSingleLine(error?.message, 260) || 'Could not create Linear issue.'
        };
    }
}

function sanitizeLinearTriggerRunPayload(rawPayload = {}) {
    return {
        dryRun: Boolean(rawPayload?.dryRun)
    };
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
        dryRun: Boolean(rawRun.dryRun),
        exitCode,
        signal: sanitizeSingleLine(rawRun.signal, 32),
        error: sanitizeSingleLine(rawRun.error, 260)
    };
}

async function callLinearTriggerServer(path, { method = 'GET', body = null } = {}) {
    const normalizedPath = String(path || '').trim().startsWith('/') ? String(path).trim() : `/${String(path || '').trim()}`;
    const targetUrl = `${LINEAR_TRIGGER_SERVER_BASE_URL}${normalizedPath}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), LINEAR_TRIGGER_SERVER_TIMEOUT_MS);

    try {
        const headers = { 'Accept': 'application/json' };
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

async function handleTriggerLinearBotJobsRun(rawPayload) {
    try {
        const payload = sanitizeLinearTriggerRunPayload(rawPayload);
        const { response, payload: serverPayload } = await callLinearTriggerServer('/trigger-linear', {
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
            return {
                success: false,
                error: sanitizeSingleLine(serverPayload?.error, 240) || `Trigger service failed with status ${response.status}.`
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
    if (typeof tabId !== 'number') return false;
    const message = buildMorningDashboardSummaryMessage(summary);
    if (!message.trim()) return false;

    try {
        await chrome.scripting.executeScript({
            target: { tabId },
            func: (text) => {
                window.alert(String(text || 'BetterLetter morning summary is ready.'));
            },
            args: [message]
        });
        return true;
    } catch (e) {
        return false;
    }
}

async function maybeTriggerMorningDashboardAlert(tabId, tabUrl, reason = '') {
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

async function getOrderedBetterLetterTabCandidates() {
    const candidates = [];
    const seen = new Set();
    const pushTab = (tab) => {
        if (!tab || typeof tab.id !== 'number') return;
        if (!isBetterLetterUrl(getTabUrl(tab))) return;
        if (seen.has(tab.id)) return;
        seen.add(tab.id);
        candidates.push(tab);
    };

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

async function runInExistingBetterLetterTab(func, args = []) {
    const candidates = await getOrderedBetterLetterTabCandidates();
    if (!Array.isArray(candidates) || candidates.length === 0) return null;

    for (const tab of candidates) {
        if (!tab?.id || tab.discarded) continue;

        try {
            const [{ result }] = await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                func,
                args
            });
            await setTargetTabId(tab.id);
            return result;
        } catch (e) {
            // Try the next BetterLetter tab if this one is not scriptable.
        }
    }

    return null;
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
    if (isScrapingActive) return [];
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

function openPanelPopup() {
    chrome.windows.create({
        url: chrome.runtime.getURL('panel.html'),
        type: 'popup',
        width: 330,
        height: 750,
        focused: true
    });
}

async function ensureSidebarPanelMounted(tabId) {
    await chrome.scripting.executeScript({
        target: { tabId },
        func: (panelUrl) => {
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
                iframe.src = panelUrl;
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
        args: [chrome.runtime.getURL('panel.html')]
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
    openPanelPopup();
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
        if (message?.type === 'mailroom_doc_clicked' && message?.data) {
            const payload = { clickedMailroomDocData: message.data };
            const senderTabId = sender?.tab?.id;
            if (typeof senderTabId === 'number' && isBetterLetterUrl(sender?.tab?.url || '')) {
                payload.targetTabId = senderTabId;
            }
            await chrome.storage.local.set(payload);
            return { success: true };
        }

        if (CACHE_REQUIRED_ACTIONS.has(message?.action)) {
            await ensureCacheLoaded();
        }

        if (message.action === 'getPracticeCache') return { practiceCache };
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
        if (message.action === 'createLinearIssueAndNotifySlack') {
            return await handleCreateLinearIssueAndNotifySlack(message.payload);
        }
        if (message.action === 'triggerLinearBotJobsRun') {
            return await handleTriggerLinearBotJobsRun(message.payload);
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
