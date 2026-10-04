import "server-only";

import { embed, embedMany, generateObject } from "ai";
import { z } from "zod";
import { query } from "@/server/db/client";
import { trace } from "@/server/db/traces";
import { embeddingModel, gatewayProviderOptions, modelFor } from "@/server/agent/model";

/**
 * Long-term personal memory (spec 14). Advisory context only: retrieved
 * memories are labeled as memory and never change what August is allowed to do.
 */

const toVector = (v: number[]) => `[${v.join(",")}]`;
/** Near-duplicates of an existing memory are skipped. */
const DUPLICATE_SIMILARITY = 0.9;

const candidateSchema = z.object({
  memories: z
    .array(
      z.object({
        kind: z.enum(["preference", "fact", "relationship", "routine"]),
        text: z.string().min(3).max(240).describe("One self-contained statement, third person, e.g. 'Charlie prefers aisle seats.'"),
        sourceType: z.enum(["user_stated", "assistant_inferred"]),
        importance: z.number().min(0).max(1),
        confidence: z.number().min(0).max(1),
      }),
    )
    .max(5),
});

const CAPTURE_PROMPT = `Extract durable personal memories from the person's latest message (and August's reply only for context).
Keep only things likely to stay true and useful beyond the current task: stable preferences, facts about their life,
people and relationships, routines. Do NOT keep one-off task details (tonight's dinner time, a specific booking),
facts about the outside world (a restaurant's hours), or anything August merely guessed unless clearly useful
(then mark it assistant_inferred with low confidence). Return an empty list when there is nothing durable.`;

/** Capture durable memories from one exchange. Best-effort; never throws. */
export async function captureMemories(input: {
  userId: string;
  sourceMessageId: string;
  userText: string;
  assistantText: string;
}): Promise<void> {
  try {
    const { object } = await generateObject({
      model: modelFor("memory"),
      schema: candidateSchema,
      system: `${CAPTURE_PROMPT}\nThe person's name is ${process.env.DEMO_USER_NAME ?? "the user"}; write memories about them by name.`,
      prompt: `Person: ${input.userText.slice(0, 3000)}\n\nAugust: ${input.assistantText.slice(0, 1500)}`,
      providerOptions: gatewayProviderOptions,
      abortSignal: AbortSignal.timeout(45_000),
    });
    if (object.memories.length === 0) return;
    const { embeddings } = await embedMany({ model: embeddingModel(), values: object.memories.map((m) => m.text) });
    for (const [i, m] of object.memories.entries()) {
      const vec = toVector(embeddings[i]);
      const dup = await query<{ id: string }>(
        `select id from memory_records
          where user_id = $1 and forgotten_at is null and 1 - (embedding <=> $2::vector) >= $3
          limit 1`,
        [input.userId, vec, DUPLICATE_SIMILARITY],
      );
      if (dup.rows[0]) continue;
      await query(
        `insert into memory_records (user_id, kind, text, source_message_id, source_type, confidence, importance, embedding)
         values ($1, $2, $3, $4, $5, $6, $7, $8::vector)`,
        [input.userId, m.kind, m.text, input.sourceMessageId, m.sourceType, m.confidence, m.importance, vec],
      );
      await trace({ userId: input.userId, kind: "memory.captured", detail: { kind: m.kind } });
    }
  } catch (e) {
    console.error("memory capture failed:", (e as Error).message);
  }
}

export type RetrievedMemory = { id: string; kind: string; text: string; sourceType: string };

/**
 * Top memories for a query, ranked per spec 14:
 * 0.55 similarity + 0.15 recency + 0.20 importance + 0.10 confidence.
 */
export async function retrieveMemories(userId: string, queryText: string, limit = 6): Promise<RetrievedMemory[]> {
  if (!queryText.trim()) return [];
  try {
    const { embedding } = await embed({ model: embeddingModel(), value: queryText.slice(0, 2000) });
    const { rows } = await query<RetrievedMemory & { score: number }>(
      `select id, kind, text, source_type as "sourceType",
              0.55 * (1 - (embedding <=> $2::vector))
            + 0.15 * exp(-extract(epoch from now() - coalesce(last_used_at, created_at)) / (86400 * 30))
            + 0.20 * importance + 0.10 * confidence as score
         from memory_records
        where user_id = $1 and forgotten_at is null and (expires_at is null or expires_at > now())
        order by score desc
        limit $3`,
      [userId, toVector(embedding), limit],
    );
    const relevant = rows.filter((r) => r.score > 0.45);
    if (relevant.length) {
      await query(`update memory_records set last_used_at = now() where id = any($1::uuid[])`, [relevant.map((r) => r.id)]);
    }
    return relevant;
  } catch (e) {
    console.error("memory retrieval failed:", (e as Error).message);
    return [];
  }
}

/** Forget memories matching what the user asked to forget. Marks forgotten immediately. */
export async function forgetMemories(userId: string, about: string): Promise<string[]> {
  const { embedding } = await embed({ model: embeddingModel(), value: about });
  const { rows } = await query<{ id: string; text: string }>(
    `update memory_records set forgotten_at = now()
      where id in (
        select id from memory_records
         where user_id = $1 and forgotten_at is null and 1 - (embedding <=> $2::vector) >= 0.6
         order by embedding <=> $2::vector limit 3)
      returning id, text`,
    [userId, toVector(embedding)],
  );
  return rows.map((r) => r.text);
}

export function formatMemories(memories: RetrievedMemory[]): string {
  if (memories.length === 0) return "(nothing relevant)";
  return memories
    .map((m) => `- ${m.text}${m.sourceType === "assistant_inferred" ? " (inferred, low confidence)" : ""}`)
    .join("\n");
}
