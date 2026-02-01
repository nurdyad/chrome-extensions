/**
 * bot_dashboard_navigator.js - Slim, Locked & Formatted Copy
 */
(() => {
    let floatingNavPanel = null;
    let activeDocIdElement = null;
    let isMouseInPanel = false;

    function createFloatingNavPanel() {
        if (document.getElementById('bl-doc-nav-panel')) return document.getElementById('bl-doc-nav-panel');

        floatingNavPanel = document.createElement("div");
        floatingNavPanel.id = "bl-doc-nav-panel";
        
        Object.assign(floatingNavPanel.style, {
            position: "absolute",
            zIndex: "2147483647",
            display: "none",
            flexDirection: "row",
            gap: "3px",
            background: "#ffffff",
            padding: "3px 5px",
            border: "1px solid #007bff",
            borderRadius: "4px",
            boxShadow: "0 2px 8px rgba(0,0,0,0.2)",
            fontFamily: 'system-ui, -apple-system, sans-serif',
            pointerEvents: "auto"
        });

        floatingNavPanel.addEventListener('mouseenter', () => { isMouseInPanel = true; });
        floatingNavPanel.addEventListener('mouseleave', () => { isMouseInPanel = false; hideNavPanel(); });

        const createNavBtn = (label, color, getUrl) => {
            const btn = document.createElement("button");
            btn.textContent = label;
            Object.assign(btn.style, {
                background: color, color: "#fff", border: "none", borderRadius: "3px",
                padding: "2px 6px", cursor: "pointer", fontSize: "11px", fontWeight: "bold"
            });
            
            btn.onclick = (e) => {
                e.preventDefault(); e.stopPropagation();
                const docId = activeDocIdElement.textContent.trim().replace(/\D/g,'');
                window.open(getUrl(docId), '_blank');
            };
            return btn;
        };

        // 📋 THE NEW COPY BUTTON: Formats as "document_id=XXXXXXX"
        const createCopyBtn = () => {
            const btn = document.createElement("button");
            btn.title = "Copy as document_id = ...";
            btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;
            Object.assign(btn.style, {
                background: "#f0f0f0", color: "#333", border: "1px solid #ccc", borderRadius: "3px",
                padding: "2px 5px", cursor: "pointer", display: "flex", alignItems: "center"
            });
            
            btn.onclick = (e) => {
                e.preventDefault(); e.stopPropagation();
                const docId = activeDocIdElement.textContent.trim().replace(/\D/g,'');
                
                // 🛡️ Added spaces around the equal sign
                const formatted = `document_id = ${docId}`;
                
                navigator.clipboard.writeText(formatted).then(() => {
                    const originalBg = btn.style.background;
                    btn.style.background = "#d4edda"; // Success green
                    setTimeout(() => { btn.style.background = originalBg; }, 1000);
                });
            };
            return btn;
        };

        floatingNavPanel.append(
            createNavBtn("Jobs", "#6c757d", id => `https://app.betterletter.ai/admin_panel/bots/dashboard?document_id=${id}`),
            createNavBtn("Oban", "#fd7e14", id => `https://app.betterletter.ai/oban/jobs?args=document_id%2B%2B${id}`),
            createNavBtn("Log", "#17a2b8", id => `https://app.betterletter.ai/admin_panel/event_log/${id}`),
            createNavBtn("Admin", "#007bff", id => `https://app.betterletter.ai/admin_panel/letter/${id}`),
            createCopyBtn() // Add the new icon here
        );

        document.body.appendChild(floatingNavPanel);
        return floatingNavPanel;
    }

    function showNavPanel(el) {
        activeDocIdElement = el;
        createFloatingNavPanel();
        const rect = el.getBoundingClientRect();
        floatingNavPanel.style.left = `${rect.left + window.scrollX}px`;
        floatingNavPanel.style.top = `${rect.bottom + window.scrollY + 2}px`;
        floatingNavPanel.style.display = "flex";
    }

    function hideNavPanel() {
        setTimeout(() => {
            if (!isMouseInPanel && activeDocIdElement) {
                const hoverEl = document.querySelectorAll(':hover');
                const isStillOvering = Array.from(hoverEl).some(node => node === activeDocIdElement || node === floatingNavPanel);
                if (!isStillOvering) {
                    if (floatingNavPanel) floatingNavPanel.style.display = "none";
                    activeDocIdElement = null;
                }
            }
        }, 300);
    }

    function attachListeners() {
        const items = document.querySelectorAll('td:nth-child(2) a, td:first-child span, td:first-child div, a[href*="document_id="]');
        items.forEach(el => {
            if (el.dataset.blNavReady) return;
            const text = el.textContent.trim();
            if (!/^\d{6,9}$/.test(text)) return; 
            el.dataset.blNavReady = "true";
            el.style.borderBottom = "1px dotted #007bff";
            el.addEventListener('mouseenter', () => showNavPanel(el));
            el.addEventListener('mouseleave', () => hideNavPanel());
        });
    }

    const observer = new MutationObserver(() => attachListeners());
    observer.observe(document.body, { childList: true, subtree: true });
    attachListeners();
})();