import "server-only";

import { query } from "@/server/db/client";
import { knownIn, sanitizeGeneratedHtml, type SanitizedHtml } from "@/lib/htmlImages";

const EVIDENCE_DAYS = 7;

/**
 * Text a remote URL must appear in to be shown: this person's evidence from
 * the last week, and their own recent messages. August's own past replies are
 * not a source, since they could repeat an invented URL.
 */
async function knownUrlCorpus(userId: string, extra = ""): Promise<string> {
  const [evidence, messages] = await Promise.all([
    query<{ text: string }>(
      `select concat_ws(' ', source_url, safe_summary, left(payload::text, 20000)) as text
         from evidence_records
        where user_id = $1 and observed_at > now() - make_interval(days => $2)
        order by observed_at desc limit 300`,
      [userId, EVIDENCE_DAYS],
    ),
    query<{ text: string }>(
      `select content as text from messages
        where user_id = $1 and role = 'user'
        order by created_at desc limit 40`,
      [userId],
    ),
  ]);
  return [extra, ...evidence.rows.map((r) => r.text), ...messages.rows.map((r) => r.text)].join("\n");
}

/** Generated HTML with every unvetted remote URL removed, plus the image URLs its CSP may allow. */
export async function vetGeneratedHtml(userId: string, html: string, extraCorpus = ""): Promise<SanitizedHtml> {
  return sanitizeGeneratedHtml(html, knownIn(await knownUrlCorpus(userId, extraCorpus)));
}
