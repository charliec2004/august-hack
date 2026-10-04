import type { EffectClass } from "@/server/types/domain";

/**
 * An effect that has passed the exact-effect rail (policy, review, approval)
 * and holds a dispatch reservation. Provider adapters' `*Authorized` functions
 * accept ONLY this type, and must execute exactly `canonicalArgs`, nothing else.
 */
export type AuthorizedEffect = {
  id: string;
  userId: string;
  responsibilityId: string;
  provider: string;
  action: string;
  effectClass: EffectClass;
  canonicalArgs: Record<string, unknown>;
  materialFacts: Record<string, unknown>;
  proposalHash: string;
  /** Pass through as the provider's native idempotency key when supported. */
  idempotencyKey: string;
};

/**
 * Result of a provider dispatch. `uncertain` means the request may have reached
 * the provider (e.g. timeout after send): never blindly retried; reconciled by readback.
 */
export type DispatchResult = {
  outcome: "succeeded" | "failed" | "uncertain";
  providerReceiptRef: string | null;
  providerRequestId: string | null;
  evidenceRefs: string[];
  safeSummary: string;
};

/** What an adapter returns when a Worker asks to prepare a mutation. */
export type EffectDraft = {
  provider: string;
  action: string;
  /** Exact arguments that will be executed verbatim if authorized. */
  args: Record<string, unknown>;
  /** Material facts observed right before proposing (price, time, recipient...). */
  materialFacts: Record<string, unknown>;
};
