const BETTERLETTER_BOTS = "https://app.betterletter.ai/admin_panel/bots/";
let provisioning = false;
let runnerMutation = Promise.resolve();

function serializeRunner(task) {
  const result = runnerMutation.then(task, task);
  runnerMutation = result.catch(() => {});
  return result;
}

function mutateRunner(options, updater) {
  return serializeRunner(async () => {
    const { blRunner: current = {} } = await chrome.storage.local.get("blRunner");
    if (options.expectedRunId && current.runId !== options.expectedRunId) {
      return { ok: false, cancelled: true, state: current };
    }
    if (options.requireActive && !current.active) {
      return { ok: false, cancelled: true, state: current };
    }
    const values = await updater(current);
    if (!values) return { ok: false, cancelled: true, state: current };
    const next = options.replace ? values : { ...current, ...values };
    next.updatedAt = new Date().toISOString();
    await chrome.storage.local.set({ blRunner: next });
    return { ok: true, state: next };
  });
}

function dashboardUrl(practiceId) {
  const url = new URL("https://app.betterletter.ai/admin_panel/bots/dashboard");
  url.searchParams.set("job_types", "docman_delete_original");
  url.searchParams.set("practice_ids", practiceId);
  url.searchParams.set("status", "paused");
  return url.href;
}

async function updateBadge(state) {
  if (!state) return chrome.action.setBadgeText({ text: "" });
  if (state.active) {
    const done = state.completedCount || 0;
    const left = Number.isInteger(state.remainingCount) ? state.remainingCount : "?";
    await chrome.action.setBadgeBackgroundColor({ color: "#1769e0" });
    await chrome.action.setBadgeText({ text: `${done}/${left}` });
    await chrome.action.setTitle({ title: `BetterLetter: ${done} completed, ${left} remaining` });
  } else if (state.phase === "starting") {
    await chrome.action.setBadgeBackgroundColor({ color: "#1769e0" });
    await chrome.action.setBadgeText({ text: "…" });
    await chrome.action.setTitle({ title: "BetterLetter: opening worker window" });
  } else if (state.phase === "complete") {
    await chrome.action.setBadgeBackgroundColor({ color: "#16803a" });
    await chrome.action.setBadgeText({ text: "✓" });
    await chrome.action.setTitle({ title: `BetterLetter: complete (${state.completedCount || 0} processed)` });
  } else if (state.phase === "stopped" && state.message !== "Stopped by user") {
    await chrome.action.setBadgeBackgroundColor({ color: "#b42318" });
    await chrome.action.setBadgeText({ text: "!" });
    await chrome.action.setTitle({ title: `BetterLetter stopped: ${state.message || "check status"}` });
  } else {
    await chrome.action.setBadgeText({ text: "" });
    await chrome.action.setTitle({ title: "BetterLetter Safe Job Completer" });
  }
}

async function closeWorkerForRun(snapshot) {
  if (!snapshot?.dedicatedWindow || snapshot.workerWindowId == null) return;
  try { await chrome.windows.remove(snapshot.workerWindowId); } catch { /* It may already be closed. */ }
  await mutateRunner({ expectedRunId: snapshot.runId }, (latest) =>
    latest.active ? null : { workerWindowId: null, targetTabId: null, workerVisibility: "closed" });
}

async function startRunner(message) {
  const practiceName = String(message?.config?.practiceName || "").trim();
  const practiceId = String(message?.config?.practiceId || "").trim().toUpperCase();
  const delaySeconds = Math.max(1, Math.min(120, Number(message?.config?.delaySeconds) || 1));
  if (!practiceName || !/^[A-Z][A-Z0-9]{4,9}$/.test(practiceId) ||
      message?.config?.jobType !== "docman_delete_original" || !Number.isInteger(message?.sourceTabId)) {
    return { ok: false, error: "The start request was invalid." };
  }

  const sourceTab = await chrome.tabs.get(message.sourceTabId).catch(() => null);
  if (!sourceTab?.url?.startsWith(BETTERLETTER_BOTS) || sourceTab.windowId == null) {
    return { ok: false, error: "Open the BetterLetter bots dashboard in the active tab first." };
  }
  const { blRunner: prior = {} } = await chrome.storage.local.get("blRunner");
  const priorStartedAt = Date.parse(prior.startedAt || "");
  if (prior.phase === "starting" && (!Number.isFinite(priorStartedAt) ||
      Date.now() - priorStartedAt >= 60000)) {
    await mutateRunner({ expectedRunId: prior.runId }, () => ({ active: false, phase: "stopped",
      message: "A previous worker startup was interrupted; opening a fresh worker." }));
    await closeWorkerForRun({ ...prior, active: false, phase: "stopped" });
  }
  const runId = crypto.randomUUID();
  const config = { practiceName, practiceId, jobType: "docman_delete_original", delaySeconds,
    dedicatedWindow: true, dashboardUrl: dashboardUrl(practiceId) };
  const starting = {
    active: false, phase: "starting", runId, dedicatedWindow: true,
    targetTabId: null, workerWindowId: null, sourceWindowId: sourceTab.windowId,
    workerVisibility: "opening", startedAt: new Date().toISOString(),
    completedCount: 0, remainingCount: null,
    currentJob: null, currentDocumentId: null, currentStatus: null,
    expectedJobUrl: null, openingAt: null, confirmedAt: null,
    dialogAttempts: 0, completionAttempts: 0, confirmationInfo: null,
    liveViewReloads: 0, detailRecoveryReloads: 0, dashboardRecoveryReloads: 0,
    unacceptedDispatches: 0, liveViewInfo: null,
    lastDispatchPushed: null, lastDispatchAcknowledged: null,
    suspensionRecovery: false, suspensionReason: null, resumeWindowId: null,
    processed: [], message: "Opening a dedicated BetterLetter worker window", config
  };
  const acquired = await mutateRunner({ replace: true }, (previous) =>
    previous.active || previous.phase === "starting" ? null : starting);
  if (!acquired.ok) {
    return { ok: false, error: "A run is already active or starting. Stop it before starting another one." };
  }

  let workerWindowId = null;
  try {
    const worker = await chrome.windows.create({ url: config.dashboardUrl, type: "normal",
      focused: false, state: "normal", width: 1000, height: 760 });
    workerWindowId = worker.id ?? null;
    let workerTab = worker.tabs?.[0];
    if (!workerTab?.id && workerWindowId != null) {
      [workerTab] = await chrome.tabs.query({ windowId: workerWindowId });
    }
    if (workerWindowId == null || !workerTab?.id) throw new Error("Chrome did not return the new worker tab.");

    const registered = await mutateRunner({ expectedRunId: runId }, (latest) =>
      latest.phase === "starting" ? { workerWindowId, targetTabId: workerTab.id } : null);
    if (!registered.ok) throw new Error("Start was cancelled.");

    await chrome.tabs.update(workerTab.id, { active: true, autoDiscardable: false });
    const [verifiedWindow, verifiedTab] = await Promise.all([
      chrome.windows.get(workerWindowId),
      chrome.tabs.get(workerTab.id)
    ]);
    const verifiedUrl = [verifiedTab.url, verifiedTab.pendingUrl]
      .find((value) => value?.startsWith(BETTERLETTER_BOTS));
    if (verifiedWindow.state === "minimized" || verifiedTab.windowId !== workerWindowId || !verifiedUrl) {
      throw new Error("The dedicated worker did not open on the BetterLetter dashboard.");
    }

    const promoted = await mutateRunner({ expectedRunId: runId }, (latest) =>
      latest.phase === "starting" ? { active: true, phase: "dashboard",
        targetTabId: workerTab.id, workerWindowId, workerVisibility: "waiting for page",
        message: "Starting in the dedicated worker window" } : null);
    if (!promoted.ok) throw new Error("Start was cancelled.");
    await chrome.windows.update(sourceTab.windowId, { focused: true }).catch(() => {});
    return { ok: true, runId, workerWindowId, targetTabId: workerTab.id };
  } catch (error) {
    if (workerWindowId != null) {
      try { await chrome.windows.remove(workerWindowId); } catch { /* Already closed. */ }
    }
    await mutateRunner({ expectedRunId: runId }, (latest) =>
      latest.phase === "starting" ? { active: false, phase: "stopped",
        workerWindowId: null, targetTabId: null, workerVisibility: "closed",
        message: `Could not start worker: ${error?.message || String(error)}` } : null);
    return { ok: false, error: error?.message || String(error) };
  }
}

async function stopRunner(message = "Stopped by user", expectedRunId = null) {
  const result = await mutateRunner({ expectedRunId }, (current) =>
    current.runId ? { active: false, phase: "stopped", message } : null);
  return { ok: result.ok || !expectedRunId };
}

async function stopIfWorkerChanged(field, id, message) {
  const { blRunner = {} } = await chrome.storage.local.get("blRunner");
  if (!blRunner.active || blRunner[field] !== id) return;
  await stopRunner(message, blRunner.runId);
}

async function recoverSuspendedWorker(tabId, reason) {
  const { blRunner = {} } = await chrome.storage.local.get("blRunner");
  if (!blRunner.active || blRunner.targetTabId !== tabId || blRunner.suspensionRecovery) return;
  const workerWindow = await chrome.windows.get(blRunner.workerWindowId).catch(() => null);
  if (!workerWindow) return stopRunner("Chrome suspended the worker and its window could not be recovered.", blRunner.runId);
  if (workerWindow.state === "minimized") {
    await mutateRunner({ expectedRunId: blRunner.runId, requireActive: true }, (latest) =>
      latest.targetTabId === tabId && !latest.suspensionRecovery ? {
      suspensionRecovery: true,
      suspensionReason: reason,
      recoveryStartedAt: new Date().toISOString(),
      workerVisibility: "minimized",
      message: "Chrome paused the minimized worker. Restore its window; no attempt was consumed."
      } : null);
    return;
  }

  const lastFocused = await chrome.windows.getLastFocused().catch(() => null);
  const resumeWindowId = lastFocused?.id !== blRunner.workerWindowId ? lastFocused?.id : blRunner.sourceWindowId;
  const marked = await mutateRunner({ expectedRunId: blRunner.runId, requireActive: true }, (latest) =>
    latest.targetTabId === tabId && !latest.suspensionRecovery ? {
      suspensionRecovery: true,
      suspensionReason: reason,
      recoveryStartedAt: new Date().toISOString(),
      resumeWindowId: resumeWindowId ?? latest.sourceWindowId,
      workerVisibility: `recovering from Chrome ${reason}`,
      message: `Chrome ${reason} the worker; waking the same page without consuming an attempt.`
    } : null);
  if (!marked.ok) return;

  try {
    // Activating the tab within its own (unfocused) window can resume a
    // frozen or discarded tab without stealing OS focus from the window the
    // user is actively working in. Only steal focus if that gentle wake does
    // not resolve within a short grace period.
    await chrome.tabs.update(tabId, { active: true, autoDiscardable: false });
    setTimeout(() => { void escalateWorkerWake(blRunner.runId, tabId, marked.state.recoveryStartedAt); }, 8000);
  } catch (error) {
    await stopRunner(`Could not wake the Chrome-${reason} worker: ${error?.message || String(error)}`, blRunner.runId);
  }
}

async function escalateWorkerWake(runId, tabId, recoveryStartedAt) {
  const { blRunner = {} } = await chrome.storage.local.get("blRunner");
  if (!blRunner.active || blRunner.runId !== runId || blRunner.targetTabId !== tabId ||
      !blRunner.suspensionRecovery || blRunner.recoveryStartedAt !== recoveryStartedAt) return;
  try {
    await chrome.tabs.update(tabId, { active: true, autoDiscardable: false });
    await chrome.windows.update(blRunner.workerWindowId, { focused: true, state: "normal" });
  } catch (error) {
    await stopRunner(`Could not wake the Chrome-${blRunner.suspensionReason} worker: ${error?.message || String(error)}`, runId);
  }
}

async function acknowledgeWorkerAwake(message, senderTabId) {
  const { blRunner = {} } = await chrome.storage.local.get("blRunner");
  if (!blRunner.active || blRunner.runId !== message.runId ||
      blRunner.targetTabId !== senderTabId || !blRunner.suspensionRecovery) {
    return { ok: false, cancelled: true };
  }
  const resumeWindowId = blRunner.resumeWindowId;
  const resumed = await mutateRunner({ expectedRunId: blRunner.runId, requireActive: true }, (latest) =>
    latest.targetTabId === senderTabId && latest.suspensionRecovery ? {
      suspensionRecovery: false,
      suspensionReason: null,
      recoveryStartedAt: null,
      resumeWindowId: null,
      workerVisibility: message.visibility || "awake",
      message: "Chrome worker resumed; continuing the same job safely."
    } : null);
  if (!resumed.ok) return { ok: false, cancelled: true };
  await chrome.alarms.clear(`worker-recovery:${blRunner.runId}`);
  if (resumeWindowId != null && resumeWindowId !== blRunner.workerWindowId) {
    await chrome.windows.update(resumeWindowId, { focused: true }).catch(() => {});
  }
  return { ok: true };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "getTabId") {
    sendResponse({ tabId: sender.tab?.id ?? null });
    return;
  }
  if (message?.type === "startRunner") {
    if (provisioning) {
      sendResponse({ ok: false, error: "A worker is already being opened." });
      return;
    }
    provisioning = true;
    void startRunner(message).then(sendResponse).catch((error) =>
      sendResponse({ ok: false, error: error?.message || String(error) }))
      .finally(() => { provisioning = false; });
    return true;
  }
  if (message?.type === "stopRunner") {
    void stopRunner().then(sendResponse).catch((error) =>
      sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }
  if (message?.type === "patchRunner") {
    const protectedFields = new Set(["runId", "targetTabId", "workerWindowId", "sourceWindowId",
      "dedicatedWindow", "config", "startedAt"]);
    const values = Object.fromEntries(Object.entries(message.values || {})
      .filter(([key]) => !protectedFields.has(key)));
    void mutateRunner({ expectedRunId: message.runId, requireActive: true }, (current) =>
      current.suspensionRecovery ? null : values)
      .then(sendResponse).catch((error) =>
        sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }
  if (message?.type === "workerAwake") {
    void acknowledgeWorkerAwake(message, sender.tab?.id ?? null)
      .then(sendResponse).catch((error) =>
        sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.blRunner) return;
  const next = changes.blRunner.newValue;
  void updateBadge(next);
  if (next && !next.active && next.phase !== "starting" && next.workerWindowId != null) {
    void closeWorkerForRun(next);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void stopIfWorkerChanged("targetTabId", tabId, "The BetterLetter worker tab was closed; no further action was taken.");
});

chrome.windows.onRemoved.addListener((windowId) => {
  void stopIfWorkerChanged("workerWindowId", windowId, "The dedicated worker window was closed; no further action was taken.");
});

chrome.tabs.onDetached.addListener((tabId) => {
  void stopIfWorkerChanged("targetTabId", tabId, "The BetterLetter worker tab was moved; no further action was taken.");
});

chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  const { blRunner = {} } = await chrome.storage.local.get("blRunner");
  if (blRunner.active && blRunner.workerWindowId === windowId && blRunner.targetTabId !== tabId) {
    await stopRunner("Another tab was activated in the worker window; no further action was taken.", blRunner.runId);
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.discarded === true || changeInfo.frozen === true) {
    const reason = changeInfo.discarded === true ? "discarded" : "froze";
    void recoverSuspendedWorker(tabId, reason).then(async () => {
      const { blRunner = {} } = await chrome.storage.local.get("blRunner");
      if (blRunner.active && blRunner.targetTabId === tabId && blRunner.suspensionRecovery) {
        await chrome.alarms.create(`worker-recovery:${blRunner.runId}`, { delayInMinutes: 1 });
      }
    });
  } else if (changeInfo.url && !changeInfo.url.startsWith(BETTERLETTER_BOTS)) {
    void stopIfWorkerChanged("targetTabId", tabId, "The worker left the BetterLetter bots pages; no further action was taken.");
  } else if (changeInfo.status === "loading") {
    void (async () => {
      const { blRunner = {} } = await chrome.storage.local.get("blRunner");
      if (!blRunner.active || blRunner.targetTabId !== tabId) return;
      const urls = [changeInfo.url, tab.pendingUrl, tab.url].filter(Boolean);
      if (!urls.some((value) => value.startsWith(BETTERLETTER_BOTS))) {
        await stopRunner("The worker navigated outside the BetterLetter bots pages; no further action was taken.", blRunner.runId);
      }
    })();
  }
});

chrome.alarms.onAlarm.addListener(async ({ name }) => {
  if (!name.startsWith("worker-recovery:")) return;
  const runId = name.slice("worker-recovery:".length);
  const { blRunner = {} } = await chrome.storage.local.get("blRunner");
  if (!blRunner.active || blRunner.runId !== runId || !blRunner.suspensionRecovery) return;
  await mutateRunner({ expectedRunId: runId, requireActive: true }, (latest) =>
    latest.suspensionRecovery ? {
      message: "Chrome has not resumed the worker yet. Restore its window to continue; no attempt was consumed."
    } : null);
});

chrome.windows.onBoundsChanged.addListener(async (window) => {
  const { blRunner = {} } = await chrome.storage.local.get("blRunner");
  if (!blRunner.active || blRunner.workerWindowId !== window.id) return;
  if (window.state === "minimized") {
    await mutateRunner({ expectedRunId: blRunner.runId, requireActive: true }, (latest) =>
      latest.workerWindowId === window.id ? { workerVisibility: "minimized",
        message: "Worker window is minimized. Restore it; no completion attempt will be made." } : null);
    return;
  }
  if (blRunner.suspensionRecovery) {
    try {
      await chrome.tabs.update(blRunner.targetTabId, { active: true, autoDiscardable: false });
      await chrome.windows.update(window.id, { focused: true, state: "normal" });
    } catch { /* The existing recovery state remains safe and visible in the popup. */ }
  }
});

chrome.storage.local.get("blRunner").then(async ({ blRunner }) => {
  await updateBadge(blRunner);
  if (!blRunner) return;
  const startingAge = Date.now() - Date.parse(blRunner.startedAt || "");
  if (blRunner.phase === "starting" && (!Number.isFinite(startingAge) || startingAge >= 60000)) {
    await mutateRunner({ expectedRunId: blRunner.runId }, () => ({ active: false, phase: "stopped",
      message: "A previous worker startup was interrupted; start again." }));
    await closeWorkerForRun({ ...blRunner, active: false, phase: "stopped" });
  } else if (!blRunner.active && blRunner.workerWindowId != null) {
    await closeWorkerForRun(blRunner);
  }
});
