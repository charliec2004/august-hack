import "server-only";

import { query } from "@/server/db/client";
import { nextPendingWake } from "@/server/db/wakeups";
import { processDueWakes } from "./wakes";

/**
 * "Run next check now": pull the responsibility's real pending wake forward to
 * now and run it through the normal claim path. Time is accelerated; nothing else.
 */
export async function demoRunNextWake(userId: string, responsibilityId: string) {
  const wake = await nextPendingWake(userId, responsibilityId);
  if (!wake) return { ok: false, error: "no_pending_wake" as const };
  await query(`update wakeups set due_at = now() where id = $1 and status = 'pending'`, [wake.id]);
  await query(
    `insert into responsibility_events (responsibility_id, user_id, event_kind, safe_detail)
     values ($1, $2, 'demo.fast_forward', '{"text":"Fast-forwarded to the next check (demo)"}')`,
    [responsibilityId, userId],
  );
  const results = await processDueWakes({ onlyId: wake.id });
  return { ok: true, wakeId: wake.id, results };
}
