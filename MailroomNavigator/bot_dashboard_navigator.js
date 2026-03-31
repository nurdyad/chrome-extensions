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
        serverlessLiteMode: false,
        features: {
            dashboard_hover_tools: false,
            linear_create_issue: false
        }
    };
    let listenersStarted = false;

    const META_CLOSE_DELAY_MS = 120;
    const META_REANCHOR_DELAY_MS = 90;
    const BOT_JOB_TITLE_PREFIX = 'Bot Job Error:';
    const PRACTICE_SUPPORT_TITLE_PREFIX = 'Practice Support Ticket:';
    const BOT_JOB_DEFAULT_PRIORITY = 3;
    const BOT_JOB_LABELS_ALWAYS = ['bot-jobs', 'automation'];
    const HIDDEN_DEDUPE_PREFIX = 'BOT_JOBS_DEDUPE:';
    const GROUP_DEDUPE_PREFIX = 'BOT_JOBS_GROUP:';
    const REJECTED_PRACTICE_ISSUE_HOST_ID = 'bl-rejected-practice-issue-host';
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
        status: 'status'
    };

    function collapseText(value) {
        return String(value || '').replace(/\s+/g, ' ').trim();
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
        const labels = [...BOT_JOB_LABELS_ALWAYS];
        const ehr = inferEhrLabel(row?.job_type);
        if (ehr) labels.push(ehr);
        labels.push(inferIssueTypeLabel(row));
        labels.push(inferSupportTypeLabel(row));
        const stage = inferLetterStageLabel(row);
        if (stage) labels.push(stage);
        return [...new Set(labels.filter(Boolean))];
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

        const practiceName = collapseText(rowData?.practiceName || rowData?.practice || '');
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
- Reason: ${reason}
- Rejected By: ${rejectedBy}
- On: ${rejectedOn}
- Annotation editor: ${buildAnnotationEditorUrl(documentId)}
- Letter Admin: ${buildLetterAdminUrl(documentId)}
- Letter Bots link: ${buildLetterBotsDocumentUrl(documentId)}
- Oban Jobs Link: ${buildObanJobsDocumentUrl(documentId)}
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
            priority: 2
        };
    }

    function buildLinearIssuePayloadFromBotDashboardRow(rowData, fallbackDocId = '') {
        const botJobRow = buildBotJobRowFromRowData(rowData, fallbackDocId);
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
            labels: buildLabels(botJobRow),
            stateName: 'Todo',
            dedupeKey: dedupeKey.key,
            jobType: botJobRow.job_type
        };
    }

    function buildLinearIssuePayloadFromRejectedPracticeContext(context) {
        const practiceName = collapseText(context?.practiceName);
        const practiceCode = collapseText(context?.practiceCode || '').toUpperCase();
        const rejectedCount = Number(context?.rejectedCount || 0);
        if (!practiceName || rejectedCount <= 0) return null;

        const issueTitle = `${PRACTICE_SUPPORT_TITLE_PREFIX} ${practiceName}`;
        const description = `
## Summary
- ${rejectedCount} rejected letters need to be processed by Practice.

## Practice details
- Practice: ${practiceName}
- Practice Code: ${practiceCode || 'N/A'}
- Rejected letters needing processing: ${rejectedCount}
- Rejected queue: ${window.location.href}
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
            stateName: 'Todo',
            dedupeKey: `practice_support_ticket|${practiceCode || normalizeGroupKeyPart(practiceName)}`
        };
    }

    function buildLinearIssuePayloadFromRow(rowData, fallbackDocId = '') {
        if (!rowData) return null;
        if (rowData.sourceKind === 'mailroom_rejected') {
            return buildLinearIssuePayloadFromMailroomRejectedRow(rowData, fallbackDocId);
        }
        return buildLinearIssuePayloadFromBotDashboardRow(rowData, fallbackDocId);
    }

    function sendRuntimeMessage(message) {
        return new Promise((resolve, reject) => {
            try {
                chrome.runtime.sendMessage(message, (response) => {
                    if (chrome.runtime.lastError) {
                        reject(new Error(String(chrome.runtime.lastError.message || 'Runtime message failed.')));
                        return;
                    }
                    resolve(response || {});
                });
            } catch (error) {
                reject(error);
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

    function copyToClipboard(text, onSuccess) {
        navigator.clipboard.writeText(text).then(() => {
            if (typeof onSuccess === 'function') onSuccess();
        }).catch(() => {
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
            const response = await sendRuntimeMessage({
                action: 'createLinearIssueFromEnv',
                payload
            });

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
            btn.textContent = String(response.issue.identifier || 'Created');
            btn.style.background = '#16a34a';
            showNavigatorToast(`Created ${String(response.issue.identifier || 'issue')}.`, 'valid');
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
            console.warn('[BL Navigator] Issue creation failed.', { payload, error: failureMessage });
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
        if (!restrictedToolsAccess?.serverlessLiteMode && hasRestrictedFeature('linear_create_issue')) {
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
        const sourceKind = window.location.pathname.includes('/mailroom/rejected')
            ? 'mailroom_rejected'
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

    function findRejectedPracticeToggleElement() {
        return Array.from(document.querySelectorAll('button, [role="button"], a, label, span, div'))
            .find((element) => /^Practice\s*\(\d+\)$/i.test(getElementDisplayText(element))) || null;
    }

    function resolveRejectedPracticeCount() {
        const toggleText = getElementDisplayText(findRejectedPracticeToggleElement());
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

        return {
            practiceName,
            practiceCode,
            rejectedCount: resolveRejectedPracticeCount()
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
        if (!isRejectedMailroomPage() || restrictedToolsAccess?.serverlessLiteMode || !hasRestrictedFeature('linear_create_issue')) {
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
        const practiceToggleElement = findRejectedPracticeToggleElement();
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

        button.title = `Create practice support ticket for ${context.practiceName} (${context.rejectedCount} rejected letters)`;
        host.dataset.practiceName = context.practiceName;
        host.dataset.practiceCount = String(context.rejectedCount);

        if (practiceNameAnchor && practiceNameAnchor.nextElementSibling !== host) {
            practiceNameAnchor.insertAdjacentElement('afterend', host);
            return;
        }

        if (!practiceNameAnchor && practiceToggleElement && practiceToggleElement.nextElementSibling !== host) {
            practiceToggleElement.insertAdjacentElement('afterend', host);
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
                    && !restrictedToolsAccess?.serverlessLiteMode
                    && hasRestrictedFeature('linear_create_issue')
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
                    && !restrictedToolsAccess?.serverlessLiteMode
                    && hasRestrictedFeature('linear_create_issue')
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
    }

    const observer = new MutationObserver(() => attachListeners());

    async function init() {
        if (listenersStarted) return;
        listenersStarted = true;
        observer.observe(document.body, { childList: true, subtree: true });
        attachListeners();
        ensureRestrictedToolsAccess(false)
            .then(() => {
                if (floatingNavPanel) createFloatingDocPanel();
                attachListeners();
            })
            .catch(() => undefined);
    }

    init().catch(() => undefined);
})();
