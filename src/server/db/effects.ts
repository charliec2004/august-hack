import "server-only";

import { query } from "./client";

export type EffectStatus =
  | "prepared"
  | "authorized"
  | "waiting_approval"
  | "denied"
  | "dispatching"
  | "succeeded"
  | "failed"
  | "uncertain";

export type EffectRow = {
  id: string;
  user_id: string;
  responsibility_id: string;
  worker_session_id: string | null;
  source_message_id: string | null;
  provider: string;
  action: string;
  effect_class: "reversible" | "consequential" | "irreversible";
  canonical_args: Record<string, unknown>;
  material_facts: Record<string, unknown>;
  proposal_hash: string;
  review_decision: string | null;
  review_reason: string | null;
  status: EffectStatus;
  idempotency_key: string;
  attempt: number;
  dispatch_claimed_at: Date | null;
  /** Send later: an authorized effect is not dispatched before this time. */
  scheduled_for: Date | null;
  /** Set on a user-authored proposal that replaced an edited agent proposal. */
  supersedes_effect_id: string | null;
  created_at: Date;
  updated_at: Date;
};

export async function getEffect(userId: string, id: string) {
  const { rows } = await query<EffectRow>(
    `select * from effect_proposals where user_id = $1 and id = $2`,
    [userId, id],
  );
  return rows[0] ?? null;
}

export async function pendingApprovals(userId: string) {
  const { rows } = await query<EffectRow & { responsibility_title: string }>(
    `select e.*, r.title as responsibility_title
       from effect_proposals e join responsibilities r on r.id = e.responsibility_id
      where e.user_id = $1 and e.status = 'waiting_approval'
        and r.status not in ('completed','failed','cancelled')
      order by e.created_at asc`,
    [userId],
  );
  return rows;
}

export type UserFacingEffectRow = EffectRow & {
  responsibility_title: string;
  decided_at: Date | null;
  settled_at: Date | null;
  superseded_by: string | null;
};

/**
 * Every recent effect the user was asked about (pending, or decided via an
 * approval record), newest first, for persistent approval cards. A pending card
 * whose responsibility has closed is dropped: it can no longer be acted on.
 */
export async function recentUserFacingEffects(userId: string, limit = 50) {
  const { rows } = await query<UserFacingEffectRow>(
    `select e.*, r.title as responsibility_title,
            (select max(a.created_at) from approvals a where a.effect_proposal_id = e.id) as decided_at,
            (select max(x.created_at) from effect_receipts x where x.effect_proposal_id = e.id) as settled_at,
            (select s.id from effect_proposals s where s.supersedes_effect_id = e.id
              order by s.created_at desc limit 1) as superseded_by
       from effect_proposals e join responsibilities r on r.id = e.responsibility_id
      where e.user_id = $1
        and e.created_at > now() - interval '48 hours'
        and (
          (e.status = 'waiting_approval' and r.status not in ('completed','failed','cancelled'))
          or exists (select 1 from approvals a where a.effect_proposal_id = e.id)
        )
      order by e.created_at desc
      limit $2`,
    [userId, limit],
  );
  return rows;
}

export async function effectsForResponsibility(userId: string, responsibilityId: string) {
  const { rows } = await query<EffectRow>(
    `select * from effect_proposals where user_id = $1 and responsibility_id = $2
      order by created_at asc`,
    [userId, responsibilityId],
  );
  return rows;
}

export async function receiptFor(userId: string, effectId: string) {
  const { rows } = await query<{
    id: string;
    outcome: string;
    provider_receipt_ref: string | null;
    evidence_refs: string[];
    created_at: Date;
  }>(
    `select id, outcome, provider_receipt_ref, evidence_refs, created_at
       from effect_receipts where user_id = $1 and effect_proposal_id = $2
      order by created_at desc limit 1`,
    [userId, effectId],
  );
  return rows[0] ?? null;
}
