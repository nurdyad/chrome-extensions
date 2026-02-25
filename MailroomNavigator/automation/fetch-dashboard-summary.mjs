import "dotenv/config";
import { chromium } from "playwright";

const ADMIN_DASHBOARD_URL = "https://app.betterletter.ai/admin_panel/bots/dashboard?status=paused";
const REQUESTS = [
  {
    key: "filing",
    label: "Filing",
    path: "/admin_panel/bots/dashboard?job_types=generate_output+docman_upload+docman_file+merge_tasks_for_same_recipient+docman_review+docman_delete_original+docman_validate&status=paused",
  },
  {
    key: "docman_import",
    label: "Docman Import",
    path: "/admin_panel/bots/dashboard?job_types=docman_import&status=paused",
  },
  {
    key: "coding",
    label: "Coding",
    path: "/admin_panel/bots/dashboard?job_types=emis_coding+emis_api_consultation&status=paused",
  },
  {
    key: "import",
    label: "Import",
    path: "/admin_panel/bots/dashboard?job_types=import_jobs+emis_prepare&status=paused",
  },
];

function collapse(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function buildLooseLabelPattern(label) {
  const tokens = collapse(label).toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return "";
  return tokens.join("\\s*");
}

function parseCountByLabel(text, label) {
  const source = collapse(text);
  const looseLabelPattern = buildLooseLabelPattern(label);
  if (!source || !looseLabelPattern) return null;

  const patterns = [
    new RegExp(`${looseLabelPattern}[^0-9]{0,20}\\((\\d+)\\)`, "gi"),
    new RegExp(`${looseLabelPattern}[^0-9]{0,20}[:\\-]?\\s*(\\d+)\\b`, "gi"),
  ];

  const values = [];
  for (const regex of patterns) {
    for (const match of source.matchAll(regex)) {
      const parsed = Number.parseInt(String(match?.[1] || ""), 10);
      if (Number.isFinite(parsed) && parsed >= 0) values.push(parsed);
    }
  }

  if (!values.length) return null;
  return Math.max(...values);
}

function formatCount(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? String(parsed) : "unknown";
}

async function fetchSummary(page) {
  const result = await page.evaluate(async (requestConfigs) => {
    const collapse = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const buildLooseLabelPattern = (label) => {
      const tokens = collapse(label).toLowerCase().split(/\s+/).filter(Boolean);
      if (!tokens.length) return "";
      return tokens.join("\\s*");
    };
    const parseCountByLabel = (text, label) => {
      const source = collapse(text);
      const looseLabelPattern = buildLooseLabelPattern(label);
      if (!source || !looseLabelPattern) return null;

      const patterns = [
        new RegExp(`${looseLabelPattern}[^0-9]{0,20}\\((\\d+)\\)`, "gi"),
        new RegExp(`${looseLabelPattern}[^0-9]{0,20}[:\\-]?\\s*(\\d+)\\b`, "gi"),
      ];

      const values = [];
      patterns.forEach((regex) => {
        for (const match of source.matchAll(regex)) {
          const parsed = Number.parseInt(String(match?.[1] || ""), 10);
          if (Number.isFinite(parsed) && parsed >= 0) values.push(parsed);
        }
      });

      if (!values.length) return null;
      return Math.max(...values);
    };

    const fetchOne = async (item) => {
      try {
        const response = await fetch(String(item?.path || ""), {
          credentials: "include",
          cache: "no-store",
        });
        if (!response.ok) {
          return {
            key: String(item?.key || ""),
            label: String(item?.label || item?.key || "Category"),
            requireAttention: null,
            unauthorized: false,
          };
        }

        const html = await response.text();
        const doc = new DOMParser().parseFromString(String(html || ""), "text/html");
        const sourceText = collapse(doc?.body?.innerText || "");
        const unauthorized = /log in|sign in|password/i.test(sourceText) &&
          Boolean(doc.querySelector('form[action*="sign"], input[type="password"]'));

        const requireAttention = parseCountByLabel(sourceText, "Require Attention");
        const count = Number.isFinite(requireAttention) ? requireAttention : null;

        return {
          key: String(item?.key || ""),
          label: String(item?.label || item?.key || "Category"),
          requireAttention: count,
          unauthorized,
        };
      } catch {
        return {
          key: String(item?.key || ""),
          label: String(item?.label || item?.key || "Category"),
          requireAttention: null,
          unauthorized: false,
        };
      }
    };

    const categories = await Promise.all((Array.isArray(requestConfigs) ? requestConfigs : []).map(fetchOne));
    const unauthorized = categories.some((item) => item?.unauthorized);
    return { categories, unauthorized };
  }, REQUESTS);

  if (result?.unauthorized) {
    throw new Error("BetterLetter session unauthorized while fetching summary.");
  }

  const categories = Array.isArray(result?.categories) ? result.categories : [];
  const generatedAt = Date.now();
  const summary = categories
    .map((item) => `${String(item?.label || "Category")}: ${formatCount(item?.requireAttention)} require attention`)
    .join(" | ");

  return {
    generatedAt,
    categories,
    summary: summary || "Unavailable",
  };
}

async function main() {
  const storageStatePath = String(
    process.env.AUTH_STORAGE_STATE_PATH ||
    process.env.MORNING_LOGIN_AUTH_STATE_FILE ||
    "storageState.mailroomnavigator.json"
  );
  const timeoutMs = Math.max(15_000, Number(process.env.DASHBOARD_SUMMARY_TIMEOUT_MS || 90_000));

  const httpUser = String(process.env.ADMIN_PANEL_USERNAME || process.env.BASIC_AUTH_USERNAME || "");
  const httpPass = String(process.env.ADMIN_PANEL_PASSWORD || process.env.BASIC_AUTH_PASSWORD || "");
  const httpCredentials = httpUser && httpPass ? { username: httpUser, password: httpPass } : undefined;

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    storageState: storageStatePath,
    httpCredentials,
  });
  const page = await context.newPage();

  try {
    await page.goto(ADMIN_DASHBOARD_URL, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    const payload = await fetchSummary(page);
    console.log(`SUMMARY=${payload.summary}`);
    console.log(`SUMMARY_JSON=${JSON.stringify(payload)}`);
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((error) => {
  const message = collapse(error?.message || error);
  console.error(`SUMMARY_ERROR=${message || "Unknown summary error."}`);
  process.exit(1);
});
