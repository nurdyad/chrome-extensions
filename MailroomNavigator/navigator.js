// navigator.js
import { state, setCurrentSelectedOdsCode } from './state.js';
import { showStatus } from './utils.js';

// --- 1. Normalize Input Helper ---
export function normalizePracticeSelection(input) {
  if (input && typeof input === 'object' && typeof input.ods === 'string') {
    const name = typeof input.name === 'string' ? input.name : '';
    return { name, ods: input.ods, display: `${name} (${input.ods})` };
  }

  if (input && typeof input === 'object' && typeof input.odsCode === 'string') {
    const name = typeof input.practiceName === 'string' ? input.practiceName : '';
    return { name, ods: input.odsCode, display: `${name} (${input.odsCode})` };
  }

  if (typeof input === 'string' && state.cachedPractices[input]) {
    const p = state.cachedPractices[input];
    return { name: p.name, ods: p.ods, display: input };
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

  const list = document.getElementById('suggestions');
  if (list) list.style.display = 'none';

  setNavigatorButtonsState(true);

  if (triggerStatus) displayPracticeStatus();

  return normalized;
}

// --- 3. Clear Selection ---
export function clearSelectedPractice() {
  setCurrentSelectedOdsCode(null);
  setNavigatorButtonsState(false);
}

// --- 4. Enable/Disable Buttons ---
export function setNavigatorButtonsState(enable) {
    // Strictly matching your original logic
    const ids = [
        'usersBtn', 
        'collectionBtn', 
        'preparingBtn', 
        'rejectedBtn', 
        'taskRecipientsBtn', // Included based on your uploaded file
        'docmanJobSelectNav', 
        'emisJobSelectNav'
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

// --- 6. Fetch Status ---
export async function displayPracticeStatus() {
    const statusDisplayEl = document.getElementById('statusDisplay');
    const statusEl = document.getElementById('status');

    if (statusDisplayEl) statusDisplayEl.style.display = 'none';
    if (!state.currentSelectedOdsCode) return;

    showStatus('Fetching status...', 'loading');

    try {
        const response = await chrome.runtime.sendMessage({ action: 'getPracticeStatus', odsCode: state.currentSelectedOdsCode });
        
        if (response && response.success && response.status) {
            statusDisplayEl.innerHTML = `
                <strong>ODS Code:</strong> ${response.status.odsCode || 'N/A'}<br>
                <strong>EHR Type:</strong> ${response.status.ehrType || 'N/A'}<br>
                <strong>Quota:</strong> ${response.status.collectionQuota || 'N/A'}<br>
                <strong>Collected:</strong> ${response.status.collectedToday || 'N/A'}<br>
                <strong>Service Level:</strong> ${response.status.serviceLevel || 'N/A'}<br>
                <strong>CDB:</strong> ${response.status.practiceCDB || 'N/A'}
            `;
            statusDisplayEl.style.display = 'block';
            showStatus('Status fetched!', 'success');
            if (statusEl) setTimeout(() => statusEl.style.display = 'none', 2000);
        } else {
             showStatus('Failed to get status.', 'error');
        }
    } catch (err) {
        showStatus(`Error: ${err.message}`, 'error');
    }
}

// --- 7. Handle Input Typing ---
export function handleNavigatorInput() {
    const inputEl = document.getElementById('practiceInput');
    const listEl = document.getElementById('suggestions');
    if (!inputEl || !listEl) return;

    const query = inputEl.value.toLowerCase().trim();
    const allNames = Object.keys(state.cachedPractices);

    let matches = [];
    if (!query) {
        matches = allNames; 
    } else {
        matches = allNames.filter(name => name.toLowerCase().includes(query)).slice(0, 8);
    }

    if (matches.length === 0) {
        listEl.style.display = 'none';
        return;
    }

    listEl.innerHTML = '';
    matches.forEach(name => {
        const li = document.createElement('li');
        li.textContent = name;
        li.addEventListener('click', () => {
            const practiceObj = state.cachedPractices[name];
            setSelectedPractice(practiceObj, { updateInput: true, triggerStatus: true });
        });
        listEl.appendChild(li);
    });
    listEl.style.display = 'block';
    
    if (!state.currentSelectedOdsCode && !state.cachedPractices[inputEl.value]) {
         setNavigatorButtonsState(false);
    }
}