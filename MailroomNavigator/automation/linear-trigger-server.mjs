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

const HOST = String(process.env.LINEAR_TRIGGER_SERVER_HOST || "127.0.0.1");
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
const ACCESS_CONTROL_OWNER_EMAIL = normalizeEmail(
  process.env.MAILROOMNAV_OWNER_EMAIL
    || "nur.siddique@dyad.net",
);
const ACCESS_CONTROL_ISSUE_TITLE = sanitizeSingleLine(
  process.env.MAILROOMNAV_ACCESS_CONTROL_ISSUE_TITLE
    || "[MailroomNavigator] Access Control",
  180,
);
const ACCESS_CONTROL_CACHE_TTL_MS = 30 * 1000;
const LOG_DIR = String(process.env.LINEAR_TRIGGER_LOG_DIR || join(REPO_ROOT, "logs"));
const STATE_DIR = String(process.env.LINEAR_TRIGGER_STATE_DIR || join(REPO_ROOT, ".automation-state"));
const SERVER_LOG_PATH = join(LOG_DIR, "linear-trigger-server.log");
const LAST_RUN_STATE_PATH = join(STATE_DIR, "linear-trigger-last-run.json");
const BOT_JOBS_REPORTS_DIR = join(STATE_DIR, "reports");

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
let accessControlCache = {
  loadedAt: 0,
  issue: null,
  policy: null,
};

function nowIso() {
  return new Date().toISOString();
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

const ACCESS_CONTROL_MARKER_START = "<!-- MAILROOMNAV_ACCESS_CONTROL_START -->";
const ACCESS_CONTROL_MARKER_END = "<!-- MAILROOMNAV_ACCESS_CONTROL_END -->";
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

function sanitizeAccessControlPolicy(rawPolicy = null) {
  const users = {};
  const sourceUsers = rawPolicy?.users && typeof rawPolicy.users === "object" ? rawPolicy.users : {};
  Object.entries(sourceUsers).forEach(([emailKey, rawUser]) => {
    const sanitizedUser = sanitizeAccessUserRecord(rawUser, emailKey);
    if (!sanitizedUser || sanitizedUser.role === "owner") return;
    users[sanitizedUser.email] = sanitizedUser;
  });
  return {
    version: 1,
    ownerEmail: ACCESS_CONTROL_OWNER_EMAIL,
    initializedAt: sanitizeSingleLine(rawPolicy?.initializedAt, 80),
    updatedAt: sanitizeSingleLine(rawPolicy?.updatedAt, 80),
    users,
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

function parseAccessControlPolicyFromDescription(description = "") {
  const source = String(description || "");
  const startIndex = source.indexOf(ACCESS_CONTROL_MARKER_START);
  const endIndex = source.indexOf(ACCESS_CONTROL_MARKER_END);
  if (startIndex < 0 || endIndex < 0 || endIndex <= startIndex) return null;
  const jsonBlock = source.slice(startIndex + ACCESS_CONTROL_MARKER_START.length, endIndex).trim();
  if (!jsonBlock) return null;
  try {
    return sanitizeAccessControlPolicy(JSON.parse(jsonBlock));
  } catch {
    return null;
  }
}

function buildAccessControlIssueDescription(policy) {
  return [
    "# MailroomNavigator access control",
    "",
    `Owner: ${ACCESS_CONTROL_OWNER_EMAIL}`,
    "",
    "This issue stores the centrally synced access-control policy used by the MailroomNavigator extension.",
    "",
    ACCESS_CONTROL_MARKER_START,
    serializeAccessControlPolicy(policy),
    ACCESS_CONTROL_MARKER_END,
  ].join("\n");
}

function sanitizeAccessControlIssue(rawIssue = null) {
  if (!rawIssue || typeof rawIssue !== "object") return null;
  const id = sanitizeSingleLine(rawIssue.id, 64);
  if (!id) return null;
  return {
    id,
    identifier: sanitizeSingleLine(rawIssue.identifier, 64),
    title: sanitizeSingleLine(rawIssue.title, 180),
    description: sanitizeMultiline(rawIssue.description, 40000),
    url: sanitizeSingleLine(rawIssue.url, 1000),
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
  if (!managedUser) {
    return {
      enabled: true,
      initialized: true,
      allowed: false,
      isOwner: false,
      canManageUsers: false,
      role: "",
      email: normalizedEmail,
      reason: "You do not have MailroomNavigator access. Ask Nur to add your BetterLetter email.",
      features: buildAccessFeatureMap([], false),
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

async function findAccessControlIssue() {
  const now = Date.now();
  if (
    accessControlCache?.issue?.id
    && accessControlCache?.policy
    && now - Number(accessControlCache.loadedAt || 0) < ACCESS_CONTROL_CACHE_TTL_MS
  ) {
    return {
      issue: sanitizeAccessControlIssue(accessControlCache.issue),
      policy: sanitizeAccessControlPolicy(accessControlCache.policy),
    };
  }

  const team = await resolveLinearTeam();
  const query = `
    query FindAccessControlIssue($teamId: String!, $first: Int!, $after: String) {
      team(id: $teamId) {
        issues(first: $first, after: $after) {
          nodes {
            id
            identifier
            title
            description
            url
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    }
  `;

  let after = null;
  let foundIssue = null;

  for (let page = 0; page < 20; page += 1) {
    const data = await runLinearGraphqlRequest(query, {
      teamId: team.id,
      first: 100,
      after,
    });
    const issuesRoot = data?.team?.issues;
    const nodes = Array.isArray(issuesRoot?.nodes)
      ? issuesRoot.nodes
      : Array.isArray(issuesRoot?.edges)
        ? issuesRoot.edges.map((edge) => edge?.node).filter(Boolean)
        : [];
    foundIssue = nodes
      .map((issue) => sanitizeAccessControlIssue(issue))
      .find((issue) => issue?.title === ACCESS_CONTROL_ISSUE_TITLE) || null;
    if (foundIssue) break;
    const pageInfo = issuesRoot?.pageInfo || {};
    if (!pageInfo?.hasNextPage || !sanitizeSingleLine(pageInfo?.endCursor, 260)) break;
    after = sanitizeSingleLine(pageInfo.endCursor, 260);
  }

  const policy = foundIssue?.description
    ? parseAccessControlPolicyFromDescription(foundIssue.description) || buildDefaultAccessPolicy()
    : buildDefaultAccessPolicy();

  accessControlCache = {
    loadedAt: now,
    issue: foundIssue,
    policy,
  };

  return {
    issue: foundIssue,
    policy,
  };
}

async function createAccessControlIssue() {
  const team = await resolveLinearTeam();
  const policy = buildDefaultAccessPolicy();
  const mutation = `
    mutation CreateAccessControlIssue($input: IssueCreateInput!) {
      issueCreate(input: $input) {
        success
        issue {
          id
          identifier
          title
          description
          url
        }
      }
    }
  `;
  const input = {
    teamId: team.id,
    title: ACCESS_CONTROL_ISSUE_TITLE,
    description: buildAccessControlIssueDescription(policy),
  };
  const data = await runLinearGraphqlRequest(mutation, { input });
  const issue = sanitizeAccessControlIssue(data?.issueCreate?.issue);
  if (!data?.issueCreate?.success || !issue?.id) {
    throw new Error("Could not create the MailroomNavigator access-control issue in Linear.");
  }
  accessControlCache = {
    loadedAt: Date.now(),
    issue,
    policy,
  };
  return { issue, policy };
}

async function ensureAccessControlStore() {
  const existing = await findAccessControlIssue();
  if (existing?.issue?.id) return existing;
  return createAccessControlIssue();
}

async function saveAccessControlPolicy(issueId, policy) {
  const normalizedPolicy = sanitizeAccessControlPolicy(policy);
  const mutation = `
    mutation UpdateAccessControlIssue($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) {
        success
        issue {
          id
          identifier
          title
          description
          url
        }
      }
    }
  `;
  const data = await runLinearGraphqlRequest(mutation, {
    id: sanitizeSingleLine(issueId, 64),
    input: {
      description: buildAccessControlIssueDescription(normalizedPolicy),
    },
  });
  const issue = sanitizeAccessControlIssue(data?.issueUpdate?.issue);
  if (!data?.issueUpdate?.success || !issue?.id) {
    throw new Error("Could not update the MailroomNavigator access-control issue.");
  }
  accessControlCache = {
    loadedAt: Date.now(),
    issue,
    policy: normalizedPolicy,
  };
  return { issue, policy: normalizedPolicy };
}

async function resolveAccessControl(email) {
  if (!ACCESS_CONTROL_OWNER_EMAIL) {
    throw new Error("MAILROOMNAV owner email is not configured.");
  }
  const normalizedEmail = normalizeEmail(email);

  if (normalizedEmail === ACCESS_CONTROL_OWNER_EMAIL) {
    const store = await ensureAccessControlStore();
    return {
      access: {
        ...buildResolvedAccess(normalizedEmail, store.policy),
        featureCatalog: ACCESS_CONTROL_FEATURE_CATALOG,
        ownerEmail: ACCESS_CONTROL_OWNER_EMAIL,
      },
      issue: store.issue,
      policy: store.policy,
    };
  }

  const store = await findAccessControlIssue();
  return {
    access: {
      ...buildResolvedAccess(normalizedEmail, store.policy),
      featureCatalog: ACCESS_CONTROL_FEATURE_CATALOG,
      ownerEmail: ACCESS_CONTROL_OWNER_EMAIL,
    },
    issue: store.issue,
    policy: store.policy,
  };
}

async function getAccessControlManagement(actorEmail) {
  const resolved = await resolveAccessControl(actorEmail);
  if (!resolved?.access?.isOwner) {
    throw new Error(resolved?.access?.reason || "Only the MailroomNavigator owner can manage access.");
  }
  const ensuredStore = resolved.issue?.id ? resolved : await resolveAccessControl(ACCESS_CONTROL_OWNER_EMAIL);
  return {
    access: ensuredStore.access,
    management: {
      ownerEmail: ACCESS_CONTROL_OWNER_EMAIL,
      users: listManagedAccessUsers(ensuredStore.policy),
      featureCatalog: ACCESS_CONTROL_FEATURE_CATALOG,
    },
    issue: ensuredStore.issue,
    policy: ensuredStore.policy,
  };
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

  const { issue, policy } = await getAccessControlManagement(actor);
  const now = nowIso();
  const existingUser = sanitizeAccessUserRecord(policy.users?.[targetEmail], targetEmail);
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
  });
  const saved = await saveAccessControlPolicy(issue.id, nextPolicy);
  return {
    ownerEmail: ACCESS_CONTROL_OWNER_EMAIL,
    users: listManagedAccessUsers(saved.policy),
    featureCatalog: ACCESS_CONTROL_FEATURE_CATALOG,
  };
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

  const { issue, policy } = await getAccessControlManagement(actor);
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
  const saved = await saveAccessControlPolicy(issue.id, nextPolicy);
  return {
    ownerEmail: ACCESS_CONTROL_OWNER_EMAIL,
    users: listManagedAccessUsers(saved.policy),
    featureCatalog: ACCESS_CONTROL_FEATURE_CATALOG,
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

async function fetchSlackWorkspaceTargets() {
  if (!SLACK_BOT_TOKEN) {
    throw new Error("SLACK_BOT_TOKEN is missing in MailroomNavigator/.env.");
  }

  const channels = await listSlackChannels();
  let users = [];
  try {
    users = await listSlackUsers();
  } catch (error) {
    await appendServerLog(`[${nowIso()}] slack users sync skipped: ${String(error?.message || error)}`);
  }

  return {
    channels,
    users,
    syncedAt: nowIso(),
  };
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

async function startBotJobsRun({ dryRun, entryScript = BOT_JOBS_ENTRY, runType = "trigger" }) {
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
        slack: {
          configured: Boolean(SLACK_BOT_TOKEN),
        },
        access: {
          enabled: Boolean(ACCESS_CONTROL_OWNER_EMAIL),
          ownerEmail: ACCESS_CONTROL_OWNER_EMAIL,
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

    if (method === "GET" && path === "/slack/targets") {
      try {
        const targets = await fetchSlackWorkspaceTargets();
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
      const result = await startBotJobsRun({
        dryRun,
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
      const result = await startBotJobsRun({
        dryRun,
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
