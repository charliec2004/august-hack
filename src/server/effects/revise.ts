import "server-only";

import { tx } from "@/server/db/client";
import { buildSendDraft } from "@/server/providers/agentmail";
import { ApprovalConflict, lockAwaitingProposal, normalizeSendAt, recordResolution } from "./approve";
import { canonicalize, proposalHash } from "./canonicalize";
import { classifyAction } from "./classify";
import { idempotencyKey } from "./idempotency";

export type EmailEdit = { to: string[]; subject: string; body: string };

/**
 * The user edited an email August proposed and pressed Send. In one transaction:
 * the original (still waiting, hash as shown) is denied as superseded, and a new
 * proposal with exactly the user's to/subject/body (same sending inbox and
 * reply target) is frozen, hashed, and approved, bound to its new hash, since
 * the user authored those exact bytes. Nothing else about the effect can change.
 */
export async function reviseEmailEffect(input: {
  userId: string;
  effectId: string;
  shownProposalHash: string;
  edit: EmailEdit;
  sendAt?: string | null;
}): Promise<{ effectId: string; responsibilityId: string; proposalHash: string; scheduledFor: Date | null }> {
  const scheduledFor = normalizeSendAt(input.sendAt);
  const { to, subject, body } = input.edit;
  if (to.length === 0 || to.length > 20) throw new ApprovalConflict("bad_recipients");
  if (subject.length > 300 || body.length > 50_000) throw new ApprovalConflict("too_long");

  return tx(async (c) => {
    const orig = await lockAwaitingProposal(c, input);
    if (orig.provider !== "agentmail" || orig.action !== "send_email") throw new ApprovalConflict("not_editable");
    const prev = orig.canonical_args as { fromInbox?: unknown; replyToMessageId?: unknown };
    if (typeof prev.fromInbox !== "string") throw new ApprovalConflict("not_editable");

    let draft;
    try {
      draft = buildSendDraft(
        {
          to,
          subject,
          text: body,
          ...(typeof prev.replyToMessageId === "string" ? { replyToMessageId: prev.replyToMessageId } : {}),
        },
        prev.fromInbox,
      );
    } catch {
      throw new ApprovalConflict("bad_recipients");
    }
    const cls = classifyAction(draft.provider, draft.action);
    if (cls.kind !== "effect") throw new ApprovalConflict("not_editable");
    const exactArgs = canonicalize(draft.args) as Record<string, unknown>;
    const materialFacts = canonicalize(draft.materialFacts) as Record<string, unknown>;
    const hash = proposalHash({ provider: draft.provider, action: draft.action, exactArgs, materialFacts });
    if (hash === orig.proposal_hash) throw new ApprovalConflict("unchanged");

    const key = idempotencyKey({
      userId: input.userId,
      responsibilityId: orig.responsibility_id,
      effectType: `${draft.provider}.${draft.action}`,
      proposalHash: hash,
      attempt: 1,
    });

    // The edited original can never execute: denied, with a decision record.
    await c.query(
      `update effect_proposals set status = 'denied', review_reason = 'superseded_by_user_edit', updated_at = now()
        where id = $1`,
      [orig.id],
    );
    await c.query(
      `insert into approvals (effect_proposal_id, user_id, proposal_hash, decision) values ($1, $2, $3, 'denied')`,
      [orig.id, input.userId, orig.proposal_hash],
    );

    const inserted = await c.query<{ id: string }>(
      `insert into effect_proposals
         (user_id, responsibility_id, worker_session_id, source_message_id, provider, action, effect_class,
          canonical_args, material_facts, proposal_hash, review_decision, review_reason, status,
          idempotency_key, scheduled_for, supersedes_effect_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'user_authored', null, 'authorized', $11, $12, $13)
       on conflict (idempotency_key) do nothing
       returning id`,
      [
        input.userId,
        orig.responsibility_id,
        orig.worker_session_id,
        orig.source_message_id,
        draft.provider,
        draft.action,
        cls.effectClass,
        JSON.stringify(exactArgs),
        JSON.stringify(materialFacts),
        hash,
        key,
        scheduledFor,
        orig.id,
      ],
    );
    // The same exact email already exists for this responsibility: never send twice.
    if (!inserted.rows[0]) throw new ApprovalConflict("duplicate_of_existing_effect");
    const effectId = inserted.rows[0].id;
    await c.query(
      `insert into approvals (effect_proposal_id, user_id, proposal_hash, decision) values ($1, $2, $3, 'approved')`,
      [effectId, input.userId, hash],
    );
    await recordResolution(c, {
      userId: input.userId,
      responsibilityId: orig.responsibility_id,
      effectId,
      decision: "approved",
      scheduledFor,
      eventText: scheduledFor ? "You edited and scheduled it" : "You edited and approved it",
    });
    return { effectId, responsibilityId: orig.responsibility_id, proposalHash: hash, scheduledFor };
  });
}
