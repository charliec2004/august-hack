import type { EffectClass } from "@/server/types/domain";

/**
 * Deterministic, server-owned risk policy (spec sections 10, 11, 12).
 *
 * The policy is a static table keyed by "provider.action". Nothing here reads
 * model output, provider metadata, tool descriptions, or memory: a provider
 * claiming an action is "safe" never changes its class.
 *
 * Fallbacks:
 * - an unknown action whose name matches an irreversible category keyword
 *   (purchase, payment, transfer, delete, cancel, ...) is irreversible
 * - any other unknown action is consequential
 * - an unknown action is never treated as a read
 */

export type EffectCategory =
  | "draft"
  | "label"
  | "message_send"
  | "calendar_write"
  | "booking"
  | "form_submit"
  | "purchase"
  | "payment"
  | "financial_transfer"
  | "destructive_delete"
  | "cancel_with_penalty"
  | "unknown";

export type ActionClassification =
  | { kind: "read"; provider: string; action: string }
  | { kind: "internal_write"; provider: string; action: string }
  | {
      kind: "effect";
      provider: string;
      action: string;
      effectClass: EffectClass;
      category: EffectCategory;
      /** False for categories this build refuses to execute at all. */
      supported: boolean;
      source: "policy_table" | "irreversible_keyword" | "unknown_default";
    };

type PolicyEntry =
  | { kind: "read" }
  | { kind: "internal_write" }
  | { kind: "effect"; category: Exclude<EffectCategory, "unknown"> };

/** Class implied by each effect category. */
export const CATEGORY_CLASS: Record<EffectCategory, EffectClass> = {
  draft: "reversible",
  label: "reversible",
  message_send: "consequential",
  calendar_write: "consequential",
  booking: "consequential",
  form_submit: "consequential",
  purchase: "irreversible",
  payment: "irreversible",
  financial_transfer: "irreversible",
  destructive_delete: "irreversible",
  cancel_with_penalty: "irreversible",
  unknown: "consequential",
};

/** Categories this build will never execute, even with approval. */
const UNSUPPORTED_CATEGORIES: ReadonlySet<EffectCategory> = new Set([
  "financial_transfer",
]);

const READ: PolicyEntry = { kind: "read" };
const INTERNAL: PolicyEntry = { kind: "internal_write" };
const effect = (category: Exclude<EffectCategory, "unknown">): PolicyEntry => ({
  kind: "effect",
  category,
});

/** Keys are lowercase "provider.action". */
export const POLICY_TABLE: Readonly<Record<string, PolicyEntry>> = {
  // Exa: research only.
  "exa.search": READ,
  "exa.get_contents": READ,
  "exa.find_similar": READ,
  "exa.answer": READ,

  // AgentMail.
  "agentmail.list_inboxes": READ,
  "agentmail.list_threads": READ,
  "agentmail.get_thread": READ,
  "agentmail.list_messages": READ,
  "agentmail.get_message": READ,
  "agentmail.create_draft": effect("draft"),
  "agentmail.update_draft": effect("draft"),
  "agentmail.send_email": effect("message_send"),
  "agentmail.send_draft": effect("message_send"),
  "agentmail.reply": effect("message_send"),
  "agentmail.forward": effect("message_send"),
  "agentmail.delete_message": effect("destructive_delete"),
  "agentmail.delete_thread": effect("destructive_delete"),

  // Kernel browser: reading a page is a read; the final committing click is an effect.
  "kernel.navigate": READ,
  "kernel.read_page": READ,
  "kernel.screenshot": READ,
  "kernel.extract": READ,
  "kernel.check_availability": READ,
  "kernel.submit_form": effect("form_submit"),
  "kernel.book": effect("booking"),
  "kernel.send": effect("message_send"),
  "kernel.purchase": effect("purchase"),
  "kernel.cancel": effect("cancel_with_penalty"),

  // Executor-connected apps (action = "<app>.<operation>").
  "executor.calendar.list_events": READ,
  "executor.calendar.get_event": READ,
  "executor.calendar.free_busy": READ,
  "executor.calendar.create_event": effect("calendar_write"),
  "executor.calendar.update_event": effect("calendar_write"),
  "executor.calendar.delete_event": effect("destructive_delete"),
  "executor.gmail.list_messages": READ,
  "executor.gmail.get_message": READ,
  "executor.gmail.search": READ,
  "executor.gmail.create_draft": effect("draft"),
  "executor.gmail.add_label": effect("label"),
  "executor.gmail.send_message": effect("message_send"),
  "executor.gmail.reply": effect("message_send"),
  "executor.gmail.delete_message": effect("destructive_delete"),

  // Internal state changes owned by Postgres.
  "internal.create_responsibility": INTERNAL,
  "internal.update_responsibility": INTERNAL,
  "internal.schedule_wake": INTERNAL,
  "internal.store_memory_candidate": INTERNAL,
  "internal.record_evidence": INTERNAL,
};

/**
 * Keyword → irreversible category, checked against tokens of unknown action names.
 * Order matters: earlier entries win.
 */
const IRREVERSIBLE_KEYWORDS: ReadonlyArray<
  [Exclude<EffectCategory, "unknown">, readonly string[]]
> = [
  ["financial_transfer", ["transfer", "wire", "withdraw", "remit", "payout"]],
  ["payment", ["pay", "payment", "charge", "tip", "donate"]],
  ["purchase", ["purchase", "buy", "checkout", "order", "subscribe"]],
  ["cancel_with_penalty", ["cancel", "terminate", "forfeit"]],
  ["destructive_delete", ["delete", "destroy", "purge", "erase", "remove", "drop", "wipe", "trash"]],
];

function tokens(action: string): string[] {
  return action
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

export function policyKey(provider: string, action: string): string {
  return `${provider.trim().toLowerCase()}.${action.trim().toLowerCase()}`;
}

export function classifyAction(provider: string, action: string): ActionClassification {
  const entry = POLICY_TABLE[policyKey(provider, action)];

  if (entry?.kind === "read") return { kind: "read", provider, action };
  if (entry?.kind === "internal_write") return { kind: "internal_write", provider, action };
  if (entry?.kind === "effect") {
    return {
      kind: "effect",
      provider,
      action,
      effectClass: CATEGORY_CLASS[entry.category],
      category: entry.category,
      supported: !UNSUPPORTED_CATEGORIES.has(entry.category),
      source: "policy_table",
    };
  }

  const actionTokens = new Set(tokens(action));
  for (const [category, words] of IRREVERSIBLE_KEYWORDS) {
    if (words.some((w) => actionTokens.has(w))) {
      return {
        kind: "effect",
        provider,
        action,
        effectClass: CATEGORY_CLASS[category],
        category,
        supported: !UNSUPPORTED_CATEGORIES.has(category),
        source: "irreversible_keyword",
      };
    }
  }

  return {
    kind: "effect",
    provider,
    action,
    effectClass: "consequential",
    category: "unknown",
    supported: true,
    source: "unknown_default",
  };
}

/** True when the action must go through the exact-effect rail. */
export function isExternalEffect(provider: string, action: string): boolean {
  return classifyAction(provider, action).kind === "effect";
}
