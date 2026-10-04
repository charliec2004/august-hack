import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { APIError } from "@fly/sprites";

import { activateGenerationCas, type Db } from "../src/server/computers/environment";
import {
  EMPTY_MANIFEST,
  EnvironmentError,
  boundOutput,
  buildBundleScript,
  bundleObjectKey,
  canonicalManifest,
  decideActivation,
  lifecycleFromSpriteStatus,
  manifestSha256,
  nextManifestFor,
  parseEnvironmentChangeArgs,
  reconcileLifecycle,
  redactSecrets,
  restoreBundleScript,
  spriteNameForSession,
  type UserEnvironmentTool,
} from "../src/server/computers/types";
import { classifySpriteError } from "../src/server/providers/sprites";

const cowsay: UserEnvironmentTool = { toolKey: "cowsay", packageName: "cowsay", packageVersion: "1.6.0" };
const prettier: UserEnvironmentTool = { toolKey: "prettier", packageName: "prettier", packageVersion: "3.3.3" };
const doordash: UserEnvironmentTool = {
  toolKey: "doordash",
  packageName: "-",
  packageVersion: "0.4.1",
  setup: "curl -fsSL https://example.com/dd-0.4.1 -o \"$AUGUST_ENV_PREFIX/bin/doordash\" && chmod +x \"$AUGUST_ENV_PREFIX/bin/doordash\"",
};

describe("manifest canonicalization", () => {
  it("sorts tools by toolKey and drops unknown fields", () => {
    const m = canonicalManifest({
      tools: [{ ...prettier, extra: "x" } as UserEnvironmentTool, cowsay, doordash],
    });
    expect(m.format).toBe("user-environment-manifest:v1");
    expect(m.tools.map((t) => t.toolKey)).toEqual(["cowsay", "doordash", "prettier"]);
    expect(Object.keys(m.tools[2])).toEqual(["toolKey", "packageName", "packageVersion"]);
  });

  it("rejects duplicate toolKeys", () => {
    expect(() => canonicalManifest({ tools: [cowsay, { ...cowsay, packageVersion: "1.5.0" }] })).toThrow(
      EnvironmentError,
    );
  });

  it("rejects invalid tools and non-npm tools without setup", () => {
    expect(() => canonicalManifest({ tools: [{ ...cowsay, packageVersion: "latest" }] })).toThrow();
    expect(() => canonicalManifest({ tools: [{ ...cowsay, toolKey: "Bad Key" }] })).toThrow();
    expect(() => canonicalManifest({ tools: [{ toolKey: "x", packageName: "-", packageVersion: "1.0.0" }] })).toThrow();
    expect(() => canonicalManifest({ format: "other", tools: [] })).toThrow();
  });

  it("sha256 is order-independent and content-sensitive", () => {
    const a = manifestSha256(canonicalManifest({ tools: [cowsay, prettier] }));
    const b = manifestSha256(canonicalManifest({ tools: [prettier, cowsay] }));
    const c = manifestSha256(canonicalManifest({ tools: [cowsay, { ...prettier, packageVersion: "3.3.4" }] }));
    expect(a).toMatch(/^[a-f0-9]{64}$/);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(manifestSha256(EMPTY_MANIFEST)).not.toBe(a);
  });

  it("install adds or upgrades; remove deletes; no-ops are rejected", () => {
    const m1 = nextManifestFor(EMPTY_MANIFEST, { operation: "install", tool: prettier });
    const m2 = nextManifestFor(m1, { operation: "install", tool: cowsay });
    expect(m2.tools.map((t) => t.toolKey)).toEqual(["cowsay", "prettier"]);
    const m3 = nextManifestFor(m2, { operation: "install", tool: { ...prettier, packageVersion: "3.4.0" } });
    expect(m3.tools.find((t) => t.toolKey === "prettier")?.packageVersion).toBe("3.4.0");
    expect(m3.tools).toHaveLength(2);
    expect(() => nextManifestFor(m3, { operation: "install", tool: cowsay })).toThrow(/already installed/);
    const m4 = nextManifestFor(m3, { operation: "remove", removeToolKey: "cowsay" });
    expect(m4.tools.map((t) => t.toolKey)).toEqual(["prettier"]);
    expect(() => nextManifestFor(m4, { operation: "remove", removeToolKey: "cowsay" })).toThrow(/not installed/);
  });

  it("bundle keys are content-addressed per user", () => {
    const sha = "a".repeat(64);
    expect(bundleObjectKey("11111111-2222-3333-4444-555555555555", sha)).toBe(
      `user-environment/11111111-2222-3333-4444-555555555555/${sha}.tgz`,
    );
    expect(() => bundleObjectKey("u", "nothex")).toThrow();
    expect(() => bundleObjectKey("../x", sha)).toThrow();
  });
});

describe("environment change args", () => {
  const next = canonicalManifest({ tools: [cowsay] });
  const base = {
    format: "user-environment-change:v1",
    userId: "u1",
    operation: "install",
    tool: cowsay,
    removeToolKey: null,
    rollbackGeneration: null,
    expectedGeneration: 0,
    expectedActivationRevision: 0,
    nextManifest: next,
    nextManifestSha256: manifestSha256(next),
  };

  it("accepts a well-formed install", () => {
    expect(parseEnvironmentChangeArgs(base).nextManifestSha256).toBe(base.nextManifestSha256);
  });

  it("rejects a tampered manifest (sha mismatch)", () => {
    const tampered = { ...base, nextManifest: canonicalManifest({ tools: [prettier] }) };
    expect(() => parseEnvironmentChangeArgs(tampered)).toThrow(/sha_mismatch/);
  });

  it("rejects malformed shapes", () => {
    expect(() => parseEnvironmentChangeArgs({ ...base, removeToolKey: "x" })).toThrow();
    expect(() => parseEnvironmentChangeArgs({ ...base, operation: "rollback", tool: null, rollbackGeneration: 0 })).toThrow();
    expect(() => parseEnvironmentChangeArgs({ ...base, expectedGeneration: -1 })).toThrow();
  });
});

describe("compare-and-swap activation", () => {
  it("pure decision: matches -> advance revision; mismatch -> conflict", () => {
    const head = { activeGeneration: 2, activationRevision: 5 };
    expect(decideActivation(head, head, 3)).toEqual({ ok: true, next: { activeGeneration: 3, activationRevision: 6 } });
    expect(decideActivation(head, { activeGeneration: 2, activationRevision: 4 }, 3).ok).toBe(false);
    expect(decideActivation(head, { activeGeneration: 1, activationRevision: 5 }, 3).ok).toBe(false);
  });

  it("rollback to the same generation number still conflicts on stale revision (no ABA)", () => {
    // Head went 1 -> 2 -> back to 1; a change approved at (1, rev 0) must not apply.
    const now = { activeGeneration: 1, activationRevision: 2 };
    expect(decideActivation(now, { activeGeneration: 1, activationRevision: 0 }, 3).ok).toBe(false);
  });

  /** In-memory stand-in for user_environment_states with the same UPDATE guard. */
  function fakeDb(state: { active_generation: number; activation_revision: number }) {
    const db: Db = {
      query: (async (text: string, params: unknown[] = []) => {
        if (/^\s*select/i.test(text)) return { rows: [{ ...state }], rowCount: 1 };
        if (/^\s*update user_environment_states/i.test(text)) {
          const [, target, expGen, expRev] = params as [string, number, number, number];
          if (state.active_generation === expGen && state.activation_revision === expRev) {
            state.active_generation = target;
            state.activation_revision += 1;
            return { rows: [], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        }
        throw new Error(`unexpected sql ${text}`);
      }) as Db["query"],
    };
    return db;
  }

  it("first activation wins, a concurrent second one gets conflict", async () => {
    const state = { active_generation: 0, activation_revision: 0 };
    const db = fakeDb(state);
    const expected = { activeGeneration: 0, activationRevision: 0 };
    const a = await activateGenerationCas(db, { userId: "u", expected, targetGeneration: 1 });
    const b = await activateGenerationCas(db, { userId: "u", expected, targetGeneration: 2 });
    expect(a).toEqual({ ok: true, head: { activeGeneration: 1, activationRevision: 1 } });
    expect(b.ok).toBe(false);
    expect(state).toEqual({ active_generation: 1, activation_revision: 1 });
  });

  it("reports conflict when the UPDATE guard matches no row (lost race after read)", async () => {
    const state = { active_generation: 0, activation_revision: 0 };
    const db = fakeDb(state);
    const racing: Db = {
      query: (async (text: string, params?: unknown[]) => {
        const r = await db.query(text, params);
        if (/^\s*select/i.test(text)) state.activation_revision = 9; // someone else commits in between
        return r;
      }) as Db["query"],
    };
    const res = await activateGenerationCas(racing, {
      userId: "u",
      expected: { activeGeneration: 0, activationRevision: 0 },
      targetGeneration: 1,
    });
    expect(res.ok).toBe(false);
    expect(state.active_generation).toBe(0);
  });
});

describe("computer lifecycle mapping", () => {
  it("maps Sprites statuses", () => {
    expect(lifecycleFromSpriteStatus("running")).toBe("running");
    expect(lifecycleFromSpriteStatus("warm")).toBe("running");
    expect(lifecycleFromSpriteStatus("cold")).toBe("dormant");
    expect(lifecycleFromSpriteStatus("weird")).toBe("lost");
    expect(lifecycleFromSpriteStatus(null)).toBe("released");
  });

  it("a live computer that vanished is lost, not released", () => {
    expect(reconcileLifecycle("running", null)).toBe("lost");
    expect(reconcileLifecycle("dormant", "running")).toBe("running");
    expect(reconcileLifecycle("released", "running")).toBe("released");
  });

  it("sprite names are deterministic, unique per attempt, and valid", () => {
    const a = spriteNameForSession("session:abc", 1);
    expect(a).toBe(spriteNameForSession("session:abc", 1));
    expect(a).not.toBe(spriteNameForSession("session:abc", 2));
    expect(a).not.toBe(spriteNameForSession("session:abd", 1));
    expect(a).toMatch(/^[a-z0-9][a-z0-9-]{0,62}$/);
  });
});

describe("provider error classification", () => {
  it("detects billing restriction", () => {
    const e = new APIError("Your account is restricted. Please contact billing@fly.io", { statusCode: 403 });
    expect(classifySpriteError(e).code).toBe("provider_billing_restricted");
  });
  it("maps statuses", () => {
    expect(classifySpriteError(new APIError("nope", { statusCode: 404 })).code).toBe("not_found");
    expect(classifySpriteError(new APIError("slow down", { statusCode: 429 })).code).toBe("rate_limited");
    expect(classifySpriteError(new Error("Failed to get sprite (status 401): x")).code).toBe("unauthorized");
    const t = new Error("t");
    t.name = "TimeoutError";
    expect(classifySpriteError(t).code).toBe("timeout");
  });
});

describe("scripts and output hygiene", () => {
  it("builder disables npm scripts, runs setup, and writes the manifest marker", () => {
    const script = buildBundleScript(canonicalManifest({ tools: [prettier, doordash, cowsay] }), "/tmp/b.tgz");
    expect(script).toContain("--ignore-scripts");
    expect(script).toContain("'cowsay@1.6.0' 'prettier@3.3.3'");
    expect(script).not.toContain("'-@0.4.1'");
    expect(script).toContain("setup doordash");
    expect(script).toContain(".august-manifest.json");
    expect(script).toContain("sha256sum");
  });

  it("restore verifies the manifest digest", () => {
    expect(restoreBundleScript("/tmp/x.tgz", "f".repeat(64))).toContain("f".repeat(64));
  });

  it("bounds long output keeping head and tail", () => {
    const s = "a".repeat(1000) + "TAIL";
    const b = boundOutput(s, 100);
    expect(b.length).toBeLessThan(200);
    expect(b.endsWith("TAIL")).toBe(true);
    expect(b).toContain("truncated");
  });

  it("redacts obvious secrets", () => {
    const r = redactSecrets("API_KEY=abc123 curl -H 'Authorization: Bearer tok_xyz' --token s3cr3t");
    expect(r).not.toContain("abc123");
    expect(r).not.toContain("tok_xyz");
    expect(r).not.toContain("s3cr3t");
  });
});
