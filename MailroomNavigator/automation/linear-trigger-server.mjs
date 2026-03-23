import { config as loadDotenv } from "dotenv";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
const SLACK_BOT_TOKEN = String(
  process.env.SLACK_BOT_TOKEN
    || process.env.LINEAR_SLACK_BOT_TOKEN
    || "",
).trim();
const SLACK_API_BASE_URL = "https://slack.com/api";
const SLACK_SYNC_MEMBER_ONLY = String(process.env.SLACK_SYNC_MEMBER_ONLY || "1")
  .trim()
  .toLowerCase() !== "0";
const SUPERBLOCKS_UUID_LOOKUP_URL = sanitizeHttpUrl(
  process.env.SUPERBLOCKS_UUID_LOOKUP_URL
    || "",
);
const SUPERBLOCKS_UUID_LOOKUP_TOKEN = sanitizeSingleLine(
  process.env.SUPERBLOCKS_UUID_LOOKUP_TOKEN
    || "",
  4096,
);
const SUPERBLOCKS_UUID_LOOKUP_TOKEN_HEADER = sanitizeSingleLine(
  process.env.SUPERBLOCKS_UUID_LOOKUP_TOKEN_HEADER
    || "Authorization",
  120,
) || "Authorization";
const SUPERBLOCKS_UUID_LOOKUP_METHOD = String(process.env.SUPERBLOCKS_UUID_LOOKUP_METHOD || "POST")
  .trim()
  .toUpperCase() === "GET" ? "GET" : "POST";
const SUPERBLOCKS_UUID_LOOKUP_UUID_FIELD = sanitizeSingleLine(
  process.env.SUPERBLOCKS_UUID_LOOKUP_UUID_FIELD
    || "uuid",
  120,
) || "uuid";
const SUPERBLOCKS_UUID_LOOKUP_STATUS_PATH = sanitizeSingleLine(
  process.env.SUPERBLOCKS_UUID_LOOKUP_STATUS_PATH
    || "status",
  240,
);
const SUPERBLOCKS_UUID_LOOKUP_DETAIL_PATH = sanitizeSingleLine(
  process.env.SUPERBLOCKS_UUID_LOOKUP_DETAIL_PATH
    || "",
  240,
);
const SUPERBLOCKS_UUID_LOOKUP_TIMEOUT_MS = (() => {
  const parsed = Number.parseInt(String(process.env.SUPERBLOCKS_UUID_LOOKUP_TIMEOUT_MS || "12000"), 10);
  if (!Number.isFinite(parsed)) return 12000;
  return Math.min(60000, Math.max(1500, parsed));
})();
const ACCESS_CONTROL_OWNER_EMAIL = normalizeEmail(
  process.env.MAILROOMNAV_OWNER_EMAIL
    || "nur.siddique@dyad.net",
);
const ACCESS_CONTROL_SLACK_TARGET_TYPE = normalizeSlackTargetType(
  process.env.MAILROOMNAV_ACCESS_CONTROL_SLACK_TARGET_TYPE
    || process.env.MAILROOMNAV_ACCESS_CONTROL_ALERT_TARGET_TYPE
    || "channel",
);
const ACCESS_CONTROL_SLACK_TARGET = sanitizeSingleLine(
  process.env.MAILROOMNAV_ACCESS_CONTROL_SLACK_TARGET
    || process.env.MAILROOMNAV_ACCESS_CONTROL_ALERT_TARGET
    || "",
  120,
).replace(/^[@#]/, "");
const ACCESS_CONTROL_SHARED_KEY = sanitizeSingleLine(
  process.env.MAILROOMNAV_ACCESS_CONTROL_SHARED_KEY
    || "",
  240,
);
const ACCESS_CONTROL_ALERT_COOLDOWN_MINUTES = (() => {
  const parsed = Number.parseInt(String(process.env.MAILROOMNAV_ACCESS_CONTROL_ALERT_COOLDOWN_MINUTES || "60"), 10);
  if (!Number.isFinite(parsed)) return 60;
  return Math.min(24 * 60, Math.max(1, parsed));
})();
const ACCESS_CONTROL_ALERT_COOLDOWN_MS = ACCESS_CONTROL_ALERT_COOLDOWN_MINUTES * 60 * 1000;
const ACCESS_CONTROL_CACHE_TTL_MS = 30 * 1000;
const LOG_DIR = String(process.env.LINEAR_TRIGGER_LOG_DIR || join(REPO_ROOT, "logs"));
const STATE_DIR = String(process.env.LINEAR_TRIGGER_STATE_DIR || join(REPO_ROOT, ".automation-state"));
const ACCESS_CONTROL_STATE_PATH = String(
  process.env.MAILROOMNAV_ACCESS_CONTROL_STATE_FILE
    || join(STATE_DIR, "mailroomnav-access-control.json"),
);
const SLACK_TARGETS_CACHE_PATH = join(STATE_DIR, "slack-workspace-targets.json");
const SERVER_LOG_PATH = join(LOG_DIR, "linear-trigger-server.log");
const LAST_RUN_STATE_PATH = join(STATE_DIR, "linear-trigger-last-run.json");
const BOT_JOBS_REPORTS_DIR = join(STATE_DIR, "reports");
const SLACK_TARGETS_CACHE_TTL_MS = 10 * 60 * 1000;
const SUPERBLOCKS_LOOKUP_CACHE_TTL_MS = 15 * 60 * 1000;

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
let resolvedLinearTeam = null;
const accessControlAlertSentAt = new Map();
let accessControlCache = {
  loadedAt: 0,
  policy: null,
};
let slackTargetsCache = {
  loadedAt: 0,
  targets: null,
};
const superblocksLookupCache = new Map();
const superblocksLookupInFlight = new Map();

function nowIso() {
  return new Date().toISOString();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
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

function normalizeEmail(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(normalized)) return "";
  return normalized;
}

function extractUuid(value) {
  const match = sanitizeSingleLine(value, 240).match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i);
  return match ? match[0].toLowerCase() : "";
}

function getValueByPath(value, path) {
  const normalizedPath = sanitizeSingleLine(path, 240);
  if (!normalizedPath) return undefined;

  const segments = normalizedPath
    .split(".")
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (!segments.length) return undefined;

  let current = value;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      const index = Number.parseInt(segment, 10);
      if (!Number.isFinite(index) || index < 0 || index >= current.length) return undefined;
      current = current[index];
      continue;
    }

    if (!current || typeof current !== "object" || !(segment in current)) {
      return undefined;
    }
    current = current[segment];
  }

  return current;
}

function pickFirstPresentValue(value, paths = []) {
  for (const path of paths) {
    const candidate = getValueByPath(value, path);
    if (candidate === undefined || candidate === null) continue;
    if (typeof candidate === "string") {
      const normalized = sanitizeSingleLine(candidate, 320);
      if (normalized) return { path, value: normalized };
      continue;
    }
    if (typeof candidate === "number" || typeof candidate === "boolean") {
      return { path, value: String(candidate) };
    }
  }
  return { path: "", value: "" };
}

const ACCESS_CONTROL_FEATURE_CATALOG = [
  { key: "practice_navigator", label: "Navigator", description: "Practice Navigator, practice links, live counts, and related admin pages." },
  { key: "job_panel", label: "Job Panel", description: "Quick document search, job status checks, and bulk job/admin links." },
  { key: "email_formatter", label: "Email Formatter", description: "Use the Email Formatter tool from Bookmarklet Tools." },
  { key: "linear_create_issue", label: "Create Linear Issue", description: "Manual Linear issue creation from the panel or document hover actions." },
  { key: "linear_trigger", label: "Trigger Linear", description: "Run automated bot-jobs issue creation." },
  { key: "linear_reconcile", label: "Reconcile Linear", description: "Mark resolved bot-job issues done in Linear." },
  { key: "slack_sync", label: "Slack Sync", description: "Sync Slack workspace targets and send Slack notifications from the Linear panel." },
  { key: "workflow_groups", label: "Workflow Groups", description: "Use the Custom Workflow Groups tool from Bookmarklet Tools." },
  { key: "bookmarklet_tools", label: "Bookmarklet Tools", description: "Use UUID picker, Docman group discovery, and related modal tools." },
  { key: "dashboard_hover_tools", label: "Dashboard Hover Tools", description: "Use Jobs/Admin/Issue hover actions on BetterLetter dashboards." },
];
const ACCESS_CONTROL_FEATURE_KEYS = ACCESS_CONTROL_FEATURE_CATALOG.map((feature) => feature.key);
const ACCESS_CONTROL_FEATURE_KEY_SET = new Set(ACCESS_CONTROL_FEATURE_KEYS);
const ACCESS_REQUEST_STATUS_SET = new Set(["pending", "approved", "rejected"]);
const MAX_ACCESS_REQUEST_IPS = 8;

function normalizeAccessRole(role) {
  const normalized = sanitizeSingleLine(role, 40).toLowerCase();
  if (normalized === "owner") return "owner";
  if (normalized === "admin") return "admin";
  return "user";
}

function normalizeAccessFeatures(rawFeatures = []) {
  if (!Array.isArray(rawFeatures)) return [];
  const unique = new Set();
  rawFeatures.forEach((featureKey) => {
    const normalized = sanitizeSingleLine(featureKey, 64);
    if (!ACCESS_CONTROL_FEATURE_KEY_SET.has(normalized)) return;
    unique.add(normalized);
  });
  return [...unique];
}

function buildAccessFeatureMap(rawFeatures = [], forceAll = false) {
  const granted = forceAll ? ACCESS_CONTROL_FEATURE_KEYS : normalizeAccessFeatures(rawFeatures);
  const grantedSet = new Set(granted);
  return Object.fromEntries(ACCESS_CONTROL_FEATURE_KEYS.map((featureKey) => [featureKey, grantedSet.has(featureKey)]));
}

function sanitizeAccessUserRecord(rawUser = null, fallbackEmail = "") {
  const email = normalizeEmail(rawUser?.email || fallbackEmail);
  if (!email) return null;
  const role = normalizeAccessRole(rawUser?.role);
  const features = role === "owner"
    ? [...ACCESS_CONTROL_FEATURE_KEYS]
    : normalizeAccessFeatures(rawUser?.features);
  return {
    email,
    role,
    features,
    createdAt: sanitizeSingleLine(rawUser?.createdAt, 80),
    updatedAt: sanitizeSingleLine(rawUser?.updatedAt, 80),
    createdBy: normalizeEmail(rawUser?.createdBy),
    updatedBy: normalizeEmail(rawUser?.updatedBy),
  };
}

function normalizeAccessRequestStatus(value) {
  const normalized = sanitizeSingleLine(value, 40).toLowerCase();
  return ACCESS_REQUEST_STATUS_SET.has(normalized) ? normalized : "pending";
}

function normalizeClientIp(value) {
  const raw = sanitizeSingleLine(value, 120);
  if (!raw) return "";
  if (raw.startsWith("::ffff:")) return raw.slice(7);
  if (raw === "::1") return "127.0.0.1";
  return raw;
}

function sanitizeAccessRequestRecord(rawRequest = null, fallbackEmail = "") {
  const email = normalizeEmail(rawRequest?.email || fallbackEmail);
  if (!email || email === ACCESS_CONTROL_OWNER_EMAIL) return null;

  const ipValues = Array.isArray(rawRequest?.ipAddresses) ? rawRequest.ipAddresses : [];
  const ipAddresses = [];
  const seenIps = new Set();
  ipValues.forEach((value) => {
    const normalizedIp = normalizeClientIp(value);
    if (!normalizedIp || seenIps.has(normalizedIp)) return;
    seenIps.add(normalizedIp);
    ipAddresses.push(normalizedIp);
  });

  const requestCount = Math.max(
    0,
    Number.parseInt(String(rawRequest?.requestCount ?? "0"), 10) || 0,
  );

  return {
    email,
    status: normalizeAccessRequestStatus(rawRequest?.status),
    requestedFeatures: normalizeAccessFeatures(rawRequest?.requestedFeatures),
    note: sanitizeMultiline(rawRequest?.note, 1200),
    firstSeenAt: sanitizeSingleLine(rawRequest?.firstSeenAt, 80),
    lastSeenAt: sanitizeSingleLine(rawRequest?.lastSeenAt, 80),
    requestedAt: sanitizeSingleLine(rawRequest?.requestedAt, 80),
    updatedAt: sanitizeSingleLine(rawRequest?.updatedAt, 80),
    reviewedAt: sanitizeSingleLine(rawRequest?.reviewedAt, 80),
    reviewedBy: normalizeEmail(rawRequest?.reviewedBy),
    reviewNote: sanitizeMultiline(rawRequest?.reviewNote, 600),
    requestCount,
    lastIp: normalizeClientIp(rawRequest?.lastIp),
    ipAddresses: ipAddresses.slice(0, MAX_ACCESS_REQUEST_IPS),
    lastUserAgent: sanitizeSingleLine(rawRequest?.lastUserAgent, 240),
  };
}

function sanitizeAccessControlPolicy(rawPolicy = null) {
  const users = {};
  const sourceUsers = rawPolicy?.users && typeof rawPolicy.users === "object" ? rawPolicy.users : {};
  Object.entries(sourceUsers).forEach(([emailKey, rawUser]) => {
    const sanitizedUser = sanitizeAccessUserRecord(rawUser, emailKey);
    if (!sanitizedUser || sanitizedUser.role === "owner") return;
    users[sanitizedUser.email] = sanitizedUser;
  });

  const requests = {};
  const sourceRequests = rawPolicy?.requests && typeof rawPolicy.requests === "object" ? rawPolicy.requests : {};
  Object.entries(sourceRequests).forEach(([emailKey, rawRequest]) => {
    const sanitizedRequest = sanitizeAccessRequestRecord(rawRequest, emailKey);
    if (!sanitizedRequest) return;
    requests[sanitizedRequest.email] = sanitizedRequest;
  });

  return {
    version: 1,
    ownerEmail: ACCESS_CONTROL_OWNER_EMAIL,
    initializedAt: sanitizeSingleLine(rawPolicy?.initializedAt, 80),
    updatedAt: sanitizeSingleLine(rawPolicy?.updatedAt, 80),
    users,
    requests,
  };
}

function buildDefaultAccessPolicy() {
  const now = nowIso();
  return sanitizeAccessControlPolicy({
    initializedAt: now,
    updatedAt: now,
    users: {},
  });
}

function serializeAccessControlPolicy(policy) {
  const normalizedPolicy = sanitizeAccessControlPolicy(policy);
  return JSON.stringify(normalizedPolicy, null, 2);
}

async function readAccessControlPolicyFile() {
  try {
    const raw = await readFile(ACCESS_CONTROL_STATE_PATH, "utf8");
    const parsed = raw.trim() ? JSON.parse(raw) : null;
    return {
      exists: true,
      policy: parsed ? sanitizeAccessControlPolicy(parsed) : buildDefaultAccessPolicy(),
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        exists: false,
        policy: buildDefaultAccessPolicy(),
      };
    }
    throw new Error(`Could not read Access Control store at ${ACCESS_CONTROL_STATE_PATH}: ${sanitizeSingleLine(error?.message, 220) || "unknown error"}`);
  }
}

async function saveAccessControlPolicyToFile(policy) {
  const normalizedPolicy = sanitizeAccessControlPolicy(policy);
  await mkdir(dirname(ACCESS_CONTROL_STATE_PATH), { recursive: true });
  await writeFile(
    ACCESS_CONTROL_STATE_PATH,
    `${serializeAccessControlPolicy(normalizedPolicy)}\n`,
    "utf8",
  );
  accessControlCache = {
    loadedAt: Date.now(),
    policy: normalizedPolicy,
  };
  return normalizedPolicy;
}

async function loadAccessControlStore({ forceRefresh = false, ensureExists = true } = {}) {
  const now = Date.now();
  if (
    !forceRefresh
    && accessControlCache?.policy
    && now - Number(accessControlCache.loadedAt || 0) < ACCESS_CONTROL_CACHE_TTL_MS
  ) {
    return {
      policy: sanitizeAccessControlPolicy(accessControlCache.policy),
      exists: true,
      path: ACCESS_CONTROL_STATE_PATH,
    };
  }

  const stored = await readAccessControlPolicyFile();
  const policy = stored.exists || !ensureExists
    ? stored.policy
    : await saveAccessControlPolicyToFile(stored.policy);

  accessControlCache = {
    loadedAt: Date.now(),
    policy,
  };

  return {
    policy,
    exists: stored.exists,
    path: ACCESS_CONTROL_STATE_PATH,
  };
}

function listManagedAccessUsers(policy) {
  return Object.values(policy?.users || {})
    .map((user) => sanitizeAccessUserRecord(user))
    .filter(Boolean)
    .sort((a, b) => {
      if (a.role !== b.role) return a.role === "admin" ? -1 : 1;
      return a.email.localeCompare(b.email);
    });
}

function listAccessRequests(policy) {
  return Object.values(policy?.requests || {})
    .map((request) => sanitizeAccessRequestRecord(request))
    .filter(Boolean)
    .sort((a, b) => {
      const statusOrder = { pending: 0, rejected: 1, approved: 2 };
      const aOrder = statusOrder[a.status] ?? 9;
      const bOrder = statusOrder[b.status] ?? 9;
      if (aOrder !== bOrder) return aOrder - bOrder;
      const aTime = new Date(a.requestedAt || a.lastSeenAt || a.updatedAt || 0).getTime();
      const bTime = new Date(b.requestedAt || b.lastSeenAt || b.updatedAt || 0).getTime();
      return bTime - aTime;
    });
}

function buildAccessControlManagementPayload(policy, alert = null) {
  const users = listManagedAccessUsers(policy);
  const requests = listAccessRequests(policy);
  return {
    ownerEmail: ACCESS_CONTROL_OWNER_EMAIL,
    users,
    requests,
    featureCatalog: ACCESS_CONTROL_FEATURE_CATALOG,
    storage: "file",
    storePath: ACCESS_CONTROL_STATE_PATH,
    policyUpdatedAt: sanitizeSingleLine(policy?.updatedAt, 80),
    counts: {
      users: users.length,
      pendingRequests: requests.filter((request) => request.status === "pending").length,
      rejectedRequests: requests.filter((request) => request.status === "rejected").length,
      approvedHistory: requests.filter((request) => request.status === "approved").length,
    },
    alert: sanitizeSlackNotificationResult(alert),
  };
}

function buildResolvedAccess(email, policy) {
  const normalizedEmail = normalizeEmail(email);
  const normalizedPolicy = sanitizeAccessControlPolicy(policy);

  if (!normalizedEmail) {
    return {
      enabled: true,
      initialized: Boolean(normalizedPolicy.initializedAt),
      allowed: false,
      isOwner: false,
      canManageUsers: false,
      role: "",
      email: "",
      reason: "Could not detect the current BetterLetter user email from your BetterLetter session.",
      features: buildAccessFeatureMap([], false),
    };
  }

  if (normalizedEmail === ACCESS_CONTROL_OWNER_EMAIL) {
    return {
      enabled: true,
      initialized: true,
      allowed: true,
      isOwner: true,
      canManageUsers: true,
      role: "owner",
      email: normalizedEmail,
      reason: "",
      features: buildAccessFeatureMap([], true),
    };
  }

  const managedUser = sanitizeAccessUserRecord(normalizedPolicy.users?.[normalizedEmail], normalizedEmail);
  const accessRequest = sanitizeAccessRequestRecord(normalizedPolicy.requests?.[normalizedEmail], normalizedEmail);
  if (!managedUser) {
    let reason = "You do not have MailroomNavigator access. Use Request Access in the panel or ask Nur to add your BetterLetter email.";
    if (accessRequest?.status === "pending" && accessRequest?.requestedAt) {
      reason = "Your MailroomNavigator access request is pending review.";
    } else if (accessRequest?.status === "rejected") {
      reason = "Your MailroomNavigator access request was rejected. Contact Nur if this should be reviewed again.";
    }
    return {
      enabled: true,
      initialized: true,
      allowed: false,
      isOwner: false,
      canManageUsers: false,
      role: "",
      email: normalizedEmail,
      reason,
      features: buildAccessFeatureMap([], false),
      requestStatus: accessRequest?.status || "",
      requestRequestedAt: accessRequest?.requestedAt || "",
      requestUpdatedAt: accessRequest?.updatedAt || accessRequest?.lastSeenAt || "",
      requestRequestedFeatures: accessRequest?.requestedFeatures || [],
    };
  }

  const features = buildAccessFeatureMap(managedUser.features, false);
  const hasAnyFeature = Object.values(features).some(Boolean);
  return {
    enabled: true,
    initialized: true,
    allowed: hasAnyFeature,
    isOwner: false,
    canManageUsers: false,
    role: managedUser.role,
    email: normalizedEmail,
    reason: hasAnyFeature ? "" : "Your account exists but no features are enabled yet.",
    features,
  };
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
    slack: sanitizeLinearSlackPayload(rawPayload?.slack),
  };
}

function validateLinearIssuePayload(payload) {
  if (!/^\d+$/.test(payload.documentId)) {
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

async function createLinearIssue(payload) {
  const team = await resolveLinearTeam();
  const effectivePriority = payload.priority > 0 ? payload.priority : getLinearDefaultPriority();

  const issueInput = {
    teamId: team.id,
    title: payload.title,
  };
  if (payload.description) issueInput.description = payload.description;
  if (effectivePriority > 0) issueInput.priority = effectivePriority;

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
  };
}

async function resolveAccessControl(email) {
  if (!ACCESS_CONTROL_OWNER_EMAIL) {
    throw new Error("MAILROOMNAV owner email is not configured.");
  }
  const normalizedEmail = normalizeEmail(email);
  const store = await loadAccessControlStore({ ensureExists: true });
  return {
    access: {
      ...buildResolvedAccess(normalizedEmail, store.policy),
      featureCatalog: ACCESS_CONTROL_FEATURE_CATALOG,
      ownerEmail: ACCESS_CONTROL_OWNER_EMAIL,
      storage: "file",
      storePath: ACCESS_CONTROL_STATE_PATH,
    },
    policy: store.policy,
    storePath: ACCESS_CONTROL_STATE_PATH,
  };
}

async function getAccessControlManagement(actorEmail) {
  const resolved = await resolveAccessControl(actorEmail);
  if (!resolved?.access?.isOwner) {
    throw new Error(resolved?.access?.reason || "Only the MailroomNavigator owner can manage access.");
  }
  const store = await loadAccessControlStore({ forceRefresh: true, ensureExists: true });
  return {
    access: {
      ...resolved.access,
      storage: "file",
      storePath: ACCESS_CONTROL_STATE_PATH,
    },
    management: buildAccessControlManagementPayload(store.policy),
    policy: store.policy,
  };
}

async function exportAccessControlPolicy(actorEmail) {
  const actor = normalizeEmail(actorEmail);
  const { policy } = await getAccessControlManagement(actor);
  return {
    exportedAt: nowIso(),
    ownerEmail: ACCESS_CONTROL_OWNER_EMAIL,
    storage: "file",
    storePath: ACCESS_CONTROL_STATE_PATH,
    policy: sanitizeAccessControlPolicy(policy),
    counts: {
      users: Object.keys(policy?.users || {}).length,
      requests: Object.keys(policy?.requests || {}).length,
    },
  };
}

function normalizePolicyImportMode(value) {
  return String(value || "").trim().toLowerCase() === "replace" ? "replace" : "merge";
}

function buildImportedPolicy(existingPolicy, incomingPolicy, mode = "merge") {
  const existing = sanitizeAccessControlPolicy(existingPolicy);
  const incoming = sanitizeAccessControlPolicy(incomingPolicy);
  const now = nowIso();

  if (mode === "replace") {
    return sanitizeAccessControlPolicy({
      ...incoming,
      initializedAt: incoming.initializedAt || existing.initializedAt || now,
      updatedAt: now,
    });
  }

  return sanitizeAccessControlPolicy({
    ...existing,
    initializedAt: existing.initializedAt || incoming.initializedAt || now,
    updatedAt: now,
    users: {
      ...(existing.users || {}),
      ...(incoming.users || {}),
    },
    requests: {
      ...(existing.requests || {}),
      ...(incoming.requests || {}),
    },
  });
}

async function importAccessControlPolicy({ actorEmail, policy, mode } = {}) {
  const actor = normalizeEmail(actorEmail);
  if (!policy || typeof policy !== "object") {
    throw new Error("Imported policy JSON is required.");
  }

  const { policy: existingPolicy } = await getAccessControlManagement(actor);
  const normalizedMode = normalizePolicyImportMode(mode);
  const nextPolicy = buildImportedPolicy(existingPolicy, policy, normalizedMode);
  const savedPolicy = await saveAccessControlPolicyToFile(nextPolicy);
  await appendServerLog(
    `[${nowIso()}] access control imported mode=${normalizedMode} actor=${actor} users=${Object.keys(savedPolicy.users || {}).length} requests=${Object.keys(savedPolicy.requests || {}).length}`,
  );
  return {
    management: buildAccessControlManagementPayload(savedPolicy),
    importMode: normalizedMode,
    importedAt: nowIso(),
  };
}

function extractClientMetadata(req) {
  const forwardedFor = sanitizeSingleLine(req?.headers?.["x-forwarded-for"], 240);
  const forwardedIp = forwardedFor.split(",").map((part) => normalizeClientIp(part)).find(Boolean);
  const remoteIp = normalizeClientIp(req?.socket?.remoteAddress);
  return {
    clientIp: forwardedIp || remoteIp || "",
    userAgent: sanitizeSingleLine(req?.headers?.["user-agent"], 240),
  };
}

function mergeRecentIps(existingIps = [], nextIp = "") {
  const merged = [];
  const seen = new Set();
  [nextIp, ...(Array.isArray(existingIps) ? existingIps : [])].forEach((ip) => {
    const normalizedIp = normalizeClientIp(ip);
    if (!normalizedIp || seen.has(normalizedIp)) return;
    seen.add(normalizedIp);
    merged.push(normalizedIp);
  });
  return merged.slice(0, MAX_ACCESS_REQUEST_IPS);
}

async function upsertAccessControlRequest({
  email,
  requestedFeatures = [],
  note = "",
  explicitRequest = false,
  clientIp = "",
  userAgent = "",
} = {}) {
  // This request store is the shared review queue for company-wide installs.
  // Both explicit "Request Access" submissions and passive denied-access
  // observations land here so the owner can review the same dataset.
  const targetEmail = normalizeEmail(email);
  if (!targetEmail) {
    throw new Error("A valid BetterLetter email is required.");
  }
  if (targetEmail === ACCESS_CONTROL_OWNER_EMAIL) {
    throw new Error("The owner account already has full MailroomNavigator access.");
  }

  const store = await loadAccessControlStore({ forceRefresh: true, ensureExists: true });
  const existingUser = sanitizeAccessUserRecord(store.policy?.users?.[targetEmail], targetEmail);
  if (existingUser) {
    throw new Error("Your BetterLetter email already has MailroomNavigator access.");
  }

  const now = nowIso();
  const existingRequest = sanitizeAccessRequestRecord(store.policy?.requests?.[targetEmail], targetEmail);
  const nextRequest = sanitizeAccessRequestRecord({
    ...existingRequest,
    email: targetEmail,
    status: explicitRequest ? "pending" : (existingRequest?.status || "pending"),
    requestedFeatures: explicitRequest
      ? normalizeAccessFeatures(requestedFeatures)
      : (existingRequest?.requestedFeatures || []),
    note: explicitRequest
      ? sanitizeMultiline(note, 1200)
      : (existingRequest?.note || ""),
    firstSeenAt: existingRequest?.firstSeenAt || now,
    lastSeenAt: now,
    requestedAt: explicitRequest ? now : (existingRequest?.requestedAt || ""),
    updatedAt: now,
    reviewedAt: explicitRequest ? "" : (existingRequest?.reviewedAt || ""),
    reviewedBy: explicitRequest ? "" : (existingRequest?.reviewedBy || ""),
    reviewNote: explicitRequest ? "" : (existingRequest?.reviewNote || ""),
    requestCount: Math.max(0, Number(existingRequest?.requestCount || 0)) + 1,
    lastIp: normalizeClientIp(clientIp),
    ipAddresses: mergeRecentIps(existingRequest?.ipAddresses || [], clientIp),
    lastUserAgent: sanitizeSingleLine(userAgent, 240) || existingRequest?.lastUserAgent || "",
  }, targetEmail);

  const nextPolicy = sanitizeAccessControlPolicy({
    ...store.policy,
    initializedAt: store.policy?.initializedAt || now,
    updatedAt: now,
    requests: {
      ...(store.policy?.requests || {}),
      [targetEmail]: nextRequest,
    },
  });
  const savedPolicy = await saveAccessControlPolicyToFile(nextPolicy);
  return {
    request: sanitizeAccessRequestRecord(savedPolicy.requests?.[targetEmail], targetEmail),
    policy: savedPolicy,
  };
}

async function reviewAccessControlRequest({ actorEmail, email, action, reviewNote = "" }) {
  const actor = normalizeEmail(actorEmail);
  const targetEmail = normalizeEmail(email);
  const normalizedAction = sanitizeSingleLine(action, 40).toLowerCase();
  if (!targetEmail) {
    throw new Error("A valid BetterLetter email is required.");
  }
  if (!["reject", "archive"].includes(normalizedAction)) {
    throw new Error("Unsupported review action.");
  }

  const { policy } = await getAccessControlManagement(actor);
  const existingRequest = sanitizeAccessRequestRecord(policy?.requests?.[targetEmail], targetEmail);
  if (!existingRequest) {
    throw new Error("That access request does not exist.");
  }

  const nextRequests = { ...(policy?.requests || {}) };
  if (normalizedAction === "archive") {
    delete nextRequests[targetEmail];
  } else {
    nextRequests[targetEmail] = sanitizeAccessRequestRecord({
      ...existingRequest,
      status: "rejected",
      updatedAt: nowIso(),
      reviewedAt: nowIso(),
      reviewedBy: actor,
      reviewNote: sanitizeMultiline(reviewNote, 600),
    }, targetEmail);
  }

  const nextPolicy = sanitizeAccessControlPolicy({
    ...policy,
    updatedAt: nowIso(),
    requests: nextRequests,
  });
  const savedPolicy = await saveAccessControlPolicyToFile(nextPolicy);
  return buildAccessControlManagementPayload(savedPolicy);
}

async function saveAccessControlUser({ actorEmail, email, role, features }) {
  const actor = normalizeEmail(actorEmail);
  const targetEmail = normalizeEmail(email);
  if (!targetEmail) {
    throw new Error("A valid BetterLetter email is required.");
  }
  if (targetEmail === ACCESS_CONTROL_OWNER_EMAIL) {
    throw new Error("The owner account is fixed and cannot be edited here.");
  }

  const { policy } = await getAccessControlManagement(actor);
  const now = nowIso();
  const existingUser = sanitizeAccessUserRecord(policy.users?.[targetEmail], targetEmail);
  const existingRequest = sanitizeAccessRequestRecord(policy.requests?.[targetEmail], targetEmail);
  const nextUser = sanitizeAccessUserRecord({
    email: targetEmail,
    role: normalizeAccessRole(role),
    features: normalizeAccessFeatures(features),
    createdAt: existingUser?.createdAt || now,
    updatedAt: now,
    createdBy: existingUser?.createdBy || actor,
    updatedBy: actor,
  }, targetEmail);

  const nextPolicy = sanitizeAccessControlPolicy({
    ...policy,
    initializedAt: policy.initializedAt || now,
    updatedAt: now,
    users: {
      ...policy.users,
      [targetEmail]: nextUser,
    },
    requests: {
      ...(policy.requests || {}),
      ...(existingRequest
        ? {
          [targetEmail]: sanitizeAccessRequestRecord({
            ...existingRequest,
            status: "approved",
            updatedAt: now,
            reviewedAt: now,
            reviewedBy: actor,
          }, targetEmail),
        }
        : {}),
    },
  });
  const savedPolicy = await saveAccessControlPolicyToFile(nextPolicy);
  const alert = await sendAccessControlSlackAlert({
    eventType: existingUser ? "user_updated" : "user_granted",
    actorEmail: actor,
    targetEmail,
    role: nextUser?.role,
    features: nextUser?.features || [],
  });
  await appendServerLog(
    `[${nowIso()}] access control ${existingUser ? "updated" : "granted"} user=${targetEmail} actor=${actor} slack=${alert.success ? "sent" : alert.skipped ? "skipped" : alert.error || "disabled"}`,
  );
  return buildAccessControlManagementPayload(savedPolicy, alert);
}

async function deleteAccessControlUser({ actorEmail, email }) {
  const actor = normalizeEmail(actorEmail);
  const targetEmail = normalizeEmail(email);
  if (!targetEmail) {
    throw new Error("A valid BetterLetter email is required.");
  }
  if (targetEmail === ACCESS_CONTROL_OWNER_EMAIL) {
    throw new Error("The owner account cannot be deleted.");
  }

  const { policy } = await getAccessControlManagement(actor);
  const existingUser = sanitizeAccessUserRecord(policy.users?.[targetEmail], targetEmail);
  if (!existingUser) {
    throw new Error("That user does not exist.");
  }

  const nextUsers = { ...policy.users };
  delete nextUsers[targetEmail];
  const nextPolicy = sanitizeAccessControlPolicy({
    ...policy,
    updatedAt: nowIso(),
    users: nextUsers,
  });
  const savedPolicy = await saveAccessControlPolicyToFile(nextPolicy);
  const alert = await sendAccessControlSlackAlert({
    eventType: "user_deleted",
    actorEmail: actor,
    targetEmail,
  });
  await appendServerLog(
    `[${nowIso()}] access control removed user=${targetEmail} actor=${actor} slack=${alert.success ? "sent" : alert.skipped ? "skipped" : alert.error || "disabled"}`,
  );
  return buildAccessControlManagementPayload(savedPolicy, alert);
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

function ensureSuperblocksLookupConfig() {
  if (!SUPERBLOCKS_UUID_LOOKUP_URL) {
    throw new Error("SUPERBLOCKS_UUID_LOOKUP_URL is missing in MailroomNavigator/.env.");
  }
}

function getCachedSuperblocksLookup(uuid) {
  const normalizedUuid = extractUuid(uuid);
  if (!normalizedUuid) return null;
  const cached = superblocksLookupCache.get(normalizedUuid);
  if (!cached) return null;
  if ((Date.now() - Number(cached.cachedAt || 0)) > SUPERBLOCKS_LOOKUP_CACHE_TTL_MS) {
    superblocksLookupCache.delete(normalizedUuid);
    return null;
  }
  return cached.result || null;
}

function rememberSuperblocksLookup(uuid, result) {
  const normalizedUuid = extractUuid(uuid);
  if (!normalizedUuid || !result || typeof result !== "object") return;
  superblocksLookupCache.set(normalizedUuid, {
    cachedAt: Date.now(),
    result,
  });
}

async function runSuperblocksUuidLookup(uuid, { forceRefresh = false } = {}) {
  ensureSuperblocksLookupConfig();

  const normalizedUuid = extractUuid(uuid);
  if (!normalizedUuid) {
    throw new Error("Invalid or missing UUID.");
  }

  if (!forceRefresh) {
    const cached = getCachedSuperblocksLookup(normalizedUuid);
    if (cached) return cached;

    const inFlight = superblocksLookupInFlight.get(normalizedUuid);
    if (inFlight) return inFlight;
  }

  const runPromise = (async () => {
    const endpoint = new URL(SUPERBLOCKS_UUID_LOOKUP_URL);
    const headers = {
      Accept: "application/json",
    };
    let body = null;

    if (SUPERBLOCKS_UUID_LOOKUP_TOKEN) {
      headers[SUPERBLOCKS_UUID_LOOKUP_TOKEN_HEADER] = SUPERBLOCKS_UUID_LOOKUP_TOKEN_HEADER.toLowerCase() === "authorization"
        && !/^bearer\s+/i.test(SUPERBLOCKS_UUID_LOOKUP_TOKEN)
        ? `Bearer ${SUPERBLOCKS_UUID_LOOKUP_TOKEN}`
        : SUPERBLOCKS_UUID_LOOKUP_TOKEN;
    }

    if (SUPERBLOCKS_UUID_LOOKUP_METHOD === "GET") {
      endpoint.searchParams.set(SUPERBLOCKS_UUID_LOOKUP_UUID_FIELD, normalizedUuid);
    } else {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify({ [SUPERBLOCKS_UUID_LOOKUP_UUID_FIELD]: normalizedUuid });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SUPERBLOCKS_UUID_LOOKUP_TIMEOUT_MS);

    let response;
    let rawBody = "";
    try {
      response = await fetch(endpoint, {
        method: SUPERBLOCKS_UUID_LOOKUP_METHOD,
        headers,
        body,
        signal: controller.signal,
      });
      rawBody = await response.text();
    } finally {
      clearTimeout(timeout);
    }

    let parsedBody = null;
    try {
      parsedBody = rawBody ? JSON.parse(rawBody) : null;
    } catch {
      parsedBody = null;
    }

    if (!response.ok) {
      const bodySnippet = sanitizeSingleLine(
        parsedBody?.error
          || parsedBody?.message
          || rawBody,
        320,
      );
      throw new Error(
        `Superblocks lookup failed with status ${response.status}${bodySnippet ? `: ${bodySnippet}` : ""}`,
      );
    }

    const payload = parsedBody ?? {};
    const statusPaths = [
      SUPERBLOCKS_UUID_LOOKUP_STATUS_PATH,
      "status",
      "data.status",
      "result.status",
      "record.status",
      "output.status",
      "outputs.status",
      "data.result.status",
      "data.record.status",
    ].filter(Boolean);
    const detailPaths = [
      SUPERBLOCKS_UUID_LOOKUP_DETAIL_PATH,
      "detail",
      "message",
      "data.detail",
      "data.message",
      "result.detail",
      "result.message",
      "record.detail",
      "record.message",
      "error",
    ].filter(Boolean);

    const { path: matchedStatusPath, value: status } = pickFirstPresentValue(payload, statusPaths);
    const { value: detailValue } = pickFirstPresentValue(payload, detailPaths);
    const detail = detailValue || (!status ? sanitizeSingleLine(rawBody, 320) : "");

    const result = {
      uuid: normalizedUuid,
      found: Boolean(status),
      status,
      detail,
      documentId: pickFirstPresentValue(payload, [
        "document_id",
        "data.document_id",
        "result.document_id",
        "output.result.0.document_id",
        "output.FetchDocumentID.0.document_id",
      ]).value,
      documentLink: pickFirstPresentValue(payload, [
        "document_link",
        "data.document_link",
        "result.document_link",
        "output.result.0.document_link",
        "output.FetchDocumentID.0.document_link",
      ]).value,
      rejectionReason: pickFirstPresentValue(payload, [
        "rejection_reason",
        "data.rejection_reason",
        "result.rejection_reason",
        "output.result.0.rejection_reason",
        "output.FetchDocumentID.0.rejection_reason",
      ]).value,
      matchedStatusPath,
      checkedAt: nowIso(),
    };

    rememberSuperblocksLookup(normalizedUuid, result);
    return result;
  })();

  superblocksLookupInFlight.set(normalizedUuid, runPromise);
  try {
    return await runPromise;
  } finally {
    if (superblocksLookupInFlight.get(normalizedUuid) === runPromise) {
      superblocksLookupInFlight.delete(normalizedUuid);
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

function formatAccessControlFeatureList(features = []) {
  const labels = normalizeAccessFeatures(features)
    .map((featureKey) => ACCESS_CONTROL_FEATURE_CATALOG.find((feature) => feature.key === featureKey)?.label || featureKey)
    .filter(Boolean);
  return labels.length > 0 ? labels.join(", ") : "none";
}

function buildAccessControlSlackMessage({
  eventType,
  actorEmail = "",
  targetEmail = "",
  role = "",
  features = [],
  reason = "",
  clientIp = "",
} = {}) {
  const normalizedEventType = sanitizeSingleLine(eventType, 40).toLowerCase();
  const actor = normalizeEmail(actorEmail) || "unknown";
  const target = normalizeEmail(targetEmail) || "unknown";
  const normalizedRole = normalizeAccessRole(role);
  const lines = [];

  if (normalizedEventType === "access_denied") {
    lines.push("MailroomNavigator access denied");
    lines.push(`User: ${target}`);
    if (reason) lines.push(`Reason: ${sanitizeSingleLine(reason, 220)}`);
    return sanitizeMultiline(lines.join("\n"), 3200);
  }

  if (normalizedEventType === "access_request") {
    lines.push("MailroomNavigator access requested");
    lines.push(`User: ${target}`);
    if (clientIp) lines.push(`IP: ${normalizeClientIp(clientIp)}`);
    lines.push(`Requested features: ${formatAccessControlFeatureList(features)}`);
    if (reason) lines.push(`Note: ${sanitizeSingleLine(reason, 220)}`);
    return sanitizeMultiline(lines.join("\n"), 3200);
  }

  if (normalizedEventType === "user_deleted") {
    lines.push("MailroomNavigator access removed");
    lines.push(`Actor: ${actor}`);
    lines.push(`User: ${target}`);
    return sanitizeMultiline(lines.join("\n"), 3200);
  }

  lines.push(normalizedEventType === "user_updated"
    ? "MailroomNavigator access updated"
    : "MailroomNavigator access granted");
  lines.push(`Actor: ${actor}`);
  lines.push(`User: ${target}`);
  lines.push(`Role: ${normalizedRole}`);
  lines.push(`Features: ${formatAccessControlFeatureList(features)}`);
  return sanitizeMultiline(lines.join("\n"), 3200);
}

function pruneAccessControlAlertCache() {
  const cutoff = Date.now() - ACCESS_CONTROL_ALERT_COOLDOWN_MS;
  for (const [key, sentAt] of accessControlAlertSentAt.entries()) {
    if (!Number.isFinite(sentAt) || sentAt < cutoff) {
      accessControlAlertSentAt.delete(key);
    }
  }
}

async function sendAccessControlSlackAlert({
  eventType,
  actorEmail = "",
  targetEmail = "",
  role = "",
  features = [],
  reason = "",
  clientIp = "",
  dedupeKey = "",
} = {}) {
  if (!ACCESS_CONTROL_SLACK_TARGET || !SLACK_BOT_TOKEN) {
    return {
      attempted: false,
      success: false,
      targetType: ACCESS_CONTROL_SLACK_TARGET_TYPE,
      target: ACCESS_CONTROL_SLACK_TARGET,
      error: "Access Control Slack alert is not configured.",
    };
  }

  const normalizedDedupeKey = sanitizeSingleLine(dedupeKey, 160);
  pruneAccessControlAlertCache();
  if (normalizedDedupeKey && accessControlAlertSentAt.has(normalizedDedupeKey)) {
    return {
      attempted: false,
      success: false,
      skipped: true,
      targetType: ACCESS_CONTROL_SLACK_TARGET_TYPE,
      target: ACCESS_CONTROL_SLACK_TARGET,
      error: "Duplicate access alert skipped during cooldown window.",
    };
  }

  try {
    const channelId = await resolveSlackChannelId({
      targetType: ACCESS_CONTROL_SLACK_TARGET_TYPE,
      target: ACCESS_CONTROL_SLACK_TARGET,
    });
    const text = buildAccessControlSlackMessage({
      eventType,
      actorEmail,
      targetEmail,
      role,
      features,
      reason,
      clientIp,
    });
    const data = await postSlackMessageWithAutoJoin({
      channelId,
      text,
      targetType: ACCESS_CONTROL_SLACK_TARGET_TYPE,
    });
    if (normalizedDedupeKey) {
      accessControlAlertSentAt.set(normalizedDedupeKey, Date.now());
    }
    return {
      attempted: true,
      success: true,
      skipped: false,
      targetType: ACCESS_CONTROL_SLACK_TARGET_TYPE,
      target: ACCESS_CONTROL_SLACK_TARGET,
      channel: sanitizeSingleLine(data?.channel, 80) || channelId,
      ts: sanitizeSingleLine(data?.ts, 64),
      error: "",
    };
  } catch (error) {
    return {
      attempted: true,
      success: false,
      skipped: false,
      targetType: ACCESS_CONTROL_SLACK_TARGET_TYPE,
      target: ACCESS_CONTROL_SLACK_TARGET,
      error: sanitizeSingleLine(error?.message, 260) || "Access Control Slack alert failed.",
    };
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
    actionableFoundTotal: Number(report.summary?.actionable_found_total || 0),
    issueCandidatesTotal: Number(report.summary?.issue_candidates_total || 0),
    floodMode: Boolean(report.safeguards?.flood_mode),
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
    "Access-Control-Allow-Headers": "Content-Type,X-MailroomNavigator-Access-Key",
  };
  if (isOriginAllowed(origin)) {
    headers["Access-Control-Allow-Origin"] = origin || "*";
    headers["Vary"] = "Origin";
  }
  return headers;
}

function isLoopbackRequest(req) {
  const remoteAddress = String(req?.socket?.remoteAddress || "").trim();
  return (
    remoteAddress === "127.0.0.1"
    || remoteAddress === "::1"
    || remoteAddress === "::ffff:127.0.0.1"
  );
}

function isAuthorizedAccessControlRequest(req) {
  if (!ACCESS_CONTROL_SHARED_KEY) return true;
  if (isLoopbackRequest(req)) return true;
  const providedKey = sanitizeSingleLine(
    req?.headers?.["x-mailroomnavigator-access-key"],
    240,
  );
  return Boolean(providedKey) && providedKey === ACCESS_CONTROL_SHARED_KEY;
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

function buildBotJobsEnv({ dryRun, reportPath = "" }) {
  const env = {
    ...process.env,
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
    const reportSummary = summarizeBotJobsReport(await readBotJobsReport(baseRun.reportPath || reportPath));
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
    const text = String(chunk || "").replace(/\r?\n$/, "");
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

await mkdir(LOG_DIR, { recursive: true });
await mkdir(STATE_DIR, { recursive: true });
await mkdir(BOT_JOBS_REPORTS_DIR, { recursive: true });
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
    const requiresAccessControlAuth = path === "/health" || path.startsWith("/access/");
    if (requiresAccessControlAuth && !isAuthorizedAccessControlRequest(req)) {
      sendJson(res, 403, origin, {
        ok: false,
        error: "Forbidden access-control request.",
      });
      return;
    }

    if (method === "GET" && path === "/health") {
      const store = await loadAccessControlStore({ forceRefresh: true, ensureExists: true });
      const managedUsers = listManagedAccessUsers(store.policy);
      const requests = listAccessRequests(store.policy);
      sendJson(res, 200, origin, {
        ok: true,
        running: Boolean(activeRun),
        activeRun: toRunPublic(activeRun),
        lastRun: toRunPublic(lastRun),
        linear: {
          configured: Boolean(LINEAR_API_KEY && LINEAR_TEAM_KEY),
          teamKey: LINEAR_TEAM_KEY || "",
        },
        slack: {
          configured: Boolean(SLACK_BOT_TOKEN),
        },
        superblocks: {
          configured: Boolean(SUPERBLOCKS_UUID_LOOKUP_URL),
          method: SUPERBLOCKS_UUID_LOOKUP_METHOD,
          uuidField: SUPERBLOCKS_UUID_LOOKUP_UUID_FIELD,
          statusPath: SUPERBLOCKS_UUID_LOOKUP_STATUS_PATH,
        },
        access: {
          enabled: Boolean(ACCESS_CONTROL_OWNER_EMAIL),
          ownerEmail: ACCESS_CONTROL_OWNER_EMAIL,
          storage: "file",
          storePath: ACCESS_CONTROL_STATE_PATH,
          managedUsers: managedUsers.length,
          pendingRequests: requests.filter((request) => request.status === "pending").length,
          policyUpdatedAt: sanitizeSingleLine(store.policy?.updatedAt, 80),
          alertsSlackConfigured: Boolean(SLACK_BOT_TOKEN && ACCESS_CONTROL_SLACK_TARGET),
          alertsSlackTargetType: ACCESS_CONTROL_SLACK_TARGET_TYPE,
          alertsSlackTarget: ACCESS_CONTROL_SLACK_TARGET,
        },
        serverTime: nowIso(),
      });
      return;
    }

    if (method === "POST" && path === "/access/resolve") {
      try {
        const body = await parseJsonBody(req);
        const email = sanitizeSingleLine(body?.email, 240);
        const resolved = await resolveAccessControl(email);
        if (resolved?.access?.email && !resolved?.access?.allowed) {
          const clientMeta = extractClientMetadata(req);
          const requestResult = await upsertAccessControlRequest({
            email: resolved.access.email,
            explicitRequest: false,
            clientIp: clientMeta.clientIp,
            userAgent: clientMeta.userAgent,
          }).catch(() => null);
          // Passive denied opens should populate the review queue without creating
          // Slack noise. Explicit Request Access submissions are the only path that
          // send Slack alerts for access requests.
          await appendServerLog(
            `[${nowIso()}] access denied observed user=${resolved.access.email} ip=${clientMeta.clientIp || "unknown"} status=${requestResult?.request?.status || "pending"} count=${Number(requestResult?.request?.requestCount || 0) || 0}`,
          );
        }
        sendJson(res, 200, origin, {
          ok: true,
          access: resolved.access,
        });
      } catch (error) {
        sendJson(res, 500, origin, {
          ok: false,
          error: sanitizeSingleLine(error?.message, 260) || "Could not resolve MailroomNavigator access.",
        });
      }
      return;
    }

    if (method === "POST" && path === "/access/request") {
      try {
        const body = await parseJsonBody(req);
        const email = sanitizeSingleLine(body?.email, 240);
        const note = sanitizeMultiline(body?.note, 1200);
        const requestedFeatures = Array.isArray(body?.requestedFeatures) ? body.requestedFeatures : [];
        const clientMeta = extractClientMetadata(req);
        const requestResult = await upsertAccessControlRequest({
          email,
          requestedFeatures,
          note,
          explicitRequest: true,
          clientIp: clientMeta.clientIp,
          userAgent: clientMeta.userAgent,
        });
        const resolved = await resolveAccessControl(email);
        const alert = await sendAccessControlSlackAlert({
          eventType: "access_request",
          targetEmail: normalizeEmail(email),
          features: requestedFeatures,
          reason: note,
          clientIp: clientMeta.clientIp,
          dedupeKey: `request:${normalizeEmail(email)}`,
        });
        await appendServerLog(
          `[${nowIso()}] access request user=${normalizeEmail(email)} ip=${clientMeta.clientIp || "unknown"} slack=${alert.success ? "sent" : alert.skipped ? "skipped" : alert.error || "disabled"}`,
        );
        sendJson(res, 200, origin, {
          ok: true,
          access: resolved.access,
          request: requestResult.request,
          alert,
        });
      } catch (error) {
        sendJson(res, 400, origin, {
          ok: false,
          error: sanitizeSingleLine(error?.message, 260) || "Could not submit MailroomNavigator access request.",
        });
      }
      return;
    }

    if (method === "POST" && path === "/access/management") {
      try {
        const body = await parseJsonBody(req);
        const actorEmail = sanitizeSingleLine(body?.actorEmail, 240);
        const resolved = await getAccessControlManagement(actorEmail);
        sendJson(res, 200, origin, {
          ok: true,
          access: resolved.access,
          management: resolved.management,
        });
      } catch (error) {
        sendJson(res, 403, origin, {
          ok: false,
          error: sanitizeSingleLine(error?.message, 260) || "Could not load MailroomNavigator user management.",
        });
      }
      return;
    }

    if (method === "POST" && path === "/access/export-policy") {
      try {
        const body = await parseJsonBody(req);
        const exported = await exportAccessControlPolicy(
          sanitizeSingleLine(body?.actorEmail, 240),
        );
        sendJson(res, 200, origin, {
          ok: true,
          exported,
        });
      } catch (error) {
        sendJson(res, 403, origin, {
          ok: false,
          error: sanitizeSingleLine(error?.message, 260) || "Could not export MailroomNavigator access policy.",
        });
      }
      return;
    }

    if (method === "POST" && path === "/access/import-policy") {
      try {
        const body = await parseJsonBody(req);
        const imported = await importAccessControlPolicy({
          actorEmail: sanitizeSingleLine(body?.actorEmail, 240),
          policy: body?.policy,
          mode: sanitizeSingleLine(body?.mode, 20),
        });
        sendJson(res, 200, origin, {
          ok: true,
          ...imported,
        });
      } catch (error) {
        sendJson(res, 403, origin, {
          ok: false,
          error: sanitizeSingleLine(error?.message, 260) || "Could not import MailroomNavigator access policy.",
        });
      }
      return;
    }

    if (method === "POST" && path === "/access/review-request") {
      try {
        const body = await parseJsonBody(req);
        const management = await reviewAccessControlRequest({
          actorEmail: sanitizeSingleLine(body?.actorEmail, 240),
          email: sanitizeSingleLine(body?.email, 240),
          action: sanitizeSingleLine(body?.action, 40),
          reviewNote: sanitizeMultiline(body?.reviewNote, 600),
        });
        sendJson(res, 200, origin, {
          ok: true,
          management,
        });
      } catch (error) {
        sendJson(res, 403, origin, {
          ok: false,
          error: sanitizeSingleLine(error?.message, 260) || "Could not review MailroomNavigator access request.",
        });
      }
      return;
    }

    if (method === "POST" && path === "/access/save-user") {
      try {
        const body = await parseJsonBody(req);
        const management = await saveAccessControlUser({
          actorEmail: sanitizeSingleLine(body?.actorEmail, 240),
          email: sanitizeSingleLine(body?.email, 240),
          role: sanitizeSingleLine(body?.role, 40),
          features: Array.isArray(body?.features) ? body.features : [],
        });
        sendJson(res, 200, origin, {
          ok: true,
          management,
        });
      } catch (error) {
        sendJson(res, 403, origin, {
          ok: false,
          error: sanitizeSingleLine(error?.message, 260) || "Could not save MailroomNavigator user.",
        });
      }
      return;
    }

    if (method === "POST" && path === "/access/delete-user") {
      try {
        const body = await parseJsonBody(req);
        const management = await deleteAccessControlUser({
          actorEmail: sanitizeSingleLine(body?.actorEmail, 240),
          email: sanitizeSingleLine(body?.email, 240),
        });
        sendJson(res, 200, origin, {
          ok: true,
          management,
        });
      } catch (error) {
        sendJson(res, 403, origin, {
          ok: false,
          error: sanitizeSingleLine(error?.message, 260) || "Could not delete MailroomNavigator user.",
        });
      }
      return;
    }

    if (method === "GET" && path === "/superblocks/uuid-status") {
      try {
        const lookup = await runSuperblocksUuidLookup(url.searchParams.get("uuid"));
        sendJson(res, 200, origin, {
          ok: true,
          lookup,
        });
      } catch (error) {
        const message = sanitizeSingleLine(error?.message, 320) || "Could not look up Superblocks status.";
        const statusCode = /missing in MailroomNavigator\/\.env/i.test(message)
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
      const result = await startBotJobsRun({
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
        const slack = await sendSlackIssueNotification(payload, created);
        await appendServerLog(
          `[${nowIso()}] linear issue created ${created.issue.identifier} doc=${payload.documentId} job=${payload.failedJobId || "n/a"}`,
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

        sendJson(res, 201, origin, {
          ok: true,
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
