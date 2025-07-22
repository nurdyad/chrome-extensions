
console.log("Mailroom Integrator: Script loaded.");

// Function to extract data from a table row on Mailroom pages (Rejected, Preparing, etc.)
function extractDataFromMailroomRow(row) {
    console.log("Mailroom Integrator: Processing row:", row);
    const cells = row.querySelectorAll('td');
    console.log(`Mailroom Integrator: Row has ${cells.length} cells.`);

    // Based on the latest screenshot, expecting 7 columns (0-6)
    if (cells.length < 7) { 
        console.log("Mailroom Integrator: Row has too few cells (<7), skipping.", row);
        return null;
    }

    // --- Column 0: Document ID (from span) ---
    const docIdSpan = cells[0]?.querySelector('div > span.grow-0.overflow-x-clip'); 
    const documentId = docIdSpan ? docIdSpan.textContent.trim() : null;
    console.log("Mailroom Integrator: Extracted Document ID:", documentId);
    if (!documentId || !/^\d+$/.test(documentId)) { // Allow any number of digits
        console.log("Mailroom Integrator: Document ID not found or invalid format.", documentId);
        return null;
    }

    const originalNameContent = cells[0]?.innerText.trim(); // Full text of the first column
    
    // --- Column 1: Status (e.g., "Patient not matched", "Missing NHS No.") ---
    const statusContent = cells[1]?.innerText.trim();
    console.log("Mailroom Integrator: Extracted Status Content (col 1):", statusContent);

    // --- Column 2: Time Spent (e.g., "Paused") ---
    const timeSpent = cells[2]?.innerText.trim();
    console.log("Mailroom Integrator: Extracted Time Spent (col 2):", timeSpent);

    // --- Column 3: Document Name (contains UUID in title attribute) ---
    const docNameTd = cells[3]; // This td contains the link with the UUID filename
    const jobIdMatch = docNameTd?.title.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
    const jobId = jobIdMatch ? jobIdMatch[1] : null;
    console.log("Mailroom Integrator: Extracted Job ID (UUID from col 3 title):", jobId);

    // --- Column 4: Expected Return Date ---
    const expectedReturnDate = cells[4]?.innerText.trim();
    console.log("Mailroom Integrator: Extracted Expected Return Date (col 4):", expectedReturnDate);

    // --- Column 5: Practice Name (from its title attribute if available, or innerText) ---
    const practiceTd = cells[5];
    const practiceName = practiceTd?.title || practiceTd?.innerText.trim(); // Get from title attribute first
    const odsCode = null; // ODS Code is not available in this table view
    console.log("Mailroom Integrator: Extracted Practice Name (col 5):", practiceName);

    // --- Column 6: Urgent Status (not needed for panel fields, but for completeness) ---
    const urgentStatus = cells[6]?.querySelector('[data-test-id="urgent"]')?.innerText.trim(); 
    console.log("Mailroom Integrator: Extracted Urgent Status (col 6):", urgentStatus);


    // --- Inferring fields that are not direct columns or need special handling ---
    // NHS No., Patient Name, Reason, Rejected By / On are NOT in these columns in this table view.
    // They are in the 'Rejected' table, but not 'Preparing' based on your previous screenshots.
    const nhsNo = null;
    const patientName = null;
    const reason = null;
    const rejectedByOn = null;
    
    let inferredJobType = null;
    if (originalNameContent && originalNameContent.toLowerCase().includes("clinical letter")) inferredJobType = "Clinical letter";
    else if (originalNameContent && originalNameContent.toLowerCase().includes("document")) inferredJobType = "Document";

    console.log("Mailroom Integrator: Final extracted data for row.");
    return { 
        documentId, 
        originalNameContent, 
        nhsNo, 
        patientName, 
        practiceName, 
        odsCode, 
        reason, 
        rejectedByOn, 
        status: statusContent, // From Column 1
        jobId, 
        inferredJobType 
    };
}

// Function to add double-click listeners to Document ID elements on Mailroom pages
function addMailroomDocIdListeners() {
    console.log("Mailroom Integrator: Running addMailroomDocIdListeners.");
    const tableRows = document.querySelectorAll('#documents-table-body tr'); 
    console.log(`Mailroom Integrator: Found ${tableRows.length} table rows with #documents-table-body tr.`);

    tableRows.forEach(row => {
        if (row.dataset.processedByMailroomExt) {
            return;
        }
        row.dataset.processedByMailroomExt = 'true';

        const docIdElement = row.querySelector('td:first-child div > span.grow-0.overflow-x-clip');

        if (docIdElement) {
            const rowData = extractDataFromMailroomRow(row);
            if (rowData) {
                // Store all extracted data in the dataset
                docIdElement.dataset.documentId = rowData.documentId;
                docIdElement.dataset.originalNameContent = rowData.originalNameContent; 
                docIdElement.dataset.nhsNo = rowData.nhsNo;
                docIdElement.dataset.patientName = rowData.patientName;
                docIdElement.dataset.practiceName = rowData.practiceName;
                docIdElement.dataset.odsCode = rowData.odsCode;
                docIdElement.dataset.reason = rowData.reason;
                docIdElement.dataset.rejectedByOn = rowData.rejectedByOn;
                docIdElement.dataset.status = rowData.status;
                docIdElement.dataset.jobId = rowData.jobId; 
                docIdElement.dataset.inferredJobType = rowData.inferredJobType; 

                docIdElement.addEventListener('dblclick', (e) => { 
                    e.preventDefault(); 
                    e.stopPropagation(); 

                    console.log("Mailroom Integrator: Document ID DOUBLE-CLICKED! Sending message to background.", e.currentTarget.dataset);
                    chrome.runtime.sendMessage({
                        type: 'mailroom_doc_clicked',
                        data: {
                            documentId: e.currentTarget.dataset.documentId,
                            originalNameContent: e.currentTarget.dataset.originalNameContent, 
                            nhsNo: e.currentTarget.dataset.nhsNo,
                            patientName: e.currentTarget.dataset.patientName,
                            practiceName: e.currentTarget.dataset.practiceName,
                            odsCode: e.currentTarget.dataset.odsCode,
                            reason: e.currentTarget.dataset.reason,
                            rejectedByOn: e.currentTarget.dataset.rejectedByOn,
                            status: e.currentTarget.dataset.status,
                            jobId: e.currentTarget.dataset.jobId, 
                            inferredJobType: e.currentTarget.dataset.inferredJobType 
                        }
                    }).then(response => {
                        console.log('Mailroom Integrator: Message sent response from background:', response);
                    }).catch(error => {
                        console.error('Mailroom Integrator: Error sending message:', error);
                    });
                });
            } else {
                console.log("Mailroom Integrator: Row data extraction failed for element, no listener added for:", docIdElement);
            }
        } else {
            console.log("Mailroom Integrator: No Document ID span found in row (td:first-child div > span.grow-0.overflow-x-clip):", row);
        }
    });
}

const observer = new MutationObserver((mutationsList, observer) => {
    clearTimeout(window._mailroomObserverTimeout);
    window._mailroomObserverTimeout = setTimeout(() => {
        addMailroomDocIdListeners();
    }, 500);
});

observer.observe(document.body, { childList: true, subtree: true });

setTimeout(() => {
    addMailroomDocIdListeners();
}, 1000); 
