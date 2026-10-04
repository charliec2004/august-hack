import { currentUser } from "@/server/auth/currentUser";
import { buildTimeline } from "@/server/timeline";

export const dynamic = "force-dynamic";

/**
 * The conversation of record merged with activity lines and approval cards,
 * in time order, as AI SDK UIMessages (assistant-ui initial load and sync).
 */
export async function GET(req: Request) {
  const user = await currentUser();
  const limit = Number(new URL(req.url).searchParams.get("limit")) || undefined;
  const { messages, hasEarlier } = await buildTimeline(user.id, { limit });
  return Response.json(messages, { headers: { "x-has-earlier": hasEarlier ? "1" : "0" } });
}
