import "server-only";

import { query } from "@/server/db/client";
import { getActiveEnvironment } from "@/server/computers/environment";
import type { ToolCredentialMaterial } from "@/server/computers/toolAuth";
import type { ToolAuth } from "@/server/computers/types";
import { openCredential, parseCredentialsKey, sealCredential } from "./crypto";

/**
 * The user's CLI logins (User Auth State, hackathon cut): one encrypted
 * envelope per tool. Values go in through PUT and come out only as decrypted
 * material for injection into the user's own Computers. No API returns them.
 */

export type ToolCredentialInfo = { toolKey: string; kind: "env" | "file"; updatedAt: string };

export class CredentialInputError extends Error {}

const MAX_ENV_VALUE = 8 * 1024;
const MAX_FILE = 64 * 1024;

function key(): Buffer {
  return parseCredentialsKey(process.env.CREDENTIALS_KEY);
}

type Row = {
  tool_key: string;
  kind: "env" | "file";
  ciphertext: Buffer;
  iv: Buffer;
  auth_tag: Buffer;
  key_version: number;
  updated_at: Date;
};

export async function listToolCredentials(userId: string): Promise<ToolCredentialInfo[]> {
  const { rows } = await query<Pick<Row, "tool_key" | "kind" | "updated_at">>(
    `select tool_key, kind, updated_at from tool_credentials where user_id = $1 order by tool_key`,
    [userId],
  );
  return rows.map((r) => ({ toolKey: r.tool_key, kind: r.kind, updatedAt: r.updated_at.toISOString() }));
}

/** Validates a PUT body against the tool's declared login; returns the material. */
export function credentialFromInput(auth: ToolAuth, body: unknown): ToolCredentialMaterial {
  const b = (body ?? {}) as { env?: unknown; file?: unknown };
  if (auth.kind === "env") {
    if (!b.env || typeof b.env !== "object" || Array.isArray(b.env)) {
      throw new CredentialInputError(`Provide ${auth.vars.join(", ")}.`);
    }
    const env: Record<string, string> = {};
    for (const name of auth.vars) {
      const v = (b.env as Record<string, unknown>)[name];
      if (typeof v !== "string" || v.trim() === "") throw new CredentialInputError(`${name} is required.`);
      if (v.length > MAX_ENV_VALUE || /[\0\r\n]/.test(v)) throw new CredentialInputError(`${name} is not a valid value.`);
      env[name] = v.trim();
    }
    return { kind: "env", env };
  }
  if (typeof b.file !== "string" || b.file.trim() === "") throw new CredentialInputError("Paste the credentials file.");
  if (b.file.length > MAX_FILE || b.file.includes("\0")) throw new CredentialInputError("That file is too large.");
  return { kind: "file", file: b.file };
}

/** The login a tool in the user's ACTIVE environment declares, or null. */
export async function declaredAuth(userId: string, toolKey: string): Promise<ToolAuth | null> {
  const env = await getActiveEnvironment(userId);
  return env.manifest.tools.find((t) => t.toolKey === toolKey)?.auth ?? null;
}

export async function putToolCredential(userId: string, toolKey: string, body: unknown): Promise<ToolCredentialInfo> {
  const auth = await declaredAuth(userId, toolKey);
  if (!auth) throw new CredentialInputError("That tool doesn't use a login.");
  const material = credentialFromInput(auth, body);
  const plaintext = JSON.stringify(material);
  const sealed = sealCredential(key(), { userId, toolKey, kind: material.kind }, plaintext);
  const { rows } = await query<{ updated_at: Date }>(
    `insert into tool_credentials (user_id, tool_key, kind, ciphertext, iv, auth_tag, key_version)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (user_id, tool_key) do update
       set kind = excluded.kind, ciphertext = excluded.ciphertext, iv = excluded.iv,
           auth_tag = excluded.auth_tag, key_version = excluded.key_version, updated_at = now()
     returning updated_at`,
    [userId, toolKey, material.kind, sealed.ciphertext, sealed.iv, sealed.authTag, sealed.keyVersion],
  );
  return { toolKey, kind: material.kind, updatedAt: rows[0].updated_at.toISOString() };
}

export async function deleteToolCredential(userId: string, toolKey: string): Promise<boolean> {
  const r = await query(`delete from tool_credentials where user_id = $1 and tool_key = $2`, [userId, toolKey]);
  return (r.rowCount ?? 0) > 0;
}

export type LoadedCredential = { material: ToolCredentialMaterial; updatedAt: string };

/**
 * Decrypts the user's credentials for these tools. A row that fails to decrypt
 * (tampered, wrong key) is skipped: the tool simply runs without its login.
 */
export async function loadToolCredentials(userId: string, toolKeys: string[]): Promise<Map<string, LoadedCredential>> {
  const out = new Map<string, LoadedCredential>();
  if (toolKeys.length === 0) return out;
  const { rows } = await query<Row>(
    `select tool_key, kind, ciphertext, iv, auth_tag, key_version, updated_at
       from tool_credentials where user_id = $1 and tool_key = any($2::text[])`,
    [userId, toolKeys],
  );
  if (rows.length === 0) return out;
  const k = key();
  for (const r of rows) {
    try {
      const plaintext = openCredential(
        k,
        { userId, toolKey: r.tool_key, kind: r.kind },
        { ciphertext: r.ciphertext, iv: r.iv, authTag: r.auth_tag, keyVersion: r.key_version },
      );
      const material = JSON.parse(plaintext) as ToolCredentialMaterial;
      if (material.kind !== r.kind) continue;
      out.set(r.tool_key, { material, updatedAt: r.updated_at.toISOString() });
    } catch {
      console.error(`[credentials] could not open credential for tool ${r.tool_key}`);
    }
  }
  return out;
}
