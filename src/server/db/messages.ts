import "server-only";

import type { ChannelId } from "@/server/channels/capabilities";
import { query } from "./client";

/**
 * Who a message speaks for:
 *  - 'user_instruction': authenticated user text (the only kind that may authorize effects)
 *  - 'unverified_channel': user text from a channel whose sender authentication
 *    could not be confirmed (answered, never authorizing)
 *  - 'none': assistant output and system notes
 */
export type AuthorityKind = "user_instruction" | "unverified_channel" | "none";

export type MessageRow = {
  id: string;
  thread_id: string;
  user_id: string;
  role: "user" | "assistant" | "system";
  content: string;
  authority_kind: AuthorityKind;
  parts: unknown[] | null;
  channel: ChannelId;
  channel_ref: Record<string, unknown> | null;
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
 * Persist a message. User text defaults to 'user_instruction' (web chat is
 * authenticated); a channel that could not authenticate its sender passes
 * 'unverified_channel'. Non-user messages are always 'none'.
 */
export async function insertMessage(m: {
  threadId: string;
  userId: string;
  role: MessageRow["role"];
  content: string;
  parts?: unknown[] | null;
  responsibilityId?: string | null;
  channel?: ChannelId;
  channelRef?: Record<string, unknown> | null;
  authorityKind?: Exclude<AuthorityKind, "none">;
}): Promise<MessageRow> {
  const authority: AuthorityKind = m.role === "user" ? (m.authorityKind ?? "user_instruction") : "none";
  const { rows } = await query<MessageRow>(
    `insert into messages (thread_id, user_id, role, content, authority_kind, parts, responsibility_id, channel, channel_ref)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     returning *`,
    [
      m.threadId,
      m.userId,
      m.role,
      m.content,
      authority,
      m.parts ? JSON.stringify(m.parts) : null,
      m.responsibilityId ?? null,
      m.channel ?? "web",
      m.channelRef ? JSON.stringify(m.channelRef) : null,
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

/** The channel a message arrived on, and its provider reference (user-scoped). */
export async function messageChannel(
  userId: string,
  messageId: string,
): Promise<{ channel: ChannelId; channel_ref: Record<string, unknown> | null } | null> {
  const { rows } = await query<{ channel: ChannelId; channel_ref: Record<string, unknown> | null }>(
    `select channel, channel_ref from messages where user_id = $1 and id = $2`,
    [userId, messageId],
  );
  return rows[0] ?? null;
}
