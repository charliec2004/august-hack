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
  /** Short-lived Kernel live-view URL while a browser session is open. */
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
};

export type ActivityItem = {
  id: string;
  at: string;
  responsibilityId: string | null;
  /** Safe, evidence-oriented sentence, e.g. "Searched the web". */
  text: string;
  liveViewUrl: string | null;
};

/** GET /api/state: one poll endpoint for the whole shell. */
export type AugustState = {
  responsibilities: ResponsibilityView[];
  approvals: ApprovalView[];
  activity: ActivityItem[];
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
