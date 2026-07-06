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
    const BOT_JOB_TITLE_PREFIX = 'Bot Job Error:';
    const PRACTICE_SUPPORT_TITLE_PREFIX = 'Practice Support Ticket:';
    const BOT_JOB_DEFAULT_PRIORITY = 3;
    const BOT_JOB_ISSUE_TYPE_LABEL = 'Stuck Letters';
    const BOT_JOB_LETTER_STAGE_LABELS = {
        docman_rejection: 'Bot Job/ docman_rejection',
        docman_import: 'Bot Job/docman_import',
        emis_api_consultation: 'Bot Job/emis_api_consultation',
        generate_output: 'Bot job/generate_output',
        docman_review: 'Bot job/ docman_review',
        docman_delete_original: 'Bot Job/docman_delete_originals',
        docman_file: 'Bot job/ docman_file'
    };
    const STUCK_LETTERS_PREPARING_LABEL = 'Stuck letters - Preparing';
    const STUCK_LETTERS_BOT_JOBS_LABEL = 'Stuck letters - Bot jobs';
    const REJECTED_QUEUE_LABELS = ['Rejection', 'Monitoring / Reporting'];
    const HIDDEN_DEDUPE_PREFIX = 'BOT_JOBS_DEDUPE:';
    const GROUP_DEDUPE_PREFIX = 'BOT_JOBS_GROUP:';
    const REJECTED_PRACTICE_ISSUE_HOST_ID = 'bl-rejected-practice-issue-host';
    const BOT_DASHBOARD_PAGE_ISSUE_HOST_ID = 'bl-bot-dashboard-page-issue-host';
    const BOT_DASHBOARD_PRACTICE_FILTER_HOST_ID = 'bl-bot-dashboard-practice-filter-host';
    const PREPARING_OVER_3H_ISSUE_HOST_ID = 'bl-preparing-over-3h-issue-host';
    const COPY_ICON_SVG = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
    const LINK_ICON_SVG = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.07 0l2.83-2.83a5 5 0 1 0-7.07-7.07L11 4"></path><path d="M14 11a5 5 0 0 0-7.07 0L4.1 13.83a5 5 0 0 0 7.07 7.07L13 19"></path></svg>';

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

    function normalizeGroupKeyPart(value) {
        return collapseText(value).toLowerCase();
    }

    function computeDedupeKey(row) {
        const fingerprint = normalizeFingerprint(row?.status_text);
        if (row?.job_id) return { kind: 'job_id', key: row.job_id, fingerprint };
        if (row?.document_id && row?.job_type) {
            return { kind: 'doc_job_fp', key: `${row.document_id}|${row.job_type}|${fingerprint}`, fingerprint };
        }
        if (row?.practice_name && row?.job_type) {
            return { kind: 'practice_job_fp', key: `${row.practice_name}|${row.job_type}|${fingerprint}`, fingerprint };
        }
        return { kind: 'fallback', key: fingerprint, fingerprint };
    }

    function computePracticeGroupKey(row, dedupeKey = null) {
        const practice = normalizeGroupKeyPart(row?.practice_name);
        const jobType = normalizeGroupKeyPart(row?.job_type);
        const fingerprint = normalizeGroupKeyPart(dedupeKey?.fingerprint || normalizeFingerprint(row?.status_text));
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

    function inferEhrLabel(jobType) {
        const normalized = String(jobType || '').toLowerCase();
        if (normalized.includes('docman')) return 'Docman';
        if (normalized.includes('emis')) return 'Emis';
        if (normalized.includes('sys1') || normalized.includes('systemone')) return 'Sys1';
        return '';
    }

    function inferIssueTypeLabel(row) {
        return String(row?.job_type || '').toLowerCase() === 'docman_import'
            ? 'Collection'
            : 'Stuck letters / Manual intervention';
    }

    function inferSupportTypeLabel(row) {
        const status = String(row?.status_text || '').toLowerCase();
        if (
            status.includes('traceback') ||
            status.includes('nonetype') ||
            status.includes('exception') ||
            status.includes('attribute')
        ) {
            return 'Engineering';
        }
        if (status.includes('unknown') || status.includes('still erroring')) {
            return 'Investigation';
        }
        return 'Technical';
    }

    function inferLetterStageLabel(row) {
        const jobType = String(row?.job_type || '').toLowerCase();
        if (jobType.startsWith('emis_') || jobType.includes('generate_output')) return 'Coding/Coding';
        if (jobType === 'docman_import') return '';
        if (jobType.startsWith('docman_')) return 'Coding/Filing';
        if (jobType.includes('ocr')) return 'Preparing/OCR';
        return '';
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

    function buildLabels(row) {
        const labels = [];
        const ehr = inferEhrLabel(row?.job_type);
        if (ehr) labels.push(ehr);
        labels.push(inferIssueTypeLabel(row));
        labels.push(inferSupportTypeLabel(row));
        const stage = inferLetterStageLabel(row);
        if (stage) labels.push(stage);
        return [...new Set(labels.filter(Boolean))];
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

    function getStuckLettersLinearLabelForCurrentPage() {
        const path = String(window.location.pathname || '');
        if (path.includes('/mailroom/preparing')) return STUCK_LETTERS_PREPARING_LABEL;
        if (path.includes('/admin_panel/bots/dashboard')) return STUCK_LETTERS_BOT_JOBS_LABEL;
        return '';
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
        if (row?.document_id) return row.document_id;
        if (String(row?.job_type || '').toLowerCase() === 'docman_import') return 'collection-error';
        return 'unknown-document-id';
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

    function getBotDashboardStatusFilterStorageKey() {
        const pageKey = `${window.location.pathname}${window.location.search}`;
        return `blBotDashboardStatusFilter:${pageKey}`;
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

    function loadBotDashboardStatusFilterTerm() {
        try {
            return collapseText(window.sessionStorage.getItem(getBotDashboardStatusFilterStorageKey()) || '');
        } catch {
            return '';
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

    function getBotDashboardStatusHaystack(entry) {
        return collapseText([
            entry?.botJobRow?.status_text,
            entry?.botJobRow?.attempts_count ? `${entry.botJobRow.attempts_count} attempts` : '',
            entry?.rowData?.status,
            entry?.rowData?.row?.innerText
        ].filter(Boolean).join(' ')).toLowerCase();
    }

    function getBotDashboardRowEntries({ visibleOnly = false } = {}) {
        if (!isBotDashboardPage()) return [];
        return Array.from(document.querySelectorAll('table tbody tr'))
            .filter((row) => row instanceof HTMLElement)
            .filter((row) => !visibleOnly || row.offsetParent !== null)
            .map((row) => {
                const rowData = getRowDataFromElement(row.querySelector('td') || row);
                const botJobRow = buildBotJobRowFromRowData(rowData);
                const practiceName = collapseText(botJobRow?.practice_name || rowData?.practiceName || rowData?.practice || '');
                return {
                    row,
                    rowData,
                    botJobRow,
                    practiceName,
                    normalizedPracticeName: normalizePracticeFilterName(practiceName)
                };
            })
            .filter((entry) => entry.botJobRow && entry.practiceName);
    }

    function getBotDashboardPracticeCounts() {
        const counts = new Map();
        getBotDashboardRowEntries({ visibleOnly: false }).forEach((entry) => {
            const key = entry.normalizedPracticeName;
            if (!key) return;
            const existing = counts.get(key) || { name: entry.practiceName, count: 0 };
            existing.count += 1;
            counts.set(key, existing);
        });
        return [...counts.entries()]
            .map(([key, value]) => ({ key, ...value }))
            .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
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

    function applyBotDashboardPracticeFilters() {
        if (!isBotDashboardPage()) return;
        const hiddenPractices = loadHiddenBotDashboardPractices();
        const statusTerm = loadBotDashboardStatusFilterTerm().toLowerCase();
        getBotDashboardRowEntries({ visibleOnly: false }).forEach((entry) => {
            const hiddenByPractice = hiddenPractices.has(entry.normalizedPracticeName);
            const hiddenByStatus = Boolean(statusTerm) && !getBotDashboardStatusHaystack(entry).includes(statusTerm);
            const shouldHide = hiddenByPractice || hiddenByStatus;
            entry.row.style.display = shouldHide ? 'none' : '';
            entry.row.dataset.blPracticeHidden = shouldHide ? 'true' : 'false';
            entry.row.dataset.blStatusHidden = hiddenByStatus ? 'true' : 'false';
            if (shouldHide) {
                const checkbox = entry.row.querySelector('input[type="checkbox"]');
                if (checkbox) checkbox.checked = false;
            }
        });
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
        const dedupeKey = `bot_dashboard_practice_job_spike|${firstGroupKey}`;
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

    function hasRestrictedFeature(featureKey) {
        return Boolean(restrictedToolsAccess?.features?.[featureKey]);
    }

    function canUseLinearIssueAction() {
        if (restrictedToolsAccess?.serverlessLiteMode) return false;
        return true;
    }

    function canUseNavigatorClipboardApi() {
        try {
            const protocol = String(globalThis?.location?.protocol || '').toLowerCase();
            return protocol === 'chrome-extension:' || protocol === 'moz-extension:';
        } catch (error) {
            return false;
        }
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
        const existingIssue = dedupeKey ? createdIssueByDedupeKey.get(dedupeKey) : null;
        if (existingIssue?.identifier) {
            btn.textContent = String(existingIssue.identifier);
            btn.style.background = '#0f766e';
            if (existingIssue.url) openUrlInNewTab(existingIssue.url);
            setTimeout(() => {
                btn.textContent = originalLabel;
                btn.style.background = originalBg;
            }, 1500);
            return;
        }

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
                const reason = collapseText(response?.error || response || 'Could not create issue.');
                throw new Error(reason);
            }

            if (dedupeKey) {
                createdIssueByDedupeKey.set(dedupeKey, {
                    identifier: String(response.issue.identifier || ''),
                    url: collapseText(response.issue.url || '')
                });
            }
            btn.textContent = String(response.issue.identifier || 'Created');
            btn.style.background = '#16a34a';
            showNavigatorToast(
                response?.duplicate
                    ? `Using existing ${String(response.issue.identifier || 'issue')}.`
                    : `Created ${String(response.issue.identifier || 'issue')}.`,
                'valid'
            );
            setTimeout(() => {
                btn.textContent = originalLabel;
                btn.style.background = originalBg;
                btn.disabled = false;
            }, 1800);
        } catch (error) {
            const failureMessage = collapseText(error?.message || 'Could not create issue.');
            btn.textContent = 'Failed';
            btn.style.background = '#dc2626';
            btn.title = failureMessage;
            showNavigatorToast(failureMessage, 'invalid');
            console.warn(`[BL Navigator] Issue creation failed: ${failureMessage}`);
            console.debug('[BL Navigator] Issue creation failure details.', { payload, error: failureMessage });
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
        const existingIssue = dedupeKey ? createdIssueByDedupeKey.get(dedupeKey) : null;
        if (existingIssue?.identifier) {
            return { duplicate: true, issue: existingIssue };
        }

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
            const reason = collapseText(response?.error || 'Could not create issue.');
            throw new Error(reason);
        }

        if (dedupeKey) {
            createdIssueByDedupeKey.set(dedupeKey, {
                identifier: String(response.issue.identifier || ''),
                url: collapseText(response.issue.url || '')
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
        const failed = [];

        try {
            for (let index = 0; index < queue.length; index += 1) {
                btn.textContent = `Creating ${index + 1}/${queue.length}`;
                try {
                    const response = await createLinearIssueFromPayload(queue[index]);
                    created.push(response?.issue?.identifier || 'issue');
                } catch (error) {
                    failed.push(collapseText(error?.message || 'Could not create issue.'));
                }
            }

            if (created.length > 0 && failed.length === 0) {
                btn.textContent = created.length === 1 ? String(created[0]) : `Created ${created.length}`;
                btn.style.background = '#16a34a';
                showNavigatorToast(
                    created.length === 1
                        ? `Created ${created[0]}.`
                        : `Created ${created.length} Linear issues.`,
                    'valid'
                );
                return;
            }

            if (created.length > 0 && failed.length > 0) {
                btn.textContent = `${created.length}/${queue.length}`;
                btn.style.background = '#f59e0b';
                showNavigatorToast(`Created ${created.length}; failed ${failed.length}: ${failed[0]}`, 'invalid');
                return;
            }

            throw new Error(failed[0] || 'Could not create any issues.');
        } catch (error) {
            const failureMessage = collapseText(error?.message || 'Could not create issues.');
            btn.textContent = 'Failed';
            btn.style.background = '#dc2626';
            btn.title = failureMessage;
            showNavigatorToast(failureMessage, 'invalid');
            console.warn('[BL Navigator] Page issue creation failed.', { payloads: queue, error: failureMessage });
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

    function getAnchorElementFromPointerEvent(cell, event) {
        if (!(cell instanceof Element)) return null;

        if (event && Number.isFinite(event.clientX) && Number.isFinite(event.clientY)) {
            const pointed = document.elementFromPoint(event.clientX, event.clientY);
            if (pointed instanceof Element && cell.contains(pointed)) {
                const interactive = pointed.closest('a, button, [role="button"]');
                if (interactive && cell.contains(interactive)) return interactive;
                return pointed;
            }
        }

        const hovered = Array.from(cell.querySelectorAll(':hover')).pop();
        if (hovered instanceof Element) {
            const interactive = hovered.closest('a, button, [role="button"]');
            if (interactive && cell.contains(interactive)) return interactive;
            return hovered;
        }

        return cell;
    }

    function getAnchorPointFromPointerEvent(event) {
        if (!event) return null;
        if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return null;
        return { clientX: event.clientX, clientY: event.clientY };
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

    function findBotDashboardPracticeFilterAnchor() {
        return document.querySelector('table') || findBotDashboardPageIssueAnchor();
    }

    function renderBotDashboardPracticeFilterPanel(host, { force = false } = {}) {
        const practiceCounts = getBotDashboardPracticeCounts();
        const hiddenPractices = loadHiddenBotDashboardPractices();
        const statusFilterTerm = loadBotDashboardStatusFilterTerm();
        const statusCounts = getBotDashboardStatusCounts(hiddenPractices);
        const searchTerm = collapseText(host.dataset.search || '').toLowerCase();
        const filteredCounts = practiceCounts.filter((item) => !searchTerm || item.name.toLowerCase().includes(searchTerm));
        const statusSearchTerm = collapseText(host.dataset.statusSearch || '').toLowerCase();
        const filteredStatusCounts = statusCounts.filter((item) => !statusSearchTerm || item.label.toLowerCase().includes(statusSearchTerm));
        const totalRows = getBotDashboardRowEntries({ visibleOnly: false }).length;
        const visibleRows = getBotDashboardRowEntries({ visibleOnly: true }).length;
        const hiddenRows = Math.max(0, totalRows - visibleRows);
        const signature = JSON.stringify({
            counts: practiceCounts.map((item) => [item.key, item.count]),
            statusCounts: statusCounts.map((item) => [item.label, item.count]),
            hidden: [...hiddenPractices].sort(),
            statusFilterTerm,
            searchTerm,
            statusSearchTerm
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
            maxWidth: '860px',
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
        summary.textContent = `${visibleRows} visible rows${hiddenRows ? `, ${hiddenRows} hidden` : ''}`;
        Object.assign(summary.style, {
            fontSize: '12px',
            color: '#64748b'
        });

        const searchInput = document.createElement('input');
        searchInput.type = 'search';
        searchInput.placeholder = 'Find practice';
        searchInput.value = host.dataset.search || '';
        Object.assign(searchInput.style, {
            minWidth: '180px',
            height: '30px',
            border: '1px solid #cbd5e1',
            borderRadius: '6px',
            padding: '0 8px',
            fontSize: '12px',
            marginLeft: 'auto'
        });
        searchInput.addEventListener('input', () => {
            host.dataset.search = searchInput.value;
            renderBotDashboardPracticeFilterPanel(host, { force: true });
        });

        const statusInput = document.createElement('input');
        statusInput.type = 'search';
        statusInput.placeholder = 'Status or attempts';
        statusInput.value = statusFilterTerm;
        Object.assign(statusInput.style, {
            minWidth: '180px',
            height: '30px',
            border: '1px solid #cbd5e1',
            borderRadius: '6px',
            padding: '0 8px',
            fontSize: '12px'
        });
        statusInput.addEventListener('input', () => {
            saveBotDashboardStatusFilterTerm(statusInput.value);
            applyBotDashboardPracticeFilters();
            const nextVisibleRows = getBotDashboardRowEntries({ visibleOnly: true }).length;
            const nextHiddenRows = Math.max(0, totalRows - nextVisibleRows);
            summary.textContent = `${nextVisibleRows} visible rows${nextHiddenRows ? `, ${nextHiddenRows} hidden` : ''}`;
            clearButton.disabled = hiddenPractices.size === 0 && !collapseText(statusInput.value);
            clearButton.style.opacity = clearButton.disabled ? '0.55' : '1';
            attachBotDashboardPageIssueButton();
        });

        const clearButton = document.createElement('button');
        clearButton.type = 'button';
        clearButton.textContent = 'Show all';
        clearButton.title = 'Clear hidden-practice and status filters';
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
        clearButton.disabled = hiddenPractices.size === 0 && !statusFilterTerm;
        clearButton.style.opacity = clearButton.disabled ? '0.55' : '1';
        clearButton.addEventListener('click', () => {
            saveHiddenBotDashboardPractices(new Set());
            saveBotDashboardStatusFilterTerm('');
            applyBotDashboardPracticeFilters();
            renderBotDashboardPracticeFilterPanel(host, { force: true });
            attachBotDashboardPageIssueButton();
        });

        topRow.append(title, summary, searchInput, statusInput, clearButton);

        const list = document.createElement('div');
        Object.assign(list.style, {
            display: 'flex',
            gap: '6px',
            flexWrap: 'wrap',
            maxHeight: '150px',
            overflow: 'auto'
        });

        filteredCounts.forEach((item) => {
            const isHidden = hiddenPractices.has(item.key);
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = `${isHidden ? 'Show' : 'Hide'} ${item.name} (${item.count})`;
            button.title = `${isHidden ? 'Show' : 'Hide'} rows for ${item.name}`;
            Object.assign(button.style, {
                minHeight: '28px',
                border: `1px solid ${isHidden ? '#fca5a5' : '#cbd5e1'}`,
                borderRadius: '999px',
                background: isHidden ? '#fee2e2' : '#fff',
                color: isHidden ? '#991b1b' : '#0f172a',
                fontSize: '12px',
                fontWeight: isHidden ? '700' : '600',
                padding: '4px 9px',
                cursor: 'pointer'
            });
            button.addEventListener('click', () => {
                const nextHidden = loadHiddenBotDashboardPractices();
                if (nextHidden.has(item.key)) {
                    nextHidden.delete(item.key);
                } else {
                    nextHidden.add(item.key);
                }
                saveHiddenBotDashboardPractices(nextHidden);
                applyBotDashboardPracticeFilters();
                renderBotDashboardPracticeFilterPanel(host, { force: true });
                attachBotDashboardPageIssueButton();
            });
            list.appendChild(button);
        });

        if (!filteredCounts.length) {
            const empty = document.createElement('span');
            empty.textContent = 'No matching practices on this page.';
            Object.assign(empty.style, {
                fontSize: '12px',
                color: '#64748b'
            });
            list.appendChild(empty);
        }

        const statusHeader = document.createElement('div');
        Object.assign(statusHeader.style, {
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            margin: '10px 0 6px 0'
        });
        const statusTitle = document.createElement('strong');
        statusTitle.textContent = 'Status / attempts';
        Object.assign(statusTitle.style, {
            fontSize: '12px'
        });
        const statusSearchInput = document.createElement('input');
        statusSearchInput.type = 'search';
        statusSearchInput.placeholder = 'Find status chip';
        statusSearchInput.value = host.dataset.statusSearch || '';
        Object.assign(statusSearchInput.style, {
            minWidth: '170px',
            height: '28px',
            border: '1px solid #cbd5e1',
            borderRadius: '6px',
            padding: '0 8px',
            fontSize: '12px',
            marginLeft: 'auto'
        });
        statusSearchInput.addEventListener('input', () => {
            host.dataset.statusSearch = statusSearchInput.value;
            renderBotDashboardPracticeFilterPanel(host, { force: true });
        });
        statusHeader.append(statusTitle, statusSearchInput);

        const statusList = document.createElement('div');
        Object.assign(statusList.style, {
            display: 'flex',
            gap: '6px',
            flexWrap: 'wrap',
            maxHeight: '112px',
            overflow: 'auto'
        });
        filteredStatusCounts.forEach((item) => {
            const isActive = statusFilterTerm.toLowerCase() === item.term.toLowerCase();
            const label = item.label.length > 74 ? `${item.label.slice(0, 74)}...` : item.label;
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = `${isActive ? 'Showing' : 'Show'} ${label} (${item.count})`;
            button.title = `Show only rows matching: ${item.term}`;
            Object.assign(button.style, {
                minHeight: '28px',
                border: `1px solid ${isActive ? '#93c5fd' : '#cbd5e1'}`,
                borderRadius: '999px',
                background: isActive ? '#dbeafe' : '#fff',
                color: isActive ? '#1d4ed8' : '#0f172a',
                fontSize: '12px',
                fontWeight: isActive ? '700' : '600',
                padding: '4px 9px',
                cursor: 'pointer'
            });
            button.addEventListener('click', () => {
                saveBotDashboardStatusFilterTerm(isActive ? '' : item.term);
                applyBotDashboardPracticeFilters();
                renderBotDashboardPracticeFilterPanel(host, { force: true });
                attachBotDashboardPageIssueButton();
            });
            statusList.appendChild(button);
        });

        if (!filteredStatusCounts.length) {
            const empty = document.createElement('span');
            empty.textContent = 'No status values from visible practices.';
            Object.assign(empty.style, {
                fontSize: '12px',
                color: '#64748b'
            });
            statusList.appendChild(empty);
        }

        host.append(topRow, list, statusHeader, statusList);
    }

    function attachBotDashboardPracticeFilterPanel() {
        const existingHost = document.getElementById(BOT_DASHBOARD_PRACTICE_FILTER_HOST_ID);
        if (!isBotDashboardPage()) {
            existingHost?.remove();
            return;
        }

        applyBotDashboardPracticeFilters();
        const anchor = findBotDashboardPracticeFilterAnchor();
        if (!anchor?.parentElement) {
            existingHost?.remove();
            return;
        }

        const host = existingHost || document.createElement('div');
        host.id = BOT_DASHBOARD_PRACTICE_FILTER_HOST_ID;
        renderBotDashboardPracticeFilterPanel(host);

        if (!host.parentElement) {
            anchor.parentElement.insertBefore(host, anchor);
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
        Object.assign(host.style, {
            display: 'inline-flex',
            alignItems: 'center',
            marginLeft: '12px',
            verticalAlign: 'middle'
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

        if (!host.parentElement) {
            anchor.insertAdjacentElement('afterend', host);
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
                cell.addEventListener('mouseenter', (event) => {
                    const anchorElement = getAnchorElementFromPointerEvent(cell, event);
                    const anchorPoint = getAnchorPointFromPointerEvent(event);
                    scheduleMetaPanelForCell(cell, builder, label, anchorElement, anchorPoint);
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
                if (rowData.odsCode) actions.push(makePracticeEhrAction(rowData.odsCode));
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
            bindCell('status', (rowData) => [makeCopyAction(rowData.status, 'status')]);

            row.dataset.blMetaBound = 'true';
        });
    }

    function attachListeners() {
        attachDocListeners();
        attachMetaListeners();
        attachRejectedPracticeIssueButton();
        attachBotDashboardPracticeFilterPanel();
        attachBotDashboardPageIssueButton();
        attachPreparingOver3hIssueButton();
    }

    const observer = new MutationObserver(() => attachListeners());

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
