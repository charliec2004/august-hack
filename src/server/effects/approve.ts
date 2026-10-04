import "server-only";

import { tx } from "@/server/db/client";
import type { EffectRow } from "@/server/db/effects";
import { appendEvent, transition } from "@/server/db/responsibilities";
import { trace } from "@/server/db/traces";
import { proposalHash } from "./canonicalize";

export class ApprovalConflict extends Error {}

/**
 * Record the user's decision on exactly one frozen proposal (spec 11, 13).
 * The browser must echo the hash it displayed; it must equal the stored hash,
 * which must equal a fresh recomputation from the stored canonical payload.
 * A denied or already-decided proposal can never be approved later.
 */
export async function decideApproval(input: {
  userId: string;
  effectId: string;
  decision: "approved" | "denied";
  shownProposalHash: string;
}): Promise<{ responsibilityId: string; decision: "approved" | "denied" }> {
  return tx(async (c) => {
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

    await c.query(
      `insert into approvals (effect_proposal_id, user_id, proposal_hash, decision)
       values ($1, $2, $3, $4)`,
      [e.id, input.userId, e.proposal_hash, input.decision],
    );
    await c.query(`update effect_proposals set status = $2, updated_at = now() where id = $1`, [
      e.id,
      input.decision === "approved" ? "authorized" : "denied",
    ]);
    await transition(c, {
      userId: input.userId,
      responsibilityId: e.responsibility_id,
      to: "active",
      waitingOn: null,
      eventText: input.decision === "approved" ? "You approved" : "You said not now",
      detail: { effectId: e.id },
    });
    await appendEvent(c, {
      userId: input.userId,
      responsibilityId: e.responsibility_id,
      kind: "approval.resolved",
      detail: { effectId: e.id, decision: input.decision },
    });
    await trace({
      userId: input.userId,
      responsibilityId: e.responsibility_id,
      kind: "approval.resolved",
      detail: { effectId: e.id, decision: input.decision },
    });
    return { responsibilityId: e.responsibility_id, decision: input.decision };
  });
}
