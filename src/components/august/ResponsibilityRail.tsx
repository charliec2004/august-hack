"use client";

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
            Nothing yet.
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
            {done.length > 0 && (
              <>
                <ul className="mt-4 flex flex-col gap-0.5" aria-label="Finished">
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
              </>
            )}
          </>
        )}
      </div>
      {footer}
    </nav>
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
