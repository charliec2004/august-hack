import { currentUser } from "@/server/auth/currentUser";
import { buildState } from "@/server/views";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await currentUser();
  const state = await buildState(user.id);
  return Response.json(state.responsibilities);
}
