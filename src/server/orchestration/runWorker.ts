import "server-only";

import { randomUUID } from "node:crypto";
import { query, tx } from "@/server/db/client";
import { effectsForResponsibility } from "@/server/db/effects";
import { listEvidence } from "@/server/db/evidence";
import { getResponsibility, isTerminal, transition } from "@/server/db/responsibilities";
import { trace } from "@/server/db/traces";
import type { WakeRow } from "@/server/db/wakeups";
import { nextPendingWake, scheduleWake } from "@/server/db/wakeups";
import {
  createWorkerSession,
  finishRun,
  heartbeat,
  latestReports,
  latestSessionFor,
  startRun,
} from "@/server/db/workers";
import { runWorkerAgent } from "@/server/agent/worker";
import { releaseComputersInBackground } from "@/server/computers/releaseOnTerminal";
import type { CapabilityName, WorkerReport } from "@/server/types/domain";
import { deliverUpdate } from "./deliver";

const LEASE_MS = 4 * 60_000;
const FALLBACK_WAKE_MS = 30 * 60_000;

export const DEFAULT_CAPABILITIES: CapabilityName[] = [
  "exa.search",
  "executor.read",
  "kernel.read",
  "kernel.commit",
  "agentmail.read",
  "agentmail.send",
  "sprite.exec",
];

/**
 * Run one Worker activation for a claimed wake. The responsibility is
 * reconstructed entirely from Postgres; nothing depends on in-memory state.
 */
export async function runWorkerForWake(wake: WakeRow): Promise<string> {
  const userId = wake.user_id;
  const resp = await getResponsibility(userId, wake.responsibility_id);
  if (!resp || isTerminal(resp.status)) return "skipped_terminal";

  let session = await latestSessionFor(userId, resp.id);
  if (!session) {
    session = await createWorkerSession({
      userId,
      responsibilityId: resp.id,
      assignmentRef: `asg_${resp.id}_${Date.now()}`,
      objective: resp.goal,
      successCriteria: resp.success_criteria,
      constraints: resp.constraints,
      capabilities: DEFAULT_CAPABILITIES,
    });
  }

  const run = await startRun({
    userId,
    sessionId: session.id,
    responsibilityId: resp.id,
    leaseOwner: `run-${randomUUID().slice(0, 8)}`,
    leaseMs: LEASE_MS,
  });
  if (!run) return "skipped_live_run";

  const prior = resp.status;
  await tx((c) =>
    transition(c, {
      userId,
      responsibilityId: resp.id,
      to: "running",
      waitingOn: null,
      eventText: wake.source === "schedule" ? "Checking again" : "Working on it",
    }),
  );
  await trace({
    userId,
    responsibilityId: resp.id,
    workerRunId: run.id,
    kind: "worker.started",
    detail: { text: wake.source === "schedule" ? "Checking again" : undefined, wakeSource: wake.source },
  });

  const beat = setInterval(() => void heartbeat(run.id, LEASE_MS).catch(() => {}), 60_000);
  let report: WorkerReport;
  try {
    const [reports, evidence, effects] = await Promise.all([
      latestReports(userId, resp.id, 3),
      listEvidence(userId, resp.id),
      effectsForResponsibility(userId, resp.id),
    ]);
    report = await runWorkerAgent({
      userId,
      responsibility: resp,
      session,
      runId: run.id,
      wake: { source: wake.source, causeRef: wake.cause_ref, priorStatus: prior },
      priorReports: reports.map((r) => r.report),
      evidence: evidence.slice(0, 15).map((e) => ({
        id: e.id,
        provider: e.provider,
        url: e.source_url,
        summary: e.safe_summary.slice(0, 400),
        observedAt: e.observed_at.toISOString(),
      })),
      effects: effects.map((e) => ({
        id: e.id,
        action: `${e.provider}.${e.action}`,
        // An approved send-later effect is handled: it dispatches on its own at that time.
        status:
          e.status === "authorized" && e.scheduled_for
            ? `approved_scheduled_for ${e.scheduled_for.toISOString()} (sends automatically; do not propose it again)`
            : e.status,
        args: e.canonical_args,
      })),
    });
  } catch (err) {
    report = {
      status: "failed",
      summary: `Worker run error: ${(err as Error).message?.slice(0, 200)}`,
      evidenceRefs: [],
      proposedEffectIds: [],
      nextSuggestedAction: "retry",
      shouldWakeAt: null,
      blocker: null,
    };
    // Transient infrastructure failure is not an outcome failure: retry later.
    report.status = "waiting";
    report.shouldWakeAt = new Date(Date.now() + 10 * 60_000).toISOString();
  } finally {
    clearInterval(beat);
  }

  await finishRun(run.id, report.status === "failed" ? "failed" : "completed", report);
  await trace({
    userId,
    responsibilityId: resp.id,
    workerRunId: run.id,
    kind: "worker.completed",
    detail: { status: report.status },
  });
  return settle(userId, resp.id, report);
}

/** Completion requires provider evidence, never a model sentence (spec 5). */
async function completionIsEvidenced(userId: string, responsibilityId: string, report: WorkerReport) {
  const effects = await effectsForResponsibility(userId, responsibilityId);
  if (effects.some((e) => e.status === "uncertain" || e.status === "waiting_approval" || e.status === "dispatching")) {
    return false;
  }
  if (effects.length > 0) return effects.some((e) => e.status === "succeeded");
  if (report.evidenceRefs.length === 0) return false;
  const { rows } = await query<{ n: number }>(
    `select count(*)::int as n from evidence_records
      where user_id = $1 and responsibility_id = $2 and id = any($3::uuid[])`,
    [userId, responsibilityId, report.evidenceRefs.filter((r) => /^[0-9a-f-]{36}$/i.test(r))],
  );
  return (rows[0]?.n ?? 0) > 0;
}

async function settle(userId: string, responsibilityId: string, report: WorkerReport): Promise<string> {
  const resp = await getResponsibility(userId, responsibilityId);
  if (!resp || isTerminal(resp.status)) return "terminal";

  // An effect parked for approval already moved the responsibility to waiting_user.
  const awaitingApproval = resp.status === "waiting_user" && resp.waiting_on?.startsWith("approval:");
  if (awaitingApproval) {
    await deliverUpdate({ userId, responsibilityId, kind: "needs_approval", report });
    return "waiting_approval";
  }

  if (report.status === "completed" && (await completionIsEvidenced(userId, responsibilityId, report))) {
    await tx((c) =>
      transition(c, {
        userId,
        responsibilityId,
        to: "completed",
        nextAction: null,
        nextWakeAt: null,
        eventText: "Done",
        evidenceRefs: report.evidenceRefs,
      }),
    );
    await query(`update wakeups set status = 'cancelled' where responsibility_id = $1 and status = 'pending'`, [
      responsibilityId,
    ]);
    releaseComputersInBackground(userId, responsibilityId);
    await deliverUpdate({ userId, responsibilityId, kind: "completed", report });
    return "completed";
  }

  if (report.status === "blocked") {
    await tx((c) =>
      transition(c, {
        userId,
        responsibilityId,
        to: "waiting_user",
        waitingOn: report.blocker ?? "your input",
        nextAction: report.nextSuggestedAction,
        eventText: "Needs you",
      }),
    );
    await deliverUpdate({ userId, responsibilityId, kind: "needs_input", report });
    return "blocked";
  }

  if (report.status === "failed") {
    await tx((c) =>
      transition(c, { userId, responsibilityId, to: "failed", eventText: "Couldn't finish", nextWakeAt: null }),
    );
    releaseComputersInBackground(userId, responsibilityId);
    await deliverUpdate({ userId, responsibilityId, kind: "failed", report });
    return "failed";
  }

  // waiting (or an unevidenced "completed"): persist the next wake. No silent limbo.
  const requested = report.shouldWakeAt ? new Date(report.shouldWakeAt) : null;
  const minDue = Date.now() + 60_000;
  const dueAt =
    requested && !Number.isNaN(requested.getTime())
      ? new Date(Math.max(requested.getTime(), minDue))
      : new Date(Date.now() + FALLBACK_WAKE_MS);
  const existing = await nextPendingWake(userId, responsibilityId);
  const due = existing ? existing.due_at : dueAt;
  const { rows: tzRows } = await query<{ timezone: string }>(`select timezone from app_users where id = $1`, [userId]);
  const dueLocal = due.toLocaleTimeString("en-US", {
    timeZone: tzRows[0]?.timezone ?? "UTC",
    hour: "numeric",
    minute: "2-digit",
  });
  await tx(async (c) => {
    if (!existing) {
      await scheduleWake(c, { userId, responsibilityId, source: "schedule", causeRef: "worker_wait", dueAt });
    }
    await transition(c, {
      userId,
      responsibilityId,
      to: resp.waiting_on?.startsWith("mail:") ? "waiting_external" : "scheduled",
      nextWakeAt: due,
      nextAction: report.nextSuggestedAction,
      eventText: `Will check again at ${dueLocal}`,
    });
  });
  await trace({
    userId,
    responsibilityId,
    kind: "wake.scheduled",
    detail: { text: `Will check again at ${dueLocal}`, dueAt: due.toISOString() },
  });
  await deliverUpdate({ userId, responsibilityId, kind: "waiting", report });
  return "scheduled";
}
