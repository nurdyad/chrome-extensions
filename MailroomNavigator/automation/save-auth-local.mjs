import "dotenv/config";
import { chromium } from "playwright";
import { ImapFlow } from "imapflow";
import { writeFile } from "node:fs/promises";

const DASHBOARD_URL = "https://app.betterletter.ai/admin_panel/bots/dashboard?status=paused";
const STORAGE_STATE_PATH = process.env.AUTH_STORAGE_STATE_PATH || "storageState.mailroomnavigator.json";

function envFlag(value) {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function envValue(value) {
  return String(value ?? "").replace(/\r/g, "").replace(/\n/g, "");
}

function getHttpCredentials() {
  const username = envValue(
    process.env.ADMIN_PANEL_USERNAME ||
    process.env.BASIC_AUTH_USERNAME,
  );
  const password = envValue(
    process.env.ADMIN_PANEL_PASSWORD ||
    process.env.BASIC_AUTH_PASSWORD,
  );

  if (!username && !password) return undefined;
  if (!username || !password) {
    throw new Error(
      "HTTP auth credentials are partially configured. Set both ADMIN_PANEL_USERNAME and ADMIN_PANEL_PASSWORD (or BASIC_AUTH_USERNAME/BASIC_AUTH_PASSWORD).",
    );
  }

  return { username, password };
}

function isSignInUrl(url) {
  return String(url || "").toLowerCase().includes("/sign-in");
}

function is2faPageText(text) {
  const t = String(text || "").toLowerCase();
  return t.includes("enter your security code") || t.includes("security code");
}

async function is2faPage(page) {
  const bodyText = await page.locator("body").innerText().catch(() => "");
  return is2faPageText(bodyText);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function firstExisting(locators) {
  for (const locator of locators) {
    if (await locator.count()) return locator;
  }
  return null;
}

async function robustFillInput(locator, value) {
  const target = String(value || "");

  await locator.scrollIntoViewIfNeeded().catch(() => {});
  await locator.click({ timeout: 5000 }).catch(() => {});
  await locator.fill("").catch(() => {});

  await locator.type(target, { delay: 12 }).catch(async () => {
    await locator.fill(target);
  });

  let actual = await locator.inputValue().catch(() => "");
  if (actual !== target) {
    await locator.fill(target).catch(() => {});
    actual = await locator.inputValue().catch(() => "");
  }

  return String(actual || "");
}

async function getSignInDiagnostics(page) {
  const emailValueLen = await page
    .locator(
      'input[type="email"], input[name="email"], input#email, input[autocomplete="username"], input[name*="email" i]',
    )
    .first()
    .inputValue()
    .then((v) => String(v || "").length)
    .catch(() => 0);

  const passwordValueLen = await page
    .locator(
      'input[type="password"], input[name="password"], input#password, input[autocomplete="current-password"]',
    )
    .first()
    .inputValue()
    .then((v) => String(v || "").length)
    .catch(() => 0);

  const bodyText = await page.locator("body").innerText().catch(() => "");
  const errorHints = String(bodyText || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => /(invalid|incorrect|error|failed|try again|unable|denied|captcha|too many)/i.test(line))
    .slice(0, 4);

  return { emailValueLen, passwordValueLen, errorHints };
}

async function fillPrimaryLogin(page, email, password) {
  await page
    .waitForFunction(
      () =>
        Boolean(
          document.querySelector(
            'input[type="password"], input[name="password"], input#password, input[autocomplete="current-password"]',
          ),
        ),
      null,
      { timeout: 20_000 },
    )
    .catch(() => {});

  const emailField = await firstExisting([
    page.getByLabel(/email/i).first(),
    page
      .locator(
        'input[type="email"], input[name="email"], input#email, input[autocomplete="username"], input[name*="email" i]',
      )
      .first(),
  ]);

  const passwordField = await firstExisting([
    page.getByLabel(/^password$/i).first(),
    page
      .locator(
        'input[type="password"], input[name="password"], input#password, input[autocomplete="current-password"]',
      )
      .first(),
  ]);

  if (!emailField || !passwordField) {
    return false;
  }

  const emailValue = await robustFillInput(emailField, email);
  const passwordValue = await robustFillInput(passwordField, password);
  console.log(
    `[save-auth] Sign-in form filled (emailLen=${emailValue.length}, passwordLen=${passwordValue.length}).`,
  );

  if (!emailValue || !passwordValue) {
    throw new Error("Could not populate sign-in form fields reliably.");
  }

  const submit = page
    .locator(
      'button:has-text("Sign in"), button:has-text("Log in"), button:has-text("SIGN IN"), button[type="submit"]',
    )
    .first();
  if (await submit.count()) {
    await submit.click();
  } else {
    await passwordField.press("Enter");
  }

  return true;
}

async function captureAuthDebugFiles(page) {
  const screenshotPath = "debug-save-auth-failure.png";
  const htmlPath = "debug-save-auth-failure.html";

  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
  const html = await page.content().catch(() => "");
  if (html) {
    await writeFile(htmlPath, html, "utf8").catch(() => {});
  }

  return { screenshotPath, htmlPath };
}

async function waitFor2faOrDashboard(page) {
  const timeoutMs = Number(process.env.POST_LOGIN_WAIT_SECONDS || 120) * 1000;
  const startedAt = Date.now();
  let sawSignInUrl = false;

  while (Date.now() - startedAt < timeoutMs) {
    const url = page.url().toLowerCase();
    if (url.includes("/admin_panel/") && !url.includes("/sign-in")) return;
    if (isSignInUrl(url)) sawSignInUrl = true;

    const bodyText = await page.locator("body").innerText().catch(() => "");
    if (is2faPageText(bodyText)) return;

    const codeLabelCount = await page
      .locator("label")
      .filter({ hasText: /security code/i })
      .count()
      .catch(() => 0);
    if (codeLabelCount > 0) return;

    await sleep(1000);
  }

  const { screenshotPath, htmlPath } = await captureAuthDebugFiles(page);
  if (sawSignInUrl || isSignInUrl(page.url())) {
    const diagnostics = await getSignInDiagnostics(page);
    const hints = diagnostics.errorHints.length
      ? ` Hints: ${diagnostics.errorHints.join(" | ")}`
      : "";
    throw new Error(
      `Login did not advance from sign-in within ${Math.floor(timeoutMs / 1000)} seconds. Current URL: ${page.url()}. Form values seen: emailLen=${diagnostics.emailValueLen}, passwordLen=${diagnostics.passwordValueLen}.${hints} Saved debug files: ${screenshotPath}, ${htmlPath}`,
    );
  }

  throw new Error(
    `Timed out waiting for 2FA/dashboard after ${Math.floor(timeoutMs / 1000)} seconds. Current URL: ${page.url()}. Saved debug files: ${screenshotPath}, ${htmlPath}`,
  );
}

async function fillAndSubmit2fa(page, code) {
  const codeInput = await firstExisting([
    page.getByLabel(/security code/i).first(),
    page.locator('input[autocomplete="one-time-code"]').first(),
    page
      .locator(
        'input[name*="code" i], input[id*="code" i], input[inputmode="numeric"], input[type="tel"]',
      )
      .first(),
  ]);

  if (!codeInput) {
    throw new Error("Could not find 2FA code input field.");
  }

  await codeInput.fill(String(code));

  const verifyButton = page
    .locator(
      'button:has-text("Verify Code"), button:has-text("VERIFY CODE"), button:has-text("Verify"), button[type="submit"]',
    )
    .first();

  if (await verifyButton.count()) {
    await verifyButton.click();
  } else {
    await codeInput.press("Enter");
  }
}

function looksLikeOtpFailureText(text) {
  const bodyLower = String(text || "").toLowerCase();
  const failureHints = [
    "invalid",
    "incorrect",
    "expired",
    "try again",
    "too many",
    "unable",
    "denied",
  ];
  return failureHints.some((hint) => bodyLower.includes(hint));
}

async function waitForPostOtpResult(page) {
  const timeoutMs = Number(process.env.POST_OTP_WAIT_SECONDS || 35) * 1000;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const url = String(page.url() || "");
    const urlLower = url.toLowerCase();

    if (urlLower.includes("/admin_panel/") && !urlLower.includes("/sign-in")) {
      return "dashboard";
    }

    const bodyText = await page.locator("body").innerText().catch(() => "");
    const bodyLower = String(bodyText || "").toLowerCase();
    if (bodyLower.includes("bot jobs dashboard")) {
      return "dashboard";
    }

    const codeLabelCount = await page
      .locator("label")
      .filter({ hasText: /security code/i })
      .count()
      .catch(() => 0);

    const stillOn2fa = is2faPageText(bodyText) || codeLabelCount > 0;
    const looksLikeFailure = looksLikeOtpFailureText(bodyLower);

    if (stillOn2fa && looksLikeFailure) {
      return "otp_failed";
    }

    if (!stillOn2fa && isSignInUrl(urlLower) && looksLikeFailure) {
      return "otp_failed";
    }

    await sleep(1000);
  }

  return "timeout";
}

async function submitOtpFromEmail(page, { allowRequestNewCode = true } = {}) {
  const maxOtpSubmitAttempts = Math.max(1, Number(process.env.OTP_SUBMIT_MAX_ATTEMPTS || 3));

  for (let attempt = 1; attempt <= maxOtpSubmitAttempts; attempt += 1) {
    const shouldRequestNewCode = allowRequestNewCode || attempt > 1;
    const requestedNewCode = shouldRequestNewCode ? await maybeRequestNew2faCode(page) : false;
    const fetchStartedAt = new Date();

    console.log(
      requestedNewCode
        ? `Primary login attempted. Requested new 2FA code. Fetching 2FA security code from email... (${attempt}/${maxOtpSubmitAttempts})`
        : `Primary login attempted. Fetching 2FA security code from email... (${attempt}/${maxOtpSubmitAttempts})`,
    );

    const otpCode = await fetchOtpCodeFromEmail(fetchStartedAt);
    await fillAndSubmit2fa(page, otpCode);
    console.log("2FA code submitted automatically.");

    // Wait for OTP acceptance/rejection before forcing a navigation fallback.
    const postOtpState = await waitForPostOtpResult(page);
    if (postOtpState === "dashboard") return;

    if (postOtpState === "otp_failed") {
      const canRetry = attempt < maxOtpSubmitAttempts;
      if (!canRetry) {
        throw new Error("2FA security code was rejected (invalid/expired) after retry attempts.");
      }
      console.log("[save-auth] 2FA code rejected. Requesting a new code and retrying...");
      await sleep(1200);
      continue;
    }

    // Some runs do not auto-redirect after successful OTP submit.
    await page.goto(DASHBOARD_URL, { waitUntil: "domcontentloaded" }).catch(() => {});
    return;
  }
}

async function maybeRequestNew2faCode(page) {
  const trigger = page
    .locator(
      'a:has-text("generate new code"), button:has-text("generate new code"), a:has-text("new code"), button:has-text("new code")',
    )
    .first();

  if (!(await trigger.count())) return false;

  try {
    await trigger.click({ timeout: 3000 });
    await sleep(1000);
    return true;
  } catch {
    return false;
  }
}

function getOtpEmailConfig() {
  const host = envValue(process.env.OTP_EMAIL_IMAP_HOST);
  const username = envValue(process.env.OTP_EMAIL_USERNAME);
  const password = envValue(process.env.OTP_EMAIL_PASSWORD);

  if (!host || !username || !password) {
    throw new Error(
      "Missing OTP email IMAP config. Set OTP_EMAIL_IMAP_HOST, OTP_EMAIL_USERNAME, OTP_EMAIL_PASSWORD in .env.",
    );
  }

  return {
    host,
    port: Number(process.env.OTP_EMAIL_IMAP_PORT || 993),
    secure: process.env.OTP_EMAIL_IMAP_SECURE
      ? envFlag(process.env.OTP_EMAIL_IMAP_SECURE)
      : true,
    username,
    password,
    mailbox: process.env.OTP_EMAIL_MAILBOX || "INBOX",
    fromFilter: process.env.OTP_EMAIL_FROM_FILTER || "",
    subjectFilter: process.env.OTP_EMAIL_SUBJECT_FILTER || "security code",
    lookbackMs: Number(process.env.OTP_EMAIL_LOOKBACK_MINUTES || 20) * 60 * 1000,
    timeoutMs: Number(process.env.OTP_EMAIL_TIMEOUT_SECONDS || 120) * 1000,
    pollMs: Number(process.env.OTP_EMAIL_POLL_SECONDS || 4) * 1000,
    codeRegex: process.env.OTP_EMAIL_CODE_REGEX || "\\b(\\d{6})\\b",
  };
}

function extractRegexMatches(text, pattern) {
  const re = new RegExp(pattern, "ig");
  const matches = [];
  let match = null;

  while ((match = re.exec(text)) !== null) {
    const value = String(match[1] || match[0] || "");
    if (value) matches.push(value);
    if (re.lastIndex === match.index) re.lastIndex += 1;
  }

  return matches;
}

function parseOtpFromRawMessage(raw, codeRegex) {
  const text = String(raw || "");
  const patterns = [];

  if (codeRegex) {
    const rawPattern = String(codeRegex);
    patterns.push(rawPattern);

    // Support .env values that were double-escaped, e.g. "\\b(\\d{6})\\b".
    const unescaped = rawPattern.replace(/\\\\/g, "\\");
    if (unescaped !== rawPattern) {
      patterns.push(unescaped);
    }
  }

  patterns.push("\\b(\\d{6})\\b");

  for (const pattern of patterns) {
    try {
      const matches = extractRegexMatches(text, pattern);
      if (matches.length > 0) {
        // Prefer earliest match because OTP emails usually place latest code near the top.
        return matches[0];
      }
    } catch {
      // Ignore invalid custom regex and continue with fallbacks.
    }
  }

  return "";
}

async function fetchOtpCodeFromEmail(sinceDate) {
  const cfg = getOtpEmailConfig();
  const client = new ImapFlow({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: {
      user: cfg.username,
      pass: cfg.password,
    },
    logger: false,
  });

  const startedAt = Date.now();
  const loginMs = sinceDate instanceof Date ? sinceDate.getTime() : Date.now();
  const searchSince = new Date(Math.max(0, loginMs - cfg.lookbackMs));
  const acceptedSkewMs = Number(process.env.OTP_EMAIL_ACCEPT_SKEW_SECONDS || 60) * 1000;
  const minAcceptedMessageMs = Math.max(0, loginMs - acceptedSkewMs);

  await client.connect();
  const lock = await client.getMailboxLock(cfg.mailbox);
  try {
    while (Date.now() - startedAt < cfg.timeoutMs) {
      const searchQuery = { since: searchSince };
      if (cfg.fromFilter) searchQuery.from = cfg.fromFilter;

      let uids = await client.search(searchQuery);
      if (!uids.length && cfg.fromFilter) {
        // Sender matching can vary by alias/forwarding; retry without from filter.
        uids = await client.search({ since: searchSince });
      }
      const newestFirst = [...uids].sort((a, b) => b - a).slice(0, 30);

      for (const uid of newestFirst) {
        const msg = await client.fetchOne(uid, {
          envelope: true,
          internalDate: true,
          source: true,
        });
        if (!msg?.source) continue;
        if (msg.internalDate && msg.internalDate < searchSince) continue;
        if (msg.internalDate && msg.internalDate.getTime() < minAcceptedMessageMs) continue;

        const subject = String(msg.envelope?.subject || "");
        if (cfg.subjectFilter && !subject.toLowerCase().includes(cfg.subjectFilter.toLowerCase())) {
          continue;
        }

        const raw = Buffer.from(msg.source).toString("utf8");
        const code = parseOtpFromRawMessage(raw, cfg.codeRegex);
        if (code) return code;
      }

      await client.noop().catch(() => {});
      await sleep(cfg.pollMs);
    }
  } finally {
    lock.release();
    await client.logout().catch(() => {});
  }

  throw new Error(
    `Timed out waiting for OTP email after ${Math.floor(cfg.timeoutMs / 1000)} seconds (mailbox=${cfg.mailbox}, fromFilter=${cfg.fromFilter || "none"}, subjectFilter=${cfg.subjectFilter || "none"}, lookbackMinutes=${Math.floor(cfg.lookbackMs / 60000)}).`,
  );
}

async function waitForDashboard(page) {
  const timeoutMs = Number(process.env.DASHBOARD_WAIT_SECONDS || 120) * 1000;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const url = page.url().toLowerCase();
    if (url.includes("/admin_panel/") && !url.includes("/sign-in")) return;

    const bodyText = await page.locator("body").innerText().catch(() => "");
    const bodyLower = String(bodyText || "").toLowerCase();
    if (bodyLower.includes("bot jobs dashboard")) return;
    if (bodyLower.includes("admin panel") && !bodyLower.includes("sign in to betterletter")) return;

    await sleep(1000);
  }

  const { screenshotPath, htmlPath } = await captureAuthDebugFiles(page);
  throw new Error(
    `Timed out waiting for dashboard after ${Math.floor(timeoutMs / 1000)} seconds. Current URL: ${page.url()}. Saved debug files: ${screenshotPath}, ${htmlPath}`,
  );
}

async function main() {
  const email = envValue(process.env.user_email);
  const password = envValue(process.env.user_password);
  const auto2faFromEmail = envFlag(process.env.AUTO_2FA_FROM_EMAIL);
  const headless = envFlag(process.env.AUTH_HEADLESS);

  if (!email || !password) {
    console.log("Missing user_email or user_password in .env");
    process.exit(1);
  }

  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({
    httpCredentials: getHttpCredentials(),
  });

  const page = await context.newPage();

  // Go straight to dashboard to trigger both basic auth and BetterLetter auth if needed.
  const response = await page.goto(DASHBOARD_URL, {
    waitUntil: "domcontentloaded",
  });
  const httpStatus = response?.status();
  if (httpStatus === 401 || httpStatus === 403) {
    throw new Error(
      `Dashboard returned HTTP ${httpStatus}. Set ADMIN_PANEL_USERNAME and ADMIN_PANEL_PASSWORD in .env and rerun save-auth-local.mjs.`,
    );
  }

  const didAutoLogin = await fillPrimaryLogin(page, email, password);

  if (didAutoLogin) {
    try {
      await waitFor2faOrDashboard(page);
    } catch (error) {
      if (!isSignInUrl(page.url())) throw error;

      console.log("[save-auth] First sign-in attempt did not progress. Retrying once...");
      await fillPrimaryLogin(page, email, password);
      await waitFor2faOrDashboard(page);
    }
  }

  if (isSignInUrl(page.url()) && !didAutoLogin) {
    throw new Error(
      "Reached sign-in page but could not auto-fill email/password. Check login selectors or sign in manually once, then rerun save-auth-local.mjs.",
    );
  }

  if (await is2faPage(page)) {
    if (auto2faFromEmail) {
      await submitOtpFromEmail(page, { allowRequestNewCode: true });
    } else {
      console.log("Primary login attempted. Enter only the 2FA security code in the browser.");
    }
  } else if (isSignInUrl(page.url())) {
    console.log("Primary login page still open; check credentials.");
  } else {
    console.log("Waiting for dashboard confirmation...");
  }

  const maxReloginCycles = Math.max(1, Number(process.env.OTP_RELOGIN_MAX_CYCLES || 3));
  let reachedDashboard = false;

  for (let cycle = 1; cycle <= maxReloginCycles; cycle += 1) {
    try {
      await waitForDashboard(page);
      reachedDashboard = true;
      break;
    } catch (error) {
      // Intermittent 2FA failures can bounce back to sign-in. Retry full cycles when enabled.
      const canRetry = auto2faFromEmail && cycle < maxReloginCycles;
      if (!canRetry || !isSignInUrl(page.url())) throw error;

      console.log(
        `[save-auth] Dashboard not reached after OTP. Retrying login + fresh 2FA code (${cycle + 1}/${maxReloginCycles})...`,
      );
      const retriedLogin = await fillPrimaryLogin(page, email, password);
      if (!retriedLogin) throw error;
      await waitFor2faOrDashboard(page);

      if (await is2faPage(page)) {
        await submitOtpFromEmail(page, { allowRequestNewCode: true });
      }
    }
  }

  if (!reachedDashboard) {
    throw new Error("Dashboard not reached after configured retry cycles.");
  }

  // Save session
  await context.storageState({ path: STORAGE_STATE_PATH });
  await browser.close();

  console.log(`Saved login session to ${STORAGE_STATE_PATH} ✅`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
