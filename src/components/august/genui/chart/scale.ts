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
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

const PREFIX_UNITS = new Set(["$", "€", "£", "¥", "₹"]);

/** 1234.5 with unit "$" -> "$1,234.5"; "°F" -> "1,234.5°F"; "min" -> "1,234.5 min". */
export function formatValue(v: number, unit: string | null, short = false): string {
  const n = short && Math.abs(v) >= 10_000 ? compact.format(v) : number.format(v);
  if (!unit) return n;
  if (PREFIX_UNITS.has(unit)) return v < 0 ? `-${unit}${n.slice(1)}` : `${unit}${n}`;
  if (unit === "%" || unit.startsWith("°")) return `${n}${unit}`;
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
