/**
 * API response shapes shared by the server and the UI (spec section 33:
 * ResponsibilityView, ApprovalView, ActivityItem). The UI renders only these;
 * it never sees raw provider payloads, worker ids, model names, or leases.
 */
import type { EffectClass, ResponsibilityStatus } from "./domain";

/** Human-facing status label, derived server-side from ResponsibilityStatus. */
export type HumanStatus =
  | "Working on it"
  | "Checking again later"
  | "Waiting for reply"
  | "Needs you"
  | "Done"
  | "Stopped"
  | "Couldn't finish";

export type ResponsibilityView = {
  id: string;
  title: string;
  status: ResponsibilityStatus;
  humanStatus: HumanStatus;
  /** ISO time of the next scheduled check, if any. */
  nextWakeAt: string | null;
  waitingOn: string | null;
  /** True while a Worker run is actively executing. */
  active: boolean;
  /** Live-view URL while a browser session is live (from AugustState.liveBrowsers). */
  liveViewUrl: string | null;
  updatedAt: string;
};

export type TimelineEvent = {
  id: string;
  at: string;
  kind: string;
  text: string;
};

export type EvidenceView = {
  id: string;
  provider: string;
  title: string;
  url: string | null;
  summary: string;
  observedAt: string;
};

export type ResponsibilityDetail = ResponsibilityView & {
  goal: string;
  successCriteria: string[];
  constraints: Record<string, unknown>;
  nextAction: string | null;
  timeline: TimelineEvent[];
  evidence: EvidenceView[];
};

/** One labeled material field on an approval card. */
export type ApprovalField = { label: string; value: string };

/** Where a user-facing effect stands, derived from effect_proposals.status. */
export type ApprovalState = "pending" | "sending" | "sent" | "declined" | "failed" | "uncertain";

export type ApprovalView = {
  effectId: string;
  responsibilityId: string;
  responsibilityTitle: string;
  /** Card layout hint (spec 42.4). */
  kind: "email" | "booking" | "calendar" | "form" | "computer" | "generic";
  /** e.g. "August wants to send:" */
  headline: string;
  effectClass: EffectClass;
  /** Every material field, rendered from the frozen proposal. */
  fields: ApprovalField[];
  /** Full message body / command text, if any. Rendered verbatim. */
  body: string | null;
  /** The frozen proposal hash the approval binds to. */
  proposalHash: string;
  /** Reviewer's question when it returned needs_confirmation. */
  question: string | null;
  createdAt: string;
  state: ApprovalState;
  /** When the user approved or declined, if they have. */
  decidedAt: string | null;
  /** When the outcome was recorded (receipt), if it has been. */
  settledAt: string | null;
};

export type ActivityItem = {
  id: string;
  at: string;
  responsibilityId: string | null;
  /** Safe, evidence-oriented sentence, e.g. "Searched the web". */
  text: string;
  /** Browser session this line happened in, if any. Watchable only while live. */
  browserSessionId: string | null;
};

/** A browser session that is live right now. The only source of live-view links. */
export type LiveBrowser = {
  sessionId: string;
  responsibilityId: string | null;
  liveViewUrl: string;
};

/* Timeline parts (GET /api/messages). Rendered by makeAssistantDataUI. -------- */

export type TimelineActivityItem = {
  id: string;
  text: string;
  at: string;
  responsibilityId: string | null;
  responsibilityTitle: string | null;
  browserSessionId: string | null;
};

/** `data-activity`: a run of consecutive activity lines. */
export type TimelineActivityData = { items: TimelineActivityItem[] };

/** `data-approval`: an approval card, resolved against AugustState.approvals. */
export type TimelineApprovalData = { effectId: string };

/** GET /api/state: one poll endpoint for the whole shell. */
export type AugustState = {
  responsibilities: ResponsibilityView[];
  /** Every recent user-facing effect (48h, newest 50), pending and resolved. */
  approvals: ApprovalView[];
  activity: ActivityItem[];
  /** Browser sessions that are live right now. */
  liveBrowsers: LiveBrowser[];
  /**
   * Changes whenever anything in the conversation timeline changes (a message,
   * an activity line, or an effect's state). The UI reloads GET /api/messages
   * when it changes and nothing is streaming.
   */
  timelineVersion: string;
  /** Id of the newest persisted conversation message. */
  latestMessageId: string | null;
  /** Development/demo controls enabled (AUGUST_ENV !== "production"). */
  demoControls: boolean;
  serverTime: string;
};

/** POST /api/approvals/:id body. */
export type ApprovalDecisionRequest = {
  decision: "approved" | "denied";
  /** Must equal the proposalHash the user was shown. */
  proposalHash: string;
};
