import { sha256Hex } from "./canonicalize";

/**
 * Idempotency key for one logical effect attempt (spec section 13):
 *   sha256(user_id | responsibility_id | effect_type | proposal_hash | attempt)
 *
 * Retrying the same logical attempt reuses the key; a deliberate new attempt
 * (after readback proves absence) increments `attempt`.
 */
export type IdempotencyInput = {
  userId: string;
  responsibilityId: string;
  /** e.g. "agentmail.send_email" */
  effectType: string;
  /** "sha256:<hex>" from proposalHash() */
  proposalHash: string;
  /** Logical attempt number, starting at 1. */
  attempt: number;
};

export function idempotencyKey(input: IdempotencyInput): string {
  const { userId, responsibilityId, effectType, proposalHash, attempt } = input;

  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new Error(`attempt must be a positive integer, got ${attempt}`);
  }
  const fields = { userId, responsibilityId, effectType, proposalHash };
  for (const [name, value] of Object.entries(fields)) {
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`${name} must be a non-empty string`);
    }
    // The delimiter must not appear inside a field, or distinct inputs could collide.
    if (value.includes("|")) {
      throw new Error(`${name} must not contain "|"`);
    }
  }

  return sha256Hex([userId, responsibilityId, effectType, proposalHash, String(attempt)].join("|"));
}
