(() => {
  // Prevent double-injection
  if (window.__BL_BULK_WORKFLOW_RUN__) return;

  /* ---------------- Utilities ---------------- */

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function toTitleCase(str) {
    return str
      .toLowerCase()
      .split(" ")
      .map(w => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
  }

  function setLiveViewInput(inputEl, value) {
    inputEl.focus();
    inputEl.value = value;
    inputEl.dispatchEvent(new Event("input", { bubbles: true }));
    inputEl.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function findAddButton() {
    return document.querySelector('[phx-click="add_workflow_group"]');
  }

  function lastInput(selector) {
    const nodes = document.querySelectorAll(selector);
    return nodes.length ? nodes[nodes.length - 1] : null;
  }

  function findSaveForRow(labelInput) {
    // Scope search to the nearest reasonable container
    const scope =
      labelInput.closest("section") ||
      labelInput.closest("form") ||
      labelInput.closest("div");

    if (!scope) return null;

    // Prefer a button if one exists
    const button = [...scope.querySelectorAll("button")].find(b =>
      /save/i.test(b.textContent || "")
    );
    if (button) return button;

    // Otherwise locate the checkmark SVG and click its nearest clickable parent
    const polyline = scope.querySelector("svg polyline");
    if (!polyline) return null;

    const svg = polyline.closest("svg");
    return (
      svg.closest("button") ||
      svg.closest("span") ||
      svg.parentElement ||
      null
    );
  }

  async function ensureOnTaskRecipientsTab() {
    const tab = document.querySelector(
      '[phx-click="tab_changed"][phx-value-tab="task_recipients"]'
    );
    if (tab) {
      tab.click();
      await sleep(600);
    }
  }

  /* ---------------- Main Runner ---------------- */

  window.__BL_BULK_WORKFLOW_RUN__ = async ({ names, options }) => {
    const result = {
      ok: true,
      created: 0,
      skipped: 0,
      errors: []
    };

    try {
      if (!location.href.startsWith("https://app.betterletter.ai/")) {
        return { ok: false, error: "Not on app.betterletter.ai" };
      }

      options = options || {
        skipDuplicates: true,
        titleCase: false
      };

      // Best effort: ensure correct tab
      await ensureOnTaskRecipientsTab();

      for (const rawName of names) {
        const finalName = options.titleCase
          ? toTitleCase(rawName)
          : rawName;

        // Duplicate detection (soft)
        const alreadyExists = document.body?.innerText?.includes(finalName);
        if (alreadyExists && options.skipDuplicates) {
          result.skipped += 1;

          chrome.runtime.sendMessage({
            type: "BL_PROGRESS",
            current: result.created + result.skipped + result.errors.length,
            total: names.length
          });

          continue;
        }

        const addBtn = findAddButton();
        if (!addBtn) {
          return {
            ok: false,
            error:
              'Cannot find "Add Custom Workflow Group" button. Are you on Task Recipients (Workflows)?'
          };
        }

        addBtn.click();
        await sleep(700);

        const docmanInput = lastInput('input[name="form-[docman_group]"]');
        const labelInput = lastInput('input[name="form-[label_for_ui]"]');

        if (!docmanInput || !labelInput) {
          result.errors.push(`Inputs not found for "${finalName}"`);

          chrome.runtime.sendMessage({
            type: "BL_PROGRESS",
            current: result.created + result.skipped + result.errors.length,
            total: names.length
          });

          continue;
        }

        setLiveViewInput(docmanInput, finalName);
        setLiveViewInput(labelInput, finalName);

        await sleep(250);

        const saveBtn = findSaveForRow(labelInput);
        if (!saveBtn) {
          result.errors.push(`Save control not found for "${finalName}"`);

          chrome.runtime.sendMessage({
            type: "BL_PROGRESS",
            current: result.created + result.skipped + result.errors.length,
            total: names.length
          });

          continue;
        }

        saveBtn.click();
        await sleep(900);

        result.created += 1;

        chrome.runtime.sendMessage({
          type: "BL_PROGRESS",
          current: result.created + result.skipped + result.errors.length,
          total: names.length
        });
      }

      return result;
    } catch (e) {
      return {
        ok: false,
        error: e?.message || String(e)
      };
    }
  };
})();
