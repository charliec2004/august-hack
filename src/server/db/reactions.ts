import "server-only";

import type { Tapback } from "@/lib/tapbacks";
import { query } from "./client";

export type ReactionRow = { message_id: string; emoji: Tapback; created_at: Date };

/**
 * Set the user's one reaction on a message, replacing any earlier one. Only a
 * message the user owns can be reacted to. Returns null when it doesn't exist.
 */
export async function setReaction(userId: string, messageId: string, emoji: Tapback): Promise<ReactionRow | null> {
  const { rows } = await query<ReactionRow>(
    `insert into message_reactions (user_id, message_id, emoji)
     select $1, m.id, $3 from messages m where m.id = $2 and m.user_id = $1 and m.role <> 'system'
     on conflict (user_id, message_id) do update set emoji = excluded.emoji, created_at = now()
     returning message_id, emoji, created_at`,
    [userId, messageId, emoji],
  );
  return rows[0] ?? null;
}

/** Remove the user's reaction on a message. True when one was removed. */
export async function clearReaction(userId: string, messageId: string): Promise<boolean> {
  const { rowCount } = await query(`delete from message_reactions where user_id = $1 and message_id = $2`, [
    userId,
    messageId,
  ]);
  return (rowCount ?? 0) > 0;
}

/** The user's reactions on these messages, keyed by message id. */
export async function reactionsFor(userId: string, messageIds: string[]): Promise<Map<string, ReactionRow>> {
  if (messageIds.length === 0) return new Map();
  const { rows } = await query<ReactionRow>(
    `select message_id, emoji, created_at from message_reactions
      where user_id = $1 and message_id = any($2::uuid[])`,
    [userId, messageIds],
  );
  return new Map(rows.map((r) => [r.message_id, r]));
}
