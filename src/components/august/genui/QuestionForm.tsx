"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { normalizeForm, type AskUser, type FormQuestion, type LegacyAskUser } from "@/lib/genui";
import {
  answerText,
  composeFormReply,
  emptyAnswer,
  isAnswered,
  type FormAnswer,
} from "@/lib/genuiForm";
import { cn } from "@/lib/utils";
import { ChoiceChip, ScaleControl, textFieldClass } from "./controls";
import { useCardAnswer, useSendReply } from "./hooks";

type Answers = Record<string, FormAnswer>;

/**
 * ask_user as one native form. A single Send replies with every answer in one
 * readable message; afterwards the card shows a compact summary of the answers.
 */
export function QuestionForm({
  cardId,
  data,
  complete = true,
}: {
  cardId: string | null;
  data: Partial<AskUser> & LegacyAskUser;
  complete?: boolean;
}) {
  const { send, disabled } = useSendReply();
  const answer = useCardAnswer(cardId);
  const [answers, setAnswers] = useState<Answers>({});
  const [sent, setSent] = useState<Record<string, string> | null>(null);
  const form = normalizeForm(data);
  const { questions } = form;
  if (questions.length === 0) return null;

  // Resolved only by a submission of this card, never by an unrelated later message.
  const resolved = sent ?? (answer ? flatten(answer.answers) : null);
  if (resolved) return <ResolvedForm title={form.title} questions={questions} answers={resolved} />;

  const update = (id: string, next: Partial<FormAnswer>) =>
    setAnswers((a) => ({ ...a, [id]: { ...(a[id] ?? emptyAnswer()), ...next } }));

  const submit = (all: Answers) => {
    const text = composeFormReply(questions, all);
    if (!text || !cardId) return;
    const answers = Object.fromEntries(questions.map((q) => [q.id, answerText(q, all[q.id])]).filter(([, v]) => v));
    setSent(answers);
    send(text, { cardId, answers });
  };

  // A lone one-of-many question answers on tap, like a quick reply.
  const instant = questions.length === 1 && questions[0].kind === "single" && !questions[0].allowOther;
  const ready = complete && questions.every((q) => isAnswered(q, answers[q.id]));

  return (
    <section aria-label={form.title ?? "Questions"} className="bg-card my-3 max-w-xl rounded-2xl border px-4 py-3.5">
      {form.title && <p className="mb-3 text-[15px] leading-snug font-medium">{form.title}</p>}
      <div className="flex flex-col gap-4">
        {questions.map((q) => (
          <QuestionField
            key={q.id}
            question={q}
            answer={answers[q.id]}
            disabled={disabled}
            onChange={(next) => {
              if (instant && next.picked?.length) {
                submit({ [q.id]: { ...emptyAnswer(), ...next } });
              } else {
                update(q.id, next);
              }
            }}
          />
        ))}
      </div>
      {!instant && (
        <div className="mt-4 flex justify-end">
          <Button size="sm" className="rounded-full px-4" disabled={!ready || disabled} onClick={() => submit(answers)}>
            {form.submitLabel ?? "Send"}
          </Button>
        </div>
      )}
    </section>
  );
}

function QuestionField({
  question: q,
  answer,
  disabled,
  onChange,
}: {
  question: FormQuestion;
  answer: FormAnswer | undefined;
  disabled: boolean;
  onChange: (next: Partial<FormAnswer>) => void;
}) {
  const a = answer ?? emptyAnswer();
  const [otherOpen, setOtherOpen] = useState(false);
  const promptId = `q-${q.id}`;

  if (q.kind === "text") {
    return (
      <div>
        <label htmlFor={promptId} className="mb-1.5 block text-sm font-medium">
          {q.prompt}
        </label>
        <textarea
          id={promptId}
          rows={1}
          value={a.text}
          disabled={disabled}
          placeholder={q.placeholder ?? ""}
          onChange={(e) => onChange({ text: e.target.value })}
          className={cn(textFieldClass, "field-sizing-content max-h-40 min-h-9 resize-none")}
        />
      </div>
    );
  }

  if (q.kind === "scale") {
    const s = q.scale ?? { min: 1, max: 5, minLabel: null, maxLabel: null };
    return (
      <div>
        <p id={promptId} className="mb-1.5 text-sm font-medium">
          {q.prompt}
        </p>
        <ScaleControl {...s} label={q.prompt} value={a.value} disabled={disabled} onChange={(value) => onChange({ value })} />
      </div>
    );
  }

  const multi = q.kind === "multi";
  const wide = q.choices.some((c) => c.detail);
  const toggle = (id: string) => {
    if (multi) onChange({ picked: a.picked.includes(id) ? a.picked.filter((p) => p !== id) : [...a.picked, id] });
    else {
      setOtherOpen(false);
      onChange({ picked: [id], text: "" });
    }
  };
  const toggleOther = () => {
    const open = !otherOpen;
    setOtherOpen(open);
    if (!open) onChange({ text: "" });
    else if (!multi) onChange({ picked: [] });
  };

  return (
    <div role={multi ? "group" : "radiogroup"} aria-labelledby={promptId}>
      <p id={promptId} className="mb-1.5 text-sm font-medium">
        {q.prompt}
        {multi && <span className="text-muted-foreground font-normal"> (any that apply)</span>}
      </p>
      <div className={cn("flex gap-1.5", wide ? "flex-col" : "flex-wrap")}>
        {q.choices.map((c) => (
          <ChoiceChip
            key={c.id}
            label={c.label}
            detail={c.detail}
            wide={wide}
            role={multi ? "checkbox" : "radio"}
            selected={a.picked.includes(c.id)}
            disabled={disabled}
            onClick={() => toggle(c.id)}
          />
        ))}
        {q.allowOther && (
          <ChoiceChip
            label="Other…"
            wide={wide}
            role={multi ? "checkbox" : "radio"}
            selected={otherOpen}
            disabled={disabled}
            onClick={toggleOther}
          />
        )}
      </div>
      {otherOpen && (
        <input
          autoFocus
          aria-label={`${q.prompt} (other)`}
          value={a.text}
          disabled={disabled}
          placeholder={q.placeholder ?? "Type your answer"}
          onChange={(e) => onChange({ text: e.target.value })}
          className={cn(textFieldClass, "mt-2")}
        />
      )}
    </div>
  );
}

/** Read-only summary of what was submitted. */
function ResolvedForm({
  title,
  questions,
  answers,
}: {
  title: string | null;
  questions: FormQuestion[];
  answers: Record<string, string>;
}) {
  const rows = questions.filter((q) => answers[q.id]);
  return (
    <section aria-label={title ?? "Your answers"} className="bg-muted/40 my-3 max-w-xl rounded-2xl border px-4 py-3 text-sm">
      {title && <p className="mb-1.5 font-medium">{title}</p>}
      {rows.length > 0 ? (
        <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-4 gap-y-1">
          {rows.map((q) => (
            <div key={q.id} className="contents">
              <dt className="text-muted-foreground">{q.prompt}</dt>
              <dd>{answers[q.id]}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="text-muted-foreground">Sent</p>
      )}
    </section>
  );
}

const flatten = (answers: Record<string, string | string[]>): Record<string, string> =>
  Object.fromEntries(Object.entries(answers).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : v]));
