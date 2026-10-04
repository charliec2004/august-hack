import { isTapback } from "@/lib/tapbacks";
import { currentUser } from "@/server/auth/currentUser";
import { clearReaction, setReaction } from "@/server/db/reactions";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Ctx = { params: Promise<{ id: string }> };

/**
 * Tapback on a message: one per user per message (a new one replaces the old).
 * A reaction is context for the next Brain turn; it never starts one.
 */
export async function POST(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  if (!UUID.test(id)) return Response.json({ error: "not_found" }, { status: 404 });
  const body = (await req.json().catch(() => null)) as { emoji?: unknown } | null;
  if (!isTapback(body?.emoji)) return Response.json({ error: "invalid_emoji" }, { status: 400 });
  const user = await currentUser();
  const row = await setReaction(user.id, id, body.emoji);
  if (!row) return Response.json({ error: "not_found" }, { status: 404 });
  return Response.json({ messageId: row.message_id, emoji: row.emoji });
}

export async function DELETE(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  if (!UUID.test(id)) return Response.json({ error: "not_found" }, { status: 404 });
  const user = await currentUser();
  await clearReaction(user.id, id);
  return Response.json({ messageId: id, emoji: null });
}
