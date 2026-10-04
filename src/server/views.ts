import "server-only";

import { query } from "@/server/db/client";
import { pendingApprovals } from "@/server/db/effects";
import { listEvidence } from "@/server/db/evidence";
import {
  getResponsibility,
  listEvents,
  listResponsibilities,
  type ResponsibilityRow,
} from "@/server/db/responsibilities";
import { activeRunsFor } from "@/server/db/workers";
import { toApprovalView } from "@/server/effects/display";
import type {
  ActivityItem,
  AugustState,
  HumanStatus,
  ResponsibilityDetail,
  ResponsibilityView,
} from "@/server/types/api";

export function humanStatus(r: ResponsibilityRow, active: boolean): HumanStatus {
  switch (r.status) {
    case "completed":
      return "Done";
    case "cancelled":
      return "Stopped";
    case "failed":
      return "Couldn't finish";
    case "waiting_user":
      return "Needs you";
    case "waiting_external":
      return "Waiting for reply";
    case "scheduled":
      return active ? "Working on it" : "Checking again later";
    default:
      return "Working on it";
  }
}

const SORT: Record<HumanStatus, number> = {
  "Needs you": 0,
  "Working on it": 1,
  "Checking again later": 2,
  "Waiting for reply": 2,
  Done: 3,
  Stopped: 4,
  "Couldn't finish": 4,
};

function toView(r: ResponsibilityRow, runs: Map<string, string | null>): ResponsibilityView {
  const active = runs.has(r.id);
  return {
    id: r.id,
    title: r.title,
    status: r.status,
    humanStatus: humanStatus(r, active),
    nextWakeAt: r.next_wake_at ? r.next_wake_at.toISOString() : null,
    waitingOn: r.waiting_on?.startsWith("approval:") ? "your approval" : r.waiting_on,
    active,
    liveViewUrl: runs.get(r.id) ?? null,
    updatedAt: r.updated_at.toISOString(),
  };
}

async function runMap(userId: string) {
  const runs = await activeRunsFor(userId);
  const m = new Map<string, string | null>();
  for (const run of runs) if (run.responsibility_id) m.set(run.responsibility_id, run.live_view_url);
  return m;
}

export async function buildState(userId: string): Promise<AugustState> {
  const [rows, runs, approvals, activity, latest] = await Promise.all([
    listResponsibilities(userId),
    runMap(userId),
    pendingApprovals(userId),
    query<{ id: string; created_at: Date; responsibility_id: string | null; safe_detail: { text?: string; liveViewUrl?: string | null } }>(
      `select id::text, created_at, responsibility_id, safe_detail from trace_events
        where user_id = $1 and safe_detail ? 'text' and coalesce(safe_detail->>'text','') <> ''
        order by created_at desc limit 40`,
      [userId],
    ),
    query<{ id: string }>(
      `select id from messages where user_id = $1 order by created_at desc limit 1`,
      [userId],
    ),
  ]);
  const responsibilities = rows
    .map((r) => toView(r, runs))
    .sort((a, b) => SORT[a.humanStatus] - SORT[b.humanStatus] || b.updatedAt.localeCompare(a.updatedAt));
  const items: ActivityItem[] = activity.rows.reverse().map((t) => ({
    id: t.id,
    at: t.created_at.toISOString(),
    responsibilityId: t.responsibility_id,
    text: t.safe_detail.text ?? "",
    liveViewUrl: t.safe_detail.liveViewUrl ?? null,
  }));
  return {
    responsibilities,
    approvals: approvals.map(toApprovalView),
    activity: items,
    latestMessageId: latest.rows[0]?.id ?? null,
    demoControls: process.env.AUGUST_ENV !== "production",
    serverTime: new Date().toISOString(),
  };
}

export async function buildDetail(userId: string, id: string): Promise<ResponsibilityDetail | null> {
  const r = await getResponsibility(userId, id);
  if (!r) return null;
  const [runs, events, evidence] = await Promise.all([
    runMap(userId),
    listEvents(userId, id),
    listEvidence(userId, id),
  ]);
  return {
    ...toView(r, runs),
    goal: r.goal,
    successCriteria: r.success_criteria,
    constraints: r.constraints,
    nextAction: r.next_action,
    timeline: events
      .filter((e) => e.safe_detail?.text)
      .map((e) => ({ id: e.id, at: e.created_at.toISOString(), kind: e.event_kind, text: e.safe_detail.text! })),
    evidence: evidence.map((ev) => ({
      id: ev.id,
      provider: ev.provider,
      title: ev.safe_summary.split("\n")[0].slice(0, 120),
      url: ev.source_url,
      summary: ev.safe_summary.slice(0, 600),
      observedAt: ev.observed_at.toISOString(),
    })),
  };
}
