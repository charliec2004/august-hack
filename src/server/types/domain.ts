/**
 * Core domain contracts (spec Appendix A, section 37) plus the uniform
 * provider ToolResult shape (section 10). Types only; no runtime code.
 */

export type ResponsibilityStatus =
  | "active"
  | "running"
  | "waiting_external"
  | "waiting_user"
  | "scheduled"
  | "completed"
  | "failed"
  | "cancelled";

export type Responsibility = {
  id: string;
  userId: string;
  threadId: string;
  title: string;
  goal: string;
  successCriteria: string[];
  constraints: Record<string, unknown>;
  status: ResponsibilityStatus;
  priority: "low" | "normal" | "high";
  nextAction: string | null;
  nextWakeAt: string | null;
  waitingOn: string | null;
  sourceMessageId: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export type CapabilityName =
  | "exa.search"
  | "executor.read"
  | "executor.write"
  | "kernel.read"
  | "kernel.commit"
  | "agentmail.read"
  | "agentmail.send"
  | "sprite.exec";

export type EffectClass =
  | "reversible"
  | "consequential"
  | "irreversible";

export type EffectProposal = {
  id: string;
  userId: string;
  responsibilityId: string;
  workerSessionId: string | null;
  provider: "executor" | "kernel" | "agentmail" | "internal";
  action: string;
  effectClass: EffectClass;
  canonicalArgs: Record<string, unknown>;
  materialFacts: Record<string, unknown>;
  proposalHash: string;
  sourceMessageId: string;
  status:
    | "prepared"
    | "authorized"
    | "waiting_approval"
    | "denied"
    | "dispatching"
    | "succeeded"
    | "failed"
    | "uncertain";
};

export type ReviewDecision = {
  decision: "authorized" | "needs_confirmation" | "denied";
  reasonCode: string;
  userFacingQuestion?: string;
};

export type Approval = {
  id: string;
  effectProposalId: string;
  proposalHash: string;
  userId: string;
  decision: "approved" | "denied";
  createdAt: string;
};

export type EffectReceipt = {
  id: string;
  effectProposalId: string;
  outcome: "succeeded" | "failed" | "uncertain";
  providerReceiptRef: string | null;
  providerRequestId: string | null;
  evidenceRefs: string[];
  retry: "would_duplicate" | "safe" | "reconciling" | "not_retryable";
  createdAt: string;
};

export type WorkerBrief = {
  responsibilityId: string;
  assignmentRef: string;
  objective: string;
  successCriteria: string[];
  constraints: Record<string, unknown>;
  allowedCapabilities: CapabilityName[];
  maxToolCalls: number;
  deadlineMs: number;
};

export type WorkerReport = {
  status: "completed" | "blocked" | "waiting" | "failed";
  summary: string;
  evidenceRefs: string[];
  proposedEffectIds: string[];
  nextSuggestedAction: string | null;
  shouldWakeAt: string | null;
  blocker: string | null;
};

export type MemoryRecord = {
  id: string;
  userId: string;
  kind: "preference" | "fact" | "relationship" | "routine" | "episodic";
  text: string;
  sourceMessageId: string | null;
  sourceType: "user_stated" | "assistant_inferred";
  confidence: number;
  importance: number;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  forgottenAt: string | null;
};

/** Uniform result shape every external capability returns (section 10). */
export type ToolResult<T> = {
  status: "succeeded" | "failed" | "blocked" | "uncertain";
  data?: T;
  evidenceRefs: string[];
  providerRequestId?: string;
  safeSummary: string;
  retry:
    | "safe"
    | "unsafe_without_readback"
    | "after_backoff"
    | "after_user"
    | "never";
};
