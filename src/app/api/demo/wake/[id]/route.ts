import { currentUser } from "@/server/auth/currentUser";
import { demoRunNextWake } from "@/server/orchestration/demo";

/**
 * Development-only fast-forward: advances the responsibility's real persisted
 * wake through the real claim/resume path. Never fabricates provider results.
 */
export const maxDuration = 300;

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (process.env.AUGUST_ENV === "production") return Response.json({ error: "disabled" }, { status: 404 });
  const { id } = await ctx.params;
  const user = await currentUser();
  const result = await demoRunNextWake(user.id, id);
  return Response.json(result, { status: result.ok ? 200 : 409 });
}
