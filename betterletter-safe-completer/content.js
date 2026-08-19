(() => {
  const JOB_TYPE = "docman_delete_original";
  const DASHBOARD = "/admin_panel/bots/dashboard";
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const DASHBOARD_STABILIZE_MS = 400;
  const DASHBOARD_RETURN_SETTLE_MS = 1000;
  const DETAIL_RETURN_WAIT_MS = 1500;
  const JOB_STILL_LISTED_WAIT_MS = 2000;
  const LIVEVIEW_STABLE_SLEEP_MS = 150;
  const BACKGROUND_NAV_WAIT_MS = 2000;
  let routePath = location.pathname;
  let routeEnteredAt = Date.now();
  let busy = false;
  let tickRunId = null;
  class RunCancelled extends Error {}
  const tabId = chrome.runtime.sendMessage({ type: "getTabId" }).then((r) => r?.tabId ?? null).catch(() => null);
  const norm = (value) => (value || "").replace(/\s+/g, " ").trim();
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function syncRouteClock() {
    if (location.pathname === routePath) return;
    routePath = location.pathname;
    routeEnteredAt = Date.now();
  }

  function routeAge() {
    syncRouteClock();
    return Date.now() - routeEnteredAt;
  }

  function deepQueryAll(selector) {
    const results = [];
    const visited = new Set();
    function visit(root) {
      if (!root || visited.has(root)) return;
      visited.add(root);
      try {
        results.push(...root.querySelectorAll(selector));
        for (const element of root.querySelectorAll("*")) {
          if (element.shadowRoot) visit(element.shadowRoot);
          if (element.tagName === "IFRAME") {
            try { visit(element.contentDocument); } catch { /* Cross-origin frames are inaccessible. */ }
          }
        }
      } catch { /* Ignore inaccessible roots. */ }
    }
    visit(document);
    return [...new Set(results)];
  }

  function pageLoadFinished() {
    if (document.readyState !== "complete") return false;
    const progress = document.querySelector("#nprogress");
    return !progress || !visible(progress);
  }

  function composedClosest(element, selector) {
    for (let node = element; node?.nodeType === Node.ELEMENT_NODE;) {
      if (node.matches?.(selector)) return node;
      const root = node.getRootNode?.();
      node = node.parentElement || root?.host || null;
    }
    return null;
  }

  function liveViewRoot(control) {
    const direct = composedClosest(control, "[data-phx-session]");
    if (direct) return direct;
    const main = deepQueryAll("[data-phx-main][data-phx-session]")
      .filter((root) => root.isConnected && visible(root));
    if (main.length === 1) return main[0];
    const roots = deepQueryAll("[data-phx-session]")
      .filter((root) => root.isConnected && visible(root));
    return roots.length === 1 ? roots[0] : null;
  }

  function liveViewConnection(control) {
    const root = liveViewRoot(control);
    if (!root || !root.isConnected) return { ready: false, state: "missing", root: null };
    const loading = root.classList.contains("phx-loading") ||
      root.classList.contains("phx-disconnected");
    const error = root.classList.contains("phx-error");
    const connected = root.classList.contains("phx-connected");
    const state = error ? "error" : loading ? "loading" : connected ? "connected" : "connecting";
    return { ready: connected && !loading && !error, state, root };
  }

  function liveViewInfo(control) {
    const connection = liveViewConnection(control);
    const root = connection.root;
    const rootName = root ? `${root.tagName.toLowerCase()}${root.id ? `#${root.id}` : ""}` : "none";
    return `${connection.state} (root=${rootName})`;
  }

  async function waitForLiveViewControl(resolveControl, timeout = 20000) {
    const control = await waitFor(() => {
      const candidate = resolveControl();
      return candidate && liveViewConnection(candidate).ready ? candidate : null;
    }, timeout);
    if (!control) return null;
    // A reconnect can replace the DOM immediately after phx-connected appears.
    // Require a short stable interval and resolve the element again.
    await sleep(LIVEVIEW_STABLE_SLEEP_MS);
    const current = resolveControl();
    return current && current.isConnected && liveViewConnection(current).ready ? current : null;
  }

  function controlDisabled(control) {
    try {
      return !control || Boolean(control.disabled) || control.matches(":disabled") ||
        control.getAttribute("aria-disabled") === "true" ||
        control.classList.contains("phx-click-loading");
    } catch { return true; }
  }

  function trackPhoenixClick(control) {
    let pushObserved = control?.classList?.contains("phx-click-loading") || false;
    let acknowledgementObserved = false;
    let observer = null;
    const inspect = () => {
      const hasLoading = control?.classList?.contains("phx-click-loading") || false;
      if (hasLoading) pushObserved = true;
      if (pushObserved && !hasLoading) acknowledgementObserved = true;
    };
    if (control) {
      const view = control.ownerDocument?.defaultView || window;
      const Observer = view.MutationObserver || MutationObserver;
      observer = new Observer((records) => {
        for (const record of records) {
          if (record.type === "attributes" && record.attributeName === "class" &&
              record.target === control) {
            const oldHadLoading = (record.oldValue || "").split(/\s+/).includes("phx-click-loading");
            const newHasLoading = control.classList.contains("phx-click-loading");
            if (oldHadLoading || newHasLoading) pushObserved = true;
            if (pushObserved && oldHadLoading && !newHasLoading) acknowledgementObserved = true;
          }
        }
        inspect();
      });
      // Observe the control itself so shadow-root boundaries cannot hide a fast
      // phx-click-loading transition from the delivery tracker.
      observer.observe(control, { attributes: true, attributeFilter: ["class"],
        attributeOldValue: true });
    }
    return {
      sample() { inspect(); return { pushObserved, acknowledgementObserved }; },
      stop() { observer?.disconnect(); inspect(); return { pushObserved, acknowledgementObserved }; }
    };
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

  async function state() {
    try {
      if (!chrome.runtime?.id) return null;
      return (await chrome.storage.local.get("blRunner")).blRunner;
    } catch { return null; }
  }
  async function patch(values) {
    try {
      if (!chrome.runtime?.id) return;
      if (!tickRunId) throw new RunCancelled();
      const result = await chrome.runtime.sendMessage({ type: "patchRunner", runId: tickRunId, values });
      if (!result?.ok) throw new RunCancelled();
    } catch (error) {
      if (error instanceof RunCancelled) throw error;
      /* Extension was reloaded; the old content-script context must exit quietly. */
    }
  }
  const stop = (message) => patch({ active: false, phase: "stopped", message });
  const visible = (element) => {
    for (let node = element; node?.nodeType === Node.ELEMENT_NODE;) {
      const view = node.ownerDocument?.defaultView || window;
      const style = view.getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") return false;
      const root = node.getRootNode?.();
      node = node.parentElement || root?.host || null;
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

  function exactDetailState(current, status) {
    return Boolean(current?.expectedJobUrl &&
      sameJob(location.href, current.expectedJobUrl) &&
      detailDocumentId() === current.currentDocumentId &&
      details(current.config, status));
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
      const observers = [];
      const observedRoots = new Set();
      let timer = null;
      const finish = (value) => {
        if (done) return;
        done = true;
        for (const observer of observers) observer.disconnect();
        if (timer) clearTimeout(timer);
        resolve(value);
      };
      const startTimer = () => {
        if (done || timer) return;
        timer = setTimeout(() => {
          // Always sample once at the deadline. A separate observer may have
          // recorded delivery without producing another DOM mutation for this
          // waiter (for example a very fast phx-click-loading add/remove pair).
          test();
          if (!done) finish(null);
        }, timeout);
      };
      const observeRoot = (root) => {
        if (!root || observedRoots.has(root)) return;
        observedRoots.add(root);
        try {
          const target = root.nodeType === Node.DOCUMENT_NODE ? root.documentElement : root;
          if (target) {
            const view = root.ownerDocument?.defaultView || root.defaultView || window;
            const Observer = view.MutationObserver || MutationObserver;
            const observer = new Observer(test);
            observer.observe(target, { subtree: true, childList: true, attributes: true, characterData: true });
            observers.push(observer);
          }
          for (const element of root.querySelectorAll("*")) {
            if (element.shadowRoot) observeRoot(element.shadowRoot);
            if (element.tagName === "IFRAME") {
              try { observeRoot(element.contentDocument); } catch { /* Cross-origin frames are inaccessible. */ }
            }
          }
        } catch { /* Ignore inaccessible roots. */ }
      };
      const test = () => {
        if (done) return;
        observeRoot(document);
        try {
          const value = check();
          if (value) finish(value);
        } catch { /* Retry on a later DOM mutation. */ }
      };
      observeRoot(document);
      startTimer();
      test();
    });
  }

  function allPhoenixConfirmationControls() {
    return deepQueryAll("#confirm-complete button[phx-click]").filter((button) => {
      const label = norm(button.textContent).toLowerCase();
      const action = button.getAttribute("phx-click") || "";
      const isCompleteAction = action === "complete" || /["']event["']\s*:\s*["']complete["']/.test(action);
      return label === "mark as complete" && isCompleteAction;
    });
  }

  function phoenixConfirmationControls() {
    return allPhoenixConfirmationControls().filter((button) =>
      !button.disabled && button.getAttribute("aria-disabled") !== "true");
  }

  function confirmationSnapshot() {
    return new Map(allPhoenixConfirmationControls().map((control) => [control, {
      rendered: controlIsRendered(control),
      disabled: Boolean(control.disabled) || control.getAttribute("aria-disabled") === "true",
      signature: confirmationStateSignature(control)
    }]));
  }

  function confirmationStateSignature(control) {
    const parts = [];
    for (let node = control; node?.nodeType === Node.ELEMENT_NODE;) {
      const view = node.ownerDocument?.defaultView || window;
      const computed = view.getComputedStyle(node);
      parts.push([
        node.tagName, node.id, String(node.className || ""),
        node.hidden ? "hidden" : "shown",
        node.getAttribute("aria-hidden") || "",
        node.hasAttribute("inert") ? "inert" : "",
        node.hasAttribute("open") ? "open" : "",
        node.getAttribute("style") || "",
        computed.display, computed.visibility, computed.opacity, computed.pointerEvents
      ].join(":"));
      if (node.id === "confirm-complete") break;
      const root = node.getRootNode?.();
      node = node.parentElement || root?.host || null;
    }
    return parts.join(">");
  }

  function confirmationSemanticKey(control) {
    const modal = control.closest("#confirm-complete");
    const owner = control.closest("[data-phx-component], [data-phx-session]") ||
      modal?.closest("[data-phx-component], [data-phx-session]");
    return [
      control.getAttribute("phx-click") || "",
      control.getAttribute("phx-target") || "",
      modal?.getAttribute("data-phx-component") || "",
      modal?.getAttribute("phx-target") || "",
      owner?.getAttribute("data-phx-component") || "",
      owner?.getAttribute("data-phx-session") || "",
      owner?.id || ""
    ].join("|");
  }

  function oneSemanticConfirmationGroup(controls) {
    const groups = new Map();
    for (const control of controls) {
      const key = confirmationSemanticKey(control);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(control);
    }
    return groups.size === 1 ? [...groups.values()][0] : [];
  }

  function confirmationDiagnostics() {
    const exact = phoenixConfirmationControls();
    const rendered = exact.filter(controlIsRendered);
    const semanticGroups = new Set(rendered.map(confirmationSemanticKey)).size;
    return `exact Phoenix controls=${exact.length}, CSS-active controls=${rendered.length}, semantic groups=${semanticGroups}`;
  }

  function confirmationControls(before = null) {
    const phoenix = phoenixConfirmationControls();
    const rendered = phoenix.filter(controlIsRendered);
    if (before) {
      const activated = rendered.filter((control) => {
        const previous = before.get(control);
        return !previous || (controlIsRendered(control) && !previous.rendered) || previous.disabled ||
          previous.signature !== confirmationStateSignature(control);
      });
      if (activated.length) return oneSemanticConfirmationGroup(activated);
      return [];
    }
    if (rendered.length) return oneSemanticConfirmationGroup(rendered);
    // Delivery rollback relies on Phoenix's phx-click-loading signal. Never
    // click a label-only fallback whose submission mechanism cannot be proven.
    return [];
  }

  function controlIsRendered(control) {
    try {
      if (!control?.isConnected || !visible(control) || control.hidden) return false;
      if (typeof control.checkVisibility === "function" &&
          !control.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
      for (let node = control; node?.nodeType === Node.ELEMENT_NODE;) {
        if (node.hidden || node.inert || node.hasAttribute("inert") ||
            node.getAttribute("aria-hidden") === "true") return false;
        if (node.tagName === "DIALOG" && !node.open) return false;
        if (node.tagName === "DETAILS" && !node.open) return false;
        const view = node.ownerDocument?.defaultView || window;
        const style = view.getComputedStyle(node);
        if (style.display === "none" || style.visibility === "hidden" ||
            style.contentVisibility === "hidden" || style.opacity === "0" ||
            style.pointerEvents === "none") return false;
        const root = node.getRootNode?.();
        node = node.parentElement || root?.host || null;
      }
      // Background tabs can report zero geometry even for the active responsive
      // control. CSS/ARIA state is authoritative for eligibility; geometry is
      // used only as an optional ranking signal in controlScore().
      return true;
    } catch { return false; }
  }

  function controlScore(control) {
    try {
      if (!control?.isConnected) return -1;
      const rect = control.getBoundingClientRect();
      const area = Math.max(0, rect.width) * Math.max(0, rect.height);
      if (!area) return 0;
      const hit = control.ownerDocument.elementFromPoint(
        rect.left + rect.width / 2, rect.top + rect.height / 2);
      return area + ((hit === control || control.contains(hit)) ? 1000000 : 0);
    } catch { return 0; }
  }

  function rankControls(controls) {
    return controls.map((control, index) => ({ control, index, score: controlScore(control) }))
      .sort((a, b) => (b.score - a.score) || (b.index - a.index))
      .map((entry) => entry.control);
  }

  function chooseConfirmationControl(controls, attemptNumber) {
    const ranked = rankControls(controls);
    if (!ranked.length) return null;
    const bestScore = controlScore(ranked[0]);
    const secondScore = ranked.length > 1 ? controlScore(ranked[1]) : -1;
    if (bestScore >= 1000000 || (bestScore > 0 && bestScore > secondScore)) return ranked[0];
    if (controls.length === 1) return controls[0];
    // Never probe ambiguous zero-geometry responsive copies. The dedicated
    // visible worker should expose one unique hit-testable active control.
    return null;
  }

  function confirmationWaitMs() {
    return document.hidden ? 90000 : 30000;
  }

  function workerVisibility() {
    if (document.hidden || document.visibilityState !== "visible") return "hidden or minimized";
    return document.hasFocus() ? "visible and focused" : "visible in another Chrome window";
  }

  async function workerReadyForAction(current, action) {
    if (!document.hidden && document.visibilityState === "visible") return true;
    await patch({ workerVisibility: workerVisibility(),
      message: `Worker window is hidden or minimized. Restore it to ${action}; no attempt was made.` });
    return false;
  }

  async function liveViewControlForAction(current, resolveControl, action) {
    const initial = resolveControl();
    if (!initial) return null;
    const initialInfo = liveViewInfo(initial);
    if (!liveViewConnection(initial).ready) {
      await patch({ liveViewInfo: initialInfo,
        message: `Waiting for BetterLetter LiveView to reconnect before ${action}; no attempt has been made.` });
    }
    const ready = await waitForLiveViewControl(resolveControl, confirmationWaitMs());
    if (ready) await patch({ liveViewInfo: liveViewInfo(ready) });
    return ready;
  }

  async function reloadForLiveView(current, expectedJobUrl, action, diagnostic) {
    const reloads = (current.liveViewReloads || 0) + 1;
    const attemptMessage = (current.completionAttempts || 0) > 0 ?
      "No additional completion attempt was made." : "No completion attempt was made.";
    if (reloads > 2) {
      await stop(`BetterLetter LiveView did not reconnect before ${action} after two fresh-page checks. ${attemptMessage} (${diagnostic}).`);
      return;
    }
    await patch({ phase: "reconnecting", liveViewReloads: reloads, liveViewInfo: diagnostic,
      message: `BetterLetter LiveView was not connected before ${action}; reloading the exact job to reconnect (${reloads}/2).` });
    location.replace(freshJobUrl(expectedJobUrl));
  }

  async function reloadForDetailHydration(current, expectedJobUrl, field, diagnostic) {
    if (!await workerReadyForAction(current, `recover the job page for document ${current.currentDocumentId}`)) {
      return false;
    }
    const reloads = (current.detailRecoveryReloads || 0) + 1;
    const attemptMessage = (current.completionAttempts || 0) > 0 ?
      "No additional completion attempt was made." : "No completion attempt was made.";
    if (reloads > 2) {
      await stop(`Document ${current.currentDocumentId} did not render a stable ${field} after two fresh exact-page checks. ${attemptMessage} (${diagnostic}).`);
      return false;
    }
    let resumePhase = current.phase;
    if ((current.completionAttempts || 0) > 0) resumePhase = "verifying_result";
    else if (resumePhase === "clicked" || resumePhase === "confirming" ||
        resumePhase === "reconnecting") resumePhase = "retrying";
    await patch({ phase: resumePhase, detailRecoveryReloads: reloads,
      liveViewInfo: diagnostic,
      message: `Refreshing the exact job page to recover document ${current.currentDocumentId} ${field} (${reloads}/2); ${attemptMessage}` });
    location.replace(freshJobUrl(expectedJobUrl));
    return true;
  }

  async function reloadDashboardForHydration(current, reason) {
    if (!await workerReadyForAction(current, "recover the filtered dashboard")) return false;
    const reloads = (current.dashboardRecoveryReloads || 0) + 1;
    if (reloads > 2) {
      await stop(`The filtered dashboard did not finish loading after two fresh checks (${reason}); no job action was taken.`);
      return false;
    }
    await patch({ dashboardRecoveryReloads: reloads,
      message: `Refreshing the exact filtered dashboard because ${reason} (${reloads}/2); no job action was taken.` });
    const fresh = new URL(current.config.dashboardUrl);
    fresh.searchParams.set("_bl_verify", String(Date.now()));
    location.replace(fresh.href);
    return true;
  }

  async function requireRun(expected, phases = null) {
    const latest = await state();
    const ownTabId = await tabId;
    const valid = latest?.active && latest.runId === expected.runId &&
      latest.targetTabId === ownTabId &&
      !latest.suspensionRecovery &&
      (expected.currentJob == null || latest.currentJob === expected.currentJob) &&
      (expected.currentDocumentId == null || latest.currentDocumentId === expected.currentDocumentId) &&
      (!phases || phases.includes(latest.phase));
    if (!valid) throw new RunCancelled();
    return latest;
  }

  async function dashboard(current) {
    const { config } = current;
    if (!exactDashboard(config)) return stop("URL filters changed; no action taken.");
    if (!pageLoadFinished()) {
      if (routeAge() < 30000) {
        const message = "Waiting for the dashboard loading bar to finish";
        if (current.message !== message) await patch({ message });
        return;
      }
      await reloadDashboardForHydration(current, "its loading bar remained active");
      return;
    }
    const body = norm(document.body?.innerText);
    if (routeAge() < DASHBOARD_STABILIZE_MS) return patch({ message: "Waiting for dashboard rows to stabilize" });
    if (current.phase === "returning") {
      const returnedAt = Date.parse(current.returnStartedAt || "");
      const elapsed = Number.isFinite(returnedAt) ? Date.now() - returnedAt : routeAge();
      if (elapsed < DASHBOARD_RETURN_SETTLE_MS || routeAge() < DASHBOARD_RETURN_SETTLE_MS) {
        await patch({ message: "Waiting for the dashboard identity and rows to repopulate after browser Back" });
        return;
      }
    }
    if (!body.includes(config.practiceName)) {
      const diagnostic = liveViewInfo(null);
      if (routeAge() < 30000) {
        const message = `Waiting for the filtered dashboard to confirm practice ${config.practiceName} (${diagnostic})`;
        if (current.liveViewInfo !== diagnostic || current.message !== message) {
          await patch({ liveViewInfo: diagnostic, message });
        }
        return;
      }
      await reloadDashboardForHydration(current,
        `practice ${config.practiceName} was not rendered (${diagnostic})`);
      return;
    }
    const jobs = rowJobs(config);
    const countMatch = body.match(/\b(\d+)\s+visible rows?\b/i);
    const censusCount = countMatch ? Number(countMatch[1]) : null;
    const censusKnown = Number.isInteger(censusCount);
    const connection = liveViewConnection(null);
    const missingRows = jobs.length === 0 && (!censusKnown || censusCount > 0);
    const contradictoryRows = jobs.length > 0 && censusKnown && censusCount === 0;
    if (!connection.ready || missingRows || contradictoryRows) {
      const reason = !connection.ready ? `LiveView is ${connection.state}` :
        !censusKnown ? "its row count and job links have not rendered" :
        `it reports ${censusCount} visible rows but ${jobs.length} safe job links were found`;
      const diagnostic = liveViewInfo(null);
      if (routeAge() < 30000) {
        const message = `Waiting for the filtered dashboard to finish hydrating because ${reason} (${diagnostic})`;
        if (current.liveViewInfo !== diagnostic || current.message !== message) {
          await patch({ liveViewInfo: diagnostic, message });
        }
        return;
      }
      await reloadDashboardForHydration(current, `${reason} (${diagnostic})`);
      return;
    }
    const remainingCount = censusKnown ? censusCount : jobs.length;
    // A finished loading bar alone is not proof that LiveView restored its
    // rows. Reset the bounded recovery budget only after identity, connection,
    // and an authoritative census (or at least one safe row) are all present.
    if ((current.dashboardRecoveryReloads || 0) > 0) {
      await patch({ dashboardRecoveryReloads: 0, liveViewInfo: liveViewInfo(null) });
      current = { ...current, dashboardRecoveryReloads: 0 };
    }

    if (current.currentJob && current.phase === "opening") {
      const openingAt = Date.parse(current.openingAt || "");
      const elapsed = Number.isFinite(openingAt) ? Date.now() - openingAt : Infinity;
      if (elapsed < BACKGROUND_NAV_WAIT_MS) {
        await patch({ remainingCount,
          message: `Waiting for document ${current.currentDocumentId} to open in this tab` });
        return;
      }
      if (!current.expectedJobUrl) return stop("Selected job URL is missing; no action taken.");
      await patch({ message: `Background link navigation did not start; opening document ${current.currentDocumentId} directly in this tab` });
      await requireRun(current, ["opening"]);
      if (!await workerReadyForAction(current, `open document ${current.currentDocumentId}`)) return;
      location.assign(current.expectedJobUrl);
      return;
    }

    if (current.currentJob) {
      const currentStillListed = jobs.some((link) => norm(link.textContent) === current.currentJob);
      if (currentStillListed) {
        if ((current.completionAttempts || 0) === 0) {
          return stop(`Document ${current.currentDocumentId} returned to the dashboard before confirmation; no completion was counted.`);
        }
        const elapsed = Date.now() - Date.parse(current.confirmedAt || "");
        if (Number.isFinite(elapsed) && elapsed < JOB_STILL_LISTED_WAIT_MS) return patch({ remainingCount, message: `Waiting for dashboard to remove ${current.currentJob}` });
        if (current.phase !== "returning" || current.currentStatus !== "completed") {
          if (!current.expectedJobUrl) return stop("Cannot verify the selected job because its exact URL is missing.");
          await patch({ phase: "verifying_result", remainingCount,
            message: `Dashboard still lists document ${current.currentDocumentId}; verifying its exact server state` });
          location.replace(freshJobUrl(current.expectedJobUrl));
          return;
        }
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
      if (current.phase !== "returning" || current.currentStatus !== "completed") {
        if ((current.completionAttempts || 0) > 0 && current.expectedJobUrl) {
          await patch({ phase: "verifying_result", remainingCount,
            message: `Document ${current.currentDocumentId} left the dashboard; verifying its exact completed status before counting it` });
          location.replace(freshJobUrl(current.expectedJobUrl));
          return;
        }
        return stop(`Selected document ${current.currentDocumentId} disappeared before a verified completion.`);
      }
      const processed = [...new Set([...(current.processed || []), current.currentJob])].slice(-500);
      const completionUpdate = { currentJob: null, currentDocumentId: null, currentStatus: null,
        expectedJobUrl: null, openingAt: null, confirmedAt: null, dashboardReloaded: false,
        dialogAttempts: 0, completionAttempts: 0, confirmationInfo: null,
        liveViewReloads: 0, detailRecoveryReloads: 0, unacceptedDispatches: 0, liveViewInfo: null,
        lastDispatchPushed: null, lastDispatchAcknowledged: null,
        completedCount: (current.completedCount || 0) +
          ((current.completionAttempts || 0) > 0 ? 1 : 0), processed, remainingCount };
      await patch(completionUpdate);
      current = { ...current, ...completionUpdate };
    }
    if (censusKnown && censusCount === 0 && jobs.length === 0) return patch({ active: false, phase: "complete", remainingCount: 0,
      message: "No matching paused jobs remain." });
    const link = jobs.find((item) => !(current.processed || []).includes(norm(item.textContent)));
    if (!link) return stop("No unique safe matching job link was found.");
    const jobId = norm(link.textContent);
    const documentId = documentIdForJobLink(link, config);
    if (!documentId) return stop(`Could not identify the Document ID for job ${jobId}.`);
    await patch({ currentJob: jobId, currentDocumentId: documentId, currentStatus: "paused",
      expectedJobUrl: link.href, phase: "opening", remainingCount, dashboardReloaded: false,
      openingAt: new Date().toISOString(), dialogAttempts: 0, completionAttempts: 0,
      confirmationInfo: null, liveViewReloads: 0, detailRecoveryReloads: 0,
      unacceptedDispatches: 0,
      liveViewInfo: null, lastDispatchPushed: null, lastDispatchAcknowledged: null,
      message: `Opening document ${documentId}` });
    await sleep(config.delaySeconds * 1000);
    const selectedRun = { ...current, currentJob: jobId, currentDocumentId: documentId,
      expectedJobUrl: link.href };
    await requireRun(selectedRun, ["opening"]);
    if (!await workerReadyForAction(selectedRun, `open document ${documentId}`)) return;
    // Follow the dashboard's own same-tab navigation, matching the manual process.
    if (link.target && link.target.toLowerCase() !== "_self") {
      return stop("Job link is no longer configured for same-tab navigation.");
    }
    if (!link.isConnected || norm(link.textContent) !== jobId || link.href !== selectedRun.expectedJobUrl) {
      return stop(`Dashboard link for document ${documentId} changed before navigation; no action was taken.`);
    }
    link.click();
  }

  async function detail(current) {
    const { config, currentJob, expectedJobUrl } = current;
    if (!currentJob || !UUID.test(currentJob)) return stop("Missing or invalid current job ID.");
    if (!expectedJobUrl || !sameJob(location.href, expectedJobUrl)) return stop("Job URL does not match the dashboard selection.");
    if (current.phase === "returning") {
      const returnStartedAt = Date.parse(current.returnStartedAt || "");
      if (Number.isFinite(returnStartedAt) && Date.now() - returnStartedAt < DETAIL_RETURN_WAIT_MS) return;
      await patch({ message: "Browser Back did not return to the dashboard; loading the exact filtered dashboard" });
      location.assign(config.dashboardUrl);
      return;
    }
    const pageDocumentId = detailDocumentId();
    if (!pageDocumentId) {
      const diagnostic = liveViewInfo(null);
      if (routeAge() < 30000) {
        const message = `Waiting for document ${current.currentDocumentId} identity while the BetterLetter job page reconnects (${diagnostic})`;
        if (current.liveViewInfo !== diagnostic || current.message !== message) {
          await patch({ liveViewInfo: diagnostic, message });
        }
        return;
      }
      await reloadForDetailHydration(current, expectedJobUrl, "Document ID", diagnostic);
      return;
    }
    if (pageDocumentId !== current.currentDocumentId) {
      const diagnostic = liveViewInfo(null);
      if (routeAge() < 15000) {
        const message = `Waiting for the BetterLetter job page to confirm document ${current.currentDocumentId}; it is temporarily showing ${pageDocumentId} (${diagnostic})`;
        if (current.liveViewInfo !== diagnostic || current.message !== message) {
          await patch({ liveViewInfo: diagnostic, message });
        }
        return;
      }
      if (!pageLoadFinished() || !liveViewConnection(null).ready ||
          (current.detailRecoveryReloads || 0) === 0) {
        await reloadForDetailHydration(current, expectedJobUrl,
          `Document ID (temporarily showed ${pageDocumentId})`, diagnostic);
        return;
      }
      return stop(`Fresh connected job page Document ID ${pageDocumentId} does not match selected document ${current.currentDocumentId || "missing"}; no action was taken.`);
    }
    const pageStatus = detailStatus();
    if (pageStatus && pageStatus !== current.currentStatus) await patch({ currentStatus: pageStatus });
    // The matching Document ID and labelled completed status are authoritative.
    // LiveView's cosmetic top progress bar can linger after this DOM update.
    if (exactDetailState(current, "completed") && (current.completionAttempts || 0) > 0) {
      await patch({ phase: "returning", currentStatus: "completed",
        returnStartedAt: new Date().toISOString(),
        message: `Document ${current.currentDocumentId} is completed; using browser Back` });
      history.back();
      return;
    }
    if (!pageLoadFinished()) {
      if (routeAge() < 30000) {
        const diagnostic = liveViewInfo(null);
        const message = `Waiting for document ${current.currentDocumentId || currentJob} to finish loading (${diagnostic})`;
        if (current.liveViewInfo !== diagnostic || current.message !== message) {
          await patch({ liveViewInfo: diagnostic, message });
        }
        return;
      }
      await reloadForDetailHydration(current, expectedJobUrl, "page loading state", liveViewInfo(null));
      return;
    }
    if (!pageStatus) {
      const diagnostic = liveViewInfo(null);
      if (routeAge() < 30000) {
        const message = `Waiting for document ${current.currentDocumentId} status while the BetterLetter job page reconnects (${diagnostic})`;
        if (current.liveViewInfo !== diagnostic || current.message !== message) {
          await patch({ liveViewInfo: diagnostic, message });
        }
        return;
      }
      await reloadForDetailHydration(current, expectedJobUrl, "Status", diagnostic);
      return;
    }
    if (current.phase === "verifying_result") {
      if (exactDetailState(current, "completed")) {
        await patch({ phase: "returning", currentStatus: "completed",
          confirmedAt: new Date().toISOString(), returnStartedAt: new Date().toISOString(),
          message: `Fresh server page confirms document ${current.currentDocumentId} is completed; returning to dashboard` });
        history.back();
        return;
      }
      if (exactDetailState(current, "paused")) {
        if ((current.completionAttempts || 0) >= 2) {
          const delivery = current.lastDispatchPushed ?
            `Phoenix push was observed${current.lastDispatchAcknowledged ? " and acknowledged" : " but its acknowledgement was not observed"}` :
            "Phoenix delivery could not be proven after the content script was interrupted";
          return stop(`Fresh server page still shows ${currentJob} paused after two server completion attempts. ${delivery}; check this BetterLetter job or its server logs manually.`);
        }
        current = { ...current, phase: "retrying" };
        await patch({ phase: "retrying", confirmedAt: null,
          message: `Fresh server page still shows ${currentJob} paused; making the one permitted retry` });
      } else {
        if (routeAge() < 15000) return;
        await reloadForDetailHydration(current, expectedJobUrl,
          "practice, job type, and Status identity", liveViewInfo(null));
        return;
      }
    }
    if (!exactDetailState(current, "paused")) {
      if (exactDetailState(current, "completed")) {
        const extensionAttempted = (current.completionAttempts || 0) > 0;
        await patch({ phase: "returning", currentStatus: "completed",
          confirmedAt: new Date().toISOString(), returnStartedAt: new Date().toISOString(),
          message: extensionAttempted ?
            `Document ${current.currentDocumentId} is completed; using browser Back to return to dashboard` :
            `Document ${current.currentDocumentId} was completed before this extension made an attempt; returning without counting it` });
        history.back();
        return;
      }
      if (routeAge() < 15000) return;
      await reloadForDetailHydration(current, expectedJobUrl,
        "practice, job type, and Status identity", liveViewInfo(null));
      return;
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
    const resolveManual = () => {
      const candidates = exact("MANUALLY COMPLETE JOB");
      return candidates.length === 1 && !controlDisabled(candidates[0]) && candidates[0].isConnected ?
        candidates[0] : null;
    };
    const manual = exact("MANUALLY COMPLETE JOB");
    let controls = [];
    let dialogAttempts = current.dialogAttempts || 0;
    if (current.phase === "clicked") {
      controls = confirmationControls();
      if (!controls.length) {
        controls = await waitFor(() => confirmationControls().length ? confirmationControls() : null,
          confirmationWaitMs());
      }
    } else {
      if (manual.length !== 1 || controlDisabled(manual[0])) return stop("Exactly one usable Manually Complete Job control was not found.");
      if (!await workerReadyForAction(current, "open the completion dialog")) return;
      const connectedManual = await liveViewControlForAction(current, resolveManual,
        `opening the completion dialog for document ${current.currentDocumentId}`);
      if (!connectedManual) {
        await reloadForLiveView(current, expectedJobUrl,
          `opening the completion dialog for document ${current.currentDocumentId}`,
          liveViewInfo(resolveManual() || manual[0]));
        return;
      }
      dialogAttempts += 1;
      if (dialogAttempts > 2) return stop("Could not open a usable confirmation dialog after two attempts.");
      const beforeConfirmation = confirmationSnapshot();
      await patch({ phase: "clicked", dialogAttempts,
        message: `Opening confirmation dialog for document ${current.currentDocumentId}` });
      const currentManual = resolveManual();
      if (!currentManual) {
        await patch({ phase: "verifying_result",
          message: `Manual completion control changed before it could be clicked for document ${current.currentDocumentId}; verifying before retry` });
        location.replace(freshJobUrl(expectedJobUrl));
        return;
      }
      if (!await workerReadyForAction(current, "open the completion dialog")) {
        await patch({ phase: "retrying", dialogAttempts: Math.max(0, dialogAttempts - 1) });
        return;
      }
      if (!liveViewConnection(currentManual).ready) {
        await patch({ phase: "retrying", dialogAttempts: Math.max(0, dialogAttempts - 1) });
        await reloadForLiveView(current, expectedJobUrl,
          `opening the completion dialog for document ${current.currentDocumentId}`,
          liveViewInfo(currentManual));
        return;
      }
      await requireRun(current, ["clicked"]);
      const dispatchManual = resolveManual();
      if (!exactDetailState(current, "paused")) {
        const resumePhase = (current.completionAttempts || 0) > 0 ? "verifying_result" : "retrying";
        const recoveredDialogAttempts = Math.max(0, dialogAttempts - 1);
        await patch({ phase: resumePhase, dialogAttempts: recoveredDialogAttempts,
          message: `Document ${current.currentDocumentId} changed before the completion dialog could be opened; refreshing its exact page without taking action` });
        await reloadForDetailHydration({ ...current, phase: resumePhase,
          dialogAttempts: recoveredDialogAttempts }, expectedJobUrl,
          "pre-dialog identity", liveViewInfo(dispatchManual));
        return;
      }
      if (!dispatchManual || !liveViewConnection(dispatchManual).ready) {
        await patch({ phase: "retrying", dialogAttempts: Math.max(0, dialogAttempts - 1) });
        await reloadForLiveView(current, expectedJobUrl,
          `opening the completion dialog for document ${current.currentDocumentId}`,
          liveViewInfo(dispatchManual || currentManual));
        return;
      }
      dispatchManual.click();
      controls = await waitFor(() => {
        const candidates = confirmationControls(beforeConfirmation);
        return candidates.length ? candidates : null;
      }, confirmationWaitMs());
    }
    if (!controls?.length) {
      await patch({ phase: "verifying_result",
        message: `Confirmation dialog was not safely selectable for document ${current.currentDocumentId} (${confirmationDiagnostics()}); verifying before one permitted retry` });
      location.replace(freshJobUrl(expectedJobUrl));
      return;
    }
    if (!await workerReadyForAction(current, "submit Mark as Complete")) return;
    const completionAttempts = (current.completionAttempts || 0) + 1;
    if (completionAttempts > 2) return stop("Two completion attempts were already made.");
    let confirm = chooseConfirmationControl(controls, completionAttempts);
    if (!confirm || controlDisabled(confirm) || !confirm.isConnected) {
      return stop(`The confirmation control for document ${current.currentDocumentId} was ambiguous or unusable; no completion attempt was made.`);
    }
    const semanticKey = confirmationSemanticKey(confirm);
    const resolveConfirm = () => {
      const candidates = confirmationControls()
        .filter((candidate) => confirmationSemanticKey(candidate) === semanticKey);
      const candidate = chooseConfirmationControl(candidates, completionAttempts);
      return candidate && !controlDisabled(candidate) && candidate.isConnected ? candidate : null;
    };
    const connectedConfirm = await liveViewControlForAction(current, resolveConfirm,
      `submitting Mark as Complete for document ${current.currentDocumentId}`);
    if (!connectedConfirm) {
      await patch({ phase: "retrying", dialogAttempts: Math.max(0, dialogAttempts - 1) });
      await reloadForLiveView(current, expectedJobUrl,
        `submitting Mark as Complete for document ${current.currentDocumentId}`,
        liveViewInfo(confirm));
      return;
    }
    confirm = connectedConfirm;
    controls = confirmationControls()
      .filter((candidate) => confirmationSemanticKey(candidate) === semanticKey);
    const selectedOrdinal = controls.indexOf(confirm) + 1;
    const confirmationInfo = `${confirmationDiagnostics()}, selected=${selectedOrdinal}/${controls.length}, ` +
      `tab hidden=${document.hidden}, LiveView=${liveViewInfo(confirm)}, Phoenix push=pending`;
    await patch({ phase: "confirming", completionAttempts, confirmedAt: new Date().toISOString(),
      confirmationInfo, lastDispatchPushed: null, lastDispatchAcknowledged: null,
      message: `Confirming document ${current.currentDocumentId} (server attempt ${completionAttempts}/2)` });
    if (!await workerReadyForAction(current, "submit Mark as Complete")) {
      await patch({ phase: "clicked", completionAttempts: completionAttempts - 1, confirmedAt: null,
        confirmationInfo: null });
      return;
    }
    await requireRun(current, ["confirming"]);
    const dispatchConfirm = resolveConfirm();
    if (!exactDetailState(current, "paused")) {
      const priorAttempts = completionAttempts - 1;
      const resumePhase = priorAttempts > 0 ? "verifying_result" : "retrying";
      const recoveredDialogAttempts = Math.max(0, dialogAttempts - 1);
      await patch({ phase: resumePhase,
        completionAttempts: priorAttempts, dialogAttempts: recoveredDialogAttempts,
        confirmedAt: null, lastDispatchPushed: false, lastDispatchAcknowledged: false,
        message: `Document ${current.currentDocumentId} changed before Mark as Complete could be submitted; refreshing its exact page without consuming an attempt` });
      await reloadForDetailHydration({ ...current, phase: resumePhase,
        completionAttempts: priorAttempts, dialogAttempts: recoveredDialogAttempts },
        expectedJobUrl, "pre-confirmation identity", liveViewInfo(dispatchConfirm));
      return;
    }
    if (!dispatchConfirm || controlDisabled(dispatchConfirm) || !dispatchConfirm.isConnected ||
        !liveViewConnection(dispatchConfirm).ready) {
      await patch({ phase: "retrying", completionAttempts: completionAttempts - 1,
        dialogAttempts: Math.max(0, dialogAttempts - 1), confirmedAt: null,
        lastDispatchPushed: false, lastDispatchAcknowledged: false,
        message: `LiveView or its confirmation control changed before dispatch for document ${current.currentDocumentId}; reconnecting without consuming an attempt` });
      await reloadForLiveView(current, expectedJobUrl,
        `submitting Mark as Complete for document ${current.currentDocumentId}`,
        liveViewInfo(dispatchConfirm || confirm));
      return;
    }
    confirm = dispatchConfirm;
    const pushTracker = trackPhoenixClick(confirm);
    try {
      confirm.click();
    } catch (error) {
      pushTracker.stop();
      await patch({ active: false, phase: "stopped", completionAttempts: completionAttempts - 1,
        confirmedAt: null, confirmationInfo: null,
        message: `Confirmation dispatch failed before submission for document ${current.currentDocumentId}: ${error?.message || String(error)}` });
      return;
    }
    let delivery = await waitFor(() => {
      const tracked = pushTracker.sample();
      if (tracked.pushObserved) return "pushed";
      if (location.pathname === DASHBOARD) return "dashboard";
      if (exactDetailState(current, "completed")) return "completed";
      return null;
    }, 2000);
    if (!delivery && pushTracker.sample().pushObserved) delivery = "pushed";
    if (!delivery) {
      pushTracker.stop();
      const unacceptedDispatches = (current.unacceptedDispatches || 0) + 1;
      const rollback = { phase: "retrying", completionAttempts: completionAttempts - 1,
        dialogAttempts: Math.max(0, dialogAttempts - 1), confirmedAt: null,
        unacceptedDispatches, lastDispatchPushed: false, lastDispatchAcknowledged: false,
        liveViewInfo: liveViewInfo(confirm),
        confirmationInfo: `${confirmationInfo.replace("Phoenix push=pending", "Phoenix push=not observed")}`,
        message: `Phoenix did not accept the Mark as Complete click for document ${current.currentDocumentId}; reconnecting without consuming a server attempt (${unacceptedDispatches}/2)` };
      await patch(rollback);
      if (unacceptedDispatches >= 2) {
        return stop(`Phoenix did not accept the Mark as Complete click for document ${current.currentDocumentId} after two delivery checks; no server completion attempt was consumed (${liveViewInfo(confirm)}).`);
      }
      location.replace(freshJobUrl(expectedJobUrl));
      return;
    }
    const initiallyTracked = pushTracker.sample();
    const pushObserved = initiallyTracked.pushObserved || delivery === "completed" || delivery === "dashboard";
    await patch({ lastDispatchPushed: pushObserved,
      lastDispatchAcknowledged: initiallyTracked.acknowledgementObserved,
      confirmationInfo: confirmationInfo.replace("Phoenix push=pending",
        `Phoenix push=${pushObserved ? "observed" : "terminal result"}`),
      message: `BetterLetter accepted completion attempt ${completionAttempts}/2 for document ${current.currentDocumentId}; waiting for its server result` });
    const result = delivery === "completed" || delivery === "dashboard" ? delivery : await waitFor(() => {
      pushTracker.sample();
      if (location.pathname === DASHBOARD) return "dashboard";
      if (exactDetailState(current, "completed")) return "completed";
      return null;
    }, confirmationWaitMs());
    const finalTracked = pushTracker.stop();
    const finalInfo = confirmationInfo.replace("Phoenix push=pending",
      `Phoenix push=${pushObserved ? "observed" : "terminal result"}, acknowledgement=${finalTracked.acknowledgementObserved ? "observed" : "not observed"}`);
    if (!result) {
      await patch({ phase: "verifying_result",
        lastDispatchPushed: pushObserved,
        lastDispatchAcknowledged: finalTracked.acknowledgementObserved,
        confirmationInfo: finalInfo,
        message: `No completed state appeared for ${currentJob} after a Phoenix-delivered click; reloading its exact page to verify server state` });
      location.replace(freshJobUrl(expectedJobUrl));
      return;
    }
    if (result === "completed") {
      await patch({ phase: "returning", returnStartedAt: new Date().toISOString(),
        currentStatus: "completed", lastDispatchPushed: pushObserved,
        lastDispatchAcknowledged: true, confirmationInfo: finalInfo,
        message: `Document ${current.currentDocumentId} is completed; using browser Back` });
      history.back();
      return;
    }
    await patch({ phase: "verifying_result", lastDispatchPushed: pushObserved,
      lastDispatchAcknowledged: finalTracked.acknowledgementObserved,
      confirmationInfo: finalInfo,
      message: `BetterLetter returned to the dashboard after confirming document ${current.currentDocumentId}; verifying its exact completed state` });
  }

  async function tick() {
    if (busy) return;
    busy = true;
    try {
      syncRouteClock();
      const current = await state();
      if (!current?.active || current.targetTabId !== await tabId) return;
      tickRunId = current.runId;
      const visibility = workerVisibility();
      if (current.suspensionRecovery) {
        await chrome.runtime.sendMessage({ type: "workerAwake", runId: current.runId, visibility });
        return;
      }
      if (current.workerVisibility !== visibility) await patch({ workerVisibility: visibility });
      if (Date.now() - Date.parse(current.startedAt) > 8 * 60 * 60 * 1000) return stop("Eight-hour safety limit reached.");
      if (location.pathname === DASHBOARD) await dashboard(current); else await detail(current);
    } catch (error) {
      if (error instanceof RunCancelled) return;
      if (!chrome.runtime?.id || String(error).includes("Extension context invalidated")) return;
      await stop(`Unexpected error: ${error?.message || String(error)}`);
    }
    finally { tickRunId = null; busy = false; }
  }
  setTimeout(tick, 500);
  setInterval(tick, 1000);
})();
