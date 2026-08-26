import { config as loadDotenv } from "dotenv";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

/**
 * Local trigger server used by the extension "Trigger Linear" button.
 * Security model:
 * - Binds to localhost only by default (127.0.0.1)
 * - Applies origin allowlist checks for browser requests
 * - Reads runtime config from env (no secrets hard-coded in repo)
 */
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "..");
const DEFAULT_ENV_PATH = resolve(REPO_ROOT, ".env");
const { Pool } = pg;
loadDotenv({ path: process.env.DOTENV_CONFIG_PATH || DEFAULT_ENV_PATH });

function normalizeTriggerServerHost(rawHost) {
  const normalized = String(rawHost || "").trim();
  if (!normalized) return "127.0.0.1";
  if (normalized === "0.0.0.0" || normalized === "::" || normalized === "[::]") {
    return "127.0.0.1";
  }
  return normalized;
}

const HOST = normalizeTriggerServerHost(process.env.LINEAR_TRIGGER_SERVER_HOST || "127.0.0.1");
const PORT = Number(process.env.LINEAR_TRIGGER_SERVER_PORT || 4817);
// Optional: when set, every request (except /health) must send this exact
// value back in the X-MailroomNav-Trigger-Secret header. Unset by default
// so a normal single-machine localhost install needs nothing extra; set
// this whenever LINEAR_TRIGGER_SERVER_HOST is bound to a LAN address other
// installs will share, since that server otherwise has no authentication
// at all - anyone who can reach the port can trigger issues, run Docman
// automation, or query the database through it.
const TRIGGER_SHARED_SECRET = String(process.env.LINEAR_TRIGGER_SHARED_SECRET || "").trim();
const TRIGGER_SECRET_HEADER = "x-mailroomnav-trigger-secret";
function resolveDefaultBotJobsDir() {
  const candidates = [
    resolve(REPO_ROOT, "..", "bot-jobs-linear"),
    resolve(process.env.HOME || "", "Projects", "bot-jobs-linear"),
  ];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return candidates[0];
}

const BOT_JOBS_DIR = String(process.env.LINEAR_TRIGGER_BOT_JOBS_DIR || resolveDefaultBotJobsDir());
const BOT_JOBS_ENTRY = String(process.env.LINEAR_TRIGGER_BOT_JOBS_ENTRY || "bot-jobs.js");
const BOT_JOBS_RECONCILE_ENTRY = String(
  process.env.LINEAR_TRIGGER_BOT_JOBS_RECONCILE_ENTRY || "reconcile-bot-issues.js",
);
const BOT_JOBS_ENV_FILE = String(
  process.env.LINEAR_TRIGGER_BOT_JOBS_ENV_FILE || join(BOT_JOBS_DIR, ".env"),
);
function resolveDefaultDocmanToolDir() {
  const candidates = [
    resolve(REPO_ROOT, "..", "..", "tools", "docman-tool"),
    resolve(process.env.HOME || "", "tools", "docman-tool"),
  ];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return candidates[0];
}

const DOCMAN_TOOL_DIR = String(
  process.env.LINEAR_TRIGGER_DOCMAN_TOOL_DIR
    || process.env.MAILROOMNAV_DOCMAN_TOOL_DIR
    || resolveDefaultDocmanToolDir(),
);
const DOCMAN_EXTENSION_RUNNER_ENTRY = resolve(REPO_ROOT, "automation", "docman-extension-runner.cjs");
const DOCMAN_TOOL_TIMEOUT_MINUTES = (() => {
  const parsed = Number.parseInt(String(process.env.LINEAR_TRIGGER_DOCMAN_TOOL_TIMEOUT_MINUTES || "45"), 10);
  if (!Number.isFinite(parsed)) return 45;
  return Math.min(180, Math.max(5, parsed));
})();
const DOCMAN_TOOL_TIMEOUT_MS = DOCMAN_TOOL_TIMEOUT_MINUTES * 60 * 1000;
const BOT_JOBS_TIMEOUT_MINUTES = (() => {
  const parsed = Number.parseInt(String(process.env.LINEAR_TRIGGER_BOT_JOBS_TIMEOUT_MINUTES || "20"), 10);
  if (!Number.isFinite(parsed)) return 20;
  return Math.min(120, Math.max(2, parsed));
})();
const BOT_JOBS_TIMEOUT_MS = BOT_JOBS_TIMEOUT_MINUTES * 60 * 1000;
// Keep this aligned with panel.js LINEAR_TRIGGER_STATUS_AUTO_CLEAR_MS so operators
// see the final run result in the side panel before Slack receives the summary.
const LINEAR_TRIGGER_SLACK_SUMMARY_DELAY_MS = 2000;
const LINEAR_GRAPHQL_ENDPOINT = "https://api.linear.app/graphql";
const LINEAR_API_KEY = String(
  process.env.LINEAR_API_KEY
    || process.env.LINEAR_PERSONAL_API_KEY
    || process.env.LINEAR_TRIGGER_API_KEY
    || "",
).trim().replace(/^bearer\s+/i, "");
const LINEAR_TEAM_KEY = String(
  process.env.LINEAR_TEAM_KEY
    || process.env.LINEAR_TRIGGER_TEAM_KEY
    || "",
).trim();
const LINEAR_DUPLICATE_REOPEN_STATE_NAME = sanitizeSingleLine(
  process.env.LINEAR_DUPLICATE_REOPEN_STATE_NAME
    || process.env.LINEAR_REOPEN_DUPLICATE_STATE_NAME
    || "In Review",
  120,
);
const SLACK_BOT_TOKEN = String(
  process.env.SLACK_BOT_TOKEN
    || process.env.LINEAR_SLACK_BOT_TOKEN
    || "",
).trim();
const SLACK_API_BASE_URL = "https://slack.com/api";
const SLACK_SYNC_MEMBER_ONLY = String(process.env.SLACK_SYNC_MEMBER_ONLY || "1")
  .trim()
  .toLowerCase() !== "0";
const LOG_DIR = String(process.env.LINEAR_TRIGGER_LOG_DIR || join(REPO_ROOT, "logs"));
const STATE_DIR = String(process.env.LINEAR_TRIGGER_STATE_DIR || join(REPO_ROOT, ".automation-state"));
const SLACK_TARGETS_CACHE_PATH = join(STATE_DIR, "slack-workspace-targets.json");
const SERVER_LOG_PATH = join(LOG_DIR, "linear-trigger-server.log");
const LAST_RUN_STATE_PATH = join(STATE_DIR, "linear-trigger-last-run.json");
const DOCMAN_LAST_RUN_STATE_PATH = join(STATE_DIR, "docman-tool-last-run.json");
const BOT_JOBS_REPORTS_DIR = join(STATE_DIR, "reports");
const SLACK_TARGETS_CACHE_TTL_MS = 10 * 60 * 1000;
const UUID_LOOKUP_CACHE_TTL_MS = 15 * 60 * 1000;
const SQL_LOOKUP_ENABLED = String(process.env.MAILROOMNAV_SQL_ENABLED || "1")
  .trim()
  .toLowerCase() !== "0";
const SQL_CONNECTION_STRING = String(
  process.env.MAILROOMNAV_DATABASE_URL
    || process.env.MAILROOMNAV_SQL_DATABASE_URL
    || process.env.DATABASE_URL
    || "",
).trim();
const SQL_HOST = String(process.env.MAILROOMNAV_SQL_HOST || process.env.PGHOST || "127.0.0.1").trim();
const SQL_PORT = (() => {
  const parsed = Number.parseInt(String(process.env.MAILROOMNAV_SQL_PORT || process.env.PGPORT || "15432"), 10);
  if (!Number.isFinite(parsed)) return 15432;
  return Math.min(65535, Math.max(1, parsed));
})();
const SQL_DATABASE = String(process.env.MAILROOMNAV_SQL_DATABASE || process.env.PGDATABASE || "mailroom_prod").trim();
const SQL_USER = String(process.env.MAILROOMNAV_SQL_USER || process.env.PGUSER || "reporting").trim();
const SQL_PASSWORD = String(process.env.MAILROOMNAV_SQL_PASSWORD || process.env.PGPASSWORD || "").trim();
const SQL_QUERY_TIMEOUT_MS = (() => {
  const parsed = Number.parseInt(String(process.env.MAILROOMNAV_SQL_QUERY_TIMEOUT_MS || "5000"), 10);
  if (!Number.isFinite(parsed)) return 5000;
  return Math.min(30000, Math.max(1000, parsed));
})();
const SQL_UUID_LOOKUP_TIMEOUT_MS = (() => {
  const parsed = Number.parseInt(String(process.env.MAILROOMNAV_SQL_UUID_LOOKUP_TIMEOUT_MS || "20000"), 10);
  if (!Number.isFinite(parsed)) return 20000;
  return Math.min(60000, Math.max(1000, parsed));
})();
const SQL_RECONCILE_ENABLED = String(process.env.MAILROOMNAV_SQL_RECONCILE_ENABLED || "1")
  .trim()
  .toLowerCase() !== "0";
const SQL_RECONCILE_MAX_ROWS = (() => {
  const parsed = Number.parseInt(String(process.env.MAILROOMNAV_SQL_RECONCILE_MAX_ROWS || "1000"), 10);
  if (!Number.isFinite(parsed)) return 1000;
  return Math.min(5000, Math.max(50, parsed));
})();
const SQL_RECONCILE_QUERY_TIMEOUT_MS = (() => {
  const parsed = Number.parseInt(String(process.env.MAILROOMNAV_SQL_RECONCILE_QUERY_TIMEOUT_MS || "15000"), 10);
  if (!Number.isFinite(parsed)) return 15000;
  return Math.min(60000, Math.max(1000, parsed));
})();
const SQL_CONNECTION_TIMEOUT_MS = (() => {
  const parsed = Number.parseInt(String(process.env.MAILROOMNAV_SQL_CONNECTION_TIMEOUT_MS || "2000"), 10);
  if (!Number.isFinite(parsed)) return 2000;
  return Math.min(15000, Math.max(500, parsed));
})();

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
let docmanActiveRun = null;
let lastDocmanRun = null;
let sqlPool = null;
let resolvedLinearTeam = null;
let resolvedLinearWorkflowStateCatalog = null;
let resolvedLinearIssueLabelCatalog = null;
const resolvedLinearStateIdCache = new Map();
const resolvedLinearLabelIdCache = new Map();
const SQL_CLIENT_ERROR_HANDLER_ATTACHED = Symbol("mailroomnavigatorSqlClientErrorHandlerAttached");
let slackTargetsCache = {
  loadedAt: 0,
  targets: null,
};
const uuidLookupCache = new Map();
const uuidLookupInFlight = new Map();
let restartRequested = false;

function nowIso() {
  return new Date().toISOString();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function supportsSelfRestart() {
  const launchAgentEnvFile = sanitizeSingleLine(process.env.LINEAR_TRIGGER_ENV_FILE || "", 400);
  const launchAgentBotJobsDir = sanitizeSingleLine(process.env.LINEAR_TRIGGER_BOT_JOBS_DIR || "", 400);
  const launchdServiceName = sanitizeSingleLine(
    process.env.XPC_SERVICE_NAME || process.env.LAUNCH_JOB_LABEL || "",
    200,
  );
  return Boolean(
    launchAgentEnvFile
    || launchAgentBotJobsDir
    || /launchagents/i.test(launchAgentEnvFile)
    || /projects\/bot-jobs-linear/i.test(launchAgentBotJobsDir)
    || /mailroomnavigator\/\.env/i.test(launchAgentEnvFile)
    || /mailroomnavigator/i.test(launchAgentBotJobsDir)
    || /linear-trigger-server/i.test(launchdServiceName)
    || (process.platform === "darwin" && process.ppid === 1)
  );
}

function scheduleServerRestart(reason = "manual") {
  if (restartRequested) return false;
  restartRequested = true;
  const normalizedReason = sanitizeSingleLine(reason, 80) || "manual";
  appendServerLog(`[${nowIso()}] linear-trigger restart requested reason=${normalizedReason}`).catch(() => undefined);

  setTimeout(() => {
    server.close(() => {
      appendServerLog(`[${nowIso()}] linear-trigger server restarting reason=${normalizedReason}`).catch(() => undefined);
      process.exit(0);
    });

    setTimeout(() => {
      process.exit(0);
    }, 1500);
  }, 180);

  return true;
}

function sanitizeSingleLine(value, maxLength = 1024) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function sanitizeMultiline(value, maxLength = 12000) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\u0000/g, "")
    .trim()
    .slice(0, maxLength);
}

function sanitizeHttpUrl(value) {
  try {
    const raw = String(value || "").trim();
    if (!raw) return "";
    const url = new URL(raw);
    if (!/^https?:$/i.test(url.protocol)) return "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

function sanitizeStringList(values, maxItems = 8, maxLength = 220) {
  if (!Array.isArray(values)) return [];
  return values
    .map((value) => sanitizeSingleLine(value, maxLength))
    .filter(Boolean)
    .slice(0, maxItems);
}

function sanitizeDbSecret(value, maxLength = 1024) {
  return String(value ?? "")
    .replace(/\u0000/g, "")
    .trim()
    .slice(0, maxLength);
}

function normalizeOdsCode(value) {
  const normalized = sanitizeSingleLine(value, 24).toUpperCase();
  return /^[A-Z]\d{5}$/.test(normalized) ? normalized : "";
}

function normalizePracticeLookupQuery(value) {
  return sanitizeSingleLine(value, 120).replace(/[<>]/g, "").trim();
}

function sqlPasswordMayComeFromPgPass() {
  const pgpassFile = String(process.env.PGPASSFILE || "").trim();
  if (pgpassFile && existsSync(pgpassFile)) return true;
  const homePgpass = process.env.HOME ? resolve(process.env.HOME, ".pgpass") : "";
  return Boolean(homePgpass && existsSync(homePgpass));
}

function isSqlLookupConfigured() {
  if (!SQL_LOOKUP_ENABLED) return false;
  if (SQL_CONNECTION_STRING) return true;
  return Boolean(SQL_HOST && SQL_PORT && SQL_DATABASE && SQL_USER && (SQL_PASSWORD || sqlPasswordMayComeFromPgPass()));
}

function getSqlPublicConfig() {
  return {
    enabled: SQL_LOOKUP_ENABLED,
    configured: isSqlLookupConfigured(),
    host: SQL_HOST || "",
    port: SQL_PORT,
    database: SQL_DATABASE || "",
    user: SQL_USER || "",
    passwordConfigured: Boolean(SQL_PASSWORD || SQL_CONNECTION_STRING || sqlPasswordMayComeFromPgPass()),
    queryTimeoutMs: SQL_QUERY_TIMEOUT_MS,
    uuidLookupTimeoutMs: SQL_UUID_LOOKUP_TIMEOUT_MS,
    reconcileEnabled: SQL_RECONCILE_ENABLED,
    reconcileMaxRows: SQL_RECONCILE_MAX_ROWS,
    reconcileQueryTimeoutMs: SQL_RECONCILE_QUERY_TIMEOUT_MS,
  };
}

function getSqlPool() {
  if (!isSqlLookupConfigured()) {
    throw new Error("Cloud SQL lookup is not configured. Add MAILROOMNAV_SQL_PASSWORD to MailroomNavigator/.env and restart the local service.");
  }
  if (sqlPool) return sqlPool;

  const baseConfig = {
    max: 2,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: SQL_CONNECTION_TIMEOUT_MS,
    application_name: "mailroomnavigator-local-service",
  };
  sqlPool = SQL_CONNECTION_STRING
    ? new Pool({ ...baseConfig, connectionString: SQL_CONNECTION_STRING })
    : new Pool({
        ...baseConfig,
        host: SQL_HOST,
        port: SQL_PORT,
        database: SQL_DATABASE,
        user: SQL_USER,
        password: SQL_PASSWORD || undefined,
        ssl: false,
      });

  sqlPool.on("error", (error) => {
    appendServerLog(`[${nowIso()}] sql pool error: ${String(error?.message || error)}`).catch(() => undefined);
    if (isTransientSqlConnectionError(error)) {
      resetSqlPoolAfterConnectionError(error?.message || error).catch(() => undefined);
    }
  });
  sqlPool.on("connect", (client) => {
    ensureSqlClientErrorHandler(client);
  });
  sqlPool.on("acquire", (client) => {
    ensureSqlClientErrorHandler(client);
  });
  return sqlPool;
}

function ensureSqlClientErrorHandler(client) {
  if (!client || client[SQL_CLIENT_ERROR_HANDLER_ATTACHED]) return;
  Object.defineProperty(client, SQL_CLIENT_ERROR_HANDLER_ATTACHED, {
    value: true,
    enumerable: false,
    configurable: false,
  });
  client.on("error", (error) => {
    appendServerLog(`[${nowIso()}] sql client error: ${String(error?.message || error)}`).catch(() => undefined);
  });
}

function isTransientSqlConnectionError(error) {
  const message = String(error?.message || error || "").toLowerCase();
  const code = String(error?.code || "").toUpperCase();
  return Boolean(
    code === "ECONNRESET"
    || code === "ECONNREFUSED"
    || code === "57P01"
    || message.includes("connection terminated unexpectedly")
    || message.includes("server closed the connection unexpectedly")
    || message.includes("terminating connection")
    || message.includes("connection reset by peer")
    || message.includes("socket hang up")
    || message.includes("read econnreset")
  );
}

async function runSqlQuery(text, values = [], options = {}) {
  const pool = getSqlPool();
  const timeoutMs = (() => {
    const parsed = Number.parseInt(String(options?.timeoutMs || SQL_QUERY_TIMEOUT_MS), 10);
    if (!Number.isFinite(parsed)) return SQL_QUERY_TIMEOUT_MS;
    return Math.min(60000, Math.max(1000, parsed));
  })();
  const client = await pool.connect();
  ensureSqlClientErrorHandler(client);
  let queryError = null;
  try {
    await client.query("BEGIN READ ONLY");
    await client.query("SELECT set_config($1, $2, true)", ["statement_timeout", String(timeoutMs)]);
    const result = await client.query(text, values);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    queryError = error;
    try {
      await client.query("ROLLBACK");
    } catch {
      // Ignore rollback failures; the original query error is more useful.
    }
    throw error;
  } finally {
    client.release(queryError && isTransientSqlConnectionError(queryError) ? queryError : undefined);
  }
}

async function resetSqlPoolAfterConnectionError(reason = "") {
  const stalePool = sqlPool;
  sqlPool = null;
  if (!stalePool) return;
  await appendServerLog(
    `[${nowIso()}] sql pool reset${reason ? `: ${sanitizeSingleLine(reason, 220)}` : ""}`,
  ).catch(() => undefined);
  try {
    await stalePool.end();
  } catch (error) {
    await appendServerLog(
      `[${nowIso()}] sql pool reset cleanup failed: ${sanitizeSingleLine(error?.message || error, 220)}`,
    ).catch(() => undefined);
  }
}

async function runSqlQueryWithConnectionRetry(text, values = [], options = {}) {
  const attempts = Math.max(1, Math.min(3, Number.parseInt(String(options?.attempts || "2"), 10) || 2));
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await runSqlQuery(text, values, options);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !isTransientSqlConnectionError(error)) throw error;
      await appendServerLog(
        `[${nowIso()}] sql query retry ${attempt + 1}/${attempts} after connection error: ${sanitizeSingleLine(error?.message || error, 220)}`,
      ).catch(() => undefined);
      await resetSqlPoolAfterConnectionError(error?.message || error);
      await delay(150);
    }
  }

  throw lastError;
}

function isPresentSecret(value) {
  return sanitizeDbSecret(value).length > 0;
}

function rowCountValue(value) {
  if (value === null || value === undefined) return "";
  const number = Number(value);
  if (!Number.isFinite(number)) return sanitizeSingleLine(value, 40);
  return String(number);
}

function firstPresentCountValue(...values) {
  for (const value of values) {
    if (value === null || value === undefined) continue;
    if (String(value).trim() === "") continue;
    return rowCountValue(value);
  }
  return "";
}

function sanitizePracticeLookupRow(row = {}, { includeSecrets = false } = {}) {
  const odsCode = normalizeOdsCode(row.ods_code);
  const practiceCdb = sanitizeSingleLine(row.practice_cdb, 80);
  const displayName = sanitizeSingleLine(row.display_name, 240);
  const docmanPassword = sanitizeDbSecret(row.docman_password);
  const emisApiPassword = sanitizeDbSecret(row.emis_api_password);
  const emisWebPassword = sanitizeDbSecret(row.emis_web_password);
  const isSelfService = row.self_service === true;
  const preferredQuota = isSelfService
    ? firstPresentCountValue(row.collection_quota, row.full_service_quota)
    : firstPresentCountValue(row.full_service_quota, row.collection_quota);
  const preferredQuotaUsed = isSelfService
    ? firstPresentCountValue(row.collection_quota_used, row.full_service_quota_used)
    : firstPresentCountValue(row.full_service_quota_used, row.collection_quota_used);

  return {
    id: odsCode,
    ods: odsCode,
    odsCode,
    name: displayName,
    displayName,
    cdb: practiceCdb,
    practiceCDB: practiceCdb,
    ehrType: sanitizeSingleLine(row.ehr_type, 80),
    serviceLevel: isSelfService ? "Self Service" : "Full Service",
    active: row.active === true,
    codingEnabled: row.coding_enabled === true,
    selfService: isSelfService,
    collectionQuota: preferredQuota,
    collectedToday: preferredQuotaUsed,
    fullServiceQuota: rowCountValue(row.full_service_quota),
    fullServiceQuotaUsed: rowCountValue(row.full_service_quota_used),
    source: "cloud-sql",
    emisApiUsername: sanitizeSingleLine(row.emis_api_username, 240),
    emisApiPassword: includeSecrets ? emisApiPassword : "",
    emisApiPasswordPresent: isPresentSecret(row.emis_api_password),
    emisWebUsername: sanitizeSingleLine(row.emis_web_username, 240),
    emisWebPassword: includeSecrets ? emisWebPassword : "",
    emisWebPasswordPresent: isPresentSecret(row.emis_web_password),
    emisWebDummyNhsNumber: sanitizeSingleLine(row.emis_web_dummy_nhs_number, 80),
    docmanUsername: sanitizeSingleLine(row.docman_username, 240),
    docmanPassword: includeSecrets ? docmanPassword : "",
    docmanPasswordPresent: isPresentSecret(row.docman_password),
    docmanDummyNhsNumber: sanitizeSingleLine(row.docman_dummy_nhs_number, 80),
    docmanInputFolder: sanitizeDocmanFolderName(row.docman_input_folder),
    docmanProcessingFolder: sanitizeDocmanFolderName(row.docman_processing_folder),
    docmanFilingFolder: sanitizeDocmanFolderName(row.docman_filing_folder),
    docmanRejectedFolder: sanitizeDocmanFolderName(row.docman_rejected_folder),
  };
}

const PRACTICE_LOOKUP_SQL = `
select
  ods_code,
  display_name,
  ehr_type,
  "active?" as active,
  coding_enabled,
  "self_service?" as self_service,
  collection_quota,
  collection_quota_used,
  full_service_quota,
  full_service_quota_used,
  ehr_settings->>'practice_cdb' as practice_cdb,
  ehr_settings->'emis_api'->>'username' as emis_api_username,
  ehr_settings->'emis_api'->>'password' as emis_api_password,
  ehr_settings->'emis_web'->>'username' as emis_web_username,
  ehr_settings->'emis_web'->>'password' as emis_web_password,
  ehr_settings->'emis_web'->>'dummy_nhs_number' as emis_web_dummy_nhs_number,
  ehr_settings->'docman'->>'username' as docman_username,
  ehr_settings->'docman'->>'password' as docman_password,
  ehr_settings->'docman'->>'dummy_nhs_number' as docman_dummy_nhs_number,
  ehr_settings->'docman'->>'input_folder' as docman_input_folder,
  ehr_settings->'docman'->>'processing_folder' as docman_processing_folder,
  ehr_settings->'docman'->>'filing_folder' as docman_filing_folder,
  ehr_settings->'docman'->>'rejected_folder' as docman_rejected_folder
from practices
where
  (
    upper(ods_code) = upper($1)
    or ehr_settings->>'practice_cdb' = $1
    or display_name ilike '%' || $1 || '%'
  )
order by
  case
    when upper(ods_code) = upper($1) then 0
    when ehr_settings->>'practice_cdb' = $1 then 1
    when display_name ilike $1 || '%' then 2
    else 3
  end,
  "active?" desc nulls last,
  display_name asc
limit $2
`;

async function lookupPracticesFromSql(query, { includeSecrets = false, limit = 12 } = {}) {
  const normalizedQuery = normalizePracticeLookupQuery(query);
  if (!normalizedQuery) {
    throw new Error("Practice lookup query is required.");
  }
  const safeLimit = Math.min(50, Math.max(1, Number.parseInt(String(limit || 12), 10) || 12));
  const result = await runSqlQuery(PRACTICE_LOOKUP_SQL, [normalizedQuery, safeLimit]);
  return result.rows.map((row) => sanitizePracticeLookupRow(row, { includeSecrets }));
}

async function lookupPracticeByOdsFromSql(odsCode, { includeSecrets = false } = {}) {
  const normalizedOds = normalizeOdsCode(odsCode);
  if (!normalizedOds) return null;
  const practices = await lookupPracticesFromSql(normalizedOds, { includeSecrets, limit: 1 });
  return practices[0] || null;
}

function sanitizeLiveCountRow(row = {}) {
  const normalizeCount = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  };

  return {
    preparing: normalizeCount(row.preparing),
    edit: normalizeCount(row.edit),
    review: normalizeCount(row.review),
    coding: normalizeCount(row.coding),
    rejected: normalizeCount(row.rejected),
    source: "cloud-sql",
  };
}

const PRACTICE_LIVE_COUNTS_SQL = `
select
  count(*) filter (
    where combined_status in (
      'patient_not_matched',
      'pending_patient_history',
      'pending_patient_identification',
      'pending_ocr',
      'pending_dyadbot',
      'uploading'
    )
  ) as preparing,
  count(*) filter (where combined_status = 'needs_annotation') as edit,
  count(*) filter (where combined_status = 'needs_review') as review,
  count(*) filter (where combined_status = 'needs_coding') as coding,
  count(*) filter (
    where combined_status in ('manual_pending', 'auto_processing')
      or rejection_processing_status in ('manual_pending', 'auto_processing')
  ) as rejected
from letter_list_items
where practice_id = $1
`;

async function lookupPracticeLiveCountsFromSql(odsCode) {
  const normalizedOds = normalizeOdsCode(odsCode);
  if (!normalizedOds) {
    throw new Error("Valid ODS code is required.");
  }
  const result = await runSqlQuery(PRACTICE_LIVE_COUNTS_SQL, [normalizedOds]);
  return sanitizeLiveCountRow(result.rows[0] || {});
}

const PRACTICE_SECRET_FIELDS = new Set([
  "emisApiPassword",
  "emisWebPassword",
  "docmanPassword",
]);

async function lookupPracticeSecretFromSql(odsCode, field) {
  const normalizedOds = normalizeOdsCode(odsCode);
  const normalizedField = sanitizeSingleLine(field, 80);
  if (!normalizedOds) {
    throw new Error("Valid ODS code is required.");
  }
  if (!PRACTICE_SECRET_FIELDS.has(normalizedField)) {
    throw new Error("Unsupported practice secret field.");
  }

  const practice = await lookupPracticeByOdsFromSql(normalizedOds, { includeSecrets: true });
  if (!practice) {
    throw new Error("Practice was not found.");
  }

  const value = sanitizeDbSecret(practice[normalizedField]);
  const presentKey = `${normalizedField}Present`;
  return {
    field: normalizedField,
    value,
    present: Boolean(practice[presentKey] || value),
  };
}

function sanitizeDocmanVerifyResultEntry(rawEntry = {}, index = 0) {
  const requestedUsername = sanitizeSingleLine(
    rawEntry?.requestedUsername
      || rawEntry?.input
      || rawEntry?.query
      || rawEntry?.username
      || "",
    120,
  );
  const docmanUsername = sanitizeSingleLine(
    rawEntry?.docmanUsername
      || rawEntry?.match
      || rawEntry?.matchedUsername
      || "",
    120,
  );
  const exists = Boolean(rawEntry?.exists);
  return {
    index: Number.isFinite(Number(rawEntry?.index)) ? Number(rawEntry.index) : index,
    requestedUsername,
    docmanUsername,
    exists,
    detail: sanitizeSingleLine(
      rawEntry?.detail
        || rawEntry?.message
        || rawEntry?.status
        || rawEntry?.reason
        || "",
      180,
    ),
    partialMatches: sanitizeStringList(rawEntry?.partialMatches, 8, 120),
    needsManualReview: Boolean(rawEntry?.needsManualReview),
  };
}

function sanitizeDocmanResultData(rawResult = null) {
  if (!rawResult || typeof rawResult !== "object") return null;
  const type = normalizeDocmanAction(rawResult.type || rawResult.action || rawResult.kind);
  if (type === "verify") {
    const results = Array.isArray(rawResult.results)
      ? rawResult.results.map((entry, index) => sanitizeDocmanVerifyResultEntry(entry, index)).slice(0, 500)
      : [];
    const exactMatches = sanitizeDocmanUsernames(
      rawResult.exactMatches
        || results.filter((entry) => entry.exists && entry.docmanUsername).map((entry) => entry.docmanUsername),
    );
    const checked = Number.isFinite(Number(rawResult.checked)) ? Number(rawResult.checked) : results.length;
    const matched = Number.isFinite(Number(rawResult.matched)) ? Number(rawResult.matched) : exactMatches.length;
    const missing = Number.isFinite(Number(rawResult.missing))
      ? Number(rawResult.missing)
      : Math.max(0, checked - matched);
    return {
      type,
      checked,
      matched,
      missing,
      clipboardCopied: Boolean(rawResult.clipboardCopied),
      exactMatches,
      results,
    };
  }

  if (type === "create-group") {
    const members = sanitizeDocmanUsernames(rawResult.members);
    return {
      type,
      groupName: sanitizeSingleLine(rawResult.groupName, 240),
      members,
      membersCount: members.length,
    };
  }

  if (type === "onboarding") {
    return {
      type,
      inputFolderName: sanitizeDocmanFolderName(rawResult.inputFolderName),
      folderCount: Number.isFinite(Number(rawResult.folderCount)) ? Number(rawResult.folderCount) : 0,
      existingCount: Number.isFinite(Number(rawResult.existingCount)) ? Number(rawResult.existingCount) : 0,
    };
  }

  if (type === "clean-processing" || type === "clean-filing") {
    const totalDocuments = Number.isFinite(Number(rawResult.totalDocuments)) ? Number(rawResult.totalDocuments) : 0;
    const matchedDocuments = Number.isFinite(Number(rawResult.matchedDocuments)) ? Number(rawResult.matchedDocuments) : 0;
    const movedDocuments = Number.isFinite(Number(rawResult.movedDocuments)) ? Number(rawResult.movedDocuments) : 0;
    const failedDocuments = Number.isFinite(Number(rawResult.failedDocuments))
      ? Number(rawResult.failedDocuments)
      : Math.max(0, matchedDocuments - movedDocuments);
    return {
      type,
      cleanType: sanitizeSingleLine(rawResult.cleanType, 80),
      outcome: sanitizeSingleLine(rawResult.outcome, 40) || "success",
      sourceFolder: sanitizeDocmanFolderName(rawResult.sourceFolder),
      destinationFolder: sanitizeDocmanFolderName(rawResult.destinationFolder),
      totalDocuments,
      matchedDocuments,
      movedDocuments,
      failedDocuments,
      errorMessage: rawResult.outcome === "failed" ? sanitizeSingleLine(rawResult.errorMessage, 400) : "",
    };
  }

  return null;
}

function normalizeEmail(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(normalized)) return "";
  return normalized;
}

function extractUuid(value) {
  const raw = sanitizeSingleLine(value, 240)
    .replace(/(?:…|\.\.\.)$/u, "")
    .trim();
  if (!raw) return "";

  const fullUuidMatch = raw.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i);
  if (fullUuidMatch) return fullUuidMatch[0].toLowerCase();

  const partialMatch = raw.match(/[0-9a-f-]{6,80}/i);
  const partial = sanitizeSingleLine(partialMatch?.[0] || "", 80)
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return /^[0-9a-f-]{6,80}$/.test(partial) ? partial : "";
}

function clampLinearPriority(value) {
  const parsed = Number.parseInt(String(value ?? "0"), 10);
  return [0, 1, 2, 3, 4].includes(parsed) ? parsed : 0;
}

function normalizeSlackTargetType(value) {
  return String(value || "").trim().toLowerCase() === "user" ? "user" : "channel";
}

function sanitizeLinearSlackPayload(rawSlack = null) {
  if (!rawSlack || typeof rawSlack !== "object") return null;
  return {
    enabled: Boolean(rawSlack.enabled),
    targetType: normalizeSlackTargetType(rawSlack.targetType),
    target: sanitizeSingleLine(rawSlack.target, 80).replace(/^[@#]/, ""),
  };
}

function sanitizeSlackNotificationResult(rawSlack = null) {
  if (!rawSlack || typeof rawSlack !== "object") return null;
  return {
    attempted: Boolean(rawSlack.attempted),
    success: Boolean(rawSlack.success),
    targetType: normalizeSlackTargetType(rawSlack.targetType),
    target: sanitizeSingleLine(rawSlack.target, 80),
    channel: sanitizeSingleLine(rawSlack.channel, 80),
    ts: sanitizeSingleLine(rawSlack.ts, 64),
    error: sanitizeSingleLine(rawSlack.error, 260),
  };
}

function getLinearDefaultPriority() {
  return clampLinearPriority(process.env.LINEAR_ISSUE_DEFAULT_PRIORITY);
}

function sanitizeLinearIssueLabelList(rawLabels = []) {
  if (!Array.isArray(rawLabels)) return [];
  const unique = new Set();
  rawLabels.forEach((label) => {
    const normalized = sanitizeSingleLine(label, 120);
    if (!normalized) return;
    unique.add(normalized);
  });
  return [...unique].slice(0, 20);
}

function ensureLinearConfig() {
  if (!LINEAR_API_KEY) {
    throw new Error("LINEAR_API_KEY is missing in MailroomNavigator/.env.");
  }
  if (!LINEAR_TEAM_KEY) {
    throw new Error("LINEAR_TEAM_KEY is missing in MailroomNavigator/.env.");
  }
}

function sanitizeLinearIssuePayload(rawPayload = {}) {
  return {
    documentId: sanitizeSingleLine(rawPayload.documentId, 32),
    failedJobId: sanitizeSingleLine(rawPayload.failedJobId, 120),
    fileSizeBytes: sanitizeSingleLine(rawPayload.fileSizeBytes, 120),
    practiceName: sanitizeSingleLine(rawPayload.practiceName, 240),
    letterAdminLink: sanitizeSingleLine(rawPayload.letterAdminLink, 1200),
    failedJobLink: sanitizeSingleLine(rawPayload.failedJobLink, 1200),
    title: sanitizeSingleLine(rawPayload.title, 240),
    description: sanitizeMultiline(rawPayload.description, 12000),
    priority: clampLinearPriority(rawPayload.priority),
    labels: sanitizeLinearIssueLabelList(rawPayload.labels),
    stateName: sanitizeSingleLine(rawPayload.stateName, 120),
    dedupeKey: sanitizeSingleLine(rawPayload.dedupeKey, 160),
    jobType: sanitizeSingleLine(rawPayload.jobType, 120),
    bulk: rawPayload.bulk === true,
    slack: sanitizeLinearSlackPayload(rawPayload?.slack),
  };
}

function isDocumentOptionalLinearIssuePayload(payload) {
  const normalizedTitle = sanitizeSingleLine(payload?.title, 240);
  const failedJobId = sanitizeSingleLine(payload?.failedJobId, 120);
  return Boolean(
    /^Bot Job Error:/i.test(normalizedTitle)
    || /^Bot Job Spike:/i.test(normalizedTitle)
    || /^Preparing stuck letters:/i.test(normalizedTitle)
    || /^Practice Support Ticket:/i.test(normalizedTitle)
    || failedJobId
  );
}

function validateLinearIssuePayload(payload) {
  if (!/^\d+$/.test(payload.documentId) && !isDocumentOptionalLinearIssuePayload(payload)) {
    throw new Error("Invalid or missing Document ID.");
  }
  if (!payload.title) {
    throw new Error("Issue title is required.");
  }
  if (!payload.description) {
    throw new Error("Issue description is required.");
  }
}

async function runLinearGraphqlRequest(query, variables = {}) {
  ensureLinearConfig();

  const response = await fetch(LINEAR_GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: LINEAR_API_KEY,
    },
    body: JSON.stringify({ query, variables }),
  });

  const rawBody = await response.text();
  let parsedBody = null;
  try {
    parsedBody = rawBody ? JSON.parse(rawBody) : null;
  } catch {
    parsedBody = null;
  }

  if (!response.ok) {
    const structuredError = Array.isArray(parsedBody?.errors)
      ? parsedBody.errors.map((err) => sanitizeSingleLine(err?.message, 220)).filter(Boolean).join("; ")
      : "";
    const bodySnippet = structuredError || sanitizeSingleLine(rawBody, 300);
    throw new Error(
      `Linear request failed with status ${response.status}${bodySnippet ? `: ${bodySnippet}` : ""}`,
    );
  }

  const payload = parsedBody && typeof parsedBody === "object" ? parsedBody : {};
  if (Array.isArray(payload?.errors) && payload.errors.length > 0) {
    const message = payload.errors
      .map((err) => sanitizeSingleLine(err?.message, 220))
      .filter(Boolean)
      .join("; ");
    throw new Error(message || "Linear returned an unknown error.");
  }

  return payload?.data || {};
}

async function resolveLinearTeam() {
  ensureLinearConfig();
  const lookup = sanitizeSingleLine(LINEAR_TEAM_KEY, 120);
  if (
    resolvedLinearTeam?.id
    && (resolvedLinearTeam.id === lookup || resolvedLinearTeam.key?.toUpperCase() === lookup.toUpperCase())
  ) {
    return resolvedLinearTeam;
  }

  let team = null;
  let discoveredTeams = [];

  // First try direct lookup as team id (works when LINEAR_TEAM_KEY is actually the team UUID/id).
  try {
    const teamByIdQuery = `
      query ResolveTeamById($id: String!) {
        team(id: $id) {
          id
          key
          name
        }
      }
    `;
    const idData = await runLinearGraphqlRequest(teamByIdQuery, { id: lookup });
    team = idData?.team || null;
  } catch {
    // Keep going; some environments may restrict this path.
  }

  // If direct id lookup did not match, list teams and resolve by short key/id/name.
  if (!team?.id) {
    const listTeamsQueries = [
      {
        query: `
          query ListTeamsWithFirst($first: Int!) {
            teams(first: $first) {
              nodes {
                id
                key
                name
              }
            }
          }
        `,
        variables: { first: 250 }
      },
      {
        query: `
          query ListTeams {
            teams {
              nodes {
                id
                key
                name
              }
            }
          }
        `,
        variables: {}
      }
    ];

    for (const entry of listTeamsQueries) {
      try {
        const listData = await runLinearGraphqlRequest(entry.query, entry.variables);
        const teamsRoot = listData?.teams;
        const nodes = Array.isArray(teamsRoot?.nodes)
          ? teamsRoot.nodes
          : Array.isArray(teamsRoot?.edges)
            ? teamsRoot.edges.map((edge) => edge?.node).filter(Boolean)
            : [];
        if (nodes.length > 0) {
          discoveredTeams = nodes;
          break;
        }
      } catch {
        // Try next variant.
      }
    }

    if (discoveredTeams.length > 0) {
      const lookupUpper = lookup.toUpperCase();
      const lookupLower = lookup.toLowerCase();
      team = discoveredTeams.find((item) => sanitizeSingleLine(item?.id, 64) === lookup)
        || discoveredTeams.find((item) => sanitizeSingleLine(item?.key, 32).toUpperCase() === lookupUpper)
        || discoveredTeams.find((item) => sanitizeSingleLine(item?.name, 120).toLowerCase() === lookupLower)
        || null;
    }
  }

  if (!team?.id) {
    const availableKeys = discoveredTeams
      .map((item) => sanitizeSingleLine(item?.key, 32))
      .filter(Boolean)
      .slice(0, 12)
      .join(", ");
    throw new Error(
      `Linear team "${lookup}" was not found.${availableKeys ? ` Available team keys: ${availableKeys}.` : ""}`,
    );
  }

  resolvedLinearTeam = {
    id: sanitizeSingleLine(team.id, 64),
    key: sanitizeSingleLine(team.key, 32),
    name: sanitizeSingleLine(team.name, 120),
  };
  return resolvedLinearTeam;
}

async function resolveLinearWorkflowStateId(teamId, rawStateName) {
  const stateName = sanitizeSingleLine(rawStateName, 120);
  if (!teamId || !stateName) return "";

  const cacheKey = `${teamId}:${stateName.toLowerCase()}`;
  if (resolvedLinearStateIdCache.has(cacheKey)) {
    return resolvedLinearStateIdCache.get(cacheKey) || "";
  }

  try {
    if (!resolvedLinearWorkflowStateCatalog) {
      const query = `
        query workflowStates($first: Int) {
          workflowStates(first: $first) {
            nodes {
              id
              name
              team {
                id
              }
            }
          }
        }
      `;
      const data = await runLinearGraphqlRequest(query, { first: 250 });
      resolvedLinearWorkflowStateCatalog = Array.isArray(data?.workflowStates?.nodes)
        ? data.workflowStates.nodes
        : [];
    }
    const nodes = Array.isArray(resolvedLinearWorkflowStateCatalog) ? resolvedLinearWorkflowStateCatalog : [];
    const match = nodes.find((node) =>
      sanitizeSingleLine(node?.team?.id, 64) === teamId
      && sanitizeSingleLine(node?.name, 120).toLowerCase() === stateName.toLowerCase()
    );
    const stateId = sanitizeSingleLine(match?.id, 64);
    if (!stateId) {
      await appendServerLog(
        `[${nowIso()}] linear workflow state missing for "${stateName}" on team ${teamId}`
      ).catch(() => undefined);
    }
    resolvedLinearStateIdCache.set(cacheKey, stateId);
    return stateId;
  } catch (error) {
    await appendServerLog(
      `[${nowIso()}] linear workflow state resolve failed for "${stateName}": ${sanitizeSingleLine(error?.message || error, 260)}`
    ).catch(() => undefined);
    resolvedLinearStateIdCache.set(cacheKey, "");
    return "";
  }
}

async function resolveLinearLabelIds(labelNames = []) {
  const uniqueNames = sanitizeLinearIssueLabelList(labelNames);
  if (!uniqueNames.length) return [];

  const resolvedIds = [];
  if (!resolvedLinearIssueLabelCatalog) {
    const query = `
      query issueLabels($first: Int) {
        issueLabels(first: $first) {
          nodes {
            id
            name
          }
        }
      }
    `;
    try {
      const data = await runLinearGraphqlRequest(query, { first: 250 });
      resolvedLinearIssueLabelCatalog = Array.isArray(data?.issueLabels?.nodes)
        ? data.issueLabels.nodes
        : [];
    } catch (error) {
      await appendServerLog(
        `[${nowIso()}] linear label catalog load failed: ${sanitizeSingleLine(error?.message || error, 260)}`
      ).catch(() => undefined);
      resolvedLinearIssueLabelCatalog = [];
    }
  }

  for (const labelName of uniqueNames) {
    const cacheKey = labelName.toLowerCase();
    if (resolvedLinearLabelIdCache.has(cacheKey)) {
      const cachedId = resolvedLinearLabelIdCache.get(cacheKey);
      if (cachedId) resolvedIds.push(cachedId);
      continue;
    }

    try {
      const nodes = Array.isArray(resolvedLinearIssueLabelCatalog) ? resolvedLinearIssueLabelCatalog : [];
      const exactMatch = nodes.find((node) =>
        sanitizeSingleLine(node?.name, 120).toLowerCase() === labelName.toLowerCase()
      );
      const labelId = sanitizeSingleLine(exactMatch?.id, 64);
      if (!labelId) {
        await appendServerLog(
          `[${nowIso()}] linear label missing for "${labelName}"`
        ).catch(() => undefined);
      }
      resolvedLinearLabelIdCache.set(cacheKey, labelId);
      if (labelId) resolvedIds.push(labelId);
    } catch (error) {
      await appendServerLog(
        `[${nowIso()}] linear label resolve failed for "${labelName}": ${sanitizeSingleLine(error?.message || error, 260)}`
      ).catch(() => undefined);
      resolvedLinearLabelIdCache.set(cacheKey, "");
    }
  }

  return resolvedIds;
}

const LINEAR_ISSUE_DEDUPE_MARKER_PREFIX = "BOT_JOBS_DEDUPE:";
const BOT_JOB_TITLE_PREFIX = "Bot Job Error:";
const BOT_JOB_SPIKE_TITLE_PREFIX = "Bot Job Spike:";
const PRACTICE_SUPPORT_TITLE_PREFIX = "Practice Support Ticket:";
const MAILROOM_REJECTED_TITLE_PREFIX = "Mailroom Rejected:";

// New issues created via the bulk "Create Issue" action (payload.bulk) or as
// a combined Bot Job Spike issue - not reopened duplicates, and not issues
// created one at a time via a single-row button - get auto-assigned between
// these two on a running 60/40 split. See pickNextBotJobBulkAssignee.
const BOT_JOB_BULK_ASSIGNEES = [
  { id: "08fbc9ef-b958-406b-b7be-fb956452f18b", name: "Nur Siddique", weight: 60 },
  { id: "f2e5964e-f773-40e5-aada-5d05ea6d885e", name: "Abby Buckley", weight: 40 },
];
const BOT_JOB_BULK_ASSIGNMENT_STATE_PATH = join(STATE_DIR, "bot-job-bulk-assignment-state.json");

async function readBotJobBulkAssignmentState() {
  const current = {};
  for (const candidate of BOT_JOB_BULK_ASSIGNEES) current[candidate.id] = 0;

  try {
    const raw = await readFile(BOT_JOB_BULK_ASSIGNMENT_STATE_PATH, "utf8");
    const parsed = raw.trim() ? JSON.parse(raw) : {};
    for (const candidate of BOT_JOB_BULK_ASSIGNEES) {
      const stored = Number(parsed?.current?.[candidate.id]);
      if (Number.isFinite(stored)) current[candidate.id] = stored;
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      await appendServerLog(
        `[${nowIso()}] bot job spike assignment state read failed, restarting from even split: ${sanitizeSingleLine(error?.message, 200)}`,
      ).catch(() => undefined);
    }
  }

  return { current };
}

async function writeBotJobBulkAssignmentState(state) {
  await mkdir(dirname(BOT_JOB_BULK_ASSIGNMENT_STATE_PATH), { recursive: true });
  await writeFile(
    BOT_JOB_BULK_ASSIGNMENT_STATE_PATH,
    `${JSON.stringify(state, null, 2)}\n`,
    "utf8",
  );
}

// Smooth weighted round-robin (the same algorithm nginx uses for weighted
// load balancing): each candidate's running "current" value increases by its
// own weight every pick, the highest current wins, and the winner's current
// then drops by the total weight. This converges on the exact target ratio
// over time instead of drifting the way an independent random 60/40 coin
// flip per issue would (a short run of spikes could otherwise land on the
// same person several times in a row purely by chance).
async function pickNextBotJobBulkAssignee() {
  const totalWeight = BOT_JOB_BULK_ASSIGNEES.reduce((sum, candidate) => sum + candidate.weight, 0);
  const state = await readBotJobBulkAssignmentState();
  const current = { ...state.current };

  for (const candidate of BOT_JOB_BULK_ASSIGNEES) {
    current[candidate.id] = (Number(current[candidate.id]) || 0) + candidate.weight;
  }

  let winner = BOT_JOB_BULK_ASSIGNEES[0];
  for (const candidate of BOT_JOB_BULK_ASSIGNEES) {
    if ((current[candidate.id] || 0) > (current[winner.id] || 0)) winner = candidate;
  }

  current[winner.id] = (current[winner.id] || 0) - totalWeight;

  await writeBotJobBulkAssignmentState({ current }).catch((error) => {
    // Non-fatal: worst case the next pick recomputes from a stale/reset
    // state and briefly drifts from the exact 60/40 target, rather than
    // blocking issue creation over a state-file write failure.
    appendServerLog(
      `[${nowIso()}] bot job spike assignment state write failed: ${sanitizeSingleLine(error?.message, 200)}`,
    ).catch(() => undefined);
  });

  return winner;
}

function normalizeIssueText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeIssueLookupKey(value) {
  return sanitizeSingleLine(value, 240).toLowerCase();
}

function normalizeIssueDocumentId(value) {
  const match = String(value || "").match(/\d+/);
  return match?.[0] || "";
}

function escapeRegex(text) {
  return String(text || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractIssueStructuredField(text, label) {
  const pattern = new RegExp(`(?:^|\\n)\\s*[-*]?\\s*${escapeRegex(label)}\\s*:\\s*([^\\n]+)`, "i");
  const match = String(text || "").match(pattern);
  return normalizeIssueText(match?.[1] || "");
}

function inferRejectedQueueKey(text) {
  const normalized = normalizeIssueText(text).toLowerCase();
  if (!normalized) return "";
  if (normalized.includes("service=self") || normalized.includes("queue: practice") || normalized.includes("processed by practice")) {
    return "practice";
  }
  if (
    normalized.includes("service=full")
    || normalized.includes("queue: betterletter")
    || normalized.includes("betterletter's rejected queue")
    || normalized.includes("betterletter rejected queue")
  ) {
    return "betterletter";
  }
  return "";
}

function buildLinearIssueDedupeMarker(dedupeKey) {
  const normalized = sanitizeSingleLine(dedupeKey, 160);
  return normalized ? `${LINEAR_ISSUE_DEDUPE_MARKER_PREFIX}${normalized}` : "";
}

function extractPracticeSupportSignatureFromPayload(payload = {}) {
  const dedupeKey = sanitizeSingleLine(payload?.dedupeKey, 160);
  const dedupeMatch = dedupeKey.match(/^practice_support_ticket\|([^|]+)\|(practice|betterletter)$/i);
  if (dedupeMatch?.[1] && dedupeMatch?.[2]) {
    return {
      practiceKey: normalizeIssueLookupKey(dedupeMatch[1]),
      queueKey: dedupeMatch[2].toLowerCase(),
    };
  }

  const description = String(payload?.description || "");
  const title = sanitizeSingleLine(payload?.title, 240);
  const practiceCode = extractIssueStructuredField(description, "Practice Code");
  const practiceName = normalizeIssueText(title.replace(/^Practice Support Ticket:/i, "").split("|")[0] || payload?.practiceName || "");
  const queueKey = inferRejectedQueueKey(`${title}\n${description}`);
  const practiceKey = normalizeIssueLookupKey(practiceCode || practiceName);
  if (!practiceKey || !queueKey) return null;
  return { practiceKey, queueKey };
}

function extractPracticeSupportSignatureFromIssue(issue = {}) {
  const title = sanitizeSingleLine(issue?.title, 240);
  const description = String(issue?.description || "");
  const combined = `${title}\n${description}`;
  if (!/^Practice Support Ticket:/i.test(title) && !/Rejected letters needing processing:/i.test(combined)) {
    return null;
  }

  const practiceCode = extractIssueStructuredField(description, "Practice Code");
  const practiceName = normalizeIssueText(title.replace(/^Practice Support Ticket:/i, "").split("|")[0]);
  const queueKey = inferRejectedQueueKey(combined);
  const practiceKey = normalizeIssueLookupKey(practiceCode || practiceName);
  if (!practiceKey || !queueKey) return null;
  return { practiceKey, queueKey };
}

function extractMailroomRejectedDocumentIdFromIssue(issue = {}) {
  const title = sanitizeSingleLine(issue?.title, 240);
  const description = String(issue?.description || "");
  if (!/^Mailroom Rejected:/i.test(title) && !/Document ID:/i.test(description)) {
    return "";
  }
  return normalizeIssueDocumentId(
    extractIssueStructuredField(description, "Document ID")
    || title.replace(/^Mailroom Rejected:/i, "")
  );
}

function extractBotJobTypeFromIssueText(text) {
  const structured = extractIssueStructuredField(text, "Job Type");
  if (structured) return normalizeIssueLookupKey(structured);

  const match = normalizeIssueText(text).match(/\b(docman_[a-z_]+|emis_[a-z_]+|generate_output)\b/i);
  return normalizeIssueLookupKey(match?.[1] || "");
}

function extractBotJobIdFromIssue(issue = {}) {
  const title = sanitizeSingleLine(issue?.title, 240);
  const description = String(issue?.description || "");
  if (!title.toLowerCase().startsWith(BOT_JOB_TITLE_PREFIX.toLowerCase())) return "";
  const structured = extractIssueStructuredField(description, "Job ID");
  if (!structured || /^n\/?a$/i.test(structured)) return "";
  return normalizeIssueLookupKey(structured);
}

function normalizeIssueListField(value) {
  return String(value || "")
    .split(",")
    .map((part) => normalizeIssueLookupKey(part))
    .filter(Boolean)
    .sort();
}

function arraysMatchExactly(left = [], right = []) {
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function extractBotJobSpikeSignatureFromText(title = "", description = "") {
  const normalizedTitle = sanitizeSingleLine(title, 240);
  if (!normalizedTitle.toLowerCase().startsWith(BOT_JOB_SPIKE_TITLE_PREFIX.toLowerCase())) return null;

  const combined = `${normalizedTitle}\n${String(description || "")}`;
  const rowCountFromTitle = normalizedTitle.match(/\|\s*(\d+)\s+jobs?\s*\|/i)?.[1] || "";
  const rowCountFromDescription = extractIssueStructuredField(description, "Visible rows on this page").match(/\d+/)?.[0] || "";
  const documentIds = [...new Set(
    Array.from(combined.matchAll(/\bdoc\s+(\d{4,})\b/gi))
      .map((match) => normalizeIssueDocumentId(match?.[1] || ""))
      .filter(Boolean)
  )].sort();
  const jobIds = [...new Set(
    Array.from(combined.matchAll(/\bjob\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gi))
      .map((match) => normalizeIssueLookupKey(match?.[1] || ""))
      .filter(Boolean)
  )].sort();

  return {
    title: normalizeIssueLookupKey(normalizedTitle),
    rowCount: rowCountFromDescription || rowCountFromTitle || "",
    jobTypes: normalizeIssueListField(extractIssueStructuredField(description, "Job types")),
    practices: normalizeIssueListField(extractIssueStructuredField(description, "Practices")),
    documentIds,
    jobIds,
  };
}

function botJobSpikeSignaturesMatch(candidateSignature, payloadSignature) {
  if (!candidateSignature || !payloadSignature) return false;

  const jobTypesMatch = Boolean(candidateSignature.jobTypes.length)
    && Boolean(payloadSignature.jobTypes.length)
    && arraysMatchExactly(candidateSignature.jobTypes, payloadSignature.jobTypes);
  const practicesMatch = Boolean(candidateSignature.practices.length)
    && Boolean(payloadSignature.practices.length)
    && arraysMatchExactly(candidateSignature.practices, payloadSignature.practices);

  if (!jobTypesMatch || !practicesMatch) return false;

  if (
    candidateSignature.documentIds.length
    && payloadSignature.documentIds.length
    && arraysMatchExactly(candidateSignature.documentIds, payloadSignature.documentIds)
  ) {
    return true;
  }

  if (
    candidateSignature.jobIds.length
    && payloadSignature.jobIds.length
    && arraysMatchExactly(candidateSignature.jobIds, payloadSignature.jobIds)
  ) {
    return true;
  }

  return false;
}

function isLinearIssueDuplicate(candidate, payload, dedupeMarker, practiceSupportSignature, payloadDocumentId) {
  if (!candidate?.id) return false;

  const candidateTitle = sanitizeSingleLine(candidate.title, 240);
  const candidateDescription = String(candidate.description || "");
  const normalizedCandidateTitle = candidateTitle.toLowerCase();
  const normalizedPayloadTitle = sanitizeSingleLine(payload?.title, 240).toLowerCase();
  const payloadIsMailroomRejected = normalizedPayloadTitle.startsWith(MAILROOM_REJECTED_TITLE_PREFIX.toLowerCase());
  const payloadIsBotJob = normalizedPayloadTitle.startsWith(BOT_JOB_TITLE_PREFIX.toLowerCase());
  const payloadIsBotJobSpike = normalizedPayloadTitle.startsWith(BOT_JOB_SPIKE_TITLE_PREFIX.toLowerCase());
  const candidateIsBotJob = normalizedCandidateTitle.startsWith(BOT_JOB_TITLE_PREFIX.toLowerCase());
  const candidateIsBotJobSpike = normalizedCandidateTitle.startsWith(BOT_JOB_SPIKE_TITLE_PREFIX.toLowerCase());

  if (dedupeMarker && candidateDescription.includes(dedupeMarker)) {
    return true;
  }

  if (
    normalizedPayloadTitle
    && normalizedCandidateTitle === normalizedPayloadTitle
    && !payloadIsBotJob
    && !payloadIsBotJobSpike
  ) {
    return true;
  }

  if (payloadIsMailroomRejected && payloadDocumentId) {
    const candidateDocumentId = extractMailroomRejectedDocumentIdFromIssue(candidate)
      || normalizeIssueDocumentId(extractIssueStructuredField(candidateDescription, "Document ID"));
    if (candidateDocumentId && candidateDocumentId === payloadDocumentId) {
      return true;
    }
  }

  if (payloadIsBotJob && candidateIsBotJob) {
    const payloadFailedJobId = normalizeIssueLookupKey(payload?.failedJobId);
    if (payloadFailedJobId) {
      const candidateJobId = extractBotJobIdFromIssue(candidate);
      if (candidateJobId && candidateJobId === payloadFailedJobId) {
        return true;
      }
    }
  }

  if (payloadIsBotJob && candidateIsBotJob && payloadDocumentId) {
    const candidateDocumentId = normalizeIssueDocumentId(
      extractIssueStructuredField(candidateDescription, "Document ID")
      || candidateTitle
    );
    if (candidateDocumentId && candidateDocumentId === payloadDocumentId) {
      return true;
    }
  }

  if (payloadIsBotJobSpike && candidateIsBotJobSpike) {
    const payloadSpikeSignature = extractBotJobSpikeSignatureFromText(payload?.title, payload?.description);
    const candidateSpikeSignature = extractBotJobSpikeSignatureFromText(candidateTitle, candidateDescription);
    if (botJobSpikeSignaturesMatch(candidateSpikeSignature, payloadSpikeSignature)) {
      return true;
    }
  }

  if (payloadIsBotJob && candidateIsBotJobSpike) {
    const candidateSpikeSignature = extractBotJobSpikeSignatureFromText(candidateTitle, candidateDescription);
    if (candidateSpikeSignature) {
      const payloadJobType = normalizeIssueLookupKey(payload?.jobType)
        || normalizeIssueLookupKey(extractIssueStructuredField(payload?.description, "Job Type"));
      const payloadPractice = normalizeIssueLookupKey(payload?.practiceName)
        || normalizeIssueLookupKey(extractIssueStructuredField(payload?.description, "Practice"));
      const payloadFailedJobId = normalizeIssueLookupKey(payload?.failedJobId);
      const jobTypeMatches = Boolean(payloadJobType) && candidateSpikeSignature.jobTypes.includes(payloadJobType);
      const practiceMatches = Boolean(payloadPractice) && candidateSpikeSignature.practices.includes(payloadPractice);
      const documentCovered = Boolean(payloadDocumentId) && candidateSpikeSignature.documentIds.includes(payloadDocumentId);
      const jobCovered = Boolean(payloadFailedJobId) && candidateSpikeSignature.jobIds.includes(payloadFailedJobId);
      if ((documentCovered || jobCovered) && jobTypeMatches && practiceMatches) {
        return true;
      }
    }
  }

  if (practiceSupportSignature) {
    const candidateSignature = extractPracticeSupportSignatureFromIssue(candidate);
    if (
      candidateSignature
      && candidateSignature.practiceKey === practiceSupportSignature.practiceKey
      && candidateSignature.queueKey === practiceSupportSignature.queueKey
    ) {
      return true;
    }
  }

  return false;
}

async function findExistingLinearIssue(payload, team) {
  const dedupeMarker = buildLinearIssueDedupeMarker(payload?.dedupeKey);
  const practiceSupportSignature = extractPracticeSupportSignatureFromPayload(payload);
  const payloadDocumentId = normalizeIssueDocumentId(payload?.documentId);
  const normalizedTitle = sanitizeSingleLine(payload?.title, 240);

  if (!dedupeMarker && !practiceSupportSignature && !payloadDocumentId && !normalizedTitle) {
    return null;
  }

  const shapeMatch = (match) => ({
    id: sanitizeSingleLine(match.id, 64),
    identifier: sanitizeSingleLine(match.identifier, 64),
    title: sanitizeSingleLine(match.title, 240),
    url: sanitizeSingleLine(match.url, 1200),
    priority: 0,
    state: {
      id: sanitizeSingleLine(match?.state?.id, 64),
      name: sanitizeSingleLine(match?.state?.name, 120),
      type: sanitizeSingleLine(match?.state?.type, 64),
    },
  });

  const normalizedPayloadTitleLower = normalizedTitle.toLowerCase();
  const payloadIsBotJobForSearch = normalizedPayloadTitleLower.startsWith(BOT_JOB_TITLE_PREFIX.toLowerCase());
  const payloadIsBotJobSpikeForSearch = normalizedPayloadTitleLower.startsWith(BOT_JOB_SPIKE_TITLE_PREFIX.toLowerCase());

  // Bot job / bot job spike issues always embed their document id and job id as literal
  // text in the title or description (structured fields, "doc 123" / "job <uuid>" sample
  // lines, and the hidden dedupe marker all include the raw value). So any real duplicate
  // must contain that literal text somewhere - searching Linear directly for it instead of
  // paging through the entire team backlog is safe and much faster.
  if (payloadIsBotJobForSearch || payloadIsBotJobSpikeForSearch) {
    const identifierCandidates = [...new Set([
      payloadDocumentId,
      normalizeIssueLookupKey(payload?.failedJobId),
    ].filter(Boolean))];

    if (identifierCandidates.length > 0) {
      const targetedQuery = `
        query FindBotJobDuplicateByIdentifier($teamKey: String!, $value: String!, $first: Int!, $after: String) {
          issues(
            first: $first
            after: $after
            filter: {
              team: { key: { eq: $teamKey } }
              or: [
                { description: { contains: $value } }
                { title: { contains: $value } }
              ]
            }
          ) {
            nodes {
              id
              identifier
              title
              url
              description
              createdAt
              updatedAt
              state {
                id
                name
                type
              }
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      `;

      for (const identifierValue of identifierCandidates) {
        const seenIssueIds = new Set();
        let after = null;
        for (let page = 0; page < 5; page += 1) {
          const data = await runLinearGraphqlRequest(targetedQuery, {
            teamKey: team.key,
            value: identifierValue,
            first: 50,
            after,
          });
          const issuesRoot = data?.issues;
          const nodes = Array.isArray(issuesRoot?.nodes) ? issuesRoot.nodes : [];
          const match = nodes.find((candidate) => {
            if (!candidate?.id || seenIssueIds.has(candidate.id)) return false;
            seenIssueIds.add(candidate.id);
            return isLinearIssueDuplicate(candidate, payload, dedupeMarker, practiceSupportSignature, payloadDocumentId);
          });
          if (match?.id) return shapeMatch(match);

          const pageInfo = issuesRoot?.pageInfo;
          if (!pageInfo?.hasNextPage || !sanitizeSingleLine(pageInfo?.endCursor, 240)) break;
          after = sanitizeSingleLine(pageInfo.endCursor, 240);
        }
      }

      return null;
    }
  }

  const buildQuery = (stateFilterBlock = "") => `
    query FindPotentialDuplicateIssues($teamKey: String!, $first: Int!, $after: String) {
      issues(
        first: $first
        after: $after
        filter: {
          team: { key: { eq: $teamKey } }
          ${stateFilterBlock}
        }
      ) {
        nodes {
          id
          identifier
          title
          url
          description
          createdAt
          updatedAt
          state {
            id
            name
            type
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  `;

  const searchScopes = [
    {
      name: "active",
      stateFilterBlock: 'state: { type: { nin: ["completed", "canceled"] } }',
      maxPages: 8,
    },
    {
      name: "all_states",
      stateFilterBlock: "",
      maxPages: 16,
    },
  ];
  const seenIssueIds = new Set();

  for (const scope of searchScopes) {
    let after = null;
    const query = buildQuery(scope.stateFilterBlock);
    for (let page = 0; page < scope.maxPages; page += 1) {
      const data = await runLinearGraphqlRequest(query, {
        teamKey: team.key,
        first: 100,
        after,
      });
      const issuesRoot = data?.issues;
      const nodes = Array.isArray(issuesRoot?.nodes) ? issuesRoot.nodes : [];
      const match = nodes.find((candidate) => {
        if (!candidate?.id || seenIssueIds.has(candidate.id)) return false;
        seenIssueIds.add(candidate.id);
        return isLinearIssueDuplicate(candidate, payload, dedupeMarker, practiceSupportSignature, payloadDocumentId);
      });
      if (match?.id) {
        return shapeMatch(match);
      }

      const pageInfo = issuesRoot?.pageInfo;
      if (!pageInfo?.hasNextPage || !sanitizeSingleLine(pageInfo?.endCursor, 240)) {
        break;
      }
      after = sanitizeSingleLine(pageInfo.endCursor, 240);
    }
  }

  return null;
}

function toPublicLinearIssue(issue = {}) {
  return {
    identifier: sanitizeSingleLine(issue?.identifier, 64),
    title: sanitizeSingleLine(issue?.title, 240),
    url: sanitizeSingleLine(issue?.url, 1200),
    priority: clampLinearPriority(issue?.priority),
    state: issue?.state
      ? {
          name: sanitizeSingleLine(issue.state.name, 120),
          type: sanitizeSingleLine(issue.state.type, 64),
        }
      : undefined,
  };
}

async function moveExistingLinearIssueToReopenState(issue, team) {
  const issueId = sanitizeSingleLine(issue?.id, 64);
  const stateName = sanitizeSingleLine(LINEAR_DUPLICATE_REOPEN_STATE_NAME, 120);
  const fallbackIssue = toPublicLinearIssue(issue);

  if (!issueId || !team?.id || !stateName) {
    return {
      issue: fallbackIssue,
      reopened: false,
      reopenStateName: stateName,
      reopenSkipped: "missing_issue_or_state",
    };
  }

  const currentStateName = sanitizeSingleLine(issue?.state?.name, 120);
  if (currentStateName && currentStateName.toLowerCase() === stateName.toLowerCase()) {
    return {
      issue: fallbackIssue,
      reopened: false,
      reopenStateName: stateName,
      reopenSkipped: "already_in_state",
    };
  }

  const stateId = await resolveLinearWorkflowStateId(team.id, stateName);
  if (!stateId) {
    const message = `Linear workflow state "${stateName}" was not found.`;
    await appendServerLog(
      `[${nowIso()}] linear duplicate reopen skipped ${issue?.identifier || issueId}: ${message}`
    ).catch(() => undefined);
    return {
      issue: fallbackIssue,
      reopened: false,
      reopenStateName: stateName,
      reopenError: message,
    };
  }

  try {
    const mutation = `
      mutation ReopenDuplicateIssue($id: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) {
          success
          issue {
            id
            identifier
            title
            url
            priority
            state {
              id
              name
              type
            }
          }
        }
      }
    `;
    const data = await runLinearGraphqlRequest(mutation, {
      id: issueId,
      input: {
        stateId,
      },
    });
    const issueUpdate = data?.issueUpdate;
    const updatedIssue = issueUpdate?.issue;
    if (!issueUpdate?.success || !updatedIssue?.identifier || !updatedIssue?.url) {
      throw new Error("Linear issue update did not return a successful issue.");
    }

    return {
      issue: toPublicLinearIssue(updatedIssue),
      reopened: true,
      reopenStateName: stateName,
    };
  } catch (error) {
    const message = sanitizeSingleLine(error?.message || error, 260) || "Could not move issue to reopen state.";
    await appendServerLog(
      `[${nowIso()}] linear duplicate reopen failed ${issue?.identifier || issueId}: ${message}`
    ).catch(() => undefined);
    return {
      issue: fallbackIssue,
      reopened: false,
      reopenStateName: stateName,
      reopenError: message,
    };
  }
}

async function createLinearIssue(payload) {
  const team = await resolveLinearTeam();
  const duplicateIssue = await findExistingLinearIssue(payload, team);
  if (duplicateIssue?.identifier && duplicateIssue?.url) {
    const normalizedPayloadTitle = sanitizeSingleLine(payload?.title, 240).toLowerCase();
    const payloadIsBotJob = normalizedPayloadTitle.startsWith(BOT_JOB_TITLE_PREFIX.toLowerCase());
    const duplicateIsBotJobSpike = sanitizeSingleLine(duplicateIssue?.title, 240)
      .toLowerCase()
      .startsWith(BOT_JOB_SPIKE_TITLE_PREFIX.toLowerCase());
    if (payloadIsBotJob && duplicateIsBotJobSpike) {
      return {
        team,
        issue: toPublicLinearIssue(duplicateIssue),
        duplicate: true,
        reopened: false,
        reopenStateName: LINEAR_DUPLICATE_REOPEN_STATE_NAME,
        reopenSkipped: "covered_by_bot_job_spike",
      };
    }

    // Only pull a duplicate back into review when it was actually marked
    // done - the underlying document/job showing up again means a "done"
    // issue was closed prematurely. An issue already sitting in Triage,
    // Backlog, Todo, In Progress (or any other non-completed state,
    // including Canceled) is already being tracked appropriately; forcing
    // it into In Review would just disrupt whatever's already happening
    // with it instead of reflecting anything new.
    const duplicateStateType = sanitizeSingleLine(duplicateIssue?.state?.type, 64).toLowerCase();
    if (duplicateStateType !== "completed") {
      return {
        team,
        issue: toPublicLinearIssue(duplicateIssue),
        duplicate: true,
        reopened: false,
        reopenStateName: LINEAR_DUPLICATE_REOPEN_STATE_NAME,
        reopenSkipped: duplicateStateType ? `already_active_${duplicateStateType}` : "unknown_state",
      };
    }

    const reopenResult = await moveExistingLinearIssueToReopenState(duplicateIssue, team);
    return {
      team,
      issue: reopenResult.issue,
      duplicate: true,
      reopened: Boolean(reopenResult.reopened),
      reopenStateName: reopenResult.reopenStateName || LINEAR_DUPLICATE_REOPEN_STATE_NAME,
      reopenError: reopenResult.reopenError || "",
      reopenSkipped: reopenResult.reopenSkipped || "",
    };
  }

  const effectivePriority = payload.priority > 0 ? payload.priority : getLinearDefaultPriority();

  const issueInput = {
    teamId: team.id,
    title: payload.title,
  };
  if (payload.description) issueInput.description = payload.description;
  if (effectivePriority > 0) issueInput.priority = effectivePriority;
  if (payload.stateName) {
    const stateId = await resolveLinearWorkflowStateId(team.id, payload.stateName);
    if (stateId) issueInput.stateId = stateId;
  }
  if (Array.isArray(payload.labels) && payload.labels.length > 0) {
    const labelIds = await resolveLinearLabelIds(payload.labels);
    if (labelIds.length > 0) issueInput.labelIds = labelIds;
  }
  const isBulkCreatedIssue = payload?.bulk === true
    || sanitizeSingleLine(payload?.title, 240).toLowerCase().startsWith(BOT_JOB_SPIKE_TITLE_PREFIX.toLowerCase());
  if (isBulkCreatedIssue) {
    const assignee = await pickNextBotJobBulkAssignee().catch(() => null);
    if (assignee?.id) {
      issueInput.assigneeId = assignee.id;
    }
  }

  const mutation = `
    mutation CreateIssue($input: IssueCreateInput!) {
      issueCreate(input: $input) {
        success
        issue {
          id
          identifier
          title
          url
          priority
        }
      }
    }
  `;

  const data = await runLinearGraphqlRequest(mutation, { input: issueInput });
  const issueCreate = data?.issueCreate;
  const issue = issueCreate?.issue;
  if (!issueCreate?.success || !issue?.id || !issue?.identifier || !issue?.url) {
    throw new Error("Linear issue creation failed.");
  }

  return {
    team,
    issue: {
      identifier: sanitizeSingleLine(issue.identifier, 64),
      title: sanitizeSingleLine(issue.title, 240),
      url: sanitizeSingleLine(issue.url, 1200),
      priority: clampLinearPriority(issue.priority),
    },
    duplicate: false,
  };
}

async function runSlackApiRequest(method, body = {}) {
  if (!SLACK_BOT_TOKEN) {
    throw new Error("SLACK_BOT_TOKEN is missing in MailroomNavigator/.env.");
  }

  const endpoint = `${SLACK_API_BASE_URL}/${String(method || "").replace(/^\/+/, "")}`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
    },
    body: JSON.stringify(body),
  });

  const rawBody = await response.text();
  let parsedBody = null;
  try {
    parsedBody = rawBody ? JSON.parse(rawBody) : null;
  } catch {
    parsedBody = null;
  }

  if (!response.ok) {
    const bodySnippet = sanitizeSingleLine(parsedBody?.error || rawBody, 300);
    throw new Error(
      `Slack request failed with status ${response.status}${bodySnippet ? `: ${bodySnippet}` : ""}`,
    );
  }

  const payload = parsedBody && typeof parsedBody === "object" ? parsedBody : {};
  if (!payload.ok) {
    throw new Error(sanitizeSingleLine(payload?.error, 220) || "Slack returned an unknown error.");
  }

  return payload;
}

function getCachedUuidLookup(uuid) {
  const normalizedUuid = extractUuid(uuid);
  if (!normalizedUuid) return null;
  const cached = uuidLookupCache.get(normalizedUuid);
  if (!cached) return null;
  if ((Date.now() - Number(cached.cachedAt || 0)) > UUID_LOOKUP_CACHE_TTL_MS) {
    uuidLookupCache.delete(normalizedUuid);
    return null;
  }
  return cached.result || null;
}

function rememberUuidLookup(uuid, result) {
  const normalizedUuid = extractUuid(uuid);
  if (!normalizedUuid || !result || typeof result !== "object") return;
  uuidLookupCache.set(normalizedUuid, {
    cachedAt: Date.now(),
    result,
  });
}

function sanitizeUuidLookupRow(row = {}) {
  return {
    documentId: sanitizeSingleLine(row.document_id, 80),
    matchedUuid: sanitizeSingleLine(row.matched_uuid, 160),
    inputFileName: sanitizeSingleLine(row.input_file_name, 260),
    status: sanitizeSingleLine(row.document_status, 120),
    documentLink: sanitizeHttpUrl(row.document_link),
    botJobId: sanitizeSingleLine(row.bot_job_id, 120),
    botJobType: sanitizeSingleLine(row.bot_job_type, 120),
    botJobStatus: sanitizeSingleLine(row.bot_job_status, 120),
    botJobStatusReason: sanitizeSingleLine(row.bot_job_status_reason, 420),
    rejectionId: sanitizeSingleLine(row.rejection_id, 80),
    rejectionReason: sanitizeSingleLine(row.rejection_reason, 420),
    rejectionMarkedBy: sanitizeSingleLine(row.rejection_marked_by, 180),
    rejectionProcessingStatus: sanitizeSingleLine(row.rejection_processing_status, 120),
    matchType: sanitizeSingleLine(row.match_type, 80),
  };
}

async function runUuidStatusLookup(uuid, { forceRefresh = false } = {}) {
  if (!isSqlLookupConfigured()) {
    throw new Error("Cloud SQL UUID lookup is not configured. Check MailroomNavigator/.env and start Cloud SQL Proxy.");
  }

  const normalizedUuid = extractUuid(uuid);
  if (!normalizedUuid) {
    throw new Error("Invalid or missing UUID.");
  }

  if (!forceRefresh) {
    const cached = getCachedUuidLookup(normalizedUuid);
    if (cached) return cached;

    const inFlight = uuidLookupInFlight.get(normalizedUuid);
    if (inFlight) return inFlight;
  }

  const runPromise = (async () => {
    const query = `
      WITH search_input AS (
        SELECT TRIM(
          REGEXP_REPLACE(
            $1,
            '(…|\\.\\.\\.)$',
            ''
	          )
	        ) AS uuid_part
	      ),
	      document_matches AS (
	        SELECT
	          d.id AS document_id,
	          SPLIT_PART(d.input_file_name, '.', 1) AS matched_uuid,
	          d.input_file_name,
	          d.status AS document_status,
	          NULL::text AS bot_job_id,
	          NULL::text AS bot_job_type,
	          NULL::text AS bot_job_status,
	          NULL::text AS bot_job_status_reason,
	          CASE
	            WHEN LOWER(SPLIT_PART(d.input_file_name, '.', 1)) = LOWER(s.uuid_part)
	              THEN 0
	            ELSE 2
	          END AS match_rank,
	          CASE
	            WHEN LOWER(SPLIT_PART(d.input_file_name, '.', 1)) = LOWER(s.uuid_part)
	              THEN 'Exact document UUID match'
	            ELSE 'Partial document UUID match'
	          END AS match_type
	        FROM documents d
	        CROSS JOIN search_input s
	        WHERE LENGTH(s.uuid_part) >= 6
	          AND SPLIT_PART(d.input_file_name, '.', 1)
	              ILIKE '%' || s.uuid_part || '%'
	      ),
	      bot_job_matches AS (
	        SELECT
	          d.id AS document_id,
	          SPLIT_PART(d.input_file_name, '.', 1) AS matched_uuid,
	          d.input_file_name,
	          d.status AS document_status,
	          bj.id::text AS bot_job_id,
	          bj.type::text AS bot_job_type,
	          bj.status::text AS bot_job_status,
	          bj.status_reason::text AS bot_job_status_reason,
	          CASE
	            WHEN LOWER(bj.id::text) = LOWER(s.uuid_part)
	              THEN 1
	            ELSE 3
	          END AS match_rank,
	          CASE
	            WHEN LOWER(bj.id::text) = LOWER(s.uuid_part)
	              THEN 'Exact bot job UUID match'
	            ELSE 'Partial bot job UUID match'
	          END AS match_type
	        FROM bot_jobs bj
	        CROSS JOIN search_input s
	        LEFT JOIN documents d
	          ON d.id = bj.document_id
	        WHERE LENGTH(s.uuid_part) >= 6
	          AND bj.id::text ILIKE '%' || s.uuid_part || '%'
	      ),
	      matches AS (
	        SELECT * FROM document_matches
	        UNION ALL
	        SELECT * FROM bot_job_matches
	      )
	      SELECT
	        m.document_id,
	        m.matched_uuid,
	        m.input_file_name,
	        m.document_status,
	        CONCAT(
	          'https://app.betterletter.ai/mailroom/annotations/',
	          m.document_id
	        ) AS document_link,
	        m.bot_job_id,
	        m.bot_job_type,
	        m.bot_job_status,
	        m.bot_job_status_reason,
	        dr.id AS rejection_id,
	        dr.rejection_reason,
	        drv.origin->>'user' AS rejection_marked_by,
	        drv.changes->>'processing_status' AS rejection_processing_status,
	        m.match_type
	      FROM matches m
	      LEFT JOIN document_rejections dr
	        ON m.document_id = dr.mailroom_document_id
	      LEFT JOIN document_rejections_versions drv
	        ON drv.mailroom_document_id = m.document_id
	        AND drv.changes->>'processing_status' = 'done'
	      ORDER BY
	        m.match_rank,
	        m.document_id DESC
	      LIMIT 100
	    `;

    const result = await runSqlQueryWithConnectionRetry(query, [normalizedUuid], {
      timeoutMs: SQL_UUID_LOOKUP_TIMEOUT_MS,
      attempts: 2,
    });
    const matches = (Array.isArray(result?.rows) ? result.rows : [])
      .map(sanitizeUuidLookupRow)
      .filter((row) => row.documentId || row.botJobId)
      .slice(0, 100);
    const firstMatch = matches[0] || null;
    const lookup = firstMatch
      ? {
          uuid: normalizedUuid,
          found: true,
	          source: "cloud_sql",
	          status: firstMatch.status || firstMatch.botJobStatus,
	          detail: firstMatch.botJobId
	            ? `Bot job ${firstMatch.botJobType || firstMatch.botJobId} -> ${firstMatch.inputFileName || firstMatch.botJobStatus || firstMatch.matchType}`
	            : firstMatch.inputFileName || firstMatch.matchType,
	          documentId: firstMatch.documentId,
	          documentLink: firstMatch.documentLink,
	          rejectionReason: firstMatch.rejectionReason,
	          matchedUuid: firstMatch.matchedUuid,
	          inputFileName: firstMatch.inputFileName,
	          botJobId: firstMatch.botJobId,
	          botJobType: firstMatch.botJobType,
	          botJobStatus: firstMatch.botJobStatus,
	          botJobStatusReason: firstMatch.botJobStatusReason,
	          rejectionId: firstMatch.rejectionId,
	          rejectionMarkedBy: firstMatch.rejectionMarkedBy,
	          rejectionProcessingStatus: firstMatch.rejectionProcessingStatus,
	          matchType: firstMatch.matchType,
	          matches,
	          checkedAt: nowIso(),
	          matchedStatusPath: firstMatch.botJobId
	            ? "cloud_sql.bot_jobs.id -> documents.status"
	            : "cloud_sql.documents.status",
	        }
      : {
          uuid: normalizedUuid,
          found: false,
          source: "cloud_sql",
          status: "",
          detail: `No document or bot job found for UUID fragment ${normalizedUuid}.`,
          documentId: "",
          documentLink: "",
          rejectionReason: "",
          matches: [],
          checkedAt: nowIso(),
          matchedStatusPath: "cloud_sql.documents.status + cloud_sql.bot_jobs.id",
        };

    rememberUuidLookup(normalizedUuid, lookup);
    return lookup;
  })();

  uuidLookupInFlight.set(normalizedUuid, runPromise);
  try {
    return await runPromise;
  } finally {
    if (uuidLookupInFlight.get(normalizedUuid) === runPromise) {
      uuidLookupInFlight.delete(normalizedUuid);
    }
  }
}

function isLikelySlackId(value, prefixes = "CGD") {
  const allowed = String(prefixes || "CGD").toUpperCase();
  return new RegExp(`^[${allowed}][A-Z0-9]{8,}$`, "i").test(String(value || "").trim());
}

async function resolveSlackChannelIdByName(channelNameRaw) {
  const lookup = sanitizeSingleLine(channelNameRaw, 120).replace(/^#/, "").toLowerCase();
  if (!lookup) {
    throw new Error("Slack channel name is empty.");
  }

  let cursor = "";
  for (let page = 0; page < 30; page += 1) {
    const body = {
      types: "public_channel,private_channel",
      exclude_archived: true,
      limit: 200,
    };
    if (cursor) body.cursor = cursor;

    const data = await runSlackApiRequest("conversations.list", body);
    const channels = Array.isArray(data?.channels) ? data.channels : [];
    for (const channel of channels) {
      const id = sanitizeSingleLine(channel?.id, 80);
      const name = sanitizeSingleLine(channel?.name_normalized || channel?.name, 120).toLowerCase();
      if (id && name === lookup) return id;
    }

    cursor = sanitizeSingleLine(data?.response_metadata?.next_cursor, 260);
    if (!cursor) break;
  }

  throw new Error(`Slack channel "${lookup}" was not found for this bot token.`);
}

async function resolveSlackChannelId({ targetType, target }) {
  if (targetType === "user") {
    const data = await runSlackApiRequest("conversations.open", {
      users: target,
      return_im: true,
    });
    const channelId = sanitizeSingleLine(data?.channel?.id, 80);
    if (!channelId) {
      throw new Error("Slack did not return a DM channel for that user.");
    }
    return channelId;
  }

  const normalizedTarget = sanitizeSingleLine(target, 120).replace(/^[@#]/, "");
  if (isLikelySlackId(normalizedTarget, "CGD")) {
    return normalizedTarget;
  }
  return resolveSlackChannelIdByName(normalizedTarget);
}

async function postSlackMessageWithAutoJoin({ channelId, text, targetType }) {
  const messagePayload = {
    channel: channelId,
    text,
    unfurl_links: false,
    unfurl_media: false,
  };

  try {
    return await runSlackApiRequest("chat.postMessage", messagePayload);
  } catch (error) {
    const message = sanitizeSingleLine(error?.message, 260).toLowerCase();
    const canAttemptJoin = targetType === "channel" && isLikelySlackId(channelId, "CG");
    const shouldAttemptJoin = message.includes("not_in_channel") || message.includes("channel_not_found");
    if (!canAttemptJoin || !shouldAttemptJoin) throw error;

    await runSlackApiRequest("conversations.join", { channel: channelId });
    return runSlackApiRequest("chat.postMessage", messagePayload);
  }
}

function buildSlackIssueMessage({ payload, created }) {
  const issueId = sanitizeSingleLine(created?.issue?.identifier, 64) || "Issue";
  const issueTitle = sanitizeSingleLine(created?.issue?.title, 240) || "Linear issue";
  const issueUrl = sanitizeSingleLine(created?.issue?.url, 1200);

  const lines = [
    `${issueId}: ${issueTitle}`,
    issueUrl,
    "",
    `Letter ID: ${sanitizeSingleLine(payload?.documentId, 32) || "N/A"}`,
    `Failed job ID: ${sanitizeSingleLine(payload?.failedJobId, 120) || "N/A"}`,
    `Practice: ${sanitizeSingleLine(payload?.practiceName, 240) || "N/A"}`,
  ];

  return sanitizeMultiline(lines.filter(Boolean).join("\n"), 3200);
}

async function sendSlackIssueNotification(payload, created) {
  const slack = payload?.slack;
  if (!slack?.enabled) {
    return { attempted: false, success: false };
  }

  const targetType = normalizeSlackTargetType(slack.targetType);
  const target = sanitizeSingleLine(slack.target, 80).replace(/^[@#]/, "");
  if (!target) {
    return {
      attempted: true,
      success: false,
      targetType,
      target: "",
      error: "Slack target is required.",
    };
  }

  try {
    const channelId = await resolveSlackChannelId({ targetType, target });
    const text = buildSlackIssueMessage({ payload, created });
    const data = await postSlackMessageWithAutoJoin({ channelId, text, targetType });

    return {
      attempted: true,
      success: true,
      targetType,
      target,
      channel: sanitizeSingleLine(data?.channel, 80) || channelId,
      ts: sanitizeSingleLine(data?.ts, 64),
      error: "",
    };
  } catch (error) {
    return {
      attempted: true,
      success: false,
      targetType,
      target,
      error: sanitizeSingleLine(error?.message, 260) || "Slack notification failed.",
    };
  }
}

function buildBotJobsRunSlackMessage(run) {
  const runType = normalizeRunType(run?.runType);
  const runLabel = runType === "reconcile" ? "MailroomNavigator Reconcile Linear" : "MailroomNavigator Trigger Linear";
  const runId = sanitizeSingleLine(run?.runId, 80) || "unknown";
  const dryRun = run?.dryRun ? " (dry run)" : "";
  const endedAt = sanitizeSingleLine(run?.endedAt, 80) || nowIso();
  const status = sanitizeSingleLine(run?.status, 32).toLowerCase();
  const headline = status === "success"
    ? `${runLabel}${dryRun} finished successfully.`
    : `${runLabel}${dryRun} failed.`;

  const lines = [
    headline,
    `Run ID: ${runId}`,
    `Completed: ${endedAt}`,
  ];

  if (status !== "success") {
    const error = sanitizeSingleLine(run?.error, 220) || "Unknown error.";
    lines.push(`Error: ${error}`);
  }

  lines.push(`Actionable rows: ${Number(run?.actionableFoundTotal || 0)}`);
  lines.push(`Issue candidates: ${Number(run?.issueCandidatesTotal || 0)}`);

  if (run?.dryRun) {
    lines.push(`Preview issues: ${Number(run?.previewIssuesTotal || 0)}`);
  } else {
    lines.push(`Created issues: ${Number(run?.createdIssuesTotal || 0)}`);
  }

  lines.push(`Skipped duplicates: ${Number(run?.skippedDuplicatesTotal || 0)}`);

  if (run?.floodMode) {
    lines.push("Flood safeguards activated during this run.");
  }

  const summaryLines = sanitizeStringList(run?.summaryLines, 6, 220);
  if (summaryLines.length) {
    lines.push("");
    summaryLines.forEach((line) => lines.push(line));
  }

  return sanitizeMultiline(lines.filter(Boolean).join("\n"), 3200);
}

async function sendSlackBotJobsRunNotification(run, rawSlack = null) {
  const slack = sanitizeLinearSlackPayload(rawSlack);
  if (!slack?.enabled) {
    return { attempted: false, success: false };
  }
  if (!SLACK_BOT_TOKEN) {
    return {
      attempted: true,
      success: false,
      targetType: normalizeSlackTargetType(slack?.targetType),
      target: sanitizeSingleLine(slack?.target, 80),
      error: "SLACK_BOT_TOKEN is missing in MailroomNavigator/.env.",
    };
  }

  const targetType = normalizeSlackTargetType(slack.targetType);
  const target = sanitizeSingleLine(slack.target, 80).replace(/^[@#]/, "");
  if (!target) {
    return {
      attempted: true,
      success: false,
      targetType,
      target: "",
      error: "Slack target is required.",
    };
  }

  try {
    const channelId = await resolveSlackChannelId({ targetType, target });
    const text = buildBotJobsRunSlackMessage(run);
    const data = await postSlackMessageWithAutoJoin({ channelId, text, targetType });
    return {
      attempted: true,
      success: true,
      targetType,
      target,
      channel: sanitizeSingleLine(data?.channel, 80) || channelId,
      ts: sanitizeSingleLine(data?.ts, 64),
      error: "",
    };
  } catch (error) {
    return {
      attempted: true,
      success: false,
      targetType,
      target,
      error: sanitizeSingleLine(error?.message, 260) || "Slack notification failed.",
    };
  }
}

function sortSlackTargets(list = []) {
  return [...list].sort((a, b) => {
    const nameA = sanitizeSingleLine(a?.name || "", 140).toLowerCase();
    const nameB = sanitizeSingleLine(b?.name || "", 140).toLowerCase();
    if (nameA && nameB && nameA !== nameB) return nameA.localeCompare(nameB);
    const idA = sanitizeSingleLine(a?.id || "", 80).toLowerCase();
    const idB = sanitizeSingleLine(b?.id || "", 80).toLowerCase();
    return idA.localeCompare(idB);
  });
}

function sanitizeSlackTargetEntry(entry = {}, fallbackType = "channel") {
  const id = sanitizeSingleLine(entry?.id, 80).replace(/^[@#]/, "");
  if (!id) return null;
  const type = normalizeSlackTargetType(entry?.type || fallbackType);
  const name = sanitizeSingleLine(entry?.name, 140);
  const label = sanitizeSingleLine(entry?.label, 220)
    || (type === "user"
      ? (name ? `${name} (${id})` : id)
      : (name ? `#${name} (${id})` : id));
  return { id, name, label, type };
}

function sanitizeSlackTargetList(list = [], fallbackType = "channel") {
  const source = Array.isArray(list) ? list : [];
  const deduped = new Map();
  source.forEach((entry) => {
    const normalized = sanitizeSlackTargetEntry(entry, fallbackType);
    if (!normalized || deduped.has(normalized.id)) return;
    deduped.set(normalized.id, normalized);
  });
  return sortSlackTargets([...deduped.values()]);
}

function sanitizeSlackWorkspaceTargets(rawTargets = {}) {
  return {
    channels: sanitizeSlackTargetList(rawTargets?.channels, "channel"),
    users: sanitizeSlackTargetList(rawTargets?.users, "user"),
    syncedAt: sanitizeSingleLine(rawTargets?.syncedAt, 80),
  };
}

function isSlackWorkspaceTargetsCacheFresh(targets) {
  const syncedAtRaw = sanitizeSingleLine(targets?.syncedAt, 80);
  if (!syncedAtRaw) return false;
  const syncedAtMs = new Date(syncedAtRaw).getTime();
  if (!Number.isFinite(syncedAtMs)) return false;
  return Date.now() - syncedAtMs <= SLACK_TARGETS_CACHE_TTL_MS;
}

async function readSlackWorkspaceTargetsCacheFile() {
  try {
    const raw = await readFile(SLACK_TARGETS_CACHE_PATH, "utf8");
    const parsed = raw.trim() ? JSON.parse(raw) : {};
    return sanitizeSlackWorkspaceTargets(parsed);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return sanitizeSlackWorkspaceTargets({});
    }
    throw new Error(
      `Could not read Slack target cache at ${SLACK_TARGETS_CACHE_PATH}: ${sanitizeSingleLine(error?.message, 220) || "unknown error"}`,
    );
  }
}

async function saveSlackWorkspaceTargetsCacheFile(targets) {
  const normalizedTargets = sanitizeSlackWorkspaceTargets(targets);
  await mkdir(dirname(SLACK_TARGETS_CACHE_PATH), { recursive: true });
  await writeFile(
    SLACK_TARGETS_CACHE_PATH,
    `${JSON.stringify(normalizedTargets, null, 2)}\n`,
    "utf8",
  );
  slackTargetsCache = {
    loadedAt: Date.now(),
    targets: normalizedTargets,
  };
  return normalizedTargets;
}

async function loadSlackWorkspaceTargetsCache({ forceRefresh = false } = {}) {
  if (
    !forceRefresh
    && slackTargetsCache?.targets
    && Date.now() - Number(slackTargetsCache.loadedAt || 0) < SLACK_TARGETS_CACHE_TTL_MS
  ) {
    return sanitizeSlackWorkspaceTargets(slackTargetsCache.targets);
  }

  const cachedTargets = await readSlackWorkspaceTargetsCacheFile();
  if (!forceRefresh && isSlackWorkspaceTargetsCacheFresh(cachedTargets)) {
    slackTargetsCache = {
      loadedAt: Date.now(),
      targets: cachedTargets,
    };
  }
  return cachedTargets;
}

async function listSlackChannels() {
  const results = [];
  let cursor = "";

  for (let page = 0; page < 20; page += 1) {
    const body = {
      types: "public_channel,private_channel",
      exclude_archived: true,
      limit: 200,
    };
    if (cursor) body.cursor = cursor;

    const data = await runSlackApiRequest("conversations.list", body);
    const channels = Array.isArray(data?.channels) ? data.channels : [];
    channels.forEach((channel) => {
      if (SLACK_SYNC_MEMBER_ONLY && !channel?.is_member) return;
      const id = sanitizeSingleLine(channel?.id, 80);
      if (!id) return;
      const name = sanitizeSingleLine(channel?.name_normalized || channel?.name, 120);
      results.push({
        id,
        name,
        label: name ? `#${name} (${id})` : id,
        type: "channel",
      });
    });

    cursor = sanitizeSingleLine(data?.response_metadata?.next_cursor, 260);
    if (!cursor) break;
  }

  const uniqueById = new Map();
  results.forEach((entry) => {
    if (!entry?.id || uniqueById.has(entry.id)) return;
    uniqueById.set(entry.id, entry);
  });
  return sortSlackTargets([...uniqueById.values()]);
}

async function listSlackUsers() {
  const results = [];
  let cursor = "";

  for (let page = 0; page < 20; page += 1) {
    const body = { limit: 200 };
    if (cursor) body.cursor = cursor;

    const data = await runSlackApiRequest("users.list", body);
    const members = Array.isArray(data?.members) ? data.members : [];
    members.forEach((member) => {
      if (!member || member.deleted || member.is_bot || member.id === "USLACKBOT") return;
      const id = sanitizeSingleLine(member?.id, 80);
      if (!id) return;
      const profile = member?.profile && typeof member.profile === "object" ? member.profile : {};
      const realName = sanitizeSingleLine(
        profile.real_name_normalized
          || profile.real_name
          || profile.display_name_normalized
          || profile.display_name
          || member.real_name
          || member.name,
        120,
      );
      const userHandle = sanitizeSingleLine(member.name, 80);
      const label = realName
        ? (userHandle && realName.toLowerCase() !== userHandle.toLowerCase()
          ? `${realName} (@${userHandle}) (${id})`
          : `${realName} (${id})`)
        : (userHandle ? `@${userHandle} (${id})` : id);
      results.push({
        id,
        name: realName || userHandle,
        label,
        type: "user",
      });
    });

    cursor = sanitizeSingleLine(data?.response_metadata?.next_cursor, 260);
    if (!cursor) break;
  }

  const uniqueById = new Map();
  results.forEach((entry) => {
    if (!entry?.id || uniqueById.has(entry.id)) return;
    uniqueById.set(entry.id, entry);
  });
  return sortSlackTargets([...uniqueById.values()]);
}

async function fetchSlackWorkspaceTargets({ forceRefresh = false } = {}) {
  if (!SLACK_BOT_TOKEN) {
    throw new Error("SLACK_BOT_TOKEN is missing in MailroomNavigator/.env.");
  }

  const cachedTargets = await loadSlackWorkspaceTargetsCache({ forceRefresh: false });
  if (!forceRefresh && isSlackWorkspaceTargetsCacheFresh(cachedTargets)) {
    return cachedTargets;
  }

  let channels = cachedTargets.channels;
  let users = cachedTargets.users;
  let channelsFetchedLive = false;
  let usersFetchedLive = false;
  let channelError = null;
  let userError = null;

  try {
    channels = await listSlackChannels();
    channelsFetchedLive = true;
  } catch (error) {
    channelError = error;
    await appendServerLog(`[${nowIso()}] slack channels sync fallback: ${String(error?.message || error)}`);
  }

  try {
    users = await listSlackUsers();
    usersFetchedLive = true;
  } catch (error) {
    userError = error;
    await appendServerLog(`[${nowIso()}] slack users sync skipped: ${String(error?.message || error)}`);
  }

  const resolvedTargets = sanitizeSlackWorkspaceTargets({
    channels,
    users,
    syncedAt: channelsFetchedLive || usersFetchedLive
      ? nowIso()
      : cachedTargets.syncedAt,
  });

  if (channelsFetchedLive || usersFetchedLive) {
    return saveSlackWorkspaceTargetsCacheFile(resolvedTargets);
  }

  if (resolvedTargets.channels.length || resolvedTargets.users.length) {
    return resolvedTargets;
  }

  throw channelError || userError || new Error("Could not sync Slack workspace targets.");
}

function toRunPublic(run) {
  if (!run || typeof run !== "object") return null;
  const exitCode =
    typeof run.exitCode === "number" && Number.isFinite(run.exitCode)
      ? run.exitCode
      : null;
  const runType = String(run.runType || "").toLowerCase() === "reconcile" ? "reconcile" : "trigger";
  return {
    runId: String(run.runId || ""),
    startedAt: String(run.startedAt || ""),
    endedAt: run.endedAt ? String(run.endedAt) : "",
    status: String(run.status || ""),
    runType,
    dryRun: Boolean(run.dryRun),
    exitCode,
    signal: run.signal ? String(run.signal) : "",
    error: run.error ? String(run.error) : "",
    source: sanitizeSingleLine(run?.source, 80),
    summaryLines: sanitizeStringList(run.summaryLines, 10, 240),
    reportErrors: sanitizeStringList(run.reportErrors, 4, 240),
    createdIssuesTotal: Number.isFinite(Number(run.createdIssuesTotal)) ? Number(run.createdIssuesTotal) : 0,
    previewIssuesTotal: Number.isFinite(Number(run.previewIssuesTotal)) ? Number(run.previewIssuesTotal) : 0,
    skippedDuplicatesTotal: Number.isFinite(Number(run.skippedDuplicatesTotal)) ? Number(run.skippedDuplicatesTotal) : 0,
    actionableFoundTotal: Number.isFinite(Number(run.actionableFoundTotal)) ? Number(run.actionableFoundTotal) : 0,
    issueCandidatesTotal: Number.isFinite(Number(run.issueCandidatesTotal)) ? Number(run.issueCandidatesTotal) : 0,
    floodMode: Boolean(run.floodMode),
    slackNotification: sanitizeSlackNotificationResult(run.slackNotification),
  };
}

async function readBotJobsReport(reportPath) {
  const safePath = String(reportPath || "").trim();
  if (!safePath) return null;
  try {
    const raw = await readFile(safePath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function isBotJobsReportShape(report) {
  return Boolean(
    report
      && typeof report === "object"
      && (
        Array.isArray(report.pages_visited)
        || (report.summary && typeof report.summary === "object")
      )
  );
}

function parseBotJobsReportFromStdout(stdoutText) {
  const raw = String(stdoutText || "").trim();
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw);
    if (isBotJobsReportShape(parsed)) return parsed;
  } catch {
    // Fall through and try to find the final JSON object after log lines.
  }

  const startOffsets = [];
  const objectStartPattern = /(^|\n)\{/g;
  let match;
  while ((match = objectStartPattern.exec(raw)) !== null) {
    startOffsets.push(match.index + (match[1] ? match[1].length : 0));
  }

  for (let index = startOffsets.length - 1; index >= 0; index -= 1) {
    const candidate = raw.slice(startOffsets[index]).trim();
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (isBotJobsReportShape(parsed)) return parsed;
    } catch {
      // Try the previous "{"
    }
  }

  return null;
}

function summarizeBotJobsReport(report) {
  if (!report || typeof report !== "object") {
    return {
      summaryLines: [],
      reportErrors: [],
      createdIssuesTotal: 0,
      previewIssuesTotal: 0,
      skippedDuplicatesTotal: 0,
      actionableFoundTotal: 0,
      issueCandidatesTotal: 0,
      floodMode: false,
    };
  }

  const rowsScannedFromPages = Array.isArray(report.pages_visited)
    ? report.pages_visited.reduce((sum, entry) => sum + Number(entry?.rows_scanned || 0), 0)
    : 0;
  const actionableFoundFromPages = Array.isArray(report.pages_visited)
    ? report.pages_visited.reduce((sum, entry) => sum + Number(entry?.actionable_found || 0), 0)
    : 0;
  const actionableFoundTotal = Number.isFinite(Number(report.summary?.actionable_found_total))
    ? Number(report.summary.actionable_found_total)
    : actionableFoundFromPages;
  const issueCandidatesTotal = Number.isFinite(Number(report.summary?.issue_candidates_total))
    ? Number(report.summary.issue_candidates_total)
    : Number.isFinite(Number(report.grouping?.issue_candidates_total))
      ? Number(report.grouping.issue_candidates_total)
      : Number.isFinite(Number(report.safeguards?.estimated_new_issues))
        ? Number(report.safeguards.estimated_new_issues)
        : 0;

  return {
    summaryLines: sanitizeStringList(report.summary?.lines, 10, 240),
    reportErrors: sanitizeStringList(
      Array.isArray(report.errors)
        ? report.errors.map((entry) => {
            const step = sanitizeSingleLine(entry?.step, 32);
            const message = sanitizeSingleLine(entry?.message, 220);
            return step ? `${step}: ${message}` : message;
          })
        : [],
      4,
      240,
    ),
    createdIssuesTotal: Array.isArray(report.issues_created) ? report.issues_created.length : 0,
    previewIssuesTotal: Array.isArray(report.issues_preview) ? report.issues_preview.length : 0,
    skippedDuplicatesTotal: Array.isArray(report.issues_skipped_duplicate) ? report.issues_skipped_duplicate.length : 0,
    rowsScannedTotal: rowsScannedFromPages,
    actionableFoundTotal,
    issueCandidatesTotal,
    floodMode: Boolean(report.safeguards?.flood_mode),
  };
}

const SQL_RECONCILE_PRACTICE_MATCH_JOB_TYPES = new Set([
  "docman_import",
  "docman_validate",
]);
const SQL_RECONCILE_DOC_MATCH_JOB_TYPES = new Set([
  "docman_upload",
  "docman_file",
  "docman_review",
  "docman_delete_original",
  "docman_rejection",
  "emis_api_consultation",
  "emis_coding",
  "emis_rejection",
  "emis_delete_originals",
  "emis_prepare",
  "emis_unmatch",
  "generate_output",
  "merge_tasks_for_same_recipient",
]);

function normalizeSqlReconcileJobType(value) {
  const normalized = sanitizeSingleLine(value, 120).toLowerCase();
  if (!normalized) return "";
  if (normalized.includes("docman_validate") || normalized.includes("validatejob.create")) return "docman_validate";
  if (normalized.includes("docman_import")) return "docman_import";
  return normalized;
}

function normalizeSqlReconcilePractice(value) {
  return sanitizeSingleLine(value, 240)
    .toLowerCase()
    .replace(/[\u2026.]+$/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sqlReconcilePracticesLikelyMatch(a, b) {
  const left = normalizeSqlReconcilePractice(a);
  const right = normalizeSqlReconcilePractice(b);
  if (!left || !right) return false;
  if (left === right) return true;
  if (left.length >= 12 && right.startsWith(left)) return true;
  if (right.length >= 12 && left.startsWith(right)) return true;
  return false;
}

function sanitizeSqlReconcilePracticeCode(value) {
  return normalizeOdsCode(value) || sanitizeSingleLine(value, 32).toUpperCase().match(/\b[A-Z]\d{4,6}\b/)?.[0] || "";
}

function extractSqlReconcileIssueField(description, fieldName) {
  const text = String(description || "");
  const escaped = escapeRegex(fieldName);
  const patterns = [
    new RegExp(`^[\\s>*\\-•]*${escaped}\\s*:\\s*(.*)$`, "im"),
    new RegExp(`${escaped}\\s*:\\s*([^\\n\\r]+)`, "i"),
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return sanitizeSingleLine(match[1], 500);
  }
  return "";
}

function parseSqlReconcileBotIssueContext(issue = {}) {
  const title = sanitizeSingleLine(issue?.title, 240);
  if (!title.toLowerCase().includes(BOT_JOB_TITLE_PREFIX.toLowerCase())) return null;

  const normalizedTitle = title.replace(/^\s*\[prod\]\s*/i, "").trim();
  const titleMatch = normalizedTitle.match(/bot job error:\s*([^|]+)\|\s*([^|]+)\|\s*(.+)$/i);
  const description = String(issue?.description || "");
  const descJobType = extractSqlReconcileIssueField(description, "Job Type");
  const descDocumentId = extractSqlReconcileIssueField(description, "Document ID");
  const descPractice = extractSqlReconcileIssueField(description, "Practice");
  const descPracticeCode = extractSqlReconcileIssueField(description, "Practice Code");

  const jobType = normalizeSqlReconcileJobType(descJobType || titleMatch?.[1] || "");
  const documentId = normalizeIssueDocumentId(descDocumentId || titleMatch?.[2] || "");
  const practiceCandidate = sanitizeSingleLine(descPractice || titleMatch?.[3] || "", 240);
  const practiceCode = sanitizeSqlReconcilePracticeCode(descPracticeCode)
    || sanitizeSqlReconcilePracticeCode(practiceCandidate);
  const practiceName = /practice code/i.test(practiceCandidate) ? "" : practiceCandidate;

  return {
    issue,
    title,
    job_type: jobType,
    document_id: documentId,
    practice_name: practiceName,
    practice_code: practiceCode,
  };
}

function parseSqlReconcileSpikeIssueContext(issue = {}) {
  const title = sanitizeSingleLine(issue?.title, 240);
  if (!title.toLowerCase().includes(BOT_JOB_SPIKE_TITLE_PREFIX.toLowerCase())) return null;

  const signature = extractBotJobSpikeSignatureFromText(title, issue?.description);
  if (!signature) return null;

  return {
    issue,
    title,
    job_type: signature.jobTypes.length === 1 ? normalizeSqlReconcileJobType(signature.jobTypes[0]) : "",
    document_ids: signature.documentIds,
    practice_name: signature.practices.length === 1 ? signature.practices[0] : "",
    practice_code: "",
  };
}

function sanitizeSqlReconcileDashboardRow(row = {}) {
  const attemptCount = Number(row.attempt_count);
  const maxAttempts = Number(row.max_attempts);
  const statusReason = sanitizeMultiline(row.status_reason, 1000);
  const fallbackStatus = Number.isFinite(attemptCount) && Number.isFinite(maxAttempts) && attemptCount >= maxAttempts
    ? `Made ${attemptCount} attempts but still erroring`
    : "Require Attention";

  return {
    environment: "production",
    page_url: "cloud_sql.bot_jobs status=paused",
    document_id: normalizeIssueDocumentId(row.document_id),
    job_type: normalizeSqlReconcileJobType(row.job_type),
    practice_name: sanitizeSingleLine(row.practice_name, 240),
    practice_code: sanitizeSqlReconcilePracticeCode(row.practice_code),
    status_text: statusReason || fallbackStatus,
    attempts_count: Number.isFinite(attemptCount) ? attemptCount : null,
    max_attempts: Number.isFinite(maxAttempts) ? maxAttempts : null,
    job_id: sanitizeSingleLine(row.job_id, 120),
    inserted_at: sanitizeSingleLine(row.inserted_at, 80),
    updated_at: sanitizeSingleLine(row.updated_at, 80),
  };
}

const SQL_RECONCILE_PAUSED_BOT_JOBS_SQL = `
select
  bj.id::text as job_id,
  bj.type as job_type,
  bj.document_id::text as document_id,
  bj.practice_id as practice_code,
  p.display_name as practice_name,
  bj.status_reason,
  bj.attempt_count,
  bj.max_attempts,
  bj.inserted_at::text as inserted_at,
  bj.updated_at::text as updated_at
from bot_jobs bj
left join practices p
  on p.ods_code = bj.practice_id
where bj.status = 'paused'
order by bj.updated_at desc nulls last, bj.inserted_at desc nulls last
limit $1
`;

async function collectSqlReconcileDashboardRows(report) {
  const result = await runSqlQuery(
    SQL_RECONCILE_PAUSED_BOT_JOBS_SQL,
    [SQL_RECONCILE_MAX_ROWS],
    { timeoutMs: SQL_RECONCILE_QUERY_TIMEOUT_MS },
  );
  const rows = (Array.isArray(result?.rows) ? result.rows : [])
    .map(sanitizeSqlReconcileDashboardRow)
    .filter((row) => row.job_type || row.document_id || row.practice_code);

  report.pages_visited.push({
    url: "cloud_sql.bot_jobs where status = paused",
    rows_scanned: rows.length,
    actionable_found: rows.length,
    source: "cloud_sql",
  });
  report.dashboard_rows.push(...rows);
  return rows;
}

function buildSqlReconcileLiveIndex(rows = []) {
  const docKeys = new Set();
  const practiceByJobType = new Map();
  const practiceCodeByJobType = new Map();

  for (const row of rows) {
    const jobType = normalizeSqlReconcileJobType(row.job_type);
    const documentId = normalizeIssueDocumentId(row.document_id);
    const practiceName = normalizeSqlReconcilePractice(row.practice_name);
    const practiceCode = sanitizeSqlReconcilePracticeCode(row.practice_code);

    if (jobType && documentId) {
      docKeys.add(`${jobType}|${documentId}`);
    }
    if (jobType && practiceName) {
      const existing = practiceByJobType.get(jobType) || [];
      existing.push(practiceName);
      practiceByJobType.set(jobType, existing);
    }
    if (jobType && practiceCode) {
      const existing = practiceCodeByJobType.get(jobType) || new Set();
      existing.add(practiceCode);
      practiceCodeByJobType.set(jobType, existing);
    }
  }

  return { docKeys, practiceByJobType, practiceCodeByJobType };
}

function sqlReconcileIssueStillExists(context, liveIndex) {
  const jobType = normalizeSqlReconcileJobType(context?.job_type);
  const documentId = normalizeIssueDocumentId(context?.document_id);
  const practiceName = normalizeSqlReconcilePractice(context?.practice_name);
  const practiceCode = sanitizeSqlReconcilePracticeCode(context?.practice_code);

  if (!jobType) {
    return { found: true, reason: "missing_job_type_in_issue" };
  }

  if (SQL_RECONCILE_PRACTICE_MATCH_JOB_TYPES.has(jobType)) {
    const practices = liveIndex.practiceByJobType.get(jobType) || [];
    const foundByName = practiceName
      ? practices.some((candidate) => sqlReconcilePracticesLikelyMatch(practiceName, candidate))
      : false;
    if (foundByName) {
      return { found: true, reason: "matched_practice_job_type" };
    }

    const codes = liveIndex.practiceCodeByJobType.get(jobType) || new Set();
    const foundByCode = practiceCode ? codes.has(practiceCode) : false;
    return {
      found: foundByCode,
      reason: foundByCode ? "matched_practice_code_job_type" : "practice_job_type_not_found",
    };
  }

  if (!SQL_RECONCILE_DOC_MATCH_JOB_TYPES.has(jobType)) {
    return { found: true, reason: "unsupported_job_type_for_auto_close" };
  }

  if (!documentId) {
    return { found: true, reason: "missing_document_id_for_doc_match_job_type" };
  }

  const key = `${jobType}|${documentId}`;
  const found = liveIndex.docKeys.has(key);
  return { found, reason: found ? "matched_document_job_type" : "document_job_type_not_found" };
}

function sqlReconcileSpikeIssueStillExists(context, liveIndex) {
  const jobType = normalizeSqlReconcileJobType(context?.job_type);
  const documentIds = Array.isArray(context?.document_ids) ? context.document_ids : [];

  if (!jobType) {
    return { found: true, reason: "missing_job_type_in_issue" };
  }

  if (SQL_RECONCILE_PRACTICE_MATCH_JOB_TYPES.has(jobType)) {
    const practiceName = normalizeSqlReconcilePractice(context?.practice_name);
    const practiceCode = sanitizeSqlReconcilePracticeCode(context?.practice_code);
    const practices = liveIndex.practiceByJobType.get(jobType) || [];
    const foundByName = practiceName
      ? practices.some((candidate) => sqlReconcilePracticesLikelyMatch(practiceName, candidate))
      : false;
    if (foundByName) {
      return { found: true, reason: "matched_practice_job_type" };
    }

    const codes = liveIndex.practiceCodeByJobType.get(jobType) || new Set();
    const foundByCode = practiceCode ? codes.has(practiceCode) : false;
    return {
      found: foundByCode,
      reason: foundByCode ? "matched_practice_code_job_type" : "practice_job_type_not_found",
    };
  }

  if (!SQL_RECONCILE_DOC_MATCH_JOB_TYPES.has(jobType)) {
    return { found: true, reason: "unsupported_job_type_for_auto_close" };
  }

  if (!documentIds.length) {
    return { found: true, reason: "missing_document_ids_for_doc_match_job_type" };
  }

  // A spike is only stale once every one of its original documents has left the
  // paused queue - as long as even one is still stuck, the underlying problem
  // this issue tracks hasn't actually been resolved yet.
  const stillPausedCount = documentIds.filter((documentId) => liveIndex.docKeys.has(`${jobType}|${documentId}`)).length;
  const found = stillPausedCount > 0;
  return { found, reason: found ? "matched_document_job_type" : "document_job_type_not_found" };
}

async function fetchSqlReconcileOpenBotIssues(team) {
  const query = `
    query ReconcileOpenBotIssues($teamKey: String!, $first: Int!, $after: String) {
      issues(
        first: $first
        after: $after
        filter: {
          team: { key: { eq: $teamKey } }
          state: { type: { nin: ["completed", "canceled"] } }
        }
      ) {
        nodes {
          id
          identifier
          title
          url
          description
          state {
            id
            name
            type
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  `;
  const issues = [];
  let after = null;
  for (let page = 0; page < 20; page += 1) {
    const data = await runLinearGraphqlRequest(query, {
      teamKey: team.key,
      first: 100,
      after,
    });
    const root = data?.issues;
    const nodes = Array.isArray(root?.nodes) ? root.nodes : [];
    nodes
      .filter((issue) => {
        const normalized = sanitizeSingleLine(issue?.title, 240).toLowerCase();
        return normalized.includes(BOT_JOB_TITLE_PREFIX.toLowerCase())
          || normalized.includes(BOT_JOB_SPIKE_TITLE_PREFIX.toLowerCase());
      })
      .forEach((issue) => issues.push(issue));

    const pageInfo = root?.pageInfo;
    if (!pageInfo?.hasNextPage || !sanitizeSingleLine(pageInfo?.endCursor, 240)) break;
    after = sanitizeSingleLine(pageInfo.endCursor, 240);
  }
  return issues;
}

async function resolveLinearDoneStateId(teamId) {
  const exactDone = await resolveLinearWorkflowStateId(teamId, "Done");
  if (exactDone) return exactDone;

  const catalogHasStateType = Array.isArray(resolvedLinearWorkflowStateCatalog)
    && resolvedLinearWorkflowStateCatalog.some((state) => Object.prototype.hasOwnProperty.call(state || {}, "type"));
  if (!resolvedLinearWorkflowStateCatalog || !catalogHasStateType) {
    const query = `
      query workflowStates($first: Int) {
        workflowStates(first: $first) {
          nodes {
            id
            name
            type
            team {
              id
            }
          }
        }
      }
    `;
    const data = await runLinearGraphqlRequest(query, { first: 250 });
    resolvedLinearWorkflowStateCatalog = Array.isArray(data?.workflowStates?.nodes)
      ? data.workflowStates.nodes
      : [];
  }

  const completedState = (Array.isArray(resolvedLinearWorkflowStateCatalog) ? resolvedLinearWorkflowStateCatalog : [])
    .find((state) =>
      sanitizeSingleLine(state?.team?.id, 64) === teamId
      && sanitizeSingleLine(state?.type, 64).toLowerCase() === "completed"
    );
  const stateId = sanitizeSingleLine(completedState?.id, 64);
  if (!stateId) {
    throw new Error(`Could not find a done/completed workflow state for team ${LINEAR_TEAM_KEY}.`);
  }
  return stateId;
}

async function moveLinearIssueToState(issueId, stateId) {
  const mutation = `
    mutation ReconcileIssueUpdate($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) {
        success
      }
    }
  `;
  const data = await runLinearGraphqlRequest(mutation, {
    id: sanitizeSingleLine(issueId, 64),
    input: { stateId: sanitizeSingleLine(stateId, 64) },
  });
  if (!data?.issueUpdate?.success) {
    throw new Error("Linear issue update did not return success.");
  }
}

function buildSqlReconcileSummary(report) {
  const rowsScannedTotal = report.pages_visited.reduce(
    (sum, page) => sum + Number(page.rows_scanned || 0),
    0,
  );
  const actionableFoundTotal = report.pages_visited.reduce(
    (sum, page) => sum + Number(page.actionable_found || 0),
    0,
  );

  return {
    rows_scanned_total: rowsScannedTotal,
    actionable_found_total: actionableFoundTotal,
    open_issues_scanned_total: report.open_issues_scanned,
    marked_done_total: report.issues_marked_done.length,
    preview_done_total: report.issues_preview_done.length,
    kept_open_total: report.issues_kept_open.length,
    skipped_unmatchable_total: report.issues_skipped_unmatchable.length,
    source: "cloud_sql",
    lines: [
      "It used Cloud SQL for the bot dashboard check.",
      `It scanned ${rowsScannedTotal} SQL bot-job rows and found ${actionableFoundTotal} actionable.`,
      `It scanned ${report.open_issues_scanned} open bot issues in Linear.`,
      `It marked ${report.issues_marked_done.length} issues as done.`,
      `It previewed ${report.issues_preview_done.length} issues to mark done.`,
      `It kept ${report.issues_kept_open.length} issues open (still on dashboard).`,
      `It skipped ${report.issues_skipped_unmatchable.length} issues due to missing match fields.`,
    ],
  };
}

async function runSqlReconcileBotIssues({ dryRun = false } = {}) {
  if (!SQL_RECONCILE_ENABLED) {
    throw new Error("Cloud SQL reconcile is disabled by MAILROOMNAV_SQL_RECONCILE_ENABLED=0.");
  }
  ensureLinearConfig();
  if (!isSqlLookupConfigured()) {
    throw new Error("Cloud SQL is not configured for reconcile.");
  }

  const report = {
    environment: "production",
    dry_run: Boolean(dryRun),
    source: "cloud_sql",
    run_started_at: nowIso(),
    run_finished_at: null,
    pages_visited: [],
    dashboard_rows: [],
    open_issues_scanned: 0,
    issues_marked_done: [],
    issues_preview_done: [],
    issues_kept_open: [],
    issues_skipped_unmatchable: [],
    errors: [],
    auth_refresh_attempted: false,
    auth_refresh_succeeded: null,
    summary: null,
  };

  try {
    const team = await resolveLinearTeam();
    const doneStateId = dryRun ? "" : await resolveLinearDoneStateId(team.id);
    const rows = await collectSqlReconcileDashboardRows(report);
    const liveIndex = buildSqlReconcileLiveIndex(rows);
    const openBotIssues = await fetchSqlReconcileOpenBotIssues(team);
    report.open_issues_scanned = openBotIssues.length;

    for (const issue of openBotIssues) {
      const isSpike = sanitizeSingleLine(issue?.title, 240).toLowerCase().includes(BOT_JOB_SPIKE_TITLE_PREFIX.toLowerCase());
      const contextInfo = isSpike
        ? parseSqlReconcileSpikeIssueContext(issue)
        : parseSqlReconcileBotIssueContext(issue);
      if (!contextInfo) {
        report.issues_skipped_unmatchable.push({
          linear_key: sanitizeSingleLine(issue?.identifier, 64),
          title: sanitizeSingleLine(issue?.title, 240),
          reason: "not_parseable_bot_issue",
        });
        continue;
      }

      const hasDocumentIds = isSpike
        ? contextInfo.document_ids.length > 0
        : Boolean(contextInfo.document_id);
      const missingRequiredFields =
        !contextInfo.job_type
        || (SQL_RECONCILE_DOC_MATCH_JOB_TYPES.has(contextInfo.job_type) && !hasDocumentIds)
        || (
          SQL_RECONCILE_PRACTICE_MATCH_JOB_TYPES.has(contextInfo.job_type)
          && !normalizeSqlReconcilePractice(contextInfo.practice_name)
          && !sanitizeSqlReconcilePracticeCode(contextInfo.practice_code)
        );
      if (missingRequiredFields) {
        report.issues_skipped_unmatchable.push({
          linear_key: sanitizeSingleLine(issue?.identifier, 64),
          title: sanitizeSingleLine(issue?.title, 240),
          job_type: contextInfo.job_type,
          document_id: isSpike ? contextInfo.document_ids.join(",") : contextInfo.document_id,
          practice_name: contextInfo.practice_name,
          practice_code: contextInfo.practice_code,
          reason: "missing_required_match_fields",
        });
        continue;
      }

      const matchResult = isSpike
        ? sqlReconcileSpikeIssueStillExists(contextInfo, liveIndex)
        : sqlReconcileIssueStillExists(contextInfo, liveIndex);
      const publicEntry = {
        linear_key: sanitizeSingleLine(issue?.identifier, 64),
        title: sanitizeSingleLine(issue?.title, 240),
        job_type: contextInfo.job_type,
        document_id: isSpike ? contextInfo.document_ids.join(",") : contextInfo.document_id,
        practice_name: contextInfo.practice_name,
        practice_code: contextInfo.practice_code,
        reason: matchResult.reason,
      };

      if (matchResult.found) {
        report.issues_kept_open.push(publicEntry);
        continue;
      }

      if (dryRun) {
        report.issues_preview_done.push({
          ...publicEntry,
          dry_run: true,
        });
        continue;
      }

      await moveLinearIssueToState(issue.id, doneStateId);
      report.issues_marked_done.push(publicEntry);
    }
  } catch (error) {
    report.errors.push({
      step: "main",
      message: sanitizeSingleLine(error?.message || error, 300) || "Cloud SQL reconcile failed.",
    });
  }

  report.run_finished_at = nowIso();
  report.summary = buildSqlReconcileSummary(report);
  return report;
}

async function finalizeInProcessBotJobsRun({
  runId,
  startedAt,
  dryRun,
  runType,
  reportPath,
  slack,
  report,
  source = "",
}) {
  const endedAt = nowIso();
  const reportSummary = summarizeBotJobsReport(report);
  const reportErrors = Array.isArray(reportSummary.reportErrors) ? reportSummary.reportErrors : [];
  const status = reportErrors.length ? "failed" : "success";
  const finalError = reportErrors[0] || "";

  try {
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  } catch (error) {
    await appendServerLog(
      `[${nowIso()}] [${runId}] failed to write report: ${sanitizeSingleLine(error?.message || error, 260)}`
    ).catch(() => undefined);
  }

  lastRun = {
    runId,
    startedAt,
    endedAt,
    status,
    runType: normalizeRunType(runType),
    dryRun: Boolean(dryRun),
    exitCode: status === "success" ? 0 : 1,
    signal: "",
    error: finalError,
    pid: null,
    reportPath,
    slack: sanitizeLinearSlackPayload(slack),
    slackNotification: null,
    source: sanitizeSingleLine(source, 80),
    ...reportSummary,
  };
  activeRun = null;
  await appendServerLog(
    `[${nowIso()}] [${runId}] finished status=${status} source=${sanitizeSingleLine(source, 80) || "in_process"}`
  ).catch(() => undefined);
  await writeLastRunState().catch(() => undefined);

  await delay(LINEAR_TRIGGER_SLACK_SUMMARY_DELAY_MS);
  const slackResult = await sendSlackBotJobsRunNotification(lastRun, slack);
  if (slackResult.attempted) {
    appendServerLog(
      `[${nowIso()}] [${runId}] slack ${slackResult.success ? "sent" : "failed"} targetType=${slackResult.targetType} target=${slackResult.target || "n/a"}${slackResult.error ? ` error=${slackResult.error}` : ""}`,
    ).catch(() => undefined);
  }
  lastRun = {
    ...lastRun,
    slackNotification: sanitizeSlackNotificationResult(slackResult),
  };
  await writeLastRunState().catch(() => undefined);
}

async function startSqlReconcileRun({ dryRun, slack = null } = {}) {
  if (activeRun) {
    return { accepted: false, reason: "already_running", run: toRunPublic(activeRun) };
  }

  const runId = createRunId();
  const startedAt = nowIso();
  const reportPath = join(BOT_JOBS_REPORTS_DIR, `${runId}.json`);
  activeRun = {
    runId,
    startedAt,
    endedAt: "",
    status: "running",
    runType: "reconcile",
    dryRun: Boolean(dryRun),
    exitCode: null,
    signal: "",
    error: "",
    pid: null,
    reportPath,
    slack: sanitizeLinearSlackPayload(slack),
    slackNotification: null,
    source: "cloud_sql",
  };
  await appendServerLog(
    `[${nowIso()}] [${runId}] started type=reconcile source=cloud_sql (dryRun=${Boolean(dryRun)})`,
  );
  await writeLastRunState();

  void (async () => {
    const report = await runSqlReconcileBotIssues({ dryRun }).catch((error) => ({
      environment: "production",
      dry_run: Boolean(dryRun),
      source: "cloud_sql",
      run_started_at: startedAt,
      run_finished_at: nowIso(),
      pages_visited: [],
      dashboard_rows: [],
      open_issues_scanned: 0,
      issues_marked_done: [],
      issues_preview_done: [],
      issues_kept_open: [],
      issues_skipped_unmatchable: [],
      errors: [{
        step: "main",
        message: sanitizeSingleLine(error?.message || error, 300) || "Cloud SQL reconcile failed.",
      }],
      summary: {
        lines: ["Cloud SQL reconcile failed."],
        actionable_found_total: 0,
      },
    }));

    await finalizeInProcessBotJobsRun({
      runId,
      startedAt,
      dryRun,
      runType: "reconcile",
      reportPath,
      slack: sanitizeLinearSlackPayload(slack),
      report,
      source: "cloud_sql",
    });
  })();

  return { accepted: true, run: toRunPublic(activeRun) };
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
    "Access-Control-Allow-Headers": `Content-Type, ${TRIGGER_SECRET_HEADER}`,
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

async function writeDocmanRunState() {
  await mkdir(STATE_DIR, { recursive: true });
  const payload = {
    updatedAt: nowIso(),
    activeRun: toDocmanRunPublic(docmanActiveRun),
    lastRun: toDocmanRunPublic(lastDocmanRun),
  };
  await writeFile(DOCMAN_LAST_RUN_STATE_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function loadDocmanRunState() {
  try {
    const raw = await readFile(DOCMAN_LAST_RUN_STATE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed?.lastRun && typeof parsed.lastRun === "object") {
      lastDocmanRun = parsed.lastRun;
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

function buildBotJobsEnv({ dryRun, reportPath = "" }) {
  const env = {
    ...buildChildProcessEnv(),
    DOTENV_CONFIG_PATH: BOT_JOBS_ENV_FILE,
    AUTH_HEADLESS: process.env.AUTH_HEADLESS || "1",
    AUTO_2FA_FROM_EMAIL: process.env.AUTO_2FA_FROM_EMAIL || "1",
  };
  if (dryRun) env.DRY_RUN = "1";
  else delete env.DRY_RUN;
  if (reportPath) env.BOT_JOBS_REPORT_PATH = reportPath;
  else delete env.BOT_JOBS_REPORT_PATH;
  return env;
}

function createRunId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeRunType(value) {
  return String(value || "").toLowerCase().trim() === "reconcile" ? "reconcile" : "trigger";
}

function normalizeDocmanAction(value) {
  const normalized = sanitizeSingleLine(value, 40).toLowerCase();
  if (normalized === "login") return "login";
  if (normalized === "verify") return "verify";
  if (["create-group", "create_group", "creategroup", "group"].includes(normalized)) return "create-group";
  if (["clean-processing", "clean_processing", "processing"].includes(normalized)) return "clean-processing";
  if (["clean-filing", "clean_filing", "filing"].includes(normalized)) return "clean-filing";
  if (normalized === "onboarding") return "onboarding";
  return "";
}

function getDocmanActionLabel(action) {
  const normalized = normalizeDocmanAction(action);
  if (normalized === "login") return "Login";
  if (normalized === "verify") return "Verify";
  if (normalized === "create-group") return "Create Group";
  if (normalized === "clean-processing") return "Clean Processing";
  if (normalized === "clean-filing") return "Clean Filing";
  if (normalized === "onboarding") return "Onboarding";
  return "Docman Tool";
}

const DOCMAN_ONBOARDING_DEFAULT_INPUT_FOLDER_NAME = "zz BL Input. Do not touch";

function sanitizeDocmanFolderName(value) {
  return sanitizeSingleLine(value, 240);
}

function sanitizeDocmanCredential(value, maxLength = 240) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function resolveDocmanOnboardingInputFolderName(payload = {}) {
  return sanitizeDocmanFolderName(payload?.onboardingInputFolderName) || DOCMAN_ONBOARDING_DEFAULT_INPUT_FOLDER_NAME;
}

function sanitizeDocmanUsernames(rawUsernames = []) {
  if (!Array.isArray(rawUsernames)) return [];
  const seen = new Set();
  const usernames = [];
  rawUsernames.forEach((value) => {
    const username = sanitizeSingleLine(value, 120);
    if (!username) return;
    const key = username.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    usernames.push(username);
  });
  return usernames.slice(0, 500);
}

function sanitizeDocmanRunPayload(rawPayload = {}) {
  return {
    action: normalizeDocmanAction(rawPayload?.action),
    practiceName: sanitizeSingleLine(rawPayload?.practiceName, 240),
    odsCode: sanitizeSingleLine(rawPayload?.odsCode, 16).toUpperCase(),
    groupName: sanitizeSingleLine(rawPayload?.groupName, 240),
    usernames: sanitizeDocmanUsernames(rawPayload?.usernames),
    onboardingInputFolderName: sanitizeDocmanFolderName(rawPayload?.onboardingInputFolderName),
    docmanUsername: sanitizeSingleLine(rawPayload?.docmanUsername, 240),
    docmanPassword: sanitizeDocmanCredential(rawPayload?.docmanPassword),
    docmanInputFolder: sanitizeDocmanFolderName(rawPayload?.docmanInputFolder),
    docmanProcessingFolder: sanitizeDocmanFolderName(rawPayload?.docmanProcessingFolder),
    docmanFilingFolder: sanitizeDocmanFolderName(rawPayload?.docmanFilingFolder),
  };
}

function validateDocmanRunPayload(payload) {
  if (!payload?.action) {
    throw new Error("Invalid or missing Docman action.");
  }
  if (!payload.practiceName) {
    throw new Error("Missing practice name.");
  }
  if (!payload.odsCode) {
    throw new Error("Missing ODS code.");
  }
  if (!sanitizeSingleLine(payload?.docmanUsername, 240) || !sanitizeDocmanCredential(payload?.docmanPassword)) {
    throw new Error("Missing Docman username/password for direct extension login.");
  }
  if (payload.action === "verify" && payload.usernames.length === 0) {
    throw new Error("Verify requires at least one username.");
  }
  if (payload.action === "create-group") {
    if (!payload.groupName) {
      throw new Error("Create Group requires a group name.");
    }
    if (payload.usernames.length === 0) {
      throw new Error("Create Group requires at least one username.");
    }
  }
}

async function hydrateDocmanRunPayloadFromSql(payload) {
  const sanitizedPayload = sanitizeDocmanRunPayload(payload);
  if (sanitizedPayload.docmanUsername && sanitizedPayload.docmanPassword) {
    return sanitizedPayload;
  }
  const practice = await lookupPracticeByOdsFromSql(sanitizedPayload.odsCode, { includeSecrets: true });
  if (!practice) return sanitizedPayload;

  return sanitizeDocmanRunPayload({
    ...sanitizedPayload,
    practiceName: sanitizedPayload.practiceName || practice.name,
    docmanUsername: sanitizedPayload.docmanUsername || practice.docmanUsername,
    docmanPassword: sanitizedPayload.docmanPassword || practice.docmanPassword,
    onboardingInputFolderName: sanitizedPayload.onboardingInputFolderName || practice.docmanInputFolder,
    docmanInputFolder: sanitizedPayload.docmanInputFolder || practice.docmanInputFolder,
    docmanProcessingFolder: sanitizedPayload.docmanProcessingFolder || practice.docmanProcessingFolder,
    docmanFilingFolder: sanitizedPayload.docmanFilingFolder || practice.docmanFilingFolder,
  });
}

function buildDocmanToolLaunch(payload) {
  if (!existsSync(DOCMAN_EXTENSION_RUNNER_ENTRY)) {
    throw new Error(`docman extension runner not found: ${DOCMAN_EXTENSION_RUNNER_ENTRY}`);
  }

  const args = [
    DOCMAN_EXTENSION_RUNNER_ENTRY,
    "--docman-tool-dir",
    DOCMAN_TOOL_DIR,
    "--action",
    payload.action,
    "--practice",
    payload.practiceName,
    "--ods-code",
    payload.odsCode,
  ];

  if (payload.action === "verify" && payload.usernames.length) {
    args.push("--usernames", payload.usernames.join("\n"));
  }
  if (payload.action === "create-group") {
    args.push("--group-name", payload.groupName);
    if (payload.usernames.length) {
      args.push("--usernames", payload.usernames.join("\n"));
    }
  }
  if (payload.action === "onboarding") {
    args.push("--input-folder-name", resolveDocmanOnboardingInputFolderName(payload));
  }

  return {
    cwd: REPO_ROOT,
    args,
    env: {
      MAILROOM_DOCMAN_USERNAME: payload.docmanUsername,
      MAILROOM_DOCMAN_PASSWORD: payload.docmanPassword,
      MAILROOM_DOCMAN_INPUT_FOLDER: payload.docmanInputFolder,
      MAILROOM_DOCMAN_PROCESSING_FOLDER: payload.docmanProcessingFolder,
      MAILROOM_DOCMAN_FILING_FOLDER: payload.docmanFilingFolder,
    },
  };
}

function buildDocmanToolEnv() {
  return {
    ...buildChildProcessEnv(),
    FORCE_COLOR: "0",
  };
}

function buildChildProcessEnv(extraEnv = {}) {
  return {
    ...process.env,
    PATH: buildExecutablePath(process.env.PATH),
    ...extraEnv,
  };
}

function buildExecutablePath(currentPath = "") {
  const requiredEntries = process.platform === "win32"
    ? []
    : ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  const parts = String(currentPath || "")
    .split(delimiter)
    .map((part) => String(part || "").trim())
    .filter(Boolean);
  const seen = new Set();
  const ordered = [];

  [...requiredEntries, ...parts].forEach((part) => {
    const key = process.platform === "win32" ? part.toLowerCase() : part;
    if (!part || seen.has(key)) return;
    seen.add(key);
    ordered.push(part);
  });

  return ordered.join(delimiter);
}

function appendDocmanRunTail(run, rawText, channel = "stdout") {
  if (!run || typeof run !== "object") return;
  const prefix = channel === "stderr" ? "[stderr] " : "";
  const lines = String(rawText || "").replace(/\r/g, "\n").split("\n");
  if (!Array.isArray(run.logLines)) {
    run.logLines = [];
  }
  if (!Array.isArray(run.summaryTail)) {
    run.summaryTail = [];
  }
  for (const line of lines) {
    const rawTrimmed = String(line || "").trim();
    if (rawTrimmed.startsWith("__DOCMAN_RESULT__")) {
      // Parse from the untruncated line - the JSON payload (verify results,
      // clean-processing folder names/counts, etc.) routinely exceeds the
      // 240-char cap used for human-readable log lines below, and truncating
      // it first breaks JSON.parse, silently leaving resultData unset.
      try {
        const parsed = JSON.parse(rawTrimmed.slice("__DOCMAN_RESULT__".length));
        const resultData = sanitizeDocmanResultData(parsed);
        if (resultData) {
          run.resultData = resultData;
        }
      } catch {
        // Ignore malformed structured markers and keep the human-readable log instead.
      }
      continue;
    }
    const normalized = sanitizeSingleLine(line, 240);
    if (!normalized) continue;
    run.logLines.push(`${prefix}${normalized}`);
    if (run.logLines.length > 160) {
      run.logLines = run.logLines.slice(-160);
    }
    run.summaryTail.push(`${prefix}${normalized}`);
    if (run.summaryTail.length > 12) {
      run.summaryTail = run.summaryTail.slice(-12);
    }
  }
}

function toDocmanRunPublic(run) {
  if (!run || typeof run !== "object") return null;
  const exitCode = typeof run.exitCode === "number" && Number.isFinite(run.exitCode)
    ? run.exitCode
    : null;
  return {
    runId: String(run.runId || ""),
    startedAt: String(run.startedAt || ""),
    endedAt: run.endedAt ? String(run.endedAt) : "",
    status: String(run.status || ""),
    action: normalizeDocmanAction(run.action),
    practiceName: sanitizeSingleLine(run.practiceName, 240),
    odsCode: sanitizeSingleLine(run.odsCode, 16).toUpperCase(),
    groupName: sanitizeSingleLine(run.groupName, 240),
    usernamesCount: Number.isFinite(Number(run.usernamesCount)) ? Number(run.usernamesCount) : 0,
    onboardingInputFolderName: sanitizeDocmanFolderName(run.onboardingInputFolderName),
    exitCode,
    signal: run.signal ? String(run.signal) : "",
    error: run.error ? String(run.error) : "",
    summaryLines: sanitizeStringList(run.summaryLines || run.summaryTail, 10, 240),
    logLines: sanitizeStringList(run.logLines || run.summaryTail, 120, 240),
    resultData: sanitizeDocmanResultData(run.resultData),
  };
}

async function startBotJobsRun({ dryRun, entryScript = BOT_JOBS_ENTRY, runType = "trigger", slack = null }) {
  if (activeRun) {
    return { accepted: false, reason: "already_running", run: toRunPublic(activeRun) };
  }

  if (!existsSync(BOT_JOBS_DIR)) {
    throw new Error(`bot-jobs directory not found: ${BOT_JOBS_DIR}`);
  }
  const entryName = String(entryScript || "").trim() || BOT_JOBS_ENTRY;
  const entryPath = join(BOT_JOBS_DIR, entryName);
  if (!existsSync(entryPath)) {
    throw new Error(`bot-jobs entry script not found: ${entryPath}`);
  }
  if (!existsSync(BOT_JOBS_ENV_FILE)) {
    throw new Error(`bot-jobs env file not found: ${BOT_JOBS_ENV_FILE}`);
  }

  const normalizedRunType = normalizeRunType(runType);
  const runId = createRunId();
  const startedAt = nowIso();
  const reportPath = join(BOT_JOBS_REPORTS_DIR, `${runId}.json`);
  const child = spawn(process.execPath, [entryName], {
    cwd: BOT_JOBS_DIR,
    env: buildBotJobsEnv({ dryRun, reportPath }),
    stdio: ["ignore", "pipe", "pipe"],
  });

  activeRun = {
    runId,
    startedAt,
    endedAt: "",
    status: "running",
    runType: normalizedRunType,
    dryRun: Boolean(dryRun),
    exitCode: null,
    signal: "",
    error: "",
    pid: child.pid || null,
    reportPath,
    slack: sanitizeLinearSlackPayload(slack),
    slackNotification: null,
  };
  await appendServerLog(
    `[${nowIso()}] [${runId}] started type=${normalizedRunType} script=${entryName} (dryRun=${Boolean(dryRun)})`,
  );
  await writeLastRunState();

  let runFinalized = false;
  let stdoutBuffer = "";
  const finalizeRun = async (result, logMessage) => {
    if (runFinalized) return;
    runFinalized = true;

    const endedAt = nowIso();
    const baseRun = activeRun?.runId === runId
      ? activeRun
      : {
          runId,
          startedAt,
          endedAt: "",
          status: "running",
          runType: normalizedRunType,
          dryRun: Boolean(dryRun),
          exitCode: null,
          signal: "",
          error: "",
          pid: child.pid || null,
          reportPath,
          slack: sanitizeLinearSlackPayload(slack),
          slackNotification: null,
        };
    let rawReport = await readBotJobsReport(baseRun.reportPath || reportPath);
    if (!rawReport) {
      rawReport = parseBotJobsReportFromStdout(stdoutBuffer);
      if (rawReport && baseRun.reportPath) {
        writeFile(baseRun.reportPath, `${JSON.stringify(rawReport, null, 2)}\n`, "utf8").catch(() => undefined);
      }
    }
    const reportSummary = summarizeBotJobsReport(rawReport);
    const finalStatus =
      String(result?.status || "").toLowerCase() === "success" && reportSummary.reportErrors.length
        ? "failed"
        : result.status;
    const finalError = reportSummary.reportErrors[0] || result.error || "";
    lastRun = {
      ...baseRun,
      endedAt,
      ...result,
      status: finalStatus,
      error: finalError,
      ...reportSummary,
    };
    activeRun = null;
    if (logMessage) {
      appendServerLog(`[${nowIso()}] [${runId}] ${logMessage}`).catch(() => undefined);
    }
    writeLastRunState().catch(() => undefined);

    // The panel reads lastRun immediately after the process exits. Delay Slack so the
    // user gets the 2-second in-panel confirmation first, then the Slack summary.
    await delay(LINEAR_TRIGGER_SLACK_SUMMARY_DELAY_MS);
    const slackResult = await sendSlackBotJobsRunNotification(lastRun, baseRun.slack);
    if (slackResult.attempted) {
      appendServerLog(
        `[${nowIso()}] [${runId}] slack ${slackResult.success ? "sent" : "failed"} targetType=${slackResult.targetType} target=${slackResult.target || "n/a"}${slackResult.error ? ` error=${slackResult.error}` : ""}`,
      ).catch(() => undefined);
    }
    lastRun = {
      ...lastRun,
      slackNotification: sanitizeSlackNotificationResult(slackResult),
    };
    writeLastRunState().catch(() => undefined);
  };

  const killTimer = setTimeout(() => {
    void finalizeRun(
      {
        status: "failed",
        exitCode: null,
        signal: "SIGTERM",
        error: `bot-jobs exceeded timeout (${BOT_JOBS_TIMEOUT_MINUTES}m) and was terminated.`,
      },
      `timed out after ${BOT_JOBS_TIMEOUT_MINUTES}m; sent SIGTERM`,
    );
    try {
      child.kill("SIGTERM");
    } catch {
      // Ignore kill errors.
    }
  }, BOT_JOBS_TIMEOUT_MS);
  if (typeof killTimer.unref === "function") {
    killTimer.unref();
  }

  child.stdout?.on("data", (chunk) => {
    const rawText = String(chunk || "");
    stdoutBuffer = `${stdoutBuffer}${rawText}`;
    if (stdoutBuffer.length > 2_000_000) {
      stdoutBuffer = stdoutBuffer.slice(-2_000_000);
    }
    const text = rawText.replace(/\r?\n$/, "");
    appendServerLog(`[${nowIso()}] [${runId}] [stdout] ${text}`).catch(() => undefined);
  });

  child.stderr?.on("data", (chunk) => {
    const text = String(chunk || "").replace(/\r?\n$/, "");
    appendServerLog(`[${nowIso()}] [${runId}] [stderr] ${text}`).catch(() => undefined);
  });

  child.on("error", (error) => {
    clearTimeout(killTimer);
    const errMessage = String(error?.message || "Unknown process error");
    void finalizeRun(
      {
        status: "failed",
        error: errMessage,
      },
      `process error: ${errMessage}`,
    );
  });

  child.on("exit", (code, signal) => {
    clearTimeout(killTimer);
    const status = Number(code) === 0 ? "success" : "failed";
    const numericCode = Number(code);
    const safeCode = Number.isFinite(numericCode) ? numericCode : null;
    const safeSignal = signal ? String(signal) : "";
    const errorMessage = status === "success"
      ? ""
      : safeCode !== null
        ? `bot-jobs exited with code ${safeCode}.`
        : safeSignal
          ? `bot-jobs exited via signal ${safeSignal}.`
          : "bot-jobs exited unexpectedly.";
    void finalizeRun(
      {
        status,
        exitCode: safeCode,
        signal: safeSignal,
        error: errorMessage,
      },
      `finished status=${status} code=${String(code)} signal=${String(signal || "")}`,
    );
  });

  return { accepted: true, run: toRunPublic(activeRun) };
}

async function startDocmanToolRun(rawPayload) {
  if (docmanActiveRun) {
    return { accepted: false, reason: "already_running", run: toDocmanRunPublic(docmanActiveRun) };
  }

  let payload = sanitizeDocmanRunPayload(rawPayload);
  if (!payload.docmanUsername || !payload.docmanPassword) {
    try {
      payload = await hydrateDocmanRunPayloadFromSql(payload);
    } catch (error) {
      await appendServerLog(`[${nowIso()}] docman SQL credential lookup failed ods=${payload.odsCode || "n/a"}: ${String(error?.message || error)}`);
    }
  }
  validateDocmanRunPayload(payload);

  if (!existsSync(DOCMAN_TOOL_DIR)) {
    throw new Error(`docman-tool directory not found: ${DOCMAN_TOOL_DIR}`);
  }
  const launch = buildDocmanToolLaunch(payload);
  const onboardingInputFolderName = payload.action === "onboarding"
    ? resolveDocmanOnboardingInputFolderName(payload)
    : "";
  const runId = createRunId();
  const startedAt = nowIso();
  const child = spawn(process.execPath, launch.args, {
    cwd: launch.cwd,
    env: {
      ...buildDocmanToolEnv(),
      ...(launch.env || {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  docmanActiveRun = {
    runId,
    startedAt,
    endedAt: "",
    status: "running",
    action: payload.action,
    practiceName: payload.practiceName,
    odsCode: payload.odsCode,
    groupName: payload.groupName,
    usernamesCount: payload.usernames.length,
    onboardingInputFolderName,
    exitCode: null,
    signal: "",
    error: "",
    pid: child.pid || null,
    summaryTail: [],
    logLines: [],
    resultData: null,
  };
  await appendServerLog(
    `[${nowIso()}] [docman:${runId}] started action=${payload.action} practice=${payload.practiceName} ods=${payload.odsCode || "n/a"}${onboardingInputFolderName ? ` inputFolder=${onboardingInputFolderName}` : ""}`,
  );
  await writeDocmanRunState();

  let runFinalized = false;
  const finalizeRun = async (result, logMessage) => {
    if (runFinalized) return;
    runFinalized = true;

    const endedAt = nowIso();
    const baseRun = docmanActiveRun?.runId === runId
      ? docmanActiveRun
      : {
          runId,
          startedAt,
          endedAt: "",
          status: "running",
          action: payload.action,
          practiceName: payload.practiceName,
          odsCode: payload.odsCode,
          groupName: payload.groupName,
          usernamesCount: payload.usernames.length,
          onboardingInputFolderName,
          exitCode: null,
          signal: "",
          error: "",
          pid: child.pid || null,
          summaryTail: [],
          logLines: [],
          resultData: null,
        };
    const summaryLines = sanitizeStringList(baseRun.summaryTail, 10, 240);
    const fallbackSummary = result.status === "success"
      ? `${getDocmanActionLabel(payload.action)} completed.`
      : `${getDocmanActionLabel(payload.action)} failed.`;

    lastDocmanRun = {
      ...baseRun,
      endedAt,
      ...result,
      summaryLines: summaryLines.length ? summaryLines : [fallbackSummary],
      logLines: sanitizeStringList(baseRun.logLines || baseRun.summaryTail, 120, 240),
      resultData: sanitizeDocmanResultData(baseRun.resultData),
    };
    docmanActiveRun = null;
    if (logMessage) {
      appendServerLog(`[${nowIso()}] [docman:${runId}] ${logMessage}`).catch(() => undefined);
    }
    writeDocmanRunState().catch(() => undefined);
  };

  const killTimer = setTimeout(() => {
    void finalizeRun(
      {
        status: "failed",
        exitCode: null,
        signal: "SIGTERM",
        error: `docman-tool exceeded timeout (${DOCMAN_TOOL_TIMEOUT_MINUTES}m) and was terminated.`,
      },
      `timed out after ${DOCMAN_TOOL_TIMEOUT_MINUTES}m; sent SIGTERM`,
    );
    try {
      child.kill("SIGTERM");
    } catch {
      // Ignore kill errors.
    }
  }, DOCMAN_TOOL_TIMEOUT_MS);
  if (typeof killTimer.unref === "function") {
    killTimer.unref();
  }

  child.stdout?.on("data", (chunk) => {
    const rawText = String(chunk || "");
    if (docmanActiveRun?.runId === runId) {
      appendDocmanRunTail(docmanActiveRun, rawText, "stdout");
    }
    const text = rawText.replace(/\r?\n$/, "");
    appendServerLog(`[${nowIso()}] [docman:${runId}] [stdout] ${text}`).catch(() => undefined);
  });

  child.stderr?.on("data", (chunk) => {
    const rawText = String(chunk || "");
    if (docmanActiveRun?.runId === runId) {
      appendDocmanRunTail(docmanActiveRun, rawText, "stderr");
    }
    const text = rawText.replace(/\r?\n$/, "");
    appendServerLog(`[${nowIso()}] [docman:${runId}] [stderr] ${text}`).catch(() => undefined);
  });

  child.on("error", (error) => {
    clearTimeout(killTimer);
    const errMessage = String(error?.message || "Unknown process error");
    void finalizeRun(
      {
        status: "failed",
        error: errMessage,
      },
      `process error: ${errMessage}`,
    );
  });

  child.on("exit", (code, signal) => {
    clearTimeout(killTimer);
    const status = Number(code) === 0 ? "success" : "failed";
    const numericCode = Number(code);
    const safeCode = Number.isFinite(numericCode) ? numericCode : null;
    const safeSignal = signal ? String(signal) : "";
    const errorMessage = status === "success"
      ? ""
      : safeCode !== null
        ? `docman-tool exited with code ${safeCode}.`
        : safeSignal
          ? `docman-tool exited via signal ${safeSignal}.`
          : "docman-tool exited unexpectedly.";
    void finalizeRun(
      {
        status,
        exitCode: safeCode,
        signal: safeSignal,
        error: errorMessage,
      },
      `finished status=${status} code=${String(code)} signal=${String(signal || "")}`,
    );
  });

  return { accepted: true, run: toDocmanRunPublic(docmanActiveRun) };
}

await mkdir(LOG_DIR, { recursive: true });
await mkdir(STATE_DIR, { recursive: true });
await mkdir(BOT_JOBS_REPORTS_DIR, { recursive: true });
await loadLastRunState();
await loadDocmanRunState();
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

  // /health is exempt so the extension can distinguish "wrong address, no
  // server there at all" from "right address, wrong/missing secret" - it
  // only returns non-sensitive status booleans, not secrets or data.
  if (TRIGGER_SHARED_SECRET && path !== "/health") {
    const providedSecret = String(req.headers[TRIGGER_SECRET_HEADER] || "").trim();
    if (providedSecret !== TRIGGER_SHARED_SECRET) {
      sendJson(res, 401, origin, {
        ok: false,
        error: "Missing or incorrect trigger server secret.",
      });
      return;
    }
  }

  try {
    if (method === "GET" && path === "/health") {
      sendJson(res, 200, origin, {
        ok: true,
        running: Boolean(activeRun),
        activeRun: toRunPublic(activeRun),
        lastRun: toRunPublic(lastRun),
        linear: {
          configured: Boolean(LINEAR_API_KEY && LINEAR_TEAM_KEY),
          teamKey: LINEAR_TEAM_KEY || "",
        },
        docman: {
          configured: Boolean(DOCMAN_TOOL_DIR),
          toolDir: DOCMAN_TOOL_DIR,
          running: Boolean(docmanActiveRun),
          activeRun: toDocmanRunPublic(docmanActiveRun),
          lastRun: toDocmanRunPublic(lastDocmanRun),
        },
        slack: {
          configured: Boolean(SLACK_BOT_TOKEN),
        },
        database: getSqlPublicConfig(),
        serverTime: nowIso(),
      });
      return;
    }

    if (method === "GET" && path === "/practice/lookup") {
      try {
        const query = normalizePracticeLookupQuery(url.searchParams.get("query"));
        const limit = Number.parseInt(String(url.searchParams.get("limit") || "12"), 10);
        const practices = await lookupPracticesFromSql(query, { includeSecrets: false, limit });
        sendJson(res, 200, origin, {
          ok: true,
          practice: practices[0] || null,
          practices,
          database: getSqlPublicConfig(),
          serverTime: nowIso(),
        });
      } catch (error) {
        const message = sanitizeSingleLine(error?.message, 320) || "Could not look up practice from Cloud SQL.";
        const statusCode = /not configured/i.test(message) ? 503 : /query is required/i.test(message) ? 400 : 502;
        sendJson(res, statusCode, origin, {
          ok: false,
          error: message,
          database: getSqlPublicConfig(),
        });
      }
      return;
    }

    if (method === "GET" && path === "/practice/live-counts") {
      try {
        const odsCode = normalizeOdsCode(url.searchParams.get("ods") || url.searchParams.get("odsCode"));
        const counts = await lookupPracticeLiveCountsFromSql(odsCode);
        sendJson(res, 200, origin, {
          ok: true,
          odsCode,
          counts,
          database: getSqlPublicConfig(),
          serverTime: nowIso(),
        });
      } catch (error) {
        const message = sanitizeSingleLine(error?.message, 320) || "Could not look up practice live counts from Cloud SQL.";
        const statusCode = /not configured/i.test(message) ? 503 : /valid ods/i.test(message) ? 400 : 502;
        sendJson(res, statusCode, origin, {
          ok: false,
          error: message,
          database: getSqlPublicConfig(),
        });
      }
      return;
    }

    if (method === "GET" && path === "/practice/secret") {
      try {
        const odsCode = normalizeOdsCode(url.searchParams.get("ods") || url.searchParams.get("odsCode"));
        const field = sanitizeSingleLine(url.searchParams.get("field"), 80);
        const secret = await lookupPracticeSecretFromSql(odsCode, field);
        sendJson(res, 200, origin, {
          ok: true,
          odsCode,
          field: secret.field,
          value: secret.value,
          present: secret.present,
          serverTime: nowIso(),
        });
      } catch (error) {
        const message = sanitizeSingleLine(error?.message, 320) || "Could not load practice secret from Cloud SQL.";
        const statusCode = /not configured/i.test(message) ? 503 : /valid ods|unsupported/i.test(message) ? 400 : /not found/i.test(message) ? 404 : 502;
        sendJson(res, statusCode, origin, {
          ok: false,
          error: message,
        });
      }
      return;
    }

    if (method === "GET" && path === "/uuid-status") {
      try {
        const lookup = await runUuidStatusLookup(url.searchParams.get("uuid"));
        sendJson(res, 200, origin, {
          ok: true,
          lookup,
        });
      } catch (error) {
        const message = sanitizeSingleLine(error?.message, 320) || "Could not look up UUID status.";
        const statusCode = /Cloud SQL UUID lookup is not configured/i.test(message)
          ? 503
          : /Invalid or missing UUID/i.test(message)
            ? 400
            : 502;
        sendJson(res, statusCode, origin, {
          ok: false,
          error: message,
        });
      }
      return;
    }

    if (method === "GET" && path === "/slack/targets") {
      try {
        const forceRefresh = ["1", "true", "yes"].includes(
          sanitizeSingleLine(url.searchParams.get("force"), 12).toLowerCase(),
        );
        const targets = await fetchSlackWorkspaceTargets({ forceRefresh });
        sendJson(res, 200, origin, {
          ok: true,
          targets,
        });
      } catch (error) {
        sendJson(res, 502, origin, {
          ok: false,
          error: sanitizeSingleLine(error?.message, 260) || "Could not sync Slack workspace targets.",
        });
      }
      return;
    }

    if (method === "POST" && path === "/trigger-linear") {
      const body = await parseJsonBody(req).catch(() => ({}));
      const dryRun = Boolean(body?.dryRun);
      const slack = sanitizeLinearSlackPayload(body?.slack);
      const result = await startBotJobsRun({
        dryRun,
        slack,
        entryScript: BOT_JOBS_ENTRY,
        runType: "trigger",
      });
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

    if (method === "POST" && path === "/trigger-linear-reconcile") {
      const body = await parseJsonBody(req).catch(() => ({}));
      const dryRun = Boolean(body?.dryRun);
      const slack = sanitizeLinearSlackPayload(body?.slack);
      const forceLegacy = ["1", "true", "yes"].includes(
        sanitizeSingleLine(body?.legacy || body?.forceLegacy, 12).toLowerCase(),
      );
      const useSqlReconcile = SQL_RECONCILE_ENABLED && isSqlLookupConfigured() && !forceLegacy;
      const result = useSqlReconcile
        ? await startSqlReconcileRun({ dryRun, slack })
        : await startBotJobsRun({
            dryRun,
            slack,
            entryScript: BOT_JOBS_RECONCILE_ENTRY,
            runType: "reconcile",
          });
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

    if (method === "POST" && path === "/docman/run") {
      let payload = null;
      try {
        payload = sanitizeDocmanRunPayload(await parseJsonBody(req).catch(() => ({})));
      } catch (error) {
        sendJson(res, 400, origin, {
          ok: false,
          error: sanitizeSingleLine(error?.message, 260) || "Invalid Docman run payload.",
        });
        return;
      }

      try {
        const result = await startDocmanToolRun(payload);
        if (!result.accepted) {
          sendJson(res, 409, origin, {
            ok: false,
            running: true,
            error: "A Docman tool run is already in progress.",
            run: result.run,
          });
          return;
        }

        sendJson(res, 202, origin, {
          ok: true,
          accepted: true,
          run: result.run,
        });
      } catch (error) {
        await appendServerLog(`[${nowIso()}] docman run failed: ${String(error?.message || error)}`);
        const message = sanitizeSingleLine(error?.message, 260) || "Could not start docman-tool.";
        const statusCode = /missing|invalid|required|requires/i.test(message) ? 400 : 502;
        sendJson(res, statusCode, origin, {
          ok: false,
          error: message,
        });
      }
      return;
    }

    if (method === "GET" && path === "/docman/status") {
      sendJson(res, 200, origin, {
        ok: true,
        running: Boolean(docmanActiveRun),
        activeRun: toDocmanRunPublic(docmanActiveRun),
        lastRun: toDocmanRunPublic(lastDocmanRun),
        serverTime: nowIso(),
      });
      return;
    }

    if (method === "POST" && path === "/service/restart") {
      if (activeRun || docmanActiveRun) {
        sendJson(res, 409, origin, {
          ok: false,
          running: true,
          error: "A background run is in progress. Wait for it to finish before restarting the trigger service.",
        });
        return;
      }
      if (!supportsSelfRestart()) {
        sendJson(res, 409, origin, {
          ok: false,
          running: false,
          error: "Self-restart is only available when the trigger service is running as a managed background service.",
        });
        return;
      }

      scheduleServerRestart("panel");
      sendJson(res, 202, origin, {
        ok: true,
        restarting: true,
        message: "Restart requested. The local trigger service should be back in a moment.",
      });
      return;
    }

    if (method === "POST" && path === "/linear/create-issue") {
      const body = await parseJsonBody(req).catch(() => ({}));
      let payload = null;
      try {
        payload = sanitizeLinearIssuePayload(body);
        validateLinearIssuePayload(payload);
      } catch (error) {
        sendJson(res, 400, origin, {
          ok: false,
          error: sanitizeSingleLine(error?.message, 260) || "Invalid issue payload.",
        });
        return;
      }

      try {
        const created = await createLinearIssue(payload);
        const slack = created?.duplicate
          ? { attempted: false, success: false, skipped: true }
          : await sendSlackIssueNotification(payload, created);
        const reopenSummary = created?.duplicate
          ? ` reopen=${created.reopened ? created.reopenStateName || "yes" : created.reopenError ? `failed:${created.reopenError}` : created.reopenSkipped || "not_changed"}`
          : "";
        await appendServerLog(
          created?.duplicate
            ? `[${nowIso()}] linear issue duplicate reused ${created.issue.identifier} doc=${payload.documentId || "n/a"} job=${payload.failedJobId || "n/a"} dedupe=${payload.dedupeKey || "n/a"}${reopenSummary}`
            : `[${nowIso()}] linear issue created ${created.issue.identifier} doc=${payload.documentId} job=${payload.failedJobId || "n/a"}`,
        );
        if (slack?.attempted) {
          if (slack.success) {
            await appendServerLog(
              `[${nowIso()}] slack notification sent targetType=${slack.targetType} target=${slack.target || "n/a"} channel=${slack.channel || "n/a"}`,
            );
          } else {
            await appendServerLog(
              `[${nowIso()}] slack notification failed targetType=${slack.targetType} target=${slack.target || "n/a"} error=${slack.error || "unknown"}`,
            );
          }
        }

        sendJson(res, created?.duplicate ? 200 : 201, origin, {
          ok: true,
          duplicate: Boolean(created?.duplicate),
          reopened: Boolean(created?.reopened),
          reopenStateName: sanitizeSingleLine(created?.reopenStateName, 120),
          reopenError: sanitizeSingleLine(created?.reopenError, 260),
          reopenSkipped: sanitizeSingleLine(created?.reopenSkipped, 120),
          issue: created.issue,
          team: {
            key: created.team.key,
            name: created.team.name,
          },
          slack,
        });
      } catch (error) {
        await appendServerLog(`[${nowIso()}] linear issue create failed: ${String(error?.message || error)}`);
        sendJson(res, 502, origin, {
          ok: false,
          error: sanitizeSingleLine(error?.message, 260) || "Could not create Linear issue.",
        });
      }
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
