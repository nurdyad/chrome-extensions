// BetterLetter identity scanner running in the page's main world.
// This can inspect app runtime state that isolated content scripts cannot access.
(() => {
  const EMAIL_REGEX = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig;
  const MESSAGE_TYPE = "mailroomnavigator_betterletter_identity";
  const SENT_CACHE_KEY = "__MAILROOMNAV_LAST_IDENTITY_MAIN__";
  const MAX_NODES = 1800;
  const MAX_DEPTH = 5;

  function normalizeEmail(value) {
    const normalized = String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
    return /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(normalized) ? normalized : "";
  }

  function scanText(rawValue, source, score, candidates, seen) {
    const raw = String(rawValue || "");
    if (!raw) return;
    const matches = raw.match(EMAIL_REGEX) || [];
    matches.forEach((email) => {
      const normalized = normalizeEmail(email);
      if (!normalized || seen.has(normalized)) return;
      seen.add(normalized);
      candidates.push({ email: normalized, source, score });
    });
  }

  function pushDirectCandidate(value, source, score, candidates, seen) {
    const normalized = normalizeEmail(value);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    candidates.push({ email: normalized, source, score });
  }

  function scanKnownGlobals(candidates, seen) {
    const directPaths = [
      ["currentUser", "email"],
      ["current_user", "email"],
      ["viewer", "email"],
      ["user", "email"],
      ["account", "email"],
      ["profile", "email"],
      ["session", "user", "email"],
      ["session", "email"],
      ["auth", "user", "email"],
      ["auth", "email"],
      ["bootstrap", "currentUser", "email"],
      ["app", "currentUser", "email"],
      ["store", "currentUser", "email"],
      ["liveSocket", "params", "user", "email"],
      ["liveSocket", "params", "email"],
    ];

    directPaths.forEach((pathParts) => {
      try {
        let cursor = window;
        for (const part of pathParts) {
          if (!cursor || typeof cursor !== "object") {
            cursor = null;
            break;
          }
          cursor = cursor[part];
        }
        if (typeof cursor === "string") {
          pushDirectCandidate(cursor, `window.${pathParts.join(".")}`, 240, candidates, seen);
        }
      } catch {
        // Ignore page object access failures.
      }
    });
  }

  function scanWindowState(candidates, seen) {
    const queue = [];
    const visited = new WeakSet();
    const enqueue = (value, path, depth, score) => {
      if (!value || typeof value !== "object") return;
      if (visited.has(value)) return;
      visited.add(value);
      queue.push({ value, path, depth, score });
    };

    const interestingGlobalKeys = Reflect.ownKeys(window).map((key) => String(key)).filter((key) =>
      /user|account|session|auth|profile|viewer|current|store|state|bootstrap|initial|app/i.test(key)
    );

    interestingGlobalKeys.forEach((key) => {
      try {
        enqueue(window[key], `window.${key}`, 0, /user|session|auth|profile|viewer|current/i.test(key) ? 180 : 130);
      } catch {
        // Ignore cross-origin or accessor failures.
      }
    });

    enqueue(window.__NEXT_DATA__, "window.__NEXT_DATA__", 0, 150);
    enqueue(window.__INITIAL_STATE__, "window.__INITIAL_STATE__", 0, 150);
    enqueue(window.__APOLLO_STATE__, "window.__APOLLO_STATE__", 0, 140);

    let scannedNodes = 0;
    while (queue.length > 0 && scannedNodes < MAX_NODES) {
      const entry = queue.shift();
      if (!entry) break;
      const { value, path, depth, score } = entry;
      scannedNodes += 1;

      if (depth > MAX_DEPTH) continue;

      let keys = [];
      try {
        keys = Reflect.ownKeys(value).map((key) => String(key));
      } catch {
        keys = [];
      }

      for (const key of keys.slice(0, 120)) {
        let child;
        try {
          child = value[key];
        } catch {
          continue;
        }

        const childPath = `${path}.${key}`;
        const keyScoreBoost = /email|username|login|viewer|user|profile|account/i.test(key) ? 70 : 0;
        const childScore = score + keyScoreBoost;

        if (typeof child === "string") {
          if (/email|username|login/i.test(key)) {
            pushDirectCandidate(child, childPath, childScore + 60, candidates, seen);
          }
          scanText(child, childPath, childScore, candidates, seen);
          continue;
        }

        if (typeof child === "number" || typeof child === "boolean" || child == null) {
          continue;
        }

        if (Array.isArray(child)) {
          child.slice(0, 20).forEach((item, index) => {
            if (typeof item === "string") {
              scanText(item, `${childPath}[${index}]`, childScore, candidates, seen);
              return;
            }
            enqueue(item, `${childPath}[${index}]`, depth + 1, childScore - 10);
          });
          continue;
        }

        enqueue(child, childPath, depth + 1, childScore - 5);
      }
    }
  }

  function collectCandidates() {
    const candidates = [];
    const seen = new Set();

    scanKnownGlobals(candidates, seen);
    scanWindowState(candidates, seen);

    [document.documentElement, document.body].forEach((node, index) => {
      if (!node?.dataset) return;
      Object.entries(node.dataset).forEach(([key, value]) => {
        const score = /email|user|account|profile/i.test(key) ? 160 : 100;
        scanText(value, `dataset:${index}:${key}`, score, candidates, seen);
      });
    });

    document.querySelectorAll("meta").forEach((meta) => {
      const name = `${meta.getAttribute("name") || ""}${meta.getAttribute("property") || ""}`.toLowerCase();
      const content = meta.getAttribute("content") || "";
      const score = /email|user|account|profile/i.test(name) ? 170 : 90;
      scanText(content, `meta:${name || "content"}`, score, candidates, seen);
    });

    candidates.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.email.localeCompare(b.email);
    });

    return candidates;
  }

  function sendSnapshot() {
    const best = collectCandidates()[0];
    if (!best?.email) return;

    const payload = {
      email: best.email,
      source: `main_world:${best.source}`,
      capturedAt: new Date().toISOString()
    };
    const cacheKey = JSON.stringify(payload);
    if (window[SENT_CACHE_KEY] === cacheKey) return;
    window[SENT_CACHE_KEY] = cacheKey;

    try {
      const root = document.documentElement;
      if (root) {
        root.setAttribute("data-mailroomnavigator-email", payload.email);
        root.setAttribute("data-mailroomnavigator-email-source", payload.source);
        root.setAttribute("data-mailroomnavigator-email-captured-at", payload.capturedAt);
      }
    } catch {
      // Ignore DOM attribute write failures.
    }

    window.postMessage(
      {
        source: "mailroomnavigator",
        type: MESSAGE_TYPE,
        data: payload
      },
      window.location.origin
    );
  }

  const debouncedSend = (() => {
    let timer = null;
    return () => {
      clearTimeout(timer);
      timer = setTimeout(sendSnapshot, 250);
    };
  })();

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", sendSnapshot, { once: true });
  } else {
    sendSnapshot();
  }

  window.addEventListener("load", sendSnapshot, { once: true });
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
