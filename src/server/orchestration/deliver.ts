import "server-only";

import { generateText } from "ai";
import { query } from "@/server/db/client";
import { ensurePrimaryThread, insertMessage } from "@/server/db/messages";
import { getResponsibility } from "@/server/db/responsibilities";
import { trace } from "@/server/db/traces";
import { modelFor } from "@/server/agent/model";
import { BRAIN_DELIVERY_PROMPT } from "@/server/agent/prompts/brain";
import type { WorkerReport } from "@/server/types/domain";

export type DeliveryKind = "completed" | "needs_approval" | "needs_input" | "failed" | "waiting";

/**
 * Brain Core owns final wording (spec 6). Workers never speak to the user; this
 * turns a worker report into at most one short message, and only when it is
 * worth interrupting for (spec 16 notification restraint).
 */
export async function deliverUpdate(input: {
  userId: string;
  responsibilityId: string;
  kind: DeliveryKind;
  report: WorkerReport;
}) {
  const { userId, responsibilityId, kind, report } = input;
  const last = await query<{ kind: string; summary: string }>(
    `select safe_detail->>'deliveryKind' as kind, safe_detail->>'summary' as summary
       from trace_events
      where user_id = $1 and responsibility_id = $2 and event_kind = 'brain.delivered'
      order by created_at desc limit 1`,
    [userId, responsibilityId],
  );
  const prev = last.rows[0];
  // Repeated identical waiting/failure is not new information.
  if (prev && prev.kind === kind && (kind === "waiting" || kind === "failed")) return;

  const resp = await getResponsibility(userId, responsibilityId);
  if (!resp) return;
  const { rows: u } = await query<{ timezone: string }>(`select timezone from app_users where id = $1`, [userId]);
  const tz = u[0]?.timezone ?? "UTC";
  const nextCheck = resp.next_wake_at
    ? resp.next_wake_at.toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" })
    : null;

  let text: string;
  try {
    const out = await generateText({
      model: modelFor("brain"),
      system: BRAIN_DELIVERY_PROMPT,
      prompt: JSON.stringify({
        deliveryKind: kind,
        responsibility: { title: resp.title, goal: resp.goal, constraints: resp.constraints },
        workerReport: { status: report.status, summary: report.summary, blocker: report.blocker },
        nextCheckLocalTime: nextCheck,
      }),
      abortSignal: AbortSignal.timeout(30_000),
    });
    text = out.text.trim();
  } catch {
    text = fallbackText(kind, resp.title, report, nextCheck);
  }
  if (!text) return;

  const threadId = await ensurePrimaryThread(userId);
  const msg = await insertMessage({
    threadId,
    userId,
    role: "assistant",
    content: text,
    parts: [{ type: "text", text }],
    responsibilityId,
  });
  await trace({
    userId,
    responsibilityId,
    kind: "brain.delivered",
    detail: { deliveryKind: kind, messageId: msg.id, summary: report.summary.slice(0, 200) },
  });
}

function fallbackText(kind: DeliveryKind, title: string, report: WorkerReport, nextCheck: string | null) {
  switch (kind) {
    case "completed":
      return `${title}: done. ${report.summary}`;
    case "needs_approval":
      return `${title}: I have something ready. It needs your OK before I go ahead.`;
    case "needs_input":
      return report.blocker ?? `${title}: I need a quick answer from you to keep going.`;
    case "failed":
      return `${title}: I couldn't find a safe way to finish this. ${report.summary}`;
    case "waiting":
      return nextCheck
        ? `Nothing good for ${title.toLowerCase()} yet. I'll check again around ${nextCheck}.`
        : `Nothing good for ${title.toLowerCase()} yet. I'll keep checking.`;
  }
}
