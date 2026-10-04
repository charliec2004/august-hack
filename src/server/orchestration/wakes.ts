import "server-only";

import { randomUUID } from "node:crypto";
import { tx } from "@/server/db/client";
import { findStranded, transition } from "@/server/db/responsibilities";
import { trace } from "@/server/db/traces";
import {
  claimDueWakes,
  consumeWake,
  failWake,
  scheduleWake,
  type WakeRow,
} from "@/server/db/wakeups";
import { runInBackground } from "@/server/background";
import { runWorkerForWake } from "./runWorker";

const OWNER = `august-${process.pid}-${randomUUID().slice(0, 8)}`;

/**
 * Persist a wake and (optionally) record the scheduled state on the
 * responsibility in the same transaction, so the obligation can't be lost
 * between "decided to wait" and "remembered to wake".
 */
export async function scheduleResponsibilityWake(input: {
  userId: string;
  responsibilityId: string;
  dueAt: Date;
  source: WakeRow["source"];
  causeRef: string;
  markScheduled?: { nextAction: string | null; eventText: string };
}) {
  const wake = await tx(async (c) => {
    const w = await scheduleWake(c, input);
    if (input.markScheduled) {
      await transition(c, {
        userId: input.userId,
        responsibilityId: input.responsibilityId,
        to: "scheduled",
        nextWakeAt: input.dueAt,
        nextAction: input.markScheduled.nextAction,
        waitingOn: null,
        eventText: input.markScheduled.eventText,
      });
    }
    return w;
  });
  await trace({
    userId: input.userId,
    responsibilityId: input.responsibilityId,
    kind: "wake.scheduled",
    detail: { wakeId: wake.id, dueAt: input.dueAt.toISOString(), source: input.source },
  });
  return wake;
}

/** Claim and run due wakes. Safe to call concurrently from many places. */
export async function processDueWakes(opts: { limit?: number; onlyId?: string } = {}) {
  const claimed = await claimDueWakes(OWNER, { limit: opts.limit ?? 3, onlyId: opts.onlyId });
  const results = [];
  for (const wake of claimed) {
    await trace({
      userId: wake.user_id,
      responsibilityId: wake.responsibility_id,
      kind: "wake.claimed",
      detail: { wakeId: wake.id, source: wake.source },
    });
    try {
      const outcome = await runWorkerForWake(wake);
      await consumeWake(wake.id);
      results.push({ wakeId: wake.id, outcome });
    } catch (err) {
      console.error("wake run failed:", (err as Error).message);
      await failWake(wake.id, wake.attempt_count);
      results.push({ wakeId: wake.id, outcome: "error" as const });
    }
  }
  return results;
}

/** Schedule an immediate wake and process it in the background. */
export async function kickResponsibility(input: {
  userId: string;
  responsibilityId: string;
  source: WakeRow["source"];
  causeRef: string;
}) {
  const wake = await scheduleResponsibilityWake({ ...input, dueAt: new Date() });
  runInBackground("wake", () => processDueWakes({ onlyId: wake.id }));
  return wake;
}

/**
 * Consistency repair (spec 8 "no silent limbo", 29 stranded-work sweeper):
 * re-arm any nonterminal responsibility with no run, no wake, not waiting on the user.
 */
export async function repairStranded() {
  const stranded = await findStranded();
  for (const s of stranded) {
    await scheduleResponsibilityWake({
      userId: s.user_id,
      responsibilityId: s.id,
      dueAt: new Date(Date.now() + 60_000),
      source: "repair",
      causeRef: "stranded_repair",
    });
  }
  return stranded.length;
}
