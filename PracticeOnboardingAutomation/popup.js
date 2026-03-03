const formFields = {
  airtableToken: document.getElementById("airtableToken"),
  airtableBaseId: document.getElementById("airtableBaseId"),
  airtableTable: document.getElementById("airtableTable"),
  airtableView: document.getElementById("airtableView"),
  airtableRecordId: document.getElementById("airtableRecordId")
};

const runButton = document.getElementById("runButton");
const statusEl = document.getElementById("status");
const logEl = document.getElementById("log");

let activeRunId = null;

chrome.runtime.onMessage.addListener((message) => {
  if (message?.action !== "onboarding-progress") {
    return;
  }

  if (!activeRunId || message.runId !== activeRunId) {
    return;
  }

  appendLog(message.message);
});

init().catch((error) => {
  setStatus(`Failed to initialize popup: ${error.message}`, "error");
});

runButton.addEventListener("click", async () => {
  const config = collectConfigFromForm();

  try {
    validateConfig(config);
  } catch (error) {
    setStatus(error.message, "error");
    return;
  }

  setRunningState(true);
  setStatus("Running onboarding automation...", "running");
  clearLog();

  activeRunId = `run-${Date.now()}`;
  appendLog("Starting onboarding run...");

  try {
    await chrome.storage.local.set({ onboardingAutomationConfig: config });

    const response = await chrome.runtime.sendMessage({
      action: "run-onboarding",
      runId: activeRunId,
      config
    });

    if (!response?.ok) {
      throw new Error(response?.error || "Unknown automation error.");
    }

    const result = response.result;
    appendLog(`Created practice: ${result.practiceId}`);
    appendLog("Automation completed.");
    setStatus(`Success: ${result.practiceId}`, "success");
  } catch (error) {
    appendLog(`ERROR: ${error.message}`);
    setStatus(error.message, "error");
  } finally {
    setRunningState(false);
  }
});

async function init() {
  const { onboardingAutomationConfig = {} } = await chrome.storage.local.get("onboardingAutomationConfig");

  formFields.airtableToken.value = onboardingAutomationConfig.airtableToken || "";
  formFields.airtableBaseId.value = onboardingAutomationConfig.airtableBaseId || "";
  formFields.airtableTable.value = onboardingAutomationConfig.airtableTable || "";
  formFields.airtableView.value = onboardingAutomationConfig.airtableView || "";
  formFields.airtableRecordId.value = onboardingAutomationConfig.airtableRecordId || "";
}

function collectConfigFromForm() {
  return {
    airtableToken: formFields.airtableToken.value.trim(),
    airtableBaseId: formFields.airtableBaseId.value.trim(),
    airtableTable: formFields.airtableTable.value.trim(),
    airtableView: formFields.airtableView.value.trim(),
    airtableRecordId: formFields.airtableRecordId.value.trim()
  };
}

function validateConfig(config) {
  if (!config.airtableToken) {
    throw new Error("Airtable token is required.");
  }

  if (!config.airtableBaseId) {
    throw new Error("Airtable base ID is required.");
  }

  if (!config.airtableTable) {
    throw new Error("Airtable table is required.");
  }
}

function setRunningState(isRunning) {
  runButton.disabled = isRunning;
}

function setStatus(message, type) {
  statusEl.textContent = message;
  statusEl.className = type || "";
}

function appendLog(message) {
  const time = new Date().toLocaleTimeString();
  logEl.textContent += `[${time}] ${message}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

function clearLog() {
  logEl.textContent = "";
}
