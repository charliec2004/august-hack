import { describe, expect, it } from "vitest";

import { toModelHistory } from "../src/server/agent/history";
import { decideInboundEmail, parseInboundEmail, senderAuthentication } from "../src/server/channels/emailInbound";
import { renderEmailBody } from "../src/server/channels/render";

const OWN = "august-hack@agentmail.to";

function received(over: { eventType?: string; from?: string; labels?: string[]; headers?: Record<string, string>; text?: string } = {}) {
  return {
    type: "event",
    event_type: over.eventType ?? "message.received",
    event_id: "evt_1",
    message: {
      inbox_id: OWN,
      thread_id: "thr_1",
      message_id: "<m1@mail.gmail.com>",
      from: over.from ?? "Charlie <Charlieconner04@gmail.com>",
      to: [OWN],
      subject: "Hey",
      labels: over.labels ?? ["received"],
      extracted_text: over.text ?? "Hey August, what's on my plate?",
      headers: over.headers ?? {
        "Authentication-Results": "mx.agentmail.to; dkim=pass header.d=gmail.com; spf=pass; dmarc=pass (p=NONE) header.from=gmail.com",
      },
    },
    thread: { thread_id: "thr_1" },
  };
}

const decide = (payload: unknown, senderVerified = true) => {
  const mail = parseInboundEmail(payload);
  if (!mail) throw new Error("not parsed");
  return decideInboundEmail({ mail, ownInbox: OWN, senderVerified });
};

describe("inbound email: identity and authority", () => {
  it("a verified sender with DMARC pass speaks with user authority", () => {
    const mail = parseInboundEmail(received())!;
    expect(mail.from).toBe("charlieconner04@gmail.com");
    expect(senderAuthentication(mail)).toBe("pass");
    expect(decide(received())).toEqual({ action: "conversation", authority: "user_instruction", auth: "pass" });
  });

  it("DKIM pass from the From domain also counts; a foreign DKIM signature does not", () => {
    const aligned = received({ headers: { "authentication-results": "x; dkim=pass header.d=gmail.com; spf=pass" } });
    const foreign = received({ headers: { "authentication-results": "x; dkim=pass header.d=evil.example; spf=pass" } });
    expect(decide(aligned)).toMatchObject({ authority: "user_instruction" });
    expect(decide(foreign)).toMatchObject({ action: "conversation", authority: "unverified_channel" });
  });

  it("without auth evidence the message is answered but never authorizing", () => {
    expect(decide(received({ headers: {} }))).toMatchObject({ authority: "unverified_channel", auth: "provider_only" });
    expect(decide(received({ eventType: "message.received.unauthenticated", labels: ["received", "unauthenticated"] }))).toMatchObject({
      authority: "unverified_channel",
      auth: "unauthenticated",
    });
  });

  it("failed authentication and spam are ignored", () => {
    const failed = received({ headers: { "authentication-results": "x; dkim=fail; spf=pass; dmarc=fail" } });
    expect(decide(failed)).toEqual({ action: "ignore", reason: "auth_failed" });
    expect(decide(received({ eventType: "message.received.spam" }))).toEqual({ action: "ignore", reason: "auth_failed" });
  });

  it("an unverified sender is ignored", () => {
    expect(decide(received({ from: "stranger@example.com" }), false)).toEqual({ action: "ignore", reason: "unknown_sender" });
  });
});

describe("inbound email: loop prevention", () => {
  it("never answers our own inbox", () => {
    expect(decide(received({ from: `August <${OWN}>` }))).toEqual({ action: "ignore", reason: "own_inbox" });
  });

  it("never answers auto-replies or list mail", () => {
    const base = received().message.headers;
    const extras: Record<string, string>[] = [
      { "Auto-Submitted": "auto-replied" },
      { Precedence: "bulk" },
      { "X-Autoreply": "yes" },
      { "List-Id": "<news.example.com>" },
    ];
    for (const extra of extras) {
      expect(decide(received({ headers: { ...base, ...extra } }))).toEqual({ action: "ignore", reason: "auto_reply" });
    }
    expect(decide(received({ headers: { ...base, "Auto-Submitted": "no" } }))).toMatchObject({ action: "conversation" });
  });

  it("ignores sent/delivery events entirely", () => {
    expect(parseInboundEmail({ event_type: "message.sent", send: { inbox_id: OWN } })).toBeNull();
  });
});

describe("channel rendering and reactions in history", () => {
  it("downgrades a question form to a numbered list and adds the approval link", () => {
    const body = renderEmailBody({
      text: "**Two quick things** before I book:",
      ui: {
        kind: "question",
        data: {
          title: null,
          submitLabel: null,
          questions: [
            { id: "q1", prompt: "How many guests?", kind: "text", choices: [], allowOther: false, placeholder: null, scale: null },
            {
              id: "q2",
              prompt: "Indoor or outdoor?",
              kind: "single",
              choices: [
                { id: "1", label: "Indoor", detail: null },
                { id: "2", label: "Outdoor", detail: null },
              ],
              allowOther: false,
              placeholder: null,
              scale: null,
            },
          ],
        },
      },
      approvalResponsibilityId: "r1",
      baseUrl: "https://august.example",
    });
    expect(body).toContain("Two quick things before I book:");
    expect(body).toContain("1. How many guests?");
    expect(body).toContain("2. Indoor or outdoor? (Indoor / Outdoor)");
    expect(body).toContain("https://august.example/?responsibility=r1");
    expect(body).not.toContain("**");
  });

  it("puts a compact tapback line after the reacted message", () => {
    const history = toModelHistory(
      [
        { id: "a", role: "user", content: "Find dinner" },
        { id: "b", role: "assistant", content: "I found three places near you, my pick is Nopa at 7:30 with a patio." },
      ],
      new Map([["b", { emoji: "👍" as const }]]),
      "Charlie",
    );
    expect(history).toHaveLength(3);
    expect(history[2]).toEqual({
      role: "user",
      content: '[Charlie reacted 👍 to: "I found three places near you, my pick is Nopa at 7:30 with…"]',
    });
  });
});
