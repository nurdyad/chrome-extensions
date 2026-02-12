/**
 * bot_dashboard_navigator.js - Floating quick actions on dashboard rows
 */
(() => {
    let floatingNavPanel = null;
    let floatingMetaPanel = null;
    let activeDocIdElement = null;
    let activeMetaElement = null;
    let isMouseInDocPanel = false;
    let isMouseInMetaPanel = false;
    let metaHideTimer = null;
    let metaReanchorTimer = null;

    const META_CLOSE_DELAY_MS = 120;
    const META_REANCHOR_DELAY_MS = 90;

    const HEADER_KEYS = {
        documentid: 'document',
        jobtype: 'jobType',
        practice: 'practice',
        jobid: 'jobId',
        added: 'added',
        status: 'status'
    };

    function collapseText(value) {
        return String(value || '').replace(/\s+/g, ' ').trim();
    }

    function copyToClipboard(text, onSuccess) {
        navigator.clipboard.writeText(text).then(() => {
            if (typeof onSuccess === 'function') onSuccess();
        }).catch(() => {
            console.warn('[BL Navigator] Clipboard copy failed.');
        });
    }

    function flashButton(btn) {
        const originalBg = btn.style.background;
        btn.style.background = '#d4edda';
        setTimeout(() => { btn.style.background = originalBg; }, 900);
    }

    function createButton({ label, color, title, onClick, icon }) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.title = title || label;
        btn.innerHTML = icon || label;
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
            gap: '4px'
        });

        btn.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            onClick?.(btn);
        };

        return btn;
    }

    function createFloatingDocPanel() {
        if (document.getElementById('bl-doc-nav-panel')) return document.getElementById('bl-doc-nav-panel');

        floatingNavPanel = document.createElement('div');
        floatingNavPanel.id = 'bl-doc-nav-panel';

        Object.assign(floatingNavPanel.style, {
            position: 'absolute',
            zIndex: '2147483647',
            display: 'none',
            flexDirection: 'row',
            gap: '3px',
            background: '#ffffff',
            padding: '3px 5px',
            border: '1px solid #007bff',
            borderRadius: '4px',
            boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
            fontFamily: 'system-ui, -apple-system, sans-serif',
            pointerEvents: 'auto'
        });

        floatingNavPanel.addEventListener('mouseenter', () => { isMouseInDocPanel = true; });
        floatingNavPanel.addEventListener('mouseleave', () => { isMouseInDocPanel = false; hideDocPanel(); });

        const createNavBtn = (label, color, getUrl) => createButton({
            label,
            color,
            onClick: () => {
                const docId = activeDocIdElement?.textContent?.trim()?.replace(/\D/g, '');
                if (!docId) return;
                window.open(getUrl(docId), '_blank');
            }
        });

        const copyBtn = createButton({
            color: '#f0f0f0',
            title: 'Copy as document_id = ...',
            icon: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>',
            onClick: (btn) => {
                const docId = activeDocIdElement?.textContent?.trim()?.replace(/\D/g, '');
                if (!docId) return;
                copyToClipboard(`document_id = ${docId}`, () => flashButton(btn));
            }
        });
        copyBtn.style.color = '#333';
        copyBtn.style.border = '1px solid #ccc';

        floatingNavPanel.append(
            createNavBtn('Jobs', '#6c757d', id => `https://app.betterletter.ai/admin_panel/bots/dashboard?document_id=${id}`),
            createNavBtn('Oban', '#fd7e14', id => `https://app.betterletter.ai/oban/jobs?args=document_id%2B%2B${id}`),
            createNavBtn('Log', '#17a2b8', id => `https://app.betterletter.ai/admin_panel/event_log/${id}`),
            createNavBtn('Admin', '#007bff', id => `https://app.betterletter.ai/admin_panel/letter/${id}`),
            copyBtn
        );

        document.body.appendChild(floatingNavPanel);
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
            pointerEvents: 'auto'
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

        if (typeof map.document !== 'number') return null;
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

        const practiceCellText = getText('practice');
        const odsCode = practiceCellText.match(/\b[A-Z]\d{5}\b/)?.[0] || '';

        return {
            row,
            document: getText('document'),
            jobType: getText('jobType'),
            practice: practiceCellText,
            jobId: getText('jobId'),
            added: getText('added'),
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

    function getHoveredDescendant(cell) {
        const hoverChain = Array.from(document.querySelectorAll(':hover'));
        for (let i = hoverChain.length - 1; i >= 0; i -= 1) {
            const node = hoverChain[i];
            if (!(node instanceof Element)) continue;
            if (node !== cell && cell.contains(node)) return node;
        }
        return null;
    }

    function getMetaAnchorRect(cell) {
        const hoveredDescendant = getHoveredDescendant(cell);
        const hoveredInteractiveAnchor = hoveredDescendant?.closest?.('a, button, [role="button"]');
        if (hoveredInteractiveAnchor && cell.contains(hoveredInteractiveAnchor)) {
            return hoveredInteractiveAnchor.getBoundingClientRect();
        }
        if (hoveredDescendant) return hoveredDescendant.getBoundingClientRect();

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

    function showMetaPanel(el, actions = []) {
        if (!actions.length) return;

        clearTimeout(metaHideTimer);
        clearTimeout(metaReanchorTimer);

        activeMetaElement = el;
        createFloatingMetaPanel();
        floatingMetaPanel.innerHTML = '';
        actions.forEach(action => floatingMetaPanel.appendChild(action));

        const anchorRect = getMetaAnchorRect(el);
        floatingMetaPanel.style.left = `${anchorRect.left + window.scrollX}px`;
        floatingMetaPanel.style.top = `${anchorRect.bottom + window.scrollY + 2}px`;
        floatingMetaPanel.style.display = 'flex';
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
                }
            }
        }, META_CLOSE_DELAY_MS);
    }

    function scheduleMetaPanelForCell(cell, builder, label) {
        clearTimeout(metaReanchorTimer);

        if (activeMetaElement === cell) {
            const rowData = getRowDataFromElement(cell);
            if (!rowData) return;
            showMetaPanel(cell, builder(rowData, label));
            return;
        }

        metaReanchorTimer = setTimeout(() => {
            if (isMouseInMetaPanel) return;
            const hoverEl = document.querySelectorAll(':hover');
            const isStillHoveringCell = Array.from(hoverEl).some(node => node === cell || cell.contains(node));
            if (!isStillHoveringCell) return;

            const rowData = getRowDataFromElement(cell);
            if (!rowData) return;

            showMetaPanel(cell, builder(rowData, label));
        }, META_REANCHOR_DELAY_MS);
    }

    function makeCopyAction(value, label) {
        return createButton({
            label: `Copy ${label}`,
            color: '#495057',
            title: `Copy ${label}`,
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

    function attachDocListeners() {
        const items = document.querySelectorAll('td:nth-child(2) a, td:first-child span, td:first-child div, a[href*="document_id="]');
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
                cell.addEventListener('mouseenter', () => {
                    scheduleMetaPanelForCell(cell, builder, label);
                });
                cell.addEventListener('mouseleave', () => hideMetaPanel());
            };

            bindCell('jobType', (rowData) => [makeCopyAction(rowData.jobType, 'job type')]);
            bindCell('practice', (rowData) => {
                const actions = [makeCopyAction(rowData.practice, 'practice')];
                if (rowData.odsCode) actions.push(makePracticeEhrAction(rowData.odsCode));
                return actions;
            });
            bindCell('jobId', (rowData) => [makeCopyAction(rowData.jobId, 'job ID')]);
            bindCell('added', (rowData) => [makeCopyAction(rowData.added, 'added date')]);
            bindCell('status', (rowData) => [makeCopyAction(rowData.status, 'status')]);

            row.dataset.blMetaBound = 'true';
        });
    }

    function attachListeners() {
        attachDocListeners();
        attachMetaListeners();
    }

    const observer = new MutationObserver(() => attachListeners());
    observer.observe(document.body, { childList: true, subtree: true });
    attachListeners();
})();
