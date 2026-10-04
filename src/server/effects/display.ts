import "server-only";

import type { EffectRow, EffectStatus } from "@/server/db/effects";
import type { ApprovalField, ApprovalState, ApprovalView } from "@/server/types/api";

const STATE: Record<EffectStatus, ApprovalState> = {
  prepared: "pending",
  waiting_approval: "pending",
  authorized: "sending",
  dispatching: "sending",
  succeeded: "sent",
  denied: "declined",
  failed: "failed",
  uncertain: "uncertain",
};

/**
 * Approval cards are rendered from the persisted frozen proposal, never from
 * model text (spec 42.4). Every material field is shown.
 */
const str = (v: unknown): string =>
  v === null || v === undefined
    ? ""
    : Array.isArray(v)
      ? v.map(str).join(", ")
      : typeof v === "object"
        ? JSON.stringify(v)
        : String(v);

const humanize = (k: string) =>
  k
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/^\w/, (c) => c.toUpperCase());

function fieldsFrom(obj: Record<string, unknown>, skip: string[] = []): ApprovalField[] {
  return Object.entries(obj)
    .filter(([k, v]) => !skip.includes(k) && v !== null && v !== undefined && str(v) !== "")
    .map(([k, v]) => ({ label: humanize(k), value: str(v) }));
}

const list = (v: unknown): string[] =>
  (Array.isArray(v) ? v : v === null || v === undefined || v === "" ? [] : [v]).map(str).filter(Boolean);

function stateOf(e: EffectRow): ApprovalState {
  if (e.status === "authorized" && e.scheduled_for && e.scheduled_for.getTime() > Date.now()) return "scheduled";
  return STATE[e.status];
}

export function toApprovalView(
  e: EffectRow & {
    responsibility_title: string;
    decided_at?: Date | null;
    settled_at?: Date | null;
    superseded_by?: string | null;
  },
): ApprovalView {
  const a = e.canonical_args;
  const f = e.material_facts;
  const state = stateOf(e);
  const base = {
    effectId: e.id,
    responsibilityId: e.responsibility_id,
    responsibilityTitle: e.responsibility_title,
    effectClass: e.effect_class,
    proposalHash: e.proposal_hash,
    question: e.review_decision === "needs_confirmation" ? e.review_reason : null,
    createdAt: e.created_at.toISOString(),
    state,
    scheduledFor: e.scheduled_for ? e.scheduled_for.toISOString() : null,
    decidedAt: e.decided_at ? e.decided_at.toISOString() : null,
    settledAt: e.settled_at ? e.settled_at.toISOString() : null,
    supersededBy: e.superseded_by ?? null,
    supersedes: e.supersedes_effect_id,
    email: null,
    editable: false,
  };
  // A reviewer reason code (snake_case) is not a user-facing question.
  if (base.question && /^[a-z0-9_]+$/.test(base.question)) base.question = null;

  const key = `${e.provider}.${e.action}`;
  if (key === "agentmail.send_email" || key === "agentmail.reply") {
    const email = {
      from: str(a.fromInbox ?? a.from),
      to: list(a.to),
      cc: list(a.cc),
      subject: str(a.subject),
      body: str(a.text ?? a.body),
      isReply: typeof a.replyToMessageId === "string" || key === "agentmail.reply",
    };
    const fields: ApprovalField[] = [
      { label: "From", value: email.from },
      { label: "To", value: email.to.join(", ") },
    ];
    if (email.cc.length) fields.push({ label: "Cc", value: email.cc.join(", ") });
    fields.push({ label: "Subject", value: email.subject });
    return {
      ...base,
      kind: "email",
      title: email.subject ? `Email: ${email.subject}` : "Send an email",
      fields,
      body: email.body || null,
      email,
      // Only plain sends are editable; attachments/bcc would be uneditable hidden args.
      editable: key === "agentmail.send_email" && state === "pending" && !a.attachments && !a.bcc,
    };
  }
  if (e.provider === "kernel") {
    const isBooking = /book|reserv/i.test(e.action);
    return {
      ...base,
      kind: isBooking ? "booking" : "form",
      title: isBooking ? "Book this" : "Submit this form",
      fields: [...fieldsFrom(f), ...fieldsFrom(a, ["selector", "script", "instruction", "sessionHint"])],
      body: null,
    };
  }
  if (e.provider === "executor" && /calendar/i.test(e.action)) {
    return {
      ...base,
      kind: "calendar",
      title: /delete/i.test(e.action)
        ? "Remove this from your calendar"
        : /update/i.test(e.action)
          ? "Change this calendar event"
          : "Add this to your calendar",
      fields: [...fieldsFrom(f), ...fieldsFrom(a, ["program", "code"])],
      body: null,
    };
  }
  if (e.provider === "computer") {
    if (e.action === "user_environment_change") {
      return {
        ...base,
        kind: "computer",
        title: "Change the software on your computers",
        fields: fieldsFrom(f),
        body: null,
      };
    }
    return {
      ...base,
      kind: "computer",
      title: "Run this on August's computer",
      fields: fieldsFrom(f),
      body: str(a.command) || null,
    };
  }
  return {
    ...base,
    kind: "generic",
    title: humanize(e.action),
    fields: [...fieldsFrom(f), ...fieldsFrom(a)],
    body: null,
  };
}
