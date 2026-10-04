import "server-only";

import { closeBrowserSession, openBrowserSession } from "@/server/browser/sessions";
import { recordEvidence } from "@/server/db/evidence";
import { trace } from "@/server/db/traces";
import { kernel } from "./kernelClient";
import type { AuthorizedEffect, DispatchResult, EffectDraft } from "@/server/effects/types";
import type { ToolResult } from "@/server/types/domain";

/**
 * Kernel browser adapter (spec sections 19, 41.3).
 *
 * Uses Kernel's server-side Playwright execution
 * (`kernel.browsers.playwright.execute(sessionId, { code })`), so no local
 * Playwright/CDP dependency is needed. Every session here is short-lived, is
 * owned by a browser_sessions row (src/server/browser/sessions.ts), and is
 * ALWAYS deleted + closed in `finally`. The interactive live view URL lives on
 * that row while it is live; traces carry only `browserSessionId`.
 *
 * All page text is untrusted content: it is bounded and returned as data, and
 * nothing on a page can widen scope or grant permission.
 */

const MAX_PAGE_TEXT = 3000;
const SESSION_TIMEOUT_S = 300;
const NAV_TIMEOUT_MS = 30_000;

export type FillStep = { selector: string; value: string };
export type ClickStep = { click: string };
export type PreStep = FillStep | ClickStep;

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

export function normalizeFact(v: unknown): string {
  return String(v ?? "").replace(/\s+/g, " ").trim();
}

/** Keys whose normalized value differs between expected and observed. */
export function diffFacts(expected: Record<string, unknown>, observed: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(expected), ...Object.keys(observed)]);
  return [...keys].filter((k) => normalizeFact(expected[k]) !== normalizeFact(observed[k])).sort();
}

/**
 * Pick the most instruction-relevant lines first, then fill with the rest, up
 * to `max` chars. Without an instruction, plain head truncation.
 */
export function selectRelevantText(text: string, instruction: string | undefined, max = MAX_PAGE_TEXT): string {
  const lines = text
    .split(/\n+/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const terms = (instruction ?? "")
    .toLowerCase()
    .split(/[^a-z0-9$:]+/)
    .filter((t) => t.length > 2);
  let ordered = lines;
  if (terms.length > 0) {
    const scored = lines.map((l, i) => {
      const low = l.toLowerCase();
      return { l, i, s: terms.reduce((n, t) => n + (low.includes(t) ? 1 : 0), 0) };
    });
    const hits = scored.filter((x) => x.s > 0).sort((a, b) => b.s - a.s || a.i - b.i);
    const hitIdx = new Set(hits.map((h) => h.i));
    ordered = [...hits.map((h) => h.l), ...scored.filter((x) => !hitIdx.has(x.i)).map((x) => x.l)];
  }
  let out = "";
  for (const l of ordered) {
    if (out.length + l.length + 1 > max) {
      if (!out) out = l.slice(0, max);
      break;
    }
    out += (out ? "\n" : "") + l;
  }
  return out;
}

/** Best-effort confirmation/reference code from a confirmation page. */
export function extractConfirmationRef(text: string): string | null {
  const m = /(confirmation|reference|booking|order|reservation)\s*(number|code|id|no\.?|#)?\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{3,})/i.exec(text);
  return m ? m[3] : null;
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "a website";
  }
}

function assertHttpUrl(url: string) {
  const u = new URL(url);
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("Only http(s) URLs are allowed");
}

// ---------------------------------------------------------------------------
// Sandbox program fragments (run inside Kernel's Playwright VM)
// ---------------------------------------------------------------------------

const SANDBOX_HELPERS = `
const __norm = (v) => String(v ?? "").replace(/\\s+/g, " ").trim();
const __pre = async (steps) => {
  for (const s of steps) {
    if (s.click) { await page.locator(s.click).first().click({ timeout: 10000 }); await page.waitForLoadState("domcontentloaded").catch(() => {}); }
    else { await page.locator(s.selector).first().fill(String(s.value), { timeout: 10000 }); }
  }
};
const __commit = (spec) => {
  if (spec.commitSelector) return page.locator(spec.commitSelector).first();
  const re = new RegExp(spec.commitText, "i");
  return page.getByRole("button", { name: re }).or(page.getByRole("link", { name: re })).first();
};
const __observe = async (spec) => {
  const facts = {};
  for (const [k, sel] of Object.entries(spec.factSelectors || {})) {
    try { facts[k] = __norm(await page.locator(sel).first().innerText({ timeout: 5000 })); } catch { facts[k] = null; }
  }
  const tf = spec.textFacts || {};
  if (Object.keys(tf).length) {
    const body = __norm(await page.evaluate(() => (document.body ? document.body.innerText : ""))).toLowerCase();
    for (const [k, v] of Object.entries(tf)) facts[k] = body.includes(__norm(v).toLowerCase()) ? __norm(v) : null;
  }
  const u = new URL(page.url());
  facts.__page = u.host + u.pathname;
  let commitText = null, commitVisible = false;
  try {
    const c = __commit(spec);
    commitVisible = await c.waitFor({ state: "visible", timeout: 8000 }).then(() => true, () => false);
    commitText = __norm((await c.innerText({ timeout: 3000 }).catch(() => "")) || (await c.getAttribute("value")) || "");
  } catch {}
  facts.__commitControl = commitText;
  return { facts, commitVisible, title: await page.title() };
};
`;

/** Default accessible-name pattern for the final control, per policy action. */
export function defaultCommitText(action: string): string {
  if (action === "book") return "^\\s*(book|reserve|confirm|complete)";
  if (action === "send") return "^\\s*(send|submit)";
  return "^\\s*(submit|send|confirm|place|continue)";
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

async function safeTrace(t: Parameters<typeof trace>[0]) {
  try {
    await trace(t);
  } catch {
    // observability only
  }
}

type Session = { id: string; browserSessionId: string; liveViewUrl: string | null };

/** Receives the live view URL when a session starts (short-lived UI metadata). */
export type LiveViewCallback = (url: string) => void | Promise<void>;

type SessionOwner = {
  userId: string;
  responsibilityId: string | null;
  workerRunId?: string | null;
  onLiveView?: LiveViewCallback;
  /** Load the user's saved sign-ins (persistent profile) with stealth + CAPTCHA solving. */
  signedIn?: boolean;
};

/**
 * One-shot session owned by browser_sessions: opened as a lifecycle row, ALWAYS
 * deleted and closed in `finally`.
 */
async function withSession<T>(owner: SessionOwner, fn: (s: Session) => Promise<T>): Promise<T> {
  const opened = await openBrowserSession({
    userId: owner.userId,
    responsibilityId: owner.responsibilityId,
    workerRunId: owner.workerRunId ?? null,
    kind: "task",
    timeoutSeconds: SESSION_TIMEOUT_S,
    withProfile: owner.signedIn,
    stealth: owner.signedIn,
  });
  const session: Session = { id: opened.kernelSessionId, browserSessionId: opened.id, liveViewUrl: opened.liveViewUrl };
  try {
    if (session.liveViewUrl && owner.onLiveView) {
      try {
        await owner.onLiveView(session.liveViewUrl);
      } catch {
        // UI callback must never break the browser task.
      }
    }
    return await fn(session);
  } finally {
    await closeBrowserSession(opened.id, "released").catch(() => {
      // reconcileBrowserSessions closes it later.
    });
  }
}

async function runPlaywright<T>(sessionId: string, code: string, timeoutSec = 60): Promise<T> {
  const res = await kernel().browsers.playwright.execute(sessionId, { code, timeout_sec: timeoutSec });
  if (!res.success) throw new Error(`playwright: ${(res.error ?? "execution failed").slice(0, 300)}`);
  return res.result as T;
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export type BrowserReadData = {
  url: string;
  finalUrl: string;
  title: string;
  /** Bounded visible text; untrusted. */
  text: string;
  sessionId: string;
};

export async function browserRead(args: {
  userId: string;
  responsibilityId: string | null;
  url: string;
  instruction?: string;
  workerRunId?: string | null;
  onLiveView?: LiveViewCallback;
  activityText?: string;
}): Promise<ToolResult<BrowserReadData>> {
  const { userId, responsibilityId, url } = args;
  try {
    assertHttpUrl(url);
  } catch {
    return { status: "failed", evidenceRefs: [], safeSummary: "Invalid URL.", retry: "never" };
  }
  const host = hostOf(url);
  const activity = args.activityText ?? `Checked ${host}`;

  try {
    return await withSession({ userId, responsibilityId, workerRunId: args.workerRunId, onLiveView: args.onLiveView }, async (session) => {
      await safeTrace({
        userId,
        responsibilityId,
        kind: "tool.started",
        detail: { text: `Opening ${host}`, provider: "kernel", browserSessionId: session.browserSessionId },
      });
      const page = await runPlaywright<{ title: string; finalUrl: string; text: string }>(
        session.id,
        `await page.goto(${JSON.stringify(url)}, { waitUntil: "domcontentloaded", timeout: ${NAV_TIMEOUT_MS} });
await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
const text = await page.evaluate(() => (document.body ? document.body.innerText : ""));
return { title: await page.title(), finalUrl: page.url(), text: String(text).slice(0, 40000) };`,
        NAV_TIMEOUT_MS / 1000 + 20,
      );
      const text = selectRelevantText(page.text ?? "", args.instruction);
      const title = normalizeFact(page.title).slice(0, 200);
      const evidenceId = await recordEvidence({
        userId,
        responsibilityId,
        provider: "kernel",
        sourceUrl: page.finalUrl || url,
        sourceRef: session.id,
        safeSummary: `${title || host}: ${text.slice(0, 1500)}`,
        payload: { url, finalUrl: page.finalUrl, title, text, instruction: args.instruction ?? null },
      });
      await safeTrace({ userId, responsibilityId, kind: "tool.succeeded", detail: { text: activity, provider: "kernel" } });
      return {
        status: "succeeded" as const,
        data: { url, finalUrl: page.finalUrl, title, text, sessionId: session.id },
        evidenceRefs: [evidenceId],
        safeSummary: `Read "${title || host}" (${text.length} chars of page text).`,
        retry: "safe" as const,
      };
    });
  } catch (err) {
    await safeTrace({ userId, responsibilityId, kind: "tool.failed", detail: { text: `Couldn't open ${host}`, provider: "kernel" } });
    return {
      status: "failed",
      evidenceRefs: [],
      safeSummary: `Browser read of ${host} failed: ${normalizeFact((err as Error).message).slice(0, 200)}`,
      retry: "after_backoff",
    };
  }
}

export type BrowserCommitArgs = {
  url: string;
  /** Non-committing steps to reach the final control (fill fields, open dialogs). */
  steps: PreStep[];
  /** CSS selector of the final committing control; else `commitText` is used. */
  commitSelector?: string;
  /** Case-insensitive regex source for the final control's accessible name. */
  commitText: string;
  /** Named selectors whose text is a material fact (price, time, party size...). */
  factSelectors: Record<string, string>;
  /** Facts the Worker expects; each must appear verbatim (normalized) in page text. */
  textFacts: Record<string, string>;
  /** Optional selector that appears on the confirmation page. */
  confirmationSelector?: string;
  /** Worker's description of the action; recorded for review, never executed. */
  instruction?: string;
};

export type PrepareCommitInput = {
  userId: string;
  responsibilityId: string | null;
  /** Kernel policy action, e.g. "book" | "submit_form" | "send". */
  action: string;
  url: string;
  steps?: PreStep[];
  commitSelector?: string;
  commitText?: string;
  factSelectors?: Record<string, string>;
  /** Expected material facts (business, time, party size, price...) verified as visible on the page. */
  expectedFacts?: Record<string, unknown>;
  confirmationSelector?: string;
  instruction?: string;
  workerRunId?: string | null;
  onLiveView?: LiveViewCallback;
};

/** Pure: frozen commit args from a prepare request (exported for tests). */
export function buildCommitArgs(input: Omit<PrepareCommitInput, "userId" | "responsibilityId" | "onLiveView" | "workerRunId">): BrowserCommitArgs {
  const textFacts: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.expectedFacts ?? {})) {
    if (v === null || v === undefined) continue;
    const s = normalizeFact(typeof v === "object" ? JSON.stringify(v) : v);
    if (s) textFacts[k] = s;
  }
  return {
    url: input.url,
    steps: input.steps ?? [],
    ...(input.commitSelector ? { commitSelector: input.commitSelector } : {}),
    commitText: input.commitText ?? defaultCommitText(input.action),
    factSelectors: input.factSelectors ?? {},
    textFacts,
    ...(input.confirmationSelector ? { confirmationSelector: input.confirmationSelector } : {}),
    ...(input.instruction ? { instruction: input.instruction.slice(0, 1000) } : {}),
  };
}

/**
 * Observe material facts immediately before a consequential click and return
 * an EffectDraft (provider "kernel") in `data`, with the frozen commit args.
 * Never clicks the commit control. `status` is "blocked" (facts_missing) when
 * an expected fact isn't on the page, "failed" when the commit control is missing.
 */
export async function browserPrepareCommit(args: PrepareCommitInput): Promise<ToolResult<EffectDraft>> {
  const { userId, responsibilityId, url } = args;
  try {
    assertHttpUrl(url);
  } catch {
    return { status: "failed", evidenceRefs: [], safeSummary: "Invalid URL.", retry: "never" };
  }
  const host = hostOf(url);
  const commitArgs = buildCommitArgs(args);
  if (!commitArgs.commitSelector && Object.keys(commitArgs.factSelectors).length + Object.keys(commitArgs.textFacts).length === 0) {
    return { status: "failed", evidenceRefs: [], safeSummary: "facts_required: give expectedFacts or factSelectors to verify.", retry: "never" };
  }

  try {
    return await withSession({ userId, responsibilityId, workerRunId: args.workerRunId, onLiveView: args.onLiveView, signedIn: true }, async (session) => {
      await safeTrace({ userId, responsibilityId, kind: "tool.started", detail: { text: `Opening ${host}`, provider: "kernel", browserSessionId: session.browserSessionId } });
      const obs = await runPlaywright<{ facts: Record<string, string | null>; commitVisible: boolean; title: string }>(
        session.id,
        `${SANDBOX_HELPERS}
await page.goto(${JSON.stringify(url)}, { waitUntil: "domcontentloaded", timeout: ${NAV_TIMEOUT_MS} });
await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
await __pre(${JSON.stringify(commitArgs.steps)});
return await __observe(${JSON.stringify(commitArgs)});`,
        90,
      );
      const missing = [...Object.keys(commitArgs.factSelectors), ...Object.keys(commitArgs.textFacts)].filter(
        (k) => obs.facts[k] == null || obs.facts[k] === "",
      );
      const evidenceId = await recordEvidence({
        userId,
        responsibilityId,
        provider: "kernel",
        sourceUrl: url,
        sourceRef: session.id,
        safeSummary: `Before ${args.action} on ${host}: ${Object.entries(obs.facts)
          .map(([k, v]) => `${k}=${v ?? "NOT FOUND"}`)
          .join("; ")}`.slice(0, 2000),
        payload: { stage: "prepare", action: args.action, facts: obs.facts, title: obs.title, commitVisible: obs.commitVisible },
      });
      if (!obs.commitVisible) {
        await safeTrace({ userId, responsibilityId, kind: "tool.failed", detail: { text: `Couldn't find the final step on ${host}`, provider: "kernel" } });
        return { status: "failed" as const, evidenceRefs: [evidenceId], safeSummary: "commit_control_missing: the final control was not visible.", retry: "never" as const };
      }
      if (missing.length) {
        await safeTrace({ userId, responsibilityId, kind: "tool.failed", detail: { text: `Details on ${host} didn't match`, provider: "kernel" } });
        return {
          status: "blocked" as const,
          evidenceRefs: [evidenceId],
          safeSummary: `facts_missing: ${missing.join(", ")} not found on ${host}.`,
          retry: "after_user" as const,
        };
      }
      await safeTrace({ userId, responsibilityId, kind: "tool.succeeded", detail: { text: `Checked details on ${host}`, provider: "kernel" } });
      const draft: EffectDraft = {
        provider: "kernel",
        action: args.action,
        args: commitArgs as unknown as Record<string, unknown>,
        materialFacts: obs.facts,
      };
      return {
        status: "succeeded" as const,
        data: draft,
        evidenceRefs: [evidenceId],
        safeSummary: `Ready to ${args.action} on ${host} ("${obs.facts.__commitControl ?? "final step"}"); material facts captured.`,
        retry: "safe" as const,
      };
    });
  } catch (err) {
    await safeTrace({ userId, responsibilityId, kind: "tool.failed", detail: { text: `Couldn't check ${host}`, provider: "kernel" } });
    return {
      status: "failed",
      evidenceRefs: [],
      safeSummary: `Browser prepare on ${host} failed: ${normalizeFact((err as Error).message).slice(0, 200)}`,
      retry: "after_backoff",
    };
  }
}

/**
 * Execute an authorized browser commit: re-run the frozen steps, re-observe
 * material facts, refuse if anything changed (`facts_changed`), otherwise click
 * the commit control and capture confirmation text as evidence. Observe +
 * compare + click happen in ONE sandbox execution so the page can't drift
 * between check and click.
 */
export async function browserCommitAuthorized(
  effect: AuthorizedEffect,
  opts: { onLiveView?: LiveViewCallback } = {},
): Promise<DispatchResult> {
  const base = { providerReceiptRef: null, providerRequestId: null, evidenceRefs: [] as string[] };
  if (effect.provider !== "kernel") return { ...base, outcome: "failed", safeSummary: "wrong_provider: effect is not a Kernel effect." };
  const a = effect.canonicalArgs as unknown as BrowserCommitArgs;
  if (!a || typeof a.url !== "string" || (typeof a.commitSelector !== "string" && typeof a.commitText !== "string")) {
    return { ...base, outcome: "failed", safeSummary: "invalid_args: missing url/commit control." };
  }
  try {
    assertHttpUrl(a.url);
  } catch {
    return { ...base, outcome: "failed", safeSummary: "invalid_args: bad url." };
  }
  const host = hostOf(a.url);
  const { userId, responsibilityId } = effect;

  let sessionCreated = false;
  let sessionId: string | null = null;
  try {
    return await withSession({ userId, responsibilityId, onLiveView: opts.onLiveView, signedIn: true }, async (session) => {
      sessionCreated = true;
      sessionId = session.id;
      await safeTrace({ userId, responsibilityId, kind: "effect.dispatched", detail: { text: `Finishing on ${host}`, provider: "kernel", browserSessionId: session.browserSessionId } });
      const r = await runPlaywright<{
        stage: string;
        changed?: string[];
        observed?: Record<string, string | null>;
        error?: string;
        title?: string;
        finalUrl?: string;
        text?: string;
      }>(
        session.id,
        `${SANDBOX_HELPERS}
let stage = "navigate";
try {
  const spec = ${JSON.stringify(a)};
  await page.goto(spec.url, { waitUntil: "domcontentloaded", timeout: ${NAV_TIMEOUT_MS} });
  await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
  stage = "steps";
  await __pre(spec.steps || []);
  stage = "observe";
  const obs = await __observe(spec);
  const expected = ${JSON.stringify(effect.materialFacts)};
  const keys = Array.from(new Set([...Object.keys(expected), ...Object.keys(obs.facts)]));
  const changed = keys.filter((k) => __norm(expected[k]) !== __norm(obs.facts[k])).sort();
  if (changed.length || !obs.commitVisible) return { stage: "verify", changed: obs.commitVisible ? changed : [...changed, "__commitVisible"], observed: obs.facts };
  stage = "click";
  await __commit(spec).click({ timeout: 10000 });
  stage = "confirm";
  if (spec.confirmationSelector) await page.locator(spec.confirmationSelector).first().waitFor({ timeout: 20000 }).catch(() => {});
  else await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  const text = await page.evaluate(() => (document.body ? document.body.innerText : ""));
  return { stage: "done", title: await page.title(), finalUrl: page.url(), text: String(text).slice(0, 20000) };
} catch (e) {
  return { stage, error: String((e && e.message) || e).slice(0, 300) };
}`,
        120,
      );

      if (r.stage === "verify") {
        const evidenceId = await recordEvidence({
          userId,
          responsibilityId,
          provider: "kernel",
          sourceUrl: a.url,
          sourceRef: session.id,
          safeSummary: `Facts changed on ${host} before ${effect.action}: ${(r.changed ?? []).join(", ")}. Nothing was submitted.`,
          payload: { stage: "verify", effectId: effect.id, changed: r.changed, observed: r.observed },
        });
        await safeTrace({ userId, responsibilityId, kind: "effect.receipt", detail: { text: `Details changed on ${host}; stopped before submitting`, provider: "kernel" } });
        return {
          ...base,
          evidenceRefs: [evidenceId],
          outcome: "failed" as const,
          safeSummary: `facts_changed: ${(r.changed ?? []).join(", ")} differ from what was approved; nothing was submitted.`,
        };
      }
      if (r.error) {
        const clicked = r.stage === "click" || r.stage === "confirm";
        return {
          ...base,
          providerRequestId: session.id,
          outcome: clicked ? ("uncertain" as const) : ("failed" as const),
          safeSummary: clicked
            ? `browser_uncertain: error during ${r.stage} on ${host}; the submission may have happened.`
            : `browser_failed: ${r.stage} failed on ${host} before submitting (${normalizeFact(r.error).slice(0, 150)}).`,
        };
      }

      const text = selectRelevantText(r.text ?? "", "confirmation confirmed reference booking order reservation thank success", 2000);
      const ref = extractConfirmationRef(r.text ?? "");
      const evidenceId = await recordEvidence({
        userId,
        responsibilityId,
        provider: "kernel",
        sourceUrl: r.finalUrl ?? a.url,
        sourceRef: ref ?? session.id,
        safeSummary: `After ${effect.action} on ${host}: ${normalizeFact(r.title)} — ${text.slice(0, 1500)}`,
        payload: { stage: "confirm", effectId: effect.id, title: r.title, finalUrl: r.finalUrl, confirmationRef: ref, text },
      });
      await safeTrace({ userId, responsibilityId, kind: "effect.receipt", detail: { text: `Submitted on ${host}`, provider: "kernel" } });
      return {
        outcome: "succeeded" as const,
        providerReceiptRef: ref,
        providerRequestId: session.id,
        evidenceRefs: [evidenceId],
        safeSummary: `Submitted on ${host}${ref ? ` (reference ${ref})` : ""}.`,
      };
    });
  } catch (err) {
    // Before a session existed nothing could have been clicked.
    return {
      ...base,
      providerRequestId: sessionId,
      outcome: sessionCreated ? "uncertain" : "failed",
      safeSummary: sessionCreated
        ? `browser_uncertain: lost contact with the browser on ${host}; the submission may have happened.`
        : `browser_unavailable: could not start a browser (${normalizeFact((err as Error).message).slice(0, 120)}).`,
    };
  }
}
