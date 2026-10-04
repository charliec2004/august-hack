"use client";

import { useState } from "react";
import { ArrowUpIcon, CheckIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AskUser } from "@/lib/genui";
import { cn } from "@/lib/utils";
import { useLaterUserReply, useSendReply } from "./hooks";

type Choice = AskUser["choices"][number];

/**
 * A question with tappable answers. Tapping replies as the user; once a later
 * user message exists the question shows as answered.
 */
export function ChoiceQuestion({ data }: { data: Partial<AskUser> }) {
  const { send, disabled } = useSendReply();
  const reply = useLaterUserReply();
  const [selected, setSelected] = useState<string[]>([]);
  const [other, setOther] = useState<string | null>(null);
  const choices = (data.choices ?? []).filter((c): c is Choice => Boolean(c?.label));
  if (!data.question || choices.length === 0) return null;

  const answered = reply !== null;
  const replyLower = reply?.toLowerCase() ?? "";
  const isPicked = (c: Choice) =>
    answered ? replyLower.includes(c.label.toLowerCase()) : selected.includes(c.id);
  const matched = answered && choices.some(isPicked);

  const onTap = (c: Choice) => {
    if (data.multi) {
      setSelected((s) => (s.includes(c.id) ? s.filter((id) => id !== c.id) : [...s, c.id]));
    } else {
      send(c.label);
    }
  };
  const sendMulti = () =>
    send(
      choices
        .filter((c) => selected.includes(c.id))
        .map((c) => c.label)
        .join(", "),
    );

  return (
    <section aria-label="Question" className="my-3">
      <p className="text-[15px] leading-relaxed font-medium">{data.question}</p>
      <div className="mt-2.5 flex flex-wrap gap-2">
        {choices.map((c) => {
          const picked = isPicked(c);
          return (
            <button
              key={c.id}
              type="button"
              disabled={answered || disabled}
              onClick={() => onTap(c)}
              aria-pressed={picked}
              className={cn(
                "focus-visible:ring-ring/50 inline-flex max-w-full flex-col items-start rounded-2xl border px-3.5 py-2 text-left text-sm transition-colors outline-none focus-visible:ring-2",
                picked
                  ? "border-foreground/50 bg-foreground text-background"
                  : "bg-card hover:bg-muted hover:border-foreground/25",
                answered && !picked && "opacity-45",
                !answered && disabled && "opacity-60",
              )}
            >
              <span className="flex items-center gap-1.5 font-medium">
                {picked && <CheckIcon className="size-3.5" />}
                {c.label}
              </span>
              {c.detail && (
                <span className={cn("text-xs", picked ? "text-background/75" : "text-muted-foreground")}>
                  {c.detail}
                </span>
              )}
            </button>
          );
        })}
        {data.allowOther && !answered && other === null && (
          <button
            type="button"
            disabled={disabled}
            onClick={() => setOther("")}
            className="text-muted-foreground hover:text-foreground hover:bg-muted rounded-2xl border border-dashed px-3.5 py-2 text-sm transition-colors"
          >
            Something else…
          </button>
        )}
      </div>
      {other !== null && !answered && (
        <form
          className="mt-2 flex max-w-md items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            send(other);
          }}
        >
          <input
            autoFocus
            value={other}
            onChange={(e) => setOther(e.target.value)}
            placeholder="Type your answer"
            className="bg-card focus-visible:border-foreground/30 min-w-0 flex-1 rounded-full border px-3.5 py-1.5 text-sm outline-none"
          />
          <Button type="submit" size="icon-sm" className="rounded-full" disabled={disabled || !other.trim()}>
            <ArrowUpIcon />
            <span className="sr-only">Send</span>
          </Button>
        </form>
      )}
      {data.multi && !answered && selected.length > 0 && (
        <Button size="sm" className="mt-2.5 rounded-full" disabled={disabled} onClick={sendMulti}>
          Send {selected.length === 1 ? "answer" : `${selected.length} answers`}
        </Button>
      )}
      {answered && !matched && reply && (
        <p className="text-muted-foreground mt-2 text-sm">
          You answered: <span className="text-foreground/85">{reply}</span>
        </p>
      )}
    </section>
  );
}
