// navigator.js - Cleaned for Top-Nav Redesign
import { state, setCurrentSelectedOdsCode } from './state.js';
import { showStatus, showToast } from './utils.js';

// navigator.js - Safety check to prevent duplicate buttons
export function cleanDuplicateButtons() {
    const inputContainer = document.querySelector('.input-with-button');
    if (inputContainer) {
        const resetButtons = inputContainer.querySelectorAll('#resetSettingsBtn');
        // If there is more than one, remove the extra ones
        if (resetButtons.length > 1) {
            for (let i = 1; i < resetButtons.length; i++) {
                resetButtons[i].remove();
            }
        }
    }
}

// --- 1. Normalize Input Helper ---
export function normalizePracticeSelection(input) {
  if (input && typeof input === 'object' && typeof input.ods === 'string') {
    const name = typeof input.name === 'string' ? input.name : '';
    return { name, ods: input.ods, display: `${name} (${input.ods})` };
  }
  if (typeof input === 'string' && state.cachedPractices[input]) {
    const p = state.cachedPractices[input];
    return { name: p.name, ods: p.ods, display: input };
  }

  if (typeof input === 'string') {
    const trimmed = input.trim();
    const fromKey = state.cachedPractices[trimmed];
    if (fromKey) {
      return { name: fromKey.name, ods: fromKey.ods, display: trimmed };
    }

    const byName = Object.values(state.cachedPractices).find(practice =>
      practice?.name?.toLowerCase() === trimmed.toLowerCase()
    );
    if (byName) {
      return {
        name: byName.name,
        ods: byName.ods,
        display: `${byName.name} (${byName.ods})`
      };
    }
  }
  if (typeof input === 'string' && /^[A-Z]\d{5}$/.test(input.trim())) {
    return { name: '', ods: input.trim(), display: input.trim() };
  }
  return null;
}

// --- 2. Main Action: Select a Practice ---
export function setSelectedPractice(practiceLike, { updateInput = true, triggerStatus = true } = {}) {
  const normalized = normalizePracticeSelection(practiceLike);

  if (!normalized) {
    clearSelectedPractice();
    return null;
  }

  setCurrentSelectedOdsCode(normalized.ods);

  if (updateInput) {
      const el = document.getElementById('practiceInput');
      if (el) el.value = normalized.display;
  }

  hidePracticeSuggestions();
  hideCdbSuggestions();

  setNavigatorButtonsState(true);
  if (triggerStatus) displayPracticeStatus();

  return normalized;
}

// --- 3. Clear Selection ---
export function clearSelectedPractice() {
  setCurrentSelectedOdsCode(null);
  setNavigatorButtonsState(false);
  const statusDisplayEl = document.getElementById('statusDisplay');
  if (statusDisplayEl) statusDisplayEl.style.display = 'none';
  hidePracticeSuggestions();
}

export function hidePracticeSuggestions() {
    const listEl = document.getElementById('suggestions');
    if (!listEl) return;
    listEl.style.display = 'none';
    listEl.innerHTML = '';
}

export function hideCdbSuggestions() {
    const listEl = document.getElementById('cdbSuggestions');
    if (!listEl) return;
    listEl.style.display = 'none';
}

// --- 4. Enable/Disable Buttons ---
export function setNavigatorButtonsState(enable) {
    const ids = [
        'usersBtn', 'collectionBtn', 'preparingBtn', 'rejectedBtn', 
        'openEhrSettingsBtn', 'taskRecipientsBtn',
        'docmanJobSelectNav', 'emisJobSelectNav'
    ];
    
    ids.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.disabled = !enable;
    });
}

// --- 5. Guard Clause ---
export function requireSelectedOdsCode() {
  if (typeof state.currentSelectedOdsCode !== 'string' || !/^[A-Z]\d{5}$/.test(state.currentSelectedOdsCode)) {
    throw new Error('No valid practice selected.');
  }
  return state.currentSelectedOdsCode;
}

// --- 6. Fetch Status & Build Display ---
export async function displayPracticeStatus() {
    const statusDisplayEl = document.getElementById('statusDisplay');
    if (!statusDisplayEl || !state.currentSelectedOdsCode) return;

    statusDisplayEl.style.display = 'none';
    showStatus('Fetching practice details...', 'loading');

    try {
        const response = await chrome.runtime.sendMessage({ 
            action: 'getPracticeStatus', 
            odsCode: state.currentSelectedOdsCode 
        });
        
        if (response && response.success && response.status) {
            // Updated HTML to match the high-quality look of your screenshot
            statusDisplayEl.innerHTML = `
                <div class="status-info-box">
                    <div class="info-row"><strong>ODS Code:</strong> <span>${response.status.odsCode || 'N/A'}</span></div>
                    <div class="info-row"><strong>EHR Type:</strong> <span>${response.status.ehrType || 'N/A'}</span></div>
                    <div class="info-row"><strong>Quota:</strong> <span>${response.status.collectionQuota || 'N/A'}</span></div>
                    <div class="info-row"><strong>Collected:</strong> <span>${response.status.collectedToday || 'N/A'}</span></div>
                    <div class="info-row"><strong>Service Level:</strong> <span>${response.status.serviceLevel || 'N/A'}</span></div>
                    <div class="info-row" style="border-bottom: none;"><strong>CDB:</strong> <span>${response.status.practiceCDB || 'N/A'}</span></div>
                </div>
            `;
            statusDisplayEl.style.display = 'block';
            showStatus('Practice details loaded.', 'success');
        } else {
             showStatus('Practice details not found.', 'error');
        }
    } catch (err) {
        showStatus(`Error: ${err.message}`, 'error');
    }
}

// --- 7. Handle Autocomplete ---
export function handleNavigatorInput({ showOnEmpty = false } = {}) {
    const inputEl = document.getElementById('practiceInput');
    const listEl = document.getElementById('suggestions');
    if (!inputEl || !listEl) return;

    const query = inputEl.value.toLowerCase().trim();
    const allNames = Object.keys(state.cachedPractices);

    if (!query && !showOnEmpty) {
        listEl.innerHTML = '';
        listEl.style.display = 'none';
        return;
    }

    // Show all practice names when empty (if explicitly requested), and all filtered matches when typing.
    let matches = !query
        ? allNames
        : allNames.filter(name => name.toLowerCase().includes(query));

    if (matches.length === 0) {
        listEl.style.display = 'none';
        return;
    }

    listEl.innerHTML = '';
    matches.forEach(name => {
        const li = document.createElement('li');
        li.textContent = name;
        li.addEventListener('click', () => {
            setSelectedPractice(state.cachedPractices[name]);
        });
        listEl.appendChild(li);
    });
    listEl.style.display = 'block';
}

// --- 8. CDB Search Logic ---
export function buildCdbIndex() {
    state.cachedCdbIndex = Object.values(state.cachedPractices)
        .filter(p => p.cdb && p.cdb !== 'N/A')
        .map(p => ({
            cdb: p.cdb,
            ods: p.ods,
            name: p.name,
            label: `${p.name} - ${p.cdb}`
        }));
}

// --- 8. CDB Search Logic  ---
export function handleCdbInput() {
    const inputEl = document.getElementById('cdbSearchInput');
    const listEl = document.getElementById('cdbSuggestions');
    if (!inputEl || !listEl) return;

    const query = inputEl.value.trim().toLowerCase();
    const allCdbItems = state.cachedCdbIndex || [];

    // Show all known CDB items; list is scrollable in the panel.
    let matches = !query 
        ? allCdbItems
        : allCdbItems.filter(item => item.cdb.toLowerCase().includes(query));

    if (matches.length === 0) {
        listEl.innerHTML = '';
        listEl.style.display = 'none';
        return;
    }

    listEl.innerHTML = '';

    const countHeader = document.createElement('div');
    countHeader.className = 'suggestion-count';
    countHeader.textContent = `Total Results: ${matches.length} practices shown`;
    listEl.appendChild(countHeader);
    
    matches.forEach(item => {
        const li = document.createElement('li');
        li.textContent = item.label;
        
        // --- FIX: Use mousedown to prevent the list from vanishing ---
        li.addEventListener('mousedown', (e) => {
            e.stopPropagation(); // Stops the global listener from seeing this click
            e.preventDefault(); // This stops the "blur" event from hiding the list
            setSelectedPractice({ name: item.name, ods: item.ods });
            inputEl.value = item.cdb;
            listEl.style.display = 'none';
        });
        listEl.appendChild(li);
    });
    
    listEl.style.display = 'block';
}
