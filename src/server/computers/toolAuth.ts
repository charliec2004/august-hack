/**
 * CLI login injection for Computers. Pure functions only (unit-tested).
 *
 * Invariants:
 * - Credentials are injected only for tools in the Computer's PINNED manifest,
 *   and only in the shape that manifest declares (declared env var names, the
 *   declared file path). A stored value can never choose its own target.
 * - Env logins travel in the exec request's env map, never inside the command
 *   string, so the command we record never contains a secret.
 * - Every injected value (and its base64 forms) is redacted from output before
 *   it reaches the model, a trace, or computer_commands.
 */

import { withEnvPath, type ToolAuth, type UserEnvironmentManifest } from "./types";

/** Decrypted credential material (server memory only). */
export type ToolCredentialMaterial = { kind: "env"; env: Record<string, string> } | { kind: "file"; file: string };

export type CredentialFile = { toolKey: string; path: string; content: string };

export type InjectionPlan = {
  env: Record<string, string>;
  files: CredentialFile[];
  /** Every secret value that must never appear in output. */
  secrets: string[];
};

export const EMPTY_PLAN: InjectionPlan = Object.freeze({ env: {}, files: [], secrets: [] }) as InjectionPlan;

/** Tools in a manifest that declare a login. */
export function toolsWithAuth(manifest: UserEnvironmentManifest): { toolKey: string; auth: ToolAuth }[] {
  return manifest.tools.flatMap((t) => (t.auth ? [{ toolKey: t.toolKey, auth: t.auth }] : []));
}

/**
 * Joins the pinned manifest's declarations with the user's stored credentials.
 * Mismatched kinds and undeclared variables are dropped.
 */
export function planInjection(
  manifest: UserEnvironmentManifest,
  credentials: ReadonlyMap<string, ToolCredentialMaterial>,
): InjectionPlan {
  const env: Record<string, string> = {};
  const files: CredentialFile[] = [];
  const secrets: string[] = [];
  for (const { toolKey, auth } of toolsWithAuth(manifest)) {
    const cred = credentials.get(toolKey);
    if (!cred || cred.kind !== auth.kind) continue;
    if (auth.kind === "env" && cred.kind === "env") {
      for (const name of auth.vars) {
        const value = cred.env[name];
        if (typeof value !== "string" || value === "") continue;
        env[name] = value;
        secrets.push(value);
      }
    } else if (auth.kind === "file" && cred.kind === "file" && cred.file !== "") {
      files.push({ toolKey, path: auth.path, content: cred.file });
      secrets.push(...fileSecrets(cred.file));
    }
  }
  return { env, files, secrets };
}

/**
 * Secrets inside a credentials file: the whole content plus each non-trivial
 * line and JSON string value, so `cat`/`jq` of the file is redacted too.
 */
function fileSecrets(content: string): string[] {
  const out = new Set<string>([content.trim()]);
  for (const line of content.split(/\r?\n/)) {
    const t = line.trim();
    if (t.length >= 8) out.add(t);
  }
  for (const m of content.matchAll(/"((?:[^"\\]|\\.){8,})"/g)) out.add(m[1]);
  for (const m of content.matchAll(/[=:]\s*['"]?([^\s'",}]{8,})/g)) out.add(m[1]);
  return [...out].filter((s) => s.length >= 8);
}

const MIN_SECRET_CHARS = 4;

function variantsOf(secret: string): string[] {
  const b64 = Buffer.from(secret, "utf8").toString("base64");
  const unpadded = b64.replace(/=+$/, "");
  const url = unpadded.replace(/\+/g, "-").replace(/\//g, "_");
  return [secret, b64, unpadded, url];
}

/**
 * Replaces every occurrence of each secret (and its base64/base64url
 * encodings) with "[redacted]". Longest first so overlapping secrets
 * never leave a partial value behind.
 */
export function redactValues(text: string, secrets: readonly string[]): string {
  if (!text || secrets.length === 0) return text;
  const needles = [...new Set(secrets.filter((s) => s.length >= MIN_SECRET_CHARS).flatMap(variantsOf))]
    .filter((s) => s.length >= MIN_SECRET_CHARS)
    .sort((a, b) => b.length - a.length);
  let out = text;
  for (const n of needles) out = out.split(n).join("[redacted]");
  return out;
}

/** What the model and storage may see about a command's result. */
export function redactOutput<T extends { stdout: string; stderr: string }>(output: T, secrets: readonly string[]): T {
  if (secrets.length === 0) return output;
  return { ...output, stdout: redactValues(output.stdout, secrets), stderr: redactValues(output.stderr, secrets) };
}

/**
 * The exact exec request for a command: the command string carries no secret
 * (logins ride in `env`), so `recorded` is safe to persist as-is after the
 * usual best-effort redaction.
 */
export function buildExecRequest(
  command: string,
  plan: InjectionPlan,
  wrap: (c: string) => string = (c) => c,
): { command: string; env: Record<string, string> | undefined; recorded: string } {
  return {
    command: wrap(withEnvPath(command)),
    env: Object.keys(plan.env).length > 0 ? { ...plan.env } : undefined,
    recorded: redactValues(command, plan.secrets),
  };
}
