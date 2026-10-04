import "server-only";

import { runInBackground } from "../background";
import { query } from "../db/client";
import { releaseComputer } from "./runtime";

/**
 * When a responsibility reaches a terminal state (completed/failed/cancelled),
 * its live Computers have no further use: release them (which also deletes any
 * written login files). Idempotent: released rows are skipped, and
 * releaseComputer itself is a no-op on an already-released Computer.
 */
export async function releaseResponsibilityComputers(userId: string, responsibilityId: string): Promise<number> {
  const { rows } = await query<{
    id: string;
    worker_session_id: string | null;
    provider_ref: string;
    pinned_generation: number;
  }>(
    `select id, worker_session_id, provider_ref, pinned_generation from computers
      where user_id = $1 and responsibility_id = $2 and lifecycle in ('provisioning','running','dormant')`,
    [userId, responsibilityId],
  );
  let released = 0;
  for (const c of rows) {
    const r = await releaseComputer({
      computerId: c.id,
      userId,
      responsibilityId,
      workerSessionId: c.worker_session_id,
      spriteName: c.provider_ref,
      pinnedGeneration: c.pinned_generation,
      reused: true,
    }).catch(() => null);
    if (r?.status === "succeeded") released += 1;
  }
  return released;
}

/** Fire-and-forget form for terminal transitions. */
export function releaseComputersInBackground(userId: string, responsibilityId: string): void {
  runInBackground("release-computers", () => releaseResponsibilityComputers(userId, responsibilityId));
}
