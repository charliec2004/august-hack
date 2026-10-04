import "server-only";

import { listActivity, timelineVersion } from "@/server/activity";
import { query } from "@/server/db/client";
import { recentUserFacingEffects } from "@/server/db/effects";
import { listEvidence } from "@/server/db/evidence";
import {
  getResponsibility,
  listEvents,
  listResponsibilities,
  type ResponsibilityRow,
} from "@/server/db/responsibilities";
import { activeRunsFor } from "@/server/db/workers";
import { toApprovalView } from "@/server/effects/display";
import { liveBrowsersFor } from "@/server/liveBrowsers";
import type {
  AugustState,
  LiveBrowser,
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

function toView(r: ResponsibilityRow, runs: Set<string>, live: LiveBrowser[]): ResponsibilityView {
  const active = runs.has(r.id);
  return {
    id: r.id,
    title: r.title,
    status: r.status,
    humanStatus: humanStatus(r, active),
    nextWakeAt: r.next_wake_at ? r.next_wake_at.toISOString() : null,
    waitingOn: r.waiting_on?.startsWith("approval:") ? "your approval" : r.waiting_on,
    active,
    liveViewUrl: live.find((b) => b.responsibilityId === r.id)?.liveViewUrl ?? null,
    updatedAt: r.updated_at.toISOString(),
  };
}

async function activeSet(userId: string) {
  const runs = await activeRunsFor(userId);
  return new Set(runs.flatMap((run) => (run.responsibility_id ? [run.responsibility_id] : [])));
}

export async function buildState(userId: string): Promise<AugustState> {
  const [rows, runs, live, effects, activity, latest, version] = await Promise.all([
    listResponsibilities(userId),
    activeSet(userId),
    liveBrowsersFor(userId),
    recentUserFacingEffects(userId),
    listActivity(userId, { limit: 40 }),
    query<{ id: string }>(
      `select id from messages where user_id = $1 order by created_at desc limit 1`,
      [userId],
    ),
    timelineVersion(userId),
  ]);
  const responsibilities = rows
    .map((r) => toView(r, runs, live))
    .sort((a, b) => SORT[a.humanStatus] - SORT[b.humanStatus] || b.updatedAt.localeCompare(a.updatedAt));
  return {
    responsibilities,
    approvals: effects.map(toApprovalView),
    activity,
    liveBrowsers: live,
    timelineVersion: version,
    latestMessageId: latest.rows[0]?.id ?? null,
    demoControls: process.env.AUGUST_ENV !== "production",
    serverTime: new Date().toISOString(),
  };
}

export async function buildDetail(userId: string, id: string): Promise<ResponsibilityDetail | null> {
  const r = await getResponsibility(userId, id);
  if (!r) return null;
  const [runs, live, events, evidence] = await Promise.all([
    activeSet(userId),
    liveBrowsersFor(userId),
    listEvents(userId, id),
    listEvidence(userId, id),
  ]);
  return {
    ...toView(r, runs, live),
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
      title: ev.safe_summary.split("\n")[0].replace(/^[#>*\-\s]+|[*_`]+/g, "").slice(0, 140),
      url: ev.source_url,
      summary: ev.safe_summary.slice(0, 2000),
      observedAt: ev.observed_at.toISOString(),
    })),
  };
}
