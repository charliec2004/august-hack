import "server-only";

import { createHash } from "node:crypto";
import path from "node:path";

import { loadArtifact } from "../artifacts";
import { query } from "../db/client";
import { recordEvidence } from "../db/evidence";
import { trace } from "../db/traces";
import type { AuthorizedEffect, DispatchResult, EffectDraft } from "../effects/types";
import type { ToolResult } from "../types/domain";
import { getSpritesProvider, NOT_CONFIGURED, type SpriteError, type SpritesPort } from "../providers/sprites";
import { loadToolCredentials, type LoadedCredential } from "../credentials/store";
import { getActiveEnvironment, getPublishedGeneration } from "./environment";
import { detectLocalInstalls } from "./localInstalls";
import { getObjectVerified, putObjectVerified } from "./storage";
import {
  EMPTY_PLAN,
  buildExecRequest,
  planInjection,
  redactOutput,
  toolsWithAuth,
  type InjectionPlan,
  type ToolCredentialMaterial,
} from "./toolAuth";
import {
  ENVIRONMENT_LIMITS,
  boundOutput,
  reconcileLifecycle,
  redactSecrets,
  restoreBundleScript,
  safeCommandText,
  shellQuote,
  spriteNameForSession,
  type CommandOutput,
  type ComputerLease,
  type ComputerLifecycle,
} from "./types";

/**
 * Session-owned Computers on Fly Sprites (DECISIONS D1).
 *
 * Compute follows the session: one live Computer per worker session, created
 * lazily, named deterministically, pinned to the user's active environment
 * generation at acquisition. A Computer is never the source of durable state:
 * outputs are published to object storage; losing it loses only local scratch.
 *
 * `runOnComputer` is for task-local work only. Anything that reaches the outside
 * world (placing an order via a CLI, sending, submitting) must go through
 * `prepareComputerExternal` -> exact-effect rail -> `runComputerExternalAuthorized`.
 */

export const COMPUTER_PROVIDER = "computer";
export const COMPUTER_EXTERNAL_ACTION = "computer_external";

const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_TIMEOUT_MS = 2 * 60_000;
const MAX_ARTIFACT_BYTES = 50 * 1024 * 1024;
const RESTORE_BUNDLE_PATH = "/tmp/august-env-restore.tgz";

export type { ComputerLease } from "./types";

type ComputerRow = {
  id: string;
  user_id: string;
  responsibility_id: string | null;
  worker_session_id: string | null;
  provider_ref: string;
  lifecycle: ComputerLifecycle;
  pinned_generation: number;
};

function result<T>(r: Omit<ToolResult<T>, "evidenceRefs"> & { evidenceRefs?: string[] }): ToolResult<T> {
  return { evidenceRefs: [], ...r };
}

function blockedOrFailed<T>(stage: string, e: SpriteError): ToolResult<T> {
  if (e.code === "provider_billing_restricted") {
    return result({
      status: "blocked",
      safeSummary: `Computers are unavailable: the Fly Sprites account is restricted (provider_billing_restricted). Could not ${stage}.`,
      retry: "after_user",
    });
  }
  if (e.code === "not_configured") {
    return result({ status: "blocked", safeSummary: `Computers are not configured (${e.code}).`, retry: "never" });
  }
  if (e.code === "timeout") {
    return result({ status: "uncertain", safeSummary: `Timed out trying to ${stage}.`, retry: "unsafe_without_readback" });
  }
  return result({
    status: "failed",
    safeSummary: `Could not ${stage} (${e.code}).`,
    retry: e.code === "rate_limited" || e.code === "provider_error" ? "after_backoff" : "never",
  });
}

function toLease(row: ComputerRow, reused: boolean): ComputerLease {
  return {
    computerId: row.id,
    userId: row.user_id,
    responsibilityId: row.responsibility_id,
    workerSessionId: row.worker_session_id,
    spriteName: row.provider_ref,
    pinnedGeneration: row.pinned_generation,
    reused,
  };
}

async function setLifecycle(id: string, lifecycle: ComputerLifecycle): Promise<void> {
  await query(
    `update computers set lifecycle = $2, updated_at = now(),
            released_at = case when $2 = 'released' then now() else released_at end
      where id = $1`,
    [id, lifecycle],
  );
}

/**
 * Who a Computer belongs to: a worker session, else the Brain for one
 * responsibility, else (both null) the user's own console from the Computer panel.
 */
type ComputerScope = { userId: string; responsibilityId: string | null; workerSessionId: string | null };

async function findLive(args: ComputerScope): Promise<ComputerRow | null> {
  const { rows } = args.workerSessionId
    ? await query<ComputerRow>(
        `select id, user_id, responsibility_id, worker_session_id, provider_ref, lifecycle, pinned_generation
           from computers
          where user_id = $1 and worker_session_id = $2 and lifecycle in ('provisioning','running','dormant')`,
        [args.userId, args.workerSessionId],
      )
    : await query<ComputerRow>(
        `select id, user_id, responsibility_id, worker_session_id, provider_ref, lifecycle, pinned_generation
           from computers
          where user_id = $1 and worker_session_id is null and responsibility_id is not distinct from $2::uuid
            and lifecycle in ('provisioning','running','dormant')
          order by created_at desc limit 1`,
        [args.userId, args.responsibilityId],
      );
  return rows[0] ?? null;
}

async function loadOwned(lease: ComputerLease): Promise<ComputerRow | null> {
  const { rows } = await query<ComputerRow>(
    `select id, user_id, responsibility_id, worker_session_id, provider_ref, lifecycle, pinned_generation
       from computers where id = $1 and user_id = $2`,
    [lease.computerId, lease.userId],
  );
  return rows[0] ?? null;
}

/** Restores the pinned generation's verified bundle into ENV_PREFIX on the Sprite. */
async function restoreEnvironment(
  sprites: SpritesPort,
  spriteName: string,
  userId: string,
  generation: number,
): Promise<{ ok: true } | { ok: false; summary: string; error?: SpriteError }> {
  if (generation === 0) return { ok: true };
  const env = await getPublishedGeneration(userId, generation);
  if (!env) return { ok: false, summary: `environment version ${generation} is not published` };
  if (!env.bundleObjectKey || !env.bundleSha256) return { ok: true };
  let bytes: Buffer;
  try {
    bytes = await getObjectVerified(env.bundleObjectKey, env.bundleSha256, ENVIRONMENT_LIMITS.bundleCompressedBytes);
  } catch (err) {
    return { ok: false, summary: `environment bundle failed verification: ${(err as Error).message.slice(0, 120)}` };
  }
  const w = await sprites.writeFile(spriteName, RESTORE_BUNDLE_PATH, bytes, 0o600);
  if (!w.ok) return { ok: false, summary: "could not copy environment bundle", error: w.error };
  const r = await sprites.exec(spriteName, {
    command: restoreBundleScript(RESTORE_BUNDLE_PATH, env.manifestSha256),
    timeoutMs: 5 * 60_000,
    maxOutputBytes: 16 * 1024,
  });
  if (!r.ok) return { ok: false, summary: "could not restore environment", error: r.error };
  if (r.value.exitCode !== 0) {
    return { ok: false, summary: `environment restore failed (exit ${r.value.exitCode})` };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// CLI login injection (toolAuth.ts holds the pure rules)

type Injection = { plan: InjectionPlan; versions: Map<string, string> };

const NO_INJECTION: Injection = { plan: EMPTY_PLAN, versions: new Map() };

/**
 * Credentials for the tools in this pinned generation that declare a login.
 * Never throws: a missing key or unreadable row means "run without the login".
 */
async function loadInjection(userId: string, generation: number): Promise<Injection> {
  if (generation <= 0) return NO_INJECTION;
  try {
    const env = await getPublishedGeneration(userId, generation);
    const declared = env ? toolsWithAuth(env.manifest) : [];
    if (!env || declared.length === 0) return NO_INJECTION;
    const loaded = await loadToolCredentials(userId, declared.map((d) => d.toolKey));
    if (loaded.size === 0) return NO_INJECTION;
    const materials = new Map<string, ToolCredentialMaterial>();
    const versions = new Map<string, string>();
    loaded.forEach((c: LoadedCredential, toolKey) => {
      materials.set(toolKey, c.material);
      versions.set(toolKey, c.updatedAt);
    });
    return { plan: planInjection(env.manifest, materials), versions };
  } catch (err) {
    console.error("[computers] credential injection skipped:", (err as Error).name);
    return NO_INJECTION;
  }
}

type WrittenFiles = Record<string, { path: string; updatedAt: string }>;

async function readWrittenFiles(computerId: string): Promise<WrittenFiles> {
  const { rows } = await query<{ credential_files: WrittenFiles | null }>(
    `select credential_files from computers where id = $1`,
    [computerId],
  );
  return rows[0]?.credential_files ?? {};
}

async function removeCredentialFiles(sprites: SpritesPort, spriteName: string, paths: string[]): Promise<boolean> {
  if (paths.length === 0) return true;
  const r = await sprites.exec(spriteName, {
    command: `rm -f ${paths.map((p) => `"$HOME"/${shellQuote(p)}`).join(" ")}`,
    timeoutMs: 30_000,
    maxOutputBytes: 4096,
  });
  return r.ok && r.value.exitCode === 0;
}

/**
 * Makes the credential files on a live Computer match the user's current
 * logins for its pinned tools: writes new/changed files (0600 under $HOME),
 * deletes ones whose login was removed. Best effort; never blocks the task.
 */
async function syncCredentialFiles(sprites: SpritesPort, row: ComputerRow): Promise<void> {
  const [{ plan, versions }, written] = await Promise.all([
    loadInjection(row.user_id, row.pinned_generation),
    readWrittenFiles(row.id),
  ]);
  const next: WrittenFiles = {};
  const stale: string[] = [];
  for (const [toolKey, w] of Object.entries(written)) {
    const want = plan.files.find((f) => f.toolKey === toolKey);
    if (!want || want.path !== w.path) stale.push(w.path);
  }
  for (const f of plan.files) {
    const updatedAt = versions.get(f.toolKey) ?? "";
    const prior = written[f.toolKey];
    if (prior && prior.path === f.path && prior.updatedAt === updatedAt) {
      next[f.toolKey] = prior;
      continue;
    }
    const dir = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : "";
    const home = await sprites.exec(row.provider_ref, {
      command: `${dir ? `mkdir -p "$HOME"/${shellQuote(dir)} && ` : ""}printf '%s' "$HOME"`,
      timeoutMs: 30_000,
      maxOutputBytes: 4096,
    });
    const homeDir = home.ok && home.value.exitCode === 0 ? home.value.stdout.trim() : "";
    if (!homeDir.startsWith("/")) continue;
    const w = await sprites.writeFile(row.provider_ref, `${homeDir}/${f.path}`, Buffer.from(f.content, "utf8"), 0o600);
    if (w.ok) next[f.toolKey] = { path: f.path, updatedAt };
  }
  if (stale.length > 0 && !(await removeCredentialFiles(sprites, row.provider_ref, stale))) {
    // Keep tracking files we could not delete so release retries.
    for (const [toolKey, w] of Object.entries(written)) if (!next[toolKey] && stale.includes(w.path)) next[toolKey] = w;
  }
  if (JSON.stringify(next) !== JSON.stringify(written)) {
    await query(`update computers set credential_files = $2, updated_at = now() where id = $1`, [row.id, JSON.stringify(next)]);
  }
}

/**
 * Returns the session's live Computer, creating one if needed. Reuse requires
 * positive provider readback; a vanished Sprite is marked `lost` and replaced
 * with a fresh one restored from canonical state.
 */
export async function acquireComputer(args: ComputerScope, deps: { sprites?: SpritesPort | null } = {}): Promise<ToolResult<ComputerLease>> {
  const sprites = deps.sprites === undefined ? getSpritesProvider() : deps.sprites;
  if (!sprites) return blockedOrFailed("start a computer", NOT_CONFIGURED);

  const existing = await findLive(args);
  if (existing) {
    const seen = await sprites.inspect(existing.provider_ref);
    if (!seen.ok) return blockedOrFailed("check the existing computer", seen.error);
    const lifecycle = reconcileLifecycle(existing.lifecycle, seen.value?.status ?? null);
    if (lifecycle !== existing.lifecycle) await setLifecycle(existing.id, lifecycle);
    if (lifecycle === "running" || lifecycle === "dormant") {
      await syncCredentialFiles(sprites, existing).catch(() => undefined);
      return result({
        status: "succeeded",
        data: toLease({ ...existing, lifecycle }, true),
        safeSummary: "Reusing this session's computer",
        retry: "safe",
      });
    }
    if (existing.lifecycle === "provisioning" && seen.value) {
      // Unknown provider status on a half-provisioned row: let repair look at it.
      return result({ status: "uncertain", safeSummary: "Computer state is unclear; try again shortly", retry: "after_backoff" });
    }
    // lost: fall through and replace it. Canonical state is untouched.
  }

  const scope = args.workerSessionId
    ? `session:${args.workerSessionId}`
    : args.responsibilityId
      ? `brain:${args.userId}:${args.responsibilityId}`
      : `console:${args.userId}`;
  const count = args.workerSessionId
    ? await query<{ n: number }>(`select count(*)::int as n from computers where worker_session_id = $1`, [args.workerSessionId])
    : await query<{ n: number }>(
        `select count(*)::int as n from computers
          where user_id = $1 and responsibility_id is not distinct from $2::uuid and worker_session_id is null`,
        [args.userId, args.responsibilityId],
      );
  const name = spriteNameForSession(scope, count.rows[0].n + 1);
  const env = await getActiveEnvironment(args.userId);

  let row: ComputerRow;
  try {
    const ins = await query<ComputerRow>(
      `insert into computers (user_id, responsibility_id, worker_session_id, provider, provider_ref, lifecycle, pinned_generation)
       values ($1, $2, $3, 'sprites', $4, 'provisioning', $5)
       returning id, user_id, responsibility_id, worker_session_id, provider_ref, lifecycle, pinned_generation`,
      [args.userId, args.responsibilityId, args.workerSessionId, name, env.generation],
    );
    row = ins.rows[0];
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      // A concurrent acquire for the same session won; never create a second Sprite.
      return result({ status: "uncertain", safeSummary: "Computer is already being started; retry", retry: "after_backoff" });
    }
    throw err;
  }

  const created = await sprites.create(name);
  if (!created.ok && created.error.code !== "already_exists") {
    const definitelyAbsent = created.error.status !== undefined && created.error.status < 500;
    await setLifecycle(row.id, definitelyAbsent ? "released" : "lost");
    return blockedOrFailed("start a computer", created.error);
  }

  const restored = await restoreEnvironment(sprites, name, args.userId, env.generation);
  if (!restored.ok) {
    const gone = await sprites.destroy(name);
    const after = gone.ok ? await sprites.inspect(name) : null;
    const absent = after !== null && after.ok && after.value === null;
    await setLifecycle(row.id, absent ? "released" : "lost");
    if (restored.error) return blockedOrFailed("restore your tools on the computer", restored.error);
    return result({ status: "failed", safeSummary: restored.summary, retry: "after_backoff" });
  }

  await setLifecycle(row.id, "running");
  await syncCredentialFiles(sprites, row).catch(() => undefined);
  await trace({
    userId: args.userId,
    responsibilityId: args.responsibilityId,
    kind: "computer.acquired",
    detail: {
      text: env.generation > 0 ? `Started a computer with your tools (v${env.generation})` : "Started a computer",
      computerId: row.id,
      pinnedGeneration: env.generation,
    },
  });
  return result({
    status: "succeeded",
    data: toLease({ ...row, lifecycle: "running" }, false),
    safeSummary:
      env.generation > 0
        ? `Started a computer with ${env.manifest.tools.length} of your tools`
        : "Started a computer",
    retry: "safe",
  });
}

function clampTimeout(ms: number | undefined): number {
  if (!Number.isFinite(ms ?? NaN)) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.floor(ms!)));
}

async function recordCommand(args: {
  computerId: string;
  userId: string;
  command: string;
  exitCode: number | null;
  stdout: string;
  safeOutput: string;
}): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `insert into computer_commands (computer_id, user_id, command, exit_code, stdout_digest, safe_output)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [
      args.computerId,
      args.userId,
      redactSecrets(args.command).slice(0, 4000),
      args.exitCode,
      createHash("sha256").update(args.stdout, "utf8").digest("hex"),
      redactSecrets(args.safeOutput).slice(0, 4000),
    ],
  );
  return rows[0].id;
}

type ExecOutcome =
  | { kind: "ran"; output: CommandOutput; commandId: string; truncated: boolean }
  | { kind: "error"; error: SpriteError }
  | { kind: "not_live" };

async function execOnLease(
  sprites: SpritesPort,
  lease: ComputerLease,
  command: string,
  timeoutMs: number,
  wrap: (c: string) => string = (c) => c,
): Promise<ExecOutcome> {
  const row = await loadOwned(lease);
  if (!row || (row.lifecycle !== "running" && row.lifecycle !== "dormant") || row.provider_ref !== lease.spriteName) {
    return { kind: "not_live" };
  }
  const { plan } = await loadInjection(row.user_id, row.pinned_generation);
  const req = buildExecRequest(command, plan, wrap);
  const r = await sprites.exec(row.provider_ref, {
    command: req.command,
    env: req.env,
    timeoutMs,
    maxOutputBytes: 256 * 1024,
  });
  if (!r.ok) {
    if (r.error.code === "not_found") await setLifecycle(row.id, "lost");
    return { kind: "error", error: r.error };
  }
  // Redact injected logins before bounding, so truncation can't split a value.
  const raw = redactOutput(r.value, plan.secrets);
  const output: CommandOutput = {
    exitCode: raw.exitCode,
    stdout: boundOutput(raw.stdout),
    stderr: boundOutput(raw.stderr),
  };
  const commandId = await recordCommand({
    computerId: row.id,
    userId: lease.userId,
    command: req.recorded,
    exitCode: raw.exitCode,
    stdout: raw.stdout,
    safeOutput: boundOutput(`${raw.stdout}\n${raw.stderr}`.trim(), 2000),
  });
  if (row.lifecycle !== "running") await setLifecycle(row.id, "running");
  return { kind: "ran", output, commandId, truncated: r.value.truncated };
}

/**
 * Runs a task-local shell command (bash -lc) with the pinned tools on PATH.
 * Output is bounded; every run is recorded in computer_commands and traced.
 * NOT for consequential external actions: use prepareComputerExternal.
 */
export async function runOnComputer(
  args: { lease: ComputerLease; command: string; timeoutMs?: number },
  deps: { sprites?: SpritesPort | null } = {},
): Promise<ToolResult<CommandOutput>> {
  const sprites = deps.sprites === undefined ? getSpritesProvider() : deps.sprites;
  if (!sprites) return blockedOrFailed("run the command", NOT_CONFIGURED);
  if (typeof args.command !== "string" || args.command.trim() === "" || args.command.length > 20_000) {
    return result({ status: "failed", safeSummary: "Command is empty or too long", retry: "never" });
  }
  const out = await execOnLease(sprites, args.lease, args.command, clampTimeout(args.timeoutMs));
  if (out.kind === "not_live") {
    return result({ status: "failed", safeSummary: "This computer is no longer available; acquire a new one", retry: "never" });
  }
  if (out.kind === "error") {
    if (out.error.code === "not_found") {
      return result({ status: "failed", safeSummary: "The computer was lost; acquire a new one (your tools are restored automatically)", retry: "safe" });
    }
    return blockedOrFailed("run the command", out.error);
  }
  const installed = out.output.exitCode === 0 ? detectLocalInstalls(args.command) : [];
  if (installed.length > 0) {
    await query(`update computer_commands set local_installs = $2 where id = $1`, [out.commandId, installed]);
  }
  await trace({
    userId: args.lease.userId,
    responsibilityId: args.lease.responsibilityId,
    kind: "computer.command",
    detail: {
      text: `Ran \`${safeCommandText(args.command)}\` on the computer (exit ${out.output.exitCode})`,
      computerId: args.lease.computerId,
      commandId: out.commandId,
      exitCode: out.output.exitCode,
    },
  });
  return result({
    status: out.output.exitCode === 0 ? "succeeded" : "failed",
    data: out.output,
    evidenceRefs: [],
    providerRequestId: out.commandId,
    safeSummary: `Command exited ${out.output.exitCode}${out.truncated ? " (output truncated)" : ""}`,
    retry: out.output.exitCode === 0 ? "safe" : "never",
  });
}

const MEDIA_TYPES: Record<string, string> = {
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".html": "text/html",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".zip": "application/zip",
  ".tgz": "application/gzip",
  ".gz": "application/gzip",
};

/** Copies a file off the Computer into object storage (verified) and records an artifact row. */
export async function publishArtifact(
  args: { lease: ComputerLease; path: string; filename?: string; mediaType?: string },
  deps: { sprites?: SpritesPort | null } = {},
): Promise<ToolResult<{ artifactId: string; storageKey: string; sha256: string; byteCount: number; filename: string }>> {
  const sprites = deps.sprites === undefined ? getSpritesProvider() : deps.sprites;
  if (!sprites) return blockedOrFailed("publish the file", NOT_CONFIGURED);
  const row = await loadOwned(args.lease);
  if (!row || (row.lifecycle !== "running" && row.lifecycle !== "dormant")) {
    return result({ status: "failed", safeSummary: "This computer is no longer available", retry: "never" });
  }
  if (!path.posix.isAbsolute(args.path) || args.path.includes("\0")) {
    return result({ status: "failed", safeSummary: "Path must be absolute", retry: "never" });
  }
  const read = await sprites.readFile(row.provider_ref, args.path, MAX_ARTIFACT_BYTES);
  if (!read.ok) {
    if (read.error.code === "not_found") {
      return result({ status: "failed", safeSummary: `No file at ${args.path}`, retry: "never" });
    }
    return blockedOrFailed("read the file", read.error);
  }
  const filename = (args.filename ?? path.posix.basename(args.path)).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128) || "file";
  const mediaType = args.mediaType ?? MEDIA_TYPES[path.posix.extname(filename).toLowerCase()] ?? "application/octet-stream";
  const digest = createHash("sha256").update(read.value).digest("hex");
  const key = `artifacts/${args.lease.userId}/${digest}/${filename}`;
  let stored;
  try {
    stored = await putObjectVerified({ key, bytes: read.value, contentType: mediaType, expectedSha256: digest });
  } catch (err) {
    return result({
      status: "uncertain",
      safeSummary: `Upload could not be verified: ${(err as Error).message.slice(0, 120)}`,
      retry: "unsafe_without_readback",
    });
  }
  const ins = await query<{ id: string }>(
    `insert into artifacts (user_id, responsibility_id, storage_key, filename, media_type, byte_count, sha256)
     values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [args.lease.userId, args.lease.responsibilityId, stored.key, filename, mediaType, stored.byteCount, stored.sha256],
  );
  const artifactId = ins.rows[0].id;
  const ev = await recordEvidence({
    userId: args.lease.userId,
    responsibilityId: args.lease.responsibilityId,
    provider: "computer",
    sourceRef: `artifact:${artifactId}`,
    safeSummary: `Saved ${filename} (${stored.byteCount} bytes) from the computer`,
    payload: { artifactId, sha256: stored.sha256, computerId: row.id },
  });
  return result({
    status: "succeeded",
    data: { artifactId, storageKey: stored.key, sha256: stored.sha256, byteCount: stored.byteCount, filename },
    evidenceRefs: [ev],
    safeSummary: `Saved ${filename} (${stored.byteCount} bytes)`,
    retry: "safe",
  });
}

/**
 * Copies a stored artifact (e.g. a browser download) onto the Computer at an
 * absolute path. Bytes are digest-verified out of object storage first; the
 * Sprite never holds storage credentials. Recorded like a command.
 */
export async function putArtifactOnComputer(
  args: { lease: ComputerLease; artifactId: string; path: string },
  deps: { sprites?: SpritesPort | null } = {},
): Promise<ToolResult<{ path: string; filename: string; sha256: string; byteCount: number }>> {
  const sprites = deps.sprites === undefined ? getSpritesProvider() : deps.sprites;
  if (!sprites) return blockedOrFailed("copy the file", NOT_CONFIGURED);
  if (!path.posix.isAbsolute(args.path) || args.path.includes("\0") || args.path.split("/").includes("..")) {
    return result({ status: "failed", safeSummary: "Path must be absolute (no ..)", retry: "never" });
  }
  const row = await loadOwned(args.lease);
  if (!row || (row.lifecycle !== "running" && row.lifecycle !== "dormant")) {
    return result({ status: "failed", safeSummary: "This computer is no longer available", retry: "never" });
  }
  let art;
  try {
    art = await loadArtifact(args.lease.userId, args.artifactId);
  } catch (err) {
    return result({ status: "failed", safeSummary: `Artifact failed verification: ${(err as Error).message.slice(0, 120)}`, retry: "never" });
  }
  if (!art) return result({ status: "failed", safeSummary: "Unknown artifact", retry: "never" });
  const dir = path.posix.dirname(args.path);
  if (dir !== "/") {
    const mk = await sprites.exec(row.provider_ref, { command: `mkdir -p ${shellQuote(dir)}`, timeoutMs: 30_000, maxOutputBytes: 4096 });
    if (!mk.ok) return blockedOrFailed("prepare the folder", mk.error);
  }
  const w = await sprites.writeFile(row.provider_ref, args.path, art.bytes, 0o644);
  if (!w.ok) return blockedOrFailed("copy the file", w.error);
  const commandId = await recordCommand({
    computerId: row.id,
    userId: args.lease.userId,
    command: `# put artifact ${art.artifactId} -> ${args.path}`,
    exitCode: 0,
    stdout: art.sha256,
    safeOutput: `wrote ${art.byteCount} bytes (sha256 ${art.sha256})`,
  });
  await trace({
    userId: args.lease.userId,
    responsibilityId: args.lease.responsibilityId,
    kind: "computer.command",
    detail: { text: `Copied ${art.filename} onto the computer`, computerId: row.id, commandId },
  });
  return result({
    status: "succeeded",
    data: { path: args.path, filename: art.filename, sha256: art.sha256, byteCount: art.byteCount },
    safeSummary: `Copied ${art.filename} (${art.byteCount} bytes) to ${args.path}`,
    retry: "safe",
  });
}

/**
 * Optionally checkpoints, then destroys the Sprite. Marked `released` only
 * after negative readback (provider says not found); otherwise `uncertain`.
 */
export async function releaseComputer(
  lease: ComputerLease,
  options: { checkpoint?: boolean } = {},
  deps: { sprites?: SpritesPort | null } = {},
): Promise<ToolResult<{ released: boolean; checkpointRef: string | null }>> {
  const sprites = deps.sprites === undefined ? getSpritesProvider() : deps.sprites;
  if (!sprites) return blockedOrFailed("release the computer", NOT_CONFIGURED);
  const row = await loadOwned(lease);
  if (!row) return result({ status: "failed", safeSummary: "Unknown computer", retry: "never" });
  if (row.lifecycle === "released") {
    return result({ status: "succeeded", data: { released: true, checkpointRef: null }, safeSummary: "Computer already released", retry: "safe" });
  }
  // Delete written login files first: a checkpoint or a failed destroy must not keep them.
  const written = Object.values(await readWrittenFiles(row.id)).map((w) => w.path);
  if (written.length > 0 && (await removeCredentialFiles(sprites, row.provider_ref, written))) {
    await query(`update computers set credential_files = '{}', updated_at = now() where id = $1`, [row.id]);
  }
  let checkpointRef: string | null = null;
  if (options.checkpoint) {
    const cp = await sprites.checkpoint(row.provider_ref, `august release ${row.id}`);
    if (cp.ok) {
      checkpointRef = cp.value.checkpointId;
      await query(`update computers set last_checkpoint_ref = $2, updated_at = now() where id = $1`, [row.id, checkpointRef]);
    }
  }
  const d = await sprites.destroy(row.provider_ref);
  if (!d.ok) return blockedOrFailed("release the computer", d.error);
  const check = await sprites.inspect(row.provider_ref);
  if (!check.ok || check.value !== null) {
    return result({
      status: "uncertain",
      data: { released: false, checkpointRef },
      safeSummary: "Asked the provider to delete the computer but could not confirm it is gone",
      retry: "unsafe_without_readback",
    });
  }
  await setLifecycle(row.id, "released");
  await trace({
    userId: lease.userId,
    responsibilityId: lease.responsibilityId,
    kind: "computer.released",
    detail: { text: "Shut down the computer", computerId: row.id },
  });
  return result({ status: "succeeded", data: { released: true, checkpointRef }, safeSummary: "Computer released", retry: "safe" });
}

// ---------------------------------------------------------------------------
// Consequential external actions from a Computer

export type ComputerExternalArgs = {
  computerId: string;
  userId: string;
  spriteName: string;
  command: string;
  timeoutMs: number;
};

/**
 * Freezes an exact command that performs an external, consequential action
 * (e.g. `doordash order place --cart ...`). Material facts (price, merchant,
 * address...) must be observed by the caller right before proposing.
 */
export function prepareComputerExternal(args: {
  lease: ComputerLease;
  command: string;
  materialFacts: Record<string, unknown>;
  timeoutMs?: number;
}): EffectDraft {
  if (typeof args.command !== "string" || args.command.trim() === "" || args.command.length > 8_000) {
    throw new Error("computer_external command is empty or too long");
  }
  const frozen: ComputerExternalArgs = {
    computerId: args.lease.computerId,
    userId: args.lease.userId,
    spriteName: args.lease.spriteName,
    command: args.command,
    timeoutMs: clampTimeout(args.timeoutMs ?? 5 * 60_000),
  };
  return Object.freeze({
    provider: COMPUTER_PROVIDER,
    action: COMPUTER_EXTERNAL_ACTION,
    args: Object.freeze({ ...frozen }) as unknown as Record<string, unknown>,
    materialFacts: Object.freeze({ ...args.materialFacts, command: safeCommandText(args.command, 400) }),
  });
}

function parseExternalArgs(raw: Record<string, unknown>): ComputerExternalArgs | null {
  const a = raw as Partial<ComputerExternalArgs>;
  if (
    typeof a.computerId !== "string" ||
    typeof a.userId !== "string" ||
    typeof a.spriteName !== "string" ||
    typeof a.command !== "string" ||
    a.command.length === 0 ||
    typeof a.timeoutMs !== "number"
  ) {
    return null;
  }
  return { computerId: a.computerId, userId: a.userId, spriteName: a.spriteName, command: a.command, timeoutMs: a.timeoutMs };
}

/** Exit code the dispatch guard uses when this idempotency key already ran on the Computer. */
const ALREADY_DISPATCHED_EXIT = 197;

/**
 * Executes exactly the frozen command on exactly the frozen Computer. A
 * per-effect marker directory (atomic mkdir keyed by the idempotency key) makes
 * a duplicate dispatch on the same Computer refuse to run. Transport errors or
 * timeouts after send are `uncertain` and must be reconciled, never retried blindly.
 */
export async function runComputerExternalAuthorized(
  effect: AuthorizedEffect,
  deps: { sprites?: SpritesPort | null } = {},
): Promise<DispatchResult> {
  const none = { providerReceiptRef: null, providerRequestId: null, evidenceRefs: [] as string[] };
  if (effect.provider !== COMPUTER_PROVIDER || effect.action !== COMPUTER_EXTERNAL_ACTION) {
    return { outcome: "failed", ...none, safeSummary: "wrong effect type for computer_external" };
  }
  const args = parseExternalArgs(effect.canonicalArgs);
  if (!args || args.userId !== effect.userId) {
    return { outcome: "failed", ...none, safeSummary: "invalid computer_external arguments" };
  }
  const sprites = deps.sprites === undefined ? getSpritesProvider() : deps.sprites;
  if (!sprites) return { outcome: "failed", ...none, safeSummary: `computer unavailable (${NOT_CONFIGURED.code})` };

  const lease: ComputerLease = {
    computerId: args.computerId,
    userId: args.userId,
    responsibilityId: effect.responsibilityId,
    workerSessionId: null,
    spriteName: args.spriteName,
    pinnedGeneration: -1,
    reused: true,
  };
  const marker = `/tmp/august-effects/${effect.idempotencyKey.replace(/[^A-Za-z0-9]/g, "").slice(0, 64)}`;
  const guard = (c: string) =>
    `mkdir -p /tmp/august-effects && mkdir ${shellQuote(marker)} 2>/dev/null || exit ${ALREADY_DISPATCHED_EXIT}\n${c}`;
  const out = await execOnLease(sprites, lease, args.command, clampTimeout(args.timeoutMs), guard);

  if (out.kind === "not_live") {
    return { outcome: "failed", ...none, safeSummary: "the computer for this action is no longer available; nothing was run" };
  }
  if (out.kind === "error") {
    const e = out.error;
    const definitelyNotSent =
      e.code === "not_found" || e.code === "unauthorized" || e.code === "provider_billing_restricted" || e.code === "not_configured";
    return {
      outcome: definitelyNotSent ? "failed" : "uncertain",
      ...none,
      safeSummary: definitelyNotSent
        ? `command was not run (${e.code})`
        : `command may have run; outcome unknown (${e.code})`,
    };
  }
  if (out.output.exitCode === ALREADY_DISPATCHED_EXIT && out.output.stdout === "" && out.output.stderr === "") {
    return {
      outcome: "uncertain",
      providerReceiptRef: `computer_command:${out.commandId}`,
      providerRequestId: out.commandId,
      evidenceRefs: [],
      safeSummary: "this action was already dispatched on this computer; reconcile instead of re-running",
    };
  }
  const ev = await recordEvidence({
    userId: effect.userId,
    responsibilityId: effect.responsibilityId,
    provider: "computer",
    sourceRef: `computer_command:${out.commandId}`,
    safeSummary: `Ran approved command (exit ${out.output.exitCode}): ${safeCommandText(args.command)}`,
    payload: { exitCode: out.output.exitCode, stdout: out.output.stdout.slice(0, 4000), stderr: out.output.stderr.slice(0, 2000) },
  });
  await trace({
    userId: effect.userId,
    responsibilityId: effect.responsibilityId,
    kind: "computer.command",
    detail: {
      text: `Ran the approved command on the computer (exit ${out.output.exitCode})`,
      computerId: args.computerId,
      commandId: out.commandId,
      effectId: effect.id,
    },
  });
  // A non-zero exit does not prove the external side effect did not happen
  // (a CLI can fail after the order was placed), so it is reconciled, not retried.
  return {
    outcome: out.output.exitCode === 0 ? "succeeded" : "uncertain",
    providerReceiptRef: `computer_command:${out.commandId}`,
    providerRequestId: out.commandId,
    evidenceRefs: [ev],
    safeSummary:
      out.output.exitCode === 0
        ? `Approved command succeeded`
        : `Approved command exited ${out.output.exitCode}; check whether it took effect before retrying`,
  };
}
