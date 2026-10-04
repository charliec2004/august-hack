import { currentUser } from "@/server/auth/currentUser";
import { buildTimeline } from "@/server/timeline";

export const dynamic = "force-dynamic";

/**
 * The conversation of record merged with activity lines and approval cards,
 * in time order, as AI SDK UIMessages (assistant-ui initial load and sync).
 */
export async function GET() {
  const user = await currentUser();
  return Response.json(await buildTimeline(user.id));
}
