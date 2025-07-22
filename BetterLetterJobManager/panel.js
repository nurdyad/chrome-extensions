// BetterLetterJobManager/panel.js (COMPLETE AND FINALIZED VERSION - Mailroom Details Integration)

chrome.action.setBadgeText({ text: "Job Panel" });

function showToast(message) {
    const toast = document.getElementById("toast");
    toast.textContent = message;
    toast.style.display = "block";
    setTimeout(() => toast.style.display = "none", 2000);
}

document.addEventListener("DOMContentLoaded", async () => {
    const [
        docInput,
        autocompleteResultsContainer,
        copyDocBtn,
        statusBtn,
        obanBtn,
        annoBtn,
        eventLogBtn,
        letterAdminBtn,
        odsCodeLabel,
        openPracticeBtn,
        jobTypeLabel,
        jobIdInput,
        copyJobBtn,
        openJobBtn,
        documentSelectionSection,
        documentActionsSection,
        practiceInput,
        practiceAutocompleteResultsContainer,
        jobTitleSection,
        jobTitleDisplay,
        copyJobTitle,
        copyPracticeNameBtn,
        copyJobPageUrlBtn,
        jobIdAutocompleteResultsContainer,
        clearDocIdBtn,
        // NEW: Mailroom Details Section elements
        mailroomDetailsSection,
        mailroomOriginalName, // NEW
        mailroomNhsNo,
        mailroomPatientName,
        mailroomReason,
        mailroomRejectedByOn,
        mailroomStatus,
        mailroomJobId, // NEW
        mailroomInferredType, // NEW
        copyMailroomDetailsBtn
    ] = [
        document.getElementById("documentDropdown"),
        document.getElementById("autocompleteResults"),
        document.getElementById("copySelectedDocId"),
        document.getElementById("openDocumentStatus"),
        document.getElementById("openObanJob"),
        document.getElementById("openAnnotation"),
        document.getElementById("openEventLog"),
        document.getElementById("openLetterAdmin"),
        document.getElementById("ods-code"),
        document.getElementById("openPractice"),
        document.getElementById("job-type-label"),
        document.getElementById("job-id"),
        document.getElementById("copy-job-id"),
        document.getElementById("openJobDirect"),
        document.getElementById("documentSelectionSection"),
        document.getElementById("documentActionsSection"),
        document.getElementById("practiceDropdown"),
        document.getElementById("practiceAutocompleteResults"),
        document.getElementById("jobTitleSection"),
        document.getElementById("jobTitleDisplay"),
        document.getElementById("copyJobTitle"),
        document.getElementById("copyPracticeName"),
        document.getElementById("copyJobPageUrl"),
        document.getElementById("jobIdAutocompleteResults"),
        document.getElementById("clearDocId"),
        // NEW: Get Mailroom Details elements
        document.getElementById("mailroomDetailsSection"),
        document.getElementById("mailroom-original-name"),
        document.getElementById("mailroom-nhs-no"),
        document.getElementById("mailroom-patient-name"),
        document.getElementById("mailroom-reason"),
        document.getElementById("mailroom-rejected-by-on"),
        document.getElementById("mailroom-status"),
        document.getElementById("mailroom-job-id"),
        document.getElementById("mailroom-inferred-type"),
        document.getElementById("copyMailroomDetails")
    ];

    // Helper functions (moved inside DOMContentLoaded for correct scope)
    function clearDependentFields() {
        jobIdInput.value = "";
        jobTypeLabel.textContent = "—";
        odsCodeLabel.textContent = "—";
        jobTitleDisplay.value = "";
        jobTitleSection.style.display = 'none';
        practiceInput.value = "";
        jobIdAutocompleteResultsContainer.innerHTML = "";
        documentActionsSection.style.display = 'none'; // Hide Document Actions section
        // Clear Mailroom Details
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

    // FIX: Updated regex for Document ID to allow any number of digits (\d+)
    function getNumericDocIdFromInput(inputString) {
        const match = inputString.trim().match(/^\d+$/); // Changed from ^\d{6}$ to ^\d+$
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

    let jobData = [];
    let uniquePractices = [];
    let refreshIntervalId;

    // Autocomplete active index variables
    let docActive = -1;
    let practiceActive = -1;
    let jobIdActive = -1;

    // Helper for adding/removing active class (takes active index and items)
    function addActive(activeIdx, items) {
        if (!items) return -1;
        removeActive(items);
        if (activeIdx >= items.length) activeIdx = 0;
        if (activeIdx < 0) activeIdx = (items.length - 1);
        items[activeIdx].classList.add("active");
        return activeIdx; // Return updated active index
    }

    function removeActive(items) {
        for (var i = 0; i < items.length; i++) {
            items[i].classList.remove("active");
        }
    }

    // Centralized hide suggestions function
    function hideSuggestions() {
        setTimeout(() => {
            autocompleteResultsContainer.style.display = 'none';
            practiceAutocompleteResultsContainer.style.display = 'none';
            jobIdAutocompleteResultsContainer.style.display = 'none';
        }, 100); // Small delay to allow click events to register
    }

    // Functions for custom Document ID autocomplete
    function filterAndDisplaySuggestions() {
        const searchTerm = docInput.value.trim().toLowerCase();
        autocompleteResultsContainer.innerHTML = '';
        autocompleteResultsContainer.style.display = 'none';
        docActive = -1; // Reset active index for this autocomplete

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

                item.addEventListener('click', () => {
                    selectSuggestion(item);
                });
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
        docActive = -1; // Reset active index after selection
    }

    // Functions for custom Practice Name autocomplete
    function filterAndDisplayPracticeSuggestions() {
        const searchTerm = practiceInput.value.trim().toLowerCase();
        practiceAutocompleteResultsContainer.innerHTML = '';
        practiceAutocompleteResultsContainer.style.display = 'none';
        practiceActive = -1; // Reset active index for this autocomplete

        const isInputFocused = (document.activeElement === practiceInput);

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

                item.addEventListener('click', () => {
                    selectPracticeSuggestion(item);
                });
                practiceAutocompleteResultsContainer.appendChild(item);
            }
        });

        if (practiceAutocompleteResultsContainer.children.length > 0 && isInputFocused) {
            const inputRect = practiceInput.getBoundingClientRect();
            practiceAutocompleteResultsContainer.style.left = `${inputRect.left}px`;
            practiceAutocompleteResultsContainer.style.top = `${inputRect.bottom}px`;
            practiceAutocompleteResultsContainer.style.width = `${inputRect.width}px`;
            practiceAutocompleteResultsContainer.style.display = 'block';
        }
    }

    function selectPracticeSuggestion(item) {
        const selectedPracticeName = item.dataset.practiceName;
        const selectedOdsCode = item.dataset.odsCode;

        practiceInput.value = selectedPracticeName;
        odsCodeLabel.textContent = selectedOdsCode;
        practiceAutocompleteResultsContainer.style.display = 'none';
        practiceActive = -1; // Reset active index after selection
    }

    // Functions for custom Job ID autocomplete
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
        jobIdActive = -1; // Reset active index for this autocomplete

        const isInputFocused = (document.activeElement === jobIdInput);

        if (relevantJobIds.length === 0 || !isInputFocused) {
            return;
        }

        relevantJobIds.forEach(jobId => {
            const item = document.createElement('div');
            item.classList.add('autocomplete-item');
            item.textContent = jobId;
            item.dataset.jobId = jobId;

            item.addEventListener('click', () => {
                selectJobIdSuggestion(item);
            });
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
        jobIdActive = -1; // Reset active index after selection
    }


    // Main data fetching and UI population function
    async function fetchAndPopulateData() {
        const { targetTabId } = await chrome.storage.local.get("targetTabId");
        // Get data from a clicked Mailroom document link, if available
        const { clickedMailroomDocData } = await chrome.storage.local.get("clickedMailroomDocData");

        let currentTab;
        let extractedDocIdFromUrl = null; 
        let extractedJobIdFromUrl = null; 

        // Store the current value of docInput before any processing
        const userTypedDocId = docInput.value; 

        // Define URL regexes
        const dashboardUrlPrefix = "https://app.betterletter.ai/admin_panel/bots/dashboard";
        const annotationUrlRegex = /^https:\/\/app\.betterletter.ai\/mailroom\/annotations\/(\d+)/; 
        const jobPageUrlRegex = /^https:\/\/app\.betterletter.ai\/admin_panel\/bots\/jobs\/([a-f0-9-]+)\/?/; 
        const mailroomUrlPrefix = "https://app.betterletter.ai/mailroom/"; 

        // Reset Job Title section's visibility initially, it will be set to 'block' if relevant.
        jobTitleDisplay.value = "";
        jobTitleSection.style.display = 'none';
        documentActionsSection.style.display = 'none'; // Hide Document Actions section by default
        mailroomDetailsSection.style.display = 'none'; // Hide Mailroom Details section by default

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

        // --- Prioritize data from a clicked Mailroom Document link ---
        if (clickedMailroomDocData) {
            console.log("DEBUG: Using data from clicked Mailroom Document:", clickedMailroomDocData);
            docInput.value = clickedMailroomDocData.documentId || "";
            // Populate Mailroom specific details
            mailroomOriginalName.textContent = clickedMailroomDocData.originalNameContent || "—";
            mailroomNhsNo.textContent = clickedMailroomDocData.nhsNo || "—";
            mailroomPatientName.textContent = clickedMailroomDocData.patientName || "—";
            mailroomReason.textContent = clickedMailroomDocData.reason || "—";
            mailroomRejectedByOn.textContent = clickedMailroomDocData.rejectedByOn || "—";
            mailroomStatus.textContent = clickedMailroomDocData.status || "—";
            mailroomJobId.textContent = clickedMailroomDocData.jobId || "—"; // Extracted UUID if available
            mailroomInferredType.textContent = clickedMailroomDocData.inferredJobType || "—"; // Inferred type

            mailroomDetailsSection.style.display = 'block'; // Show Mailroom Details section

            // Clear the stored data immediately after using it
            await chrome.storage.local.remove("clickedMailroomDocData");
            
            // Ensure Document Actions are shown if ID is valid
            if (docInput.value && /^\d+$/.test(docInput.value)) { // FIX: Changed regex to \d+
                documentActionsSection.style.display = 'block';
            }
            // No need to fetch from dashboard or parse other URLs if we got data from a click
            return; 
        }

        // --- Existing logic for extracting IDs from current URL (Job Page or Annotation) ---
        const jobPageMatch = currentTab.url.match(jobPageUrlRegex);
        if (jobPageMatch && jobPageMatch[1]) {
            extractedJobIdFromUrl = jobPageMatch[1]; 
            console.log("DEBUG: Extracted Job ID from Job Page URL:", extractedJobIdFromUrl);

            setTimeout(async () => {
                try {
                    const tabs = await chrome.tabs.query({ url: currentTab.url, currentWindow: false });
                    if (tabs.length > 0 && tabs[0].id) {
                        const tabId = tabs[0].id;
                        const [{ result }] = await chrome.scripting.executeScript({
                            target: { tabId: tabId },
                            func: () => {
                                const pageContent = document.body.textContent;

                                console.log("JOB PAGE SCRIPT DEBUG: ---- START (Simple String Search) ----");
                                console.log("JOB PAGE SCRIPT DEBUG: Document Type:", document.contentType);
                                console.log("JOB PAGE SCRIPT DEBUG: Page content snippet (first 500 chars from body):", pageContent.substring(0, 500));
                                console.log("JOB PAGE SCRIPT DEBUG: Page content length (from body):", pageContent.length);

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
            console.log("DEBUG: Extracted Document ID from Annotation URL:", extractedDocIdFromUrl);
        }

        // --- Core data fetching from Dashboard if currentTab is a Dashboard page ---
        if (currentTab.url.startsWith(dashboardUrlPrefix)) {
            console.log("DEBUG: Current URL is Dashboard. Fetching job data.");
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
                    practiceInput.value = "";
                }

                filterAndDisplaySuggestions(); 
                filterAndDisplayPracticeSuggestions(); 
                filterAndDisplayJobIdSuggestions(); 

            } catch (err) {
                console.error("Error fetching data from dashboard:", err);
                showToast("Failed to fetch data from dashboard.");
                jobTypeLabel.textContent = "—";
                odsCodeLabel.textContent = "—";
                practiceInput.value = "";
            }
        } else {
            console.log("DEBUG: Not a Dashboard URL. Adjusting panel based on current page context.");
            
            jobData = []; 
            uniquePractices = []; 
            // innerHTML = "" calls removed from here, as they are managed by filter/display functions
            // autocompleteResultsContainer.innerHTML = ""; 
            // practiceAutocompleteResultsContainer.innerHTML = "";

            jobTypeLabel.textContent = "—";
            odsCodeLabel.textContent = "—";
            practiceInput.value = "";
        }

        // --- Final step: Populate inputs based on extracted IDs or user input ---

        // Set Job ID if extracted from a specific job page URL
        if (extractedJobIdFromUrl) {
            jobIdInput.value = extractedJobIdFromUrl;
            jobIdAutocompleteResultsContainer.innerHTML = ""; 
        } 
        else if (!currentTab.url.startsWith(dashboardUrlPrefix) && !currentTab.url.startsWith(mailroomUrlPrefix)) {
            jobIdInput.value = "";
            jobIdAutocompleteResultsContainer.innerHTML = ""; 
        }
        // If it IS a dashboard, jobIdInput and suggestions are handled by the dashboard fetching block.


        // Set Document ID based on priority (extracted from URL > user typed > clear)
        if (extractedDocIdFromUrl) {
            docInput.value = extractedDocIdFromUrl;
            docInput.dispatchEvent(new Event('input')); 
        } 
        else if (userTypedDocId) {
            docInput.value = userTypedDocId;
            docInput.dispatchEvent(new Event('input')); 
        }
        else if (!currentTab.url.startsWith(dashboardUrlPrefix) && !currentTab.url.startsWith(mailroomUrlPrefix)) { 
            docInput.value = "";
        }
        
        // Show Document Actions section if a valid 6-digit Document ID is present
        const currentDocIdInInput = docInput.value.trim();
        if (currentDocIdInInput && /^\d+$/.test(currentDocIdInInput)) { // FIX: Changed regex to \d+
            documentActionsSection.style.display = 'block';
        } else {
            documentActionsSection.style.display = 'none';
        }
    }

    // --- Initial Load and Periodic Refresh Setup ---
    // Add a delay to the initial fetchAndPopulateData call
    setTimeout(() => {
        fetchAndPopulateData();
        refreshIntervalId = setInterval(fetchAndPopulateData, 5000); // Changed to 5 seconds
    }, 500); // 500ms delay

    // Clear interval when panel closes to prevent memory leaks
    window.addEventListener('beforeunload', () => {
        clearInterval(refreshIntervalId);
    });

    // --- Event Listeners for Custom Autocomplete Inputs ---

    docInput.addEventListener("input", () => {
      const docIdFullString = docInput.value;
      const numericDocId = getNumericDocIdFromInput(docIdFullString);

      const match = jobData.find(j => j.documentId === numericDocId);
      if (match) {
        jobIdInput.value = match.jobId;
        jobTypeLabel.textContent = match.jobType;
        practiceInput.value = match.practiceName;
        odsCodeLabel.textContent = match.odsCode;
      } else {
        clearDependentFields();
        practiceInput.value = "";
      }
      filterAndDisplayJobIdSuggestions();

      // Show/hide Document Actions based on docInput value
      if (numericDocId && /^\d+$/.test(numericDocId)) { // FIX: Changed regex to \d+
          documentActionsSection.style.display = 'block';
      } else {
          documentActionsSection.style.display = 'none';
      }
    });

    docInput.addEventListener("focus", filterAndDisplaySuggestions); // Show on focus
    docInput.addEventListener("blur", hideSuggestions); // Hide on blur (with timeout)
    
    docInput.addEventListener("keydown", (e) => {
        let items = autocompleteResultsContainer.querySelectorAll(".autocomplete-item");
        if (items.length === 0) return;

        if (e.key === "ArrowDown") {
            docActive = addActive(docActive, items);
            items[docActive].scrollIntoView({ block: "nearest" });
            e.preventDefault();
        } else if (e.key === "ArrowUp") {
            docActive = addActive(docActive, items);
            items[docActive].scrollIntoView({ block: "nearest" });
            e.preventDefault();
        } else if (e.key === "Enter") {
            e.preventDefault();
            if (docActive > -1) {
                if (items[docActive]) {
                    selectSuggestion(items[docActive]);
                }
            } else if (docInput.value.trim() !== "") {
                const typedId = getNumericDocIdFromInput(docInput.value);
                const match = jobData.find(j => j.documentId === typedId);
                if (match) {
                    docInput.value = typedId;
                    docInput.dispatchEvent(new Event('input'));
                }
                hideSuggestions();
            } else {
                hideSuggestions();
            }
        }
    });

    // Job ID Input Event Listeners
    jobIdInput.addEventListener("click", (e) => {
        e.stopPropagation();
        filterAndDisplayJobIdSuggestions();
    });
    jobIdInput.addEventListener("focus", filterAndDisplayJobIdSuggestions); // Show on focus
    jobIdInput.addEventListener("blur", hideSuggestions); // Hide on blur (with timeout)

    jobIdInput.addEventListener("keydown", (e) => {
        let items = jobIdAutocompleteResultsContainer.querySelectorAll(".autocomplete-item");
        if (items.length === 0) return;

        if (e.key === "ArrowDown") {
            jobIdActive = addActive(jobIdActive, items);
            items[jobIdActive].scrollIntoView({ block: "nearest" });
            e.preventDefault();
        } else if (e.key === "ArrowUp") {
            jobIdActive = addActive(jobIdActive, items);
            items[jobIdActive].scrollIntoView({ block: "nearest" });
            e.preventDefault();
        } else if (e.key === "Enter") {
            e.preventDefault();
            if (jobIdActive > -1) {
                if (items[jobIdActive]) {
                    selectJobIdSuggestion(items[jobIdActive]);
                }
            }
            hideSuggestions();
        }
    });

    practiceInput.addEventListener("input", filterAndDisplayPracticeSuggestions);
    practiceInput.addEventListener("click", (e) => {
        e.stopPropagation();
        filterAndDisplayPracticeSuggestions();
    });
    practiceInput.addEventListener("focus", filterAndDisplayPracticeSuggestions); // Show on focus
    practiceInput.addEventListener("blur", hideSuggestions); // Hide on blur (with timeout)

    practiceInput.addEventListener("keydown", (e) => {
        let items = practiceAutocompleteResultsContainer.querySelectorAll(".autocomplete-item");
        if (items.length === 0) return;

        if (e.key === "ArrowDown") {
            practiceActive = addActive(practiceActive, items);
            items[practiceActive].scrollIntoView({ block: "nearest" });
            e.preventDefault();
        } else if (e.key === "ArrowUp") {
            practiceActive = addActive(practiceActive, items);
            items[practiceActive].scrollIntoView({ block: "nearest" });
            e.preventDefault();
        } else if (e.key === "Enter") {
            e.preventDefault();
            if (practiceActive > -1) {
                if (items[practiceActive]) {
                    selectPracticeSuggestion(items[practiceActive]);
                }
            } else if (practiceInput.value.trim() !== "") {
                const typedPracticeName = practiceInput.value.trim();
                const match = uniquePractices.find(p => p.practiceName === typedPracticeName);
                if (match) {
                    odsCodeLabel.textContent = match.odsCode;
                }
                hideSuggestions();
            } else {
                hideSuggestions();
            }
        }
    });

    // Global mousedown listener to hide all autocompletes
    document.addEventListener("mousedown", (e) => {
        if (!autocompleteResultsContainer.contains(e.target) && !docInput.contains(e.target) &&
            !practiceAutocompleteResultsContainer.contains(e.target) && !practiceInput.contains(e.target) &&
            !jobIdAutocompleteResultsContainer.contains(e.target) && !jobIdInput.contains(e.target)) {
            hideSuggestions();
        }
    });


    // --- Existing Action Button Event Listeners ---

    // NEW: Clear Document ID button functionality
    clearDocIdBtn.onclick = () => {
        docInput.value = ""; // Clear the input field
        docInput.dispatchEvent(new Event('input')); // Trigger input event to clear dependent fields
        showToast("Document ID cleared.");
        docInput.focus(); // Optional: put focus back on the input
    };

    copyDocBtn.onclick = () => {
      const docIdFullString = docInput.value.trim();
      const numericDocId = getNumericDocIdFromInput(docIdFullString);
      if (!numericDocId) return showToast("No Document ID");
      navigator.clipboard.writeText(`document_id = ${numericDocId}`);
      showToast(`Copied: document_id = ${numericDocId}`);
    };

    copyPracticeNameBtn.onclick = () => {
      const practiceName = practiceInput.value.trim();
      if (!practiceName) return showToast("No Practice Name to copy.");
      navigator.clipboard.writeText(practiceName);
      showToast(`Copied: ${practiceName}`);
    };

    statusBtn.onclick = () => {
      const docIdFullString = docInput.value.trim();
      const numericDocId = getNumericDocIdFromInput(docIdFullString);
      if (!numericDocId) return showToast("No Document ID");
      const url = `https://app.betterletter.ai/admin_panel/bots/dashboard?document_id=${numericDocId}`;
      
      navigator.clipboard.writeText(url).then(() => {
          showToast(`Copied URL: ${url}`);
      }).catch(err => {
          console.error("Failed to copy URL for Status:", err);
          showToast("Failed to copy URL.");
      });
      
      openTabWithTimeout(url);
    };

    obanBtn.onclick = () => {
      const docIdFullString = docInput.value.trim();
      const numericDocId = getNumericDocIdFromInput(docIdFullString);
      if (!numericDocId) return showToast("No Document ID");
      if (!/^\d+$/.test(numericDocId)) return showToast("Invalid Document ID"); // FIX: Changed regex to \d+
      const url = `https://app.betterletter.ai/oban/jobs?args=document_id%2B%2B${numericDocId}&state=available`;
      
      navigator.clipboard.writeText(url).then(() => {
          showToast(`Copied URL: ${url}`);
      }).catch(err => {
          console.error("Failed to copy URL for Oban:", err);
          showToast("Failed to copy URL.");
      });

      openTabWithTimeout(url);
    };

    annoBtn.onclick = () => {
      const docIdFullString = docInput.value.trim();
      const numericDocId = getNumericDocIdFromInput(docIdFullString);
      if (!numericDocId) return showToast("No Document ID");
      const url = `https://app.betterletter.ai/mailroom/annotations/${numericDocId}`;
      
      navigator.clipboard.writeText(url).then(() => {
          showToast(`Copied URL: ${url}`);
      }).catch(err => {
          console.error("Failed to copy URL for Annotation:", err);
          showToast("Failed to copy URL.");
      });

      openTabWithTimeout(url);
    };

    eventLogBtn.onclick = () => {
        const docIdFullString = docInput.value.trim();
        const numericDocId = getNumericDocIdFromInput(docIdFullString);
        if (!numericDocId) return showToast("No Document ID");
        const url = `https://app.betterletter.ai/admin_panel/event_log/${numericDocId}`;
        
        navigator.clipboard.writeText(url).then(() => {
            showToast(`Copied URL: ${url}`);
        }).catch(err => {
            console.error("Failed to copy URL for Event Log:", err);
            showToast("Failed to copy URL.");
        });

        openTabWithTimeout(url);
    };

    letterAdminBtn.onclick = () => {
        const docIdFullString = docInput.value.trim();
        const numericDocId = getNumericDocIdFromInput(docIdFullString);
        if (!numericDocId) return showToast("No Document ID");
        const url = `https://app.betterletter.ai/admin_panel/letter/${numericDocId}`;
        
        navigator.clipboard.writeText(url).then(() => {
            showToast(`Copied URL: ${url}`);
        }).catch(err => {
            console.error("Failed to copy URL for L. Admin:", err);
            showToast("Failed to copy URL.");
        });

        openTabWithTimeout(url);
    };

    openJobBtn.onclick = () => {
      const jobId = jobIdInput.value;
      if (!jobId) return showToast("No Job ID");
      const url = `https://app.betterletter.ai/admin_panel/bots/jobs/${jobId}`;
      
      navigator.clipboard.writeText(url).then(() => {
          showToast(`Copied URL: ${url}`);
      }).catch(err => {
          console.error("Failed to copy URL for Job Page:", err);
          showToast("Failed to copy URL.");
      });

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

                console.log("JOB PAGE SCRIPT DEBUG: ---- START (Simple String Search) ----");
                console.log("JOB PAGE SCRIPT DEBUG: Document Type:", document.contentType);
                console.log("JOB PAGE SCRIPT DEBUG: Page content snippet (first 500 chars from body):", pageContent.substring(0, 500));
                console.log("JOB PAGE SCRIPT DEBUG: Page content length (from body):", pageContent.length);

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

                console.log("JOB PAGE SCRIPT DEBUG: Extracted Title (string search):", extractedTitle);
                console.log("JOB PAGE SCRIPT DEBUG: ---- END ----");

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
  });
