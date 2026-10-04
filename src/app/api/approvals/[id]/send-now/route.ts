import { currentUser } from "@/server/auth/currentUser";
import { ApprovalConflict } from "@/server/effects/approve";
import { sendScheduledNow } from "@/server/orchestration/approvals";

/** Send a scheduled effect now instead of at its scheduled time. */
export const maxDuration = 300;

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const user = await currentUser();
  try {
    await sendScheduledNow({ userId: user.id, effectId: id });
    return Response.json({ ok: true });
  } catch (e) {
    if (e instanceof ApprovalConflict) return Response.json({ error: e.message }, { status: 409 });
    throw e;
  }
}
