// This script runs in the context of the floating_window.html popup.

chrome.action.setBadgeText({ text: "Nav" }); // Changed default badge text to indicate navigator

let currentSelectedOdsCode = null;

// Global variables for main view elements
let practiceNavigatorView = null;
let emailFormatterView = null;
let passwordManagerView = null; // New global for password manager view

// Global variables for status and CDB display
let statusDisplayEl = null;
let statusEl = null;
let cdbSearchResultEl = null;
let settingTypeEl = null; // Reference to the settingType select element

// Helper to enable/disable contextual buttons
function setContextualButtonsState(enable) {
  document.getElementById('usersBtn').disabled = !enable; // Users button now depends on selected practice again
  document.getElementById('preparingBtn').disabled = !enable;
  document.getElementById('rejectedBtn').disabled = !enable;
}

// Function to switch between views and manage active tab styling
function showView(viewId) {
  practiceNavigatorView.style.display = 'none';
  emailFormatterView.style.display = 'none';
  passwordManagerView.style.display = 'none';

  // Remove active-tab class from all global nav buttons
  const globalNavButtons = document.querySelectorAll('.global-nav-buttons-row .btn');
  globalNavButtons.forEach(button => button.classList.remove('active-tab'));

  // Show the requested view
  if (viewId === 'practiceNavigatorView') {
    practiceNavigatorView.style.display = 'block';
    document.getElementById('navigatorGlobalToggleBtn').classList.add('active-tab');
  } else if (viewId === 'emailFormatterView') {
    emailFormatterView.style.display = 'block';
    document.getElementById('emailFormatterGlobalToggleBtn').classList.add('active-tab');
  } else if (viewId === 'passwordManagerView') {
    passwordManagerView.style.display = 'block';
    document.getElementById('passwordGlobalToggleBtn').classList.add('active-tab');
    // Clear password list and status message when showing the view
    document.getElementById("password-list").innerHTML = '<li class="no-passwords">Click \'Show Passwords\' to see fields from the active BetterLetter page.</li>';
    document.getElementById("status-message-password").textContent = "";
    triggerPasswordManagerFunctionality();
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  // Assign view containers
  practiceNavigatorView = document.getElementById('practiceNavigatorView');
  emailFormatterView = document.getElementById('emailFormatterView');
  passwordManagerView = document.getElementById('passwordManagerView'); // Assign password manager view
  settingTypeEl = document.getElementById('settingType'); // Assign setting type select element

  // Initially show the main navigator view (and set its tab as active)
  showView('practiceNavigatorView');

  setContextualButtonsState(false);
  // Assign to global variables for status and CDB display
  statusEl = document.getElementById('status');
  statusDisplayEl = document.getElementById('statusDisplay');
  cdbSearchResultEl = document.getElementById('cdbSearchResult');

  if (statusDisplayEl) {
    statusDisplayEl.style.display = 'none';
  }
  if (cdbSearchResultEl) {
    cdbSearchResultEl.style.display = 'none';
  }

  // Initial check for cache
  try {
    const response = await chrome.runtime.sendMessage({ action: 'getPracticeCache' });
    if (response && response.practiceCache && Object.keys(response.practiceCache).length > 0) {
      cachedPractices = response.practiceCache;
      console.log(`%c[BL Nav - Popup] Practice suggestions loaded from background. Cache size: ${Object.keys(cachedPractices).length}`, 'color: blue;');
      updateContextualButtonsOnInput(false);
      showStatus('Practice cache loaded.', 'success');
      
      if (practiceInputEl.value.trim() !== '') {
          const foundPractice = Object.values(cachedPractices).find(p => 
              `${p.name} (${p.ods})`.toLowerCase() === practiceInputEl.value.toLowerCase().trim() ||
              p.ods.toLowerCase() === practiceInputEl.value.toLowerCase().trim()
          );
          if (foundPractice) {
              currentSelectedOdsCode = foundPractice.ods;
              setContextualButtonsState(true);
              displayPracticeStatus();
          } else {
              setContextualButtonsState(false);
          }
      }

      if (statusEl) setTimeout(() => statusEl.style.display = 'none', 1500);
    } else {
      console.log('%c[BL Nav - Popup] Cache empty or not loaded. Requesting active foreground scrape...', 'color: orange;');
      showStatus('Loading practices... Please wait.', 'loading');

      try {
        const scrapeResponse = await new Promise(resolve => {
          chrome.runtime.sendMessage({ action: 'requestActiveScrape' }, resolve);
        });

        if (scrapeResponse && scrapeResponse.success) {
          const newCacheResponse = await chrome.runtime.sendMessage({ action: 'getPracticeCache' });
          if (newCacheResponse && newCacheResponse.practiceCache && Object.keys(newCacheResponse.practiceCache).length > 0) {
            cachedPractices = newCacheResponse.practiceCache;
            console.log(`%c[BL Nav - Popup] Practice suggestions loaded after active scrape. Cache size: ${Object.keys(cachedPractices).length}`, 'color: blue;');
            updateContextualButtonsOnInput(false);
            showStatus('Practices loaded successfully!', 'success');
            if (statusEl) setTimeout(() => statusEl.style.display = 'none', 2000);
          } else {
             showStatus('Practices loaded, but cache still empty.', 'error');
             console.error('%c[BL Nav - Popup] Active scrape reported success but cache still empty.', 'color: red;');
          }
        } else {
          showStatus(`Failed to load practices: ${scrapeResponse?.error || 'Unknown error'}`, 'error');
          console.error(`%c[BL Nav - Popup] Active scrape request failed: ${scrapeResponse?.error}`, 'color: red;');
        }
      } catch (scrapeErr) {
        showStatus(`Error fetching status: ${scrapeErr.message}`, 'error');
        console.error(`%c[BL Nav - Popup] Error during active scrape request: ${scrapeErr.message}`, 'color: red;', scrapeErr);
      }
    }
  } catch (error) {
    console.error(`%c[BL Nav - Popup] Error during initial cache load: ${error.message}`, 'color: red;', error);
    showStatus('Failed to load practice data. Check console.', 'error');
  }

  // Set up event listeners for the Email Formatter elements
  document.getElementById("convertEmailBtn").addEventListener("click", convertEmails);
  document.getElementById("copyEmailBtn").addEventListener("click", copyEmails);
  // Using the new class for back buttons
  document.getElementById("backToNavigatorBtn").addEventListener("click", () => showView('practiceNavigatorView')); 
  document.getElementById("backToNavigatorBtnPassword").addEventListener("click", () => showView('practiceNavigatorView')); // Back button for password manager
  
  // NEW GLOBAL TOGGLE BUTTONS
  document.getElementById("navigatorGlobalToggleBtn").addEventListener("click", () => showView('practiceNavigatorView'));
  document.getElementById("emailFormatterGlobalToggleBtn").addEventListener("click", () => showView('emailFormatterView'));
  document.getElementById("passwordGlobalToggleBtn").addEventListener("click", () => showView('passwordManagerView'));

  // Create Practice button (now located within practiceNavigatorView)
  document.getElementById('createPracticeAdminBtn').addEventListener('click', () => { // Renamed ID
    chrome.tabs.create({ url: 'https://app.betterletter.ai/admin_panel/practices/new' });
  });

  // Password Manager specific buttons (still listen for clicks, but trigger via a unified function)
  document.getElementById("show-passwords").addEventListener("click", showBLPasswords);
  document.getElementById("generate-passwords").addEventListener("click", generateBLPasswords);

  // NEW: Listen for changes on the Setting Type dropdown
  settingTypeEl.addEventListener('change', function() {
    const selectedSettingType = this.value;
    if (currentSelectedOdsCode && selectedSettingType !== "") { // Only navigate if practice selected AND a valid setting type is chosen
      triggerOpenPracticePage(practiceInputEl.value, selectedSettingType);
    } else if (currentSelectedOdsCode && selectedSettingType === "") {
      showStatus('Please select a valid setting type.', 'error');
    } else {
      showStatus('Please select a practice first.', 'error');
    }
  });
});


document.getElementById('practicesBtn').addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://app.betterletter.ai/admin_panel/practices' });
});

// Users button remains as original functionality
document.getElementById('usersBtn').addEventListener('click', () => {
  if (currentSelectedOdsCode) {
    const url = `https://app.betterletter.ai/mailroom/practices/${currentSelectedOdsCode}/users`;
    chrome.tabs.create({ url });
  } else {
    showStatus('Please select a valid practice first to view users.', 'error');
  }
});

document.getElementById('preparingBtn').addEventListener('click', () => {
  if (currentSelectedOdsCode) {
    const url = `https://app.betterletter.ai/mailroom/preparing?only_action_items=true&practice=${currentSelectedOdsCode}&service=self&sort=upload_date&sort_dir=asc&urgent=false`;
    chrome.tabs.create({ url });
  } else {
    showStatus('Please select a valid practice first.', 'error');
  }
});

document.getElementById('rejectedBtn').addEventListener('click', () => {
  if (currentSelectedOdsCode) {
    const url = `https://app.betterletter.ai/mailroom/rejected?practice=${currentSelectedOdsCode}&service=full&show_processed=false&sort=inserted_at&sort_dir=asc`;
    chrome.tabs.create({ url });
  } else {
    showStatus('Please select a valid practice first.', 'error');
  }
});

// --- Status Display Logic (Integrated into selection) ---
async function displayPracticeStatus() {
    if (statusDisplayEl) statusDisplayEl.style.display = 'none';
    if (cdbSearchResultEl) cdbSearchResultEl.style.display = 'none';

    if (!currentSelectedOdsCode) {
        showStatus('Please select a valid practice first to get status.', 'error');
        return;
    }

    showStatus('Fetching status (this might open a temporary window briefly)...', 'loading');

    try {
        const response = await new Promise(resolve => {
            chrome.runtime.sendMessage({ action: 'getPracticeStatus', odsCode: currentSelectedOdsCode }, resolve);
        });

        if (response && response.success && response.status) {
            if (statusDisplayEl) {
                statusDisplayEl.innerHTML = `
                    <strong>ODS Code:</strong> ${response.status.odsCode || 'N/A'}<br>
                    <strong>EHR Type:</strong> ${response.status.ehrType || 'N/A'}<br>
                    <strong>Collection Quota:</strong> ${response.status.collectionQuota || 'N/A'}<br>
                    <strong>Collected Today:</strong> ${response.status.collectedToday || 'N/A'}<br>
                    <strong>Service Level:</strong> ${response.status.serviceLevel || 'N/A'}<br>
                    <strong>Practice CDB:</strong> ${response.status.practiceCDB || 'N/A'}
                `;
                statusDisplayEl.style.display = 'block';
            }
            showStatus('Status fetched successfully!', 'success');
            if (statusEl) setTimeout(() => statusEl.style.display = 'none', 2000);
        } else {
            showStatus(`Failed to get status: ${response?.error || 'No data found'}`, 'error');
            console.error(`%c[BL Nav - Popup] Failed to get status: ${response?.error}`, 'color: red;');
        }
    }
    catch (err) {
        showStatus(`Error fetching status: ${err.message}`, 'error');
        console.error(`%c[BL Nav - Popup] Error fetching status: ${err.message}`, 'color: red;', err);
    }
}
// --- END Status Display Logic ---

// --- NEW: CDB Search Logic ---
document.getElementById('searchCdbBtn').addEventListener('click', async () => {
    const cdbSearchInput = document.getElementById('cdbSearchInput').value.trim();
    if (statusDisplayEl) statusDisplayEl.style.display = 'none';
    if (cdbSearchResultEl) cdbSearchResultEl.style.display = 'none';

    if (!cdbSearchInput) {
        showStatus('Please enter a CDB code to search.', 'error');
        return;
    }

    showStatus('Searching for practice by CDB (this is a heavy operation)...', 'loading');
    if (cdbSearchResultEl) cdbSearchResultEl.innerHTML = '<div class="text-center py-2">Searching... This might take a moment as it checks all practices.</div>';
    if (cdbSearchResultEl) cdbSearchResultEl.style.display = 'block';


    try {
        const response = await new Promise(resolve => {
            chrome.runtime.sendMessage({ action: 'searchCDB', cdb: cdbSearchInput }, resolve);
        });

        if (response && response.success && response.practice) {
            if (cdbSearchResultEl) {
                cdbSearchResultEl.innerHTML = `
                    <strong>Practice Found:</strong><br>
                    <strong>Name:</strong> ${response.practice.name}<br>
                    <strong>ODS:</strong> ${response.practice.ods}<br>
                    <strong>CDB:</strong> ${response.practice.cdb}
                `;
                cdbSearchResultEl.style.display = 'block';
            }
            showStatus('Practice found by CDB!', 'success');
            // Populate main input for convenience
            document.getElementById('practiceInput').value = `${response.practice.name} (${response.practice.ods})`;
            currentSelectedOdsCode = response.practice.ods;
            updateContextualButtonsOnInput(true);
        } else {
            if (cdbSearchResultEl) {
                cdbSearchResultEl.innerHTML = `<strong class="text-red-500">Error:</strong> ${response?.error || 'Practice not found for this CDB.'}`;
                cdbSearchResultEl.style.display = 'block';
            }
            showStatus(`Search failed: ${response?.error || 'Practice not found.'}`, 'error');
            console.error(`%c[BL Nav - Popup] CDB Search failed: ${response?.error}`, 'color: red;');
        }
    } catch (err) {
        showStatus(`Error during CDB search: ${err.message}`, 'error');
        console.error(`%c[BL Nav - Popup] Error during CDB search: ${err.message}`, 'color: red;', err);
    }
});
// --- END NEW: CDB Search Logic ---


// Removed document.getElementById('openSettingsBtn').addEventListener('click', ...);

/**
 * Helper function to trigger the openPractice action.
 * @param {string} rawInput - The raw input from the practice search field.
 * @param {string} settingType - The selected setting type from the dropdown.
 */
async function triggerOpenPracticePage(rawInput, settingType) {
    if (statusEl) {
        showStatus('Opening settings...', 'loading');
    }

    if (!rawInput) {
        showStatus('Practice name or ODS code is missing.', 'error');
        return;
    }

    try {
        const response = await new Promise((resolve) => {
            chrome.runtime.sendMessage({
                action: 'openPractice',
                input: rawInput,
                settingType
            }, resolve);
        });

        if (response && response.error) {
            showStatus(`Error: ${response.error}`, 'error');
        } else {
            showStatus('Settings opened successfully!', 'success');
            if (statusEl) setTimeout(() => statusEl.style.display = 'none', 2000);
        }
    } catch (err) {
        showStatus(`Error: ${err.message}`, 'error');
    }
}


function showStatus(message, type) {
  if (statusEl) {
    statusEl.textContent = message;
    statusEl.className = type;
    statusEl.style.display = 'block';
  } else {
    console.warn("Status element not found in DOM when trying to showStatus:", message);
  }
}

const practiceInputEl = document.getElementById('practiceInput');
const suggestionsList = document.getElementById('suggestions');
const cdbSearchInputEl = document.getElementById('cdbSearchInput');
const cdbSuggestionsList = document.getElementById('cdbSuggestions');

let cachedPractices = {};

async function updateContextualButtonsOnInput(triggerStatus = true) {
  const inputValue = practiceInputEl.value.trim();
  let foundOds = null;

  if (inputValue) {
    for (const [key, data] of Object.entries(cachedPractices)) {
      const dataNameLower = data && data.name ? data.name.toLowerCase().trim() : '';
      const dataOdsLower = data && data.ods ? data.ods.toLowerCase().trim() : '';
      const keyLower = key ? key.toLowerCase().trim() : '';

      if (
        dataNameLower === inputValue.toLowerCase() || 
        dataOdsLower === inputValue.toLowerCase() || 
        keyLower === inputValue.toLowerCase() ||
        (dataNameLower.includes(inputValue.toLowerCase()) && inputValue.length >= 3) || // Only partial match if significant input
        (dataOdsLower.includes(inputValue.toLowerCase()) && inputValue.length >= 3)    // Only partial match if significant input
      ) {
        foundOds = data.ods;
        break;
      }
    }
  }

  if (foundOds) {
    currentSelectedOdsCode = foundOds;
    setContextualButtonsState(true);
    if (triggerStatus) {
        displayPracticeStatus();
    }
  } else {
    currentSelectedOdsCode = null;
    setContextualButtonsState(false);
    if (statusDisplayEl) statusDisplayEl.style.display = 'none';
    if (cdbSearchResultEl) cdbSearchResultEl.style.display = 'none';
  }
}

practiceInputEl.addEventListener('input', () => {
  const query = practiceInputEl.value.toLowerCase().trim();
  const cachedPracticeDisplayNames = Object.keys(cachedPractices);

  if (!query) {
    const practicesToShow = cachedPracticeDisplayNames;
    
    suggestionsList.innerHTML = '';
    practicesToShow.forEach(name => {
      const li = document.createElement('li');
      li.textContent = name;
      li.addEventListener('click', () => {
        practiceInputEl.value = name;
        suggestionsList.style.display = 'none';
        updateContextualButtonsOnInput(true);

        // Trigger openPracticePage when a suggestion is clicked and a practice is selected,
        // but only if a valid setting type is already selected (not the blank default).
        if (currentSelectedOdsCode && settingTypeEl.value !== "") {
            triggerOpenPracticePage(practiceInputEl.value, settingTypeEl.value);
        }
      });
      suggestionsList.appendChild(li);
    });
    suggestionsList.style.display = 'block';
    updateContextualButtonsOnInput(false);
    return;
  }

  const matches = cachedPracticeDisplayNames
    .filter(name => name.toLowerCase().includes(query))
    .slice(0, 8);

  suggestionsList.innerHTML = '';
  if (matches.length === 0) {
    suggestionsList.style.display = 'none';
    setContextualButtonsState(false);
    return;
  }

  matches.forEach(name => {
    const li = document.createElement('li');
    li.textContent = name;

    li.addEventListener('click', () => {
      practiceInputEl.value = name;
      suggestionsList.style.display = 'none';
      updateContextualButtonsOnInput(true);

      // Trigger openPracticePage when a suggestion is clicked and a practice is selected,
      // but only if a valid setting type is already selected (not the blank default).
      if (currentSelectedOdsCode && settingTypeEl.value !== "") {
          triggerOpenPracticePage(practiceInputEl.value, settingTypeEl.value);
      }
    });

    suggestionsList.appendChild(li);
  });

  suggestionsList.style.display = 'block';
  updateContextualButtonsOnInput(false);
});

practiceInputEl.addEventListener('focus', () => {
    if (practiceInputEl.value.trim() === '') {
        practiceInputEl.dispatchEvent(new Event('input'));
    }
});


document.addEventListener('click', (e) => {
  if (!suggestionsList.contains(e.target) && e.target !== practiceInputEl) {
    suggestionsList.style.display = 'none';
  }
  if (!cdbSuggestionsList.contains(e.target) && e.target !== cdbSearchInputEl) {
    cdbSuggestionsList.style.display = 'none';
  }
});

practiceInputEl.addEventListener('keydown', (e) => {
  const items = suggestionsList.querySelectorAll('li');
  if (items.length === 0 || suggestionsList.style.display === 'none') return;

  let currentIndex = -1;
  items.forEach((item, i) => {
      if (item.classList.contains('highlighted')) {
          currentIndex = i;
          item.classList.remove('highlighted');
      }
  });

  switch (e.key) {
    case 'ArrowDown':
      e.preventDefault();
      currentIndex = (currentIndex + 1) % items.length;
      break;
    case 'ArrowUp':
      e.preventDefault();
      currentIndex = (currentIndex - 1 + items.length) % items.length;
      break;
    case 'Enter':
      e.preventDefault();
      if (currentIndex >= 0 && items[currentIndex]) {
        items[currentIndex].click();
      }
      return;
    case 'Escape':
      e.preventDefault();
      suggestionsList.style.display = 'none';
      return;
    default:
      return;
  }

  if (currentIndex >= 0 && items[currentIndex]) {
      items[currentIndex].classList.add('highlighted');
      items[currentIndex].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
});


// --- NEW: CDB Auto-suggestion Logic ---
cdbSearchInputEl.addEventListener('input', () => {
    const query = cdbSearchInputEl.value.toLowerCase().trim();
    
    const practicesWithValidCDB = Object.values(cachedPractices).filter(p => p.cdb && p.cdb !== 'N/A' && p.cdb !== 'Error');

    const matches = query
        ? practicesWithValidCDB.filter(p => p.cdb.toLowerCase().includes(query))
        : practicesWithValidCDB;

    const displayMatches = matches
        .map(p => ({
            displayName: `${p.name} (${p.ods}) - ${p.cdb}`,
            ods: p.ods,
            cdb: p.cdb,
            name: p.name
        }))
        .slice(0, 8);

    cdbSuggestionsList.innerHTML = '';
    if (displayMatches.length === 0) {
        cdbSuggestionsList.style.display = 'none';
        return;
    }

    displayMatches.forEach(match => {
        const li = document.createElement('li');
        li.textContent = match.displayName;
        li.addEventListener('click', () => {
            cdbSearchInputEl.value = match.cdb;
            practiceInputEl.value = `${match.name} (${match.ods})`;
            currentSelectedOdsCode = match.ods;
            cdbSuggestionsList.style.display = 'none';
            updateContextualButtonsOnInput(true);
        });
        cdbSuggestionsList.appendChild(li);
    });

    cdbSuggestionsList.style.display = 'block';
});

cdbSearchInputEl.addEventListener('focus', () => {
    if (cdbSearchInputEl.value.trim() === '') {
        cdbSearchInputEl.dispatchEvent(new Event('input'));
    }
});


cdbSearchInputEl.addEventListener('keydown', (e) => {
    const items = cdbSuggestionsList.querySelectorAll('li');
    if (items.length === 0 || cdbSuggestionsList.style.display === 'none') return;

    let currentIndex = -1;
    items.forEach((item, i) => {
        if (item.classList.contains('highlighted')) {
            currentIndex = i;
            item.classList.remove('highlighted');
        }
    });

  switch (e.key) {
    case 'ArrowDown':
      e.preventDefault();
      currentIndex = (currentIndex + 1) % items.length;
      break;
    case 'ArrowUp':
      e.preventDefault();
      currentIndex = (currentIndex - 1 + items.length) % items.length;
      break;
    case 'Enter':
      e.preventDefault();
      if (currentIndex >= 0 && items[currentIndex]) {
        items[currentIndex].click();
      }
      return;
    case 'Escape':
      e.preventDefault();
      cdbSuggestionsList.style.display = 'none';
      return;
    default:
      return;
  }

  if (currentIndex >= 0 && items[currentIndex]) {
      items[currentIndex].classList.add('highlighted');
      items[currentIndex].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
});

// --- END NEW: CDB Auto-suggestion Logic ---

// --- Email Formatter Logic (Copied from provided popup.js) ---
function extractNameFromEmail(email) {
    const localPart = email.split("@")[0];
    const cleaned = localPart.replace(/[._]/g, " ");
    
    return cleaned
      .split(" ")
      .map(w => {
        const word = w.replace(/\d+/g, '');
        return word.charAt(0).toUpperCase() + word.slice(1);
      })
      .join(" ")
      .trim();
}  

function convertEmails() {
    const input = document.getElementById("inputEmailFormatter").value;
  
    const rawEntries = input
      .split(/[\n;,]+/)
      .map(entry => entry.trim())
      .filter(entry => entry.length > 0);
  
    const parsedList = rawEntries.map(entry => {
      const match = entry.match(/<?([\w.-]+@[\w.-]+\.\w+)>?/);
      if (match) {
        const email = match[1].trim();
        const name = extractNameFromEmail(email);
        return `${name} <${email}>`;
      } else {
        return entry;
      }
    });
  
    document.getElementById("outputEmailFormatter").value = parsedList.join(",\n");
}

function copyEmails() {
    const output = document.getElementById("outputEmailFormatter");
    output.select();
    document.execCommand("copy");
}
// --- END Email Formatter Logic ---

// --- Password Manager Logic (Adapted from provided popup.js) ---

// This function attempts to inject content.js and then show passwords
async function triggerPasswordManagerFunctionality() {
  console.log(`%c[BL Nav - Password] Triggering Password Manager Functionality.`, 'color: #1E90FF;');
  const passwordListEl = document.getElementById("password-list");
  passwordListEl.innerHTML = '<li class="no-passwords">Attempting to connect to the page...</li>';
  showPasswordStatus("Attempting to connect...", "loading");

  try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

      console.log(`%c[BL Nav - Password] Active tab URL: ${tab ? tab.url : 'N/A'}`, 'color: gray;');

      if (!tab || !tab.url || !tab.url.includes("app.betterletter.ai/admin_panel/practices/")) {
          showPasswordError("Please open a BetterLetter Mailroom practice settings page first.");
          return;
      }

      // First, try to execute the content script. This serves as a manual injection attempt.
      // If content.js is already running, this will effectively do nothing (or re-run it depending on logic).
      try {
          await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              files: ['content.js'] // Path to your content.js file
          });
          console.log(`%c[BL Nav - Password] Manual content.js injection successful.`, 'color: green;');
      } catch (injectionError) {
          console.error(`%c[BL Nav - Password] Manual content.js injection failed: ${injectionError.message}`, 'color: red;', injectionError);
          showPasswordError("Failed to inject password tools into the page. Ensure page is fully loaded and try refreshing.");
          return;
      }

      // Now that content.js should be running, try to get passwords
      await showBLPasswords();

  } catch (error) {
      console.error(`%c[BL Nav - Password] Error in triggerPasswordManagerFunctionality: ${error.message}`, 'color: red;', error);
      showPasswordError("An unexpected error occurred during setup. Check console for details.");
  }
}

async function showBLPasswords() {
  try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

      // The URL check is repeated here as a fallback, though triggerPasswordManagerFunctionality also checks.
      if (!tab || !tab.url || !tab.url.includes("app.betterletter.ai/admin_panel/practices/")) {
          showPasswordError("Please open a BetterLetter Mailroom practice settings page first.");
          return;
      }

      const list = document.getElementById("password-list");
      list.innerHTML = ""; // Clear previous list
      showPasswordStatus("Loading passwords...", "loading"); // Update status just before message send

      let response;
      try {
        // Attempt to send message to content script
        // Add a timeout to sendMessage to catch unresponsive content scripts
        response = await chrome.tabs.sendMessage(tab.id, { action: "getPasswords" });
      } catch (e) {
        showPasswordError("Could not communicate with password tools on this page. Try refreshing the BetterLetter page.");
        console.error(`%c[BL Nav - Password] Error during sendMessage (getPasswords): ${e.message}`, 'color: red;', e);
        return;
      }

      if (!response || !Array.isArray(response.passwords) || response.passwords.length === 0) {
          showPasswordError("No password fields found on this page.");
          return;
      }

      response.passwords.forEach((pwData, i) => {
          const li = document.createElement("li");
          li.innerHTML = `
              <span class="pw-label">${pwData.id || `Field ${i+1}`}:</span>
              <code class="pw-value">${pwData.value || "<em>(empty)</em>"}</code>
          `;
          list.appendChild(li);
      });
      showPasswordStatus("Passwords loaded successfully!", "success");

  } catch (error) {
      console.error(`%c[BL Nav - Password] Error in showBLPasswords: ${error.message}`, 'color: red;', error);
      showPasswordError("An unexpected error occurred while displaying passwords.");
  }
}

async function generateBLPasswords() {
  try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

      if (!tab || !tab.url || !tab.url.includes("app.betterletter.ai/admin_panel/practices/")) {
          showPasswordError("Please open a BetterLetter Mailroom practice settings page first to generate passwords.");
          return;
      }

      showPasswordStatus("Generating passwords...", "loading");
      
      let response;
      try {
        response = await chrome.tabs.sendMessage(tab.id, { action: "generatePasswords" });
      } catch (e) {
        showPasswordError("Could not communicate with password tools on this page. Try refreshing the BetterLetter page.");
        console.error(`%c[BL Nav - Password] Error during sendMessage (generatePasswords): ${e.message}`, 'color: red;', e);
        return;
      }

      if (response && response.status === "done") {
        showPasswordStatus("✓ Passwords generated!", "success");
        // Optionally, refresh the displayed list after generation
        showBLPasswords(); // Re-show passwords after generation
      } else {
        showPasswordStatus("⚠️ Failed to generate passwords.", "error");
      }

  } catch (error) {
      console.error(`%c[BL Nav - Password] Error generating passwords: ${error.message}`, 'color: red;', error);
      showPasswordStatus("⚠️ Failed to generate passwords.", "error");
  }
}

// Helper functions for Password Manager UI
function showPasswordError(message) {
  const list = document.getElementById("password-list");
  list.innerHTML = `
      <li class="error-message-password">${message}</li>
  `;
  document.getElementById("status-message-password").textContent = ""; // Clear status message
}

function showPasswordStatus(message, type) {
  const status = document.getElementById("status-message-password");
  status.textContent = message;
  status.style.color = type === "success" ? "#28a745" : (type === "error" ? "#dc3545" : "#0d6efd"); // blue for loading

  if (type !== "loading") { // Only clear if not a persistent loading message
    setTimeout(() => {
        status.textContent = "";
        status.style.color = ""; // Reset color
    }, 3000); // Increased timeout for visibility
  }
}
// --- END Password Manager Logic ---