/*
 * Advanced owner-only access-management UI for MailroomNavigator.
 *
 * Important constraint:
 * - This module is a panel-side presentation layer only.
 * - The existing background/service access-control flow remains the source of truth.
 * - We intentionally do not implement panel-local invite tokens or synthetic roles,
 *   because those would diverge from the shared access-control policy.
 */

const AUDIT_LOG_STORAGE_KEY = 'mailroomNavAuditLogV1';
const MAX_AUDIT_ENTRIES = 200;

const AUDIT_EVENT_TYPES = Object.freeze({
  USER_CREATED: 'user_created',
  USER_UPDATED: 'user_updated',
  USER_DELETED: 'user_deleted',
  REQUEST_REJECTED: 'request_rejected',
  REQUEST_ARCHIVED: 'request_archived',
});

const ROLE_LABELS = Object.freeze({
  owner: 'Owner',
  admin: 'Admin',
  user: 'User',
});

const ROLE_HELP = Object.freeze({
  admin: 'Admin label plus the selected feature set. Admin does not imply all features.',
  user: 'Only the selected features are enabled.',
});

const REQUEST_STATUS_LABELS = Object.freeze({
  pending: 'Pending',
  approved: 'Approved',
  rejected: 'Rejected',
});

const REQUEST_STATUS_COLORS = Object.freeze({
  pending: '#d97706',
  approved: '#16a34a',
  rejected: '#dc2626',
});

function byId(id) {
  return document.getElementById(id);
}

function all(selector, root = document) {
  return [...root.querySelectorAll(selector)];
}

function sanitizeEmail(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return /^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/i.test(normalized) ? normalized : '';
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDate(iso) {
  if (!iso) return 'Unknown';
  try {
    const parsed = new Date(iso);
    if (Number.isNaN(parsed.getTime())) return String(iso);
    return parsed.toLocaleString();
  } catch {
    return String(iso);
  }
}

function debounce(fn, waitMs = 200) {
  let timer = null;
  return (...args) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => fn(...args), waitMs);
  };
}

function setStatus(node, message, tone = 'neutral') {
  if (!node) return;
  node.classList.remove('neutral', 'valid', 'invalid');
  node.classList.add(tone === 'valid' ? 'valid' : tone === 'invalid' ? 'invalid' : 'neutral');
  node.textContent = String(message || '').trim();
}

function describeAlert(alert) {
  if (!alert?.attempted) return '';
  if (alert.success) return ' Slack alert sent.';
  return ` Slack alert failed: ${String(alert.error || 'unknown error').trim().slice(0, 120)}`;
}

function normalizeManagement(rawManagement = {}) {
  return {
    ...rawManagement,
    users: Array.isArray(rawManagement?.users)
      ? rawManagement.users
      : Object.values(rawManagement?.users || {}),
    requests: Array.isArray(rawManagement?.requests)
      ? rawManagement.requests
      : Object.values(rawManagement?.requests || {}),
    featureCatalog: Array.isArray(rawManagement?.featureCatalog)
      ? rawManagement.featureCatalog
      : [],
    counts: rawManagement?.counts && typeof rawManagement.counts === 'object'
      ? rawManagement.counts
      : {},
  };
}

function normalizeFeatureCatalog(featureCatalog = []) {
  return Array.isArray(featureCatalog)
    ? featureCatalog.filter((feature) => feature && feature.key && feature.label)
    : [];
}

function createButton(label, className = '', onClick = null) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `btn btn-sm ${className}`.trim();
  button.textContent = label;
  if (typeof onClick === 'function') {
    button.addEventListener('click', onClick);
  }
  return button;
}

function createSummaryCard(label, value, tone = '#2563eb') {
  const card = document.createElement('div');
  card.className = 'auth-stat-card';
  card.innerHTML = `
    <div class="stat-value" style="color:${tone};">${escapeHtml(String(value))}</div>
    <div class="stat-label">${escapeHtml(label)}</div>
  `;
  return card;
}

function createRoleBadge(role) {
  const badge = document.createElement('span');
  badge.className = `role-badge role-badge--${role === 'admin' ? 'admin' : role === 'owner' ? 'owner' : 'user'}`;
  badge.textContent = ROLE_LABELS[role] || role;
  return badge;
}

function createRequestStatusBadge(status) {
  const normalizedStatus = String(status || 'pending').trim().toLowerCase();
  const badge = document.createElement('span');
  badge.className = 'role-badge';
  badge.style.background = REQUEST_STATUS_COLORS[normalizedStatus] || '#6b7280';
  badge.textContent = REQUEST_STATUS_LABELS[normalizedStatus] || normalizedStatus;
  return badge;
}

function renderFeatureMatrix(container, catalog, selectedFeatures = [], role = 'user') {
  if (!container) return;
  const selected = new Set(Array.isArray(selectedFeatures) ? selectedFeatures : []);
  container.innerHTML = '';

  const grid = document.createElement('div');
  grid.style.display = 'grid';
  grid.style.gridTemplateColumns = '1fr 1fr';
  grid.style.gap = '4px';

  catalog.forEach((feature) => {
    const label = document.createElement('label');
    label.style.display = 'flex';
    label.style.alignItems = 'flex-start';
    label.style.gap = '6px';
    label.style.padding = '6px 8px';
    label.style.border = '1px solid #e5e7eb';
    label.style.borderRadius = '6px';
    label.style.background = selected.has(feature.key) ? '#eff6ff' : '#fff';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = feature.key;
    checkbox.checked = selected.has(feature.key);
    checkbox.disabled = role === 'owner';
    checkbox.addEventListener('change', () => {
      label.style.background = checkbox.checked ? '#eff6ff' : '#fff';
    });

    const copy = document.createElement('div');
    copy.innerHTML = `
      <div style="font-size:12px;font-weight:600;color:#1f2937;">${escapeHtml(feature.label)}</div>
      <div style="font-size:10px;color:#6b7280;margin-top:1px;">${escapeHtml(feature.description || '')}</div>
    `;

    label.append(checkbox, copy);
    grid.appendChild(label);
  });

  container.appendChild(grid);
}

function getSelectedFeatures(container) {
  return all('input[type="checkbox"]:checked', container)
    .map((checkbox) => String(checkbox.value || '').trim())
    .filter(Boolean);
}

function buildDiagnosticsText(diagnostics = null, accessState = null) {
  const lines = [];
  const actorEmail = sanitizeEmail(accessState?.email);
  lines.push(`Current BetterLetter user: ${actorEmail || 'not detected'}`);
  lines.push(`Access role: ${accessState?.role || 'none'}`);
  lines.push(`Detection source: ${accessState?.detectionSource || 'none'}`);
  lines.push(`Access allowed: ${accessState?.allowed ? 'yes' : 'no'}`);
  lines.push('');

  if (!diagnostics || typeof diagnostics !== 'object') {
    lines.push('Diagnostics unavailable.');
    return lines.join('\n');
  }

  lines.push(`Panel hostTabId: ${diagnostics.preferredTabId ?? 'none'}`);
  if (diagnostics?.storedSnapshot?.email) {
    lines.push(`Stored snapshot: ${diagnostics.storedSnapshot.email} (${diagnostics.storedSnapshot.source || 'unknown'})`);
  } else {
    lines.push('Stored snapshot: none');
  }

  const tabs = Array.isArray(diagnostics?.tabs) ? diagnostics.tabs : [];
  lines.push(`Candidate tabs: ${tabs.length}`);

  tabs.slice(0, 4).forEach((tab, index) => {
    lines.push('');
    lines.push(`[${index + 1}] tabId=${tab.tabId} active=${tab.active ? 'yes' : 'no'} status=${tab.status || 'unknown'}`);
    if (tab.url) lines.push(`url: ${tab.url}`);
    if (tab.datasetEmail || tab.datasetSource) {
      lines.push(`dataset: ${tab.datasetEmail || 'none'}${tab.datasetSource ? ` (${tab.datasetSource})` : ''}`);
    }
    if (tab.mainWorld?.email || tab.mainWorld?.source) {
      lines.push(`main: ${tab.mainWorld.email || 'none'}${tab.mainWorld.source ? ` (${tab.mainWorld.source})` : ''}`);
    }
    if (tab.routeProbe?.email || tab.routeProbe?.source) {
      lines.push(`route: ${tab.routeProbe.email || 'none'}${tab.routeProbe.source ? ` (${tab.routeProbe.source})` : ''}`);
    }
    if (tab.error) lines.push(`error: ${tab.error}`);
  });

  return lines.join('\n');
}

const AuditLog = (() => {
  async function loadAll() {
    try {
      const result = await chrome.storage.local.get([AUDIT_LOG_STORAGE_KEY]);
      return Array.isArray(result?.[AUDIT_LOG_STORAGE_KEY]) ? result[AUDIT_LOG_STORAGE_KEY] : [];
    } catch {
      return [];
    }
  }

  async function saveAll(entries) {
    await chrome.storage.local.set({
      [AUDIT_LOG_STORAGE_KEY]: entries.slice(0, MAX_AUDIT_ENTRIES),
    });
  }

  async function append(type, detail = {}, actorEmail = '') {
    const nextEntry = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`,
      type: String(type || ''),
      actor: sanitizeEmail(actorEmail) || 'unknown',
      detail: detail && typeof detail === 'object' ? { ...detail } : { raw: String(detail || '') },
      timestamp: new Date().toISOString(),
    };
    const entries = await loadAll();
    entries.unshift(nextEntry);
    await saveAll(entries);
    return nextEntry;
  }

  async function getRecent(limit = 50) {
    const entries = await loadAll();
    return entries.slice(0, Math.max(0, Number(limit) || 0));
  }

  async function clear() {
    await chrome.storage.local.remove([AUDIT_LOG_STORAGE_KEY]);
  }

  return {
    append,
    getRecent,
    clear,
  };
})();

const AuthManagement = (() => {
  let rootNode = null;
  let state = {
    accessState: null,
    management: { users: [], requests: [], featureCatalog: [] },
    featureCatalog: [],
    actorEmail: '',
    editingEmail: '',
    draftRequest: null,
    activeTab: 'users',
    searchQuery: '',
    roleFilter: 'all',
    requestSearchQuery: '',
    requestStatusFilter: 'all',
    auditEntries: [],
    serviceHealth: null,
    identityDiagnostics: null,
    migrationStatusMessage: '',
    migrationStatusTone: 'neutral',
    callbacks: {},
  };

  function getOrCreateRoot() {
    const existing = byId('authMgmtRoot');
    if (existing) return existing;

    const section = byId('extensionUserManagementSection');
    if (!section) return null;
    const bodyHost = byId('extensionUserManagementSectionBody') || section;

    if (!bodyHost.dataset.authManagementFallbackHtml) {
      bodyHost.dataset.authManagementFallbackHtml = bodyHost.innerHTML;
    }

    bodyHost.innerHTML = '';
    section.style.display = 'block';

    const root = document.createElement('div');
    root.id = 'authMgmtRoot';

    bodyHost.append(root);
    return root;
  }

  function syncContext(panelContext = {}) {
    if (panelContext.accessState) {
      state.accessState = panelContext.accessState;
      state.actorEmail = sanitizeEmail(panelContext.accessState?.email);
    }
    if (panelContext.management) {
      state.management = normalizeManagement(panelContext.management);
    }
    if (panelContext.featureCatalog) {
      state.featureCatalog = normalizeFeatureCatalog(panelContext.featureCatalog);
    } else if (state.management?.featureCatalog?.length > 0) {
      state.featureCatalog = normalizeFeatureCatalog(state.management.featureCatalog);
    }
    if (panelContext.callbacks && typeof panelContext.callbacks === 'object') {
      state.callbacks = {
        ...state.callbacks,
        ...panelContext.callbacks,
      };
    }
  }

  async function loadServiceDiagnostics({ forceRefresh = false } = {}) {
    const callbacks = state.callbacks || {};
    try {
      if (typeof callbacks.getAccessServiceHealth === 'function') {
        state.serviceHealth = await callbacks.getAccessServiceHealth({ forceRefresh });
      }
    } catch (error) {
      state.serviceHealth = {
        error: String(error?.message || 'Could not load service health.').trim(),
      };
    }

    try {
      if (typeof callbacks.getIdentityDiagnostics === 'function') {
        state.identityDiagnostics = await callbacks.getIdentityDiagnostics({ forceRefresh: true });
      }
    } catch (error) {
      state.identityDiagnostics = {
        error: String(error?.message || 'Could not load identity diagnostics.').trim(),
      };
    }
  }

  function renderTabBar(root) {
    const tabBar = document.createElement('div');
    tabBar.className = 'auth-tab-bar';
    tabBar.style.display = 'flex';
    tabBar.style.gap = '4px';
    tabBar.style.marginBottom = '14px';
    tabBar.style.background = '#f3f4f6';
    tabBar.style.borderRadius = '8px';
    tabBar.style.padding = '3px';

    [
      { id: 'users', label: 'Users' },
      { id: 'requests', label: 'Requests' },
      { id: 'audit', label: 'Audit' },
      { id: 'service', label: 'Service' },
    ].forEach((tab) => {
      const button = createButton(tab.label, state.activeTab === tab.id ? 'active-tab' : '', async () => {
        state.activeTab = tab.id;
        if (tab.id === 'service') {
          await loadServiceDiagnostics({ forceRefresh: false });
        }
        await render();
      });
      button.style.flex = '1';
      tabBar.appendChild(button);
    });

    root.appendChild(tabBar);
  }

  function renderOwnerPill(container) {
    const pill = document.createElement('div');
    pill.className = 'auth-owner-pill';

    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.textContent = (state.actorEmail[0] || '?').toUpperCase();

    const text = document.createElement('div');
    text.style.fontSize = '11px';
    text.innerHTML = `<strong>${escapeHtml(state.actorEmail || 'unknown')}</strong><br>Owner account. Access-control policy changes apply through the existing background/service flow.`;

    pill.append(avatar, text);
    container.appendChild(pill);
  }

  function renderUserForm(container) {
    container.innerHTML = '';

    const isEditing = Boolean(state.editingEmail);
    const draftRequest = !isEditing && state.draftRequest && typeof state.draftRequest === 'object'
      ? state.draftRequest
      : null;
    const currentUser = isEditing
      ? state.management.users.find((user) => user.email === state.editingEmail)
      : null;
    const activeRole = (currentUser?.role === 'admin' ? 'admin' : draftRequest?.role === 'admin' ? 'admin' : 'user');
    const activeFeatures = currentUser?.features || draftRequest?.features || [];

    const card = document.createElement('div');
    card.className = 'auth-card';
    card.style.marginTop = '0';
    card.style.padding = '14px';
    card.style.background = isEditing ? '#fffbeb' : '#f8fafc';

    const title = document.createElement('div');
    title.style.fontSize = '13px';
    title.style.fontWeight = '700';
    title.style.marginBottom = '10px';
    title.textContent = isEditing
      ? `Editing ${state.editingEmail}`
      : draftRequest?.email
        ? `Prepare Access Grant for ${draftRequest.email}`
        : 'Add Managed User';
    card.appendChild(title);

    if (!isEditing) {
      const emailLabel = document.createElement('label');
      emailLabel.textContent = 'BetterLetter Email';
      const emailInput = document.createElement('input');
      emailInput.id = 'authMgmt_emailInput';
      emailInput.type = 'email';
      emailInput.placeholder = 'e.g. teammate@betterletter.ai';
      emailInput.autocomplete = 'off';
      emailInput.value = draftRequest?.email || '';
      emailInput.style.marginBottom = '8px';
      card.append(emailLabel, emailInput);
    }

    const roleLabel = document.createElement('label');
    roleLabel.textContent = 'Role';
    const roleSelect = document.createElement('select');
    roleSelect.id = 'authMgmt_roleSelect';
    [
      { value: 'user', label: 'User' },
      { value: 'admin', label: 'Admin' },
    ].forEach((optionDef) => {
      const option = document.createElement('option');
      option.value = optionDef.value;
      option.textContent = optionDef.label;
      if (activeRole === optionDef.value) option.selected = true;
      roleSelect.appendChild(option);
    });
    card.append(roleLabel, roleSelect);

    const roleHelp = document.createElement('div');
    roleHelp.style.fontSize = '10px';
    roleHelp.style.color = '#6b7280';
    roleHelp.style.margin = '4px 0 10px';
    roleHelp.textContent = ROLE_HELP[activeRole];
    card.appendChild(roleHelp);

    const featureLabel = document.createElement('label');
    featureLabel.textContent = 'Enabled Features';
    const featureContainer = document.createElement('div');
    featureContainer.id = 'authMgmt_featContainer';
    card.append(featureLabel, featureContainer);
    renderFeatureMatrix(featureContainer, state.featureCatalog, activeFeatures, activeRole);

    roleSelect.addEventListener('change', () => {
      roleHelp.textContent = ROLE_HELP[roleSelect.value] || '';
    });

    const status = document.createElement('div');
    status.className = 'validation-badge neutral';
    status.style.display = 'none';
    status.style.marginTop = '10px';

    const actions = document.createElement('div');
    actions.style.display = 'flex';
    actions.style.gap = '6px';
    actions.style.marginTop = '10px';

    const saveButton = createButton(isEditing ? 'Update User' : 'Save User', '', async () => {
      const email = isEditing
        ? state.editingEmail
        : sanitizeEmail(byId('authMgmt_emailInput')?.value);
      const role = String(byId('authMgmt_roleSelect')?.value || 'user').trim().toLowerCase() === 'admin'
        ? 'admin'
        : 'user';
      const features = getSelectedFeatures(featureContainer);

      if (!email) {
        status.style.display = 'block';
        setStatus(status, 'Enter a valid BetterLetter user email.', 'invalid');
        return;
      }

      saveButton.disabled = true;
      status.style.display = 'block';
      setStatus(status, isEditing ? `Updating ${email}...` : `Saving ${email}...`, 'neutral');

      try {
        const response = await chrome.runtime.sendMessage({
          action: 'saveExtensionManagedUser',
          payload: { email, role, features },
        });
        if (!response?.success || !response?.management) {
          throw new Error(String(response?.error || 'Could not save user.').trim());
        }

        state.management = normalizeManagement(response.management);
        state.editingEmail = '';
        if (state.draftRequest?.email === email) state.draftRequest = null;

        await AuditLog.append(
          isEditing ? AUDIT_EVENT_TYPES.USER_UPDATED : AUDIT_EVENT_TYPES.USER_CREATED,
          { email, role, features },
          state.actorEmail,
        );

        setStatus(status, `Saved ${email}.${describeAlert(response.alert)}`.trim(), 'valid');
        document.dispatchEvent(new CustomEvent('authMgmt:userSaved', { detail: { email, role } }));
        window.setTimeout(() => {
          render().catch(() => undefined);
        }, 300);
      } catch (error) {
        setStatus(status, String(error?.message || 'Could not save user.').trim(), 'invalid');
      } finally {
        saveButton.disabled = false;
      }
    });
    saveButton.style.flex = '1';

    const clearButton = createButton(isEditing ? 'Cancel' : 'Clear Form', 'btn-ghost', () => {
      state.editingEmail = '';
      state.draftRequest = null;
      render().catch(() => undefined);
    });
    clearButton.style.flex = '1';

    actions.append(saveButton, clearButton);
    card.append(status, actions);
    container.appendChild(card);
  }

  function renderUserCard(user) {
    const card = document.createElement('div');
    card.className = 'auth-card';

    const header = document.createElement('div');
    header.style.display = 'flex';
    header.style.justifyContent = 'space-between';
    header.style.alignItems = 'center';
    header.style.gap = '8px';

    const identity = document.createElement('div');
    identity.style.minWidth = '0';
    identity.innerHTML = `<div style="font-size:12px;font-weight:600;color:#111827;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(user.email)}</div>`;

    const meta = document.createElement('div');
    meta.style.display = 'flex';
    meta.style.alignItems = 'center';
    meta.style.gap = '6px';
    meta.style.marginTop = '4px';
    meta.appendChild(createRoleBadge(user.role));

    const updated = document.createElement('span');
    updated.style.fontSize = '10px';
    updated.style.color = '#9ca3af';
    updated.textContent = `Updated ${formatDate(user.updatedAt || user.createdAt)}`;
    meta.appendChild(updated);
    identity.appendChild(meta);

    const actions = document.createElement('div');
    actions.style.display = 'flex';
    actions.style.gap = '6px';

    const editButton = createButton('Edit', 'btn-ghost', () => {
      state.editingEmail = user.email;
      render().then(() => {
        byId('authMgmtRoot')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }).catch(() => undefined);
    });

    const deleteButton = createButton('Delete', '', async () => {
      if (!window.confirm(`Delete ${user.email} from MailroomNavigator access?`)) return;
      deleteButton.disabled = true;
      editButton.disabled = true;
      try {
        const response = await chrome.runtime.sendMessage({
          action: 'deleteExtensionManagedUser',
          payload: { email: user.email },
        });
        if (!response?.success || !response?.management) {
          throw new Error(String(response?.error || 'Could not delete user.').trim());
        }

        state.management = normalizeManagement(response.management);
        if (state.editingEmail === user.email) state.editingEmail = '';

        await AuditLog.append(
          AUDIT_EVENT_TYPES.USER_DELETED,
          { email: user.email },
          state.actorEmail,
        );

        document.dispatchEvent(new CustomEvent('authMgmt:userDeleted', { detail: { email: user.email, alert: response.alert || null } }));
        await render();
      } catch (error) {
        window.alert(String(error?.message || 'Could not delete user.').trim());
      } finally {
        deleteButton.disabled = false;
        editButton.disabled = false;
      }
    });
    deleteButton.style.background = '#dc2626';

    actions.append(editButton, deleteButton);
    header.append(identity, actions);

    const featureRow = document.createElement('div');
    featureRow.style.display = 'flex';
    featureRow.style.flexWrap = 'wrap';
    featureRow.style.gap = '4px';
    featureRow.style.marginTop = '8px';

    const featureKeys = Array.isArray(user.features) ? user.features : [];
    if (featureKeys.length === 0) {
      const empty = document.createElement('span');
      empty.style.fontSize = '11px';
      empty.style.color = '#9ca3af';
      empty.textContent = 'No features enabled';
      featureRow.appendChild(empty);
    } else {
      featureKeys.forEach((featureKey) => {
        const feature = state.featureCatalog.find((entry) => entry.key === featureKey);
        const chip = document.createElement('span');
        chip.style.fontSize = '10px';
        chip.style.padding = '2px 7px';
        chip.style.borderRadius = '10px';
        chip.style.background = '#eff6ff';
        chip.style.color = '#1d4ed8';
        chip.style.border = '1px solid #bfdbfe';
        chip.textContent = feature?.label || featureKey;
        featureRow.appendChild(chip);
      });
    }

    card.append(header, featureRow);
    return card;
  }

  function renderRequestCard(request) {
    // Requests come from the shared access store, not from local panel state.
    // The owner can either reject/archive them here or load them into the
    // standard grant form so approval still uses saveExtensionManagedUser.
    const card = document.createElement('div');
    card.className = 'auth-card';

    const header = document.createElement('div');
    header.style.display = 'flex';
    header.style.justifyContent = 'space-between';
    header.style.alignItems = 'flex-start';
    header.style.gap = '8px';

    const identity = document.createElement('div');
    identity.style.minWidth = '0';
    identity.innerHTML = `<div style="font-size:12px;font-weight:600;color:#111827;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(request.email)}</div>`;

    const meta = document.createElement('div');
    meta.style.display = 'flex';
    meta.style.alignItems = 'center';
    meta.style.gap = '6px';
    meta.style.marginTop = '4px';
    meta.appendChild(createRequestStatusBadge(request.status));

    const seen = document.createElement('span');
    seen.style.fontSize = '10px';
    seen.style.color = '#9ca3af';
    seen.textContent = `Seen ${formatDate(request.lastSeenAt || request.updatedAt || request.requestedAt)}`;
    meta.appendChild(seen);
    identity.appendChild(meta);

    const actions = document.createElement('div');
    actions.style.display = 'flex';
    actions.style.flexWrap = 'wrap';
    actions.style.justifyContent = 'flex-end';
    actions.style.gap = '6px';

    const prepareButton = createButton('Prepare Grant', 'btn-ghost', () => {
      state.draftRequest = {
        email: request.email,
        role: 'user',
        features: Array.isArray(request.requestedFeatures) ? request.requestedFeatures : [],
      };
      state.editingEmail = '';
      state.activeTab = 'users';
      render().catch(() => undefined);
    });
    actions.appendChild(prepareButton);

    if (request.status !== 'approved') {
      const rejectButton = createButton('Reject', '', async () => {
        if (!window.confirm(`Reject access request for ${request.email}?`)) return;
        rejectButton.disabled = true;
        try {
          const response = await chrome.runtime.sendMessage({
            action: 'reviewExtensionAccessRequest',
            payload: { email: request.email, action: 'reject' },
          });
          if (!response?.success || !response?.management) {
            throw new Error(String(response?.error || 'Could not reject request.').trim());
          }
          state.management = normalizeManagement(response.management);
          await AuditLog.append(AUDIT_EVENT_TYPES.REQUEST_REJECTED, { email: request.email }, state.actorEmail);
          await render();
        } catch (error) {
          window.alert(String(error?.message || 'Could not reject request.').trim());
        } finally {
          rejectButton.disabled = false;
        }
      });
      rejectButton.style.background = '#dc2626';
      actions.appendChild(rejectButton);
    }

    const archiveButton = createButton('Archive', 'btn-ghost', async () => {
      if (!window.confirm(`Archive the request history for ${request.email}?`)) return;
      archiveButton.disabled = true;
      try {
        const response = await chrome.runtime.sendMessage({
          action: 'reviewExtensionAccessRequest',
          payload: { email: request.email, action: 'archive' },
        });
        if (!response?.success || !response?.management) {
          throw new Error(String(response?.error || 'Could not archive request.').trim());
        }
        state.management = normalizeManagement(response.management);
        await AuditLog.append(AUDIT_EVENT_TYPES.REQUEST_ARCHIVED, { email: request.email }, state.actorEmail);
        await render();
      } catch (error) {
        window.alert(String(error?.message || 'Could not archive request.').trim());
      } finally {
        archiveButton.disabled = false;
      }
    });
    actions.appendChild(archiveButton);

    header.append(identity, actions);

    const details = document.createElement('div');
    details.style.display = 'grid';
    details.style.gridTemplateColumns = '1fr 1fr';
    details.style.gap = '8px';
    details.style.marginTop = '10px';

    [
      { label: 'Request Count', value: String(request.requestCount || 0) },
      { label: 'Last IP', value: request.lastIp || 'unknown' },
      { label: 'Requested At', value: request.requestedAt ? formatDate(request.requestedAt) : 'Not explicitly submitted yet' },
      { label: 'Reviewed By', value: request.reviewedBy || 'Not reviewed' },
    ].forEach((item) => {
      const cell = document.createElement('div');
      cell.style.border = '1px solid #e5e7eb';
      cell.style.borderRadius = '8px';
      cell.style.padding = '8px';
      cell.innerHTML = `
        <div style="font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:.04em;">${escapeHtml(item.label)}</div>
        <div style="font-size:12px;color:#111827;margin-top:4px;word-break:break-word;">${escapeHtml(item.value)}</div>
      `;
      details.appendChild(cell);
    });
    card.append(header, details);

    if (Array.isArray(request.requestedFeatures) && request.requestedFeatures.length > 0) {
      const featureRow = document.createElement('div');
      featureRow.style.display = 'flex';
      featureRow.style.flexWrap = 'wrap';
      featureRow.style.gap = '4px';
      featureRow.style.marginTop = '8px';
      request.requestedFeatures.forEach((featureKey) => {
        const feature = state.featureCatalog.find((entry) => entry.key === featureKey);
        const chip = document.createElement('span');
        chip.style.fontSize = '10px';
        chip.style.padding = '2px 7px';
        chip.style.borderRadius = '10px';
        chip.style.background = '#eff6ff';
        chip.style.color = '#1d4ed8';
        chip.style.border = '1px solid #bfdbfe';
        chip.textContent = feature?.label || featureKey;
        featureRow.appendChild(chip);
      });
      card.appendChild(featureRow);
    }

    if (request.note) {
      const note = document.createElement('div');
      note.className = 'validation-badge neutral';
      note.style.marginTop = '8px';
      note.textContent = request.note;
      card.appendChild(note);
    }

    if (Array.isArray(request.ipAddresses) && request.ipAddresses.length > 1) {
      const ipMeta = document.createElement('div');
      ipMeta.style.fontSize = '10px';
      ipMeta.style.color = '#6b7280';
      ipMeta.style.marginTop = '8px';
      ipMeta.textContent = `Recent IPs: ${request.ipAddresses.join(', ')}`;
      card.appendChild(ipMeta);
    }

    if (request.lastUserAgent) {
      const ua = document.createElement('details');
      ua.style.marginTop = '8px';
      const summary = document.createElement('summary');
      summary.style.cursor = 'pointer';
      summary.style.fontSize = '11px';
      summary.style.color = '#374151';
      summary.textContent = 'User agent';
      const code = document.createElement('div');
      code.style.fontSize = '10px';
      code.style.color = '#6b7280';
      code.style.marginTop = '6px';
      code.style.wordBreak = 'break-word';
      code.textContent = request.lastUserAgent;
      ua.append(summary, code);
      card.appendChild(ua);
    }

    return card;
  }

  async function renderUsersTab(container) {
    renderOwnerPill(container);

    const users = Array.isArray(state.management?.users) ? state.management.users : [];
    const requests = Array.isArray(state.management?.requests) ? state.management.requests : [];
    const summary = document.createElement('div');
    summary.style.display = 'grid';
    summary.style.gridTemplateColumns = '1fr 1fr 1fr 1fr';
    summary.style.gap = '6px';
    summary.style.marginBottom = '12px';
    summary.append(
      createSummaryCard('Managed Users', users.length, '#2563eb'),
      createSummaryCard('Admins', users.filter((user) => user.role === 'admin').length, '#0f766e'),
      createSummaryCard('Pending Requests', requests.filter((request) => request.status === 'pending').length, '#d97706'),
      createSummaryCard('Feature Keys', state.featureCatalog.length, '#7c3aed'),
    );
    container.appendChild(summary);

    const isSharedService = Boolean(state.serviceHealth?.usingRemoteConfig && state.serviceHealth?.baseUrl);
    if (!isSharedService && users.length === 0) {
      const localWarning = document.createElement('div');
      localWarning.className = 'validation-badge neutral';
      localWarning.style.marginBottom = '12px';
      localWarning.textContent = 'This machine is using its own local access store. Users granted on another machine will not appear here unless this extension points to the same shared access service, or you import the existing policy in the Service tab.';
      container.appendChild(localWarning);
    }

    const formContainer = document.createElement('div');
    formContainer.id = 'authMgmt_formContainer';
    renderUserForm(formContainer);
    container.appendChild(formContainer);

    const divider = document.createElement('div');
    divider.className = 'auth-divider';
    divider.innerHTML = '<hr><span>Managed Users</span><hr>';
    container.appendChild(divider);

    const searchRow = document.createElement('div');
    searchRow.style.display = 'grid';
    searchRow.style.gridTemplateColumns = '1fr auto';
    searchRow.style.gap = '8px';
    searchRow.style.alignItems = 'end';
    searchRow.style.marginBottom = '10px';

    const searchInput = document.createElement('input');
    searchInput.type = 'search';
    searchInput.placeholder = 'Search users by email';
    searchInput.value = state.searchQuery;
    searchInput.addEventListener('input', debounce((event) => {
      state.searchQuery = String(event?.target?.value || '').trim().toLowerCase();
      render().catch(() => undefined);
    }, 120));

    const roleSelect = document.createElement('select');
    [
      { value: 'all', label: 'All roles' },
      { value: 'admin', label: 'Admin' },
      { value: 'user', label: 'User' },
    ].forEach((optionDef) => {
      const option = document.createElement('option');
      option.value = optionDef.value;
      option.textContent = optionDef.label;
      option.selected = state.roleFilter === optionDef.value;
      roleSelect.appendChild(option);
    });
    roleSelect.addEventListener('change', () => {
      state.roleFilter = roleSelect.value;
      render().catch(() => undefined);
    });

    searchRow.append(searchInput, roleSelect);
    container.appendChild(searchRow);

    const list = document.createElement('div');
    list.id = 'authMgmt_userList';
    const filteredUsers = users.filter((user) => {
      if (state.roleFilter !== 'all' && user.role !== state.roleFilter) return false;
      if (state.searchQuery && !user.email.includes(state.searchQuery)) return false;
      return true;
    });

    if (filteredUsers.length === 0) {
      const empty = document.createElement('div');
      empty.style.padding = '14px 0';
      empty.style.color = '#9ca3af';
      empty.style.fontSize = '12px';
      empty.style.textAlign = 'center';
      empty.textContent = users.length === 0 ? 'No managed users yet.' : 'No users match the current filters.';
      list.appendChild(empty);
    } else {
      filteredUsers.forEach((user) => {
        list.appendChild(renderUserCard(user));
      });
    }
    container.appendChild(list);

    const refreshRow = document.createElement('div');
    refreshRow.style.display = 'flex';
    refreshRow.style.justifyContent = 'flex-end';
    refreshRow.style.marginTop = '12px';
    const refreshButton = createButton('Refresh List', 'btn-ghost', async () => {
      refreshButton.disabled = true;
      refreshButton.textContent = 'Refreshing...';
      await refresh({ forceRefresh: true });
      refreshButton.disabled = false;
      refreshButton.textContent = 'Refresh List';
    });
    refreshRow.appendChild(refreshButton);
    container.appendChild(refreshRow);
  }

  async function renderRequestsTab(container) {
    const requests = Array.isArray(state.management?.requests) ? state.management.requests : [];
    const intro = document.createElement('div');
    intro.className = 'validation-badge neutral';
    intro.style.marginBottom = '10px';
    intro.textContent = 'This queue includes explicit Request Access submissions and recent denied-access observations captured by the shared access service. IPs reflect the machine or proxy reaching that service.';
    container.appendChild(intro);

    const summary = document.createElement('div');
    summary.style.display = 'grid';
    summary.style.gridTemplateColumns = '1fr 1fr 1fr';
    summary.style.gap = '6px';
    summary.style.marginBottom = '12px';
    summary.append(
      createSummaryCard('Pending', requests.filter((request) => request.status === 'pending').length, '#d97706'),
      createSummaryCard('Rejected', requests.filter((request) => request.status === 'rejected').length, '#dc2626'),
      createSummaryCard('Approved History', requests.filter((request) => request.status === 'approved').length, '#16a34a'),
    );
    container.appendChild(summary);

    const filterRow = document.createElement('div');
    filterRow.style.display = 'grid';
    filterRow.style.gridTemplateColumns = '1fr auto';
    filterRow.style.gap = '8px';
    filterRow.style.alignItems = 'end';
    filterRow.style.marginBottom = '10px';

    const searchInput = document.createElement('input');
    searchInput.type = 'search';
    searchInput.placeholder = 'Search requests by email or IP';
    searchInput.value = state.requestSearchQuery;
    searchInput.addEventListener('input', debounce((event) => {
      state.requestSearchQuery = String(event?.target?.value || '').trim().toLowerCase();
      render().catch(() => undefined);
    }, 120));

    const statusFilter = document.createElement('select');
    [
      { value: 'all', label: 'All statuses' },
      { value: 'pending', label: 'Pending' },
      { value: 'rejected', label: 'Rejected' },
      { value: 'approved', label: 'Approved' },
    ].forEach((optionDef) => {
      const option = document.createElement('option');
      option.value = optionDef.value;
      option.textContent = optionDef.label;
      option.selected = state.requestStatusFilter === optionDef.value;
      statusFilter.appendChild(option);
    });
    statusFilter.addEventListener('change', () => {
      state.requestStatusFilter = statusFilter.value;
      render().catch(() => undefined);
    });

    filterRow.append(searchInput, statusFilter);
    container.appendChild(filterRow);

    const filteredRequests = requests.filter((request) => {
      if (state.requestStatusFilter !== 'all' && request.status !== state.requestStatusFilter) return false;
      if (!state.requestSearchQuery) return true;
      const haystack = [
        request.email,
        request.lastIp,
        ...(Array.isArray(request.ipAddresses) ? request.ipAddresses : []),
        request.note,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(state.requestSearchQuery);
    });

    if (filteredRequests.length === 0) {
      const empty = document.createElement('div');
      empty.style.padding = '14px 0';
      empty.style.color = '#9ca3af';
      empty.style.fontSize = '12px';
      empty.style.textAlign = 'center';
      empty.textContent = requests.length === 0
        ? 'No access requests or denied-attempt records yet.'
        : 'No requests match the current filters.';
      container.appendChild(empty);
      return;
    }

    filteredRequests.forEach((request) => {
      container.appendChild(renderRequestCard(request));
    });
  }

  async function renderAuditTab(container) {
    const header = document.createElement('div');
    header.style.display = 'flex';
    header.style.justifyContent = 'space-between';
    header.style.alignItems = 'center';
    header.style.marginBottom = '10px';

    const title = document.createElement('div');
    title.style.fontSize = '12px';
    title.style.fontWeight = '700';
    title.textContent = `Local audit log (${state.auditEntries.length})`;

    const clearButton = createButton('Clear Log', 'btn-ghost', async () => {
      if (!window.confirm('Clear the local audit log on this browser profile?')) return;
      await AuditLog.clear();
      state.auditEntries = [];
      await render();
    });
    header.append(title, clearButton);
    container.appendChild(header);

    const note = document.createElement('div');
    note.className = 'validation-badge neutral';
    note.style.marginBottom = '10px';
    note.textContent = 'This audit view is browser-local. The authoritative access policy still lives in the configured access service.';
    container.appendChild(note);

    if (state.auditEntries.length === 0) {
      const empty = document.createElement('div');
      empty.style.padding = '14px 0';
      empty.style.color = '#9ca3af';
      empty.style.fontSize = '12px';
      empty.style.textAlign = 'center';
      empty.textContent = 'No local audit entries yet.';
      container.appendChild(empty);
      return;
    }

    const scroll = document.createElement('div');
    scroll.className = 'log-scroll';
    state.auditEntries.forEach((entry) => {
      const row = document.createElement('div');
      row.className = 'audit-row';

      const body = document.createElement('div');
      body.style.flex = '1';
      const heading = document.createElement('div');
      heading.style.fontSize = '11px';
      heading.style.fontWeight = '600';
      heading.textContent = `${entry.type.replace(/_/g, ' ')}${entry.detail?.email ? ` - ${entry.detail.email}` : ''}`;

      const detail = document.createElement('div');
      detail.style.fontSize = '10px';
      detail.style.color = '#6b7280';
      detail.style.marginTop = '2px';
      detail.textContent = `${formatDate(entry.timestamp)} by ${entry.actor}`;

      body.append(heading, detail);
      row.appendChild(body);
      scroll.appendChild(row);
    });
    container.appendChild(scroll);
  }

  async function renderServiceTab(container) {
    if (!state.serviceHealth && !state.identityDiagnostics) {
      await loadServiceDiagnostics({ forceRefresh: false });
    }

    const infoCard = document.createElement('div');
    infoCard.className = 'auth-card';
    infoCard.style.marginTop = '0';

    const summary = document.createElement('div');
    summary.className = 'validation-badge neutral';
    const serviceMode = state.serviceHealth?.usingRemoteConfig && state.serviceHealth?.baseUrl
      ? `Shared access service: ${state.serviceHealth.baseUrl}`
      : 'Local access service';
    const ownerLine = state.serviceHealth?.access?.ownerEmail
      ? `Owner: ${state.serviceHealth.access.ownerEmail}`
      : 'Owner: unknown';
    const storageLine = state.serviceHealth?.access?.storage
      ? `Storage: ${state.serviceHealth.access.storage}`
      : 'Storage: unknown';
    setStatus(
      summary,
      state.serviceHealth?.error
        ? `Service health check failed. ${state.serviceHealth.error}`
        : `${serviceMode}\n${ownerLine}\n${storageLine}`,
      state.serviceHealth?.error ? 'invalid' : 'valid',
    );
    infoCard.appendChild(summary);

    const detailGrid = document.createElement('div');
    detailGrid.style.display = 'grid';
    detailGrid.style.gridTemplateColumns = '1fr 1fr';
    detailGrid.style.gap = '8px';
    detailGrid.style.marginTop = '10px';

    [
      { label: 'Current user', value: state.accessState?.email || 'not detected' },
      { label: 'Access role', value: state.accessState?.role || 'none' },
      { label: 'Detection source', value: state.accessState?.detectionSource || 'none' },
      { label: 'Store path', value: state.serviceHealth?.access?.storePath || 'hidden/unavailable' },
      { label: 'Managed users', value: String(state.serviceHealth?.access?.managedUsers ?? '0') },
      { label: 'Pending requests', value: String(state.serviceHealth?.access?.pendingRequests ?? '0') },
      { label: 'Policy updated', value: state.serviceHealth?.access?.policyUpdatedAt ? formatDate(state.serviceHealth.access.policyUpdatedAt) : 'Unknown' },
      { label: 'Management source', value: state.serviceHealth?.usingRemoteConfig && state.serviceHealth?.baseUrl ? state.serviceHealth.baseUrl : 'This machine (local service)' },
    ].forEach((item) => {
      const cell = document.createElement('div');
      cell.style.border = '1px solid #e5e7eb';
      cell.style.borderRadius = '8px';
      cell.style.padding = '10px';
      cell.innerHTML = `
        <div style="font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:.04em;">${escapeHtml(item.label)}</div>
        <div style="font-size:12px;color:#111827;margin-top:4px;word-break:break-word;">${escapeHtml(item.value)}</div>
      `;
      detailGrid.appendChild(cell);
    });
    infoCard.appendChild(detailGrid);

    const actions = document.createElement('div');
    actions.style.display = 'flex';
    actions.style.gap = '8px';
    actions.style.marginTop = '12px';

    const refreshHealthButton = createButton('Refresh Service', 'btn-ghost', async () => {
      refreshHealthButton.disabled = true;
      await loadServiceDiagnostics({ forceRefresh: true });
      refreshHealthButton.disabled = false;
      await render();
    });
    const refreshSessionButton = createButton('Refresh Session', 'btn-ghost', async () => {
      refreshSessionButton.disabled = true;
      await loadServiceDiagnostics({ forceRefresh: true });
      refreshSessionButton.disabled = false;
      await render();
    });
    actions.append(refreshHealthButton, refreshSessionButton);
    infoCard.appendChild(actions);

    container.appendChild(infoCard);

    const serviceNotice = document.createElement('div');
    serviceNotice.className = 'validation-badge neutral';
    serviceNotice.style.marginTop = '12px';
    serviceNotice.textContent = state.serviceHealth?.usingRemoteConfig && state.serviceHealth?.baseUrl
      ? 'This browser is using a shared access service. User changes here should be visible to any other machine pointed at the same service.'
      : 'This browser is using a machine-local access service. User changes here are stored only on this machine unless other machines are configured to use this machine as their shared access service.';
    container.appendChild(serviceNotice);

    const migrationCard = document.createElement('div');
    migrationCard.className = 'auth-card';
    migrationCard.style.marginTop = '12px';

    const migrationTitle = document.createElement('div');
    migrationTitle.style.fontSize = '12px';
    migrationTitle.style.fontWeight = '700';
    migrationTitle.textContent = 'Policy Migration';
    migrationCard.appendChild(migrationTitle);

    const migrationHelp = document.createElement('div');
    migrationHelp.style.fontSize = '11px';
    migrationHelp.style.color = '#6b7280';
    migrationHelp.style.marginTop = '6px';
    migrationHelp.textContent = 'Use export/import to move the access policy from an older machine to the current source-of-truth service. Merge keeps existing local entries and overlays imported users/requests. Replace overwrites the current policy with the imported one.';
    migrationCard.appendChild(migrationHelp);

    const migrationStatus = document.createElement('div');
    migrationStatus.className = 'validation-badge neutral';
    migrationStatus.style.marginTop = '10px';
    setStatus(
      migrationStatus,
      state.migrationStatusMessage || 'No import/export action run yet.',
      state.migrationStatusTone || 'neutral',
    );
    migrationCard.appendChild(migrationStatus);

    const migrationTextarea = document.createElement('textarea');
    migrationTextarea.rows = 8;
    migrationTextarea.placeholder = 'Paste exported access policy JSON here to import.';
    migrationTextarea.style.marginTop = '10px';
    migrationTextarea.style.width = '100%';
    migrationTextarea.style.resize = 'vertical';
    migrationCard.appendChild(migrationTextarea);

    const migrationActions = document.createElement('div');
    migrationActions.style.display = 'flex';
    migrationActions.style.flexWrap = 'wrap';
    migrationActions.style.gap = '8px';
    migrationActions.style.marginTop = '10px';

    const copyExportButton = createButton('Copy Policy JSON', 'btn-ghost', async () => {
      copyExportButton.disabled = true;
      try {
        const exported = await state.callbacks.exportAccessPolicy();
        const text = JSON.stringify(exported?.policy || {}, null, 2);
        await navigator.clipboard.writeText(text);
        migrationTextarea.value = text;
        state.migrationStatusMessage = `Policy JSON copied. Source: ${exported?.storePath || 'unknown'} | users=${String(exported?.counts?.users ?? 0)} | requests=${String(exported?.counts?.requests ?? 0)}`;
        state.migrationStatusTone = 'valid';
        setStatus(
          migrationStatus,
          state.migrationStatusMessage,
          state.migrationStatusTone,
        );
      } catch (error) {
        state.migrationStatusMessage = String(error?.message || 'Could not export policy.').trim();
        state.migrationStatusTone = 'invalid';
        setStatus(migrationStatus, state.migrationStatusMessage, state.migrationStatusTone);
      } finally {
        copyExportButton.disabled = false;
      }
    });

    const mergeImportButton = createButton('Import Merge', '', async () => {
      mergeImportButton.disabled = true;
      replaceImportButton.disabled = true;
      try {
        const parsed = JSON.parse(String(migrationTextarea.value || '').trim() || '{}');
        const response = await state.callbacks.importAccessPolicy({ policy: parsed, mode: 'merge' });
        state.management = normalizeManagement(response.management);
        await loadServiceDiagnostics({ forceRefresh: true });
        state.migrationStatusMessage = `Policy merged successfully at ${formatDate(response.importedAt)}.`;
        state.migrationStatusTone = 'valid';
        setStatus(migrationStatus, state.migrationStatusMessage, state.migrationStatusTone);
        await render();
      } catch (error) {
        state.migrationStatusMessage = String(error?.message || 'Could not merge imported policy.').trim();
        state.migrationStatusTone = 'invalid';
        setStatus(migrationStatus, state.migrationStatusMessage, state.migrationStatusTone);
      } finally {
        mergeImportButton.disabled = false;
        replaceImportButton.disabled = false;
      }
    });

    const replaceImportButton = createButton('Import Replace', 'btn-ghost', async () => {
      replaceImportButton.disabled = true;
      mergeImportButton.disabled = true;
      try {
        const parsed = JSON.parse(String(migrationTextarea.value || '').trim() || '{}');
        const response = await state.callbacks.importAccessPolicy({ policy: parsed, mode: 'replace' });
        state.management = normalizeManagement(response.management);
        await loadServiceDiagnostics({ forceRefresh: true });
        state.migrationStatusMessage = `Policy replaced successfully at ${formatDate(response.importedAt)}.`;
        state.migrationStatusTone = 'valid';
        setStatus(migrationStatus, state.migrationStatusMessage, state.migrationStatusTone);
        await render();
      } catch (error) {
        state.migrationStatusMessage = String(error?.message || 'Could not replace policy.').trim();
        state.migrationStatusTone = 'invalid';
        setStatus(migrationStatus, state.migrationStatusMessage, state.migrationStatusTone);
      } finally {
        replaceImportButton.disabled = false;
        mergeImportButton.disabled = false;
      }
    });

    migrationActions.append(copyExportButton, mergeImportButton, replaceImportButton);
    migrationCard.appendChild(migrationActions);
    container.appendChild(migrationCard);

    const diagTitle = document.createElement('div');
    diagTitle.style.fontSize = '12px';
    diagTitle.style.fontWeight = '700';
    diagTitle.style.margin = '12px 0 8px';
    diagTitle.textContent = 'Identity diagnostics';
    container.appendChild(diagTitle);

    const diagnosticsBlock = document.createElement('pre');
    diagnosticsBlock.className = 'validation-badge neutral';
    diagnosticsBlock.style.whiteSpace = 'pre-wrap';
    diagnosticsBlock.style.overflow = 'auto';
    diagnosticsBlock.style.maxHeight = '260px';
    diagnosticsBlock.style.fontSize = '11px';
    diagnosticsBlock.textContent = state.identityDiagnostics?.error
      ? `Diagnostics failed.\n${state.identityDiagnostics.error}`
      : buildDiagnosticsText(state.identityDiagnostics, state.accessState);
    container.appendChild(diagnosticsBlock);
  }

  async function render() {
    if (!rootNode) return;

    state.auditEntries = await AuditLog.getRecent(80);
    rootNode.innerHTML = '';
    renderTabBar(rootNode);

    const content = document.createElement('div');
    content.id = 'authMgmt_tabContent';

    if (state.activeTab === 'audit') {
      await renderAuditTab(content);
    } else if (state.activeTab === 'requests') {
      await renderRequestsTab(content);
    } else if (state.activeTab === 'service') {
      await renderServiceTab(content);
    } else {
      await renderUsersTab(content);
    }

    rootNode.appendChild(content);
  }

  async function init(panelContext = {}) {
    syncContext(panelContext);
    rootNode = getOrCreateRoot();
    if (!rootNode) return;
    try {
      await render();
    } catch (error) {
      const bodyHost = byId('extensionUserManagementSectionBody') || byId('extensionUserManagementSection');
      if (bodyHost?.dataset?.authManagementFallbackHtml) {
        bodyHost.innerHTML = bodyHost.dataset.authManagementFallbackHtml;
      }
      throw error;
    }
  }

  async function refresh({ forceRefresh = false } = {}) {
    if (typeof state.callbacks?.fetchManagement === 'function') {
      const management = await state.callbacks.fetchManagement({ forceRefresh });
      syncContext({ management });
    }
    await render();
  }

  async function updateContext(panelContext = {}) {
    syncContext(panelContext);
    await render();
  }

  return {
    init,
    refresh,
    updateContext,
    render,
  };
})();

export { AuthManagement, AuditLog };
