import { currentUser } from "@/server/auth/currentUser";
import { openUserBrowser } from "@/server/browser/userBrowser";

export const dynamic = "force-dynamic";

/** Opens the user's own browser on August's computer (their profile, so sign-ins persist). */
export async function POST() {
  const user = await currentUser();
  try {
    return Response.json(await openUserBrowser(user.id));
  } catch {
    return Response.json({ error: "Couldn't open a browser right now." }, { status: 502 });
  }
}
