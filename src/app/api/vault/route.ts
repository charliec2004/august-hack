import { currentUser } from "@/server/auth/currentUser";
import { addLogin, listLogins, VaultInputError } from "@/server/vault/vault";

/**
 * Saved website logins. POST takes a password ONCE and hands it straight to
 * Kernel's vault; no response, log, or row ever contains it.
 */

export async function GET() {
  const user = await currentUser();
  return Response.json({ logins: await listLogins(user.id) });
}

export async function POST(req: Request) {
  const user = await currentUser();
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const str = (k: string) => (typeof body[k] === "string" ? (body[k] as string) : "");
  try {
    const login = await addLogin({
      userId: user.id,
      origin: str("origin"),
      username: str("username"),
      password: str("password"),
      label: str("label") || undefined,
      extraOrigins: Array.isArray(body.extraOrigins) ? body.extraOrigins.filter((o): o is string => typeof o === "string") : [],
    });
    return Response.json({ login }, { status: 201 });
  } catch (err) {
    if (err instanceof VaultInputError) return Response.json({ error: err.message }, { status: 400 });
    return Response.json({ error: (err as Error).message.slice(0, 200) }, { status: 502 });
  }
}
