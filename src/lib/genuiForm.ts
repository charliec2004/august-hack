/**
 * Question-form answers as one readable user message. The message is what the
 * model reads, so it stays plain: "How many guests? 2 · Cuisine: Italian".
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
