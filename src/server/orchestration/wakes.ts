import "server-only";

import { randomUUID } from "node:crypto";
import { query, tx } from "@/server/db/client";
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
import { reconcileBrowserSessions } from "@/server/browser/sessions";
import { executeEffect } from "@/server/effects/execute";
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

/**
 * Dispatch approved send-later effects whose time has come. executeEffect's
 * transactional claim makes this exactly-once across concurrent scanners; after
 * a send, the responsibility resumes exactly as after an immediate approval.
 */
export async function dispatchDueScheduledEffects(
  opts: {
    limit?: number;
    userId?: string;
    /** How to resume the responsibility after a send (tests stub this). */
    resume?: (e: { userId: string; responsibilityId: string; effectId: string }) => Promise<unknown>;
  } = {},
) {
  const resume =
    opts.resume ??
    ((e) =>
      kickResponsibility({
        userId: e.userId,
        responsibilityId: e.responsibilityId,
        source: "schedule",
        causeRef: `approval:${e.effectId}:approved`,
      }));
  const { rows } = await query<{ id: string; user_id: string; responsibility_id: string }>(
    `select id, user_id, responsibility_id from effect_proposals
      where status = 'authorized' and scheduled_for is not null and scheduled_for <= now()
        and ($2::uuid is null or user_id = $2)
      order by scheduled_for asc limit $1`,
    [opts.limit ?? 10, opts.userId ?? null],
  );
  let dispatched = 0;
  for (const e of rows) {
    try {
      const result = await executeEffect(e.user_id, e.id);
      if (!result) continue;
      dispatched += 1;
      await resume({ userId: e.user_id, responsibilityId: e.responsibility_id, effectId: e.id });
    } catch (err) {
      console.error("scheduled effect dispatch failed:", (err as Error).message);
    }
  }
  return dispatched;
}

/** Claim and run due wakes (and due send-later effects). Safe to call concurrently. */
export async function processDueWakes(opts: { limit?: number; onlyId?: string } = {}) {
  if (!opts.onlyId) await dispatchDueScheduledEffects().catch((e) => console.error("[scheduled]", e.message));
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
  // Close browser sessions whose run ended or that Kernel no longer has.
  await reconcileBrowserSessions().catch(() => {});
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
