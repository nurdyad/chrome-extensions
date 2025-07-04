chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  if (message.action === "getMainWindowTabs") {
  
  chrome.tabs.query({ currentWindow: true }, (tabs) => {
  
  sendResponse({ tabs });
  
  });
  
  return true; // Needed for async response
  
  }
  
  });