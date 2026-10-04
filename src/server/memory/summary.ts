import "server-only";

import { generateText } from "ai";
import { query } from "@/server/db/client";
import { gatewayProviderOptions, modelFor } from "@/server/agent/model";

/** Messages kept verbatim for the Brain; everything older lives in the summary. */
export const VERBATIM_TAIL = 24;
/** Fold older messages in batches so the summary isn't rewritten every turn. */
const MIN_BATCH = 8;

const SUMMARY_PROMPT = `You maintain the running memory of one long conversation between a person and their assistant, August.
Update the summary with the new messages. Keep what matters for continuing the relationship and the work:
decisions, preferences the person stated, people and places mentioned, commitments August made, open questions,
and how things turned out. Drop pleasantries and step-by-step detail. Write compact plain prose in the third person
("Charlie asked…", "August found…"), at most ~400 words. Output only the summary.`;

export async function getThreadSummary(threadId: string): Promise<string | null> {
  const { rows } = await query<{ summary: string }>(`select summary from thread_summaries where thread_id = $1`, [threadId]);
  return rows[0]?.summary ?? null;
}

/**
 * Fold messages that have fallen out of the verbatim tail into the running
 * summary. Idempotent and incremental: only messages after `covers_until` and
 * before the tail are read. Safe to call after every turn.
 */
export async function updateThreadSummary(userId: string, threadId: string): Promise<void> {
  const { rows: tail } = await query<{ created_at: Date }>(
    `select created_at from messages where user_id = $1 and thread_id = $2
      order by created_at desc offset $3 limit 1`,
    [userId, threadId, VERBATIM_TAIL - 1],
  );
  const tailStart = tail[0]?.created_at;
  if (!tailStart) return;

  const { rows: current } = await query<{ summary: string; covers_until: Date; message_count: number }>(
    `select summary, covers_until, message_count from thread_summaries where thread_id = $1`,
    [threadId],
  );
  const prior = current[0];
  const { rows: fresh } = await query<{ role: string; content: string; created_at: Date }>(
    `select role, content, created_at from messages
      where user_id = $1 and thread_id = $2 and role <> 'system'
        and created_at < $3 and ($4::timestamptz is null or created_at > $4)
      order by created_at asc limit 200`,
    [userId, threadId, tailStart, prior?.covers_until ?? null],
  );
  if (fresh.length < MIN_BATCH) return;

  const transcript = fresh
    .map((m) => `${m.role === "user" ? "Person" : "August"}: ${m.content.slice(0, 1500)}`)
    .join("\n");
  const { text } = await generateText({
    model: modelFor("memory"),
    system: SUMMARY_PROMPT,
    prompt: `Current summary:\n${prior?.summary ?? "(none yet)"}\n\nNew messages:\n${transcript}`,
    providerOptions: gatewayProviderOptions,
    abortSignal: AbortSignal.timeout(60_000),
  });
  const summary = text.trim();
  if (!summary) return;
  await query(
    `insert into thread_summaries (thread_id, user_id, summary, covers_until, message_count)
     values ($1, $2, $3, $4, $5)
     on conflict (thread_id) do update set summary = excluded.summary, covers_until = excluded.covers_until,
       message_count = thread_summaries.message_count + excluded.message_count, updated_at = now()`,
    [threadId, userId, summary, fresh[fresh.length - 1].created_at, fresh.length],
  );
}
