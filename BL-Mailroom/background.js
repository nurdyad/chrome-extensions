
// Listener for messages from the popup script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Check if the message is a request to execute the content script
    if (message.action === "executeContentScript") {
        // Get the current active tab
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs && tabs.length > 0) {
                const tabId = tabs[0].id;
                // Execute the content script on the current tab
                chrome.scripting.executeScript({
                    target: { tabId: tabId },
                    files: ['content.js']
                }, () => {
                    if (chrome.runtime.lastError) {
                        console.error('Error executing content script:', chrome.runtime.lastError.message);
                        sendResponse({ error: chrome.runtime.lastError.message });
                    } else {
                        console.log('Content script executed on tab:', tabId);
                        sendResponse({ success: true });
                    }
                });
            } else {
                console.error("No active tab found.");
                sendResponse({ error: "No active tab found." });
            }
        });
        // Indicate that sendResponse will be called asynchronously
        return true;
    }
});
