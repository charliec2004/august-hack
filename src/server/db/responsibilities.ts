import "server-only";

import type { PoolClient } from "pg";
import type { ResponsibilityStatus } from "@/server/types/domain";
import { query, tx } from "./client";

export type ResponsibilityRow = {
  id: string;
  user_id: string;
  thread_id: string;
  source_message_id: string | null;
  title: string;
  goal: string;
  success_criteria: string[];
  constraints: Record<string, unknown>;
  status: ResponsibilityStatus;
  priority: string;
  next_action: string | null;
  next_wake_at: Date | null;
  waiting_on: string | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
};

const TERMINAL: ResponsibilityStatus[] = ["completed", "failed", "cancelled"];
export const isTerminal = (s: ResponsibilityStatus) => TERMINAL.includes(s);

type Q = Pick<PoolClient, "query">;

export async function appendEvent(
  c: Q,
  e: {
    userId: string;
    responsibilityId: string;
    kind: string;
    detail?: Record<string, unknown>;
    evidenceRefs?: string[];
  },
) {
  await c.query(
    `insert into responsibility_events (responsibility_id, user_id, event_kind, safe_detail, evidence_refs)
     values ($1, $2, $3, $4, $5)`,
    [
      e.responsibilityId,
      e.userId,
      e.kind,
      JSON.stringify(e.detail ?? {}),
      JSON.stringify(e.evidenceRefs ?? []),
    ],
  );
}

export async function createResponsibility(input: {
  userId: string;
  threadId: string;
  sourceMessageId: string | null;
  title: string;
  goal: string;
  successCriteria: string[];
  constraints: Record<string, unknown>;
  priority?: "low" | "normal" | "high";
  nextAction: string;
}): Promise<ResponsibilityRow> {
  return tx(async (c) => {
    const { rows } = await c.query<ResponsibilityRow>(
      `insert into responsibilities
         (user_id, thread_id, source_message_id, title, goal, success_criteria, constraints,
          status, priority, next_action)
       values ($1, $2, $3, $4, $5, $6, $7, 'active', $8, $9)
       returning *`,
      [
        input.userId,
        input.threadId,
        input.sourceMessageId,
        input.title,
        input.goal,
        JSON.stringify(input.successCriteria),
        JSON.stringify(input.constraints),
        input.priority ?? "normal",
        input.nextAction,
      ],
    );
    const r = rows[0];
    await appendEvent(c, {
      userId: input.userId,
      responsibilityId: r.id,
      kind: "created",
      detail: { text: `Took on: ${r.title}` },
    });
    return r;
  });
}

export async function getResponsibility(userId: string, id: string) {
  const { rows } = await query<ResponsibilityRow>(
    `select * from responsibilities where user_id = $1 and id = $2`,
    [userId, id],
  );
  return rows[0] ?? null;
}

export async function listResponsibilities(userId: string, opts: { includeTerminalSince?: Date } = {}) {
  const since = opts.includeTerminalSince ?? new Date(Date.now() - 24 * 3600_000);
  const { rows } = await query<ResponsibilityRow>(
    `select * from responsibilities
      where user_id = $1
        and (status not in ('completed','failed','cancelled') or updated_at > $2)
      order by updated_at desc
      limit 50`,
    [userId, since],
  );
  return rows;
}

/**
 * Transition a responsibility's status. Terminal states are sticky: a completed
 * or cancelled responsibility is never moved back by a wake or a stale worker.
 * Returns the updated row, or null if the transition was refused.
 */
export async function transition(
  c: Q,
  input: {
    userId: string;
    responsibilityId: string;
    to: ResponsibilityStatus;
    nextAction?: string | null;
    nextWakeAt?: Date | null;
    waitingOn?: string | null;
    eventText: string;
    evidenceRefs?: string[];
    detail?: Record<string, unknown>;
  },
): Promise<ResponsibilityRow | null> {
  const { rows } = await c.query<ResponsibilityRow>(
    `update responsibilities set
        status = $3,
        next_action = case when $4::boolean then $5 else next_action end,
        next_wake_at = case when $6::boolean then $7::timestamptz else next_wake_at end,
        waiting_on = case when $8::boolean then $9 else waiting_on end,
        completed_at = case when $3 in ('completed','failed','cancelled') then now() else completed_at end,
        updated_at = now()
      where user_id = $1 and id = $2
        and status not in ('completed','failed','cancelled')
      returning *`,
    [
      input.userId,
      input.responsibilityId,
      input.to,
      input.nextAction !== undefined,
      input.nextAction ?? null,
      input.nextWakeAt !== undefined,
      input.nextWakeAt ?? null,
      input.waitingOn !== undefined,
      input.waitingOn ?? null,
    ],
  );
  const r = rows[0] ?? null;
  if (r) {
    await appendEvent(c, {
      userId: input.userId,
      responsibilityId: input.responsibilityId,
      kind: `status.${input.to}`,
      detail: { text: input.eventText, ...(input.detail ?? {}) },
      evidenceRefs: input.evidenceRefs,
    });
  }
  return r;
}

export async function listEvents(userId: string, responsibilityId: string) {
  const { rows } = await query<{
    id: string;
    event_kind: string;
    safe_detail: { text?: string };
    created_at: Date;
  }>(
    `select id, event_kind, safe_detail, created_at
       from responsibility_events
      where user_id = $1 and responsibility_id = $2
      order by created_at asc
      limit 200`,
    [userId, responsibilityId],
  );
  return rows;
}

/**
 * "No silent limbo" (spec 8): nonterminal responsibilities that have no active
 * run, no pending wake, and are not waiting on the user.
 */
export async function findStranded(userId?: string) {
  const { rows } = await query<{ id: string; user_id: string; status: string }>(
    `select r.id, r.user_id, r.status
       from responsibilities r
      where r.status not in ('completed','failed','cancelled','waiting_user')
        and ($1::uuid is null or r.user_id = $1)
        and not exists (
          select 1 from worker_runs wr join worker_sessions ws on ws.id = wr.worker_session_id
           where ws.responsibility_id = r.id and wr.status = 'running'
             and (wr.lease_expires_at is null or wr.lease_expires_at > now()))
        and not exists (
          select 1 from wakeups w where w.responsibility_id = r.id and w.status in ('pending','claimed'))
        and not exists (
          select 1 from effect_proposals e where e.responsibility_id = r.id
             and e.status = 'authorized' and e.scheduled_for is not null)
        and r.updated_at < now() - interval '2 minutes'`,
    [userId ?? null],
  );
  return rows;
}
