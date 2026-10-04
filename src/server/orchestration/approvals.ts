import "server-only";

import { runInBackground } from "@/server/background";
import {
  cancelScheduledEffect,
  decideApproval,
  makeScheduledEffectDue,
} from "@/server/effects/approve";
import { executeEffect } from "@/server/effects/execute";
import { reviseEmailEffect, type EmailEdit } from "@/server/effects/revise";
import { kickResponsibility } from "./wakes";

/** Execute an approved effect once, then resume its responsibility to verify and settle. */
function executeAndResume(userId: string, effectId: string, responsibilityId: string) {
  runInBackground("approval", async () => {
    await executeEffect(userId, effectId);
    await kickResponsibility({ userId, responsibilityId, source: "user", causeRef: `approval:${effectId}:approved` });
  });
}

/**
 * Apply the user's decision. Approved: execute that exact frozen proposal once
 * (or leave it authorized until its send-later time; the wake scanner dispatches
 * it then), then resume the responsibility so the Worker verifies the receipt.
 * Denied: resume so August can choose another plan (the denial is final for
 * that proposal; a changed proposal is a new one reviewed again).
 */
export async function resolveApproval(input: {
  userId: string;
  effectId: string;
  decision: "approved" | "denied";
  shownProposalHash: string;
  sendAt?: string | null;
}) {
  const { responsibilityId, decision, scheduledFor } = await decideApproval(input);
  if (decision === "approved") {
    if (!scheduledFor) executeAndResume(input.userId, input.effectId, responsibilityId);
    return;
  }
  runInBackground("approval", () =>
    kickResponsibility({
      userId: input.userId,
      responsibilityId,
      source: "user",
      causeRef: `approval:${input.effectId}:denied`,
    }),
  );
}

/** The user edited the email and sent (or scheduled) their version. */
export async function reviseAndSend(input: {
  userId: string;
  effectId: string;
  shownProposalHash: string;
  edit: EmailEdit;
  sendAt?: string | null;
}) {
  const res = await reviseEmailEffect(input);
  if (!res.scheduledFor) executeAndResume(input.userId, res.effectId, res.responsibilityId);
  return { effectId: res.effectId, proposalHash: res.proposalHash };
}

export async function cancelSchedule(input: { userId: string; effectId: string }) {
  const { responsibilityId } = await cancelScheduledEffect(input);
  runInBackground("approval", () =>
    kickResponsibility({
      userId: input.userId,
      responsibilityId,
      source: "user",
      causeRef: `approval:${input.effectId}:denied`,
    }),
  );
}

export async function sendScheduledNow(input: { userId: string; effectId: string }) {
  const { responsibilityId } = await makeScheduledEffectDue(input);
  executeAndResume(input.userId, input.effectId, responsibilityId);
}
