/**
 * MailroomNavigator — Auth & User Management Module
 * ===================================================
 * Drop-in replacement/enhancement for the existing Access Control section.
 *
 * What this module provides:
 *  - Bootstrap flow (first-run super-admin self-setup)
 *  - Full CRUD for managed users with role + feature matrix
 *  - Activity audit log (stored locally, shown in panel)
 *  - Session/identity diagnostics view
 *  - Access-service (local vs remote) health indicator
 *  - Invite token helpers for onboarding teammates
 *  - Animated, reactive UI components that slot into the existing panel.html DOM
 *
 * Integration:
 *  Import and call `AuthManagement.init(panelContext)` from panel.js after
 *  access state is resolved.  The module emits custom DOM events so panel.js
 *  can react without tight coupling.
 *
 * Nothing in this file replaces background.js logic — it is purely a UI layer
 * that calls the same existing chrome.runtime.sendMessage actions already
 * wired in background.js.
 */

// ─── Constants ───────────────────────────────────────────────────────────────

const AUDIT_LOG_STORAGE_KEY   = 'mailroomNavAuditLogV1';
const INVITE_TOKENS_STORAGE_KEY = 'mailroomNavInviteTokensV1';
const MAX_AUDIT_ENTRIES        = 200;
const MAX_INVITE_TOKENS        = 20;
const AUDIT_EVENT_TYPES = Object.freeze({
  USER_CREATED:   'user_created',
  USER_UPDATED:   'user_updated',
  USER_DELETED:   'user_deleted',
  ACCESS_GRANTED: 'access_granted',
  ACCESS_DENIED:  'access_denied',
  BOOTSTRAP:      'bootstrap',
  INVITE_CREATED: 'invite_created',
  INVITE_USED:    'invite_used',
  INVITE_REVOKED: 'invite_revoked',
});

const ROLE_LABELS = { super_admin: 'Super Admin', admin: 'Admin', user: 'User' };
const ROLE_COLORS = {
  super_admin: '#7c3aed',
  admin:       '#2563eb',
  user:        '#374151',
};

// ─── Utilities ────────────────────────────────────────────────────────────────

function el(id)          { return document.getElementById(id); }
function qs(sel, root)   { return (root || document).querySelector(sel); }
function qsa(sel, root)  { return [...(root || document).querySelectorAll(sel)]; }

function sanitizeEmail(v) {
  const s = String(v || '').trim().toLowerCase();
  return /^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/.test(s) ? s : '';
}

function formatDate(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    if (isNaN(d)) return iso;
    return d.toLocaleString(undefined, {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });
  } catch { return iso; }
}

function generateToken(length = 24) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, length);
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function debounce(fn, ms = 280) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function cls(el, add = [], remove = []) {
  if (!el) return;
  remove.forEach(c => el.classList.remove(c));
  add.forEach(c => el.classList.add(c));
}

function statusBadge(element, message, tone) {
  if (!element) return;
  element.textContent = message;
  cls(element,
    tone === 'valid' ? ['valid'] : tone === 'invalid' ? ['invalid'] : ['neutral'],
    ['valid', 'invalid', 'neutral']
  );
}

async function msg(action, payload = {}) {
  try {
    return await chrome.runtime.sendMessage({ action, payload, ...payload });
  } catch (e) {
    return { success: false, error: String(e?.message || e) };
  }
}

// ─── Audit Log ────────────────────────────────────────────────────────────────

const AuditLog = (() => {
  let entries = [];

  async function load() {
    try {
      const r = await chrome.storage.local.get([AUDIT_LOG_STORAGE_KEY]);
      entries = Array.isArray(r?.[AUDIT_LOG_STORAGE_KEY]) ? r[AUDIT_LOG_STORAGE_KEY] : [];
    } catch { entries = []; }
  }

  async function append(type, detail = {}, actorEmail = '') {
    await load();
    const entry = {
      id:        generateToken(12),
      type:      String(type),
      actor:     sanitizeEmail(actorEmail) || 'unknown',
      detail:    typeof detail === 'object' ? { ...detail } : { raw: String(detail) },
      timestamp: new Date().toISOString(),
    };
    entries = [entry, ...entries].slice(0, MAX_AUDIT_ENTRIES);
    try {
      await chrome.storage.local.set({ [AUDIT_LOG_STORAGE_KEY]: entries });
    } catch { /* non-fatal */ }
    return entry;
  }

  async function getRecent(n = 50) {
    await load();
    return entries.slice(0, n);
  }

  async function clear() {
    entries = [];
    await chrome.storage.local.remove([AUDIT_LOG_STORAGE_KEY]);
  }

  return { append, getRecent, clear };
})();

// ─── Invite Tokens ───────────────────────────────────────────────────────────

const InviteTokens = (() => {
  async function load() {
    try {
      const r = await chrome.storage.local.get([INVITE_TOKENS_STORAGE_KEY]);
      return Array.isArray(r?.[INVITE_TOKENS_STORAGE_KEY]) ? r[INVITE_TOKENS_STORAGE_KEY] : [];
    } catch { return []; }
  }

  async function save(tokens) {
    await chrome.storage.local.set({ [INVITE_TOKENS_STORAGE_KEY]: tokens.slice(0, MAX_INVITE_TOKENS) });
  }

  async function create({ role = 'user', features = [], expiresInHours = 72, createdBy = '' }) {
    const tokens = await load();
    const token = {
      id:         generateToken(20),
      token:      generateToken(32),
      role:       String(role),
      features:   Array.isArray(features) ? [...features] : [],
      createdAt:  new Date().toISOString(),
      expiresAt:  new Date(Date.now() + expiresInHours * 3600 * 1000).toISOString(),
      createdBy:  sanitizeEmail(createdBy),
      usedBy:     '',
      usedAt:     '',
      revoked:    false,
    };
    tokens.unshift(token);
    await save(tokens);
    return token;
  }

  async function revoke(tokenId) {
    const tokens = await load();
    const idx = tokens.findIndex(t => t.id === tokenId);
    if (idx === -1) return false;
    tokens[idx] = { ...tokens[idx], revoked: true };
    await save(tokens);
    return true;
  }

  async function redeem(tokenValue, targetEmail) {
    const tokens = await load();
    const token = tokens.find(t =>
      t.token === tokenValue && !t.revoked && !t.usedBy &&
      new Date(t.expiresAt) > new Date()
    );
    if (!token) return null;
    const idx = tokens.indexOf(token);
    tokens[idx] = { ...token, usedBy: sanitizeEmail(targetEmail), usedAt: new Date().toISOString() };
    await save(tokens);
    return tokens[idx];
  }

  async function getAll() { return load(); }

  return { create, revoke, redeem, getAll };
})();

// ─── UI Builder Helpers ───────────────────────────────────────────────────────

function makeButton(text, classes = '', onclick = null) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = text;
  b.className = `btn btn-sm ${classes}`.trim();
  if (onclick) b.addEventListener('click', onclick);
  return b;
}

function makeBadge(text, color = '#6b7280') {
  const span = document.createElement('span');
  span.style.cssText = `
    display:inline-block; padding:2px 8px; border-radius:12px;
    font-size:10px; font-weight:700; text-transform:uppercase;
    letter-spacing:.5px; color:#fff; background:${color};
  `;
  span.textContent = text;
  return span;
}

function makeIcon(path, size = 14) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.innerHTML = path;
  return svg;
}

function makeDivider(label = '') {
  const d = document.createElement('div');
  d.style.cssText = 'display:flex;align-items:center;gap:8px;margin:12px 0 8px;';
  if (label) {
    const hr1 = document.createElement('hr');
    hr1.style.cssText = 'flex:1;border:none;border-top:1px solid #e5e7eb;margin:0;';
    const span = document.createElement('span');
    span.style.cssText = 'font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:#9ca3af;white-space:nowrap;';
    span.textContent = label;
    const hr2 = hr1.cloneNode();
    d.append(hr1, span, hr2);
  } else {
    d.innerHTML = '<hr style="flex:1;border:none;border-top:1px solid #e5e7eb;margin:0;">';
  }
  return d;
}

// ─── Feature Matrix Renderer ─────────────────────────────────────────────────

function renderFeatureMatrix(container, catalog, selected = [], role = 'user', onChange = null) {
  container.innerHTML = '';

  // For super_admin: show all checked + disabled
  const isAdmin = role === 'super_admin';
  const selectedSet = new Set(isAdmin ? catalog.map(f => f.key) : selected);

  const grid = document.createElement('div');
  grid.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:4px;';

  catalog.forEach(feature => {
    const label = document.createElement('label');
    label.style.cssText = `
      display:flex;align-items:flex-start;gap:6px;padding:6px 8px;
      border:1px solid #e5e7eb;border-radius:6px;cursor:${isAdmin ? 'not-allowed' : 'pointer'};
      background:${selectedSet.has(feature.key) ? '#eff6ff' : '#fff'};
      transition:background .15s;
    `;

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = feature.key;
    cb.checked = selectedSet.has(feature.key);
    cb.disabled = isAdmin;
    cb.style.marginTop = '2px';
    cb.addEventListener('change', () => {
      label.style.background = cb.checked ? '#eff6ff' : '#fff';
      if (onChange) onChange(getChecked(container));
    });

    const copy = document.createElement('div');
    copy.innerHTML = `<div style="font-size:12px;font-weight:600;color:#1f2937;">${escapeHtml(feature.label)}</div>
      <div style="font-size:10px;color:#6b7280;margin-top:1px;">${escapeHtml(feature.description)}</div>`;

    label.append(cb, copy);
    grid.appendChild(label);
  });

  if (isAdmin) {
    const note = document.createElement('div');
    note.style.cssText = 'grid-column:1/-1;font-size:11px;color:#7c3aed;margin-top:4px;';
    note.textContent = '✦ Super Admin has all features enabled automatically.';
    grid.appendChild(note);
  }

  container.appendChild(grid);
}

function getChecked(container) {
  return qsa('input[type=checkbox]:checked', container).map(cb => cb.value);
}

// ─── User Card Renderer ───────────────────────────────────────────────────────

function renderUserCard(user, catalog, actorEmail, callbacks = {}) {
  const card = document.createElement('div');
  const roleColor = ROLE_COLORS[user.role] || '#374151';
  card.style.cssText = `
    border:1px solid #e5e7eb;border-radius:10px;padding:12px;margin-top:10px;
    background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.06);
    transition:box-shadow .15s;
  `;
  card.addEventListener('mouseenter', () => { card.style.boxShadow = '0 4px 12px rgba(0,0,0,.1)'; });
  card.addEventListener('mouseleave', () => { card.style.boxShadow = '0 1px 3px rgba(0,0,0,.06)'; });

  const header = document.createElement('div');
  header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;';

  const left = document.createElement('div');
  left.style.cssText = 'display:flex;align-items:center;gap:8px;min-width:0;';

  // Avatar
  const avatar = document.createElement('div');
  avatar.style.cssText = `
    width:32px;height:32px;border-radius:50%;background:${roleColor};
    color:#fff;display:flex;align-items:center;justify-content:center;
    font-size:12px;font-weight:700;flex-shrink:0;
  `;
  avatar.textContent = (user.email[0] || '?').toUpperCase();

  const meta = document.createElement('div');
  meta.style.cssText = 'min-width:0;';
  const emailEl = document.createElement('div');
  emailEl.style.cssText = 'font-size:12px;font-weight:600;color:#111827;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
  emailEl.textContent = user.email;
  emailEl.title = user.email;

  const roleMeta = document.createElement('div');
  roleMeta.style.cssText = 'display:flex;align-items:center;gap:6px;margin-top:2px;';
  roleMeta.appendChild(makeBadge(ROLE_LABELS[user.role] || user.role, roleColor));

  if (user.createdAt) {
    const when = document.createElement('span');
    when.style.cssText = 'font-size:10px;color:#9ca3af;';
    when.textContent = `Added ${formatDate(user.createdAt)}`;
    roleMeta.appendChild(when);
  }

  meta.append(emailEl, roleMeta);
  left.append(avatar, meta);

  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex;gap:5px;flex-shrink:0;';
  const editBtn = makeButton('Edit', 'btn-ghost', () => callbacks.onEdit && callbacks.onEdit(user));
  const deleteBtn = makeButton('Delete', '', async () => {
    if (!confirm(`Remove ${user.email} from MailroomNavigator?\nThis will immediately revoke their access.`)) return;
    deleteBtn.disabled = editBtn.disabled = true;
    deleteBtn.textContent = 'Removing…';
    await callbacks.onDelete(user);
    deleteBtn.disabled = editBtn.disabled = false;
    deleteBtn.textContent = 'Delete';
  });
  deleteBtn.style.background = '#dc2626';

  actions.append(editBtn, deleteBtn);
  header.append(left, actions);

  // Feature chips
  const chips = document.createElement('div');
  chips.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;margin-top:8px;';
  const featureKeys = user.role === 'super_admin'
    ? catalog.map(f => f.key)
    : (user.features || []);

  if (featureKeys.length === 0) {
    const none = document.createElement('span');
    none.style.cssText = 'font-size:11px;color:#9ca3af;font-style:italic;';
    none.textContent = 'No features assigned';
    chips.appendChild(none);
  } else {
    featureKeys.slice(0, 8).forEach(key => {
      const featureDef = catalog.find(f => f.key === key);
      if (!featureDef) return;
      const chip = document.createElement('span');
      chip.style.cssText = `
        font-size:10px;padding:2px 7px;border-radius:10px;
        background:#eff6ff;color:#1d4ed8;border:1px solid #bfdbfe;
      `;
      chip.textContent = featureDef.label;
      chips.appendChild(chip);
    });
    if (featureKeys.length > 8) {
      const more = document.createElement('span');
      more.style.cssText = 'font-size:10px;color:#6b7280;padding:2px 4px;';
      more.textContent = `+${featureKeys.length - 8} more`;
      chips.appendChild(more);
    }
  }

  // Timestamps footer
  const footer = document.createElement('div');
  footer.style.cssText = 'margin-top:6px;font-size:10px;color:#9ca3af;display:flex;gap:10px;';
  if (user.updatedAt) {
    const upd = document.createElement('span');
    upd.textContent = `Updated ${formatDate(user.updatedAt)}`;
    footer.appendChild(upd);
  }
  if (user.createdBy) {
    const by = document.createElement('span');
    by.textContent = `by ${user.createdBy}`;
    footer.appendChild(by);
  }

  card.append(header, chips, footer);
  return card;
}

// ─── Audit Log Renderer ───────────────────────────────────────────────────────

function renderAuditEntry(entry) {
  const ICONS = {
    [AUDIT_EVENT_TYPES.USER_CREATED]:   '➕',
    [AUDIT_EVENT_TYPES.USER_UPDATED]:   '✏️',
    [AUDIT_EVENT_TYPES.USER_DELETED]:   '🗑️',
    [AUDIT_EVENT_TYPES.ACCESS_GRANTED]: '✅',
    [AUDIT_EVENT_TYPES.ACCESS_DENIED]:  '🚫',
    [AUDIT_EVENT_TYPES.BOOTSTRAP]:      '🚀',
    [AUDIT_EVENT_TYPES.INVITE_CREATED]: '📨',
    [AUDIT_EVENT_TYPES.INVITE_USED]:    '🎟️',
    [AUDIT_EVENT_TYPES.INVITE_REVOKED]: '❌',
  };

  const row = document.createElement('div');
  row.style.cssText = `
    display:flex;align-items:flex-start;gap:8px;padding:7px 0;
    border-bottom:1px solid #f3f4f6;
  `;

  const icon = document.createElement('span');
  icon.style.cssText = 'font-size:14px;line-height:1.4;flex-shrink:0;';
  icon.textContent = ICONS[entry.type] || '•';

  const body = document.createElement('div');
  body.style.cssText = 'flex:1;min-width:0;';

  const top = document.createElement('div');
  top.style.cssText = 'font-size:11px;color:#1f2937;font-weight:500;';
  const typeLabel = entry.type.replace(/_/g, ' ');
  const targetEmail = entry.detail?.email || entry.detail?.targetEmail || '';
  top.textContent = `${typeLabel}${targetEmail ? ` — ${targetEmail}` : ''}`;

  const sub = document.createElement('div');
  sub.style.cssText = 'font-size:10px;color:#9ca3af;margin-top:1px;';
  sub.textContent = `${formatDate(entry.timestamp)} · ${entry.actor}`;

  body.append(top, sub);
  row.append(icon, body);
  return row;
}

// ─── Invite Token Renderer ────────────────────────────────────────────────────

function renderInviteTokenCard(token, catalog, onRevoke) {
  const isExpired  = new Date(token.expiresAt) < new Date();
  const isUsed     = Boolean(token.usedBy);
  const isRevoked  = Boolean(token.revoked);
  const status     = isRevoked ? 'revoked' : isUsed ? 'used' : isExpired ? 'expired' : 'active';
  const statusColors = { active: '#16a34a', used: '#2563eb', expired: '#d97706', revoked: '#dc2626' };

  const card = document.createElement('div');
  card.style.cssText = `
    border:1px solid #e5e7eb;border-radius:8px;padding:10px;margin-top:8px;
    background:${status === 'active' ? '#fff' : '#f9fafb'};opacity:${status === 'active' ? '1' : '.7'};
  `;

  const header = document.createElement('div');
  header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;';

  const left = document.createElement('div');
  const tokenDisplay = document.createElement('code');
  tokenDisplay.style.cssText = 'font-size:10px;color:#374151;background:#f3f4f6;padding:2px 6px;border-radius:4px;word-break:break-all;';
  tokenDisplay.textContent = token.token.slice(0, 12) + '…';
  tokenDisplay.title = 'Click to copy full token';
  tokenDisplay.style.cursor = 'pointer';
  tokenDisplay.addEventListener('click', () => {
    navigator.clipboard.writeText(token.token).catch(() => {});
    tokenDisplay.textContent = '✓ Copied!';
    setTimeout(() => { tokenDisplay.textContent = token.token.slice(0, 12) + '…'; }, 1500);
  });

  const meta = document.createElement('div');
  meta.style.cssText = 'font-size:10px;color:#6b7280;margin-top:3px;';
  const roleLabel = ROLE_LABELS[token.role] || token.role;
  meta.textContent = `${roleLabel} · Expires ${formatDate(token.expiresAt)}`;
  if (isUsed) meta.textContent += ` · Used by ${token.usedBy}`;

  left.append(tokenDisplay, meta);

  const right = document.createElement('div');
  right.style.cssText = 'display:flex;align-items:center;gap:6px;';
  right.appendChild(makeBadge(status, statusColors[status]));

  if (status === 'active' && onRevoke) {
    const revokeBtn = makeButton('Revoke', 'btn-ghost', async () => {
      if (!confirm('Revoke this invite token? It will no longer be usable.')) return;
      revokeBtn.disabled = true;
      await onRevoke(token.id);
    });
    right.appendChild(revokeBtn);
  }

  const copyBtn = makeButton('Copy', 'btn-ghost', () => {
    navigator.clipboard.writeText(token.token).catch(() => {});
    copyBtn.textContent = '✓';
    setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
  });
  if (status === 'active') right.appendChild(copyBtn);

  header.append(left, right);
  card.appendChild(header);
  return card;
}

// ─── Search / Filter Bar ──────────────────────────────────────────────────────

function buildSearchBar(placeholder, onInput) {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'position:relative;';
  const input = document.createElement('input');
  input.type = 'search';
  input.placeholder = placeholder;
  input.autocomplete = 'off';
  input.style.cssText = `
    width:100%;box-sizing:border-box;padding:7px 10px 7px 30px;
    border:1px solid #d1d5db;border-radius:7px;font-size:12px;
    background:#fff url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='%239ca3af' stroke-width='2'%3E%3Ccircle cx='11' cy='11' r='8'/%3E%3Cline x1='21' y1='21' x2='16.65' y2='16.65'/%3E%3C/svg%3E")
    no-repeat 9px center;
    outline:none;color:#111827;
  `;
  input.addEventListener('input', debounce(() => onInput(input.value)));
  wrap.appendChild(input);
  return wrap;
}

// ─── Bootstrap Flow ───────────────────────────────────────────────────────────

function renderBootstrapFlow(container, { currentEmail, onBootstrap }) {
  container.innerHTML = '';

  const box = document.createElement('div');
  box.style.cssText = `
    background:linear-gradient(135deg,#f5f3ff 0%,#ede9fe 100%);
    border:1px solid #c4b5fd;border-radius:12px;padding:16px;
    text-align:center;
  `;

  const icon = document.createElement('div');
  icon.style.cssText = 'font-size:32px;margin-bottom:8px;';
  icon.textContent = '🚀';

  const title = document.createElement('div');
  title.style.cssText = 'font-size:15px;font-weight:700;color:#5b21b6;margin-bottom:6px;';
  title.textContent = 'First-Run Setup';

  const desc = document.createElement('div');
  desc.style.cssText = 'font-size:12px;color:#6d28d9;margin-bottom:12px;line-height:1.5;';
  desc.textContent = 'No super admin is configured yet. Bootstrap yourself as the first owner to unlock all features and manage team access.';

  const emailDisplay = document.createElement('div');
  emailDisplay.style.cssText = `
    font-size:12px;font-weight:600;color:#5b21b6;background:#fff;
    border:1px solid #c4b5fd;border-radius:6px;padding:6px 10px;margin-bottom:12px;
  `;
  emailDisplay.textContent = currentEmail
    ? `Detected BetterLetter user: ${currentEmail}`
    : 'BetterLetter user not yet detected — open a signed-in tab first.';

  const status = document.createElement('div');
  status.className = 'validation-badge neutral';
  status.style.marginBottom = '10px';
  status.style.display = 'none';

  const bootstrapBtn = makeButton(
    currentEmail ? 'Bootstrap as Super Admin' : 'Refresh Identity',
    '',
    async () => {
      if (!currentEmail) {
        status.style.display = 'block';
        statusBadge(status, 'Refresh the panel after opening a signed-in BetterLetter tab.', 'invalid');
        return;
      }
      bootstrapBtn.disabled = true;
      bootstrapBtn.textContent = 'Setting up…';
      status.style.display = 'block';
      statusBadge(status, 'Bootstrapping…', 'neutral');
      try {
        await onBootstrap(currentEmail);
        statusBadge(status, `✓ Super admin configured for ${currentEmail}`, 'valid');
      } catch (err) {
        statusBadge(status, String(err?.message || 'Bootstrap failed.'), 'invalid');
        bootstrapBtn.disabled = false;
        bootstrapBtn.textContent = 'Bootstrap as Super Admin';
      }
    }
  );
  bootstrapBtn.style.cssText = 'width:100%;background:#7c3aed;color:#fff;padding:10px;font-size:13px;font-weight:600;';

  box.append(icon, title, desc, emailDisplay, status, bootstrapBtn);
  container.appendChild(box);
}

// ─── Main Auth Management Controller ─────────────────────────────────────────

const AuthManagement = (() => {
  let state = {
    accessState:   null,     // normalized access state from background
    management:    null,     // { users:[], featureCatalog:[] }
    catalog:       [],
    actorEmail:    '',
    editingEmail:  '',       // '' means "new user" form state
    searchQuery:   '',
    activeTab:     'users',  // 'users' | 'audit' | 'invites'
    inviteTokens:  [],
    auditEntries:  [],
    panelCallbacks: null,    // reference back to panel.js helpers
  };

  let rootContainer = null;

  // ── Section root (slots into existing extensionUserManagementSection) ────────

  function getOrCreateRoot() {
    const existing = el('authMgmtRoot');
    if (existing) return existing;

    const parent = el('extensionUserManagementSection');
    if (!parent) {
      console.warn('[AuthManagement] extensionUserManagementSection not found in DOM');
      return null;
    }

    // Clear existing basic markup, replace with advanced UI
    parent.innerHTML = '';
    parent.style.display = 'block';

    const h3 = document.createElement('h3');
    h3.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:12px;';
    h3.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
        <circle cx="9" cy="7" r="4"/>
        <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
        <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
      </svg>
      Access Control
    `;

    const root = document.createElement('div');
    root.id = 'authMgmtRoot';
    parent.append(h3, root);
    return root;
  }

  // ── Tab bar ───────────────────────────────────────────────────────────────

  function renderTabBar(root) {
    let tabBar = qs('.auth-tab-bar', root);
    if (tabBar) tabBar.remove();

    tabBar = document.createElement('div');
    tabBar.className = 'auth-tab-bar';
    tabBar.style.cssText = `
      display:flex;gap:4px;margin-bottom:14px;
      background:#f3f4f6;border-radius:8px;padding:3px;
    `;

    const tabs = [
      { id: 'users',   label: 'Users',   icon: '👥' },
      { id: 'invites', label: 'Invites', icon: '📨' },
      { id: 'audit',   label: 'Audit',   icon: '📋' },
    ];

    tabs.forEach(tab => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.style.cssText = `
        flex:1;padding:5px 8px;border:none;border-radius:6px;cursor:pointer;
        font-size:11px;font-weight:600;transition:all .15s;
        background:${state.activeTab === tab.id ? '#fff' : 'transparent'};
        color:${state.activeTab === tab.id ? '#1f2937' : '#6b7280'};
        box-shadow:${state.activeTab === tab.id ? '0 1px 3px rgba(0,0,0,.1)' : 'none'};
      `;
      btn.textContent = `${tab.icon} ${tab.label}`;
      btn.addEventListener('click', () => {
        state.activeTab = tab.id;
        render();
      });
      tabBar.appendChild(btn);
    });

    root.insertBefore(tabBar, root.firstChild);
  }

  // ── User Form (create / edit) ─────────────────────────────────────────────

  function renderUserForm(container) {
    container.innerHTML = '';

    const isEditing = Boolean(state.editingEmail);
    const currentUser = isEditing
      ? (state.management?.users || []).find(u => u.email === state.editingEmail)
      : null;

    const form = document.createElement('div');
    form.style.cssText = `
      background:${isEditing ? '#fffbeb' : '#f8fafc'};
      border:1px solid ${isEditing ? '#fde68a' : '#e5e7eb'};
      border-radius:10px;padding:14px;margin-bottom:12px;
    `;

    const formTitle = document.createElement('div');
    formTitle.style.cssText = 'font-size:13px;font-weight:700;color:#111827;margin-bottom:10px;';
    formTitle.textContent = isEditing ? `Editing: ${state.editingEmail}` : 'Add New User';
    form.appendChild(formTitle);

    // Email input
    if (!isEditing) {
      const emailLabel = document.createElement('label');
      emailLabel.style.cssText = 'font-size:11px;font-weight:600;color:#374151;display:block;margin-bottom:4px;';
      emailLabel.textContent = 'BetterLetter Email';
      const emailInput = document.createElement('input');
      emailInput.id = 'authMgmt_emailInput';
      emailInput.type = 'email';
      emailInput.placeholder = 'colleague@betterletter.ai';
      emailInput.autocomplete = 'off';
      emailInput.style.cssText = 'width:100%;box-sizing:border-box;margin-bottom:8px;';
      form.append(emailLabel, emailInput);
    }

    // Role selector
    const roleLabel = document.createElement('label');
    roleLabel.style.cssText = 'font-size:11px;font-weight:600;color:#374151;display:block;margin-bottom:4px;';
    roleLabel.textContent = 'Role';
    const roleSelect = document.createElement('select');
    roleSelect.id = 'authMgmt_roleSelect';
    roleSelect.style.cssText = 'width:100%;box-sizing:border-box;margin-bottom:10px;';
    [
      { value: 'user',        label: 'User — selected features only' },
      { value: 'super_admin', label: 'Super Admin — all features, can manage users' },
    ].forEach(opt => {
      const o = document.createElement('option');
      o.value = opt.value;
      o.textContent = opt.label;
      if (currentUser?.role === opt.value) o.selected = true;
      roleSelect.appendChild(o);
    });
    form.append(roleLabel, roleSelect);

    // Feature matrix
    const featLabel = document.createElement('label');
    featLabel.style.cssText = 'font-size:11px;font-weight:600;color:#374151;display:block;margin-bottom:6px;';
    featLabel.textContent = 'Enabled Features';
    const featContainer = document.createElement('div');
    featContainer.id = 'authMgmt_featContainer';
    form.append(featLabel, featContainer);

    const initialFeatures = currentUser?.role === 'super_admin'
      ? state.catalog.map(f => f.key)
      : (currentUser?.features || []);

    renderFeatureMatrix(featContainer, state.catalog, initialFeatures, currentUser?.role || 'user');

    // Update matrix when role changes
    roleSelect.addEventListener('change', () => {
      const role = roleSelect.value;
      const checked = role === 'super_admin' ? state.catalog.map(f => f.key) : [];
      renderFeatureMatrix(featContainer, state.catalog, checked, role);
    });

    // Status + action buttons
    const formStatus = document.createElement('div');
    formStatus.id = 'authMgmt_formStatus';
    formStatus.className = 'validation-badge neutral';
    formStatus.style.cssText = 'margin-top:10px;display:none;';

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:6px;margin-top:10px;';

    const saveBtn = makeButton(isEditing ? 'Update User' : 'Add User', '', async () => {
      const emailInput = el('authMgmt_emailInput');
      const role       = el('authMgmt_roleSelect')?.value || 'user';
      const features   = getChecked(el('authMgmt_featContainer') || featContainer);
      const email      = isEditing ? state.editingEmail : sanitizeEmail(emailInput?.value || '');

      if (!email) {
        formStatus.style.display = 'block';
        statusBadge(formStatus, 'Please enter a valid email address.', 'invalid');
        return;
      }

      formStatus.style.display = 'block';
      statusBadge(formStatus, 'Saving…', 'neutral');
      saveBtn.disabled = true;

      const response = await chrome.runtime.sendMessage({
        action: 'saveExtensionManagedUser',
        payload: { email, role, features }
      });

      if (!response?.success) {
        statusBadge(formStatus, String(response?.error || 'Could not save user.'), 'invalid');
        saveBtn.disabled = false;
        return;
      }

      await AuditLog.append(
        isEditing ? AUDIT_EVENT_TYPES.USER_UPDATED : AUDIT_EVENT_TYPES.USER_CREATED,
        { email, role, features },
        state.actorEmail
      );

      state.management   = response.management;
      state.editingEmail = '';
      statusBadge(formStatus, `✓ ${isEditing ? 'Updated' : 'Added'} ${email}.`, 'valid');

      // Emit event for panel.js to refresh access state
      document.dispatchEvent(new CustomEvent('authMgmt:userSaved', { detail: { email, role } }));

      setTimeout(() => render(), 400);
    });
    saveBtn.style.cssText = 'flex:1;background:#2563eb;color:#fff;font-weight:600;';

    if (isEditing) {
      const cancelBtn = makeButton('Cancel', 'btn-ghost', () => {
        state.editingEmail = '';
        render();
      });
      btnRow.append(saveBtn, cancelBtn);
    } else {
      // Select-all / clear-all helpers
      const selectAll = makeButton('All', 'btn-ghost', () => {
        qsa('input[type=checkbox]', featContainer).forEach(cb => {
          if (!cb.disabled) { cb.checked = true; cb.dispatchEvent(new Event('change')); }
        });
      });
      const clearAll = makeButton('None', 'btn-ghost', () => {
        qsa('input[type=checkbox]', featContainer).forEach(cb => {
          if (!cb.disabled) { cb.checked = false; cb.dispatchEvent(new Event('change')); }
        });
      });
      btnRow.append(saveBtn, selectAll, clearAll);
    }

    form.append(formStatus, btnRow);
    container.appendChild(form);
  }

  // ── Users Tab ─────────────────────────────────────────────────────────────

  async function renderUsersTab(container) {
    container.innerHTML = '';

    // Owner info pill
    const ownerPill = document.createElement('div');
    ownerPill.style.cssText = `
      display:flex;align-items:center;gap:8px;padding:8px 10px;
      background:#f5f3ff;border:1px solid #ddd6fe;border-radius:8px;
      margin-bottom:10px;
    `;
    const ownerAvatar = document.createElement('div');
    ownerAvatar.style.cssText = 'width:24px;height:24px;border-radius:50%;background:#7c3aed;color:#fff;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;flex-shrink:0;';
    ownerAvatar.textContent = (state.actorEmail[0] || '?').toUpperCase();
    const ownerText = document.createElement('div');
    ownerText.style.cssText = 'font-size:11px;color:#5b21b6;';
    ownerText.innerHTML = `<strong>You</strong> · ${escapeHtml(state.actorEmail)} · <em>Super Admin (Owner)</em>`;
    ownerPill.append(ownerAvatar, ownerText);
    container.appendChild(ownerPill);

    // Summary
    const users = Array.isArray(state.management?.users) ? state.management.users : [];
    const summary = document.createElement('div');
    summary.style.cssText = 'display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-bottom:12px;';
    [
      { label: 'Total Users', value: users.length,                                    color: '#2563eb' },
      { label: 'Super Admins', value: users.filter(u => u.role === 'super_admin').length, color: '#7c3aed' },
      { label: 'Regular Users', value: users.filter(u => u.role !== 'super_admin').length, color: '#374151' },
    ].forEach(({ label, value, color }) => {
      const card = document.createElement('div');
      card.style.cssText = `text-align:center;padding:8px;background:#f8fafc;border:1px solid #e5e7eb;border-radius:8px;`;
      card.innerHTML = `
        <div style="font-size:18px;font-weight:800;color:${color};">${value}</div>
        <div style="font-size:10px;color:#6b7280;margin-top:2px;">${label}</div>
      `;
      summary.appendChild(card);
    });
    container.appendChild(summary);

    // Add/Edit user form
    const formContainer = document.createElement('div');
    formContainer.id = 'authMgmt_formContainer';
    renderUserForm(formContainer);
    container.appendChild(formContainer);

    container.appendChild(makeDivider('Managed Users'));

    // Search
    const searchBar = buildSearchBar('Search users…', q => {
      state.searchQuery = q.toLowerCase();
      renderUserList(listContainer);
    });
    container.appendChild(searchBar);

    // Role filter
    const roleFilter = document.createElement('div');
    roleFilter.style.cssText = 'display:flex;gap:4px;margin:6px 0 10px;flex-wrap:wrap;';
    const allRoles = ['all', 'super_admin', 'user'];
    let activeRoleFilter = 'all';
    allRoles.forEach(role => {
      const btn = makeButton(role === 'all' ? 'All' : ROLE_LABELS[role], 'btn-ghost', () => {
        activeRoleFilter = role;
        qsa('button', roleFilter).forEach(b => cls(b, [], ['active-tab']));
        btn.classList.add('active-tab');
        renderUserList(listContainer);
      });
      btn.style.fontSize = '10px';
      if (role === 'all') btn.classList.add('active-tab');
      roleFilter.appendChild(btn);
    });
    container.appendChild(roleFilter);

    // User list
    const listContainer = document.createElement('div');
    listContainer.id = 'authMgmt_userList';

    function renderUserList(target) {
      target.innerHTML = '';
      const query = state.searchQuery;
      const filtered = users.filter(u => {
        if (activeRoleFilter !== 'all' && u.role !== activeRoleFilter) return false;
        if (query && !u.email.includes(query)) return false;
        return true;
      });

      if (filtered.length === 0) {
        const empty = document.createElement('div');
        empty.style.cssText = 'text-align:center;padding:20px;color:#9ca3af;font-size:12px;';
        empty.textContent = users.length === 0 ? 'No managed users yet. Add one above.' : 'No users match your search.';
        target.appendChild(empty);
        return;
      }

      filtered.forEach(user => {
        const card = renderUserCard(user, state.catalog, state.actorEmail, {
          onEdit: u => {
            state.editingEmail = u.email;
            renderUserForm(formContainer);
            formContainer.scrollIntoView({ behavior: 'smooth', block: 'start' });
          },
          onDelete: async u => {
            const response = await chrome.runtime.sendMessage({
              action: 'deleteExtensionManagedUser',
              payload: { email: u.email }
            });
            if (!response?.success) {
              alert(String(response?.error || 'Could not delete user.'));
              return;
            }
            await AuditLog.append(AUDIT_EVENT_TYPES.USER_DELETED, { email: u.email }, state.actorEmail);
            state.management = response.management;
            document.dispatchEvent(new CustomEvent('authMgmt:userDeleted', { detail: { email: u.email } }));
            render();
          }
        });
        target.appendChild(card);
      });
    }

    renderUserList(listContainer);
    container.appendChild(listContainer);

    // Refresh button
    const refreshRow = document.createElement('div');
    refreshRow.style.cssText = 'margin-top:12px;display:flex;justify-content:flex-end;';
    const refreshBtn = makeButton('Refresh List', 'btn-ghost', async () => {
      refreshBtn.disabled = true;
      refreshBtn.textContent = 'Refreshing…';
      await refresh({ forceRefresh: true });
      refreshBtn.disabled = false;
      refreshBtn.textContent = 'Refresh List';
    });
    refreshRow.appendChild(refreshBtn);
    container.appendChild(refreshRow);
  }

  // ── Invites Tab ───────────────────────────────────────────────────────────

  async function renderInvitesTab(container) {
    container.innerHTML = '';

    const intro = document.createElement('div');
    intro.style.cssText = 'font-size:12px;color:#374151;margin-bottom:12px;line-height:1.5;';
    intro.innerHTML = `Generate a <strong>single-use invite token</strong> to onboard a teammate.
      Share the token out-of-band. When they redeem it, their role and features are pre-configured.`;
    container.appendChild(intro);

    // Create invite form
    const createBox = document.createElement('div');
    createBox.style.cssText = 'background:#f8fafc;border:1px solid #e5e7eb;border-radius:10px;padding:12px;margin-bottom:12px;';

    const createTitle = document.createElement('div');
    createTitle.style.cssText = 'font-size:12px;font-weight:700;margin-bottom:8px;color:#111827;';
    createTitle.textContent = 'New Invite Token';

    const roleLabel = document.createElement('label');
    roleLabel.style.cssText = 'font-size:11px;font-weight:600;color:#374151;display:block;margin-bottom:4px;';
    roleLabel.textContent = 'Role for invited user';
    const roleSelect = document.createElement('select');
    roleSelect.id = 'inviteRoleSelect';
    roleSelect.style.cssText = 'width:100%;box-sizing:border-box;margin-bottom:8px;';
    [
      { value: 'user', label: 'User' },
      { value: 'super_admin', label: 'Super Admin' },
    ].forEach(opt => {
      const o = document.createElement('option');
      o.value = opt.value;
      o.textContent = opt.label;
      roleSelect.appendChild(o);
    });

    const expiryLabel = document.createElement('label');
    expiryLabel.style.cssText = 'font-size:11px;font-weight:600;color:#374151;display:block;margin-bottom:4px;';
    expiryLabel.textContent = 'Expires in';
    const expirySelect = document.createElement('select');
    expirySelect.id = 'inviteExpirySelect';
    expirySelect.style.cssText = 'width:100%;box-sizing:border-box;margin-bottom:8px;';
    [24, 48, 72, 168].forEach(h => {
      const o = document.createElement('option');
      o.value = h;
      o.textContent = h < 48 ? `${h} hours` : `${h / 24} days`;
      if (h === 72) o.selected = true;
      expirySelect.appendChild(o);
    });

    const featLabel2 = document.createElement('label');
    featLabel2.style.cssText = 'font-size:11px;font-weight:600;color:#374151;display:block;margin-bottom:6px;';
    featLabel2.textContent = 'Pre-select features';
    const inviteFeatContainer = document.createElement('div');
    renderFeatureMatrix(inviteFeatContainer, state.catalog, [], 'user');

    roleSelect.addEventListener('change', () => {
      renderFeatureMatrix(inviteFeatContainer, state.catalog,
        roleSelect.value === 'super_admin' ? state.catalog.map(f => f.key) : [],
        roleSelect.value
      );
    });

    const createStatus = document.createElement('div');
    createStatus.className = 'validation-badge neutral';
    createStatus.style.cssText = 'margin-top:8px;display:none;';

    const createBtn = makeButton('Generate Invite Token', '', async () => {
      createBtn.disabled = true;
      createBtn.textContent = 'Generating…';
      createStatus.style.display = 'block';
      statusBadge(createStatus, 'Creating…', 'neutral');

      const role      = el('inviteRoleSelect')?.value || 'user';
      const expiresIn = Number(el('inviteExpirySelect')?.value || 72);
      const features  = getChecked(inviteFeatContainer);

      try {
        const token = await InviteTokens.create({ role, features, expiresInHours: expiresIn, createdBy: state.actorEmail });
        await AuditLog.append(AUDIT_EVENT_TYPES.INVITE_CREATED, { role, expiresIn }, state.actorEmail);
        state.inviteTokens = await InviteTokens.getAll();
        statusBadge(createStatus, `✓ Token created. Share it securely: ${token.token}`, 'valid');

        // Copy to clipboard automatically
        navigator.clipboard.writeText(token.token).catch(() => {});

        render();
      } catch (err) {
        statusBadge(createStatus, String(err?.message || 'Could not create token.'), 'invalid');
        createBtn.disabled = false;
        createBtn.textContent = 'Generate Invite Token';
      }
    });
    createBtn.style.cssText = 'width:100%;background:#2563eb;color:#fff;margin-top:10px;font-weight:600;';

    createBox.append(createTitle, roleLabel, roleSelect, expiryLabel, expirySelect, featLabel2, inviteFeatContainer, createStatus, createBtn);
    container.appendChild(createBox);

    container.appendChild(makeDivider('Existing Tokens'));

    const tokens = state.inviteTokens;
    if (tokens.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = 'text-align:center;padding:16px;color:#9ca3af;font-size:12px;';
      empty.textContent = 'No invite tokens yet.';
      container.appendChild(empty);
    } else {
      tokens.forEach(token => {
        const card = renderInviteTokenCard(token, state.catalog, async (tokenId) => {
          await InviteTokens.revoke(tokenId);
          await AuditLog.append(AUDIT_EVENT_TYPES.INVITE_REVOKED, { tokenId }, state.actorEmail);
          state.inviteTokens = await InviteTokens.getAll();
          render();
        });
        container.appendChild(card);
      });
    }

    // Redeem section for non-owners who landed here somehow
    container.appendChild(makeDivider('Redeem an Invite'));
    const redeemBox = document.createElement('div');
    redeemBox.style.cssText = 'background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:10px;';
    const redeemTitle = document.createElement('div');
    redeemTitle.style.cssText = 'font-size:11px;font-weight:700;color:#166534;margin-bottom:6px;';
    redeemTitle.textContent = 'Have an invite token?';
    const redeemInput = document.createElement('input');
    redeemInput.type = 'text';
    redeemInput.placeholder = 'Paste token…';
    redeemInput.style.cssText = 'width:100%;box-sizing:border-box;margin-bottom:6px;';
    const redeemStatus = document.createElement('div');
    redeemStatus.className = 'validation-badge neutral';
    redeemStatus.style.display = 'none';
    const redeemBtn = makeButton('Redeem Token', '', async () => {
      const tokenValue = String(redeemInput.value || '').trim();
      if (!tokenValue) return;
      redeemBtn.disabled = true;
      redeemStatus.style.display = 'block';
      statusBadge(redeemStatus, 'Redeeming…', 'neutral');
      const redeemed = await InviteTokens.redeem(tokenValue, state.actorEmail);
      if (!redeemed) {
        statusBadge(redeemStatus, 'Invalid, expired, or already used token.', 'invalid');
      } else {
        // Auto-register user with the pre-configured role/features
        const response = await chrome.runtime.sendMessage({
          action: 'saveExtensionManagedUser',
          payload: { email: state.actorEmail, role: redeemed.role, features: redeemed.features }
        });
        if (response?.success) {
          await AuditLog.append(AUDIT_EVENT_TYPES.INVITE_USED, { tokenId: redeemed.id }, state.actorEmail);
          statusBadge(redeemStatus, `✓ Access granted as ${ROLE_LABELS[redeemed.role] || redeemed.role}!`, 'valid');
          state.management = response.management;
          setTimeout(() => render(), 800);
        } else {
          statusBadge(redeemStatus, String(response?.error || 'Could not apply invite.'), 'invalid');
        }
      }
      redeemBtn.disabled = false;
    });
    redeemBox.append(redeemTitle, redeemInput, redeemStatus, redeemBtn);
    container.appendChild(redeemBox);
  }

  // ── Audit Tab ─────────────────────────────────────────────────────────────

  async function renderAuditTab(container) {
    container.innerHTML = '';

    const header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;';
    const title = document.createElement('div');
    title.style.cssText = 'font-size:12px;font-weight:700;color:#374151;';
    title.textContent = `Activity Log (last ${state.auditEntries.length} events)`;

    const clearBtn = makeButton('Clear Log', 'btn-ghost', async () => {
      if (!confirm('Clear the full audit log?')) return;
      await AuditLog.clear();
      state.auditEntries = [];
      render();
    });
    clearBtn.style.fontSize = '10px';

    header.append(title, clearBtn);
    container.appendChild(header);

    if (state.auditEntries.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = 'text-align:center;padding:20px;color:#9ca3af;font-size:12px;';
      empty.textContent = 'No activity recorded yet.';
      container.appendChild(empty);
      return;
    }

    const logWrap = document.createElement('div');
    logWrap.style.cssText = 'max-height:320px;overflow-y:auto;';
    state.auditEntries.forEach(entry => logWrap.appendChild(renderAuditEntry(entry)));
    container.appendChild(logWrap);

    // Export button
    const exportBtn = makeButton('Export as JSON', 'btn-ghost', () => {
      const json = JSON.stringify(state.auditEntries, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `mailroomnav-audit-${Date.now()}.json`;
      a.click();
    });
    exportBtn.style.cssText = 'margin-top:10px;width:100%;';
    container.appendChild(exportBtn);
  }

  // ── Bootstrap Tab (shown when no users exist) ─────────────────────────────

  async function renderBootstrapState(root) {
    root.innerHTML = '';
    renderBootstrapFlow(root, {
      currentEmail: state.actorEmail,
      onBootstrap: async (email) => {
        const response = await chrome.runtime.sendMessage({
          action: 'saveExtensionManagedUser',
          payload: { email, role: 'super_admin', features: state.catalog.map(f => f.key) }
        });
        if (!response?.success) throw new Error(response?.error || 'Bootstrap failed.');
        await AuditLog.append(AUDIT_EVENT_TYPES.BOOTSTRAP, { email }, email);
        state.management = response.management;
        document.dispatchEvent(new CustomEvent('authMgmt:userSaved', { detail: { email, role: 'super_admin' } }));
        setTimeout(() => render(), 600);
      }
    });
  }

  // ── Main render ───────────────────────────────────────────────────────────

  async function render() {
    const root = rootContainer;
    if (!root) return;

    // Load fresh data
    const [tokens, audit] = await Promise.all([
      InviteTokens.getAll(),
      AuditLog.getRecent(80),
    ]);
    state.inviteTokens = tokens;
    state.auditEntries = audit;

    const users = Array.isArray(state.management?.users) ? state.management.users : [];

    // If no super_admin exists yet — show bootstrap
    const hasSuperAdmin = users.some(u => u.role === 'super_admin');
    if (!hasSuperAdmin) {
      await renderBootstrapState(root);
      return;
    }

    // Build tab structure
    root.innerHTML = '';
    renderTabBar(root);

    const tabContent = document.createElement('div');
    tabContent.id = 'authMgmt_tabContent';

    switch (state.activeTab) {
      case 'users':
        await renderUsersTab(tabContent);
        break;
      case 'invites':
        await renderInvitesTab(tabContent);
        break;
      case 'audit':
        await renderAuditTab(tabContent);
        break;
      default:
        await renderUsersTab(tabContent);
    }

    root.appendChild(tabContent);
  }

  // ── Public: refresh data from background ─────────────────────────────────

  async function refresh({ forceRefresh = false } = {}) {
    try {
      const response = await chrome.runtime.sendMessage({
        action: 'getExtensionUserManagement',
        payload: { forceRefresh }
      });
      if (response?.success && response?.management) {
        state.management = {
          ...response.management,
          users: Array.isArray(response.management.users)
            ? response.management.users
            : Object.values(response.management.users || {})
        };
        state.catalog = Array.isArray(response.management.featureCatalog)
          ? response.management.featureCatalog
          : state.catalog;
      }
    } catch (e) {
      console.warn('[AuthManagement] refresh failed:', e);
    }
    await render();
  }

  // ── Public: init ──────────────────────────────────────────────────────────

  async function init(panelContext = {}) {
    state.panelCallbacks = panelContext;
    state.actorEmail     = panelContext?.accessState?.email || '';
    state.catalog        = panelContext?.featureCatalog || [];

    // Normalize management.users to always be an array
    const rawMgmt = panelContext?.management || {};
    state.management = {
      ...rawMgmt,
      users: Array.isArray(rawMgmt.users)
        ? rawMgmt.users
        : Object.values(rawMgmt.users || {})
    };

    rootContainer = getOrCreateRoot();
    if (!rootContainer) return;

    await render();
  }

  return { init, refresh, render };
})();

// ─── Export ───────────────────────────────────────────────────────────────────

export { AuthManagement, AuditLog, InviteTokens };
