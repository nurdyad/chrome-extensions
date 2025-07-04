// Content script to navigate between settings
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "navigateToSetting" && message.setting) {
      const settingIdMap = {
        "basic": "tab-basic",
        "service": "tab-service",
        "workflows": "tab-workflows",
        "ehr": "tab-ehr_settings"
      };
  
      const settingTab = document.querySelector(`[data-test-id='${settingIdMap[message.setting]}']`);
      
      if (settingTab) {
        settingTab.click(); // Simulate click event
        sendResponse({ success: true, message: `Clicked on ${message.setting}` });
      } else {
        sendResponse({ success: false, message: "Tab not found!" });
      }
    }
  });
  