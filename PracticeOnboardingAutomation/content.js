chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then((result) => {
      sendResponse({ ok: true, ...result });
    })
    .catch((error) => {
      sendResponse({ ok: false, error: error.message });
    });

  return true;
});

async function handleMessage(message) {
  switch (message.action) {
    case "fill-new-practice":
      return fillNewPractice(message);
    case "click-settings-tab":
      return clickSettingsTab(message.tab);
    case "set-self-service-enabled":
      return setSelfServiceEnabled(Boolean(message.enabled));
    case "fill-practice-cdb":
      return fillPracticeCdb(message.practiceCdb);
    case "fill-section-credentials":
      return fillSectionCredentials(message.sectionTitle, message.username, message.password);
    case "read-doc-text":
      return readGoogleDocText();
    default:
      throw new Error(`Unsupported action: ${message.action}`);
  }
}

async function fillNewPractice({ odsCode, displayName, ehrTypeValue, ehrTypeLabel }) {
  await waitFor(() => !!findFieldByLabel(/ods\s*code/i), 25000, "ODS field not found.");

  const odsField = findFieldByLabel(/ods\s*code/i) || findInputByHints(["ods", "code"]);
  const displayNameField =
    findFieldByLabel(/display\s*name/i) || findFieldByLabel(/practice\s*name/i) || findInputByHints(["display", "name"]);
  const ehrField = findFieldByLabel(/ehr\s*type/i) || findFieldByLabel(/emr\s*type/i) || findInputByHints(["ehr"]);

  if (!odsField) throw new Error("Could not find ODS code field.");
  if (!displayNameField) throw new Error("Could not find Display name field.");
  if (!ehrField) throw new Error("Could not find EHR type field.");

  setValue(odsField, odsCode);
  setValue(displayNameField, displayName);
  setSelectValue(ehrField, ehrTypeValue || ehrTypeLabel);

  const saveButton = findSaveButton();
  if (!saveButton) {
    throw new Error("Could not find Save button on new practice form.");
  }

  clickElement(saveButton);

  await waitFor(
    () => /\/admin_panel\/practices\/[^/]+$/.test(window.location.pathname) && !window.location.pathname.endsWith("/new"),
    40000,
    "Practice page did not open after save."
  );

  const pathParts = window.location.pathname.split("/").filter(Boolean);
  const practiceId = pathParts[pathParts.length - 1];

  return { practiceId };
}

async function clickSettingsTab(tab) {
  const dataTestMap = {
    basic: "tab-basic",
    service: "tab-service",
    workflows: "tab-workflows",
    ehr: "tab-ehr_settings"
  };

  const textMap = {
    basic: /basic\s*settings/i,
    service: /service\s*settings/i,
    workflows: /task\s*recipients|workflow/i,
    ehr: /ehr\s*settings/i
  };

  const dataTestId = dataTestMap[tab];
  const textPattern = textMap[tab];

  let tabElement = null;
  if (dataTestId) {
    tabElement = document.querySelector(`[data-test-id="${dataTestId}"]`);
  }

  if (!tabElement && textPattern) {
    tabElement = findClickableByText(textPattern);
  }

  if (!tabElement) {
    throw new Error(`Could not find settings tab: ${tab}`);
  }

  clickElement(tabElement);
  await sleep(600);

  return {};
}

async function setSelfServiceEnabled(enabled) {
  if (!enabled) {
    return { skipped: true };
  }

  await waitFor(
    () => !!findFieldByLabel(/self\s*service/i, document, { type: "checkbox" }) || !!findCheckboxByHints(["self", "service"]),
    25000,
    "Self Service checkbox not found."
  );

  const checkbox =
    findFieldByLabel(/self\s*service/i, document, { type: "checkbox" }) || findCheckboxByHints(["self", "service"]);

  if (!checkbox) {
    throw new Error("Self Service checkbox not found.");
  }

  if (!checkbox.checked) {
    setCheckboxValue(checkbox, true);
  }

  const sectionContainer = findNearestContainer(checkbox);
  const saveButton = findSaveButton(sectionContainer) || findSaveButton();
  if (!saveButton) {
    throw new Error("Save button not found for Service Settings.");
  }

  clickElement(saveButton);
  await sleep(700);

  return {};
}

async function fillPracticeCdb(practiceCdb) {
  await waitFor(
    () => !!findFieldByLabel(/practice\s*cdb/i) || !!findInputByHints(["practice", "cdb"]),
    25000,
    "Practice CDB field not found."
  );

  const cdbField = findFieldByLabel(/practice\s*cdb/i) || findInputByHints(["practice", "cdb"]);
  if (!cdbField) {
    throw new Error("Practice CDB field not found.");
  }

  setValue(cdbField, practiceCdb);

  const container = findNearestContainer(cdbField);
  const saveButton = findSaveButton(container) || findSaveButton();
  if (!saveButton) {
    throw new Error("Save button not found for Practice CDB.");
  }

  clickElement(saveButton);
  await sleep(700);
  return {};
}

async function fillSectionCredentials(sectionTitle, username, password) {
  await waitFor(
    () => !!findSectionContainer(sectionTitle),
    30000,
    `Could not locate section "${sectionTitle}".`
  );

  const section = findSectionContainer(sectionTitle);
  if (!section) {
    throw new Error(`Could not locate section "${sectionTitle}".`);
  }

  const usernameField =
    findFieldByLabel(/username/i, section) || findInputByHints(["username"], section) || findInputByHints(["user", "name"], section);
  const passwordField =
    findFieldByLabel(/password/i, section) || findInputByHints(["password"], section, { preferPassword: true });

  if (!usernameField || !passwordField) {
    throw new Error(`Username/Password fields not found in "${sectionTitle}".`);
  }

  setValue(usernameField, username);
  setValue(passwordField, password);

  const saveButton = findSaveButton(section) || findSaveButton();
  if (!saveButton) {
    throw new Error(`Save button not found in "${sectionTitle}".`);
  }

  clickElement(saveButton);
  await sleep(800);

  return {};
}

async function readGoogleDocText() {
  const match = window.location.pathname.match(/\/document\/d\/([^/]+)/);
  const docId = match?.[1];

  if (docId) {
    const exportUrl = `https://docs.google.com/document/d/${docId}/export?format=txt`;
    try {
      const response = await fetch(exportUrl, { credentials: "include" });
      if (response.ok) {
        const text = (await response.text()).trim();
        if (text) {
          return { text };
        }
      }
    } catch (_error) {
      // Fall through to DOM text fallback.
    }
  }

  const text = (document.body?.innerText || "").trim();
  if (!text) {
    throw new Error("Google Doc appears empty or inaccessible.");
  }

  return { text };
}

function findFieldByLabel(pattern, root = document, options = {}) {
  const labels = Array.from(root.querySelectorAll("label"));
  const requiredType = options.type || null;

  for (const label of labels) {
    const labelText = normalizeText(label.textContent);
    if (!pattern.test(labelText)) {
      continue;
    }

    const control = getControlForLabel(label);
    if (!control || !isVisible(control)) {
      continue;
    }

    if (requiredType && control.type !== requiredType) {
      continue;
    }

    return control;
  }

  return null;
}

function getControlForLabel(label) {
  if (label.control) {
    return label.control;
  }

  if (label.htmlFor) {
    const byId = document.getElementById(label.htmlFor);
    if (byId) {
      return byId;
    }
  }

  const nested = label.querySelector("input, select, textarea");
  if (nested) {
    return nested;
  }

  let sibling = label.nextElementSibling;
  while (sibling) {
    if (sibling.matches("input, select, textarea")) {
      return sibling;
    }
    const insideSibling = sibling.querySelector("input, select, textarea");
    if (insideSibling) {
      return insideSibling;
    }
    sibling = sibling.nextElementSibling;
  }

  const parent = label.parentElement;
  if (parent) {
    const controls = parent.querySelectorAll("input, select, textarea");
    if (controls.length === 1) {
      return controls[0];
    }
  }

  return null;
}

function findInputByHints(hints, root = document, options = {}) {
  const inputs = Array.from(root.querySelectorAll("input, select, textarea"));

  const candidates = inputs.filter((input) => {
    if (!isVisible(input)) {
      return false;
    }

    if (options.preferPassword && input.type === "password") {
      return true;
    }

    const haystack = normalizeText([
      input.getAttribute("aria-label") || "",
      input.getAttribute("placeholder") || "",
      input.getAttribute("name") || "",
      input.getAttribute("id") || ""
    ].join(" "));

    return hints.every((hint) => haystack.includes(normalizeText(hint)));
  });

  return candidates[0] || null;
}

function findCheckboxByHints(hints, root = document) {
  const checkboxes = Array.from(root.querySelectorAll('input[type="checkbox"]'));

  return checkboxes.find((checkbox) => {
    if (!isVisible(checkbox)) {
      return false;
    }

    const wrapper = checkbox.closest("label, div, section, form");
    const text = normalizeText(wrapper?.textContent || checkbox.getAttribute("aria-label") || "");

    return hints.every((hint) => text.includes(normalizeText(hint)));
  }) || null;
}

function setValue(field, value) {
  if (field.tagName === "SELECT") {
    setSelectValue(field, value);
    return;
  }

  field.focus();
  setNativeValue(field, String(value ?? ""));
  field.dispatchEvent(new Event("input", { bubbles: true }));
  field.dispatchEvent(new Event("change", { bubbles: true }));
  field.blur();
}

function setSelectValue(field, value) {
  if (field.tagName === "SELECT") {
    const normalizedTarget = normalizeText(String(value || ""));
    const options = Array.from(field.options || []);
    const matchedOption =
      options.find((option) => normalizeText(option.value) === normalizedTarget) ||
      options.find((option) => normalizeText(option.textContent) === normalizedTarget) ||
      options.find((option) => normalizeText(option.textContent).includes(normalizedTarget));

    if (matchedOption) {
      field.value = matchedOption.value;
    } else {
      field.value = String(value || "");
    }

    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.dispatchEvent(new Event("change", { bubbles: true }));
    return;
  }

  clickElement(field);
  const option = findClickableByText(new RegExp(escapeRegExp(String(value || "")), "i"));
  if (!option) {
    throw new Error(`Could not select option "${value}".`);
  }
  clickElement(option);
}

function setCheckboxValue(checkbox, checked) {
  checkbox.focus();
  if (checkbox.checked !== checked) {
    checkbox.click();
  }
  checkbox.dispatchEvent(new Event("input", { bubbles: true }));
  checkbox.dispatchEvent(new Event("change", { bubbles: true }));
}

function setNativeValue(element, value) {
  const prototype =
    element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
  if (descriptor?.set) {
    descriptor.set.call(element, value);
  } else {
    element.value = value;
  }
}

function findSectionContainer(sectionTitle) {
  const normalizedTitle = normalizeText(sectionTitle);
  const headings = Array.from(document.querySelectorAll("h1, h2, h3, h4, h5, h6, legend, strong, div, span, p"));

  for (const heading of headings) {
    const headingText = normalizeText(heading.textContent);
    if (!headingText || !headingText.includes(normalizedTitle)) {
      continue;
    }

    let current = heading;
    for (let depth = 0; depth < 8 && current; depth += 1) {
      const parent = current.parentElement;
      if (!parent) {
        break;
      }
      const fieldCount = parent.querySelectorAll("input, select, textarea").length;
      if (fieldCount >= 2) {
        return parent;
      }
      current = parent;
    }
  }

  return null;
}

function findSaveButton(root = document) {
  const buttons = Array.from(root.querySelectorAll("button, input[type='submit'], input[type='button']"));

  return buttons.find((button) => {
    if (!isVisible(button) || button.disabled) {
      return false;
    }
    const text = normalizeText(button.textContent || button.value || button.getAttribute("aria-label") || "");
    return text === "save" || text.includes("save");
  }) || null;
}

function findClickableByText(pattern, root = document) {
  const selectors = "button, a, [role='button'], [role='tab'], li, div";
  const candidates = Array.from(root.querySelectorAll(selectors));

  for (const element of candidates) {
    if (!isVisible(element)) {
      continue;
    }
    const text = normalizeText(element.textContent);
    if (!text || text.length > 120) {
      continue;
    }
    if (pattern.test(text)) {
      return element;
    }
  }

  return null;
}

function findNearestContainer(element) {
  let current = element;
  for (let depth = 0; depth < 6 && current; depth += 1) {
    const parent = current.parentElement;
    if (!parent) break;
    if (parent.querySelectorAll("input, select, textarea").length >= 1) {
      current = parent;
      continue;
    }
    break;
  }
  return current?.parentElement || document;
}

function clickElement(element) {
  element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  element.click();
}

function normalizeText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function isVisible(element) {
  if (!element) return false;
  const style = window.getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
    return false;
  }
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function waitFor(predicate, timeoutMs, message) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) {
      return;
    }
    await sleep(250);
  }
  throw new Error(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
