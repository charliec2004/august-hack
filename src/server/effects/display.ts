import "server-only";

import type { EffectRow } from "@/server/db/effects";
import type { ApprovalField, ApprovalView } from "@/server/types/api";

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

export function toApprovalView(
  e: EffectRow & { responsibility_title: string },
): ApprovalView {
  const a = e.canonical_args;
  const f = e.material_facts;
  const base = {
    effectId: e.id,
    responsibilityId: e.responsibility_id,
    responsibilityTitle: e.responsibility_title,
    effectClass: e.effect_class,
    proposalHash: e.proposal_hash,
    question: e.review_decision === "needs_confirmation" ? e.review_reason : null,
    createdAt: e.created_at.toISOString(),
  };
  // A reviewer reason code (snake_case) is not a user-facing question.
  if (base.question && /^[a-z0-9_]+$/.test(base.question)) base.question = null;

  const key = `${e.provider}.${e.action}`;
  if (key === "agentmail.send_email" || key === "agentmail.reply") {
    const fields: ApprovalField[] = [
      { label: "From", value: str(a.fromInbox ?? a.from) },
      { label: "To", value: str(a.to) },
    ];
    if (a.cc) fields.push({ label: "Cc", value: str(a.cc) });
    if (a.bcc) fields.push({ label: "Bcc", value: str(a.bcc) });
    fields.push({ label: "Subject", value: str(a.subject) });
    if (a.attachments) fields.push({ label: "Attachments", value: str(a.attachments) });
    return { ...base, kind: "email", headline: "August wants to send:", fields, body: str(a.text ?? a.body) || null };
  }
  if (e.provider === "kernel") {
    const isBooking = /book|reserv/i.test(e.action);
    return {
      ...base,
      kind: isBooking ? "booking" : "form",
      headline: isBooking ? "August wants to book:" : "August wants to submit:",
      fields: [...fieldsFrom(f), ...fieldsFrom(a, ["selector", "script", "instruction", "sessionHint"])],
      body: null,
    };
  }
  if (e.provider === "executor" && /calendar/i.test(e.action)) {
    return {
      ...base,
      kind: "calendar",
      headline: "August wants to change your calendar:",
      fields: [...fieldsFrom(f), ...fieldsFrom(a, ["program", "code"])],
      body: null,
    };
  }
  if (e.provider === "computer") {
    if (e.action === "user_environment_change") {
      return {
        ...base,
        kind: "computer",
        headline: "August wants to change the software on your computers:",
        fields: fieldsFrom(f),
        body: null,
      };
    }
    return {
      ...base,
      kind: "computer",
      headline: "August wants to run this on its computer:",
      fields: fieldsFrom(f),
      body: str(a.command) || null,
    };
  }
  return {
    ...base,
    kind: "generic",
    headline: "August wants to do this:",
    fields: [{ label: "Action", value: humanize(e.action) }, ...fieldsFrom(f), ...fieldsFrom(a)],
    body: null,
  };
}
