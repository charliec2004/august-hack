/**
 * Email as a conversational channel: parse an AgentMail `message.received*`
 * webhook, decide whether it is the user talking to August, and with what
 * authority. Pure (no I/O) so identity, authority, and loop prevention are
 * testable.
 *
 * Sender authentication. AgentMail checks SPF/DKIM/DMARC on inbound mail:
 * mail that explicitly fails is dropped; mail with no auth headers arrives as
 * `message.received.unauthenticated` (label `unauthenticated`); everything
 * else is `message.received`. Because a domain with DMARC p=none (gmail.com)
 * can pass that gate with a spoofed From, we only grant user authority when
 * the message's own Authentication-Results header shows DMARC pass, or a DKIM
 * pass signed by the From domain. Without that evidence the message is stored
 * as 'unverified_channel': answered, never authorizing.
 */

export type InboundEmail = {
  eventId: string | null;
  eventType: string;
  inboxId: string | null;
  threadId: string | null;
  messageId: string | null;
  /** Bare, lowercased sender address. */
  from: string | null;
  to: string[];
  subject: string | null;
  /** New text in this message (quoted history removed when AgentMail could). */
  text: string;
  labels: string[];
  /** Header names lowercased. */
  headers: Record<string, string>;
};

export type SenderAuth = "pass" | "provider_only" | "unauthenticated" | "fail";

export type InboundDecision =
  | { action: "conversation"; authority: "user_instruction" | "unverified_channel"; auth: SenderAuth }
  | { action: "ignore"; reason: IgnoreReason };

export type IgnoreReason =
  | "not_received"
  | "not_our_inbox"
  | "own_inbox"
  | "auto_reply"
  | "auth_failed"
  | "unknown_sender"
  | "empty";

type Rec = Record<string, unknown>;
const pick = (o: Rec | undefined, ...keys: string[]): unknown => {
  if (!o) return undefined;
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k];
  return undefined;
};
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** Extract the bare address from `Name <addr>` or `addr`. */
export function bareEmail(a: string | null | undefined): string | null {
  if (!a) return null;
  const m = /<([^>]+)>/.exec(a);
  const addr = (m ? m[1] : a).trim().toLowerCase();
  return addr || null;
}

function domainOf(addr: string | null): string | null {
  const at = addr?.lastIndexOf("@") ?? -1;
  return addr && at > 0 ? addr.slice(at + 1) : null;
}

/** Parse a `message.received*` payload (snake_case wire JSON or camelCase). Null for other events. */
export function parseInboundEmail(payload: unknown): InboundEmail | null {
  const p = (payload ?? {}) as Rec;
  const eventType = str(pick(p, "event_type", "eventType")) ?? "unknown";
  if (!eventType.startsWith("message.received")) return null;
  const msg = (pick(p, "message") ?? {}) as Rec;
  const rawHeaders = pick(msg, "headers");
  const headers: Record<string, string> = {};
  if (rawHeaders && typeof rawHeaders === "object") {
    for (const [k, v] of Object.entries(rawHeaders as Rec)) {
      if (typeof v === "string") headers[k.toLowerCase()] = v;
      else if (Array.isArray(v)) headers[k.toLowerCase()] = v.filter((x) => typeof x === "string").join("\n");
    }
  }
  const text = str(pick(msg, "extracted_text", "extractedText")) ?? str(pick(msg, "text")) ?? str(pick(msg, "preview")) ?? "";
  return {
    eventId: str(pick(p, "event_id", "eventId")),
    eventType,
    inboxId: str(pick(msg, "inbox_id", "inboxId")),
    threadId: str(pick(msg, "thread_id", "threadId")),
    messageId: str(pick(msg, "message_id", "messageId")),
    from: bareEmail(str(pick(msg, "from"))),
    to: strs(pick(msg, "to")).map((a) => bareEmail(a)).filter((a): a is string => !!a),
    subject: str(pick(msg, "subject")),
    text: text.trim(),
    labels: strs(pick(msg, "labels")).map((l) => l.toLowerCase()),
    headers,
  };
}

/** Machine-sent mail (vacation responders, bounces, lists): never answered. RFC 3834 plus common practice. */
export function isAutoReply(headers: Record<string, string>): boolean {
  const h = (k: string) => (headers[k] ?? "").trim().toLowerCase();
  if (h("auto-submitted") && h("auto-submitted") !== "no") return true;
  if (["bulk", "junk", "list", "auto_reply"].includes(h("precedence"))) return true;
  if (h("x-autoreply") || h("x-autorespond") || h("x-auto-response-suppress").includes("all")) return true;
  if (h("list-id") || h("list-unsubscribe")) return true;
  if (h("return-path") === "<>") return true;
  return false;
}

/** Sender authentication from AgentMail's verdict plus the message's own Authentication-Results. */
export function senderAuthentication(mail: InboundEmail): SenderAuth {
  if (mail.eventType === "message.received.unauthenticated" || mail.labels.includes("unauthenticated")) {
    return "unauthenticated";
  }
  if (mail.eventType !== "message.received" || mail.labels.includes("spam") || mail.labels.includes("blocked")) {
    return "fail";
  }
  const results = (mail.headers["authentication-results"] ?? "").toLowerCase();
  if (!results) return "provider_only";
  if (/\b(?:spf|dkim|dmarc)=(?:fail|softfail|permerror)\b/.test(results)) return "fail";
  if (/\bdmarc=pass\b/.test(results)) return "pass";
  const fromDomain = domainOf(mail.from);
  const dkimAligned =
    !!fromDomain &&
    [...results.matchAll(/\bdkim=pass\b[^;]*?header\.(?:d|i)=@?([a-z0-9.-]+)/g)].some(
      (m) => m[1] === fromDomain || m[1].endsWith(`.${fromDomain}`),
    );
  return dkimAligned ? "pass" : "provider_only";
}

/**
 * Is this inbound email the user talking to August? Called only for mail that
 * is NOT a reply on a thread linked to a responsibility (those wake the work).
 */
export function decideInboundEmail(input: {
  mail: InboundEmail;
  ownInbox: string;
  /** The sender is a verified email identity of some user. */
  senderVerified: boolean;
}): InboundDecision {
  const { mail, senderVerified } = input;
  const own = input.ownInbox.trim().toLowerCase();
  if (!mail.eventType.startsWith("message.received")) return { action: "ignore", reason: "not_received" };
  if (mail.inboxId && mail.inboxId.toLowerCase() !== own) return { action: "ignore", reason: "not_our_inbox" };
  if (!mail.from || mail.from === own) return { action: "ignore", reason: "own_inbox" };
  if (isAutoReply(mail.headers)) return { action: "ignore", reason: "auto_reply" };
  const auth = senderAuthentication(mail);
  if (auth === "fail") return { action: "ignore", reason: "auth_failed" };
  if (!senderVerified) return { action: "ignore", reason: "unknown_sender" };
  if (!mail.text) return { action: "ignore", reason: "empty" };
  return { action: "conversation", authority: auth === "pass" ? "user_instruction" : "unverified_channel", auth };
}
