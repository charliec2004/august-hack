import { currentUser } from "@/server/auth/currentUser";
import { computerWorkspace } from "@/server/surfaces/computer";

export const dynamic = "force-dynamic";

/** August's computer: live browsers, recent commands, files. */
export async function GET() {
  const user = await currentUser();
  try {
    return Response.json(await computerWorkspace(user.id));
  } catch {
    return Response.json({ error: "Couldn't load August's computer right now." }, { status: 502 });
  }
}
