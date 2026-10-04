import "server-only";

import { query } from "./client";

export type NewEvidence = {
  userId: string;
  responsibilityId: string | null;
  provider: string;
  sourceUrl?: string | null;
  sourceRef?: string | null;
  /** Bounded, model-safe summary. Never secrets. */
  safeSummary: string;
  /** Optional structured payload; stored, not shown to the model by default. */
  payload?: unknown;
  expiresAt?: Date | null;
};

/** Persist one evidence record and return its id. */
export async function recordEvidence(e: NewEvidence): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `insert into evidence_records
       (user_id, responsibility_id, provider, source_url, source_ref, safe_summary, payload, expires_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     returning id`,
    [
      e.userId,
      e.responsibilityId,
      e.provider,
      e.sourceUrl ?? null,
      e.sourceRef ?? null,
      e.safeSummary.slice(0, 4000),
      e.payload === undefined ? null : JSON.stringify(e.payload),
      e.expiresAt ?? null,
    ],
  );
  return rows[0].id;
}

export async function listEvidence(userId: string, responsibilityId: string) {
  const { rows } = await query<{
    id: string;
    provider: string;
    source_url: string | null;
    source_ref: string | null;
    safe_summary: string;
    observed_at: Date;
  }>(
    `select id, provider, source_url, source_ref, safe_summary, observed_at
       from evidence_records
      where user_id = $1 and responsibility_id = $2
      order by observed_at desc
      limit 50`,
    [userId, responsibilityId],
  );
  return rows;
}
