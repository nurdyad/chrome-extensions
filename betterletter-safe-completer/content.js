(() => {
  const JOB_TYPE = "docman_delete_original";
  const DASHBOARD = "/admin_panel/bots/dashboard";
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const started = Date.now();
  let busy = false;
  const tabId = chrome.runtime.sendMessage({ type: "getTabId" }).then((r) => r?.tabId ?? null).catch(() => null);
  const norm = (value) => (value || "").replace(/\s+/g, " ").trim();
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function pageLoadFinished() {
    if (document.readyState !== "complete") return false;
    const progress = document.querySelector("#nprogress");
    return !progress || !visible(progress);
  }

  function controlDisabled(control) {
    if (!control || !control.isConnected) return true;
    const clickable = control.closest("button, a, [role=button]") || control;
    const style = getComputedStyle(clickable);
    const classText = `${clickable.className || ""}`.toLowerCase();
    const disabledMarkup = clickable.matches(":disabled, [disabled], [aria-disabled='true'], [aria-busy='true']") ||
      Boolean(clickable.querySelector("[disabled], [aria-disabled='true'], [aria-busy='true']"));
    const disabledClass = /(^|[\s_-])(disabled|loading|opacity-\d+|cursor-not-allowed|grayscale)([\s_-]|$)/.test(classText);
    return disabledMarkup || disabledClass || style.pointerEvents === "none" ||
      Number.parseFloat(style.opacity || "1") < 0.75;
  }

  function labelledValue(labelText) {
    const label = [...document.querySelectorAll("label")]
      .find((item) => norm(item.textContent).toLowerCase() === labelText.toLowerCase());
    if (!label?.parentElement) return null;
    const value = label.parentElement.querySelector("span.col-span-4.font-bold") ||
      [...label.parentElement.children].find((item) =>
      item !== label && item.tagName !== "LABEL");
    return value ? norm(value.textContent) : null;
  }

  function detailDocumentId() {
    const value = labelledValue("Document ID");
    if (value && /^\d+$/.test(value)) return value;
    const annotation = document.querySelector('a[href*="/mailroom/annotations/"]');
    return annotation?.getAttribute("href")?.match(/\/mailroom\/annotations\/(\d+)/)?.[1] || null;
  }

  function detailStatus() {
    const value = labelledValue("Status")?.toLowerCase();
    return value === "paused" || value === "completed" ? value : null;
  }

  function confirmationModalOpen() {
    const modal = document.querySelector("#confirm-complete");
    return Boolean(modal && controlIsRendered(modal));
  }

  async function state() {
    try {
      if (!chrome.runtime?.id) return null;
      return (await chrome.storage.local.get("blRunner")).blRunner;
    } catch { return null; }
  }
  async function patch(values) {
    try {
      if (!chrome.runtime?.id) return;
      const current = await state();
      if (current) await chrome.storage.local.set({ blRunner: { ...current, ...values, updatedAt: new Date().toISOString() } });
    } catch { /* Extension was reloaded; the old content-script context must exit quietly. */ }
  }
  const stop = (message) => patch({ active: false, phase: "stopped", message });
  const visible = (element) => {
    for (let node = element; node?.nodeType === Node.ELEMENT_NODE; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") return false;
    }
    return Boolean(element);
  };
  const exact = (text, selector = "button, a, [role=button]") => [...document.querySelectorAll(selector)]
    .filter((el) => visible(el) && norm(el.value || el.textContent).toLowerCase() === text.toLowerCase());

  function exactDashboard(config) {
    const url = new URL(location.href);
    const has = (key, value) => url.searchParams.getAll(key).flatMap((v) => v.split(",")).includes(value);
    return location.origin === "https://app.betterletter.ai" && url.pathname === DASHBOARD &&
      has("job_types", JOB_TYPE) && has("practice_ids", config.practiceId) && has("status", "paused");
  }
  function rowForJobLink(link, config) {
    const semantic = link.closest("tr") || link.closest("[role=row]");
    if (semantic) return semantic;
    for (let node = link.parentElement; node && node !== document.body; node = node.parentElement) {
      const text = norm(node.textContent);
      const uuidLinks = [...node.querySelectorAll("a[href]")]
        .filter((item) => UUID.test(norm(item.textContent)));
      if (uuidLinks.length === 1 && text.includes(JOB_TYPE) &&
          text.includes(config.practiceName) && text.includes(config.practiceId)) {
        return node;
      }
    }
    return null;
  }
  function rowJobs(config) {
    return [...document.querySelectorAll("a[href]")].filter((link) => {
      if (!UUID.test(norm(link.textContent))) return false;
      const row = rowForJobLink(link, config);
      const text = norm(row?.textContent);
      return text.includes(JOB_TYPE) && text.includes(config.practiceName) && text.includes(config.practiceId);
    });
  }
  function documentIdForJobLink(link, config) {
    const row = rowForJobLink(link, config);
    const annotation = row?.querySelector('a[href*="/mailroom/annotations/"]');
    const fromHref = annotation?.getAttribute("href")?.match(/\/mailroom\/annotations\/(\d+)/)?.[1];
    if (fromHref) return fromHref;
    const labelled = [...(row?.querySelectorAll("a") || [])].map((item) => norm(item.textContent))
      .find((text) => /^\d{4,}$/.test(text));
    return labelled || null;
  }
  function details(config, status) {
    const text = norm(document.body?.innerText);
    return text.includes(`Practice ${config.practiceName}`) && text.includes(`Job Type ${JOB_TYPE}`) &&
      detailStatus() === status;
  }
  function sameJob(actual, expected) {
    try {
      const a = new URL(actual), e = new URL(expected);
      return a.origin === e.origin && a.pathname.replace(/\/+$/, "") === e.pathname.replace(/\/+$/, "");
    } catch { return false; }
  }
  function freshJobUrl(value) {
    const url = new URL(value);
    url.searchParams.set("_bl_verify", String(Date.now()));
    return url.href;
  }
  function waitFor(check, timeout = 30000) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (value) => { if (!done) { done = true; observer.disconnect(); clearTimeout(timer); resolve(value); } };
      const test = () => { try { const value = check(); if (value) finish(value); } catch { /* retry on mutation */ } };
      const observer = new MutationObserver(test);
      observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
      const timer = setTimeout(() => finish(null), timeout);
      test();
    });
  }

  function confirmationControls() {
    const modal = document.querySelector("#confirm-complete");
    if (!modal || !controlIsRendered(modal)) return [];
    // BetterLetter renders responsive duplicate controls. They are equivalent
    // only when they live inside the validated confirmation modal and carry the
    // exact label; geometry merely chooses the preferred copy when available.
    return [...modal.querySelectorAll("button, [role=button], a")].filter((button) =>
      norm(button.value || button.textContent).toLowerCase() === "mark as complete" &&
      !button.disabled && button.getAttribute("aria-disabled") !== "true" &&
      controlIsRendered(button));
  }

  function controlIsRendered(control) {
    try {
      if (!control?.isConnected || !visible(control) || control.hidden) return false;
      for (let node = control; node?.nodeType === Node.ELEMENT_NODE; node = node.parentElement) {
        if (node.hidden || node.getAttribute("aria-hidden") === "true") return false;
        const style = getComputedStyle(node);
        if (style.opacity === "0" || style.pointerEvents === "none") return false;
      }
      // Background tabs can report zero geometry even for the active responsive
      // control. CSS/ARIA state is authoritative for eligibility; geometry is
      // used only as an optional ranking signal in controlScore().
      return true;
    } catch { return false; }
  }

  function controlScore(control) {
    try {
      if (!controlIsRendered(control)) return -1;
      const rect = control.getBoundingClientRect();
      const area = Math.max(0, rect.width) * Math.max(0, rect.height);
      if (!area) return 0;
      const hit = control.ownerDocument.elementFromPoint(
        rect.left + rect.width / 2, rect.top + rect.height / 2);
      return area + ((hit === control || control.contains(hit)) ? 1000000 : 0);
    } catch { return 0; }
  }

  async function dashboard(current) {
    const { config } = current;
    if (!exactDashboard(config)) return stop("URL filters changed; no action taken.");
    if (!pageLoadFinished()) {
      await patch({ message: "Waiting for the dashboard loading bar to finish" });
      return;
    }
    const body = norm(document.body?.innerText);
    if (Date.now() - started < 2000) return patch({ message: "Waiting for dashboard rows to stabilize" });
    if (!body.includes(config.practiceName)) return stop("Dashboard does not visibly confirm the configured practice.");
    const jobs = rowJobs(config);
    const countMatch = body.match(/\b(\d+)\s+visible rows?\b/i);
    const remainingCount = countMatch ? Number(countMatch[1]) : jobs.length;

    if (current.currentJob && current.phase === "opening") {
      const openingAt = Date.parse(current.openingAt || "");
      const elapsed = Number.isFinite(openingAt) ? Date.now() - openingAt : Infinity;
      if (elapsed < 5000) {
        await patch({ remainingCount,
          message: `Waiting for document ${current.currentDocumentId} to open in this tab` });
        return;
      }
      if (!current.expectedJobUrl) return stop("Selected job URL is missing; no action taken.");
      await patch({ message: `Background link navigation did not start; opening document ${current.currentDocumentId} directly in this tab` });
      location.assign(current.expectedJobUrl);
      return;
    }

    // history.back() can restore a zero-row LiveView shell before its rows are
    // hydrated. Never interpret that transient state as an empty queue.
    if (current.phase === "returning" && remainingCount === 0 && jobs.length === 0) {
      const returnedAt = Date.parse(current.returnStartedAt || "");
      const elapsed = Number.isFinite(returnedAt) ? Date.now() - returnedAt : 0;
      if (elapsed < 10000) {
        await patch({ message: "Waiting for dashboard rows to repopulate after browser Back" });
        return;
      }
      if (!current.dashboardReloaded) {
        await patch({ dashboardReloaded: true, message: "Refreshing once to verify the apparent empty queue" });
        const fresh = new URL(config.dashboardUrl);
        fresh.searchParams.set("_bl_verify", String(Date.now()));
        location.replace(fresh.href);
        return;
      }
    }

    if (current.currentJob) {
      if (jobs.some((link) => norm(link.textContent) === current.currentJob)) {
        const elapsed = Date.now() - Date.parse(current.confirmedAt || "");
        if (Number.isFinite(elapsed) && elapsed < 10000) return patch({ remainingCount, message: `Waiting for dashboard to remove ${current.currentJob}` });
        if (!current.dashboardReloaded) {
          await patch({ dashboardReloaded: true,
            message: `Refreshing the dashboard once to verify completed document ${current.currentDocumentId || current.currentJob}` });
          const fresh = new URL(config.dashboardUrl);
          fresh.searchParams.set("_bl_verify", String(Date.now()));
          location.replace(fresh.href);
          return;
        }
        return stop(`Document ${current.currentDocumentId || current.currentJob} is still listed after a fresh dashboard load; check it manually.`);
      }
      const processed = [...new Set([...(current.processed || []), current.currentJob])].slice(-500);
      current = { ...current, currentJob: null, currentDocumentId: null, currentStatus: null,
        expectedJobUrl: null, openingAt: null, confirmedAt: null, dashboardReloaded: false,
        completionAttempts: 0, completedCount: (current.completedCount || 0) + 1, processed, remainingCount };
      await patch(current);
    }
    if (remainingCount === 0 && jobs.length === 0) return patch({ active: false, phase: "complete", remainingCount: 0,
      message: "No matching paused jobs remain." });
    const link = jobs.find((item) => !(current.processed || []).includes(norm(item.textContent)));
    if (!link) return stop("No unique safe matching job link was found.");
    const jobId = norm(link.textContent);
    const documentId = documentIdForJobLink(link, config);
    if (!documentId) return stop(`Could not identify the Document ID for job ${jobId}.`);
    await patch({ currentJob: jobId, currentDocumentId: documentId, currentStatus: "paused",
      expectedJobUrl: link.href, phase: "opening", remainingCount, dashboardReloaded: false,
      openingAt: new Date().toISOString(), completionAttempts: 0,
      message: `Opening document ${documentId}` });
    await sleep(config.delaySeconds * 1000);
    // Follow the dashboard's own same-tab navigation, matching the manual process.
    if (link.target && link.target.toLowerCase() !== "_self") {
      return stop("Job link is no longer configured for same-tab navigation.");
    }
    link.click();
  }

  async function detail(current) {
    const { config, currentJob, expectedJobUrl } = current;
    if (!currentJob || !UUID.test(currentJob)) return stop("Missing or invalid current job ID.");
    if (!expectedJobUrl || !sameJob(location.href, expectedJobUrl)) return stop("Job URL does not match the dashboard selection.");
    const pageDocumentId = detailDocumentId();
    if (!pageDocumentId || pageDocumentId !== current.currentDocumentId) {
      if (Date.now() - started < 15000) return;
      return stop(`Job page Document ID ${pageDocumentId || "missing"} does not match selected document ${current.currentDocumentId || "missing"}.`);
    }
    const pageStatus = detailStatus();
    if (pageStatus && pageStatus !== current.currentStatus) await patch({ currentStatus: pageStatus });
    if (current.phase === "returning") {
      const returnStartedAt = Date.parse(current.returnStartedAt || "");
      if (Number.isFinite(returnStartedAt) && Date.now() - returnStartedAt < 10000) return;
      await patch({ message: "Browser Back did not return to the dashboard; loading the exact filtered dashboard" });
      location.assign(config.dashboardUrl);
      return;
    }
    // The matching Document ID and labelled completed status are authoritative.
    // LiveView's cosmetic top progress bar can linger after this DOM update.
    if (pageStatus === "completed" && (current.completionAttempts || 0) > 0) {
      await patch({ phase: "returning", currentStatus: "completed",
        returnStartedAt: new Date().toISOString(),
        message: `Document ${current.currentDocumentId} is completed; using browser Back` });
      history.back();
      return;
    }
    if (!pageLoadFinished()) {
      await patch({ message: `Waiting for document ${current.currentDocumentId || currentJob} to finish loading` });
      return;
    }
    if (current.phase === "verifying_result") {
      if (details(config, "completed")) {
        await patch({ phase: "returning", confirmedAt: new Date().toISOString(), returnStartedAt: new Date().toISOString(),
          message: `Fresh server page confirms ${currentJob} is completed; returning to dashboard` });
        history.back();
        return;
      }
      if (details(config, "paused")) {
        if ((current.completionAttempts || 0) >= 2) {
          return stop(`Fresh server page still shows ${currentJob} paused after two completion attempts.`);
        }
        current = { ...current, phase: "retrying" };
        await patch({ phase: "retrying", confirmedAt: null,
          message: `Fresh server page still shows ${currentJob} paused; making the one permitted retry` });
      } else {
        if (Date.now() - started < 15000) return;
        return stop("Fresh verification page did not show a clear completed or paused state.");
      }
    }
    if (!details(config, "paused")) {
      if (details(config, "completed")) {
        await patch({ phase: "returning", confirmedAt: new Date().toISOString(), returnStartedAt: new Date().toISOString(),
          message: `${currentJob} is completed; using browser Back to return to dashboard` });
        history.back();
        return;
      }
      if (Date.now() - started < 15000) return;
      return stop("Job page did not confirm practice, job type, and paused status.");
    }
    if (current.phase === "confirming") {
      // Recover if the original wait was interrupted (for example by a content
      // script reload). Never click again from this state: first verify the exact
      // job against a fresh server-rendered page.
      const confirmedAt = Date.parse(current.confirmedAt || "");
      const elapsed = Number.isFinite(confirmedAt) ? Date.now() - confirmedAt : Infinity;
      if (elapsed < 35000) return;
      await patch({ phase: "verifying_result",
        message: `Confirmation wait was interrupted for document ${current.currentDocumentId}; verifying server state` });
      location.replace(freshJobUrl(expectedJobUrl));
      return;
    }

    // A content-script or extension reload can happen after the first click while
    // BetterLetter's confirmation modal remains open. Resume from that validated
    // modal instead of returning forever in the persisted `clicked` phase.
    const manual = exact("MANUALLY COMPLETE JOB");
    let controls = confirmationControls();
    let attempts = current.completionAttempts || 0;
    if (!controls.length) {
      if (current.phase === "clicked") {
        controls = await waitFor(() => confirmationControls().length ? confirmationControls() : null, 30000);
      } else {
        if (manual.length !== 1 || manual[0].disabled) return stop("Exactly one usable Manually Complete Job control was not found.");
        attempts += 1;
        if (attempts > 2) return stop("Two completion attempts were already made.");
        await patch({ phase: "clicked", completionAttempts: attempts, message: `Opening confirmation for ${currentJob}` });
        manual[0].click();
        controls = await waitFor(() => confirmationControls().length ? confirmationControls() : null, 30000);
      }
    }
    if (!controls?.length) return stop("Could not safely identify the Mark as Complete confirmation control.");
    const ranked = controls.map((control, index) => ({ control, index, score: controlScore(control) }))
      .sort((a, b) => (b.score - a.score) || (b.index - a.index))
      .map((entry) => entry.control);
    const confirm = ranked.find((button) => controlScore(button) >= 0 && !button.disabled);
    if (!confirm || confirm.disabled) return stop("Confirmation control is disabled.");
    await patch({ phase: "confirming", confirmedAt: new Date().toISOString(),
      message: `Confirming document ${current.currentDocumentId}` });
    confirm.click();
    const result = await waitFor(() => {
      if (location.pathname === DASHBOARD) return "dashboard";
      // BetterLetter greys/disables the original control as its acknowledgement.
      // Requiring the confirmation modal to have closed prevents racing a button
      // that was already disabled while the modal was still submitting.
      if (controlDisabled(manual[0]) && !confirmationModalOpen()) return "manual_disabled";
      if (details(config, "completed")) return "completed";
      return null;
    });
    if (!result) {
      await patch({ phase: "verifying_result",
        message: `No visible result for ${currentJob}; reloading its exact page to verify server state` });
      location.replace(freshJobUrl(expectedJobUrl));
      return;
    }
    if (result === "manual_disabled" || result === "completed") {
      await patch({ phase: "returning", returnStartedAt: new Date().toISOString(),
        message: `Manual completion control is disabled for ${currentJob}; using browser Back` });
      history.back();
    }
  }

  async function tick() {
    if (busy) return;
    busy = true;
    try {
      const current = await state();
      if (!current?.active || current.targetTabId !== await tabId) return;
      if (Date.now() - Date.parse(current.startedAt) > 8 * 60 * 60 * 1000) return stop("Eight-hour safety limit reached.");
      if (location.pathname === DASHBOARD) await dashboard(current); else await detail(current);
    } catch (error) {
      if (!chrome.runtime?.id || String(error).includes("Extension context invalidated")) return;
      await stop(`Unexpected error: ${error?.message || String(error)}`);
    }
    finally { busy = false; }
  }
  setTimeout(tick, 500);
  setInterval(tick, 1000);
})();
