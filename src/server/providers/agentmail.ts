import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

import { AgentMailClient, AgentMailError, AgentMailTimeoutError } from "agentmail";

import { recordEvidence } from "@/server/db/evidence";
import { trace } from "@/server/db/traces";
import type { AuthorizedEffect, DispatchResult, EffectDraft } from "@/server/effects/types";
import type { ToolResult } from "@/server/types/domain";

/**
 * AgentMail adapter (spec sections 21, 41.4): August's own outside-world inbox
 * (AGENTMAIL_INBOX_ID). Sending is consequential and only happens through
 * `mailSendAuthorized(effect)`, which sends exactly the frozen canonicalArgs
 * and passes `effect.idempotencyKey` as AgentMail's native `idempotencyKey`.
 *
 * Webhooks: AgentMail delivers via Svix. `verifyAgentMailWebhook` implements
 * the Svix scheme directly (HMAC-SHA256 over `${svix-id}.${svix-timestamp}.${body}`
 * keyed with the base64 part of the `whsec_...` secret; header `svix-signature`
 * holds space-separated `v1,<base64>` entries; 5-minute timestamp tolerance).
 */

const PREVIEW_CHARS = 500;

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

export function normalizeAddress(a: string): string {
  return a.trim().toLowerCase();
}

/** Extract the bare address from `Name <addr>` or `addr`. */
export function bareAddress(a: string | null | undefined): string | null {
  if (!a) return null;
  const m = /<([^>]+)>/.exec(a);
  return normalizeAddress(m ? m[1] : a);
}

function clip(s: string | null | undefined, n: number): string {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

type HeaderBag = Headers | Record<string, string | string[] | undefined>;

function header(h: HeaderBag, name: string): string | null {
  if (typeof (h as Headers).get === "function") return (h as Headers).get(name);
  const rec = h as Record<string, string | string[] | undefined>;
  const key = Object.keys(rec).find((k) => k.toLowerCase() === name);
  const v = key ? rec[key] : undefined;
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
}

export type WebhookVerification = { ok: true; webhookId: string } | { ok: false; reason: string };

/** Verify a Svix-signed AgentMail webhook. `rawBody` must be the exact bytes received. */
export function verifyAgentMailWebhook(
  rawBody: string | Buffer,
  headers: HeaderBag,
  secret: string,
  opts: { toleranceSec?: number; nowSec?: number } = {},
): WebhookVerification {
  const id = header(headers, "svix-id") ?? header(headers, "webhook-id");
  const ts = header(headers, "svix-timestamp") ?? header(headers, "webhook-timestamp");
  const sigHeader = header(headers, "svix-signature") ?? header(headers, "webhook-signature");
  if (!id || !ts || !sigHeader) return { ok: false, reason: "missing_headers" };
  if (!secret) return { ok: false, reason: "missing_secret" };

  const tsNum = Number(ts);
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const tolerance = opts.toleranceSec ?? 300;
  if (!Number.isFinite(tsNum) || Math.abs(now - tsNum) > tolerance) return { ok: false, reason: "timestamp_out_of_tolerance" };

  const key = Buffer.from(secret.startsWith("whsec_") ? secret.slice(6) : secret, "base64");
  const body = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");
  const expected = createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest();

  for (const part of sigHeader.split(" ")) {
    const [version, sig] = part.split(",", 2);
    if (version !== "v1" || !sig) continue;
    let given: Buffer;
    try {
      given = Buffer.from(sig, "base64");
    } catch {
      continue;
    }
    if (given.length === expected.length && timingSafeEqual(given, expected)) return { ok: true, webhookId: id };
  }
  return { ok: false, reason: "bad_signature" };
}

export type NormalizedAgentMailEvent = {
  eventId: string | null;
  eventType: string;
  inboxId: string | null;
  threadId: string | null;
  messageId: string | null;
  from: string | null;
  subject: string | null;
  textPreview: string | null;
  /** True only for a genuine inbound message (message.received, not from our own inbox). */
  isInboundMessage: boolean;
  direction: "inbound" | "outbound" | "other";
};

type AnyRec = Record<string, unknown>;
const pick = (o: AnyRec | undefined, ...keys: string[]): unknown => {
  if (!o) return undefined;
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k];
  return undefined;
};
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/**
 * Normalize an AgentMail webhook payload (snake_case wire JSON or camelCase SDK
 * objects). Distinguishes `message.received` (the only event that may wake an
 * agent) from `message.sent` / delivery / bounce events, and also refuses to
 * treat mail from our own inbox as inbound, to prevent reply loops.
 */
export function normalizeAgentMailEvent(payload: unknown, ownInboxId?: string | null): NormalizedAgentMailEvent {
  const p = (payload ?? {}) as AnyRec;
  const eventType = str(pick(p, "event_type", "eventType", "type")) ?? "unknown";
  const msg = pick(p, "message") as AnyRec | undefined;
  const send = pick(p, "send", "delivery", "bounce", "complaint", "reject", "open") as AnyRec | undefined;
  const thread = pick(p, "thread") as AnyRec | undefined;
  const src = msg ?? send ?? {};

  const inboxId = str(pick(src, "inbox_id", "inboxId")) ?? str(pick(thread, "inbox_id", "inboxId"));
  const from = str(pick(msg, "from"));
  const own = ownInboxId ? normalizeAddress(ownInboxId) : null;
  const fromOwn = !!own && bareAddress(from) === own;

  const isReceived = eventType === "message.received";
  const outbound = eventType.startsWith("message.") && !eventType.startsWith("message.received");
  const textRaw = str(pick(msg, "extracted_text", "extractedText")) ?? str(pick(msg, "text")) ?? str(pick(msg, "preview"));

  return {
    eventId: str(pick(p, "event_id", "eventId")),
    eventType,
    inboxId,
    threadId: str(pick(src, "thread_id", "threadId")) ?? str(pick(thread, "thread_id", "threadId")),
    messageId: str(pick(src, "message_id", "messageId")),
    from,
    subject: str(pick(msg, "subject")) ?? str(pick(thread, "subject")),
    textPreview: textRaw ? clip(textRaw, PREVIEW_CHARS) : null,
    isInboundMessage: isReceived && !fromOwn,
    direction: isReceived ? (fromOwn ? "other" : "inbound") : outbound ? "outbound" : "other",
  };
}

export type SendArgs = {
  fromInbox: string;
  to: string[];
  subject: string;
  text: string;
  replyToMessageId?: string;
};

/** Pure draft builder (exported for tests); `inboxId` defaults to AGENTMAIL_INBOX_ID. */
export function buildSendDraft(
  input: { to: string | string[]; subject: string; text: string; replyToMessageId?: string },
  inboxId: string,
): EffectDraft {
  const to = (Array.isArray(input.to) ? input.to : [input.to]).map(normalizeAddress).filter(Boolean);
  if (to.length === 0) throw new Error("mailPrepareSend: at least one recipient required");
  for (const a of to) if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(a)) throw new Error(`mailPrepareSend: invalid address`);
  const args: SendArgs = {
    fromInbox: inboxId,
    to,
    subject: input.subject.trim(),
    text: input.text,
    ...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {}),
  };
  return {
    provider: "agentmail",
    action: "send_email",
    args: args as unknown as Record<string, unknown>,
    materialFacts: {
      from: inboxId,
      recipients: to,
      subject: args.subject,
      bodyChars: args.text.length,
      isReply: !!input.replyToMessageId,
    },
  };
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

let client: AgentMailClient | null = null;
function am(): AgentMailClient {
  if (!client) {
    const apiKey = process.env.AGENTMAIL_API_KEY;
    if (!apiKey) throw new Error("AGENTMAIL_API_KEY is not set");
    client = new AgentMailClient({ apiKey, timeoutInSeconds: 30 });
  }
  return client;
}

export function agentMailInboxId(): string {
  const id = process.env.AGENTMAIL_INBOX_ID;
  if (!id) throw new Error("AGENTMAIL_INBOX_ID is not set");
  return id;
}

async function safeTrace(t: Parameters<typeof trace>[0]) {
  try {
    await trace(t);
  } catch {
    // observability only
  }
}

function statusOf(err: unknown): number | undefined {
  return err instanceof AgentMailError ? err.statusCode : undefined;
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export function mailPrepareSend(input: {
  to: string | string[];
  subject: string;
  text: string;
  replyToMessageId?: string;
}): EffectDraft {
  return buildSendDraft(input, agentMailInboxId());
}

export async function mailSendAuthorized(effect: AuthorizedEffect): Promise<DispatchResult> {
  const base = { providerReceiptRef: null, providerRequestId: null, evidenceRefs: [] as string[] };
  if (effect.provider !== "agentmail" || effect.action !== "send_email") {
    return { ...base, outcome: "failed", safeSummary: "wrong_provider: not an agentmail send_email effect." };
  }
  const a = effect.canonicalArgs as unknown as SendArgs;
  if (!a || !Array.isArray(a.to) || a.to.length === 0 || typeof a.subject !== "string" || typeof a.text !== "string") {
    return { ...base, outcome: "failed", safeSummary: "invalid_args: to/subject/text required." };
  }
  if (a.fromInbox !== agentMailInboxId()) {
    return { ...base, outcome: "failed", safeSummary: "invalid_args: fromInbox is not August's inbox." };
  }

  let res: { messageId: string; threadId: string };
  try {
    const reqOpts = { idempotencyKey: effect.idempotencyKey, timeoutInSeconds: 30 };
    res = a.replyToMessageId
      ? await am().inboxes.messages.reply(a.fromInbox, a.replyToMessageId, { to: a.to, text: a.text }, reqOpts)
      : await am().inboxes.messages.send(a.fromInbox, { to: a.to, subject: a.subject, text: a.text }, reqOpts);
  } catch (err) {
    const status = statusOf(err);
    // Timeouts, network failures and 5xx may have been accepted: never report as failed.
    const uncertain = err instanceof AgentMailTimeoutError || status === undefined || status >= 500 || status === 409;
    await safeTrace({
      userId: effect.userId,
      responsibilityId: effect.responsibilityId,
      kind: "effect.receipt",
      detail: { text: uncertain ? "Email send not confirmed yet" : "Email was not sent", provider: "agentmail" },
    });
    return {
      ...base,
      outcome: uncertain ? "uncertain" : "failed",
      safeSummary: uncertain
        ? `agentmail_uncertain: no confirmation${status ? ` (HTTP ${status})` : ""}; reconcile with mailFindSent before retrying.`
        : `agentmail_rejected: HTTP ${status}.`,
    };
  }

  const evidenceId = await recordEvidence({
    userId: effect.userId,
    responsibilityId: effect.responsibilityId,
    provider: "agentmail",
    sourceRef: res.messageId,
    safeSummary: `Sent email "${clip(a.subject, 120)}" to ${a.to.join(", ")} (thread ${res.threadId}).`,
    payload: { effectId: effect.id, messageId: res.messageId, threadId: res.threadId, to: a.to, subject: a.subject },
  });
  await safeTrace({
    userId: effect.userId,
    responsibilityId: effect.responsibilityId,
    kind: "effect.receipt",
    detail: { text: `Emailed ${a.to.join(", ")}`, provider: "agentmail" },
  });
  return {
    outcome: "succeeded",
    providerReceiptRef: res.messageId,
    providerRequestId: null,
    evidenceRefs: [evidenceId],
    safeSummary: `Email sent; thread ${res.threadId}.`,
  };
}

/**
 * Conversational email to the user's own verified address (the email channel).
 * This is August replying to its principal, like a chat message, not an
 * external effect: callers must only pass an address from a verified
 * channel identity. Replies in `replyToMessageId`'s thread when given.
 */
export async function mailSendToUser(input: {
  to: string;
  subject: string;
  text: string;
  replyToMessageId?: string | null;
  idempotencyKey: string;
}): Promise<{ messageId: string; threadId: string }> {
  const inbox = agentMailInboxId();
  const reqOpts = { idempotencyKey: input.idempotencyKey, timeoutInSeconds: 30 };
  const to = [normalizeAddress(input.to)];
  const fresh = () =>
    am().inboxes.messages.send(
      inbox,
      { to, subject: input.subject, text: input.text },
      { ...reqOpts, idempotencyKey: `${input.idempotencyKey}-new` },
    );
  if (!input.replyToMessageId) return fresh();
  try {
    return await am().inboxes.messages.reply(inbox, input.replyToMessageId, { to, text: input.text }, reqOpts);
  } catch (err) {
    // The original is gone (or never reached this inbox): start a new thread instead.
    const status = statusOf(err);
    if (status === 404 || status === 400) return fresh();
    throw err;
  }
}

export type MailMessageSummary = {
  messageId: string;
  threadId: string;
  from: string;
  to: string[];
  subject: string | null;
  timestamp: string;
  labels: string[];
  /** Bounded body text; untrusted external content. */
  textPreview: string;
};

export type MailThreadData = { threadId: string; subject: string | null; messages: MailMessageSummary[] };

/**
 * Read a thread in August's inbox. Pass `{ userId, responsibilityId, threadId }`
 * to persist evidence + trace (preferred); a bare `threadId` reads without
 * recording evidence (evidence rows need a user).
 */
export async function mailReadThread(
  arg: string | { userId: string; responsibilityId: string | null; threadId: string },
): Promise<ToolResult<MailThreadData>> {
  const { userId, responsibilityId, threadId } =
    typeof arg === "string" ? { userId: null as string | null, responsibilityId: null, threadId: arg } : arg;
  try {
    const t = await am().inboxes.threads.get(agentMailInboxId(), threadId);
    const messages: MailMessageSummary[] = (t.messages ?? []).map((m) => ({
      messageId: m.messageId,
      threadId: m.threadId,
      from: m.from,
      to: m.to ?? [],
      subject: m.subject ?? null,
      timestamp: new Date(m.timestamp).toISOString(),
      labels: m.labels ?? [],
      textPreview: clip(m.extractedText ?? m.text ?? m.preview ?? "", 1200),
    }));
    const summary = `Thread "${clip(t.subject, 100)}": ${messages.length} message(s). ${messages
      .slice(-3)
      .map((m) => `[${m.from}] ${clip(m.textPreview, 200)}`)
      .join(" | ")}`;
    const evidenceRefs: string[] = [];
    if (userId) {
      evidenceRefs.push(
        await recordEvidence({
          userId,
          responsibilityId,
          provider: "agentmail",
          sourceRef: threadId,
          safeSummary: clip(summary, 2000),
          payload: { threadId, subject: t.subject ?? null, messages },
        }),
      );
      await safeTrace({ userId, responsibilityId, kind: "tool.succeeded", detail: { text: "Read the email thread", provider: "agentmail" } });
    }
    return {
      status: "succeeded",
      data: { threadId, subject: t.subject ?? null, messages },
      evidenceRefs,
      safeSummary: clip(summary, 500),
      retry: "safe",
    };
  } catch (err) {
    const status = statusOf(err);
    if (userId) {
      await safeTrace({ userId, responsibilityId, kind: "tool.failed", detail: { text: "Couldn't read the email thread", provider: "agentmail" } });
    }
    return {
      status: "failed",
      evidenceRefs: [],
      safeSummary: `Thread read failed${status ? ` (HTTP ${status})` : ""}.`,
      retry: status === 404 ? "never" : "after_backoff",
    };
  }
}

export type FindSentData = { found: boolean; messageId: string | null; threadId: string | null; timestamp: string | null };

/** Readback for reconciliation: did we already send `subject` to `to` since `since`? */
export async function mailFindSent(args: {
  userId: string;
  responsibilityId: string | null;
  to: string;
  subject: string;
  since: Date | string;
}): Promise<ToolResult<FindSentData>> {
  const { userId, responsibilityId } = args;
  const since = new Date(args.since);
  try {
    const res = await am().inboxes.messages.list(agentMailInboxId(), {
      labels: ["sent"],
      to: [normalizeAddress(args.to)],
      subject: [args.subject],
      after: since,
      limit: 10,
    });
    const match = (res.messages ?? []).find(
      (m) =>
        (m.subject ?? "").trim() === args.subject.trim() &&
        (m.to ?? []).some((t) => bareAddress(t) === normalizeAddress(args.to)) &&
        new Date(m.timestamp).getTime() >= since.getTime(),
    );
    const data: FindSentData = match
      ? { found: true, messageId: match.messageId, threadId: match.threadId, timestamp: new Date(match.timestamp).toISOString() }
      : { found: false, messageId: null, threadId: null, timestamp: null };
    const evidenceId = await recordEvidence({
      userId,
      responsibilityId,
      provider: "agentmail",
      sourceRef: data.messageId,
      safeSummary: data.found
        ? `Readback: email "${clip(args.subject, 100)}" to ${args.to} was sent (${data.messageId}).`
        : `Readback: no sent email "${clip(args.subject, 100)}" to ${args.to} since ${since.toISOString()}.`,
      payload: { ...data, to: args.to, subject: args.subject, since: since.toISOString() },
    });
    return {
      status: "succeeded",
      data,
      evidenceRefs: [evidenceId],
      safeSummary: data.found ? "Found the sent email." : "No matching sent email found.",
      retry: "safe",
    };
  } catch (err) {
    const status = statusOf(err);
    return { status: "failed", evidenceRefs: [], safeSummary: `Sent-mail readback failed${status ? ` (HTTP ${status})` : ""}.`, retry: "after_backoff" };
  }
}

/** Non-destructive health check: inbox exists and recent thread count. */
export async function mailInboxStatus(): Promise<{ inboxId: string; email: string; recentThreads: number }> {
  const inboxId = agentMailInboxId();
  const inbox = await am().inboxes.get(inboxId);
  const threads = await am().inboxes.threads.list(inboxId, { limit: 5 });
  return { inboxId: inbox.inboxId, email: inbox.email, recentThreads: threads.threads?.length ?? 0 };
}
