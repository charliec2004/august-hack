import "server-only";

import { query } from "./client";

/** Spec section 30 trace vocabulary. */
export type TraceKind =
  | "responsibility.created"
  | "responsibility.state_changed"
  | "worker.spawned"
  | "worker.started"
  | "worker.completed"
  | "tool.started"
  | "tool.succeeded"
  | "tool.failed"
  | "effect.proposed"
  | "effect.reviewed"
  | "approval.requested"
  | "approval.resolved"
  | "effect.dispatched"
  | "effect.receipt"
  | "wake.scheduled"
  | "wake.claimed"
  | "provider.event_received"
  | "memory.captured"
  | "computer.acquired"
  | "computer.command"
  | "computer.released"
  | "brain.delivered";

export type TraceInput = {
  userId: string;
  responsibilityId?: string | null;
  workerRunId?: string | null;
  kind: TraceKind;
  /**
   * `text` is the user-safe activity sentence shown in the UI ("Searched the web").
   * Everything here must be safe to display: no secrets, no chain-of-thought.
   */
  detail: { text?: string; liveViewUrl?: string | null; [k: string]: unknown };
};

export async function trace(t: TraceInput): Promise<void> {
  await query(
    `insert into trace_events (user_id, responsibility_id, worker_run_id, event_kind, safe_detail)
     values ($1, $2, $3, $4, $5)`,
    [
      t.userId,
      t.responsibilityId ?? null,
      t.workerRunId ?? null,
      t.kind,
      JSON.stringify(t.detail),
    ],
  );
}
