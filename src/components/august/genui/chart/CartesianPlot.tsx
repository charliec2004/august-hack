"use client";

import { useRef, useState } from "react";
import { categories, numericX, valueAt, type Series } from "./data";
import { barPath, formatTick, formatValue, linear, niceTicks, seriesColor, isCompactAxis } from "./scale";
import { ChartTooltip, type TooltipState } from "./ChartTooltip";

const HEIGHT = 208;
const TOP = 10;
const BOTTOM = 26;
const RIGHT = 14;
const BAR_MAX = 24;
const GAP = 2;

/** Bar, line, and scatter on one shared x/y frame. Hover shows values. */
export function CartesianPlot({
  kind,
  series,
  unit,
  width,
}: {
  kind: "bar" | "line" | "scatter";
  series: Series[];
  unit: string | null;
  width: number;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<{ index: number; tip: TooltipState } | null>(null);

  const cats = categories(series);
  const numeric = kind !== "bar" && numericX(series) && cats.length > 1;
  const ys = series.flatMap((s) => s.points.map((p) => p.y));
  let yMin = Math.min(...ys);
  let yMax = Math.max(...ys);
  if (kind === "bar" || (yMin >= 0 && yMin < yMax * 0.5)) yMin = Math.min(0, yMin);
  if (kind === "bar") yMax = Math.max(0, yMax);
  const yTicks = niceTicks(yMin, yMax, 5);
  const yCompact = isCompactAxis(yTicks);
  const tickLabels = yTicks.map((t) => formatTick(t, unit, yCompact));
  const left = Math.max(...tickLabels.map((l) => l.length)) * 6.4 + 12;
  const innerW = Math.max(width - left - RIGHT, 40);
  const y = linear([yTicks[0], yTicks[yTicks.length - 1]], [HEIGHT - BOTTOM, TOP]);

  const band = innerW / Math.max(cats.length, 1);
  const xNums = cats.map(Number);
  // Scatter reads x as a measure (round ticks); a numeric line keeps its own x values as labels.
  const xTicks = numeric && kind === "scatter" ? niceTicks(Math.min(...xNums), Math.max(...xNums), 5) : null;
  const xDomain: [number, number] = xTicks
    ? [xTicks[0], xTicks[xTicks.length - 1]]
    : [Math.min(...xNums), Math.max(...xNums)];
  const xLin = numeric ? linear(xDomain, [left + 8, left + innerW - 8]) : null;
  const xAt = (i: number) => (xLin ? xLin(xNums[i]) : left + (i + 0.5) * band);

  // Thin x labels so they never collide.
  const labelW = Math.min(Math.max(...cats.map((c) => c.length)), 14) * 6.2 + 10;
  const every = Math.max(1, Math.ceil((labelW * cats.length) / innerW));
  const clip = (c: string) => (c.length > 14 ? `${c.slice(0, 13)}…` : c);

  const tipFor = (i: number, px: number, py: number): TooltipState => {
    const rows = series
      .map((s, si) => ({ color: seriesColor(si), label: s.name, value: valueAt(s, cats[i]) }))
      .filter((r): r is { color: string; label: string; value: number } => r.value !== null)
      .map((r) => ({ ...r, value: formatValue(r.value, unit) }));
    // One series: the title already names it, so the readout is just "<x> · <value>".
    if (series.length === 1) return { x: px, y: py, title: [cats[i], rows[0]?.value].filter(Boolean).join(" · "), rows: [] };
    return { x: px, y: py, title: cats[i], rows };
  };

  const nearestIndex = (clientX: number) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return 0;
    const px = clientX - rect.left;
    let best = 0;
    cats.forEach((_, i) => {
      if (Math.abs(xAt(i) - px) < Math.abs(xAt(best) - px)) best = i;
    });
    return best;
  };

  const zeroY = y(Math.max(yTicks[0], Math.min(0, yTicks[yTicks.length - 1])));
  const groupW = Math.min(band * 0.72, series.length * BAR_MAX + (series.length - 1) * GAP);
  const barW = (groupW - (series.length - 1) * GAP) / series.length;

  return (
    <div className="relative" onMouseLeave={() => setHover(null)}>
      <svg ref={svgRef} width={width} height={HEIGHT} aria-hidden className="block overflow-visible">
        {yTicks.map((t, i) => (
          <g key={t}>
            <line
              x1={left}
              x2={left + innerW}
              y1={y(t)}
              y2={y(t)}
              stroke={t === 0 ? "var(--viz-axis)" : "var(--viz-grid)"}
              strokeWidth={1}
              shapeRendering="crispEdges"
            />
            <text x={left - 8} y={y(t)} dy="0.32em" textAnchor="end" className="fill-muted-foreground text-[11px] tabular-nums">
              {tickLabels[i]}
            </text>
          </g>
        ))}
        {xTicks?.map((t) => (
          <text key={t} x={xLin!(t)} y={HEIGHT - 8} textAnchor="middle" className="fill-muted-foreground text-[11px] tabular-nums">
            {formatTick(t, null, isCompactAxis(xTicks))}
          </text>
        ))}
        {!xTicks &&
          cats.map((c, i) =>
          i % every === 0 ? (
            <text key={c} x={xAt(i)} y={HEIGHT - 8} textAnchor="middle" className="fill-muted-foreground text-[11px]">
              {clip(c)}
            </text>
          ) : null,
        )}

        {kind === "bar" &&
          cats.map((c, i) => (
            <g key={c}>
              {hover?.index === i && (
                <rect x={left + i * band} y={TOP} width={band} height={HEIGHT - TOP - BOTTOM} className="fill-muted" opacity={0.6} />
              )}
              {series.map((s, si) => {
                const v = valueAt(s, c);
                if (v === null) return null;
                const x0 = xAt(i) - groupW / 2 + si * (barW + GAP);
                return <path key={s.name} d={barPath(x0, zeroY, y(v), barW)} fill={seriesColor(si)} />;
              })}
              <rect
                x={left + i * band}
                y={TOP}
                width={band}
                height={HEIGHT - TOP - BOTTOM}
                fill="transparent"
                onMouseMove={(e) => {
                  const rect = svgRef.current!.getBoundingClientRect();
                  setHover({ index: i, tip: tipFor(i, e.clientX - rect.left, e.clientY - rect.top) });
                }}
              />
            </g>
          ))}

        {kind === "line" && (
          <>
            {hover && (
              <line
                x1={xAt(hover.index)}
                x2={xAt(hover.index)}
                y1={TOP}
                y2={HEIGHT - BOTTOM}
                stroke="var(--viz-axis)"
                strokeWidth={1}
              />
            )}
            {series.map((s, si) => {
              const pts = cats
                .map((c, i) => ({ i, v: valueAt(s, c) }))
                .filter((p): p is { i: number; v: number } => p.v !== null);
              const d = pts.map((p, k) => `${k ? "L" : "M"}${xAt(p.i)},${y(p.v)}`).join("");
              const last = pts[pts.length - 1];
              const marked = hover ? pts.find((p) => p.i === hover.index) : last;
              return (
                <g key={s.name}>
                  <path d={d} fill="none" stroke={seriesColor(si)} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
                  {(pts.length === 1 || marked) && (
                    <circle
                      cx={xAt((marked ?? last).i)}
                      cy={y((marked ?? last).v)}
                      r={4}
                      fill={seriesColor(si)}
                      stroke="var(--card)"
                      strokeWidth={2}
                    />
                  )}
                </g>
              );
            })}
            <rect
              x={left}
              y={TOP}
              width={innerW}
              height={HEIGHT - TOP - BOTTOM}
              fill="transparent"
              onMouseMove={(e) => {
                const rect = svgRef.current!.getBoundingClientRect();
                const i = nearestIndex(e.clientX);
                setHover({ index: i, tip: tipFor(i, xAt(i), e.clientY - rect.top) });
              }}
            />
          </>
        )}

        {kind === "scatter" &&
          series.map((s, si) =>
            s.points.map((p, pi) => {
              const i = cats.indexOf(String(p.x));
              const cx = xAt(i);
              const cy = y(p.y);
              const on = hover?.index === i && hover.tip.rows[0]?.label === s.name;
              return (
                <g key={`${s.name}-${pi}`}>
                  <circle cx={cx} cy={cy} r={on ? 6 : 4.5} fill={seriesColor(si)} stroke="var(--card)" strokeWidth={2} />
                  <circle
                    cx={cx}
                    cy={cy}
                    r={11}
                    fill="transparent"
                    onMouseEnter={() =>
                      setHover({
                        index: i,
                        tip:
                          series.length === 1
                            ? { x: cx, y: cy, title: `${p.x} · ${formatValue(p.y, unit)}`, rows: [] }
                            : { x: cx, y: cy, title: String(p.x), rows: [{ color: seriesColor(si), label: s.name, value: formatValue(p.y, unit) }] },
                      })
                    }
                  />
                </g>
              );
            }),
          )}
      </svg>
      {hover && <ChartTooltip tip={hover.tip} width={width} />}
    </div>
  );
}
