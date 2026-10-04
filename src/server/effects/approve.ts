import "server-only";

import type { PoolClient } from "pg";
import { tx } from "@/server/db/client";
import type { EffectRow } from "@/server/db/effects";
import { appendEvent, transition } from "@/server/db/responsibilities";
import { trace } from "@/server/db/traces";
import { proposalHash } from "./canonicalize";

export class ApprovalConflict extends Error {}

const MAX_SCHEDULE_MS = 90 * 24 * 3600_000;

/**
 * Send-later time from the client. Null (or a time that is already due) means
 * "now". Anything unparseable or absurdly far out is rejected.
 */
export function normalizeSendAt(sendAt: string | null | undefined): Date | null {
  if (!sendAt) return null;
  const d = new Date(sendAt);
  if (Number.isNaN(d.getTime())) throw new ApprovalConflict("bad_send_at");
  if (d.getTime() - Date.now() > MAX_SCHEDULE_MS) throw new ApprovalConflict("bad_send_at");
  return d.getTime() <= Date.now() + 5_000 ? null : d;
}

/** Lock one proposal still waiting for the user, verifying the hash they saw. */
export async function lockAwaitingProposal(
  c: Pick<PoolClient, "query">,
  input: { userId: string; effectId: string; shownProposalHash: string },
): Promise<EffectRow> {
  const { rows } = await c.query<EffectRow>(
    `select * from effect_proposals where user_id = $1 and id = $2 for update`,
    [input.userId, input.effectId],
  );
  const e = rows[0];
  if (!e) throw new ApprovalConflict("not_found");
  if (e.status !== "waiting_approval") throw new ApprovalConflict("not_awaiting_approval");
  const recomputed = proposalHash({
    provider: e.provider,
    action: e.action,
    exactArgs: e.canonical_args,
    materialFacts: e.material_facts,
  });
  if (recomputed !== e.proposal_hash || input.shownProposalHash !== e.proposal_hash) {
    throw new ApprovalConflict("proposal_hash_mismatch");
  }
  return e;
}

/** Move the responsibility on after the user approved (now or later) or declined. */
export async function recordResolution(
  c: Pick<PoolClient, "query">,
  input: {
    userId: string;
    responsibilityId: string;
    effectId: string;
    decision: "approved" | "denied";
    scheduledFor: Date | null;
    eventText?: string;
  },
) {
  const scheduled = input.decision === "approved" && input.scheduledFor !== null;
  await transition(c, {
    userId: input.userId,
    responsibilityId: input.responsibilityId,
    to: scheduled ? "scheduled" : "active",
    waitingOn: null,
    ...(scheduled ? { nextWakeAt: input.scheduledFor, nextAction: "Send at the scheduled time" } : {}),
    eventText:
      input.eventText ??
      (scheduled ? "You scheduled it" : input.decision === "approved" ? "You approved" : "You said not now"),
    detail: { effectId: input.effectId },
  });
  const detail = {
    effectId: input.effectId,
    decision: input.decision,
    ...(scheduled ? { scheduledFor: input.scheduledFor!.toISOString() } : {}),
  };
  await appendEvent(c, { userId: input.userId, responsibilityId: input.responsibilityId, kind: "approval.resolved", detail });
  await trace({ userId: input.userId, responsibilityId: input.responsibilityId, kind: "approval.resolved", detail });
}

/**
 * Record the user's decision on exactly one frozen proposal (spec 11, 13).
 * The browser must echo the hash it displayed; it must equal the stored hash,
 * which must equal a fresh recomputation from the stored canonical payload.
 * A denied or already-decided proposal can never be approved later.
 * `sendAt` (approve only) keeps the effect authorized but undispatched until due.
 */
export async function decideApproval(input: {
  userId: string;
  effectId: string;
  decision: "approved" | "denied";
  shownProposalHash: string;
  sendAt?: string | null;
}): Promise<{ responsibilityId: string; decision: "approved" | "denied"; scheduledFor: Date | null }> {
  const scheduledFor = input.decision === "approved" ? normalizeSendAt(input.sendAt) : null;
  return tx(async (c) => {
    const e = await lockAwaitingProposal(c, input);
    await c.query(
      `insert into approvals (effect_proposal_id, user_id, proposal_hash, decision)
       values ($1, $2, $3, $4)`,
      [e.id, input.userId, e.proposal_hash, input.decision],
    );
    await c.query(
      `update effect_proposals set status = $2, scheduled_for = $3, updated_at = now() where id = $1`,
      [e.id, input.decision === "approved" ? "authorized" : "denied", scheduledFor],
    );
    await recordResolution(c, {
      userId: input.userId,
      responsibilityId: e.responsibility_id,
      effectId: e.id,
      decision: input.decision,
      scheduledFor,
    });
    return { responsibilityId: e.responsibility_id, decision: input.decision, scheduledFor };
  });
}

/** Lock an approved effect that is still waiting for its scheduled time. */
async function lockScheduled(c: Pick<PoolClient, "query">, userId: string, effectId: string) {
  const { rows } = await c.query<EffectRow>(
    `select * from effect_proposals
      where user_id = $1 and id = $2 and status = 'authorized' and scheduled_for is not null
      for update`,
    [userId, effectId],
  );
  if (!rows[0]) throw new ApprovalConflict("not_scheduled");
  return rows[0];
}

/** Cancel a scheduled send before it dispatches. Final, like a denial. */
export async function cancelScheduledEffect(input: { userId: string; effectId: string }) {
  return tx(async (c) => {
    const e = await lockScheduled(c, input.userId, input.effectId);
    await c.query(
      `update effect_proposals set status = 'denied', review_reason = 'cancelled_by_user', updated_at = now()
        where id = $1`,
      [e.id],
    );
    await recordResolution(c, {
      userId: input.userId,
      responsibilityId: e.responsibility_id,
      effectId: e.id,
      decision: "denied",
      scheduledFor: null,
      eventText: "You cancelled the scheduled send",
    });
    return { responsibilityId: e.responsibility_id };
  });
}

/** Make a scheduled effect due immediately. The caller then executes it. */
export async function makeScheduledEffectDue(input: { userId: string; effectId: string }) {
  return tx(async (c) => {
    const e = await lockScheduled(c, input.userId, input.effectId);
    await c.query(`update effect_proposals set scheduled_for = now(), updated_at = now() where id = $1`, [e.id]);
    await transition(c, {
      userId: input.userId,
      responsibilityId: e.responsibility_id,
      to: "active",
      nextWakeAt: null,
      eventText: "You sent it now",
      detail: { effectId: e.id },
    });
    return { responsibilityId: e.responsibility_id };
  });
}
