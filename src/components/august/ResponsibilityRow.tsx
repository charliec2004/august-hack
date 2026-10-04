"use client";

import { MonitorPlayIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ResponsibilityView } from "@/server/types/api";
import { formatWhen, isFinished } from "./format";

export function ResponsibilityRow({
  responsibility: r,
  selected,
  onOpen,
  onWatch,
}: {
  responsibility: ResponsibilityView;
  selected?: boolean;
  onOpen: () => void;
  onWatch: () => void;
}) {
  const needsYou = r.humanStatus === "Needs you";
  const finished = isFinished(r);
  const nextCheck =
    r.nextWakeAt && !finished && !r.active ? formatWhen(r.nextWakeAt) : null;

  return (
    <li className="group/row relative">
      <button
        type="button"
        onClick={onOpen}
        aria-current={selected ? "true" : undefined}
        className={cn(
          "hover:bg-sidebar-accent focus-visible:ring-ring/50 w-full rounded-xl px-3 py-2.5 text-left transition-colors outline-none focus-visible:ring-2",
          selected && "bg-sidebar-accent",
          needsYou && "bg-attention/8 hover:bg-attention/12",
        )}
      >
        <div className="flex items-start gap-2.5">
          <StatusDot r={r} />
          <div className="min-w-0 flex-1">
            <p
              className={cn(
                "truncate text-sm leading-5 font-medium",
                finished && "text-muted-foreground",
              )}
            >
              {r.title}
            </p>
            <p
              className={cn(
                "text-muted-foreground mt-0.5 truncate text-[13px] leading-5",
                needsYou && "text-attention-foreground font-medium",
              )}
            >
              {r.humanStatus}
            </p>
            {nextCheck && (
              <p className="text-muted-foreground/80 truncate text-xs leading-5">
                Next check {nextCheck}
              </p>
            )}
          </div>
        </div>
      </button>
      {r.liveViewUrl && (
        <button
          type="button"
          onClick={onWatch}
          className="text-muted-foreground hover:text-foreground hover:bg-background/80 focus-visible:ring-ring/50 mt-0.5 mb-1 ml-[2.1rem] inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs transition-colors outline-none focus-visible:ring-2"
        >
          <MonitorPlayIcon className="size-3.5" />
          Watch browser
        </button>
      )}
    </li>
  );
}

function StatusDot({ r }: { r: ResponsibilityView }) {
  const finished = isFinished(r);
  const needsYou = r.humanStatus === "Needs you";
  return (
    <span className="mt-[7px] flex size-2 shrink-0 items-center justify-center" aria-hidden>
      {r.active ? (
        <span className="bg-live relative flex size-2 rounded-full">
          <span className="bg-live absolute inset-0 animate-ping rounded-full opacity-50 motion-reduce:hidden" />
        </span>
      ) : needsYou ? (
        <span className="bg-attention size-2 rounded-full" />
      ) : finished ? (
        <span className="border-muted-foreground/40 size-2 rounded-full border" />
      ) : (
        <span className="bg-muted-foreground/35 size-2 rounded-full" />
      )}
    </span>
  );
}
