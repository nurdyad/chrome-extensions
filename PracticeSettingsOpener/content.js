// Content script to extract practice names and IDs
(() => {
    function extractPractices() {
      const practiceList = [];
      
      document.querySelectorAll("a[href*='/admin_panel/practices/']").forEach((link) => {
        const practiceID = link.href.split("/").pop(); // Extract last part of URL as ID
        const practiceName = link.innerText.trim();
        
        if (practiceID && practiceName) {
          practiceList.push({ id: practiceID, name: practiceName });
        }
      });
  
      return practiceList;
    }
  
    // Listen for messages from popup.js
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.action === "getPractices") {
        const practices = extractPractices();
        sendResponse({ practices });
      }
      return true;
    });
  })();
  