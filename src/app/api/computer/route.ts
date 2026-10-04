import { currentUser } from "@/server/auth/currentUser";
import { computerStatus } from "@/server/surfaces/computer";

export const dynamic = "force-dynamic";

/** August's own computer: availability and installed tools. */
export async function GET() {
  const user = await currentUser();
  try {
    return Response.json(await computerStatus(user.id));
  } catch {
    return Response.json({ error: "Couldn't load August's computer right now." }, { status: 502 });
  }
}
