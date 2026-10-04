import "server-only";

import { query } from "@/server/db/client";
import { kernel } from "@/server/providers/kernelClient";

/**
 * Persistent per-user Kernel browser profile (cookies, local storage, saved
 * sign-ins). One default profile per user; at most one WRITER at a time via
 * browser_profile_leases (unique unreleased lease per profile). A browser that
 * cannot get the write lease still loads the profile, read-only
 * (`save_changes: false`), so concurrent runs never clobber each other's state.
 */

const LEASE_MS = 15 * 60_000;

export type ProfileHandle = {
  profileId: string;
  kernelProfileName: string;
  /** Present when this caller holds the single-writer lease. */
  leaseId: string | null;
};

function profileNameFor(userId: string): string {
  return `august-u-${userId}`;
}

async function ensureKernelProfile(name: string): Promise<void> {
  try {
    await kernel().profiles.retrieve(name);
  } catch (err) {
    if ((err as { status?: number }).status !== 404) throw err;
    try {
      await kernel().profiles.create({ name });
    } catch (e) {
      // A concurrent create already made it.
      if ((e as { status?: number }).status !== 409) throw e;
    }
  }
}

/** The user's default profile row (created in Kernel + Postgres on first use). */
export async function ensureUserProfile(userId: string): Promise<{ id: string; kernelProfileName: string }> {
  const existing = await query<{ id: string; kernel_profile_ref: string }>(
    `select id, kernel_profile_ref from browser_profiles
      where user_id = $1 and label = 'default' and status = 'active'`,
    [userId],
  );
  if (existing.rows[0]) return { id: existing.rows[0].id, kernelProfileName: existing.rows[0].kernel_profile_ref };

  const name = profileNameFor(userId);
  await ensureKernelProfile(name);
  const ins = await query<{ id: string; kernel_profile_ref: string }>(
    `insert into browser_profiles (user_id, kernel_profile_ref, label, status)
     values ($1, $2, 'default', 'active')
     on conflict (kernel_profile_ref) do update set updated_at = now()
     returning id, kernel_profile_ref`,
    [userId, name],
  );
  return { id: ins.rows[0].id, kernelProfileName: ins.rows[0].kernel_profile_ref };
}

/** Try to take the profile's single-writer lease; expired leases are reclaimed. */
export async function acquireProfileLease(args: {
  userId: string;
  profileId: string;
  workerRunId: string | null;
  owner: string;
}): Promise<string | null> {
  await query(
    `update browser_profile_leases set released_at = now()
      where browser_profile_id = $1 and released_at is null and lease_expires_at < now()`,
    [args.profileId],
  );
  const { rows } = await query<{ id: string }>(
    `insert into browser_profile_leases (browser_profile_id, user_id, worker_run_id, mode, lease_owner, lease_expires_at)
     values ($1, $2, $3, 'write', $4, now() + ($5 || ' milliseconds')::interval)
     on conflict (browser_profile_id) where released_at is null do nothing
     returning id`,
    [args.profileId, args.userId, args.workerRunId, args.owner, String(LEASE_MS)],
  );
  return rows[0]?.id ?? null;
}

export async function attachLeaseSession(leaseId: string, kernelSessionId: string): Promise<void> {
  await query(`update browser_profile_leases set kernel_session_ref = $2 where id = $1`, [leaseId, kernelSessionId]);
}

export async function releaseProfileLease(leaseId: string): Promise<void> {
  await query(`update browser_profile_leases set released_at = now() where id = $1 and released_at is null`, [leaseId]);
}

/** Profile + (maybe) writer lease for a new browser session. */
export async function openProfile(args: { userId: string; workerRunId: string | null; owner: string }): Promise<ProfileHandle> {
  const p = await ensureUserProfile(args.userId);
  const leaseId = await acquireProfileLease({ userId: args.userId, profileId: p.id, workerRunId: args.workerRunId, owner: args.owner });
  return { profileId: p.id, kernelProfileName: p.kernelProfileName, leaseId };
}
