(() => {
  if (window.__BL_BULK_WORKFLOW_RUN__) return;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
    const byAttribute = document.querySelector('[phx-click="add_workflow_group"]');
    if (byAttribute) return byAttribute;

    const byText = Array.from(document.querySelectorAll('button')).find((button) =>
      /add\s+custom\s+workflow\s+group/i.test(button.textContent || '')
    );
    return byText || null;
  };

  const getLastInput = (selector) => {
    const nodes = document.querySelectorAll(selector);
    return nodes.length ? nodes[nodes.length - 1] : null;
  };

  const findSaveForRow = (labelInput) => {
    if (!labelInput) return null;

    const row = labelInput.closest('tr') || labelInput.closest('.grid') || labelInput.closest('div');
    const scope = row || labelInput.closest('section') || labelInput.closest('form') || labelInput.closest('div');
    if (!scope) return null;

    const saveByAttr = scope.querySelector('[phx-click*="save"]');
    if (saveByAttr) return saveByAttr;

    const button = Array.from(scope.querySelectorAll('button')).find((btn) => /save/i.test(btn.textContent || ''));
    if (button) return button;

    const polyline = scope.querySelector('svg polyline');
    if (!polyline) return null;

    const svg = polyline.closest('svg');
    return svg?.closest('button') || svg?.closest('[role="button"]') || svg?.closest('span') || svg?.parentElement || null;
  };

  const emitProgress = (current, total) => {
    try {
      chrome.runtime.sendMessage({ type: 'BL_WORKFLOW_PROGRESS', current, total });
    } catch (error) {
      // No-op. Popup might not be open.
    }
  };

  const ensureOnTaskRecipientsTab = async () => {
    const tab = document.querySelector('[phx-click="tab_changed"][phx-value-tab="task_recipients"]');
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
        if (!addButton) {
          return {
            ok: false,
            error: 'Cannot find Add Custom Workflow Group button. Open the Task Recipients tab first.'
          };
        }

        addButton.click();
        await sleep(700);

        const docmanInput = getLastInput('input[name="form-[docman_group]"]');
        const labelInput = getLastInput('input[name="form-[label_for_ui]"]');

        if (!docmanInput || !labelInput) {
          result.errors.push(`Inputs not found for "${finalName}".`);
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
