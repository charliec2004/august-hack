import { currentUser } from "@/server/auth/currentUser";
import { deleteLogin } from "@/server/vault/vault";

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const user = await currentUser();
  try {
    const ok = await deleteLogin(user.id, id);
    return Response.json({ ok }, { status: ok ? 200 : 404 });
  } catch (err) {
    return Response.json({ error: (err as Error).message.slice(0, 200) }, { status: 502 });
  }
}
