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

/** One moment in a responsibility's history. `key` moments show by default. */
export type DetailMoment = {
  id: string;
  at: string;
  text: string;
  key: boolean;
  /** Consecutive identical lines collapse into one with a count. */
  count: number;
};

export type SourceItem = {
  id: string;
  title: string;
  url: string | null;
  /** Clipped markdown summary. */
  summary: string;
  observedAt: string;
};

/** Sources grouped by domain (web pages) or connector ("Web search", "Email"). */
export type SourceGroup = {
  key: string;
  label: string;
  items: SourceItem[];
};

export type ResponsibilityDetail = ResponsibilityView & {
  /** Where it stands, in August's own words (its latest message about this). */
  standing: string | null;
  standingAt: string | null;
  /** Short humanized constraint tags, e.g. "Party of 2", "Under $120". */
  facts: string[];
  goal: string;
  successCriteria: string[];
  nextAction: string | null;
  moments: DetailMoment[];
  sources: SourceGroup[];
};

/** One labeled material field on an approval card. */
export type ApprovalField = { label: string; value: string };

/** Where a user-facing effect stands, derived from effect_proposals.status. */
export type ApprovalState =
  | "pending"
  /** Approved for a later time; not dispatched until `scheduledFor`. */
  | "scheduled"
  | "sending"
  | "sent"
  | "declined"
  | "failed"
  | "uncertain";

/** The exact email an email effect will send, from the frozen proposal. */
export type ApprovalEmail = {
  /** August's sending inbox. Never editable. */
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  /** A reply in an existing thread (the subject is the thread's). */
  isReply: boolean;
};

export type ApprovalView = {
  effectId: string;
  responsibilityId: string;
  responsibilityTitle: string;
  /** Card layout hint (spec 42.4). */
  kind: "email" | "booking" | "calendar" | "form" | "computer" | "generic";
  /** One line saying what will happen, e.g. "Book this table". */
  title: string;
  effectClass: EffectClass;
  /** Every material field, rendered from the frozen proposal. */
  fields: ApprovalField[];
  /** Full message body / command text, if any. Rendered verbatim. */
  body: string | null;
  /** Structured email (kind "email" only). */
  email: ApprovalEmail | null;
  /** The user may edit to/subject/body before sending (POST .../revise). */
  editable: boolean;
  /** The frozen proposal hash the approval binds to. */
  proposalHash: string;
  /** Reviewer's question when it returned needs_confirmation. */
  question: string | null;
  createdAt: string;
  state: ApprovalState;
  /** Send-later time (ISO) for an approved effect, if any. */
  scheduledFor: string | null;
  /** When the user approved or declined, if they have. */
  decidedAt: string | null;
  /** When the outcome was recorded (receipt), if it has been. */
  settledAt: string | null;
  /** The user-edited effect that replaced this one, if the user edited it. */
  supersededBy: string | null;
  /** The agent proposal this user-edited effect replaced. */
  supersedes: string | null;
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
  /** Who is signed in. */
  viewer: { name: string; email: string | null };
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
  /** Send later (approve only), ISO time. */
  sendAt?: string | null;
};

/** POST /api/approvals/:id/revise body: the user's edited email. */
export type ApprovalReviseRequest = {
  shownProposalHash: string;
  to: string[];
  subject: string;
  body: string;
  sendAt?: string | null;
};

/* App surfaces beyond the conversation. ----------------------------------- */

/** GET /api/vault row. Never carries a username or password. */
export type SavedLogin = {
  id: string;
  label: string;
  origins: string[];
  status: "pending" | "ready" | "failed";
  lastUsedAt: string | null;
  createdAt: string;
};

/** GET /api/connections row: a connected app, in human terms. */
export type ConnectionView = {
  /** e.g. "Google Calendar" */
  name: string;
  /** Executor integration key, e.g. "google_calendar". */
  integration: string;
  /** e.g. "Connected" */
  status: string;
  /** "Personal" or "Shared". */
  scope: string;
};

export type ConnectionsResponse = { connections: ConnectionView[]; message: string | null };

/** GET /api/computer. */
export type ComputerStatus = {
  available: boolean;
  reason: string | null;
  tools: { toolKey: string; packageName: string; packageVersion: string }[];
  generation: number;
  /** Browser sessions live right now. */
  liveSessions: number;
};
