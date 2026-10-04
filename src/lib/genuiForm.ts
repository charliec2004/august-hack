/**
 * Question-form answers as one readable user message, and back. The message is
 * what the model reads, so it stays plain: "How many guests? 2 · Cuisine: Italian".
 */
import type { FormQuestion } from "./genui";

export type FormAnswer = {
  /** Choice ids picked (single/multi). */
  picked: string[];
  /** Typed "Other" text (single/multi) or the answer (text). */
  text: string;
  /** Selected value (scale). */
  value: number | null;
};

export const SEPARATOR = " · ";

export const emptyAnswer = (): FormAnswer => ({ picked: [], text: "", value: null });

/** Choice and scale questions must be answered; text questions are optional. */
export function isAnswered(q: FormQuestion, a: FormAnswer | undefined): boolean {
  if (q.kind === "text") return true;
  if (!a) return false;
  if (q.kind === "scale") return a.value !== null;
  return a.picked.length > 0 || a.text.trim() !== "";
}

/** The answer to one question as text, or "" when unanswered. */
export function answerText(q: FormQuestion, a: FormAnswer | undefined): string {
  if (!a) return "";
  if (q.kind === "scale") {
    if (a.value === null || !q.scale) return a.value === null ? "" : String(a.value);
    return `${a.value} of ${q.scale.max}`;
  }
  if (q.kind === "text") return a.text.trim();
  const labels = q.choices.filter((c) => a.picked.includes(c.id)).map((c) => c.label);
  if (a.text.trim()) labels.push(a.text.trim());
  return labels.join(", ");
}

/** "How many guests?" stays as is; "Cuisine" becomes "Cuisine:". */
export function promptPrefix(prompt: string): string {
  const p = prompt.trim();
  return /[?:]$/.test(p) ? p : `${p}:`;
}

/** One user message for the whole form. A single question replies with just its answer. */
export function composeFormReply(questions: FormQuestion[], answers: Record<string, FormAnswer>): string {
  const parts = questions
    .map((q) => ({ q, text: answerText(q, answers[q.id]) }))
    .filter((p) => p.text !== "");
  if (questions.length === 1) return parts[0]?.text ?? "";
  return parts.map((p) => `${promptPrefix(p.q.prompt)} ${p.text}`).join(SEPARATOR);
}

/**
 * Recover per-question answers from a reply composed by `composeFormReply`.
 * Returns null when the reply wasn't one (the person typed something else).
 */
export function parseFormReply(questions: FormQuestion[], reply: string): Record<string, string> | null {
  if (questions.length === 1) {
    const [q] = questions;
    const text = reply.trim();
    if (!text) return null;
    // A fixed-choice question only counts as answered by a reply naming one of its choices.
    const fixed = (q.kind === "single" || q.kind === "multi") && !q.allowOther;
    if (fixed && !q.choices.some((c) => text.toLowerCase().includes(c.label.toLowerCase()))) return null;
    return { [q.id]: text };
  }
  const found = questions
    .map((q) => ({ q, prefix: promptPrefix(q.prompt), at: reply.indexOf(promptPrefix(q.prompt)) }))
    .filter((f) => f.at >= 0)
    .sort((a, b) => a.at - b.at);
  if (found.length === 0) return null;
  const out: Record<string, string> = {};
  found.forEach((f, i) => {
    const end = i + 1 < found.length ? found[i + 1].at : reply.length;
    let value = reply.slice(f.at + f.prefix.length, end).trim();
    if (value.endsWith(SEPARATOR.trim())) value = value.slice(0, -1).trim();
    if (value) out[f.q.id] = value;
  });
  return out;
}
