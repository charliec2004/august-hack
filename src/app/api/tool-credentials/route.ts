import { currentUser } from "@/server/auth/currentUser";
import { getActiveEnvironment } from "@/server/computers/environment";
import { listToolCredentials } from "@/server/credentials/store";
import type { ToolLogin } from "@/server/types/api";

export const dynamic = "force-dynamic";

/**
 * CLI logins: tools in the active environment that declare one, with status.
 * Never returns a value; stored logins for tools no longer installed are
 * listed (auth: null) so they can be removed.
 */
export async function GET() {
  const user = await currentUser();
  const [env, creds] = await Promise.all([getActiveEnvironment(user.id), listToolCredentials(user.id)]);
  const byTool = new Map(creds.map((c) => [c.toolKey, c]));
  const tools: ToolLogin[] = env.manifest.tools
    .filter((t) => t.auth)
    .map((t) => ({ toolKey: t.toolKey, auth: t.auth!, updatedAt: byTool.get(t.toolKey)?.updatedAt ?? null }));
  for (const c of creds) {
    if (!tools.some((t) => t.toolKey === c.toolKey)) tools.push({ toolKey: c.toolKey, auth: null, updatedAt: c.updatedAt });
  }
  return Response.json({ tools });
}
