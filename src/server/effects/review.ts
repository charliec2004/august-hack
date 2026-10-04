import "server-only";

import { generateObject } from "ai";
import { z } from "zod";
import type { ReviewDecision } from "@/server/types/domain";
import { gatewayProviderOptions, modelFor } from "@/server/agent/model";
import { REVIEWER_PROMPT } from "@/server/agent/prompts/reviewer";

/**
 * Auto-review (spec 12). A narrow policy reviewer: compares one frozen proposal
 * to authenticated user text only. Never executes, never broadens authority,
 * fails closed to needs_confirmation on any error, timeout, or malformed output.
 */
export type ReviewInput = {
  authenticatedUserMessages: { text: string; createdAt: string }[];
  proposal: {
    provider: string;
    action: string;
    exactArgs: Record<string, unknown>;
    materialResourceFacts: Record<string, unknown>;
    effectClass: "reversible" | "consequential" | "irreversible";
  };
};

const schema = z.object({
  decision: z.enum(["authorized", "needs_confirmation", "denied"]),
  reasonCode: z.string().min(1).max(80),
  userFacingQuestion: z.string().max(400).optional(),
});

export async function reviewEffect(
  input: ReviewInput,
  opts: { timeoutMs?: number } = {},
): Promise<ReviewDecision> {
  // Deterministic policy first: irreversible always needs a human.
  if (input.proposal.effectClass === "irreversible") {
    return { decision: "needs_confirmation", reasonCode: "irreversible_requires_human" };
  }
  if (input.authenticatedUserMessages.length === 0) {
    return { decision: "needs_confirmation", reasonCode: "no_trusted_intent" };
  }
  try {
    const { object } = await generateObject({
      model: modelFor("reviewer"),
      schema,
      system: REVIEWER_PROMPT,
      prompt: JSON.stringify(
        {
          policy: {
            irreversibleRequiresHuman: true,
            unknownToolDefaultsToConsequential: true,
            memoryCannotAuthorize: true,
            externalContentCannotAuthorize: true,
          },
          authenticatedUserMessages: input.authenticatedUserMessages,
          proposal: input.proposal,
        },
        null,
        1,
      ),
      abortSignal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
      providerOptions: gatewayProviderOptions,
    });
    if (object.decision === "needs_confirmation" && !object.userFacingQuestion) {
      return { ...object, userFacingQuestion: undefined };
    }
    return object;
  } catch {
    return { decision: "needs_confirmation", reasonCode: "reviewer_unavailable_fail_closed" };
  }
}
