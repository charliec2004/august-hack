"use client";

import { useState } from "react";
import { ChevronUpIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ResponsibilityView } from "@/server/types/api";
import { isFinished, sortResponsibilities } from "./format";
import { ResponsibilityRow } from "./ResponsibilityRow";

const DONE_LIMIT = 5;

export function ResponsibilityRail({
  responsibilities,
  loading,
  selectedId,
  onOpen,
  onWatch,
  footer,
}: {
  responsibilities: ResponsibilityView[];
  loading: boolean;
  selectedId: string | null;
  onOpen: (id: string) => void;
  onWatch: (id: string) => void;
  footer?: React.ReactNode;
}) {
  const sorted = sortResponsibilities(responsibilities);
  const open = sorted.filter((r) => !isFinished(r));
  const done = sorted.filter(isFinished).slice(0, DONE_LIMIT);

  return (
    <nav aria-label="What August owns" className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pt-4 pb-4">
        {loading ? (
          <RailSkeleton />
        ) : open.length === 0 && done.length === 0 ? (
          <p className="text-muted-foreground px-3 py-2 text-sm leading-relaxed">
            No tasks yet
          </p>
        ) : (
          <>
            <ul className="flex flex-col gap-0.5">
              {open.map((r) => (
                <ResponsibilityRow
                  key={r.id}
                  responsibility={r}
                  selected={r.id === selectedId}
                  onOpen={() => onOpen(r.id)}
                  onWatch={() => onWatch(r.id)}
                />
              ))}
            </ul>
          </>
        )}
      </div>
      {!loading && done.length > 0 && (
        <FinishedSection done={done} selectedId={selectedId} onOpen={onOpen} onWatch={onWatch} />
      )}
      {footer}
    </nav>
  );
}

/**
 * Finished items, pinned to the bottom of the rail and opening upward, so
 * active work keeps the top and history stays out of the way.
 */
function FinishedSection({
  done,
  selectedId,
  onOpen,
  onWatch,
}: {
  done: ResponsibilityView[];
  selectedId: string | null;
  onOpen: (id: string) => void;
  onWatch: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex max-h-[45%] shrink-0 flex-col px-2 pb-1">
      {open && (
        <ul className="mb-1 flex min-h-0 flex-col gap-0.5 overflow-y-auto">
          {done.map((r) => (
            <ResponsibilityRow
              key={r.id}
              responsibility={r}
              selected={r.id === selectedId}
              onOpen={() => onOpen(r.id)}
              onWatch={() => onWatch(r.id)}
            />
          ))}
        </ul>
      )}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 flex items-center gap-1 rounded-md px-3 py-1.5 text-sm transition-colors outline-none focus-visible:ring-2"
      >
        <ChevronUpIcon className={cn("size-3.5 transition-transform", open && "rotate-180")} />
        Finished
      </button>
    </div>
  );
}

function RailSkeleton() {
  return (
    <div className="flex flex-col gap-3 px-3 py-2" aria-hidden>
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex flex-col gap-1.5">
          <div className="bg-muted h-3.5 w-3/4 animate-pulse rounded" />
          <div className="bg-muted/70 h-3 w-1/2 animate-pulse rounded" />
        </div>
      ))}
    </div>
  );
}
