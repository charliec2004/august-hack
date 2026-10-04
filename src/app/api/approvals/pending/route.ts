import { currentUser } from "@/server/auth/currentUser";
import { pendingApprovals } from "@/server/db/effects";
import { toApprovalView } from "@/server/effects/display";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await currentUser();
  return Response.json((await pendingApprovals(user.id)).map(toApprovalView));
}
