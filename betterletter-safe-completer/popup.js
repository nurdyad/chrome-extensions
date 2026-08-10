const $ = (id) => document.getElementById(id);

function dashboardUrl(practiceId) {
  const url = new URL("https://app.betterletter.ai/admin_panel/bots/dashboard");
  url.searchParams.set("job_types", "docman_delete_original");
  url.searchParams.set("practice_ids", practiceId);
  url.searchParams.set("status", "paused");
  return url.href;
}

function isExactDashboard(value, practiceId) {
  try {
    const url = new URL(value);
    return url.origin === "https://app.betterletter.ai" &&
      url.pathname === "/admin_panel/bots/dashboard" &&
      url.searchParams.get("job_types") === "docman_delete_original" &&
      url.searchParams.get("practice_ids") === practiceId &&
      url.searchParams.get("status") === "paused";
  } catch { return false; }
}

async function render() {
  const { blRunner: state = {} } = await chrome.storage.local.get("blRunner");
  if (state.config) {
    $("practiceName").value = state.config.practiceName || "";
    $("practiceId").value = state.config.practiceId || "";
    $("delaySeconds").value = state.config.delaySeconds || 2;
  }
  $("status").textContent = [
    `Extension version: ${chrome.runtime.getManifest().version}`,
    `State: ${state.active ? "RUNNING" : "stopped"}`,
    `Completed this run: ${state.completedCount || 0}`,
    `Remaining: ${Number.isInteger(state.remainingCount) ? state.remainingCount : "waiting to count"}`,
    `Current document ID: ${state.currentDocumentId || "none"}`,
    `Job status: ${state.currentStatus || "waiting"}`,
    `Job UUID: ${state.currentJob || "none"}`,
    `Completion attempts: ${state.completionAttempts || 0}/2`,
    `Message: ${state.message || "Ready"}`
  ].join("\n");
}

$("start").addEventListener("click", async () => {
  const practiceName = $("practiceName").value.trim();
  const practiceId = $("practiceId").value.trim().toUpperCase();
  const delaySeconds = Math.max(2, Math.min(120, Number($("delaySeconds").value) || 2));
  if (!practiceName || !/^[A-Z][A-Z0-9]{4,9}$/.test(practiceId)) {
    $("status").textContent = "Enter a practice name and valid ODS ID.";
    return;
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url?.startsWith("https://app.betterletter.ai/admin_panel/bots/")) {
    $("status").textContent = "Open the BetterLetter bots dashboard in the active tab first.";
    return;
  }
  const blRunner = {
    active: true, targetTabId: tab.id, runId: crypto.randomUUID(),
    startedAt: new Date().toISOString(), completedCount: 0, remainingCount: null,
    currentJob: null, currentDocumentId: null, currentStatus: null,
    expectedJobUrl: null, openingAt: null, confirmedAt: null, completionAttempts: 0,
    phase: "dashboard", processed: [], message: "Starting on filtered dashboard",
    config: { practiceName, practiceId, jobType: "docman_delete_original", delaySeconds,
      dashboardUrl: dashboardUrl(practiceId) }
  };
  await chrome.storage.local.set({ blRunner });
  if (!isExactDashboard(tab.url, practiceId)) await chrome.tabs.update(tab.id, { url: blRunner.config.dashboardUrl });
  render();
});

$("stop").addEventListener("click", async () => {
  const { blRunner = {} } = await chrome.storage.local.get("blRunner");
  await chrome.storage.local.set({ blRunner: { ...blRunner, active: false, currentJob: null,
    phase: "stopped", message: "Stopped by user" } });
  render();
});

chrome.storage.onChanged.addListener(render);
render();
