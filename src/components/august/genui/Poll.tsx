"use client";

import { useState } from "react";
import { CheckIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ShowPoll } from "@/lib/genui";
import { cn } from "@/lib/utils";
import { useLaterUserReply, useSendReply } from "./hooks";

type PollOption = ShowPoll["options"][number];

/**
 * A quick preference poll. One person votes, so the result is their pick, not
 * percentages. The vote is sent as their reply.
 */
export function Poll({ data, complete = true }: { data: Partial<ShowPoll>; complete?: boolean }) {
  const { send, disabled } = useSendReply();
  const reply = useLaterUserReply();
  const [selected, setSelected] = useState<string[]>([]);
  const [voted, setVoted] = useState<string[] | null>(null);
  const options = (data.options ?? []).filter((o): o is PollOption => Boolean(o?.id && o?.label));
  if (!data.question || options.length === 0) return null;

  const replyLower = reply?.toLowerCase() ?? null;
  const picks =
    voted ?? (replyLower !== null ? options.filter((o) => replyLower.includes(o.label.toLowerCase())).map((o) => o.id) : null);
  const done = picks !== null;

  const vote = (ids: string[]) => {
    const labels = options.filter((o) => ids.includes(o.id)).map((o) => o.label);
    if (labels.length === 0) return;
    setVoted(ids);
    send(labels.join(", "));
  };
  const tap = (id: string) => {
    if (!data.multi) return vote([id]);
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  };

  return (
    <section aria-label={data.question} className="bg-card my-3 max-w-md rounded-2xl border px-4 py-3.5">
      <p className="text-[15px] leading-snug font-medium">{data.question}</p>
      <ul className="mt-2.5 flex flex-col gap-1.5" role={done ? "list" : data.multi ? "group" : "radiogroup"}>
        {options.map((o) => {
          const picked = done ? picks.includes(o.id) : selected.includes(o.id);
          return (
            <li key={o.id}>
              {done ? (
                <div
                  className={cn(
                    "relative flex items-center justify-between overflow-hidden rounded-xl px-3.5 py-2 text-sm",
                    picked ? "bg-foreground/[0.07] font-medium" : "text-muted-foreground",
                  )}
                >
                  <span className="flex items-center gap-1.5">
                    {picked && <CheckIcon className="size-3.5" />}
                    {o.label}
                  </span>
                  {picked && <span className="text-muted-foreground text-xs font-normal">Your pick</span>}
                </div>
              ) : (
                <button
                  type="button"
                  role={data.multi ? "checkbox" : "radio"}
                  aria-checked={picked}
                  disabled={disabled || !complete}
                  onClick={() => tap(o.id)}
                  className={cn(
                    "focus-visible:ring-ring/50 flex w-full items-center gap-2.5 rounded-xl border px-3.5 py-2 text-left text-sm transition-colors outline-none focus-visible:ring-2",
                    picked ? "border-foreground/60 bg-muted" : "bg-background hover:bg-muted",
                  )}
                >
                  <span
                    aria-hidden
                    className={cn(
                      "flex size-4 shrink-0 items-center justify-center border",
                      data.multi ? "rounded-[5px]" : "rounded-full",
                      picked ? "border-foreground bg-foreground text-background" : "border-foreground/30",
                    )}
                  >
                    {picked && <CheckIcon className="size-3" />}
                  </span>
                  {o.label}
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {!done && data.multi && (
        <div className="mt-3 flex justify-end">
          <Button size="sm" className="rounded-full px-4" disabled={disabled || selected.length === 0} onClick={() => vote(selected)}>
            Vote
          </Button>
        </div>
      )}
    </section>
  );
}
