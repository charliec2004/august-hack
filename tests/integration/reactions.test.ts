/**
 * Tapback reactions against the Neon `test` branch: one reaction per user per
 * message (a new one replaces the old), removable, and user-scoped.
 * Skipped when TEST_DATABASE_URL is absent.
 */
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";

const enabled = Boolean(process.env.TEST_DATABASE_URL);
const d = enabled ? describe : describe.skip;

d("message reactions (real Postgres)", async () => {
  const { query, getPool } = await import("@/server/db/client");
  const { ensureUser } = await import("@/server/auth/currentUser");
  const { ensurePrimaryThread, insertMessage } = await import("@/server/db/messages");
  const { setReaction, clearReaction, reactionsFor } = await import("@/server/db/reactions");

  const user = await ensureUser(`test-reactions-${randomUUID()}`);
  const other = await ensureUser(`test-reactions-${randomUUID()}`);
  const threadId = await ensurePrimaryThread(user.id);
  const msg = await insertMessage({ threadId, userId: user.id, role: "assistant", content: "Booked Nopa for 7:30." });

  afterAll(async () => {
    await query(`delete from message_reactions where user_id = any($1::uuid[])`, [[user.id, other.id]]);
    await query(`delete from messages where user_id = $1`, [user.id]);
    await query(`delete from threads where user_id = $1`, [user.id]);
    await query(`delete from app_users where id = any($1::uuid[])`, [[user.id, other.id]]);
    await getPool().end();
  });

  it("replaces on change: one reaction per user per message", async () => {
    expect(await setReaction(user.id, msg.id, "👍")).toMatchObject({ emoji: "👍" });
    expect(await setReaction(user.id, msg.id, "❤️")).toMatchObject({ emoji: "❤️" });
    const { rows } = await query(`select emoji from message_reactions where message_id = $1`, [msg.id]);
    expect(rows).toEqual([{ emoji: "❤️" }]);
    expect((await reactionsFor(user.id, [msg.id])).get(msg.id)?.emoji).toBe("❤️");
  });

  it("removes, and another user cannot react to a message they don't own", async () => {
    expect(await setReaction(other.id, msg.id, "👎")).toBeNull();
    expect(await clearReaction(user.id, msg.id)).toBe(true);
    expect((await reactionsFor(user.id, [msg.id])).size).toBe(0);
  });

  it("rejects anything outside the six tapbacks at the database", async () => {
    await expect(
      query(`insert into message_reactions (user_id, message_id, emoji) values ($1, $2, '🔥')`, [user.id, msg.id]),
    ).rejects.toThrow();
  });
});
