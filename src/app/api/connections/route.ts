import { currentUser } from "@/server/auth/currentUser";
import { listConnections } from "@/server/surfaces/connections";

export const dynamic = "force-dynamic";

/** The user's connected apps through Executor, in human terms. */
export async function GET() {
  const user = await currentUser();
  return Response.json(await listConnections(user.id));
}
