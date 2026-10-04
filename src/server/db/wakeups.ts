import "server-only";

import type { PoolClient } from "pg";
import { query, tx } from "./client";

export type WakeRow = {
  id: string;
  responsibility_id: string;
  user_id: string;
  source: "schedule" | "provider_event" | "user" | "repair" | "demo";
  cause_ref: string;
  due_at: Date;
  status: "pending" | "claimed" | "consumed" | "cancelled" | "failed";
  claim_owner: string | null;
  claim_expires_at: Date | null;
  attempt_count: number;
};

type Q = Pick<PoolClient, "query">;

/** Persist a future reason to resume. The model never holds a timer. */
export async function scheduleWake(
  c: Q,
  w: { userId: string; responsibilityId: string; source: WakeRow["source"]; causeRef: string; dueAt: Date },
): Promise<WakeRow> {
  const { rows } = await c.query<WakeRow>(
    `insert into wakeups (responsibility_id, user_id, source, cause_ref, due_at)
     values ($1, $2, $3, $4, $5) returning *`,
    [w.responsibilityId, w.userId, w.source, w.causeRef, w.dueAt],
  );
  return rows[0];
}

export async function cancelPendingWakes(c: Q, userId: string, responsibilityId: string) {
  await c.query(
    `update wakeups set status = 'cancelled'
      where user_id = $1 and responsibility_id = $2 and status = 'pending'`,
    [userId, responsibilityId],
  );
}

/**
 * Claim due wakes exactly once (FOR UPDATE SKIP LOCKED + lease). Expired claims
 * are reclaimable. Wakes for terminal responsibilities are cancelled, never run.
 */
export async function claimDueWakes(owner: string, opts: { limit?: number; leaseMs?: number; onlyId?: string } = {}) {
  const limit = opts.limit ?? 5;
  const leaseMs = opts.leaseMs ?? 5 * 60_000;
  return tx(async (c) => {
    await c.query(
      `update wakeups w set status = 'cancelled'
         from responsibilities r
        where r.id = w.responsibility_id and w.status = 'pending'
          and r.status in ('completed','failed','cancelled')`,
    );
    const { rows } = await c.query<WakeRow>(
      `with due as (
          select id from wakeups
           where (($3::uuid is null and due_at <= now()) or id = $3::uuid)
             and (status = 'pending' or (status = 'claimed' and claim_expires_at < now()))
           order by due_at asc
           limit $1
           for update skip locked)
       update wakeups w set status = 'claimed', claim_owner = $2,
              claim_expires_at = now() + ($4 || ' milliseconds')::interval,
              attempt_count = attempt_count + 1
         from due where w.id = due.id
       returning w.*`,
      [limit, owner, opts.onlyId ?? null, String(leaseMs)],
    );
    return rows;
  });
}

export async function consumeWake(id: string) {
  await query(`update wakeups set status = 'consumed', consumed_at = now() where id = $1`, [id]);
}

/** Bounded backoff (spec 29): 30s, 2m, 10m, 30m, then give up to repair. */
export async function failWake(id: string, attempt: number) {
  const delays = [30, 120, 600, 1800];
  if (attempt > delays.length) {
    await query(`update wakeups set status = 'failed' where id = $1`, [id]);
    return;
  }
  await query(
    `update wakeups set status = 'pending', claim_owner = null, claim_expires_at = null,
            due_at = now() + ($2 || ' seconds')::interval
      where id = $1`,
    [id, String(delays[attempt - 1])],
  );
}

export async function nextPendingWake(userId: string, responsibilityId: string) {
  const { rows } = await query<WakeRow>(
    `select * from wakeups where user_id = $1 and responsibility_id = $2 and status = 'pending'
      order by due_at asc limit 1`,
    [userId, responsibilityId],
  );
  return rows[0] ?? null;
}
