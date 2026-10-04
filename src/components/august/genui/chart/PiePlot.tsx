"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import type { Slice } from "./data";
import { arcPath, formatTick, isCompactAxis, seriesColor } from "./scale";

const SIZE = 168;

/** Parts of a whole: a ring with a 2px surface gap, and a labeled legend beside it. */
export function PiePlot({ slices, unit }: { slices: Slice[]; unit: string | null }) {
  const [active, setActive] = useState<number | null>(null);
  const total = slices.reduce((sum, s) => sum + s.value, 0);
  if (total <= 0) return null;
  const r = SIZE / 2;
  const turn = (v: number) => (v / total) * Math.PI * 2;
  const arcs = slices.reduce<{ a0: number; a1: number }[]>((acc, s) => {
    const a0 = acc.length ? acc[acc.length - 1].a1 : 0;
    return [...acc, { a0, a1: a0 + turn(s.value) }];
  }, []);
  const pct = (v: number) => `${Math.round((v / total) * 100)}%`;
  const shown = active !== null ? slices[active] : null;

  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-3" onMouseLeave={() => setActive(null)}>
      <div className="relative shrink-0" style={{ width: SIZE, height: SIZE }}>
        <svg width={SIZE} height={SIZE} aria-hidden className="block">
          {slices.map((s, i) => (
            <path
              key={s.label}
              d={arcPath(r, r, r - 1, r * 0.6, arcs[i].a0, arcs[i].a1)}
              fill={seriesColor(i)}
              stroke="var(--card)"
              strokeWidth={2}
              strokeLinejoin="round"
              opacity={active === null || active === i ? 1 : 0.35}
              onMouseEnter={() => setActive(i)}
            />
          ))}
        </svg>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
          <span className="text-sm font-medium tabular-nums">{formatTick(shown?.value ?? total, unit, isCompactAxis([total]))}</span>
          <span className="text-muted-foreground max-w-20 truncate text-xs">{shown ? shown.label : "Total"}</span>
        </div>
      </div>
      <ul className="min-w-40 flex-1 text-[13px]">
        {slices.map((s, i) => (
          <li
            key={s.label}
            onMouseEnter={() => setActive(i)}
            className={cn("flex items-center gap-2 py-0.5", active !== null && active !== i && "opacity-50")}
          >
            <span aria-hidden className="size-2.5 shrink-0 rounded-full" style={{ background: seriesColor(i) }} />
            <span className="min-w-0 flex-1 truncate">{s.label}</span>
            <span className="text-muted-foreground tabular-nums">{pct(s.value)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
