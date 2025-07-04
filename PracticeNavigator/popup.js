// This script runs in the context of the floating_window.html popup.

chrome.action.setBadgeText({ text: "Practice" });
chrome.action.setBadgeBackgroundColor({ color: "#00BFFF" });

let currentSelectedOdsCode = null;

// Make statusDisplayEl and statusEl global variables
let statusDisplayEl = null;
let statusEl = null;
let cdbSearchResultEl = null; // New: Global variable for CDB search result display

// Helper to enable/disable contextual buttons
function setContextualButtonsState(enable) {
  document.getElementById('usersBtn').disabled = !enable;
  document.getElementById('preparingBtn').disabled = !enable;
  document.getElementById('rejectedBtn').disabled = !enable;
  document.getElementById('statusBtn').disabled = !enable; // Also disable status button
}

document.addEventListener('DOMContentLoaded', async () => {
  setContextualButtonsState(false);
  // Assign to global variables here
  statusEl = document.getElementById('status');
  statusDisplayEl = document.getElementById('statusDisplay');
  cdbSearchResultEl = document.getElementById('cdbSearchResult'); // New: Assign CDB search result element

  if (statusDisplayEl) { // Defensive check
    statusDisplayEl.style.display = 'none'; // Ensure hidden on load
  }
  if (cdbSearchResultEl) { // Defensive check
    cdbSearchResultEl.style.display = 'none'; // Ensure hidden on load
  }


  // Initial check for cache
  try {
    const response = await chrome.runtime.sendMessage({ action: 'getPracticeCache' });
    if (response && response.practiceCache && Object.keys(response.practiceCache).length > 0) {
      cachedPractices = response.practiceCache;
      console.log(`%c[BL Nav - Popup] Practice suggestions loaded from background. Cache size: ${Object.keys(cachedPractices).length}`, 'color: blue;');
      updateContextualButtonsOnInput();
      showStatus('Practice cache loaded.', 'success');
      // Use global statusEl
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
            updateContextualButtonsOnInput();
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
        showStatus(`Failed to load practices: ${scrapeErr.message}`, 'error');
        console.error(`%c[BL Nav - Popup] Error during active scrape request: ${scrapeErr.message}`, 'color: red;', scrapeErr);
      }
    }
  } catch (error) {
    console.error(`%c[BL Nav - Popup] Error during initial cache load: ${error.message}`, 'color: red;', error);
    showStatus('Failed to load practice data. Check console.', 'error');
  }
});


document.getElementById('practicesBtn').addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://app.betterletter.ai/admin_panel/practices' });
});

document.getElementById('usersBtn').addEventListener('click', () => {
  if (currentSelectedOdsCode) {
    const url = `https://app.betterletter.ai/mailroom/practices/${currentSelectedOdsCode}/users`;
    chrome.tabs.create({ url });
  } else {
    showStatus('Please select a valid practice first to view users.', 'error');
  }
});

document.getElementById('createPracticeBtn').addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://app.betterletter.ai/admin_panel/practices/new' });
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

// --- Status Button Logic ---
document.getElementById('statusBtn').addEventListener('click', async () => {
    // Use global statusDisplayEl
    if (statusDisplayEl) statusDisplayEl.style.display = 'none'; // Hide previous status
    if (cdbSearchResultEl) cdbSearchResultEl.style.display = 'none'; // Hide CDB search results

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
            // Display all requested fields, including ODS Code and CDB
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
    } catch (err) {
        showStatus(`Error fetching status: ${err.message}`, 'error');
        console.error(`%c[BL Nav - Popup] Error fetching status: ${err.message}`, 'color: red;', err);
    }
});
// --- END Status Button Logic ---

// --- NEW: CDB Search Logic ---
document.getElementById('searchCdbBtn').addEventListener('click', async () => {
    const cdbSearchInput = document.getElementById('cdbSearchInput').value.trim();
    if (statusDisplayEl) statusDisplayEl.style.display = 'none'; // Hide previous status
    if (cdbSearchResultEl) cdbSearchResultEl.style.display = 'none'; // Hide previous CDB search results

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
            updateContextualButtonsOnInput();
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


document.getElementById('openSettingsBtn').addEventListener('click', async () => {
  const rawInput = document.getElementById('practiceInput').value.trim();
  // Remove the ODS code in parentheses for the clean input, as the background script will handle ODS resolution.
  const cleanInput = rawInput.replace(/\s*\([A-Z]\d{5}\)\s*$/, '').trim(); 
  const settingType = document.getElementById('settingType').value;
  // Use global statusEl
  if (statusEl) { // Defensive check
    showStatus('Searching for practice...', 'loading');
  }

  if (!cleanInput) {
    showStatus('Please enter a practice name or ODS code', 'error');
    return;
  }


  try {
    const response = await new Promise((resolve) => {
      chrome.runtime.sendMessage({
        action: 'openPractice',
        input: rawInput, // Send rawInput, as getOdsCodeFromName handles parsing "Name (ODS)"
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
});

function showStatus(message, type) {
  // Use global statusEl
  if (statusEl) { // Defensive check
    statusEl.textContent = message;
    statusEl.className = type;
    statusEl.style.display = 'block';
  } else {
    console.warn("Status element not found in DOM when trying to showStatus:", message);
  }
}

const practiceInputEl = document.getElementById('practiceInput');
const suggestionsList = document.getElementById('suggestions');
const cdbSearchInputEl = document.getElementById('cdbSearchInput'); // New: Get CDB search input
const cdbSuggestionsList = document.getElementById('cdbSuggestions'); // New: Get CDB suggestions list

let cachedPractices = {};

async function updateContextualButtonsOnInput() {
  const inputValue = practiceInputEl.value.trim();
  let foundOds = null;

  if (inputValue) {
    for (const [key, data] of Object.entries(cachedPractices)) {
      const dataNameLower = data && data.name ? data.name.toLowerCase().trim() : '';
      const dataOdsLower = data && data.ods ? data.ods.toLowerCase().trim() : '';
      const keyLower = key ? key.toLowerCase().trim() : '';

      // Adopt the more robust matching from background.js
      if (
        dataNameLower === inputValue.toLowerCase() ||
        dataOdsLower === inputValue.toLowerCase() ||
        keyLower === inputValue.toLowerCase() ||
        dataNameLower.includes(inputValue.toLowerCase()) || // Added .includes() for partial name match
        dataOdsLower.includes(inputValue.toLowerCase())    // Added .includes() for partial ODS match
      ) {
        foundOds = data.ods;
        // REMOVED: The aggressive auto-population that was preventing typing.
        // The value is now set explicitly when a suggestion is clicked or via CDB search.
        break;
      }
    }
  }

  if (foundOds) {
    currentSelectedOdsCode = foundOds;
    setContextualButtonsState(true);
  } else {
    currentSelectedOdsCode = null;
    setContextualButtonsState(false);
    // Use global statusDisplayEl
    if (statusDisplayEl) statusDisplayEl.style.display = 'none'; // Hide status display if practice is unselected
    if (cdbSearchResultEl) cdbSearchResultEl.style.display = 'none'; // Hide CDB search results
  }
}

practiceInputEl.addEventListener('input', () => {
  const query = practiceInputEl.value.toLowerCase().trim();
  const cachedPracticeDisplayNames = Object.keys(cachedPractices);

  if (!query || cachedPracticeDisplayNames.length === 0) {
    suggestionsList.style.display = 'none';
    setContextualButtonsState(false);
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
      practiceInputEl.value = name; // This line now explicitly sets the value on click
      suggestionsList.style.display = 'none';
      updateContextualButtonsOnInput();
      // Logic for 'Add New Practice' is not clearly defined in provided files,
      // but keeping the display logic for settingType and openSettingsBtn for completeness.
      if (name.toLowerCase().includes('add new practice')) { // Assuming this is a special suggestion.
        document.getElementById('settingType').style.display = 'none';
        document.getElementById('openSettingsBtn').style.display = 'none';
      } else {
        document.getElementById('settingType').style.display = 'block';
        document.getElementById('openSettingsBtn').style.display = 'inline-block';
      }
    });

    suggestionsList.appendChild(li);
  });

  suggestionsList.style.display = 'block';
  updateContextualButtonsOnInput();
});

document.addEventListener('click', (e) => {
  if (!suggestionsList.contains(e.target) && e.target !== practiceInputEl) {
    suggestionsList.style.display = 'none';
  }
  // NEW: Hide CDB suggestions if clicking outside
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
        practiceInputEl.value = items[currentIndex].textContent; // This line explicitly sets the value on Enter
        suggestionsList.style.display = 'none';
        updateContextualButtonsOnInput();
        practiceInputEl.dispatchEvent(new Event('input')); // Trigger input event to re-evaluate suggestions/buttons
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
    
    if (!query || Object.keys(cachedPractices).length === 0) {
        cdbSuggestionsList.style.display = 'none';
        return;
    }

    const matches = Object.values(cachedPractices)
        .filter(p => p.cdb && p.cdb !== 'N/A' && p.cdb !== 'Error' && p.cdb.toLowerCase().includes(query))
        .map(p => ({
            displayName: `${p.name} (${p.ods}) - ${p.cdb}`,
            ods: p.ods,
            cdb: p.cdb,
            name: p.name
        }))
        .slice(0, 8); // Limit to 8 suggestions

    cdbSuggestionsList.innerHTML = '';
    if (matches.length === 0) {
        cdbSuggestionsList.style.display = 'none';
        return;
    }

    matches.forEach(match => {
        const li = document.createElement('li');
        li.textContent = match.displayName;
        li.addEventListener('click', () => {
            cdbSearchInputEl.value = match.cdb; // Set CDB input to the selected CDB
            practiceInputEl.value = `${match.name} (${match.ods})`; // Also populate main practice input
            currentSelectedOdsCode = match.ods; // Set the current selected ODS
            cdbSuggestionsList.style.display = 'none';
            updateContextualButtonsOnInput(); // Update button states
        });
        cdbSuggestionsList.appendChild(li);
    });

    cdbSuggestionsList.style.display = 'block';
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
                // Simulate click on the highlighted item
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
