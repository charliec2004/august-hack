import "server-only";

import { query } from "@/server/db/client";
import type { ActivityItem } from "@/server/types/api";

/** Old rows narrated internal thread ids; they are never shown. */
const LEGACY = /thread [0-9a-f-]{8,}/i;

type TraceRow = {
  id: string;
  created_at: Date;
  responsibility_id: string | null;
  safe_detail: { text?: string; browserSessionId?: string | null };
};

/**
 * User-facing activity lines (trace_events with a safe `text`), oldest first.
 * `since` bounds the window; the newest `limit` rows are returned.
 */
export async function listActivity(
  userId: string,
  opts: { since?: Date | null; limit: number },
): Promise<ActivityItem[]> {
  const { rows } = await query<TraceRow>(
    `select id::text, created_at, responsibility_id, safe_detail from trace_events
      where user_id = $1 and coalesce(safe_detail->>'text','') <> ''
        and ($2::timestamptz is null or created_at >= $2)
      order by created_at desc, id desc limit $3`,
    [userId, opts.since ?? null, opts.limit],
  );
  return rows
    .reverse()
    .filter((t) => !LEGACY.test(t.safe_detail.text ?? ""))
    .map((t) => ({
      id: t.id,
      at: t.created_at.toISOString(),
      responsibilityId: t.responsibility_id,
      text: t.safe_detail.text ?? "",
      browserSessionId: t.safe_detail.browserSessionId ?? null,
    }));
}

/** Changes whenever a message, an activity line, or an effect's state changes. */
export async function timelineVersion(userId: string): Promise<string> {
  const { rows } = await query<{ v: string }>(
    `select concat_ws('|',
        (select max(created_at)::text from messages where user_id = $1),
        (select max(id)::text from trace_events where user_id = $1 and safe_detail ? 'text'),
        (select max(updated_at)::text from effect_proposals where user_id = $1)) as v`,
    [userId],
  );
  return rows[0]?.v ?? "";
}
