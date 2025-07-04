// BetterLetterJobManager/panel.js (FINAL VERSION)

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
      jobIdAutocompleteResultsContainer
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
      document.getElementById("jobIdAutocompleteResults")
    ];

    // Helper function to clear dependent fields
    function clearDependentFields() {
        jobIdInput.value = "";
        jobTypeLabel.textContent = "—";
        odsCodeLabel.textContent = "—";
        jobTitleDisplay.value = "";
        jobTitleSection.style.display = 'none';
        practiceInput.value = "";
        jobIdAutocompleteResultsContainer.innerHTML = "";
    }

    // Helper function to extract numeric Document ID from formatted string
    function getNumericDocIdFromInput(inputString) {
        const match = inputString.trim().match(/^\d+/);
        return match ? match[0] : null;
    }

    // Helper to get ODS code from practice name
    function getOdsCodeFromPracticeName(practiceName) {
        const found = uniquePractices.find(p => p.practiceName === practiceName);
        return found ? found.odsCode : null;
    }

    let jobData = [];
    let uniquePractices = [];
    let refreshIntervalId;

    // ORIGINAL openTabWithTimeout function (without inactivity detection)
    function openTabWithTimeout(url) { // No 'delay' parameter, as inactivity timer is removed
        chrome.tabs.create({ url }).catch(err => {
            console.error("Failed to open tab:", err);
            showToast("Failed to open page.");
        });
    }

    // Functions for custom Document ID autocomplete
    function filterAndDisplaySuggestions() {
        const searchTerm = docInput.value.trim().toLowerCase();
        autocompleteResultsContainer.innerHTML = '';
        autocompleteResultsContainer.style.display = 'none';

        const isInputFocused = (document.activeElement === docInput);

        // Only proceed if there's a search term, OR if input is focused AND there's actual data to show
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

         // Only display items if filteredData actually has items
        if (filteredData.length === 0) { // If no matches, or no data at all
            return; // Don't show empty dropdown
        }

        filteredData.forEach(job => {
            if(job.documentId){
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

        if (filteredData.length > 0 && isInputFocused) {
            const inputRect = docInput.getBoundingClientRect();

            // Set position and width directly based on viewport coordinates
            autocompleteResultsContainer.style.left = `${inputRect.left}px`; // Relative to viewport left
            autocompleteResultsContainer.style.top = `${inputRect.bottom}px`; // Below the input
            autocompleteResultsContainer.style.width = `${inputRect.width}px`;
            autocompleteResultsContainer.style.display = 'block';
        } else if (jobData.length > 0 && !searchTerm && isInputFocused) {
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
    }

    function hideSuggestions() {
        setTimeout(() => {
            autocompleteResultsContainer.style.display = 'none';
            practiceAutocompleteResultsContainer.style.display = 'none';
        }, 100);
    }

    let currentActive = -1;

    function addActive(items) {
        if (!items) return false;
        removeActive(items);
        if (currentActive >= items.length) currentActive = 0;
        if (currentActive < 0) currentActive = (items.length - 1);
        items[currentActive].classList.add("active");
    }

    function removeActive(items) {
        for (var i = 0; i < items.length; i++) {
            items[i].classList.remove("active");
        }
    }

    // Functions for custom Practice Name autocomplete
    function filterAndDisplayPracticeSuggestions() {
        const searchTerm = practiceInput.value.trim().toLowerCase();
        practiceAutocompleteResultsContainer.innerHTML = ''; // Clear previous suggestions
        practiceAutocompleteResultsContainer.style.display = 'none'; // Hide container by default

        const isInputFocused = (document.activeElement === practiceInput);

        // If there's no search term AND the input is not focused, AND there's no data,
        // then simply return. This prevents showing an empty dropdown or popping up without interaction.
        if ((!searchTerm && !isInputFocused && uniquePractices.length === 0) || (uniquePractices.length === 0 && !searchTerm)) {
            return;
        }

        let filteredData = uniquePractices;
        // Filter data if a search term is present
        if (searchTerm) {
            filteredData = uniquePractices.filter(p =>
                // Ensure practiceName and odsCode exist before calling toLowerCase()
                (p.practiceName || '').toLowerCase().includes(searchTerm) ||
                (p.odsCode || '').toLowerCase().includes(searchTerm)
            );
        }

        // Only proceed to create and display items if there's actual filtered data
        if (filteredData.length === 0) {
            return; // If no matches, or filtered data is empty, don't show the dropdown
        }

        // Iterate through filtered data and create suggestion items
        filteredData.forEach(p => {
            // IMPORTANT: Only create an item if both practiceName and odsCode actually exist
            if (p.practiceName && p.odsCode) { 
                const item = document.createElement('div');
                item.classList.add('autocomplete-item');
                item.textContent = `${p.practiceName} (${p.odsCode})`; // Display formatted practice name and ODS code
                item.dataset.practiceName = p.practiceName; // Store full practice name
                item.dataset.odsCode = p.odsCode; // Store ODS code

                item.addEventListener('click', () => {
                    selectPracticeSuggestion(item);
                });
                practiceAutocompleteResultsContainer.appendChild(item);
            }
        });

        // Only show the container if it actually has children (suggestions) AND the input is focused
        if (practiceAutocompleteResultsContainer.children.length > 0 && isInputFocused) {
            const inputRect = practiceInput.getBoundingClientRect();
            
            // Position the autocomplete container based on the input field's viewport coordinates
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
    }

    function filterAndDisplaySuggestions() {
        const searchTerm = docInput.value.trim().toLowerCase();
        autocompleteResultsContainer.innerHTML = ''; // Clear previous suggestions
        autocompleteResultsContainer.style.display = 'none'; // Hide container by default

        const isInputFocused = (document.activeElement === docInput);

        // If there's no search term AND the input is not focused, AND there's no data,
        // OR if there's no data at all, then simply return.
        // This prevents showing an empty dropdown or popping up without interaction.
        if ((!searchTerm && !isInputFocused && jobData.length === 0) || (jobData.length === 0 && !searchTerm)) {
            return;
        }

        let filteredData = jobData;
        // Filter data if a search term is present
        if (searchTerm) {
            filteredData = jobData.filter(job =>
                // Ensure job.documentId and job.practiceName exist before calling toLowerCase()
                (job.documentId || '').toLowerCase().includes(searchTerm) ||
                (job.practiceName || '').toLowerCase().includes(searchTerm)
            );
        }

        // Only proceed to create and display items if there's actual filtered data
        if (filteredData.length === 0) {
            return; // If no matches, or filtered data is empty, don't show the dropdown
        }

        // Iterate through filtered data and create suggestion items
        filteredData.forEach(job => {
            // IMPORTANT: Only create an item if job.documentId actually exists
            if (job.documentId) { 
                const item = document.createElement('div');
                item.classList.add('autocomplete-item');
                item.textContent = job.documentId; // Display only the document ID
                item.dataset.documentId = job.documentId; // Store the ID for selection

                item.addEventListener('click', () => {
                    selectSuggestion(item);
                });
                autocompleteResultsContainer.appendChild(item);
            }
        });

        // Only show the container if it actually has children (suggestions) AND the input is focused
        if (autocompleteResultsContainer.children.length > 0 && isInputFocused) {
            const inputRect = docInput.getBoundingClientRect();
            
            // Position the autocomplete container based on the input field's viewport coordinates
            autocompleteResultsContainer.style.left = `${inputRect.left}px`; 
            autocompleteResultsContainer.style.top = `${inputRect.bottom}px`; // Place directly below the input
            autocompleteResultsContainer.style.width = `${inputRect.width}px`; // Match input width
            autocompleteResultsContainer.style.display = 'block'; // Make it visible
        }
    }

    function selectJobIdSuggestion(item) {
        const selectedJobId = item.dataset.jobId;
        jobIdInput.value = selectedJobId; // Populate the readonly input
        jobIdAutocompleteResultsContainer.style.display = 'none'; // Hide suggestions
        // No need to dispatch 'input' as it's readonly and doesn't drive other fields directly
    }


    // Main data fetching and UI population function
    async function fetchAndPopulateData() {
        const { targetTabId } = await chrome.storage.local.get("targetTabId");
        let currentTab;
        let extractedDocIdFromUrl = null; 
        let extractedJobIdFromUrl = null; 

        const userTypedDocId = docInput.value; 

        // Define URL regexes
        const dashboardUrlPrefix = "https://app.betterletter.ai/admin_panel/bots/dashboard";
        const annotationUrlRegex = /^https:\/\/app\.betterletter\.ai\/mailroom\/annotations\/(\d+)/; 
        const jobPageUrlRegex = /^https:\/\/app\.betterletter\.ai\/admin_panel\/bots\/jobs\/([a-f0-9-]+)\/?/; 

        // Reset Job Title section's visibility initially, it will be set to 'block' if relevant.
        jobTitleDisplay.value = "";
        jobTitleSection.style.display = 'none';

        if (!targetTabId) {
            showToast("No active tab context. Please ensure a tab is active.");
            clearDependentFields();
            docInput.value = userTypedDocId; // Preserve user's input
            return;
        }

        try {
            currentTab = await chrome.tabs.get(targetTabId);
        } catch (e) {
            showToast("Target tab no longer exists or is inaccessible.");
            clearDependentFields();
            docInput.value = userTypedDocId; // Preserve user's input
            return;
        }

        if (!currentTab.url) { 
            showToast("Cannot read URL from the active tab.");
            clearDependentFields();
            docInput.value = userTypedDocId; // Preserve user's input
            return;
        }

        // --- Extract IDs from current URL if applicable ---
        const jobPageMatch = currentTab.url.match(jobPageUrlRegex);
        if (jobPageMatch && jobPageMatch[1]) {
            extractedJobIdFromUrl = jobPageMatch[1]; 
            console.log("DEBUG: Extracted Job ID from Job Page URL:", extractedJobIdFromUrl);

            // If we are on a job page, immediately try to extract title without waiting for full refresh cycle
            // This makes it more responsive for title display
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
                            jobTitleSection.style.display = 'block'; // Make it visible
                        } else {
                            jobTitleDisplay.value = "Title not found";
                            jobTitleSection.style.display = 'block';
                        }
                    }
                } catch (e) {
                    console.error("Error extracting job title on refresh:", e);
                    jobTitleDisplay.value = "Error extracting title";
                    jobTitleSection.style.display = 'block';
                }
            }, 100); // Small delay to allow page to settle
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
                    // Preserve docInput below. Clear other fields.
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
                // Preserve docInput below. Clear other fields.
                jobTypeLabel.textContent = "—";
                odsCodeLabel.textContent = "—";
                practiceInput.value = "";
            }
        } else {
            // --- If NOT a dashboard URL (e.g., on a specific job page or annotation page, or generic page) ---
            console.log("DEBUG: Not a Dashboard URL. Adjusting panel based on current page context.");
            
            jobData = []; 
            uniquePractices = []; 
            autocompleteResultsContainer.innerHTML = ""; 
            practiceAutocompleteResultsContainer.innerHTML = "";

            // Clear only fields that are not derived from the current page's specific context
            jobTypeLabel.textContent = "—";
            odsCodeLabel.textContent = "—";
            practiceInput.value = "";
            // Job Title section visibility is managed above if it's a job page.
        }

        // --- Final step: Populate inputs based on extracted IDs or user input ---

        // Set Job ID if extracted from a specific job page URL
        if (extractedJobIdFromUrl) {
            jobIdInput.value = extractedJobIdFromUrl;
            jobIdAutocompleteResultsContainer.innerHTML = ""; // No suggestions needed when on a specific job page
        } else if (!currentTab.url.startsWith(dashboardUrlPrefix)) {
            // If not a job page AND not a dashboard, clear Job ID
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
        else if (!currentTab.url.startsWith(dashboardUrlPrefix)) { // Only clear if not a dashboard and no other ID source
            docInput.value = "";
        }
        // If it is a dashboard, docInput value is driven by select suggestion or typed value (which triggers jobData match).
    }

    // --- Initial Load and Periodic Refresh Setup ---
    fetchAndPopulateData();
    refreshIntervalId = setInterval(fetchAndPopulateData, 2000);

    // Clear interval when panel closes to prevent memory leaks
    window.addEventListener('beforeunload', () => {
        clearInterval(refreshIntervalId);
    });

    // --- Event Listeners for Custom Autocomplete Inputs ---

    docInput.addEventListener("input", filterAndDisplaySuggestions);
    docInput.addEventListener("click", (e) => {
        e.stopPropagation();
        filterAndDisplaySuggestions();
    });
    docInput.addEventListener("keydown", (e) => {
        let items = autocompleteResultsContainer.querySelectorAll(".autocomplete-item");
        if (items.length === 0) return;

        if (e.key === "ArrowDown") {
            currentActive++;
            addActive(items);
            items[currentActive].scrollIntoView({ block: "nearest" });
            e.preventDefault();
        } else if (e.key === "ArrowUp") {
            currentActive--;
            addActive(items);
            items[currentActive].scrollIntoView({ block: "nearest" });
            e.preventDefault();
        } else if (e.key === "Enter") {
            e.preventDefault();
            if (currentActive > -1) {
                if (items[currentActive]) {
                    selectSuggestion(items[currentActive]);
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
        filterAndDisplayJobIdSuggestions(); // Show suggestions on click
    });

    jobIdInput.addEventListener("keydown", (e) => {
        let items = jobIdAutocompleteResultsContainer.querySelectorAll(".autocomplete-item");
        if (items.length === 0) return;

        if (e.key === "ArrowDown") {
            currentActive++;
            addActive(items);
            items[currentActive].scrollIntoView({ block: "nearest" });
            e.preventDefault();
        } else if (e.key === "ArrowUp") {
            currentActive--;
            addActive(items);
            items[currentActive].scrollIntoView({ block: "nearest" });
            e.preventDefault();
        } else if (e.key === "Enter") {
            e.preventDefault();
            if (currentActive > -1) {
                if (items[currentActive]) {
                    selectJobIdSuggestion(items[currentActive]);
                }
            }
            hideSuggestions(); // Hide after selection or attempted selection
        }
    });

    // Modify global mousedown listener to also hide jobId suggestions
    document.addEventListener("mousedown", (e) => {
        if (!autocompleteResultsContainer.contains(e.target) && !docInput.contains(e.target) &&
            !practiceAutocompleteResultsContainer.contains(e.target) && !practiceInput.contains(e.target) &&
            !jobIdAutocompleteResultsContainer.contains(e.target) && !jobIdInput.contains(e.target)) { // NEW condition
            hideSuggestions();
        }
    });

    practiceInput.addEventListener("input", filterAndDisplayPracticeSuggestions);
    practiceInput.addEventListener("click", (e) => {
        e.stopPropagation();
        filterAndDisplayPracticeSuggestions();
    });
    practiceInput.addEventListener("keydown", (e) => {
        let items = practiceAutocompleteResultsContainer.querySelectorAll(".autocomplete-item");
        if (items.length === 0) return;

        if (e.key === "ArrowDown") {
            currentActive++;
            addActive(items);
            items[currentActive].scrollIntoView({ block: "nearest" });
            e.preventDefault();
        } else if (e.key === "ArrowUp") {
            currentActive--;
            addActive(items);
            items[currentActive].scrollIntoView({ block: "nearest" });
            e.preventDefault();
        } else if (e.key === "Enter") {
            e.preventDefault();
            if (currentActive > -1) {
                if (items[currentActive]) {
                    selectPracticeSuggestion(items[currentActive]);
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

    

    document.addEventListener("mousedown", (e) => {
        if (!autocompleteResultsContainer.contains(e.target) && !docInput.contains(e.target) &&
            !practiceAutocompleteResultsContainer.contains(e.target) && !practiceInput.contains(e.target)) {
            hideSuggestions();
        }
    });


    // --- Existing Action Button Event Listeners ---

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
    });

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
      if (!/^\d{6}$/.test(numericDocId)) return showToast("Invalid Document ID");
      const url = `https://app.betterletter.ai/oban/jobs?args=document_id%2B%2B${input}&state=available`;
      
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
        navigator.clipboard.writeText(`edited_file_name = "${titleText}"`);
        showToast(`Copied: edited_file_name = "${titleText}"`);
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
