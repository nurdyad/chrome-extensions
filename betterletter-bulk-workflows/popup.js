// ---- DOM references ----
const statusEl = document.getElementById("status");
const namesEl = document.getElementById("names");
const progressContainer = document.getElementById("progressContainer");
const progressBar = document.getElementById("progressBar");

// ---- Progress state ---
let startTime = null;
let isRunning = false;

// Hide progress bar initially
progressContainer.style.display = "none";

// ---- Restore saved options ----
chrome.storage.sync.get(
  { skipDuplicates: true, titleCase: false },
  (opts) => {
    document.getElementById("skipDuplicates").checked = opts.skipDuplicates;
    document.getElementById("titleCase").checked = opts.titleCase;
  }
);

function parseNames(raw) {
  // Split into lines, trim, ignore blanks.
  // If a line has tabs (Airtable rows), take first column.
  // Also handle commas/semicolons lightly by preferring the first field only if it's clearly tabular.
  return raw
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      // Airtable: tab-separated columns
      if (line.includes("\t")) return line.split("\t")[0].trim();

      // If user pasted "Name, ..." from CSV accidentally, take first segment ONLY when it looks like CSV
      // (i.e., there are multiple commas). Otherwise keep full line to avoid breaking "Last, First".
      const commaCount = (line.match(/,/g) || []).length;
      if (commaCount >= 2) return line.split(",")[0].trim();

      return line;
    })
    .filter(Boolean);
}

function formatEta(ms) {
  if (ms <= 0 || !isFinite(ms)) return "—";

  const seconds = Math.ceil(ms / 1000);
  if (seconds < 60) return `${seconds}s`;

  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}m ${secs}s`;
}


function getOptions() {
  return {
    skipDuplicates: document.getElementById("skipDuplicates")?.checked ?? true,
    titleCase: document.getElementById("titleCase")?.checked ?? false
  };
}

async function runOnActiveTab(payload) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab found.");

  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ["content.js"]
  });

  const result = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (payload) => window.__BL_BULK_WORKFLOW_RUN__(payload),
    args: [payload]
  });

  return result?.[0]?.result;
}

// ---- Progress listener (ADD THIS HERE) ----
chrome.runtime.onMessage.addListener((message) => {
  if (!isRunning) return;

  if (message?.type === "BL_PROGRESS") {
    const { current, total } = message;
    const percent = Math.round((current / total) * 100);

    progressContainer.style.display = "block";
    progressBar.style.width = `${percent}%`;

    // ETA calculation
    const elapsedMs = Date.now() - startTime;
    const avgPerItem = elapsedMs / Math.max(current, 1);
    const remainingMs = Math.round(avgPerItem * (total - current));

    statusEl.textContent =
      `Creating ${current} / ${total}… · ETA ${formatEta(remainingMs)}`;
  }
});

// ---- Test parse button ----
document.getElementById("test").addEventListener("click", () => {
  const parsed = parseNames(namesEl.value);
  statusEl.textContent =
    parsed.length
      ? `Parsed ${parsed.length} names:\n- ` + parsed.slice(0, 20).join("\n- ") + (parsed.length > 20 ? "\n..." : "")
      : "No names parsed.";
});

// ---- Submit handler ----
document.getElementById("submit").addEventListener("click", async () => {
  const submitBtn = document.getElementById("submit");

  try {
    const names = parseNames(namesEl.value);

    if (!names.length) {
      statusEl.textContent = "Paste at least one name first.";
      return;
    }

    // ✅ Confirmation for large batches
    if (names.length > 30) {
      const ok = confirm(
        `You are about to create ${names.length} workflow groups.\n\nDo you want to continue?`
      );
      if (!ok) return;
    }

    // ✅ Lock UI
    submitBtn.disabled = true;
    submitBtn.textContent = "Running…";

    // Start progress tracking
    isRunning = true;
    startTime = Date.now();
    progressBar.style.width = "0%";
    progressContainer.style.display = "block";

    statusEl.textContent = `Starting… (0 / ${names.length})`;

    chrome.storage.sync.set({
        skipDuplicates: document.getElementById("skipDuplicates").checked,
        titleCase: document.getElementById("titleCase").checked
    });

    const res = await runOnActiveTab({
      names,
      options: getOptions()
    });

    if (res?.ok) {
      statusEl.textContent =
        `Done ✅\nCreated: ${res.created}\nSkipped: ${res.skipped}\nErrors: ${res.errors.length}`;

      // ✅ Auto-clear textarea after success
      namesEl.value = "";
    } else {
      statusEl.textContent = `Failed ❌\n${res?.error || "Unknown error"}`;
    }
  } catch (e) {
    statusEl.textContent = `Error ❌\n${e.message || e}`;
  } finally {
    // ✅ Always restore button state
    submitBtn.disabled = false;
    submitBtn.textContent = "Submit";
    isRunning = false;
  }
});
