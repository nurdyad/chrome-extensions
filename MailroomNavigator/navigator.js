// navigator.js - Cleaned for Top-Nav Redesign
import { state, setCurrentSelectedOdsCode } from './state.js';
import { showStatus } from './utils.js';

const ALL_PRACTICES_CODE = 'ALL';
const ALL_PRACTICES_LABEL = 'All practices';
const LIVE_COUNT_KEYS = ['preparing', 'edit', 'review', 'coding', 'rejected'];
const statusFetchInFlightByOds = new Map();
const lastKnownLiveCountsByOds = new Map();

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
  if (input && typeof input === 'object' && String(input.ods || '').toUpperCase() === ALL_PRACTICES_CODE) {
    return { name: ALL_PRACTICES_LABEL, ods: ALL_PRACTICES_CODE, display: ALL_PRACTICES_LABEL };
  }
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
    if (trimmed.toLowerCase() === ALL_PRACTICES_LABEL.toLowerCase()) {
      return { name: ALL_PRACTICES_LABEL, ods: ALL_PRACTICES_CODE, display: ALL_PRACTICES_LABEL };
    }

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
  const hasConcretePractice = /^[A-Z]\d{5}$/.test(String(normalized.ods || '').toUpperCase());

  if (updateInput) {
      const el = document.getElementById('practiceInput');
      if (el) el.value = normalized.display;
  }

  hidePracticeSuggestions();
  hideCdbSuggestions();

  setNavigatorButtonsState(hasConcretePractice);
  if (triggerStatus) {
    if (hasConcretePractice) {
      displayPracticeStatus({ keepExisting: true, preferCached: true, silent: false });
    } else {
      const statusDisplayEl = document.getElementById('statusDisplay');
      if (statusDisplayEl) statusDisplayEl.style.display = 'none';
      const statusEl = document.getElementById('status');
      if (statusEl) statusEl.style.display = 'none';
    }
  }

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
        'openEhrSettingsBtn', 'taskRecipientsBtn'
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

function formatCount(value) {
    if (value === null || value === undefined || value === '') return 'N/A';
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 'N/A';
}

function normalizeLiveCounts(rawCounts) {
    return rawCounts && typeof rawCounts === 'object' ? rawCounts : {};
}

function createEmptyLiveCounts() {
    return {
        preparing: null,
        edit: null,
        review: null,
        coding: null,
        rejected: null
    };
}

function parseCountNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function hasMissingLiveCounts(counts) {
    return LIVE_COUNT_KEYS.some((key) => parseCountNumber(counts?.[key]) === null);
}

function readDisplayedLiveCounts() {
    const counts = {};
    LIVE_COUNT_KEYS.forEach((key) => {
        const el = document.querySelector(`#statusDisplay [data-live-count="${key}"]`);
        if (!el) {
            counts[key] = null;
            return;
        }
        const parsed = Number.parseInt(String(el.textContent || '').trim(), 10);
        counts[key] = Number.isFinite(parsed) ? parsed : null;
    });
    return counts;
}

function mergeDisplayCounts(incomingCounts, fallbackCounts) {
    const merged = { ...incomingCounts };
    LIVE_COUNT_KEYS.forEach((key) => {
        const incomingValue = parseCountNumber(incomingCounts?.[key]);
        if (incomingValue !== null) return;
        const fallbackValue = parseCountNumber(fallbackCounts?.[key]);
        merged[key] = fallbackValue;
    });
    return merged;
}

function rememberLiveCountsForOds(odsCode, counts) {
    const normalizedOds = String(odsCode || '').toUpperCase();
    if (!/^[A-Z]\d{5}$/.test(normalizedOds)) return;

    const previous = normalizeLiveCounts(lastKnownLiveCountsByOds.get(normalizedOds));
    const merged = mergeDisplayCounts(normalizeLiveCounts(counts), previous);
    const sanitized = { ...createEmptyLiveCounts() };
    LIVE_COUNT_KEYS.forEach((key) => {
        sanitized[key] = parseCountNumber(merged?.[key]);
    });
    lastKnownLiveCountsByOds.set(normalizedOds, sanitized);
}

function findCachedPracticeByOds(odsCode) {
    const normalizedOds = String(odsCode || '').toUpperCase();
    if (!/^[A-Z]\d{5}$/.test(normalizedOds)) return null;
    const practices = Object.values(state.cachedPractices || {});
    return practices.find((practice) => String(practice?.ods || '').toUpperCase() === normalizedOds) || null;
}

function buildCachedStatusSnapshot(odsCode) {
    const cached = findCachedPracticeByOds(odsCode);
    if (!cached) return null;
    return {
        ...cached,
        odsCode: cached.ods || String(odsCode || '').toUpperCase(),
        practiceCDB: cached.cdb || cached.practiceCDB || 'N/A'
    };
}

function buildPracticeStatusHtml(status, counts) {
    return `
        <div class="status-info-box" data-status-ods="${status.odsCode || ''}">
            <div class="info-row"><strong>ODS Code:</strong> <span>${status.odsCode || 'N/A'}</span></div>
            <div class="info-row"><strong>EHR Type:</strong> <span>${status.ehrType || 'N/A'}</span></div>
            <div class="info-row"><strong>Quota:</strong> <span>${status.collectionQuota || 'N/A'}</span></div>
            <div class="info-row"><strong>Collected:</strong> <span>${status.collectedToday || 'N/A'}</span></div>
            <div class="info-row"><strong>Service Level:</strong> <span>${status.serviceLevel || 'N/A'}</span></div>
            <div class="info-row"><strong>CDB:</strong> <span>${status.practiceCDB || 'N/A'}</span></div>
            <div class="info-row"><strong>Preparing:</strong> <span data-live-count="preparing">${formatCount(counts.preparing)}</span></div>
            <div class="info-row"><strong>Edit:</strong> <span data-live-count="edit">${formatCount(counts.edit)}</span></div>
            <div class="info-row"><strong>Review:</strong> <span data-live-count="review">${formatCount(counts.review)}</span></div>
            <div class="info-row"><strong>Coding:</strong> <span data-live-count="coding">${formatCount(counts.coding)}</span></div>
            <div class="info-row" style="border-bottom: none;"><strong>Rejected:</strong> <span data-live-count="rejected">${formatCount(counts.rejected)}</span></div>
        </div>
    `;
}

function applyLiveCountsToStatusDisplay(counts) {
    LIVE_COUNT_KEYS.forEach((key) => {
        const el = document.querySelector(`#statusDisplay [data-live-count="${key}"]`);
        if (!el) return;
        el.textContent = formatCount(counts?.[key]);
    });
    const displayedOds = String(
        document.querySelector('#statusDisplay .status-info-box')?.getAttribute('data-status-ods') || ''
    ).toUpperCase();
    if (displayedOds) {
        rememberLiveCountsForOds(displayedOds, counts);
    }
}

async function refreshLiveCountsForSelection(odsCode) {
    try {
        const response = await chrome.runtime.sendMessage({
            action: 'getPracticeLiveCounts',
            odsCode
        });

        const normalizedOds = String(odsCode || '').toUpperCase();
        const stillCurrentSelection = String(state.currentSelectedOdsCode || '').toUpperCase() === normalizedOds;
        const displayedOds = String(
            document.querySelector('#statusDisplay .status-info-box')?.getAttribute('data-status-ods') || ''
        ).toUpperCase();
        if (!stillCurrentSelection || displayedOds !== normalizedOds) return;
        if (!response?.success) return;

        const counts = normalizeLiveCounts(response.liveMailroomCounts);
        applyLiveCountsToStatusDisplay(counts);
        rememberLiveCountsForOds(normalizedOds, counts);
    } catch (e) {
        // Keep existing values if background live-count refresh fails.
    }
}

// --- 6. Fetch Status & Build Display ---
export async function displayPracticeStatus(options = {}) {
    const keepExisting = options?.keepExisting !== false;
    const preferCached = options?.preferCached !== false;
    const silent = options?.silent === true;
    const statusDisplayEl = document.getElementById('statusDisplay');
    const selectedOds = String(state.currentSelectedOdsCode || '').toUpperCase();
    if (!statusDisplayEl || !/^[A-Z]\d{5}$/.test(selectedOds)) return;
    const displayedOdsBeforeFetch = String(
        document.querySelector('#statusDisplay .status-info-box')?.getAttribute('data-status-ods') || ''
    ).toUpperCase();
    const hasVisibleStatusCard = Boolean(document.querySelector('#statusDisplay .status-info-box'));

    if (preferCached) {
        const cachedStatus = buildCachedStatusSnapshot(selectedOds);
        if (cachedStatus) {
            const fallbackCounts = displayedOdsBeforeFetch === selectedOds
                ? readDisplayedLiveCounts()
                : normalizeLiveCounts(lastKnownLiveCountsByOds.get(selectedOds));
            const immediateCounts = mergeDisplayCounts(
                normalizeLiveCounts(lastKnownLiveCountsByOds.get(selectedOds)),
                fallbackCounts
            );
            statusDisplayEl.innerHTML = buildPracticeStatusHtml(cachedStatus, immediateCounts);
            statusDisplayEl.style.display = 'block';
        } else if (!keepExisting) {
            statusDisplayEl.style.display = 'none';
        }
    } else if (!keepExisting) {
        statusDisplayEl.style.display = 'none';
    }

    const existingInFlight = statusFetchInFlightByOds.get(selectedOds);
    if (!silent && !existingInFlight) {
        showStatus(hasVisibleStatusCard ? 'Refreshing practice details...' : 'Fetching practice details...', 'loading');
    }

    try {
        const statusPromise = existingInFlight || chrome.runtime.sendMessage({
            action: 'getPracticeStatus',
            odsCode: selectedOds
        });
        if (!existingInFlight) {
            statusFetchInFlightByOds.set(selectedOds, statusPromise);
        }

        const response = await statusPromise;
        if (statusFetchInFlightByOds.get(selectedOds) === statusPromise) {
            statusFetchInFlightByOds.delete(selectedOds);
        }
        
        const stillCurrentSelection = String(state.currentSelectedOdsCode || '').toUpperCase() === selectedOds;
        if (!stillCurrentSelection) return;

        if (response && response.success && response.status) {
            const counts = normalizeLiveCounts(response.status.liveMailroomCounts);
            const displayedOds = String(
                document.querySelector('#statusDisplay .status-info-box')?.getAttribute('data-status-ods') || ''
            ).toUpperCase();
            const countsForRender = displayedOds === selectedOds
                ? mergeDisplayCounts(counts, readDisplayedLiveCounts())
                : mergeDisplayCounts(counts, normalizeLiveCounts(lastKnownLiveCountsByOds.get(selectedOds)));

            statusDisplayEl.innerHTML = buildPracticeStatusHtml(response.status, countsForRender);
            statusDisplayEl.style.display = 'block';
            rememberLiveCountsForOds(selectedOds, countsForRender);
            if (!silent) {
                showStatus('Practice details loaded.', 'success');
            }

            // Fetch fresh live counts asynchronously so basic status renders immediately.
            if (hasMissingLiveCounts(counts)) {
                refreshLiveCountsForSelection(selectedOds).catch(() => undefined);
            }
        } else {
             if (!silent) showStatus('Practice details not found.', 'error');
        }
    } catch (err) {
        statusFetchInFlightByOds.delete(selectedOds);
        if (!silent) showStatus(`Error: ${err.message}`, 'error');
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

    const shouldShowAllPractices = !query || ALL_PRACTICES_LABEL.toLowerCase().includes(query);

    if (matches.length === 0 && !shouldShowAllPractices) {
        listEl.style.display = 'none';
        return;
    }

    listEl.innerHTML = '';

    if (shouldShowAllPractices) {
        const allLi = document.createElement('li');
        allLi.textContent = `${ALL_PRACTICES_LABEL} (no practice filter)`;
        allLi.className = 'all-practices-option';
        allLi.addEventListener('mousedown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            setSelectedPractice({ name: ALL_PRACTICES_LABEL, ods: ALL_PRACTICES_CODE, display: ALL_PRACTICES_LABEL });
        });
        listEl.appendChild(allLi);
    }

    matches.forEach(name => {
        const li = document.createElement('li');
        li.textContent = name;
        li.addEventListener('mousedown', (e) => {
            e.preventDefault();
            e.stopPropagation();
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
