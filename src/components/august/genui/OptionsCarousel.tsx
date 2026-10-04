"use client";

import { useState } from "react";
import { ArrowUpRightIcon, CheckIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { safeUrl, type OptionCard, type ShowOptions } from "@/lib/genui";
import { cn } from "@/lib/utils";
import { hostOf } from "../format";
import { CHOOSE_PREFIX, useCardAnswer, useSendReply } from "./hooks";
import { SafeImage } from "./SafeImage";

/**
 * A horizontally scrollable row of compact option cards. "Choose this" replies
 * as the user ("I choose: <name>") with an answer naming this card; only that
 * answer marks the pick.
 */
export function OptionsCarousel({ cardId, data }: { cardId: string | null; data: Partial<ShowOptions> }) {
  const { send, disabled } = useSendReply();
  const answer = useCardAnswer(cardId);
  const [picked, setPicked] = useState<string | null>(null);
  const answered = answer?.answers.chosen;
  const chosen = picked ?? (typeof answered === "string" ? answered : null);
  const options = (data.options ?? []).filter((o): o is OptionCard => Boolean(o?.name));
  if (options.length === 0) return null;

  return (
    <section aria-label={data.title ?? "Options"} className="my-3">
      {data.title && <h3 className="text-foreground/90 mb-2 text-sm font-medium">{data.title}</h3>}
      <ul className="-mx-2 flex snap-x snap-mandatory gap-3 overflow-x-auto px-2 pt-0.5 pb-3 [scrollbar-width:thin]">
        {options.map((o, i) => (
          <OptionItem
            key={o.id ?? i}
            option={o}
            chosen={chosen !== null && chosen === (o.id ?? String(i))}
            disabled={disabled || chosen !== null}
            onChoose={() => {
              if (!cardId) return;
              const id = o.id ?? String(i);
              setPicked(id);
              send(`${CHOOSE_PREFIX}${o.name}`, { cardId, answers: { chosen: id } });
            }}
          />
        ))}
      </ul>
    </section>
  );
}

function OptionItem({
  option: o,
  chosen,
  disabled,
  onChoose,
}: {
  option: OptionCard;
  chosen: boolean;
  disabled: boolean;
  onChoose: () => void;
}) {
  const link = safeUrl(o.url);
  const facts = (o.facts ?? []).filter((f) => f?.label && f?.value).slice(0, 3);
  return (
    <li
      className={cn(
        "bg-card text-card-foreground flex w-[15.5rem] shrink-0 snap-start flex-col overflow-hidden rounded-2xl border shadow-[0_1px_2px_rgba(60,40,20,0.04)] transition-shadow sm:w-[16.5rem]",
        chosen && "border-foreground/40 ring-foreground/15 ring-2",
      )}
    >
      <SafeImage src={o.imageUrl} alt="" className="aspect-[16/9] w-full" />
      <div className="flex flex-1 flex-col px-4 pt-3 pb-3.5">
        <div className="flex items-start justify-between gap-2">
          <p className="min-w-0 text-[15px] leading-snug font-medium">{o.name}</p>
          {o.badge && (
            <span className="bg-muted text-muted-foreground shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium">
              {o.badge}
            </span>
          )}
        </div>
        {o.subtitle && <p className="text-muted-foreground mt-0.5 line-clamp-2 text-[13px] leading-snug">{o.subtitle}</p>}
        {facts.length > 0 && (
          <dl className="mt-2.5 flex flex-col gap-1 text-[13px]">
            {facts.map((f, i) => (
              <div key={`${f.label}-${i}`} className="flex items-baseline justify-between gap-3">
                <dt className="text-muted-foreground shrink-0">{f.label}</dt>
                <dd className="line-clamp-2 min-w-0 text-right font-medium">{f.value}</dd>
              </div>
            ))}
          </dl>
        )}
        <div className="mt-auto flex items-center gap-2 pt-3.5">
          <Button
            size="sm"
            variant={chosen ? "default" : "outline"}
            className="flex-1 rounded-full"
            disabled={disabled}
            onClick={onChoose}
          >
            {chosen && <CheckIcon />}
            {chosen ? "Chosen" : "Choose this"}
          </Button>
          {link && (
            <a
              href={link}
              target="_blank"
              rel="noopener noreferrer"
              title={hostOf(link)}
              className="text-muted-foreground hover:text-foreground hover:bg-muted inline-flex shrink-0 items-center gap-0.5 rounded-full px-2 py-1 text-xs transition-colors"
            >
              View
              <ArrowUpRightIcon className="size-3.5" />
            </a>
          )}
        </div>
      </div>
    </li>
  );
}
