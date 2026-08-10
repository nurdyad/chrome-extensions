chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "getTabId") sendResponse({ tabId: sender.tab?.id ?? null });
});

async function updateBadge(state) {
  if (!state) return chrome.action.setBadgeText({ text: "" });
  if (state.active) {
    const done = state.completedCount || 0;
    const left = Number.isInteger(state.remainingCount) ? state.remainingCount : "?";
    await chrome.action.setBadgeBackgroundColor({ color: "#1769e0" });
    await chrome.action.setBadgeText({ text: `${done}/${left}` });
    await chrome.action.setTitle({ title: `BetterLetter: ${done} completed, ${left} remaining` });
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

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.blRunner) updateBadge(changes.blRunner.newValue);
});
chrome.storage.local.get("blRunner").then(({ blRunner }) => updateBadge(blRunner));
