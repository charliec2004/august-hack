import "server-only";

import { APIError, FilesystemError, SpritesClient, type Sprite } from "@fly/sprites";

import {
  lifecycleFromSpriteStatus,
  type ComputerLifecycle,
} from "../computers/types";

/**
 * Thin Fly Sprites provider port (DECISIONS D1), built on the official
 * `@fly/sprites` SDK (REST https://api.sprites.dev + WebSocket exec).
 *
 * - Never throws: every call returns a ProviderResult with a stable error code.
 * - Provider handles (Sprite names, URLs) stay inside the server; the token is
 *   read from SPRITES_TOKEN and never logged or passed into a Sprite.
 * - exec is WebSocket-streamed by the SDK; this port collects it into one
 *   blocking, bounded result with a hard timeout.
 */

export type SpriteErrorCode =
  | "provider_billing_restricted"
  | "not_found"
  | "already_exists"
  | "unauthorized"
  | "rate_limited"
  | "timeout"
  | "not_configured"
  | "provider_error";

export type SpriteError = { code: SpriteErrorCode; status?: number; message: string };

export type ProviderResult<T> = { ok: true; value: T } | { ok: false; error: SpriteError };

export type SpriteInfo = {
  name: string;
  id: string | null;
  status: string;
  lifecycle: ComputerLifecycle;
};

export type SpriteExecInput = {
  command: string;
  timeoutMs: number;
  cwd?: string;
  env?: Record<string, string>;
  /** Max bytes retained per stream; extra output is counted and dropped. */
  maxOutputBytes?: number;
};

export type SpriteExecOutput = {
  exitCode: number;
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  truncated: boolean;
  durationMs: number;
};

export type SpritesPort = {
  list(prefix?: string): Promise<ProviderResult<SpriteInfo[]>>;
  create(name: string): Promise<ProviderResult<SpriteInfo>>;
  /** `value: null` = provider says not found (positive absence evidence). */
  inspect(name: string): Promise<ProviderResult<SpriteInfo | null>>;
  exec(name: string, input: SpriteExecInput): Promise<ProviderResult<SpriteExecOutput>>;
  checkpoint(name: string, comment: string): Promise<ProviderResult<{ checkpointId: string }>>;
  restore(name: string, checkpointId: string): Promise<ProviderResult<null>>;
  /** Already-absent is success with `alreadyAbsent: true`. */
  destroy(name: string): Promise<ProviderResult<{ alreadyAbsent: boolean }>>;
  writeFile(name: string, path: string, bytes: Buffer, mode?: number): Promise<ProviderResult<null>>;
  readFile(name: string, path: string, maxBytes: number): Promise<ProviderResult<Buffer>>;
};

const BILLING_RESTRICTED = /account is restricted|contact billing@fly\.io/i;

/** Maps any SDK/transport failure to a stable code without leaking secrets. */
export function classifySpriteError(err: unknown): SpriteError {
  const message = (err instanceof Error ? err.message : String(err)).slice(0, 300);
  const status =
    err instanceof APIError
      ? err.statusCode
      : Number(/status (\d{3})/.exec(message)?.[1]) || undefined;
  if (BILLING_RESTRICTED.test(message)) {
    return { code: "provider_billing_restricted", status, message: "Fly Sprites account is restricted (billing)" };
  }
  if (err instanceof FilesystemError && err.code === "ENOENT") return { code: "not_found", status: 404, message };
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
    return { code: "timeout", status, message };
  }
  if (status === 404) return { code: "not_found", status, message };
  if (status === 409 || /already exists/i.test(message)) return { code: "already_exists", status, message };
  if (status === 401 || status === 403) return { code: "unauthorized", status, message };
  if (status === 429) return { code: "rate_limited", status, message };
  return { code: "provider_error", status, message };
}

function info(sprite: Pick<Sprite, "name" | "status"> & { id?: string }): SpriteInfo {
  const status = sprite.status ?? "unknown";
  return { name: sprite.name, id: sprite.id ?? null, status, lifecycle: lifecycleFromSpriteStatus(status) };
}

async function attempt<T>(fn: () => Promise<T>): Promise<ProviderResult<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    return { ok: false, error: classifySpriteError(err) };
  }
}

const SPRITE_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

function assertName(name: string): void {
  if (!SPRITE_NAME.test(name)) throw new Error("invalid sprite name");
}

/** Drains a checkpoint/restore NDJSON stream; throws on an `error` event. */
async function drainStream(stream: AsyncIterable<{ type: string; data?: string; error?: string }>): Promise<string> {
  let last = "";
  for await (const msg of stream) {
    if (msg.type === "error") throw new Error(msg.error ?? "stream error");
    if (msg.data) last = msg.data;
  }
  return last;
}

export function createSpritesProvider(token: string, options?: { baseURL?: string }): SpritesPort {
  const client = new SpritesClient(token, { baseURL: options?.baseURL, timeout: 60_000 });

  return {
    list: (prefix) =>
      attempt(async () => (await client.listSprites({ prefix, maxResults: 100 })).sprites.map(info)),

    create: (name) =>
      attempt(async () => {
        assertName(name);
        return info(await client.createSprite(name));
      }),

    inspect: async (name) => {
      const r = await attempt(async () => info(await client.getSprite(name)));
      if (!r.ok && r.error.code === "not_found") return { ok: true, value: null };
      return r;
    },

    exec: (name, input) =>
      attempt(
        () =>
          new Promise<SpriteExecOutput>((resolve, reject) => {
            const started = Date.now();
            const max = input.maxOutputBytes ?? 1024 * 1024;
            const out: Buffer[] = [];
            const err: Buffer[] = [];
            let outBytes = 0;
            let errBytes = 0;
            let outKept = 0;
            let errKept = 0;
            let settled = false;
            const cmd = client.sprite(name).spawn("bash", ["-lc", input.command], {
              cwd: input.cwd,
              env: input.env,
            });
            const finish = (fn: () => void) => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              fn();
            };
            const timer = setTimeout(() => {
              finish(() => {
                try {
                  cmd.kill();
                  cmd.close();
                } catch {
                  // best effort
                }
                const e = new Error(`exec timed out after ${input.timeoutMs}ms`);
                e.name = "TimeoutError";
                reject(e);
              });
            }, input.timeoutMs);
            cmd.stdout.on("data", (chunk: Buffer) => {
              outBytes += chunk.length;
              if (outKept < max) {
                const slice = chunk.subarray(0, max - outKept);
                out.push(slice);
                outKept += slice.length;
              }
            });
            cmd.stderr.on("data", (chunk: Buffer) => {
              errBytes += chunk.length;
              if (errKept < max) {
                const slice = chunk.subarray(0, max - errKept);
                err.push(slice);
                errKept += slice.length;
              }
            });
            cmd.on("exit", (code: number) =>
              finish(() => {
                cmd.close();
                resolve({
                  exitCode: typeof code === "number" ? code : -1,
                  stdout: Buffer.concat(out).toString("utf8"),
                  stderr: Buffer.concat(err).toString("utf8"),
                  stdoutBytes: outBytes,
                  stderrBytes: errBytes,
                  truncated: outBytes > outKept || errBytes > errKept,
                  durationMs: Date.now() - started,
                });
              }),
            );
            cmd.on("error", (e: unknown) => finish(() => reject(e)));
          }),
      ),

    checkpoint: (name, comment) =>
      attempt(async () => {
        const sprite = client.sprite(name);
        const last = await drainStream(await sprite.createCheckpoint(comment));
        const fromMessage = /\b(v\d+)\b/.exec(last)?.[1];
        if (fromMessage) return { checkpointId: fromMessage };
        const list = await sprite.listCheckpoints();
        const newest = list
          .filter((c) => c.id !== "Current")
          .sort((a, b) => b.createTime.getTime() - a.createTime.getTime())[0];
        if (!newest) throw new Error("checkpoint id not found after create");
        return { checkpointId: newest.id };
      }),

    restore: (name, checkpointId) =>
      attempt(async () => {
        await drainStream(await client.sprite(name).restoreCheckpoint(checkpointId));
        return null;
      }),

    destroy: async (name) => {
      const r = await attempt(async () => {
        await client.deleteSprite(name);
        return { alreadyAbsent: false };
      });
      if (!r.ok && r.error.code === "not_found") return { ok: true, value: { alreadyAbsent: true } };
      return r;
    },

    writeFile: (name, path, bytes, mode) =>
      attempt(async () => {
        await client.sprite(name).filesystem("/").writeFile(path, bytes, mode === undefined ? undefined : { mode });
        return null;
      }),

    readFile: (name, path, maxBytes) =>
      attempt(async () => {
        const bytes = await client.sprite(name).filesystem("/").readFile(path, null);
        if (bytes.length > maxBytes) throw new Error(`file exceeds ${maxBytes} bytes`);
        return bytes;
      }),
  };
}

declare global {
  var __augustSprites: SpritesPort | undefined;
}

let override: SpritesPort | null = null;

/** Test seam: inject a fake provider. Pass null to restore the real one. */
export function setSpritesProviderForTesting(port: SpritesPort | null): void {
  override = port;
}

/** The process-wide provider, configured from SPRITES_TOKEN. Null if unset. */
export function getSpritesProvider(): SpritesPort | null {
  if (override) return override;
  if (!globalThis.__augustSprites) {
    const token = process.env.SPRITES_TOKEN;
    if (!token) return null;
    globalThis.__augustSprites = createSpritesProvider(token, {
      baseURL: process.env.SPRITES_API_URL || undefined,
    });
  }
  return globalThis.__augustSprites;
}

export const NOT_CONFIGURED: SpriteError = {
  code: "not_configured",
  message: "SPRITES_TOKEN is not set",
};
