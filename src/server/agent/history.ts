import "server-only";

import type { ModelMessage } from "ai";
import { stripHistoryLines } from "@/lib/genui";
import { reactionHistoryLine } from "@/lib/tapbacks";
import { recentMessages, type MessageRow } from "@/server/db/messages";
import { reactionsFor, type ReactionRow } from "@/server/db/reactions";

/**
 * Pure: the model's view of the recent conversation. Each tapback follows the
 * message it was put on as one compact bracketed line (a user-role note, since
 * the user made it). Reactions are context, never instructions.
 */
export function toModelHistory(
  messages: Pick<MessageRow, "id" | "role" | "content">[],
  reactions: Map<string, Pick<ReactionRow, "emoji">>,
  who: string,
): ModelMessage[] {
  const out: ModelMessage[] = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    out.push(m.role === "user" ? { role: "user", content: m.content } : { role: "assistant", content: m.content });
    const r = reactions.get(m.id);
    if (r) out.push({ role: "user", content: reactionHistoryLine(who, r.emoji, stripHistoryLines(m.content) || m.content) });
  }
  return out;
}

/** Recent tail of the thread, with tapbacks, ready for the Brain. */
export async function brainHistory(userId: string, threadId: string, limit: number): Promise<ModelMessage[]> {
  const rows = await recentMessages(userId, threadId, limit);
  const reactions = await reactionsFor(
    userId,
    rows.map((m) => m.id),
  );
  return toModelHistory(rows, reactions, process.env.DEMO_USER_NAME || "The user");
}
