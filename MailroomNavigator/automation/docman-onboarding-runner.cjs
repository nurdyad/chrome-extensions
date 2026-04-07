#!/usr/bin/env node

const { existsSync } = require("node:fs");
const path = require("node:path");

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

function printHelp() {
  console.log("Docman onboarding runner\n");
  console.log("Required:");
  console.log("  --docman-tool-dir <path>");
  console.log("      Path to the local docman-tool project.");
  console.log("  --practice <name>");
  console.log("      Practice name as shown in BetterLetter.");
  console.log("\nOptional:");
  console.log("  --input-folder-name <name>");
  console.log("      Folder #4 choice for onboarding. Defaults to zz BL Input. Do not touch.");
  console.log("  --help, -h");
  console.log("      Show this help and exit.");
}

function parseCliArgs(argv = process.argv.slice(2)) {
  const out = {
    docmanToolDir: "",
    practiceName: "",
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

      case "--practice": {
        const value = readValue(args, i, inlineValue, flag);
        if (inlineValue == null) i += 1;
        out.practiceName = value;
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
    const onboardingDocmanFolders = requireFromDocmanTool("automation/onboardingDocmanFolders.js");
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
      app: "docman-tool-onboarding",
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

    const defaultInputFolderName = sanitizeSingleLine(
      onboardingDocmanFolders?.DEFAULT_FOLDER_NAMES?.[3] || "zz BL Input. Do not touch",
      240,
    ) || "zz BL Input. Do not touch";
    const inputFolderName = sanitizeSingleLine(cliOptions.inputFolderName, 240) || defaultInputFolderName;

    console.log(`✔ Practice: ${practiceName}`);
    console.log(`✔ Folder #4 choice: ${inputFolderName}`);
    console.log(`Using basic auth user: ${basicAuth.username}`);
    console.log("🔗 Bootstrapping BetterLetter → Docman session…");

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
          chromeCdpUrl: config.browser.chromeCdpUrl,
          forceFreshDocmanLogin: false,
          resetDocmanAuthAtStart: true,
          includeDocmanInHealthCheck: false,
          skipPostLoginDialogWatch: false,
          retryPolicy: config.retries.step,
          timeouts: config.timeouts,
          logger: runLogger,
        }),
    });

    const onboardingResult = await runStepWithRetry({
      label: "onboarding_docman_folders",
      logger: runLogger,
      retryPolicy: config.retries.step,
      withRetry,
      classifyError,
      task: async () =>
        onboardingDocmanFolders({
          page: session.page,
          inputFolderName,
          timeouts: config.timeouts,
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
    await closeSession(session);
  }
}

main();
