import { z } from "zod";
import { currentUser } from "@/server/auth/currentUser";
import { ApprovalConflict } from "@/server/effects/approve";
import { resolveApproval } from "@/server/orchestration/approvals";

const body = z.object({
  decision: z.enum(["approved", "denied"]),
  proposalHash: z.string().startsWith("sha256:"),
});

/** Approve or deny one exact frozen effect. Identity is server-derived. */
export const maxDuration = 300;

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "bad_request" }, { status: 400 });
  const user = await currentUser();
  try {
    await resolveApproval({
      userId: user.id,
      effectId: id,
      decision: parsed.data.decision,
      shownProposalHash: parsed.data.proposalHash,
    });
    return Response.json({ ok: true });
  } catch (e) {
    if (e instanceof ApprovalConflict) return Response.json({ error: e.message }, { status: 409 });
    throw e;
  }
}
