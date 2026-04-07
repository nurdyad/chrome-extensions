#!/usr/bin/env node

const { existsSync } = require("node:fs");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

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

  const value = String(raw).trim();
  if (!value || (inlineValue == null && value.startsWith("-"))) {
    throw new Error(`Missing value for ${flag}`);
  }

  return value;
}

function parseCliArgs(argv = process.argv.slice(2)) {
  const out = {
    docmanToolDir: "",
    practiceName: "",
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

      case "--practice": {
        const value = readValue(args, i, inlineValue, flag);
        if (inlineValue == null) i += 1;
        out.practiceName = value;
        break;
      }

      default:
        throw new Error(`Unknown option: ${flag}`);
    }
  }

  return out;
}

function printHelp() {
  console.log("Docman login runner\n");
  console.log("Required:");
  console.log("  --docman-tool-dir <path>");
  console.log("      Path to the local docman-tool project.");
  console.log("  --practice <name>");
  console.log("      Practice name as shown in BetterLetter.");
  console.log("\nOptional:");
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
  const userDataDir = path.join(os.tmpdir(), "mailroomnavigator-docman-login-chrome");
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

function resolveBasicAuth(config, loadBetterLetterBasicAuth) {
  const fromSaved = typeof loadBetterLetterBasicAuth === "function"
    ? loadBetterLetterBasicAuth()
    : null;
  if (fromSaved?.username && fromSaved?.password) {
    return {
      username: sanitizeSingleLine(fromSaved.username, 240),
      password: String(fromSaved.password),
      source: "env_or_saved_auth_file",
    };
  }

  const cfgUser = sanitizeSingleLine(config?.betterLetter?.basicAuth?.username, 240);
  const cfgPass = String(config?.betterLetter?.basicAuth?.password || "");
  if (cfgUser && cfgPass) {
    return {
      username: cfgUser,
      password: cfgPass,
      source: "runtime_config",
    };
  }

  return null;
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

async function main() {
  let session = null;
  let runOutcome = "success";
  let runLogger = createNoopLogger();

  try {
    const cliOptions = parseCliArgs(process.argv.slice(2));
    if (cliOptions.help) {
      printHelp();
      return;
    }

    const docmanToolDir = path.resolve(String(cliOptions.docmanToolDir || "").trim());
    const practiceName = sanitizeSingleLine(cliOptions.practiceName, 240);
    if (!docmanToolDir) {
      throw new Error("Missing --docman-tool-dir.");
    }
    if (!practiceName) {
      throw new Error("Missing --practice.");
    }
    if (!existsSync(docmanToolDir)) {
      throw new Error(`docman-tool directory not found: ${docmanToolDir}`);
    }

    const requireFromDocmanTool = (relativePath) => require(path.join(docmanToolDir, relativePath));
    const bootstrapDocmanSession = requireFromDocmanTool("automation/bootstrapDocmanSession.js");
    const { loadEnvFile } = requireFromDocmanTool("automation/env.js");
    const { loadRuntimeConfig } = requireFromDocmanTool("automation/config.js");
    const { loadBetterLetterBasicAuth } = requireFromDocmanTool("automation/betterLetterBasicAuth.js");
    const { withRetry } = requireFromDocmanTool("automation/retry.js");
    const { classifyError, createRunLogger } = requireFromDocmanTool("automation/runLogger.js");

    const envInfo = loadEnvFile();
    const { config, configPath, hasConfigFile, projectRoot } = loadRuntimeConfig();
    runLogger = createRunLogger({
      enabled: Boolean(config?.logging?.enabled),
      projectRoot,
      logDirectory: config?.logging?.directory || "logs",
      app: "docman-tool-login",
    });

    runLogger.event("config_loaded", {
      configPath,
      hasConfigFile,
      envFile: envInfo.filePath,
      envFileExists: envInfo.exists,
      envLoadedCount: envInfo.loadedCount,
    });

    console.log(`ℹ Runtime config: ${path.basename(configPath)} (${hasConfigFile ? "loaded" : "defaults"})`);
    if (envInfo.exists) {
      console.log(`ℹ Environment: ${path.basename(envInfo.filePath)} loaded (${envInfo.loadedCount} variable(s))`);
    }
    if (runLogger.enabled && runLogger.filePath) {
      console.log(`ℹ Run log: ${runLogger.filePath}`);
    }

    const basicAuth = resolveBasicAuth(config, loadBetterLetterBasicAuth);
    if (!basicAuth) {
      throw new Error("BetterLetter Basic Auth not found in environment, saved auth file, or runtime config.");
    }

    runLogger.event("basic_auth_resolved", {
      source: basicAuth.source,
      username: basicAuth.username,
    });

    console.log(`✔ Practice: ${practiceName}`);
    console.log(`Using basic auth user: ${basicAuth.username}`);
    console.log("🔗 Bootstrapping BetterLetter → Docman session…");

    const shouldUseExternalChrome = Boolean(config?.browser?.step4Visible) && Boolean(config?.browser?.step4UseCurrentChrome);
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
      label: "bootstrap_session",
      logger: runLogger,
      retryPolicy: { attempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
      withRetry,
      classifyError,
      task: async () =>
        bootstrapDocmanSession(practiceName, {
          httpCredentials: {
            username: basicAuth.username,
            password: basicAuth.password,
          },
          window: config.browser.window,
          preDocmanHeadless: config.browser.preDocmanHeadless,
          allowVisibleFallback: config.browser.allowVisibleFallback,
          step4Visible: config.browser.step4Visible,
          step4UseCurrentChrome: config.browser.step4UseCurrentChrome,
          step4BrowserEngine: config.browser.step4BrowserEngine,
          chromeCdpUrl: resolvedChromeCdpUrl,
          forceFreshDocmanLogin: false,
          resetDocmanAuthAtStart: true,
          includeDocmanInHealthCheck: false,
          skipPostLoginDialogWatch: true,
          retryPolicy: config.retries.step,
          timeouts: config.timeouts,
          logger: runLogger,
        }),
    });

    if (session?.isExternalBrowser) {
      console.log("ℹ Chrome was attached via CDP. Leaving the browser open after login.");
    }

    console.log("✅ LOGIN workflow finished.");
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

    if (session?.isExternalBrowser) {
      await disconnectExternalBrowserSession(session);
      return;
    }

    await closeSession(session);
  }
}

main();
