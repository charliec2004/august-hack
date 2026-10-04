"use client";

import { useState } from "react";
import { ChevronDownIcon, MonitorPlayIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { LiveBrowser, TimelineActivityItem } from "@/server/types/api";
import { formatWhen } from "./format";
import { liveBrowserForLine, useShellActions } from "./shellActions";
import { useAugust } from "./useAugustState";

type Line = Pick<TimelineActivityItem, "id" | "text" | "at" | "responsibilityId" | "browserSessionId"> & {
  responsibilityTitle?: string | null;
};

/**
 * A run of August's steps inline in the conversation, where they happened.
 * Just "Worked" by default; expands to the individual steps.
 */
export function ActivityLines({ items }: { items: TimelineActivityItem[] }) {
  const [expanded, setExpanded] = useState(false);
  const { state } = useAugust();
  const { watch } = useShellActions();
  if (items.length === 0) return null;
  const live = items.map((i) => liveBrowserForLine(state, i)).find(Boolean) ?? null;

  return (
    <div data-slot="august-activity" className="my-1 text-[13px] leading-5">
      <div className="flex items-baseline gap-1.5">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="text-muted-foreground hover:text-foreground inline-flex min-w-0 items-baseline gap-1 text-left transition-colors"
        >
          <span>Worked</span>
          <ChevronDownIcon className={cn("size-3.5 shrink-0 translate-y-[2px] transition-transform", expanded && "rotate-180")} />
        </button>
        {live && <WatchButton browser={live} onWatch={watch} />}
      </div>
      {expanded && (
        <div className="mt-1 border-l pl-3">
          <ActivityList items={items} />
        </div>
      )}
    </div>
  );
}

/** Plain list of activity lines. "Watch browser" only while that session is live. */
export function ActivityList({ items, showTitles = false }: { items: Line[]; showTitles?: boolean }) {
  const { state } = useAugust();
  const { watch, openResponsibility } = useShellActions();
  return (
    <ol className="flex flex-col">
      {items.map((item, i) => {
        const live = liveBrowserForLine(state, item);
        // Name the responsibility once per stretch, not on every line.
        const titled =
          showTitles &&
          item.responsibilityTitle &&
          item.responsibilityId &&
          items[i - 1]?.responsibilityId !== item.responsibilityId;
        return (
          <li
            key={item.id}
            className="animate-in fade-in flex items-baseline gap-2 py-0.5 text-[13px] leading-5 duration-300"
          >
            <span className="bg-muted-foreground/35 size-1 shrink-0 translate-y-[-2px] rounded-full" aria-hidden />
            <div className="text-muted-foreground min-w-0 flex-1">
              {titled ? (
                <button
                  type="button"
                  onClick={() => openResponsibility(item.responsibilityId!)}
                  className="hover:text-foreground mr-1.5 transition-colors"
                >
                  {item.responsibilityTitle}
                  <span aria-hidden> ·</span>
                </button>
              ) : null}
              <span className="text-foreground/75">{item.text}</span>
              <time dateTime={item.at} className="text-muted-foreground/60 ml-2 text-xs tabular-nums">
                {formatWhen(item.at)}
              </time>
              {live && <WatchButton browser={live} onWatch={watch} />}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function WatchButton({ browser, onWatch }: { browser: LiveBrowser; onWatch: (b: LiveBrowser) => void }) {
  return (
    <button
      type="button"
      onClick={() => onWatch(browser)}
      className="text-foreground/70 hover:text-foreground hover:bg-muted ml-2 inline-flex translate-y-[1px] items-center gap-1 rounded-md px-1.5 text-xs transition-colors"
    >
      <span className="bg-live relative flex size-1.5 rounded-full" aria-hidden>
        <span className="bg-live absolute inset-0 animate-ping rounded-full opacity-60 motion-reduce:hidden" />
      </span>
      <MonitorPlayIcon className="size-3.5" />
      Watch browser
    </button>
  );
}
