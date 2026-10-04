/**
 * CLI login injection end to end against the Neon `test` branch with a fake
 * Sprites provider: file logins are written 0600 at acquire and deleted before
 * destroy; env logins ride in the exec env; output and stored commands are
 * redacted. Skipped when TEST_DATABASE_URL is absent.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { SpriteExecInput, SpritesPort } from "@/server/providers/sprites";

const enabled = Boolean(process.env.TEST_DATABASE_URL);
const d = enabled ? describe : describe.skip;

d("tool login injection (real Postgres, fake Sprites)", async () => {
  const { query, getPool } = await import("@/server/db/client");
  const { ensureUser } = await import("@/server/auth/currentUser");
  const { canonicalManifest, manifestSha256 } = await import("@/server/computers/types");
  const { acquireComputer, releaseComputer, runOnComputer } = await import("@/server/computers/runtime");
  const { putToolCredential, listToolCredentials } = await import("@/server/credentials/store");

  const ENV_SECRET = "ntn_envsecret_7f3a9c";
  const FILE_SECRET = "dd_filesecret_22b81e";
  const calls: { op: string; input?: SpriteExecInput; path?: string; mode?: number; body?: string }[] = [];
  let alive = false;

  const fake: SpritesPort = {
    list: async () => ({ ok: true, value: [] }),
    create: async (name) => {
      alive = true;
      return { ok: true, value: { name, id: null, status: "running", lifecycle: "running" } };
    },
    inspect: async (name) => ({
      ok: true,
      value: alive ? { name, id: null, status: "running", lifecycle: "running" } : null,
    }),
    exec: async (_name, input) => {
      calls.push({ op: "exec", input });
      if (input.command.includes(`printf '%s' "$HOME"`)) {
        return { ok: true, value: { exitCode: 0, stdout: "/home/sprite", stderr: "", stdoutBytes: 12, stderrBytes: 0, truncated: false, durationMs: 1 } };
      }
      const leaked = `${input.env?.NOTION_TOKEN ?? ""} ${Buffer.from(input.env?.NOTION_TOKEN ?? "").toString("base64")}`;
      return { ok: true, value: { exitCode: 0, stdout: `token: ${leaked}`, stderr: "", stdoutBytes: 1, stderrBytes: 0, truncated: false, durationMs: 1 } };
    },
    checkpoint: async () => ({ ok: true, value: { checkpointId: "v1" } }),
    restore: async () => ({ ok: true, value: null }),
    destroy: async () => {
      calls.push({ op: "destroy" });
      alive = false;
      return { ok: true, value: { alreadyAbsent: false } };
    },
    writeFile: async (_name, path, bytes, mode) => {
      calls.push({ op: "writeFile", path, mode, body: bytes.toString("utf8") });
      return { ok: true, value: null };
    },
    readFile: async () => ({ ok: false, error: { code: "not_found", message: "nope" } }),
  };

  let userId = "";

  beforeAll(async () => {
    process.env.CREDENTIALS_KEY = randomBytes(32).toString("base64");
    userId = (await ensureUser(`tool-auth-${randomUUID()}`)).id;
    const manifest = canonicalManifest({
      tools: [
        { toolKey: "notion", packageName: "notion-cli", packageVersion: "1.0.0", auth: { kind: "env", vars: ["NOTION_TOKEN"] } },
        { toolKey: "doordash", packageName: "-", packageVersion: "0.4.1", setup: "true", auth: { kind: "file", path: ".config/doordash/auth.json" } },
      ],
    });
    await query(
      `insert into user_environments (user_id, generation, manifest, manifest_sha256, status) values ($1, 1, $2, $3, 'published')`,
      [userId, JSON.stringify(manifest), manifestSha256(manifest)],
    );
    await query(
      `insert into user_environment_states (user_id, active_generation, next_generation, activation_revision) values ($1, 1, 2, 1)`,
      [userId],
    );
    await putToolCredential(userId, "notion", { env: { NOTION_TOKEN: ENV_SECRET } });
    await putToolCredential(userId, "doordash", { file: `{"token":"${FILE_SECRET}"}` });
  });

  afterAll(async () => {
    await getPool().end();
  });

  it("stores ciphertext only and lists without values", async () => {
    const { rows } = await query<{ ciphertext: Buffer }>(`select ciphertext from tool_credentials where user_id = $1`, [userId]);
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r.ciphertext.toString("utf8")).not.toMatch(/envsecret|filesecret/);
    expect(JSON.stringify(await listToolCredentials(userId))).not.toMatch(/envsecret|filesecret/);
  });

  it("injects, redacts, and cleans up", async () => {
    const lease = await acquireComputer({ userId, responsibilityId: null, workerSessionId: null }, { sprites: fake });
    expect(lease.status).toBe("succeeded");
    const write = calls.find((c) => c.op === "writeFile");
    expect(write).toMatchObject({ path: "/home/sprite/.config/doordash/auth.json", mode: 0o600 });
    expect(write?.body).toContain(FILE_SECRET);

    const run = await runOnComputer({ lease: lease.data!, command: "notion whoami" }, { sprites: fake });
    const exec = calls.filter((c) => c.op === "exec").pop()!;
    expect(exec.input?.env).toEqual({ NOTION_TOKEN: ENV_SECRET });
    expect(exec.input?.command).not.toContain(ENV_SECRET);
    expect(JSON.stringify(run)).not.toContain(ENV_SECRET);
    expect(JSON.stringify(run)).not.toContain(Buffer.from(ENV_SECRET).toString("base64").replace(/=+$/, ""));

    const { rows } = await query<{ command: string; safe_output: string }>(
      `select command, safe_output from computer_commands where user_id = $1`,
      [userId],
    );
    expect(JSON.stringify(rows)).not.toMatch(/envsecret|filesecret/);

    calls.length = 0;
    const rel = await releaseComputer(lease.data!, {}, { sprites: fake });
    expect(rel.status).toBe("succeeded");
    const rmIdx = calls.findIndex((c) => c.op === "exec" && c.input!.command.startsWith("rm -f") && c.input!.command.includes(".config/doordash/auth.json"));
    const destroyIdx = calls.findIndex((c) => c.op === "destroy");
    expect(rmIdx).toBeGreaterThanOrEqual(0);
    expect(rmIdx).toBeLessThan(destroyIdx);
  });
});
