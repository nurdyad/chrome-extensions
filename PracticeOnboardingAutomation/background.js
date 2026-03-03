const BETTERLETTER_NEW_PRACTICE_URL = "https://app.betterletter.ai/admin_panel/practices/new";

const AIRTABLE_FIELD_CANDIDATES = {
  odsCode: ["ODS", "ODS code", "Ods", "ods"],
  practiceName: ["Practice Name", "Practice Name (must match EMIS)", "Display name", "Practice"],
  emrType: ["EMR", "EHR Type", "EHR type", "EHR"],
  subscriptionType: ["subscription type", "Subscription type", "Subscription"],
  emisSiteCode: ["Emis Site code", "EMIS Site Code", "EMIS Site code", "Practice CDB", "Practice CDb"],
  emrAccessDetails: ["EMR Access Details", "EMR access details", "EMR Access", "Access Details"]
};

let runInProgress = false;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.action !== "run-onboarding") {
    return;
  }

  runOnboarding(message.config, message.runId)
    .then((result) => {
      sendResponse({ ok: true, result });
    })
    .catch((error) => {
      sendResponse({ ok: false, error: error.message });
    });

  return true;
});

async function runOnboarding(config, runId) {
  if (runInProgress) {
    throw new Error("Another onboarding run is already in progress.");
  }

  runInProgress = true;

  try {
    const normalizedConfig = normalizeConfig(config);
    await chrome.storage.local.set({ onboardingAutomationConfig: normalizedConfig });

    progress(runId, "Fetching onboarding data from Airtable...");
    const airtableRecord = await fetchAirtableRecord(normalizedConfig);
    const onboardingData = parseOnboardingRecord(airtableRecord);

    progress(runId, `Loaded Airtable record ${airtableRecord.id}.`);
    progress(runId, "Reading EMR credentials from Google Doc...");
    const docText = await readGoogleDocText(onboardingData.emrAccessDetailsUrl);
    const credentials = parseCredentials(docText);

    if (!credentials.username || !credentials.password) {
      throw new Error("Could not parse username/password from EMR Access Details Google Doc.");
    }

    progress(runId, "Opening BetterLetter onboarding form...");
    const practiceTab = await chrome.tabs.create({
      url: BETTERLETTER_NEW_PRACTICE_URL,
      active: true
    });
    const tabId = practiceTab.id;

    await waitForTabComplete(tabId);
    progress(runId, "Creating practice on BetterLetter...");

    const createResult = await runTabAction(tabId, "fill-new-practice", {
      odsCode: onboardingData.odsCode,
      displayName: onboardingData.practiceName,
      ehrTypeValue: onboardingData.ehrType.value,
      ehrTypeLabel: onboardingData.ehrType.label
    });

    const practiceId = createResult.practiceId;
    progress(runId, `Practice created: ${practiceId}.`);

    progress(runId, "Opening Service Settings...");
    await runTabAction(tabId, "click-settings-tab", { tab: "service" });

    if (onboardingData.selfServiceEnabled) {
      progress(runId, "Enabling Self Service...");
      await runTabAction(tabId, "set-self-service-enabled", { enabled: true });
    } else {
      progress(runId, "Subscription is not self-service, skipping checkbox.");
    }

    progress(runId, "Opening EHR Settings...");
    await runTabAction(tabId, "click-settings-tab", { tab: "ehr" });

    progress(runId, "Filling Practice CDB...");
    await runTabAction(tabId, "fill-practice-cdb", {
      practiceCdb: onboardingData.emisSiteCode
    });

    progress(runId, "Filling EMIS API credentials...");
    await runTabAction(tabId, "fill-section-credentials", {
      sectionTitle: "EMIS API Settings",
      username: credentials.username,
      password: credentials.password
    });

    progress(runId, "Filling EMIS Web credentials...");
    await runTabAction(tabId, "fill-section-credentials", {
      sectionTitle: "EMIS Web Settings",
      username: credentials.username,
      password: credentials.password
    });

    progress(runId, "Filling Docman credentials...");
    await runTabAction(tabId, "fill-section-credentials", {
      sectionTitle: "Docman Settings",
      username: credentials.username,
      password: credentials.password
    });

    progress(runId, "Onboarding flow completed.");

    return {
      practiceId,
      recordId: airtableRecord.id,
      odsCode: onboardingData.odsCode,
      practiceName: onboardingData.practiceName,
      selfServiceEnabled: onboardingData.selfServiceEnabled
    };
  } finally {
    runInProgress = false;
  }
}

function normalizeConfig(config) {
  return {
    airtableToken: String(config?.airtableToken || "").trim(),
    airtableBaseId: String(config?.airtableBaseId || "").trim(),
    airtableTable: String(config?.airtableTable || "").trim(),
    airtableView: String(config?.airtableView || "").trim(),
    airtableRecordId: String(config?.airtableRecordId || "").trim()
  };
}

async function fetchAirtableRecord(config) {
  const tablePath = `https://api.airtable.com/v0/${encodeURIComponent(config.airtableBaseId)}/${encodeURIComponent(config.airtableTable)}`;

  if (config.airtableRecordId) {
    const recordUrl = `${tablePath}/${encodeURIComponent(config.airtableRecordId)}`;
    const recordPayload = await airtableRequest(recordUrl, config.airtableToken);
    return recordPayload;
  }

  const url = new URL(tablePath);
  url.searchParams.set("maxRecords", "1");
  url.searchParams.set("pageSize", "1");
  if (config.airtableView) {
    url.searchParams.set("view", config.airtableView);
  }

  const payload = await airtableRequest(url.toString(), config.airtableToken);
  const record = payload?.records?.[0];

  if (!record) {
    throw new Error("No Airtable records found. Provide a record ID or use a view with records.");
  }

  return record;
}

async function airtableRequest(url, token) {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  if (!response.ok) {
    let responseMessage = `${response.status} ${response.statusText}`;
    try {
      const errorPayload = await response.json();
      const airtableMessage = errorPayload?.error?.message;
      if (airtableMessage) {
        responseMessage = `${responseMessage}: ${airtableMessage}`;
      }
    } catch (_error) {
      // Ignore parse failures and use default response message.
    }
    throw new Error(`Airtable request failed (${responseMessage}).`);
  }

  return response.json();
}

function parseOnboardingRecord(record) {
  const fields = record?.fields || {};

  const odsCode = readFieldText(fields, AIRTABLE_FIELD_CANDIDATES.odsCode);
  const practiceName = readFieldText(fields, AIRTABLE_FIELD_CANDIDATES.practiceName);
  const emrTypeRaw = readFieldText(fields, AIRTABLE_FIELD_CANDIDATES.emrType);
  const subscriptionType = readFieldText(fields, AIRTABLE_FIELD_CANDIDATES.subscriptionType);
  const emisSiteCode = readFieldText(fields, AIRTABLE_FIELD_CANDIDATES.emisSiteCode);
  const emrAccessDetailsUrl = readFieldUrl(fields, AIRTABLE_FIELD_CANDIDATES.emrAccessDetails);

  const missingFields = [];
  if (!odsCode) missingFields.push("ODS");
  if (!practiceName) missingFields.push("Practice Name");
  if (!emrTypeRaw) missingFields.push("EMR");
  if (!emisSiteCode) missingFields.push("EMIS Site Code");
  if (!emrAccessDetailsUrl) missingFields.push("EMR Access Details");

  if (missingFields.length > 0) {
    throw new Error(`Missing Airtable fields: ${missingFields.join(", ")}.`);
  }

  const ehrType = mapEhrType(emrTypeRaw);
  const selfServiceEnabled = /self[\s-_]*service/i.test(subscriptionType);

  return {
    odsCode,
    practiceName,
    ehrType,
    selfServiceEnabled,
    emisSiteCode,
    emrAccessDetailsUrl
  };
}

function mapEhrType(emrRaw) {
  const normalized = String(emrRaw || "").toLowerCase();

  if (normalized.includes("emis")) {
    return {
      value: "docman_emis",
      label: "docman_emis"
    };
  }

  return {
    value: normalized.replace(/\s+/g, "_"),
    label: String(emrRaw || "").trim()
  };
}

function readFieldText(fields, candidates) {
  const value = readFieldValue(fields, candidates);
  if (value === null || value === undefined) {
    return "";
  }
  return valueToText(value).trim();
}

function readFieldUrl(fields, candidates) {
  const value = readFieldValue(fields, candidates);
  return extractUrl(value);
}

function readFieldValue(fields, candidates) {
  const normalizedMap = new Map();
  Object.entries(fields).forEach(([key, value]) => {
    normalizedMap.set(normalizeFieldName(key), value);
  });

  for (const candidate of candidates) {
    const exact = normalizedMap.get(normalizeFieldName(candidate));
    if (exact !== undefined && exact !== null && exact !== "") {
      return exact;
    }
  }

  return null;
}

function normalizeFieldName(name) {
  return String(name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function valueToText(value) {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => valueToText(entry)).filter(Boolean).join(" ");
  }
  if (typeof value === "object") {
    if (typeof value.name === "string") return value.name;
    if (typeof value.url === "string") return value.url;
    if (typeof value.text === "string") return value.text;
  }
  return "";
}

function extractUrl(value) {
  if (!value) {
    return "";
  }

  if (typeof value === "string") {
    return findFirstUrl(value);
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      const entryUrl = extractUrl(entry);
      if (entryUrl) {
        return entryUrl;
      }
    }
    return "";
  }

  if (typeof value === "object") {
    if (typeof value.url === "string") {
      return value.url.trim();
    }
    if (typeof value.text === "string") {
      return findFirstUrl(value.text);
    }
  }

  return "";
}

function findFirstUrl(text) {
  const match = String(text || "").match(/https?:\/\/[^\s)]+/i);
  return match ? match[0].trim() : "";
}

async function readGoogleDocText(docUrl) {
  const tab = await chrome.tabs.create({
    url: docUrl,
    active: false
  });

  const tabId = tab.id;

  try {
    await waitForTabComplete(tabId, 45000);
    const response = await runTabAction(tabId, "read-doc-text", {}, { retries: 90, delayMs: 500 });
    const text = String(response.text || "").trim();

    if (!text) {
      throw new Error("Google Doc text is empty.");
    }

    return text;
  } finally {
    try {
      await chrome.tabs.remove(tabId);
    } catch (_error) {
      // Tab may have already been closed by the user.
    }
  }
}

function parseCredentials(text) {
  const rawText = String(text || "").replace(/\r/g, "\n");

  const username =
    extractInlineValue(rawText, [
      /\b(?:emis\s*username|docman\s*username|username|user\s*name)\b\s*(?:[:\-]|\t| {2,})\s*([^\n]+)/i
    ]) || extractAdjacentValue(rawText, /(emis\s*username|docman\s*username|username|user\s*name)/i);

  const password =
    extractInlineValue(rawText, [
      /\b(?:emis\s*password|docman\s*password|password)\b\s*(?:[:\-]|\t| {2,})\s*([^\n]+)/i
    ]) || extractAdjacentValue(rawText, /(emis\s*password|docman\s*password|password)/i);

  return {
    username: cleanupCredential(username),
    password: cleanupCredential(password)
  };
}

function extractInlineValue(text, patterns) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
  }
  return "";
}

function extractAdjacentValue(text, keyPattern) {
  const lines = String(text || "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (let i = 0; i < lines.length; i += 1) {
    if (!keyPattern.test(lines[i])) {
      continue;
    }

    const nextLine = lines[i + 1] || "";
    if (nextLine && !keyPattern.test(nextLine)) {
      return nextLine;
    }
  }

  return "";
}

function cleanupCredential(value) {
  return String(value || "")
    .replace(/^["'`]+/, "")
    .replace(/["'`]+$/, "")
    .trim();
}

async function runTabAction(tabId, action, payload = {}, options = {}) {
  const retries = Number.isFinite(options.retries) ? options.retries : 50;
  const delayMs = Number.isFinite(options.delayMs) ? options.delayMs : 400;
  let lastError = null;

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, {
        action,
        ...payload
      });

      if (!response) {
        throw new Error("No response from content script.");
      }
      if (response.ok === false) {
        throw new Error(response.error || `Action failed: ${action}`);
      }

      return response;
    } catch (error) {
      lastError = error;
      await sleep(delayMs);
    }
  }

  throw new Error(`Failed action "${action}": ${lastError ? lastError.message : "Unknown error"}`);
}

async function waitForTabComplete(tabId, timeoutMs = 30000) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const tab = await chrome.tabs.get(tabId);
    if (tab?.status === "complete") {
      return;
    }
    await sleep(250);
  }

  throw new Error(`Timed out waiting for tab ${tabId} to finish loading.`);
}

function progress(runId, message) {
  console.log(`[Onboarding] ${message}`);
  chrome.runtime
    .sendMessage({
      action: "onboarding-progress",
      runId,
      message
    })
    .catch(() => {
      // Popup may be closed; ignore.
    });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
