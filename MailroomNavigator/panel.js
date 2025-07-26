/**
 * Merged panel.js
 *
 * This script runs in the context of the unified panel.html popup.
 * It combines functionalities from BL-Mailroom's popup.js and BetterLetterJobManager's panel.js.
 */

// --- Global State Variables ---
let currentSelectedOdsCode = null;
let cachedPractices = {}; // For Practice Navigator
let jobData = []; // For Job Manager
let uniquePractices = []; // For Job Manager

// UI View Elements
let practiceNavigatorView = null;
let emailFormatterView = null;
let jobManagerView = null; // New view for Job Panel

// Practice Navigator Specific Elements
let statusDisplayEl = null;
let statusEl = null;
let cdbSearchResultEl = null;
let settingTypeEl = null;
let resetSettingsBtn = null;
let practiceInputEl = null;
let suggestionsList = null;
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
let practiceInputJobManager = null; // Renamed to avoid conflict with Navigator's practiceInput
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
let toastEl = null; // Unified toast element
let refreshIntervalId = null; // For Job Manager data refresh
let docActive = -1; // Autocomplete active index for Document ID
let practiceActive = -1; // Autocomplete active index for Practice Name (Job Manager)
let jobIdActive = -1; // Autocomplete active index for Job ID

// --- Helper Functions (Unified and Adapted) ---

// Unified Toast Notification (from Job Manager, as it's more complete)
function showToast(message) {
    if (!toastEl) {
        console.warn("Toast element not found in DOM.");
        return;
    }
    toastEl.textContent = message;
    toastEl.style.display = "block";
    setTimeout(() => toastEl.style.display = "none", 2000);
}

// Helper to enable/disable contextual buttons for Practice Navigator
function setContextualButtonsState(enable) {
  document.getElementById('usersBtn').disabled = !enable;
  document.getElementById('preparingBtn').disabled = !enable;
  document.getElementById('rejectedBtn').disabled = !enable;
}

// Function to switch between views and manage active tab styling
function showView(viewId) {
    // Hide all main views
    practiceNavigatorView.style.display = 'none';
    emailFormatterView.style.display = 'none';
    jobManagerView.style.display = 'none';

    // Remove active-tab class from all global nav buttons
    const globalNavButtons = document.querySelectorAll('.global-nav-buttons-row .btn');
    globalNavButtons.forEach(button => button.classList.remove('active-tab'));

    // Show the requested view and set its button as active
    if (viewId === 'practiceNavigatorView') {
        practiceNavigatorView.style.display = 'block';
        document.getElementById('navigatorGlobalToggleBtn').classList.add('active-tab');
        // Clear Job Manager interval if switching away
        if (refreshIntervalId) {
            clearInterval(refreshIntervalId);
            refreshIntervalId = null;
        }
        // Immediately fetch data for navigator when shown
        updateContextualButtonsOnInput(false);
    } else if (viewId === 'jobManagerView') {
        jobManagerView.style.display = 'block';
        document.getElementById('jobManagerGlobalToggleBtn').classList.add('active-tab');
        // Start Job Manager data refresh when shown
        if (!refreshIntervalId) {
            setTimeout(() => {
                fetchAndPopulateData();
                refreshIntervalId = setInterval(fetchAndPopulateData, 5000);
            }, 100); // Small delay to ensure view is visible
        }
    } else if (viewId === 'emailFormatterView') {
        emailFormatterView.style.display = 'block';
        document.getElementById('emailFormatterGlobalToggleBtn').classList.add('active-tab');
        // Clear Job Manager interval if switching away
        if (refreshIntervalId) {
            clearInterval(refreshIntervalId);
            refreshIntervalId = null;
        }
    }
    // Clear any active autocomplete suggestions when switching views
    hideSuggestions();
    // Hide status/CDB search results when switching views
    if (statusDisplayEl) statusDisplayEl.style.display = 'none';
    if (cdbSearchResultEl) cdbSearchResultEl.style.display = 'none';
    if (statusEl) statusEl.style.display = 'none';
}

// Helper for adding/removing active class for autocompletes
function addActive(activeIdx, items) {
    if (!items || items.length === 0) return -1;
    removeActive(items);
    activeIdx = (activeIdx + items.length) % items.length; // Ensure index wraps around
    items[activeIdx].classList.add("active");
    return activeIdx;
}

function removeActive(items) {
    for (let i = 0; i < items.length; i++) {
        items[i].classList.remove("active");
    }
}

// Centralized hide suggestions function (from both, consolidated)
function hideSuggestions() {
    setTimeout(() => {
        if (autocompleteResultsContainer) autocompleteResultsContainer.style.display = 'none';
        if (practiceAutocompleteResultsContainer) practiceAutocompleteResultsContainer.style.display = 'none';
        if (jobIdAutocompleteResultsContainer) jobIdAutocompleteResultsContainer.style.display = 'none';
        if (suggestionsList) suggestionsList.style.display = 'none'; // For Practice Navigator
        if (cdbSuggestionsList) cdbSuggestionsList.style.display = 'none'; // For Practice Navigator CDB
        docActive = -1;
        practiceActive = -1;
        jobIdActive = -1;
    }, 100);
}

// From BetterLetterJobManager: Helper to clear dependent fields in Job Panel
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

// From BetterLetterJobManager: Helper to extract numeric Document ID
function getNumericDocIdFromInput(inputString) {
    const match = inputString.trim().match(/^\d+$/);
    return match ? match[0] : null;
}

// From BetterLetterJobManager: Helper to get ODS code from practice name (Job Manager context)
function getOdsCodeFromPracticeName(practiceName) {
    const found = uniquePractices.find(p => p.practiceName === practiceName);
    return found ? found.odsCode : null;
}

// From BetterLetterJobManager: Helper to open tab with timeout
function openTabWithTimeout(url) {
    chrome.tabs.create({ url }).catch(err => {
        console.error("Failed to open tab:", err);
        showToast("Failed to open page.");
    });
}

// From BL-Mailroom: Helper to show status messages in Practice Navigator
function showStatus(message, type) {
  if (statusEl) {
    statusEl.textContent = message;
    statusEl.className = type;
    statusEl.style.display = 'block';
  } else {
    console.warn("Status element not found in DOM when trying to showStatus:", message);
  }
}

// From BL-Mailroom: Helper to trigger practice page opening
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

// From BL-Mailroom: Function to update buttons based on practice input (Practice Navigator)
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

  if (foundOds) {
    currentSelectedOdsCode = foundOds;
    setContextualButtonsState(true);
    if (triggerStatus) {
        displayPracticeStatus();
    }
  } else {
    currentSelectedOdsCode = null;
    setContextualButtonsState(false);
    if (statusDisplayEl) statusDisplayEl.style.display = 'none';
    if (cdbSearchResultEl) cdbSearchResultEl.style.display = 'none';
  }
}

// From BL-Mailroom: Function to display practice status (Practice Navigator)
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

// From BL-Mailroom: Email Formatter logic
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

function copyEmails() {
    outputEmailFormatter.select();
    document.execCommand("copy");
    showToast("Email list copied!");
}

// --- Job Manager Specific Functions (Adapted) ---

// Main data fetching and UI population function for Job Manager
async function fetchAndPopulateData() {
    const { targetTabId } = await chrome.storage.local.get("targetTabId");
    const { clickedMailroomDocData } = await chrome.storage.local.get("clickedMailroomDocData");

    let currentTab;
    let extractedDocIdFromUrl = null;
    let extractedJobIdFromUrl = null;

    const userTypedDocId = docInput.value;

    const dashboardUrlPrefix = "https://app.betterletter.ai/admin_panel/bots/dashboard";
    const annotationUrlRegex = /^https:\/\/app\.betterletter.ai\/mailroom\/annotations\/(\d+)/;
    const jobPageUrlRegex = /^https:\/\/app\.betterletter.ai\/admin_panel\/bots\/jobs\/([a-f0-9-]+)\/?/;
    const mailroomUrlPrefix = "https://app.betterletter.ai/mailroom/";

    jobTitleDisplay.value = "";
    jobTitleSection.style.display = 'none';
    documentActionsSection.style.display = 'none';
    mailroomDetailsSection.style.display = 'none';

    if (!targetTabId) {
        showToast("No active tab context. Please ensure a tab is active.");
        clearDependentFields();
        docInput.value = userTypedDocId;
        return;
    }

    try {
        currentTab = await chrome.tabs.get(targetTabId);
    } catch (e) {
        showToast("Target tab no longer exists or is inaccessible.");
        clearDependentFields();
        docInput.value = userTypedDocId;
        return;
    }

    if (!currentTab.url) {
        showToast("Cannot read URL from the active tab.");
        clearDependentFields();
        docInput.value = userTypedDocId;
        return;
    }

    if (clickedMailroomDocData) {
        console.log("DEBUG: Using data from clicked Mailroom Document:", clickedMailroomDocData);
        docInput.value = clickedMailroomDocData.documentId || "";
        mailroomOriginalName.textContent = clickedMailroomDocData.originalNameContent || "—";
        mailroomNhsNo.textContent = clickedMailroomDocData.nhsNo || "—";
        mailroomPatientName.textContent = clickedMailroomDocData.patientName || "—";
        mailroomReason.textContent = clickedMailroomDocData.reason || "—";
        mailroomRejectedByOn.textContent = clickedMailroomDocData.rejectedByOn || "—";
        mailroomStatus.textContent = clickedMailroomDocData.status || "—";
        mailroomJobId.textContent = clickedMailroomDocData.jobId || "—";
        mailroomInferredType.textContent = clickedMailroomDocData.inferredJobType || "—";

        mailroomDetailsSection.style.display = 'block';
        await chrome.storage.local.remove("clickedMailroomDocData");

        if (docInput.value && /^\d+$/.test(docInput.value)) {
            documentActionsSection.style.display = 'block';
        }
        return;
    }

    const jobPageMatch = currentTab.url.match(jobPageUrlRegex);
    if (jobPageMatch && jobPageMatch[1]) {
        extractedJobIdFromUrl = jobPageMatch[1];
        setTimeout(async () => {
            try {
                const tabs = await chrome.tabs.query({ url: currentTab.url, currentWindow: false });
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
                    }
                }
            } catch (e) {
                console.error("Error extracting job title:", e);
                jobTitleDisplay.value = "Error extracting title";
                jobTitleSection.style.display = 'block';
            }
        }, 100);
    }

    const annotationMatch = currentTab.url.match(annotationUrlRegex);
    if (annotationMatch && annotationMatch[1]) {
        extractedDocIdFromUrl = annotationMatch[1];
    }

    if (currentTab.url.startsWith(dashboardUrlPrefix)) {
        try {
            const [{ result }] = await chrome.scripting.executeScript({
                target: { tabId: targetTabId },
                func: () => {
                    const tableRows = document.querySelectorAll("table tbody tr");
                    if (!tableRows || tableRows.length === 0) {
                        return [];
                    }
                    return Array.from(tableRows).map(row => {
                        const cells = row.querySelectorAll("td");
                        const documentId = cells[1]?.querySelector("a")?.textContent.trim();
                        const jobType = cells[2]?.innerText.trim();
                        const practiceCell = cells[3]?.innerText.trim();
                        const [practiceName, odsCode] = practiceCell ? practiceCell.split("\n").map(t => t.trim()) : ["", ""];
                        const jobId = cells[4]?.querySelector("a")?.textContent.trim();
                        return { documentId, jobType, jobId, practiceName, odsCode };
                    }).filter(Boolean);
                }
            });

            jobData = result;

            const practicesMap = new Map();
            jobData.forEach(job => {
                if (job.practiceName && job.odsCode) {
                    practicesMap.set(job.practiceName, job.odsCode);
                }
            });
            uniquePractices = Array.from(practicesMap, ([practiceName, odsCode]) => ({ practiceName, odsCode }));

            if (jobData.length === 0) {
                showToast("No job data found on this Dashboard page.");
                jobTypeLabel.textContent = "—";
                odsCodeLabel.textContent = "—";
                practiceInputJobManager.value = "";
            }

            filterAndDisplaySuggestions();
            filterAndDisplayPracticeSuggestions();
            filterAndDisplayJobIdSuggestions();

        } catch (err) {
            console.error("Error fetching data from dashboard:", err);
            showToast("Failed to fetch data from dashboard.");
            jobTypeLabel.textContent = "—";
            odsCodeLabel.textContent = "—";
            practiceInputJobManager.value = "";
        }
    } else {
        jobData = [];
        uniquePractices = [];
        jobTypeLabel.textContent = "—";
        odsCodeLabel.textContent = "—";
        practiceInputJobManager.value = "";
    }

    if (extractedJobIdFromUrl) {
        jobIdInput.value = extractedJobIdFromUrl;
        jobIdAutocompleteResultsContainer.innerHTML = "";
    } else if (!currentTab.url.startsWith(dashboardUrlPrefix) && !currentTab.url.startsWith(mailroomUrlPrefix)) {
        jobIdInput.value = "";
        jobIdAutocompleteResultsContainer.innerHTML = "";
    }

    if (extractedDocIdFromUrl) {
        docInput.value = extractedDocIdFromUrl;
        docInput.dispatchEvent(new Event('input'));
    } else if (userTypedDocId) {
        docInput.value = userTypedDocId;
        docInput.dispatchEvent(new Event('input'));
    } else if (!currentTab.url.startsWith(dashboardUrlPrefix) && !currentTab.url.startsWith(mailroomUrlPrefix)) {
        docInput.value = "";
    }

    const currentDocIdInInput = docInput.value.trim();
    if (currentDocIdInInput && /^\d+$/.test(currentDocIdInInput)) {
        documentActionsSection.style.display = 'block';
    } else {
        documentActionsSection.style.display = 'none';
    }
}

// Functions for custom Document ID autocomplete (Job Manager)
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
            item.textContent = job.documentId;
            item.dataset.documentId = job.documentId;
            item.addEventListener('click', () => { selectSuggestion(item); });
            autocompleteResultsContainer.appendChild(item);
        }
    });

    if (autocompleteResultsContainer.children.length > 0 && isInputFocused) {
        const inputRect = docInput.getBoundingClientRect();
        autocompleteResultsContainer.style.left = `${inputRect.left}px`;
        autocompleteResultsContainer.style.top = `${inputRect.bottom}px`;
        autocompleteResultsContainer.style.width = `${inputRect.width}px`;
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

// Functions for custom Practice Name autocomplete (Job Manager)
function filterAndDisplayPracticeSuggestions() {
    const searchTerm = practiceInputJobManager.value.trim().toLowerCase();
    practiceAutocompleteResultsContainer.innerHTML = '';
    practiceAutocompleteResultsContainer.style.display = 'none';
    practiceActive = -1;

    const isInputFocused = (document.activeElement === practiceInputJobManager);

    if (!searchTerm && (!isInputFocused || uniquePractices.length === 0)) {
        return;
    }

    let filteredData = uniquePractices;
    if (searchTerm) {
        filteredData = uniquePractices.filter(p =>
            (p.practiceName || '').toLowerCase().includes(searchTerm) ||
            (p.odsCode || '').toLowerCase().includes(searchTerm)
        );
    }

    if (filteredData.length === 0) {
        return;
    }

    filteredData.forEach(p => {
        if (p.practiceName && p.odsCode) {
            const item = document.createElement('div');
            item.classList.add('autocomplete-item');
            item.textContent = `${p.practiceName} (${p.odsCode})`;
            item.dataset.practiceName = p.practiceName;
            item.dataset.odsCode = p.odsCode;
            item.addEventListener('click', () => { selectPracticeSuggestion(item); });
            practiceAutocompleteResultsContainer.appendChild(item);
        }
    });

    if (practiceAutocompleteResultsContainer.children.length > 0 && isInputFocused) {
        const inputRect = practiceInputJobManager.getBoundingClientRect();
        practiceAutocompleteResultsContainer.style.left = `${inputRect.left}px`;
        practiceAutocompleteResultsContainer.style.top = `${inputRect.bottom}px`;
        practiceAutocompleteResultsContainer.style.width = `${inputRect.width}px`;
        practiceAutocompleteResultsContainer.style.display = 'block';
    }
}

function selectPracticeSuggestion(item) {
    const selectedPracticeName = item.dataset.practiceName;
    const selectedOdsCode = item.dataset.odsCode;
    practiceInputJobManager.value = selectedPracticeName;
    odsCodeLabel.textContent = selectedOdsCode;
    practiceAutocompleteResultsContainer.style.display = 'none';
    practiceActive = -1;
}

// Functions for custom Job ID autocomplete (Job Manager)
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
        const inputRect = jobIdInput.getBoundingClientRect();
        jobIdAutocompleteResultsContainer.style.left = `${inputRect.left}px`;
        jobIdAutocompleteResultsContainer.style.top = `${inputRect.bottom}px`;
        jobIdAutocompleteResultsContainer.style.width = `${inputRect.width}px`;
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
    // --- Assign All UI Elements ---
    toastEl = document.getElementById("toast");

    // Practice Navigator Elements
    practiceNavigatorView = document.getElementById('practiceNavigatorView');
    statusDisplayEl = document.getElementById('statusDisplay');
    statusEl = document.getElementById('status');
    cdbSearchResultEl = document.getElementById('cdbSearchResult');
    settingTypeEl = document.getElementById('settingType');
    resetSettingsBtn = document.getElementById('resetSettingsBtn');
    practiceInputEl = document.getElementById('practiceInput');
    suggestionsList = document.getElementById('suggestions');
    cdbSearchInputEl = document.getElementById('cdbSearchInput');
    cdbSuggestionsList = document.getElementById('cdbSuggestions');

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
    practiceAutocompleteResultsContainer = document.getElementById("practiceAutocompleteResults");
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

    // Email Formatter Elements
    emailFormatterView = document.getElementById('emailFormatterView');
    inputEmailFormatter = document.getElementById("inputEmailFormatter");
    outputEmailFormatter = document.getElementById("outputEmailFormatter");
    convertEmailBtn = document.getElementById("convertEmailBtn");
    copyEmailBtn = document.getElementById("copyEmailBtn");

    // --- Initial View Setup (Defaults to Navigator) ---
    showView('practiceNavigatorView'); // Set the initial view

    // --- Global Navigation Toggle Buttons ---
    document.getElementById("navigatorGlobalToggleBtn").addEventListener("click", () => showView('practiceNavigatorView'));
    document.getElementById("jobManagerGlobalToggleBtn").addEventListener("click", () => showView('jobManagerView'));
    document.getElementById("emailFormatterGlobalToggleBtn").addEventListener("click", () => showView('emailFormatterView'));

    // --- Practice Navigator Event Listeners ---
    setContextualButtonsState(false); // Initial state for Navigator buttons

    if (resetSettingsBtn) {
        resetSettingsBtn.addEventListener('click', () => {
            practiceInputEl.value = '';
            settingTypeEl.value = '';
            suggestionsList.style.display = 'none';
            cdbSuggestionsList.style.display = 'none';
            currentSelectedOdsCode = null;
            setContextualButtonsState(false);
            if (statusDisplayEl) statusDisplayEl.style.display = 'none';
            if (cdbSearchResultEl) cdbSearchResultEl.style.display = 'none';
            showStatus('Settings reset.', 'success');
            setTimeout(() => statusEl.style.display = 'none', 1500);
        });
    }

    // Initial check for cache for Practice Navigator
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
                    currentSelectedOdsCode = foundPractice.ods;
                    setContextualButtonsState(true);
                    displayPracticeStatus();
                } else {
                    setContextualButtonsState(false);
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

    settingTypeEl.addEventListener('change', function() {
        const selectedSettingType = this.value;
        if (currentSelectedOdsCode && selectedSettingType !== "") {
            triggerOpenPracticePage(practiceInputEl.value, selectedSettingType);
        } else if (currentSelectedOdsCode && selectedSettingType === "") {
            showStatus('Please select a valid setting type.', 'error');
        } else {
            showStatus('Please select a practice first.', 'error');
        }
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
                    practiceInputEl.value = name;
                    suggestionsList.style.display = 'none';
                    updateContextualButtonsOnInput(true);
                    if (currentSelectedOdsCode && settingTypeEl.value !== "") {
                        triggerOpenPracticePage(practiceInputEl.value, settingTypeEl.value);
                    }
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
            setContextualButtonsState(false);
            return;
        }

        matches.forEach(name => {
            const li = document.createElement('li');
            li.textContent = name;
            li.addEventListener('click', () => {
                practiceInputEl.value = name;
                suggestionsList.style.display = 'none';
                updateContextualButtonsOnInput(true);
                if (currentSelectedOdsCode && settingTypeEl.value !== "") {
                    triggerOpenPracticePage(practiceInputEl.value, settingTypeEl.value);
                }
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
                currentSelectedOdsCode = response.practice.ods;
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
                currentSelectedOdsCode = match.ods;
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

    // --- Email Formatter Event Listeners ---
    convertEmailBtn.addEventListener("click", convertEmails);
    copyEmailBtn.addEventListener("click", copyEmails);
    document.getElementById("backToNavigatorBtnEmail").addEventListener("click", () => showView('practiceNavigatorView'));

    // --- Job Manager Event Listeners ---
    document.getElementById("backToNavigatorBtnJobPanel").addEventListener("click", () => showView('practiceNavigatorView'));

    clearDocIdBtn.onclick = () => {
        docInput.value = "";
        docInput.dispatchEvent(new Event('input'));
        showToast("Document ID cleared.");
        docInput.focus();
    };

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

    // --- Autocomplete Event Listeners for Job Manager ---
    docInput.addEventListener("input", () => {
      const docIdFullString = docInput.value;
      const numericDocId = getNumericDocIdFromInput(docIdFullString);
      const match = jobData.find(j => j.documentId === numericDocId);
      if (match) {
        jobIdInput.value = match.jobId;
        jobTypeLabel.textContent = match.jobType;
        practiceInputJobManager.value = match.practiceName; // Use Job Manager's practice input
        odsCodeLabel.textContent = match.odsCode;
      } else {
        clearDependentFields();
        practiceInputJobManager.value = "";
      }
      filterAndDisplayJobIdSuggestions();
      if (numericDocId && /^\d+$/.test(numericDocId)) {
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

    practiceInputJobManager.addEventListener("input", filterAndDisplayPracticeSuggestions);
    practiceInputJobManager.addEventListener("click", (e) => { e.stopPropagation(); filterAndDisplayPracticeSuggestions(); });
    practiceInputJobManager.addEventListener("focus", filterAndDisplayPracticeSuggestions);
    practiceInputJobManager.addEventListener("blur", hideSuggestions);
    practiceInputJobManager.addEventListener("keydown", (e) => {
        let items = practiceAutocompleteResultsContainer.querySelectorAll(".autocomplete-item");
        if (items.length === 0) return;
        if (e.key === "ArrowDown") { practiceActive = addActive(practiceActive, items); items[practiceActive].scrollIntoView({ block: "nearest" }); e.preventDefault(); }
        else if (e.key === "ArrowUp") { practiceActive = addActive(practiceActive, items); items[practiceActive].scrollIntoView({ block: "nearest" }); e.preventDefault(); }
        else if (e.key === "Enter") {
            e.preventDefault();
            if (practiceActive > -1 && items[practiceActive]) { selectPracticeSuggestion(items[practiceActive]); }
            else if (practiceInputJobManager.value.trim() !== "") {
                const typedPracticeName = practiceInputJobManager.value.trim();
                const match = uniquePractices.find(p => p.practiceName === typedPracticeName);
                if (match) { odsCodeLabel.textContent = match.odsCode; }
                hideSuggestions();
            } else { hideSuggestions(); }
        }
    });

    // Global mousedown listener to hide all autocompletes
    document.addEventListener("mousedown", (e) => {
        const isNavigatorAutocomplete = (suggestionsList && suggestionsList.contains(e.target) || e.target === practiceInputEl || cdbSuggestionsList && cdbSuggestionsList.contains(e.target) || e.target === cdbSearchInputEl);
        const isJobManagerAutocomplete = (autocompleteResultsContainer && autocompleteResultsContainer.contains(e.target) || e.target === docInput || practiceAutocompleteResultsContainer && practiceAutocompleteResultsContainer.contains(e.target) || e.target === practiceInputJobManager || jobIdAutocompleteResultsContainer && jobIdAutocompleteResultsContainer.contains(e.target) || e.target === jobIdInput);

        if (!isNavigatorAutocomplete && !isJobManagerAutocomplete) {
            hideSuggestions();
        }
    });

    // Clear interval when panel closes to prevent memory leaks for Job Manager's refresh
    window.addEventListener('beforeunload', () => {
        if (refreshIntervalId) {
            clearInterval(refreshIntervalId);
        }
    });

}); // End of DOMContentLoaded