import "server-only";

import { runInBackground } from "@/server/background";
import { decideApproval } from "@/server/effects/approve";
import { executeEffect } from "@/server/effects/execute";
import { kickResponsibility } from "./wakes";

/**
 * Apply the user's decision. Approved: execute that exact frozen proposal once,
 * then resume the responsibility so the Worker verifies the receipt and settles.
 * Denied: resume so August can choose another plan (the denial is final for
 * that proposal; a changed proposal is a new one reviewed again).
 */
export async function resolveApproval(input: {
  userId: string;
  effectId: string;
  decision: "approved" | "denied";
  shownProposalHash: string;
}) {
  const { responsibilityId, decision } = await decideApproval(input);
  runInBackground("approval", async () => {
    if (decision === "approved") await executeEffect(input.userId, input.effectId);
    await kickResponsibility({
      userId: input.userId,
      responsibilityId,
      source: "user",
      causeRef: `approval:${input.effectId}:${decision}`,
    });
  });
}
