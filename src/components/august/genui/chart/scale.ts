/** Small, dependency-free helpers for hand-rolled SVG charts. */

export const SERIES_COLORS = Array.from({ length: 8 }, (_, i) => `var(--viz-${i + 1})`);

/** Categorical color by series index, in fixed order. */
export const seriesColor = (i: number) => SERIES_COLORS[i % SERIES_COLORS.length];

/** Round tick values covering [min, max], about `count` of them. */
export function niceTicks(min: number, max: number, count = 4): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (min === max) {
    const pad = Math.abs(min) || 1;
    return niceTicks(min - pad, max + pad, count);
  }
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const start = Math.floor(min / step) * step;
  const end = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= end + step / 2; v += step) ticks.push(Number(v.toPrecision(12)));
  return ticks;
}

export function linear(domain: [number, number], range: [number, number]) {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const k = d1 === d0 ? 0 : (r1 - r0) / (d1 - d0);
  return (v: number) => r0 + (v - d0) * k;
}

const number = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const oneDecimal = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

const PREFIX_UNITS = new Set(["$", "€", "£", "¥", "₹"]);

/** Units short enough to sit on every tick: currency symbols, %, and degree units. */
function symbolUnit(unit: string | null): "prefix" | "suffix" | null {
  if (!unit) return null;
  if (PREFIX_UNITS.has(unit)) return "prefix";
  if (unit === "%" || /^°[A-Z]?$/.test(unit)) return "suffix";
  return null;
}

function withSymbol(n: string, v: number, unit: string | null): string {
  const kind = symbolUnit(unit);
  if (kind === "prefix") return v < 0 ? `-${unit}${n.replace(/^-/, "")}` : `${unit}${n}`;
  if (kind === "suffix") return `${n}${unit}`;
  return n;
}

/** 15000 -> "15k", 2500000 -> "2.5M". */
function compact(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e9) return `${oneDecimal.format(v / 1e9)}B`;
  if (a >= 1e6) return `${oneDecimal.format(v / 1e6)}M`;
  if (a >= 1e3) return `${oneDecimal.format(v / 1e3)}k`;
  return oneDecimal.format(v);
}

/** Whether an axis spanning these values should use compact labels (decided once per axis). */
export const isCompactAxis = (values: number[]) => Math.max(0, ...values.map(Math.abs)) >= 10_000;

/**
 * An axis tick: a plain number, compact when the axis is large. Only a
 * single-symbol unit ($, %, °F) rides along; any other unit is named once in
 * the title, never on every tick.
 */
export function formatTick(v: number, unit: string | null, compactAxis: boolean): string {
  return withSymbol(compactAxis ? compact(v) : number.format(v), v, unit);
}

/** A value in full, with its unit once: "$1,234.5", "62°F", "15,000 steps". */
export function formatValue(v: number, unit: string | null): string {
  const n = number.format(v);
  if (!unit || symbolUnit(unit)) return withSymbol(n, v, unit);
  return `${n} ${unit}`;
}

/** Bar path with 4px rounded data-end, square at the baseline. */
export function barPath(x: number, y0: number, y1: number, w: number, radius = 4): string {
  const h = Math.abs(y1 - y0);
  const r = Math.min(radius, w / 2, h);
  if (y1 <= y0) {
    // Grows upward: round the top.
    return `M${x},${y0}V${y1 + r}Q${x},${y1} ${x + r},${y1}H${x + w - r}Q${x + w},${y1} ${x + w},${y1 + r}V${y0}Z`;
  }
  return `M${x},${y0}V${y1 - r}Q${x},${y1} ${x + r},${y1}H${x + w - r}Q${x + w},${y1} ${x + w},${y1 - r}V${y0}Z`;
}

/** Points on a circle for a pie slice from angle a0 to a1 (radians, 0 = 12 o'clock). */
export function arcPath(cx: number, cy: number, r: number, inner: number, a0: number, a1: number): string {
  const pt = (rad: number, a: number) => [cx + rad * Math.sin(a), cy - rad * Math.cos(a)];
  const large = a1 - a0 > Math.PI ? 1 : 0;
  if (a1 - a0 >= Math.PI * 2 - 1e-6) {
    // Full circle: two half arcs.
    return `${arcPath(cx, cy, r, inner, 0, Math.PI)} ${arcPath(cx, cy, r, inner, Math.PI, Math.PI * 2)}`;
  }
  const [x0, y0] = pt(r, a0);
  const [x1, y1] = pt(r, a1);
  const [x2, y2] = pt(inner, a1);
  const [x3, y3] = pt(inner, a0);
  return `M${x0},${y0}A${r},${r} 0 ${large} 1 ${x1},${y1}L${x2},${y2}A${inner},${inner} 0 ${large} 0 ${x3},${y3}Z`;
}
