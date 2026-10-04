import "server-only";

import { query } from "./client";

export type MessageRow = {
  id: string;
  thread_id: string;
  user_id: string;
  role: "user" | "assistant" | "system";
  content: string;
  authority_kind: string;
  parts: unknown[] | null;
  responsibility_id: string | null;
  created_at: Date;
};

/** The demo user's single primary thread (created on first use). */
export async function ensurePrimaryThread(userId: string): Promise<string> {
  const existing = await query<{ id: string }>(
    `select id from threads where user_id = $1 order by created_at asc limit 1`,
    [userId],
  );
  if (existing.rows[0]) return existing.rows[0].id;
  const { rows } = await query<{ id: string }>(
    `insert into threads (user_id, title) values ($1, 'August') returning id`,
    [userId],
  );
  return rows[0].id;
}

/**
 * Persist a message. `authority_kind`:
 *  - 'user_instruction' for authenticated user text (the only kind that may authorize effects)
 *  - 'none' for assistant output and system notes
 */
export async function insertMessage(m: {
  threadId: string;
  userId: string;
  role: MessageRow["role"];
  content: string;
  parts?: unknown[] | null;
  responsibilityId?: string | null;
}): Promise<MessageRow> {
  const authority = m.role === "user" ? "user_instruction" : "none";
  const { rows } = await query<MessageRow>(
    `insert into messages (thread_id, user_id, role, content, authority_kind, parts, responsibility_id)
     values ($1, $2, $3, $4, $5, $6, $7)
     returning *`,
    [
      m.threadId,
      m.userId,
      m.role,
      m.content,
      authority,
      m.parts ? JSON.stringify(m.parts) : null,
      m.responsibilityId ?? null,
    ],
  );
  return rows[0];
}

export async function recentMessages(userId: string, threadId: string, limit = 30) {
  const { rows } = await query<MessageRow>(
    `select * from (
        select * from messages where user_id = $1 and thread_id = $2
        order by created_at desc limit $3
      ) t order by created_at asc`,
    [userId, threadId, limit],
  );
  return rows;
}

/** Authenticated user messages only: the reviewer's trusted intent window. */
export async function recentUserInstructions(userId: string, threadId: string, limit = 8) {
  const { rows } = await query<{ id: string; content: string; created_at: Date }>(
    `select id, content, created_at from (
        select id, content, created_at from messages
         where user_id = $1 and thread_id = $2 and role = 'user' and authority_kind = 'user_instruction'
         order by created_at desc limit $3
      ) t order by created_at asc`,
    [userId, threadId, limit],
  );
  return rows;
}
