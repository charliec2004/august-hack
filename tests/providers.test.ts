import { createHmac } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/db/evidence", () => ({ recordEvidence: vi.fn(async () => "ev_test") }));
vi.mock("@/server/db/traces", () => ({ trace: vi.fn(async () => {}) }));

import {
  bareAddress,
  buildSendDraft,
  normalizeAgentMailEvent,
  verifyAgentMailWebhook,
} from "../src/server/providers/agentmail";
import { boundText, isRetryableStatus, normalizeExaResult } from "../src/server/providers/exa";
import {
  buildAuthorizedProgram,
  buildIntentDiscoveryProgram,
  calendarPrepareCreateEvent,
  computeFreeWindows,
  interpretExecuteResult,
  isReadOnlyToolPath,
  looksMutating,
  normalizeCalendarEvents,
  redactSecrets,
  zonedTimeToUtc,
} from "../src/server/providers/executor";
import {
  buildCommitArgs,
  defaultCommitText,
  diffFacts,
  extractConfirmationRef,
  selectRelevantText,
} from "../src/server/providers/kernel";

describe("exa normalization", () => {
  const at = "2026-10-04T12:00:00.000Z";

  it("normalizes and bounds highlight text", () => {
    const r = normalizeExaResult(
      { title: "  Ramen  ", url: "https://x.test/a", publishedDate: "2026-09-01T10:00:00Z", highlights: ["a ".repeat(500), "b"] },
      at,
    );
    expect(r).not.toBeNull();
    expect(r!.title).toBe("Ramen");
    expect(r!.publishedDate).toBe("2026-09-01");
    expect(r!.highlights.length).toBeLessThanOrEqual(600);
    expect(r!.retrievedAt).toBe(at);
  });

  it("rejects non-http urls and tolerates missing fields", () => {
    expect(normalizeExaResult({ url: "javascript:alert(1)" }, at)).toBeNull();
    const r = normalizeExaResult({ url: "https://x.test", title: null, publishedDate: "garbage" }, at);
    expect(r!.title).toBe("https://x.test");
    expect(r!.publishedDate).toBeNull();
    expect(r!.highlights).toBe("");
  });

  it("boundText clips with an ellipsis", () => {
    expect(boundText("hello   world", 50)).toBe("hello world");
    expect(boundText("word ".repeat(100), 20).length).toBeLessThanOrEqual(20);
  });

  it("retries only 429/5xx/network", () => {
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(undefined)).toBe(true);
    expect(isRetryableStatus(400)).toBe(false);
    expect(isRetryableStatus(401)).toBe(false);
  });
});

describe("executor helpers", () => {
  it("redacts secret keys and token-shaped values", () => {
    const out = redactSecrets({
      access_token: "x",
      nested: { Authorization: "Bearer abc", note: "token ya29.AbC-123 here", ok: 1 },
      list: ["Bearer zzz.yyy"],
    }) as Record<string, unknown>;
    expect(out).not.toHaveProperty("access_token");
    expect(JSON.stringify(out)).not.toMatch(/ya29\.|Bearer abc|Bearer zzz/);
    expect((out.nested as Record<string, unknown>).ok).toBe(1);
  });

  it("detects mutating programs but allows reads", () => {
    expect(looksMutating("await tools.google_calendar.user.x.calendar.events.insert({})")).toBe(true);
    expect(looksMutating("await tools.x.calendar.events.delete({ eventId })")).toBe(true);
    expect(looksMutating("const d = new Date(); d.setUTCHours(0); await tools.x.calendar.events.list({})")).toBe(false);
  });

  it("classifies read-only tool paths", () => {
    expect(isReadOnlyToolPath("google_calendar.user.c.calendar.events.list")).toBe(true);
    expect(isReadOnlyToolPath("google_calendar.user.c.calendar.freebusy.query")).toBe(true);
    expect(isReadOnlyToolPath("google_calendar.user.c.calendar.events.insert")).toBe(false);
    expect(isReadOnlyToolPath("x.list); evil(")).toBe(false);
  });

  it("interprets execute results", () => {
    expect(interpretExecuteResult({ structuredContent: { status: "completed", result: { a: 1 } } })).toEqual({
      kind: "completed",
      result: { a: 1 },
    });
    expect(
      interpretExecuteResult({ structuredContent: { status: "error", error: "boom" }, isError: true }),
    ).toMatchObject({ kind: "error", error: "boom" });
    expect(
      interpretExecuteResult({ structuredContent: { status: "waiting_for_interaction", executionId: "exec_1" } }),
    ).toEqual({ kind: "paused", executionId: "exec_1", status: "waiting_for_interaction" });
  });

  it("converts zoned wall time to UTC across DST", () => {
    expect(zonedTimeToUtc(2026, 10, 4, 0, 0, "America/Los_Angeles").toISOString()).toBe("2026-10-04T07:00:00.000Z");
    expect(zonedTimeToUtc(2026, 12, 4, 0, 0, "America/Los_Angeles").toISOString()).toBe("2026-12-04T08:00:00.000Z");
    expect(zonedTimeToUtc(2026, 10, 4, 9, 30, "UTC").toISOString()).toBe("2026-10-04T09:30:00.000Z");
  });

  it("normalizes calendar events and computes free windows", () => {
    const tz = "America/Los_Angeles";
    const events = normalizeCalendarEvents(
      [
        { summary: "Standup", start: { dateTime: "2026-10-04T09:00:00-07:00" }, end: { dateTime: "2026-10-04T09:30:00-07:00" } },
        { summary: "Lunch", start: { dateTime: "2026-10-04T12:00:00-07:00" }, end: { dateTime: "2026-10-04T13:00:00-07:00" } },
        { summary: "Overlap", start: { dateTime: "2026-10-04T12:30:00-07:00" }, end: { dateTime: "2026-10-04T13:30:00-07:00" } },
        { summary: "Optional", transparency: "transparent", start: { dateTime: "2026-10-04T15:00:00-07:00" }, end: { dateTime: "2026-10-04T16:00:00-07:00" } },
        { summary: "Declined", selfResponse: "declined", start: { dateTime: "2026-10-04T17:00:00-07:00" }, end: { dateTime: "2026-10-04T18:00:00-07:00" } },
        { summary: "Gone", status: "cancelled", start: { dateTime: "2026-10-04T19:00:00-07:00" }, end: { dateTime: "2026-10-04T20:00:00-07:00" } },
        { summary: "Holiday", start: { date: "2026-10-04" }, end: { date: "2026-10-05" } },
      ],
      tz,
    );
    expect(events.map((e) => e.title)).not.toContain("Gone");
    expect(events.find((e) => e.title === "Holiday")).toMatchObject({ allDay: true, busy: false });
    expect(events.find((e) => e.title === "Optional")!.busy).toBe(false);
    expect(events.find((e) => e.title === "Declined")!.busy).toBe(false);

    const windows = computeFreeWindows(
      events,
      zonedTimeToUtc(2026, 10, 4, 8, 0, tz),
      zonedTimeToUtc(2026, 10, 4, 22, 0, tz),
      tz,
    );
    expect(windows.map((w) => [w.startLocal, w.endLocal])).toEqual([
      ["8:00 AM", "9:00 AM"],
      ["9:30 AM", "12:00 PM"],
      ["1:30 PM", "10:00 PM"],
    ]);
  });

  it("embeds intent safely in the discovery program", () => {
    const code = buildIntentDiscoveryProgram('events"); evil(); ("');
    expect(code).toContain(JSON.stringify('events"); evil(); ("'));
    expect(looksMutating(code)).toBe(false);
  });

  it("builds an authorized program only from valid frozen args", () => {
    const draft = calendarPrepareCreateEvent({
      summary: "Dinner",
      startIso: "2026-10-04T19:00:00-07:00",
      endIso: "2026-10-04T20:30:00-07:00",
      timezone: "America/Los_Angeles",
    });
    expect(draft).toMatchObject({ provider: "executor", action: "calendar.create_event" });
    const code = buildAuthorizedProgram(draft.args)!;
    expect(code).toContain("tools.google_calendar.user.personalGoogleCalendarApi.calendar.events.insert(");
    expect(code).toContain('"summary":"Dinner"');
    expect(buildAuthorizedProgram({ tool: "x(); evil" })).toBeNull();
    expect(buildAuthorizedProgram({ connection: "bad path", tool: "a.b" })).toBeNull();
  });
});

describe("kernel helpers", () => {
  it("freezes commit args with normalized text facts and a default commit control", () => {
    const a = buildCommitArgs({
      action: "book",
      url: "https://r.test/book",
      expectedFacts: { time: " 7:00  PM ", party: 2, skip: null },
      instruction: "book a table",
    });
    expect(a).toEqual({
      url: "https://r.test/book",
      steps: [],
      commitText: defaultCommitText("book"),
      factSelectors: {},
      textFacts: { time: "7:00 PM", party: "2" },
      instruction: "book a table",
    });
    expect(new RegExp(a.commitText, "i").test("Reserve now")).toBe(true);
    expect(new RegExp(defaultCommitText("submit_form"), "i").test("Submit order")).toBe(true);
  });

  it("diffs material facts after whitespace normalization", () => {
    expect(diffFacts({ price: "$40 ", time: "7:00 PM" }, { price: "$40", time: "7:00  PM" })).toEqual([]);
    expect(diffFacts({ price: "$40", time: "7:00 PM" }, { price: "$45", time: "7:00 PM", extra: "x" })).toEqual(["extra", "price"]);
  });

  it("prioritizes instruction-relevant lines within the budget", () => {
    const text = "Header\nNav links\nTables available at 7:00 PM for two\nFooter";
    const out = selectRelevantText(text, "available tables tonight", 1000);
    expect(out.split("\n")[0]).toBe("Tables available at 7:00 PM for two");
    expect(selectRelevantText("a".repeat(5000), undefined, 100).length).toBe(100);
  });

  it("extracts confirmation references", () => {
    expect(extractConfirmationRef("Thanks! Your confirmation number: ABC-1234.")).toBe("ABC-1234");
    expect(extractConfirmationRef("Reservation #R99881 confirmed")).toBe("R99881");
    expect(extractConfirmationRef("Nothing here")).toBeNull();
  });
});

describe("agentmail webhook verification", () => {
  const rawKey = Buffer.from("august-test-secret-key-0123456789");
  const secret = `whsec_${rawKey.toString("base64")}`;
  const body = JSON.stringify({ event_type: "message.received", event_id: "evt_1" });
  const ts = 1_790_000_000;
  const sign = (id: string, t: number, b: string, key = rawKey) =>
    `v1,${createHmac("sha256", key).update(`${id}.${t}.${b}`).digest("base64")}`;

  it("accepts a valid Svix signature (Headers or plain object)", () => {
    const headers = { "svix-id": "msg_1", "svix-timestamp": String(ts), "svix-signature": sign("msg_1", ts, body) };
    expect(verifyAgentMailWebhook(body, headers, secret, { nowSec: ts + 10 })).toEqual({ ok: true, webhookId: "msg_1" });
    expect(verifyAgentMailWebhook(Buffer.from(body), new Headers(headers), secret, { nowSec: ts })).toMatchObject({ ok: true });
  });

  it("accepts when any of several signatures matches (key rotation)", () => {
    const headers = {
      "svix-id": "msg_1",
      "svix-timestamp": String(ts),
      "svix-signature": `${sign("msg_1", ts, body, Buffer.from("old"))} ${sign("msg_1", ts, body)}`,
    };
    expect(verifyAgentMailWebhook(body, headers, secret, { nowSec: ts }).ok).toBe(true);
  });

  it("rejects tampered body, stale timestamp, missing headers", () => {
    const headers = { "svix-id": "msg_1", "svix-timestamp": String(ts), "svix-signature": sign("msg_1", ts, body) };
    expect(verifyAgentMailWebhook(body.replace("evt_1", "evt_2"), headers, secret, { nowSec: ts })).toEqual({
      ok: false,
      reason: "bad_signature",
    });
    expect(verifyAgentMailWebhook(body, headers, secret, { nowSec: ts + 3600 })).toEqual({
      ok: false,
      reason: "timestamp_out_of_tolerance",
    });
    expect(verifyAgentMailWebhook(body, {}, secret)).toEqual({ ok: false, reason: "missing_headers" });
  });
});

describe("agentmail event normalization", () => {
  const own = "august-hack@agentmail.to";

  it("normalizes message.received (snake_case wire format)", () => {
    const e = normalizeAgentMailEvent(
      {
        type: "event",
        event_type: "message.received",
        event_id: "evt_1",
        message: {
          inbox_id: own,
          thread_id: "thr_1",
          message_id: "<m1@x>",
          from: "Bistro <hello@bistro.test>",
          subject: "Re: Table for two",
          text: "Yes, 7pm works.\n\nThanks",
        },
        thread: { inbox_id: own, thread_id: "thr_1" },
      },
      own,
    );
    expect(e).toEqual({
      eventId: "evt_1",
      eventType: "message.received",
      inboxId: own,
      threadId: "thr_1",
      messageId: "<m1@x>",
      from: "Bistro <hello@bistro.test>",
      subject: "Re: Table for two",
      textPreview: "Yes, 7pm works. Thanks",
      isInboundMessage: true,
      direction: "inbound",
    });
  });

  it("marks sent/delivered events as outbound, never inbound", () => {
    const sent = normalizeAgentMailEvent({
      event_type: "message.sent",
      event_id: "evt_2",
      send: { inbox_id: own, thread_id: "thr_1", message_id: "<m2@x>", recipients: ["a@b.test"] },
    });
    expect(sent).toMatchObject({ isInboundMessage: false, direction: "outbound", messageId: "<m2@x>", threadId: "thr_1" });
    const delivered = normalizeAgentMailEvent({ eventType: "message.delivered", eventId: "evt_3", delivery: { inboxId: own } });
    expect(delivered).toMatchObject({ isInboundMessage: false, direction: "outbound" });
  });

  it("does not treat a received copy of our own mail as inbound (loop prevention)", () => {
    const e = normalizeAgentMailEvent({ event_type: "message.received", message: { from: `August <${own.toUpperCase()}>` } }, own);
    expect(e.isInboundMessage).toBe(false);
  });

  it("builds a frozen send draft", () => {
    const d = buildSendDraft({ to: " Hello@Bistro.test ", subject: " Table for two ", text: "Hi" }, own);
    expect(d).toEqual({
      provider: "agentmail",
      action: "send_email",
      args: { fromInbox: own, to: ["hello@bistro.test"], subject: "Table for two", text: "Hi" },
      materialFacts: { from: own, recipients: ["hello@bistro.test"], subject: "Table for two", bodyChars: 2, isReply: false },
    });
    expect(() => buildSendDraft({ to: "not-an-email", subject: "x", text: "y" }, own)).toThrow();
    expect(bareAddress("A <B@C.test>")).toBe("b@c.test");
  });
});
