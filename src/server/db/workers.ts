import "server-only";

import type { CapabilityName, WorkerReport } from "@/server/types/domain";
import { query, tx } from "./client";

export type WorkerSessionRow = {
  id: string;
  responsibility_id: string;
  user_id: string;
  assignment_ref: string;
  objective: string;
  success_criteria: string[];
  constraints: Record<string, unknown>;
  capability_scope: CapabilityName[];
  status: string;
};

export type WorkerRunRow = {
  id: string;
  worker_session_id: string;
  user_id: string;
  responsibility_id: string | null;
  status: "running" | "completed" | "failed" | "abandoned";
  lease_owner: string | null;
  lease_expires_at: Date | null;
  live_view_url: string | null;
  started_at: Date;
  finished_at: Date | null;
  report: WorkerReport | null;
};

export async function createWorkerSession(input: {
  userId: string;
  responsibilityId: string;
  assignmentRef: string;
  objective: string;
  successCriteria: string[];
  constraints: Record<string, unknown>;
  capabilities: CapabilityName[];
}): Promise<WorkerSessionRow> {
  const { rows } = await query<WorkerSessionRow>(
    `insert into worker_sessions
       (responsibility_id, user_id, assignment_ref, objective, success_criteria, constraints,
        capability_scope, status)
     values ($1, $2, $3, $4, $5, $6, $7, 'open')
     on conflict (assignment_ref) do update set updated_at = now()
     returning *`,
    [
      input.responsibilityId,
      input.userId,
      input.assignmentRef,
      input.objective,
      JSON.stringify(input.successCriteria),
      JSON.stringify(input.constraints),
      JSON.stringify(input.capabilities),
    ],
  );
  return rows[0];
}

export async function getWorkerSession(userId: string, id: string) {
  const { rows } = await query<WorkerSessionRow>(
    `select * from worker_sessions where user_id = $1 and id = $2`,
    [userId, id],
  );
  return rows[0] ?? null;
}

/** Most recent open session for a responsibility (resumed on wake). */
export async function latestSessionFor(userId: string, responsibilityId: string) {
  const { rows } = await query<WorkerSessionRow>(
    `select * from worker_sessions where user_id = $1 and responsibility_id = $2
      order by created_at desc limit 1`,
    [userId, responsibilityId],
  );
  return rows[0] ?? null;
}

/**
 * Start a run with a lease. Refuses if another live (unexpired) run owns the
 * session, so a crashed process can't leave two writers on one assignment.
 */
export async function startRun(input: {
  userId: string;
  sessionId: string;
  responsibilityId: string;
  leaseOwner: string;
  leaseMs: number;
}): Promise<WorkerRunRow | null> {
  return tx(async (c) => {
    await c.query(`select id from worker_sessions where id = $1 for update`, [input.sessionId]);
    const live = await c.query(
      `select 1 from worker_runs
        where worker_session_id = $1 and status = 'running' and lease_expires_at > now()`,
      [input.sessionId],
    );
    if (live.rowCount) return null;
    await c.query(
      `update worker_runs set status = 'abandoned', finished_at = now()
        where worker_session_id = $1 and status = 'running'`,
      [input.sessionId],
    );
    const { rows } = await c.query<WorkerRunRow>(
      `insert into worker_runs
         (worker_session_id, user_id, responsibility_id, status, lease_owner, lease_expires_at, heartbeat_at)
       values ($1, $2, $3, 'running', $4, now() + ($5 || ' milliseconds')::interval, now())
       returning *`,
      [input.sessionId, input.userId, input.responsibilityId, input.leaseOwner, String(input.leaseMs)],
    );
    return rows[0];
  });
}

export async function heartbeat(runId: string, leaseMs: number) {
  await query(
    `update worker_runs set heartbeat_at = now(),
        lease_expires_at = now() + ($2 || ' milliseconds')::interval
      where id = $1 and status = 'running'`,
    [runId, String(leaseMs)],
  );
}

export async function setLiveView(runId: string, url: string | null) {
  await query(`update worker_runs set live_view_url = $2 where id = $1`, [runId, url]);
}

export async function finishRun(runId: string, status: "completed" | "failed", report: WorkerReport) {
  await query(
    `update worker_runs set status = $2, report = $3, finished_at = now(), live_view_url = null
      where id = $1`,
    [runId, status, JSON.stringify(report)],
  );
}

export async function activeRunsFor(userId: string) {
  const { rows } = await query<WorkerRunRow>(
    `select * from worker_runs
      where user_id = $1 and status = 'running' and lease_expires_at > now()`,
    [userId],
  );
  return rows;
}

export async function latestReports(userId: string, responsibilityId: string, limit = 3) {
  const { rows } = await query<{ report: WorkerReport; finished_at: Date }>(
    `select wr.report, wr.finished_at from worker_runs wr
       join worker_sessions ws on ws.id = wr.worker_session_id
      where wr.user_id = $1 and ws.responsibility_id = $2 and wr.report is not null
      order by wr.finished_at desc limit $3`,
    [userId, responsibilityId, limit],
  );
  return rows;
}
