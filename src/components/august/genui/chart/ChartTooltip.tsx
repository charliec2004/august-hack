"use client";

export type TooltipState = {
  x: number;
  y: number;
  title: string;
  rows: { color: string; label: string; value: string }[];
};

const TIP_W = 168;

/** Hover readout. Text stays in text colors; a swatch carries series identity. */
export function ChartTooltip({ tip, width }: { tip: TooltipState; width: number }) {
  const left = tip.x + 12 + TIP_W > width ? Math.max(0, tip.x - 12 - TIP_W) : tip.x + 12;
  return (
    <div
      role="presentation"
      className="bg-popover text-popover-foreground pointer-events-none absolute z-10 rounded-lg border px-2.5 py-1.5 text-xs shadow-md"
      style={{ left, top: Math.max(0, tip.y - 16), width: TIP_W }}
    >
      <p className="text-muted-foreground mb-0.5 truncate">{tip.title}</p>
      {tip.rows.map((r) => (
        <p key={r.label} className="flex items-center gap-1.5">
          <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: r.color }} />
          <span className="min-w-0 flex-1 truncate">{r.label}</span>
          <span className="font-medium tabular-nums">{r.value}</span>
        </p>
      ))}
    </div>
  );
}
