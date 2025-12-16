/**
 * panel.js
 *
 * This script runs in the context of the unified panel.html popup.
 * It combines functionalities from BL-Mailroom's popup.js and BetterLetterJobManager's panel.js.
 */

/**********************
 * UTILITY FUNCTIONS
 **********************/

function debounce(func, timeout = 300) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => { func.apply(this, args); }, timeout);
  };
}

function safeSetInnerHTML(element, content) {
  if (element && element.innerHTML !== undefined) {
    element.innerHTML = content;
  } else {
    console.warn('Attempted to set innerHTML on missing element:', element?.id);
  }
}

function toggleLoadingState(element, isLoading) {
  if (!element) return;
  element.classList.toggle('loading-state', isLoading);
}

// Debounced functions
const debouncedFilterAndDisplaySuggestions = debounce(filterAndDisplaySuggestions, 300);
const debouncedFilterAndDisplayPracticeSuggestions = debounce(filterAndDisplayPracticeSuggestions, 300);
const debouncedFilterAndDisplayJobIdSuggestions = debounce(filterAndDisplayJobIdSuggestions, 300);

// --- Global State Variables ---
let currentSelectedOdsCode = null;
let cachedPractices = {}; // For Practice Navigator
let jobData = []; // For Job Manager
let uniquePractices = []; // For Job Manager

// UI View Elements
let practiceNavigatorView = null;
let emailFormatterView = null;
let jobManagerView = null;

// Practice Navigator Specific Elements
let statusDisplayEl = null;
let statusEl = null;
let cdbSearchResultEl = null;
let resetSettingsBtn = null;
let practiceInputEl = null;
let suggestionsList = null;
let docmanJobSelectNav = null;
let emisJobSelectNav = null;
let cdbSearchInputEl = null;
let cdbSuggestionsList = null;

// Job Manager Specific Elements
let docInput = null;
let autocompleteResultsContainer = null;
let copyDocBtn = null;
let statusBtn = null;
let obanBtn = null;
let annoBtn = null;
let eventLogBtn = null;
let letterAdminBtn = null;
let odsCodeLabel = null;
let openPracticeBtn = null;
let jobTypeLabel = null;
let jobIdInput = null;
let copyJobBtn = null;
let openJobBtn = null;
let documentSelectionSection = null;
let documentActionsSection = null;
let practiceInputJobManager = null;
let practiceAutocompleteResultsContainer = null;
let jobTitleSection = null;
let jobTitleDisplay = null;
let copyJobTitle = null;
let copyPracticeNameBtn = null;
let copyJobPageUrlBtn = null;
let jobIdAutocompleteResultsContainer = null;
let clearDocIdBtn = null;
let mailroomDetailsSection = null;
let mailroomOriginalName = null;
let mailroomNhsNo = null;
let mailroomPatientName = null;
let mailroomReason = null;
let mailroomRejectedByOn = null;
let mailroomStatus = null;
let mailroomJobId = null;
let mailroomInferredType = null;
let copyMailroomDetailsBtn = null;

// Email Formatter Specific Elements
let inputEmailFormatter = null;
let outputEmailFormatter = null;
let convertEmailBtn = null;
let copyEmailBtn = null;

// Global UI / Utility
let toastEl = null;
let refreshIntervalId = null;
let docActive = -1;
let practiceActive = -1;
let jobIdActive = -1;

// --- Helper Functions ---

function showToast(message) {
    if (!toastEl) {
        console.warn("Toast element not found in DOM.");
        return;
    }
    toastEl.textContent = message;
    toastEl.style.display = "block";
    setTimeout(() => toastEl.style.display = "none", 2000);
}

// Contextual Buttons State For Practice Navigator
function setNavigatorButtonsState(enable) {
  document.getElementById('usersBtn').disabled = !enable;
  document.getElementById('collectionBtn').disabled = !enable;
  document.getElementById('preparingBtn').disabled = !enable;
  document.getElementById('rejectedBtn').disabled = !enable;
}

// Contextual Buttons StateFor Job Panel
function setJobPanelButtonsState(enable) {
  document.getElementById('docmanJobsBtn').disabled = !enable;
  document.getElementById('emisJobsBtn').disabled = !enable;
  document.getElementById('docmanValidateBtn').disabled = !enable;
}

function showView(viewId) {
    // Hide all main views
    practiceNavigatorView.style.display = 'none';
    emailFormatterView.style.display = 'none';
    jobManagerView.style.display = 'none';

    // Remove active-tab class from all global nav buttons
    const globalNavButtons = document.querySelectorAll('.global-nav-buttons-row .btn');
    globalNavButtons.forEach(button => button.classList.remove('active-tab'));

    // Show the requested view
    if (viewId === 'practiceNavigatorView') {
        practiceNavigatorView.style.display = 'block';
        document.getElementById('navigatorGlobalToggleBtn').classList.add('active-tab');
        if (refreshIntervalId) { // If the refresh interval is running...
            clearInterval(refreshIntervalId); // ...stop it.
            refreshIntervalId = null;
        }
        updateContextualButtonsOnInput(false);
    } else if (viewId === 'jobManagerView') {
        jobManagerView.style.display = 'block';
        document.getElementById('jobManagerGlobalToggleBtn').classList.add('active-tab');
        // Now, it only fetches data once when you switch to the tab.
        fetchAndPopulateData();
    } else if (viewId === 'emailFormatterView') {
        emailFormatterView.style.display = 'block';
        document.getElementById('emailFormatterGlobalToggleBtn').classList.add('active-tab');
        if (refreshIntervalId) { // If the refresh interval is running...
            clearInterval(refreshIntervalId); // ...stop it.
            refreshIntervalId = null;
        }
    }
    
    hideSuggestions();
    if (statusDisplayEl) statusDisplayEl.style.display = 'none';
    if (cdbSearchResultEl) cdbSearchResultEl.style.display = 'none';
    if (statusEl) statusEl.style.display = 'none';
}

function addActive(activeIdx, items) {
    if (!items || items.length === 0) return -1;
    removeActive(items);
    activeIdx = (activeIdx + items.length) % items.length;
    items[activeIdx].classList.add("active");
    return activeIdx;
}

function removeActive(items) {
    for (let i = 0; i < items.length; i++) {
        items[i].classList.remove("active");
    }
}

function hideSuggestions() {
    setTimeout(() => {
        if (autocompleteResultsContainer) autocompleteResultsContainer.style.display = 'none';
        if (practiceAutocompleteResultsContainer) practiceAutocompleteResultsContainer.style.display = 'none';
        if (jobIdAutocompleteResultsContainer) jobIdAutocompleteResultsContainer.style.display = 'none';
        if (suggestionsList) suggestionsList.style.display = 'none';
        if (cdbSuggestionsList) cdbSuggestionsList.style.display = 'none';
        docActive = -1;
        practiceActive = -1;
        jobIdActive = -1;
    }, 100);
}

function clearDependentFields() {
    jobIdInput.value = "";
    jobTypeLabel.textContent = "—";
    odsCodeLabel.textContent = "—";
    jobTitleDisplay.value = "";
    jobTitleSection.style.display = 'none';
    practiceInputJobManager.value = "";
    jobIdAutocompleteResultsContainer.innerHTML = "";
    documentActionsSection.style.display = 'none';
    mailroomOriginalName.textContent = "—";
    mailroomNhsNo.textContent = "—";
    mailroomPatientName.textContent = "—";
    mailroomReason.textContent = "—";
    mailroomRejectedByOn.textContent = "—";
    mailroomStatus.textContent = "—";
    mailroomJobId.textContent = "—";
    mailroomInferredType.textContent = "—";
    mailroomDetailsSection.style.display = 'none';
}

function getNumericDocIdFromInput(inputString) {
    const match = inputString.trim().match(/^\d+$/);
    return match ? match[0] : null;
}

function getOdsCodeFromPracticeName(practiceName) {
    const found = uniquePractices.find(p => p.practiceName === practiceName);
    return found ? found.odsCode : null;
}

function openTabWithTimeout(url) {
    chrome.tabs.create({ url }).catch(err => {
        console.error("Failed to open tab:", err);
        showToast("Failed to open page.");
    });
}

function showStatus(message, type) {
  if (statusEl) {
    statusEl.textContent = message;
    statusEl.className = type;
    statusEl.style.display = 'block';
  } else {
    console.warn("Status element not found in DOM when trying to showStatus:", message);
  }
}

async function triggerOpenPracticePage(rawInput, settingType) {
    if (statusEl) {
        showStatus('Opening settings...', 'loading');
    }

    if (!rawInput) {
        showStatus('Practice name or ODS code is missing.', 'error');
        return;
    }

    try {
        const response = await new Promise((resolve) => {
            chrome.runtime.sendMessage({
                action: 'openPractice',
                input: rawInput,
                settingType
            }, resolve);
        });

        if (response && response.error) {
            showStatus(`Error: ${response.error}`, 'error');
        } else {
            showStatus('Settings opened successfully!', 'success');
            if (statusEl) setTimeout(() => statusEl.style.display = 'none', 2000);
        }
    } catch (err) {
        showStatus(`Error: ${err.message}`, 'error');
    }
}

// --- Practice Selection: Single Source of Truth ---

function normalizePracticeSelection(input) {
  // Returns { name, ods, display } or null

  // A) Cached practice object: { name, ods, ... }
  if (input && typeof input === 'object' && typeof input.ods === 'string') {
    const name = typeof input.name === 'string' ? input.name : '';
    return { name, ods: input.ods, display: `${name} (${input.ods})` };
  }

  // B) Job Manager shape: { practiceName, odsCode }
  if (input && typeof input === 'object' && typeof input.odsCode === 'string') {
    const name = typeof input.practiceName === 'string' ? input.practiceName : '';
    return { name, ods: input.odsCode, display: `${name} (${input.odsCode})` };
  }

  // C) String key in cachedPractices: "Name (ODS)"
  if (typeof input === 'string' && cachedPractices[input] && typeof cachedPractices[input].ods === 'string') {
    const p = cachedPractices[input];
    return { name: p.name, ods: p.ods, display: input };
  }

  // D) Raw ODS typed/pasted
  if (typeof input === 'string' && /^[A-Z]\d{5}$/.test(input.trim())) {
    return { name: '', ods: input.trim(), display: input.trim() };
  }

  return null;
}

function setSelectedPractice(practiceLike, { updateInput = true, triggerStatus = true } = {}) {
  const normalized = normalizePracticeSelection(practiceLike);

  if (!normalized || typeof normalized.ods !== 'string' || !/^[A-Z]\d{5}$/.test(normalized.ods)) {
    console.error('[BetterLetter] setSelectedPractice: invalid selection:', practiceLike);
    // Fail loudly + clear state deterministically
    currentSelectedOdsCode();
    setNavigatorButtonsState(false);
    if (docmanJobSelectNav) docmanJobSelectNav.disabled = true;
    if (emisJobSelectNav) emisJobSelectNav.disabled = true;
    throw new Error('Invalid practice selection (ODS must be a string like M84003).');
  }

  // ✅ The ONLY place currentSelectedOdsCode is ever set
  currentSelectedOdsCode = normalized.ods;

  if (updateInput && practiceInputEl) practiceInputEl.value = normalized.display;

  if (suggestionsList) suggestionsList.style.display = 'none';
  setNavigatorButtonsState(true);
  if (docmanJobSelectNav) docmanJobSelectNav.disabled = false;
  if (emisJobSelectNav) emisJobSelectNav.disabled = false;

  if (triggerStatus) displayPracticeStatus();
  
  const ehrBtn = document.getElementById('openEhrSettingsBtn');
  if (ehrBtn) ehrBtn.disabled = false;

  return normalized;
}

function clearSelectedPractice() {
  currentSelectedOdsCode = null;
  setNavigatorButtonsState(false);
  if (docmanJobSelectNav) docmanJobSelectNav.disabled = true;
  if (emisJobSelectNav) emisJobSelectNav.disabled = true;
  const ehrBtn = document.getElementById('openEhrSettingsBtn');
    if (ehrBtn) ehrBtn.disabled = true;
}

function requireSelectedOdsCode() {
  if (typeof currentSelectedOdsCode !== 'string' || !/^[A-Z]\d{5}$/.test(currentSelectedOdsCode)) {
    console.error('[BetterLetter] Invalid currentSelectedOdsCode:', currentSelectedOdsCode);
    throw new Error('No valid practice selected (ODS must be a string like M84003).');
  }
  return currentSelectedOdsCode;
}

async function updateContextualButtonsOnInput(triggerStatus = true) {
  const inputValue = practiceInputEl.value.trim();
  let foundOds = null;

  if (inputValue) {
    for (const [key, data] of Object.entries(cachedPractices)) {
      const dataNameLower = data && data.name ? data.name.toLowerCase().trim() : '';
      const dataOdsLower = data && data.ods ? data.ods.toLowerCase().trim() : '';
      const keyLower = key ? key.toLowerCase().trim() : '';

      if (
        dataNameLower === inputValue.toLowerCase() ||
        dataOdsLower === inputValue.toLowerCase() ||
        keyLower === inputValue.toLowerCase() ||
        (dataNameLower.includes(inputValue.toLowerCase()) && inputValue.length >= 3) ||
        (dataOdsLower.includes(inputValue.toLowerCase()) && inputValue.length >= 3)
      ) {
        foundOds = data.ods;
        break;
      }
    }
  }
    
  clearSelectedPractice();

}

async function displayPracticeStatus() {
    if (statusDisplayEl) statusDisplayEl.style.display = 'none';
    if (cdbSearchResultEl) cdbSearchResultEl.style.display = 'none';

    if (!currentSelectedOdsCode) {
        showStatus('Please select a valid practice first to get status.', 'error');
        return;
    }

    showStatus('Fetching status (this might open a temporary window briefly)...', 'loading');

    try {
        const response = await new Promise(resolve => {
            chrome.runtime.sendMessage({ action: 'getPracticeStatus', odsCode: currentSelectedOdsCode }, resolve);
        });

        if (response && response.success && response.status) {
            if (statusDisplayEl) {
                statusDisplayEl.innerHTML = `
                    <strong>ODS Code:</strong> ${response.status.odsCode || 'N/A'}<br>
                    <strong>EHR Type:</strong> ${response.status.ehrType || 'N/A'}<br>
                    <strong>Collection Quota:</strong> ${response.status.collectionQuota || 'N/A'}<br>
                    <strong>Collected Today:</strong> ${response.status.collectedToday || 'N/A'}<br>
                    <strong>Service Level:</strong> ${response.status.serviceLevel || 'N/A'}<br>
                    <strong>Practice CDB:</strong> ${response.status.practiceCDB || 'N/A'}
                `;
                statusDisplayEl.style.display = 'block';
            }
            showStatus('Status fetched successfully!', 'success');
            if (statusEl) setTimeout(() => statusEl.style.display = 'none', 2000);
        } else {
            showStatus(`Failed to get status: ${response?.error || 'No data found'}`, 'error');
            console.error(`%c[Merged UI] Failed to get status: ${response?.error}`, 'color: red;');
        }
    }
    catch (err) {
        showStatus(`Error fetching status: ${err.message}`, 'error');
        console.error(`%c[Merged UI] Error fetching status: ${err.message}`, 'color: red;', err);
    }
}

function extractNameFromEmail(email) {
    const localPart = email.split("@")[0];
    const cleaned = localPart.replace(/[._]/g, " ");
    return cleaned
      .split(" ")
      .map(w => {
        const word = w.replace(/\d+/g, '');
        return word.charAt(0).toUpperCase() + word.slice(1);
      })
      .join(" ")
      .trim();
}

function convertEmails() {
    const input = inputEmailFormatter.value;
    const rawEntries = input
      .split(/[\n;,]+/)
      .map(entry => entry.trim())
      .filter(entry => entry.length > 0);
    const parsedList = rawEntries.map(entry => {
      const match = entry.match(/<?([\w.-]+@[\w.-]+\.\w+)>?/);
      if (match) {
        const email = match[1].trim();
        const name = extractNameFromEmail(email);
        return `${name} <${email}>`;
      } else {
        return entry;
      }
    });
    outputEmailFormatter.value = parsedList.join(",\n");
}

// Function for name-only conversion
function convertEmailsToNamesOnly() {
    const input = inputEmailFormatter.value;
    const rawEntries = input
      .split(/[\n;,]+/)
      .map(entry => entry.trim())
      .filter(entry => entry.length > 0);

    const nameList = rawEntries.map(entry => {
      const match = entry.match(/<?([\w.-]+@[\w.-]+\.\w+)>?/);
      if (match) {
        const email = match[1].trim();
        // This is the only part that's different:
        // It calls extractNameFromEmail but doesn't include the email address.
        return extractNameFromEmail(email);
      } else {
        // If it's not an email, assume it's already a name
        return entry;
      }
    });

    outputEmailFormatter.value = nameList.join(", ");
}

function copyEmails() {
    outputEmailFormatter.select();
    document.execCommand("copy");
    showToast("Email list copied!");
}

// --- Job Manager Functions ---

async function fetchAndPopulateData() {
    const elements = {
        jobTypeLabel: document.getElementById('jobTypeLabel'),
        odsCodeLabel: document.getElementById('ods-code'),
        practiceInputJobManager: document.getElementById('practiceDropdown'),
        jobIdInput: document.getElementById('job-id'),
        jobTitleDisplay: document.getElementById('jobTitleDisplay'),
        docInput: document.getElementById('documentDropdown'),
        docAutocompleteResults: document.getElementById('autocompleteResults'),
        jobIdAutocompleteResults: document.getElementById('jobIdAutocompleteResultsContainer'),
        mailroomOriginalName: document.getElementById('mailroom-original-name'),
        mailroomNhsNo: document.getElementById('mailroom-nhs-no'),
        mailroomPatientName: document.getElementById('mailroom-patient-name'),
        mailroomReason: document.getElementById('mailroom-reason'),
        mailroomRejectedByOn: document.getElementById('mailroom-rejected-by-on'),
        mailroomStatus: document.getElementById('mailroom-status'),
        mailroomJobId: document.getElementById('mailroom-job-id'),
        mailroomInferredType: document.getElementById('mailroom-inferred-type'),
        documentActionsSection: document.getElementById('documentActionsSection'),
        mailroomDetailsSection: document.getElementById('mailroomDetailsSection'),
        jobTitleSection: document.getElementById('jobTitleSection')
    };

    const resetUI = () => {
        const textElements = [
            elements.jobTypeLabel,
            elements.odsCodeLabel,
            elements.mailroomOriginalName,
            elements.mailroomNhsNo,
            elements.mailroomPatientName,
            elements.mailroomReason,
            elements.mailroomRejectedByOn,
            elements.mailroomStatus,
            elements.mailroomJobId,
            elements.mailroomInferredType
        ];
        
        textElements.forEach(el => {
            if (el) el.textContent = '—';
        });

        if (elements.jobTitleDisplay) elements.jobTitleDisplay.value = '';
        if (elements.practiceInputJobManager) elements.practiceInputJobManager.value = '';
        if (elements.jobIdInput) elements.jobIdInput.value = '';
        
        if (elements.documentActionsSection) elements.documentActionsSection.style.display = 'none';
        if (elements.mailroomDetailsSection) elements.mailroomDetailsSection.style.display = 'none';
        if (elements.jobTitleSection) elements.jobTitleSection.style.display = 'none';
    };

    try {
        const { targetTabId } = await chrome.storage.local.get("targetTabId") || {};
        const { clickedMailroomDocData } = await chrome.storage.local.get("clickedMailroomDocData") || {};
        
        const dashboardUrlPrefix = "https://app.betterletter.ai/admin_panel/bots/dashboard";
        const annotationUrlRegex = /^https:\/\/app\.betterletter\.ai\/mailroom\/annotations\/(\d+)/;
        const jobPageUrlRegex = /^https:\/\/app\.betterletter\.ai\/admin_panel\/bots\/jobs\/([a-f0-9-]+)\/?/;
        const mailroomUrlPrefix = "https://app.betterletter.ai/mailroom/";

        const userTypedDocId = elements.docInput?.value || '';
        
        resetUI();

        if (!targetTabId) {
            showToast("No active tab context. Please ensure a tab is active.");
            if (elements.docInput) elements.docInput.value = userTypedDocId;
            return;
        }

        let currentTab;
        try {
            currentTab = await chrome.tabs.get(targetTabId);
            if (!currentTab?.url) {
                showToast("Cannot read URL from the active tab.");
                if (elements.docInput) elements.docInput.value = userTypedDocId;
                return;
            }
        } catch (e) {
            showToast("Target tab no longer exists or is inaccessible.");
            if (elements.docInput) elements.docInput.value = userTypedDocId;
            return;
        }

        if (clickedMailroomDocData) {
            console.log("Using Mailroom Document data:", clickedMailroomDocData);
            
            if (elements.docInput) elements.docInput.value = clickedMailroomDocData.documentId || "";
            if (elements.mailroomOriginalName) elements.mailroomOriginalName.textContent = clickedMailroomDocData.originalNameContent || "—";
            if (elements.mailroomNhsNo) elements.mailroomNhsNo.textContent = clickedMailroomDocData.nhsNo || "—";
            if (elements.mailroomPatientName) elements.mailroomPatientName.textContent = clickedMailroomDocData.patientName || "—";
            if (elements.mailroomReason) elements.mailroomReason.textContent = clickedMailroomDocData.reason || "—";
            if (elements.mailroomRejectedByOn) elements.mailroomRejectedByOn.textContent = clickedMailroomDocData.rejectedByOn || "—";
            if (elements.mailroomStatus) elements.mailroomStatus.textContent = clickedMailroomDocData.status || "—";
            if (elements.mailroomJobId) elements.mailroomJobId.textContent = clickedMailroomDocData.jobId || "—";
            if (elements.mailroomInferredType) elements.mailroomInferredType.textContent = clickedMailroomDocData.inferredJobType || "—";

            if (elements.mailroomDetailsSection) elements.mailroomDetailsSection.style.display = 'block';
            await chrome.storage.local.remove("clickedMailroomDocData");

            if (elements.docInput?.value && /^\d+$/.test(elements.docInput.value)) {
                if (elements.documentActionsSection) elements.documentActionsSection.style.display = 'block';
            }
            return;
        }

        const jobPageMatch = currentTab.url.match(jobPageUrlRegex);
        let extractedJobIdFromUrl = null;
        
        if (jobPageMatch?.[1]) {
            extractedJobIdFromUrl = jobPageMatch[1];
            
            setTimeout(async () => {
                try {
                    const tabs = await chrome.tabs.query({ url: currentTab.url, currentWindow: false });
                    if (tabs.length > 0 && tabs[0].id) {
                        const [{ result }] = await chrome.scripting.executeScript({
                            target: { tabId: tabs[0].id },
                            func: () => {
                                const pageContent = document.body.textContent;
                                const tagStart = '<Title>';
                                const tagEnd = '</Title>';
                                const startIndex = pageContent.indexOf(tagStart);
                                if (startIndex !== -1) {
                                    const endIndex = pageContent.indexOf(tagEnd, startIndex + tagStart.length);
                                    if (endIndex !== -1) {
                                        return pageContent.substring(
                                            startIndex + tagStart.length, 
                                            endIndex
                                        ).trim();
                                    }
                                }
                                return null;
                            }
                        });
                        
                        if (elements.jobTitleDisplay) {
                            elements.jobTitleDisplay.value = result || "Title not found";
                            if (elements.jobTitleSection) elements.jobTitleSection.style.display = 'block';
                        }
                    }
                } catch (e) {
                    console.error("Error extracting job title:", e);
                    if (elements.jobTitleDisplay) {
                        elements.jobTitleDisplay.value = "Error extracting title";
                        if (elements.jobTitleSection) elements.jobTitleSection.style.display = 'block';
                    }
                }
            }, 100);
        }

        const annotationMatch = currentTab.url.match(annotationUrlRegex);
        const extractedDocIdFromUrl = annotationMatch?.[1] || null;

        if (currentTab.url.startsWith(dashboardUrlPrefix)) {
            try {
                const [{ result }] = await chrome.scripting.executeScript({
                    target: { tabId: targetTabId },
                    func: () => {
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

                if (result?.length > 0) {
                    jobData = result;
                    uniquePractices = [];
                    const practiceMap = new Map();

                    jobData.forEach(job => {
                        if (job.practiceName && job.odsCode) {
                            practiceMap.set(job.practiceName, job.odsCode);
                        }
                    });

                    uniquePractices = Array.from(practiceMap, ([name, code]) => ({ practiceName: name, odsCode: code }));

                    if (elements.jobTypeLabel) elements.jobTypeLabel.textContent = jobData[0].jobType || "—";
                    if (elements.odsCodeLabel) elements.odsCodeLabel.textContent = jobData[0].odsCode || "—";
                    if (elements.practiceInputJobManager) elements.practiceInputJobManager.value = "";

                    filterAndDisplaySuggestions();
                    filterAndDisplayPracticeSuggestions();
                    filterAndDisplayJobIdSuggestions();
                } else {
                    showToast("No job data found on this Dashboard page.");
                    if (elements.jobTypeLabel) elements.jobTypeLabel.textContent = "—";
                    if (elements.odsCodeLabel) elements.odsCodeLabel.textContent = "—";
                    if (elements.practiceInputJobManager) elements.practiceInputJobManager.value = "";
                }
            } catch (err) {
                console.error("Error fetching dashboard data:", err);
                showToast("Failed to fetch data from dashboard.");
                if (elements.jobTypeLabel) elements.jobTypeLabel.textContent = "—";
                if (elements.odsCodeLabel) elements.odsCodeLabel.textContent = "—";
                if (elements.practiceInputJobManager) elements.practiceInputJobManager.value = "";
            }
        } else {
            jobData = [];
            uniquePractices = [];
            if (elements.jobTypeLabel) elements.jobTypeLabel.textContent = "—";
            if (elements.odsCodeLabel) elements.odsCodeLabel.textContent = "—";
            if (elements.practiceInputJobManager) elements.practiceInputJobManager.value = "";
        }

        if (extractedJobIdFromUrl) {
            if (elements.jobIdInput) elements.jobIdInput.value = extractedJobIdFromUrl;
            if (elements.jobIdAutocompleteResults) elements.jobIdAutocompleteResults.innerHTML = "";
        } else if (!currentTab.url.startsWith(dashboardUrlPrefix) && !currentTab.url.startsWith(mailroomUrlPrefix)) {
            if (elements.jobIdInput) elements.jobIdInput.value = "";
            if (elements.jobIdAutocompleteResults) elements.jobIdAutocompleteResults.innerHTML = "";
        }

        if (extractedDocIdFromUrl) {
            if (elements.docInput) {
                elements.docInput.value = extractedDocIdFromUrl;
                elements.docInput.dispatchEvent(new Event('input'));
            }
        } else if (userTypedDocId) {
            if (elements.docInput) {
                elements.docInput.value = userTypedDocId;
                elements.docInput.dispatchEvent(new Event('input'));
            }
        } else if (!currentTab.url.startsWith(dashboardUrlPrefix) && !currentTab.url.startsWith(mailroomUrlPrefix)) {
            if (elements.docInput) elements.docInput.value = "";
        }

        if (elements.docInput?.value && /^\d+$/.test(elements.docInput.value)) {
            if (elements.documentActionsSection) elements.documentActionsSection.style.display = 'block';
        } else {
            if (elements.documentActionsSection) elements.documentActionsSection.style.display = 'none';
        }

    } catch (err) {
        console.error("Unexpected error in fetchAndPopulateData:", err);
        showToast("An unexpected error occurred");
        resetUI();
    }
}

function filterAndDisplaySuggestions() {
    const searchTerm = docInput.value.trim().toLowerCase();
    autocompleteResultsContainer.innerHTML = '';
    autocompleteResultsContainer.style.display = 'none';
    docActive = -1;

    const isInputFocused = (document.activeElement === docInput);

    if (!searchTerm && (!isInputFocused || jobData.length === 0)) {
        return;
    }

    let filteredData = jobData;
    if (searchTerm) {
        filteredData = jobData.filter(job =>
            (job.documentId || '').toLowerCase().includes(searchTerm) ||
            (job.practiceName || '').toLowerCase().includes(searchTerm)
        );
    }

    if (filteredData.length === 0) {
        return;
    }

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
            item.dataset.documentId = job.documentId;
            item.addEventListener('click', () => { selectSuggestion(item); });
            autocompleteResultsContainer.appendChild(item);
        }
    });

    if (autocompleteResultsContainer.children.length > 0 && isInputFocused) {
        autocompleteResultsContainer.style.position = 'absolute';
        autocompleteResultsContainer.style.top = '100%';
        autocompleteResultsContainer.style.left = '0';
        autocompleteResultsContainer.style.width = '100%';
        autocompleteResultsContainer.style.display = 'block';
    }
}

function selectSuggestion(item) {
    const selectedDocId = item.dataset.documentId;
    docInput.value = selectedDocId;
    autocompleteResultsContainer.style.display = 'none';
    docInput.dispatchEvent(new Event('input'));
    docActive = -1;
}

function filterAndDisplayPracticeSuggestions() {
    const practiceInput = document.getElementById('practiceDropdown');
    const resultsContainer = document.getElementById('practiceAutocompleteResultsContainer');
    
    if (!practiceInput || !resultsContainer) {
        console.warn('Practice autocomplete elements not found');
        return;
    }

    const searchTerm = practiceInput.value.trim().toLowerCase();
    if (searchTerm.length < 2) {
        resultsContainer.innerHTML = '';
        resultsContainer.style.display = 'none';
        return;
    }

    const isInputFocused = (document.activeElement === practiceInput);
    
    if (!searchTerm && (!isInputFocused || !uniquePractices?.length)) {
        safeSetInnerHTML(resultsContainer, '');
        resultsContainer.style.display = 'none';
        return;
    }

    try {
        toggleLoadingState(practiceInput, true);
        safeSetInnerHTML(resultsContainer, '');
        resultsContainer.style.display = 'none';
        practiceActive = -1;

        const allPractices = Object.values(cachedPractices).map(p => ({
            practiceName: p.name,
            odsCode: p.ods
        }));

        let filteredData;
        if (searchTerm) {
            filteredData = allPractices.filter(p => 
                (p.practiceName?.toLowerCase().includes(searchTerm) || 
                 p.odsCode?.toLowerCase().includes(searchTerm))
            );
        } else {
            filteredData = allPractices;
        }

        if (filteredData.length === 0) {
            const noResults = document.createElement('div');
            noResults.className = 'autocomplete-item';
            noResults.textContent = 'No matching practices found';
            resultsContainer.appendChild(noResults);
        } else {
            filteredData.forEach(p => {
                if (p.practiceName && p.odsCode) {
                    const item = document.createElement('div');
                    item.className = 'autocomplete-item';
                    item.innerHTML = `
                        <div class="suggestion-main">${p.practiceName}</div>
                        <div class="suggestion-meta">${p.odsCode}</div>
                    `;
                    item.dataset.practiceName = p.practiceName;
                    item.dataset.odsCode = p.odsCode;
                    item.addEventListener('click', () => {
                        selectPracticeSuggestion(p);
                        resultsContainer.style.display = 'none';
                    });
                    resultsContainer.appendChild(item);
                }
            });
        }

        if (resultsContainer.children.length > 0 && isInputFocused) {
            resultsContainer.style.position = 'absolute';
            resultsContainer.style.top = '100%';
            resultsContainer.style.left = '0';
            resultsContainer.style.width = '100%';
            resultsContainer.style.display = 'block';
        }
    } catch (error) {
        console.error('Error in practice suggestions:', error);
        safeSetInnerHTML(resultsContainer, '');
    } finally {
        toggleLoadingState(practiceInput, false);
    }
}

function selectPracticeSuggestion(practice) {
  setSelectedPractice(practice, {
    updateInput: true,
    triggerStatus: true
  });
}


function filterAndDisplayJobIdSuggestions() {
    const currentDocId = getNumericDocIdFromInput(docInput.value);
    let relevantJobIds = [];

    if (currentDocId) {
        const matchingJobs = jobData.filter(job => job.documentId === currentDocId);
        const uniqueJobIds = new Set(matchingJobs.map(job => job.jobId).filter(Boolean));
        relevantJobIds = Array.from(uniqueJobIds);
    }

    jobIdAutocompleteResultsContainer.innerHTML = '';
    jobIdAutocompleteResultsContainer.style.display = 'none';
    jobIdActive = -1;

    const isInputFocused = (document.activeElement === jobIdInput);

    if (relevantJobIds.length === 0 || !isInputFocused) {
        return;
    }

    relevantJobIds.forEach(jobId => {
        const item = document.createElement('div');
        item.classList.add('autocomplete-item');
        item.textContent = jobId;
        item.dataset.jobId = jobId;
        item.addEventListener('click', () => { selectJobIdSuggestion(item); });
        jobIdAutocompleteResultsContainer.appendChild(item);
    });

    if (jobIdAutocompleteResultsContainer.children.length > 0 && isInputFocused) {
        jobIdAutocompleteResultsContainer.style.position = 'absolute';
        jobIdAutocompleteResultsContainer.style.top = '100%';
        jobIdAutocompleteResultsContainer.style.left = '0';
        jobIdAutocompleteResultsContainer.style.width = '100%';
        jobIdAutocompleteResultsContainer.style.display = 'block';
    }
}

function selectJobIdSuggestion(item) {
    const selectedJobId = item.dataset.jobId;
    jobIdInput.value = selectedJobId;
    jobIdAutocompleteResultsContainer.style.display = 'none';
    jobIdActive = -1;
}

// --- Main DOM Content Loaded Listener ---
document.addEventListener('DOMContentLoaded', async () => {
    // Assign all UI elements
    toastEl = document.getElementById("toast");

    // Practice Navigator Elements
    practiceNavigatorView = document.getElementById('practiceNavigatorView');
    statusDisplayEl = document.getElementById('statusDisplay');
    statusEl = document.getElementById('status');
    cdbSearchResultEl = document.getElementById('cdbSearchResult');
    resetSettingsBtn = document.getElementById('resetSettingsBtn');
    practiceInputEl = document.getElementById('practiceInput');
    suggestionsList = document.getElementById('suggestions');
    docmanJobSelectNav = document.getElementById('docmanJobSelectNav');
    emisJobSelectNav = document.getElementById('emisJobSelectNav');
    cdbSearchInputEl = document.getElementById('cdbSearchInput');
    cdbSuggestionsList = document.getElementById('cdbSuggestions');

    function openSingleJobDashboard(jobType) {
        if (!jobType) return;

        const ods = requireSelectedOdsCode(); // ✅ hard-fail if invalid

        const url =
            `https://app.betterletter.ai/admin_panel/bots/dashboard` +
            `?job_types=${encodeURIComponent(jobType)}` +
            `&practice_ids=${encodeURIComponent(ods)}` +
            `&status=paused`;

        openTabWithTimeout(url);
    }

    // Job Manager Elements
    jobManagerView = document.getElementById('jobManagerView');
    docInput = document.getElementById("documentDropdown");
    autocompleteResultsContainer = document.getElementById("autocompleteResults");
    copyDocBtn = document.getElementById("copySelectedDocId");
    statusBtn = document.getElementById("openDocumentStatus");
    obanBtn = document.getElementById("openObanJob");
    annoBtn = document.getElementById("openAnnotation");
    eventLogBtn = document.getElementById("openEventLog");
    letterAdminBtn = document.getElementById("openLetterAdmin");
    odsCodeLabel = document.getElementById("ods-code");
    openPracticeBtn = document.getElementById("openPractice");
    jobTypeLabel = document.getElementById("job-type-label");
    jobIdInput = document.getElementById("job-id");
    copyJobBtn = document.getElementById("copy-job-id");
    openJobBtn = document.getElementById("openJobDirect");
    documentSelectionSection = document.getElementById("documentSelectionSection");
    documentActionsSection = document.getElementById("documentActionsSection");
    practiceInputJobManager = document.getElementById("practiceDropdown");
    practiceAutocompleteResultsContainer = document.getElementById("practiceAutocompleteResultsContainer");
    jobTitleSection = document.getElementById("jobTitleSection");
    jobTitleDisplay = document.getElementById("jobTitleDisplay");
    copyJobTitle = document.getElementById("copyJobTitle");
    copyPracticeNameBtn = document.getElementById("copyPracticeName");
    copyJobPageUrlBtn = document.getElementById("copyJobPageUrl");
    jobIdAutocompleteResultsContainer = document.getElementById("jobIdAutocompleteResults");
    clearDocIdBtn = document.getElementById("clearDocId");
    mailroomDetailsSection = document.getElementById("mailroomDetailsSection");
    mailroomOriginalName = document.getElementById("mailroom-original-name");
    mailroomNhsNo = document.getElementById("mailroom-nhs-no");
    mailroomPatientName = document.getElementById("mailroom-patient-name");
    mailroomReason = document.getElementById("mailroom-reason");
    mailroomRejectedByOn = document.getElementById("mailroom-rejected-by-on");
    mailroomStatus = document.getElementById("mailroom-status");
    mailroomJobId = document.getElementById("mailroom-job-id");
    mailroomInferredType = document.getElementById("mailroom-inferred-type");
    copyMailroomDetailsBtn = document.getElementById("copyMailroomDetails");
    const jobStatusInput = document.getElementById('jobStatusInput');
    const openJobStatusBtn = document.getElementById('openJobStatusBtn');
    const copyJobStatusIdBtn = document.getElementById('copyJobStatusIdBtn');
    const copyJobStatusUrlBtn = document.getElementById('copyJobStatusUrlBtn');
    const clearJobStatusInputBtn = document.getElementById('clearJobStatusInputBtn');

    openJobStatusBtn.disabled = true;
    copyJobStatusIdBtn.disabled = true;
    copyJobStatusUrlBtn.disabled = true;
    clearJobStatusInputBtn.disabled = true;

    // Email Formatter Elements
    emailFormatterView = document.getElementById('emailFormatterView');
    inputEmailFormatter = document.getElementById("inputEmailFormatter");
    outputEmailFormatter = document.getElementById("outputEmailFormatter");
    convertEmailBtn = document.getElementById("convertEmailBtn");
    copyEmailBtn = document.getElementById("copyEmailBtn");
    const nameOnlyBtn = document.getElementById('nameOnlyBtn');

    // Initial View Setup
    showView('practiceNavigatorView');

    const openEhrSettingsBtn = document.getElementById('openEhrSettingsBtn');

    if (openEhrSettingsBtn) {
        openEhrSettingsBtn.addEventListener('click', async () => {
            try {
            const ods = requireSelectedOdsCode();

            await chrome.runtime.sendMessage({
                action: 'openPractice',
                input: ods,
                settingType: 'ehr_settings'
            });
            } catch (error) {
            console.error('EHR Settings open failed:', error);
            showStatus('Please select a practice first.', 'error');
            }
        });
    }

    // ------------------------------
    // Job Dropdown Listeners (FIX)
    // ------------------------------

    if (docmanJobSelectNav) {
        docmanJobSelectNav.addEventListener('change', (event) => {
            const jobType = event.target.value;

            if (!jobType) return;

            try {
                openSingleJobDashboard(jobType);
            } catch (err) {
                console.error('Docman job open failed:', err);
            }

            // Reset dropdown after opening
            event.target.value = '';
        });
    }

    if (emisJobSelectNav) {
        emisJobSelectNav.addEventListener('change', (event) => {
            const jobType = event.target.value;

            if (!jobType) return;

            try {
                openSingleJobDashboard(jobType);
            } catch (err) {
                console.error('EMIS job open failed:', err);
            }

            // Reset dropdown after opening
            event.target.value = '';
        });
    }


    // Global Navigation Toggle Buttons
    document.getElementById("navigatorGlobalToggleBtn").addEventListener("click", () => showView('practiceNavigatorView'));
    document.getElementById("jobManagerGlobalToggleBtn").addEventListener("click", () => showView('jobManagerView'));
    document.getElementById("emailFormatterGlobalToggleBtn").addEventListener("click", () => showView('emailFormatterView'));

    // Practice Navigator Event Listeners
    setNavigatorButtonsState(false);

    if (resetSettingsBtn) {
        resetSettingsBtn.addEventListener('click', () => {
            practiceInputEl.value = '';
            suggestionsList.style.display = 'none';
            cdbSuggestionsList.style.display = 'none';
            clearSelectedPractice();
            setNavigatorButtonsState(false);;
            if (statusDisplayEl) statusDisplayEl.style.display = 'none';
            if (cdbSearchResultEl) cdbSearchResultEl.style.display = 'none';
            showStatus('Settings reset.', 'success');
            setTimeout(() => statusEl.style.display = 'none', 1500);
        });
    }

    // Initial check for cache
    try {
        const response = await chrome.runtime.sendMessage({ action: 'getPracticeCache' });
        if (response && response.practiceCache && Object.keys(response.practiceCache).length > 0) {
            cachedPractices = response.practiceCache;
            console.log(`%c[Merged UI] Practice suggestions loaded from background. Cache size: ${Object.keys(cachedPractices).length}`, 'color: blue;');
            updateContextualButtonsOnInput(false);
            showStatus('Practice cache loaded.', 'success');

            if (practiceInputEl.value.trim() !== '') {
                const foundPractice = Object.values(cachedPractices).find(p =>
                    `${p.name} (${p.ods})`.toLowerCase() === practiceInputEl.value.toLowerCase().trim() ||
                    p.ods.toLowerCase() === practiceInputEl.value.toLowerCase().trim()
                );
                if (foundPractice) {
                    setSelectedPractice(foundPractice, { updateInput: true, triggerStatus: true });
                } else {
                    clearSelectedPractice();
                }

            }
            if (statusEl) setTimeout(() => statusEl.style.display = 'none', 1500);
        } else {
            console.log('%c[Merged UI] Cache empty or not loaded. Requesting active foreground scrape...', 'color: orange;');
            showStatus('Loading practices... Please wait.', 'loading');
            try {
                const scrapeResponse = await new Promise(resolve => {
                    chrome.runtime.sendMessage({ action: 'requestActiveScrape' }, resolve);
                });
                if (scrapeResponse && scrapeResponse.success) {
                    const newCacheResponse = await chrome.runtime.sendMessage({ action: 'getPracticeCache' });
                    if (newCacheResponse && newCacheResponse.practiceCache && Object.keys(newCacheResponse.practiceCache).length > 0) {
                        cachedPractices = newCacheResponse.practiceCache;
                        console.log(`%c[Merged UI] Practice suggestions loaded after active scrape. Cache size: ${Object.keys(cachedPractices).length}`, 'color: blue;');
                        updateContextualButtonsOnInput(false);
                        showStatus('Practices loaded successfully!', 'success');
                        if (statusEl) setTimeout(() => statusEl.style.display = 'none', 2000);
                    } else {
                         showStatus('Practices loaded, but cache still empty.', 'error');
                         console.error('%c[Merged UI] Active scrape reported success but cache still empty.', 'color: red;');
                    }
                } else {
                  showStatus(`Failed to load practices: ${scrapeResponse?.error || 'Unknown error'}`, 'error');
                  console.error(`%c[Merged UI] Active scrape request failed: ${scrapeResponse?.error}`, 'color: red;');
                }
            } catch (scrapeErr) {
                showStatus(`Error fetching status: ${scrapeErr.message}`, 'error');
                console.error(`%c[Merged UI] Error during active scrape request: ${scrapeErr.message}`, 'color: red;', scrapeErr);
            }
        }
    } catch (error) {
        console.error(`%c[Merged UI] Error during initial cache load: ${error.message}`, 'color: red;', error);
        showStatus('Failed to load practice data. Check console.', 'error');
    }

    document.getElementById('practicesBtn').addEventListener('click', () => {
        chrome.tabs.create({ url: 'https://app.betterletter.ai/admin_panel/practices' });
    });
    
    // Add the click listener for the new Import button
    document.getElementById('collectionBtn').addEventListener('click', () => {
    if (currentSelectedOdsCode) {
        const url = `https://app.betterletter.ai/admin_panel/bots/dashboard?job_types=docman_import+emis_prepare&practice_ids=${currentSelectedOdsCode}&status=paused`;
        chrome.tabs.create({ url });
    } else {
        showToast('Please select a valid practice first.');
    }
    });

    document.getElementById('usersBtn').addEventListener('click', () => {
        if (currentSelectedOdsCode) {
            const url = `https://app.betterletter.ai/mailroom/practices/${currentSelectedOdsCode}/users`;
            chrome.tabs.create({ url });
        } else {
            showStatus('Please select a valid practice first to view users.', 'error');
        }
    });

    document.getElementById('preparingBtn').addEventListener('click', () => {
        if (currentSelectedOdsCode) {
            const url = `https://app.betterletter.ai/mailroom/preparing?only_action_items=true&practice=${currentSelectedOdsCode}&service=self&sort=upload_date&sort_dir=asc&urgent=false`;
            chrome.tabs.create({ url });
        } else {
            showStatus('Please select a valid practice first.', 'error');
        }
    });

    document.getElementById('rejectedBtn').addEventListener('click', () => {
        if (currentSelectedOdsCode) {
            const url = `https://app.betterletter.ai/mailroom/rejected?practice=${currentSelectedOdsCode}&service=full&show_processed=false&sort=inserted_at&sort_dir=asc`;
            chrome.tabs.create({ url });
        } else {
            showStatus('Please select a valid practice first.', 'error');
        }
    });

    document.getElementById('createPracticeAdminBtn').addEventListener('click', () => {
        chrome.tabs.create({ url: 'https://app.betterletter.ai/admin_panel/practices/new' });
    });

    practiceInputEl.addEventListener('input', () => {
        const query = practiceInputEl.value.toLowerCase().trim();
        const cachedPracticeDisplayNames = Object.keys(cachedPractices);

        if (!query) {
            const practicesToShow = cachedPracticeDisplayNames;
            suggestionsList.innerHTML = '';
            practicesToShow.forEach(name => {
                const li = document.createElement('li');
                li.textContent = name;
                li.addEventListener('click', () => {
                    const practiceObj = cachedPractices[name] || name; // name is "Practice (ODS)"
                    selectPracticeSuggestion(practiceObj);             // sets ODS + enables buttons + shows status
                    suggestionsList.style.display = 'none';
                });
                suggestionsList.appendChild(li);
            });
            suggestionsList.style.display = 'block';
            updateContextualButtonsOnInput(false);
            return;
        }

        const matches = cachedPracticeDisplayNames
            .filter(name => name.toLowerCase().includes(query))
            .slice(0, 8);

        suggestionsList.innerHTML = '';
        if (matches.length === 0) {
            suggestionsList.style.display = 'none';
            setNavigatorButtonsState(false);
            return;
        }

        matches.forEach(name => {
            const li = document.createElement('li');
            li.textContent = name;
            li.addEventListener('click', () => {
                const practiceObj = cachedPractices[name] || name; // name is "Practice (ODS)"
                selectPracticeSuggestion(practiceObj);             // sets ODS + enables buttons + shows status
                suggestionsList.style.display = 'none';
            });
            suggestionsList.appendChild(li);
        });
        suggestionsList.style.display = 'block';
        updateContextualButtonsOnInput(false);
    });

    practiceInputEl.addEventListener('focus', () => {
        if (practiceInputEl.value.trim() === '') {
            practiceInputEl.dispatchEvent(new Event('input'));
        }
    });

    practiceInputEl.addEventListener('keydown', (e) => {
        const items = suggestionsList.querySelectorAll('li');
        if (items.length === 0 || suggestionsList.style.display === 'none') return;
        let currentIndex = -1;
        items.forEach((item, i) => { if (item.classList.contains('highlighted')) { currentIndex = i; item.classList.remove('highlighted'); } });
        switch (e.key) {
          case 'ArrowDown': e.preventDefault(); currentIndex = (currentIndex + 1) % items.length; break;
          case 'ArrowUp': e.preventDefault(); currentIndex = (currentIndex - 1 + items.length) % items.length; break;
          case 'Enter': e.preventDefault(); if (currentIndex >= 0 && items[currentIndex]) { items[currentIndex].click(); } return;
          case 'Escape': e.preventDefault(); suggestionsList.style.display = 'none'; return;
          default: return;
        }
        if (currentIndex >= 0 && items[currentIndex]) { items[currentIndex].classList.add('highlighted'); items[currentIndex].scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
    });

    document.getElementById('searchCdbBtn').addEventListener('click', async () => {
        const cdbSearchInput = cdbSearchInputEl.value.trim();
        if (statusDisplayEl) statusDisplayEl.style.display = 'none';
        if (cdbSearchResultEl) cdbSearchResultEl.style.display = 'none';

        if (!cdbSearchInput) { showStatus('Please enter a CDB code to search.', 'error'); return; }
        showStatus('Searching for practice by CDB (this is a heavy operation)...', 'loading');
        if (cdbSearchResultEl) { cdbSearchResultEl.innerHTML = '<div class="text-center py-2">Searching... This might take a moment as it checks all practices.</div>'; cdbSearchResultEl.style.display = 'block'; }

        try {
            const response = await new Promise(resolve => {
                chrome.runtime.sendMessage({ action: 'searchCDB', cdb: cdbSearchInput }, resolve);
            });
            if (response && response.success && response.practice) {
                if (cdbSearchResultEl) {
                    cdbSearchResultEl.innerHTML = `
                        <strong>Practice Found:</strong><br>
                        <strong>Name:</strong> ${response.practice.name}<br>
                        <strong>ODS:</strong> ${response.practice.ods}<br>
                        <strong>CDB:</strong> ${response.practice.cdb}
                    `;
                    cdbSearchResultEl.style.display = 'block';
                }
                showStatus('Practice found by CDB!', 'success');
                practiceInputEl.value = `${response.practice.name} (${response.practice.ods})`;
                setSelectedPractice({ name: response.practice.name, ods: response.practice.ods }, { updateInput: true, triggerStatus: true });
                updateContextualButtonsOnInput(true);
            } else {
                if (cdbSearchResultEl) {
                    cdbSearchResultEl.innerHTML = `<strong class="text-red-500">Error:</strong> ${response?.error || 'Practice not found for this CDB.'}`;
                    cdbSearchResultEl.style.display = 'block';
                }
                showStatus(`Search failed: ${response?.error || 'Practice not found.'}`, 'error');
                console.error(`%c[Merged UI] CDB Search failed: ${response?.error}`, 'color: red;');
            }
        } catch (err) {
            showStatus(`Error during CDB search: ${err.message}`, 'error');
            console.error(`%c[Merged UI] Error during CDB search: ${err.message}`, 'color: red;', err);
        }
    });

    cdbSearchInputEl.addEventListener('input', () => {
        const query = cdbSearchInputEl.value.toLowerCase().trim();
        const practicesWithValidCDB = Object.values(cachedPractices).filter(p => p.cdb && p.cdb !== 'N/A' && p.cdb !== 'Error');
        const matches = query ? practicesWithValidCDB.filter(p => p.cdb.toLowerCase().includes(query)) : practicesWithValidCDB;
        const displayMatches = matches.map(p => ({ displayName: `${p.name} (${p.ods}) - ${p.cdb}`, ods: p.ods, cdb: p.cdb, name: p.name })).slice(0, 8);

        cdbSuggestionsList.innerHTML = '';
        if (displayMatches.length === 0) { cdbSuggestionsList.style.display = 'none'; return; }

        displayMatches.forEach(match => {
            const li = document.createElement('li');
            li.textContent = match.displayName;
            li.addEventListener('click', () => {
                cdbSearchInputEl.value = match.cdb;
                practiceInputEl.value = `${match.name} (${match.ods})`;
                setSelectedPractice({ name: match.name, ods: match.ods }, { updateInput: true, triggerStatus: true });
                cdbSuggestionsList.style.display = 'none';
                updateContextualButtonsOnInput(true);
            });
            cdbSuggestionsList.appendChild(li);
        });
        cdbSuggestionsList.style.display = 'block';
    });

    cdbSearchInputEl.addEventListener('focus', () => { if (cdbSearchInputEl.value.trim() === '') { cdbSearchInputEl.dispatchEvent(new Event('input')); } });

    cdbSearchInputEl.addEventListener('keydown', (e) => {
        const items = cdbSuggestionsList.querySelectorAll('li');
        if (items.length === 0 || cdbSuggestionsList.style.display === 'none') return;
        let currentIndex = -1;
        items.forEach((item, i) => { if (item.classList.contains('highlighted')) { currentIndex = i; item.classList.remove('highlighted'); } });
        switch (e.key) {
          case 'ArrowDown': e.preventDefault(); currentIndex = (currentIndex + 1) % items.length; break;
          case 'ArrowUp': e.preventDefault(); currentIndex = (currentIndex - 1 + items.length) % items.length; break;
          case 'Enter': e.preventDefault(); if (currentIndex >= 0 && items[currentIndex]) { items[currentIndex].click(); } return;
          case 'Escape': e.preventDefault(); cdbSuggestionsList.style.display = 'none'; return;
          default: return;
        }
        if (currentIndex >= 0 && items[currentIndex]) { items[currentIndex].classList.add('highlighted'); items[currentIndex].scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
    });

    // Email Formatter Event Listeners
    convertEmailBtn.addEventListener("click", convertEmails);
    if (nameOnlyBtn) {
    nameOnlyBtn.addEventListener("click", convertEmailsToNamesOnly);
    }
    copyEmailBtn.addEventListener("click", copyEmails);

    // Job Manager Event Listeners

    clearDocIdBtn.onclick = () => {
        docInput.value = "";
        docInput.dispatchEvent(new Event('input'));
        showToast("Document ID cleared.");
        docInput.focus();
    };

    // --- Add listeners for Bot Jobs Buttons ---
    document.getElementById('docmanJobsBtn').addEventListener('click', () => {
        const odsCode = odsCodeLabel.textContent.trim();
        if (odsCode && odsCode !== '—') {
            const url = `https://app.betterletter.ai/admin_panel/bots/dashboard?job_types=generate_output+docman_upload+docman_file+docman_review+docman_delete_original&status=paused&practice_ids=${odsCode}`;
            chrome.tabs.create({ url });
        } else {
            showToast('Please select a practice first.');
        }
    });

    document.getElementById('emisJobsBtn').addEventListener('click', () => {
        const odsCode = odsCodeLabel.textContent.trim();
        if (odsCode && odsCode !== '—') {
            const url = `https://app.betterletter.ai/admin_panel/bots/dashboard?job_types=emis_coding+emis_prepare+emis_delete_originals+emis_api_consultation&status=paused&practice_ids=${odsCode}`;
            chrome.tabs.create({ url });
        } else {
            showToast('Please select a practice first.');
        }
    });

    document.getElementById('docmanValidateBtn').addEventListener('click', () => {
        showToast('Docman Validate function is not yet implemented.');
    });

    copyDocBtn.onclick = () => {
      const docIdFullString = docInput.value.trim();
      const numericDocId = getNumericDocIdFromInput(docIdFullString);
      if (!numericDocId) return showToast("No Document ID");
      navigator.clipboard.writeText(`document_id = ${numericDocId}`);
      showToast(`Copied: document_id = ${numericDocId}`);
    };

    copyPracticeNameBtn.onclick = () => {
      const practiceName = practiceInputJobManager.value.trim();
      if (!practiceName) return showToast("No Practice Name to copy.");
      navigator.clipboard.writeText(practiceName);
      showToast(`Copied: ${practiceName}`);
    };

    statusBtn.onclick = () => {
      const docIdFullString = docInput.value.trim();
      const numericDocId = getNumericDocIdFromInput(docIdFullString);
      if (!numericDocId) return showToast("No Document ID");
      const url = `https://app.betterletter.ai/admin_panel/bots/dashboard?document_id=${numericDocId}`;

      navigator.clipboard.writeText(url).then(() => { showToast(`Copied URL: ${url}`); }).catch(err => { console.error("Failed to copy URL for Status:", err); showToast("Failed to copy URL."); });
      openTabWithTimeout(url);
    };

    obanBtn.onclick = () => {
      const docIdFullString = docInput.value.trim();
      const numericDocId = getNumericDocIdFromInput(docIdFullString);
      if (!numericDocId) return showToast("No Document ID");
      if (!/^\d+$/.test(numericDocId)) return showToast("Invalid Document ID");
      const url = `https://app.betterletter.ai/oban/jobs?args=document_id%2B%2B${numericDocId}&state=available`;

      navigator.clipboard.writeText(url).then(() => { showToast(`Copied URL: ${url}`); }).catch(err => { console.error("Failed to copy URL for Oban:", err); showToast("Failed to copy URL."); });
      openTabWithTimeout(url);
    };

    annoBtn.onclick = () => {
      const docIdFullString = docInput.value.trim();
      const numericDocId = getNumericDocIdFromInput(docIdFullString);
      if (!numericDocId) return showToast("No Document ID");
      const url = `https://app.betterletter.ai/mailroom/annotations/${numericDocId}`;

      navigator.clipboard.writeText(url).then(() => { showToast(`Copied URL: ${url}`); }).catch(err => { console.error("Failed to copy URL for Annotation:", err); showToast("Failed to copy URL."); });
      openTabWithTimeout(url);
    };

    eventLogBtn.onclick = () => {
        const docIdFullString = docInput.value.trim();
        const numericDocId = getNumericDocIdFromInput(docIdFullString);
        if (!numericDocId) return showToast("No Document ID");
        const url = `https://app.betterletter.ai/admin_panel/event_log/${numericDocId}`;

        navigator.clipboard.writeText(url).then(() => { showToast(`Copied URL: ${url}`); }).catch(err => { console.error("Failed to copy URL for Event Log:", err); showToast("Failed to copy URL."); });
        openTabWithTimeout(url);
    };

    letterAdminBtn.onclick = () => {
        const docIdFullString = docInput.value.trim();
        const numericDocId = getNumericDocIdFromInput(docIdFullString);
        if (!numericDocId) return showToast("No Document ID");
        const url = `https://app.betterletter.ai/admin_panel/letter/${numericDocId}`;

        navigator.clipboard.writeText(url).then(() => { showToast(`Copied URL: ${url}`); }).catch(err => { console.error("Failed to copy URL for L. Admin:", err); showToast("Failed to copy URL."); });
        openTabWithTimeout(url);
    };

    openJobBtn.onclick = () => {
      const jobId = jobIdInput.value;
      if (!jobId) return showToast("No Job ID");
      const url = `https://app.betterletter.ai/admin_panel/bots/jobs/${jobId}`;

      navigator.clipboard.writeText(url).then(() => { showToast(`Copied URL: ${url}`); }).catch(err => { console.error("Failed to copy URL for Job Page:", err); showToast("Failed to copy URL."); });
      openTabWithTimeout(url);

      setTimeout(async () => {
        try {
          const tabs = await chrome.tabs.query({ url: url, currentWindow: false });
          if (tabs.length > 0 && tabs[0].id) {
            const tabId = tabs[0].id;
            const [{ result }] = await chrome.scripting.executeScript({
              target: { tabId: tabId },
              func: () => {
                const pageContent = document.body.textContent;
                let extractedTitle = null;
                const tagStart = '<Title>';
                const tagEnd = '</Title>';
                const startIndex = pageContent.indexOf(tagStart);
                if (startIndex !== -1) {
                    const endIndex = pageContent.indexOf(tagEnd, startIndex + tagStart.length);
                    if (endIndex !== -1) {
                        extractedTitle = pageContent.substring(startIndex + tagStart.length, endIndex).trim();
                    }
                }
                return extractedTitle;
              }
            });
            if (result) {
              jobTitleDisplay.value = result;
              jobTitleSection.style.display = 'block';
            } else {
              jobTitleDisplay.value = "Title not found";
              jobTitleSection.style.display = 'block';
              showToast("Job title not found on page.");
            }
          }
        } catch (e) {
          console.error("Error extracting job title:", e);
          jobTitleDisplay.value = "Error extracting title";
          jobTitleSection.style.display = 'block';
          showToast("Error extracting job title.");
        }
      }, 1000);
    };

    copyJobTitle.onclick = () => {
      const titleText = jobTitleDisplay.value;
      if (titleText && titleText !== "Title not found" && titleText !== "Error extracting title") {
        const sanitizedTitleText = titleText.replace(/[^\x00-\x7F]+/g, '');
        navigator.clipboard.writeText(`edited_file_name = "${sanitizedTitleText}"`);
        showToast(`Copied: edited_file_name = "${sanitizedTitleText}"`);
      } else {
        showToast("No valid job title to copy.");
      }
    };

    copyJobPageUrlBtn.onclick = () => {
      const jobId = jobIdInput.value;
      if (!jobId) return showToast("No Job ID available to construct URL.");
      const jobPageUrl = `https://app.betterletter.ai/admin_panel/bots/jobs/${jobId}`;
      navigator.clipboard.writeText(jobPageUrl);
      showToast(`Copied Job URL: ${jobPageUrl}`);
    };

    openPracticeBtn.onclick = () => {
      const ods = odsCodeLabel.textContent.trim();
      const actualOds = ods.startsWith("ODS: ") ? ods.substring(5) : ods;
      if (!actualOds || actualOds === "—") {
        return showToast("No ODS Code found for the selected document.");
      }
      const url = `https://app.betterletter.ai/admin_panel/practices/${actualOds}`;
      openTabWithTimeout(url);
      showToast(`Opening Practice for ODS: ${actualOds}`);
    };

    copyJobBtn.onclick = () => {
      const jobType = jobTypeLabel.textContent;
      const jobId = jobIdInput.value;
      if (!jobType || !jobId || jobType === "—") return showToast("Missing Job ID or Type");
      navigator.clipboard.writeText(`${jobType}_job_id = "${jobId}"`);
      showToast(`Copied: ${jobType}_job_id = "${jobId}"`);
    };

    copyMailroomDetailsBtn.onclick = () => {
        let details = [];
        const originalName = mailroomOriginalName.textContent.trim();
        const nhsNo = mailroomNhsNo.textContent.trim();
        const patientName = mailroomPatientName.textContent.trim();
        const reason = mailroomReason.textContent.trim();
        const rejectedByOn = mailroomRejectedByOn.textContent.trim();
        const status = mailroomStatus.textContent.trim();
        const jobIdMailroom = mailroomJobId.textContent.trim();
        const inferredType = mailroomInferredType.textContent.trim();

        if (originalName && originalName !== '—') details.push(`Original Name: ${originalName}`);
        if (nhsNo && nhsNo !== '—') details.push(`NHS No.: ${nhsNo}`);
        if (patientName && patientName !== '—') details.push(`Patient Name: ${patientName}`);
        if (reason && reason !== '—') details.push(`Reason: ${reason}`);
        if (rejectedByOn && rejectedByOn !== '—') details.push(`Rejected By/On: ${rejectedByOn}`);
        if (status && status !== '—') details.push(`Status: ${status}`);
        if (jobIdMailroom && jobIdMailroom !== '—') details.push(`Job ID (Mailroom): ${jobIdMailroom}`);
        if (inferredType && inferredType !== '—') details.push(`Inferred Type: ${inferredType}`);

        if (details.length > 0) {
            navigator.clipboard.writeText(details.join('\n'));
            showToast("Mailroom details copied!");
        } else {
            showToast("No Mailroom details to copy.");
        }
    };

    // Autocomplete Event Listeners for Job Manager
    docInput.addEventListener("input", () => {
        const docIdFullString = docInput.value;
        const numericDocId = getNumericDocIdFromInput(docIdFullString);
        
        // Find a match in the currently scraped data
        const match = jobData.find(j => j.documentId === numericDocId);

        if (match) {
            // If a match is found, populate all the fields
            jobIdInput.value = match.jobId || '';
            jobTypeLabel.textContent = match.jobType || '—';
            practiceInputJobManager.value = match.practiceName || '';
            odsCodeLabel.textContent = match.odsCode || '—';
        } else {
            // If no match is found (e.g., you're not on a dashboard page),
            // clear the dependent fields
            clearDependentFields();
            practiceInputJobManager.value = "";
        }

        // Run the autocomplete for the Job ID field
        filterAndDisplayJobIdSuggestions();

        // **THE FIX**: This check now runs last to ensure the action
        // buttons appear whenever there's a valid ID in the box.
        if (numericDocId) {
            documentActionsSection.style.display = 'block';
        } else {
            documentActionsSection.style.display = 'none';
        }
    });

    docInput.addEventListener("focus", filterAndDisplaySuggestions);
    docInput.addEventListener("blur", hideSuggestions);
    docInput.addEventListener("keydown", (e) => {
        let items = autocompleteResultsContainer.querySelectorAll(".autocomplete-item");
        if (items.length === 0) return;
        if (e.key === "ArrowDown") { docActive = addActive(docActive, items); items[docActive].scrollIntoView({ block: "nearest" }); e.preventDefault(); }
        else if (e.key === "ArrowUp") { docActive = addActive(docActive, items); items[docActive].scrollIntoView({ block: "nearest" }); e.preventDefault(); }
        else if (e.key === "Enter") {
            e.preventDefault();
            if (docActive > -1 && items[docActive]) { selectSuggestion(items[docActive]); }
            else if (docInput.value.trim() !== "") {
                const typedId = getNumericDocIdFromInput(docInput.value);
                const match = jobData.find(j => j.documentId === typedId);
                if (match) { docInput.value = typedId; docInput.dispatchEvent(new Event('input')); }
                hideSuggestions();
            } else { hideSuggestions(); }
        }
    });

    jobIdInput.addEventListener("click", (e) => { e.stopPropagation(); filterAndDisplayJobIdSuggestions(); });
    jobIdInput.addEventListener("focus", filterAndDisplayJobIdSuggestions);
    jobIdInput.addEventListener("blur", hideSuggestions);
    jobIdInput.addEventListener("keydown", (e) => {
        let items = jobIdAutocompleteResultsContainer.querySelectorAll(".autocomplete-item");
        if (items.length === 0) return;
        if (e.key === "ArrowDown") { jobIdActive = addActive(jobIdActive, items); items[jobIdActive].scrollIntoView({ block: "nearest" }); e.preventDefault(); }
        else if (e.key === "ArrowUp") { jobIdActive = addActive(jobIdActive, items); items[jobIdActive].scrollIntoView({ block: "nearest" }); e.preventDefault(); }
        else if (e.key === "Enter") { e.preventDefault(); if (jobIdActive > -1 && items[jobIdActive]) { selectJobIdSuggestion(items[jobIdActive]); } hideSuggestions(); }
    });

    practiceInputJobManager.addEventListener("input", debouncedFilterAndDisplayPracticeSuggestions);
    practiceInputJobManager.addEventListener("focus", filterAndDisplayPracticeSuggestions);
    practiceInputJobManager.addEventListener("blur", hideSuggestions);
    practiceInputJobManager.addEventListener("keydown", (e) => {
        let items = practiceAutocompleteResultsContainer.querySelectorAll(".autocomplete-item");
        if (items.length === 0) return;
        if (e.key === "ArrowDown") { practiceActive = addActive(practiceActive, items); items[practiceActive].scrollIntoView({ block: "nearest" }); e.preventDefault(); }
        else if (e.key === "ArrowUp") { practiceActive = addActive(practiceActive, items); items[practiceActive].scrollIntoView({ block: "nearest" }); e.preventDefault(); }
        else if (e.key === "Enter") {
            e.preventDefault();
            if (practiceActive > -1 && items[practiceActive]) {
                const practiceName = items[practiceActive].dataset.practiceName;
                const odsCode = items[practiceActive].dataset.odsCode;
                selectPracticeSuggestion({ name: practiceName, ods: odsCode });
            }
            hideSuggestions();
        }
    });

    // The Job Selection buttons
    if (jobStatusInput) {
        jobStatusInput.addEventListener('input', () => {
            const hasInput = jobStatusInput.value.trim().length > 0;
            openJobStatusBtn.disabled = !hasInput;
            copyJobStatusIdBtn.disabled = !hasInput;
            copyJobStatusUrlBtn.disabled = !hasInput;
            clearJobStatusInputBtn.disabled = !hasInput; // <-- ADD THIS LINE
        });
    }

    // 3. Add the click handlers for each button's action
    if (openJobStatusBtn) {
        openJobStatusBtn.addEventListener('click', () => {
            const jobId = jobStatusInput.value.trim();
            if (jobId) {
                const url = `https://app.betterletter.ai/admin_panel/bots/jobs/${jobId}`;
                chrome.tabs.create({ url: url });
            }
        });
    }

    if (copyJobStatusIdBtn) {
        copyJobStatusIdBtn.addEventListener('click', () => {
            const jobId = jobStatusInput.value.trim();
            if (jobId) {
                navigator.clipboard.writeText(jobId);
                showToast("Job ID copied!");
            }
        });
    }

    if (copyJobStatusUrlBtn) {
        copyJobStatusUrlBtn.addEventListener('click', () => {
            const jobId = jobStatusInput.value.trim();
            if (jobId) {
                const url = `https://app.betterletter.ai/admin_panel/bots/jobs/${jobId}`;
                navigator.clipboard.writeText(url);
                showToast("Job Status URL copied!");
            }
        });
    }

    if (clearJobStatusInputBtn) {
        clearJobStatusInputBtn.addEventListener('click', () => {
            jobStatusInput.value = ''; // Clear the input field

            // Manually trigger the 'input' event we created earlier.
            // This re-uses our existing logic to disable the other buttons.
            jobStatusInput.dispatchEvent(new Event('input'));

            jobStatusInput.focus(); // For convenience, focus back on the input field
        });
    }
    // END: Job Selection button listeners
    
    // Global mousedown listener to hide all autocompletes
    document.addEventListener("mousedown", (e) => {
        const isNavigatorAutocomplete = (suggestionsList && suggestionsList.contains(e.target) || e.target === practiceInputEl || cdbSuggestionsList && cdbSuggestionsList.contains(e.target) || e.target === cdbSearchInputEl);
        const isJobManagerAutocomplete = (autocompleteResultsContainer && autocompleteResultsContainer.contains(e.target) || e.target === docInput || practiceAutocompleteResultsContainer && practiceAutocompleteResultsContainer.contains(e.target) || e.target === practiceInputJobManager || jobIdAutocompleteResultsContainer && jobIdAutocompleteResultsContainer.contains(e.target) || e.target === jobIdInput);

        if (!isNavigatorAutocomplete && !isJobManagerAutocomplete) {
            hideSuggestions();
        }
    });

    // Clear interval when panel closes
    window.addEventListener('beforeunload', () => {
        if (refreshIntervalId) {
            clearInterval(refreshIntervalId);
        }
    });
});