"use client";

export type TooltipState = {
  x: number;
  y: number;
  title: string;
  rows: { color: string; label: string; value: string }[];
};

/**
 * Hover readout. Text stays in text colors; a swatch carries series identity.
 * It sizes to its content (full series names) and opens away from the edge.
 */
export function ChartTooltip({ tip, width }: { tip: TooltipState; width: number }) {
  const flip = tip.x > width / 2;
  return (
    <div
      role="presentation"
      className="bg-popover text-popover-foreground pointer-events-none absolute z-10 max-w-xs rounded-lg border px-2.5 py-1.5 text-xs whitespace-nowrap shadow-md"
      style={{ top: Math.max(0, tip.y - 16), ...(flip ? { right: width - tip.x + 12 } : { left: tip.x + 12 }) }}
    >
      <p className={tip.rows.length ? "text-muted-foreground mb-0.5" : "font-medium tabular-nums"}>{tip.title}</p>
      {tip.rows.map((r) => (
        <p key={r.label} className="flex items-center gap-1.5">
          <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: r.color }} />
          <span className="flex-1">{r.label}</span>
          <span className="ml-3 font-medium tabular-nums">{r.value}</span>
        </p>
      ))}
    </div>
  );
}
