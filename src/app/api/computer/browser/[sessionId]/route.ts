import { currentUser } from "@/server/auth/currentUser";
import { closeUserBrowser } from "@/server/browser/userBrowser";

export const dynamic = "force-dynamic";

/** Closes the user's own browser session. */
export async function DELETE(_req: Request, ctx: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await ctx.params;
  const user = await currentUser();
  try {
    const ok = await closeUserBrowser(user.id, sessionId);
    return Response.json({ ok }, { status: ok ? 200 : 404 });
  } catch {
    return Response.json({ error: "Couldn't close the browser right now." }, { status: 502 });
  }
}
