import { currentUser } from "@/server/auth/currentUser";
import { buildState } from "@/server/views";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await currentUser();
  return Response.json(await buildState(user.id));
}
