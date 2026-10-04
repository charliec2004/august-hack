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
