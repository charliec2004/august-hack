import { currentUser } from "@/server/auth/currentUser";
import { reconcileEffect } from "@/server/effects/execute";

/** Readback for an uncertain effect (spec 13). */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const user = await currentUser();
  const result = await reconcileEffect(user.id, id);
  return Response.json({ settled: Boolean(result), outcome: result?.outcome ?? null });
}
