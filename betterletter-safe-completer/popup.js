const $ = (id) => document.getElementById(id);

async function render() {
  const { blRunner: state = {} } = await chrome.storage.local.get("blRunner");
  if (state.config) {
    $("practiceName").value = state.config.practiceName || "";
    $("practiceId").value = state.config.practiceId || "";
    $("delaySeconds").value = state.config.delaySeconds || 1;
  }
  $("status").textContent = [
    `Extension version: ${chrome.runtime.getManifest().version}`,
    `State: ${state.active ? "RUNNING" : state.phase === "starting" ? "STARTING" : "stopped"}`,
    `Runner mode: ${state.dedicatedWindow === false ? "current tab" : "separate worker window"}`,
    `Worker page: ${state.workerVisibility || "waiting"}`,
    `Chrome recovery: ${state.suspensionRecovery ? "waking worker" : "ready"}`,
    `Completed this run: ${state.completedCount || 0}`,
    `Remaining: ${Number.isInteger(state.remainingCount) ? state.remainingCount : "waiting to count"}`,
    `Current document ID: ${state.currentDocumentId || "none"}`,
    `Job status: ${state.currentStatus || "waiting"}`,
    `Job UUID: ${state.currentJob || "none"}`,
    `Dialog attempts: ${state.dialogAttempts || 0}/2`,
    `Completion attempts: ${state.completionAttempts || 0}/2`,
    `LiveView connection: ${state.liveViewInfo || "waiting"}`,
    `LiveView reloads: ${state.liveViewReloads || 0}/2`,
    `Job page recovery reloads: ${state.detailRecoveryReloads || 0}/2`,
    `Dashboard recovery reloads: ${state.dashboardRecoveryReloads || 0}/2`,
    `Phoenix delivery: ${state.lastDispatchPushed == null ? "waiting" : state.lastDispatchPushed ?
      `push observed, acknowledgement ${state.lastDispatchAcknowledged ? "observed" : "pending/not observed"}` :
      "push not observed"}`,
    `Unaccepted delivery checks: ${state.unacceptedDispatches || 0}/2`,
    `Confirmation controls: ${state.confirmationInfo || "waiting"}`,
    `Message: ${state.message || "Ready"}`
  ].join("\n");
}

$("start").addEventListener("click", async () => {
  const practiceName = $("practiceName").value.trim();
  const practiceId = $("practiceId").value.trim().toUpperCase();
  const delaySeconds = Math.max(1, Math.min(120, Number($("delaySeconds").value) || 1));
  if (!practiceName || !/^[A-Z][A-Z0-9]{4,9}$/.test(practiceId)) {
    $("status").textContent = "Enter a practice name and valid ODS ID.";
    return;
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url?.startsWith("https://app.betterletter.ai/admin_panel/bots/")) {
    $("status").textContent = "Open the BetterLetter bots dashboard in the active tab first.";
    return;
  }
  try {
    $("status").textContent = "Opening a dedicated BetterLetter worker window…";
    const result = await chrome.runtime.sendMessage({ type: "startRunner", sourceTabId: tab.id,
      config: { practiceName, practiceId, jobType: "docman_delete_original", delaySeconds } });
    if (!result?.ok) throw new Error(result?.error || "The background runner did not start.");
    await render();
  } catch (error) {
    $("status").textContent = `Could not start the worker: ${error?.message || String(error)}`;
  }
});

$("stop").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "stopRunner" });
  await render();
});

chrome.storage.onChanged.addListener(render);
render();
