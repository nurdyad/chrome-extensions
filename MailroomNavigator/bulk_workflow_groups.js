// In-page automation helper for creating workflow groups in bulk.
// Triggered from the extension "Custom Workflow Groups" section.
(() => {
  if (window.__BL_BULK_WORKFLOW_RUN__) return;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const isVisible = (element) => Boolean(element && (element.offsetParent !== null || element.getClientRects?.().length));
  const normalizeText = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const INPUT_FIELD_SELECTOR = 'input, textarea, [contenteditable="true"], [contenteditable="plaintext-only"]';

  const toTitleCase = (value) => value
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');

  const getFieldValue = (field) => {
    if (!field) return '';
    if ('value' in field) return field.value || '';
    if (field.isContentEditable) return field.textContent || '';
    return '';
  };

  const setLiveViewInput = (inputElement, value) => {
    if (!inputElement) return;

    const isTextarea = inputElement instanceof window.HTMLTextAreaElement;
    const isInput = inputElement instanceof window.HTMLInputElement;
    const nativeSetter = isInput
      ? Object.getOwnPropertyDescriptor(window.HTMLInputElement?.prototype || {}, 'value')?.set
      : isTextarea
        ? Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement?.prototype || {}, 'value')?.set
        : null;

    inputElement.focus();
    if (typeof nativeSetter === 'function') nativeSetter.call(inputElement, value);
    else if ('value' in inputElement) inputElement.value = value;
    else if (inputElement.isContentEditable) inputElement.textContent = value;

    try {
      inputElement.dispatchEvent(new InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' }));
    } catch (error) {
      inputElement.dispatchEvent(new Event('input', { bubbles: true }));
    }
    inputElement.dispatchEvent(new Event('change', { bubbles: true }));
    inputElement.dispatchEvent(new Event('blur', { bubbles: true }));
    inputElement.dispatchEvent(new Event('focusout', { bubbles: true }));
    inputElement.blur?.();
  };

  const findAddButton = () => {
    const byAttribute = document.querySelector('[phx-click="add_workflow_group"], [phx-click*="add_workflow"]');
    if (byAttribute && isVisible(byAttribute) && !byAttribute.disabled) return byAttribute;

    const byText = Array.from(document.querySelectorAll('button, [role="button"]')).find((button) => {
      if (!isVisible(button) || button.disabled) return false;
      const text = String(button.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const phx = String(button.getAttribute?.('phx-click') || '').toLowerCase();
      return (
        /add\s+custom\s+workflow\s+group/.test(text) ||
        (/add/.test(text) && /(workflow|task recipient|custom)/.test(text)) ||
        (/add/.test(phx) && /workflow/.test(phx))
      );
    });

    return byText || null;
  };

  const isEditableTextField = (field) => {
    if (!field || !isVisible(field)) return false;
    if (field.matches?.('input')) {
      const type = normalizeText(field.getAttribute('type') || 'text') || 'text';
      if (['hidden', 'checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'range', 'color', 'image'].includes(type)) {
        return false;
      }
      return !field.disabled && !field.readOnly;
    }
    if (field.matches?.('textarea')) return !field.disabled && !field.readOnly;
    if (field.isContentEditable) return true;
    return false;
  };

  const getVisibleInputs = (scope, selector = INPUT_FIELD_SELECTOR) =>
    Array.from(scope.querySelectorAll(selector)).filter(isEditableTextField);

  const getFieldHint = (field) => {
    if (!field) return '';

    const parts = [
      field.getAttribute?.('aria-label'),
      field.getAttribute?.('placeholder'),
      field.getAttribute?.('name'),
      field.getAttribute?.('id'),
      field.getAttribute?.('data-test-id'),
      field.getAttribute?.('data-testid')
    ];

    if (field.labels?.length) {
      parts.push(...Array.from(field.labels).map((label) => label.textContent || ''));
    }

    let sibling = field.previousElementSibling;
    let siblingChecks = 0;
    while (sibling && siblingChecks < 3) {
      parts.push(sibling.textContent || '');
      sibling = sibling.previousElementSibling;
      siblingChecks += 1;
    }

    let parent = field.parentElement;
    let parentChecks = 0;
    while (parent && parentChecks < 2) {
      parts.push(parent.textContent || '');
      parent = parent.parentElement;
      parentChecks += 1;
    }

    return normalizeText(parts.join(' '));
  };

  const findFieldByHint = (fields, patterns, used = new Set()) => {
    for (const field of fields) {
      if (used.has(field)) continue;
      const hint = getFieldHint(field);
      if (patterns.some((pattern) => pattern.test(hint))) return field;
    }
    return null;
  };

  const getInputPairWithin = (scope) => {
    if (!scope?.querySelectorAll) return null;

    const namedDocmanInputs = getVisibleInputs(scope, 'input[name="form-[docman_group]"], textarea[name="form-[docman_group]"]');
    const namedLabelInputs = getVisibleInputs(scope, 'input[name="form-[label_for_ui]"], textarea[name="form-[label_for_ui]"]');
    if (namedDocmanInputs.length && namedLabelInputs.length) {
      return {
        docmanInput: namedDocmanInputs[0],
        labelInput: namedLabelInputs[0]
      };
    }

    const fields = getVisibleInputs(scope);
    if (fields.length < 2) return null;

    const used = new Set();
    let docmanInput = findFieldByHint(fields, [/docman/, /\bgroup\b/], used);
    if (docmanInput) used.add(docmanInput);

    let labelInput = findFieldByHint(fields, [/mailroom/, /\blabel\b/, /\bui\b/], used);
    if (labelInput) used.add(labelInput);

    if (!docmanInput && fields.length >= 2) {
      [docmanInput] = fields;
      used.add(docmanInput);
    }
    if (!labelInput) {
      labelInput = fields.find((field) => !used.has(field)) || null;
    }

    if (!docmanInput || !labelInput) return null;

    return { docmanInput, labelInput };
  };

  const getLastWorkflowInputs = () => {
    const fields = getVisibleInputs(document);
    if (fields.length < 2) return null;

    const docmanInput = fields[fields.length - 2];
    const labelInput = fields[fields.length - 1];
    if (!docmanInput || !labelInput) return null;

    return { docmanInput, labelInput };
  };

  const getButtonText = (button) => normalizeText(button?.textContent || button?.ariaLabel || '');
  const getPhxAction = (button) => normalizeText(button?.getAttribute?.('phx-click') || '');
  const matchesSaveButton = (button) => {
    if (!button || !isVisible(button)) return false;
    const text = getButtonText(button);
    const phx = getPhxAction(button);
    return text === 'save' || text.startsWith('save ') || phx.includes('save');
  };
  const matchesCancelButton = (button) => {
    if (!button || !isVisible(button)) return false;
    const text = getButtonText(button);
    const phx = getPhxAction(button);
    return text === 'cancel' || text.startsWith('cancel ') || phx.includes('cancel');
  };

  const hasDraftSaveState = (scope = document) => {
    const buttons = Array.from(scope.querySelectorAll?.('button, [role="button"]') || []);
    const hasSave = buttons.some(matchesSaveButton);
    const hasCancel = buttons.some(matchesCancelButton);
    return hasSave && hasCancel;
  };

  const findCommonAncestor = (a, b) => {
    if (!a || !b) return null;
    const visited = new Set();
    let current = a;
    while (current) {
      visited.add(current);
      current = current.parentElement;
    }
    current = b;
    while (current) {
      if (visited.has(current)) return current;
      current = current.parentElement;
    }
    return null;
  };

  const findDraftContainer = (docmanInput, labelInput) => {
    const common = findCommonAncestor(docmanInput, labelInput);
    let scope = common;
    while (scope && scope !== document.body) {
      if (hasDraftSaveState(scope)) return scope;
      scope = scope.parentElement;
    }
    return common || labelInput?.closest('form') || labelInput?.parentElement || docmanInput?.parentElement || null;
  };

  const getDraftCandidateScore = ({ draftContainer, docmanInput, labelInput }) => {
    const scopeText = normalizeText(draftContainer?.textContent || '');
    const visibleFieldCount = getVisibleInputs(draftContainer || document).length;
    let score = 0;

    if (scopeText.includes('new task recipient')) score += 10;
    if (!normalizeText(getFieldValue(docmanInput))) score += 4;
    if (!normalizeText(getFieldValue(labelInput))) score += 4;
    if (hasDraftSaveState(draftContainer || document)) score += 2;

    return score - visibleFieldCount;
  };

  const findActiveDraftRow = () => {
    const buttons = Array.from(document.querySelectorAll('button, [role="button"]')).filter(isVisible);
    const saveButtons = buttons.filter(matchesSaveButton);
    const candidates = [];

    for (const saveButton of saveButtons) {
      let scope = saveButton.parentElement;
      while (scope && scope !== document.body) {
        const inputPair = getInputPairWithin(scope);
        const hasCancel = Array.from(scope.querySelectorAll('button, [role="button"]')).some(matchesCancelButton);
        if (inputPair && hasCancel) {
          candidates.push({
            ...inputPair,
            draftContainer: scope,
            score: getDraftCandidateScore({ draftContainer: scope, ...inputPair })
          });
          break;
        }
        scope = scope.parentElement;
      }
    }

    if (candidates.length) {
      candidates.sort((a, b) => b.score - a.score);
      return candidates[0];
    }

    const fallbackPair = getLastWorkflowInputs();
    if (!fallbackPair) return null;
    return {
      ...fallbackPair,
      draftContainer: findDraftContainer(fallbackPair.docmanInput, fallbackPair.labelInput),
      score: -Infinity
    };
  };

  const findSaveForRow = (draftContainer) => {
    if (!draftContainer) return null;

    const buttons = Array.from(draftContainer.querySelectorAll('button, [role="button"]'))
      .filter((button) => isVisible(button) && !button.disabled);

    const saveByMatch = buttons.find(matchesSaveButton);
    if (saveByMatch) return saveByMatch;

    const iconButton = Array.from(draftContainer.querySelectorAll('svg'))
      .map((svg) => svg.closest('button') || svg.closest('[role="button"]') || svg.closest('span') || svg.parentElement)
      .find((button) => button && isVisible(button) && !button.disabled && matchesSaveButton(button));
    if (iconButton) return iconButton;

    return null;
  };

  const countMatchingWorkflowValues = (name) => {
    const normalized = normalizeText(name);
    if (!normalized) return 0;

    const matchingFieldCount = getVisibleInputs(document)
      .filter((field) => normalizeText(getFieldValue(field)) === normalized)
      .length;

    return Math.floor(matchingFieldCount / 2);
  };

  const waitForSaveReady = async (draftContainer, timeoutMs = 2500) => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const saveButton = findSaveForRow(draftContainer);
      if (saveButton) return saveButton;
      await sleep(100);
    }
    return null;
  };

  const waitForActiveDraftRow = async (timeoutMs = 3500) => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const inputPair = findActiveDraftRow();
      if (inputPair) return inputPair;
      await sleep(100);
    }
    return null;
  };

  const waitForWorkflowPersist = async ({ finalName, beforeMatchCount = 0, draftContainer, docmanInput, labelInput, timeoutMs = 4500 }) => {
    const startedAt = Date.now();
    const normalized = normalizeText(finalName);

    while (Date.now() - startedAt < timeoutMs) {
      const draftStillAttached = Boolean(document.contains(docmanInput) && document.contains(labelInput));
      const draftHasSaveState = draftStillAttached && draftContainer ? hasDraftSaveState(draftContainer) : false;
      const docmanValue = normalizeText(getFieldValue(docmanInput));
      const labelValue = normalizeText(getFieldValue(labelInput));
      const matchCount = countMatchingWorkflowValues(finalName);

      if (matchCount > beforeMatchCount) {
        if (!draftStillAttached) return true;
        if (!draftHasSaveState) return true;
        if (docmanValue !== normalized || labelValue !== normalized) return true;
      }

      if (!draftHasSaveState && docmanValue === normalized && labelValue === normalized) {
        return true;
      }

      await sleep(150);
    }

    return false;
  };

  const emitProgress = (current, total) => {
    try {
      chrome.runtime.sendMessage({ type: 'BL_WORKFLOW_PROGRESS', current, total });
    } catch (error) {
      // No-op. Popup might not be open.
    }
  };

  const ensureOnTaskRecipientsTab = async () => {
    const tab = document.querySelector('[phx-value-tab="task_recipients"]')
      || Array.from(document.querySelectorAll('button, a, [role="tab"], [role="button"]'))
        .find((element) => /task\s+recipients/i.test(element.textContent || ''));

    if (tab) {
      tab.click();
      await sleep(600);
    }
  };

  window.__BL_BULK_WORKFLOW_RUN__ = async ({ names = [], options = {} }) => {
    const result = { ok: true, created: 0, skipped: 0, errors: [] };

    try {
      if (!location.href.startsWith('https://app.betterletter.ai/')) {
        return { ok: false, error: 'Not on app.betterletter.ai.' };
      }

      await ensureOnTaskRecipientsTab();

      const mergedOptions = {
        skipDuplicates: options.skipDuplicates !== false,
        titleCase: Boolean(options.titleCase),
      };

      for (const rawName of names) {
        const candidateName = String(rawName || '').trim();
        if (!candidateName) continue;

        const finalName = mergedOptions.titleCase ? toTitleCase(candidateName) : candidateName;
        const beforeMatchCount = countMatchingWorkflowValues(finalName);

        const existingDocmanValues = getVisibleInputs(document)
          .map((input) => normalizeText(getFieldValue(input)))
          .filter(Boolean);
        const alreadyExists = existingDocmanValues.includes(finalName.trim().toLowerCase());
        if (alreadyExists && mergedOptions.skipDuplicates) {
          result.skipped += 1;
          emitProgress(result.created + result.skipped + result.errors.length, names.length);
          continue;
        }

        const addButton = findAddButton();
        if (addButton) {
          addButton.click();
          await sleep(700);
        }

        const inputPair = await waitForActiveDraftRow();
        if (!inputPair) {
          result.errors.push(`Workflow inputs not found for "${finalName}".`);
          emitProgress(result.created + result.skipped + result.errors.length, names.length);
          continue;
        }
        const { docmanInput, labelInput } = inputPair;
        const draftContainer = inputPair.draftContainer || findDraftContainer(docmanInput, labelInput);

        // If Add button is hidden but a draft row is already open, reuse that row.
        // This happens when the page already shows "New task recipient" with Save/Cancel.
        if (!addButton) {
          const hasDraftInputs = !String(getFieldValue(docmanInput) || '').trim() || !String(getFieldValue(labelInput) || '').trim() || hasDraftSaveState(draftContainer || document);
          if (!hasDraftInputs) {
            result.errors.push(`Cannot find Add Custom Workflow Group button or an open draft row for "${finalName}".`);
            emitProgress(result.created + result.skipped + result.errors.length, names.length);
            continue;
          }
        }

        if (!docmanInput || !labelInput) {
          result.errors.push(`Workflow inputs not found for "${finalName}".`);
          emitProgress(result.created + result.skipped + result.errors.length, names.length);
          continue;
        }

        setLiveViewInput(docmanInput, finalName);
        setLiveViewInput(labelInput, finalName);

        await sleep(350);

        const saveButton = await waitForSaveReady(draftContainer);
        if (!saveButton) {
          result.errors.push(`Save control did not become ready for "${finalName}".`);
          emitProgress(result.created + result.skipped + result.errors.length, names.length);
          continue;
        }

        saveButton.click();

        const persisted = await waitForWorkflowPersist({
          finalName,
          beforeMatchCount,
          draftContainer,
          docmanInput,
          labelInput
        });
        if (!persisted) {
          result.errors.push(`Save click did not persist workflow "${finalName}".`);
          emitProgress(result.created + result.skipped + result.errors.length, names.length);
          continue;
        }

        result.created += 1;
        emitProgress(result.created + result.skipped + result.errors.length, names.length);
      }

      return result;
    } catch (error) {
      return { ok: false, error: error?.message || String(error) };
    }
  };
})();
