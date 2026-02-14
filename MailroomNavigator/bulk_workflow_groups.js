(() => {
  if (window.__BL_BULK_WORKFLOW_RUN__) return;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const isVisible = (element) => Boolean(element && (element.offsetParent !== null || element.getClientRects?.().length));

  const toTitleCase = (value) => value
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');

  const setLiveViewInput = (inputElement, value) => {
    if (!inputElement) return;
    inputElement.focus();
    inputElement.value = value;
    inputElement.dispatchEvent(new Event('input', { bubbles: true }));
    inputElement.dispatchEvent(new Event('change', { bubbles: true }));
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

  const getLastWorkflowInputs = () => {
    const docmanInputs = Array.from(document.querySelectorAll('input[name="form-[docman_group]"]')).filter(isVisible);
    const labelInputs = Array.from(document.querySelectorAll('input[name="form-[label_for_ui]"]')).filter(isVisible);
    if (!docmanInputs.length || !labelInputs.length) return null;
    return {
      docmanInput: docmanInputs[docmanInputs.length - 1],
      labelInput: labelInputs[labelInputs.length - 1]
    };
  };

  const hasDraftSaveState = () => {
    const hasSave = Array.from(document.querySelectorAll('button, [role="button"]')).some((button) =>
      isVisible(button) && /save/i.test(button.textContent || '')
    );
    const hasCancel = Array.from(document.querySelectorAll('button, [role="button"]')).some((button) =>
      isVisible(button) && /cancel/i.test(button.textContent || '')
    );
    return hasSave && hasCancel;
  };

  const findSaveForRow = (labelInput) => {
    if (!labelInput) return null;

    const scopes = [
      labelInput.closest('tr'),
      labelInput.closest('.grid'),
      labelInput.closest('section'),
      labelInput.closest('form'),
      document
    ].filter(Boolean);

    for (const scope of scopes) {
      const saveByAttr = Array.from(scope.querySelectorAll('button, [role="button"]')).find((button) => {
        if (!isVisible(button) || button.disabled) return false;
        const phx = String(button.getAttribute?.('phx-click') || '').toLowerCase();
        return phx.includes('save');
      });
      if (saveByAttr) return saveByAttr;

      const saveByText = Array.from(scope.querySelectorAll('button, [role="button"]')).find((button) =>
        isVisible(button) && !button.disabled && /save/i.test(button.textContent || '')
      );
      if (saveByText) return saveByText;

      const polyline = scope.querySelector('svg polyline');
      if (polyline) {
        const svg = polyline.closest('svg');
        const iconButton = svg?.closest('button') || svg?.closest('[role="button"]') || svg?.closest('span') || svg?.parentElement;
        if (isVisible(iconButton) && !iconButton.disabled) return iconButton;
      }
    }

    return null;
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

        const existingDocmanValues = Array.from(document.querySelectorAll('input[name="form-[docman_group]"]'))
          .map((input) => String(input?.value || '').trim().toLowerCase())
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

        const inputPair = getLastWorkflowInputs();
        if (!inputPair) {
          result.errors.push(`Workflow inputs not found for "${finalName}".`);
          emitProgress(result.created + result.skipped + result.errors.length, names.length);
          continue;
        }
        const { docmanInput, labelInput } = inputPair;

        // If Add button is hidden but a draft row is already open, reuse that row.
        // This happens when the page already shows "New task recipient" with Save/Cancel.
        if (!addButton) {
          const hasDraftInputs = !String(docmanInput.value || '').trim() || !String(labelInput.value || '').trim() || hasDraftSaveState();
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

        await sleep(250);

        const saveButton = findSaveForRow(labelInput);
        if (!saveButton) {
          result.errors.push(`Save control not found for "${finalName}".`);
          emitProgress(result.created + result.skipped + result.errors.length, names.length);
          continue;
        }

        saveButton.click();
        await sleep(900);

        result.created += 1;
        emitProgress(result.created + result.skipped + result.errors.length, names.length);
      }

      return result;
    } catch (error) {
      return { ok: false, error: error?.message || String(error) };
    }
  };
})();
