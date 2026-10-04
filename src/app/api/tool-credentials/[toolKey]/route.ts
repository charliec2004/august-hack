import { currentUser } from "@/server/auth/currentUser";
import { CredentialInputError, deleteToolCredential, putToolCredential } from "@/server/credentials/store";

export const dynamic = "force-dynamic";

const TOOL_KEY = /^[a-z0-9][a-z0-9._+-]{0,63}$/;

/** Sets a tool's login: { env: { NAME: value } } or { file: string }. Write-only. */
export async function PUT(req: Request, ctx: { params: Promise<{ toolKey: string }> }) {
  const { toolKey } = await ctx.params;
  if (!TOOL_KEY.test(toolKey)) return Response.json({ error: "Unknown tool." }, { status: 404 });
  const user = await currentUser();
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON." }, { status: 400 });
  }
  try {
    const saved = await putToolCredential(user.id, toolKey, body);
    return Response.json({ tool: saved });
  } catch (err) {
    if (err instanceof CredentialInputError) return Response.json({ error: err.message }, { status: 400 });
    console.error("[tool-credentials] save failed:", (err as Error).name);
    return Response.json({ error: "Couldn't save this login." }, { status: 500 });
  }
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ toolKey: string }> }) {
  const { toolKey } = await ctx.params;
  if (!TOOL_KEY.test(toolKey)) return Response.json({ ok: false }, { status: 404 });
  const user = await currentUser();
  const ok = await deleteToolCredential(user.id, toolKey);
  return Response.json({ ok }, { status: ok ? 200 : 404 });
}
