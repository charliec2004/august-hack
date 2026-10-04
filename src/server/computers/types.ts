/**
 * Computers subsystem contracts (DECISIONS D1). Pure types and functions only:
 * no I/O, no `server-only`, so they are unit-testable and safe to share.
 *
 * Ported invariants from the main August repo ("persistent user state follows
 * the user; compute follows the session"):
 * - The User Environment manifest is canonical in Postgres; the installed-tool
 *   bundle lives in object storage; a Computer only holds a restored copy.
 * - Generations are immutable. Activation is a compare-and-swap on
 *   (active_generation, activation_revision). Generation 0 is the empty baseline.
 * - A Computer pins one generation at acquisition.
 * - Losing a Computer never loses canonical state.
 * - Changing the environment is a consequential effect (exact-effect rail).
 */

import { createHash } from "node:crypto";

import { canonicalJson } from "../effects/canonicalize";

// ---------------------------------------------------------------------------
// Lifecycle

export type ComputerLifecycle = "provisioning" | "running" | "dormant" | "released" | "lost";

export const LIVE_LIFECYCLES: readonly ComputerLifecycle[] = ["provisioning", "running", "dormant"];

/**
 * The one projection of a Sprites API status onto August's lifecycle.
 * `null` means the provider answered "not found" (404): the Sprite is gone.
 * Documented statuses: cold (hibernated, wakes on demand), warm, running.
 * Anything else is a provider contract change, reported as `lost` so repair
 * reconciles the exact Sprite instead of guessing.
 */
export function lifecycleFromSpriteStatus(status: string | null): ComputerLifecycle {
  if (status === null) return "released";
  switch (status) {
    case "running":
    case "warm":
      return "running";
    case "cold":
      return "dormant";
    default:
      return "lost";
  }
}

/**
 * Reconciles our durable lifecycle with what the provider reports. A Sprite we
 * believe is live but the provider cannot find was LOST (not released: only
 * our own destroy + negative readback releases a Computer).
 */
export function reconcileLifecycle(
  recorded: ComputerLifecycle,
  providerStatus: string | null,
): ComputerLifecycle {
  if (recorded === "released") return "released";
  if (providerStatus === null) return "lost";
  return lifecycleFromSpriteStatus(providerStatus);
}

// ---------------------------------------------------------------------------
// User Environment manifest

export const MANIFEST_FORMAT = "user-environment-manifest:v1" as const;
export const CHANGE_FORMAT = "user-environment-change:v1" as const;
export const BUNDLE_FORMAT = "npm-prefix-tgz:v1" as const;

/** Where a restored bundle lives on every Computer; `${ENV_PREFIX}/bin` joins PATH. */
export const ENV_PREFIX = "/opt/august-env";

export const ENVIRONMENT_LIMITS = Object.freeze({
  tools: 64,
  setupCommandChars: 2000,
  bundleCompressedBytes: 256 * 1024 * 1024,
});

const TOOL_KEY = /^[a-z0-9][a-z0-9._+-]{0,63}$/;
const PACKAGE = /^(?:@[a-z0-9][a-z0-9._-]{0,63}\/)?[a-z0-9][a-z0-9._-]{0,127}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]{1,64})?(?:\+[0-9A-Za-z.-]{1,64})?$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;

/**
 * One user-selected tool. npm tools install `packageName@packageVersion` with
 * scripts disabled. A non-npm tool (e.g. a CLI binary download) sets
 * `packageName` to "-" and supplies `setup`, a shell command run in the builder
 * with $AUGUST_ENV_PREFIX set; it must place executables in $AUGUST_ENV_PREFIX/bin.
 */
export type UserEnvironmentTool = {
  toolKey: string;
  packageName: string;
  packageVersion: string;
  setup?: string;
};

export type UserEnvironmentManifest = {
  format: typeof MANIFEST_FORMAT;
  tools: UserEnvironmentTool[];
};

export const NON_NPM_PACKAGE = "-";

export class EnvironmentError extends Error {
  constructor(readonly code: string, message?: string) {
    super(message ?? code);
    this.name = "EnvironmentError";
  }
}

export function assertTool(tool: UserEnvironmentTool): void {
  if (!tool || typeof tool !== "object") throw new EnvironmentError("tool_invalid");
  if (!TOOL_KEY.test(tool.toolKey)) throw new EnvironmentError("tool_key_invalid");
  if (!VERSION.test(tool.packageVersion)) throw new EnvironmentError("tool_version_invalid");
  if (tool.packageName === NON_NPM_PACKAGE) {
    if (typeof tool.setup !== "string" || tool.setup.trim().length === 0) {
      throw new EnvironmentError("tool_setup_required", "non-npm tools need a setup command");
    }
  } else if (!PACKAGE.test(tool.packageName)) {
    throw new EnvironmentError("tool_package_invalid");
  }
  if (tool.setup !== undefined) {
    if (typeof tool.setup !== "string" || tool.setup.length > ENVIRONMENT_LIMITS.setupCommandChars) {
      throw new EnvironmentError("tool_setup_invalid");
    }
    if (tool.setup.includes("\0")) throw new EnvironmentError("tool_setup_invalid");
  }
}

function normalizeTool(tool: UserEnvironmentTool): UserEnvironmentTool {
  assertTool(tool);
  const out: UserEnvironmentTool = {
    toolKey: tool.toolKey,
    packageName: tool.packageName,
    packageVersion: tool.packageVersion,
  };
  if (tool.setup !== undefined && tool.setup.trim().length > 0) out.setup = tool.setup;
  return out;
}

/**
 * Canonical manifest: known fields only, tools sorted by toolKey, toolKeys
 * unique. Throws on duplicates rather than silently picking one.
 */
export function canonicalManifest(input: {
  format?: string;
  tools: UserEnvironmentTool[];
}): UserEnvironmentManifest {
  if (input.format !== undefined && input.format !== MANIFEST_FORMAT) {
    throw new EnvironmentError("manifest_format_invalid");
  }
  if (!Array.isArray(input.tools)) throw new EnvironmentError("manifest_invalid");
  if (input.tools.length > ENVIRONMENT_LIMITS.tools) throw new EnvironmentError("manifest_too_many_tools");
  const tools = input.tools.map(normalizeTool);
  tools.sort((a, b) => (a.toolKey < b.toolKey ? -1 : a.toolKey > b.toolKey ? 1 : 0));
  for (let i = 1; i < tools.length; i++) {
    if (tools[i].toolKey === tools[i - 1].toolKey) {
      throw new EnvironmentError("manifest_duplicate_tool", `duplicate tool ${tools[i].toolKey}`);
    }
  }
  return { format: MANIFEST_FORMAT, tools };
}

export const EMPTY_MANIFEST: UserEnvironmentManifest = Object.freeze({
  format: MANIFEST_FORMAT,
  tools: [],
}) as UserEnvironmentManifest;

/** Hex sha256 of the canonical JSON of the canonical manifest. */
export function manifestSha256(manifest: UserEnvironmentManifest): string {
  return createHash("sha256")
    .update(canonicalJson(canonicalManifest(manifest)), "utf8")
    .digest("hex");
}

export type EnvironmentOperation = "install" | "remove" | "rollback";

/** Computes the next manifest for install/remove. Rollback uses a stored manifest instead. */
export function nextManifestFor(
  current: UserEnvironmentManifest,
  change:
    | { operation: "install"; tool: UserEnvironmentTool }
    | { operation: "remove"; removeToolKey: string },
): UserEnvironmentManifest {
  const base = canonicalManifest(current);
  if (change.operation === "install") {
    const tool = normalizeTool(change.tool);
    const existing = base.tools.find((t) => t.toolKey === tool.toolKey);
    if (existing && canonicalJson(existing) === canonicalJson(tool)) {
      throw new EnvironmentError("change_noop", `${tool.toolKey} is already installed at that version`);
    }
    return canonicalManifest({ tools: [...base.tools.filter((t) => t.toolKey !== tool.toolKey), tool] });
  }
  if (!TOOL_KEY.test(change.removeToolKey)) throw new EnvironmentError("tool_key_invalid");
  if (!base.tools.some((t) => t.toolKey === change.removeToolKey)) {
    throw new EnvironmentError("change_noop", `${change.removeToolKey} is not installed`);
  }
  return canonicalManifest({ tools: base.tools.filter((t) => t.toolKey !== change.removeToolKey) });
}

export function bundleObjectKey(userId: string, bundleSha256: string): string {
  if (!SHA256_HEX.test(bundleSha256)) throw new EnvironmentError("bundle_sha_invalid");
  if (!/^[A-Za-z0-9-]{1,64}$/.test(userId)) throw new EnvironmentError("user_id_invalid");
  return `user-environment/${userId}/${bundleSha256}.tgz`;
}

/** Frozen args of a `computer.user_environment_change` effect. */
export type EnvironmentChangeArgs = {
  format: typeof CHANGE_FORMAT;
  userId: string;
  operation: EnvironmentOperation;
  tool: UserEnvironmentTool | null;
  removeToolKey: string | null;
  rollbackGeneration: number | null;
  expectedGeneration: number;
  expectedActivationRevision: number;
  nextManifest: UserEnvironmentManifest;
  nextManifestSha256: string;
};

function isGeneration(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}

/** Strictly re-validates stored args before dispatch; throws EnvironmentError. */
export function parseEnvironmentChangeArgs(raw: Record<string, unknown>): EnvironmentChangeArgs {
  const a = raw as Partial<EnvironmentChangeArgs>;
  if (a.format !== CHANGE_FORMAT) throw new EnvironmentError("change_format_invalid");
  if (typeof a.userId !== "string" || a.userId.length === 0) throw new EnvironmentError("change_user_invalid");
  if (!isGeneration(a.expectedGeneration) || !isGeneration(a.expectedActivationRevision)) {
    throw new EnvironmentError("change_expected_invalid");
  }
  if (!a.nextManifest || typeof a.nextManifestSha256 !== "string") {
    throw new EnvironmentError("change_manifest_missing");
  }
  const nextManifest = canonicalManifest(a.nextManifest);
  if (manifestSha256(nextManifest) !== a.nextManifestSha256) {
    throw new EnvironmentError("change_manifest_sha_mismatch");
  }
  const op = a.operation;
  if (op === "install") {
    if (!a.tool || a.removeToolKey != null || a.rollbackGeneration != null) {
      throw new EnvironmentError("change_shape_invalid");
    }
    assertTool(a.tool);
  } else if (op === "remove") {
    if (a.tool != null || typeof a.removeToolKey !== "string" || a.rollbackGeneration != null) {
      throw new EnvironmentError("change_shape_invalid");
    }
  } else if (op === "rollback") {
    if (
      a.tool != null ||
      a.removeToolKey != null ||
      !isGeneration(a.rollbackGeneration) ||
      a.rollbackGeneration === a.expectedGeneration
    ) {
      throw new EnvironmentError("change_shape_invalid");
    }
  } else {
    throw new EnvironmentError("change_operation_invalid");
  }
  return {
    format: CHANGE_FORMAT,
    userId: a.userId,
    operation: op,
    tool: a.tool ?? null,
    removeToolKey: a.removeToolKey ?? null,
    rollbackGeneration: a.rollbackGeneration ?? null,
    expectedGeneration: a.expectedGeneration,
    expectedActivationRevision: a.expectedActivationRevision,
    nextManifest,
    nextManifestSha256: a.nextManifestSha256,
  };
}

// ---------------------------------------------------------------------------
// Compare-and-swap activation (pure decision; SQL lives in environment.ts)

export type EnvironmentHead = {
  activeGeneration: number;
  activationRevision: number;
};

export type CasDecision =
  | { ok: true; next: EnvironmentHead }
  | { ok: false; reason: "conflict"; observed: EnvironmentHead };

/**
 * Activation succeeds only if the head still equals what the approved change
 * observed. The revision always advances, so a rollback to an older generation
 * can never be confused with "nothing changed" (no ABA).
 */
export function decideActivation(
  observed: EnvironmentHead,
  expected: EnvironmentHead,
  targetGeneration: number,
): CasDecision {
  if (
    observed.activeGeneration !== expected.activeGeneration ||
    observed.activationRevision !== expected.activationRevision
  ) {
    return { ok: false, reason: "conflict", observed };
  }
  return {
    ok: true,
    next: { activeGeneration: targetGeneration, activationRevision: observed.activationRevision + 1 },
  };
}

// ---------------------------------------------------------------------------
// Computers

export type ComputerLease = {
  computerId: string;
  userId: string;
  responsibilityId: string | null;
  workerSessionId: string | null;
  /** Provider handle; never shown to the model. */
  spriteName: string;
  pinnedGeneration: number;
  reused: boolean;
};

export type CommandOutput = { exitCode: number; stdout: string; stderr: string };

/** Deterministic Sprite name for a session's Nth computer (names are org-unique). */
export function spriteNameForSession(scope: string, attempt: number): string {
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new Error("attempt must be >= 1");
  const digest = createHash("sha256").update(scope, "utf8").digest("hex").slice(0, 16);
  return `aug-c-${digest}-${attempt}`;
}

export function builderSpriteName(seed: string): string {
  return `aug-b-${createHash("sha256").update(seed, "utf8").digest("hex").slice(0, 20)}`;
}

export const OUTPUT_LIMIT_CHARS = 16_000;

/** Keeps the head and tail of long output, marking what was dropped. */
export function boundOutput(text: string, limit = OUTPUT_LIMIT_CHARS): string {
  if (text.length <= limit) return text;
  const head = Math.floor(limit * 0.25);
  const tail = limit - head;
  const dropped = text.length - head - tail;
  return `${text.slice(0, head)}\n...[${dropped} chars truncated]...\n${text.slice(-tail)}`;
}

const SECRET_PATTERNS: RegExp[] = [
  /\b(authorization:\s*(?:bearer|basic)\s+)\S+/gi,
  /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|APIKEY|ACCESS_KEY)[A-Z0-9_]*\s*=\s*)("[^"]*"|'[^']*'|\S+)/gi,
  /(--(?:token|password|secret|api-key)[= ]\s*)\S+/gi,
  /\b(sk|pk|rk|ghp|gho|xox[abp])[-_][A-Za-z0-9_-]{16,}\b/g,
  /\b[A-Za-z0-9_-]{40,}\b/g,
];

/** Best-effort redaction for text persisted/shown about commands. Not a security boundary. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (match, prefix: unknown) =>
      typeof prefix === "string" && match.startsWith(prefix) && prefix.length < match.length
        ? `${prefix}[redacted]`
        : "[redacted]",
    );
  }
  return out;
}

/** Short, user-safe description of a command for traces. */
export function safeCommandText(command: string, max = 120): string {
  const oneLine = redactSecrets(command).replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/** POSIX single-quote escaping for embedding a value in a shell command. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Builder script that materializes a manifest into an npm prefix bundle.
 * npm tools: one `npm install -g --prefix` with scripts disabled.
 * Non-npm tools: their `setup` command with $AUGUST_ENV_PREFIX exported.
 * Ends by writing the manifest marker, tarring the prefix, and printing the digest.
 */
export function buildBundleScript(manifest: UserEnvironmentManifest, outPath: string): string {
  const m = canonicalManifest(manifest);
  const npmSpecs = m.tools
    .filter((t) => t.packageName !== NON_NPM_PACKAGE)
    .map((t) => shellQuote(`${t.packageName}@${t.packageVersion}`));
  const lines = [
    "set -euo pipefail",
    `P=${shellQuote(ENV_PREFIX)}`,
    `OUT=${shellQuote(outPath)}`,
    'if [ -e "$P" ] && [ ! -w "$P" ]; then sudo rm -rf "$P"; fi',
    'rm -rf "$P" 2>/dev/null || sudo rm -rf "$P"',
    'mkdir -p "$P" 2>/dev/null || { sudo mkdir -p "$P" && sudo chown "$(id -u):$(id -g)" "$P"; }',
    'mkdir -p "$P/bin"',
    "export AUGUST_ENV_PREFIX=\"$P\"",
    'export PATH="$P/bin:$PATH"',
  ];
  if (npmSpecs.length > 0) {
    lines.push(
      `npm install -g --prefix "$P" --ignore-scripts --no-audit --no-fund --loglevel=error ${npmSpecs.join(" ")}`,
    );
  }
  for (const t of m.tools) {
    if (t.setup) {
      lines.push(`echo "[august] setup ${t.toolKey}" >&2`);
      lines.push(`( cd "$P" && bash -euo pipefail -c ${shellQuote(t.setup)} )`);
    }
  }
  lines.push(
    `printf '%s' ${shellQuote(canonicalJson(m))} > "$P/.august-manifest.json"`,
    'rm -f "$OUT"',
    'tar -C "$P" -czf "$OUT" .',
    'sha256sum "$OUT" | cut -d" " -f1',
  );
  return lines.join("\n");
}

/** Restore script run on a Computer after the verified bundle was written to `bundlePath`. */
export function restoreBundleScript(bundlePath: string, expectedManifestSha256: string): string {
  return [
    "set -euo pipefail",
    `P=${shellQuote(ENV_PREFIX)}`,
    `B=${shellQuote(bundlePath)}`,
    'rm -rf "$P" 2>/dev/null || sudo rm -rf "$P"',
    'mkdir -p "$P" 2>/dev/null || { sudo mkdir -p "$P" && sudo chown "$(id -u):$(id -g)" "$P"; }',
    'tar -C "$P" -xzf "$B" --no-same-owner',
    'rm -f "$B"',
    'mkdir -p "$P/bin"',
    `test "$(sha256sum < "$P/.august-manifest.json" | cut -d' ' -f1)" = ${shellQuote(expectedManifestSha256)}`,
    'grep -q "august-env" "$HOME/.bashrc" 2>/dev/null || echo \'export PATH="/opt/august-env/bin:$PATH" # august-env\' >> "$HOME/.bashrc"',
    "echo restored",
  ].join("\n");
}

/** Wraps a command so the pinned environment's bin is first on PATH. */
export function withEnvPath(command: string): string {
  return `export PATH=${shellQuote(`${ENV_PREFIX}/bin`)}:"$PATH"\n${command}`;
}
