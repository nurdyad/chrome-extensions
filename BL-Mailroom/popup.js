// popup.js

// Global variable to store extracted data
let extractedDataGlobal = [];

// Function to display a temporary message in the popup
function showMessage(message, type = 'success') {
    const messageBox = document.getElementById('messageBox');
    messageBox.textContent = message;
    messageBox.className = `message-box show bg-${type === 'success' ? 'green' : 'red'}-500`;
    setTimeout(() => {
        messageBox.classList.remove('show');
    }, 2000); // Message disappears after 2 seconds
}

// Function to copy text to clipboard using document.execCommand
function copyToClipboard(text) {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed'; // Prevent scrolling to bottom
    textarea.style.left = '-9999px'; // Move out of sight
    document.body.appendChild(textarea);
    textarea.select();
    try {
        const successful = document.execCommand('copy');
        if (successful) {
            showMessage('Copied to clipboard!');
        } else {
            showMessage('Failed to copy. Please try again.', 'error');
        }
    } catch (err) {
        showMessage('Error copying: ' + err, 'error');
    } finally {
        document.body.removeChild(textarea);
    }
}

// Get references to DOM elements
const loadingIndicator = document.getElementById('loading');
const mainContent = document.getElementById('mainContent');
const rowDataSelect = document.getElementById('rowDataSelect');
const dynamicButtonsContainer = document.getElementById('dynamicButtonsContainer');

// Request the content script to run and send data
function requestDataFromContentScript() {
    chrome.runtime.sendMessage({ action: "executeContentScript" }, (response) => {
        if (response && response.success) {
            console.log("Content script execution requested successfully.");
            // Content script will send data back via another message
        } else if (response && response.error) {
            console.error("Failed to execute content script:", response.error);
            loadingIndicator.textContent = `Error: ${response.error}. Ensure you are on the correct page and permissions are set.`;
        } else {
            console.error("No response from background script.");
            loadingIndicator.textContent = "Error: No response from extension. Check permissions and URL.";
        }
    });
}

// Listener for messages from the content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "extractedData") {
        const extractedData = message.data;
        if (extractedData && extractedData.length > 0) {
            extractedDataGlobal = extractedData; // Store data globally
            loadingIndicator.classList.add('hidden'); // Hide loading
            mainContent.classList.remove('hidden'); // Show main content
            populateDropdown(extractedData.slice(0, 10)); // Populate dropdown with first 10 rows
            showMessage('Data loaded successfully!');
        } else {
            loadingIndicator.textContent = "No data found on this page. Make sure the table exists.";
            mainContent.classList.add('hidden'); // Keep main content hidden
            showMessage('No data extracted!', 'error');
        }
        sendResponse({ status: "received" }); // Acknowledge receipt
    }
});

// Function to populate the dropdown with the first N rows
function populateDropdown(data) {
    rowDataSelect.innerHTML = '<option value="">-- Select a patient row --</option>'; // Clear and add default
    data.forEach((rowData, index) => {
        const option = document.createElement('option');
        // Use a unique identifier (like index or originalName) for the option value
        option.value = index; // Store the index of the row in the global data array
        // Display a meaningful summary in the dropdown
        // Using `originalName` for the numeric ID and `documentId` for the long hash
        option.textContent = `Original: ${rowData.originalName} | Patient: ${rowData.patientName} (NHS No: ${rowData.nhsNo})`;
        rowDataSelect.appendChild(option);
    });
}

// Function to create dynamic buttons based on the selected row
function createDynamicButtons(rowData) {
    dynamicButtonsContainer.innerHTML = ''; // Clear previous buttons

    // Define the order and labels for the buttons
    const buttonOrder = [
        'originalName',
        'documentId', // Ensure this is explicitly listed if it's a new field from content.js
        'nhsNo',
        'patientName',
        'practice',
        'reason',
        'rejectedBy',
        'on',
        'status'
    ];

    const columnLabels = {
        originalName: 'Original Name (Numeric ID)', // Clarified label
        documentId: 'Document ID',                   // Added label for Document ID
        nhsNo: 'NHS No.',
        patientName: 'Patient Name',
        practice: 'Practice',
        reason: 'Reason',
        rejectedBy: 'Rejected By',
        on: 'On',
        status: 'Status'
    };

    // Iterate through the defined button order and create a button for each field
    buttonOrder.forEach(key => {
        // Only create a button if the data exists for this key
        if (rowData.hasOwnProperty(key) && rowData[key]) {
            const button = document.createElement('button');
            button.classList.add('copy-button', 'rounded-lg', 'bg-gradient-to-r', 'from-indigo-500', 'to-blue-600', 'hover:from-indigo-600', 'hover:to-blue-700', 'focus:ring-indigo-500', 'shadow-md', 'active:scale-95', 'transform', 'transition-all', 'duration-150', 'ease-in-out');
            button.textContent = `${columnLabels[key] || key}: ${rowData[key]}`;
            button.setAttribute('data-value', rowData[key]); // Store the actual value to copy

            button.addEventListener('click', (event) => {
                const valueToCopy = event.target.getAttribute('data-value');
                copyToClipboard(valueToCopy);
            });
            dynamicButtonsContainer.appendChild(button);
        }
    });
}

// Event listener for dropdown selection change
rowDataSelect.addEventListener('change', (event) => {
    const selectedIndex = event.target.value;
    if (selectedIndex !== "") {
        // Retrieve the full row data from the global array using the index
        const selectedRowData = extractedDataGlobal[parseInt(selectedIndex)];
        if (selectedRowData) {
            createDynamicButtons(selectedRowData);
        } else {
            dynamicButtonsContainer.innerHTML = ''; // Clear buttons if selection is invalid
            console.error("Selected index not found in data.");
        }
    } else {
        dynamicButtonsContainer.innerHTML = ''; // Clear buttons if default option is selected
    }
});

// When the popup loads, request data
document.addEventListener('DOMContentLoaded', requestDataFromContentScript);
