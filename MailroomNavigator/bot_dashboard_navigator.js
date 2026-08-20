/**
 * Bot dashboard content helper:
 * - Shows row-level floating copy/open quick actions
 * - Extracts structured row metadata for extension features
 */
(() => {
    let floatingNavPanel = null;
    let floatingMetaPanel = null;
    let activeDocIdElement = null;
    let activeMetaElement = null;
    let activeMetaAnchorElement = null;
    let activeMetaAnchorPoint = null;
    let isMouseInDocPanel = false;
    let isMouseInMetaPanel = false;
    let metaHideTimer = null;
    let metaReanchorTimer = null;
    let navigatorToastEl = null;
    let navigatorToastTimer = null;
    let uuidBatchCheckRequestSeq = 0;
    let botDashboardRowCache = null;
    let attachListenersTimer = null;
    let botDashboardSelectionPruneTimer = null;
    let botDashboardReapplyFrame = null;
    let botDashboardReapplyTimer = null;
    let botDashboardBulkSelecting = false;
    let botDashboardBulkRefreshPending = false;
    let botDashboardBulkStatusEl = null;
    let botDashboardBulkOverlayEl = null;
    const createdIssueByDedupeKey = new Map();
    let restrictedToolsAccess = {
        enabled: true,
        allowed: false,
        reason: '',
        openAccessMode: false,
        isOwner: false,
        serverlessLiteMode: false,
        features: {
            dashboard_hover_tools: false,
            linear_create_issue: false
        }
    };
    let listenersStarted = false;

    const META_CLOSE_DELAY_MS = 120;
    const META_REANCHOR_DELAY_MS = 90;
    const CREATE_ISSUE_TIMEOUT_MS = 30000;
    const DOCMAN_LOGIN_START_TIMEOUT_MS = 15000;
    const BOT_DASHBOARD_ROW_CACHE_TTL_MS = 900;
    // Max time to wait for a single toggle_job push to be acknowledged
    // (its phx-click-loading class removed) before giving up on that row
    // and moving on, so one stuck row can't hang the whole operation.
    const BOT_DASHBOARD_SELECT_ALL_ACK_TIMEOUT_MS = 5000;
    const BOT_DASHBOARD_SELECT_ALL_ACK_POLL_MS = 40;
    // How many toggle_job pushes may be in flight at once. 1 is the safest
    // (guaranteed not to overload the channel); bump cautiously if LiveView
    // keeps up, roll back to 1 if push timeouts return.
    const BOT_DASHBOARD_SELECT_ALL_CONCURRENCY = 2;
    const BOT_JOB_TITLE_PREFIX = 'Bot Job Error:';
    const PRACTICE_SUPPORT_TITLE_PREFIX = 'Practice Support Ticket:';
    const BOT_JOB_DEFAULT_PRIORITY = 3;
    const DOCUMENTLESS_BOT_JOB_TITLE_SUBJECTS = {
        docman_validate: 'practice validation',
        docman_password_update: 'password update',
        docman_update_password: 'password update',
        password_update: 'password update'
    };
    const BOT_JOB_ISSUE_TYPE_LABEL = 'Stuck letters / Manual intervention';
    const BOT_JOB_LETTER_STAGE_LABELS = {
        docman_rejection: 'Bot Job/ docman_rejection',
        docman_import: 'Bot Job/docman_import',
        emis_api_consultation: 'Bot Job/emis_api_consultation',
        generate_output: 'Bot job/generate_output',
        docman_review: 'Bot job/ docman_review',
        docman_delete_original: 'Bot Job/docman_delete_originals',
        docman_delete_originals: 'Bot Job/docman_delete_originals',
        docman_file: 'Bot job/ docman_file'
    };
    const STUCK_LETTERS_PREPARING_LABEL = 'Stuck letters - Preparing';
    const REJECTED_QUEUE_LABELS = ['Rejection', 'Monitoring / Reporting'];
    const HIDDEN_DEDUPE_PREFIX = 'BOT_JOBS_DEDUPE:';
    const GROUP_DEDUPE_PREFIX = 'BOT_JOBS_GROUP:';
    const REJECTED_PRACTICE_ISSUE_HOST_ID = 'bl-rejected-practice-issue-host';
    const BOT_DASHBOARD_PAGE_ISSUE_HOST_ID = 'bl-bot-dashboard-page-issue-host';
    const BOT_DASHBOARD_PRACTICE_FILTER_HOST_ID = 'bl-bot-dashboard-practice-filter-host';
    const BOT_DASHBOARD_FILTER_TOGGLE_HOST_ID = 'bl-bot-dashboard-filter-toggle-host';
    const BOT_DASHBOARD_FILTER_STYLE_ID = 'bl-bot-dashboard-filter-style';
    const PREPARING_OVER_3H_ISSUE_HOST_ID = 'bl-preparing-over-3h-issue-host';
    const COPY_ICON_SVG = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
    const LINK_ICON_SVG = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.07 0l2.83-2.83a5 5 0 1 0-7.07-7.07L11 4"></path><path d="M14 11a5 5 0 0 0-7.07 0L4.1 13.83a5 5 0 0 0 7.07 7.07L13 19"></path></svg>';
    const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
    // Shared with panel.js: writing the latest batch here lets the sidebar
    // panel's UUID Lookup section mirror what was just checked on-page.
    const UUID_BATCH_RESULTS_STORAGE_KEY = 'uuidBatchCheckLatest';

    const HEADER_KEYS = {
        documentid: 'document',
        originalname: 'originalName',
        jobtype: 'jobType',
        practice: 'practice',
        jobid: 'jobId',
        added: 'added',
        reason: 'reason',
        rejectedby: 'rejectedBy',
        on: 'rejectedOn',
        status: 'status',
        timespent: 'timeSpent'
    };

    function toSingleLineText(value) {
        if (value == null) return '';
        if (typeof value === 'string') return value;
        if (typeof value === 'number' || typeof value === 'boolean') return String(value);
        if (value instanceof Error) return value.message || String(value);
        if (typeof value === 'object') {
            const directMessage = value.message || value.error || value.reason || value.detail;
            if (directMessage && directMessage !== value) return toSingleLineText(directMessage);
            try {
                return JSON.stringify(value);
            } catch {
                return String(value);
            }
        }
        return String(value);
    }

    function collapseText(value) {
        return toSingleLineText(value).replace(/\s+/g, ' ').trim();
    }

    function describeError(error, fallback = 'Something went wrong.') {
        const direct = collapseText(error);
        if (direct && direct !== '[object Object]') return direct;

        if (error && typeof error === 'object') {
            const nested = error.message || error.error || error.reason || error.detail || error.details;
            const nestedText = collapseText(nested);
            if (nestedText && nestedText !== '[object Object]') return nestedText;

            try {
                const json = JSON.stringify(error);
                if (json && json !== '{}') return json;
            } catch (_error) {
                // Fall through to fallback below.
            }
        }

        return fallback;
    }

    function summarizeIssuePayload(payload = null) {
        if (!payload || typeof payload !== 'object') return 'unknown payload';
        const parts = [
            payload.documentId ? `doc=${collapseText(payload.documentId)}` : '',
            payload.jobType ? `jobType=${collapseText(payload.jobType)}` : '',
            payload.failedJobId ? `job=${collapseText(payload.failedJobId)}` : '',
            payload.title ? `title="${collapseText(payload.title).slice(0, 120)}"` : ''
        ].filter(Boolean);
        return parts.join(' ') || 'unknown payload';
    }

    function extractNumericId(value) {
        const match = String(value || '').match(/\d+/);
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

        if (/^[A-Za-z0-9_-]{8,}$/.test(raw)) return raw;
        return '';
    }

    function extractBotJobType(value) {
        const match = collapseText(value).match(/\b(docman_[a-z_]+|emis_[a-z_]+|generate_output)\b/i);
        return match?.[1] || '';
    }

    function parseAttempts(text) {
        const match = String(text || '').match(/\b(\d+)\s+attempts?\b/i);
        if (!match?.[1]) return null;
        const parsed = Number.parseInt(match[1], 10);
        return Number.isFinite(parsed) ? parsed : null;
    }

    function parseTimeSpentMinutes(text) {
        const normalized = String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
        if (!normalized || normalized.includes('paused')) return null;
        let minutes = 0;
        const dayMatch = normalized.match(/\b(\d+)\s*d(?:ay)?s?\b/);
        const hourMatch = normalized.match(/\b(\d+)\s*h(?:our)?s?\b/);
        const minuteMatch = normalized.match(/\b(\d+)\s*m(?:in(?:ute)?)?s?\b/);
        if (dayMatch?.[1]) minutes += Number.parseInt(dayMatch[1], 10) * 24 * 60;
        if (hourMatch?.[1]) minutes += Number.parseInt(hourMatch[1], 10) * 60;
        if (minuteMatch?.[1]) minutes += Number.parseInt(minuteMatch[1], 10);
        return minutes > 0 ? minutes : null;
    }

    function shortPractice(text) {
        const normalized = collapseText(text);
        return normalized.length > 60 ? `${normalized.slice(0, 60)}...` : normalized;
    }

    function normalizeFingerprint(statusText) {
        return String(statusText || '')
            .toLowerCase()
            .replace(/\bmade\s+\d+\s+attempts\b/g, 'made attempts')
            .replace(/\b\d+\s+attempts\b/g, 'attempts')
            .replace(/\b\d{4}-\d{2}-\d{2}\b/g, '')
            .replace(/\b\d{1,2}:\d{2}(:\d{2})?\b/g, '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function normalizeSpikeFingerprint(row) {
        const jobType = String(row?.job_type || '').toLowerCase();
        const normalized = normalizeFingerprint(row?.status_text);
        if (!normalized) return '';

        if (jobType === 'docman_file') {
            if (normalized.includes('document not found')) return 'document not found';
            if (normalized.includes('save filing action failed')) return 'save filing action failed';
            if (normalized.includes('could not find document')) return 'could not find document';
            if (normalized.includes('no documents')) return 'no documents found';
        }

        return normalized;
    }

    function normalizeGroupKeyPart(value) {
        return collapseText(value).toLowerCase();
    }

    function stableHash(text) {
        let hash = 2166136261;
        const input = String(text || '');
        for (let index = 0; index < input.length; index += 1) {
            hash ^= input.charCodeAt(index);
            hash = Math.imul(hash, 16777619);
        }
        return (hash >>> 0).toString(36);
    }

    function computeBotJobStableIdentity(row) {
        const jobId = collapseText(row?.job_id);
        if (jobId) return `job:${jobId}`;

        const documentId = collapseText(row?.document_id);
        if (documentId) return `document:${documentId}`;

        const fallbackParts = [
            collapseText(row?.practice_code || row?.practice_name),
            collapseText(row?.job_type),
            collapseText(row?.added_at),
            normalizeFingerprint(row?.status_text)
        ].filter(Boolean);
        return fallbackParts.length ? `row:${stableHash(fallbackParts.join('|'))}` : '';
    }

    function computeDedupeKey(row) {
        const fingerprint = normalizeFingerprint(row?.status_text);
        const stableIdentity = computeBotJobStableIdentity(row);
        if (row?.job_id) return { kind: 'job_id', key: row.job_id, fingerprint, stableIdentity };
        if (row?.document_id) return { kind: 'document_id', key: stableIdentity || `document:${row.document_id}`, fingerprint, stableIdentity };
        if (stableIdentity) return { kind: 'row_fingerprint', key: stableIdentity, fingerprint, stableIdentity };
        return { kind: 'fallback', key: '', fingerprint, stableIdentity: '' };
    }

    function computePracticeGroupKey(row, dedupeKey = null) {
        const practice = normalizeGroupKeyPart(row?.practice_name);
        const jobType = normalizeGroupKeyPart(row?.job_type);
        const fingerprint = normalizeGroupKeyPart(normalizeSpikeFingerprint(row) || dedupeKey?.fingerprint || normalizeFingerprint(row?.status_text));
        if (!practice || !jobType || !fingerprint) return '';
        return `${practice}|${jobType}|${fingerprint}`;
    }

    function escapeMarkdownReferenceTitle(text) {
        return String(text || '')
            .replace(/\\/g, '\\\\')
            .replace(/"/g, '\\"');
    }

    function buildHiddenDedupeBlock(dedupeKeys = [], groupKeys = []) {
        const seen = new Set();
        const markers = [];
        let dedupeIndex = 0;
        let groupIndex = 0;

        dedupeKeys.forEach((rawKey) => {
            const key = collapseText(rawKey);
            if (!key) return;
            const normalized = key.toLowerCase();
            if (seen.has(`dedupe:${normalized}`)) return;
            seen.add(`dedupe:${normalized}`);
            dedupeIndex += 1;
            markers.push(
                `[bot-jobs-dedupe-${dedupeIndex}]: # "${escapeMarkdownReferenceTitle(`${HIDDEN_DEDUPE_PREFIX}${key}`)}"`
            );
        });

        const normalizedGroupKeys = Array.isArray(groupKeys) ? groupKeys : [groupKeys];
        normalizedGroupKeys.forEach((rawGroupKey) => {
            const groupKey = collapseText(rawGroupKey);
            if (!groupKey) return;
            const normalized = groupKey.toLowerCase();
            if (seen.has(`group:${normalized}`)) return;
            seen.add(`group:${normalized}`);
            groupIndex += 1;
            markers.push(
                `[bot-jobs-group-${groupIndex}]: # "${escapeMarkdownReferenceTitle(`${GROUP_DEDUPE_PREFIX}${groupKey}`)}"`
            );
        });

        return markers.length ? `\n\n${markers.join('\n')}` : '';
    }

    function inferPriority(row) {
        const status = String(row?.status_text || '').toLowerCase();
        const attempts = Number(row?.attempts_count || 0);
        const jobType = String(row?.job_type || '').toLowerCase();

        if (jobType === 'docman_import') return 1;
        if (['emis_api_consultation', 'docman_file', 'docman_review'].includes(jobType)) return 2;
        if (jobType === 'docman_delete_original') return 4;
        if (status.includes('no response from bot') || status.includes('made 10 attempts') || attempts >= 10) return 1;
        if (attempts >= 4) return 2;
        if (['docman_file', 'docman_validate', 'emis_coding'].includes(jobType)) return 2;
        return BOT_JOB_DEFAULT_PRIORITY;
    }

    function inferBotJobLetterStageLabel(row) {
        const jobType = String(row?.job_type || '').trim().toLowerCase();
        return BOT_JOB_LETTER_STAGE_LABELS[jobType] || '';
    }

    function buildBotJobLinearLabels(rows = []) {
        const normalizedRows = Array.isArray(rows) ? rows.filter(Boolean) : [rows].filter(Boolean);
        const stageLabels = [...new Set(normalizedRows.map((row) => inferBotJobLetterStageLabel(row)).filter(Boolean))];
        const labels = [BOT_JOB_ISSUE_TYPE_LABEL];
        if (stageLabels.length === 1) {
            labels.push(stageLabels[0]);
        }
        return labels;
    }

    function buildAnnotationEditorUrl(documentId) {
        return `https://app.betterletter.ai/mailroom/annotations/${encodeURIComponent(documentId)}`;
    }

    function buildLetterAdminUrl(documentId) {
        return `https://app.betterletter.ai/admin_panel/letter/${encodeURIComponent(documentId)}`;
    }

    function buildLetterBotsDocumentUrl(documentId) {
        return `https://app.betterletter.ai/admin_panel/bots/dashboard?document_id=${encodeURIComponent(documentId)}`;
    }

    function buildObanJobsDocumentUrl(documentId) {
        return `https://app.betterletter.ai/oban/jobs?args=document_id%2B%2B${encodeURIComponent(documentId)}`;
    }

    function buildLetterJobUrl(jobId) {
        return `https://app.betterletter.ai/admin_panel/bots/jobs/${encodeURIComponent(jobId)}`;
    }

    function buildIssueTitleSubject(row) {
        const documentId = collapseText(row?.document_id);
        if (documentId) return documentId;

        const jobType = String(row?.job_type || '').trim().toLowerCase();
        if (jobType === 'docman_import') return 'collection-error';
        if (DOCUMENTLESS_BOT_JOB_TITLE_SUBJECTS[jobType]) return DOCUMENTLESS_BOT_JOB_TITLE_SUBJECTS[jobType];

        return 'job failure';
    }

    function buildIssueTitle(row) {
        const subject = buildIssueTitleSubject(row);
        const practice = shortPractice(row?.practice_name || 'unknown-practice');
        return `${BOT_JOB_TITLE_PREFIX} ${row?.job_type || 'unknown-job'} | ${subject} | ${practice}`;
    }

    function buildIssueDescription(row, dedupeKey = computeDedupeKey(row)) {
        const practiceGroupKey = computePracticeGroupKey(row, dedupeKey);
        const hiddenBlock = buildHiddenDedupeBlock(
            dedupeKey?.key ? [dedupeKey.key] : [],
            practiceGroupKey ? [practiceGroupKey] : []
        );
        const documentId = collapseText(row?.document_id);
        const jobId = collapseText(row?.job_id);
        const annotationEditorUrl = documentId ? buildAnnotationEditorUrl(documentId) : 'N/A';
        const letterAdminUrl = documentId ? buildLetterAdminUrl(documentId) : 'N/A';
        const letterBotsUrl = documentId ? buildLetterBotsDocumentUrl(documentId) : 'N/A';
        const obanJobsUrl = documentId ? buildObanJobsDocumentUrl(documentId) : 'N/A';
        const displayDocumentId = documentId || 'N/A';

        return `
## Summary
- Status: ${collapseText(row?.status_text)}

## Key details
- Document ID: ${displayDocumentId}
- Annotation editor: ${annotationEditorUrl}
- Letter Admin: ${letterAdminUrl}
- Letter Bots link: ${letterBotsUrl}
- Oban Jobs Link: ${obanJobsUrl}
- Job Type: ${collapseText(row?.job_type)}
- Practice: ${collapseText(row?.practice_name)}
- Practice Code: ${collapseText(row?.practice_code)}
- Job ID: ${jobId}
- Letter Job Link: ${jobId ? buildLetterJobUrl(jobId) : ''}
- Added: ${collapseText(row?.added_at)}
- Attempts: ${row?.attempts_count ?? ''}
${row?.error_snippet ? `\n\n\`\`\`\n${String(row.error_snippet)}\n\`\`\`\n` : ''}
${hiddenBlock}
`.trim();
    }

    function buildBotJobRowFromRowData(rowData, fallbackDocId = '') {
        const documentId = extractNumericId(rowData?.document || fallbackDocId);
        const jobType = extractBotJobType(rowData?.jobType || '') || collapseText(rowData?.jobType) || 'unknown-job';
        const practiceName = collapseText(rowData?.practiceName || rowData?.practice || '') || 'unknown-practice';
        const practiceCode = collapseText(rowData?.odsCode || '').toUpperCase();
        const jobId = extractJobId(rowData?.jobId || '');
        const addedAt = collapseText(rowData?.added || '');
        const rowText = collapseText(rowData?.row?.innerText || '');
        const statusText = collapseText(rowData?.status || '') || rowText || 'Unknown status';
        const attemptsCount = parseAttempts(`${statusText} ${rowText}`);
        if (!documentId && !jobId && !jobType) return null;

        return {
            document_id: documentId,
            job_type: jobType,
            practice_name: practiceName,
            practice_code: practiceCode,
            job_id: jobId,
            added_at: addedAt,
            status_text: statusText,
            attempts_count: attemptsCount,
            error_snippet: null
        };
    }

    function buildLinearIssuePayloadFromMailroomRejectedRow(rowData, fallbackDocId = '') {
        const documentId = extractNumericId(rowData?.document || fallbackDocId);
        if (!documentId) return null;

        const dedupeKey = `mailroom_rejected|${documentId}`;
        const hiddenBlock = buildHiddenDedupeBlock([dedupeKey]);
        const practiceName = collapseText(rowData?.practiceName || rowData?.practice || '');
        const rejectedQueue = getRejectedQueueMeta().label;
        const originalName = collapseText(rowData?.originalName || '');
        const reason = collapseText(rowData?.reason || '');
        const rejectedBy = collapseText(rowData?.rejectedBy || '');
        const rejectedOn = collapseText(rowData?.rejectedOn || '');
        const status = collapseText(rowData?.status || '') || 'Rejected';
        const title = practiceName
            ? `Mailroom Rejected: ${documentId} | ${practiceName}`
            : `Mailroom Rejected: ${documentId}`;
        const description = `
## Summary
- Status: ${status}

## Key details
- Document ID: ${documentId}
- Original Name: ${originalName}
- Practice: ${practiceName}
- Queue: ${rejectedQueue}
- Reason: ${reason}
- Rejected By: ${rejectedBy}
- On: ${rejectedOn}
- Annotation editor: ${buildAnnotationEditorUrl(documentId)}
- Letter Admin: ${buildLetterAdminUrl(documentId)}
- Letter Bots link: ${buildLetterBotsDocumentUrl(documentId)}
- Oban Jobs Link: ${buildObanJobsDocumentUrl(documentId)}
${hiddenBlock}
`.trim();

        return {
            documentId,
            failedJobId: '',
            fileSizeBytes: 'N/A',
            practiceName: practiceName || 'N/A',
            letterAdminLink: buildLetterAdminUrl(documentId),
            failedJobLink: '',
            title,
            description,
            priority: 2,
            labels: [...REJECTED_QUEUE_LABELS],
            dedupeKey
        };
    }

    function buildLinearIssuePayloadFromBotDashboardRow(rowData, fallbackDocId = '') {
        const botJobRow = buildBotJobRowFromRowData(rowData, fallbackDocId);
        if (!botJobRow) return null;
        return buildLinearIssuePayloadFromBotJobRow(botJobRow);
    }

    function buildLinearIssuePayloadFromBotJobRow(botJobRow) {
        if (!botJobRow) return null;
        const dedupeKey = computeDedupeKey(botJobRow);
        const failedJobLink = botJobRow.job_id ? buildLetterJobUrl(botJobRow.job_id) : '';

        return {
            documentId: botJobRow.document_id || '',
            failedJobId: botJobRow.job_id,
            fileSizeBytes: 'N/A',
            practiceName: botJobRow.practice_name || 'N/A',
            letterAdminLink: botJobRow.document_id ? buildLetterAdminUrl(botJobRow.document_id) : '',
            failedJobLink,
            title: buildIssueTitle(botJobRow),
            description: buildIssueDescription(botJobRow, dedupeKey),
            priority: inferPriority(botJobRow),
            labels: buildBotJobLinearLabels([botJobRow]),
            stateName: 'Todo',
            dedupeKey: dedupeKey.key,
            jobType: botJobRow.job_type
        };
    }

    function isBotDashboardPage() {
        return window.location.pathname.includes('/admin_panel/bots/dashboard');
    }

    function getVisibleBotDashboardRows() {
        if (!isBotDashboardPage()) return [];
        return getBotDashboardRowEntries({ visibleOnly: true })
            .map((entry) => entry.botJobRow)
            .filter(Boolean);
    }

    function getSelectedBotDashboardRows() {
        if (!isBotDashboardPage()) return [];
        return getBotDashboardRowEntries({ visibleOnly: true })
            .filter((entry) => Boolean(entry.row.querySelector('input[type="checkbox"]:checked')))
            .map((entry) => entry.botJobRow)
            .filter(Boolean);
    }

    function normalizePracticeFilterName(value) {
        return collapseText(value).toLowerCase();
    }

    function getBotDashboardPracticeFilterStorageKey() {
        const pageKey = `${window.location.pathname}${window.location.search}`;
        return `blBotDashboardHiddenPractices:${pageKey}`;
    }

    function getBotDashboardSelectedPracticeStorageKey() {
        const pageKey = `${window.location.pathname}${window.location.search}`;
        return `blBotDashboardSelectedPractices:${pageKey}`;
    }

    function getBotDashboardPracticeModeStorageKey() {
        const pageKey = `${window.location.pathname}${window.location.search}`;
        return `blBotDashboardPracticeMode:${pageKey}`;
    }

    function getBotDashboardStatusFilterStorageKey() {
        const pageKey = `${window.location.pathname}${window.location.search}`;
        return `blBotDashboardStatusFilter:${pageKey}`;
    }

    function getBotDashboardSelectedStatusStorageKey() {
        const pageKey = `${window.location.pathname}${window.location.search}`;
        return `blBotDashboardSelectedStatuses:${pageKey}`;
    }

    function getBotDashboardStatusModeStorageKey() {
        const pageKey = `${window.location.pathname}${window.location.search}`;
        return `blBotDashboardStatusMode:${pageKey}`;
    }

    function getBotDashboardJobTypeFilterStorageKey() {
        const pageKey = `${window.location.pathname}${window.location.search}`;
        return `blBotDashboardJobTypeFilter:${pageKey}`;
    }

    function getBotDashboardSelectedJobTypeStorageKey() {
        const pageKey = `${window.location.pathname}${window.location.search}`;
        return `blBotDashboardSelectedJobTypes:${pageKey}`;
    }

    function getBotDashboardJobTypeModeStorageKey() {
        const pageKey = `${window.location.pathname}${window.location.search}`;
        return `blBotDashboardJobTypeMode:${pageKey}`;
    }

    function getBotDashboardFilterPanelExpandedStorageKey() {
        const pageKey = `${window.location.pathname}${window.location.search}`;
        return `blBotDashboardFilterPanelExpanded:${pageKey}`;
    }

    function loadBotDashboardFilterPanelExpanded() {
        try {
            return window.sessionStorage.getItem(getBotDashboardFilterPanelExpandedStorageKey()) === 'true';
        } catch {
            return false;
        }
    }

    function saveBotDashboardFilterPanelExpanded(expanded) {
        try {
            if (expanded) {
                window.sessionStorage.setItem(getBotDashboardFilterPanelExpandedStorageKey(), 'true');
            } else {
                window.sessionStorage.removeItem(getBotDashboardFilterPanelExpandedStorageKey());
            }
        } catch {
            // Keep the panel usable for the current render even if storage is unavailable.
        }
    }

    function loadHiddenBotDashboardPractices() {
        try {
            const parsed = JSON.parse(window.sessionStorage.getItem(getBotDashboardPracticeFilterStorageKey()) || '[]');
            return new Set(Array.isArray(parsed) ? parsed.map(normalizePracticeFilterName).filter(Boolean) : []);
        } catch {
            return new Set();
        }
    }

    function saveHiddenBotDashboardPractices(hiddenPractices) {
        const values = [...(hiddenPractices || [])].map(normalizePracticeFilterName).filter(Boolean);
        try {
            window.sessionStorage.setItem(getBotDashboardPracticeFilterStorageKey(), JSON.stringify(values));
        } catch {
            // Session storage can be unavailable in some browser modes; filtering still works for the current render.
        }
    }

    function loadSelectedBotDashboardPractices() {
        try {
            const parsed = JSON.parse(window.sessionStorage.getItem(getBotDashboardSelectedPracticeStorageKey()) || '[]');
            return new Set(Array.isArray(parsed) ? parsed.map(normalizePracticeFilterName).filter(Boolean) : []);
        } catch {
            return new Set();
        }
    }

    function saveSelectedBotDashboardPractices(selectedPractices) {
        const values = [...(selectedPractices || [])].map(normalizePracticeFilterName).filter(Boolean);
        try {
            if (values.length) {
                window.sessionStorage.setItem(getBotDashboardSelectedPracticeStorageKey(), JSON.stringify(values));
            } else {
                window.sessionStorage.removeItem(getBotDashboardSelectedPracticeStorageKey());
            }
        } catch {
            // Keep filtering usable for the current render even if storage is unavailable.
        }
    }

    function loadBotDashboardPracticeMode() {
        try {
            const mode = collapseText(window.sessionStorage.getItem(getBotDashboardPracticeModeStorageKey()) || '').toLowerCase();
            return mode === 'exclude' ? 'exclude' : 'include';
        } catch {
            return 'include';
        }
    }

    function saveBotDashboardPracticeMode(mode) {
        const normalized = collapseText(mode).toLowerCase() === 'exclude' ? 'exclude' : 'include';
        try {
            if (normalized === 'exclude') {
                window.sessionStorage.setItem(getBotDashboardPracticeModeStorageKey(), normalized);
            } else {
                window.sessionStorage.removeItem(getBotDashboardPracticeModeStorageKey());
            }
        } catch {
            // Keep filtering usable for the current render even if storage is unavailable.
        }
    }

    function loadBotDashboardStatusFilterTerm() {
        try {
            return collapseText(window.sessionStorage.getItem(getBotDashboardStatusFilterStorageKey()) || '');
        } catch {
            return '';
        }
    }

    function loadSelectedBotDashboardStatuses() {
        try {
            const parsed = JSON.parse(window.sessionStorage.getItem(getBotDashboardSelectedStatusStorageKey()) || '[]');
            return new Set(Array.isArray(parsed) ? parsed.map((value) => collapseText(value).toLowerCase()).filter(Boolean) : []);
        } catch {
            return new Set();
        }
    }

    function saveSelectedBotDashboardStatuses(selectedStatuses) {
        const values = [...(selectedStatuses || [])].map((value) => collapseText(value).toLowerCase()).filter(Boolean);
        try {
            if (values.length) {
                window.sessionStorage.setItem(getBotDashboardSelectedStatusStorageKey(), JSON.stringify(values));
            } else {
                window.sessionStorage.removeItem(getBotDashboardSelectedStatusStorageKey());
            }
        } catch {
            // Keep filtering usable for the current render even if storage is unavailable.
        }
    }

    function loadBotDashboardStatusMode() {
        try {
            const mode = collapseText(window.sessionStorage.getItem(getBotDashboardStatusModeStorageKey()) || '').toLowerCase();
            return mode === 'exclude' ? 'exclude' : 'include';
        } catch {
            return 'include';
        }
    }

    function saveBotDashboardStatusMode(mode) {
        const normalized = collapseText(mode).toLowerCase() === 'exclude' ? 'exclude' : 'include';
        try {
            if (normalized === 'exclude') {
                window.sessionStorage.setItem(getBotDashboardStatusModeStorageKey(), normalized);
            } else {
                window.sessionStorage.removeItem(getBotDashboardStatusModeStorageKey());
            }
        } catch {
            // Keep filtering usable for the current render even if storage is unavailable.
        }
    }

    function saveBotDashboardStatusFilterTerm(term) {
        try {
            const normalized = collapseText(term || '');
            if (normalized) {
                window.sessionStorage.setItem(getBotDashboardStatusFilterStorageKey(), normalized);
            } else {
                window.sessionStorage.removeItem(getBotDashboardStatusFilterStorageKey());
            }
        } catch {
            // Keep the current render usable even if storage is unavailable.
        }
    }

    function loadBotDashboardJobTypeFilterTerm() {
        try {
            return collapseText(window.sessionStorage.getItem(getBotDashboardJobTypeFilterStorageKey()) || '');
        } catch {
            return '';
        }
    }

    function loadSelectedBotDashboardJobTypes() {
        try {
            const parsed = JSON.parse(window.sessionStorage.getItem(getBotDashboardSelectedJobTypeStorageKey()) || '[]');
            return new Set(Array.isArray(parsed) ? parsed.map((value) => collapseText(value).toLowerCase()).filter(Boolean) : []);
        } catch {
            return new Set();
        }
    }

    function saveSelectedBotDashboardJobTypes(selectedJobTypes) {
        const values = [...(selectedJobTypes || [])].map((value) => collapseText(value).toLowerCase()).filter(Boolean);
        try {
            if (values.length) {
                window.sessionStorage.setItem(getBotDashboardSelectedJobTypeStorageKey(), JSON.stringify(values));
            } else {
                window.sessionStorage.removeItem(getBotDashboardSelectedJobTypeStorageKey());
            }
        } catch {
            // Keep filtering usable for the current render even if storage is unavailable.
        }
    }

    function loadBotDashboardJobTypeMode() {
        try {
            const mode = collapseText(window.sessionStorage.getItem(getBotDashboardJobTypeModeStorageKey()) || '').toLowerCase();
            return mode === 'exclude' ? 'exclude' : 'include';
        } catch {
            return 'include';
        }
    }

    function saveBotDashboardJobTypeMode(mode) {
        const normalized = collapseText(mode).toLowerCase() === 'exclude' ? 'exclude' : 'include';
        try {
            if (normalized === 'exclude') {
                window.sessionStorage.setItem(getBotDashboardJobTypeModeStorageKey(), normalized);
            } else {
                window.sessionStorage.removeItem(getBotDashboardJobTypeModeStorageKey());
            }
        } catch {
            // Keep filtering usable for the current render even if storage is unavailable.
        }
    }

    function saveBotDashboardJobTypeFilterTerm(term) {
        try {
            const normalized = collapseText(term || '');
            if (normalized) {
                window.sessionStorage.setItem(getBotDashboardJobTypeFilterStorageKey(), normalized);
            } else {
                window.sessionStorage.removeItem(getBotDashboardJobTypeFilterStorageKey());
            }
        } catch {
            // Keep the current render usable even if storage is unavailable.
        }
    }

    function getBotDashboardStatusHaystack(entry) {
        if (entry?.statusHaystack) return entry.statusHaystack;
        return collapseText([
            entry?.botJobRow?.status_text,
            entry?.botJobRow?.attempts_count ? `${entry.botJobRow.attempts_count} attempts` : '',
            entry?.rowData?.status
        ].filter(Boolean).join(' ')).toLowerCase();
    }

    function botDashboardEntryMatchesStatusTerm(entry, rawTerm) {
        const term = collapseText(rawTerm).toLowerCase();
        if (!term) return true;

        const attemptsMatch = term.match(/^(\d+)\s+attempts?$/i);
        if (attemptsMatch?.[1]) {
            return Number(entry?.botJobRow?.attempts_count || 0) === Number.parseInt(attemptsMatch[1], 10);
        }

        return getBotDashboardStatusHaystack(entry).includes(term);
    }

    function getBotDashboardJobTypeHaystack(entry) {
        if (entry?.jobTypeHaystack) return entry.jobTypeHaystack;
        return collapseText([
            entry?.botJobRow?.job_type,
            entry?.rowData?.jobType
        ].filter(Boolean).join(' ')).toLowerCase();
    }

    function invalidateBotDashboardRowCache() {
        botDashboardRowCache = null;
    }

    function getBotDashboardRowEntries({ visibleOnly = false, forceFresh = false } = {}) {
        if (!isBotDashboardPage()) return [];
        const rows = Array.from(document.querySelectorAll('table tbody tr')).filter((row) => row instanceof HTMLElement);
        const now = Date.now();
        const firstRowKey = collapseText(rows[0]?.textContent || '').slice(0, 80);
        const lastRowKey = collapseText(rows[rows.length - 1]?.textContent || '').slice(0, 80);
        const cacheKey = `${window.location.pathname}${window.location.search}|${rows.length}|${firstRowKey}|${lastRowKey}`;
        const cachedEntries = !forceFresh
            && botDashboardRowCache
            && botDashboardRowCache.key === cacheKey
            && botDashboardRowCache.firstRow === rows[0]
            && botDashboardRowCache.lastRow === rows[rows.length - 1]
            && now - botDashboardRowCache.createdAt < BOT_DASHBOARD_ROW_CACHE_TTL_MS
            ? botDashboardRowCache.entries
            : null;
        const entries = cachedEntries || rows
            .filter((row) => row instanceof HTMLElement)
            .map((row) => {
                const rowData = getRowDataFromElement(row.querySelector('td') || row);
                const botJobRow = buildBotJobRowFromRowData(rowData);
                const practiceName = collapseText(botJobRow?.practice_name || rowData?.practiceName || rowData?.practice || '');
                const statusHaystack = collapseText([
                    botJobRow?.status_text,
                    botJobRow?.attempts_count ? `${botJobRow.attempts_count} attempts` : '',
                    rowData?.status
                ].filter(Boolean).join(' ')).toLowerCase();
                const jobTypeHaystack = collapseText([
                    botJobRow?.job_type,
                    rowData?.jobType
                ].filter(Boolean).join(' ')).toLowerCase();
                return {
                    row,
                    rowData,
                    botJobRow,
                    practiceName,
                    normalizedPracticeName: normalizePracticeFilterName(practiceName),
                    statusHaystack,
                    jobTypeHaystack
                };
            })
            .filter((entry) => entry.botJobRow && entry.practiceName);
        if (!cachedEntries) {
            botDashboardRowCache = {
                key: cacheKey,
                createdAt: now,
                firstRow: rows[0],
                lastRow: rows[rows.length - 1],
                entries
            };
        }
        return entries
            .filter((entry) => {
                if (!visibleOnly) return true;
                if (hasActiveBotDashboardFilters()) {
                    return entry.row.dataset.blFilterVisible === 'true' && entry.row.style.display !== 'none';
                }
                return entry.row.offsetParent !== null;
            });
    }

    function getBotDashboardPracticeCounts() {
        const counts = new Map();
        getBotDashboardRowEntries({ visibleOnly: false }).forEach((entry) => {
            const key = entry.normalizedPracticeName;
            if (!key) return;
            const odsCode = collapseText(entry.botJobRow?.practice_code || entry.rowData?.odsCode || '').toUpperCase();
            const existing = counts.get(key) || { name: entry.practiceName, odsCode, count: 0 };
            if (!existing.odsCode && odsCode) existing.odsCode = odsCode;
            existing.count += 1;
            counts.set(key, existing);
        });
        return [...counts.entries()]
            .map(([key, value]) => ({ key, ...value }))
            .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    }

    function getEffectiveHiddenBotDashboardPractices(
        selectedPractices = loadSelectedBotDashboardPractices(),
        hiddenPractices = loadHiddenBotDashboardPractices(),
        practiceMode = loadBotDashboardPracticeMode()
    ) {
        if (!selectedPractices.size) return hiddenPractices;
        if (practiceMode === 'exclude') {
            return new Set([...hiddenPractices, ...selectedPractices]);
        }
        const effectiveHidden = new Set();
        getBotDashboardPracticeCounts().forEach((item) => {
            if (!selectedPractices.has(item.key)) effectiveHidden.add(item.key);
        });
        return effectiveHidden;
    }

    function getBotDashboardStatusCounts(hiddenPractices = loadHiddenBotDashboardPractices()) {
        const counts = new Map();
        getBotDashboardRowEntries({ visibleOnly: false })
            .filter((entry) => !hiddenPractices.has(entry.normalizedPracticeName))
            .forEach((entry) => {
                const statusText = collapseText(entry.botJobRow?.status_text || 'Unknown status');
                if (statusText) {
                    const statusKey = statusText.toLowerCase();
                    const existing = counts.get(statusKey) || { label: statusText, term: statusText, count: 0 };
                    existing.count += 1;
                    counts.set(statusKey, existing);
                }
                const attempts = Number(entry.botJobRow?.attempts_count || 0);
                if (attempts > 0) {
                    const attemptLabel = `${attempts} attempts`;
                    const existing = counts.get(attemptLabel) || { label: attemptLabel, term: attemptLabel, count: 0 };
                    existing.count += 1;
                    counts.set(attemptLabel, existing);
                }
            });

        return [...counts.values()]
            .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
            .slice(0, 18);
    }

    function getBotDashboardJobTypeCounts(hiddenPractices = loadHiddenBotDashboardPractices()) {
        const counts = new Map();
        getBotDashboardRowEntries({ visibleOnly: false })
            .filter((entry) => !hiddenPractices.has(entry.normalizedPracticeName))
            .forEach((entry) => {
                const jobType = collapseText(entry.botJobRow?.job_type || entry.rowData?.jobType || 'unknown-job');
                if (!jobType) return;
                const key = jobType.toLowerCase();
                const existing = counts.get(key) || { label: jobType, term: jobType, count: 0 };
                existing.count += 1;
                counts.set(key, existing);
            });

        return [...counts.values()]
            .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
            .slice(0, 18);
    }

    function ensureBotDashboardFilterStyle() {
        if (document.getElementById(BOT_DASHBOARD_FILTER_STYLE_ID)) return;
        const style = document.createElement('style');
        style.id = BOT_DASHBOARD_FILTER_STYLE_ID;
        style.textContent = `
body[data-bl-dashboard-filter-lock="true"] table tbody tr:not([data-bl-filter-visible="true"]) {
    display: none !important;
}
body[data-bl-dashboard-bulk-selecting="true"] {
    cursor: wait !important;
}
.bl-dashboard-bulk-overlay {
    position: fixed;
    inset: 0;
    z-index: 2147483646;
    background: transparent;
    pointer-events: all;
    cursor: wait;
}
.bl-dashboard-bulk-status {
    position: fixed;
    right: 24px;
    bottom: 24px;
    z-index: 2147483647;
    background: #0b2545;
    color: #fff;
    border-radius: 8px;
    box-shadow: 0 10px 24px rgba(15, 23, 42, 0.28);
    padding: 10px 14px;
    font: 700 13px/1.3 system-ui, -apple-system, sans-serif;
}
.bl-dashboard-practice-inline-actions {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    margin-left: 10px;
    vertical-align: middle;
}
.bl-dashboard-practice-inline-actions button {
    border: 1px solid #cbd5e1;
    border-radius: 999px;
    background: #fff;
    color: #0f172a;
    cursor: pointer;
    font: 700 11px/1.1 system-ui, -apple-system, sans-serif;
    min-height: 22px;
    padding: 2px 7px;
}
.bl-dashboard-practice-inline-actions button[data-action="only"] {
    border-color: #93c5fd;
    background: #eff6ff;
    color: #1d4ed8;
}
.bl-dashboard-practice-inline-actions button[data-action="show"] {
    border-color: #fca5a5;
    background: #fee2e2;
    color: #991b1b;
}
`;
        document.head.appendChild(style);
    }

    function updateBotDashboardFilterLock(isActive = hasActiveBotDashboardFilters()) {
        if (!document.body) return;
        ensureBotDashboardFilterStyle();
        if (isActive) {
            document.body.dataset.blDashboardFilterLock = 'true';
        } else {
            delete document.body.dataset.blDashboardFilterLock;
        }
    }

    function setBotDashboardBulkSelectingMask(isActive) {
        if (!document.body) return;
        ensureBotDashboardFilterStyle();
        if (isActive) {
            document.body.dataset.blDashboardBulkSelecting = 'true';
            if (!botDashboardBulkOverlayEl) {
                botDashboardBulkOverlayEl = document.createElement('div');
                botDashboardBulkOverlayEl.className = 'bl-dashboard-bulk-overlay';
                botDashboardBulkOverlayEl.setAttribute('aria-hidden', 'true');
                document.body.appendChild(botDashboardBulkOverlayEl);
            }
        } else {
            delete document.body.dataset.blDashboardBulkSelecting;
            botDashboardBulkOverlayEl?.remove();
            botDashboardBulkOverlayEl = null;
        }
    }

    function setBotDashboardBulkStatus(message = '') {
        ensureBotDashboardFilterStyle();
        if (!message) {
            botDashboardBulkStatusEl?.remove();
            botDashboardBulkStatusEl = null;
            return;
        }
        if (!botDashboardBulkStatusEl) {
            botDashboardBulkStatusEl = document.createElement('div');
            botDashboardBulkStatusEl.className = 'bl-dashboard-bulk-status';
            document.body.appendChild(botDashboardBulkStatusEl);
        }
        botDashboardBulkStatusEl.textContent = message;
    }

    function waitForNextFrame() {
        return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
    }

    function applyBotDashboardPracticeFilters() {
        if (!isBotDashboardPage()) return;
        const hiddenPractices = loadHiddenBotDashboardPractices();
        const selectedPractices = loadSelectedBotDashboardPractices();
        const practiceMode = loadBotDashboardPracticeMode();
        const statusTerm = loadBotDashboardStatusFilterTerm().toLowerCase();
        const jobTypeTerm = loadBotDashboardJobTypeFilterTerm().toLowerCase();
        const selectedStatuses = loadSelectedBotDashboardStatuses();
        const statusMode = loadBotDashboardStatusMode();
        const selectedJobTypes = loadSelectedBotDashboardJobTypes();
        const jobTypeMode = loadBotDashboardJobTypeMode();
        const effectiveHiddenPractices = getEffectiveHiddenBotDashboardPractices(selectedPractices, hiddenPractices, practiceMode);
        updateBotDashboardFilterLock(Boolean(effectiveHiddenPractices.size)
            || Boolean(statusTerm)
            || Boolean(jobTypeTerm)
            || Boolean(selectedStatuses.size)
            || Boolean(selectedJobTypes.size));
        let shouldPruneSelection = false;
        getBotDashboardRowEntries({ visibleOnly: false }).forEach((entry) => {
            const hiddenByPractice = effectiveHiddenPractices.has(entry.normalizedPracticeName);
            const hiddenByStatus = selectedStatuses.size
                ? (statusMode === 'exclude'
                    ? [...selectedStatuses].some((term) => botDashboardEntryMatchesStatusTerm(entry, term))
                    : ![...selectedStatuses].some((term) => botDashboardEntryMatchesStatusTerm(entry, term)))
                : Boolean(statusTerm) && !botDashboardEntryMatchesStatusTerm(entry, statusTerm);
            const entryJobType = collapseText(entry.botJobRow?.job_type || entry.rowData?.jobType || '').toLowerCase();
            const hiddenByJobType = selectedJobTypes.size
                ? (jobTypeMode === 'exclude' ? selectedJobTypes.has(entryJobType) : !selectedJobTypes.has(entryJobType))
                : Boolean(jobTypeTerm) && !getBotDashboardJobTypeHaystack(entry).includes(jobTypeTerm);
            const shouldHide = hiddenByPractice || hiddenByStatus || hiddenByJobType;
            const filterVisibleValue = shouldHide ? 'false' : 'true';
            const displayValue = shouldHide ? 'none' : '';
            const practiceHiddenValue = shouldHide ? 'true' : 'false';
            const statusHiddenValue = hiddenByStatus ? 'true' : 'false';
            const jobTypeHiddenValue = hiddenByJobType ? 'true' : 'false';
            if (entry.row.dataset.blFilterVisible !== filterVisibleValue) {
                entry.row.dataset.blFilterVisible = filterVisibleValue;
            }
            if (entry.row.style.display !== displayValue) {
                entry.row.style.display = displayValue;
            }
            if (entry.row.dataset.blPracticeHidden !== practiceHiddenValue) {
                entry.row.dataset.blPracticeHidden = practiceHiddenValue;
            }
            if (entry.row.dataset.blStatusHidden !== statusHiddenValue) {
                entry.row.dataset.blStatusHidden = statusHiddenValue;
            }
            if (entry.row.dataset.blJobTypeHidden !== jobTypeHiddenValue) {
                entry.row.dataset.blJobTypeHidden = jobTypeHiddenValue;
            }
            const checkbox = entry.row.querySelector('input[type="checkbox"]');
            if (checkbox instanceof HTMLInputElement) {
                if (checkbox.disabled !== shouldHide) {
                    checkbox.disabled = shouldHide;
                }
                if (shouldHide && checkbox.checked) {
                    shouldPruneSelection = true;
                }
            }
        });
        if (shouldPruneSelection) {
            scheduleUnselectHiddenBotDashboardRows();
        }
    }

    function hasActiveBotDashboardFilters() {
        return loadHiddenBotDashboardPractices().size > 0
            || loadSelectedBotDashboardPractices().size > 0
            || loadSelectedBotDashboardStatuses().size > 0
            || loadSelectedBotDashboardJobTypes().size > 0
            || Boolean(loadBotDashboardStatusFilterTerm())
            || Boolean(loadBotDashboardJobTypeFilterTerm());
    }

    function isHiddenBotDashboardRow(row) {
        if (!(row instanceof HTMLElement)) return false;
        return row.style.display === 'none'
            || row.dataset.blPracticeHidden === 'true'
            || row.dataset.blStatusHidden === 'true'
            || row.dataset.blJobTypeHidden === 'true';
    }

    function setBotDashboardCheckboxChecked(checkbox, checked, { quiet = false } = {}) {
        if (!(checkbox instanceof HTMLInputElement) || checkbox.checked === checked) return;
        const wasDisabled = checkbox.disabled;
        if (quiet) {
            try {
                if (wasDisabled) checkbox.disabled = false;
                const checkedSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked')?.set;
                if (checkedSetter) {
                    checkedSetter.call(checkbox, checked);
                } else {
                    checkbox.checked = checked;
                }
                checkbox.dispatchEvent(new Event('input', { bubbles: true }));
                checkbox.dispatchEvent(new Event('change', { bubbles: true }));
            } finally {
                if (wasDisabled) checkbox.disabled = true;
            }
            return;
        }

        try {
            if (wasDisabled) checkbox.disabled = false;
            checkbox.click();
        } catch {
            checkbox.checked = checked;
            checkbox.dispatchEvent(new Event('input', { bubbles: true }));
            checkbox.dispatchEvent(new Event('change', { bubbles: true }));
        } finally {
            if (wasDisabled) checkbox.disabled = true;
        }
        if (checkbox.checked !== checked) {
            checkbox.checked = checked;
            checkbox.dispatchEvent(new Event('input', { bubbles: true }));
            checkbox.dispatchEvent(new Event('change', { bubbles: true }));
        }
    }

    function uncheckBotDashboardCheckbox(checkbox, options = {}) {
        setBotDashboardCheckboxChecked(checkbox, false, options);
    }

    function unselectHiddenBotDashboardRows({ quiet = true } = {}) {
        if (!isBotDashboardPage()) return;
        document.querySelectorAll('table tbody tr input[type="checkbox"]:checked').forEach((checkbox) => {
            const row = checkbox.closest('tr');
            if (!isHiddenBotDashboardRow(row)) return;
            uncheckBotDashboardCheckbox(checkbox, { quiet });
        });
    }

    function scheduleUnselectHiddenBotDashboardRows({ quiet = true } = {}) {
        if (botDashboardSelectionPruneTimer) {
            clearTimeout(botDashboardSelectionPruneTimer);
        }
        botDashboardSelectionPruneTimer = window.setTimeout(() => {
            botDashboardSelectionPruneTimer = null;
            botDashboardBulkSelecting = true;
            try {
                unselectHiddenBotDashboardRows({ quiet });
            } finally {
                botDashboardBulkSelecting = false;
            }
            window.setTimeout(() => unselectHiddenBotDashboardRows({ quiet }), 60);
        }, 0);
    }

    function runBotDashboardFilterRefresh() {
        invalidateBotDashboardRowCache();
        applyBotDashboardPracticeFilters();
        attachBotDashboardInlinePracticeControls();
        attachBotDashboardPageIssueButton();
    }

    function reapplyBotDashboardFiltersSoon() {
        if (botDashboardReapplyFrame == null) {
            botDashboardReapplyFrame = window.requestAnimationFrame(() => {
                botDashboardReapplyFrame = null;
                runBotDashboardFilterRefresh();
            });
        }
        if (botDashboardReapplyTimer) {
            clearTimeout(botDashboardReapplyTimer);
        }
        botDashboardReapplyTimer = window.setTimeout(() => {
            botDashboardReapplyTimer = null;
            runBotDashboardFilterRefresh();
        }, 40);
    }

    function findBotDashboardPracticeCountElements() {
        const practiceCounts = getBotDashboardPracticeCounts();
        if (!practiceCounts.length) return [];

        const heading = Array.from(document.querySelectorAll('summary, div, span, button, p'))
            .find((element) => element instanceof HTMLElement
                && element.offsetParent !== null
                && /view number of jobs per practice/i.test(collapseText(element.textContent || '')));
        const headingTop = heading instanceof HTMLElement ? heading.getBoundingClientRect().top : -Infinity;
        const statusTop = Array.from(document.querySelectorAll('button, a, div, span'))
            .filter((element) => element instanceof HTMLElement && element.offsetParent !== null)
            .filter((element) => /require attention|completed successfully|in progress/i.test(collapseText(element.textContent || '')))
            .map((element) => element.getBoundingClientRect().top)
            .filter((top) => top > headingTop + 10)
            .sort((a, b) => a - b)[0] || Infinity;

        const escapeRegex = (value) => String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const candidates = Array.from(document.querySelectorAll('body *'))
            .filter((element) => element instanceof HTMLElement)
            .filter((element) => element.offsetParent !== null)
            .filter((element) => !element.closest(`#${BOT_DASHBOARD_PRACTICE_FILTER_HOST_ID}`))
            .filter((element) => !element.closest('table'))
            .filter((element) => !element.closest('.bl-dashboard-practice-inline-actions'))
            .map((element) => ({ element, rect: element.getBoundingClientRect(), text: collapseText(element.textContent || '') }))
            .filter((entry) => entry.rect.top > headingTop && entry.rect.top < statusTop)
            .filter((entry) => entry.text && entry.text.length < 180);

        return practiceCounts
            .map((item) => {
                const namePattern = escapeRegex(item.name);
                const countPattern = escapeRegex(String(item.count));
                const rowPattern = new RegExp(`\\b${namePattern}\\b[\\s\\S]{0,40}\\b${countPattern}\\b`, 'i');
                const exactNamePattern = new RegExp(`^${namePattern}$`, 'i');
                const rowMatch = candidates
                    .filter((entry) => rowPattern.test(entry.text))
                    .sort((a, b) => a.text.length - b.text.length || a.rect.width - b.rect.width)[0];
                if (rowMatch) return { element: rowMatch.element, item };

                const nameMatch = candidates
                    .filter((entry) => exactNamePattern.test(entry.text))
                    .find((entry) => collapseText(entry.element.parentElement?.textContent || '').includes(String(item.count)));
                return nameMatch ? { element: nameMatch.element.parentElement || nameMatch.element, item } : null;
            })
            .filter(Boolean);
    }

    function attachBotDashboardInlinePracticeControls() {
        if (!isBotDashboardPage()) return;
        ensureBotDashboardFilterStyle();
        const practiceCounts = getBotDashboardPracticeCounts();
        if (!practiceCounts.length) return;
        const allPracticeKeys = new Set(practiceCounts.map((item) => item.key));
        const hiddenPractices = loadHiddenBotDashboardPractices();

        findBotDashboardPracticeCountElements().forEach(({ element, item }) => {
            const existing = Array.from(element.querySelectorAll?.('.bl-dashboard-practice-inline-actions') || [])
                .find((actions) => actions instanceof HTMLElement && actions.dataset.practiceKey === item.key);
            if (existing) {
                const showButton = existing.querySelector('[data-action="show"]');
                const hideButton = showButton || existing.querySelector('[data-action="hide"]');
                if (hideButton) {
                    const isHidden = hiddenPractices.has(item.key);
                    hideButton.dataset.action = isHidden ? 'show' : 'hide';
                    hideButton.textContent = isHidden ? 'Show' : 'Hide';
                    hideButton.title = `${isHidden ? 'Show' : 'Hide'} ${item.name}`;
                }
                return;
            }

            const actions = document.createElement('span');
            actions.className = 'bl-dashboard-practice-inline-actions';
            actions.dataset.practiceKey = item.key;

            const onlyButton = document.createElement('button');
            onlyButton.type = 'button';
            onlyButton.dataset.action = 'only';
            onlyButton.textContent = 'Only';
            onlyButton.title = `Show only ${item.name}`;
            onlyButton.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                const nextHidden = new Set(allPracticeKeys);
                nextHidden.delete(item.key);
                saveHiddenBotDashboardPractices(nextHidden);
                applyBotDashboardPracticeFilters();
                attachBotDashboardPracticeFilterPanel();
                attachBotDashboardInlinePracticeControls();
                attachBotDashboardPageIssueButton();
            });

            const hideButton = document.createElement('button');
            hideButton.type = 'button';
            hideButton.dataset.action = hiddenPractices.has(item.key) ? 'show' : 'hide';
            hideButton.textContent = hiddenPractices.has(item.key) ? 'Show' : 'Hide';
            hideButton.title = `${hiddenPractices.has(item.key) ? 'Show' : 'Hide'} ${item.name}`;
            hideButton.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                const nextHidden = loadHiddenBotDashboardPractices();
                if (nextHidden.has(item.key)) {
                    nextHidden.delete(item.key);
                } else {
                    nextHidden.add(item.key);
                }
                saveHiddenBotDashboardPractices(nextHidden);
                applyBotDashboardPracticeFilters();
                attachBotDashboardPracticeFilterPanel();
                attachBotDashboardInlinePracticeControls();
                attachBotDashboardPageIssueButton();
            });

            actions.append(onlyButton, hideButton);
            element.appendChild(actions);
        });
    }

    function isBotDashboardSelectAllCheckbox(checkbox) {
        if (!(checkbox instanceof HTMLInputElement) || checkbox.type !== 'checkbox') return false;
        if (checkbox.closest('thead') || checkbox.closest('th') || !checkbox.closest('tbody')) return true;

        const row = checkbox.closest('tr');
        if (!row) return false;
        const rowText = collapseText(row.textContent || '');
        if (/^select all\b/i.test(rowText) || /\bselect all\b/i.test(rowText)) return true;

        const rowData = getRowDataFromElement(row.querySelector('td') || row);
        return rowData?.sourceKind !== 'bot_dashboard'
            || !buildBotJobRowFromRowData(rowData);
    }

    function getCheckboxFromDashboardEvent(event) {
        const target = event?.target;
        if (target instanceof HTMLInputElement && target.type === 'checkbox') return target;

        const path = typeof event?.composedPath === 'function' ? event.composedPath() : [];
        const pathCheckbox = path.find((item) => item instanceof HTMLInputElement && item.type === 'checkbox');
        if (pathCheckbox) return pathCheckbox;

        if (target instanceof Element) {
            const closestInput = target.closest('input[type="checkbox"]');
            if (closestInput instanceof HTMLInputElement) return closestInput;

            const label = target.closest('label');
            const labelInput = label?.querySelector?.('input[type="checkbox"]');
            if (labelInput instanceof HTMLInputElement) return labelInput;
        }

        if (typeof event?.clientX === 'number' && typeof event?.clientY === 'number') {
            const pointedElement = document.elementFromPoint(event.clientX, event.clientY);
            const pointedInput = pointedElement instanceof HTMLInputElement
                ? pointedElement
                : pointedElement?.closest?.('input[type="checkbox"]');
            if (pointedInput instanceof HTMLInputElement) return pointedInput;
        }

        return null;
    }

    function isBotDashboardCheckboxPushPending(checkbox) {
        return checkbox instanceof HTMLInputElement
            && (checkbox.classList.contains('phx-click-loading') || checkbox.classList.contains('phx-change-loading'));
    }

    // Resolves once the checkbox's toggle_job push has been acknowledged by
    // LiveView (its phx-click-loading class removed), or after a bounded
    // timeout so one stuck/lost push can't hang the whole operation.
    function waitForBotDashboardCheckboxSettle(checkbox) {
        return new Promise((resolve) => {
            const start = Date.now();
            const poll = () => {
                if (!isBotDashboardCheckboxPushPending(checkbox)
                    || Date.now() - start >= BOT_DASHBOARD_SELECT_ALL_ACK_TIMEOUT_MS) {
                    resolve();
                    return;
                }
                window.setTimeout(poll, BOT_DASHBOARD_SELECT_ALL_ACK_POLL_MS);
            };
            poll();
        });
    }

    // Runs the header Select All toggle as one real checkbox click at a
    // time, waiting for each toggle_job push to be acknowledged by Phoenix
    // LiveView before clicking the next row, instead of clicking every
    // visible row synchronously (or in fixed-delay batches). Firing many
    // real .click() calls without waiting for each one's server round trip
    // queues up phx-click="toggle_job" pushes faster than LiveView acks
    // them; once the backlog is older than the channel's push timeout, the
    // browser reports "push timeout" for every queued push at once, even
    // though the clicks were spread out client-side. Gating on the actual
    // ack (rather than a guessed delay) keeps at most one push in flight
    // and adapts automatically to however long the server actually takes.
    async function runVisibleOnlySelectAllBatch(headerCheckbox, { onProgress } = {}) {
        const initialEntries = getBotDashboardRowEntries({ visibleOnly: false, forceFresh: true });
        const initialVisible = initialEntries.filter((entry) => !isHiddenBotDashboardRow(entry.row));
        const visibleCheckboxes = initialVisible
            .map((entry) => entry.row.querySelector('input[type="checkbox"]'))
            .filter((rowCheckbox) => rowCheckbox instanceof HTMLInputElement && !rowCheckbox.disabled);
        const shouldSelect = visibleCheckboxes.some((rowCheckbox) => !rowCheckbox.checked);

        const hiddenTasks = initialEntries
            .filter((entry) => isHiddenBotDashboardRow(entry.row))
            .filter((entry) => entry.row.querySelector('input[type="checkbox"]')?.checked)
            .map((entry) => computeBotJobStableIdentity(entry.botJobRow))
            .filter(Boolean)
            .map((id) => ({ id, checked: false }));

        const visibleTasks = initialVisible
            .filter((entry) => {
                const rowCheckbox = entry.row.querySelector('input[type="checkbox"]');
                return rowCheckbox instanceof HTMLInputElement && !rowCheckbox.disabled && rowCheckbox.checked !== shouldSelect;
            })
            .map((entry) => computeBotJobStableIdentity(entry.botJobRow))
            .filter(Boolean)
            .map((id) => ({ id, checked: shouldSelect }));

        const queue = [...hiddenTasks, ...visibleTasks];
        const total = queue.length;
        let processed = 0;
        let nextIndex = 0;
        onProgress?.(processed, total, shouldSelect);

        async function processTask(task) {
            // Re-resolve the checkbox from a fresh DOM query every row:
            // LiveView can re-render/replace row elements mid-operation, so
            // a checkbox reference captured up front may go stale.
            const freshEntry = getBotDashboardRowEntries({ visibleOnly: false, forceFresh: true })
                .find((entry) => computeBotJobStableIdentity(entry.botJobRow) === task.id);
            const rowCheckbox = freshEntry?.row.querySelector('input[type="checkbox"]');
            if (rowCheckbox instanceof HTMLInputElement && rowCheckbox.checked !== task.checked) {
                await waitForBotDashboardCheckboxSettle(rowCheckbox);
                setBotDashboardCheckboxChecked(rowCheckbox, task.checked, { quiet: false });
                await waitForBotDashboardCheckboxSettle(rowCheckbox);
            }
            processed += 1;
            onProgress?.(processed, total, shouldSelect);
        }

        async function runWorker() {
            while (nextIndex < queue.length) {
                const task = queue[nextIndex];
                nextIndex += 1;
                await processTask(task);
            }
        }

        const workerCount = Math.min(BOT_DASHBOARD_SELECT_ALL_CONCURRENCY, queue.length);
        await Promise.all(Array.from({ length: workerCount }, () => runWorker()));

        if (headerCheckbox instanceof HTMLInputElement) {
            headerCheckbox.checked = shouldSelect && visibleCheckboxes.length > 0;
        }
    }

    function handleBotDashboardVisibleOnlySelectAll(event, checkboxOverride = null) {
        const checkbox = checkboxOverride || getCheckboxFromDashboardEvent(event);
        if (!(checkbox instanceof HTMLInputElement) || checkbox.type !== 'checkbox') return false;
        if (!isBotDashboardSelectAllCheckbox(checkbox) || !hasActiveBotDashboardFilters()) return false;
        if (event.__blDashboardSelectAllHandled) return true;
        event.__blDashboardSelectAllHandled = true;
        if (event.type !== 'click') return true;

        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();

        invalidateBotDashboardRowCache();
        applyBotDashboardPracticeFilters();
        botDashboardBulkSelecting = true;
        setBotDashboardBulkSelectingMask(true);
        setBotDashboardBulkStatus('Selecting visible jobs...');

        waitForNextFrame()
            .then(waitForNextFrame)
            .then(() => runVisibleOnlySelectAllBatch(checkbox, {
                onProgress: (processed, total, shouldSelect) => {
                    if (total > 0) {
                        const verb = shouldSelect ? 'Selecting' : 'Deselecting';
                        setBotDashboardBulkStatus(`${verb} ${processed} / ${total} visible jobs...`);
                    }
                }
            }))
            .catch((error) => {
                console.warn('[BL Navigator] visible-only Select All batch failed:', error);
            })
            .finally(() => {
                invalidateBotDashboardRowCache();
                runBotDashboardFilterRefresh();
                botDashboardBulkSelecting = false;
                setBotDashboardBulkStatus('');
                setBotDashboardBulkSelectingMask(false);
            });

        return true;
    }

    function attachBotDashboardSelectionGuard() {
        if (!isBotDashboardPage()) return;
        if (document.body && document.body.dataset.blSelectionGuardBound !== 'true') {
            document.body.dataset.blSelectionGuardBound = 'true';
            const handleDocumentSelectAll = (event) => {
                if (!isBotDashboardPage() || botDashboardBulkSelecting) return;
                const checkbox = getCheckboxFromDashboardEvent(event);
                if (!isBotDashboardSelectAllCheckbox(checkbox)) return;
                handleBotDashboardVisibleOnlySelectAll(event, checkbox);
            };
            document.addEventListener('click', handleDocumentSelectAll, true);
            document.addEventListener('change', handleDocumentSelectAll, true);
        }

        const table = document.querySelector('table');
        if (!table || table.dataset.blSelectionGuardBound === 'true') return;
        table.dataset.blSelectionGuardBound = 'true';
        table.addEventListener('change', (event) => {
            const checkbox = getCheckboxFromDashboardEvent(event);
            if (checkbox instanceof HTMLInputElement && checkbox.type === 'checkbox') {
                if (botDashboardBulkSelecting) return;
                if (handleBotDashboardVisibleOnlySelectAll(event, checkbox)) return;
                scheduleUnselectHiddenBotDashboardRows();
                reapplyBotDashboardFiltersSoon();
            }
        }, true);
        table.addEventListener('click', (event) => {
            const checkbox = getCheckboxFromDashboardEvent(event);
            if (checkbox instanceof HTMLInputElement && checkbox.type === 'checkbox') {
                if (botDashboardBulkSelecting) return;
                if (handleBotDashboardVisibleOnlySelectAll(event, checkbox)) return;
                scheduleUnselectHiddenBotDashboardRows();
                reapplyBotDashboardFiltersSoon();
            }
        }, true);
    }

    function getBotDashboardIssueRows() {
        const selectedRows = getSelectedBotDashboardRows();
        if (selectedRows.length) {
            return {
                rows: selectedRows,
                selectedOnly: true
            };
        }

        return {
            rows: getVisibleBotDashboardRows(),
            selectedOnly: false
        };
    }

    function getBotDashboardPageScopeLabel() {
        const selectedTab = Array.from(document.querySelectorAll('a, button, [role="tab"], [aria-selected="true"]'))
            .find((element) => {
                const text = collapseText(element.textContent || '');
                if (!text) return false;
                const selected = String(element.getAttribute('aria-selected') || '').toLowerCase() === 'true';
                const current = element.matches?.('[aria-current="page"], .active, .selected') || false;
                return selected || current;
            });
        const selectedTabText = collapseText(selectedTab?.textContent || '').replace(/\s*\(\d+\)\s*/g, '').trim();
        const statusTab = Array.from(document.querySelectorAll('a, button, [role="tab"]'))
            .find((element) => /require attention/i.test(collapseText(element.textContent || '')));
        const statusText = collapseText(statusTab?.textContent || '').replace(/\s+/g, ' ');
        return [selectedTabText, statusText || 'Require Attention'].filter(Boolean).join(' / ');
    }

    function buildPracticeJobSpikeIssuePayload(rows = []) {
        const normalizedRows = Array.isArray(rows) ? rows.filter(Boolean) : [];
        if (normalizedRows.length === 0) return null;
        if (normalizedRows.length === 1) {
            return buildLinearIssuePayloadFromBotJobRow(normalizedRows[0]);
        }

        const pageUrl = window.location.href;
        const pageScope = getBotDashboardPageScopeLabel();
        const groupKeys = normalizedRows
            .map((row) => computePracticeGroupKey(row, computeDedupeKey(row)))
            .filter(Boolean);
        const firstGroupKey = groupKeys[0] || `${normalizeGroupKeyPart(pageUrl)}|${normalizeGroupKeyPart(pageScope)}`;
        const stableIdentityKeys = [...new Set(normalizedRows
            .map((row) => computeBotJobStableIdentity(row))
            .filter(Boolean))]
            .sort();
        const spikeIdentity = stableIdentityKeys.length
            ? stableIdentityKeys.join('|')
            : `${firstGroupKey}|${normalizedRows.length}|${pageScope}`;
        const dedupeKey = `bot_dashboard_job_set|${normalizedRows.length}|${stableHash(spikeIdentity)}`;
        const hiddenBlock = buildHiddenDedupeBlock([dedupeKey], groupKeys);
        const jobTypes = [...new Set(normalizedRows.map((row) => collapseText(row.job_type)).filter(Boolean))];
        const practices = [...new Set(normalizedRows.map((row) => collapseText(row.practice_name)).filter(Boolean))];
        const firstRow = normalizedRows[0];
        const sampleLines = normalizedRows.slice(0, 30).map((row, index) => {
            const documentPart = row.document_id ? `doc ${row.document_id}` : 'no document id';
            const jobPart = row.job_id ? `job ${row.job_id}` : 'no job id';
            const practicePart = [row.practice_name, row.practice_code].filter(Boolean).join(' ');
            return `${index + 1}. ${documentPart} | ${row.job_type || 'unknown-job'} | ${practicePart || 'unknown practice'} | ${jobPart} | ${row.status_text || 'No status'}`;
        });
        const overflowCount = Math.max(0, normalizedRows.length - sampleLines.length);
        const titleJobType = jobTypes.length === 1 ? jobTypes[0] : `${jobTypes.length} job types`;
        const titlePractice = practices.length === 1 ? shortPractice(practices[0]) : `${practices.length} practices`;
        const priorities = normalizedRows
            .map((row) => inferPriority(row))
            .filter((priority) => Number.isFinite(priority));
        const description = `
## Summary
- Current dashboard page: ${pageScope || 'Bot Jobs Dashboard'}
- Visible rows on this page: ${normalizedRows.length}
- Job types: ${jobTypes.join(', ') || 'N/A'}
- Practices: ${practices.slice(0, 12).join(', ') || 'N/A'}${practices.length > 12 ? `, and ${practices.length - 12} more` : ''}
- Dashboard URL: ${pageUrl}

## Visible rows
${sampleLines.join('\n')}
${overflowCount ? `\n...and ${overflowCount} more visible row(s) on the page.` : ''}

${hiddenBlock}
`.trim();

        return {
            documentId: firstRow.document_id || '',
            failedJobId: firstRow.job_id || '',
            fileSizeBytes: 'N/A',
            practiceName: practices.length === 1 ? practices[0] : `${practices.length} practices`,
            letterAdminLink: firstRow.document_id ? buildLetterAdminUrl(firstRow.document_id) : '',
            failedJobLink: firstRow.job_id ? buildLetterJobUrl(firstRow.job_id) : '',
            title: `Bot Job Spike: ${titleJobType} | ${normalizedRows.length} jobs | ${titlePractice}`,
            description,
            priority: priorities.length ? Math.min(...priorities) : BOT_JOB_DEFAULT_PRIORITY,
            labels: buildBotJobLinearLabels(normalizedRows),
            stateName: 'Todo',
            dedupeKey,
            jobType: titleJobType
        };
    }

    function buildCurrentPageIssuePayloads(rows = []) {
        const normalizedRows = Array.isArray(rows) ? rows.filter(Boolean) : [];
        const grouped = new Map();
        normalizedRows.forEach((row) => {
            const dedupeKey = computeDedupeKey(row);
            const practiceJobKey = computePracticeGroupKey(row, dedupeKey);
            const fallbackKey = collapseText(dedupeKey?.key || row.job_id || row.document_id || JSON.stringify(row));
            const key = practiceJobKey || fallbackKey;
            if (!key) return;
            if (!grouped.has(key)) grouped.set(key, []);
            grouped.get(key).push(row);
        });

        return [...grouped.values()]
            .map((groupRows) => buildPracticeJobSpikeIssuePayload(groupRows))
            .filter(Boolean);
    }

    function buildLinearIssuePayloadFromRejectedPracticeContext(context) {
        const practiceName = collapseText(context?.practiceName);
        const practiceCode = collapseText(context?.practiceCode || '').toUpperCase();
        const rejectedCount = Number(context?.rejectedCount || 0);
        const queueLabel = collapseText(context?.queueLabel) || 'BetterLetter';
        const queueKey = collapseText(context?.queueKey) || 'betterletter';
        if (!practiceName || rejectedCount <= 0) return null;

        const dedupeKey = `practice_support_ticket|${practiceCode || normalizeGroupKeyPart(practiceName)}|${queueKey}`;
        const hiddenBlock = buildHiddenDedupeBlock([dedupeKey]);
        const issueTitle = `${PRACTICE_SUPPORT_TITLE_PREFIX} ${practiceName} | ${queueLabel} rejected queue`;
        const summaryLine = queueKey === 'practice'
            ? `${rejectedCount} rejected letters need to be processed by Practice.`
            : `${rejectedCount} rejected letters are in BetterLetter's rejected queue and need monitoring / reporting.`;
        const description = `
## Summary
- ${summaryLine}

## Practice details
- Practice: ${practiceName}
- Practice Code: ${practiceCode || 'N/A'}
- Queue: ${queueLabel}
- Rejected letters needing processing: ${rejectedCount}
- Rejected queue: ${window.location.href}
${hiddenBlock}
`.trim();

        return {
            documentId: '',
            failedJobId: '',
            fileSizeBytes: 'N/A',
            practiceName,
            letterAdminLink: '',
            failedJobLink: '',
            title: issueTitle,
            description,
            priority: 2,
            labels: [...REJECTED_QUEUE_LABELS],
            stateName: 'Todo',
            dedupeKey
        };
    }

    function isPreparingMailroomPage() {
        return window.location.pathname.includes('/mailroom/preparing');
    }

    function getPreparingQueueMeta() {
        const service = collapseText(new URLSearchParams(window.location.search).get('service')).toLowerCase();
        if (service === 'self') return { key: 'practice', label: 'Practice', queryValue: 'self' };
        return { key: 'betterletter', label: 'BetterLetter', queryValue: 'full' };
    }

    function getVisiblePreparingRowsOverThreshold(thresholdMinutes = 180) {
        if (!isPreparingMailroomPage()) return [];
        return Array.from(document.querySelectorAll('table tbody tr'))
            .filter((row) => row instanceof HTMLElement && row.offsetParent !== null)
            .map((row) => {
                const rowData = getRowDataFromElement(row.querySelector('td') || row);
                const timeSpentText = collapseText(rowData?.timeSpent || '');
                const timeSpentMinutes = parseTimeSpentMinutes(timeSpentText);
                return {
                    rowData,
                    timeSpentText,
                    timeSpentMinutes
                };
            })
            .filter((entry) => entry.rowData && Number(entry.timeSpentMinutes) > thresholdMinutes);
    }

    function buildPreparingOver3hIssuePayload(entries = []) {
        const matches = Array.isArray(entries) ? entries.filter((entry) => entry?.rowData) : [];
        if (!matches.length) return null;

        const queueMeta = getPreparingQueueMeta();
        const first = matches[0].rowData;
        const firstDocumentId = extractNumericId(first.document || '');
        const documentIds = matches
            .map((entry) => extractNumericId(entry.rowData?.document || ''))
            .filter(Boolean);
        const uniqueDocumentIds = [...new Set(documentIds)];
        const dedupeKey = `mailroom_preparing_over_3h|${queueMeta.key}|${uniqueDocumentIds.join(',')}`;
        const hiddenBlock = buildHiddenDedupeBlock([dedupeKey]);
        const rowLines = matches.slice(0, 50).map((entry, index) => {
            const rowData = entry.rowData;
            const documentId = extractNumericId(rowData.document || '') || 'N/A';
            const status = collapseText(rowData.status || '') || 'N/A';
            const practice = collapseText(rowData.practiceName || rowData.practice || '') || 'N/A';
            const originalName = collapseText(rowData.originalName || '');
            return `${index + 1}. ${documentId} | ${practice} | ${status} | ${entry.timeSpentText}${originalName ? ` | ${originalName}` : ''}`;
        });
        const overflowCount = Math.max(0, matches.length - rowLines.length);
        const description = `
## Summary
- ${matches.length} visible preparing letter(s) have spent more than 3 hours.
- Queue: ${queueMeta.label}
- Page URL: ${window.location.href}

## Matching rows
${rowLines.join('\n')}
${overflowCount ? `\n...and ${overflowCount} more matching row(s) on this page.` : ''}

${hiddenBlock}
`.trim();

        return {
            documentId: firstDocumentId,
            failedJobId: '',
            fileSizeBytes: 'N/A',
            practiceName: matches.length === 1
                ? collapseText(first.practiceName || first.practice || 'N/A')
                : `${matches.length} preparing letters`,
            letterAdminLink: firstDocumentId ? buildLetterAdminUrl(firstDocumentId) : '',
            failedJobLink: '',
            title: `Preparing stuck letters: ${matches.length} over 3h | ${queueMeta.label}`,
            description,
            priority: 2,
            labels: [STUCK_LETTERS_PREPARING_LABEL],
            stateName: 'Todo',
            dedupeKey
        };
    }

    function buildLinearIssuePayloadFromRow(rowData, fallbackDocId = '') {
        if (!rowData) return null;
        if (rowData.sourceKind === 'mailroom_rejected') {
            return buildLinearIssuePayloadFromMailroomRejectedRow(rowData, fallbackDocId);
        }
        return buildLinearIssuePayloadFromBotDashboardRow(rowData, fallbackDocId);
    }

    function sendRuntimeMessage(message, { timeoutMs = 0 } = {}) {
        return new Promise((resolve, reject) => {
            let settled = false;
            let timeoutId = null;
            const settle = (handler, value) => {
                if (settled) return;
                settled = true;
                if (timeoutId) clearTimeout(timeoutId);
                handler(value);
            };

            if (Number(timeoutMs) > 0) {
                timeoutId = setTimeout(() => {
                    settle(reject, new Error('MailroomNavigator action timed out. Check the local trigger service and reload the extension.'));
                }, Number(timeoutMs));
            }

            try {
                chrome.runtime.sendMessage(message, (response) => {
                    if (chrome.runtime.lastError) {
                        settle(reject, new Error(String(chrome.runtime.lastError.message || 'Runtime message failed.')));
                        return;
                    }
                    settle(resolve, response || {});
                });
            } catch (error) {
                settle(reject, error);
            }
        });
    }

    async function ensureRestrictedToolsAccess(forceRefresh = false) {
        if (!forceRefresh && restrictedToolsAccess && (restrictedToolsAccess.allowed || restrictedToolsAccess.reason)) {
            return restrictedToolsAccess;
        }

        try {
            const response = await sendRuntimeMessage({
                action: 'getExtensionAccessState',
                payload: {
                    forceRefresh,
                    allowStale: true
                }
            });
            if (response?.success && response?.access) {
                restrictedToolsAccess = {
                    enabled: true,
                    allowed: Boolean(response.access.allowed),
                    reason: collapseText(response.access.reason || ''),
                    openAccessMode: Boolean(response.access?.openAccessMode),
                    isOwner: Boolean(response.access?.isOwner),
                    serverlessLiteMode: Boolean(response.access?.serverlessLiteMode),
                    features: {
                        dashboard_hover_tools: Boolean(response.access?.features?.dashboard_hover_tools),
                        linear_create_issue: Boolean(response.access?.features?.linear_create_issue)
                    }
                };
                return restrictedToolsAccess;
            }
        } catch (error) {
            // Fall through to deny-by-default if access state cannot be resolved.
        }

        restrictedToolsAccess = {
            enabled: true,
            allowed: false,
            reason: 'MailroomNavigator access could not be verified.',
            openAccessMode: false,
            isOwner: false,
            serverlessLiteMode: false,
            features: {
                dashboard_hover_tools: false,
                linear_create_issue: false
            }
        };
        return restrictedToolsAccess;
    }

    function canUseLinearIssueAction() {
        if (restrictedToolsAccess?.serverlessLiteMode) return false;
        return true;
    }

    function canUseNavigatorClipboardApi() {
        try {
            const protocol = String(globalThis?.location?.protocol || '').toLowerCase();
            if (protocol !== 'chrome-extension:' && protocol !== 'moz-extension:') {
                return false;
            }

            const policy = document?.permissionsPolicy || document?.featurePolicy;
            if (policy && typeof policy.allowsFeature === 'function') {
                return policy.allowsFeature('clipboard-write');
            }

            return true;
        } catch (error) {
            return false;
        }
    }

    function copyToClipboardViaBackground(value) {
        return new Promise((resolve) => {
            try {
                if (!chrome?.runtime?.sendMessage) {
                    resolve(false);
                    return;
                }

                chrome.runtime.sendMessage(
                    { action: 'copyTextToClipboard', value },
                    (response) => {
                        if (chrome.runtime.lastError) {
                            resolve(false);
                            return;
                        }
                        resolve(Boolean(response?.success));
                    }
                );
            } catch (error) {
                resolve(false);
            }
        });
    }

    function copyToClipboard(text, onSuccess) {
        const value = String(text ?? '');
        if (!value) return;

        const runSuccess = () => {
            if (typeof onSuccess === 'function') onSuccess();
        };

        const fallbackCopy = () => {
            try {
                if (!document?.body) return false;
                const textarea = document.createElement('textarea');
                textarea.value = value;
                textarea.setAttribute('readonly', 'true');
                textarea.style.position = 'fixed';
                textarea.style.top = '-9999px';
                textarea.style.left = '-9999px';
                textarea.style.opacity = '0';
                document.body.appendChild(textarea);
                textarea.focus();
                textarea.select();
                textarea.setSelectionRange(0, textarea.value.length);
                const copied = document.execCommand('copy');
                textarea.remove();
                return Boolean(copied);
            } catch (error) {
                return false;
            }
        };

        copyToClipboardViaBackground(value).then((copiedViaBackground) => {
            if (copiedViaBackground) {
                runSuccess();
                return;
            }

            if (canUseNavigatorClipboardApi() && navigator?.clipboard?.writeText) {
                navigator.clipboard.writeText(value).then(() => {
                    runSuccess();
                }).catch(() => {
                    if (fallbackCopy()) {
                        runSuccess();
                        return;
                    }
                    console.warn('[BL Navigator] Clipboard copy failed.');
                });
                return;
            }

            if (fallbackCopy()) {
                runSuccess();
                return;
            }

            console.warn('[BL Navigator] Clipboard copy failed.');
        });
    }

    function showNavigatorToast(message, tone = 'neutral') {
        const normalizedMessage = collapseText(message);
        if (!normalizedMessage) return;

        if (!navigatorToastEl || !document.body.contains(navigatorToastEl)) {
            navigatorToastEl = document.createElement('div');
            navigatorToastEl.id = 'bl-navigator-toast';
            Object.assign(navigatorToastEl.style, {
                position: 'fixed',
                top: '16px',
                right: '16px',
                zIndex: '2147483647',
                maxWidth: '360px',
                padding: '10px 12px',
                borderRadius: '10px',
                boxShadow: '0 10px 30px rgba(15, 23, 42, 0.22)',
                fontFamily: 'system-ui, -apple-system, sans-serif',
                fontSize: '12px',
                lineHeight: '1.4',
                color: '#fff',
                opacity: '0',
                pointerEvents: 'none',
                transition: 'opacity 120ms ease'
            });
            document.body.appendChild(navigatorToastEl);
        }

        navigatorToastEl.textContent = normalizedMessage;
        navigatorToastEl.style.background = tone === 'invalid' ? '#b91c1c' : tone === 'valid' ? '#047857' : '#1f2937';
        navigatorToastEl.style.opacity = '1';

        if (navigatorToastTimer) {
            clearTimeout(navigatorToastTimer);
        }
        navigatorToastTimer = window.setTimeout(() => {
            if (navigatorToastEl) {
                navigatorToastEl.style.opacity = '0';
            }
        }, 2600);
    }

    function flashButton(btn) {
        const originalBg = btn.style.background;
        btn.style.background = '#d4edda';
        setTimeout(() => { btn.style.background = originalBg; }, 900);
    }

    function openUrlInNewTab(url) {
        const normalizedUrl = collapseText(url);
        if (!normalizedUrl) return;

        try {
            chrome.runtime.sendMessage({ action: 'openUrlInNewTab', url: normalizedUrl }, (response) => {
                if (chrome.runtime.lastError || !response?.success) {
                    window.open(normalizedUrl, '_blank', 'noopener,noreferrer');
                }
            });
        } catch (e) {
            window.open(normalizedUrl, '_blank', 'noopener,noreferrer');
        }
    }

    function createButton({ label, color, title, onClick, icon }) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.title = title || label || '';
        btn.innerHTML = icon || label || '';
        Object.assign(btn.style, {
            background: color,
            color: '#fff',
            border: 'none',
            borderRadius: '3px',
            padding: '2px 6px',
            cursor: 'pointer',
            fontSize: '11px',
            fontWeight: 'bold',
            display: 'inline-flex',
            alignItems: 'center',
            gap: '4px',
            whiteSpace: 'nowrap',
            lineHeight: '1.2'
        });

        btn.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            onClick?.(btn);
        };

        return btn;
    }

    async function handleCreateIssueWithPayload(btn, payload = null) {
        const originalLabel = btn.textContent || 'Issue';
        const originalBg = btn.style.background;
        if (!payload?.title || !payload?.description) return;

        const dedupeKey = collapseText(payload.dedupeKey || payload.failedJobId || payload.documentId || payload.title);

        btn.disabled = true;
        btn.textContent = 'Creating...';
        btn.style.background = '#1d4ed8';

        try {
            console.info('[BL Navigator] Creating Linear issue.', {
                documentId: payload.documentId || '',
                failedJobId: payload.failedJobId || '',
                title: payload.title || '',
                dedupeKey: payload.dedupeKey || ''
            });
            const response = await sendRuntimeMessage({
                action: 'createLinearIssueFromEnv',
                payload
            }, {
                timeoutMs: CREATE_ISSUE_TIMEOUT_MS
            });

            console.info('[BL Navigator] Create Linear issue response.', response);

            if (!response?.success || !response?.issue?.identifier) {
                const reason = describeError(response?.error || response, 'Could not create issue.');
                throw new Error(reason);
            }

            if (dedupeKey) {
                createdIssueByDedupeKey.set(dedupeKey, {
                    identifier: String(response.issue.identifier || ''),
                    url: collapseText(response.issue.url || ''),
                    reopened: Boolean(response.reopened),
                    reopenStateName: collapseText(response.reopenStateName || '')
                });
            }
            const issueUrl = collapseText(response.issue.url || '');
            if (response?.duplicate && issueUrl) {
                openUrlInNewTab(issueUrl);
            }
            btn.textContent = String(response.issue.identifier || 'Created');
            btn.style.background = '#16a34a';
            showNavigatorToast(
                response?.duplicate && response?.reopened
                    ? `Moved existing ${String(response.issue.identifier || 'issue')} to ${collapseText(response.reopenStateName || 'In Review')}.`
                    : response?.duplicate
                        ? `Opened existing ${String(response.issue.identifier || 'issue')}.`
                    : `Created ${String(response.issue.identifier || 'issue')}.`,
                'valid'
            );
            setTimeout(() => {
                btn.textContent = originalLabel;
                btn.style.background = originalBg;
                btn.disabled = false;
            }, 1800);
        } catch (error) {
            const failureMessage = describeError(error, 'Could not create issue.');
            btn.textContent = 'Failed';
            btn.style.background = '#dc2626';
            btn.title = failureMessage;
            showNavigatorToast(failureMessage, 'invalid');
            console.warn(`[BL Navigator] Issue creation failed: ${failureMessage}`);
            console.debug(`[BL Navigator] Issue creation failure details: ${summarizeIssuePayload(payload)} error=${failureMessage}`);
            setTimeout(() => {
                btn.textContent = originalLabel;
                btn.style.background = originalBg;
                btn.disabled = false;
            }, 2200);
        }
    }

    async function createLinearIssueFromPayload(payload = null) {
        if (!payload?.title || !payload?.description) {
            throw new Error('Issue payload is missing title or description.');
        }

        const dedupeKey = collapseText(payload.dedupeKey || payload.failedJobId || payload.documentId || payload.title);

        console.info('[BL Navigator] Creating Linear issue.', {
            documentId: payload.documentId || '',
            failedJobId: payload.failedJobId || '',
            title: payload.title || '',
            dedupeKey: payload.dedupeKey || ''
        });
        const response = await sendRuntimeMessage({
            action: 'createLinearIssueFromEnv',
            payload
        }, {
            timeoutMs: CREATE_ISSUE_TIMEOUT_MS
        });
        console.info('[BL Navigator] Create Linear issue response.', response);

        if (!response?.success || !response?.issue?.identifier) {
            const reason = describeError(response?.error || response, 'Could not create issue.');
            throw new Error(reason);
        }

        if (dedupeKey) {
            createdIssueByDedupeKey.set(dedupeKey, {
                identifier: String(response.issue.identifier || ''),
                url: collapseText(response.issue.url || ''),
                reopened: Boolean(response.reopened),
                reopenStateName: collapseText(response.reopenStateName || '')
            });
        }
        return response;
    }

    async function handleCreateIssuesWithPayloads(btn, payloads = []) {
        const originalLabel = btn.textContent || 'Issue Page';
        const originalBg = btn.style.background;
        const queue = Array.isArray(payloads) ? payloads.filter(Boolean) : [];
        if (!queue.length) return;

        btn.disabled = true;
        btn.style.background = '#1d4ed8';
        const created = [];
        const reused = [];
        const failed = [];

        try {
            for (let index = 0; index < queue.length; index += 1) {
                btn.textContent = `Creating ${index + 1}/${queue.length}`;
                try {
                    const response = await createLinearIssueFromPayload(queue[index]);
                    if (response?.duplicate) {
                        reused.push({
                            ...(response?.issue || {}),
                            reopened: Boolean(response?.reopened),
                            reopenStateName: collapseText(response?.reopenStateName || '')
                        });
                    }
                    else created.push(response?.issue || {});
                } catch (error) {
                    const failureMessage = describeError(error, 'Could not create issue.');
                    const payloadSummary = summarizeIssuePayload(queue[index]);
                    failed.push(`${payloadSummary}: ${failureMessage}`);
                    console.warn(`[BL Navigator] Page issue item failed: ${payloadSummary}: ${failureMessage}`);
                }
            }

            const successCount = created.length + reused.length;
            if (successCount > 0 && failed.length === 0) {
                if (queue.length === 1 && reused.length === 1 && collapseText(reused[0]?.url)) {
                    openUrlInNewTab(collapseText(reused[0].url));
                }

                const firstIdentifier = collapseText(created[0]?.identifier || reused[0]?.identifier || 'issue');
                const reopenedCount = reused.filter((issue) => issue?.reopened).length;
                btn.textContent = successCount === 1 ? firstIdentifier : `Done ${successCount}`;
                btn.style.background = '#16a34a';
                showNavigatorToast(
                    reopenedCount > 0 && created.length === 0
                        ? (successCount === 1
                            ? `Moved existing ${firstIdentifier} to ${collapseText(reused[0]?.reopenStateName || 'In Review')}.`
                            : `Moved ${reopenedCount} existing Linear issues to In Review.`)
                        : reused.length > 0 && created.length === 0
                        ? (successCount === 1
                            ? `Opened existing ${firstIdentifier}.`
                            : `Using ${successCount} existing Linear issues.`)
                        : (successCount === 1
                            ? `Created ${firstIdentifier}.`
                            : `Created ${created.length}; reused ${reused.length}.`),
                    'valid'
                );
                return;
            }

            if (successCount > 0 && failed.length > 0) {
                btn.textContent = `${successCount}/${queue.length}`;
                btn.style.background = '#f59e0b';
                showNavigatorToast(`Handled ${successCount}; failed ${failed.length}: ${failed[0]}`, 'invalid');
                return;
            }

            throw new Error(failed[0] || 'Could not create any issues.');
        } catch (error) {
            const failureMessage = describeError(error, 'Could not create issues.');
            btn.textContent = 'Failed';
            btn.style.background = '#dc2626';
            btn.title = failureMessage;
            showNavigatorToast(failureMessage, 'invalid');
            console.warn(`[BL Navigator] Page issue creation failed: ${failureMessage}`);
            console.debug(`[BL Navigator] Page issue creation payload count=${queue.length}; first=${summarizeIssuePayload(queue[0])}`);
        } finally {
            setTimeout(() => {
                btn.textContent = originalLabel;
                btn.style.background = originalBg;
                btn.disabled = false;
            }, 2200);
        }
    }

    async function handleCreateIssueForRow(btn, rowData = null, fallbackDocId = '') {
        const payload = buildLinearIssuePayloadFromRow(rowData, fallbackDocId);
        await handleCreateIssueWithPayload(btn, payload);
    }

    function makeCreateIssueAction(rowData, fallbackDocId = '') {
        return createButton({
            label: 'Issue',
            color: '#2563eb',
            title: 'Create Linear issue for this row',
            onClick: (btn) => {
                handleCreateIssueForRow(btn, rowData, fallbackDocId).catch(() => undefined);
            }
        });
    }

    function createFloatingDocPanel() {
        if (!floatingNavPanel || !document.body.contains(floatingNavPanel)) {
            floatingNavPanel = document.createElement('div');
            floatingNavPanel.id = 'bl-doc-nav-panel';

            Object.assign(floatingNavPanel.style, {
                position: 'absolute',
                zIndex: '2147483647',
                display: 'none',
                flexDirection: 'column',
                gap: '3px',
                background: '#ffffff',
                padding: '2px 4px',
                border: '1px solid #007bff',
                borderRadius: '4px',
                boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
                fontFamily: 'system-ui, -apple-system, sans-serif',
                pointerEvents: 'auto',
                alignItems: 'center',
                whiteSpace: 'nowrap',
                minWidth: 'fit-content'
            });

            floatingNavPanel.addEventListener('mouseenter', () => { isMouseInDocPanel = true; });
            floatingNavPanel.addEventListener('mouseleave', () => { isMouseInDocPanel = false; hideDocPanel(); });

            document.body.appendChild(floatingNavPanel);
        }

        floatingNavPanel.innerHTML = '';

        const applyCompactButtonStyle = (btn, options = {}) => {
            btn.style.padding = options.padding || '1px 5px';
            btn.style.fontSize = options.fontSize || '10px';
            btn.style.lineHeight = '1.15';
        };

        const createNavActionGroup = (label, color, getUrl) => {
            const group = document.createElement('div');
            Object.assign(group.style, {
                display: 'inline-flex',
                alignItems: 'stretch',
                gap: '0',
                borderRadius: '3px',
                overflow: 'hidden'
            });

            const openBtn = createButton({
                label,
                color,
                title: `Open ${label} link`,
                onClick: () => {
                    const docId = activeDocIdElement?.textContent?.trim()?.replace(/\D/g, '');
                    if (!docId) return;
                    openUrlInNewTab(getUrl(docId));
                }
            });
            openBtn.style.borderRadius = '3px 0 0 3px';
            applyCompactButtonStyle(openBtn);

            const copyBtn = createButton({
                color: '#f0f0f0',
                title: `Copy ${label} link`,
                icon: COPY_ICON_SVG,
                onClick: (btn) => {
                    const docId = activeDocIdElement?.textContent?.trim()?.replace(/\D/g, '');
                    if (!docId) return;
                    copyToClipboard(getUrl(docId), () => flashButton(btn));
                }
            });
            copyBtn.style.color = '#333';
            copyBtn.style.border = '1px solid rgba(0, 0, 0, 0.15)';
            copyBtn.style.borderLeft = 'none';
            copyBtn.style.borderRadius = '0 3px 3px 0';
            applyCompactButtonStyle(copyBtn, { padding: '1px 4px' });

            group.append(openBtn, copyBtn);
            return group;
        };

        const copyFilterBtn = createButton({
            color: '#f0f0f0',
            title: 'Copy as document_id = ...',
            icon: COPY_ICON_SVG,
            onClick: (btn) => {
                const docId = activeDocIdElement?.textContent?.trim()?.replace(/\D/g, '');
                if (!docId) return;
                copyToClipboard(`document_id = ${docId}`, () => flashButton(btn));
            }
        });
        copyFilterBtn.style.color = '#333';
        copyFilterBtn.style.border = '1px solid #ccc';
        applyCompactButtonStyle(copyFilterBtn, { padding: '1px 4px' });

        const copyIdBtn = createButton({
            color: '#f0f0f0',
            title: 'Copy document ID',
            icon: `${COPY_ICON_SVG}<span>ID</span>`,
            onClick: (btn) => {
                const docId = activeDocIdElement?.textContent?.trim()?.replace(/\D/g, '');
                if (!docId) return;
                copyToClipboard(docId, () => flashButton(btn));
            }
        });
        copyIdBtn.style.color = '#333';
        copyIdBtn.style.border = '1px solid #ccc';
        applyCompactButtonStyle(copyIdBtn, { padding: '1px 4px' });

        const createIssueBtn = createButton({
            label: 'Issue',
            color: '#2563eb',
            title: 'Create Linear issue for this document',
            onClick: async (btn) => {
                const docId = extractNumericId(activeDocIdElement?.textContent);
                const rowData = activeDocIdElement ? getRowDataFromElement(activeDocIdElement) : null;
                await handleCreateIssueForRow(btn, rowData, docId);
            }
        });

        const primaryRow = document.createElement('div');
        Object.assign(primaryRow.style, {
            display: 'flex',
            flexDirection: 'row',
            gap: '2px',
            alignItems: 'center',
            flexWrap: 'nowrap'
        });

        const secondaryRow = document.createElement('div');
        Object.assign(secondaryRow.style, {
            display: 'flex',
            flexDirection: 'row',
            gap: '2px',
            alignItems: 'center',
            flexWrap: 'nowrap'
        });

        applyCompactButtonStyle(createIssueBtn, { padding: '1px 6px' });
        createIssueBtn.style.minWidth = '46px';
        createIssueBtn.style.justifyContent = 'center';
        createIssueBtn.style.whiteSpace = 'nowrap';

        const jobsGroup = createNavActionGroup('Jobs', '#6c757d', id => `https://app.betterletter.ai/admin_panel/bots/dashboard?document_id=${id}`);
        const obanGroup = createNavActionGroup('Oban', '#fd7e14', id => `https://app.betterletter.ai/oban/jobs?args=document_id%2B%2B${id}`);
        const logGroup = createNavActionGroup('Log', '#17a2b8', id => `https://app.betterletter.ai/admin_panel/event_log/${id}`);
        const adminGroup = createNavActionGroup('Admin', '#007bff', id => `https://app.betterletter.ai/admin_panel/letter/${id}`);

        primaryRow.append(jobsGroup, obanGroup, logGroup);

        secondaryRow.append(adminGroup);
        if (canUseLinearIssueAction()) {
            secondaryRow.append(createIssueBtn);
        }
        secondaryRow.append(copyFilterBtn, copyIdBtn);

        if (primaryRow.childNodes.length > 0) {
            floatingNavPanel.append(primaryRow);
        }
        if (secondaryRow.childNodes.length > 0) {
            floatingNavPanel.append(secondaryRow);
        }

        return floatingNavPanel;
    }

    function createFloatingMetaPanel() {
        if (document.getElementById('bl-meta-action-panel')) return document.getElementById('bl-meta-action-panel');

        floatingMetaPanel = document.createElement('div');
        floatingMetaPanel.id = 'bl-meta-action-panel';

        Object.assign(floatingMetaPanel.style, {
            position: 'absolute',
            zIndex: '2147483647',
            display: 'none',
            flexDirection: 'row',
            gap: '3px',
            background: '#ffffff',
            padding: '3px 5px',
            border: '1px solid #495057',
            borderRadius: '4px',
            boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
            fontFamily: 'system-ui, -apple-system, sans-serif',
            pointerEvents: 'auto',
            flexWrap: 'nowrap',
            alignItems: 'center',
            whiteSpace: 'nowrap'
        });

        floatingMetaPanel.addEventListener('mouseenter', () => { isMouseInMetaPanel = true; });
        floatingMetaPanel.addEventListener('mouseleave', () => { isMouseInMetaPanel = false; hideMetaPanel(); });

        document.body.appendChild(floatingMetaPanel);
        return floatingMetaPanel;
    }

    function resolveHeaderMap(table) {
        if (!table) return null;

        const headers = Array.from(table.querySelectorAll('thead th'));
        if (!headers.length) return null;

        const map = {};
        headers.forEach((th, index) => {
            const normalized = collapseText(th.textContent).toLowerCase().replace(/[^a-z0-9]/g, '');
            const key = HEADER_KEYS[normalized];
            if (key) map[key] = index;
        });

        if (typeof map.document !== 'number' && typeof map.originalName === 'number') {
            map.document = map.originalName;
        }
        if (typeof map.document !== 'number' && typeof map.jobId !== 'number' && typeof map.status !== 'number') return null;
        return map;
    }

    function getRowDataFromElement(el) {
        const row = el.closest('tr');
        const table = el.closest('table');
        const headerMap = resolveHeaderMap(table);
        if (!row || !headerMap) return null;

        const cells = Array.from(row.querySelectorAll('td'));
        const getCell = (key) => cells[headerMap[key]] || null;
        const getText = (key) => collapseText(getCell(key)?.innerText || getCell(key)?.textContent || '');
        const documentCell = getCell('document');
        const documentCellText = collapseText(documentCell?.innerText || documentCell?.textContent || '');
        const documentLinkText = collapseText(documentCell?.querySelector('a')?.textContent || '');
        const documentId = extractNumericId(documentLinkText || documentCellText);

        const practiceCellText = getText('practice');
        const odsCode = practiceCellText.match(/\b[A-Z]\d{5}\b/)?.[0] || '';
        const practiceName = collapseText(practiceCellText.replace(odsCode, '')) || practiceCellText;
        const originalName = collapseText(
            documentCellText.replace(new RegExp(`\\b${documentId}\\b`, 'g'), '')
        );
        const currentPath = String(window.location.pathname || '');
        const sourceKind = currentPath.includes('/mailroom/rejected')
            ? 'mailroom_rejected'
            : currentPath.includes('/mailroom/preparing')
                ? 'mailroom_preparing'
                : 'bot_dashboard';

        return {
            row,
            sourceKind,
            document: documentId || getText('document'),
            originalName,
            jobType: getText('jobType'),
            practice: practiceCellText,
            practiceName,
            jobId: getText('jobId'),
            added: getText('added'),
            reason: getText('reason'),
            rejectedBy: getText('rejectedBy'),
            rejectedOn: getText('rejectedOn'),
            status: getText('status'),
            timeSpent: getText('timeSpent'),
            odsCode
        };
    }

    function showDocPanel(el) {
        activeDocIdElement = el;
        createFloatingDocPanel();
        const rect = el.getBoundingClientRect();
        floatingNavPanel.style.left = `${rect.left + window.scrollX}px`;
        floatingNavPanel.style.top = `${rect.bottom + window.scrollY + 2}px`;
        floatingNavPanel.style.display = 'flex';
    }

    function hideDocPanel() {
        setTimeout(() => {
            if (!isMouseInDocPanel && activeDocIdElement) {
                const hoverEl = document.querySelectorAll(':hover');
                const isStillHovering = Array.from(hoverEl).some(node => node === activeDocIdElement || node === floatingNavPanel);
                if (!isStillHovering) {
                    if (floatingNavPanel) floatingNavPanel.style.display = 'none';
                    activeDocIdElement = null;
                }
            }
        }, 250);
    }

    function getMetaAnchorRect(cell, anchorElement, anchorPoint = null) {
        if (anchorElement && anchorElement instanceof Element && cell.contains(anchorElement)) {
            const interactiveAnchor = anchorElement.closest('a, button, [role="button"]');
            if (interactiveAnchor && cell.contains(interactiveAnchor)) {
                return interactiveAnchor.getBoundingClientRect();
            }

            // If the pointer is on plain text (no interactive child), prefer point anchoring.
            if (anchorPoint && Number.isFinite(anchorPoint.clientX) && Number.isFinite(anchorPoint.clientY)) {
                return {
                    left: anchorPoint.clientX,
                    top: anchorPoint.clientY,
                    bottom: anchorPoint.clientY
                };
            }

            return anchorElement.getBoundingClientRect();
        }

        if (anchorPoint && Number.isFinite(anchorPoint.clientX) && Number.isFinite(anchorPoint.clientY)) {
            return {
                left: anchorPoint.clientX,
                top: anchorPoint.clientY,
                bottom: anchorPoint.clientY
            };
        }

        const firstVisibleChild = Array.from(cell.children).find(child => {
            const childRect = child.getBoundingClientRect();
            return childRect.width > 0 && childRect.height > 0;
        });
        if (firstVisibleChild) return firstVisibleChild.getBoundingClientRect();

        const cellRect = cell.getBoundingClientRect();
        return {
            left: cellRect.left,
            bottom: cellRect.top + Math.min(cellRect.height, 26)
        };
    }

    function positionMetaPanel(panel, cell, anchorRect) {
        const viewportPadding = 8;
        const cellRect = cell.getBoundingClientRect();
        let left = anchorRect.left + window.scrollX;
        let top = anchorRect.bottom + window.scrollY + 2;

        panel.style.left = `${left}px`;
        panel.style.top = `${top}px`;
        panel.style.display = 'flex';
        panel.style.visibility = 'hidden';

        const panelRect = panel.getBoundingClientRect();
        const minLeft = cellRect.left + window.scrollX;
        const maxLeft = cellRect.right + window.scrollX - panelRect.width;

        if (panelRect.width <= cellRect.width && maxLeft >= minLeft) {
            left = Math.min(Math.max(left, minLeft), maxLeft);
        } else {
            const viewportMinLeft = window.scrollX + viewportPadding;
            const viewportMaxLeft = window.scrollX + window.innerWidth - panelRect.width - viewportPadding;
            left = Math.min(Math.max(left, viewportMinLeft), viewportMaxLeft);
        }

        const viewportBottom = window.scrollY + window.innerHeight - viewportPadding;
        if (top + panelRect.height > viewportBottom) {
            const aboveTop = anchorRect.top + window.scrollY - panelRect.height - 2;
            top = Math.max(window.scrollY + viewportPadding, aboveTop);
        }

        panel.style.left = `${left}px`;
        panel.style.top = `${top}px`;
        panel.style.visibility = 'visible';
    }

    function showMetaPanel(el, actions = [], anchorElement = null, anchorPoint = null) {
        if (!actions.length) return;

        clearTimeout(metaHideTimer);
        clearTimeout(metaReanchorTimer);

        activeMetaElement = el;
        activeMetaAnchorElement = anchorElement;
        activeMetaAnchorPoint = anchorPoint;
        createFloatingMetaPanel();
        floatingMetaPanel.innerHTML = '';

        const appendedActionLabels = new Set();
        actions.forEach(action => {
            const dedupeKey = `${action?.title || ''}|${action?.textContent || ''}`;
            if (appendedActionLabels.has(dedupeKey)) return;
            appendedActionLabels.add(dedupeKey);
            floatingMetaPanel.appendChild(action);
        });

        const anchorRect = getMetaAnchorRect(
            el,
            anchorElement || activeMetaAnchorElement,
            anchorPoint || activeMetaAnchorPoint
        );
        positionMetaPanel(floatingMetaPanel, el, anchorRect);
    }

    function isPointerInsideMetaRegion() {
        if (!activeMetaElement) return false;

        const hoverEl = document.querySelectorAll(':hover');
        return Array.from(hoverEl).some(node =>
            node === activeMetaElement ||
            node === floatingMetaPanel ||
            activeMetaElement.contains?.(node) ||
            floatingMetaPanel?.contains?.(node)
        );
    }

    function hideMetaPanel() {
        clearTimeout(metaHideTimer);
        metaHideTimer = setTimeout(() => {
            if (!isMouseInMetaPanel && activeMetaElement) {
                if (!isPointerInsideMetaRegion()) {
                    if (floatingMetaPanel) floatingMetaPanel.style.display = 'none';
                    activeMetaElement = null;
                    activeMetaAnchorElement = null;
                    activeMetaAnchorPoint = null;
                }
            }
        }, META_CLOSE_DELAY_MS);
    }

    function scheduleMetaPanelForCell(cell, builder, label, anchorElement, anchorPoint) {
        clearTimeout(metaReanchorTimer);

        if (activeMetaElement === cell) {
            const rowData = getRowDataFromElement(cell);
            if (!rowData) return;
            showMetaPanel(cell, builder(rowData, label), anchorElement, anchorPoint);
            return;
        }

        metaReanchorTimer = setTimeout(() => {
            if (isMouseInMetaPanel) return;
            const hoverEl = document.querySelectorAll(':hover');
            const isStillHoveringCell = Array.from(hoverEl).some(node => node === cell || cell.contains(node));
            if (!isStillHoveringCell) return;

            const rowData = getRowDataFromElement(cell);
            if (!rowData) return;

            showMetaPanel(cell, builder(rowData, label), anchorElement, anchorPoint);
        }, META_REANCHOR_DELAY_MS);
    }

    function makeCopyAction(value, options) {
        const config = typeof options === 'string'
            ? { label: `Copy ${options}`, title: `Copy ${options}` }
            : options;

        return createButton({
            label: config.label,
            icon: config.icon,
            color: config.color || '#495057',
            title: config.title || config.label || 'Copy',
            onClick: (btn) => {
                if (!value) return;
                copyToClipboard(value, () => flashButton(btn));
            }
        });
    }

    function makePracticeEhrAction(odsCode) {
        return createButton({
            label: 'EHR',
            color: '#0d6efd',
            title: 'Open practice EHR settings',
            onClick: () => {
                if (!odsCode) return;
                chrome.runtime.sendMessage({ action: 'openPractice', input: odsCode, settingType: 'ehr_settings' });
            }
        });
    }

    function makeDocmanLoginAction(rowData) {
        const odsCode = collapseText(rowData?.odsCode).toUpperCase();
        const practiceName = collapseText(rowData?.practiceName || rowData?.practice?.replace(odsCode, ''));
        if (!/^[A-Z]\d{5}$/.test(odsCode)) return null;

        return createButton({
            label: 'Docman',
            color: '#0891b2',
            title: `Login to Docman for ${practiceName || odsCode}`,
            onClick: async (btn) => {
                const originalHtml = btn.innerHTML;
                const originalBg = btn.style.background;
                btn.disabled = true;
                btn.textContent = 'Starting...';
                btn.style.background = '#0e7490';

                try {
                    const response = await sendRuntimeMessage({
                        action: 'runDocmanToolAction',
                        payload: {
                            action: 'login',
                            practiceName: practiceName || odsCode,
                            odsCode
                        }
                    }, {
                        timeoutMs: DOCMAN_LOGIN_START_TIMEOUT_MS
                    });

                    if (response?.success && response?.run) {
                        btn.textContent = 'Started';
                        btn.style.background = '#047857';
                        showNavigatorToast(`Docman login started for ${practiceName || odsCode}.`, 'valid');
                    } else if (response?.running && response?.run) {
                        btn.textContent = 'Busy';
                        btn.style.background = '#b45309';
                        showNavigatorToast('A Docman tool run is already in progress.', 'neutral');
                    } else {
                        const reason = collapseText(response?.error || response || 'Could not start Docman login.');
                        throw new Error(reason);
                    }
                } catch (error) {
                    const message = collapseText(error?.message || 'Could not start Docman login.');
                    btn.textContent = 'Failed';
                    btn.style.background = '#dc2626';
                    btn.title = message;
                    showNavigatorToast(message, 'invalid');
                } finally {
                    window.setTimeout(() => {
                        btn.innerHTML = originalHtml;
                        btn.style.background = originalBg;
                        btn.disabled = false;
                        btn.title = `Login to Docman for ${practiceName || odsCode}`;
                    }, 1900);
                }
            }
        });
    }

    function getJobUrl(jobId) {
        const normalizedId = collapseText(jobId);
        if (!normalizedId) return '';
        return `https://app.betterletter.ai/admin_panel/bots/jobs/${encodeURIComponent(normalizedId)}`;
    }

    function isRejectedMailroomPage() {
        return window.location.pathname.includes('/mailroom/rejected');
    }

    function getRejectedQueueMeta() {
        const service = collapseText(new URLSearchParams(window.location.search).get('service')).toLowerCase();
        if (service === 'self') {
            return { key: 'practice', label: 'Practice', queryValue: 'self' };
        }
        return { key: 'betterletter', label: 'BetterLetter', queryValue: 'full' };
    }

    function getElementDisplayText(element) {
        if (!(element instanceof Element)) return '';
        if (element instanceof HTMLSelectElement) {
            const selectedOption = element.selectedOptions?.[0];
            return collapseText(selectedOption?.textContent || element.value || '');
        }
        if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
            return collapseText(element.value || element.placeholder || '');
        }
        return collapseText(element.textContent || '');
    }

    function findRejectedPracticeToggleElement(queueKey = getRejectedQueueMeta().key) {
        const pattern = queueKey === 'practice'
            ? /^Practice\s*\(\d+\)$/i
            : /^BetterLetter\s*\(\d+\)$/i;

        return Array.from(document.querySelectorAll('button, [role="button"], a, label, span, div'))
            .find((element) => pattern.test(getElementDisplayText(element))) || null;
    }

    function resolveRejectedPracticeCount(queueKey = getRejectedQueueMeta().key) {
        const toggleText = getElementDisplayText(findRejectedPracticeToggleElement(queueKey));
        const toggleMatch = toggleText.match(/\((\d+)\)/);
        if (toggleMatch?.[1]) {
            const parsed = Number.parseInt(toggleMatch[1], 10);
            if (Number.isFinite(parsed)) return parsed;
        }

        return Array.from(document.querySelectorAll('table tbody tr'))
            .filter((row) => row instanceof HTMLElement && row.offsetParent !== null)
            .length;
    }

    function resolveRejectedPracticeDetails() {
        const firstVisibleRow = Array.from(document.querySelectorAll('table tbody tr'))
            .find((row) => row instanceof HTMLElement && row.offsetParent !== null);
        const probeElement = firstVisibleRow?.querySelector('td') || firstVisibleRow || null;
        const rowData = probeElement ? getRowDataFromElement(probeElement) : null;
        const practiceName = collapseText(rowData?.practiceName || rowData?.practice || '');
        const practiceCodeFromUrl = collapseText(new URLSearchParams(window.location.search).get('practice') || '').toUpperCase();
        const practiceCode = collapseText(rowData?.odsCode || practiceCodeFromUrl).toUpperCase();
        const queueMeta = getRejectedQueueMeta();

        return {
            practiceName,
            practiceCode,
            queueKey: queueMeta.key,
            queueLabel: queueMeta.label,
            rejectedCount: resolveRejectedPracticeCount(queueMeta.key)
        };
    }

    function findRejectedPracticeNameAnchor(practiceName) {
        const normalizedPracticeName = collapseText(practiceName);
        if (!normalizedPracticeName) return null;

        const candidates = Array.from(document.querySelectorAll('select, button, [role="combobox"], input, [aria-haspopup="listbox"]'));
        return candidates.find((element) => {
            if (!(element instanceof HTMLElement)) return false;
            const rect = element.getBoundingClientRect();
            if (rect.width < 180 || rect.height < 24 || rect.top < 0 || rect.top > 140) return false;
            const text = getElementDisplayText(element);
            return text === normalizedPracticeName || text.includes(normalizedPracticeName);
        }) || null;
    }

    function attachRejectedPracticeIssueButton() {
        const existingHost = document.getElementById(REJECTED_PRACTICE_ISSUE_HOST_ID);
        if (!isRejectedMailroomPage() || !canUseLinearIssueAction()) {
            existingHost?.remove();
            return;
        }

        const context = resolveRejectedPracticeDetails();
        const payload = buildLinearIssuePayloadFromRejectedPracticeContext(context);
        if (!payload) {
            existingHost?.remove();
            return;
        }

        const practiceNameAnchor = findRejectedPracticeNameAnchor(context.practiceName);
        const practiceToggleElement = findRejectedPracticeToggleElement(context.queueKey);
        const anchorElement = practiceNameAnchor || practiceToggleElement;
        const anchorParent = anchorElement?.parentElement || null;
        if (!anchorElement || !anchorParent) {
            existingHost?.remove();
            return;
        }

        const host = existingHost || document.createElement('div');
        host.id = REJECTED_PRACTICE_ISSUE_HOST_ID;
        Object.assign(host.style, {
            display: 'inline-flex',
            alignItems: 'center',
            marginLeft: '8px'
        });

        let button = host.querySelector('button');
        if (!button) {
            button = createButton({
                label: 'Issue',
                color: '#2563eb',
                title: 'Create a practice support ticket for this rejected queue',
                onClick: (btn) => {
                    const nextContext = resolveRejectedPracticeDetails();
                    const nextPayload = buildLinearIssuePayloadFromRejectedPracticeContext(nextContext);
                    handleCreateIssueWithPayload(btn, nextPayload).catch(() => undefined);
                }
            });
            Object.assign(button.style, {
                padding: '8px 12px',
                borderRadius: '8px',
                fontSize: '12px',
                lineHeight: '1.1',
                minHeight: '36px',
                boxShadow: '0 1px 3px rgba(15, 23, 42, 0.16)'
            });
            host.appendChild(button);
        }

        button.title = `Create ${context.queueLabel} rejected-queue ticket for ${context.practiceName} (${context.rejectedCount} rejected letters)`;
        host.dataset.practiceName = context.practiceName;
        host.dataset.practiceCount = String(context.rejectedCount);
        host.dataset.queueKey = context.queueKey;

        if (practiceNameAnchor && practiceNameAnchor.nextElementSibling !== host) {
            practiceNameAnchor.insertAdjacentElement('afterend', host);
            return;
        }

        if (!practiceNameAnchor && practiceToggleElement && practiceToggleElement.nextElementSibling !== host) {
            practiceToggleElement.insertAdjacentElement('afterend', host);
        }
    }

    function findBotDashboardPracticeFilterPlacement() {
        const existingHost = document.getElementById(BOT_DASHBOARD_PRACTICE_FILTER_HOST_ID);
        const heading = findBotDashboardPageIssueAnchor();
        const headingTop = heading instanceof HTMLElement ? heading.getBoundingClientRect().top : -Infinity;
        const visibleTables = Array.from(document.querySelectorAll('table'))
            .filter((table) => table instanceof HTMLElement && table !== existingHost && table.offsetParent !== null)
            .filter((table) => table.getBoundingClientRect().top > headingTop + 20);
        const jobsTable = visibleTables[0] || null;
        if (jobsTable?.parentElement) {
            return {
                parent: jobsTable.parentElement,
                before: jobsTable
            };
        }

        const noJobsElement = Array.from(document.querySelectorAll('div, span, p, td'))
            .find((element) => element instanceof HTMLElement
                && element.offsetParent !== null
                && /^no jobs found$/i.test(collapseText(element.textContent || '')));
        if (noJobsElement?.parentElement) {
            return {
                parent: noJobsElement.parentElement,
                before: noJobsElement
            };
        }

        const statusElement = Array.from(document.querySelectorAll('button, a, div, span'))
            .find((element) => element instanceof HTMLElement
                && element.offsetParent !== null
                && /completed successfully/i.test(collapseText(element.textContent || ''))
                && element.getBoundingClientRect().top > headingTop);
        const statusContainer = statusElement?.parentElement || null;
        if (statusContainer?.parentElement) {
            return {
                parent: statusContainer.parentElement,
                after: statusContainer
            };
        }

        if (heading?.parentElement) {
            return {
                parent: heading.parentElement,
                after: heading
            };
        }

        return null;
    }

    function findBotDashboardPracticeDropdownAnchor() {
        const heading = findBotDashboardPageIssueAnchor();
        const headingTop = heading instanceof HTMLElement ? heading.getBoundingClientRect().top : -Infinity;
        const isOwnToggle = (element) => element.closest(`#${BOT_DASHBOARD_FILTER_TOGGLE_HOST_ID}`);
        // Strips a trailing chevron/arrow glyph (if the dropdown renders one as
        // a text character rather than an icon) before comparing the label.
        const normalizeDropdownLabel = (text) => collapseText(text).toLowerCase().replace(/[^a-z ]+$/i, '').trim();

        // Primary: match the control showing the default "Show all practices"
        // label directly, regardless of what tag/role it's built from (this is
        // a custom LiveView dropdown, not necessarily a <select> or
        // role="combobox" element). An inner text span and its outer clickable
        // box can both match this exact text; prefer the largest box that's
        // still dropdown-sized (not a full-width row wrapper) so we anchor
        // beside the visible control, not nested inside its label text.
        const textMatches = Array.from(document.querySelectorAll('div, button, span, select, a'))
            .filter((element) => element instanceof HTMLElement
                && element.offsetParent !== null
                && !isOwnToggle(element)
                && normalizeDropdownLabel(element.textContent || '') === 'show all practices');
        if (textMatches.length > 0) {
            const dropdownSized = textMatches.filter((element) => {
                const rect = element.getBoundingClientRect();
                return rect.width <= 500 && rect.height <= 80;
            });
            const pool = dropdownSized.length > 0 ? dropdownSized : textMatches;
            pool.sort((a, b) => {
                const rectA = a.getBoundingClientRect();
                const rectB = b.getBoundingClientRect();
                return (rectB.width * rectB.height) - (rectA.width * rectA.height);
            });
            return pool[0];
        }

        // Fallback: once a specific practice is selected, the label above no
        // longer reads "Show all practices". Match by position instead: the
        // topmost combobox-like control between the page heading and the
        // status tabs row. Pick the smallest matching element, not just the
        // first one in document order, since a large ancestor wrapping the
        // whole page section also contains this text further down inside it.
        const statusCandidates = Array.from(document.querySelectorAll('button, a, div, span'))
            .filter((element) => element instanceof HTMLElement
                && element.offsetParent !== null
                && element.getBoundingClientRect().top > headingTop
                && /completed successfully/i.test(collapseText(element.textContent || '')));
        statusCandidates.sort((a, b) => {
            const rectA = a.getBoundingClientRect();
            const rectB = b.getBoundingClientRect();
            return (rectA.width * rectA.height) - (rectB.width * rectB.height);
        });
        const statusElement = statusCandidates[0] || null;
        const statusTop = statusElement instanceof HTMLElement ? statusElement.getBoundingClientRect().top : Infinity;

        const candidates = Array.from(document.querySelectorAll('select, button, [role="combobox"], [aria-haspopup="listbox"]'))
            .filter((element) => element instanceof HTMLElement
                && element.offsetParent !== null
                && !isOwnToggle(element))
            .filter((element) => {
                const rect = element.getBoundingClientRect();
                return rect.width >= 180 && rect.height >= 24 && rect.top > headingTop && rect.top < statusTop;
            })
            .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);

        return candidates[0] || null;
    }

    let botDashboardAnchorDebugLogged = false;
    function debugLogBotDashboardDropdownCandidates() {
        if (botDashboardAnchorDebugLogged) return;
        botDashboardAnchorDebugLogged = true;
        try {
            const heading = findBotDashboardPageIssueAnchor();
            const headingTop = heading instanceof HTMLElement ? heading.getBoundingClientRect().top : -Infinity;
            const info = Array.from(document.querySelectorAll('body *'))
                .filter((element) => element instanceof HTMLElement
                    && element.offsetParent !== null
                    && element.children.length <= 3
                    && /practice/i.test(collapseText(element.textContent || '')))
                .filter((element) => {
                    const rect = element.getBoundingClientRect();
                    return rect.top > headingTop - 20 && rect.top < headingTop + 300;
                })
                .map((element) => {
                    const rect = element.getBoundingClientRect();
                    return {
                        tag: element.tagName,
                        role: element.getAttribute('role') || '',
                        text: collapseText(element.textContent || '').slice(0, 60),
                        width: Math.round(rect.width),
                        height: Math.round(rect.height),
                        top: Math.round(rect.top),
                        html: element.outerHTML.slice(0, 300)
                    };
                });
            const selects = Array.from(document.querySelectorAll('select')).map((element) => {
                const rect = element.getBoundingClientRect();
                const style = getComputedStyle(element);
                return {
                    optionCount: element.options.length,
                    selectedText: element.options[element.selectedIndex]?.text || '',
                    width: Math.round(rect.width),
                    height: Math.round(rect.height),
                    top: Math.round(rect.top),
                    visible: element.offsetParent !== null,
                    display: style.display,
                    opacity: style.opacity
                };
            });
            const statusCandidates = Array.from(document.querySelectorAll('button, a, div, span'))
                .filter((element) => element instanceof HTMLElement
                    && element.offsetParent !== null
                    && element.getBoundingClientRect().top > headingTop
                    && /completed successfully/i.test(collapseText(element.textContent || '')));
            statusCandidates.sort((a, b) => {
                const rectA = a.getBoundingClientRect();
                const rectB = b.getBoundingClientRect();
                return (rectA.width * rectA.height) - (rectB.width * rectB.height);
            });
            const statusElement = statusCandidates[0] || null;
            const statusTop = statusElement instanceof HTMLElement ? statusElement.getBoundingClientRect().top : Infinity;
            console.log(
                '[MailroomNavigator] filter-toggle anchor not found. Nearby "practice" elements:\n'
                + JSON.stringify(info, null, 2)
            );
            console.log(
                '[MailroomNavigator] all <select> elements on page:\n'
                + JSON.stringify(selects, null, 2)
            );
            console.log(
                '[MailroomNavigator] headingTop=' + headingTop
                + ' statusTop=' + statusTop
                + ' statusElement.tag=' + (statusElement?.tagName || 'none')
                + ' statusElement.html=' + (statusElement ? statusElement.outerHTML.slice(0, 200) : 'none')
            );
        } catch (error) {
            console.log('[MailroomNavigator] filter-toggle anchor debug failed:', error);
        }
    }

    // Walks up from a deeply-nested control (e.g. a <select> inside a fixed-width
    // wrapper with no room to its right) to find the ancestor that is itself a
    // direct child of a flex row. Inserting a sibling after that ancestor lets
    // it flow inline using the row's own gap, instead of wrapping to a new line
    // because the immediate wrapper was already full width.
    function findFlexRowInsertionPoint(element) {
        let node = element;
        while (node && node.parentElement && node.parentElement !== document.body) {
            const parentDisplay = getComputedStyle(node.parentElement).display;
            if (parentDisplay === 'flex' || parentDisplay === 'inline-flex') {
                return node;
            }
            node = node.parentElement;
        }
        return element;
    }

    function attachBotDashboardFilterToggleButton() {
        const existingHost = document.getElementById(BOT_DASHBOARD_FILTER_TOGGLE_HOST_ID);
        if (!isBotDashboardPage()) {
            existingHost?.remove();
            botDashboardAnchorDebugLogged = false;
            return null;
        }

        const anchor = findBotDashboardPracticeDropdownAnchor();
        if (!anchor?.parentElement) {
            existingHost?.remove();
            debugLogBotDashboardDropdownCandidates();
            return null;
        }

        const host = existingHost || document.createElement('div');
        host.id = BOT_DASHBOARD_FILTER_TOGGLE_HOST_ID;
        Object.assign(host.style, {
            display: 'inline-flex',
            alignItems: 'center',
            marginLeft: '10px',
            verticalAlign: 'middle'
        });

        const isActive = hasActiveBotDashboardFilters();
        const isExpanded = loadBotDashboardFilterPanelExpanded();

        let button = host.querySelector('button');
        if (!button) {
            button = createButton({
                label: '',
                color: '#eff6ff',
                title: 'Show or hide the extension\'s practice/job type/status filters',
                onClick: () => {
                    saveBotDashboardFilterPanelExpanded(!loadBotDashboardFilterPanelExpanded());
                    attachBotDashboardPracticeFilterPanel();
                }
            });
            host.appendChild(button);
        }

        button.textContent = isExpanded
            ? 'Hide Filters'
            : `Filters${isActive ? ' (active)' : ''}`;
        Object.assign(button.style, {
            color: isActive ? '#1d4ed8' : '#334155',
            background: isExpanded ? '#dbeafe' : '#eff6ff',
            border: `1px solid ${isActive ? '#93c5fd' : '#cbd5e1'}`,
            borderRadius: '6px',
            padding: '5px 10px',
            fontSize: '12px'
        });

        const insertionPoint = findFlexRowInsertionPoint(anchor);
        if (host.parentElement !== insertionPoint.parentElement || host.previousElementSibling !== insertionPoint) {
            insertionPoint.insertAdjacentElement('afterend', host);
        }

        return host;
    }

    function renderBotDashboardPracticeFilterPanel(host, { force = false } = {}) {
        const practiceCounts = getBotDashboardPracticeCounts();
        const hiddenPractices = loadHiddenBotDashboardPractices();
        const selectedPractices = loadSelectedBotDashboardPractices();
        const practiceMode = loadBotDashboardPracticeMode();
        const effectiveHiddenPractices = getEffectiveHiddenBotDashboardPractices(selectedPractices, hiddenPractices, practiceMode);
        const statusFilterTerm = loadBotDashboardStatusFilterTerm();
        const jobTypeFilterTerm = loadBotDashboardJobTypeFilterTerm();
        const selectedStatuses = loadSelectedBotDashboardStatuses();
        const statusMode = loadBotDashboardStatusMode();
        const selectedJobTypes = loadSelectedBotDashboardJobTypes();
        const jobTypeMode = loadBotDashboardJobTypeMode();
        const statusCounts = getBotDashboardStatusCounts(effectiveHiddenPractices);
        const jobTypeCounts = getBotDashboardJobTypeCounts(effectiveHiddenPractices);
        const practiceSearchTerm = collapseText(host.dataset.practiceSearch || '').toLowerCase();
        const filteredPracticeCounts = practiceCounts.filter((item) => !practiceSearchTerm
            || item.name.toLowerCase().includes(practiceSearchTerm)
            || String(item.odsCode || '').toLowerCase().includes(practiceSearchTerm));
        const statusSearchTerm = collapseText(host.dataset.statusSearch || '').toLowerCase();
        const filteredStatusCounts = statusCounts.filter((item) => !statusSearchTerm || item.label.toLowerCase().includes(statusSearchTerm));
        const jobTypeSearchTerm = collapseText(host.dataset.jobTypeSearch || '').toLowerCase();
        const filteredJobTypeCounts = jobTypeCounts.filter((item) => !jobTypeSearchTerm || item.label.toLowerCase().includes(jobTypeSearchTerm));
        const totalRows = getBotDashboardRowEntries({ visibleOnly: false }).length;
        const visibleRows = getBotDashboardRowEntries({ visibleOnly: true }).length;
        const hiddenRows = Math.max(0, totalRows - visibleRows);
        const signature = JSON.stringify({
            counts: practiceCounts.map((item) => [item.key, item.count]),
            statusCounts: statusCounts.map((item) => [item.label, item.count]),
            jobTypeCounts: jobTypeCounts.map((item) => [item.label, item.count]),
            hidden: [...hiddenPractices].sort(),
            selected: [...selectedPractices].sort(),
            practiceMode,
            selectedStatuses: [...selectedStatuses].sort(),
            statusMode,
            selectedJobTypes: [...selectedJobTypes].sort(),
            jobTypeMode,
            statusFilterTerm,
            jobTypeFilterTerm,
            practiceSearchTerm,
            statusSearchTerm,
            jobTypeSearchTerm
        });
        if (!force && host.dataset.signature === signature && host.childElementCount > 0) return;
        host.dataset.signature = signature;

        host.replaceChildren();
        Object.assign(host.style, {
            margin: '12px 0 14px 0',
            padding: '10px',
            border: '1px solid #d8dee8',
            borderRadius: '8px',
            background: '#f8fafc',
            width: '100%',
            maxWidth: '100%',
            boxSizing: 'border-box',
            fontFamily: 'system-ui, -apple-system, sans-serif',
            color: '#0b2545'
        });

        const topRow = document.createElement('div');
        Object.assign(topRow.style, {
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            flexWrap: 'wrap',
            marginBottom: '8px'
        });

        const title = document.createElement('strong');
        title.textContent = 'Dashboard filters';
        Object.assign(title.style, {
            fontSize: '13px',
            marginRight: '4px'
        });

        const summary = document.createElement('span');
        const activeSelectionSummary = [
            selectedPractices.size ? `${selectedPractices.size} practice${selectedPractices.size === 1 ? '' : 's'}` : '',
            selectedJobTypes.size ? `${selectedJobTypes.size} job type${selectedJobTypes.size === 1 ? '' : 's'}` : '',
            selectedStatuses.size ? `${selectedStatuses.size} status${selectedStatuses.size === 1 ? '' : 'es'}` : ''
        ].filter(Boolean).join(', ');
        summary.textContent = `${visibleRows} visible rows${hiddenRows ? `, ${hiddenRows} hidden` : ''}${activeSelectionSummary ? `, selected ${activeSelectionSummary}` : ''}`;
        Object.assign(summary.style, {
            fontSize: '12px',
            color: '#64748b'
        });

        const clearButton = document.createElement('button');
        clearButton.type = 'button';
        clearButton.textContent = 'Show all';
        clearButton.title = 'Clear hidden-practice, job-type, and status filters';
        Object.assign(clearButton.style, {
            height: '30px',
            border: '1px solid #93c5fd',
            borderRadius: '6px',
            background: '#eff6ff',
            color: '#1d4ed8',
            fontWeight: '700',
            fontSize: '12px',
            padding: '0 10px',
            cursor: 'pointer'
        });
        clearButton.disabled = selectedPractices.size === 0
            && selectedJobTypes.size === 0
            && selectedStatuses.size === 0
            && hiddenPractices.size === 0
            && !statusFilterTerm
            && !jobTypeFilterTerm;
        clearButton.style.opacity = clearButton.disabled ? '0.55' : '1';
        clearButton.addEventListener('click', () => {
            saveHiddenBotDashboardPractices(new Set());
            saveSelectedBotDashboardPractices(new Set());
            saveSelectedBotDashboardJobTypes(new Set());
            saveSelectedBotDashboardStatuses(new Set());
            saveBotDashboardStatusFilterTerm('');
            saveBotDashboardJobTypeFilterTerm('');
            saveBotDashboardPracticeMode('include');
            saveBotDashboardStatusMode('include');
            saveBotDashboardJobTypeMode('include');
            applyBotDashboardPracticeFilters();
            renderBotDashboardPracticeFilterPanel(host, { force: true });
            attachBotDashboardInlinePracticeControls();
            attachBotDashboardPageIssueButton();
        });

        topRow.append(title, summary, clearButton);

        const practiceHeader = document.createElement('div');
        Object.assign(practiceHeader.style, {
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            flexWrap: 'wrap',
            margin: '10px 0 6px 0'
        });
        const practiceTitle = document.createElement('strong');
        practiceTitle.textContent = 'Practice';
        Object.assign(practiceTitle.style, { fontSize: '12px' });
        const practiceSearchInput = document.createElement('input');
        practiceSearchInput.type = 'search';
        practiceSearchInput.placeholder = 'Find practice or ODS';
        practiceSearchInput.value = host.dataset.practiceSearch || '';
        Object.assign(practiceSearchInput.style, {
            minWidth: '150px',
            width: 'min(190px, 100%)',
            flex: '1 1 150px',
            height: '28px',
            border: '1px solid #cbd5e1',
            borderRadius: '6px',
            padding: '0 8px',
            fontSize: '12px',
            marginLeft: 'auto'
        });
        practiceSearchInput.addEventListener('input', () => {
            host.dataset.practiceSearch = practiceSearchInput.value;
            renderBotDashboardPracticeFilterPanel(host, { force: true });
        });
        const practiceModeToggle = makeVisibilityModeToggle({
            mode: practiceMode,
            showTitle: 'Selected practices are shown and other practices are hidden',
            hideTitle: 'Selected practices are hidden and other practices remain visible',
            onToggle: (nextMode) => {
                saveBotDashboardPracticeMode(nextMode);
                saveHiddenBotDashboardPractices(new Set());
                applyBotDashboardPracticeFilters();
                renderBotDashboardPracticeFilterPanel(host, { force: true });
                attachBotDashboardPageIssueButton();
            }
        });
        practiceHeader.append(practiceTitle, practiceModeToggle, practiceSearchInput);

        const practiceSelect = document.createElement('select');
        practiceSelect.multiple = true;
        practiceSelect.size = 6;
        practiceSelect.title = practiceMode === 'exclude'
            ? 'Select one or more practices to hide those practices'
            : 'Select one or more practices to show only those practices';
        Object.assign(practiceSelect.style, {
            width: '100%',
            maxWidth: 'none',
            minHeight: '112px',
            border: '1px solid #cbd5e1',
            borderRadius: '6px',
            padding: '6px',
            fontSize: '12px',
            background: '#fff',
            color: '#0f172a'
        });
        filteredPracticeCounts.forEach((item) => {
            const option = document.createElement('option');
            option.value = item.key;
            option.selected = selectedPractices.has(item.key);
            option.textContent = `${item.name}${item.odsCode ? ` (${item.odsCode})` : ''} - ${item.count}`;
            practiceSelect.appendChild(option);
        });
        bindToggleMultiSelect(practiceSelect, () => {
            const nextSelected = getSelectedValuesFromMultiSelect(practiceSelect);
            saveSelectedBotDashboardPractices(nextSelected);
            saveHiddenBotDashboardPractices(new Set());
            applyBotDashboardPracticeFilters();
            renderBotDashboardPracticeFilterPanel(host, { force: true });
            attachBotDashboardPageIssueButton();
        });

        const practiceHint = document.createElement('div');
        practiceHint.textContent = selectedPractices.size
            ? (practiceMode === 'exclude'
                ? 'Selected practices are hidden. Use Show all to clear.'
                : 'Only selected practices are visible. Use Show all to clear.')
            : (practiceMode === 'exclude'
                ? 'Select one or more practices to hide those jobs.'
                : 'Select one or more practices to show only those jobs.');
        Object.assign(practiceHint.style, {
            marginTop: '4px',
            fontSize: '12px',
            color: '#64748b'
        });

        const filterGrid = document.createElement('div');
        Object.assign(filterGrid.style, {
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 300px), 1fr))',
            gap: '12px',
            alignItems: 'start'
        });

        const makeFilterColumn = (...children) => {
            const column = document.createElement('div');
            Object.assign(column.style, {
                minWidth: '0'
            });
            column.append(...children);
            return column;
        };

        function makeVisibilityModeToggle({ mode, onToggle, showTitle, hideTitle }) {
            const group = document.createElement('div');
            Object.assign(group.style, {
                display: 'inline-flex',
                alignItems: 'center',
                gap: '4px',
                flex: '0 0 auto',
                whiteSpace: 'nowrap'
            });
            const makeModeButton = ({ modeValue, label, title, iconSvg }) => {
                const button = document.createElement('button');
                button.type = 'button';
                const isActive = mode === modeValue;
                button.title = title;
                button.setAttribute('aria-label', title);
                Object.assign(button.style, {
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '5px',
                    height: '26px',
                    border: isActive ? '1px solid #2563eb' : '1px solid #cbd5e1',
                    borderRadius: '999px',
                    background: isActive ? '#eff6ff' : '#fff',
                    color: isActive ? '#1d4ed8' : '#475569',
                    fontWeight: '700',
                    fontSize: '11px',
                    padding: '0 9px',
                    cursor: 'pointer',
                    whiteSpace: 'nowrap'
                });
                const icon = document.createElement('span');
                icon.setAttribute('aria-hidden', 'true');
                icon.innerHTML = iconSvg;
                const labelEl = document.createElement('span');
                labelEl.textContent = label;
                button.append(icon, labelEl);
                button.addEventListener('click', () => {
                    if (mode !== modeValue) onToggle(modeValue);
                });
                return button;
            };
            group.append(
                makeModeButton({
                    modeValue: 'include',
                    label: 'Show only',
                    title: showTitle,
                    iconSvg: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>'
                }),
                makeModeButton({
                    modeValue: 'exclude',
                    label: 'Hide',
                    title: hideTitle,
                    iconSvg: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.9 10.9 0 0 1 12 20C7 20 2.73 16.89 1 12a11.8 11.8 0 0 1 5.06-5.94"></path><path d="M10.58 10.58A2 2 0 0 0 12 14a2 2 0 0 0 1.42-.58"></path><path d="M9.9 4.24A10.8 10.8 0 0 1 12 4c5 0 9.27 3.11 11 8a11.7 11.7 0 0 1-2.16 3.19"></path><path d="M1 1l22 22"></path></svg>'
                })
            );
            return group;
        }

        function getSelectedValuesFromMultiSelect(select) {
            return new Set(Array.from(select.options)
                .filter((option) => option.selected && !option.disabled)
                .map((option) => option.value)
                .filter(Boolean));
        }

        function bindToggleMultiSelect(select, onSelectionChange) {
            select.addEventListener('mousedown', (event) => {
                const option = event.target instanceof HTMLOptionElement
                    ? event.target
                    : event.target?.closest?.('option');
                if (!option || option.disabled) return;
                event.preventDefault();
                option.selected = !option.selected;
                select.focus();
                onSelectionChange(getSelectedValuesFromMultiSelect(select));
            });
            select.addEventListener('change', () => {
                onSelectionChange(getSelectedValuesFromMultiSelect(select));
            });
        }

        const makeSectionHeader = (label, placeholder, datasetKey, rerender) => {
            const header = document.createElement('div');
            Object.assign(header.style, {
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                flexWrap: 'wrap',
                margin: '10px 0 6px 0'
            });
            const sectionTitle = document.createElement('strong');
            sectionTitle.textContent = label;
            Object.assign(sectionTitle.style, {
                fontSize: '12px'
            });
            const chipSearchInput = document.createElement('input');
            chipSearchInput.type = 'search';
            chipSearchInput.placeholder = placeholder;
            chipSearchInput.value = host.dataset[datasetKey] || '';
            Object.assign(chipSearchInput.style, {
                minWidth: '130px',
                width: 'min(180px, 100%)',
                flex: '1 1 130px',
                height: '28px',
                border: '1px solid #cbd5e1',
                borderRadius: '6px',
                padding: '0 8px',
                fontSize: '12px',
                marginLeft: 'auto'
            });
            chipSearchInput.addEventListener('input', () => {
                host.dataset[datasetKey] = chipSearchInput.value;
                rerender();
            });
            header.append(sectionTitle, chipSearchInput);
            return header;
        };

        const makeMultiSelect = ({ items, selectedSet, title, emptyText, onChange, optionText }) => {
            const select = document.createElement('select');
            select.multiple = true;
            select.size = 6;
            select.title = title;
            Object.assign(select.style, {
                width: '100%',
                maxWidth: 'none',
                minHeight: '112px',
                border: '1px solid #cbd5e1',
                borderRadius: '6px',
                padding: '6px',
                fontSize: '12px',
                background: '#fff',
                color: '#0f172a'
            });
            if (!items.length) {
                const option = document.createElement('option');
                option.disabled = true;
                option.textContent = emptyText;
                select.appendChild(option);
                return select;
            }
            items.forEach((item) => {
                const option = document.createElement('option');
                const value = collapseText(item.term || item.label || '').toLowerCase();
                option.value = value;
                option.selected = selectedSet.has(value);
                option.textContent = optionText(item);
                select.appendChild(option);
            });
            bindToggleMultiSelect(select, () => {
                onChange(getSelectedValuesFromMultiSelect(select));
            });
            return select;
        };

        const jobTypeHeader = makeSectionHeader('Job type', 'Find job type chip', 'jobTypeSearch', () => {
            renderBotDashboardPracticeFilterPanel(host, { force: true });
        });
        const jobTypeModeToggle = makeVisibilityModeToggle({
            mode: jobTypeMode,
            showTitle: 'Selected job types are shown and other job types are hidden',
            hideTitle: 'Selected job types are hidden and other job types remain visible',
            onToggle: (nextMode) => {
                saveBotDashboardJobTypeMode(nextMode);
                applyBotDashboardPracticeFilters();
                renderBotDashboardPracticeFilterPanel(host, { force: true });
                attachBotDashboardPageIssueButton();
            }
        });
        jobTypeHeader.insertBefore(jobTypeModeToggle, jobTypeHeader.querySelector('input'));

        const jobTypeSelect = makeMultiSelect({
            items: filteredJobTypeCounts,
            selectedSet: selectedJobTypes,
            title: jobTypeMode === 'exclude'
                ? 'Select one or more job types to hide those rows'
                : 'Select one or more job types to show only those rows',
            emptyText: 'No job types from visible practices.',
            optionText: (item) => `${item.label} - ${item.count}`,
            onChange: (nextSelected) => {
                saveSelectedBotDashboardJobTypes(nextSelected);
                saveBotDashboardJobTypeFilterTerm('');
                applyBotDashboardPracticeFilters();
                renderBotDashboardPracticeFilterPanel(host, { force: true });
                attachBotDashboardPageIssueButton();
            }
        });

        const jobTypeHint = document.createElement('div');
        jobTypeHint.textContent = selectedJobTypes.size
            ? (jobTypeMode === 'exclude'
                ? 'Selected job types are hidden. Use Show all to clear.'
                : 'Only selected job types are visible. Use Show all to clear.')
            : (jobTypeMode === 'exclude'
                ? 'Select one or more job types to hide those rows.'
                : 'Select one or more job types to show only those rows.');
        Object.assign(jobTypeHint.style, {
            marginTop: '4px',
            fontSize: '12px',
            color: '#64748b'
        });

        const statusHeader = makeSectionHeader('Status / attempts', 'Find status chip', 'statusSearch', () => {
            renderBotDashboardPracticeFilterPanel(host, { force: true });
        });
        const statusModeToggle = makeVisibilityModeToggle({
            mode: statusMode,
            showTitle: 'Selected statuses are shown and other statuses are hidden',
            hideTitle: 'Selected statuses are hidden and other statuses remain visible',
            onToggle: (nextMode) => {
                saveBotDashboardStatusMode(nextMode);
                applyBotDashboardPracticeFilters();
                renderBotDashboardPracticeFilterPanel(host, { force: true });
                attachBotDashboardPageIssueButton();
            }
        });
        statusHeader.insertBefore(statusModeToggle, statusHeader.querySelector('input'));

        const statusSelect = makeMultiSelect({
            items: filteredStatusCounts,
            selectedSet: selectedStatuses,
            title: statusMode === 'exclude'
                ? 'Select one or more statuses/attempt values to hide those rows'
                : 'Select one or more statuses/attempt values to show only those rows',
            emptyText: 'No status values from visible practices.',
            optionText: (item) => `${item.label.length > 96 ? `${item.label.slice(0, 96)}...` : item.label} - ${item.count}`,
            onChange: (nextSelected) => {
                saveSelectedBotDashboardStatuses(nextSelected);
                saveBotDashboardStatusFilterTerm('');
                applyBotDashboardPracticeFilters();
                renderBotDashboardPracticeFilterPanel(host, { force: true });
                attachBotDashboardPageIssueButton();
            }
        });

        const statusHint = document.createElement('div');
        statusHint.textContent = selectedStatuses.size
            ? (statusMode === 'exclude'
                ? 'Selected statuses/attempt values are hidden. Use Show all to clear.'
                : 'Only selected statuses/attempt values are visible. Use Show all to clear.')
            : (statusMode === 'exclude'
                ? 'Select one or more statuses or attempt values to hide those rows.'
                : 'Select one or more statuses or attempt values to show only those rows.');
        Object.assign(statusHint.style, {
            marginTop: '4px',
            fontSize: '12px',
            color: '#64748b'
        });

        filterGrid.append(
            makeFilterColumn(practiceHeader, practiceSelect, practiceHint),
            makeFilterColumn(jobTypeHeader, jobTypeSelect, jobTypeHint),
            makeFilterColumn(statusHeader, statusSelect, statusHint)
        );
        host.append(topRow, filterGrid);
    }

    function attachBotDashboardPracticeFilterPanel() {
        const existingHost = document.getElementById(BOT_DASHBOARD_PRACTICE_FILTER_HOST_ID);
        if (!isBotDashboardPage()) {
            existingHost?.remove();
            updateBotDashboardFilterLock(false);
            document.getElementById(BOT_DASHBOARD_FILTER_TOGGLE_HOST_ID)?.remove();
            return;
        }

        applyBotDashboardPracticeFilters();

        // The full panel is tall (search boxes + scrollable lists per filter),
        // so by default it stays collapsed behind a small toggle placed next to
        // the page's own practice dropdown. If that dropdown can't be found,
        // fail open (always show the panel) rather than hiding filters with no
        // way to reach them.
        const toggleHost = attachBotDashboardFilterToggleButton();
        const shouldShowPanel = !toggleHost || loadBotDashboardFilterPanelExpanded();
        if (!shouldShowPanel) {
            existingHost?.remove();
            return;
        }

        const placement = findBotDashboardPracticeFilterPlacement();
        if (!placement?.parent) {
            existingHost?.remove();
            return;
        }

        const host = existingHost || document.createElement('div');
        host.id = BOT_DASHBOARD_PRACTICE_FILTER_HOST_ID;
        renderBotDashboardPracticeFilterPanel(host);

        const desiredNextSibling = placement.before || placement.after?.nextSibling || null;
        if (host.parentElement !== placement.parent || host.nextSibling !== desiredNextSibling) {
            placement.parent.insertBefore(host, desiredNextSibling);
        }
    }

    function findBotDashboardPageIssueAnchor() {
        const headings = Array.from(document.querySelectorAll('h1, h2, h3, [role="heading"]'));
        return headings.find((element) => /bot jobs dashboard/i.test(collapseText(element.textContent || ''))) || null;
    }

    function attachBotDashboardPageIssueButton() {
        const existingHost = document.getElementById(BOT_DASHBOARD_PAGE_ISSUE_HOST_ID);
        if (!isBotDashboardPage() || !canUseLinearIssueAction()) {
            existingHost?.remove();
            return;
        }

        const anchor = findBotDashboardPageIssueAnchor();
        if (!anchor?.parentElement) {
            existingHost?.remove();
            return;
        }

        const host = existingHost || document.createElement('div');
        host.id = BOT_DASHBOARD_PAGE_ISSUE_HOST_ID;
        const anchorParent = anchor.parentElement;
        if (anchorParent && getComputedStyle(anchorParent).position === 'static') {
            anchorParent.style.position = 'relative';
        }
        Object.assign(host.style, {
            display: 'inline-flex',
            alignItems: 'center',
            position: 'absolute',
            top: '0',
            right: '0',
            zIndex: '5'
        });

        let button = host.querySelector('button');
        if (!button) {
            button = createButton({
                label: 'Issue Page',
                color: '#2563eb',
                title: 'Create Linear issues from selected bot job rows, or the visible page if none are selected',
                onClick: (btn) => {
                    const { rows, selectedOnly } = getBotDashboardIssueRows();
                    const payloads = buildCurrentPageIssuePayloads(rows);
                    if (!payloads.length) {
                        showNavigatorToast(
                            selectedOnly
                                ? 'No selected bot job rows could be read.'
                                : 'No visible bot job rows found on this page.',
                            'invalid'
                        );
                        return;
                    }
                    handleCreateIssuesWithPayloads(btn, payloads).catch(() => undefined);
                }
            });
            Object.assign(button.style, {
                padding: '7px 12px',
                borderRadius: '8px',
                fontSize: '12px',
                lineHeight: '1.1',
                minHeight: '34px',
                boxShadow: '0 1px 3px rgba(15, 23, 42, 0.16)'
            });
            host.appendChild(button);
        }

        const visibleCount = getVisibleBotDashboardRows().length;
        const selectedCount = getSelectedBotDashboardRows().length;
        button.title = selectedCount
            ? `Create practice/job spike issues or single failures from ${selectedCount} selected bot job row${selectedCount === 1 ? '' : 's'} only`
            : `Create practice/job spike issues or single failures from ${visibleCount || 'the'} visible bot job row${visibleCount === 1 ? '' : 's'} only`;

        if (host.parentElement !== anchorParent) {
            anchorParent.appendChild(host);
        }
    }

    function findPreparingIssueButtonAnchor() {
        return document.querySelector('table') || document.body;
    }

    function attachPreparingOver3hIssueButton() {
        const existingHost = document.getElementById(PREPARING_OVER_3H_ISSUE_HOST_ID);
        if (!isPreparingMailroomPage() || !canUseLinearIssueAction()) {
            existingHost?.remove();
            return;
        }

        const anchor = findPreparingIssueButtonAnchor();
        if (!anchor?.parentElement) {
            existingHost?.remove();
            return;
        }

        const host = existingHost || document.createElement('div');
        host.id = PREPARING_OVER_3H_ISSUE_HOST_ID;
        Object.assign(host.style, {
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            margin: '10px 0',
            padding: '0 0 4px 0'
        });

        let button = host.querySelector('button');
        if (!button) {
            button = createButton({
                label: 'Issue >3h',
                color: '#2563eb',
                title: 'Create one Linear issue for visible Preparing letters with Time Spent over 3 hours',
                onClick: (btn) => {
                    const matches = getVisiblePreparingRowsOverThreshold(180);
                    const payload = buildPreparingOver3hIssuePayload(matches);
                    if (!payload) {
                        showNavigatorToast('No visible Preparing rows have Time Spent over 3 hours.', 'invalid');
                        return;
                    }
                    handleCreateIssueWithPayload(btn, payload).catch(() => undefined);
                }
            });
            Object.assign(button.style, {
                padding: '8px 12px',
                borderRadius: '8px',
                fontSize: '12px',
                lineHeight: '1.1',
                minHeight: '36px',
                boxShadow: '0 1px 3px rgba(15, 23, 42, 0.16)'
            });
            host.appendChild(button);
        }

        const matchCount = getVisiblePreparingRowsOverThreshold(180).length;
        button.title = `Create one Linear issue for ${matchCount || 'visible'} Preparing row${matchCount === 1 ? '' : 's'} with Time Spent over 3 hours`;

        if (!host.parentElement) {
            anchor.parentElement.insertBefore(host, anchor);
        }
    }

    function attachDocListeners() {
        const items = document.querySelectorAll('td:nth-child(2) a, td:first-child a, td:first-child span, td:first-child div, a[href*="document_id="]');
        items.forEach(el => {
            if (el.dataset.blNavReady) return;
            const text = el.textContent.trim();
            if (!/^\d{6,9}$/.test(text)) return;

            el.dataset.blNavReady = 'true';
            el.style.borderBottom = '1px dotted #007bff';
            el.addEventListener('mouseenter', () => showDocPanel(el));
            el.addEventListener('mouseleave', () => hideDocPanel());
        });
    }

    function extractUuidsFromText(text) {
        const matches = String(text || '').match(UUID_PATTERN) || [];
        const seen = new Set();
        const uuids = [];
        matches.forEach((match) => {
            const normalized = match.toLowerCase();
            if (seen.has(normalized)) return;
            seen.add(normalized);
            uuids.push(normalized);
        });
        return uuids;
    }

    function persistUuidBatchResults(items) {
        try {
            chrome.storage.local.set({
                [UUID_BATCH_RESULTS_STORAGE_KEY]: {
                    checkedAt: new Date().toISOString(),
                    items
                }
            });
        } catch (error) {
            // Ignore: syncing to the sidebar panel is a nice-to-have, not
            // required for the check itself to run.
        }
    }

    // No on-page popup: results are checked here but only ever displayed in
    // the sidebar/floating panel's UUID Lookup section (synced via
    // chrome.storage). A bottom-right status pill (reusing the same one the
    // bulk-select feature uses) gives progress feedback, since it stays
    // visible regardless of mouse position — unlike the hover meta-panel,
    // which hides as soon as you move the mouse away from the cell.
    async function runUuidBatchCheck(uuids) {
        const batchItems = uuids.map((uuid) => ({ uuid, error: null, result: null }));
        persistUuidBatchResults(batchItems);

        const requestSeq = ++uuidBatchCheckRequestSeq;
        let completed = 0;
        let nextIndex = 0;
        setBotDashboardBulkStatus(`Checking ${completed} / ${uuids.length} UUIDs...`);

        async function checkOne(uuid, itemIndex) {
            try {
                // The lookup runs a real SQL query through the local
                // trigger service's Cloud SQL Proxy connection, which can
                // legitimately take up to UUID_LOOKUP_TRIGGER_SERVER_TIMEOUT_MS
                // (26s) server-side, so this client-side timeout must stay
                // comfortably above that or slow-but-successful lookups get
                // reported as failed.
                const response = await sendRuntimeMessage({
                    action: 'lookupUuidStatus',
                    payload: { uuid }
                }, { timeoutMs: 30000 });
                if (requestSeq !== uuidBatchCheckRequestSeq) return;
                if (!response?.success) {
                    const error = collapseText(response?.error) || 'Lookup failed';
                    batchItems[itemIndex] = { uuid, error, result: null };
                } else {
                    batchItems[itemIndex] = { uuid, error: null, result: response.result };
                }
            } catch (error) {
                if (requestSeq !== uuidBatchCheckRequestSeq) return;
                const message = collapseText(error?.message) || 'Lookup failed';
                batchItems[itemIndex] = { uuid, error: message, result: null };
            }
            if (requestSeq !== uuidBatchCheckRequestSeq) return;
            completed += 1;
            setBotDashboardBulkStatus(`Checking ${completed} / ${uuids.length} UUIDs...`);
            persistUuidBatchResults(batchItems);
        }

        async function worker() {
            while (nextIndex < uuids.length) {
                if (requestSeq !== uuidBatchCheckRequestSeq) return;
                const index = nextIndex;
                nextIndex += 1;
                await checkOne(uuids[index], index);
            }
        }

        // The local trigger service's SQL pool caps out at 2 concurrent
        // connections (see automation/linear-trigger-server.mjs), so 2
        // workers fully uses that capacity without queuing requests behind
        // it for no benefit — this doubles throughput over strictly
        // sequential lookups.
        const workerCount = Math.min(2, uuids.length);
        await Promise.all(Array.from({ length: workerCount }, () => worker()));

        if (requestSeq !== uuidBatchCheckRequestSeq) return;
        setBotDashboardBulkStatus(`Checked ${uuids.length} UUID${uuids.length === 1 ? '' : 's'} — see the sidebar panel for results.`);
        window.setTimeout(() => {
            if (requestSeq === uuidBatchCheckRequestSeq) setBotDashboardBulkStatus('');
        }, 3500);
    }

    function makeUuidBatchCheckAction(rowData) {
        const uuids = extractUuidsFromText(rowData?.status);
        if (!uuids.length) return null;

        const label = `Check ${uuids.length} UUID${uuids.length === 1 ? '' : 's'}`;
        return createButton({
            icon: `${LINK_ICON_SVG}<span>${label}</span>`,
            color: '#6f42c1',
            title: `Look up document status for ${uuids.length} UUID${uuids.length === 1 ? '' : 's'} found in this status message`,
            onClick: () => runUuidBatchCheck(uuids)
        });
    }

    function attachMetaListeners() {
        const rows = document.querySelectorAll('table tbody tr');
        rows.forEach(row => {
            if (row.dataset.blMetaBound === 'true') return;

            const cells = Array.from(row.querySelectorAll('td'));
            if (!cells.length) return;

            const headerMap = resolveHeaderMap(row.closest('table'));
            if (!headerMap) return;

            const bindCell = (key, builder) => {
                const idx = headerMap[key];
                if (typeof idx !== 'number' || !cells[idx]) return;
                const cell = cells[idx];
                const label = key === 'jobType' ? 'job type' : key;

                cell.dataset.blMetaAction = 'true';
                cell.style.borderBottom = '1px dotted #6c757d';
                cell.addEventListener('mouseenter', () => {
                    // Anchor to a fixed spot on the cell (its top) rather than
                    // the pointer's entry position: on tall multi-line cells
                    // (e.g. long Status error text), pointer-based anchoring
                    // made the action buttons jump around distractingly as
                    // the mouse moved over different lines of text.
                    scheduleMetaPanelForCell(cell, builder, label, null, null);
                });
                cell.addEventListener('mouseleave', () => hideMetaPanel());
            };

            bindCell('jobType', (rowData) => {
                const actions = [makeCopyAction(rowData.jobType, { title: 'Copy job type', icon: COPY_ICON_SVG })];
                if (
                    !rowData.document
                    && rowData.sourceKind === 'bot_dashboard'
                    && canUseLinearIssueAction()
                ) {
                    actions.unshift(makeCreateIssueAction(rowData));
                }
                return actions;
            });
            bindCell('practice', (rowData) => {
                const actions = [];
                if (rowData.practiceName) {
                    actions.push(makeCopyAction(rowData.practiceName, {
                        title: 'Copy practice name',
                        icon: `${COPY_ICON_SVG}<span>Practice</span>`
                    }));
                }
                if (rowData.odsCode) {
                    actions.push(makeCopyAction(rowData.odsCode, {
                        title: 'Copy ODS code',
                        icon: `${COPY_ICON_SVG}<span>ODS</span>`
                    }));
                }
                if (rowData.odsCode) {
                    const docmanLoginAction = makeDocmanLoginAction(rowData);
                    if (docmanLoginAction) actions.push(docmanLoginAction);
                    actions.push(makePracticeEhrAction(rowData.odsCode));
                }
                return actions;
            });
            bindCell('jobId', (rowData) => {
                const jobUrl = getJobUrl(rowData.jobId);
                const actions = [makeCopyAction(rowData.jobId, 'job ID')];
                if (
                    !rowData.document
                    && rowData.sourceKind === 'bot_dashboard'
                    && canUseLinearIssueAction()
                ) {
                    actions.unshift(makeCreateIssueAction(rowData));
                }
                if (jobUrl) {
                    actions.push(makeCopyAction(jobUrl, {
                        title: 'Copy job link',
                        icon: `${LINK_ICON_SVG}<span>Link</span>`
                    }));
                }
                return actions;
            });
            bindCell('added', (rowData) => [makeCopyAction(rowData.added, 'added date')]);
            bindCell('status', (rowData) => {
                const actions = [makeCopyAction(rowData.status, 'status')];
                const uuidCheckAction = makeUuidBatchCheckAction(rowData);
                if (uuidCheckAction) actions.push(uuidCheckAction);
                return actions;
            });

            row.dataset.blMetaBound = 'true';
        });
    }

    function attachListeners() {
        attachDocListeners();
        attachMetaListeners();
        attachRejectedPracticeIssueButton();
        attachBotDashboardSelectionGuard();
        attachBotDashboardPracticeFilterPanel();
        attachBotDashboardInlinePracticeControls();
        attachBotDashboardPageIssueButton();
        attachPreparingOver3hIssueButton();
    }

    function scheduleAttachListeners() {
        invalidateBotDashboardRowCache();
        if (botDashboardBulkSelecting) {
            botDashboardBulkRefreshPending = true;
            return;
        }
        if (attachListenersTimer) return;
        const delay = isBotDashboardPage() && hasActiveBotDashboardFilters() ? 80 : 120;
        attachListenersTimer = window.setTimeout(() => {
            attachListenersTimer = null;
            attachListeners();
        }, delay);
    }

    const observer = new MutationObserver(() => scheduleAttachListeners());

    async function init() {
        if (listenersStarted) return;
        listenersStarted = true;
        observer.observe(document.body, { childList: true, subtree: true });
        attachListeners();
        ensureRestrictedToolsAccess(true)
            .then(() => {
                if (floatingNavPanel) createFloatingDocPanel();
                attachListeners();
            })
            .catch(() => undefined);
    }

    init().catch(() => undefined);
})();
