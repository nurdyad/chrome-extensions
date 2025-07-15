
// Function to extract data from a table row on Mailroom pages (Rejected, Preparing, etc.)
function extractDataFromMailroomRow(row) {
    const cells = row.querySelectorAll('td');
    // Basic check for minimum number of cells
    if (cells.length < 6) { 
        return null;
    }

    const originalNameLink = cells[0]?.querySelector('a'); // Document ID is typically in the first column's link
    // Regex to extract ID from URL like /123456.pdf or from text 123456.pdf
    const documentIdMatch = originalNameLink?.href.match(/\/(\d+)\.pdf$/) || originalNameLink?.textContent.match(/^(\d{6})\.pdf$/); 

    const documentId = documentIdMatch ? documentIdMatch[1] : null;
    const jobType = cells[1]?.innerText.trim(); // Assuming Job Type is in the second column
    const practiceCell = cells[2]?.innerText.trim(); // Assuming Practice is in the third column
    const [practiceName, odsCode] = practiceCell ? practiceCell.split('\n').map(t => t.trim()) : ['', ''];
    const jobId = cells[3]?.innerText.trim(); // Assuming Job ID is in the fourth column

    if (documentId && /^\d{6}$/.test(documentId)) { // Ensure it's a valid 6-digit ID
        return { documentId, jobType, practiceName, odsCode, jobId };
    }
    return null;
}

// Function to add click listeners to Document ID links on Mailroom pages
function addMailroomDocIdListeners() {
    // Target table rows on Mailroom pages
    // This selector should be robust enough for similar table structures
    const tableRows = document.querySelectorAll('table.table tbody tr'); 

    tableRows.forEach(row => {
        // Prevent processing the same row multiple times
        if (row.dataset.processedByMailroomExt) {
            return;
        }
        row.dataset.processedByMailroomExt = 'true'; // Mark as processed

        const originalNameLink = row.querySelector('td:first-child a'); // The link in the first column

        if (originalNameLink) {
            const rowData = extractDataFromMailroomRow(row);
            if (rowData) {
                // Store data directly on the link's dataset for easy access in the click handler
                originalNameLink.dataset.documentId = rowData.documentId;
                originalNameLink.dataset.jobType = rowData.jobType;
                originalNameLink.dataset.practiceName = rowData.practiceName;
                originalNameLink.dataset.odsCode = rowData.odsCode;
                originalNameLink.dataset.jobId = rowData.jobId;

                // Add a click listener to the link
                originalNameLink.addEventListener('click', (e) => {
                    // Send message to background script with the extracted data
                    chrome.runtime.sendMessage({
                        type: 'mailroom_doc_clicked', // NEW message type
                        data: {
                            documentId: e.currentTarget.dataset.documentId,
                            jobType: e.currentTarget.dataset.jobType,
                            practiceName: e.currentTarget.dataset.practiceName,
                            odsCode: e.currentTarget.dataset.odsCode,
                            jobId: e.currentTarget.dataset.jobId
                        }
                    }).catch(error => {
                        console.error('Error sending mailroom_doc_clicked message:', error);
                    });
                    // Allow default navigation to happen after sending message
                });
            }
        }
    });
}

// Observe DOM changes (e.g., pagination, new rows loading)
const observer = new MutationObserver(addMailroomDocIdListeners);
observer.observe(document.body, { childList: true, subtree: true });

// Run once on initial page load
addMailroomDocIdListeners();