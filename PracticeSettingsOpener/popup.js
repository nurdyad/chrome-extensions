// Set badge text and color
chrome.action.setBadgeText({ text: "Practice" });
chrome.action.setBadgeBackgroundColor({ color: "#4CAF50" }); // Green badge

document.getElementById('open-practice').addEventListener('click', () => {
    const input = document.getElementById('practice-input').value.trim();
    const settingType = document.getElementById('settings-dropdown').value;
    if (!input) return;
  
    chrome.runtime.sendMessage(
      { action: "openPractice", input, settingType },
      (response) => {
        if (response?.error) alert(response.error);
      }
    );
  });