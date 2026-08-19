// Navigator view logic: practice lookup, quick navigation actions, and practice status rendering.
import { state, setCurrentSelectedOdsCode } from './state.js';
import { copyTextToClipboard, hideStatus, showStatus, showToast } from './utils.js';

const ALL_PRACTICES_CODE = 'ALL';
const ALL_PRACTICES_LABEL = 'All practices';
const PANEL_HOST_TAB_ID = (() => {
    try {
        const rawValue = new URLSearchParams(window.location.search).get('hostTabId');
        const parsed = Number.parseInt(String(rawValue || ''), 10);
        return Number.isFinite(parsed) ? parsed : null;
    } catch (error) {
        return null;
    }
})();
const LIVE_COUNT_KEYS = ['preparing', 'edit', 'review', 'coding', 'rejected'];
const RECENT_PRACTICES_STORAGE_KEY = 'mailroomNavigatorRecentPracticesV1';
const RECENT_PRACTICES_LIMIT = 6;
const statusFetchInFlightByOds = new Map();
const lastKnownLiveCountsByOds = new Map();
const lastKnownDetailedStatusByOds = new Map();
const revealedSecretFieldsByOds = new Map();
const lastRenderedStatusSignatureByOds = new Map();
let recentPractices = [];
let recentPracticesLoaded = false;
let recentPracticesLoadPromise = null;
let recentPracticesInteractionsBound = false;
let statusDisplayInteractionsBound = false;
let lastStatusDisplayInteractionAt = 0;
const STATUS_DISPLAY_INTERACTION_COOLDOWN_MS = 15000;

function withPreferredTabId(message = {}) {
    return typeof PANEL_HOST_TAB_ID === 'number'
        ? { ...message, preferredTabId: PANEL_HOST_TAB_ID }
        : { ...message };
}

function rememberStatusDisplayInteraction() {
    lastStatusDisplayInteractionAt = Date.now();
}

export function shouldPauseStatusAutoRefresh() {
    return Date.now() - lastStatusDisplayInteractionAt < STATUS_DISPLAY_INTERACTION_COOLDOWN_MS;
}

function emitPracticeSelectionChanged(detail = {}) {
    document.dispatchEvent(new CustomEvent('mailroomNavigator:practiceSelectionChanged', {
        detail: {
            odsCode: String(detail.odsCode || '').trim().toUpperCase(),
            practiceName: String(detail.practiceName || '').trim(),
            hasConcretePractice: Boolean(detail.hasConcretePractice),
            isAllPractices: Boolean(detail.isAllPractices)
        }
    }));
}

function getSecretFieldKey(secretLabel) {
    return String(secretLabel || '').trim();
}

function isSecretFieldVisible(odsCode, secretLabel) {
    const normalizedOds = String(odsCode || '').toUpperCase();
    const key = getSecretFieldKey(secretLabel);
    if (!normalizedOds || !key) return false;
    return Boolean(revealedSecretFieldsByOds.get(normalizedOds)?.has(key));
}

function setSecretFieldVisibility(odsCode, secretLabel, isVisible) {
    const normalizedOds = String(odsCode || '').toUpperCase();
    const key = getSecretFieldKey(secretLabel);
    if (!normalizedOds || !key) return;

    const next = new Set(revealedSecretFieldsByOds.get(normalizedOds) || []);
    if (isVisible) next.add(key);
    else next.delete(key);

    if (next.size > 0) {
        revealedSecretFieldsByOds.set(normalizedOds, next);
    } else {
        revealedSecretFieldsByOds.delete(normalizedOds);
    }
}

function buildStatusDetailSignature(status) {
    return JSON.stringify({
        odsCode: String(status?.odsCode || '').trim().toUpperCase(),
        practiceCDB: String(status?.practiceCDB || '').trim(),
        ehrType: String(status?.ehrType || '').trim(),
        serviceLevel: String(status?.serviceLevel || '').trim(),
        collectionQuota: String(status?.collectionQuota || '').trim(),
        collectedToday: String(status?.collectedToday || '').trim(),
        emisApiUsername: String(status?.emisApiUsername || '').trim(),
        emisApiPassword: String(status?.emisApiPassword || '').trim(),
        emisApiPasswordPresent: Boolean(status?.emisApiPasswordPresent),
        emisWebUsername: String(status?.emisWebUsername || '').trim(),
        emisWebPassword: String(status?.emisWebPassword || '').trim(),
        emisWebPasswordPresent: Boolean(status?.emisWebPasswordPresent),
        emisWebDummyNhsNumber: String(status?.emisWebDummyNhsNumber || '').trim(),
        docmanUsername: String(status?.docmanUsername || '').trim(),
        docmanPassword: String(status?.docmanPassword || '').trim(),
        docmanPasswordPresent: Boolean(status?.docmanPasswordPresent),
        docmanDummyNhsNumber: String(status?.docmanDummyNhsNumber || '').trim(),
        docmanInputFolder: String(status?.docmanInputFolder || '').trim(),
        docmanProcessingFolder: String(status?.docmanProcessingFolder || '').trim(),
        docmanFilingFolder: String(status?.docmanFilingFolder || '').trim(),
        docmanRejectedFolder: String(status?.docmanRejectedFolder || '').trim()
    });
}

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
    const cdb = String(input.cdb || input.practiceCDB || '').trim();
    return { name, ods: input.ods, cdb, display: `${name} (${input.ods})` };
  }
  if (typeof input === 'string' && state.cachedPractices[input]) {
    const p = state.cachedPractices[input];
    return { name: p.name, ods: p.ods, cdb: p.cdb || p.practiceCDB || '', display: input };
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

    const normalizedQuery = trimmed.toLowerCase();
    const byName = Object.values(state.cachedPractices).find(practice =>
      practice?.name?.toLowerCase() === normalizedQuery
      || String(practice?.ods || '').toLowerCase() === normalizedQuery
      || String(practice?.cdb || practice?.practiceCDB || '').toLowerCase() === normalizedQuery
    );
    if (byName) {
      return {
        name: byName.name,
        ods: byName.ods,
        cdb: byName.cdb || byName.practiceCDB || '',
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
  const isAllPractices = String(normalized.ods || '').toUpperCase() === ALL_PRACTICES_CODE;

  if (updateInput) {
      const el = document.getElementById('practiceInput');
      if (el) el.value = normalized.display;
  }

  hidePracticeSuggestions();

  setNavigatorButtonsState({ hasConcretePractice, isAllPractices });
  if (hasConcretePractice) {
    rememberRecentPractice(normalized);
  }
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

  emitPracticeSelectionChanged({
      odsCode: normalized.ods,
      practiceName: normalized.name,
      hasConcretePractice,
      isAllPractices
  });

  return normalized;
}

// --- 3. Clear Selection ---
export function clearSelectedPractice() {
  setCurrentSelectedOdsCode(null);
  setNavigatorButtonsState({ hasConcretePractice: false, isAllPractices: false });
  const statusDisplayEl = document.getElementById('statusDisplay');
  if (statusDisplayEl) statusDisplayEl.style.display = 'none';
  hidePracticeSuggestions();
  emitPracticeSelectionChanged({
      odsCode: '',
      practiceName: '',
      hasConcretePractice: false,
      isAllPractices: false
  });
}

function getPracticeDisplayName(practice) {
    return String(practice?.name || practice?.practiceName || practice?.displayName || '').trim();
}

function normalizeRecentPractice(practiceLike) {
    const normalized = normalizePracticeSelection(practiceLike);
    const ods = String(normalized?.ods || '').trim().toUpperCase();
    if (!/^[A-Z]\d{5}$/.test(ods)) return null;

    const cached = findCachedPracticeByOds(ods);
    const source = practiceLike && typeof practiceLike === 'object' ? practiceLike : {};
    const name = getPracticeDisplayName(source) || getPracticeDisplayName(cached) || normalized.name || ods;
    const cdb = String(
        source.cdb
        || source.practiceCDB
        || cached?.cdb
        || cached?.practiceCDB
        || normalized.cdb
        || ''
    ).trim();

    return {
        name,
        ods,
        cdb,
        display: `${name} (${ods})`
    };
}

function getStorageLocal() {
    try {
        if (typeof chrome === 'undefined') return null;
        return chrome.storage?.local || null;
    } catch {
        return null;
    }
}

function renderRecentPractices() {
    const sectionEl = document.getElementById('recentPracticesSection');
    const listEl = document.getElementById('recentPracticesList');
    if (!sectionEl || !listEl) return;

    listEl.innerHTML = '';
    const visiblePractices = recentPractices
        .map(normalizeRecentPractice)
        .filter(Boolean)
        .slice(0, RECENT_PRACTICES_LIMIT);

    if (visiblePractices.length === 0) {
        sectionEl.hidden = true;
        return;
    }

    visiblePractices.forEach((practice) => {
        const button = document.createElement('button');
        button.type = 'button';
        const isCurrentPractice = String(state.currentSelectedOdsCode || '').toUpperCase() === practice.ods;
        button.className = `recent-practice-chip${isCurrentPractice ? ' is-current' : ''}`;
        button.setAttribute('data-ods', practice.ods);
        button.title = practice.cdb
            ? `${practice.name} · ODS ${practice.ods} · CDB ${practice.cdb}`
            : `${practice.name} · ODS ${practice.ods}`;
        const metaText = [practice.ods, practice.cdb ? `CDB ${practice.cdb}` : ''].filter(Boolean).join(' · ');
        button.innerHTML = `
            <span class="recent-practice-name">${escapeHtml(practice.name)}</span>
            <span class="recent-practice-meta">${escapeHtml(metaText)}</span>
        `;
        button.addEventListener('click', () => {
            const cachedPractice = findCachedPracticeByOds(practice.ods);
            setSelectedPractice(cachedPractice || practice, { updateInput: true, triggerStatus: true });
        });
        listEl.appendChild(button);
    });

    sectionEl.hidden = false;
}

async function saveRecentPractices() {
    const storage = getStorageLocal();
    if (!storage) return;
    try {
        await storage.set({ [RECENT_PRACTICES_STORAGE_KEY]: recentPractices });
    } catch {
        // Recent-practice memory is a convenience only.
    }
}

async function ensureRecentPracticesLoaded() {
    if (recentPracticesLoaded) return recentPractices;
    if (recentPracticesLoadPromise) return recentPracticesLoadPromise;

    recentPracticesLoadPromise = (async () => {
        const storage = getStorageLocal();
        if (!storage) {
            recentPracticesLoaded = true;
            renderRecentPractices();
            return recentPractices;
        }

        try {
            const result = await storage.get([RECENT_PRACTICES_STORAGE_KEY]);
            const stored = result?.[RECENT_PRACTICES_STORAGE_KEY];
            recentPractices = Array.isArray(stored)
                ? stored.map(normalizeRecentPractice).filter(Boolean).slice(0, RECENT_PRACTICES_LIMIT)
                : [];
        } catch {
            recentPractices = [];
        } finally {
            recentPracticesLoaded = true;
            recentPracticesLoadPromise = null;
            renderRecentPractices();
        }

        return recentPractices;
    })();

    return recentPracticesLoadPromise;
}

function rememberRecentPractice(practiceLike) {
    const selected = normalizeRecentPractice(practiceLike);
    if (!selected) return;

    const update = async () => {
        await ensureRecentPracticesLoaded();
        recentPractices = [
            selected,
            ...recentPractices.filter((practice) => String(practice?.ods || '').toUpperCase() !== selected.ods)
        ].slice(0, RECENT_PRACTICES_LIMIT);
        renderRecentPractices();
        await saveRecentPractices();
    };

    update().catch(() => undefined);
}

export async function initializeRecentPractices() {
    if (!recentPracticesInteractionsBound) {
        document.getElementById('clearRecentPracticesBtn')?.addEventListener('click', async () => {
            recentPractices = [];
            renderRecentPractices();
            await saveRecentPractices();
            showToast('Recent practices cleared.');
        });
        recentPracticesInteractionsBound = true;
    }

    await ensureRecentPracticesLoaded();
}

export function hidePracticeSuggestions() {
    const listEl = document.getElementById('suggestions');
    if (!listEl) return;
    listEl.style.display = 'none';
    listEl.innerHTML = '';
}

// --- 4. Enable/Disable Buttons ---
export function setNavigatorButtonsState(stateOrEnabled) {
    const normalized = typeof stateOrEnabled === 'object' && stateOrEnabled !== null
        ? stateOrEnabled
        : { hasConcretePractice: Boolean(stateOrEnabled), isAllPractices: false };

    const hasConcretePractice = Boolean(normalized.hasConcretePractice);
    const isAllPractices = Boolean(normalized.isAllPractices);
    const allowBroadActions = hasConcretePractice || isAllPractices;

    [
        ['collectionBtn', allowBroadActions],
        ['preparingBtn', allowBroadActions],
        ['rejectedBtn', allowBroadActions],
        ['usersBtn', hasConcretePractice],
        ['openEhrSettingsBtn', hasConcretePractice],
        ['taskRecipientsBtn', hasConcretePractice],
        ['runDocmanLoginBtn', hasConcretePractice],
        ['runDocmanVerifyBtn', hasConcretePractice],
        ['runDocmanCreateGroupBtn', hasConcretePractice],
        ['runDocmanCleanProcessingBtn', hasConcretePractice],
        ['runDocmanCleanFilingBtn', hasConcretePractice],
        ['runDocmanOnboardingBtn', hasConcretePractice]
    ].forEach(([id, enabled]) => {
        const el = document.getElementById(id);
        if (el) el.disabled = !enabled;
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
    const normalizedOds = String(odsCode || '').toUpperCase();
    const cached = findCachedPracticeByOds(odsCode);
    const detailed = lastKnownDetailedStatusByOds.get(normalizedOds);
    if (!cached && !detailed) return null;
    return {
        ...(cached || {}),
        ...(detailed || {}),
        odsCode: detailed?.odsCode || cached?.ods || normalizedOds,
        practiceCDB: detailed?.practiceCDB || cached?.cdb || cached?.practiceCDB || 'N/A'
    };
}

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function formatStatusValue(value, fallback = 'N/A') {
    const text = String(value ?? '').trim();
    return text || fallback;
}

function formatOptionalStatusValue(value) {
    return String(value ?? '').trim();
}

function maskSecretValue(value) {
    const normalizedValue = formatOptionalStatusValue(value);
    if (!normalizedValue) return '';
    return '*'.repeat(Math.min(Math.max(normalizedValue.length, 6), 14));
}

function getRandomPasswordCharacter(charset) {
    const safeCharset = String(charset || '');
    if (!safeCharset) return '';
    const bytes = new Uint32Array(1);
    crypto.getRandomValues(bytes);
    return safeCharset[bytes[0] % safeCharset.length];
}

function shufflePasswordCharacters(chars) {
    const next = [...chars];
    for (let index = next.length - 1; index > 0; index -= 1) {
        const bytes = new Uint32Array(1);
        crypto.getRandomValues(bytes);
        const swapIndex = bytes[0] % (index + 1);
        [next[index], next[swapIndex]] = [next[swapIndex], next[index]];
    }
    return next.join('');
}

function generateSafePassword(length = 18) {
    const lower = 'abcdefghijkmnpqrstuvwxyz';
    const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    const digits = '23456789';
    const special = '!@#$%^&*+-_?';
    const groups = [lower, upper, digits, special];
    const all = groups.join('');
    const safeLength = Math.max(16, Number.parseInt(String(length || 18), 10) || 18);
    const chars = groups.map(getRandomPasswordCharacter);
    while (chars.length < safeLength) {
        chars.push(getRandomPasswordCharacter(all));
    }
    return shufflePasswordCharacters(chars);
}

function setSecretValueElement(valueEl, rawValue, { visible = false } = {}) {
    const value = String(rawValue || '').trim();
    const masked = maskSecretValue(value);
    valueEl.setAttribute('data-secret-value', value);
    valueEl.setAttribute('data-secret-mask', masked);
    valueEl.removeAttribute('data-secret-fetch');
    valueEl.classList.remove('is-configured');
    valueEl.textContent = visible ? value : masked;
    valueEl.setAttribute('data-secret-visible', visible ? 'true' : 'false');
}

function buildStatusActionIcon(type) {
    if (type === 'eye') {
        return `
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6Z"></path>
                <circle cx="12" cy="12" r="3.2"></circle>
            </svg>
        `;
    }

    if (type === 'generate') {
        return `
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path d="M13 2 9.8 8.8 3 12l6.8 3.2L13 22l3.2-6.8L23 12l-6.8-3.2Z"></path>
                <path d="m5 3 1 2 2 1-2 1-1 2-1-2-2-1 2-1Z"></path>
            </svg>
        `;
    }

    if (type === 'save') {
        return `
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path d="M5 3h12l2 2v16H5Z"></path>
                <path d="M8 3v6h8V3"></path>
                <path d="M8 17h8"></path>
            </svg>
        `;
    }

    if (type === 'undo') {
        return `
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path d="M9 7H4v5"></path>
                <path d="M5 12a7 7 0 1 0 2-5"></path>
            </svg>
        `;
    }

    return `
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <rect x="9" y="9" width="10" height="10" rx="2"></rect>
            <path d="M7 15H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v1"></path>
        </svg>
    `;
}

function buildMetaItemHtml(label, value, toneClass, options = {}) {
    const safeLabel = escapeHtml(label);
    const displayValue = formatStatusValue(value);
    const copyValue = formatOptionalStatusValue(options.copyValue);
    const copyLabel = escapeHtml(options.copyLabel || label);
    const tagName = copyValue ? 'button' : 'div';
    const interactiveClass = copyValue ? ' practice-status-meta-item-button' : '';
    const actionAttrs = copyValue
        ? ` type="button" data-copy-value="${escapeHtml(copyValue)}" data-copy-label="${copyLabel}" title="Copy ${copyLabel}"`
        : '';

    return `
        <${tagName} class="practice-status-meta-item ${toneClass}${interactiveClass}"${actionAttrs}>
            <span class="practice-status-meta-label">${safeLabel}</span>
            <span class="practice-status-meta-value">${escapeHtml(displayValue)}</span>
        </${tagName}>
    `;
}

function buildCredentialFieldHtml(groupLabel, label, value, options = {}) {
    const normalizedValue = formatOptionalStatusValue(value);
    const safeLabel = escapeHtml(label);
    const fullLabel = `${groupLabel} ${label}`.trim();
    const safeFullLabel = escapeHtml(fullLabel);
    const isSecret = options.secret === true;
    const isConfiguredSecret = isSecret && !normalizedValue && options.present === true;
    const secretKey = String(options.secretKey || '').trim();
    const isVisible = isSecret && isSecretFieldVisible(options.odsCode, fullLabel);
    const canRevealSecret = isSecret && (Boolean(normalizedValue) || isConfiguredSecret);
    const valueMarkup = normalizedValue
        ? (isSecret
            ? `<span class="practice-status-credential-value is-secret" data-secret-field-key="${escapeHtml(secretKey)}" data-secret-value="${escapeHtml(normalizedValue)}" data-secret-mask="${escapeHtml(maskSecretValue(normalizedValue))}" data-secret-label="${safeFullLabel}" data-secret-visible="${isVisible ? 'true' : 'false'}">${escapeHtml(isVisible ? normalizedValue : maskSecretValue(normalizedValue))}</span>`
            : `<span class="practice-status-credential-value">${escapeHtml(normalizedValue)}</span>`)
        : isConfiguredSecret
            ? `<span class="practice-status-credential-value is-secret is-configured" data-secret-field-key="${escapeHtml(secretKey)}" data-secret-fetch="${escapeHtml(secretKey)}" data-secret-label="${safeFullLabel}" data-secret-visible="false">Hidden</span>`
        : '<span class="practice-status-credential-value is-empty">&nbsp;</span>';
    const actionsMarkup = (normalizedValue || isConfiguredSecret)
        ? `
            <div class="practice-status-inline-actions">
                ${canRevealSecret
                    ? `<button class="practice-status-inline-action${isVisible ? ' is-active' : ''}" type="button" data-secret-toggle="true" aria-pressed="${isVisible ? 'true' : 'false'}" aria-label="${isVisible ? 'Hide' : 'Show'} ${safeFullLabel}" title="${isVisible ? 'Hide' : 'Show'} ${safeFullLabel}">
                        ${buildStatusActionIcon('eye')}
                    </button>`
                    : ''}
                ${canRevealSecret ? `<button class="practice-status-inline-action" type="button" data-secret-copy="true" aria-label="Copy ${safeFullLabel}" title="Copy ${safeFullLabel}">
                    ${buildStatusActionIcon('copy')}
                </button>` : ''}
                ${canRevealSecret ? `<button class="practice-status-inline-action" type="button" data-secret-generate="true" aria-label="Generate ${safeFullLabel}" title="Generate ${safeFullLabel}">
                    ${buildStatusActionIcon('generate')}
                </button>` : ''}
                ${canRevealSecret ? `<button class="practice-status-inline-action" type="button" data-secret-save="true" aria-label="Save ${safeFullLabel} in BetterLetter" title="Save ${safeFullLabel} in BetterLetter">
                    ${buildStatusActionIcon('save')}
                </button>` : ''}
                ${canRevealSecret ? `<button class="practice-status-inline-action" type="button" data-secret-undo="true" aria-label="Undo last saved ${safeFullLabel}" title="Undo last saved ${safeFullLabel}">
                    ${buildStatusActionIcon('undo')}
                </button>` : ''}
            </div>
        `
        : '';
    const fieldAttributes = canRevealSecret ? ' data-secret-field="true"' : '';

    return `
        <div class="practice-status-credential-field"${fieldAttributes}>
            <span class="practice-status-credential-label">${safeLabel}</span>
            <div class="practice-status-credential-value-row">
                ${valueMarkup}
                ${actionsMarkup}
            </div>
        </div>
    `;
}

function buildCredentialGroupHtml(groupLabel, fields) {
    const body = fields.map((field) => buildCredentialFieldHtml(groupLabel, field.label, field.value, field)).join('');
    const usernameField = fields.find((field) => String(field.label || '').toLowerCase() === 'username');
    const username = formatOptionalStatusValue(usernameField?.value);
    const hasPassword = fields.some((field) => (
        field.secret === true
        && (Boolean(formatOptionalStatusValue(field.value)) || field.present === true)
    ));
    const previewParts = [
        username ? `User ${username}` : '',
        hasPassword ? 'Password saved' : ''
    ].filter(Boolean);
    const preview = previewParts.length ? previewParts.join(' · ') : 'No saved credentials';

    return `
        <details class="practice-status-credential-card">
            <summary class="practice-status-credential-summary">
                <span class="practice-status-credential-card-title">${escapeHtml(groupLabel)}</span>
                <span class="practice-status-credential-preview">${escapeHtml(preview)}</span>
            </summary>
            <div class="practice-status-credential-card-body">
                ${body}
            </div>
        </details>
    `;
}

function getMetricToneClass(key, rawValue) {
    const value = parseCountNumber(rawValue);
    if (value === null) return 'is-neutral';
    if (key === 'rejected') return value > 0 ? 'is-danger' : 'is-success';
    if (key === 'preparing') return value > 0 ? 'is-warning' : 'is-neutral';
    if (key === 'edit' || key === 'review') return value > 0 ? 'is-info' : 'is-neutral';
    if (key === 'coding') return value > 0 ? 'is-accent' : 'is-neutral';
    return 'is-neutral';
}

function getLiveTotal(counts) {
    let total = 0;
    let hasAny = false;
    LIVE_COUNT_KEYS.forEach((key) => {
        const parsed = parseCountNumber(counts?.[key]);
        if (parsed === null) return;
        total += parsed;
        hasAny = true;
    });
    return hasAny ? total : 'N/A';
}

function getEhrChipClass(ehrType) {
    const normalized = String(ehrType || '').trim().toLowerCase();
    if (normalized === 'emis') return 'is-ehr-emis';
    if (normalized === 'docman_emis') return 'is-ehr-docman-emis';
    return 'is-neutral';
}

function getServiceChipClass(serviceLevel) {
    const normalized = String(serviceLevel || '').trim().toLowerCase();
    if (normalized === 'full') return 'is-service-full';
    if (normalized === 'self') return 'is-service-self';
    if (normalized === 'hybrid') return 'is-service-hybrid';
    return 'is-neutral';
}

function ensureStatusDisplayInteractions() {
    if (statusDisplayInteractionsBound) return;
    const statusDisplayEl = document.getElementById('statusDisplay');
    if (!statusDisplayEl) return;

    const getSecretContext = (actionTarget) => {
        const fieldEl = actionTarget?.closest?.('[data-secret-field]');
        const valueEl = fieldEl?.querySelector?.('[data-secret-value], [data-secret-fetch], [data-secret-field-key]');
        if (!fieldEl || !valueEl) return null;
        const odsCode = String(
            valueEl.closest('.status-info-box')?.getAttribute('data-status-ods') || state.currentSelectedOdsCode || ''
        ).toUpperCase();
        const field = String(
            valueEl.getAttribute('data-secret-field-key') ||
            valueEl.getAttribute('data-secret-fetch') ||
            ''
        ).trim();
        const label = String(valueEl.getAttribute('data-secret-label') || 'Password').trim();
        if (!odsCode || !field) return null;
        return { fieldEl, valueEl, odsCode, field, label };
    };

    const ensureSecretValue = async (context, actionTarget, { reveal = false } = {}) => {
        let rawValue = String(context.valueEl.getAttribute('data-secret-value') || '').trim();
        if (rawValue) return rawValue;

        const previousText = context.valueEl.textContent;
        if (actionTarget) actionTarget.disabled = true;
        context.valueEl.textContent = 'Loading...';
        try {
            const response = await chrome.runtime.sendMessage({
                action: 'getPracticeSecret',
                odsCode: context.odsCode,
                field: context.field
            });
            rawValue = String(response?.value || '').trim();
            if (!response?.success || !rawValue) {
                throw new Error(response?.error || 'Password could not be loaded.');
            }
            setSecretValueElement(context.valueEl, rawValue, { visible: reveal });
            return rawValue;
        } catch (error) {
            context.valueEl.textContent = previousText || 'Hidden';
            showToast(error?.message || 'Password could not be loaded.');
            return '';
        } finally {
            if (actionTarget) actionTarget.disabled = false;
        }
    };

    statusDisplayEl.addEventListener('click', async (event) => {
        const toggleTarget = event.target instanceof Element
            ? event.target.closest('[data-secret-toggle]')
            : null;
        if (toggleTarget) {
            rememberStatusDisplayInteraction();
            const context = getSecretContext(toggleTarget);
            if (!context) return;

            const currentVisible = String(context.valueEl.getAttribute('data-secret-visible') || '').toLowerCase() === 'true';
            const nextVisible = !currentVisible;
            const rawValue = nextVisible
                ? await ensureSecretValue(context, toggleTarget, { reveal: true })
                : String(context.valueEl.getAttribute('data-secret-value') || '').trim();
            if (!rawValue) return;

            context.valueEl.textContent = nextVisible ? rawValue : maskSecretValue(rawValue);
            context.valueEl.setAttribute('data-secret-visible', nextVisible ? 'true' : 'false');
            toggleTarget.setAttribute('aria-pressed', nextVisible ? 'true' : 'false');
            toggleTarget.setAttribute('aria-label', `${nextVisible ? 'Hide' : 'Show'} ${context.label}`);
            toggleTarget.setAttribute('title', `${nextVisible ? 'Hide' : 'Show'} ${context.label}`);
            toggleTarget.classList.toggle('is-active', nextVisible);
            setSecretFieldVisibility(context.odsCode, context.label, nextVisible);
            return;
        }

        const secretCopyTarget = event.target instanceof Element
            ? event.target.closest('[data-secret-copy]')
            : null;
        if (secretCopyTarget) {
            rememberStatusDisplayInteraction();
            const context = getSecretContext(secretCopyTarget);
            if (!context) return;
            const rawValue = await ensureSecretValue(context, secretCopyTarget, { reveal: false });
            if (!rawValue) return;
            try {
                const copied = await copyTextToClipboard(rawValue);
                if (!copied) throw new Error('copy failed');
                showToast(`${context.label} copied.`);
            } catch (error) {
                showToast('Copy failed.');
            }
            return;
        }

        const secretGenerateTarget = event.target instanceof Element
            ? event.target.closest('[data-secret-generate]')
            : null;
        if (secretGenerateTarget) {
            rememberStatusDisplayInteraction();
            const context = getSecretContext(secretGenerateTarget);
            if (!context) return;
            const generatedPassword = generateSafePassword(18);
            setSecretValueElement(context.valueEl, generatedPassword, { visible: true });
            const toggleTargetForField = context.fieldEl.querySelector('[data-secret-toggle]');
            if (toggleTargetForField) {
                toggleTargetForField.setAttribute('aria-pressed', 'true');
                toggleTargetForField.setAttribute('aria-label', `Hide ${context.label}`);
                toggleTargetForField.setAttribute('title', `Hide ${context.label}`);
                toggleTargetForField.classList.add('is-active');
            }
            setSecretFieldVisibility(context.odsCode, context.label, true);
            showToast('Generated password. Click save to update BetterLetter.');
            return;
        }

        const secretSaveTarget = event.target instanceof Element
            ? event.target.closest('[data-secret-save]')
            : null;
        if (secretSaveTarget) {
            rememberStatusDisplayInteraction();
            const context = getSecretContext(secretSaveTarget);
            if (!context) return;
            const rawValue = await ensureSecretValue(context, secretSaveTarget, { reveal: false });
            if (!rawValue) return;
            secretSaveTarget.disabled = true;
            try {
                const response = await chrome.runtime.sendMessage({
                    action: 'savePracticeSecretToAdminPanel',
                    odsCode: context.odsCode,
                    field: context.field,
                    value: rawValue
                });
                if (!response?.success) {
                    throw new Error(response?.error || 'Password could not be saved.');
                }
                showToast('Password saved in BetterLetter.');
            } catch (error) {
                showToast(error?.message || 'Password could not be saved.');
            } finally {
                secretSaveTarget.disabled = false;
            }
            return;
        }

        const secretUndoTarget = event.target instanceof Element
            ? event.target.closest('[data-secret-undo]')
            : null;
        if (secretUndoTarget) {
            rememberStatusDisplayInteraction();
            const context = getSecretContext(secretUndoTarget);
            if (!context) return;
            secretUndoTarget.disabled = true;
            try {
                const response = await chrome.runtime.sendMessage({
                    action: 'undoPracticeSecretSave',
                    odsCode: context.odsCode,
                    field: context.field
                });
                if (!response?.success || !response?.value) {
                    throw new Error(response?.error || 'No saved password history for this field.');
                }

                setSecretValueElement(context.valueEl, response.value, { visible: true });
                const toggleTargetForField = context.fieldEl.querySelector('[data-secret-toggle]');
                if (toggleTargetForField) {
                    toggleTargetForField.setAttribute('aria-pressed', 'true');
                    toggleTargetForField.setAttribute('aria-label', `Hide ${context.label}`);
                    toggleTargetForField.setAttribute('title', `Hide ${context.label}`);
                    toggleTargetForField.classList.add('is-active');
                }
                setSecretFieldVisibility(context.odsCode, context.label, true);
                showToast('Previous password restored in BetterLetter.');
            } catch (error) {
                showToast(error?.message || 'Password could not be restored.');
            } finally {
                secretUndoTarget.disabled = false;
            }
            return;
        }

        const copyTarget = event.target instanceof Element
            ? event.target.closest('[data-copy-value]')
            : null;
        if (!copyTarget) return;
        rememberStatusDisplayInteraction();

        const copyValue = String(copyTarget.getAttribute('data-copy-value') || '').trim();
        const copyLabel = String(copyTarget.getAttribute('data-copy-label') || 'Value').trim();
        if (!copyValue) return;

        try {
            const copied = await copyTextToClipboard(copyValue);
            if (!copied) throw new Error('copy failed');
            showToast(`${copyLabel} copied.`);
        } catch (error) {
            showToast('Copy failed.');
        }
    });

    statusDisplayInteractionsBound = true;
}

function buildPracticeStatusHtml(status, counts) {
    const displayName = formatStatusValue(
        status?.name || status?.practiceName || status?.practiceCDB || status?.odsCode,
        'Practice Status'
    );
    const odsCode = formatStatusValue(status?.odsCode);
    const ehrType = formatStatusValue(status?.ehrType);
    const serviceLevel = formatStatusValue(status?.serviceLevel);
    const practiceCdbRaw = formatOptionalStatusValue(status?.practiceCDB);
    const practiceCdb = practiceCdbRaw || 'N/A';
    const collectionQuota = formatStatusValue(status?.collectionQuota);
    const collectedToday = formatStatusValue(status?.collectedToday);
    const totalLive = getLiveTotal(counts);
    const metaItems = [
        buildMetaItemHtml('ODS', odsCode, 'is-primary', { copyValue: status?.odsCode, copyLabel: 'ODS' }),
        buildMetaItemHtml('CDB', practiceCdb, practiceCdbRaw ? 'is-cdb' : 'is-neutral', { copyValue: practiceCdbRaw, copyLabel: 'CDB' }),
        buildMetaItemHtml('EHR Type', ehrType, getEhrChipClass(ehrType)),
        buildMetaItemHtml('Service', serviceLevel, getServiceChipClass(serviceLevel))
    ].join('');

    const summaryCards = [
        ['Active', totalLive, 'is-primary'],
        ['Quota', collectionQuota, ''],
        ['Collected', collectedToday, '']
    ].map(([label, value, toneClass]) => `
        <div class="practice-status-summary-card ${toneClass}">
            <span class="practice-status-summary-label">${escapeHtml(label)}</span>
            <span class="practice-status-summary-value"${label === 'Active' ? ' data-live-total' : ''}>${escapeHtml(String(value))}</span>
        </div>
    `).join('');

    const metricCards = [
        ['preparing', 'Preparing'],
        ['edit', 'Edit'],
        ['review', 'Review'],
        ['coding', 'Coding'],
        ['rejected', 'Rejected']
    ].map(([key, label]) => `
        <div class="practice-status-metric ${getMetricToneClass(key, counts?.[key])}" data-live-metric-card="${key}">
            <span class="practice-status-metric-label">${escapeHtml(label)}</span>
            <span class="practice-status-metric-value" data-live-count="${key}">${formatCount(counts?.[key])}</span>
        </div>
    `).join('');

    const ehrGroups = [
        buildCredentialGroupHtml('EMIS API', [
            { label: 'Username', value: status?.emisApiUsername, odsCode: status?.odsCode },
            { label: 'Password', value: status?.emisApiPassword, present: Boolean(status?.emisApiPasswordPresent), secret: true, secretKey: 'emisApiPassword', odsCode: status?.odsCode }
        ]),
        buildCredentialGroupHtml('EMIS Web', [
            { label: 'Username', value: status?.emisWebUsername, odsCode: status?.odsCode },
            { label: 'Password', value: status?.emisWebPassword, present: Boolean(status?.emisWebPasswordPresent), secret: true, secretKey: 'emisWebPassword', odsCode: status?.odsCode },
            { label: 'Dummy NHS Number', value: status?.emisWebDummyNhsNumber, odsCode: status?.odsCode }
        ]),
        buildCredentialGroupHtml('Docman', [
            { label: 'Username', value: status?.docmanUsername, odsCode: status?.odsCode },
            { label: 'Password', value: status?.docmanPassword, present: Boolean(status?.docmanPasswordPresent), secret: true, secretKey: 'docmanPassword', odsCode: status?.odsCode },
            { label: 'Dummy NHS Number', value: status?.docmanDummyNhsNumber, odsCode: status?.odsCode },
            { label: 'Input Folder', value: status?.docmanInputFolder, odsCode: status?.odsCode },
            { label: 'Processing Folder', value: status?.docmanProcessingFolder, odsCode: status?.odsCode },
            { label: 'Filing Folder', value: status?.docmanFilingFolder, odsCode: status?.odsCode },
            { label: 'Rejected Folder', value: status?.docmanRejectedFolder, odsCode: status?.odsCode }
        ])
    ].join('');

    return `
        <div class="status-info-box practice-status-card practice-status-card-compact" data-status-ods="${escapeHtml(status.odsCode || '')}">
            <div class="practice-status-hero">
                <div class="practice-status-hero-row">
                    <div class="practice-status-heading">
                        <div class="practice-status-kicker">Practice Status</div>
                        <div class="practice-status-title">${escapeHtml(displayName)}</div>
                        <div class="practice-status-subtitle">Live BetterLetter summary</div>
                    </div>
                    <div class="practice-status-meta-grid">
                        ${metaItems}
                    </div>
                </div>
                <div class="practice-status-summary-strip">
                    ${summaryCards}
                </div>
            </div>
            <div class="practice-status-section-head">
                <span class="practice-status-section-caption">Live mailroom counts</span>
            </div>
            <div class="practice-status-metrics">
                ${metricCards}
            </div>
            <details class="practice-status-ehr-details">
                <summary class="practice-status-ehr-summary">
                    <span class="practice-status-ehr-summary-title">EHR settings</span>
                    <span class="practice-status-ehr-summary-meta">EMIS API · EMIS Web · Docman</span>
                </summary>
                <div class="practice-status-credentials-list">
                    ${ehrGroups}
                </div>
            </details>
        </div>
    `;
}

function applyLiveCountsToStatusDisplay(counts) {
    LIVE_COUNT_KEYS.forEach((key) => {
        const el = document.querySelector(`#statusDisplay [data-live-count="${key}"]`);
        if (!el) return;
        el.textContent = formatCount(counts?.[key]);
        const metricCardEl = document.querySelector(`#statusDisplay [data-live-metric-card="${key}"]`);
        if (!metricCardEl) return;
        metricCardEl.classList.remove('is-neutral', 'is-info', 'is-warning', 'is-accent', 'is-success', 'is-danger');
        metricCardEl.classList.add(getMetricToneClass(key, counts?.[key]));
    });
    const totalEl = document.querySelector('#statusDisplay [data-live-total]');
    if (totalEl) totalEl.textContent = String(getLiveTotal(counts));
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
    ensureStatusDisplayInteractions();
    const displayedOdsBeforeFetch = String(
        document.querySelector('#statusDisplay .status-info-box')?.getAttribute('data-status-ods') || ''
    ).toUpperCase();
    const hasVisibleStatusCard = Boolean(document.querySelector('#statusDisplay .status-info-box'));

    if (preferCached) {
        const shouldRenderImmediateSnapshot = !keepExisting || !hasVisibleStatusCard || displayedOdsBeforeFetch !== selectedOds;
        const cachedStatus = shouldRenderImmediateSnapshot ? buildCachedStatusSnapshot(selectedOds) : null;
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
        } else if (!keepExisting && shouldRenderImmediateSnapshot) {
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
            odsCode: selectedOds,
            ...withPreferredTabId()
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
            const statusSignature = buildStatusDetailSignature(response.status);
            lastKnownDetailedStatusByOds.set(selectedOds, { ...response.status });
            const displayedOds = String(
                document.querySelector('#statusDisplay .status-info-box')?.getAttribute('data-status-ods') || ''
            ).toUpperCase();
            const countsForRender = displayedOds === selectedOds
                ? mergeDisplayCounts(counts, readDisplayedLiveCounts())
                : mergeDisplayCounts(counts, normalizeLiveCounts(lastKnownLiveCountsByOds.get(selectedOds)));
            const previousSignature = lastRenderedStatusSignatureByOds.get(selectedOds);
            const canPatchCountsOnly = hasVisibleStatusCard && displayedOds === selectedOds && previousSignature === statusSignature;

            if (canPatchCountsOnly) {
                applyLiveCountsToStatusDisplay(countsForRender);
            } else {
                statusDisplayEl.innerHTML = buildPracticeStatusHtml(response.status, countsForRender);
                statusDisplayEl.style.display = 'block';
                rememberLiveCountsForOds(selectedOds, countsForRender);
                lastRenderedStatusSignatureByOds.set(selectedOds, statusSignature);
            }
            if (!silent) hideStatus();

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
    const allPractices = Object.entries(state.cachedPractices)
        .map(([label, practice]) => ({ label, practice }))
        .filter(({ practice }) => practice && practice.ods);

    if (!query && !showOnEmpty) {
        listEl.innerHTML = '';
        listEl.style.display = 'none';
        return;
    }

    const practiceMatchesQuery = ({ label, practice }) => {
        if (!query) return true;
        return [
            label,
            practice?.name,
            practice?.ods,
            practice?.cdb,
            practice?.practiceCDB
        ].some((value) => String(value || '').toLowerCase().includes(query));
    };

    // Show all practices when empty (if explicitly requested), and filter by name, ODS, or CDB while typing.
    let matches = allPractices.filter(practiceMatchesQuery);

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

    matches.forEach(({ label, practice }) => {
        const li = document.createElement('li');
        const meta = [
            practice?.ods ? `ODS ${practice.ods}` : '',
            practice?.cdb || practice?.practiceCDB ? `CDB ${practice.cdb || practice.practiceCDB}` : ''
        ].filter(Boolean).join(' · ');
        li.innerHTML = `
            <div class="suggestion-main">${escapeHtml(practice?.name || label)}</div>
            ${meta ? `<div class="suggestion-meta">${escapeHtml(meta)}</div>` : ''}
        `;
        li.addEventListener('mousedown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            setSelectedPractice(practice);
        });
        listEl.appendChild(li);
    });
    listEl.style.display = 'block';
}
