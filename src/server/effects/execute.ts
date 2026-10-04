import "server-only";

import { query, tx } from "@/server/db/client";
import type { EffectRow } from "@/server/db/effects";
import { appendEvent } from "@/server/db/responsibilities";
import { trace } from "@/server/db/traces";
import { proposalHash } from "./canonicalize";
import "./dispatchers";
import { getDispatcher } from "./registry";
import type { AuthorizedEffect, DispatchResult } from "./types";

function toAuthorized(e: EffectRow): AuthorizedEffect {
  return {
    id: e.id,
    userId: e.user_id,
    responsibilityId: e.responsibility_id,
    provider: e.provider,
    action: e.action,
    effectClass: e.effect_class,
    canonicalArgs: e.canonical_args,
    materialFacts: e.material_facts,
    proposalHash: e.proposal_hash,
    idempotencyKey: e.idempotency_key,
  };
}

export class EffectIntegrityError extends Error {}

/**
 * Execute an authorized effect exactly once.
 * - Claims the dispatch transactionally (authorized -> dispatching); a second
 *   caller gets null and does nothing. A scheduled effect is not claimable
 *   before its scheduled_for time.
 * - Recomputes the proposal hash from the stored canonical payload; any drift blocks.
 * - If review required confirmation, requires an approval row bound to this exact hash.
 * - A thrown adapter error after dispatch began is "uncertain", never "failed",
 *   so it is reconciled by readback instead of blindly retried.
 */
export async function executeEffect(userId: string, effectId: string): Promise<DispatchResult | null> {
  let integrityFailure = false;
  const claimed = await tx(async (c) => {
    const { rows } = await c.query<EffectRow & { not_yet_due: boolean }>(
      `select *, coalesce(scheduled_for > now(), false) as not_yet_due
         from effect_proposals where user_id = $1 and id = $2 for update`,
      [userId, effectId],
    );
    const e = rows[0];
    if (!e || e.status !== "authorized") return null;
    // Send later: never dispatch before the time the user chose.
    if (e.not_yet_due) return null;

    const recomputed = proposalHash({
      provider: e.provider,
      action: e.action,
      exactArgs: e.canonical_args,
      materialFacts: e.material_facts,
    });
    if (recomputed !== e.proposal_hash) {
      await c.query(`update effect_proposals set status = 'failed', updated_at = now() where id = $1`, [e.id]);
      integrityFailure = true;
      return null;
    }
    if (e.review_decision !== "authorized") {
      const ok = await c.query(
        `select 1 from approvals
          where effect_proposal_id = $1 and user_id = $2 and proposal_hash = $3 and decision = 'approved'`,
        [e.id, userId, e.proposal_hash],
      );
      if (!ok.rowCount) return null;
    }
    await c.query(
      `update effect_proposals set status = 'dispatching', dispatch_claimed_at = now(), updated_at = now()
        where id = $1`,
      [e.id],
    );
    return e;
  });
  if (integrityFailure) throw new EffectIntegrityError("proposal payload no longer matches its hash");
  if (!claimed) return null;

  const effect = toAuthorized(claimed);
  const dispatcher = getDispatcher(effect.provider, effect.action);
  await trace({
    userId,
    responsibilityId: effect.responsibilityId,
    kind: "effect.dispatched",
    detail: { effectId, action: `${effect.provider}.${effect.action}` },
  });

  let result: DispatchResult;
  if (!dispatcher) {
    result = {
      outcome: "failed",
      providerReceiptRef: null,
      providerRequestId: null,
      evidenceRefs: [],
      safeSummary: `no adapter registered for ${effect.provider}.${effect.action}`,
    };
  } else {
    try {
      result = await dispatcher.dispatch(effect);
    } catch (err) {
      result = {
        outcome: "uncertain",
        providerReceiptRef: null,
        providerRequestId: null,
        evidenceRefs: [],
        safeSummary: `dispatch error after request may have been sent: ${(err as Error).message?.slice(0, 160)}`,
      };
    }
  }
  await recordReceipt(effect, result);
  return result;
}

/** User-facing receipt sentence. Provider summaries (ids, codes) stay in the receipt row. */
const RECEIPT_TEXT: Record<DispatchResult["outcome"], string> = {
  succeeded: "Confirmed it went through",
  failed: "That didn't go through",
  uncertain: "Checking whether that went through",
};

async function recordReceipt(effect: AuthorizedEffect, result: DispatchResult) {
  await tx(async (c) => {
    await c.query(
      `insert into effect_receipts
         (effect_proposal_id, user_id, outcome, provider_receipt_ref, provider_request_id, evidence_refs, retry_posture)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        effect.id,
        effect.userId,
        result.outcome,
        result.providerReceiptRef,
        result.providerRequestId,
        JSON.stringify(result.evidenceRefs),
        result.outcome === "uncertain" ? "reconciling" : result.outcome === "failed" ? "safe" : "not_retryable",
      ],
    );
    await c.query(`update effect_proposals set status = $2, updated_at = now() where id = $1`, [
      effect.id,
      result.outcome,
    ]);
    await appendEvent(c, {
      userId: effect.userId,
      responsibilityId: effect.responsibilityId,
      kind: `effect.${result.outcome}`,
      detail: { effectId: effect.id, text: RECEIPT_TEXT[result.outcome], providerSummary: result.safeSummary },
      evidenceRefs: result.evidenceRefs,
    });
  });
  await trace({
    userId: effect.userId,
    responsibilityId: effect.responsibilityId,
    kind: "effect.receipt",
    detail: { effectId: effect.id, outcome: result.outcome, text: RECEIPT_TEXT[result.outcome] },
  });
}

/**
 * Reconcile an uncertain effect by provider readback (spec 13). Never re-dispatches
 * a non-idempotent effect unless readback proves absence.
 */
export async function reconcileEffect(userId: string, effectId: string): Promise<DispatchResult | null> {
  const { rows } = await query<EffectRow>(
    `select * from effect_proposals where user_id = $1 and id = $2 and status = 'uncertain'`,
    [userId, effectId],
  );
  const e = rows[0];
  if (!e) return null;
  const effect = toAuthorized(e);
  const d = getDispatcher(e.provider, e.action);
  if (!d?.readback) return null;
  const settled = await d.readback(effect);
  if (!settled) return null;
  if (settled.outcome === "succeeded") {
    await recordReceipt(effect, settled);
    return settled;
  }
  // Readback proved absence: a new logical attempt may run under a new idempotency key.
  await query(
    `update effect_proposals set status = 'authorized', attempt = attempt + 1,
            idempotency_key = idempotency_key || ':' || (attempt + 1), updated_at = now()
      where id = $1 and status = 'uncertain'`,
    [e.id],
  );
  return executeEffect(userId, effectId);
}
