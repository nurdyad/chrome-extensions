// jobs.js - Full Replacement with URL Safety Guards
import { state, setJobData, setUniquePractices, setDocActive, setJobIdActive, setPracticeActive } from './state.js';
import { showToast, safeSetInnerHTML, toggleLoadingState, addActive, openTabWithTimeout } from './utils.js';
import { setSelectedPractice } from './navigator.js';

// --- 1. Main Scrape Function ---
export async function fetchAndPopulateData() {
    // Define UI Elements locally
    const elements = {
        jobTypeLabel: document.getElementById('jobTypeLabel'),
        odsCodeLabel: document.getElementById('ods-code'),
        practiceInputJobManager: document.getElementById('practiceDropdown'),
        jobIdInput: document.getElementById('job-id'),
        jobTitleDisplay: document.getElementById('jobTitleDisplay'),
        docInput: document.getElementById('documentDropdown'),
        documentActionsSection: document.getElementById('documentActionsSection'),
        jobTitleSection: document.getElementById('jobTitleSection'),
        mailroomDetailsSection: document.getElementById('mailroomDetailsSection')
    };

    // Helper to clear fields
    const resetUI = () => {
        if(elements.jobTypeLabel) elements.jobTypeLabel.textContent = '—';
        if(elements.odsCodeLabel) elements.odsCodeLabel.textContent = '—';
        if(elements.jobIdInput) elements.jobIdInput.value = '';
        if(elements.practiceInputJobManager) elements.practiceInputJobManager.value = '';
        if(elements.jobTitleDisplay) elements.jobTitleDisplay.value = '';
        
        if(elements.documentActionsSection) elements.documentActionsSection.style.display = 'none';
        if(elements.mailroomDetailsSection) elements.mailroomDetailsSection.style.display = 'none';
        if(elements.jobTitleSection) elements.jobTitleSection.style.display = 'none';
        
        ['mailroom-original-name', 'mailroom-nhs-no', 'mailroom-patient-name', 'mailroom-reason', 
         'mailroom-rejected-by-on', 'mailroom-status', 'mailroom-job-id', 'mailroom-inferred-type']
         .forEach(id => {
             const el = document.getElementById(id);
             if(el) el.textContent = '—';
         });
    };

    try {
        const { targetTabId } = await chrome.storage.local.get("targetTabId") || {};

        // --- 🛡️ SAFETY GUARD: Prevent chrome:// URL Access ---
        if (targetTabId) {
            const tab = await chrome.tabs.get(targetTabId);
            // Skip protected pages to prevent console errors
            if (tab.url.startsWith("chrome://") || tab.url.startsWith("edge://") || tab.url.startsWith("about:")) {
                console.log("[Jobs] Scraper skipped: Protected system page.");
                return; 
            }
        }
        
        const { clickedMailroomDocData } = await chrome.storage.local.get("clickedMailroomDocData") || {};
        const userTypedDocId = elements.docInput?.value || '';

        resetUI();

        if (!targetTabId) {
            if (elements.docInput) elements.docInput.value = userTypedDocId;
            return;
        }

        // --- A) Handle Mailroom Data Clicked from Content Script ---
        if (clickedMailroomDocData) {
            if (elements.docInput) elements.docInput.value = clickedMailroomDocData.documentId || "";
            const map = {
                'mailroom-original-name': clickedMailroomDocData.originalNameContent,
                'mailroom-nhs-no': clickedMailroomDocData.nhsNo,
                'mailroom-patient-name': clickedMailroomDocData.patientName,
                'mailroom-reason': clickedMailroomDocData.reason,
                'mailroom-rejected-by-on': clickedMailroomDocData.rejectedByOn,
                'mailroom-status': clickedMailroomDocData.status,
                'mailroom-job-id': clickedMailroomDocData.jobId,
                'mailroom-inferred-type': clickedMailroomDocData.inferredJobType
            };
            Object.entries(map).forEach(([id, val]) => {
                const el = document.getElementById(id);
                if(el) el.textContent = val || "—";
            });

            if (elements.mailroomDetailsSection) elements.mailroomDetailsSection.style.display = 'block';
            await chrome.storage.local.remove("clickedMailroomDocData"); 

            if (elements.docInput?.value && /^\d+$/.test(elements.docInput.value)) {
                if (elements.documentActionsSection) elements.documentActionsSection.style.display = 'block';
            }
            return;
        }

        // --- B) Scrape Dashboard Data ---
        const [{ result }] = await chrome.scripting.executeScript({
            target: { tabId: targetTabId },
            func: () => {
                if (!window.location.href.includes("bots/dashboard")) return null; 
                const tableRows = document.querySelectorAll("table tbody tr");
                if (!tableRows || tableRows.length === 0) return [];
                return Array.from(tableRows).map(row => {
                    const cells = row.querySelectorAll("td");
                    return {
                        documentId: cells[1]?.querySelector("a")?.textContent.trim(),
                        jobType: cells[2]?.innerText.trim(),
                        practiceName: cells[3]?.innerText.split("\n")[0]?.trim(),
                        odsCode: cells[3]?.innerText.split("\n")[1]?.trim(),
                        jobId: cells[4]?.querySelector("a")?.textContent.trim()
                    };
                }).filter(job => job.documentId && job.jobType);
            }
        });

        if (result && result.length > 0) {
            setJobData(result); 
            const practiceMap = new Map();
            result.forEach(job => {
                if (job.practiceName && job.odsCode) {
                    practiceMap.set(job.practiceName, job.odsCode);
                }
            });
            const unique = Array.from(practiceMap, ([name, code]) => ({ practiceName: name, odsCode: code }));
            setUniquePractices(unique);

            filterAndDisplaySuggestions();
            filterAndDisplayPracticeSuggestions();
        } else {
            setJobData([]);
            setUniquePractices([]);
        }
        
        if (elements.docInput && userTypedDocId) {
            elements.docInput.value = userTypedDocId;
            elements.docInput.dispatchEvent(new Event('input')); 
        }

    } catch (err) {
        console.error("Error in fetchAndPopulateData:", err);
    }
}

// --- 2. Document ID Autocomplete ---
export function filterAndDisplaySuggestions() {
    const docInput = document.getElementById("documentDropdown");
    const container = document.getElementById("autocompleteResults");
    if (!docInput || !container) return;

    const searchTerm = docInput.value.trim().toLowerCase();
    container.innerHTML = '';
    container.style.display = 'none';
    setDocActive(-1);

    const isInputFocused = (document.activeElement === docInput);
    if (!searchTerm && (!isInputFocused || state.jobData.length === 0)) return;

    let filteredData = state.jobData;
    if (searchTerm) {
        filteredData = state.jobData.filter(job =>
            (job.documentId || '').toLowerCase().includes(searchTerm) ||
            (job.practiceName || '').toLowerCase().includes(searchTerm)
        );
    }

    if (filteredData.length === 0) return;

    filteredData.forEach(job => {
        if (job.documentId) {
            const item = document.createElement('div');
            item.classList.add('autocomplete-item');
            item.innerHTML = `
                <div class="suggestion-main">${job.documentId}</div>
                <div class="suggestion-meta">
                    <span>${job.jobType || 'Unknown'}</span>
                    <span>${job.practiceName || ''}</span>
                </div>
            `;
            item.addEventListener('click', () => {
                docInput.value = job.documentId;
                container.style.display = 'none';
                docInput.dispatchEvent(new Event('input')); 
            });
            container.appendChild(item);
        }
    });

    if (container.children.length > 0 && isInputFocused) {
        container.style.display = 'block';
    }
}

// --- 3. Job ID Autocomplete ---
export function filterAndDisplayJobIdSuggestions() {
    const docInput = document.getElementById("documentDropdown");
    const jobIdInput = document.getElementById("job-id");
    const container = document.getElementById("jobIdAutocompleteResultsContainer");
    
    if(!docInput || !jobIdInput || !container) return;

    const currentDocId = docInput.value.trim(); 
    let relevantJobIds = [];

    if (currentDocId) {
        const matchingJobs = state.jobData.filter(job => job.documentId === currentDocId);
        const uniqueIds = new Set(matchingJobs.map(j => j.jobId).filter(Boolean));
        relevantJobIds = Array.from(uniqueIds);
    }

    container.innerHTML = '';
    container.style.display = 'none';
    setJobIdActive(-1);

    const isInputFocused = (document.activeElement === jobIdInput);
    if (relevantJobIds.length === 0 || !isInputFocused) return;

    relevantJobIds.forEach(jobId => {
        const item = document.createElement('div');
        item.classList.add('autocomplete-item');
        item.textContent = jobId;
        item.addEventListener('click', () => {
            jobIdInput.value = jobId;
            container.style.display = 'none';
        });
        container.appendChild(item);
    });

    if (container.children.length > 0 && isInputFocused) {
        container.style.display = 'block';
    }
}

// --- 4. Practice Dropdown (Job Manager specific) ---
export function filterAndDisplayPracticeSuggestions() {
    const practiceInput = document.getElementById('practiceDropdown');
    const container = document.getElementById('practiceAutocompleteResultsContainer');
    
    if (!practiceInput || !container) return;

    const searchTerm = practiceInput.value.trim().toLowerCase();
    container.innerHTML = '';
    container.style.display = 'none';
    setPracticeActive(-1);

    const isInputFocused = (document.activeElement === practiceInput);

    const allPractices = Object.values(state.cachedPractices).map(p => ({
        practiceName: p.name,
        odsCode: p.ods
    }));

    let filteredData = allPractices;
    if (searchTerm) {
        filteredData = allPractices.filter(p => 
            (p.practiceName?.toLowerCase().includes(searchTerm) || 
             p.odsCode?.toLowerCase().includes(searchTerm))
        );
    }

    if (filteredData.length === 0 && searchTerm.length > 1) {
        const noResults = document.createElement('div');
        noResults.className = 'autocomplete-item';
        noResults.textContent = 'No matching practices found';
        container.appendChild(noResults);
    } else {
        filteredData.slice(0, 50).forEach(p => { 
            if (p.practiceName && p.odsCode) {
                const item = document.createElement('div');
                item.className = 'autocomplete-item';
                item.innerHTML = `
                    <div class="suggestion-main">${p.practiceName}</div>
                    <div class="suggestion-meta">${p.odsCode}</div>
                `;
                item.addEventListener('click', () => {
                    setSelectedPractice({ name: p.practiceName, ods: p.odsCode }); 
                    practiceInput.value = `${p.practiceName} (${p.odsCode})`;
                    container.style.display = 'none';
                });
                container.appendChild(item);
            }
        });
    }

    if (container.children.length > 0 && isInputFocused) {
        container.style.display = 'block';
    }
}