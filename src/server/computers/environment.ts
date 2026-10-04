import "server-only";

import { query, tx } from "../db/client";
import { recordEvidence } from "../db/evidence";
import { trace } from "../db/traces";
import type { AuthorizedEffect, DispatchResult, EffectDraft } from "../effects/types";
import { getSpritesProvider, NOT_CONFIGURED, type SpriteError, type SpritesPort } from "../providers/sprites";
import { putObjectVerified, sha256Bytes } from "./storage";
import {
  EMPTY_MANIFEST,
  ENVIRONMENT_LIMITS,
  EnvironmentError,
  bundleObjectKey,
  buildBundleScript,
  builderSpriteName,
  canonicalManifest,
  decideActivation,
  manifestSha256,
  nextManifestFor,
  parseEnvironmentChangeArgs,
  CHANGE_FORMAT,
  type EnvironmentChangeArgs,
  type EnvironmentHead,
  type EnvironmentOperation,
  type UserEnvironmentManifest,
  type UserEnvironmentTool,
} from "./types";

/**
 * User Environment: the user's portable, versioned set of tools (DECISIONS D1).
 *
 * Canonical state is Postgres (user_environment_states head + immutable
 * user_environments generations); bundles live in object storage. Changes are
 * consequential effects: `prepareEnvironmentChange` freezes the exact change,
 * the exact-effect rail authorizes it, and `applyEnvironmentChangeAuthorized`
 * executes exactly that change, activating it by compare-and-swap.
 */

export const ENVIRONMENT_PROVIDER = "computer";
export const ENVIRONMENT_ACTION = "user_environment_change";

/** Minimal query surface (Pool or PoolClient) so the CAS can run in a tx or a fake. */
export type Db = {
  query: <R = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ) => Promise<{ rows: R[]; rowCount: number | null }>;
};

const defaultDb: Db = { query: query as unknown as Db["query"] };

export type ActiveEnvironment = {
  generation: number;
  activationRevision: number;
  manifest: UserEnvironmentManifest;
  manifestSha256: string;
  bundleObjectKey: string | null;
  bundleSha256: string | null;
};

async function readHead(db: Db, userId: string): Promise<EnvironmentHead> {
  await db.query(
    `insert into user_environment_states (user_id) values ($1) on conflict (user_id) do nothing`,
    [userId],
  );
  const { rows } = await db.query<{ active_generation: number; activation_revision: number }>(
    `select active_generation, activation_revision from user_environment_states where user_id = $1`,
    [userId],
  );
  return { activeGeneration: rows[0].active_generation, activationRevision: rows[0].activation_revision };
}

type GenerationRow = {
  generation: number;
  manifest: UserEnvironmentManifest;
  manifest_sha256: string;
  bundle_object_key: string | null;
  bundle_sha256: string | null;
  status: string;
};

async function readPublishedGeneration(db: Db, userId: string, generation: number): Promise<GenerationRow | null> {
  if (generation === 0) {
    return {
      generation: 0,
      manifest: EMPTY_MANIFEST,
      manifest_sha256: manifestSha256(EMPTY_MANIFEST),
      bundle_object_key: null,
      bundle_sha256: null,
      status: "published",
    };
  }
  const { rows } = await db.query<GenerationRow>(
    `select generation, manifest, manifest_sha256, bundle_object_key, bundle_sha256, status
       from user_environments
      where user_id = $1 and generation = $2 and status = 'published'`,
    [userId, generation],
  );
  return rows[0] ?? null;
}

/** The user's active generation and its manifest. Generation 0 = empty baseline. */
export async function getActiveEnvironment(userId: string, db: Db = defaultDb): Promise<ActiveEnvironment> {
  const head = await readHead(db, userId);
  const row = await readPublishedGeneration(db, userId, head.activeGeneration);
  if (!row) throw new EnvironmentError("active_generation_missing");
  return {
    generation: head.activeGeneration,
    activationRevision: head.activationRevision,
    manifest: canonicalManifest(row.manifest),
    manifestSha256: row.manifest_sha256,
    bundleObjectKey: row.bundle_object_key,
    bundleSha256: row.bundle_sha256,
  };
}

/** Reads a specific published generation (for pinned Computers). */
export async function getPublishedGeneration(
  userId: string,
  generation: number,
  db: Db = defaultDb,
): Promise<ActiveEnvironment | null> {
  const row = await readPublishedGeneration(db, userId, generation);
  if (!row) return null;
  return {
    generation,
    activationRevision: -1,
    manifest: canonicalManifest(row.manifest),
    manifestSha256: row.manifest_sha256,
    bundleObjectKey: row.bundle_object_key,
    bundleSha256: row.bundle_sha256,
  };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

function toolLabel(t: UserEnvironmentTool): string {
  return t.packageName === "-" ? `${t.toolKey}@${t.packageVersion} (setup)` : `${t.toolKey} (${t.packageName}@${t.packageVersion})`;
}

export type PrepareEnvironmentChangeInput = {
  userId: string;
  operation: EnvironmentOperation;
  tool?: UserEnvironmentTool;
  removeToolKey?: string;
  rollbackGeneration?: number;
};

/**
 * Freezes the exact environment change against the CURRENT head. The draft is
 * stale (and will fail CAS) if anything activates before it is dispatched.
 * Throws EnvironmentError for invalid/no-op changes.
 */
export async function prepareEnvironmentChange(
  input: PrepareEnvironmentChangeInput,
  db: Db = defaultDb,
): Promise<EffectDraft> {
  const current = await getActiveEnvironment(input.userId, db);
  let nextManifest: UserEnvironmentManifest;
  let summary: string;
  if (input.operation === "install") {
    if (!input.tool) throw new EnvironmentError("tool_required");
    nextManifest = nextManifestFor(current.manifest, { operation: "install", tool: input.tool });
    summary = `Install ${toolLabel(input.tool)} into your personal computer environment`;
  } else if (input.operation === "remove") {
    if (!input.removeToolKey) throw new EnvironmentError("remove_tool_key_required");
    nextManifest = nextManifestFor(current.manifest, { operation: "remove", removeToolKey: input.removeToolKey });
    summary = `Remove ${input.removeToolKey} from your personal computer environment`;
  } else if (input.operation === "rollback") {
    const g = input.rollbackGeneration;
    if (g === undefined || !Number.isSafeInteger(g) || g < 0) throw new EnvironmentError("rollback_generation_required");
    if (g === current.generation) throw new EnvironmentError("change_noop", "that generation is already active");
    const target = await readPublishedGeneration(db, input.userId, g);
    if (!target) throw new EnvironmentError("rollback_generation_not_published");
    nextManifest = canonicalManifest(target.manifest);
    summary = `Roll your computer environment back to version ${g}`;
  } else {
    throw new EnvironmentError("change_operation_invalid");
  }

  const args: EnvironmentChangeArgs = {
    format: CHANGE_FORMAT,
    userId: input.userId,
    operation: input.operation,
    tool: input.operation === "install" ? canonicalManifest({ tools: [input.tool!] }).tools[0] : null,
    removeToolKey: input.operation === "remove" ? input.removeToolKey! : null,
    rollbackGeneration: input.operation === "rollback" ? input.rollbackGeneration! : null,
    expectedGeneration: current.generation,
    expectedActivationRevision: current.activationRevision,
    nextManifest,
    nextManifestSha256: manifestSha256(nextManifest),
  };
  // Round-trip through the strict parser so a draft can never hold args the dispatcher rejects.
  parseEnvironmentChangeArgs(args as unknown as Record<string, unknown>);

  return deepFreeze({
    provider: ENVIRONMENT_PROVIDER,
    action: ENVIRONMENT_ACTION,
    args: args as unknown as Record<string, unknown>,
    materialFacts: {
      summary,
      currentGeneration: current.generation,
      currentTools: current.manifest.tools.map(toolLabel),
      nextTools: nextManifest.tools.map(toolLabel),
      setupCommands: nextManifest.tools.filter((t) => t.setup).map((t) => ({ toolKey: t.toolKey, command: t.setup! })),
    },
  });
}

// ---------------------------------------------------------------------------
// Compare-and-swap activation

export type ActivationResult =
  | { ok: true; head: EnvironmentHead }
  | { ok: false; reason: "conflict"; observed: EnvironmentHead };

/**
 * Atomically moves the head to `targetGeneration` iff it still equals `expected`.
 * Must run inside a transaction (row lock via `for update`). The UPDATE's own
 * WHERE clause is the real guard; the pure decision mirrors it for clarity/tests.
 */
export async function activateGenerationCas(
  db: Db,
  args: { userId: string; expected: EnvironmentHead; targetGeneration: number },
): Promise<ActivationResult> {
  const { rows } = await db.query<{ active_generation: number; activation_revision: number }>(
    `select active_generation, activation_revision from user_environment_states where user_id = $1 for update`,
    [args.userId],
  );
  if (!rows[0]) throw new EnvironmentError("environment_state_missing");
  const observed = { activeGeneration: rows[0].active_generation, activationRevision: rows[0].activation_revision };
  const decision = decideActivation(observed, args.expected, args.targetGeneration);
  if (!decision.ok) return decision;
  const upd = await db.query(
    `update user_environment_states
        set active_generation = $2, activation_revision = activation_revision + 1, updated_at = now()
      where user_id = $1 and active_generation = $3 and activation_revision = $4`,
    [args.userId, args.targetGeneration, args.expected.activeGeneration, args.expected.activationRevision],
  );
  if (upd.rowCount !== 1) return { ok: false, reason: "conflict", observed };
  return { ok: true, head: decision.next };
}

// ---------------------------------------------------------------------------
// Dispatch

const BUILD_TIMEOUT_MS = 10 * 60_000;
const BUNDLE_PATH = "/tmp/august-env-bundle.tgz";

function failed(safeSummary: string, evidenceRefs: string[] = []): DispatchResult {
  return { outcome: "failed", providerReceiptRef: null, providerRequestId: null, evidenceRefs, safeSummary };
}

function providerFailure(stage: string, e: SpriteError): string {
  if (e.code === "provider_billing_restricted") {
    return `blocked (provider_billing_restricted): Fly Sprites account is restricted, could not ${stage}`;
  }
  return `could not ${stage} (${e.code})`;
}

async function destroyBuilder(sprites: SpritesPort, name: string): Promise<boolean> {
  const d = await sprites.destroy(name);
  if (!d.ok) return false;
  const check = await sprites.inspect(name);
  return check.ok && check.value === null;
}

type BuiltBundle = { key: string; sha256: string; byteCount: number };

/** Builds the bundle in a disposable builder Sprite and uploads it with readback verification. */
async function buildAndUploadBundle(
  sprites: SpritesPort,
  args: EnvironmentChangeArgs,
  seed: string,
): Promise<{ ok: true; bundle: BuiltBundle } | { ok: false; summary: string }> {
  const name = builderSpriteName(seed);
  const created = await sprites.create(name);
  if (!created.ok && created.error.code !== "already_exists") {
    return { ok: false, summary: providerFailure("create the builder computer", created.error) };
  }
  try {
    const run = await sprites.exec(name, {
      command: buildBundleScript(args.nextManifest, BUNDLE_PATH),
      timeoutMs: BUILD_TIMEOUT_MS,
      maxOutputBytes: 64 * 1024,
    });
    if (!run.ok) return { ok: false, summary: providerFailure("run the environment build", run.error) };
    if (run.value.exitCode !== 0) {
      const tail = run.value.stderr.trim().split("\n").slice(-3).join(" | ").slice(0, 300);
      return { ok: false, summary: `environment build failed (exit ${run.value.exitCode}): ${tail}` };
    }
    const reported = run.value.stdout.trim().split("\n").pop()?.trim() ?? "";
    if (!/^[a-f0-9]{64}$/.test(reported)) return { ok: false, summary: "environment build did not report a bundle digest" };

    const read = await sprites.readFile(name, BUNDLE_PATH, ENVIRONMENT_LIMITS.bundleCompressedBytes);
    if (!read.ok) return { ok: false, summary: providerFailure("read the built bundle", read.error) };
    if (sha256Bytes(read.value) !== reported) return { ok: false, summary: "bundle digest mismatch between builder and server" };

    const key = bundleObjectKey(args.userId, reported);
    const stored = await putObjectVerified({
      key,
      bytes: read.value,
      contentType: "application/gzip",
      expectedSha256: reported,
    });
    return { ok: true, bundle: stored };
  } catch (err) {
    return { ok: false, summary: `environment bundle upload failed: ${(err as Error).message.slice(0, 200)}` };
  } finally {
    // Builders are disposable; a leaked builder holds no canonical state.
    await destroyBuilder(sprites, name).catch(() => false);
  }
}

/**
 * Executes exactly the frozen environment change. Replays of the same effect
 * return the original receipt. A head that moved since preparation is a CAS
 * conflict: the generation is marked failed and nothing activates.
 */
export async function applyEnvironmentChangeAuthorized(
  effect: AuthorizedEffect,
  deps: { sprites?: SpritesPort | null; db?: Db } = {},
): Promise<DispatchResult> {
  if (effect.provider !== ENVIRONMENT_PROVIDER || effect.action !== ENVIRONMENT_ACTION) {
    return failed("wrong effect type for environment change");
  }
  let args: EnvironmentChangeArgs;
  try {
    args = parseEnvironmentChangeArgs(effect.canonicalArgs);
  } catch (err) {
    return failed(`invalid environment change: ${(err as EnvironmentError).code ?? "invalid"}`);
  }
  if (args.userId !== effect.userId) return failed("environment change belongs to another user");
  const db = deps.db ?? defaultDb;

  // Replay: this effect already produced a generation.
  const prior = await db.query<{ id: string; generation: number; status: string }>(
    `select id, generation, status from user_environments where user_id = $1 and source_effect_id = $2`,
    [effect.userId, effect.id],
  );
  if (prior.rows[0]?.status === "published") {
    return {
      outcome: "succeeded",
      providerReceiptRef: `user_environment:${prior.rows[0].id}`,
      providerRequestId: null,
      evidenceRefs: [],
      safeSummary: `Environment version ${prior.rows[0].generation} is already active (replay)`,
    };
  }
  if (prior.rows[0]) return failed(`environment change already attempted (status ${prior.rows[0].status})`);

  const head = await readHead(db, effect.userId);
  const expected = { activeGeneration: args.expectedGeneration, activationRevision: args.expectedActivationRevision };
  if (!decideActivation(head, expected, 0).ok) {
    return failed("environment changed since this was approved (conflict); prepare the change again");
  }

  // Rollback re-activates an existing immutable generation; no build.
  if (args.operation === "rollback") {
    const target = await readPublishedGeneration(db, effect.userId, args.rollbackGeneration!);
    if (!target || target.manifest_sha256 !== args.nextManifestSha256) {
      return failed("rollback target is missing or does not match the approved manifest");
    }
    const res = await tx((client) =>
      activateGenerationCas(client as unknown as Db, {
        userId: effect.userId,
        expected,
        targetGeneration: args.rollbackGeneration!,
      }),
    );
    if (!res.ok) return failed("environment changed since this was approved (conflict); nothing was activated");
    const ev = await recordEvidence({
      userId: effect.userId,
      responsibilityId: effect.responsibilityId,
      provider: "computer",
      sourceRef: `user_environment_generation:${args.rollbackGeneration}`,
      safeSummary: `Rolled environment back to version ${args.rollbackGeneration}`,
      payload: { head: res.head, manifestSha256: args.nextManifestSha256 },
    });
    return {
      outcome: "succeeded",
      providerReceiptRef: `user_environment_generation:${args.rollbackGeneration}`,
      providerRequestId: null,
      evidenceRefs: [ev],
      safeSummary: `Rolled your environment back to version ${args.rollbackGeneration}`,
    };
  }

  // Install/remove: allocate an immutable generation, build, verify, then CAS-activate.
  const alloc = await db.query<{ generation: number }>(
    `update user_environment_states set next_generation = next_generation + 1, updated_at = now()
      where user_id = $1 returning next_generation - 1 as generation`,
    [effect.userId],
  );
  const generation = alloc.rows[0].generation;
  const ins = await db.query<{ id: string }>(
    `insert into user_environments (user_id, generation, manifest, manifest_sha256, status, source_effect_id)
     values ($1, $2, $3, $4, 'candidate', $5) returning id`,
    [effect.userId, generation, JSON.stringify(args.nextManifest), args.nextManifestSha256, effect.id],
  );
  const rowId = ins.rows[0].id;
  const markFailed = () => db.query(`update user_environments set status = 'failed' where id = $1`, [rowId]);

  let bundle: BuiltBundle | null = null;
  if (args.nextManifest.tools.length > 0) {
    const sprites = deps.sprites === undefined ? getSpritesProvider() : deps.sprites;
    if (!sprites) {
      await markFailed();
      return failed(`could not build environment (${NOT_CONFIGURED.code})`);
    }
    await trace({
      userId: effect.userId,
      responsibilityId: effect.responsibilityId,
      kind: "tool.started",
      detail: { text: "Building your computer environment", generation },
    });
    const built = await buildAndUploadBundle(sprites, args, `${effect.idempotencyKey}:${generation}`);
    if (!built.ok) {
      await markFailed();
      await trace({
        userId: effect.userId,
        responsibilityId: effect.responsibilityId,
        kind: "tool.failed",
        detail: { text: "Environment build did not complete", generation },
      });
      return failed(built.summary);
    }
    bundle = built.bundle;
  }

  await db.query(
    `update user_environments set status = 'verified', bundle_object_key = $2, bundle_sha256 = $3 where id = $1`,
    [rowId, bundle?.key ?? null, bundle?.sha256 ?? null],
  );

  const res = await tx(async (client) => {
    const r = await activateGenerationCas(client as unknown as Db, {
      userId: effect.userId,
      expected,
      targetGeneration: generation,
    });
    await client.query(`update user_environments set status = $2 where id = $1`, [rowId, r.ok ? "published" : "failed"]);
    return r;
  });
  if (!res.ok) {
    return failed("environment changed while building (conflict); this version was not activated");
  }

  const ev = await recordEvidence({
    userId: effect.userId,
    responsibilityId: effect.responsibilityId,
    provider: "computer",
    sourceRef: `user_environment:${rowId}`,
    safeSummary: `Activated environment version ${generation} (${args.nextManifest.tools.length} tools)`,
    payload: { generation, manifestSha256: args.nextManifestSha256, bundle },
  });
  await trace({
    userId: effect.userId,
    responsibilityId: effect.responsibilityId,
    kind: "tool.succeeded",
    detail: { text: `Activated computer environment version ${generation}`, generation },
  });
  return {
    outcome: "succeeded",
    providerReceiptRef: `user_environment:${rowId}`,
    providerRequestId: null,
    evidenceRefs: [ev],
    safeSummary: `Activated environment version ${generation}: ${args.nextManifest.tools.map((t) => t.toolKey).join(", ") || "no tools"}`,
  };
}
