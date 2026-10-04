import "server-only";

import { releaseComputersInBackground } from "@/server/computers/releaseOnTerminal";
import { tx } from "@/server/db/client";
import { transition } from "@/server/db/responsibilities";
import { cancelPendingWakes } from "@/server/db/wakeups";

/** User cancellation: invalidates future wakes and any not-yet-dispatched effects. */
export async function cancelResponsibility(userId: string, responsibilityId: string, reason: string) {
  const updated = await tx(async (c) => {
    await cancelPendingWakes(c, userId, responsibilityId);
    await c.query(
      `update effect_proposals set status = 'denied', updated_at = now()
        where user_id = $1 and responsibility_id = $2 and status in ('prepared','waiting_approval','authorized')`,
      [userId, responsibilityId],
    );
    return transition(c, {
      userId,
      responsibilityId,
      to: "cancelled",
      nextWakeAt: null,
      eventText: "Stopped",
      detail: { reason },
    });
  });
  if (updated) releaseComputersInBackground(userId, responsibilityId);
  return Boolean(updated);
}
