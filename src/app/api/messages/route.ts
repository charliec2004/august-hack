import { currentUser } from "@/server/auth/currentUser";
import { ensurePrimaryThread, recentMessages } from "@/server/db/messages";

export const dynamic = "force-dynamic";

/** Conversation of record as AI SDK UIMessages (for assistant-ui initial/sync). */
export async function GET() {
  const user = await currentUser();
  const threadId = await ensurePrimaryThread(user.id);
  const rows = await recentMessages(user.id, threadId, 60);
  return Response.json(
    rows
      .filter((m) => m.role !== "system")
      .map((m) => ({
        id: m.id,
        role: m.role,
        parts: [{ type: "text", text: m.content }],
        metadata: { createdAt: m.created_at.toISOString(), responsibilityId: m.responsibility_id },
      })),
  );
}
