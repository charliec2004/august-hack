import { currentUser } from "@/server/auth/currentUser";
import { cancelResponsibility } from "@/server/orchestration/cancel";

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const user = await currentUser();
  const ok = await cancelResponsibility(user.id, id, "Cancelled from the app");
  return Response.json({ ok }, { status: ok ? 200 : 409 });
}
