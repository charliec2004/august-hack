"use client";

import { useState } from "react";
import { ChevronDownIcon, MonitorPlayIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ActivityItem, ResponsibilityView } from "@/server/types/api";
import { formatWhen } from "./format";

const COLLAPSED_COUNT = 4;

function chronological(items: ActivityItem[]) {
  return [...items].sort(
    (a, b) => new Date(a.at).getTime() - new Date(b.at).getTime(),
  );
}

/**
 * Calm, evidence-oriented record of what August actually did. Lives under the
 * conversation; newest at the bottom like the thread itself.
 */
export function ActivityFeed({
  activity,
  responsibilities,
  onWatch,
  onOpenResponsibility,
}: {
  activity: ActivityItem[];
  responsibilities: ResponsibilityView[];
  onWatch: (item: ActivityItem) => void;
  onOpenResponsibility: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  if (activity.length === 0) return null;

  const items = chronological(activity);
  const hidden = Math.max(0, items.length - COLLAPSED_COUNT);
  const visible = expanded ? items : items.slice(-COLLAPSED_COUNT);
  const titles = new Map(responsibilities.map((r) => [r.id, r.title]));

  return (
    <section aria-label="Activity" className="mb-6 px-2">
      <div className="mb-1.5 flex items-center gap-2">
        <h2 className="text-muted-foreground text-[11px] font-semibold tracking-[0.12em] uppercase">
          Activity
        </h2>
        <span className="bg-border h-px flex-1" aria-hidden />
        {hidden > 0 && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs transition-colors"
          >
            {expanded ? "Show less" : `${hidden} earlier`}
            <ChevronDownIcon
              className={cn(
                "size-3.5 transition-transform",
                expanded && "rotate-180",
              )}
            />
          </button>
        )}
      </div>
      <ActivityList
        items={visible}
        titles={titles}
        onWatch={onWatch}
        onOpenResponsibility={onOpenResponsibility}
      />
    </section>
  );
}

export function ActivityList({
  items,
  titles,
  onWatch,
  onOpenResponsibility,
}: {
  items: ActivityItem[];
  titles?: Map<string, string>;
  onWatch?: (item: ActivityItem) => void;
  onOpenResponsibility?: (id: string) => void;
}) {
  return (
    <ol className="flex flex-col">
      {items.map((item) => {
        const title =
          item.responsibilityId && titles?.get(item.responsibilityId);
        return (
          <li
            key={item.id}
            className="animate-in fade-in grid grid-cols-[4.75rem_1fr] items-baseline gap-x-3 py-1 text-[13px] leading-5 duration-300"
          >
            <time
              dateTime={item.at}
              className="text-muted-foreground/80 text-right text-xs tabular-nums"
            >
              {formatWhen(item.at)}
            </time>
            <div className="min-w-0">
              {title && item.responsibilityId && onOpenResponsibility ? (
                <button
                  type="button"
                  onClick={() => onOpenResponsibility(item.responsibilityId!)}
                  className="text-muted-foreground hover:text-foreground mr-1.5 transition-colors"
                >
                  {title}
                  <span aria-hidden> ·</span>
                </button>
              ) : null}
              <span className="text-foreground/85">{item.text}</span>
              {item.liveViewUrl && onWatch && (
                <button
                  type="button"
                  onClick={() => onWatch(item)}
                  className="text-foreground/70 hover:text-foreground hover:bg-muted ml-2 inline-flex translate-y-[1px] items-center gap-1 rounded-md px-1.5 text-xs transition-colors"
                >
                  <span className="bg-live relative flex size-1.5 rounded-full" aria-hidden>
                    <span className="bg-live absolute inset-0 animate-ping rounded-full opacity-60 motion-reduce:hidden" />
                  </span>
                  <MonitorPlayIcon className="size-3.5" />
                  Watch browser
                </button>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
