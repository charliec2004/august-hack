import "server-only";

import { query } from "@/server/db/client";
import { isKernelNotFound, kernel, kernelVaultName } from "@/server/providers/kernelClient";
import { normalizeLoginOrigin } from "./origin";

/**
 * The user's vault of website logins (like a password manager).
 *
 * Where secrets live: the username/password go from the POST /api/vault request
 * straight into a Kernel vault credential item (`kernel.vaults.items.upsert`,
 * provider "kernel"; the password field is `sensitive`, encrypted by Kernel and
 * never returned by any Kernel API). August's database stores only the opaque
 * item key, a label, and the exact HTTPS origins the login is bound to. Nothing
 * here logs, returns, or persists a secret.
 *
 * Use: `vaultSignIn` (browser/runBrowser.ts) asks Kernel to fill the fields in
 * August's live browser (`vaults.items.performOperation({ type: "fill" })`),
 * after verifying the page's exact origin is one this login is bound to.
 */

export type VaultLogin = {
  id: string;
  label: string;
  origins: string[];
  status: "pending" | "ready" | "failed";
  lastUsedAt: string | null;
  createdAt: string;
};

type Row = {
  id: string;
  label: string;
  login_origins: string[];
  login_url: string | null;
  kernel_vault: string;
  kernel_item_key: string;
  status: VaultLogin["status"];
  last_used_at: Date | null;
  created_at: Date;
};

const toView = (r: Row): VaultLogin => ({
  id: r.id,
  label: r.label,
  origins: r.login_origins,
  status: r.status,
  lastUsedAt: r.last_used_at?.toISOString() ?? null,
  createdAt: r.created_at.toISOString(),
});

export class VaultInputError extends Error {}

let vaultReady: Promise<void> | null = null;
function ensureVault(): Promise<void> {
  vaultReady ??= kernel()
    .vaults.upsert({ name: kernelVaultName() })
    .then(() => undefined)
    .catch((err) => {
      vaultReady = null;
      throw err;
    });
  return vaultReady;
}

export async function addLogin(args: {
  userId: string;
  origin: string;
  username: string;
  password: string;
  label?: string;
  extraOrigins?: string[];
}): Promise<VaultLogin> {
  const primary = normalizeLoginOrigin(args.origin);
  if (!primary) throw new VaultInputError("Login origin must be an https:// website address.");
  const extras = (args.extraOrigins ?? []).map((o) => normalizeLoginOrigin(o));
  if (extras.some((o) => o === null)) throw new VaultInputError("Every login origin must be an https:// website address.");
  const origins = [...new Set([primary, ...(extras as string[])])].slice(0, 5);
  const username = args.username.trim();
  if (!username || username.length > 512) throw new VaultInputError("Username is required.");
  if (!args.password || args.password.length > 4096) throw new VaultInputError("Password is required.");
  const loginUrl = (() => {
    try {
      const u = new URL(args.origin.trim());
      return u.pathname !== "/" || u.search ? u.toString() : null;
    } catch {
      return null;
    }
  })();
  const label = (args.label?.trim() || new URL(primary).hostname).slice(0, 80);

  const vault = kernelVaultName();
  const ins = await query<Row>(
    `insert into vault_items (user_id, label, login_origins, login_url, kernel_vault, kernel_item_key, status)
     values ($1, $2, $3, $4, $5, gen_random_uuid()::text, 'pending')
     returning *`,
    [args.userId, label, origins, loginUrl, vault],
  );
  const row = ins.rows[0];
  try {
    await ensureVault();
    await kernel().vaults.items.upsert(row.kernel_item_key, {
      id_or_name: vault,
      type: "credential",
      spec: {
        provider: "kernel",
        description: label,
        fields: [
          { name: "username", type: "text", label: "Username or email", required: true, sensitive: false, value: username },
          { name: "password", type: "password", label: "Password", required: true, sensitive: true, value: args.password },
        ],
      },
    });
  } catch (err) {
    await query(`delete from vault_items where id = $1`, [row.id]);
    // Never surface provider error bodies: they could echo request fields.
    throw new Error(`Could not save the login with Kernel (HTTP ${(err as { status?: number }).status ?? "error"}).`);
  }
  const done = await query<Row>(
    `update vault_items set status = 'ready', updated_at = now() where id = $1 returning *`,
    [row.id],
  );
  return toView(done.rows[0]);
}

export async function listLogins(userId: string): Promise<VaultLogin[]> {
  const { rows } = await query<Row>(
    `select * from vault_items where user_id = $1 and status <> 'failed' order by created_at desc`,
    [userId],
  );
  return rows.map(toView);
}

/** Deletes the Kernel item first; the row goes only once Kernel no longer holds the secret. */
export async function deleteLogin(userId: string, id: string): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return false;
  const { rows } = await query<Row>(`select * from vault_items where user_id = $1 and id = $2`, [userId, id]);
  const row = rows[0];
  if (!row) return false;
  try {
    await kernel().vaults.items.delete(row.kernel_item_key, { id_or_name: row.kernel_vault });
  } catch (err) {
    if (!isKernelNotFound(err)) throw new Error("Could not remove the login from Kernel; try again.");
  }
  await query(`delete from vault_items where id = $1 and user_id = $2`, [id, userId]);
  return true;
}

export type BoundLogin = { id: string; label: string; origins: string[]; loginUrl: string | null; vault: string; itemKey: string };

/** Ready logins whose declared origins include exactly `origin`. */
export async function loginsForOrigin(userId: string, origin: string): Promise<BoundLogin[]> {
  const o = normalizeLoginOrigin(origin);
  if (!o) return [];
  const { rows } = await query<Row>(
    `select * from vault_items where user_id = $1 and status = 'ready' and $2 = any(login_origins)
      order by last_used_at desc nulls last, created_at desc`,
    [userId, o],
  );
  return rows.map((r) => ({
    id: r.id,
    label: r.label,
    origins: r.login_origins,
    loginUrl: r.login_url,
    vault: r.kernel_vault,
    itemKey: r.kernel_item_key,
  }));
}

export async function markLoginUsed(id: string): Promise<void> {
  await query(`update vault_items set last_used_at = now() where id = $1`, [id]);
}
