/**************************************
 *         TAB TIMEOUT SYSTEM         *
 **************************************/
let previousActiveTabId = null;

// Initialize storage
chrome.runtime.onInstalled.addListener(async () => {
  await chrome.storage.local.set({ practiceTabs: [] });
});

// Track tab switches
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  const { practiceTabs = [] } = await chrome.storage.local.get('practiceTabs');
  const newTabId = activeInfo.tabId;

  if (previousActiveTabId && practiceTabs.includes(previousActiveTabId)) {
    chrome.alarms.create(`closeTab-${previousActiveTabId}`, { 
      delayInMinutes: 1 
    });
  }

  if (practiceTabs.includes(newTabId)) {
    await chrome.alarms.clear(`closeTab-${newTabId}`);
  }

  previousActiveTabId = newTabId;
});

// Handle timeout alarms
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (!alarm.name.startsWith('closeTab-')) return;
  
  const tabId = parseInt(alarm.name.split('-')[1], 10);
  
  try {
    await chrome.tabs.remove(tabId);
  } catch {
    console.log('Tab already closed');
  }
  
  // Clean up storage
  const { practiceTabs = [] } = await chrome.storage.local.get('practiceTabs');
  await chrome.storage.local.set({
    practiceTabs: practiceTabs.filter(id => id !== tabId)
  });
});

// Cleanup closed tabs
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { practiceTabs = [] } = await chrome.storage.local.get('practiceTabs');
  if (practiceTabs.includes(tabId)) {
    await chrome.storage.local.set({
      practiceTabs: practiceTabs.filter(id => id !== tabId)
    });
    await chrome.alarms.clear(`closeTab-${tabId}`);
  }
});

/**************************************
 *       CORE FUNCTIONALITY          *
 **************************************/
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "openPractice") {
    handleOpenPractice(message.input, message.settingType)
      .then(() => sendResponse({ status: "success" }))
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }
});

async function handleOpenPractice(input, settingType) {
  const practiceId = await getPracticeIdFromInput(input);
  await openPracticePage(practiceId, settingType);
}

async function getPracticeIdFromInput(input) {
  if (/^\d+$/.test(input)) return input;

  const practiceListUrl = 'https://app.betterletter.ai/admin_panel/practices';
  let practiceListTab = await findExistingTab(practiceListUrl);
  let tabCreated = !practiceListTab;

  if (!practiceListTab) {
    practiceListTab = await chrome.tabs.create({ 
      url: practiceListUrl, 
      active: false 
    });
    await waitForTabLoad(practiceListTab.id);
  }

  const practices = await extractPractices(practiceListTab.id);
  const matched = practices.find(p => 
    p.name.toLowerCase().includes(input.toLowerCase())
  );

  if (tabCreated) await chrome.tabs.remove(practiceListTab.id);
  if (!matched) throw new Error(`Practice "${input}" not found.`);

  return matched.id;
}

async function findExistingTab(url) {
  const tabs = await chrome.tabs.query({ url });
  return tabs[0];
}

async function waitForTabLoad(tabId) {
  return new Promise(resolve => {
    chrome.tabs.onUpdated.addListener(function listener(id, info) {
      if (id === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    });
  });
}

async function extractPractices(tabId) {
  const result = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      return Array.from(document.querySelectorAll('a[href^="/admin_panel/practices/"]'))
        .map(link => ({
          id: link.href.split('/').pop(),
          name: link.textContent.trim()
        }));
    }
  });
  return result[0].result;
}

async function openPracticePage(practiceId, settingType) {
  const practiceUrl = `https://app.betterletter.ai/admin_panel/practices/${practiceId}`;
  const existingTabs = await chrome.tabs.query({ url: `${practiceUrl}*` });
  let practiceTab = existingTabs[0];

  if (!practiceTab) {
    practiceTab = await chrome.tabs.create({ 
      url: practiceUrl, 
      active: true 
    });
  } else {
    await chrome.tabs.update(practiceTab.id, { 
      active: true,
      url: practiceUrl
    });
  }

  // Add to tracked practice tabs
  const { practiceTabs = [] } = await chrome.storage.local.get('practiceTabs');
  if (!practiceTabs.includes(practiceTab.id)) {
    await chrome.storage.local.set({
      practiceTabs: [...practiceTabs, practiceTab.id]
    });
  }

  await waitForTabLoad(practiceTab.id);
  await clickSettingsTab(practiceTab.id, settingType);
}

async function clickSettingsTab(tabId, settingType) {
  const selectorMap = {
    basic: "[data-test-id='tab-basic']",
    service: "[data-test-id='tab-service']",
    workflows: "[data-test-id='tab-workflows']",
    ehr_settings: "[data-test-id='tab-ehr_settings']"
  };
  const selector = selectorMap[settingType];

  await chrome.scripting.executeScript({
    target: { tabId },
    func: (selector) => {
      const waitForElement = (selector, timeout = 15000) => {
        return new Promise((resolve, reject) => {
          const start = Date.now();
          const interval = setInterval(() => {
            const element = document.querySelector(selector);
            if (element) {
              clearInterval(interval);
              element.click();
              resolve();
            } else if (Date.now() - start > timeout) {
              clearInterval(interval);
              reject(new Error(`Element ${selector} not found`));
            }
          }, 500);
        });
      };
      return waitForElement(selector);
    },
    args: [selector]
  });
}