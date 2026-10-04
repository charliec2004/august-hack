import { z } from "zod";
import { currentUser } from "@/server/auth/currentUser";
import { ApprovalConflict } from "@/server/effects/approve";
import { reviseAndSend } from "@/server/orchestration/approvals";

const body = z.object({
  /** Hash of the proposal the user started editing from. */
  shownProposalHash: z.string().startsWith("sha256:"),
  to: z.array(z.string().trim().min(3).max(320)).min(1).max(20),
  subject: z.string().max(300),
  body: z.string().max(50_000),
  sendAt: z.iso.datetime({ offset: true }).nullish(),
});

/**
 * Send the user's edited version of a proposed email. The original is denied
 * (superseded) and a new user-authored proposal is approved and executed, or
 * scheduled. Only to/subject/body are editable.
 */
export const maxDuration = 300;

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "bad_request" }, { status: 400 });
  const user = await currentUser();
  try {
    const res = await reviseAndSend({
      userId: user.id,
      effectId: id,
      shownProposalHash: parsed.data.shownProposalHash,
      edit: { to: parsed.data.to, subject: parsed.data.subject, body: parsed.data.body },
      sendAt: parsed.data.sendAt,
    });
    return Response.json({ ok: true, ...res });
  } catch (e) {
    if (e instanceof ApprovalConflict) return Response.json({ error: e.message }, { status: 409 });
    throw e;
  }
}
