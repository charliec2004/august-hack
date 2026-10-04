"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import type { DetailMoment } from "@/server/types/api";
import { formatWhen } from "./format";

/** One timeline, key moments by default; "Show all" reveals every step. */
export function MomentsTimeline({ moments }: { moments: DetailMoment[] }) {
  const [all, setAll] = useState(false);
  const keyMoments = moments.filter((m) => m.key);
  const shown = all || keyMoments.length === 0 ? moments : keyMoments;
  const hidden = moments.length - keyMoments.length;

  return (
    <div>
      <ol className="flex flex-col gap-2.5">
        {shown.map((m) => (
          <li key={m.id} className="flex items-baseline gap-3 text-sm leading-snug">
            <time
              dateTime={m.at}
              className="text-muted-foreground/70 w-[4.5rem] shrink-0 text-xs tabular-nums"
            >
              {formatWhen(m.at)}
            </time>
            <span className={cn("min-w-0", m.key ? "text-foreground/90" : "text-muted-foreground")}>
              {m.text}
              {m.count > 1 && <span className="text-muted-foreground/70 ml-1 text-xs">×{m.count}</span>}
            </span>
          </li>
        ))}
      </ol>
      {hidden > 0 && keyMoments.length > 0 && (
        <button
          type="button"
          onClick={() => setAll((v) => !v)}
          className="text-muted-foreground hover:text-foreground mt-3 text-xs transition-colors"
        >
          {all ? "Show key moments" : "Show all"}
        </button>
      )}
    </div>
  );
}
