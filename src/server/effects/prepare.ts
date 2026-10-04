import "server-only";

import { query, tx } from "@/server/db/client";
import type { EffectRow } from "@/server/db/effects";
import { recentUserInstructions } from "@/server/db/messages";
import { transition } from "@/server/db/responsibilities";
import { trace } from "@/server/db/traces";
import type { EffectClass, ReviewDecision } from "@/server/types/domain";
import { canonicalize, proposalHash } from "./canonicalize";
import { CATEGORY_CLASS, classifyAction } from "./classify";
import { idempotencyKey } from "./idempotency";
import { reviewEffect } from "./review";
import type { EffectDraft } from "./types";

export type PrepareResult = {
  effectId: string;
  status: "authorized" | "waiting_approval" | "denied";
  decision: ReviewDecision;
  proposalHash: string;
};

const RANK: Record<EffectClass, number> = { reversible: 0, consequential: 1, irreversible: 2 };

/** Scan free-text commands (e.g. a CLI run on a Computer) for irreversible verbs. */
function classFromCommandText(text: string): EffectClass | null {
  const words = new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  const irreversible = [
    "order", "checkout", "purchase", "buy", "pay", "payment", "tip", "transfer",
    "delete", "destroy", "cancel", "rm",
  ];
  return irreversible.some((w) => words.has(w)) ? CATEGORY_CLASS.purchase : null;
}

/**
 * The single gateway for every external mutation (spec 10, 11, 13):
 * classify -> freeze exact args -> hash -> deterministic policy -> auto-review ->
 * park for the user if needed. Nothing executes here; see execute.ts.
 */
export async function prepareEffect(input: {
  userId: string;
  responsibilityId: string;
  workerSessionId: string | null;
  draft: EffectDraft;
}): Promise<PrepareResult> {
  const { userId, responsibilityId, draft } = input;

  const resp = await query<{ thread_id: string; status: string; source_message_id: string | null }>(
    `select thread_id, status, source_message_id from responsibilities where user_id = $1 and id = $2`,
    [userId, responsibilityId],
  );
  const r = resp.rows[0];
  if (!r) throw new Error("responsibility not found for user");
  if (["completed", "failed", "cancelled"].includes(r.status)) {
    throw new Error("responsibility is no longer active");
  }

  const cls = classifyAction(draft.provider, draft.action);
  if (cls.kind !== "effect") {
    throw new Error(`${draft.provider}.${draft.action} is not an external effect; call it as a read`);
  }

  let effectClass: EffectClass = cls.effectClass;
  const commandText =
    typeof draft.args.command === "string" ? draft.args.command : null;
  if (commandText) {
    const bumped = classFromCommandText(commandText);
    if (bumped && RANK[bumped] > RANK[effectClass]) effectClass = bumped;
  }

  const exactArgs = canonicalize(draft.args) as Record<string, unknown>;
  const materialFacts = canonicalize(draft.materialFacts ?? {}) as Record<string, unknown>;
  const hash = proposalHash({ provider: draft.provider, action: draft.action, exactArgs, materialFacts });

  // Same frozen proposal for the same responsibility: reuse, never duplicate.
  const dup = await query<EffectRow>(
    `select * from effect_proposals
      where user_id = $1 and responsibility_id = $2 and proposal_hash = $3
        and status in ('prepared','authorized','waiting_approval','dispatching','succeeded','uncertain')
      order by created_at desc limit 1`,
    [userId, responsibilityId, hash],
  );
  if (dup.rows[0]) {
    const d = dup.rows[0];
    return {
      effectId: d.id,
      status: d.status === "waiting_approval" ? "waiting_approval" : "authorized",
      decision: {
        decision: d.status === "waiting_approval" ? "needs_confirmation" : "authorized",
        reasonCode: "duplicate_of_existing_proposal",
      },
      proposalHash: hash,
    };
  }

  const key = idempotencyKey({
    userId,
    responsibilityId,
    effectType: `${draft.provider}.${draft.action}`,
    proposalHash: hash,
    attempt: 1,
  });

  const inserted = await query<{ id: string }>(
    `insert into effect_proposals
       (user_id, responsibility_id, worker_session_id, source_message_id, provider, action,
        effect_class, canonical_args, material_facts, proposal_hash, status, idempotency_key)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'prepared', $11)
     on conflict (idempotency_key) do update set updated_at = now()
     returning id`,
    [
      userId,
      responsibilityId,
      input.workerSessionId,
      r.source_message_id,
      draft.provider,
      draft.action,
      effectClass,
      JSON.stringify(exactArgs),
      JSON.stringify(materialFacts),
      hash,
      key,
    ],
  );
  const effectId = inserted.rows[0].id;
  await trace({
    userId,
    responsibilityId,
    kind: "effect.proposed",
    detail: { effectId, action: `${draft.provider}.${draft.action}`, effectClass },
  });

  let decision: ReviewDecision;
  if (!cls.supported) {
    decision = { decision: "denied", reasonCode: "unsupported_category" };
  } else {
    const intent = await recentUserInstructions(userId, r.thread_id, 8);
    decision = await reviewEffect({
      authenticatedUserMessages: intent.map((m) => ({
        text: m.content,
        createdAt: m.created_at.toISOString(),
      })),
      proposal: {
        provider: draft.provider,
        action: draft.action,
        exactArgs,
        materialResourceFacts: materialFacts,
        effectClass,
      },
    });
  }

  const status =
    decision.decision === "authorized"
      ? "authorized"
      : decision.decision === "denied"
        ? "denied"
        : "waiting_approval";

  await tx(async (c) => {
    await c.query(
      `update effect_proposals set status = $2, review_decision = $3, review_reason = $4, updated_at = now()
        where id = $1 and status = 'prepared'`,
      [effectId, status, decision.decision, decision.userFacingQuestion ?? decision.reasonCode],
    );
    if (status === "waiting_approval") {
      await transition(c, {
        userId,
        responsibilityId,
        to: "waiting_user",
        waitingOn: `approval:${effectId}`,
        eventText: "Needs your approval",
        detail: { effectId },
      });
    }
  });
  await trace({
    userId,
    responsibilityId,
    kind: status === "waiting_approval" ? "approval.requested" : "effect.reviewed",
    detail: {
      effectId,
      decision: decision.decision,
      reasonCode: decision.reasonCode,
      text: status === "waiting_approval" ? "Waiting for your OK" : undefined,
    },
  });

  return { effectId, status, decision, proposalHash: hash };
}
