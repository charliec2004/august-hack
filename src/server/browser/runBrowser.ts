import "server-only";

import { randomBytes } from "node:crypto";
import path from "node:path";

import { loadArtifact, MAX_ARTIFACT_BYTES, safeFilename, storeArtifact } from "@/server/artifacts";
import { recordEvidence } from "@/server/db/evidence";
import { trace } from "@/server/db/traces";
import { hostOf, normalizeFact, selectRelevantText } from "@/server/providers/kernel";
import { isKernelNotFound, kernel } from "@/server/providers/kernelClient";
import type { ToolResult } from "@/server/types/domain";
import { originAllowed, normalizeLoginOrigin } from "@/server/vault/origin";
import { loginsForOrigin, markLoginUsed } from "@/server/vault/vault";
import { closeRunBrowsers, closeBrowserSession, openBrowserSession, runBrowserFor, type OpenedBrowser } from "./sessions";

/**
 * August's own browser for one worker run: ONE live Kernel session (stealth +
 * CAPTCHA solver, the user's persistent profile, the saved-logins vault linked)
 * reused across tool calls and closed when the run ends. The user can watch and
 * take control through Kernel's interactive live view at any time.
 *
 * Every step here is non-committing: reading, navigating, filling fields,
 * clicking ordinary controls, downloading, attaching files, and signing in with
 * a saved login. A control whose label looks like a commitment (buy, book,
 * send, submit, delete...) is refused; that final click goes through
 * propose_browser_action (exact-effect rail).
 *
 * Page content is untrusted data: bounded, returned as data, never instructions.
 */

const RUN_BROWSER_TIMEOUT_S = 300;
const NAV_TIMEOUT_MS = 45_000;
const DOWNLOAD_DIR = "/tmp/august-downloads";
const UPLOAD_DIR = "/tmp/august-uploads";

export type RunBrowserCtx = { userId: string; responsibilityId: string; runId: string };

type Result<T> = ToolResult<T>;
const fail = <T>(safeSummary: string, retry: Result<T>["retry"] = "never"): Result<T> => ({
  status: "failed",
  evidenceRefs: [],
  safeSummary,
  retry,
});
const blocked = <T>(safeSummary: string): Result<T> => ({ status: "blocked", evidenceRefs: [], safeSummary, retry: "after_user" });

/** Accessible names that mean "this click commits something". */
export const COMMIT_LABEL =
  /\b(buy|purchase|pay|checkout|check out|place (your )?order|order now|book|reserve|confirm|submit|send|subscribe|donate|transfer|delete|remove|cancel|unsubscribe|sign ?up|register|publish|post|accept|agree)\b/i;

export function looksCommitting(label: string): boolean {
  return COMMIT_LABEL.test(label.replace(/\s+/g, " "));
}

async function safeTrace(t: Parameters<typeof trace>[0]) {
  try {
    await trace(t);
  } catch {
    // observability only
  }
}

function assertHttpUrl(url: string) {
  const u = new URL(url);
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("Only http(s) URLs are allowed");
}

// ---------------------------------------------------------------------------
// Session

async function openRunBrowser(ctx: RunBrowserCtx): Promise<OpenedBrowser> {
  const existing = await runBrowserFor(ctx.runId);
  if (existing) return existing;
  try {
    const b = await openBrowserSession({
      userId: ctx.userId,
      responsibilityId: ctx.responsibilityId,
      workerRunId: ctx.runId,
      kind: "run",
      timeoutSeconds: RUN_BROWSER_TIMEOUT_S,
      withProfile: true,
      withVault: true,
      stealth: true,
    });
    await safeTrace({
      userId: ctx.userId,
      responsibilityId: ctx.responsibilityId,
      workerRunId: ctx.runId,
      kind: "tool.started",
      detail: {
        text: "Opened a browser",
        provider: "kernel",
        browserSessionId: b.id,
      },
    });
    return b;
  } catch (err) {
    // Lost a race for this run's single browser: use the winner.
    if ((err as { code?: string }).code === "23505") {
      const winner = await runBrowserFor(ctx.runId);
      if (winner) return winner;
    }
    throw err;
  }
}

/** Kernel's Playwright daemon occasionally drops a response right after a session starts. */
const TRANSIENT = /failed to read response|EOF|ECONNRESET|socket hang up/i;

/**
 * Runs Playwright code in the run's browser. If Kernel lost the session (idle
 * timeout, user closed it), the row is closed and ONE fresh browser is opened.
 * `idempotent` code (navigate + read) is retried once on a transient drop;
 * code that clicks or types never is.
 */
async function exec<T>(
  ctx: RunBrowserCtx,
  code: string,
  timeoutSec = 60,
  idempotent = false,
): Promise<{ browser: OpenedBrowser; value: T }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const browser = await openRunBrowser(ctx);
    try {
      const res = await kernel().browsers.playwright.execute(browser.kernelSessionId, { code, timeout_sec: timeoutSec });
      if (!res.success) throw new Error(`playwright: ${normalizeFact((res.error ?? "execution failed").replace(/\u001b\[[0-9;]*m/g, "")).slice(0, 300)}`);
      return { browser, value: res.result as T };
    } catch (err) {
      if (attempt === 0 && isKernelNotFound(err)) {
        await closeBrowserSession(browser.id, "gone");
        continue;
      }
      if (attempt === 0 && idempotent && TRANSIENT.test((err as Error).message ?? "")) {
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      throw err;
    }
  }
  throw new Error("browser unavailable");
}

export async function closeRunBrowser(runId: string): Promise<void> {
  await closeRunBrowsers(runId);
}

// ---------------------------------------------------------------------------
// Reading

export type PageControl = { kind: string; label: string; selector: string };
export type PageView = {
  url: string;
  title: string;
  /** Bounded visible text; untrusted. */
  text: string;
  /** Interactive elements with a suggested Playwright selector. Never includes input values. */
  controls: PageControl[];
  browserSessionId: string;
};

const SNAPSHOT_CODE = `
const text = await page.evaluate(() => (document.body ? document.body.innerText : ""));
const controls = await page.evaluate(() => {
  const out = [];
  const esc = (s) => s.replace(/"/g, '\\\\"');
  const els = Array.from(document.querySelectorAll('a[href],button,input,select,textarea,[role=button],[role=link]'));
  for (const el of els) {
    if (out.length >= 60) break;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (type === 'hidden') continue;
    const lbl = (el.labels && el.labels[0] && el.labels[0].innerText) || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || (tag === 'input' ? '' : el.innerText) || (type === 'submit' || type === 'button' ? el.value : '') || el.getAttribute('name') || '';
    const label = String(lbl).replace(/\\s+/g, ' ').trim().slice(0, 80);
    let selector = '';
    if (el.id && document.querySelectorAll('#' + CSS.escape(el.id)).length === 1) selector = '#' + CSS.escape(el.id);
    else if (el.getAttribute('name')) selector = tag + '[name="' + esc(el.getAttribute('name')) + '"]';
    else if (label && (tag === 'a' || tag === 'button')) selector = tag + ':has-text("' + esc(label.slice(0, 40)) + '")';
    if (!selector) continue;
    out.push({ kind: tag === 'input' ? 'input:' + (type || 'text') : tag, label, selector });
  }
  return out;
});
return { url: page.url(), title: await page.title(), text: String(text).slice(0, 40000), controls };
`;

async function snapshot(
  ctx: RunBrowserCtx,
  instruction: string | undefined,
  prefix = "",
): Promise<Result<PageView>> {
  const { browser, value } = await exec<{ url: string; title: string; text: string; controls: PageControl[] }>(
    ctx,
    `${prefix}\n${SNAPSHOT_CODE}`,
    NAV_TIMEOUT_MS / 1000 + 30,
    true,
  );
  const text = selectRelevantText(value.text ?? "", instruction);
  const title = normalizeFact(value.title).slice(0, 200);
  const evidenceId = await recordEvidence({
    userId: ctx.userId,
    responsibilityId: ctx.responsibilityId,
    provider: "kernel",
    sourceUrl: value.url,
    sourceRef: browser.kernelSessionId,
    safeSummary: `${title || hostOf(value.url)}: ${text.slice(0, 1500)}`,
    payload: { url: value.url, title, text, instruction: instruction ?? null },
  });
  return {
    status: "succeeded",
    data: { url: value.url, title, text, controls: (value.controls ?? []).slice(0, 60), browserSessionId: browser.id },
    evidenceRefs: [evidenceId],
    safeSummary: `On "${title || hostOf(value.url)}" (${text.length} chars, ${value.controls?.length ?? 0} controls).`,
    retry: "safe",
  };
}

async function guarded<T>(ctx: RunBrowserCtx, what: string, host: string, fn: () => Promise<Result<T>>): Promise<Result<T>> {
  try {
    const r = await fn();
    await safeTrace({
      userId: ctx.userId,
      responsibilityId: ctx.responsibilityId,
      workerRunId: ctx.runId,
      kind: r.status === "succeeded" ? "tool.succeeded" : "tool.failed",
      detail: {
        text: r.status === "succeeded" ? what : `Ran into trouble on ${host}`,
        provider: "kernel",
        browserSessionId: (r.data as { browserSessionId?: string } | undefined)?.browserSessionId ?? null,
      },
    });
    return r;
  } catch (err) {
    await safeTrace({
      userId: ctx.userId,
      responsibilityId: ctx.responsibilityId,
      workerRunId: ctx.runId,
      kind: "tool.failed",
      detail: { text: `Browser trouble on ${host}`, provider: "kernel" },
    });
    return fail(`Browser step failed: ${normalizeFact((err as Error).message).slice(0, 200)}`, "after_backoff");
  }
}

/** Navigate the run's browser and read the page. */
export async function browserGoto(ctx: RunBrowserCtx, url: string, instruction?: string): Promise<Result<PageView>> {
  try {
    assertHttpUrl(url);
  } catch {
    return fail("Invalid URL.");
  }
  const host = hostOf(url);
  return guarded(ctx, `Browsed ${host}`, host, () =>
    snapshot(
      ctx,
      instruction,
      `await page.goto(${JSON.stringify(url)}, { waitUntil: "domcontentloaded", timeout: ${NAV_TIMEOUT_MS} });
await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});`,
    ),
  );
}

export async function browserReadPage(ctx: RunBrowserCtx, instruction?: string): Promise<Result<PageView>> {
  return guarded(ctx, "Read the page", "the page", () => snapshot(ctx, instruction));
}

// ---------------------------------------------------------------------------
// Non-committing interaction

export type ActStep =
  | { click: string }
  | { fill: string; value: string }
  | { select: string; value: string }
  | { press: string; selector?: string };

const SAFE_KEYS = new Set(["Tab", "Escape", "ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "PageDown", "PageUp", "Home", "End", "Space"]);

/**
 * Fill fields / click ordinary controls / press keys. Refuses: committing
 * controls (use propose_browser_action), typing into password fields (use
 * vault_sign_in), and Enter except in a search box.
 */
export async function browserAct(ctx: RunBrowserCtx, steps: ActStep[], instruction?: string): Promise<Result<PageView>> {
  if (!steps.length || steps.length > 15) return fail("Give 1-15 steps.");
  for (const s of steps) {
    if ("press" in s && !SAFE_KEYS.has(s.press) && s.press !== "Enter") return fail(`Key "${s.press}" isn't allowed here.`);
  }
  const code = `
const steps = ${JSON.stringify(steps)};
const COMMIT = new RegExp(${JSON.stringify(COMMIT_LABEL.source)}, "i");
const labelOf = async (loc) => (await loc.evaluate((el) => [el.innerText, el.value && (el.type === "submit" || el.type === "button") ? el.value : "", el.getAttribute("aria-label"), el.getAttribute("title")].filter(Boolean).join(" "))).replace(/\\s+/g, " ").trim();
for (let i = 0; i < steps.length; i++) {
  const s = steps[i];
  if (s.click) {
    const loc = page.locator(s.click).first();
    await loc.waitFor({ state: "visible", timeout: 10000 });
    const label = await labelOf(loc);
    if (COMMIT.test(label)) return { refused: "commit", index: i, label: label.slice(0, 80) };
    await loc.click({ timeout: 10000 });
    await page.waitForLoadState("domcontentloaded").catch(() => {});
  } else if (s.fill !== undefined) {
    const loc = page.locator(s.fill).first();
    const type = await loc.evaluate((el) => (el.getAttribute("type") || "").toLowerCase(), null, { timeout: 10000 });
    if (type === "password") return { refused: "password", index: i };
    await loc.fill(String(s.value), { timeout: 10000 });
  } else if (s.select !== undefined) {
    await page.locator(s.select).first().selectOption(String(s.value), { timeout: 10000 });
  } else if (s.press) {
    const loc = s.selector ? page.locator(s.selector).first() : null;
    if (s.press === "Enter") {
      const ok = await (loc || page.locator(":focus")).evaluate((e) => {
        const t = (e.getAttribute("type") || "").toLowerCase();
        const hint = [e.getAttribute("name"), e.id, e.getAttribute("placeholder"), e.getAttribute("aria-label"), e.getAttribute("role")].join(" ").toLowerCase();
        return t === "search" || /search|query|^q\\b|\\bq$/.test(hint);
      }, null, { timeout: 5000 }).catch(() => false);
      if (!ok) return { refused: "enter", index: i };
    }
    if (loc) await loc.press(s.press, { timeout: 10000 }); else await page.keyboard.press(s.press);
    await page.waitForLoadState("domcontentloaded").catch(() => {});
  }
}
await page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => {});
return { refused: null };`;
  return guarded(ctx, "Filled in the page", "the page", async () => {
    const { value } = await exec<{ refused: string | null; index?: number; label?: string }>(ctx, code, 90);
    if (value.refused === "commit") {
      return blocked(
        `Step ${value.index! + 1} ("${value.label}") looks like a final commitment; nothing was clicked. Use propose_browser_action for it.`,
      );
    }
    if (value.refused === "password") return blocked(`Step ${value.index! + 1} targets a password field. Use vault_sign_in; never type passwords.`);
    if (value.refused === "enter") {
      return blocked(`Step ${value.index! + 1}: Enter is only allowed in a search box (it could submit a form). Click a non-committing control instead.`);
    }
    return snapshot(ctx, instruction);
  });
}

// ---------------------------------------------------------------------------
// Files: screenshot, download, upload

export type ArtifactRef = { artifactId: string; filename: string; mediaType: string; sha256: string; byteCount: number; browserSessionId: string };

export async function browserScreenshot(ctx: RunBrowserCtx): Promise<Result<ArtifactRef>> {
  return guarded(ctx, "Took a screenshot", "the page", async () => {
    const browser = await openRunBrowser(ctx);
    const res = await kernel().browsers.computer.captureScreenshot(browser.kernelSessionId);
    const bytes = Buffer.from(await res.arrayBuffer());
    const a = await storeArtifact({
      userId: ctx.userId,
      responsibilityId: ctx.responsibilityId,
      bytes,
      filename: `screenshot-${Date.now()}.png`,
      mediaType: "image/png",
    });
    const ev = await recordEvidence({
      userId: ctx.userId,
      responsibilityId: ctx.responsibilityId,
      provider: "kernel",
      sourceRef: `artifact:${a.artifactId}`,
      safeSummary: `Screenshot of the browser (${a.byteCount} bytes)`,
      payload: { artifactId: a.artifactId, sha256: a.sha256 },
    });
    return {
      status: "succeeded",
      data: { ...a, browserSessionId: browser.id },
      evidenceRefs: [ev],
      safeSummary: `Saved a screenshot as artifact ${a.artifactId}.`,
      retry: "safe",
    };
  });
}

/**
 * Downloads a file in the browser (click a link/button on the current page, or
 * open a direct file URL), then stores it in object storage as an artifact.
 */
export async function browserDownload(
  ctx: RunBrowserCtx,
  args: { clickSelector?: string; url?: string },
): Promise<Result<ArtifactRef>> {
  if (!args.clickSelector === !args.url) return fail("Give exactly one of clickSelector or url.");
  if (args.url) {
    try {
      assertHttpUrl(args.url);
    } catch {
      return fail("Invalid URL.");
    }
  }
  const trigger = args.url
    ? `await page.goto(${JSON.stringify(args.url)}, { timeout: ${NAV_TIMEOUT_MS} }).catch(() => {});`
    : `{ const loc = page.locator(${JSON.stringify(args.clickSelector)}).first();
  const label = (await loc.innerText({ timeout: 10000 }).catch(() => "")).replace(/\\s+/g, " ").trim();
  if (new RegExp(${JSON.stringify(COMMIT_LABEL.source)}, "i").test(label)) return { refused: label.slice(0, 80) };
  await loc.click({ timeout: 10000 }); }`;
  const code = `
const cdp = await context.newCDPSession(page);
await cdp.send("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: ${JSON.stringify(DOWNLOAD_DIR)}, eventsEnabled: true });
let name = null;
cdp.on("Browser.downloadWillBegin", (e) => { name = e.suggestedFilename; });
const done = new Promise((res) => cdp.on("Browser.downloadProgress", (e) => { if (e.state === "completed" || e.state === "canceled") res(e); }));
${trigger}
const e = await Promise.race([done, new Promise((r) => setTimeout(() => r({ state: "timeout" }), 45000))]);
return { state: e.state, filePath: e.filePath || null, bytes: e.totalBytes || e.receivedBytes || 0, name, pageUrl: page.url() };`;
  const host = args.url ? hostOf(args.url) : "the page";
  return guarded(ctx, `Downloaded a file from ${host}`, host, async () => {
    const { browser, value } = await exec<{
      refused?: string;
      state?: string;
      filePath?: string | null;
      bytes?: number;
      name?: string | null;
      pageUrl?: string;
    }>(ctx, code, 75);
    if (value.refused) return blocked(`"${value.refused}" looks like a commitment; nothing was clicked.`);
    if (value.state !== "completed" || !value.filePath) {
      return fail(value.state === "timeout" ? "No download started within 45s." : `Download ${value.state ?? "failed"}.`, "safe");
    }
    if ((value.bytes ?? 0) > MAX_ARTIFACT_BYTES) return fail("Downloaded file is too large (over 50 MB).");
    const res = await kernel().browsers.fs.readFile(browser.kernelSessionId, { path: value.filePath });
    const bytes = Buffer.from(await res.arrayBuffer());
    const a = await storeArtifact({
      userId: ctx.userId,
      responsibilityId: ctx.responsibilityId,
      bytes,
      filename: value.name || path.posix.basename(value.filePath),
    });
    await kernel().browsers.fs.deleteFile(browser.kernelSessionId, { path: value.filePath }).catch(() => {});
    const ev = await recordEvidence({
      userId: ctx.userId,
      responsibilityId: ctx.responsibilityId,
      provider: "kernel",
      sourceUrl: args.url ?? value.pageUrl ?? null,
      sourceRef: `artifact:${a.artifactId}`,
      safeSummary: `Downloaded ${a.filename} (${a.byteCount} bytes, sha256 ${a.sha256.slice(0, 12)}…)`,
      payload: { artifactId: a.artifactId, sha256: a.sha256, filename: a.filename },
    });
    return {
      status: "succeeded",
      data: { ...a, browserSessionId: browser.id },
      evidenceRefs: [ev],
      safeSummary: `Downloaded ${a.filename} (${a.byteCount} bytes) as artifact ${a.artifactId}.`,
      retry: "safe",
    };
  });
}

/** Attaches a stored artifact to a file input on the current page (does not submit). */
export async function browserUpload(
  ctx: RunBrowserCtx,
  args: { artifactId: string; selector: string },
): Promise<Result<{ filename: string; browserSessionId: string }>> {
  return guarded(ctx, "Attached a file", "the page", async () => {
    const art = await loadArtifact(ctx.userId, args.artifactId);
    if (!art) return fail("Unknown artifact.");
    const browser = await openRunBrowser(ctx);
    const remote = `${UPLOAD_DIR}/${randomBytes(6).toString("hex")}/${safeFilename(art.filename)}`;
    await kernel().browsers.fs.writeFile(browser.kernelSessionId, art.bytes, { path: remote });
    await exec(
      ctx,
      `const loc = page.locator(${JSON.stringify(args.selector)}).first();
const type = await loc.evaluate((el) => el.tagName.toLowerCase() + ":" + (el.getAttribute("type") || ""), null, { timeout: 10000 });
if (type !== "input:file") throw new Error("selector is not a file input");
await loc.setInputFiles(${JSON.stringify(remote)});
return true;`,
      40,
    );
    return {
      status: "succeeded",
      data: { filename: art.filename, browserSessionId: browser.id },
      evidenceRefs: [],
      safeSummary: `Attached ${art.filename} (${art.byteCount} bytes) to the form. Nothing was submitted.`,
      retry: "safe",
    };
  });
}

// ---------------------------------------------------------------------------
// Vault sign-in

export type SignInResult = { signedIn: boolean; url: string; title: string; text: string; login: string; browserSessionId: string };

const FIND_LOGIN_FIELDS = (nonce: string) => `
const nonce = ${JSON.stringify(nonce)};
// Main frame only: the exact-origin check below is about THIS document.
return await page.evaluate((nonce) => {
  const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && !el.disabled; };
  const pw = Array.from(document.querySelectorAll('input[type="password"]')).find(vis) || null;
  const candidates = Array.from(document.querySelectorAll('input[type="email"],input[type="text"],input:not([type]),input[type="tel"]')).filter(vis);
  let user = null;
  if (pw) {
    const before = candidates.filter((el) => el.compareDocumentPosition(pw) & Node.DOCUMENT_POSITION_FOLLOWING);
    user = before.length ? before[before.length - 1] : null;
  } else {
    user = candidates.find((el) => /user|email|login|account|identifier/i.test([el.name, el.id, el.autocomplete, el.placeholder, el.getAttribute("aria-label")].join(" "))) || null;
  }
  if (user) user.setAttribute("data-august-fill", "u-" + nonce);
  if (pw) pw.setAttribute("data-august-fill", "p-" + nonce);
  return { url: location.href, user: !!user, pw: !!pw };
}, nonce);`;

/**
 * Signs in to `origin` with a saved login bound to that exact origin. Kernel
 * fills the fields from its vault directly into the page; neither the model nor
 * August's server ever sees the password. The fill targets only elements we
 * tagged in the main document after verifying its exact origin, and passes the
 * exact page URL so Kernel refuses if the page navigated in between.
 */
export async function vaultSignIn(
  ctx: RunBrowserCtx,
  args: { origin: string; loginId?: string },
): Promise<Result<SignInResult>> {
  const origin = normalizeLoginOrigin(args.origin);
  if (!origin) return fail("origin must be an https:// website address.");
  const host = new URL(origin).host;
  const logins = await loginsForOrigin(ctx.userId, origin);
  const login = args.loginId ? logins.find((l) => l.id === args.loginId) : logins[0];
  if (!login) {
    return blocked(`No saved login for ${origin}. Ask the user to add one in Logins (it's bound to that exact website).`);
  }

  return guarded(ctx, `Signed in to ${host} with your saved login`, host, async () => {
    // Be on the login's site; if the current page has no form, open the login's start page once.
    const start = login.loginUrl && originAllowed(login.loginUrl, login.origins) ? login.loginUrl : origin;
    const gotoStart = () =>
      exec(ctx, `await page.goto(${JSON.stringify(start)}, { waitUntil: "domcontentloaded", timeout: ${NAV_TIMEOUT_MS} });
await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
return true;`, NAV_TIMEOUT_MS / 1000 + 20, true);
    const where = await exec<{ url: string }>(ctx, `return { url: page.url() };`, 30, true);
    let navigated = false;
    if (!originAllowed(where.value.url, [origin])) {
      await gotoStart();
      navigated = true;
    }

    let filledPassword = false;
    for (let stepNo = 0; stepNo < 2 && !filledPassword; stepNo++) {
      const nonce = randomBytes(8).toString("hex");
      const { browser, value: found } = await exec<{ url: string; user: boolean; pw: boolean }>(ctx, FIND_LOGIN_FIELDS(nonce));
      if (!originAllowed(found.url, login.origins) || normalizeLoginOrigin(found.url) !== origin) {
        return blocked(`The page is on ${hostOf(found.url)}, not ${host}; the saved login is only allowed on ${login.origins.join(", ")}.`);
      }
      if (!found.user && !found.pw) {
        if (stepNo === 0 && !navigated) {
          await gotoStart();
          navigated = true;
          stepNo -= 1;
          continue;
        }
        if (stepNo === 0) {
          return fail(`No sign-in form found on ${hostOf(found.url)}. Navigate to the sign-in page (or click "Sign in") first.`, "safe");
        }
        break;
      }
      const fields = [
        ...(found.user ? [{ field: "username", selector: `[data-august-fill="u-${nonce}"]` }] : []),
        ...(found.pw ? [{ field: "password", selector: `[data-august-fill="p-${nonce}"]` }] : []),
      ];
      const op = (await kernel().vaults.items.performOperation(login.itemKey, {
        id_or_name: login.vault,
        type: "fill",
        browser_id: browser.kernelSessionId,
        page_url: found.url,
        fields,
        timeout_ms: 15_000,
      })) as { type?: string; status?: string; fields?: { status: string; error_code?: string }[] };
      if (op.status !== "completed") {
        const code = op.fields?.find((f) => f.error_code)?.error_code ?? op.status ?? "unknown";
        return fail(`Kernel could not fill the saved login (${code}). Do not retry automatically.`, "after_user");
      }
      filledPassword = found.pw;
      // Submit the sign-in form from the field we filled last (Enter on a login form is the sign-in, not a commitment).
      const last = found.pw ? `p-${nonce}` : `u-${nonce}`;
      await exec(ctx, `await page.locator('[data-august-fill="${last}"]').press("Enter");
await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
await page.waitForLoadState("networkidle", { timeout: 6000 }).catch(() => {});
return true;`, 40);
    }
    await markLoginUsed(login.id);

    const after = await snapshot(ctx, "welcome signed logged account sign out log out logout dashboard error invalid incorrect");
    if (after.status !== "succeeded" || !after.data) return after as Result<never>;
    const stillOnForm = await exec<boolean>(
      ctx,
      `return await page.locator('input[type="password"]:visible').count().then((n) => n > 0).catch(() => false);`,
    );
    const signedIn = filledPassword && !stillOnForm.value;
    return {
      status: signedIn ? "succeeded" : "failed",
      data: {
        signedIn,
        url: after.data.url,
        title: after.data.title,
        text: after.data.text.slice(0, 1500),
        login: login.label,
        browserSessionId: after.data.browserSessionId,
      },
      evidenceRefs: after.evidenceRefs,
      safeSummary: signedIn
        ? `Signed in to ${host} with the saved login "${login.label}". The session is saved to the user's browser profile.`
        : `Filled the saved login on ${host} but the sign-in form is still showing (wrong password, extra verification, or CAPTCHA). The user can take over in the live browser.`,
      retry: signedIn ? "safe" : "after_user",
    };
  });
}
