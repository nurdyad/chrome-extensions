// content.js

(function() {
    console.log("BetterLetter Data Extractor: Content script running.");

    // Function to extract data from the table
    function extractTableData() {
        const extractedData = [];
        // ATTENTION: You might need to adjust this selector!
        // Try to find a unique selector for your table body.
        // Based on the screenshot, it looks like a standard HTML table.
        // If there are multiple tables, you might need a more specific selector
        // e.g., document.querySelector('#someTableId tbody') or document.querySelector('.someTableClass tbody')
        const tableBody = document.querySelector('table tbody');

        if (!tableBody) {
            console.warn("BetterLetter Data Extractor: Table body not found. Check the selector.");
            return [];
        }

        const rows = tableBody.querySelectorAll('tr'); // Get all table rows

        rows.forEach(row => {
            const cells = row.querySelectorAll('td'); // Get all cells in the row
            // Ensure there are enough cells to match your expected columns
            // Based on the screenshot, it seems there are at least 9 data columns (including the checkbox which isn't scraped)
            if (cells.length >= 9) {
                const rowData = {
                    // Re-evaluating indices based on the new screenshot and your description
                    // The first cell is likely the checkbox, which we skip.
                    // Original Name (which is the actual numeric ID in your screenshot) is the 1st visible data column (index 0 for data, but 1st actual TD)
                    // Document ID (the long hash) is the 2nd visible data column (index 1 for data, but 2nd actual TD)
                    originalName: cells[0]?.textContent.trim(), // The numeric ID, which was previously `originalName`
                    documentId: cells[1]?.textContent.trim(), // The Document ID (the long hash string)
                    nhsNo: cells[2]?.textContent.trim(),       // NHS No.
                    patientName: cells[3]?.textContent.trim(), // Patient Name
                    practice: cells[4]?.textContent.trim(),
                    reason: cells[5]?.textContent.trim(),
                    rejectedBy: cells[6]?.textContent.trim(),
                    on: cells[7]?.textContent.trim(),
                    status: cells[8]?.textContent.trim()
                };
                extractedData.push(rowData);
            }
        });
        console.log("BetterLetter Data Extractor: Data extracted:", extractedData);
        return extractedData;
    }

    // Extract data and send it to the popup script
    const data = extractTableData();
    chrome.runtime.sendMessage({ action: "extractedData", data: data });
})();
