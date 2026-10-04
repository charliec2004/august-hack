import "server-only";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

import { recordEvidence } from "@/server/db/evidence";
import { trace } from "@/server/db/traces";
import type { AuthorizedEffect, DispatchResult, EffectDraft } from "@/server/effects/types";
import type { ToolResult } from "@/server/types/domain";

/**
 * Executor adapter (spec sections 18, 41.2). Server-only; the endpoint and
 * bearer token never leave this module, and nothing here is model-visible
 * except bounded, credential-scrubbed summaries.
 *
 * ---------------------------------------------------------------------------
 * Real tool surface discovered on 2026-10-04 (server "executor" v1.0.0,
 * streamable HTTP at EXECUTOR_MCP_URL, `Authorization: Bearer <token>`):
 *
 *   execute({ code: string })                 run TypeScript in Executor's sandbox
 *   skills({ name?: string })                 how-to docs; catalog: execute,
 *                                             create-artifact, artifact-style
 *   resume({ executionId, action: "accept"|"decline"|"cancel", content?, persist? })
 *   create-artifact / edit-artifact / list-artifacts / show-artifact   (UI; unused)
 *
 * `execute` result: `structuredContent = { status: "completed", result, logs }`
 * on success, `{ status: "error", error, logs }` + `isError: true` on a thrown
 * error. Any other status carrying an `executionId` is a paused interaction
 * (Executor's own approval) and is mapped to safeSummary code
 * `executor_approval_pause`.
 *
 * Inside the sandbox:
 *   tools.search({ query, namespace?, limit?, offset? }) -> { items:[{path,description}], hasMore, nextOffset }
 *   tools.describe.tool({ path }) -> { inputTypeScript, outputTypeScript, typeScriptDefinitions }
 *   tools.executor.coreTools.connections.list({}) -> { ok, data:{ connections:[{address,integration,owner,name}] } }
 *   tools.<integration>.<owner>.<connection>.<tool>(input) -> { ok:true, data, http? } | { ok:false, error:{code,message,status?,retryable?} }
 *
 * Connected app: integration `google_calendar`, connection address
 *   tools.google_calendar.user.personalGoogleCalendarApi
 * Calendar tools (Google Calendar v3 shapes):
 *   .calendar.events.list({ calendarId, timeMin, timeMax, singleEvents, orderBy, maxResults, timeZone, q })
 *   .calendar.events.get / .insert / .move / ...   .calendar.freebusy.query({ body })
 *
 * Known state at discovery: the calendar read returns
 *   { ok:false, error:{ code:"connection_rejected", status:403 } } because the
 *   Google Calendar API is disabled in the OAuth client's Google Cloud project.
 * ---------------------------------------------------------------------------
 */

export const CALENDAR_CONNECTION = "google_calendar.user.personalGoogleCalendarApi";
const MAX_MODEL_CHARS = 4000;
const CALL_TIMEOUT_MS = 90_000;

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

const SECRET_KEY_RE =
  /(token|secret|password|passwd|authorization|api[_-]?key|credential|cookie|session[_-]?id|refresh|bearer)/i;
const SECRET_VALUE_RE = /(ya29\.[\w-]+|Bearer\s+[\w.~+/-]+=*|sk-[\w-]{16,}|whsec_[\w+/=]+)/g;

/** Deep-copy `value` dropping secret-looking keys and masking token-shaped strings. */
export function redactSecrets(value: unknown, depth = 0): unknown {
  if (depth > 12) return "[truncated]";
  if (typeof value === "string") return value.replace(SECRET_VALUE_RE, "[redacted]");
  if (Array.isArray(value)) return value.map((v) => redactSecrets(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_RE.test(k)) continue;
      out[k] = redactSecrets(v, depth + 1);
    }
    return out;
  }
  return value;
}

/** JSON-stringify a redacted value and clip it for model visibility. */
export function boundForModel(value: unknown, max = MAX_MODEL_CHARS): string {
  let s: string;
  try {
    s = typeof value === "string" ? value : JSON.stringify(redactSecrets(value));
  } catch {
    s = String(value);
  }
  s = s ?? "";
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

const MUTATING_SEGMENT_RE =
  /\.(insert|update|patch|delete|remove|move|create|createEvent|send|sendMessage|import|quickAdd|clear|watch|modify|trash|untrash|batchModify|batchDelete|batchUpdate)\s*\(/;

/** Heuristic guard: a read program must not call obviously mutating tools or resume runs. */
export function looksMutating(program: string): boolean {
  return MUTATING_SEGMENT_RE.test(program) || /\bresume\s*\(/.test(program);
}

const READ_VERBS = new Set(["list", "get", "query", "search", "instances"]);
export function isReadOnlyToolPath(path: string): boolean {
  if (!/^[A-Za-z0-9_.]+$/.test(path)) return false;
  const last = path.split(".").pop() ?? "";
  return READ_VERBS.has(last) || /^(list|get|search|query)/.test(last);
}

export type ExecuteOutcome =
  | { kind: "completed"; result: unknown }
  | { kind: "error"; error: string }
  | { kind: "paused"; executionId: string; status: string };

/** Interpret an MCP `execute` tool result. */
export function interpretExecuteResult(raw: unknown): ExecuteOutcome {
  const r = (raw ?? {}) as {
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
    content?: Array<{ type: string; text?: string }>;
  };
  const sc = r.structuredContent ?? {};
  const status = typeof sc.status === "string" ? sc.status : undefined;
  const executionId =
    (typeof sc.executionId === "string" && sc.executionId) ||
    (typeof (sc.resumePayload as { executionId?: unknown } | undefined)?.executionId === "string" &&
      (sc.resumePayload as { executionId: string }).executionId) ||
    undefined;
  if (status === "completed") return { kind: "completed", result: sc.result };
  if (executionId && status !== "error") {
    return { kind: "paused", executionId, status: status ?? "paused" };
  }
  if (status === "error" || r.isError) {
    const text = typeof sc.error === "string" ? sc.error : r.content?.find((c) => c.type === "text")?.text;
    return { kind: "error", error: boundForModel(text ?? "Executor error", 300) };
  }
  // Legacy/unstructured: treat first text block as the result.
  const text = r.content?.find((c) => c.type === "text")?.text;
  return { kind: "completed", result: text ?? null };
}

/** UTC instant for a wall-clock time in `timeZone`. */
export function zonedTimeToUtc(
  y: number,
  m: number,
  d: number,
  h: number,
  min: number,
  timeZone: string,
): Date {
  const offset = (instant: number) => {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(new Date(instant));
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
    return asUtc - Math.floor(instant / 1000) * 1000;
  };
  const guess = Date.UTC(y, m - 1, d, h, min);
  let result = guess - offset(guess);
  const second = offset(result);
  if (guess - second !== result) result = guess - second;
  return new Date(result);
}

export function formatLocalTime(iso: string | Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
  }).format(typeof iso === "string" ? new Date(iso) : iso);
}

export type CalendarEventSummary = {
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  busy: boolean;
  startLocal?: string;
  endLocal?: string;
};

export type FreeWindow = { start: string; end: string; startLocal: string; endLocal: string; minutes: number };

type RawCalEvent = {
  summary?: string;
  status?: string;
  transparency?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  selfResponse?: string | null;
};

/** Normalize Google Calendar events into safe summaries (no attendees, links, descriptions). */
export function normalizeCalendarEvents(raw: RawCalEvent[], timeZone: string): CalendarEventSummary[] {
  return raw
    .filter((e) => e && e.status !== "cancelled" && (e.start?.dateTime || e.start?.date))
    .map((e) => {
      const allDay = !e.start?.dateTime;
      const start = e.start?.dateTime ?? e.start?.date ?? "";
      const end = e.end?.dateTime ?? e.end?.date ?? start;
      const busy = !allDay && e.transparency !== "transparent" && e.selfResponse !== "declined";
      const title = (e.summary ?? "(busy)").replace(/\s+/g, " ").trim().slice(0, 120) || "(busy)";
      return {
        title,
        start,
        end,
        allDay,
        busy,
        ...(allDay ? {} : { startLocal: formatLocalTime(start, timeZone), endLocal: formatLocalTime(end, timeZone) }),
      };
    });
}

/** Gaps of at least `minMinutes` inside [windowStart, windowEnd] not covered by busy events. */
export function computeFreeWindows(
  events: CalendarEventSummary[],
  windowStart: Date,
  windowEnd: Date,
  timeZone: string,
  minMinutes = 30,
): FreeWindow[] {
  const ws = windowStart.getTime();
  const we = windowEnd.getTime();
  const busy = events
    .filter((e) => e.busy)
    .map((e) => [Math.max(ws, Date.parse(e.start)), Math.min(we, Date.parse(e.end))] as const)
    .filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e) && e > s)
    .sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const [s, e] of busy) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  const out: FreeWindow[] = [];
  let cursor = ws;
  const push = (s: number, e: number) => {
    const minutes = Math.floor((e - s) / 60000);
    if (minutes >= minMinutes) {
      out.push({
        start: new Date(s).toISOString(),
        end: new Date(e).toISOString(),
        startLocal: formatLocalTime(new Date(s), timeZone),
        endLocal: formatLocalTime(new Date(e), timeZone),
        minutes,
      });
    }
  };
  for (const [s, e] of merged) {
    if (s > cursor) push(cursor, s);
    cursor = Math.max(cursor, e);
  }
  if (we > cursor) push(cursor, we);
  return out;
}

// ---------------------------------------------------------------------------
// MCP client (one per process)
// ---------------------------------------------------------------------------

declare global {
  var __augustExecutorClient: Promise<Client> | undefined;
}

async function connect(): Promise<Client> {
  const url = process.env.EXECUTOR_MCP_URL;
  const token = process.env.EXECUTOR_MCP_TOKEN;
  if (!url || !token) throw new Error("Executor is not configured");
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "august", version: "0.1.0" });
  await client.connect(transport);
  client.onclose = () => {
    globalThis.__augustExecutorClient = undefined;
  };
  return client;
}

async function getClient(): Promise<Client> {
  if (!globalThis.__augustExecutorClient) {
    globalThis.__augustExecutorClient = connect().catch((err) => {
      globalThis.__augustExecutorClient = undefined;
      throw err;
    });
  }
  return globalThis.__augustExecutorClient;
}

/** Close the shared client (scripts/tests). */
export async function closeExecutor(): Promise<void> {
  const p = globalThis.__augustExecutorClient;
  globalThis.__augustExecutorClient = undefined;
  if (p) await (await p).close().catch(() => {});
}

function isTimeout(err: unknown): boolean {
  return (
    (err instanceof McpError && err.code === ErrorCode.RequestTimeout) ||
    (err instanceof Error && /timeout|timed out|ETIMEDOUT|aborted/i.test(err.message))
  );
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const client = await getClient();
  try {
    return await client.callTool({ name, arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS });
  } catch (err) {
    // A dropped session is reconnected once for idempotent reads; callers decide for mutations.
    if (!isTimeout(err)) globalThis.__augustExecutorClient = undefined;
    throw err;
  }
}

async function runProgram(code: string): Promise<ExecuteOutcome> {
  return interpretExecuteResult(await callTool("execute", { code }));
}

async function declinePaused(executionId: string) {
  try {
    await callTool("resume", { executionId, action: "decline" });
  } catch {
    // Best effort; the paused run will expire on Executor's side.
  }
}

async function safeTrace(t: Parameters<typeof trace>[0]) {
  try {
    await trace(t);
  } catch {
    // observability only
  }
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/** Executor's own how-to docs (catalog when `name` omitted). Not user data; no evidence row. */
export async function executorSkills(name?: string): Promise<string> {
  const raw = (await callTool("skills", name ? { name } : {})) as {
    content?: Array<{ type: string; text?: string }>;
  };
  return (raw.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n")
    .slice(0, 8000);
}

export type ExecutorReadArgs = {
  userId: string;
  responsibilityId: string | null;
  /** User-safe activity sentence for the trace, e.g. "Read your calendar". */
  activityText?: string;
} & (
  | { program: string; tool?: never; input?: never; intent?: never }
  | { tool: string; input?: Record<string, unknown>; program?: never; intent?: never }
  | { intent: string; program?: never; tool?: never; input?: never }
);

/** Sandbox program: rank read-only tools for a natural-language intent and return their input shapes. */
export function buildIntentDiscoveryProgram(intent: string): string {
  return `const s = await tools.search({ query: ${JSON.stringify(intent.slice(0, 200))}, limit: 12 });
const readVerb = (p) => { const last = p.split(".").pop() || ""; return /^(list|get|search|query|instances)/.test(last); };
const picks = (s.items || []).filter((i) => readVerb(i.path)).slice(0, 3);
const out = [];
for (const i of picks) {
  const d = await tools.describe.tool({ path: i.path });
  out.push({ tool: i.path, description: String(i.description || "").slice(0, 160), input: String(d.inputTypeScript || "").slice(0, 600) });
}
return { intent: ${JSON.stringify(intent.slice(0, 200))}, candidates: out, next: "Call again with { tool, input } using one candidate." };`;
}

/**
 * Read-only Executor call. Either a sandbox `program` (must `return` a value)
 * or a structured `{ tool, input }` where `tool` is a read verb path under the
 * calendar connection (e.g. "calendar.events.list") or a full
 * "<integration>.<owner>.<connection>.<...>" path.
 */
export async function executorRead(args: ExecutorReadArgs): Promise<ToolResult<{ text: string }>> {
  const { userId, responsibilityId } = args;
  let code: string;
  if (typeof args.intent === "string") {
    code = buildIntentDiscoveryProgram(args.intent);
  } else if (typeof args.program === "string") {
    if (looksMutating(args.program)) {
      return {
        status: "blocked",
        evidenceRefs: [],
        safeSummary: "That Executor program looks like it changes data; mutations must go through an approved effect.",
        retry: "never",
      };
    }
    code = args.program;
  } else if (typeof args.tool === "string") {
    const path = args.tool.includes(".user.") || args.tool.includes(".org.") ? args.tool : `${CALENDAR_CONNECTION}.${args.tool}`;
    if (!isReadOnlyToolPath(path)) {
      return { status: "blocked", evidenceRefs: [], safeSummary: "Only read tools may run without approval.", retry: "never" };
    }
    code = `const r = await tools.${path}(${JSON.stringify(args.input ?? {})});\nreturn r && r.ok ? r.data : { ok: false, error: r && r.error ? { code: r.error.code, message: r.error.message, status: r.error.status } : null };`;
  } else {
    return { status: "failed", evidenceRefs: [], safeSummary: "executorRead needs intent, tool, or program.", retry: "never" };
  }

  let outcome: ExecuteOutcome;
  try {
    outcome = await runProgram(code);
  } catch (err) {
    await safeTrace({ userId, responsibilityId, kind: "tool.failed", detail: { text: "Couldn't reach your connected apps", provider: "executor" } });
    return {
      status: "failed",
      evidenceRefs: [],
      safeSummary: isTimeout(err) ? "Executor timed out." : "Executor is unreachable.",
      retry: "after_backoff",
    };
  }

  if (outcome.kind === "paused") {
    // A read should never need approval; refuse rather than leave it pending.
    await declinePaused(outcome.executionId);
    return { status: "failed", evidenceRefs: [], safeSummary: "executor_approval_pause: Executor asked for approval on a read; declined.", retry: "after_user" };
  }
  if (outcome.kind === "error") {
    await safeTrace({ userId, responsibilityId, kind: "tool.failed", detail: { text: "Connected app read failed", provider: "executor" } });
    return { status: "failed", evidenceRefs: [], safeSummary: `Executor program failed: ${outcome.error}`, retry: "never" };
  }

  const appError = extractAppError(outcome.result);
  if (appError) {
    await safeTrace({ userId, responsibilityId, kind: "tool.failed", detail: { text: "Connected app read failed", provider: "executor" } });
    return { status: "failed", evidenceRefs: [], safeSummary: appError, retry: appErrorRetry(outcome.result) };
  }

  const text = boundForModel(outcome.result);
  const evidenceId = await recordEvidence({
    userId,
    responsibilityId,
    provider: "executor",
    sourceRef: args.tool ?? (args.intent ? "intent" : "program"),
    safeSummary: text,
    payload: { result: redactSecrets(outcome.result) },
  });
  await safeTrace({ userId, responsibilityId, kind: "tool.succeeded", detail: { text: args.activityText ?? "Read a connected app", provider: "executor" } });
  return { status: "succeeded", data: { text }, evidenceRefs: [evidenceId], safeSummary: text.slice(0, 300), retry: "safe" };
}

function extractAppError(result: unknown): string | null {
  const r = result as { ok?: boolean; error?: { code?: string; message?: string; status?: number } } | null;
  if (r && typeof r === "object" && r.ok === false) {
    const code = r.error?.code ?? "app_error";
    if (code === "connection_rejected" || r.error?.status === 401 || r.error?.status === 403) {
      return `executor_connection_rejected: the connected app rejected the request (HTTP ${r.error?.status ?? "?"}); the connection needs re-authorization or the API is disabled.`;
    }
    return `Connected app error (${code}): ${boundForModel(r.error?.message ?? "", 200)}`;
  }
  return null;
}

function appErrorRetry(result: unknown): ToolResult<unknown>["retry"] {
  const r = result as { error?: { status?: number; retryable?: boolean } } | null;
  if (r?.error?.retryable || (r?.error?.status ?? 0) >= 500 || r?.error?.status === 429) return "after_backoff";
  if (r?.error?.status === 401 || r?.error?.status === 403) return "after_user";
  return "never";
}

export type CalendarDay = {
  date: string;
  timezone: string;
  events: CalendarEventSummary[];
  freeWindows: FreeWindow[];
};

/** Today's (or `date`'s) events and free windows as safe summaries. */
export async function calendarFreeBusy(args: {
  userId: string;
  responsibilityId: string | null;
  /** YYYY-MM-DD in `timezone`; defaults to today there. */
  date?: string;
  timezone: string;
  dayStartHour?: number;
  dayEndHour?: number;
  calendarId?: string;
}): Promise<ToolResult<CalendarDay>> {
  const { userId, responsibilityId, timezone } = args;
  const date =
    args.date ??
    new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return { status: "failed", evidenceRefs: [], safeSummary: "Invalid date; expected YYYY-MM-DD.", retry: "never" };
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dayStart = zonedTimeToUtc(y, mo, d, 0, 0, timezone);
  const dayEnd = zonedTimeToUtc(y, mo, d + 1, 0, 0, timezone);
  const winStart = zonedTimeToUtc(y, mo, d, args.dayStartHour ?? 8, 0, timezone);
  const winEnd = zonedTimeToUtc(y, mo, d, args.dayEndHour ?? 22, 0, timezone);

  const input = {
    calendarId: args.calendarId ?? "primary",
    timeMin: dayStart.toISOString(),
    timeMax: dayEnd.toISOString(),
    singleEvents: true,
    orderBy: "startTime",
    maxResults: 50,
    timeZone: timezone,
  };
  // Map inside the sandbox so only minimal fields cross the wire.
  const code = `const r = await tools.${CALENDAR_CONNECTION}.calendar.events.list(${JSON.stringify(input)});
if (!r.ok) return { ok: false, error: { code: r.error.code, message: r.error.message, status: r.error.status, retryable: r.error.retryable } };
return { ok: true, events: (r.data.items || []).map(e => ({
  summary: e.summary, status: e.status, transparency: e.transparency,
  start: e.start ? { dateTime: e.start.dateTime, date: e.start.date } : undefined,
  end: e.end ? { dateTime: e.end.dateTime, date: e.end.date } : undefined,
  selfResponse: ((e.attendees || []).find(a => a.self) || {}).responseStatus || null,
})) };`;

  let outcome: ExecuteOutcome;
  try {
    outcome = await runProgram(code);
  } catch (err) {
    await safeTrace({ userId, responsibilityId, kind: "tool.failed", detail: { text: "Couldn't read your calendar", provider: "executor" } });
    return { status: "failed", evidenceRefs: [], safeSummary: isTimeout(err) ? "Executor timed out." : "Executor is unreachable.", retry: "after_backoff" };
  }
  if (outcome.kind === "paused") {
    await declinePaused(outcome.executionId);
    return { status: "failed", evidenceRefs: [], safeSummary: "executor_approval_pause: Executor asked for approval on a calendar read; declined.", retry: "after_user" };
  }
  if (outcome.kind === "error") {
    await safeTrace({ userId, responsibilityId, kind: "tool.failed", detail: { text: "Couldn't read your calendar", provider: "executor" } });
    return { status: "failed", evidenceRefs: [], safeSummary: `Calendar read failed: ${outcome.error}`, retry: "never" };
  }
  const appError = extractAppError(outcome.result);
  if (appError) {
    await safeTrace({ userId, responsibilityId, kind: "tool.failed", detail: { text: "Couldn't read your calendar", provider: "executor" } });
    return { status: "failed", evidenceRefs: [], safeSummary: appError, retry: appErrorRetry(outcome.result) };
  }

  const rawEvents = ((outcome.result as { events?: RawCalEvent[] })?.events ?? []) as RawCalEvent[];
  const events = normalizeCalendarEvents(rawEvents, timezone);
  const freeWindows = computeFreeWindows(events, winStart, winEnd, timezone);
  const busyText = events
    .filter((e) => !e.allDay)
    .map((e) => `${e.startLocal}-${e.endLocal} ${e.title}${e.busy ? "" : " (free)"}`)
    .join("; ");
  const freeText = freeWindows.map((w) => `${w.startLocal}-${w.endLocal}`).join(", ");
  const summary = `Calendar ${date} (${timezone}): ${events.length} event(s)${busyText ? ` — ${busyText}` : ""}. Free: ${freeText || "none"}.`;

  const evidenceId = await recordEvidence({
    userId,
    responsibilityId,
    provider: "executor",
    sourceRef: `${CALENDAR_CONNECTION}.calendar.events.list`,
    safeSummary: boundForModel(summary, 2000),
    payload: { date, timezone, events, freeWindows },
    expiresAt: dayEnd,
  });
  await safeTrace({ userId, responsibilityId, kind: "tool.succeeded", detail: { text: "Read your calendar", provider: "executor" } });

  return {
    status: "succeeded",
    data: { date, timezone, events, freeWindows },
    evidenceRefs: [evidenceId],
    safeSummary: boundForModel(summary, 600),
    retry: "safe",
  };
}

/** Prepare a calendar event creation as an exact effect (provider "executor", action "calendar.create_event"). */
export function calendarPrepareCreateEvent(args: {
  summary: string;
  startIso: string;
  endIso: string;
  timezone: string;
  location?: string;
  description?: string;
  calendarId?: string;
}): EffectDraft {
  const input: Record<string, unknown> = {
    calendarId: args.calendarId ?? "primary",
    body: {
      summary: args.summary,
      start: { dateTime: args.startIso, timeZone: args.timezone },
      end: { dateTime: args.endIso, timeZone: args.timezone },
      ...(args.location ? { location: args.location } : {}),
      ...(args.description ? { description: args.description } : {}),
    },
  };
  return {
    provider: "executor",
    action: "calendar.create_event",
    args: { connection: CALENDAR_CONNECTION, tool: "calendar.events.insert", input },
    materialFacts: {
      title: args.summary,
      start: args.startIso,
      end: args.endIso,
      timezone: args.timezone,
      ...(args.location ? { location: args.location } : {}),
    },
  };
}

const CONNECTION_RE = /^[a-z0-9_]+\.(user|org)\.[A-Za-z0-9_]+$/;

/** Build the sandbox program for an authorized effect from its frozen canonicalArgs. Pure; exported for tests. */
export function buildAuthorizedProgram(canonicalArgs: Record<string, unknown>): string | null {
  if (typeof canonicalArgs.program === "string" && canonicalArgs.program.trim()) {
    return canonicalArgs.program;
  }
  const connection = typeof canonicalArgs.connection === "string" ? canonicalArgs.connection : CALENDAR_CONNECTION;
  const tool = canonicalArgs.tool;
  if (!CONNECTION_RE.test(connection) || typeof tool !== "string" || !/^[A-Za-z0-9_.]+$/.test(tool)) return null;
  const input = canonicalArgs.input ?? {};
  return `const r = await tools.${connection}.${tool}(${JSON.stringify(input)});
if (!r.ok) return { ok: false, error: { code: r.error.code, message: r.error.message, status: r.error.status, retryable: r.error.retryable } };
const d = r.data || {};
return { ok: true, id: d.id ?? null, status: d.status ?? null, htmlLink: d.htmlLink ?? null, summary: d.summary ?? null };`;
}

/**
 * Execute an authorized mutation exactly as frozen in `effect.canonicalArgs`
 * (`{ connection?, tool, input }` or `{ program }`).
 */
export async function executorExecuteAuthorized(effect: AuthorizedEffect): Promise<DispatchResult> {
  const base = { providerReceiptRef: null, providerRequestId: null, evidenceRefs: [] as string[] };
  if (effect.provider !== "executor") {
    return { ...base, outcome: "failed", safeSummary: "wrong_provider: effect is not an Executor effect." };
  }
  const code = buildAuthorizedProgram(effect.canonicalArgs);
  if (!code) return { ...base, outcome: "failed", safeSummary: "invalid_args: canonicalArgs need { tool, input } or { program }." };

  try {
    await getClient();
  } catch {
    return { ...base, outcome: "failed", safeSummary: "executor_unreachable: could not connect; nothing was sent." };
  }

  let outcome: ExecuteOutcome;
  try {
    outcome = await runProgram(code);
  } catch {
    // We cannot know whether the program ran: never treat as failure.
    await safeTrace({ userId: effect.userId, responsibilityId: effect.responsibilityId, kind: "effect.dispatched", detail: { text: "Connected app didn't confirm the change", provider: "executor" } });
    return {
      ...base,
      outcome: "uncertain",
      safeSummary: "executor_no_response: the request may or may not have run; reconcile by readback.",
    };
  }

  if (outcome.kind === "paused") {
    return {
      ...base,
      providerRequestId: outcome.executionId,
      outcome: "failed",
      safeSummary: `executor_approval_pause: Executor paused execution ${outcome.executionId} for its own approval.`,
    };
  }
  if (outcome.kind === "error") {
    return { ...base, outcome: "failed", safeSummary: `executor_program_error: ${outcome.error}` };
  }
  const appError = extractAppError(outcome.result);
  if (appError) return { ...base, outcome: "failed", safeSummary: appError };

  const res = (redactSecrets(outcome.result) ?? {}) as { id?: string | null; htmlLink?: string | null; status?: string | null };
  const evidenceId = await recordEvidence({
    userId: effect.userId,
    responsibilityId: effect.responsibilityId,
    provider: "executor",
    sourceRef: res.id ?? effect.id,
    sourceUrl: res.htmlLink ?? null,
    safeSummary: `Executor ${effect.action} succeeded${res.id ? ` (id ${res.id})` : ""}.`,
    payload: { effectId: effect.id, action: effect.action, result: res },
  });
  await safeTrace({ userId: effect.userId, responsibilityId: effect.responsibilityId, kind: "effect.receipt", detail: { text: "Updated your connected app", provider: "executor" } });
  return {
    outcome: "succeeded",
    providerReceiptRef: res.id ?? null,
    providerRequestId: null,
    evidenceRefs: [evidenceId],
    safeSummary: `Executor ${effect.action} succeeded.`,
  };
}
