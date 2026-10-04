import "server-only";

import { applyEnvironmentChangeAuthorized } from "@/server/computers/environment";
import { runComputerExternalAuthorized } from "@/server/computers/runtime";
import { mailFindSent, mailSendAuthorized } from "@/server/providers/agentmail";
import { executorExecuteAuthorized } from "@/server/providers/executor";
import { browserCommitAuthorized } from "@/server/providers/kernel";
import { query } from "@/server/db/client";
import { registerDispatcher } from "./registry";
import type { AuthorizedEffect, DispatchResult } from "./types";

/**
 * provider.action -> adapter registrations. Imported for side effects by
 * execute.ts only; this is the single place adapters become executable.
 */

/**
 * After a successful send, link the provider thread to the responsibility so an
 * inbound reply wakes it.
 */
async function linkMailThread(effect: AuthorizedEffect, result: DispatchResult) {
  const { rows } = await query<{ thread_id: string | null }>(
    `select payload->>'threadId' as thread_id from evidence_records
      where user_id = $1 and id = any($2::uuid[]) limit 1`,
    [effect.userId, result.evidenceRefs],
  );
  const threadId = rows[0]?.thread_id;
  const inbox = (effect.canonicalArgs.fromInbox as string | undefined) ?? process.env.AGENTMAIL_INBOX_ID;
  if (!threadId || !inbox) return;
  await query(
    `insert into mail_threads (user_id, responsibility_id, inbox_id, provider_thread_id)
     values ($1, $2, $3, $4) on conflict (inbox_id, provider_thread_id) do nothing`,
    [effect.userId, effect.responsibilityId, inbox, threadId],
  );
}

registerDispatcher("agentmail.send_email", {
  dispatch: async (effect) => {
    const result = await mailSendAuthorized(effect);
    if (result.outcome === "succeeded") await linkMailThread(effect, result);
    return result;
  },
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
