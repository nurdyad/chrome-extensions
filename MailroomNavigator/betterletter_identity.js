// BetterLetter identity bridge:
// - Extracts the signed-in BetterLetter user email from page state when possible
// - Sends snapshots to the extension background so panel auth can rely on session-derived identity
(() => {
  const EMAIL_REGEX = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig;
  const SENT_CACHE_KEY = "__BL_IDENTITY_LAST_SENT__";
  const PAGE_MESSAGE_TYPE = "mailroomnavigator_betterletter_identity";

  function collapse(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function normalizeEmail(value) {
    const normalized = collapse(value).toLowerCase();
    return /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(normalized) ? normalized : "";
  }

  function scanText(text, source, score, candidates, seen) {
    const raw = String(text || "");
    if (!raw) return;
    const matches = raw.match(EMAIL_REGEX) || [];
    matches.forEach((email) => {
      const normalized = normalizeEmail(email);
      if (!normalized || seen.has(normalized)) return;
      seen.add(normalized);
      candidates.push({ email: normalized, source, score });
    });
  }

  function collectCandidates() {
    const candidates = [];
    const seen = new Set();

    try {
      const root = document.documentElement;
      const datasetEmail = normalizeEmail(root?.getAttribute?.("data-mailroomnavigator-email") || "");
      if (datasetEmail) {
        seen.add(datasetEmail);
        candidates.push({
          email: datasetEmail,
          source: collapse(root?.getAttribute?.("data-mailroomnavigator-email-source") || "dom:data-mailroomnavigator-email"),
          score: 260
        });
      }
    } catch {
      // Ignore DOM attribute access failures.
    }

    const pushStorage = (storage, storageName) => {
      try {
        if (!storage) return;
        for (let index = 0; index < storage.length; index += 1) {
          const key = String(storage.key(index) || "");
          if (!key) continue;
          const value = String(storage.getItem(key) || "");
          const normalizedKey = key.toLowerCase();
          const score = /email|user|auth|account|profile|session/.test(normalizedKey) ? 120 : 70;
          scanText(value, `${storageName}:${key}`, score, candidates, seen);
        }
      } catch {
        // Ignore storage access failures.
      }
    };

    pushStorage(window.localStorage, "localStorage");
    pushStorage(window.sessionStorage, "sessionStorage");

    const selectors = [
      "header",
      "nav",
      "[role='banner']",
      "[data-test-id*='user']",
      "[data-test-id*='account']",
      "[class*='user']",
      "[class*='account']",
      "[id*='user']",
      "[id*='account']",
      "a[href^='mailto:']",
      "button[aria-haspopup='menu']"
    ];

    selectors.forEach((selector) => {
      document.querySelectorAll(selector).forEach((node) => {
        scanText(node?.textContent || "", `dom:${selector}`, 90, candidates, seen);
        if (selector === "a[href^='mailto:']") {
          const href = String(node?.getAttribute?.("href") || "").replace(/^mailto:/i, "");
          scanText(href, `dom:${selector}:href`, 140, candidates, seen);
        }
      });
    });

    document.querySelectorAll("script").forEach((node) => {
      const text = String(node?.textContent || "");
      if (!text || text.length > 40000) return;
      const score = /email|currentUser|current_user|account|profile|viewer/i.test(text) ? 110 : 60;
      scanText(text, "script", score, candidates, seen);
    });

    candidates.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.email.localeCompare(b.email);
    });

    return candidates;
  }

  function sendIdentitySnapshot() {
    const candidates = collectCandidates();
    const best = candidates[0];
    if (!best?.email) return;

    const payload = {
      email: best.email,
      source: best.source,
      capturedAt: new Date().toISOString()
    };
    const cacheKey = JSON.stringify(payload);
    if (window[SENT_CACHE_KEY] === cacheKey) return;
    window[SENT_CACHE_KEY] = cacheKey;

    try {
      chrome.runtime.sendMessage({
        type: "betterletter_identity_snapshot",
        data: payload
      }).catch(() => undefined);
    } catch {
      // Ignore extension context errors.
    }
  }

  function forwardIdentitySnapshot(rawData) {
    const payload = {
      email: normalizeEmail(rawData?.email),
      source: collapse(rawData?.source).slice(0, 120),
      capturedAt: collapse(rawData?.capturedAt).slice(0, 80) || new Date().toISOString()
    };
    if (!payload.email) return;
    const cacheKey = JSON.stringify(payload);
    if (window[SENT_CACHE_KEY] === cacheKey) return;
    window[SENT_CACHE_KEY] = cacheKey;

    try {
      chrome.runtime.sendMessage({
        type: "betterletter_identity_snapshot",
        data: payload
      }).catch(() => undefined);
    } catch {
      // Ignore extension context errors.
    }
  }

  const debouncedSend = (() => {
    let timer = null;
    return () => {
      clearTimeout(timer);
      timer = setTimeout(sendIdentitySnapshot, 250);
    };
  })();

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", sendIdentitySnapshot, { once: true });
  } else {
    sendIdentitySnapshot();
  }

  setTimeout(sendIdentitySnapshot, 50);
  setTimeout(sendIdentitySnapshot, 500);
  setTimeout(sendIdentitySnapshot, 1500);

  window.addEventListener("load", sendIdentitySnapshot, { once: true });
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (event.origin !== window.location.origin) return;
    if (event.data?.source !== "mailroomnavigator") return;
    if (event.data?.type !== PAGE_MESSAGE_TYPE) return;
    forwardIdentitySnapshot(event.data?.data);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") debouncedSend();
  });

  const observer = new MutationObserver(() => debouncedSend());
  observer.observe(document.documentElement || document.body, {
    childList: true,
    subtree: true,
    attributes: false
  });
})();
