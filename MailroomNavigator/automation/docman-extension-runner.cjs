#!/usr/bin/env node

const { existsSync } = require("node:fs");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { createRequire } = require("node:module");

const DOCMAN_ORIGIN = "https://production.docman.thirdparty.nhs.uk";
const DOCMAN_HOST_SUFFIX = "docman.thirdparty.nhs.uk";
const DOCMAN_FILING_URL = `${DOCMAN_ORIGIN}/DocumentViewer/Filing`;
const DOCMAN_LOGIN_URL = `${DOCMAN_ORIGIN}/Account/Login`;

function createNoopLogger() {
  return {
    enabled: false,
    filePath: null,
    event: () => {},
    startStep: (name) => ({ name: String(name || "disabled"), startedAt: Date.now() }),
    endStep: () => {},
    close: () => {},
  };
}

function sanitizeSingleLine(value, maxLength = 240) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function sanitizeSecret(value, maxLength = 240) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function normalizeAction(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "login") return "login";
  if (normalized === "verify") return "verify";
  if (["create-group", "create_group", "creategroup", "group"].includes(normalized)) return "create-group";
  if (["clean-processing", "clean_processing", "processing"].includes(normalized)) return "clean-processing";
  if (["clean-filing", "clean_filing", "filing"].includes(normalized)) return "clean-filing";
  if (normalized === "onboarding") return "onboarding";
  return "";
}

function splitFlagAndValue(token) {
  if (!String(token || "").startsWith("--")) {
    return { flag: String(token || ""), inlineValue: null };
  }

  const eqIndex = token.indexOf("=");
  if (eqIndex === -1) {
    return { flag: token, inlineValue: null };
  }

  return {
    flag: token.slice(0, eqIndex),
    inlineValue: token.slice(eqIndex + 1),
  };
}

function readValue(args, index, inlineValue, flag) {
  const raw = inlineValue != null ? inlineValue : args[index + 1];
  if (raw == null) {
    throw new Error(`Missing value for ${flag}`);
  }

  const value = String(raw);
  if (!value.trim() || (inlineValue == null && value.trim().startsWith("-"))) {
    throw new Error(`Missing value for ${flag}`);
  }

  return value;
}

function sanitizeUsernames(rawValue) {
  const source = Array.isArray(rawValue)
    ? rawValue
    : String(rawValue || "")
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .filter(Boolean);
  const seen = new Set();
  const usernames = [];
  for (const value of source) {
    const username = sanitizeSingleLine(value, 120);
    if (!username) continue;
    const key = username.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    usernames.push(username);
  }
  return usernames.slice(0, 500);
}

function parseCliArgs(argv = process.argv.slice(2)) {
  const out = {
    docmanToolDir: "",
    action: "",
    practiceName: "",
    odsCode: "",
    groupName: "",
    usernames: [],
    inputFolderName: "",
    help: false,
  };

  const args = [...argv];
  for (let i = 0; i < args.length; i += 1) {
    const token = String(args[i] || "").trim();
    if (!token) continue;
    const { flag, inlineValue } = splitFlagAndValue(token);

    switch (flag) {
      case "-h":
      case "--help":
        out.help = true;
        break;

      case "--docman-tool-dir": {
        const value = readValue(args, i, inlineValue, flag);
        if (inlineValue == null) i += 1;
        out.docmanToolDir = value;
        break;
      }

      case "--action": {
        const value = readValue(args, i, inlineValue, flag);
        if (inlineValue == null) i += 1;
        out.action = normalizeAction(value);
        break;
      }

      case "--practice": {
        const value = readValue(args, i, inlineValue, flag);
        if (inlineValue == null) i += 1;
        out.practiceName = value;
        break;
      }

      case "--ods-code": {
        const value = readValue(args, i, inlineValue, flag);
        if (inlineValue == null) i += 1;
        out.odsCode = value;
        break;
      }

      case "--group-name": {
        const value = readValue(args, i, inlineValue, flag);
        if (inlineValue == null) i += 1;
        out.groupName = value;
        break;
      }

      case "--usernames": {
        const value = readValue(args, i, inlineValue, flag);
        if (inlineValue == null) i += 1;
        out.usernames = sanitizeUsernames(value);
        break;
      }

      case "--input-folder-name": {
        const value = readValue(args, i, inlineValue, flag);
        if (inlineValue == null) i += 1;
        out.inputFolderName = value;
        break;
      }

      default:
        throw new Error(`Unknown option: ${flag}`);
    }
  }

  return out;
}

function printHelp() {
  console.log("Docman extension runner\n");
  console.log("Required:");
  console.log("  --docman-tool-dir <path>");
  console.log("      Path to the local docman-tool project.");
  console.log("  --action <login|verify|create-group|clean-processing|clean-filing|onboarding>");
  console.log("      Extension-triggered Docman action.");
  console.log("  --practice <name>");
  console.log("      Practice name as shown in BetterLetter.");
  console.log("  --ods-code <code>");
  console.log("      Practice ODS code used for Docman login.");
  console.log("\nEnvironment:");
  console.log("  MAILROOM_DOCMAN_USERNAME");
  console.log("      Docman username from BetterLetter settings.");
  console.log("  MAILROOM_DOCMAN_PASSWORD");
  console.log("      Docman password from BetterLetter settings.");
  console.log("\nOptional:");
  console.log("  --group-name <name>");
  console.log("      Required for create-group.");
  console.log("  --usernames <newline-delimited names>");
  console.log("      Required for verify and create-group.");
  console.log("  --input-folder-name <name>");
  console.log("      Folder #4 choice for onboarding.");
  console.log("  --help, -h");
  console.log("      Show this help and exit.");
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function sanitizeUrl(value) {
  try {
    return new URL(String(value || "").trim()).toString();
  } catch (_) {
    return "";
  }
}

function getChromeCdpUrl(config = {}) {
  return sanitizeUrl(config?.browser?.chromeCdpUrl) || "http://127.0.0.1:9222";
}

function getChromeExecutableCandidates() {
  return [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ];
}

function resolveChromeExecutablePath() {
  return getChromeExecutableCandidates().find((candidate) => existsSync(candidate)) || "";
}

async function isChromeCdpAvailable(cdpUrl) {
  const targetUrl = sanitizeUrl(cdpUrl);
  if (!targetUrl) return false;

  try {
    const versionUrl = new URL("/json/version", targetUrl).toString();
    const response = await fetch(versionUrl, { method: "GET" });
    if (!response.ok) return false;
    const payload = await response.json().catch(() => null);
    return Boolean(payload?.webSocketDebuggerUrl);
  } catch (_) {
    return false;
  }
}

async function waitForChromeCdp(cdpUrl, timeoutMs = 15000) {
  const deadline = Date.now() + Math.max(1000, Number(timeoutMs) || 15000);
  while (Date.now() < deadline) {
    if (await isChromeCdpAvailable(cdpUrl)) {
      return true;
    }
    await wait(500);
  }
  return false;
}

function getChromeDebugPort(cdpUrl) {
  try {
    const parsed = new URL(cdpUrl);
    const explicitPort = Number.parseInt(parsed.port || "", 10);
    if (Number.isInteger(explicitPort) && explicitPort > 0) {
      return explicitPort;
    }
    return parsed.protocol === "https:" ? 443 : 80;
  } catch (_) {
    return 9222;
  }
}

async function ensureChromeCdpSession(cdpUrl) {
  const normalizedUrl = sanitizeUrl(cdpUrl);
  if (!normalizedUrl) {
    throw new Error("Invalid Chrome CDP URL.");
  }

  if (await isChromeCdpAvailable(normalizedUrl)) {
    return { cdpUrl: normalizedUrl, launchedChrome: false };
  }

  const executablePath = resolveChromeExecutablePath();
  if (!executablePath) {
    throw new Error("Google Chrome executable not found. Install Chrome or configure chromeCdpUrl manually.");
  }

  const debugPort = getChromeDebugPort(normalizedUrl);
  const userDataDir = path.join(os.tmpdir(), "mailroomnavigator-docman-extension-chrome");
  fs.mkdirSync(userDataDir, { recursive: true });

  const child = spawn(executablePath, [
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--new-window",
    "about:blank",
  ], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  const ready = await waitForChromeCdp(normalizedUrl, 20000);
  if (!ready) {
    throw new Error(`Chrome CDP did not become available at ${normalizedUrl}.`);
  }

  return {
    cdpUrl: normalizedUrl,
    launchedChrome: true,
    executablePath,
    userDataDir,
  };
}

async function runStepWithRetry({ label, task, logger, retryPolicy, withRetry, classifyError }) {
  const stepToken = logger?.startStep?.(label);
  try {
    const result = await withRetry(task, {
      ...retryPolicy,
      label,
      onRetry: ({ nextAttempt, attempts, delayMs, error }) => {
        const message = error?.message || "unknown error";
        console.log(`↻ ${label} failed (${message}). retry ${nextAttempt}/${attempts} in ${delayMs}ms`);
        logger?.event?.("step_retry", {
          step: label,
          nextAttempt,
          attempts,
          delayMs,
          errorType: classifyError(error),
          errorMessage: message,
        });
      },
    });
    logger?.endStep?.(stepToken, { status: "ok" });
    return result;
  } catch (error) {
    logger?.endStep?.(stepToken, {
      status: "error",
      errorType: classifyError(error),
      errorMessage: error?.message || String(error),
    });
    throw error;
  }
}

async function closeSession(session) {
  if (!session?.context) {
    process.stdin.pause();
    return;
  }

  if (typeof session.safeClose === "function") {
    await session.safeClose();
    process.stdin.pause();
    return;
  }

  try {
    await session.context.close();
  } catch (_) {
    // Ignore close failures so the process can still exit.
  }
  process.stdin.pause();
}

async function disconnectExternalBrowserSession(session) {
  const browser = typeof session?.context?.browser === "function"
    ? session.context.browser()
    : null;
  try {
    if (browser && typeof browser.close === "function") {
      await browser.close();
    }
  } catch (_) {
    // Ignore disconnect errors for CDP sessions.
  }
  process.stdin.pause();
}

async function clearDocmanAuthFromContext(context) {
  const docmanUrls = [
    `${DOCMAN_ORIGIN}/`,
    DOCMAN_LOGIN_URL,
    DOCMAN_FILING_URL,
  ];

  let removedCount = 0;

  try {
    const docmanCookies = await context.cookies(docmanUrls);
    if (!docmanCookies.length) return 0;

    const expiryCookies = docmanCookies
      .filter((cookie) => {
        const domain = String(cookie.domain || "").replace(/^\./, "").toLowerCase();
        return domain.endsWith(DOCMAN_HOST_SUFFIX);
      })
      .map((cookie) => {
        const expired = {
          name: cookie.name,
          value: "",
          domain: cookie.domain,
          path: cookie.path || "/",
          expires: 0,
          httpOnly: Boolean(cookie.httpOnly),
          secure: Boolean(cookie.secure),
        };

        if (cookie.sameSite === "Lax" || cookie.sameSite === "Strict" || cookie.sameSite === "None") {
          expired.sameSite = cookie.sameSite;
        }

        return expired;
      });

    removedCount = expiryCookies.length;
    if (expiryCookies.length) {
      await context.addCookies(expiryCookies).catch(() => {});
    }

    return removedCount;
  } catch (_) {
    return removedCount;
  }
}

async function tryOpenDocmanExplicitSignIn(page) {
  const trigger = page
    .locator(
      [
        'button:has-text("Sign in to Continue")',
        'a:has-text("Sign in to Continue")',
        'button:has-text("Sign In to Continue")',
        'a:has-text("Sign In to Continue")',
      ].join(", "),
    )
    .first();

  const visible = await trigger.isVisible({ timeout: 500 }).catch(() => false);
  if (!visible) return false;

  await trigger.click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(300);
  return true;
}

async function captureDocmanLoginDebugFiles(page, suffix = "failed") {
  const safe = String(suffix || "failed").replace(/[^a-z0-9_-]+/gi, "-");
  const screenshotPath = `docman-login-${safe}.png`;
  const htmlPath = `docman-login-${safe}.html`;

  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});

  const html = await page.content().catch(() => "");
  if (html) {
    fs.writeFileSync(htmlPath, html, "utf8");
  }

  return { screenshotPath, htmlPath };
}

async function overwriteInput(locator, value, label = "field") {
  await locator.click({ clickCount: 3 }).catch(() => {});
  await locator.press("ControlOrMeta+A").catch(() => {});
  await locator.press("Backspace").catch(() => {});
  await locator.fill("");
  await locator.type(value, { delay: 15 });

  const typed = await locator.inputValue().catch(() => "");
  if (typed !== value) {
    await locator.fill(value);
  }

  const finalValue = await locator.inputValue().catch(() => "");
  if (finalValue !== value) {
    throw new Error(`Docman ${label} did not stick in the input field.`);
  }
}

function getDocmanLoginFieldLocators(page) {
  return {
    orgField: page
      .locator(
        [
          "#OrganisationCode",
          "#OrganizationCode",
          "#OdsCode",
          'input[name="OrganisationCode"]',
          'input[name="OrganizationCode"]',
          'input[name="OdsCode"]',
          'input[name*="organisation" i]',
          'input[name*="organization" i]',
          'input[placeholder*="organisation" i]',
          'input[placeholder*="organization" i]',
        ].join(", "),
      )
      .first(),
    userField: page
      .locator(
        [
          "#UserName",
          "#Username",
          'input[name="UserName"]',
          'input[name="Username"]',
          'input[name*="user" i]',
          'input[autocomplete="username"]',
        ].join(", "),
      )
      .first(),
    passField: page
      .locator(
        [
          "#Password",
          'input[name="Password"]',
          'input[type="password"]',
          'input[autocomplete="current-password"]',
        ].join(", "),
      )
      .first(),
  };
}

async function inspectDocmanAuthSurface(page, timeoutMs = 6000) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const url = page.url();
    const lowerUrl = url.toLowerCase();

    const { orgField, userField, passField } = getDocmanLoginFieldLocators(page);

    const loginByUrl = lowerUrl.includes("/account/login") || lowerUrl.includes("/account/prelogin");

    const signInHeadingVisible = await page
      .locator("text=/Sign in to Continue/i")
      .first()
      .isVisible({ timeout: 250 })
      .catch(() => false);

    const autoSignInFailedVisible = await page
      .locator("text=/automatic sign-in failed/i")
      .first()
      .isVisible({ timeout: 250 })
      .catch(() => false);

    const orgVisible = await orgField.isVisible({ timeout: 250 }).catch(() => false);
    const userVisible = await userField.isVisible({ timeout: 250 }).catch(() => false);
    const passVisible = await passField.isVisible({ timeout: 250 }).catch(() => false);

    const filingUiVisible = await page
      .locator(
        [
          "span.all-docs-count",
          "#folders_list",
          "#folders",
          '[id*="folder" i]',
          '[class*="folder" i]',
          "text=/Filing/i",
        ].join(", "),
      )
      .first()
      .isVisible({ timeout: 250 })
      .catch(() => false);

    const onLoginPage =
      loginByUrl
      || signInHeadingVisible
      || autoSignInFailedVisible
      || (orgVisible && (userVisible || passVisible));

    if (onLoginPage || filingUiVisible) {
      return { onLoginPage, url };
    }

    await page.waitForTimeout(250);
  }

  const timeoutUrl = page.url();
  const timeoutLower = timeoutUrl.toLowerCase();
  return {
    onLoginPage: timeoutLower.includes("/account/login") || timeoutLower.includes("/account/prelogin"),
    url: timeoutUrl,
  };
}

async function ensureDocmanLoggedIn(page, { odsCode, username, password }, options = {}) {
  const navigationTimeoutMs = Number(options?.timeouts?.navigationMs) || 60000;
  const selectorTimeoutMs = Number(options?.timeouts?.selectorMs) || 60000;
  const fastCheckMs = Number(options?.timeouts?.docmanLoginFastCheckMs) || 3500;
  const deepCheckMs = Number(options?.timeouts?.docmanLoginDeepCheckMs) || 9000;

  console.log("➡ Checking Docman session (attempting Filing directly)...");
  const response = await page.goto(DOCMAN_FILING_URL, {
    waitUntil: "domcontentloaded",
    timeout: navigationTimeoutMs,
  });
  await page.waitForTimeout(150);

  const authState = await inspectDocmanAuthSurface(page, deepCheckMs);
  const onLoginPage = authState.onLoginPage;

  console.log(
    `[Docman auth check] status=${response?.status?.() ?? "n/a"} url=${authState.url} onLoginPage=${onLoginPage}`,
  );

  if (!onLoginPage) {
    console.log("✔ Docman appears already logged in (reused session).");
    return true;
  }

  console.log(`🔐 Docman login required. Logging in for ODS: ${odsCode}`);

  await tryOpenDocmanExplicitSignIn(page);

  const { orgField, userField, passField } = getDocmanLoginFieldLocators(page);

  await orgField.waitFor({ timeout: selectorTimeoutMs });
  await overwriteInput(orgField, odsCode, "Organisation Code");

  await userField.waitFor({ timeout: selectorTimeoutMs });
  await overwriteInput(userField, username, "User Name");

  await passField.waitFor({ timeout: selectorTimeoutMs });
  await overwriteInput(passField, password, "Password");

  const formScopedSubmit = passField
    .locator("xpath=ancestor::form[1]")
    .locator(
      [
        'button[type="submit"]',
        'input[type="submit"]',
        'button:has-text("Sign In")',
        'button:has-text("Sign in")',
      ].join(", "),
    )
    .first();

  const submitCount = await formScopedSubmit.count().catch(() => 0);
  if (submitCount > 0) {
    await formScopedSubmit.waitFor({ state: "attached", timeout: 30000 });
    await formScopedSubmit.click({ timeout: 30000 }).catch(async () => {
      await passField.press("Enter").catch(() => {});
    });
  } else {
    await passField.press("Enter").catch(() => {});
  }

  await Promise.race([
    page.waitForURL(
      (url) => {
        const current = String(url).toLowerCase();
        return !current.includes("/account/login") && !current.includes("/account/prelogin");
      },
      { timeout: Math.min(10000, navigationTimeoutMs) },
    ).catch(() => null),
    page.waitForLoadState("domcontentloaded", { timeout: 6000 }).catch(() => null),
    page.waitForTimeout(1200),
  ]);

  let postLoginState = await inspectDocmanAuthSurface(page, fastCheckMs);
  if (postLoginState.onLoginPage) {
    await page.goto(DOCMAN_FILING_URL, { waitUntil: "commit", timeout: navigationTimeoutMs });
    postLoginState = await inspectDocmanAuthSurface(page, deepCheckMs);
  }

  if (postLoginState.onLoginPage) {
    const debugFiles = await captureDocmanLoginDebugFiles(page, "failed");
    throw new Error(
      "Docman login did not complete (still on login page after submitting). "
        + `Current URL: ${postLoginState.url}. `
        + `Debug files: ${debugFiles.screenshotPath}, ${debugFiles.htmlPath}`,
    );
  }

  console.log("✔ Docman login completed.");
  return true;
}

async function waitAndDismissBlockingDialogs(
  page,
  reason = "unknown",
  windowMs = 5000,
  pollMs = 250,
) {
  console.log(`⏳ Watching for blocking dialogs (${reason})`);

  const start = Date.now();
  let dismissedAny = false;
  let lastModalSeenAt = null;
  const quietExitMs = 1200;

  while (Date.now() - start < windowMs) {
    const modal = page.locator(".alertify.ajs-in, .alertify.ajs-fade.ajs-in");

    if (await modal.count()) {
      dismissedAny = true;
      lastModalSeenAt = Date.now();
      console.log("⚠ Blocking dialog detected — dismissing");

      const button = modal
        .locator("button, a")
        .filter({ hasText: /ok|confirm|close|continue|yes|got it|×/i })
        .first();

      if (await button.count()) {
        await button.click({ force: true }).catch(() => {});
      } else {
        await page.keyboard.press("Escape").catch(() => {});
      }
    } else {
      const now = Date.now();
      if (!dismissedAny && now - start >= quietExitMs) {
        break;
      }
      if (dismissedAny && lastModalSeenAt && now - lastModalSeenAt >= quietExitMs) {
        break;
      }
    }

    await page.waitForTimeout(pollMs);
  }

  if (dismissedAny) console.log("✔ Dialog check complete");
  else console.log("✔ No blocking dialogs appeared");
}

async function main() {
  let session = null;
  let runOutcome = "success";
  let runLogger = createNoopLogger();
  let resolvedAction = "";

  try {
    const cliOptions = parseCliArgs(process.argv.slice(2));
    if (cliOptions.help) {
      printHelp();
      return;
    }

    const docmanToolDir = path.resolve(String(cliOptions.docmanToolDir || "").trim());
    const practiceName = sanitizeSingleLine(cliOptions.practiceName, 240);
    const odsCode = sanitizeSingleLine(cliOptions.odsCode, 16).toUpperCase();
    const action = normalizeAction(cliOptions.action);
    const groupName = sanitizeSingleLine(cliOptions.groupName, 240);
    const usernames = sanitizeUsernames(cliOptions.usernames);
    const docmanUsername = sanitizeSingleLine(process.env.MAILROOM_DOCMAN_USERNAME, 240);
    const docmanPassword = sanitizeSecret(process.env.MAILROOM_DOCMAN_PASSWORD, 240);

    resolvedAction = action;

    if (!docmanToolDir) {
      throw new Error("Missing --docman-tool-dir.");
    }
    if (!action) {
      throw new Error("Missing or invalid --action.");
    }
    if (!practiceName) {
      throw new Error("Missing --practice.");
    }
    if (!odsCode) {
      throw new Error("Missing --ods-code.");
    }
    if (!docmanUsername || !docmanPassword) {
      throw new Error("Missing MAILROOM_DOCMAN_USERNAME or MAILROOM_DOCMAN_PASSWORD.");
    }
    if (!existsSync(docmanToolDir)) {
      throw new Error(`docman-tool directory not found: ${docmanToolDir}`);
    }
    if (action === "verify" && usernames.length === 0) {
      throw new Error("Verify requires at least one username.");
    }
    if (action === "create-group") {
      if (!groupName) {
        throw new Error("Create Group requires a group name.");
      }
      if (usernames.length === 0) {
        throw new Error("Create Group requires at least one username.");
      }
    }

    const docmanRequire = createRequire(path.join(docmanToolDir, "run.js"));
    const { getBrowserSession } = docmanRequire("./automation/browserSession.js");
    const bootstrapDocmanSession = docmanRequire("./automation/bootstrapDocmanSession.js");
    const verifyDocmanUsers = docmanRequire("./verifyDocmanUsers.js");
    const cleanBetterLetterProcessing = docmanRequire("./cleanBetterLetterProcessing.js");
    const onboardingDocmanFolders = docmanRequire("./automation/onboardingDocmanFolders.js");
    const createDocmanUserGroup = docmanRequire("./automation/createDocmanUserGroup.js");
    const { loadEnvFile } = docmanRequire("./automation/env.js");
    const { loadRuntimeConfig } = docmanRequire("./automation/config.js");
    const { withRetry } = docmanRequire("./automation/retry.js");
    const { classifyError, createRunLogger } = docmanRequire("./automation/runLogger.js");
    let clipboardy = null;
    try {
      const clipboardModule = docmanRequire("clipboardy");
      clipboardy = clipboardModule?.default || clipboardModule || null;
    } catch (_) {
      clipboardy = null;
    }

    const envInfo = loadEnvFile();
    const { config, configPath, hasConfigFile, projectRoot } = loadRuntimeConfig();
    runLogger = createRunLogger({
      enabled: Boolean(config?.logging?.enabled),
      projectRoot,
      logDirectory: config?.logging?.directory || "logs",
      app: "docman-tool-extension",
    });

    runLogger.event("config_loaded", {
      configPath,
      hasConfigFile,
      envFile: envInfo.filePath,
      envFileExists: envInfo.exists,
      envLoadedCount: envInfo.loadedCount,
      action,
      practiceName,
      odsCode,
    });

    console.log(`ℹ Runtime config: ${path.basename(configPath)} (${hasConfigFile ? "loaded" : "defaults"})`);
    if (envInfo.exists) {
      console.log(`ℹ Environment: ${path.basename(envInfo.filePath)} loaded (${envInfo.loadedCount} variable(s))`);
    }
    if (runLogger.enabled && runLogger.filePath) {
      console.log(`ℹ Run log: ${runLogger.filePath}`);
    }

    console.log(`✔ Practice: ${practiceName} (${odsCode})`);
    console.log(`✔ Action: ${action}`);

    const shouldUseVisibleSession = Boolean(config?.browser?.step4Visible);
    const shouldUseExternalChrome = shouldUseVisibleSession && Boolean(config?.browser?.step4UseCurrentChrome);
    let resolvedChromeCdpUrl = getChromeCdpUrl(config);

    if (shouldUseExternalChrome) {
      const chromeSession = await ensureChromeCdpSession(resolvedChromeCdpUrl);
      resolvedChromeCdpUrl = chromeSession.cdpUrl;
      if (chromeSession.launchedChrome) {
        console.log(`ℹ Started external Chrome for CDP at ${resolvedChromeCdpUrl}.`);
      } else {
        console.log(`ℹ Reusing external Chrome at ${resolvedChromeCdpUrl}.`);
      }
    }

    session = await runStepWithRetry({
      label: "open_browser_session",
      logger: runLogger,
      retryPolicy: { attempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
      withRetry,
      classifyError,
      task: async () =>
        getBrowserSession({
          window: config?.browser?.window,
          headless: !shouldUseVisibleSession,
          browserEngine: config?.browser?.step4BrowserEngine || "chrome",
          attachToExistingChrome: shouldUseExternalChrome,
          chromeCdpUrl: resolvedChromeCdpUrl,
        }),
    });

    const removedCookies = await clearDocmanAuthFromContext(session.context);
    console.log(`🧹 Cleared Docman auth artifacts at startup (${removedCookies} cookie(s) removed).`);

    await runStepWithRetry({
      label: "login_docman_direct",
      logger: runLogger,
      retryPolicy: config?.retries?.step || { attempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
      withRetry,
      classifyError,
      task: async () =>
        ensureDocmanLoggedIn(
          session.page,
          {
            odsCode,
            username: docmanUsername,
            password: docmanPassword,
          },
          {
            timeouts: config?.timeouts,
          },
        ),
    });

    if (action !== "login") {
      await runStepWithRetry({
        label: "dismiss_post_login_dialogs",
        logger: runLogger,
        retryPolicy: { attempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
        withRetry,
        classifyError,
        task: async () => waitAndDismissBlockingDialogs(session.page, "after docman login"),
      });
    }

    if (action === "login") {
      if (session?.isExternalBrowser) {
        console.log("ℹ Chrome was attached via CDP. Leaving the browser open after login.");
      }
      console.log("✅ LOGIN workflow finished.");
      return;
    }

    if (action === "verify") {
      console.log("🔍 Starting VERIFY workflow…");
      console.log(`✔ Verifying ${usernames.length} username(s)`);

      const results = await runStepWithRetry({
        label: "verify_docman_users",
        logger: runLogger,
        retryPolicy: config?.retries?.step || { attempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
        withRetry,
        classifyError,
        task: async () => verifyDocmanUsers({ page: session.page, usernames }),
      });

      console.log("\nVerification results:");
      console.table(results);

      const valid = results
        .filter((result) => result.exists && result.docmanUsername)
        .map((result) => result.docmanUsername);

      if (valid.length && clipboardy && typeof clipboardy.write === "function") {
        await clipboardy.write(valid.join("\n")).catch(() => undefined);
        console.log("Copied exact Docman matches to clipboard ✔");
      }

      console.log("✅ VERIFY workflow finished.");
      return;
    }

    if (action === "create-group") {
      console.log("👥 Starting CREATE GROUP workflow…");
      console.log(`✔ Creating "${groupName}" with ${usernames.length} member(s)`);

      const result = await runStepWithRetry({
        label: "create_docman_user_group",
        logger: runLogger,
        retryPolicy: config?.retries?.step || { attempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
        withRetry,
        classifyError,
        task: async () =>
          createDocmanUserGroup({
            page: session.page,
            groupName,
            usernames,
            timeouts: config?.timeouts,
            logger: runLogger,
          }),
      });

      console.log(`✅ User group created: ${result.groupName}`);
      if (Array.isArray(result.members) && result.members.length) {
        console.log("Members added:");
        result.members.forEach((member) => console.log(` - ${member}`));
      }
      console.log("✅ CREATE GROUP workflow finished.");
      return;
    }

    if (action === "onboarding") {
      console.log("🧩 Starting ONBOARDING workflow…");
      const defaultInputFolderName = sanitizeSingleLine(
        onboardingDocmanFolders?.DEFAULT_FOLDER_NAMES?.[3] || "zz BL Input. Do not touch",
        240,
      ) || "zz BL Input. Do not touch";
      const inputFolderName = sanitizeSingleLine(cliOptions.inputFolderName, 240) || defaultInputFolderName;
      console.log(`✔ Folder #4 choice: ${inputFolderName}`);

      const onboardingResult = await runStepWithRetry({
        label: "onboarding_docman_folders",
        logger: runLogger,
        retryPolicy: config?.retries?.step || { attempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
        withRetry,
        classifyError,
        task: async () =>
          onboardingDocmanFolders({
            page: session.page,
            inputFolderName,
            timeouts: config?.timeouts,
            logger: runLogger,
          }),
      });

      const folderCount = Array.isArray(onboardingResult?.folderNames)
        ? onboardingResult.folderNames.length
        : 0;
      if (folderCount > 0 && Number(onboardingResult.existing) === folderCount) {
        console.log("ℹ All onboarding folders already exist for this practice. No changes made.");
      }
      console.log("✅ ONBOARDING workflow finished.");
      return;
    }

    if (action === "clean-processing" || action === "clean-filing") {
      const cleanType = action === "clean-processing" ? "processing" : "filing";
      console.log(`🧹 Starting CLEAN workflow (${cleanType})…`);

      if (typeof bootstrapDocmanSession.gotoDocmanFilingAndActivate === "function") {
        console.log("➡ Preparing Docman Filing for CLEAN workflow…");
        await runStepWithRetry({
          label: "prepare_filing_for_clean",
          logger: runLogger,
          retryPolicy: config?.retries?.step || { attempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
          withRetry,
          classifyError,
          task: async () =>
            bootstrapDocmanSession.gotoDocmanFilingAndActivate(session.page, {
              skipDialogCheck: true,
              timeouts: config?.timeouts,
            }),
        });
      }

      await runStepWithRetry({
        label: "clean_workflow",
        logger: runLogger,
        retryPolicy: { attempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
        withRetry,
        classifyError,
        task: async () =>
          cleanBetterLetterProcessing({
            page: session.page,
            cleanType,
            batchSize: config?.clean?.batchSize,
            dryRun: false,
            defaults: {
              sourceFolder: config?.clean?.defaultSourceFolder,
              destinationFolder: config?.clean?.defaultDestinationFolder,
            },
            inputs: {
              autoConfirmMove: true,
              nonInteractive: true,
            },
            folderPicker: config?.clean?.folderPicker,
            retryPolicy: config?.retries?.step,
            logger: runLogger,
          }),
      });

      console.log("✅ CLEAN workflow finished.");
      return;
    }

    throw new Error(`Unsupported Docman action: ${action}`);
  } catch (error) {
    runOutcome = "failed";
    runLogger?.event?.("run_error", {
      errorType: error?.name || "Error",
      errorMessage: error?.message || String(error),
    });
    console.error(`\n❌ FAILED: ${error?.message || error}`);
    process.exitCode = 1;
  } finally {
    runLogger?.close?.({ outcome: runOutcome });

    if (resolvedAction === "login" && session?.isExternalBrowser) {
      await disconnectExternalBrowserSession(session);
      return;
    }

    await closeSession(session);
  }
}

main();
