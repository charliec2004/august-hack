import { currentUser } from "@/server/auth/currentUser";
import { buildDetail } from "@/server/views";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const user = await currentUser();
  const detail = await buildDetail(user.id, id);
  if (!detail) return Response.json({ error: "not_found" }, { status: 404 });
  return Response.json(detail);
}
