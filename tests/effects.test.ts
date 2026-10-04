import { describe, expect, it } from "vitest";

import {
  CanonicalizationError,
  canonicalJson,
  proposalHash,
  type ProposalHashInput,
} from "../src/server/effects/canonicalize";
import { classifyAction, isExternalEffect } from "../src/server/effects/classify";
import { idempotencyKey } from "../src/server/effects/idempotency";

const baseProposal: ProposalHashInput = {
  provider: "agentmail",
  action: "send_email",
  exactArgs: {
    fromInbox: "august-demo@agentmail.to",
    to: ["restaurant@example.com"],
    subject: "Table for two tonight",
    text: "Hi, could we book a table for two at 7pm?",
    options: { trackOpens: false, priority: 1 },
  },
  materialFacts: { business: "Example Bistro" },
};

describe("canonicalJson", () => {
  it("is independent of key order at every depth", () => {
    const a = { b: 1, a: { y: [1, { q: 1, p: 2 }], x: "s" }, c: null };
    const b = { c: null, a: { x: "s", y: [1, { p: 2, q: 1 }] }, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson(a)).toBe('{"a":{"x":"s","y":[1,{"p":2,"q":1}]},"b":1,"c":null}');
  });

  it("sorts integer-like keys lexically like any other key", () => {
    expect(canonicalJson({ "10": 1, "9": 2, a: 3 })).toBe('{"10":1,"9":2,"a":3}');
  });

  it("omits undefined object properties but preserves array order", () => {
    expect(canonicalJson({ a: 1, b: undefined, list: [3, 1, 2] })).toBe('{"a":1,"list":[3,1,2]}');
  });

  it("rejects NaN, Infinity, functions, undefined array items and non-plain objects", () => {
    expect(() => canonicalJson({ a: NaN })).toThrow(CanonicalizationError);
    expect(() => canonicalJson({ a: Infinity })).toThrow(CanonicalizationError);
    expect(() => canonicalJson({ a: () => 1 })).toThrow(CanonicalizationError);
    expect(() => canonicalJson([1, undefined])).toThrow(CanonicalizationError);
    expect(() => canonicalJson({ when: new Date() })).toThrow(CanonicalizationError);
    expect(() => canonicalJson({ n: BigInt(1) })).toThrow(CanonicalizationError);
  });

  it("rejects circular references", () => {
    const o: Record<string, unknown> = {};
    o.self = o;
    expect(() => canonicalJson(o)).toThrow(/circular/);
  });

  it("treats __proto__ as an ordinary key", () => {
    const o = JSON.parse('{"__proto__":{"x":1},"a":2}');
    expect(canonicalJson(o)).toBe('{"__proto__":{"x":1},"a":2}');
  });
});

describe("proposalHash", () => {
  it("has the sha256:<hex> format", () => {
    expect(proposalHash(baseProposal)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("is independent of argument key order", () => {
    const reordered: ProposalHashInput = {
      materialFacts: { business: "Example Bistro" },
      exactArgs: {
        options: { priority: 1, trackOpens: false },
        text: baseProposal.exactArgs.text,
        subject: baseProposal.exactArgs.subject,
        to: ["restaurant@example.com"],
        fromInbox: "august-demo@agentmail.to",
      },
      action: "send_email",
      provider: "agentmail",
    };
    expect(proposalHash(reordered)).toBe(proposalHash(baseProposal));
  });

  it("changes when any material argument changes", () => {
    const original = proposalHash(baseProposal);
    const variants: ProposalHashInput[] = [
      { ...baseProposal, provider: "executor" },
      { ...baseProposal, action: "send_draft" },
      { ...baseProposal, exactArgs: { ...baseProposal.exactArgs, to: ["other@example.com"] } },
      {
        ...baseProposal,
        exactArgs: { ...baseProposal.exactArgs, to: ["restaurant@example.com", "cc@example.com"] },
      },
      { ...baseProposal, exactArgs: { ...baseProposal.exactArgs, subject: "Table for three tonight" } },
      { ...baseProposal, exactArgs: { ...baseProposal.exactArgs, text: "Hi, could we book a table for two at 8pm?" } },
      { ...baseProposal, exactArgs: { ...baseProposal.exactArgs, fromInbox: "x@agentmail.to" } },
      { ...baseProposal, exactArgs: { ...baseProposal.exactArgs, options: { trackOpens: true, priority: 1 } } },
      { ...baseProposal, exactArgs: { ...baseProposal.exactArgs, extra: "field" } },
      { ...baseProposal, materialFacts: { business: "Other Bistro" } },
    ];
    const hashes = variants.map(proposalHash);
    for (const h of hashes) expect(h).not.toBe(original);
    expect(new Set(hashes).size).toBe(hashes.length);
  });
});

describe("classifyAction", () => {
  it("defaults unknown actions to consequential", () => {
    const c = classifyAction("executor", "crm.update_contact");
    expect(c).toMatchObject({ kind: "effect", effectClass: "consequential", source: "unknown_default" });
    expect(classifyAction("someprovider", "frobnicate")).toMatchObject({
      kind: "effect",
      effectClass: "consequential",
    });
  });

  it("classifies purchases as irreversible", () => {
    expect(classifyAction("kernel", "purchase")).toMatchObject({
      kind: "effect",
      effectClass: "irreversible",
      category: "purchase",
      source: "policy_table",
    });
    // Unknown actions in irreversible categories escalate rather than default.
    expect(classifyAction("executor", "shop.purchaseItem")).toMatchObject({
      effectClass: "irreversible",
      category: "purchase",
      source: "irreversible_keyword",
    });
    expect(classifyAction("executor", "bank.transfer_funds")).toMatchObject({
      effectClass: "irreversible",
      supported: false,
    });
    expect(classifyAction("executor", "calendar.delete_event")).toMatchObject({
      effectClass: "irreversible",
    });
  });

  it("does not classify read actions as effects", () => {
    for (const [provider, action] of [
      ["exa", "search"],
      ["agentmail", "list_messages"],
      ["kernel", "read_page"],
      ["executor", "calendar.list_events"],
    ] as const) {
      expect(classifyAction(provider, action).kind).toBe("read");
      expect(isExternalEffect(provider, action)).toBe(false);
    }
  });

  it("classifies sends as consequential and drafts as reversible", () => {
    expect(classifyAction("agentmail", "send_email")).toMatchObject({ effectClass: "consequential" });
    expect(classifyAction("agentmail", "create_draft")).toMatchObject({ effectClass: "reversible" });
  });

  it("treats internal state changes as internal writes, not external effects", () => {
    expect(classifyAction("internal", "schedule_wake").kind).toBe("internal_write");
  });
});

describe("idempotencyKey", () => {
  const input = {
    userId: "u1",
    responsibilityId: "r1",
    effectType: "agentmail.send_email",
    proposalHash: proposalHash(baseProposal),
    attempt: 1,
  };

  it("is deterministic and changes with each component", () => {
    const k = idempotencyKey(input);
    expect(k).toMatch(/^[0-9a-f]{64}$/);
    expect(idempotencyKey({ ...input })).toBe(k);
    expect(idempotencyKey({ ...input, attempt: 2 })).not.toBe(k);
    expect(idempotencyKey({ ...input, userId: "u2" })).not.toBe(k);
    expect(idempotencyKey({ ...input, responsibilityId: "r2" })).not.toBe(k);
    expect(idempotencyKey({ ...input, effectType: "agentmail.reply" })).not.toBe(k);
    expect(idempotencyKey({ ...input, proposalHash: "sha256:00" })).not.toBe(k);
  });

  it("rejects invalid attempts and delimiter injection", () => {
    expect(() => idempotencyKey({ ...input, attempt: 0 })).toThrow();
    expect(() => idempotencyKey({ ...input, attempt: 1.5 })).toThrow();
    expect(() => idempotencyKey({ ...input, userId: "u1|r1" })).toThrow();
  });
});
