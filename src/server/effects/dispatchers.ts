import "server-only";

import { applyEnvironmentChangeAuthorized } from "@/server/computers/environment";
import { runComputerExternalAuthorized } from "@/server/computers/runtime";
import { mailFindSent, mailSendAuthorized } from "@/server/providers/agentmail";
import { executorExecuteAuthorized } from "@/server/providers/executor";
import { browserCommitAuthorized } from "@/server/providers/kernel";
import { registerDispatcher } from "./registry";
import type { AuthorizedEffect, DispatchResult } from "./types";

/**
 * provider.action -> adapter registrations. Imported for side effects by
 * execute.ts only; this is the single place adapters become executable.
 */

registerDispatcher("agentmail.send_email", {
  dispatch: mailSendAuthorized,
  // Readback for uncertain sends: did a message with this subject reach these recipients?
  readback: async (effect: AuthorizedEffect): Promise<DispatchResult | null> => {
    const a = effect.canonicalArgs as { to?: string[] | string; subject?: string };
    const to = Array.isArray(a.to) ? a.to[0] : a.to;
    if (!to || !a.subject) return null;
    const res = await mailFindSent({
      userId: effect.userId,
      responsibilityId: effect.responsibilityId,
      to,
      subject: a.subject,
      since: new Date(Date.now() - 24 * 3600_000),
    });
    if (res.status !== "succeeded" || !res.data) return null;
    return res.data.found
      ? {
          outcome: "succeeded",
          providerReceiptRef: res.data.messageId,
          providerRequestId: null,
          evidenceRefs: res.evidenceRefs,
          safeSummary: `Confirmed sent to ${to} (readback).`,
        }
      : {
          outcome: "failed",
          providerReceiptRef: null,
          providerRequestId: null,
          evidenceRefs: res.evidenceRefs,
          safeSummary: "Readback found no sent message.",
        };
  },
});

registerDispatcher("kernel.book", { dispatch: browserCommitAuthorized });
registerDispatcher("kernel.submit_form", { dispatch: browserCommitAuthorized });
registerDispatcher("executor.calendar.create_event", { dispatch: executorExecuteAuthorized });
registerDispatcher("executor.calendar.update_event", { dispatch: executorExecuteAuthorized });
registerDispatcher("computer.user_environment_change", { dispatch: applyEnvironmentChangeAuthorized });
registerDispatcher("computer.computer_external", { dispatch: runComputerExternalAuthorized });
