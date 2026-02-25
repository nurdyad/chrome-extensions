import "dotenv/config";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..");

const HOST = String(process.env.LINEAR_TRIGGER_SERVER_HOST || "127.0.0.1");
const PORT = Number(process.env.LINEAR_TRIGGER_SERVER_PORT || 4817);
const BOT_JOBS_DIR = String(
  process.env.LINEAR_TRIGGER_BOT_JOBS_DIR || "/Users/nursiddique/Projects/bot-jobs-linear",
);
const BOT_JOBS_ENTRY = String(process.env.LINEAR_TRIGGER_BOT_JOBS_ENTRY || "bot-jobs.js");
const BOT_JOBS_ENV_FILE = String(
  process.env.LINEAR_TRIGGER_BOT_JOBS_ENV_FILE || join(BOT_JOBS_DIR, ".env"),
);
const LOG_DIR = String(process.env.LINEAR_TRIGGER_LOG_DIR || join(REPO_ROOT, "logs"));
const STATE_DIR = String(process.env.LINEAR_TRIGGER_STATE_DIR || join(REPO_ROOT, ".automation-state"));
const SERVER_LOG_PATH = join(LOG_DIR, "linear-trigger-server.log");
const LAST_RUN_STATE_PATH = join(STATE_DIR, "linear-trigger-last-run.json");

const DEFAULT_ALLOWED_ORIGIN_PREFIX = "chrome-extension://";
const configuredOrigins = String(process.env.LINEAR_TRIGGER_ALLOWED_ORIGINS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const allowNoOrigin = String(process.env.LINEAR_TRIGGER_ALLOW_NO_ORIGIN || "1")
  .trim()
  .toLowerCase() !== "0";

let activeRun = null;
let lastRun = null;

function nowIso() {
  return new Date().toISOString();
}

function toRunPublic(run) {
  if (!run || typeof run !== "object") return null;
  const exitCode =
    typeof run.exitCode === "number" && Number.isFinite(run.exitCode)
      ? run.exitCode
      : null;
  return {
    runId: String(run.runId || ""),
    startedAt: String(run.startedAt || ""),
    endedAt: run.endedAt ? String(run.endedAt) : "",
    status: String(run.status || ""),
    dryRun: Boolean(run.dryRun),
    exitCode,
    signal: run.signal ? String(run.signal) : "",
    error: run.error ? String(run.error) : "",
  };
}

function isOriginAllowed(origin) {
  const normalized = String(origin || "").trim();
  if (!normalized) return allowNoOrigin;
  if (configuredOrigins.length > 0) {
    return configuredOrigins.includes(normalized);
  }
  return normalized.startsWith(DEFAULT_ALLOWED_ORIGIN_PREFIX);
}

function corsHeaders(origin) {
  const headers = {
    "Cache-Control": "no-store",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
  if (isOriginAllowed(origin)) {
    headers["Access-Control-Allow-Origin"] = origin || "*";
    headers["Vary"] = "Origin";
  }
  return headers;
}

async function appendServerLog(line) {
  await mkdir(LOG_DIR, { recursive: true });
  await appendFile(SERVER_LOG_PATH, `${line}\n`, "utf8");
}

async function writeLastRunState() {
  await mkdir(STATE_DIR, { recursive: true });
  const payload = {
    updatedAt: nowIso(),
    activeRun: toRunPublic(activeRun),
    lastRun: toRunPublic(lastRun),
  };
  await writeFile(LAST_RUN_STATE_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function loadLastRunState() {
  try {
    const raw = await readFile(LAST_RUN_STATE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed?.lastRun && typeof parsed.lastRun === "object") {
      lastRun = parsed.lastRun;
    }
  } catch {
    // No prior state on first boot is expected.
  }
}

async function parseJsonBody(req, maxBytes = 64 * 1024) {
  const chunks = [];
  let total = 0;

  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      throw new Error("Request body too large.");
    }
    chunks.push(chunk);
  }

  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function sendJson(res, statusCode, origin, payload) {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    ...corsHeaders(origin),
  };
  res.writeHead(statusCode, headers);
  res.end(JSON.stringify(payload));
}

function buildBotJobsEnv({ dryRun }) {
  const env = {
    ...process.env,
    DOTENV_CONFIG_PATH: BOT_JOBS_ENV_FILE,
    AUTH_HEADLESS: process.env.AUTH_HEADLESS || "1",
    AUTO_2FA_FROM_EMAIL: process.env.AUTO_2FA_FROM_EMAIL || "1",
  };
  if (dryRun) env.DRY_RUN = "1";
  else delete env.DRY_RUN;
  return env;
}

function createRunId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function startBotJobsRun({ dryRun }) {
  if (activeRun) {
    return { accepted: false, reason: "already_running", run: toRunPublic(activeRun) };
  }

  if (!existsSync(BOT_JOBS_DIR)) {
    throw new Error(`bot-jobs directory not found: ${BOT_JOBS_DIR}`);
  }
  const entryPath = join(BOT_JOBS_DIR, BOT_JOBS_ENTRY);
  if (!existsSync(entryPath)) {
    throw new Error(`bot-jobs entry script not found: ${entryPath}`);
  }
  if (!existsSync(BOT_JOBS_ENV_FILE)) {
    throw new Error(`bot-jobs env file not found: ${BOT_JOBS_ENV_FILE}`);
  }

  const runId = createRunId();
  const startedAt = nowIso();
  const child = spawn(process.execPath, [BOT_JOBS_ENTRY], {
    cwd: BOT_JOBS_DIR,
    env: buildBotJobsEnv({ dryRun }),
    stdio: ["ignore", "pipe", "pipe"],
  });

  activeRun = {
    runId,
    startedAt,
    endedAt: "",
    status: "running",
    dryRun: Boolean(dryRun),
    exitCode: null,
    signal: "",
    error: "",
    pid: child.pid || null,
  };
  await appendServerLog(`[${nowIso()}] [${runId}] started (dryRun=${Boolean(dryRun)})`);
  await writeLastRunState();

  child.stdout?.on("data", (chunk) => {
    const text = String(chunk || "").replace(/\r?\n$/, "");
    appendServerLog(`[${nowIso()}] [${runId}] [stdout] ${text}`).catch(() => undefined);
  });

  child.stderr?.on("data", (chunk) => {
    const text = String(chunk || "").replace(/\r?\n$/, "");
    appendServerLog(`[${nowIso()}] [${runId}] [stderr] ${text}`).catch(() => undefined);
  });

  child.on("error", (error) => {
    const endedAt = nowIso();
    lastRun = {
      ...activeRun,
      endedAt,
      status: "failed",
      error: String(error?.message || "Unknown process error"),
    };
    activeRun = null;
    appendServerLog(`[${nowIso()}] [${runId}] process error: ${lastRun.error}`).catch(() => undefined);
    writeLastRunState().catch(() => undefined);
  });

  child.on("exit", (code, signal) => {
    const endedAt = nowIso();
    const status = Number(code) === 0 ? "success" : "failed";
    lastRun = {
      ...activeRun,
      endedAt,
      status,
      exitCode: Number.isFinite(Number(code)) ? Number(code) : null,
      signal: signal ? String(signal) : "",
      error: Number(code) === 0 ? "" : `bot-jobs exited with code ${Number(code)}.`,
    };
    activeRun = null;
    appendServerLog(
      `[${nowIso()}] [${runId}] finished status=${status} code=${String(code)} signal=${String(signal || "")}`,
    ).catch(() => undefined);
    writeLastRunState().catch(() => undefined);
  });

  return { accepted: true, run: toRunPublic(activeRun) };
}

await mkdir(LOG_DIR, { recursive: true });
await mkdir(STATE_DIR, { recursive: true });
await loadLastRunState();
await appendServerLog(`[${nowIso()}] linear-trigger server booting on ${HOST}:${PORT}`);

const server = createServer(async (req, res) => {
  const method = String(req.method || "GET").toUpperCase();
  const origin = String(req.headers.origin || "");
  const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);
  const path = url.pathname;

  if (method === "OPTIONS") {
    res.writeHead(204, corsHeaders(origin));
    res.end();
    return;
  }

  if (!isOriginAllowed(origin)) {
    sendJson(res, 403, origin, {
      ok: false,
      error: "Forbidden origin.",
    });
    return;
  }

  try {
    if (method === "GET" && path === "/health") {
      sendJson(res, 200, origin, {
        ok: true,
        running: Boolean(activeRun),
        activeRun: toRunPublic(activeRun),
        lastRun: toRunPublic(lastRun),
        serverTime: nowIso(),
      });
      return;
    }

    if (method === "POST" && path === "/trigger-linear") {
      const body = await parseJsonBody(req).catch(() => ({}));
      const dryRun = Boolean(body?.dryRun);
      const result = await startBotJobsRun({ dryRun });
      if (!result.accepted) {
        sendJson(res, 409, origin, {
          ok: false,
          running: true,
          error: "A bot-jobs run is already in progress.",
          run: result.run,
        });
        return;
      }
      sendJson(res, 202, origin, {
        ok: true,
        accepted: true,
        run: result.run,
      });
      return;
    }

    sendJson(res, 404, origin, {
      ok: false,
      error: "Not found.",
    });
  } catch (error) {
    await appendServerLog(`[${nowIso()}] request error: ${String(error?.message || error)}`);
    sendJson(res, 500, origin, {
      ok: false,
      error: String(error?.message || "Internal server error."),
    });
  }
});

server.listen(PORT, HOST, () => {
  appendServerLog(`[${nowIso()}] linear-trigger server listening on ${HOST}:${PORT}`).catch(() => undefined);
});

process.on("SIGTERM", () => {
  server.close(() => {
    appendServerLog(`[${nowIso()}] linear-trigger server stopped (SIGTERM)`).catch(() => undefined);
    process.exit(0);
  });
});

process.on("SIGINT", () => {
  server.close(() => {
    appendServerLog(`[${nowIso()}] linear-trigger server stopped (SIGINT)`).catch(() => undefined);
    process.exit(0);
  });
});
