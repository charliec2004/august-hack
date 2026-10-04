"use client";

import { useState } from "react";
import { FastForwardIcon, LoaderCircleIcon, MonitorPlayIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ResponsibilityView } from "@/server/types/api";
import { isFinished } from "./format";
import { useAugust } from "./useAugustState";

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
  const canSkip = Boolean(r.nextWakeAt) && !finished && !r.active;

  return (
    <li className="group/row relative">
      <button
        type="button"
        onClick={onOpen}
        aria-current={selected ? "true" : undefined}
        className={cn(
          "hover:bg-sidebar-accent focus-visible:ring-ring/50 w-full rounded-lg px-3 py-2 text-left transition-colors outline-none focus-visible:ring-2",
          selected && "bg-sidebar-accent",
          r.liveViewUrl && "pr-24",
        )}
      >
        <div className="flex items-center gap-2.5" title={r.humanStatus}>
          <StatusDot r={r} />
          <p className={cn("min-w-0 flex-1 truncate text-sm", finished && "text-muted-foreground")}>{r.title}</p>
          {needsYou && (
            <span className="bg-attention/15 text-attention-foreground shrink-0 rounded-full px-2 py-0.5 text-xs">
              Needs you
            </span>
          )}
        </div>
      </button>
      {canSkip && <SkipWait responsibilityId={r.id} />}
      {r.liveViewUrl && (
        <button
          type="button"
          onClick={onWatch}
          title="Watch the browser"
          className="bg-background text-foreground/80 hover:text-foreground focus-visible:ring-ring/50 absolute top-1/2 right-2 inline-flex -translate-y-1/2 items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs transition-colors outline-none focus-visible:ring-2"
        >
          <span className="bg-live size-1.5 rounded-full" aria-hidden />
          <MonitorPlayIcon className="size-3.5" />
          Watch
        </button>
      )}
    </li>
  );
}

function StatusDot({ r }: { r: ResponsibilityView }) {
  const finished = isFinished(r);
  const needsYou = r.humanStatus === "Needs you";
  return (
    <span className="flex size-2 shrink-0 items-center justify-center" aria-hidden>
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

/** Demo: run the scheduled check now instead of waiting (real wake, real resume). */
function SkipWait({ responsibilityId }: { responsibilityId: string }) {
  const { state, wake } = useAugust();
  const [busy, setBusy] = useState(false);
  if (!state?.demoControls) return null;
  return (
    <button
      type="button"
      title="Don't wait — check now"
      aria-label="Don't wait, check now"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await wake(responsibilityId);
        setBusy(false);
      }}
      className="text-muted-foreground hover:text-foreground hover:bg-background/80 absolute top-1/2 right-2 -translate-y-1/2 rounded-md p-1 opacity-0 transition group-hover/row:opacity-100 focus-visible:opacity-100"
    >
      {busy ? <LoaderCircleIcon className="size-3.5 animate-spin" /> : <FastForwardIcon className="size-3.5" />}
    </button>
  );
}
